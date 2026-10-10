//! System notifications share the ledger's identifiers and the developer's settings.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

fn default_on() -> bool {
    true
}

#[derive(Serialize, Deserialize, specta::Type, Clone, Debug, PartialEq)]
pub struct MacNotifications {
    #[serde(default = "default_on")]
    pub enabled: bool,
    #[serde(default = "default_on")]
    pub in_front: bool,
    #[serde(default = "default_on")]
    pub reminders: bool,
    #[serde(default = "default_on")]
    pub requests: bool,
    #[serde(default = "default_on")]
    pub work: bool,
    #[serde(default = "default_on")]
    pub code_review: bool,
    #[serde(default = "default_on")]
    pub automations: bool,
    #[serde(default = "default_on")]
    pub budget: bool,
    #[serde(default)]
    pub checks: bool,
    #[serde(default)]
    pub claims: bool,
}

impl Default for MacNotifications {
    fn default() -> Self {
        Self {
            enabled: true,
            in_front: true,
            reminders: true,
            requests: true,
            work: true,
            code_review: true,
            automations: true,
            budget: true,
            checks: false,
            claims: false,
        }
    }
}

impl MacNotifications {
    /// Whether a new notification of this kind goes to the Mac now.
    pub fn shows(&self, kind: &str, starkline_in_front: bool) -> bool {
        self.enabled
            && (self.in_front || !starkline_in_front)
            && match kind {
                "reminder" => self.reminders,
                "approval" | "question" | "review" => self.requests,
                "task_ready" | "task_blocked" | "todo_removed" => self.work,
                "code_review" => self.code_review,
                "automation_missed" | "automation_failed" => self.automations,
                "budget" => self.budget,
                "check_failed" => self.checks,
                "claim_refused" => self.claims,
                _ => false,
            }
    }
}

pub struct Shown {
    pub id: i64,
    pub title: String,
    pub subtitle: String,
    pub body: String,
    pub thread: String,
}

/// What the Mac shows: the headline ("FRIDAY needs your approval") over the notification's title and
/// body. A reminder's text is its message, with how its task stands (or that it's late) beneath.
pub fn shown(n: &crate::ledger::Notification, headline: &str) -> Shown {
    let body = crate::chat::truncate(&n.body, crate::notify::BODY_LIMIT);
    let (title, subtitle, body) = if n.kind == "reminder" {
        let text = if body.is_empty() { n.title.clone() } else { format!("{}\n{body}", n.title) };
        (headline.to_string(), String::new(), text)
    } else if headline.is_empty() {
        (n.title.clone(), String::new(), body)
    } else {
        (headline.to_string(), n.title.clone(), body)
    };
    Shown {
        id: n.id,
        title,
        subtitle,
        body,
        thread: n.agent_id.clone(),
    }
}

#[derive(Serialize, specta::Type)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[serde(rename_all = "snake_case")]
pub enum PermissionState {
    Allowed,
    Denied,
    NotAsked,
    Provisional,
    System,
}

#[derive(Serialize, specta::Type)]
pub struct NotificationPermission {
    pub state: PermissionState,
    pub settings_url: Option<String>,
}

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn start(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
    #[cfg(target_os = "macos")]
    if crate::notifications_mac::bundled() {
        crate::notifications_mac::install(on_click);
        let enabled = app.state::<crate::AppState>().config.lock().unwrap().mac_notifications.enabled;
        if enabled {
            crate::notifications_mac::permission(|p| {
                if matches!(p, crate::notifications_mac::Permission::NotAsked) {
                    crate::notifications_mac::request(|_| {});
                }
            });
        }
    }
}

#[cfg(target_os = "macos")]
fn on_click(identifier: &str) {
    use tauri::Emitter;
    let Some(id) = identifier.strip_prefix("starkline.notification.").and_then(|s| s.parse::<i64>().ok()) else {
        return;
    };
    if let Some(app) = APP.get() {
        let h = app.clone();
        let _ = app.run_on_main_thread(move || {
            crate::lifecycle::show_main(&h);
            let _ = h.emit("notifications://open", id);
        });
    }
}

