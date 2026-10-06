use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

const CAPACITY: usize = 256 * 1024;
const FRAME: Duration = Duration::from_millis(16);
/// Less than this is someone typing, so it's sent at once rather than batched.
const INTERACTIVE: usize = 4096;
/// How often an idle terminal checks whether its shell has exited.
const EXIT_CHECK: Duration = Duration::from_millis(500);

/// Add whatever output arrives before `deadline`. Returns whether the output has ended.
fn gather(rx: &mpsc::Receiver<Vec<u8>>, data: &mut Vec<u8>, deadline: Instant) -> bool {
    while data.len() < CAPACITY {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(bytes) => data.extend(bytes),
            Err(mpsc::RecvTimeoutError::Disconnected) => return true,
            Err(mpsc::RecvTimeoutError::Timeout) => break,
        }
    }
    false
}

#[derive(Clone, Serialize, specta::Type)]
pub struct TerminalInfo {
    pub id: String,
    pub folder: String,
    pub title: String,
    pub shell: String,
    pub alive: bool,
    pub exit_code: Option<u32>,
    pub program_running: bool,
    pub note: Option<String>,
}

#[derive(Clone, Serialize, specta::Type)]
pub struct TerminalOutput {
    pub data: Vec<u8>,
    // Position after these bytes, so replay and live output never overlap.
    pub offset: u32,
    pub exit_code: Option<u32>,
}

#[derive(Default)]
struct Ring {
    bytes: VecDeque<u8>,
    offset: u32,
}

impl Ring {
    fn push(&mut self, data: &[u8]) {
        self.offset = self.offset.wrapping_add(data.len() as u32);
        self.bytes.extend(data);
        if self.bytes.len() > CAPACITY {
            self.bytes.drain(..self.bytes.len() - CAPACITY);
        }
    }

    fn replay(&self, exit_code: Option<u32>) -> TerminalOutput {
        TerminalOutput {
            data: self.bytes.iter().copied().collect(),
            offset: self.offset,
            exit_code,
        }
    }
}

struct Session {
    info: TerminalInfo,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
    pid: u32,
    output: Ring,
    channel: Option<Channel<TerminalOutput>>,
}

impl Session {
    fn program_running(&self) -> bool {
        #[cfg(unix)]
        {
            self.info.alive
                && self
                    .master
                    .process_group_leader()
                    .is_some_and(|p| p > 0 && p as u32 != self.pid)
        }
        #[cfg(not(unix))]
        {
            false
        }
    }

    fn stop(&mut self) {
        // Jobs have separate groups but share the terminal's session, even after shell exit.
        #[cfg(unix)]
        if self.pid != 0 {
            if let Ok(output) = std::process::Command::new("ps")
                .args(["-axo", "pid="])
                .output()
            {
                let groups: std::collections::HashSet<i32> =
                    String::from_utf8_lossy(&output.stdout)
                        .split_whitespace()
                        .filter_map(|pid| pid.parse::<i32>().ok())
                        .filter(|pid| unsafe { libc::getsid(*pid) } == self.pid as i32)
                        .map(|pid| unsafe { libc::getpgid(pid) })
                        .filter(|group| *group > 0)
                        .collect();
                for group in groups {
                    crate::proc::kill_tree(group as u32);
                }
            }
            if let Some(group) = self
                .master
                .process_group_leader()
                .filter(|group| *group > 0)
            {
                unsafe {
                    libc::kill(-group, libc::SIGKILL);
                }
            }
            if self.info.alive {
                crate::proc::kill_tree(self.pid);
            }
        }
        if self.info.alive {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        self.info.alive = false;
    }
}

#[derive(Clone, Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    next: Arc<std::sync::atomic::AtomicU64>,
}

