//! A reusable window for handing over work without opening the main window.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub const DEFAULT_SHORTCUT: &str = "Super+Shift+Space";

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct CaptureConfig {
    pub enabled: bool,
    pub shortcut: String,
    pub last_agent: Option<String>,
    pub last_project: Option<String>,
    pub last_reminder_agent: Option<String>,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            shortcut: DEFAULT_SHORTCUT.into(),
            last_agent: None,
            last_project: None,
            last_reminder_agent: None,
        }
    }
}

#[derive(Default)]
pub struct Runtime {
    registered: Mutex<Option<Shortcut>>,
    pub error: Mutex<Option<String>>,
}

pub fn parse(value: &str) -> Result<Shortcut, String> {
    let shortcut: Shortcut = value
        .parse()
        .map_err(|_| "Press a modifier and a key, such as Shift-Command-Space.".to_string())?;
    if !shortcut
        .mods
        .intersects(Modifiers::SUPER | Modifiers::CONTROL | Modifiers::ALT)
    {
        return Err("Include Command, Control or Option in the shortcut.".into());
    }
    Ok(shortcut)
}

pub fn display(value: &str) -> String {
    let parts: Vec<_> = value.split('+').collect();
    let mut label = String::new();
    for (key, symbol) in [
        ("Control", "⌃"),
        ("Alt", "⌥"),
        ("Shift", "⇧"),
        ("Super", "⌘"),
    ] {
        if parts.contains(&key) {
            label.push_str(symbol);
        }
    }
    if let Some(key) = parts.last() {
        label.push_str(key.trim_start_matches("Key").trim_start_matches("Digit"));
    }
    label
}

/// Acquire the replacement first, so a conflict leaves the previous shortcut working.
pub fn configure(app: &tauri::AppHandle, enabled: bool, value: &str) -> Result<(), String> {
    let next = if enabled && !value.is_empty() {
        Some(parse(value)?)
    } else {
        None
    };
    let runtime = app.state::<Runtime>();
    let mut registered = runtime.registered.lock().unwrap();
    if *registered != next {
        if let Some(shortcut) = next {
            app.global_shortcut()
                .on_shortcut(shortcut, |app, _, event| {
                    if event.state == ShortcutState::Pressed {
                        if let Err(error) = toggle(app) {
                            *app.state::<Runtime>().error.lock().unwrap() = Some(error.clone());
                            let _ = app.emit("capture://error", error);
                        }
                    }
                })
                .map_err(|_| {
                    format!(
                        "{} is taken by another app. Pick another shortcut.",
                        display(value)
                    )
                })?;
        }
        if let Some(old) = *registered {
            if app.global_shortcut().unregister(old).is_err() {
                if let Some(shortcut) = next {
                    let _ = app.global_shortcut().unregister(shortcut);
                }
                return Err("The old shortcut couldn't be released. Try again.".into());
            }
        }
        *registered = next;
    }
    *runtime.error.lock().unwrap() = None;
    Ok(())
}

pub fn start(app: &tauri::AppHandle) {
    app.manage(Runtime::default());
    let config = app
        .state::<crate::AppState>()
        .config
        .lock()
        .unwrap()
        .quick_capture
        .clone();
    // Registration dispatches to the Mac's main thread; do not wait on it from setup.
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = configure(&app, config.enabled, &config.shortcut) {
            *app.state::<Runtime>().error.lock().unwrap() = Some(error.clone());
            let _ = app.emit("capture://error", error);
        }
    });
}

pub fn hide(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("capture") {
        window
            .hide()
            .map_err(|_| "Quick capture couldn't be hidden. Try again.".to_string())?;
    }
    Ok(())
}

