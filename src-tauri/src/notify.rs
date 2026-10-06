//! The Notification Centre's record: what needs the developer (approvals,
//! questions, reviews, finished or blocked work, missed automation runs) and
//! what may interest them (failed checks, rules that let something through). Nothing is deleted on
//! its own; needs-you items are settled when they're dealt with. When the
//! window isn't in front, something that needs the developer also shows a
//! macOS notification.

use crate::bridge::ReviewRequest;
use crate::ledger::{Automation, NewNotification, Reminder, Task};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

pub const NEEDS_YOU: &str = "needs_you";
pub const UPDATE: &str = "update";
const BODY_LIMIT: usize = 240;

fn changed(app: &tauri::AppHandle) {
    let _ = app.emit("notifications://changed", ());
}

fn window_in_front(app: &tauri::AppHandle) -> bool {
    app.webview_windows().values().any(|w| w.is_focused().unwrap_or(false))
}

/// A macOS notification for something that needs the developer while they're elsewhere.
fn banner(app: &tauri::AppHandle, title: &str, body: &str) {
    if window_in_front(app) {
        return;
    }
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[notify] couldn't show a notification: {e}");
    }
}

fn add(app: &tauri::AppHandle, n: NewNotification, headline: &str) {
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    if state.ledger.add_notification(&n).is_some() {
        if n.urgency == NEEDS_YOU {
            banner(app, headline, n.title);
        }
        changed(app);
    }
}

pub fn plain(markdown: &str) -> String {
    let text: String = markdown
        .lines()
        .map(|l| l.trim_start_matches(['#', '>', '-', '*', ' ']).trim())
        .filter(|l| !l.is_empty() && !l.starts_with("```") && !l.starts_with('|'))
        .collect::<Vec<_>>()
        .join(" ");
    crate::chat::truncate(&text, BODY_LIMIT)
}

/// An agent is now waiting on the developer.
pub fn review_opened(app: &tauri::AppHandle, review: &ReviewRequest) {
    let name = crate::prompts::agent_name(app, &review.agent_id);
    let (kind, verb) = match review.kind.as_str() {
        "command" | "permission" => ("approval", "needs your approval"),
        "questions" => ("question", "has a question"),
        _ => ("review", "needs your review"),
    };
    let task = crate::tasks::active_task_for(app, &review.agent_id);
    let body = if review.kind == "mockup" { String::new() } else { plain(&review.body) };
    add(
        app,
        NewNotification {
            kind,
            urgency: NEEDS_YOU,
            agent_id: &review.agent_id,
            task_id: task.as_deref(),
            cwd: review.cwd.as_deref().unwrap_or(""),
            title: &review.title,
            body: &body,
            review_id: Some(&review.id),
            automation_id: None,
            reminder_id: None,
        },
        &format!("{name} {verb}"),
    );
}

/// The developer dealt with a review (or it went away with its agent).
pub fn review_settled(app: &tauri::AppHandle, review_id: &str, outcome: &str) {
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    if state.ledger.handle_notifications(Some(review_id), None, &[], outcome) > 0 {
        changed(app);
    }
}

/// Whether the developer hears how a task ended: always for their own work, as
/// its settings say for an automation's, and never for a delegation (it reports
/// to the agent that delegated it).
fn reports_to_developer(app: &tauri::AppHandle, task: &Task, failed: bool) -> bool {
    task.requested_by == crate::tasks::BY_DEVELOPER || crate::automations::wants_notice(app, &task.requested_by, failed)
}

/// Work the developer asked for (or scheduled) is ready to look at.
pub fn task_ready(app: &tauri::AppHandle, task: &Task) {
    if !reports_to_developer(app, task, false) {
        return;
    }
    let name = crate::prompts::agent_name(app, &task.assignee);
    add(
        app,
        NewNotification {
            kind: "task_ready",
            urgency: NEEDS_YOU,
            agent_id: &task.assignee,
            task_id: Some(&task.id),
            cwd: &task.cwd,
            title: &task.title,
            body: &format!("{name} finished and it's ready for your review."),
            review_id: None,
            automation_id: None,
            reminder_id: None,
        },
        &format!("{name} is ready for your review"),
    );
}

/// Work the developer asked for (or scheduled) stopped before it finished.
pub fn task_blocked(app: &tauri::AppHandle, task: &Task, reason: &str) {
    if !reports_to_developer(app, task, true) {
        return;
    }
    let name = crate::prompts::agent_name(app, &task.assignee);
    add(
        app,
        NewNotification {
            kind: "task_blocked",
            urgency: NEEDS_YOU,
            agent_id: &task.assignee,
            task_id: Some(&task.id),
            cwd: &task.cwd,
            title: &task.title,
            body: reason,
            review_id: None,
            automation_id: None,
            reminder_id: None,
        },
        &format!("{name} is blocked"),
    );
}

/// A finished or blocked task was dealt with (closed, continued, tried again).
pub fn task_settled(app: &tauri::AppHandle, task_id: &str, outcome: &str) {
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    if state.ledger.handle_notifications(None, Some(task_id), &["task_ready", "task_blocked"], outcome) > 0 {
        changed(app);
    }
}