fn size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if cols == 0 || rows == 0 {
        return Err("The terminal needs a width and height. Try opening it again.".into());
    }
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn folder_or_home(folder: &str) -> Result<(String, Option<String>), String> {
    if !folder.is_empty() && Path::new(folder).is_dir() {
        return Ok((folder.into(), None));
    }
    let home = std::env::var("HOME")
        .map_err(|_| "Choose an existing folder before opening a terminal.")?;
    if !Path::new(&home).is_dir() {
        return Err("Choose an existing folder before opening a terminal.".into());
    }
    let note = if folder.is_empty() {
        "No project folder was selected. This terminal opened in your home folder."
    } else {
        "That folder isn't available. This terminal opened in your home folder."
    };
    Ok((home, Some(note.into())))
}

impl TerminalManager {
    pub fn open(&self, folder: &str, cols: u16, rows: u16) -> Result<TerminalInfo, String> {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/zsh".into());
        self.spawn(folder, &shell, cols, rows)
    }

    fn spawn(
        &self,
        folder: &str,
        shell: &str,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalInfo, String> {
        let (folder, note) = folder_or_home(folder)?;
        let pair = native_pty_system()
            .openpty(size(cols, rows)?)
            .map_err(|e| e.to_string())?;
        let mut command = CommandBuilder::new(shell);
        command.arg("-l");
        command.cwd(&folder);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        if std::env::var("LANG").unwrap_or_default().is_empty() {
            command.env("LANG", "en_US.UTF-8");
        }
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let child = pair.slave.spawn_command(command).map_err(|_| {
            "The login shell couldn't start. Check your shell setting and try again.".to_string()
        })?;
        let pid = child.process_id().unwrap_or(0);
        drop(pair.slave);
        let id = format!(
            "terminal-{}",
            self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let shell_name = Path::new(shell)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let info = TerminalInfo {
            id: id.clone(),
            folder,
            shell: shell_name.clone(),
            title: shell_name,
            alive: true,
            exit_code: None,
            program_running: false,
            note,
        };
        self.sessions.lock().unwrap().insert(
            id.clone(),
            Session {
                info: info.clone(),
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                child,
                pid,
                output: Ring::default(),
                channel: None,
            },
        );
        // Bound pending output and batch IPC once per frame, even during a large cat.
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(32);
        std::thread::spawn(move || {
            let mut buf = [0; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let sessions = self.sessions.clone();
        std::thread::spawn(move || {
            let mut ended = false;
            loop {
                let mut data = Vec::new();
                // Sleep until there's output, waking now and then to notice the shell
                // exiting while a background job still holds the terminal open.
                if !ended {
                    match rx.recv_timeout(EXIT_CHECK) {
                        Ok(bytes) => {
                            data.extend(bytes);
                            while data.len() < CAPACITY {
                                let Ok(bytes) = rx.try_recv() else { break };
                                data.extend(bytes);
                            }
                            // A keystroke's echo goes straight out; a flood is sent once a frame.
                            if data.len() >= INTERACTIVE {
                                ended = gather(&rx, &mut data, Instant::now() + FRAME);
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => ended = true,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                }
                let mut sessions = sessions.lock().unwrap();
                let Some(session) = sessions.get_mut(&id) else {
                    break;
                };
                session.output.push(&data);
                // Report shell exit even if a background job still holds the slave.
                let exit = if session.info.alive {
                    session
                        .child
                        .try_wait()
                        .ok()
                        .flatten()
                        .map(|s| s.exit_code())
                } else {
                    None
                };
                if let Some(code) = exit {
                    session.info.alive = false;
                    session.info.exit_code = Some(code);
                }
                if !data.is_empty() || exit.is_some() {
                    if let Some(channel) = &session.channel {
                        let _ = channel.send(TerminalOutput {
                            data,
                            offset: session.output.offset,
                            exit_code: exit,
                        });
                    }
                }
                if ended && !session.info.alive {
                    break;
                }
                drop(sessions);
                if ended {
                    std::thread::sleep(EXIT_CHECK);
                }
            }
        });
        Ok(info)
    }

    pub fn list(&self) -> Vec<TerminalInfo> {
        let sessions = self.sessions.lock().unwrap();
        let mut items: Vec<_> = sessions
            .values()
            .map(|s| {
                let mut info = s.info.clone();
                info.program_running = s.program_running();
                info
            })
            .collect();
        items.sort_by(|a, b| a.id.cmp(&b.id));
        items
    }

    pub fn attach(
        &self,
        id: &str,
        channel: Channel<TerminalOutput>,
    ) -> Result<TerminalOutput, String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(id)
            .ok_or("This terminal has closed. Open a new terminal to continue.")?;
        session.channel = Some(channel);
        Ok(session.output.replay(session.info.exit_code))
    }

    pub fn title(&self, id: &str, title: String) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(id).ok_or("This terminal has closed.")?;
        session.info.title = title
            .chars()
            .filter(|c| !c.is_control())
            .take(160)
            .collect();
        Ok(())
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        // A large paste can block. Let the output worker keep draining the PTY.
        let writer = {
            let sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get(id)
                .ok_or("This terminal has closed. Open a new terminal to continue.")?;
            if !session.info.alive {
                return Err("The shell has exited. Restart this terminal to continue.".into());
            }
            session.writer.clone()
        };
        let mut writer = writer.lock().unwrap();
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|_| "Couldn't send input. Restart this terminal and try again.".into())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .get(id)
            .ok_or("This terminal has closed.")?
            .master
            .resize(size(cols, rows)?)
            .map_err(|e| e.to_string())
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        let session = self.sessions.lock().unwrap().remove(id);
        if let Some(mut session) = session {
            session.stop();
        }
        Ok(())
    }

    pub fn kill_all(&self) {
        let sessions = std::mem::take(&mut *self.sessions.lock().unwrap());
        for (_, mut session) in sessions {
            session.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wait_for(manager: &TerminalManager, id: &str, text: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let output = manager
                .sessions
                .lock()
                .unwrap()
                .get(id)
                .unwrap()
                .output
                .replay(None);
            if String::from_utf8_lossy(&output.data).contains(text) {
                return;
            }
            assert!(Instant::now() < deadline, "missing output: {text}");
            std::thread::sleep(FRAME);
        }
    }
    #[test]
    fn ring_keeps_and_replays_the_exact_tail() {
        let mut ring = Ring::default();
        ring.push(&vec![b'a'; CAPACITY]);
        ring.push(&[0xf0, 0x9f]);
        ring.push(&[0x98, 0x80, 27, b'[', b'm']);
        let replay = ring.replay(Some(3));
        assert_eq!(replay.data.len(), CAPACITY);
        assert_eq!(
            &replay.data[CAPACITY - 7..],
            &[0xf0, 0x9f, 0x98, 0x80, 27, b'[', b'm']
        );
        assert_eq!(replay.offset, (CAPACITY + 7) as u32);
        assert_eq!(replay.exit_code, Some(3));
    }
    #[test]
    fn login_shell_output_resize_foreground_and_close() {
        let manager = TerminalManager::default();
        let folder =
            std::env::temp_dir().join(format!("starkline-terminal-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let info = manager
            .spawn(folder.to_str().unwrap(), "/bin/bash", 80, 24)
            .unwrap();
        let pid = manager.sessions.lock().unwrap()[&info.id].pid;
        manager
            .write(&info.id, "echo terminal-test-$PWD\n")
            .unwrap();
        wait_for(
            &manager,
            &info.id,
            &format!("terminal-test-{}", folder.display()),
        );
        manager.resize(&info.id, 100, 30).unwrap();
        assert_eq!(
            manager.sessions.lock().unwrap()[&info.id]
                .master
                .get_size()
                .unwrap()
                .cols,
            100
        );
        manager.write(&info.id, "sleep 30\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !manager.list()[0].program_running {
            assert!(Instant::now() < deadline, "foreground job wasn't detected");
            std::thread::sleep(FRAME);
        }
        manager.close(&info.id).unwrap();
        assert!(manager.list().is_empty());
        #[cfg(unix)]
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
        std::fs::remove_dir_all(folder).unwrap();
    }
    #[test]
    fn exit_retains_scrollback_and_code() {
        let manager = TerminalManager::default();
        let info = manager
            .spawn(std::env::temp_dir().to_str().unwrap(), "/bin/bash", 80, 24)
            .unwrap();
        manager
            .write(&info.id, "printf 'retained-output\\n'; exit 7\n")
            .unwrap();
        wait_for(&manager, &info.id, "retained-output");
        let deadline = Instant::now() + Duration::from_secs(3);
        while manager.list()[0].alive {
            assert!(Instant::now() < deadline);
            std::thread::sleep(FRAME);
        }
        assert_eq!(manager.list()[0].exit_code, Some(7));
        manager.close(&info.id).unwrap();
    }
    #[test]
    fn unavailable_folder_falls_back_with_a_note() {
        let (folder, note) = folder_or_home("/a-folder-that-does-not-exist/starkline").unwrap();
        assert_eq!(folder, std::env::var("HOME").unwrap());
        assert!(note.unwrap().contains("home folder"));
        assert!(size(0, 20).is_err());
    }
    #[test]
    fn attaches_without_losing_or_repeating_bytes() {
        let manager = TerminalManager::default();
        let info = manager
            .spawn(std::env::temp_dir().to_str().unwrap(), "/bin/bash", 80, 24)
            .unwrap();
        manager.write(&info.id, "echo before-attach\n").unwrap();
        wait_for(&manager, &info.id, "before-attach");
        let (tx, rx) = mpsc::channel();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                tx.send(json).unwrap();
            }
            Ok(())
        });
        let snapshot = manager.attach(&info.id, channel).unwrap();
        let mut bytes = snapshot.data;
        let mut offset = snapshot.offset;
        manager
            .write(&info.id, "printf '\\360\\237\\232\\200\\n'\n")
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !String::from_utf8_lossy(&bytes).contains('🚀') {
            let json = rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            let output: serde_json::Value = serde_json::from_str(&json).unwrap();
            let data: Vec<u8> = serde_json::from_value(output["data"].clone()).unwrap();
            let next = output["offset"].as_u64().unwrap() as u32;
            assert_eq!(next.wrapping_sub(offset), data.len() as u32);
            offset = next;
            bytes.extend(data);
        }
        manager.title(&info.id, "npm run dev\n".into()).unwrap();
        assert_eq!(manager.list()[0].title, "npm run dev");
        manager.close(&info.id).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn quitting_stops_background_job_groups_too() {
        let manager = TerminalManager::default();
        let info = manager
            .spawn(std::env::temp_dir().to_str().unwrap(), "/bin/bash", 80, 24)
            .unwrap();
        manager
            .write(
                &info.id,
                "sleep 30 & echo background-pid-$!; disown; exit\n",
            )
            .unwrap();
        let pattern = regex::Regex::new("background-pid-([0-9]+)").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let pid = loop {
            let output = manager.sessions.lock().unwrap()[&info.id]
                .output
                .replay(None);
            if let Some(capture) = pattern.captures(&String::from_utf8_lossy(&output.data)) {
                break capture[1].to_string();
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(FRAME);
        };
        while manager.list()[0].alive {
            assert!(Instant::now() < deadline, "shell did not exit");
            std::thread::sleep(FRAME);
        }
        manager.kill_all();
        assert!(manager.list().is_empty());
        loop {
            let output = std::process::Command::new("ps")
                .args(["-p", &pid, "-o", "stat="])
                .output()
                .unwrap();
            let status = String::from_utf8_lossy(&output.stdout);
            if status.trim().is_empty() || status.trim().starts_with('Z') {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "background job was still running"
            );
            std::thread::sleep(FRAME);
        }
    }
}