pub fn toggle(app: &tauri::AppHandle) -> Result<(), String> {
    let window = match app.get_webview_window("capture") {
        Some(window) => window,
        None => tauri::WebviewWindowBuilder::new(
            app,
            "capture",
            tauri::WebviewUrl::App("index.html#capture".into()),
        )
        .title("Quick capture")
        .inner_size(640.0, 200.0)
        .min_inner_size(640.0, 200.0)
        .max_inner_size(640.0, 420.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .shadow(true)
        .build()
        .map_err(|_| "Quick capture couldn't open. Try again from the menu bar.".to_string())?,
    };
    #[cfg(target_os = "macos")]
    style_window(&window)?;
    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        return hide(app);
    }
    if let Ok(cursor) = app.cursor_position() {
        if let Ok(Some(monitor)) = app.monitor_from_point(cursor.x, cursor.y) {
            let size = window
                .outer_size()
                .map_err(|_| "Quick capture couldn't be positioned. Try again.".to_string())?;
            let scale = window.scale_factor().unwrap_or(monitor.scale_factor());
            let logical = size.to_logical::<f64>(scale);
            let position = centered_position(monitor.work_area(), logical, monitor.scale_factor());
            let _ = window.set_position(position);
        }
    }
    window
        .show()
        .and_then(|_| window.set_focus())
        .map_err(|_| "Quick capture couldn't be focused. Try again.".to_string())?;
    let _ = window.emit("capture://shown", ());
    Ok(())
}

/// Use the destination screen's density when moving between Retina and other displays.
fn centered_position(
    area: &tauri::PhysicalRect<i32, u32>,
    logical: tauri::LogicalSize<f64>,
    scale: f64,
) -> tauri::PhysicalPosition<i32> {
    let size = logical.to_physical::<u32>(scale);
    tauri::PhysicalPosition::new(
        area.position.x + (area.size.width as i32 - size.width as i32) / 2,
        area.position.y + (area.size.height as i32 - size.height as i32) / 2,
    )
}

/// Borderless Mac windows need their own rounded surface and Window-menu exclusion.
#[cfg(target_os = "macos")]
fn style_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let owner = window.clone();
    window
        .run_on_main_thread(move || {
            if let Ok(native) = owner.ns_window() {
                // SAFETY: Tauri owns this NSWindow, and this runs on the main thread.
                unsafe { crate::capture_mac::style(native) };
            }
        })
        .map_err(|_| "Quick capture couldn't be styled. Try again.".to_string())
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "capture" {
        return;
    }
    match event {
        tauri::WindowEvent::Focused(false) => {
            let _ = window.hide();
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = window.hide();
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_shortcuts() {
        assert!(parse(DEFAULT_SHORTCUT).is_ok());
        assert_eq!(display(DEFAULT_SHORTCUT), "⇧⌘Space");
        assert_eq!(
            parse("Command+Shift+Space").unwrap(),
            parse(DEFAULT_SHORTCUT).unwrap()
        );
        assert!(parse("Control+Alt+KeyK").is_ok());
        for invalid in [
            "",
            "Space",
            "Shift+Space",
            "Super",
            "Super+Nonsense",
            "Super+A+B",
        ] {
            assert!(parse(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn centers_on_the_destination_display_with_its_density_and_menu_bar() {
        let size = tauri::LogicalSize::new(640.0, 200.0);
        let retina = tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(0, 0),
            size: tauri::PhysicalSize::new(2560, 1440),
        };
        assert_eq!(
            centered_position(&retina, size, 2.0),
            tauri::PhysicalPosition::new(640, 520)
        );
        let other = tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(-1920, 24),
            size: tauri::PhysicalSize::new(1920, 1056),
        };
        assert_eq!(
            centered_position(&other, size, 1.0),
            tauri::PhysicalPosition::new(-1280, 452)
        );
    }

    #[test]
    fn old_configs_get_enabled_capture_and_choices_round_trip() {
        let mut value = serde_json::to_value(crate::config::default_config()).unwrap();
        value.as_object_mut().unwrap().remove("quick_capture");
        let old: crate::config::AppConfig = serde_json::from_value(value).unwrap();
        assert!(old.quick_capture.enabled);
        assert_eq!(old.quick_capture.shortcut, DEFAULT_SHORTCUT);
        let config = CaptureConfig {
            last_agent: Some("friday".into()),
            last_project: Some("/project".into()),
            last_reminder_agent: Some("edith".into()),
            ..Default::default()
        };
        let copy: CaptureConfig =
            serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
        assert_eq!(copy.last_agent, config.last_agent);
        assert_eq!(copy.last_project, config.last_project);
        assert_eq!(copy.last_reminder_agent, config.last_reminder_agent);
    }
}
