//! Hosting uses the developer's signed-in CLI. Credentials never cross IPC.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HostKind {
    Github,
    Gitlab,
    Unknown,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Host {
    pub kind: HostKind,
    pub hostname: String,
    pub repository: String,
    pub remote: String,
    pub connection: Option<String>,
}

pub fn parse_remote(url: &str) -> Option<(String, String)> {
    let url = url.trim().trim_end_matches('/');
    let (authority, path) = if let Some((scheme, rest)) = url.split_once("://") {
        if !matches!(scheme, "https" | "http" | "ssh" | "git") {
            return None;
        }
        rest.split_once('/')?
    } else {
        let (authority, path) = url.split_once(':')?;
        if !authority.contains('@') {
            return None;
        }
        (authority, path)
    };
    let hostname = authority.rsplit('@').next()?.split(':').next()?.to_lowercase();
    let path = path.trim_matches('/');
    let repository = path.strip_suffix(".git").unwrap_or(path).to_string();
    if hostname.is_empty()
        || repository.contains(['?', '#'])
        || !repository.contains('/')
        || repository.split('/').any(|p| p.is_empty() || p == ".." || p == ".")
    {
        return None;
    }
    Some((hostname, repository))
}

pub fn classify(host: &str, glab_knows: bool, gh_knows: bool) -> HostKind {
    if host == "github.com" {
        HostKind::Github
    } else if host == "gitlab.com" || host.contains("gitlab") || glab_knows {
        HostKind::Gitlab
    } else if gh_knows {
        HostKind::Github
    } else {
        HostKind::Unknown
    }
}

/// Drain both pipes while waiting; large diffs and hook output must not deadlock.
pub fn run(mut command: Command, timeout: Duration, app: Option<&tauri::AppHandle>) -> Result<String, String> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    if let Some(app) = app {
        app.state::<crate::AppState>().oneshot_pids.lock().unwrap().insert(pid);
    }
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let read = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut out = String::new();
            let _ = pipe.read_to_string(&mut out);
            out
        })
    };
    let out = read(Box::new(stdout));
    let err = read(Box::new(stderr));
    let deadline = Instant::now() + timeout;
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                crate::proc::kill_tree(pid);
                let _ = child.wait();
                break Err("The command took too long. Try again in Terminal.".to_string());
            }
        }
    };
    // A hook may leave a child holding a pipe open even after git exits.
    crate::proc::kill_tree(pid);
    if let Some(app) = app {
        app.state::<crate::AppState>().oneshot_pids.lock().unwrap().remove(&pid);
    }
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    match outcome {
        Ok(status) if status.success() => Ok(stdout),
        Ok(_) => {
            let output = format!("{}\n{}", stderr.trim(), stdout.trim());
            let credentials = regex::Regex::new(r"(https?://)[^/\s@]+@").unwrap();
            Err(credentials.replace_all(output.trim(), "$1[redacted]@").into_owned())
        }
        Err(e) => Err(e),
    }
}

pub fn git(cwd: &str, args: &[&str], app: Option<&tauri::AppHandle>) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("--literal-pathspecs").arg("-C").arg(cwd).args(args).env("GIT_TERMINAL_PROMPT", "0");
    run(cmd, Duration::from_secs(60), app)
}

fn cli_name(kind: &HostKind) -> &'static str {
    if *kind == HostKind::Gitlab {
        "glab"
    } else {
        "gh"
    }
}
fn login(kind: &HostKind, host: &str, missing: bool) -> String {
    let cli = cli_name(kind);
    let flag = if host == "github.com" || host == "gitlab.com" {
        String::new()
    } else {
        format!(" --hostname {host}")
    };
    if missing {
        format!("Connect in Terminal: brew install {cli}, then {cli} auth login{flag}.")
    } else {
        format!("Connect in Terminal: {cli} auth login{flag}.")
    }
}
fn authenticated(cli: &str, cwd: &str, hostname: &str) -> bool {
    let Some(program) = crate::chat::resolve_program(cli) else {
        return false;
    };
    let mut cmd = Command::new(program);
    cmd.current_dir(cwd).args(["auth", "status", "--hostname", hostname]);
    // auth status output can contain account details. Only its exit status matters.
    run(cmd, Duration::from_secs(10), None).is_ok()
}

