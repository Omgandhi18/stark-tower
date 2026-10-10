//! How Starkline lives on the Mac. Closing the window doesn't stop the agents:
//! the app keeps working with a menu bar item, and the Dock icon brings the
//! window back. Quitting while agents work asks first. It can open at login in
//! the background, so scheduled work has somewhere to run.

use crate::agents::AgentStatus;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};

/// Passed by the login item: open without showing the window.
pub const BACKGROUND_ARG: &str = "--background";
const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "starkline";

/// Set once the developer chose to quit, so closing and exiting go through.
static QUITTING: AtomicBool = AtomicBool::new(false);
/// The menu bar's shortcut label follows the setting.
static CAPTURE_ITEM: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();
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

/// The File menu's items that ask the page first: a tab strip with focus takes them, else the window does.
const MENU_CLOSE: &str = "app-close";
const MENU_NEW_TAB: &str = "app-new-tab";

/// What the menu items tell the page (it decides what ⌘W and ⌘T mean where focus is).
pub const CLOSE_REQUESTED: &str = "menu://close";
pub const NEW_TAB_REQUESTED: &str = "menu://new-tab";

/// The app's menu bar, written out rather than left to Tauri's default so ⌘W and ⌘T have one
/// owner. It is the default's standard items (About, Services, Hide, Quit, Edit's undo through
/// select all, full screen, minimize, zoom) with two changes: File has New Tab (⌘T) and Close
/// (⌘W), which ask the page before acting, and Window no longer carries a second Close Window.
pub fn app_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let info = app.package_info();
    let config = app.config();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let new_tab = MenuItem::with_id(app, MENU_NEW_TAB, "New Tab", true, Some("CmdOrCtrl+T"))?;
    let close = MenuItem::with_id(app, MENU_CLOSE, "Close", true, Some("CmdOrCtrl+W"))?;
    let separator = || PredefinedMenuItem::separator(app);
    let application = Submenu::with_items(
        app,
        info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &separator()?,
            &PredefinedMenuItem::services(app, None)?,
            &separator()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &separator()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(app, "File", true, &[&new_tab, &separator()?, &close])?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;
    let window = Submenu::with_id_and_items(app, tauri::menu::WINDOW_SUBMENU_ID, "Window", true, &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?])?;
    let help = Submenu::with_id_and_items(app, tauri::menu::HELP_SUBMENU_ID, "Help", true, &[])?;
    Menu::with_items(app, &[&application, &file, &edit, &view, &window, &help])
}

/// A menu item was chosen (or its shortcut pressed).
pub fn on_menu_event(app: &tauri::AppHandle, event: MenuEvent) {
    match event.id.as_ref() {
        MENU_CLOSE => {
            let _ = app.emit(CLOSE_REQUESTED, ());
        }
        MENU_NEW_TAB => {
            let _ = app.emit(NEW_TAB_REQUESTED, ());
        }
        _ => {}
    }
}

/// What Close Window did before ⌘W was asked of the page first: close the main window, which hides it.
pub fn close_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.close();
    }
}

/// The menu bar item: what's running, and a way back in or out.
pub fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", status_line(0), false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Starkline", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", capture_menu_text(app), true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Starkline", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &PredefinedMenuItem::separator(app)?, &open, &capture, &quit_item])?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Starkline")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "capture" => {
                let _ = crate::capture::toggle(app);
            }
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
    let _ = CAPTURE_ITEM.set(capture);
    Ok(())
}

fn capture_menu_text(app: &tauri::AppHandle) -> String {
    let state = app.state::<crate::AppState>();
    let config = state.config.lock().unwrap();
    let capture = &config.quick_capture;
    if capture.enabled && !capture.shortcut.is_empty() {
        format!("Quick capture…    {}", crate::capture::display(&capture.shortcut))
    } else {
        "Quick capture…".into()
    }
}

pub fn update_capture_menu(app: &tauri::AppHandle) {
    if let Some(item) = CAPTURE_ITEM.get() {
        let _ = item.set_text(capture_menu_text(app));
    }
}

/// Closing the window hides it; agents keep working.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    crate::capture::on_window_event(window, event);
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
                if let Some(state) = app.try_state::<crate::AppState>() {
                    state.voices.shutdown(app);
                }
                crate::chat::kill_all(app);
                crate::pty::kill_all(app);
                app.state::<crate::AppState>().terminals.kill_all();
            }
        }
        // Quitting normally: nothing that panicked along the way ended this run.
        tauri::RunEvent::Exit => crate::crash_log::clean_exit(),
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
