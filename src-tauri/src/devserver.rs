//! Project dev servers, with one process group and a bounded output log per folder.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

const LOG_LIMIT: usize = 2_000;
const LINE_LIMIT: usize = 16_384;
const GRACE: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Choice {
    pub selected: String,
    pub custom: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Candidate {
    pub id: String,
    pub label: String,
    pub command: String,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Candidates {
    pub folder: String,
    pub options: Vec<Candidate>,
    pub selected: String,
    pub custom: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Starting,
    Running,
    Stopped,
    Crashed,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Server {
    pub folder: String,
    pub command: String,
    pub status: Status,
    pub address: Option<String>,
    pub exit_code: Option<i32>,
    pub generation: u32,
    pub open_page: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Output {
    pub folder: String,
    pub generation: u32,
    pub cursor: u32,
    pub lines: Vec<String>,
}

struct Session {
    server: Server,
    option: Candidate,
    pid: Option<u32>,
    stopping: Option<Instant>,
    lines: VecDeque<String>,
    cursor: u32,
}

impl Session {
    fn append(&mut self, line: String) {
        if self.lines.len() == LOG_LIMIT {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
        self.cursor = self.cursor.saturating_add(1);
    }
    fn output(&self, lines: Vec<String>) -> Output {
        Output {
            folder: self.server.folder.clone(),
            generation: self.server.generation,
            cursor: self.cursor,
            lines,
        }
    }
}

type Slot = Arc<Mutex<Session>>;
#[derive(Default)]
pub struct DevServers {
    sessions: Mutex<HashMap<String, Slot>>,
    operations: Mutex<()>,
    quitting: std::sync::atomic::AtomicBool,
}

fn folder_path(folder: &str) -> Result<PathBuf, String> {
    let path = Path::new(folder)
        .canonicalize()
        .map_err(|_| "The project folder couldn't be opened. Choose an existing folder.".to_string())?;
    if !path.is_dir() {
        return Err("Choose a project folder, rather than a file.".into());
    }
    Ok(path)
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|_| {
            format!(
                "Couldn't read {}. Fix its JSON and try again.",
                path.file_name().unwrap_or_default().to_string_lossy()
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(format!("Couldn't read {}. Check its permissions and try again.", path.display())),
    }
}

fn quote(text: &str) -> String {
    if !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric() || "_./-".contains(c)) {
        text.to_string()
    } else {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
}

pub fn discover(folder: &str, choice: Option<&Choice>) -> Result<Candidates, String> {
    let root = folder_path(folder)?;
    let mut options = Vec::new();
    let make = |id: String, label: String, command: String| Candidate {
        id,
        label,
        command,
        cwd: root.to_string_lossy().into(),
        env: BTreeMap::new(),
        port: None,
    };
    if let Some(launch) = read_json(&root.join(".claude/launch.json"))? {
        for (i, entry) in launch.get("configurations").and_then(Value::as_array).into_iter().flatten().enumerate() {
            let Some(runtime) = entry.get("runtimeExecutable").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) else {
                continue;
            };
            let mut args = vec![quote(runtime)];
            args.extend(
                entry
                    .get("runtimeArgs")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(quote),
            );
            let name = entry.get("name").and_then(Value::as_str).unwrap_or("Preview");
            let id = format!("launch:{name}");
            let id = if options.iter().any(|o: &Candidate| o.id == id) {
                format!("{id}:{i}")
            } else {
                id
            };
            let mut option = make(id, name.into(), args.join(" "));
            if let Some(cwd) = entry.get("cwd").and_then(Value::as_str) {
                let resolved = root
                    .join(cwd)
                    .canonicalize()
                    .map_err(|_| format!("The working folder for {name} doesn't exist. Fix cwd in launch.json."))?;
                if Path::new(cwd).is_absolute() || !resolved.is_dir() {
                    return Err(format!("The working folder for {name} must be a relative folder. Fix cwd in launch.json."));
                }
                option.cwd = resolved.to_string_lossy().into();
            }
            if let Some(env) = entry.get("env").and_then(Value::as_object) {
                for (key, value) in env {
                    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') || key.as_bytes()[0].is_ascii_digit() {
                        return Err(format!("An environment variable for {name} has an invalid name. Fix env in launch.json."));
                    }
                    if let Some(value) = value.as_str() {
                        option.env.insert(key.clone(), value.into());
                    }
                }
            }
            option.port = entry.get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0);
            options.push(option);
        }
    }
    if let Some(package) = read_json(&root.join("package.json"))? {
        let manager = if root.join("pnpm-lock.yaml").exists() {
            "pnpm"
        } else if root.join("yarn.lock").exists() {
            "yarn"
        } else if root.join("bun.lockb").exists() || root.join("bun.lock").exists() {
            "bun"
        } else {
            "npm"
        };
        for script in ["dev", "start", "serve", "preview", "storybook"] {
            if package.get("scripts").and_then(|s| s.get(script)).and_then(Value::as_str).is_some() {
                options.push(make(format!("package:{script}"), script.into(), format!("{manager} run {script}")));
            }
        }
    }
    if root.join("bin/dev").is_file() {
        options.push(make("bin:dev".into(), "bin/dev".into(), "bin/dev".into()));
    }
    if root.join("manage.py").is_file() {
        options.push(make("django".into(), "Django".into(), "python3 manage.py runserver".into()));
    }
    let custom = choice.map(|c| c.custom.clone()).unwrap_or_default();
    if !custom.trim().is_empty() {
        options.push(make("custom".into(), "Custom command".into(), custom.clone()));
    }
    let selected = choice
        .map(|c| &c.selected)
        .filter(|id| options.iter().any(|o| &o.id == *id))
        .cloned()
        .unwrap_or_else(|| options.first().map(|o| o.id.clone()).unwrap_or_default());
    Ok(Candidates {
        folder: root.to_string_lossy().into(),
        options,
        selected,
        custom,
    })
}

pub fn candidates(app: &tauri::AppHandle, folder: &str) -> Result<Candidates, String> {
    let key = folder_path(folder)?.to_string_lossy().to_string();
    let state = app.state::<crate::AppState>();
    let choice = state.config.lock().unwrap().dev_servers.get(&key).cloned();
    discover(&key, choice.as_ref())
}

pub fn select(app: &tauri::AppHandle, folder: &str, selected: &str, custom: &str) -> Result<Candidates, String> {
    let key = folder_path(folder)?.to_string_lossy().to_string();
    let choice = Choice {
        selected: selected.into(),
        custom: custom.trim().into(),
    };
    let found = discover(&key, Some(&choice))?;
    if !found.options.iter().any(|o| o.id == selected) {
        return Err("Choose a command, or enter a custom command first.".into());
    }
    let state = app.state::<crate::AppState>();
    state.config.lock().unwrap().dev_servers.insert(key, choice);
    state.save_config();
    let _ = app.emit("config://changed", state.config.lock().unwrap().clone());
    Ok(found)
}

pub fn resolve(app: &tauri::AppHandle, folder: &str, option: Option<&str>, custom: Option<&str>) -> Result<Candidate, String> {
    if let Some(command) = custom.filter(|c| !c.trim().is_empty()) {
        return Ok(Candidate {
            id: "custom".into(),
            label: "Custom command".into(),
            command: command.trim().into(),
            cwd: folder_path(folder)?.to_string_lossy().into(),
            env: BTreeMap::new(),
            port: None,
        });
    }
    let mut found = candidates(app, folder)?;
    let id = option.unwrap_or(&found.selected);
    let index = found
        .options
        .iter()
        .position(|o| o.id == id)
        .ok_or("No dev command was found. Choose a custom command in the browser's Run menu.")?;
    Ok(found.options.remove(index))
}

/// Include the working folder and environment in what the permission gate sees.
pub fn gate_command(option: &Candidate) -> String {
    let env = option.env.iter().map(|(k, v)| format!("{k}={}", quote(v))).collect::<Vec<_>>().join(" ");
    format!(
        "cd {} && {}{}",
        quote(&option.cwd),
        if env.is_empty() { String::new() } else { format!("env {env} ") },
        option.command
    )
}

pub fn strip_ansi(line: &str) -> String {
    static ANSI: OnceLock<regex::Regex> = OnceLock::new();
    ANSI.get_or_init(|| regex::Regex::new(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])").unwrap())
        .replace_all(line, "")
        .chars()
        .filter(|c| !c.is_control() || *c == '\t')
        .collect()
}

pub fn local_url(line: &str) -> Option<String> {
    static URL: OnceLock<regex::Regex> = OnceLock::new();
    let re = URL.get_or_init(|| regex::Regex::new(r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):[0-9]+(?:/[^\s<>\x1b]*)?").unwrap());
    re.find_iter(line).find_map(|m| {
        let raw = m.as_str().trim_end_matches([')', ',', ';', '.']);
        let parsed: tauri::Url = raw.parse().ok()?;
        parsed.port_or_known_default()?;
        Some(raw.replacen("://0.0.0.0:", "://localhost:", 1))
    })
}

fn signal(pid: u32, sig: i32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), sig);
    }
    #[cfg(not(unix))]
    let _ = (pid, sig);
}

fn spawn(option: &Candidate) -> Result<std::process::Child, String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    let mut command = Command::new(shell);
    command
        .args(["-lc", &option.command])
        .current_dir(&option.cwd)
        .env("FORCE_COLOR", "1")
        .envs(&option.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| if libc::setsid() < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) });
        }
    }
    command
        .spawn()
        .map_err(|_| "Couldn't start the dev server. Make sure the command and your login shell are installed, then try again.".into())
}