type HostCache = Mutex<HashMap<String, (Instant, Option<Host>)>>;
static HOSTS: OnceLock<HostCache> = OnceLock::new();
pub fn resolve(cwd: &str) -> Option<Host> {
    let cache = HOSTS.get_or_init(Mutex::default);
    if let Some((at, host)) = cache
        .lock()
        .unwrap()
        .get(cwd)
        .filter(|(at, _)| at.elapsed() < Duration::from_secs(180))
        .cloned()
    {
        let _ = at;
        return host;
    }
    let branch = crate::tasks::current_branch(cwd).unwrap_or_default();
    let remote = git(cwd, &["config", "--get", &format!("branch.{branch}.remote")], None)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| s != ".")
        .unwrap_or_else(|| "origin".into());
    let host = git(cwd, &["remote", "get-url", &remote], None)
        .ok()
        .and_then(|url| parse_remote(&url))
        .map(|(hostname, repository)| {
            let glab = hostname != "github.com" && authenticated("glab", cwd, &hostname);
            let gh = !glab && authenticated("gh", cwd, &hostname);
            let kind = classify(&hostname, glab, gh);
            let known = if kind == HostKind::Gitlab { glab } else { gh };
            let connection = if kind == HostKind::Unknown {
                Some(format!("Unknown host: {hostname}. Commit and push are available."))
            } else if !known {
                Some(login(&kind, &hostname, crate::chat::resolve_program(cli_name(&kind)).is_none()))
            } else {
                None
            };
            Host {
                kind,
                hostname,
                repository,
                remote,
                connection,
            }
        });
    cache.lock().unwrap().insert(cwd.into(), (Instant::now(), host.clone()));
    host
}

pub fn cli(app: &tauri::AppHandle, cwd: &str, host: &Host, args: &[String]) -> Result<String, String> {
    if host.kind == HostKind::Unknown {
        return Err("Requests aren't available for this unknown host.".into());
    }
    if let Some(note) = &host.connection {
        return Err(note.clone());
    }
    let name = cli_name(&host.kind);
    let program = crate::chat::resolve_program(name).ok_or_else(|| login(&host.kind, &host.hostname, true))?;
    let mut cmd = Command::new(program);
    let mut arguments = args.to_vec();
    if !arguments.iter().any(|arg| arg == "--repo") && arguments.first().is_some_and(|arg| matches!(arg.as_str(), "pr" | "mr")) {
        arguments.extend(["--repo".into(), format!("https://{}/{}", host.hostname, host.repository)]);
    }
    cmd.current_dir(cwd)
        .args(&arguments)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GLAB_CHECK_UPDATE", "false");
    if host.kind == HostKind::Github {
        cmd.env("GH_HOST", &host.hostname);
    } else {
        cmd.env("GITLAB_HOST", &host.hostname);
    }
    run(cmd, Duration::from_secs(60), Some(app)).map_err(|e| {
        if e.contains("unknown flag") || e.contains("Unknown JSON field") {
            format!("Update {name} in Terminal: brew upgrade {name}. Starkline needs gh 2.40+ or glab 1.50+ with JSON output.\n\nDetails\n{e}")
        } else {
            format!("Couldn't read or create the request. Check your connection and {name} auth status in Terminal.\n\nDetails\n{e}")
        }
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct CodeReviewItem {
    pub id: String,
    pub cwd: String,
    pub host_kind: HostKind,
    pub number: i64,
    pub title: String,
    pub url: String,
    pub branch: String,
    pub head: String,
    /// failed | changes | comments | review
    pub reason: String,
    pub updated: String,
    pub failed_checks: Vec<String>,
    pub agent_id: String,
    pub task_id: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, specta::Type)]
pub struct CodeReviews {
    pub items: Vec<CodeReviewItem>,
    pub connections: Vec<String>,
    pub has_host: bool,
}
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}

pub fn parse_items(cwd: &str, kind: HostKind, values: &Value, review: bool, seen: impl Fn(&str) -> String) -> Vec<CodeReviewItem> {
    array(values)
        .iter()
        .filter_map(|v| {
            let github = kind == HostKind::Github;
            let number = v.get(if github { "number" } else { "iid" })?.as_i64()?;
            let url = s(v, if github { "url" } else { "web_url" });
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return None;
            }
            if matches!(s(v, "state").to_lowercase().as_str(), "closed" | "merged") {
                return None;
            }
            let id = url.to_string();
            let updated = s(v, if github { "updatedAt" } else { "updated_at" }).to_string();
            let mut failed_checks = Vec::new();
            if github {
                for check in array(&v["statusCheckRollup"]) {
                    let state = s(check, "conclusion");
                    let state = if state.is_empty() { s(check, "state") } else { state };
                    if matches!(state, "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE") {
                        failed_checks.push(s(check, "name").to_string());
                        if failed_checks.last().is_some_and(String::is_empty) {
                            *failed_checks.last_mut().unwrap() = s(check, "context").to_string();
                        }
                    }
                }
            } else if matches!(s(&v["head_pipeline"], "status"), "failed" | "canceled")
                && (s(&v["head_pipeline"], "sha").is_empty() || s(v, "sha").is_empty() || s(&v["head_pipeline"], "sha") == s(v, "sha"))
            {
                failed_checks.push("Head pipeline".into());
            }
            let last_seen = seen(&id);
            let comments_new = github
                && ["comments", "reviews"].iter().any(|key| {
                    array(&v[*key]).iter().any(|c| {
                        let time = s(c, "createdAt");
                        let time = if time.is_empty() { s(c, "submittedAt") } else { time };
                        !time.is_empty() && time > last_seen.as_str()
                    })
                });
            let unresolved = !github && v.get("blocking_discussions_resolved").and_then(Value::as_bool) == Some(false);
            let reason = if review {
                "review"
            } else if !failed_checks.is_empty() {
                "failed"
            } else if s(v, "reviewDecision") == "CHANGES_REQUESTED" {
                "changes"
            } else if comments_new || unresolved {
                "comments"
            } else {
                return None;
            };
            Some(CodeReviewItem {
                id,
                cwd: cwd.into(),
                host_kind: kind.clone(),
                number,
                title: s(v, "title").into(),
                url: url.into(),
                branch: s(v, if github { "headRefName" } else { "source_branch" }).into(),
                head: s(v, if github { "headRefOid" } else { "sha" }).into(),
                reason: reason.into(),
                updated,
                failed_checks,
                agent_id: String::new(),
                task_id: None,
            })
        })
        .collect()
}

