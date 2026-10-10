//! Where CLIs live on this Mac. An app started from Finder gets launchd's minimal
//! PATH, and nvm, fnm, mise, asdf, OpenCode and friends add their folders from
//! shell rc files that only an interactive shell reads. So at launch Starkline
//! asks the developer's login shell for its PATH (`$SHELL -lic`, as VS Code does),
//! and searches that ahead of the well-known install folders. "Check again" reads
//! it once more in the background, so a CLI installed into a new folder is found
//! without a restart; sessions already running keep the PATH they started with.
//!
//! Only PATH crosses over: shell functions and aliases (a `claude` wrapper, say)
//! never do, and a lookup only accepts executable files.

use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, OnceLock, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;

/// How long a slow or broken shell rc may take before Starkline gives up on it.
const SHELL_TIMEOUT: Duration = Duration::from_secs(6);
/// Brackets the PATH in the shell's output, so rc-file chatter is ignored.
const MARKER: &str = "__STARKLINE_PATH__";
/// Set while the shell runs, so an rc file can skip slow work for Starkline.
const RESOLVING_VAR: &str = "STARKLINE_RESOLVING_ENVIRONMENT";

/// What reading the login shell's PATH came to, for Diagnostics.
#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ShellPathHealth {
    /// The shell asked, e.g. "/bin/zsh".
    pub shell: String,
    /// Its PATH was read; otherwise CLIs are looked for in the standard install folders only.
    pub read: bool,
    /// Why it couldn't be read, when it couldn't.
    pub error: Option<String>,
    pub elapsed_ms: u32,
    /// Folders the shell's PATH added to the one Starkline started with.
    pub added: u32,
    /// When it was read (or tried), in ms since the epoch.
    pub read_at: i64,
    /// It's being read again right now; until then the last reading is used.
    pub reading: bool,
}

struct ShellPath {
    health: ShellPathHealth,
    /// Every folder searched, in order: the shell's PATH, version-manager and
    /// standard install folders, then the PATH Starkline started with.
    dirs: Vec<String>,
}

/// The latest reading of the shell's PATH, replaced whole by a re-read.
struct Resolver {
    current: OnceLock<RwLock<Arc<ShellPath>>>,
    rereading: AtomicBool,
    load: Box<dyn Fn() -> ShellPath + Send + Sync>,
}

impl Resolver {
    fn new(load: impl Fn() -> ShellPath + Send + Sync + 'static) -> Resolver {
        Resolver { current: OnceLock::new(), rereading: AtomicBool::new(false), load: Box::new(load) }
    }

