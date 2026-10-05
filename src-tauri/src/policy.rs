//! Permission rules the developer grants: "allow `npm install` for this task",
//! "always allow `git push` in checkout-web". A rule is derived here from the
//! exact request it answers, so it can never be broader than what was shown,
//! and only the developer creates one (the agent never can).

use serde::Serialize;
use std::path::Path;

/// Where a rule applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Task,
    Project,
    Everywhere,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Task => "task",
            Scope::Project => "project",
            Scope::Everywhere => "everywhere",
        }
    }

    pub fn parse(text: &str) -> Option<Scope> {
        match text {
            "task" => Some(Scope::Task),
            "project" => Some(Scope::Project),
            "everywhere" => Some(Scope::Everywhere),
            _ => None,
        }
    }
}

/// What a rule allows: one tool, narrowed to a command, folder or site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
pub struct RuleKey {
    /// The provider's tool ("Bash", "Write", "WebFetch", …).
    pub tool: String,
    /// The command ("npm install"), folder or host it covers; "" covers the whole tool.
    pub pattern: String,
    /// How the rule reads: "`npm install` commands".
    pub display: String,
}

/// Commands that are really a family of subcommands: the subcommand is part of the rule.
const SUBCOMMAND_TOOLS: &[&str] = &[
    "npm", "pnpm", "yarn", "bun", "npx", "bunx", "git", "gh", "cargo", "go", "docker", "podman", "pip", "pip3", "uv",
    "poetry", "brew", "kubectl", "terraform", "rails", "rake", "python", "python3", "swift", "dotnet", "gradle", "mvn",
];

fn words(command: &str) -> Vec<String> {
    command.split_whitespace().map(|w| w.trim_matches(['\'', '"']).to_string()).collect()
}

/// The command family a single shell command belongs to: "npm install", "git push", "rm".
fn command_pattern(command: &str) -> Option<String> {
    let all = words(command);
    let mut rest = all.iter().skip_while(|w| w.contains('=') && !w.starts_with('-'));
    let program = rest.next()?;
    let name = Path::new(program).file_name()?.to_string_lossy().to_string();
    if !SUBCOMMAND_TOOLS.contains(&name.as_str()) {
        return Some(name);
    }
    let mut rest = rest.peekable();
    // `git -C dir push`: skip global options to the subcommand.
    while let Some(w) = rest.peek() {
        if !w.starts_with('-') {
            break;
        }
        let takes_value = matches!(w.as_str(), "-C" | "-c" | "--git-dir" | "--work-tree" | "-m");
        rest.next();
        if takes_value {
            rest.next();
        }
    }
    match rest.next() {
        Some(sub) => Some(format!("{name} {sub}")),
        None => Some(name),
    }
}

fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    rest.split(['/', '?', '#']).next().unwrap_or("").rsplit('@').next().unwrap_or("").to_lowercase()
}

/// The narrowest rule that would have allowed this request. None when a rule
/// can't safely cover it (several risky commands chained together, or nothing
/// to key on).
pub fn rule_for(tool: &str, input: &serde_json::Value, risky_commands: &[String]) -> Option<RuleKey> {
    let text = |key: &str| input.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    match tool {
        "Bash" => {
            // Only one risky command may be covered at a time; a chain must be approved whole.
            let [only] = risky_commands else { return None };
            let pattern = command_pattern(only)?;
            Some(RuleKey { tool: tool.into(), display: format!("`{pattern}` commands"), pattern })
        }
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" | "Read" => {
            let path = [text("file_path"), text("notebook_path")].into_iter().find(|p| !p.is_empty())?;
            let folder = Path::new(&path).parent()?.to_string_lossy().to_string();
            let verb = if tool == "Read" { "Reading" } else { "Changing" };
            Some(RuleKey { tool: tool.into(), display: format!("{verb} files in {folder}"), pattern: folder })
        }
        "WebFetch" => {
            let host = host_of(&text("url"));
            if host.is_empty() {
                return None;
            }
            Some(RuleKey { tool: tool.into(), display: format!("Fetching pages from {host}"), pattern: host })
        }
        other => Some(RuleKey { tool: other.into(), display: format!("Using the `{other}` tool"), pattern: String::new() }),
    }
}

/// Whether a stored rule covers this request's key.
pub fn covers(rule: &RuleKey, request: &RuleKey) -> bool {
    if rule.tool != request.tool {
        return false;
    }
    match rule.tool.as_str() {
        // A folder rule covers that folder and everything under it.
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" | "Read" => {
            !rule.pattern.is_empty() && Path::new(&request.pattern).starts_with(&rule.pattern)
        }
        _ => rule.pattern.is_empty() || rule.pattern == request.pattern,
    }
}

