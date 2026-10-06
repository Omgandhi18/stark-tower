//! Simulator controls shared by the panel and the agents' tool.
use crate::attachments::{self, Attachment};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// The most device log text kept, shown, or handed to an agent.
const LOG_LIMIT: usize = 20 * 1024;
/// Streamed log lines are gathered this long and shown together, not one event per line.
const LOG_BATCH: Duration = Duration::from_millis(250);
/// The furthest back an agent can read the device logs, in minutes.
const LOG_MINUTES: u64 = 60;
/// The panel asks for state every two seconds; simctl is asked for the appearance at most this often.
const APPEARANCE_FRESH: Duration = Duration::from_secs(30);
const INTERRUPT: i32 = 2;
const TERMINATE: i32 = 15;

#[derive(Debug, Default, Serialize, Deserialize, specta::Type)]
pub struct ExtraArgs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latitude: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub longitude: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minutes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predicate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Recording {
    pub path: String,
    pub started: f64,
}
#[derive(Debug, Clone, Default, Serialize, specta::Type)]
pub struct ExtraState {
    pub recording: Option<Recording>,
    pub saved: Option<Attachment>,
    pub appearance: String,
    pub last_bundle: String,
    pub status_bar: bool,
    pub logs: String,
}
#[derive(Default)]
struct DeviceState {
    state: ExtraState,
    recorder: Option<Child>,
    logger: Option<Child>,
    log_generation: u64,
    appearance_read: Option<Instant>,
}
impl DeviceState {
    fn begin_recording(&mut self, child: Child, path: String) {
        self.state.saved = None;
        self.state.recording = Some(Recording {
            path,
            started: chrono::Utc::now().timestamp_millis() as f64,
        });
        self.recorder = Some(child);
    }

    fn end_recording(&mut self) -> Result<(), String> {
        let mut child = self.recorder.take().ok_or("This simulator isn't recording.")?;
        let recording = self.state.recording.take().ok_or("This simulator isn't recording.")?;
        stop(&mut child, INTERRUPT)?;
        let saved = attachments::describe(std::path::Path::new(&recording.path)).filter(|a| a.size > 0);
        self.state.saved = Some(saved.ok_or("The recording had no video. Try recording again.")?);
        Ok(())
    }

    fn appearance_stale(&self) -> bool {
        self.appearance_read.is_none_or(|at| at.elapsed() > APPEARANCE_FRESH)
    }
}