    /// The latest reading; the first call reads the shell (other callers wait for it).
    fn get(&self) -> Arc<ShellPath> {
        let lock = self.current.get_or_init(|| RwLock::new(Arc::new((self.load)())));
        lock.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Read the shell again on a background thread, then call `done`. Lookups keep
    /// the last reading until the new one is in. False if a re-read is already running.
    fn reread(&'static self, done: impl FnOnce() + Send + 'static) -> bool {
        if self.rereading.swap(true, Ordering::AcqRel) {
            return false;
        }
        std::thread::spawn(move || {
            let fresh = Arc::new((self.load)());
            let lock = self.current.get_or_init(|| RwLock::new(fresh.clone()));
            *lock.write().unwrap_or_else(|e| e.into_inner()) = fresh;
            self.rereading.store(false, Ordering::Release);
            done();
        });
        true
    }

    fn health(&self) -> ShellPathHealth {
        let reading = self.rereading.load(Ordering::Acquire);
        ShellPathHealth { reading, ..self.get().health.clone() }
    }
}

static RESOLVER: LazyLock<Resolver> = LazyLock::new(|| Resolver::new(|| load(&login_shell(), SHELL_TIMEOUT)));

/// Read the shell's PATH in the background at startup, so the first lookup doesn't wait for it.
pub fn prime() {
    std::thread::spawn(|| {
        RESOLVER.get();
    });
}

/// Read the login shell's PATH again in the background (same timeout and markers),
/// then call `done`. CLI lookups and new processes use it from then on.
/// False if a re-read was already running; its `done` covers this one too.
pub fn reread(done: impl FnOnce() + Send + 'static) -> bool {
    RESOLVER.reread(done)
}

pub fn health() -> ShellPathHealth {
    RESOLVER.health()
}

/// The PATH every CLI Starkline starts gets: the same folders, in the same order, it searched.
pub fn child_path() -> String {
    RESOLVER.get().dirs.join(":")
}

/// A CLI's absolute path: an explicit path (`~/` allowed) if it's an executable
/// file, else the first executable of that name on the search path. Never a
/// shell function or alias.
pub fn which(cmd: &str) -> Option<String> {
    which_in(&RESOLVER.get().dirs, cmd, &std::env::var("HOME").unwrap_or_default())
}

fn which_in(dirs: &[String], cmd: &str, home: &str) -> Option<String> {
    let cmd = cmd.trim();
    if cmd.is_empty() {
        return None;
    }
    if cmd.contains('/') {
        let cmd = match cmd.strip_prefix("~/") {
            Some(rest) if !home.is_empty() => format!("{home}/{rest}"),
            _ => cmd.to_string(),
        };
        return is_executable(Path::new(&cmd)).then_some(cmd);
    }
    find_in(dirs, cmd)
}

fn find_in(dirs: &[String], cmd: &str) -> Option<String> {
    dirs.iter().map(|d| format!("{d}/{cmd}")).find(|p| is_executable(Path::new(p)))
}

fn is_executable(path: &Path) -> bool {
    std::fs::metadata(path).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

fn load(shell: &str, timeout: Duration) -> ShellPath {
    let shell = shell.to_string();
    let started = Instant::now();
    let read = read_login_path(&shell, timeout);
    let inherited = split(&std::env::var("PATH").unwrap_or_default());
    let home = std::env::var("HOME").unwrap_or_default();
    let shell_dirs = read.clone().unwrap_or_default();
    let added = shell_dirs.iter().filter(|d| !inherited.contains(d)).count() as u32;
    let dirs = dedupe(shell_dirs.into_iter().chain(fallback_dirs(&home)).chain(inherited));
    ShellPath {
        health: ShellPathHealth {
            shell,
            read: read.is_ok(),
            error: read.err(),
            elapsed_ms: started.elapsed().as_millis().min(u32::MAX as u128) as u32,
            added,
            read_at: chrono::Utc::now().timestamp_millis(),
            reading: false,
        },
        dirs,
    }
}

/// The developer's login shell: $SHELL, else their account's shell, else zsh.
fn login_shell() -> String {
    if let Ok(s) = std::env::var("SHELL") {
        if !s.trim().is_empty() {
            return s;
        }
    }
    // SAFETY: getpwuid returns a pointer into static storage, read straight away on this thread.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if !pw.is_null() && !(*pw).pw_shell.is_null() {
            if let Ok(s) = std::ffi::CStr::from_ptr((*pw).pw_shell).to_str() {
                if !s.is_empty() {
                    return s.to_string();
                }
            }
        }
    }
    "/bin/zsh".into()
}

/// Ask an interactive login shell for its PATH, giving up after `timeout`. The
/// shell runs in its own process group, so a hung rc file is killed whole.
fn read_login_path(shell: &str, timeout: Duration) -> Result<Vec<String>, String> {
    let script = format!("echo {MARKER}; /usr/bin/printenv PATH; echo {MARKER}");
    let mut cmd = Command::new(shell);
    cmd.args(["-l", "-i", "-c", &script])
        .env(RESOLVING_VAR, "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0);
    if std::env::var_os("TERM").is_none() {
        cmd.env("TERM", "dumb");
    }
    let mut child = cmd.spawn().map_err(|e| format!("{shell} couldn't start: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no output")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        let _ = tx.send(out);
    });
    match rx.recv_timeout(timeout) {
        Ok(out) => {
            let _ = child.wait();
            parse_marked(&String::from_utf8_lossy(&out)).ok_or_else(|| format!("{shell} didn't print its PATH"))
        }
        Err(_) => {
            crate::proc::kill_tree(child.id());
            let _ = child.wait();
            Err(format!("{shell} took longer than {}s to start", timeout.as_secs_f32()))
        }
    }
}

/// The PATH between the first pair of markers, as absolute folders.
fn parse_marked(out: &str) -> Option<Vec<String>> {
    let (_, rest) = out.split_once(MARKER)?;
    let (path, _) = rest.split_once(MARKER)?;
    let dirs = split(path.trim());
    (!dirs.is_empty()).then_some(dirs)
}

fn split(path: &str) -> Vec<String> {
    path.split(':').map(str::trim).filter(|d| d.starts_with('/')).map(String::from).collect()
}

fn dedupe(dirs: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    dirs.filter(|d| seen.insert(d.clone())).collect()
}