pub fn post(app: &tauri::AppHandle, n: &Shown) {
    post_identifier(app, &format!("starkline.notification.{}", n.id), n);
}

fn post_identifier(app: &tauri::AppHandle, identifier: &str, n: &Shown) {
    #[cfg(target_os = "macos")]
    if crate::notifications_mac::bundled() {
        crate::notifications_mac::post(identifier, &n.title, &n.subtitle, &n.body, &n.thread);
        return;
    }
    // The desktop plugin cannot route clicks or remove delivered notifications.
    let _ = (identifier, &n.thread);
    let body = if n.subtitle.is_empty() || n.subtitle == n.body {
        n.body.clone()
    } else {
        format!("{}\n{}", n.subtitle, n.body)
    };
    let builder = app.notification().builder().title(&n.title).body(body);
    if let Err(e) = builder.show() {
        eprintln!("[notify] couldn't show a notification: {e}");
    }
}

pub fn forget(ids: &[i64]) {
    #[cfg(target_os = "macos")]
    if !ids.is_empty() && crate::notifications_mac::bundled() {
        crate::notifications_mac::forget(&ids.iter().map(|id| format!("starkline.notification.{id}")).collect::<Vec<_>>());
    }
    #[cfg(not(target_os = "macos"))]
    let _ = ids;
}

pub fn permission(_app: &tauri::AppHandle) -> NotificationPermission {
    read_permission(false)
}
pub fn request(_app: &tauri::AppHandle) -> NotificationPermission {
    read_permission(true)
}

fn read_permission(request: bool) -> NotificationPermission {
    #[cfg(target_os = "macos")]
    if crate::notifications_mac::bundled() {
        use crate::notifications_mac::{self, Permission};
        let (send, receive) = std::sync::mpsc::channel();
        if request {
            notifications_mac::request(move |p| {
                let _ = send.send(p);
            });
        } else {
            notifications_mac::permission(move |p| {
                let _ = send.send(p);
            });
        }
        let state = match receive.recv_timeout(std::time::Duration::from_secs(if request { 120 } else { 5 })) {
            Ok(Permission::Allowed) => PermissionState::Allowed,
            Ok(Permission::Denied) => PermissionState::Denied,
            Ok(Permission::NotAsked) => PermissionState::NotAsked,
            Ok(Permission::Provisional) => PermissionState::Provisional,
            // The system didn't answer; avoid claiming permission was granted.
            Err(_) => PermissionState::System,
        };
        return NotificationPermission {
            state,
            settings_url: notifications_mac::bundle_identifier()
                .map(|id| format!("x-apple.systempreferences:com.apple.Notifications-Settings.extension?id={id}")),
        };
    }
    let _ = request;
    NotificationPermission {
        state: PermissionState::System,
        settings_url: None,
    }
}

pub fn test(app: &tauri::AppHandle) -> Result<(), String> {
    // macOS drops a notification posted before it's been allowed, so ask first when it hasn't been.
    let mut state = permission(app).state;
    if matches!(state, PermissionState::NotAsked) {
        state = request(app).state;
    }
    if matches!(state, PermissionState::Denied | PermissionState::NotAsked) {
        return Err("Notifications are turned off for Starkline. Turn them on in System Settings → Notifications → Starkline, then try again.".into());
    }
    post_identifier(
        app,
        "starkline.test",
        &Shown {
            id: 0,
            title: "Notifications are working".into(),
            subtitle: String::new(),
            body: "This is how Starkline will reach you.".into(),
            thread: String::new(),
        },
    );
    Ok(())
}