static REVIEWS: OnceLock<Mutex<CodeReviews>> = OnceLock::new();
static POLL: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
pub fn snapshot() -> CodeReviews {
    REVIEWS.get_or_init(Mutex::default).lock().unwrap().clone()
}
fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| (*s).into()).collect()
}
pub fn poll(app: &tauri::AppHandle, focus: bool) {
    let Ok(mut last) = POLL.get_or_init(Mutex::default).try_lock() else {
        return;
    };
    if focus && last.is_some_and(|at| at.elapsed() < Duration::from_secs(60)) {
        return;
    }
    *last = Some(Instant::now());
    let state = app.state::<crate::AppState>();
    let projects = state.projects.lock().unwrap().clone();
    let tasks = state.ledger.tasks(1000);
    let mut result = CodeReviews::default();
    for cwd in projects {
        let Some(host) = resolve(&cwd) else { continue };
        if host.kind == HostKind::Unknown {
            continue;
        }
        result.has_host = true;
        if let Some(note) = &host.connection {
            result.connections.push(note.clone());
            continue;
        }
        let fetch = |review: bool| -> Result<Vec<CodeReviewItem>, String> {
            let mut args = if host.kind == HostKind::Github {
                let mut args = strings(&[
                    "pr",
                    "list",
                    "--state",
                    "open",
                    "--limit",
                    "100",
                    "--json",
                    "number,title,url,headRefName,headRefOid,isDraft,reviewDecision,statusCheckRollup,updatedAt,comments,reviews",
                ]);
                args.extend(if review {
                    strings(&["--search", "review-requested:@me"])
                } else {
                    strings(&["--author", "@me"])
                });
                args
            } else {
                strings(&[
                    "mr",
                    "list",
                    if review { "--reviewer=@me" } else { "--author=@me" },
                    "--output",
                    "json",
                    "--per-page",
                    "100",
                ])
            };
            args.extend(strings(&["--repo", &format!("https://{}/{}", host.hostname, host.repository)]));
            let output = cli(app, &cwd, &host, &args)?;
            let mut values: Value = serde_json::from_str(&output).map_err(|_| "The hosting CLI didn't return JSON. Update it in Terminal.".to_string())?;
            if host.kind == HostKind::Gitlab && !review {
                for v in values.as_array_mut().into_iter().flatten() {
                    if let Some(iid) = v["iid"].as_i64() {
                        let detail = cli(
                            app,
                            &cwd,
                            &host,
                            &strings(&[
                                "mr",
                                "view",
                                &iid.to_string(),
                                "--output",
                                "json",
                                "--repo",
                                &format!("https://{}/{}", host.hostname, host.repository),
                            ]),
                        )?;
                        *v = serde_json::from_str(&detail).map_err(|_| "GitLab didn't return request details.".to_string())?;
                    }
                }
            }
            Ok(parse_items(&cwd, host.kind.clone(), &values, review, |id| state.ledger.review_seen(id)))
        };
        for review in [false, true] {
            match fetch(review) {
                Ok(items) => result.items.extend(items),
                Err(e) => result.connections.push(e.split("\n\nDetails").next().unwrap_or(&e).into()),
            }
        }
    }
    let (enabled, default_agent) = {
        let config = state.config.lock().unwrap();
        let enabled: Vec<_> = config.agents.iter().filter(|a| a.enabled).map(|a| a.id.clone()).collect();
        let default = config
            .agents
            .iter()
            .find(|a| a.enabled && a.kind != crate::agents::AgentKind::Orchestrator)
            .or_else(|| config.agents.iter().find(|a| a.enabled))
            .map(|a| a.id.clone())
            .unwrap_or_default();
        (enabled, default)
    };
    for item in &mut result.items {
        let task = tasks.iter().find(|t| t.request_url.as_deref() == Some(&item.url));
        item.agent_id = task
            .filter(|t| enabled.contains(&t.assignee))
            .or_else(|| tasks.iter().find(|t| t.cwd == item.cwd && enabled.contains(&t.assignee)))
            .map(|t| t.assignee.clone())
            .unwrap_or_else(|| default_agent.clone());
        if let Some(task) = task {
            item.cwd = task.cwd.clone();
        }
        item.task_id = task.map(|t| t.id.clone());
        if item.reason == "failed" && !item.head.is_empty() && state.ledger.review_failure(&item.id, &item.head) {
            crate::notify::code_review(app, item);
        }
    }
    result.items.sort_by(|a, b| {
        let rank = |r: &str| match r {
            "failed" => 0,
            "changes" | "comments" => 1,
            _ => 2,
        };
        rank(&a.reason).cmp(&rank(&b.reason)).then(b.updated.cmp(&a.updated))
    });
    let mut seen = HashSet::new();
    result.items.retain(|item| seen.insert(item.id.clone()));
    result.connections.sort();
    result.connections.dedup();
    *REVIEWS.get_or_init(Mutex::default).lock().unwrap() = result.clone();
    let _ = app.emit("hosting://changed", result);
}
pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        poll(&app, false);
        std::thread::sleep(Duration::from_secs(180));
    });
}
pub fn seen(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    if !(id.starts_with("https://") || id.starts_with("http://")) {
        return Err("That request URL isn't valid.".into());
    }
    let item = snapshot().items.into_iter().find(|i| i.id == id);
    app.state::<crate::AppState>()
        .ledger
        .mark_review_seen(id, &chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    let mut reviews = REVIEWS.get_or_init(Mutex::default).lock().unwrap();
    if item.is_some_and(|item| item.reason == "comments" && item.host_kind == HostKind::Github) {
        reviews.items.retain(|i| i.id != id || i.reason != "comments");
    }
    let _ = app.emit("hosting://changed", reviews.clone());
    Ok(())
}
pub fn review_prompt(item: &CodeReviewItem) -> String {
    let cli = cli_name(&item.host_kind);
    let request = if item.host_kind == HostKind::Github { "pr" } else { "mr" };
    let checks = if item.host_kind == HostKind::Github {
        format!("`gh pr checks {}` and `gh run view <run-id> --log-failed`", item.number)
    } else {
        "`glab ci view` and `glab ci trace <job>`".into()
    };
    let instructions = match item.reason.as_str() {
        "failed" => format!("Fix the failed checks: {}. Read {checks}. Make the fix on branch {}. Push nothing; the developer will deliver it.", item.failed_checks.join(", "), item.branch),
        "review" => format!("Review with `{cli} {request} diff {}`. Report findings to the developer. Post nothing and push nothing.", item.number),
        _ => format!("Read the review with `{cli} {request} view {} --comments`. Address the feedback on branch {}. Post nothing and push nothing; the developer will deliver it.", item.number, item.branch),
    };
    format!("{}\n{}\nRequest: {}\nBranch: {}", item.title, instructions, item.url, item.branch)
}

pub fn ask(app: &tauri::AppHandle, id: &str, agent: &str) -> Result<crate::ledger::Task, String> {
    let item = snapshot()
        .items
        .into_iter()
        .find(|i| i.id == id)
        .ok_or("That request no longer needs attention.")?;
    crate::tasks::start_for(
        app,
        agent,
        &review_prompt(&item),
        Some(item.cwd.clone()),
        &[],
        &crate::tasks::Origin {
            requested_by: crate::tasks::BY_DEVELOPER,
            title: None,
            note: "You asked for help with code review",
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn remote_urls_include_nested_groups_ports_suffixes_and_slashes() {
        for (url, host, repo) in [
            ("git@github.com:o/r.git", "github.com", "o/r"),
            ("https://github.com/o/r.git.git", "github.com", "o/r.git"),
            ("https://gitlab.example.com/group/sub/r.git/", "gitlab.example.com", "group/sub/r"),
            ("ssh://git@host:2222/group/sub/r.git", "host", "group/sub/r"),
            ("https://user@GITHUB.COM:443/o/r///", "github.com", "o/r"),
            ("git@gitlab.com:group/sub/r", "gitlab.com", "group/sub/r"),
        ] {
            assert_eq!(parse_remote(url), Some((host.into(), repo.into())));
        }
        for invalid in [
            "/tmp/repo",
            "file:///tmp/repo",
            "ftp://host/o/r",
            "https://github.com",
            "git@host:r.git",
            "git@host:o/../r.git",
            "",
            "https://host/o//r.git",
        ] {
            assert!(parse_remote(invalid).is_none(), "{invalid}");
        }
    }
    #[test]
    fn both_hosts_and_unknown_enterprise_hosts() {
        assert_eq!(classify("github.com", true, true), HostKind::Github);
        assert_eq!(classify("gitlab.com", false, false), HostKind::Gitlab);
        assert_eq!(classify("gitlab.internal", false, false), HostKind::Gitlab);
        assert_eq!(classify("code.example.com", true, true), HostKind::Gitlab);
        assert_eq!(classify("code.example.com", false, true), HostKind::Github);
        assert_eq!(classify("code.example.com", false, false), HostKind::Unknown);
        assert!(login(&HostKind::Gitlab, "gitlab.internal", true).contains("glab auth login --hostname gitlab.internal"));
    }
    #[test]
    fn github_cli_fixture_distinguishes_failed_running_passing_and_missing_checks() {
        let fixture: Value = serde_json::from_str(r#"[
          {"number":128,"title":"Fix login","url":"https://github.com/o/r/pull/128","headRefName":"fix/login","headRefOid":"abc","updatedAt":"2026-10-06T10:00:00Z","statusCheckRollup":[{"__typename":"CheckRun","name":"Tests","status":"COMPLETED","conclusion":"FAILURE"},{"__typename":"StatusContext","context":"lint","state":"ERROR"}]},
          {"number":129,"url":"https://github.com/o/r/pull/129","statusCheckRollup":[{"status":"IN_PROGRESS","conclusion":""}]},
          {"number":130,"url":"https://github.com/o/r/pull/130","statusCheckRollup":[{"conclusion":"SUCCESS"}]},
          {"number":131,"url":"https://github.com/o/r/pull/131"},
          {"number":132,"url":"https://github.com/o/r/pull/132","reviewDecision":"CHANGES_REQUESTED"},
          {"number":133,"url":"https://github.com/o/r/pull/133","comments":[{"createdAt":"2026-10-06T10:00:00Z"}]},
          {"number":134,"url":"https://github.com/o/r/pull/134","reviews":[{"submittedAt":"2026-10-04T10:00:00Z"}]}]"#).unwrap();
        let items = parse_items("/w", HostKind::Github, &fixture, false, |_| "2026-10-05T10:00:00Z".into());
        assert_eq!(
            items.iter().map(|i| (i.number, i.reason.as_str())).collect::<Vec<_>>(),
            [(128, "failed"), (132, "changes"), (133, "comments")]
        );
        assert_eq!(items[0].failed_checks, ["Tests", "lint"]);
        assert_eq!(items[0].head, "abc");
        assert_eq!(parse_items("/w", HostKind::Github, &fixture, true, |_| String::new()).len(), 7);
    }
    #[test]
    fn gitlab_cli_fixture_uses_head_pipeline_and_discussions() {
        let fixture = json!([
            {"iid":45,"title":"Fix login","web_url":"https://gitlab.com/group/sub/r/-/merge_requests/45","source_branch":"fix/login","sha":"abc","head_pipeline":{"status":"failed"},"blocking_discussions_resolved":false},
            {"iid":46,"web_url":"https://gitlab.com/g/r/-/merge_requests/46","head_pipeline":{"status":"running"}},
            {"iid":47,"web_url":"https://gitlab.com/g/r/-/merge_requests/47","head_pipeline":{"status":"success"}},
            {"iid":48,"web_url":"https://gitlab.com/g/r/-/merge_requests/48"},
            {"iid":49,"web_url":"https://gitlab.com/g/r/-/merge_requests/49","blocking_discussions_resolved":false},
            {"iid":50,"web_url":"https://gitlab.com/g/r/-/merge_requests/50","state":"merged","head_pipeline":{"status":"failed"}},
            {"iid":51,"web_url":"https://gitlab.com/g/r/-/merge_requests/51","sha":"new","head_pipeline":{"sha":"old","status":"failed"}}
        ]);
        let items = parse_items("/w", HostKind::Gitlab, &fixture, false, |_| String::new());
        assert_eq!(
            items.iter().map(|i| (i.number, i.reason.as_str())).collect::<Vec<_>>(),
            [(45, "failed"), (49, "comments")]
        );
        assert_eq!(parse_items("/w", HostKind::Gitlab, &fixture, true, |_| String::new()).len(), 6);
        assert!(parse_items("/w", HostKind::Gitlab, &Value::Null, false, |_| String::new()).is_empty());
    }
    #[test]
    fn agent_requests_use_the_right_host_without_posting_or_pushing() {
        for kind in [HostKind::Github, HostKind::Gitlab] {
            let mut item = CodeReviewItem {
                id: "request".into(),
                cwd: "/w".into(),
                host_kind: kind.clone(),
                number: 45,
                title: "Fix login".into(),
                url: "https://host/request/45".into(),
                branch: "fix/login".into(),
                head: "abc".into(),
                reason: "failed".into(),
                updated: String::new(),
                failed_checks: vec!["Tests".into()],
                agent_id: "friday".into(),
                task_id: None,
            };
            let prompt = review_prompt(&item);
            assert!(prompt.contains("Push nothing"));
            assert!(prompt.contains("fix/login"));
            assert!(prompt.contains(&item.url));
            assert!(prompt.contains(if kind == HostKind::Github { "gh pr checks 45" } else { "glab ci view" }));
            assert!(!prompt.contains("glab mr checks"));
            item.reason = "comments".into();
            assert!(review_prompt(&item).contains("view 45 --comments"));
            item.reason = "review".into();
            assert!(review_prompt(&item).contains("diff 45"));
            assert!(review_prompt(&item).contains("Post nothing"));
        }
    }

    #[test]
    fn runs_a_cli_and_collects_its_output() {
        let mut cmd = Command::new("git");
        cmd.args(["--version"]);
        assert!(run(cmd, Duration::from_secs(5), None).unwrap().starts_with("git version"));
    }
}