/// Where CLIs and version managers install, for when the shell can't be read:
/// per-user bins, nvm's default Node, fnm/mise/asdf/Volta shims, then Homebrew.
fn fallback_dirs(home: &str) -> Vec<String> {
    let nvm_dir = std::env::var("NVM_DIR").unwrap_or_else(|_| format!("{home}/.nvm"));
    let mut dirs = vec![
        format!("{home}/.local/bin"),
        format!("{home}/.claude/local"),
        format!("{home}/.opencode/bin"),
        format!("{home}/.bun/bin"),
        format!("{home}/.volta/bin"),
    ];
    dirs.extend(nvm_default_bin(Path::new(&nvm_dir)));
    dirs.extend([
        format!("{home}/.local/share/fnm/aliases/default/bin"),
        format!("{home}/Library/Application Support/fnm/aliases/default/bin"),
        format!("{home}/.local/share/mise/shims"),
        format!("{home}/.asdf/shims"),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        "/usr/bin".into(),
        "/bin".into(),
    ]);
    dirs
}

/// The bin folder of nvm's default Node: the newest installed version matching
/// `alias/default` (following alias chains like default → lts/iron), else the newest.
fn nvm_default_bin(nvm_dir: &Path) -> Option<String> {
    let versions = nvm_dir.join("versions/node");
    let mut installed: Vec<String> = std::fs::read_dir(&versions)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.starts_with('v'))
        .collect();
    installed.sort_by_key(|v| version_key(v));
    let mut alias = "default".to_string();
    for _ in 0..4 {
        match std::fs::read_to_string(nvm_dir.join("alias").join(&alias)) {
            Ok(next) => alias = next.trim().to_string(),
            Err(_) => break,
        }
    }
    let wanted = alias.trim_start_matches('v');
    let numeric = wanted.chars().next().is_some_and(|c| c.is_ascii_digit());
    let pick = installed
        .iter()
        .rev()
        .find(|v| numeric && (v[1..] == *wanted || v[1..].starts_with(&format!("{wanted}."))))
        .or(installed.last())?;
    Some(versions.join(pick).join("bin").to_string_lossy().into_owned())
}