/// Focus checks can wait for the main thread, so copy the settings and release the lock first.
pub fn deliver(app: &tauri::AppHandle, n: &crate::ledger::Notification, headline: &str) {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return;
    };
    let settings = state.config.lock().unwrap().mac_notifications.clone();
    if !settings.shows(&n.kind, false) {
        return;
    }
    let front = !settings.in_front && app.webview_windows().values().any(|w| w.is_focused().unwrap_or(false));
    if settings.shows(&n.kind, front) {
        post(app, &shown(n, headline));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_obeys_only_its_category_master_and_focus_settings() {
        type Category = (&'static [&'static str], fn(&mut MacNotifications, bool));
        let groups: &[Category] = &[
            (&["reminder"], |s, v| s.reminders = v),
            (&["approval", "question", "review"], |s, v| s.requests = v),
            (&["task_ready", "task_blocked", "todo_removed"], |s, v| s.work = v),
            (&["code_review"], |s, v| s.code_review = v),
            (&["automation_missed", "automation_failed"], |s, v| s.automations = v),
            (&["budget"], |s, v| s.budget = v),
            (&["check_failed"], |s, v| s.checks = v),
            (&["claim_refused"], |s, v| s.claims = v),
        ];
        // All combinations also ensure another category never changes this kind's policy.
        for mask in 0..1024 {
            let mut settings = MacNotifications {
                enabled: mask & 1 != 0,
                in_front: mask & 2 != 0,
                ..Default::default()
            };
            for (i, (_, set)) in groups.iter().enumerate() {
                set(&mut settings, mask & (4 << i) != 0);
            }
            for (i, (kinds, _)) in groups.iter().enumerate() {
                for kind in *kinds {
                    for front in [false, true] {
                        assert_eq!(
                            settings.shows(kind, front),
                            mask & 1 != 0 && (mask & 2 != 0 || !front) && mask & (4 << i) != 0,
                            "{mask} {kind} {front}"
                        );
                    }
                }
            }
            for kind in ["rule_used", "auto_mode", "unknown", ""] {
                for front in [false, true] {
                    assert!(!settings.shows(kind, front));
                }
            }
        }
        let defaults = MacNotifications::default();
        for kind in [
            "reminder",
            "approval",
            "question",
            "review",
            "task_ready",
            "task_blocked",
            "todo_removed",
            "code_review",
            "automation_missed",
            "automation_failed",
            "budget",
        ] {
            for front in [false, true] {
                assert!(defaults.shows(kind, front));
            }
        }
        for kind in ["check_failed", "claim_refused"] {
            assert!(!defaults.shows(kind, false));
        }
    }

    #[test]
    fn headline_and_reminder_text_select_the_system_content() {
        let ledger = crate::ledger::Ledger::open(std::path::Path::new(":memory:")).unwrap();
        let mut n = ledger
            .add_notification(&crate::ledger::NewNotification {
                kind: "approval",
                agent_id: "friday",
                title: "Run migrations",
                body: "Review the command.",
                ..Default::default()
            })
            .unwrap();
        let content = shown(&n, "FRIDAY needs your approval");
        assert_eq!(
            (
                content.id,
                content.title.as_str(),
                content.subtitle.as_str(),
                content.body.as_str(),
                content.thread.as_str()
            ),
            (n.id, "FRIDAY needs your approval", "Run migrations", "Review the command.", "friday")
        );
        let content = shown(&n, "");
        assert_eq!(
            (content.title.as_str(), content.subtitle.as_str(), content.body.as_str()),
            ("Run migrations", "", "Review the command.")
        );
        n.body = "界".repeat(crate::notify::BODY_LIMIT + 1);
        assert_eq!(shown(&n, "").body, format!("{}…", "界".repeat(240)));
        n.kind = "reminder".into();
        n.body = String::new();
        let reminder = shown(&n, "FRIDAY reminds you");
        assert_eq!(
            (reminder.title.as_str(), reminder.subtitle.as_str(), reminder.body.as_str()),
            ("FRIDAY reminds you", "", "Run migrations")
        );
        n.body = "“Fix login” is under way.".into();
        assert_eq!(shown(&n, "FRIDAY reminds you").body, "Run migrations\n“Fix login” is under way.");
    }
}