/// A check the owner ran failed (for the record; the task itself carries on).
pub fn check_failed(app: &tauri::AppHandle, agent_id: &str, task: &Task, kind: &str, command: &str) {
    add(
        app,
        NewNotification {
            kind: "check_failed",
            urgency: UPDATE,
            agent_id,
            task_id: Some(&task.id),
            cwd: &task.cwd,
            title: &format!("{kind} failed"),
            body: &format!("{} in \"{}\"", crate::chat::truncate(command, 120), task.title),
            review_id: None,
            automation_id: None,
            reminder_id: None,
        },
        "",
    );
}

/// A rule the developer granted let a call through without asking.
pub fn rule_used(app: &tauri::AppHandle, agent_id: &str, task_id: Option<&str>, cwd: &str, rule: &str, subject: &str) {
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    let Some(n) = state.ledger.add_notification(&NewNotification {
        kind: "rule_used",
        urgency: UPDATE,
        agent_id,
        task_id,
        cwd,
        title: &format!("Allowed by your rule: {rule}"),
        body: &crate::chat::truncate(subject, BODY_LIMIT),
        review_id: None,
        automation_id: None,
        reminder_id: None,
    }) else {
        return;
    };
    // Nothing to act on: it goes straight to the history.
    state.ledger.mark_notifications_read(&[n.id]);
    changed(app);
}

/// A scheduled run didn't happen on time. With "ask", the developer decides
/// whether it runs now; with "skip", it's on the record.
pub fn automation_missed(app: &tauri::AppHandle, a: &Automation, due: &str, ask: bool) {
    if !ask && a.notify == "never" {
        return;
    }
    let (urgency, body) = if ask {
        (NEEDS_YOU, format!("It was due {due}, while the Mac was asleep or Starkline was closed. Run it now, or skip it and wait for the next run."))
    } else {
        (UPDATE, format!("It was due {due}, while the Mac was asleep or Starkline was closed. It was skipped, as you set it to."))
    };
    add(
        app,
        NewNotification {
            kind: "automation_missed",
            urgency,
            agent_id: &a.agent_id,
            cwd: &a.cwd,
            title: &format!("{} missed a run", a.name),
            body: &body,
            automation_id: Some(a.id),
            ..Default::default()
        },
        &format!("{} missed a run", a.name),
    );
}

/// A scheduled run couldn't start at all.
pub fn automation_failed(app: &tauri::AppHandle, a: &Automation, reason: &str) {
    if a.notify == "never" {
        return;
    }
    add(
        app,
        NewNotification {
            kind: "automation_failed",
            urgency: NEEDS_YOU,
            agent_id: &a.agent_id,
            cwd: &a.cwd,
            title: &format!("{} couldn't start", a.name),
            body: &crate::chat::truncate(reason, BODY_LIMIT),
            automation_id: Some(a.id),
            ..Default::default()
        },
        &format!("{} couldn't start", a.name),
    );
}

/// The developer dealt with an automation (ran it, skipped the missed run, paused or deleted it).
pub fn automation_settled(app: &tauri::AppHandle, automation_id: i64, outcome: &str) {
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    if state.ledger.handle_automation_notifications(automation_id, outcome) > 0 {
        changed(app);
    }
}

/// How a task stands, for a reminder about it.
fn task_standing(status: &str) -> &'static str {
    match status {
        "todo" => "is waiting its turn",
        "doing" => "is under way",
        "blocked" => "is blocked",
        "done" => "is ready for your review",
        "reviewed" => "you've reviewed",
        _ => "was closed",
    }
}

/// A reminder came due: its agent reminds the developer. Unlike other
/// notifications, the banner shows even while Starkline is in front: it's about the time.
pub fn reminder_due(app: &tauri::AppHandle, r: &Reminder, late_since: Option<&str>) {
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    let name = crate::prompts::agent_name(app, &r.agent_id);
    let task = r.task_id.as_deref().and_then(|id| state.ledger.task(id));
    let mut body = task.as_ref().map(|t| format!("\u{201c}{}\u{201d} {}.", t.title, task_standing(&t.status))).unwrap_or_default();
    if let Some(due) = late_since {
        let late = format!("It was due {due}, while the Mac was asleep or Starkline was closed.");
        body = if body.is_empty() { late } else { format!("{body} {late}") };
    }
    let n = NewNotification {
        kind: "reminder",
        urgency: NEEDS_YOU,
        agent_id: &r.agent_id,
        task_id: r.task_id.as_deref(),
        cwd: task.as_ref().map_or("", |t| t.cwd.as_str()),
        title: &r.text,
        body: &body,
        reminder_id: Some(r.id),
        ..Default::default()
    };
    if state.ledger.add_notification(&n).is_some() {
        if let Err(e) = app.notification().builder().title(format!("{name} reminds you")).body(&r.text).show() {
            eprintln!("[notify] couldn't show a reminder: {e}");
        }
        changed(app);
    }
}

/// The developer dealt with a reminder (done, snoozed, moved or deleted it).
pub fn reminder_settled(app: &tauri::AppHandle, reminder_id: i64, outcome: &str) {
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    if state.ledger.handle_reminder_notifications(reminder_id, outcome) > 0 {
        changed(app);
    }
}
