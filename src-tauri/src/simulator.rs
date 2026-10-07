//! The iOS Simulator beside a conversation, through Xcode's `simctl`: the
//! simulators there are, booting one, its screen (screenshots taken a few times a
//! second while the panel shows it), and opening links and apps on it. Taps,
//! swipes, typing and the Home button go through AXe (one Homebrew install), or
//! idb (Meta's iOS Development Bridge) when that's what's there; without either,
//! the Simulator app takes them. Agents get the
//! same through the `simulator` tool, to see what their app looks like.

use serde::Serialize;
use serde_json::Value;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

const XCRUN: &str = "/usr/bin/xcrun";
const NO_XCODE: &str = "The iOS Simulator needs Xcode. Install it from the App Store and open it once to finish setting up.";
const NO_TOUCH: &str = "To tap, swipe and type from Starkline, install AXe: run `brew install cameroncooke/axe/axe` in Terminal (idb works too). Until then, use Open in Simulator.";

static SHOT: AtomicU64 = AtomicU64::new(0);

/// A number for a new file's name, unique in this run.
pub fn next_file() -> u64 {
    SHOT.fetch_add(1, Ordering::Relaxed)
}

/// Each device's pixels per point, once asked.
fn scales() -> &'static std::sync::Mutex<std::collections::HashMap<String, f64>> {
    static SCALES: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, f64>>> = std::sync::OnceLock::new();
    SCALES.get_or_init(Default::default)
}

/// A simulator Xcode has.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct SimDevice {
    pub udid: String,
    pub name: String,
    /// "iOS 26.0"
    pub runtime: String,
    pub booted: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SimulatorStatus {
    /// Xcode's simulator tools answered.
    pub available: bool,
    /// What's missing, when something is.
    pub problem: Option<String>,
    pub devices: Vec<SimDevice>,
    /// AXe or idb is installed, so taps, swipes and typing go through from Starkline.
    pub touch: bool,
}

fn first_line(text: &str) -> String {
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("The simulator didn't do that.").to_string()
}

fn simctl(args: &[&str]) -> Result<Output, String> {
    Command::new(XCRUN).arg("simctl").args(args).output().map_err(|_| NO_XCODE.to_string())
}

/// Run `simctl` and keep what it printed, or say why it failed.
fn checked(args: &[&str]) -> Result<String, String> {
    let out = simctl(args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(first_line(&String::from_utf8_lossy(&out.stderr)))
    }
}

/// "com.apple.CoreSimulator.SimRuntime.iOS-26-0" → "iOS 26.0".
pub fn runtime_name(key: &str) -> String {
    let short = key.rsplit('.').next().unwrap_or(key);
    let mut parts = short.split('-');
    let os = parts.next().unwrap_or(short);
    let version: Vec<&str> = parts.collect();
    if version.is_empty() {
        os.to_string()
    } else {
        format!("{os} {}", version.join("."))
    }
}

fn version_of(runtime: &str) -> Vec<u32> {
    runtime.split(' ').nth(1).unwrap_or("").split('.').filter_map(|n| n.parse().ok()).collect()
}

/// The iOS simulators in `simctl list devices available --json`: booted ones
/// first, then the newest iOS, then by name.
pub fn parse_devices(json: &str) -> Vec<SimDevice> {
    let Ok(listed) = serde_json::from_str::<Value>(json) else { return vec![] };
    let mut devices: Vec<SimDevice> = listed
        .get("devices")
        .and_then(|d| d.as_object())
        .into_iter()
        .flatten()
        .filter(|(runtime, _)| runtime.contains("SimRuntime.iOS"))
        .flat_map(|(runtime, list)| {
            let runtime = runtime_name(runtime);
            list.as_array().cloned().unwrap_or_default().into_iter().filter_map(move |d| {
                if d.get("isAvailable").and_then(|a| a.as_bool()) == Some(false) {
                    return None;
                }
                Some(SimDevice {
                    udid: d.get("udid")?.as_str()?.to_string(),
                    name: d.get("name")?.as_str()?.to_string(),
                    runtime: runtime.clone(),
                    booted: d.get("state").and_then(|s| s.as_str()) == Some("Booted"),
                })
            })
        })
        .collect();
    devices.sort_by(|a, b| b.booted.cmp(&a.booted).then_with(|| version_of(&b.runtime).cmp(&version_of(&a.runtime))).then_with(|| a.name.cmp(&b.name)));
    devices
}

fn idb() -> Option<String> {
    crate::chat::resolve_program("idb")
}

