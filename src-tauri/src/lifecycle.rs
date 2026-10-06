//! How Starkline lives on the Mac. Closing the window doesn't stop the agents:
//! the app keeps working with a menu bar item, and the Dock icon brings the
//! window back. Quitting while agents work asks first. It can open at login in
//! the background, so scheduled work has somewhere to run.

use crate::agents::AgentStatus;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

/// Passed by the login item: open without showing the window.
pub const BACKGROUND_ARG: &str = "--background";
const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "starkline";

/// Set once the developer chose to quit, so closing and exiting go through.
static QUITTING: AtomicBool = AtomicBool::new(false);
/// The menu bar item's status line, updated as agents start and stop.
static STATUS_ITEM: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();

pub fn launched_in_background() -> bool {
    std::env::args().any(|a| a == BACKGROUND_ARG)
}

/// Create the main window from its configuration. Setup calls this once the app's state
/// exists: Tauri would otherwise build the window before setup runs, and a page that
/// loaded first would ask for data with nothing there to answer it.
pub fn create_main(app: &tauri::App) -> tauri::Result<()> {
    if let Some(config) = app.config().app.windows.iter().find(|w| w.label == MAIN_WINDOW) {
        tauri::WebviewWindowBuilder::from_config(app.handle(), config)?.build()?;
    }
    Ok(())
}

pub fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Agents doing something right now (working, thinking, or waiting on you).
pub fn busy_agents(app: &tauri::AppHandle) -> usize {
    app.try_state::<crate::AppState>()
        .map(|s| {
            s.statuses
                .lock()
                .unwrap()
                .values()
                .filter(|st| matches!(st, AgentStatus::Working | AgentStatus::Thinking | AgentStatus::Blocked))
                .count()
        })
        .unwrap_or(0)
}

fn status_line(busy: usize) -> String {
    match busy {
        0 => "No agents working".into(),
        1 => "1 agent working".into(),
        n => format!("{n} agents working"),
    }
}

/// Keep the menu bar item's status line current.
pub fn refresh_tray(app: &tauri::AppHandle) {
    if let Some(item) = STATUS_ITEM.get() {
        let _ = item.set_text(status_line(busy_agents(app)));
    }
}

/// Quit, unless agents are busy: then show the window and let the developer confirm.
pub fn request_quit(app: &tauri::AppHandle) {
    let busy = busy_agents(app);
    if busy == 0 {
        quit(app);
    } else {
        show_main(app);
        let _ = app.emit("app://quit-requested", busy);
    }
}

/// The developer confirmed: stop every agent and exit.
pub fn quit(app: &tauri::AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// The menu bar item: what's running, and a way back in or out.
pub fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", status_line(0), false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Starkline", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Starkline", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &PredefinedMenuItem::separator(app)?, &open, &quit_item])?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Starkline")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => request_quit(app),
            _ => {}
        });
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))
        .ok()
        .or_else(|| app.default_window_icon().cloned());
    if let Some(icon) = icon {
        tray = tray.icon(icon).icon_as_template(true);
    }
    tray.build(app)?;
    let _ = STATUS_ITEM.set(status);
    Ok(())
}

/// Closing the window hides it; agents keep working.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == MAIN_WINDOW && !QUITTING.load(Ordering::SeqCst) {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

/// Cmd+Q and the Dock's Quit ask first while agents work; the Dock icon reopens the window.
pub fn on_run_event(app: &tauri::AppHandle, event: &tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            let asked_by_developer = code.is_none();
            if asked_by_developer && !QUITTING.load(Ordering::SeqCst) && busy_agents(app) > 0 {
                api.prevent_exit();
                show_main(app);
                let _ = app.emit("app://quit-requested", busy_agents(app));
            } else {
                if let Some(servers) = app.try_state::<crate::devserver::DevServers>() {
                    servers.kill_all();
                }
                crate::simulator_extras::cleanup();
                crate::chat::kill_all(app);
                crate::pty::kill_all(app);
                app.state::<crate::AppState>().terminals.kill_all();
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { has_visible_windows: false, .. } => show_main(app),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_how_many_agents_are_working() {
        assert_eq!(status_line(0), "No agents working");
        assert_eq!(status_line(1), "1 agent working");
        assert_eq!(status_line(3), "3 agents working");
    }
}