fn devices() -> &'static Mutex<HashMap<String, DeviceState>> {
    static DEVICES: OnceLock<Mutex<HashMap<String, DeviceState>>> = OnceLock::new();
    DEVICES.get_or_init(Default::default)
}
pub fn launched(udid: &str, bundle: &str) {
    devices().lock().unwrap().entry(udid.into()).or_default().state.last_bundle = bundle.into();
}
pub fn trim_logs(text: &str) -> String {
    let mut start = text.len().saturating_sub(LOG_LIMIT);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].into()
}
fn number(args: &Value, key: &str) -> Result<f64, String> {
    args.get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .ok_or_else(|| format!("Give a valid {key}."))
}
fn text<'a>(args: &'a Value, key: &str) -> &'a str {
    args.get(key).and_then(Value::as_str).unwrap_or("")
}
fn words(s: &[&str]) -> Vec<String> {
    s.iter().map(|s| s.to_string()).collect()
}
pub fn action_args(udid: &str, action: &str, args: &Value) -> Result<Vec<String>, String> {
    Ok(match action {
        "appearance" => {
            let mode = text(args, "mode");
            if !["light", "dark"].contains(&mode) {
                return Err("Choose light or dark appearance.".into());
            }
            words(&["ui", udid, "appearance", mode])
        }
        "location" if args.get("clear").and_then(Value::as_bool) == Some(true) => words(&["location", udid, "clear"]),
        "location" => {
            let (lat, lon) = (number(args, "latitude")?, number(args, "longitude")?);
            if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
                return Err("Latitude must be between −90 and 90, longitude between −180 and 180.".into());
            }
            words(&["location", udid, "set", &format!("{lat},{lon}")])
        }
        "push" => {
            if text(args, "bundle_id").is_empty() {
                return Err("Give the app's bundle id.".into());
            }
            let payload: Value = serde_json::from_str(text(args, "payload")).map_err(|_| "The push payload must be valid JSON.".to_string())?;
            if !payload.is_object() {
                return Err("The push payload must be a JSON object.".into());
            }
            words(&["push", udid, text(args, "bundle_id"), "-"])
        }
        "status_bar" if args.get("enabled").and_then(Value::as_bool) != Some(true) => words(&["status_bar", udid, "clear"]),
        "status_bar" => words(&[
            "status_bar",
            udid,
            "override",
            "--time",
            "9:41",
            "--dataNetwork",
            "wifi",
            "--wifiMode",
            "active",
            "--wifiBars",
            "3",
            "--cellularMode",
            "active",
            "--cellularBars",
            "4",
            "--batteryState",
            "charged",
            "--batteryLevel",
            "100",
        ]),
        "record_start" => words(&["io", udid, "recordVideo", "--codec=h264", "--force", text(args, "path")]),
        "logs_start" => words(&["spawn", udid, "log", "stream", "--style", "compact", "--level", "info"]),
        "logs" => {
            let minutes = args.get("minutes").and_then(Value::as_u64).unwrap_or(5).clamp(1, LOG_MINUTES);
            let mut out = words(&["spawn", udid, "log", "show", "--last", &format!("{minutes}m"), "--style", "compact"]);
            let predicate = text(args, "predicate");
            let process = text(args, "process");
            if !predicate.is_empty() {
                out.extend(words(&["--predicate", predicate]));
            }
            if !process.is_empty() {
                out.extend(words(&["--process", process]));
            }
            out
        }
        _ => return Err("That simulator control isn't available.".into()),
    })
}
fn command(args: &[String]) -> Command {
    let mut cmd = Command::new("/usr/bin/xcrun");
    cmd.arg("simctl").args(args).stdin(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid is async-signal-safe; the child gets its own process group so stopping it stops what it started.
        unsafe {
            cmd.pre_exec(|| if libc::setsid() < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) });
        }
    }
    cmd
}
fn checked(args: &[String], input: Option<&str>) -> Result<String, String> {
    let mut child = command(args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("The simulator control couldn't run: {e}"))?;
    if let Some(input) = input {
        child
            .stdin
            .take()
            .ok_or("The push couldn't be sent.")?
            .write_all(input.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr)
            .lines()
            .next()
            .unwrap_or("The simulator control failed.")
            .into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}
/// Runs a command that can print far more than is wanted, keeping only the end of it.
fn tail(mut cmd: Command) -> Result<String, String> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("The simulator control couldn't run: {e}"))?;
    let (Some(stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err("The device logs couldn't be read.".into());
    };
    let complaint = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let mut kept = String::new();
    // Split on bytes: a line that isn't UTF-8 mustn't stop the reading and leave the command blocked.
    for line in BufReader::new(stdout).split(b'\n').map_while(Result::ok) {
        kept.push_str(&String::from_utf8_lossy(&line));
        kept.push('\n');
        if kept.len() > 2 * LOG_LIMIT {
            kept = trim_logs(&kept);
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let complaint = complaint.join().unwrap_or_default();
    if !status.success() {
        return Err(complaint.lines().next().unwrap_or("The simulator control failed.").into());
    }
    Ok(trim_logs(&kept))
}
/// `first` and the lines that arrive within `window` of it, as text.
fn batch(first: Vec<u8>, lines: &mpsc::Receiver<Vec<u8>>, window: Duration) -> String {
    let until = Instant::now() + window;
    let mut text = String::from_utf8_lossy(&first).into_owned() + "\n";
    while let Ok(line) = lines.recv_timeout(until.saturating_duration_since(Instant::now())) {
        text.push_str(&String::from_utf8_lossy(&line));
        text.push('\n');
        if text.len() > 2 * LOG_LIMIT {
            text = trim_logs(&text);
        }
    }
    text
}
/// Follows a device's log stream until it ends or is replaced, telling the panel about it in batches.
fn follow_logs(app: tauri::AppHandle, udid: String, generation: u64, stdout: std::process::ChildStdout) {
    let (tx, lines) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).split(b'\n').map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    std::thread::spawn(move || {
        while let Ok(first) = lines.recv() {
            let fresh = batch(first, &lines, LOG_BATCH);
            let logs = {
                let mut all = devices().lock().unwrap();
                let Some(d) = all.get_mut(&udid) else { return };
                if d.logger.is_none() || d.log_generation != generation {
                    return;
                }
                d.state.logs = trim_logs(&(std::mem::take(&mut d.state.logs) + &fresh));
                d.state.logs.clone()
            };
            let _ = app.emit("simulator://logs", serde_json::json!({ "udid": udid, "text": logs }));
        }
    });
}
/// A recording stopped with SIGINT exits cleanly, or reports the interrupt.
fn finished_cleanly(status: ExitStatus) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.success() || status.code() == Some(130) || status.signal() == Some(INTERRUPT)
    }
    #[cfg(not(unix))]
    {
        status.success()
    }
}
fn stop(child: &mut Child, signal: i32) -> Result<(), String> {
    if child.try_wait().map_err(|e| e.to_string())?.is_none() {
        #[cfg(unix)]
        // SAFETY: plain signals to the child's own process group, or to the child if that fails.
        unsafe {
            if libc::kill(-(child.id() as i32), signal) != 0 {
                libc::kill(child.id() as i32, signal);
            }
        }
        #[cfg(not(unix))]
        child.kill().map_err(|e| e.to_string())?;
    }
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if signal == INTERRUPT && !finished_cleanly(status) {
                return Err("The recording couldn't finish. Try recording again.".into());
            }
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(15) {
            crate::proc::kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return Err("The simulator process didn't finish in time. Try again.".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
pub fn cleanup() {
    let mut all = devices().lock().unwrap();
    for d in all.values_mut() {
        if let Some(mut child) = d.recorder.take() {
            let _ = stop(&mut child, INTERRUPT);
        }
        if let Some(mut child) = d.logger.take() {
            let _ = stop(&mut child, TERMINATE);
        }
        d.state.recording = None;
    }
}
pub fn control(app: &tauri::AppHandle, udid: &str, action: &str, args: &Value) -> Result<ExtraState, String> {
    // Stop works after a device shuts down; all other actions need a running device.
    if !["state", "logs_stop", "record_stop", "logs_clear"].contains(&action) {
        let status = crate::simulator::status();
        if !status.devices.iter().any(|d| d.udid == udid && d.booted) {
            return Err("Boot this simulator first.".into());
        }
    }
    // simctl can take seconds, so it runs before the devices are locked: the panel and the log reader don't wait on it.
    let mut appearance = None;
    match action {
        "logs" => {
            let logs = tail(command(&action_args(udid, action, args)?))?;
            return Ok(ExtraState { logs, ..Default::default() });
        }
        "appearance" | "location" | "push" | "status_bar" => {
            checked(&action_args(udid, action, args)?, (action == "push").then(|| text(args, "payload")))?;
        }
        "state" if devices().lock().unwrap().get(udid).is_none_or(DeviceState::appearance_stale) => {
            appearance = checked(&words(&["ui", udid, "appearance"]), None).ok().map(|mode| mode.trim().to_lowercase());
        }
        _ => {}
    }
    let mut all = devices().lock().unwrap();
    let d = all.entry(udid.into()).or_default();
    match action {
        "state" => {
            if d.recorder.as_mut().is_some_and(|child| child.try_wait().ok().flatten().is_some()) {
                d.end_recording()?;
            }
            if d.logger.as_mut().is_some_and(|child| child.try_wait().ok().flatten().is_some()) {
                d.logger = None;
            }
            if let Some(mode) = appearance {
                d.state.appearance = mode;
                d.appearance_read = Some(Instant::now());
            }
        }
        "record_start" => {
            if d.recorder.is_some() {
                return Err("This simulator is already recording.".into());
            }
            let base = attachments::root(app);
            std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
            let stamp = chrono::Utc::now().timestamp_millis();
            let root = base.join(format!("recording-{stamp}-{}-{}", std::process::id(), crate::simulator::next_file()));
            std::fs::create_dir(&root).map_err(|e| e.to_string())?;
            let path = root.join("simulator-recording.mp4").to_string_lossy().to_string();
            let mut child = command(&action_args(udid, action, &serde_json::json!({ "path": path }))?)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| e.to_string())?;
            std::thread::sleep(Duration::from_millis(100));
            if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                return Err("Recording couldn't start. Check that the simulator is running.".into());
            }
            d.begin_recording(child, path);
        }
        "record_stop" => d.end_recording()?,
        "logs_start" if d.logger.is_none() => {
            let mut child = command(&action_args(udid, action, args)?)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| e.to_string())?;
            let stdout = child.stdout.take().ok_or("The device logs couldn't be read.")?;
            d.logger = Some(child);
            d.log_generation += 1;
            follow_logs(app.clone(), udid.to_string(), d.log_generation, stdout);
        }
        "logs_start" => {}
        "logs_stop" => {
            if let Some(mut child) = d.logger.take() {
                let _ = stop(&mut child, TERMINATE);
            }
        }
        "logs_clear" => d.state.logs.clear(),
        "appearance" => {
            d.state.appearance = text(args, "mode").into();
            d.appearance_read = Some(Instant::now());
        }
        "status_bar" => d.state.status_bar = args.get("enabled").and_then(Value::as_bool) == Some(true),
        "location" | "push" => {}
        _ => return Err("That simulator control isn't available.".into()),
    }
    Ok(d.state.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recording_state_waits_for_the_process_and_keeps_the_finished_video() {
        let root = std::env::temp_dir().join(format!("stark-record-test-{}-{}", std::process::id(), crate::simulator::next_file()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("movie.mp4");
        let mut d = DeviceState::default();
        assert!(d.end_recording().is_err());
        // This stand-in finishes its output before exiting, as recordVideo does.
        let child = Command::new("sh")
            .args(["-c", "printf video > \"$1\"", "record", file.to_str().unwrap()])
            .spawn()
            .unwrap();
        d.begin_recording(child, file.to_string_lossy().into_owned());
        assert!(d.state.recording.is_some());
        d.recorder.as_mut().unwrap().wait().unwrap();
        d.end_recording().unwrap();
        assert!(d.recorder.is_none());
        assert!(d.state.recording.is_none());
        let saved = d.state.saved.as_ref().unwrap();
        assert_eq!(saved.size, 5);
        assert_eq!(saved.kind, attachments::AttachmentKind::Video);
        let child = Command::new("sh").args(["-c", "exit 0"]).spawn().unwrap();
        d.begin_recording(child, root.join("missing.mp4").to_string_lossy().into_owned());
        assert!(d.state.saved.is_none());
        d.recorder.as_mut().unwrap().wait().unwrap();
        assert!(d.end_recording().is_err());
        assert!(d.state.recording.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn stopping_a_recording_interrupts_and_reaps_the_process() {
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        stop(&mut child, INTERRUPT).unwrap();
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn simctl_arguments_keep_data_separate_from_options() {
        assert_eq!(
            action_args("U", "appearance", &json!({"mode":"dark"})).unwrap(),
            ["ui", "U", "appearance", "dark"]
        );
        assert!(action_args("U", "appearance", &json!({"mode":"other"})).is_err());
        assert_eq!(
            action_args("U", "location", &json!({"latitude":51.5,"longitude":-0.12})).unwrap(),
            ["location", "U", "set", "51.5,-0.12"]
        );
        assert_eq!(action_args("U", "location", &json!({"clear":true})).unwrap(), ["location", "U", "clear"]);
        assert!(action_args("U", "location", &json!({"latitude":91,"longitude":0})).is_err());
        assert_eq!(
            action_args("U", "push", &json!({"bundle_id":"app.test","payload":"{\"aps\":{}}"})).unwrap(),
            ["push", "U", "app.test", "-"]
        );
        assert!(action_args("U", "push", &json!({"bundle_id":"app.test","payload":"oops"})).is_err());
        assert_eq!(
            action_args("U", "record_start", &json!({"path":"/a b/movie.mp4"})).unwrap(),
            ["io", "U", "recordVideo", "--codec=h264", "--force", "/a b/movie.mp4"]
        );
        assert_eq!(
            action_args("U", "logs_start", &json!({})).unwrap(),
            ["spawn", "U", "log", "stream", "--style", "compact", "--level", "info"]
        );
        assert_eq!(
            action_args("U", "logs", &json!({"minutes":3,"predicate":"subsystem == 'app'","process":"My App"})).unwrap(),
            [
                "spawn",
                "U",
                "log",
                "show",
                "--last",
                "3m",
                "--style",
                "compact",
                "--predicate",
                "subsystem == 'app'",
                "--process",
                "My App"
            ]
        );
        assert_eq!(action_args("U", "logs", &json!({"minutes":1440})).unwrap()[5], "60m");
        assert_eq!(action_args("U", "status_bar", &json!({"enabled":false})).unwrap(), ["status_bar", "U", "clear"]);
        assert_eq!(
            action_args("U", "status_bar", &json!({"enabled":true})).unwrap(),
            [
                "status_bar",
                "U",
                "override",
                "--time",
                "9:41",
                "--dataNetwork",
                "wifi",
                "--wifiMode",
                "active",
                "--wifiBars",
                "3",
                "--cellularMode",
                "active",
                "--cellularBars",
                "4",
                "--batteryState",
                "charged",
                "--batteryLevel",
                "100"
            ]
        );
    }
    #[test]
    fn trims_logs_on_a_utf8_boundary() {
        let text = "😀".repeat(6000);
        let trimmed = trim_logs(&text);
        assert!(trimmed.len() <= LOG_LIMIT);
        assert!(text.ends_with(&trimmed));
    }

    #[test]
    #[cfg(unix)]
    fn reading_logs_keeps_only_the_end_past_lines_that_arent_utf8() {
        let mut cmd = Command::new("sh");
        cmd.args([
            "-c",
            "i=0; while [ $i -lt 3000 ]; do echo \"line $i of the device log\"; i=$((i+1)); done; printf 'bad \\377 byte\\nlast line\\n'",
        ]);
        let logs = tail(cmd).unwrap();
        assert!(logs.len() <= LOG_LIMIT);
        assert!(logs.ends_with("bad \u{fffd} byte\nlast line\n"));
        assert!(logs.contains("line 2999 of the device log"));
        assert!(!logs.contains("line 0 of the device log"));
        let mut failing = Command::new("sh");
        failing.args(["-c", "echo 'No devices are booted.' >&2; exit 1"]);
        assert_eq!(tail(failing).unwrap_err(), "No devices are booted.");
    }

    #[test]
    fn streamed_lines_arrive_together_in_one_batch() {
        let (tx, rx) = mpsc::channel();
        for line in ["second", "third"] {
            tx.send(line.as_bytes().to_vec()).unwrap();
        }
        tx.send(vec![0xff]).unwrap();
        assert_eq!(batch(b"first".to_vec(), &rx, Duration::from_millis(50)), "first\nsecond\nthird\n\u{fffd}\n");
        let started = Instant::now();
        assert_eq!(batch(b"alone".to_vec(), &rx, Duration::from_millis(50)), "alone\n");
        assert!(started.elapsed() >= Duration::from_millis(50));
        drop(tx);
        assert_eq!(batch(b"last".to_vec(), &rx, Duration::from_secs(5)), "last\n");
    }
}