/// A stored rule, as Settings lists it.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct PermissionRule {
    pub id: i64,
    pub created: i64,
    /// task | project | everywhere
    pub scope: String,
    /// For task rules: the task. For project rules: the project folder.
    pub task_id: Option<String>,
    pub project: Option<String>,
    pub tool: String,
    pub pattern: String,
    pub display: String,
    /// The policy rule it loosens ("Install or update dependencies").
    pub rule: String,
    /// "approval" or "never": how strongly the default held this back.
    pub tier: String,
    pub uses: i64,
    pub last_used: Option<i64>,
    pub revoked: Option<i64>,
}

/// Whether a rule applies to a request made in `cwd` while working on `task`.
pub fn applies(rule: &PermissionRule, task: Option<&str>, cwd: &str) -> bool {
    if rule.revoked.is_some() {
        return false;
    }
    match Scope::parse(&rule.scope) {
        Some(Scope::Task) => rule.task_id.as_deref().is_some_and(|t| Some(t) == task),
        Some(Scope::Project) => rule.project.as_deref().is_some_and(|p| !p.is_empty() && Path::new(cwd).starts_with(p)),
        Some(Scope::Everywhere) => true,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bash(commands: &[&str]) -> Option<RuleKey> {
        let risky: Vec<String> = commands.iter().map(|c| c.to_string()).collect();
        rule_for("Bash", &serde_json::json!({ "command": commands.join(" && ") }), &risky)
    }

    #[test]
    fn a_command_rule_covers_its_family_only() {
        let install = bash(&["npm install zod"]).unwrap();
        assert_eq!((install.pattern.as_str(), install.display.as_str()), ("npm install", "`npm install` commands"));
        assert!(covers(&install, &bash(&["npm install react --save-dev"]).unwrap()));
        assert!(!covers(&install, &bash(&["npm publish"]).unwrap()));
        assert_eq!(bash(&["git -C ../app push origin main"]).unwrap().pattern, "git push");
        assert_eq!(bash(&["NODE_ENV=test /usr/bin/curl https://x.dev"]).unwrap().pattern, "curl");
        assert!(bash(&["npm install", "git push"]).is_none(), "a chain is approved whole, never by rule");
    }

    #[test]
    fn file_and_site_rules() {
        let write = rule_for("Write", &serde_json::json!({ "file_path": "/Users/dev/notes/today.md" }), &[]).unwrap();
        assert_eq!(write.pattern, "/Users/dev/notes");
        let nested = rule_for("Edit", &serde_json::json!({ "file_path": "/Users/dev/notes/2026/oct.md" }), &[]).unwrap();
        let mut as_write = nested.clone();
        as_write.tool = "Write".into();
        assert!(covers(&write, &as_write));
        let sibling = rule_for("Write", &serde_json::json!({ "file_path": "/Users/dev/notes-old/a.md" }), &[]).unwrap();
        assert!(!covers(&write, &sibling));
        let site = rule_for("WebFetch", &serde_json::json!({ "url": "https://docs.rs/serde/latest" }), &[]).unwrap();
        assert_eq!(site.pattern, "docs.rs");
    }

    #[test]
    fn scopes_decide_where_a_rule_applies() {
        let rule = |scope: &str, task: Option<&str>, project: Option<&str>| PermissionRule {
            id: 1,
            created: 0,
            scope: scope.into(),
            task_id: task.map(String::from),
            project: project.map(String::from),
            tool: "Bash".into(),
            pattern: "npm install".into(),
            display: String::new(),
            rule: String::new(),
            tier: "approval".into(),
            uses: 0,
            last_used: None,
            revoked: None,
        };
        assert!(applies(&rule("task", Some("t1"), None), Some("t1"), "/w/app"));
        assert!(!applies(&rule("task", Some("t1"), None), Some("t2"), "/w/app"));
        assert!(applies(&rule("project", None, Some("/w/app")), None, "/w/app/packages/ui"));
        assert!(!applies(&rule("project", None, Some("/w/app")), None, "/w/app-two"));
        assert!(applies(&rule("everywhere", None, None), None, "/anywhere"));
        let mut revoked = rule("everywhere", None, None);
        revoked.revoked = Some(5);
        assert!(!applies(&revoked, None, "/anywhere"));
    }
}