/// What sends taps, swipes and typing to a simulator.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Toucher {
    Axe,
    Idb,
}

/// AXe if it's installed, else idb, with the program's path.
fn toucher() -> Option<(Toucher, String)> {
    crate::chat::resolve_program("axe").map(|p| (Toucher::Axe, p)).or_else(|| idb().map(|p| (Toucher::Idb, p)))
}

/// Something done on the device's screen, in points from its top left.
#[derive(Debug, Clone, PartialEq)]
pub enum Gesture {
    Tap { x: f64, y: f64 },
    Swipe { from: (f64, f64), to: (f64, f64) },
    Text(String),
    Home,
}

/// A gesture's command line (after the program), as each tool spells it. Text goes after
/// `--`, so words that start with a dash are typed rather than read as options.
fn gesture_args(tool: Toucher, gesture: &Gesture, udid: &str) -> Vec<String> {
    let n = |v: f64| format!("{}", v.round());
    let words = |w: &[&str]| w.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let mut args = match (tool, gesture) {
        (Toucher::Axe, Gesture::Tap { x, y }) => vec!["tap".into(), "-x".into(), n(*x), "-y".into(), n(*y)],
        (Toucher::Axe, Gesture::Swipe { from, to }) => {
            vec!["swipe".into(), "--start-x".into(), n(from.0), "--start-y".into(), n(from.1), "--end-x".into(), n(to.0), "--end-y".into(), n(to.1)]
        }
        (Toucher::Axe, Gesture::Text(_)) => words(&["type"]),
        (Toucher::Axe, Gesture::Home) => words(&["button", "home"]),
        (Toucher::Idb, Gesture::Tap { x, y }) => vec!["ui".into(), "tap".into(), n(*x), n(*y)],
        (Toucher::Idb, Gesture::Swipe { from, to }) => vec!["ui".into(), "swipe".into(), n(from.0), n(from.1), n(to.0), n(to.1)],
        (Toucher::Idb, Gesture::Text(_)) => words(&["ui", "text"]),
        (Toucher::Idb, Gesture::Home) => words(&["ui", "button", "HOME"]),
    };
    args.extend(["--udid".to_string(), udid.to_string()]);
    if let Gesture::Text(text) = gesture {
        args.extend(["--".to_string(), text.clone()]);
    }
    args
}