fn read_output(mut pipe: impl Read + Send + 'static, tx: mpsc::SyncSender<String>) {
    std::thread::spawn(move || {
        let mut chunk = [0; 4096];
        let mut line = Vec::new();
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 {
                break;
            }
            for &b in &chunk[..n] {
                if b == b'\n' || b == b'\r' || line.len() == LINE_LIMIT {
                    if !line.is_empty() && tx.send(strip_ansi(&String::from_utf8_lossy(&line))).is_err() {
                        return;
                    }
                    line.clear();
                }
                if b != b'\n' && b != b'\r' {
                    line.push(b);
                }
            }
        }
        if !line.is_empty() {
            let _ = tx.send(strip_ansi(&String::from_utf8_lossy(&line)));
        }
    });
}

impl DevServers {
    fn slot(&self, folder: &str) -> Result<Slot, String> {
        if let Some(slot) = self.sessions.lock().unwrap().get(folder).cloned() {
            return Ok(slot);
        }
        let key = folder_path(folder)?.to_string_lossy().to_string();
        self.sessions
            .lock()
            .unwrap()
            .get(&key)
            .cloned()
            .ok_or("This project hasn't run a dev server yet.".into())
    }
    pub fn list(&self) -> Vec<Server> {
        let mut servers: Vec<_> = self.sessions.lock().unwrap().values().map(|s| s.lock().unwrap().server.clone()).collect();
        servers.sort_by(|a, b| a.folder.cmp(&b.folder));
        servers
    }
    pub fn logs(&self, folder: &str) -> Result<Output, String> {
        let slot = self.slot(folder)?;
        let s = slot.lock().unwrap();
        Ok(s.output(s.lines.iter().cloned().collect()))
    }
    pub fn status(&self, folder: &str) -> Result<Server, String> {
        Ok(self.slot(folder)?.lock().unwrap().server.clone())
    }
    pub fn restart_option(&self, folder: &str) -> Result<Candidate, String> {
        Ok(self.slot(folder)?.lock().unwrap().option.clone())
    }
    pub fn start(&self, app: Option<tauri::AppHandle>, folder: &str, option: Candidate, restart: bool) -> Result<Server, String> {
        let _operation = self.operations.lock().unwrap();
        if self.quitting.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Starkline is quitting.".into());
        }
        let key = folder_path(folder)?.to_string_lossy().to_string();
        let previous = self.sessions.lock().unwrap().get(&key).cloned();
        if let Some(slot) = &previous {
            if restart {
                self.stop_slot(slot);
            } else if slot.lock().unwrap().pid.is_some() {
                return Err("A dev server is already running for this project. Stop it or restart it first.".into());
            }
        }
        let generation = previous.as_ref().map(|s| s.lock().unwrap().server.generation.wrapping_add(1)).unwrap_or(1);
        let mut server = Server {
            folder: key.clone(),
            command: option.command.clone(),
            status: Status::Starting,
            address: None,
            exit_code: None,
            generation,
            open_page: true,
        };
        let spawned = spawn(&option);
        if spawned.is_err() {
            server.status = Status::Crashed;
        }
        let slot = Arc::new(Mutex::new(Session {
            server: server.clone(),
            option: option.clone(),
            pid: spawned.as_ref().ok().map(|c| c.id()),
            stopping: None,
            lines: VecDeque::new(),
            cursor: 0,
        }));
        self.sessions.lock().unwrap().insert(key, slot.clone());
        if let Err(error) = spawned.as_ref() {
            slot.lock().unwrap().append(error.clone());
        }
        if let Some(app) = &app {
            let _ = app.emit("devserver://changed", &server);
        }
        let mut child = spawned?;
        let (tx, rx) = mpsc::sync_channel(256);
        read_output(child.stdout.take().unwrap(), tx.clone());
        read_output(child.stderr.take().unwrap(), tx);
        std::thread::spawn(move || {
            let mut exit = None;
            let mut preferred = false;
            loop {
                let mut fresh = Vec::new();
                for _ in 0..256 {
                    match rx.try_recv() {
                        Ok(line) => fresh.push(line),
                        Err(_) => break,
                    }
                }
                let mut s = slot.lock().unwrap();
                let before = s.server.address.clone();
                for line in &fresh {
                    if s.stopping.is_none() && (s.server.address.is_none() || (!preferred && line.contains("Local:"))) {
                        if let Some(url) = local_url(line) {
                            s.server.address = Some(url);
                            preferred = line.contains("Local:");
                        }
                    }
                    s.append(line.clone());
                }
                if s.stopping.is_none() && s.server.address.is_none() {
                    if let Some(port) = option.port {
                        if std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(30)).is_ok() {
                            s.server.address = Some(format!("http://localhost:{port}"));
                        }
                    }
                }
                if s.server.address.is_some() && s.stopping.is_none() {
                    s.server.status = Status::Running;
                }
                if let Some(app) = &app {
                    if before != s.server.address {
                        let _ = app.emit("devserver://changed", &s.server);
                    }
                    if !fresh.is_empty() {
                        let _ = app.emit("devserver://output", s.output(fresh));
                    }
                }
                if exit.is_none() {
                    exit = child.try_wait().ok().flatten();
                }
                let stopping = s.stopping;
                let finish = stopping.map(|at| at.elapsed() >= GRACE).unwrap_or(exit.is_some());
                if finish {
                    // An exited shell can still leave children holding the output pipes.
                    crate::proc::kill_tree(child.id());
                    if exit.is_none() {
                        exit = child.wait().ok();
                    }
                    // Drain the tail after the group closes its pipes.
                    drop(s);
                    let mut tail = Vec::new();
                    let drain_started = Instant::now();
                    while drain_started.elapsed() < Duration::from_millis(250) {
                        match rx.recv_timeout(Duration::from_millis(30)) {
                            Ok(line) => {
                                if tail.len() == LOG_LIMIT {
                                    tail.remove(0);
                                }
                                tail.push(line);
                            }
                            Err(_) => break,
                        }
                    }
                    let mut s = slot.lock().unwrap();
                    for line in &tail {
                        s.append(line.clone());
                    }
                    s.server.status = if stopping.is_some() { Status::Stopped } else { Status::Crashed };
                    s.server.exit_code = exit.and_then(|e| e.code());
                    s.pid = None;
                    if let Some(app) = &app {
                        if !tail.is_empty() {
                            let _ = app.emit("devserver://output", s.output(tail));
                        }
                        let _ = app.emit("devserver://changed", &s.server);
                    }
                    break;
                }
                drop(s);
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        Ok(server)
    }
    fn request_stop(slot: &Slot) {
        let mut s = slot.lock().unwrap();
        if let Some(pid) = s.pid {
            if s.stopping.is_none() {
                s.stopping = Some(Instant::now());
                #[cfg(unix)]
                signal(pid, libc::SIGTERM);
            }
        }
    }
    fn stop_slot(&self, slot: &Slot) {
        Self::request_stop(slot);
        while slot.lock().unwrap().pid.is_some() {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    pub fn stop(&self, folder: &str) -> Result<Server, String> {
        let _operation = self.operations.lock().unwrap();
        let slot = self.slot(folder)?;
        self.stop_slot(&slot);
        let server = slot.lock().unwrap().server.clone();
        Ok(server)
    }
    pub fn kill_all(&self) {
        self.quitting.store(true, std::sync::atomic::Ordering::SeqCst);
        let _operation = self.operations.lock().unwrap();
        let slots: Vec<_> = self.sessions.lock().unwrap().values().cloned().collect();
        for slot in &slots {
            Self::request_stop(slot);
        }
        for slot in &slots {
            self.stop_slot(slot);
        }
    }
}

/// How much output an agent gets back from one `logs` call: the most recent lines.
const AGENT_LOG_BYTES: usize = 20_000;

/// The last lines that fit in `budget` bytes, oldest first, saying how many were left out.
fn recent_lines(lines: &[String], budget: usize) -> String {
    let mut used = 0;
    let kept = lines
        .iter()
        .rev()
        .take_while(|line| {
            used += line.len() + 1;
            used <= budget
        })
        .count();
    let skipped = lines.len() - kept;
    let tail = lines[skipped..].join("\n");
    if skipped == 0 {
        tail
    } else {
        format!("({skipped} earlier lines left out)\n{tail}")
    }
}

pub fn act(app: &tauri::AppHandle, agent: &str, action: &str, args: &Value) -> Result<crate::browser::Outcome, String> {
    let state = app.state::<crate::AppState>();
    // The folder of the chat the agent asks from: its dev server, not another chat's.
    let folder = crate::runs::cwd(app, &crate::bridge::actor_for(agent, args)).unwrap_or_else(|| state.project.lock().unwrap().clone());
    let manager = app.state::<DevServers>();
    let result = match action {
        "list" => serde_json::to_string(&manager.list()),
        "status" => serde_json::to_string(&manager.status(&folder)?),
        "logs" => {
            let output = manager.logs(&folder)?;
            let filter = args.get("filter").and_then(Value::as_str).unwrap_or("");
            let lines: Vec<String> = output.lines.into_iter().filter(|l| l.contains(filter)).collect();
            return Ok(crate::browser::Outcome::Text(recent_lines(&lines, AGENT_LOG_BYTES)));
        }
        "start" | "restart" => {
            let option = if action == "restart" {
                manager.restart_option(&folder)?
            } else {
                resolve(app, &folder, None, args.get("command").and_then(Value::as_str))?
            };
            let verdict = crate::bridge::decide(app, &crate::bridge::actor_for(agent, args), "Bash", &json!({ "command": gate_command(&option) }));
            if !verdict.approved {
                return Err(verdict.reason);
            }
            let server = manager.start(Some(app.clone()), &folder, option, action == "restart")?;
            let _ = app.emit("browser://reveal", json!({ "agentId": agent }));
            serde_json::to_string(&server)
        }
        "stop" => serde_json::to_string(&manager.stop(&folder)?),
        _ => return Err("Use list, start, stop, restart, logs or status.".into()),
    };
    Ok(crate::browser::Outcome::Text(result.map_err(|e| e.to_string())?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Project(PathBuf);
    impl Project {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!("starkline-devserver-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn folder(&self) -> String {
            self.0.to_string_lossy().into()
        }
        fn write(&self, file: &str, text: &str) {
            let path = self.0.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        fn option(&self, command: &str) -> Candidate {
            Candidate {
                id: "custom".into(),
                label: "Custom command".into(),
                command: command.into(),
                cwd: self.folder(),
                env: BTreeMap::new(),
                port: None,
            }
        }
    }
    impl Drop for Project {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn eventually(mut test: impl FnMut() -> bool) {
        let start = Instant::now();
        while !test() {
            assert!(start.elapsed() < Duration::from_secs(8), "server didn't reach its expected state");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn discovers_launch_scripts_frameworks_and_remembered_custom_in_order() {
        let p = Project::new();
        p.write(".claude/launch.json", r#"{"version":"0.0.1","configurations":[{"name":"web","runtimeExecutable":"npm","runtimeArgs":["run","dev","--","a'b"],"cwd":"web","env":{"MODE":"test mode"},"port":1420}]}"#);
        p.write("web/.keep", "");
        p.write(
            "package.json",
            r#"{"scripts":{"storybook":"x","preview":"x","serve":"x","start":"x","dev":"x","test":"x"}}"#,
        );
        p.write("bin/dev", "");
        p.write("manage.py", "");
        let choice = Choice {
            selected: "custom".into(),
            custom: "bundle exec rails server".into(),
        };
        let found = discover(&p.folder(), Some(&choice)).unwrap();
        assert_eq!(
            found.options.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(),
            [
                "launch:web",
                "package:dev",
                "package:start",
                "package:serve",
                "package:preview",
                "package:storybook",
                "bin:dev",
                "django",
                "custom"
            ]
        );
        assert_eq!(found.selected, "custom");
        assert_eq!(found.options[0].command, "npm run dev -- 'a'\\''b'");
        assert_eq!(found.options[0].port, Some(1420));
        assert!(found.options[0].cwd.ends_with("/web"));
        assert!(gate_command(&found.options[0]).contains("env MODE='test mode' npm run dev"));
        assert_eq!(discover(&p.folder(), None).unwrap().selected, "launch:web");
        assert_eq!(
            discover(
                &p.folder(),
                Some(&Choice {
                    selected: "removed".into(),
                    custom: "".into()
                })
            )
            .unwrap()
            .selected,
            "launch:web"
        );
    }

    #[test]
    fn launch_cwd_can_point_to_a_relative_sibling_and_the_gate_sees_it() {
        let p = Project::new();
        p.write(
            ".claude/launch.json",
            r#"{"configurations":[{"name":"api","runtimeExecutable":"python3","runtimeArgs":["manage.py","runserver"],"cwd":".."}]}"#,
        );
        let found = discover(&p.folder(), None).unwrap();
        let parent = p.0.parent().unwrap().canonicalize().unwrap().to_string_lossy().to_string();
        assert_eq!(found.options[0].cwd, parent);
        assert!(gate_command(&found.options[0]).starts_with(&format!("cd {} && ", quote(&parent))));
    }

    #[test]
    fn remembers_a_launch_choice_when_configurations_move() {
        let p = Project::new();
        let choice = Choice {
            selected: "launch:api".into(),
            custom: String::new(),
        };
        for entries in [
            r#"[{"name":"web","runtimeExecutable":"npm"},{"name":"api","runtimeExecutable":"python3"}]"#,
            r#"[{"name":"api","runtimeExecutable":"python3"},{"name":"web","runtimeExecutable":"npm"}]"#,
        ] {
            p.write(".claude/launch.json", &format!("{{\"configurations\":{entries}}}"));
            assert_eq!(discover(&p.folder(), Some(&choice)).unwrap().selected, "launch:api");
        }
    }

    #[test]
    fn uses_each_package_manager_and_lockfile_priority() {
        for (lock, manager) in [
            ("", "npm"),
            ("pnpm-lock.yaml", "pnpm"),
            ("yarn.lock", "yarn"),
            ("bun.lockb", "bun"),
            ("bun.lock", "bun"),
        ] {
            let p = Project::new();
            p.write("package.json", r#"{"scripts":{"dev":"vite"}}"#);
            if !lock.is_empty() {
                p.write(lock, "");
            }
            assert_eq!(discover(&p.folder(), None).unwrap().options[0].command, format!("{manager} run dev"));
        }
        let p = Project::new();
        p.write("package.json", r#"{"scripts":{"dev":"vite"}}"#);
        for lock in ["pnpm-lock.yaml", "yarn.lock", "bun.lock"] {
            p.write(lock, "");
        }
        assert_eq!(discover(&p.folder(), None).unwrap().options[0].command, "pnpm run dev");
    }

    #[test]
    fn empty_projects_have_no_commands_and_bad_files_have_useful_errors() {
        let p = Project::new();
        assert!(discover(&p.folder(), None).unwrap().options.is_empty());
        p.write("package.json", "{bad");
        assert!(discover(&p.folder(), None).unwrap_err().contains("Fix its JSON"));
        p.write("package.json", "{}");
        p.write(
            ".claude/launch.json",
            &json!({ "configurations": [{ "runtimeExecutable": "npm", "cwd": p.folder() }] }).to_string(),
        );
        assert!(discover(&p.folder(), None).unwrap_err().contains("relative folder"));
    }

    #[test]
    fn finds_local_addresses_in_vite_next_rails_django_and_ipv6_output() {
        for (line, url) in [
            ("  ➜  Local:   http://localhost:5173/", "http://localhost:5173/"),
            ("  - Local: http://localhost:3000", "http://localhost:3000"),
            ("* Listening on http://127.0.0.1:3000", "http://127.0.0.1:3000"),
            ("Starting development server at http://0.0.0.0:8000/", "http://localhost:8000/"),
            ("Listening on https://[::1]:8080/", "https://[::1]:8080/"),
            ("Local: http://localhost:80/", "http://localhost:80/"),
            ("Local: https://localhost:443/", "https://localhost:443/"),
        ] {
            assert_eq!(local_url(line).as_deref(), Some(url));
        }
        for line in [
            "https://example.com:3000/",
            "http://localhost/",
            "http://192.168.0.2:5173",
            "http://localhost:99999/",
        ] {
            assert_eq!(local_url(line), None);
        }
        assert_eq!(
            strip_ansi("\x1b[32mLocal:\x1b[0m http://localhost:5173/\x1b]0;title\x07"),
            "Local: http://localhost:5173/"
        );
    }

    #[test]
    fn agents_get_the_most_recent_output_that_fits() {
        let lines: Vec<String> = (0..10).map(|n| format!("line {n}")).collect();
        assert_eq!(recent_lines(&lines, 1_000), lines.join("\n"));
        assert_eq!(recent_lines(&lines, 14), "(8 earlier lines left out)\nline 8\nline 9");
        assert_eq!(recent_lines(&[], 10), "");
    }

    #[test]
    fn the_log_keeps_the_last_two_thousand_lines() {
        let p = Project::new();
        let mut session = Session {
            server: Server {
                folder: p.folder(),
                command: "x".into(),
                status: Status::Starting,
                address: None,
                exit_code: None,
                generation: 1,
                open_page: false,
            },
            option: p.option("x"),
            pid: None,
            stopping: None,
            lines: VecDeque::new(),
            cursor: 0,
        };
        for i in 0..2_100 {
            session.append(i.to_string());
        }
        assert_eq!(session.lines.len(), LOG_LIMIT);
        assert_eq!(session.lines.front().unwrap(), "100");
        assert_eq!(session.lines.back().unwrap(), "2099");
        assert_eq!(session.output(vec![]).cursor, 2_100);
    }

    #[test]
    fn captures_both_pipes_and_reports_a_crash_with_the_exit_code() {
        let p = Project::new();
        let manager = DevServers::default();
        assert_eq!(
            manager
                .start(None, &p.folder(), p.option("printf 'hello\\n'; printf 'failed\\n' >&2; exit 7"), false)
                .unwrap()
                .status,
            Status::Starting
        );
        eventually(|| manager.status(&p.folder()).unwrap().status == Status::Crashed);
        assert_eq!(manager.status(&p.folder()).unwrap().exit_code, Some(7));
        let logs = manager.logs(&p.folder()).unwrap().lines;
        assert!(logs.contains(&"hello".into()) && logs.contains(&"failed".into()));
    }

    #[test]
    fn a_configured_port_becomes_running_without_a_printed_url() {
        let p = Project::new();
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = socket.local_addr().unwrap().port();
        let manager = DevServers::default();
        let mut option = p.option("sleep 30");
        option.port = Some(port);
        manager.start(None, &p.folder(), option, false).unwrap();
        eventually(|| manager.status(&p.folder()).unwrap().status == Status::Running);
        assert_eq!(manager.status(&p.folder()).unwrap().address, Some(format!("http://localhost:{port}")));
        manager.kill_all();
        assert_eq!(manager.status(&p.folder()).unwrap().status, Status::Stopped);
        assert!(manager.start(None, &p.folder(), p.option("sleep 30"), false).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn stop_kills_the_group_and_restart_gets_a_new_run() {
        let p = Project::new();
        let manager = DevServers::default();
        let command = "printf '\\033[32m Local: http://localhost:5173/\\033[0m\\n'; sh -c 'sleep 30 & echo $! > child.pid; wait'";
        let started = manager.start(None, &p.folder(), p.option(command), false).unwrap();
        eventually(|| manager.status(&p.folder()).unwrap().status == Status::Running && p.0.join("child.pid").exists());
        assert!(manager.start(None, &p.folder(), p.option("sleep 30"), false).is_err());
        let pid = manager.slot(&p.folder()).unwrap().lock().unwrap().pid.unwrap();
        let child: i32 = std::fs::read_to_string(p.0.join("child.pid")).unwrap().trim().parse().unwrap();
        assert_eq!(manager.stop(&p.folder()).unwrap().status, Status::Stopped);
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
        // Linux's container init may keep a killed grandchild as a zombie.
        let zombie = std::fs::read_to_string(format!("/proc/{child}/stat"))
            .ok()
            .is_some_and(|s| s.split(')').nth(1).is_some_and(|tail| tail.trim_start().starts_with('Z')));
        assert!(unsafe { libc::kill(child, 0) } == -1 || zombie, "the grandchild must not survive");
        assert!(manager.logs(&p.folder()).unwrap().lines[0].contains("Local:"));
        let next = manager.start(None, &p.folder(), p.option("exit 9"), true).unwrap();
        assert_eq!(next.generation, started.generation + 1);
        eventually(|| manager.status(&p.folder()).unwrap().status == Status::Crashed);
        assert_eq!(manager.status(&p.folder()).unwrap().exit_code, Some(9));
    }

    #[test]
    #[cfg(unix)]
    fn stop_escalates_when_the_server_ignores_term() {
        let p = Project::new();
        let manager = DevServers::default();
        manager
            .start(
                None,
                &p.folder(),
                p.option("trap '' TERM; printf 'Local: http://localhost:3000\\n'; sleep 30 & wait"),
                false,
            )
            .unwrap();
        eventually(|| manager.status(&p.folder()).unwrap().status == Status::Running);
        let pid = manager.slot(&p.folder()).unwrap().lock().unwrap().pid.unwrap();
        let stop_started = Instant::now();
        assert_eq!(manager.stop(&p.folder()).unwrap().status, Status::Stopped);
        assert!(stop_started.elapsed() >= GRACE);
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
    }

    #[test]
    #[cfg(unix)]
    fn aliases_share_one_server_and_local_line_wins() {
        use std::os::unix::fs::symlink;
        let p = Project::new();
        let alias_project = Project::new();
        let alias = alias_project.0.join("project");
        symlink(&p.0, &alias).unwrap();
        let manager = DevServers::default();
        let command = "printf 'Listening at http://127.0.0.1:3000\\n  Local: http://localhost:5173/\\n'; sleep 30";
        manager.start(None, &alias.to_string_lossy(), p.option(command), false).unwrap();
        eventually(|| manager.status(&p.folder()).unwrap().address.as_deref() == Some("http://localhost:5173/"));
        assert!(manager.start(None, &p.folder(), p.option(command), false).is_err());
        manager.kill_all();
    }

    #[test]
    fn preferences_round_trip_and_old_config_defaults_to_no_preferences() {
        let mut cfg = crate::config::default_config();
        cfg.dev_servers.insert(
            "/project".into(),
            Choice {
                selected: "custom".into(),
                custom: "npm run dev".into(),
            },
        );
        let value = serde_json::to_value(&cfg).unwrap();
        let restored: crate::config::AppConfig = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(restored.dev_servers["/project"].custom, "npm run dev");
        let mut old = value;
        old.as_object_mut().unwrap().remove("dev_servers");
        assert!(serde_json::from_value::<crate::config::AppConfig>(old).unwrap().dev_servers.is_empty());
    }
}