fn version_key(v: &str) -> Vec<u64> {
    v.trim_start_matches('v').split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("stark-shellenv-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn script(dir: &Path, name: &str, body: &str) -> String {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn reads_the_path_between_markers_and_ignores_rc_noise() {
        let out = format!("Welcome!\n{MARKER}\n/a/bin:relative:/b/bin:\n{MARKER}\nbye\n");
        assert_eq!(parse_marked(&out), Some(vec!["/a/bin".to_string(), "/b/bin".to_string()]));
        assert_eq!(parse_marked("no markers here"), None);
    }

    #[test]
    fn a_noisy_shell_still_yields_its_path() {
        let dir = scratch("noisy");
        let shell = script(&dir, "shell", &format!("echo 'oh-my-zsh says hi'\necho {MARKER}\necho /x/bin:/y/bin\necho {MARKER}"));
        assert_eq!(read_login_path(&shell, Duration::from_secs(5)).unwrap(), vec!["/x/bin", "/y/bin"]);
    }

    #[test]
    fn a_hung_shell_is_abandoned_within_the_timeout() {
        let dir = scratch("hung");
        let shell = script(&dir, "shell", "sleep 30");
        let started = Instant::now();
        let err = read_login_path(&shell, Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("longer than"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_reread_finds_a_cli_in_a_new_folder_without_blocking() {
        let dir = scratch("reread");
        let (old, new) = (dir.join("old"), dir.join("new"));
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        let installed = script(&new, "newcli", "true");
        let path_file = dir.join("path");
        std::fs::write(&path_file, old.to_string_lossy().as_bytes()).unwrap();
        let shell = script(&dir, "shell", &format!("sleep 0.4\necho {MARKER}\ncat '{}'\necho\necho {MARKER}", path_file.display()));
        let resolver: &'static Resolver = Box::leak(Box::new(Resolver::new(move || load(&shell, Duration::from_secs(5)))));

        let first = resolver.get();
        assert!(first.health.read, "{:?}", first.health.error);
        assert_eq!(find_in(&first.dirs, "newcli"), None);

        // The developer installs into a new folder and adds it to their rc file.
        std::fs::write(&path_file, format!("{}:{}", new.display(), old.display())).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let started = Instant::now();
        assert!(resolver.reread(move || tx.send(()).unwrap()));
        assert!(started.elapsed() < Duration::from_millis(200), "the re-read blocked the caller");
        assert!(!resolver.reread(|| panic!("a second re-read started")), "one re-read at a time");
        assert!(resolver.health().reading);
        assert_eq!(find_in(&resolver.get().dirs, "newcli"), None, "the last reading holds until the new one is in");

        rx.recv_timeout(Duration::from_secs(5)).expect("the re-read finished");
        let fresh = resolver.get();
        assert_eq!(find_in(&fresh.dirs, "newcli"), Some(installed));
        let health = resolver.health();
        assert!(!health.reading);
        assert!(health.read_at >= first.health.read_at);
        // A process started earlier keeps the PATH it was given.
        assert_eq!(find_in(&first.dirs, "newcli"), None);
    }

    #[test]
    fn a_failed_reread_falls_back_to_the_install_folders() {
        let dir = scratch("reread-hung");
        let shell = script(&dir, "shell", "sleep 30");
        let resolver: &'static Resolver = Box::leak(Box::new(Resolver::new(move || load(&shell, Duration::from_millis(300)))));
        let health = resolver.health();
        assert!(!health.read);
        assert!(health.error.unwrap().contains("longer than"));
        assert!(resolver.get().dirs.contains(&"/usr/bin".to_string()));
    }

    #[test]
    fn explicit_paths_must_be_executable_files_and_may_start_with_home() {
        let dir = scratch("explicit");
        let home = dir.to_string_lossy().into_owned();
        let tool = script(&dir, "tool", "true");
        std::fs::write(dir.join("notes"), "data").unwrap();
        assert_eq!(which_in(&[], &tool, &home), Some(tool.clone()));
        assert_eq!(which_in(&[], "~/tool", &home), Some(tool));
        assert_eq!(which_in(&[], "~/notes", &home), None);
        assert_eq!(which_in(&[], &home, &home), None, "a folder isn't a CLI");
        assert_eq!(which_in(&[], "  ", &home), None);
    }

    #[test]
    fn lookups_skip_folders_and_non_executables() {
        let dir = scratch("which");
        let (a, b) = (dir.join("a"), dir.join("b"));
        std::fs::create_dir_all(a.join("tool")).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("tool"), "data").unwrap();
        let c = dir.join("c");
        std::fs::create_dir_all(&c).unwrap();
        let real = script(&c, "tool", "true");
        let dirs: Vec<String> = [a, b, c].iter().map(|d| d.to_string_lossy().into_owned()).collect();
        assert_eq!(find_in(&dirs, "tool"), Some(real));
        assert_eq!(find_in(&dirs, "missing"), None);
    }

    #[test]
    fn nvm_default_follows_the_alias_to_the_newest_matching_install() {
        let nvm = scratch("nvm");
        for v in ["v18.20.1", "v24.2.0", "v24.14.0", "v25.0.0"] {
            std::fs::create_dir_all(nvm.join("versions/node").join(v).join("bin")).unwrap();
        }
        std::fs::create_dir_all(nvm.join("alias/lts")).unwrap();
        let bin = |v: &str| nvm.join("versions/node").join(v).join("bin").to_string_lossy().into_owned();

        std::fs::write(nvm.join("alias/default"), "24\n").unwrap();
        assert_eq!(nvm_default_bin(&nvm), Some(bin("v24.14.0")));

        std::fs::write(nvm.join("alias/default"), "lts/hydrogen").unwrap();
        std::fs::write(nvm.join("alias/lts/hydrogen"), "v18.20.1").unwrap();
        assert_eq!(nvm_default_bin(&nvm), Some(bin("v18.20.1")));

        std::fs::write(nvm.join("alias/default"), "node").unwrap();
        assert_eq!(nvm_default_bin(&nvm), Some(bin("v25.0.0")));

        std::fs::remove_file(nvm.join("alias/default")).unwrap();
        assert_eq!(nvm_default_bin(&nvm), Some(bin("v25.0.0")));
    }

    #[test]
    fn duplicate_folders_keep_their_first_place() {
        let dirs = dedupe(["/a", "/b", "/a", "/c", "/b"].into_iter().map(String::from));
        assert_eq!(dirs, vec!["/a", "/b", "/c"]);
    }

    /// Prints what this Mac's login shell yields. Run with `-- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_login_shell_path() {
        let h = health();
        println!("{h:?}");
        for cli in ["claude", "codex", "opencode", "node"] {
            println!("{cli}: {:?}", which(cli));
        }
        assert!(h.read, "{:?}", h.error);
    }
}
