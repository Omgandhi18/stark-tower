// Reproduces stark-tower's spawn_session pty setup in isolation to debug the
// `assertion failed: output.write(&bytes).is_ok()` abort.
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;
use std::time::Duration;

fn main() {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 28,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();

    let mut cmd = CommandBuilder::new("claude");
    let home = std::env::var("HOME").unwrap();
    let cwd = std::env::var("TESTCWD").unwrap_or_else(|_| home.clone());
    eprintln!("[cwd = {cwd}]");
    cmd.cwd(&cwd);
    // MINIMAL clean env — bisecting the abort.
    cmd.env_clear();
    cmd.env("HOME", &home);
    cmd.env(
        "PATH",
        format!("{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"),
    );
    cmd.env("TERM", "xterm-256color");
    cmd.env("LANG", "en_US.UTF-8");
    cmd.env("USER", std::env::var("USER").unwrap_or_else(|_| "user".into()));
    cmd.env("SHELL", "/bin/zsh");

    // FIX UNDER TEST: begin draining the master BEFORE the child launches,
    // so claude's first (large) trust-prompt frame never hits a full buffer.
    let mut reader = pair.master.try_clone_reader().unwrap();
    let _writer = pair.master.take_writer().unwrap();

    let handle = std::thread::spawn(move || {
        let mut s = String::new();
        let mut b = [0u8; 8192];
        loop {
            match reader.read(&mut b) {
                Ok(0) => break,
                Ok(n) => {
                    s.push_str(&String::from_utf8_lossy(&b[..n]));
                    if s.len() > 20000 {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        s
    });

    let mut child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);

    std::thread::sleep(Duration::from_secs(4));
    let _ = child.kill();
    let s = handle.join().unwrap_or_default();
    println!("=== BYTES: {} · HAS_FATAL: {} ===", s.len(), s.contains("fatal runtime error"));
    let escaped: String = s.escape_debug().take(700).collect();
    println!("RAW: {escaped}");
}
