//! The iOS Simulator beside a conversation, through Xcode's `simctl`: the
//! simulators there are, booting one, its screen (screenshots taken a few times a
//! second while the panel shows it), and opening links and apps on it. Taps,
//! typing and the Home button go through idb (Meta's iOS Development Bridge)
//! when it's installed; without it, the Simulator app takes them. Agents get the
//! same through the `simulator` tool, to see what their app looks like.

use serde::Serialize;
use serde_json::Value;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};

const XCRUN: &str = "/usr/bin/xcrun";
const NO_XCODE: &str = "The iOS Simulator needs Xcode. Install it from the App Store and open it once to finish setting up.";
const NO_IDB: &str = "Taps and typing from Starkline need idb: run `brew install facebook/fb/idb-companion` and `pip3 install fb-idb` in Terminal. Until then, use the Simulator app.";

static SHOT: AtomicU64 = AtomicU64::new(0);

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
    /// idb is installed, so taps and typing go through from Starkline.
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

pub fn status() -> SimulatorStatus {
    let unavailable = |problem: &str| SimulatorStatus { available: false, problem: Some(problem.to_string()), devices: vec![], touch: false };
    if !cfg!(target_os = "macos") {
        return unavailable("The iOS Simulator needs a Mac with Xcode.");
    }
    match simctl(&["list", "devices", "available", "--json"]) {
        Ok(out) if out.status.success() => {
            let devices = parse_devices(&String::from_utf8_lossy(&out.stdout));
            let problem = devices.is_empty().then(|| "Xcode has no iOS simulators yet. Add one in Xcode under Window > Devices and Simulators.".to_string());
            SimulatorStatus { available: true, problem, devices, touch: idb().is_some() }
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
    checked(&["launch", udid, bundle_id]).map(|_| ())
}

fn idb_run(udid: &str, args: &[&str]) -> Result<(), String> {
    let program = idb().ok_or(NO_IDB)?;
    let out = Command::new(program).args(args).args(["--udid", udid]).output().map_err(|e| format!("idb couldn't run: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(first_line(&String::from_utf8_lossy(&out.stderr)))
    }
}

/// Pixels per point on the device's screen: idb says, else iPads are 2x and iPhones 3x.
fn scale(udid: &str, name: &str) -> f64 {
    if let Some(known) = scales().lock().unwrap().get(udid) {
        return *known;
    }
    let described = idb().and_then(|program| Command::new(program).args(["describe", "--json", "--udid", udid]).output().ok());
    let density = described
        .and_then(|out| serde_json::from_slice::<Value>(&out.stdout).ok())
        .and_then(|v| v.pointer("/screen_dimensions/density").and_then(|d| d.as_f64()))
        .filter(|d| *d > 0.0);
    match density {
        Some(d) => {
            scales().lock().unwrap().insert(udid.to_string(), d);
            d
        }
        None if name.contains("iPad") => 2.0,
        None => 3.0,
    }
}

/// A tap at a point on the screen, in points.
pub fn tap(udid: &str, x: f64, y: f64) -> Result<(), String> {
    idb_run(udid, &["ui", "tap", &format!("{}", x.round()), &format!("{}", y.round())])
}

/// A tap at a pixel of a screenshot (where the developer clicked it).
pub fn tap_pixel(udid: &str, name: &str, x: f64, y: f64) -> Result<(), String> {
    let s = scale(udid, name);
    tap(udid, x / s, y / s)
}

pub fn type_text(udid: &str, text: &str) -> Result<(), String> {
    idb_run(udid, &["ui", "text", text])
}

pub fn home(udid: &str) -> Result<(), String> {
    idb_run(udid, &["ui", "button", "HOME"])
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
    found.ok_or_else(|| {
        if wanted.is_empty() {
            "No simulator is running. Boot one first (action \"boot\").".to_string()
        } else {
            format!("There's no simulator called \"{wanted}\". Ask for \"devices\" to see them.")
        }
    })
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
            let touch = if s.touch { "Taps and typing work (idb is installed)." } else { "Taps and typing need idb, which isn't installed." };
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
        "tap" => {
            let d = device(&text("device"), true)?;
            let at = |key: &str| args.get(key).and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())));
            let (Some(x), Some(y)) = (at("x"), at("y")) else { return Err("Give `x` and `y`, in points from the screen's top left.".into()) };
            tap(&d.udid, x, y)?;
            Ok(Outcome::Text(format!("Tapped ({x}, {y}) on {}. Take a screenshot to see what happened.", d.name)))
        }
        "type" => {
            let d = device(&text("device"), true)?;
            type_text(&d.udid, &text("text"))?;
            Ok(Outcome::Text(format!("Typed on {}.", d.name)))
        }
        "home" => {
            let d = device(&text("device"), true)?;
            home(&d.udid)?;
            Ok(Outcome::Text(format!("Went to {}'s home screen.", d.name)))
        }
        other => Err(format!("The simulator has no \"{other}\" action. Use devices, boot, screenshot, open_url, install, launch, tap, type or home.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