/// Do something on the device's screen.
pub fn gesture(udid: &str, g: &Gesture) -> Result<(), String> {
    let (tool, program) = toucher().ok_or(NO_TOUCH)?;
    let out = Command::new(&program).args(gesture_args(tool, g, udid)).output().map_err(|e| format!("{program} couldn't run: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let said = String::from_utf8_lossy(&out.stderr).to_string() + &String::from_utf8_lossy(&out.stdout);
        Err(first_line(&said))
    }
}

pub fn status() -> SimulatorStatus {
    let unavailable = |problem: &str| SimulatorStatus { available: false, problem: Some(problem.to_string()), devices: vec![], touch: false };
    if !cfg!(target_os = "macos") {
        return unavailable("The iOS Simulator needs a Mac with Xcode.");
    }
    match simctl(&["list", "devices", "available", "--json"]) {
        Ok(out) if out.status.success() => {
            let devices = parse_devices(&String::from_utf8_lossy(&out.stdout));
            let problem = devices.is_empty().then(|| "Xcode has no iOS simulators yet. Add one in Xcode under Window > Devices and Simulators.".to_string());
            SimulatorStatus { available: true, problem, devices, touch: toucher().is_some() }
        }
        _ => unavailable(NO_XCODE),
    }
}

pub fn boot(udid: &str) -> Result<(), String> {
    match checked(&["boot", udid]) {
        Err(e) if !e.contains("current state: Booted") => Err(e),
        _ => Ok(()),
    }
}

pub fn shutdown(udid: &str) -> Result<(), String> {
    checked(&["shutdown", udid]).map(|_| ())
}

/// Open the Simulator app on this device (where it can be used directly).
pub fn open_app(udid: &str) -> Result<(), String> {
    let out = Command::new("/usr/bin/open")
        .args(["-a", "Simulator", "--args", "-CurrentDeviceUDID", udid])
        .output()
        .map_err(|e| format!("The Simulator app couldn't open: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(first_line(&String::from_utf8_lossy(&out.stderr)))
    }
}

/// The device's screen as a JPEG.
pub fn screenshot(udid: &str) -> Result<Vec<u8>, String> {
    let path = std::env::temp_dir().join(format!("starkline-sim-{}-{}.jpg", std::process::id(), SHOT.fetch_add(1, Ordering::Relaxed)));
    let file = path.to_string_lossy().to_string();
    let taken = checked(&["io", udid, "screenshot", "--type=jpeg", &file]);
    let bytes = taken.and_then(|_| std::fs::read(&path).map_err(|e| format!("The screenshot couldn't be read: {e}")));
    let _ = std::fs::remove_file(&path);
    bytes
}

pub fn open_url(udid: &str, url: &str) -> Result<(), String> {
    checked(&["openurl", udid, url]).map(|_| ())
}

pub fn install(udid: &str, app: &str) -> Result<(), String> {
    if !app.ends_with(".app") || !std::path::Path::new(app).is_dir() {
        return Err(format!("{app} isn't a built .app bundle (build for a simulator first)."));
    }
    checked(&["install", udid, app]).map(|_| ())
}

pub fn launch(udid: &str, bundle_id: &str) -> Result<(), String> {
    checked(&["launch", udid, bundle_id])?;
    crate::simulator_extras::launched(udid, bundle_id);
    Ok(())
}

/// The width of the device's screen in points, as AXe's accessibility tree gives it.
fn points_wide(udid: &str) -> Option<f64> {
    let (Toucher::Axe, program) = toucher()? else { return None };
    let out = Command::new(program).args(["describe-ui", "--udid", udid]).output().ok()?;
    let tree: Value = serde_json::from_slice(&out.stdout).ok()?;
    let root = if tree.is_array() { tree.get(0)? } else { &tree };
    root.pointer("/frame/width").and_then(|w| w.as_f64()).filter(|w| *w > 0.0)
}

/// Pixels per point on the device's screen. idb says, or AXe gives the width in points;
/// failing both, iPads and iPhones with narrow (2x) screens are 2x and the rest 3x.
pub fn scale(udid: &str, name: &str, pixels_wide: f64) -> f64 {
    if let Some(known) = scales().lock().unwrap().get(udid) {
        return *known;
    }
    let from_idb = || {
        let out = Command::new(idb()?).args(["describe", "--json", "--udid", udid]).output().ok()?;
        serde_json::from_slice::<Value>(&out.stdout).ok()?.pointer("/screen_dimensions/density").and_then(|d| d.as_f64()).filter(|d| *d > 0.0)
    };
    let measured = from_idb().or_else(|| points_wide(udid).filter(|_| pixels_wide > 0.0).map(|points| (pixels_wide / points).round()));
    match measured {
        Some(s) if s >= 1.0 => {
            scales().lock().unwrap().insert(udid.to_string(), s);
            s
        }
        _ => guessed_scale(name, pixels_wide),
    }
}

/// iPads, and the iPhones with narrow screens (SE, XR, 11), are 2x; the rest are 3x.
pub fn guessed_scale(name: &str, pixels_wide: f64) -> f64 {
    if name.contains("iPad") || (pixels_wide > 0.0 && pixels_wide <= 828.0) {
        2.0
    } else {
        3.0
    }
}

/// A tap where the developer clicked a screenshot, in its pixels.
pub fn tap_pixel(udid: &str, name: &str, x: f64, y: f64, pixels_wide: f64) -> Result<(), String> {
    let s = scale(udid, name, pixels_wide);
    gesture(udid, &Gesture::Tap { x: x / s, y: y / s })
}

/// A swipe where the developer dragged across a screenshot, in its pixels.
pub fn swipe_pixel(udid: &str, name: &str, from: (f64, f64), to: (f64, f64), pixels_wide: f64) -> Result<(), String> {
    let s = scale(udid, name, pixels_wide);
    gesture(udid, &Gesture::Swipe { from: (from.0 / s, from.1 / s), to: (to.0 / s, to.1 / s) })
}

/// The device an agent means: by id or name, else the one that's running.
fn device(wanted: &str, booted_only: bool) -> Result<SimDevice, String> {
    let s = status();
    if !s.available {
        return Err(s.problem.unwrap_or_else(|| NO_XCODE.into()));
    }
    let wanted = wanted.trim().to_lowercase();
    let found = if wanted.is_empty() {
        s.devices.iter().find(|d| d.booted || !booted_only).cloned()
    } else {
        s.devices.iter().find(|d| d.udid.to_lowercase() == wanted || d.name.to_lowercase() == wanted).cloned()
    };
    found.filter(|d| !booted_only || d.booted).ok_or_else(|| {
        if wanted.is_empty() {
            "No simulator is running. Boot one first (action \"boot\").".to_string()
        } else {
            format!("There's no simulator called \"{wanted}\". Ask for \"devices\" to see them.")
        }
    })
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct SimulatorPoint {
    pub device: String,
    pub x: f64,
    pub y: f64,
    pub element: Option<PointElement>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct PointElement {
    pub role: String,
    pub label: String,
    pub value: String,
    pub frame: crate::browser::Bounds,
}

fn frame_of(value: &Value) -> Option<crate::browser::Bounds> {
    let frame = value.get("frame")?;
    let at = |key: &str| frame.get(key)?.as_f64();
    let bounds = crate::browser::Bounds { x: at("x")?, y: at("y")?, width: at("width")?, height: at("height")? };
    let finite = [bounds.x, bounds.y, bounds.width, bounds.height].iter().all(|n| n.is_finite());
    (finite && bounds.width > 0.0 && bounds.height > 0.0).then_some(bounds)
}

/// The deepest element in an accessibility tree (AXe's or idb's) whose frame holds the point.
pub fn element_at(tree: &Value, x: f64, y: f64) -> Option<PointElement> {
    fn search(tree: &Value, x: f64, y: f64, depth: usize, best: &mut Option<(usize, PointElement)>) {
        if let Some(frame) = frame_of(tree) {
            let inside = x >= frame.x && y >= frame.y && x <= frame.x + frame.width && y <= frame.y + frame.height;
            if inside && best.as_ref().is_none_or(|(d, _)| depth >= *d) {
                let text = |keys: &[&str]| {
                    let value = keys.iter().find_map(|k| tree.get(k).filter(|v| !v.is_null()));
                    value.map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).unwrap_or_default()
                };
                let element = PointElement {
                    role: text(&["role", "type", "AXRole"]),
                    label: text(&["AXLabel", "label"]),
                    value: text(&["AXValue", "value"]),
                    frame,
                };
                *best = Some((depth, element));
            }
        }
        match tree {
            Value::Array(items) => {
                for child in items {
                    search(child, x, y, depth + 1, best);
                }
            }
            Value::Object(items) => {
                for (key, child) in items {
                    if key != "frame" {
                        search(child, x, y, depth + 1, best);
                    }
                }
            }
            _ => {}
        }
    }
    let mut best = None;
    search(tree, x, y, 0, &mut best);
    best.map(|(_, v)| v)
}

/// What's at a point the developer clicked on the panel's picture of the screen (in its pixels, `width` wide).
pub fn point(udid: &str, name: &str, x: f64, y: f64, width: f64) -> Result<SimulatorPoint, String> {
    if [x, y, width].iter().any(|n| !n.is_finite() || *n < 0.0) || width == 0.0 {
        return Err("The screen point couldn't be read.".into());
    }
    let scale = scale(udid, name, width);
    let (x, y) = (x / scale, y / scale);
    // Without AXe or idb there's no accessibility tree; the point and picture still go to the chat.
    let element = toucher().and_then(|(tool, program)| {
        let args: Vec<String> = match tool {
            Toucher::Axe => vec!["describe-ui".into(), "--udid".into(), udid.into()],
            Toucher::Idb => vec!["ui".into(), "describe-point".into(), x.to_string(), y.to_string(), "--udid".into(), udid.into()],
        };
        let out = Command::new(program).args(args).output().ok()?;
        if !out.status.success() {
            return None;
        }
        let tree: Value = serde_json::from_slice(&out.stdout).ok()?;
        element_at(&tree, x, y)
    });
    Ok(SimulatorPoint { device: name.into(), x, y, element })
}

/// An agent's `simulator` call.
pub fn act(app: &tauri::AppHandle, action: &str, args: &Value) -> Result<crate::browser::Outcome, String> {
    use crate::browser::Outcome;
    use tauri::Emitter;
    let text = |key: &str| args.get(key).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let reveal = |udid: &str| {
        let _ = app.emit("simulator://reveal", serde_json::json!({ "udid": udid }));
    };
    match action {
        "devices" => {
            let s = status();
            if !s.available {
                return Err(s.problem.unwrap_or_else(|| NO_XCODE.into()));
            }
            let list = s.devices.iter().map(|d| format!("{} ({}){} id {}", d.name, d.runtime, if d.booted { ", running," } else { "," }, d.udid)).collect::<Vec<_>>().join("\n");
            let touch = if s.touch { "Taps, swipes and typing work." } else { "Taps, swipes and typing need AXe (or idb), which isn't installed." };
            Ok(Outcome::Text(format!("{list}\n\n{touch}")))
        }
        "boot" => {
            let d = device(&text("device"), false)?;
            boot(&d.udid)?;
            reveal(&d.udid);
            Ok(Outcome::Text(format!("{} ({}) is running; the developer sees it beside your chat.", d.name, d.runtime)))
        }
        "screenshot" => {
            let d = device(&text("device"), true)?;
            let jpeg = screenshot(&d.udid)?;
            reveal(&d.udid);
            Ok(Outcome::Image { jpeg, caption: format!("{} ({}).", d.name, d.runtime) })
        }
        "open_url" => {
            let d = device(&text("device"), true)?;
            open_url(&d.udid, &text("url"))?;
            Ok(Outcome::Text(format!("Opened {} on {}.", text("url"), d.name)))
        }
        "install" => {
            let d = device(&text("device"), true)?;
            install(&d.udid, &text("path"))?;
            Ok(Outcome::Text(format!("Installed on {}.", d.name)))
        }
        "launch" => {
            let d = device(&text("device"), true)?;
            launch(&d.udid, &text("bundle_id"))?;
            reveal(&d.udid);
            Ok(Outcome::Text(format!("Launched {} on {}.", text("bundle_id"), d.name)))
        }
        "tap" | "swipe" => {
            let d = device(&text("device"), true)?;
            let at = |key: &str| args.get(key).and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())));
            let (Some(x), Some(y)) = (at("x"), at("y")) else { return Err("Give `x` and `y`, in points from the screen's top left.".into()) };
            if action == "tap" {
                gesture(&d.udid, &Gesture::Tap { x, y })?;
                return Ok(Outcome::Text(format!("Tapped ({x}, {y}) on {}. Take a screenshot to see what happened.", d.name)));
            }
            let (Some(to_x), Some(to_y)) = (at("to_x"), at("to_y")) else { return Err("A swipe also needs `to_x` and `to_y`, where it ends.".into()) };
            gesture(&d.udid, &Gesture::Swipe { from: (x, y), to: (to_x, to_y) })?;
            Ok(Outcome::Text(format!("Swiped from ({x}, {y}) to ({to_x}, {to_y}) on {}.", d.name)))
        }
        "type" => {
            let d = device(&text("device"), true)?;
            gesture(&d.udid, &Gesture::Text(text("text")))?;
            Ok(Outcome::Text(format!("Typed on {}.", d.name)))
        }
        "home" => {
            let d = device(&text("device"), true)?;
            gesture(&d.udid, &Gesture::Home)?;
            Ok(Outcome::Text(format!("Went to {}'s home screen.", d.name)))
        }
        "record_start" | "record_stop" | "logs" | "appearance" | "location" | "push" | "status_bar" => {
            let verdict = crate::bridge::decide(app, &crate::bridge::actor_of(args), "mcp__stark__simulator", args);
            if !verdict.approved {
                return Err(verdict.reason);
            }
            // A recording can be stopped after its simulator shut down.
            let d = device(&text("device"), action != "record_stop")?;
            let state = crate::simulator_extras::control(app, &d.udid, action, args)?;
            let on = |b: Option<bool>| b == Some(true);
            Ok(Outcome::Text(match action {
                "record_start" => format!("Recording {}. Stop with record_stop.", d.name),
                "record_stop" => format!("Saved the recording: {}", state.saved.map(|a| a.path).unwrap_or_default()),
                "logs" if state.logs.trim().is_empty() => format!("{} logged nothing that matches in that time.", d.name),
                "logs" => state.logs,
                "appearance" => format!("{} is in {} mode.", d.name, text("mode")),
                "location" if on(args.get("clear").and_then(Value::as_bool)) => format!("Cleared {}'s location.", d.name),
                "location" => format!("Set {}'s location.", d.name),
                "push" => format!("Sent the push to {} on {}.", text("bundle_id"), d.name),
                _ if on(args.get("enabled").and_then(Value::as_bool)) => format!("Cleaned up {}'s status bar.", d.name),
                _ => format!("Restored {}'s status bar.", d.name),
            }))
        }
        other => Err(format!("The simulator has no \"{other}\" action. Use devices, boot, screenshot, open_url, install, launch, tap, swipe, type, home, record_start, record_stop, logs, appearance, location, push or status_bar.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_deepest_accessibility_element_at_the_point() {
        let tree = serde_json::json!([{
            "role":"Application", "frame":{"x":0,"y":0,"width":390,"height":844},
            "children":[{
                "role":"Group", "frame":{"x":0,"y":600,"width":390,"height":120},
                "children":[
                    {"role":"Button","AXLabel":"Sign in","AXValue":1,"frame":{"x":20,"y":620,"width":350,"height":50}},
                    {"role":"Button","AXLabel":"Elsewhere","frame":{"x":20,"y":700,"width":350,"height":10}}
                ]
            }]
        }]);
        let element = element_at(&tree, 120.0, 640.0).unwrap();
        assert_eq!(element.role, "Button");
        assert_eq!(element.label, "Sign in");
        assert_eq!(element.value, "1");
        assert_eq!(element.frame.height, 50.0);
        assert_eq!(element_at(&tree, 5.0, 5.0).unwrap().role, "Application");
        assert!(element_at(&tree, 500.0, 640.0).is_none());
        assert!(element_at(&serde_json::json!({"frame":{"x":0,"y":0,"width":-1,"height":20}}), 0.0, 0.0).is_none());
    }

    #[test]
    fn gestures_are_spelled_as_each_tool_takes_them() {
        let tap = Gesture::Tap { x: 120.4, y: 300.6 };
        assert_eq!(gesture_args(Toucher::Axe, &tap, "U"), ["tap", "-x", "120", "-y", "301", "--udid", "U"]);
        assert_eq!(gesture_args(Toucher::Idb, &tap, "U"), ["ui", "tap", "120", "301", "--udid", "U"]);
        let swipe = Gesture::Swipe { from: (200.0, 600.0), to: (200.0, 200.0) };
        assert_eq!(
            gesture_args(Toucher::Axe, &swipe, "U"),
            ["swipe", "--start-x", "200", "--start-y", "600", "--end-x", "200", "--end-y", "200", "--udid", "U"]
        );
        assert_eq!(gesture_args(Toucher::Idb, &swipe, "U"), ["ui", "swipe", "200", "600", "200", "200", "--udid", "U"]);
        // Words starting with a dash are typed, not read as options.
        assert_eq!(gesture_args(Toucher::Axe, &Gesture::Text("-hi".into()), "U"), ["type", "--udid", "U", "--", "-hi"]);
        assert_eq!(gesture_args(Toucher::Idb, &Gesture::Home, "U"), ["ui", "button", "HOME", "--udid", "U"]);
        assert_eq!(gesture_args(Toucher::Axe, &Gesture::Home, "U"), ["button", "home", "--udid", "U"]);
    }

    #[test]
    fn guesses_the_screen_scale_when_no_tool_says() {
        assert_eq!(guessed_scale("iPhone 17 Pro", 1206.0), 3.0);
        assert_eq!(guessed_scale("iPhone SE (3rd generation)", 750.0), 2.0);
        assert_eq!(guessed_scale("iPad Air 13-inch (M3)", 2048.0), 2.0);
    }

    #[test]
    fn names_runtimes_as_xcode_does() {
        assert_eq!(runtime_name("com.apple.CoreSimulator.SimRuntime.iOS-26-0"), "iOS 26.0");
        assert_eq!(runtime_name("com.apple.CoreSimulator.SimRuntime.iOS-18-6"), "iOS 18.6");
    }

    #[test]
    fn lists_ios_simulators_running_first_then_newest() {
        let json = r#"{"devices": {
            "com.apple.CoreSimulator.SimRuntime.iOS-18-6": [
                {"udid": "A", "name": "iPhone 16", "state": "Shutdown", "isAvailable": true}
            ],
            "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
                {"udid": "B", "name": "iPhone 17 Pro", "state": "Shutdown", "isAvailable": true},
                {"udid": "C", "name": "iPad Air", "state": "Booted", "isAvailable": true},
                {"udid": "D", "name": "iPhone 17", "state": "Shutdown", "isAvailable": false}
            ],
            "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [
                {"udid": "E", "name": "Apple Watch", "state": "Booted", "isAvailable": true}
            ]
        }}"#;
        let devices = parse_devices(json);
        assert_eq!(devices.iter().map(|d| d.udid.as_str()).collect::<Vec<_>>(), vec!["C", "B", "A"]);
        assert!(devices[0].booted);
        assert_eq!(devices[1].runtime, "iOS 26.0");
        assert!(parse_devices("not json").is_empty());
    }
}
