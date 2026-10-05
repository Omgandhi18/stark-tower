//! Scheduled work. Each automation starts a task for its owner on its schedule,
//! follows that task to a result, and applies its own settings: what happens
//! to a run that was missed (the Mac was asleep or Starkline was closed), when
//! the developer hears about results, and how long a run may take.

use crate::ledger::{Automation, AutomationRun};
use crate::schedule::Schedule;
use chrono::TimeZone;
use serde::Deserialize;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// How often the scheduler looks for due work.
const TICK: Duration = Duration::from_secs(30);
/// A run this late counts as missed: the Mac slept through it, or Starkline was closed.
const LATE_AFTER_MS: i64 = 10 * 60 * 1000;
const MINUTE_MS: i64 = 60 * 1000;
pub const MIN_MINUTES: i64 = 5;
pub const MAX_MINUTES: i64 = 24 * 60;
const MISSED_POLICIES: [&str; 3] = ["run_once", "skip", "ask"];
const NOTIFY_POLICIES: [&str; 3] = ["failure", "always", "never"];
const REQUESTER_PREFIX: &str = "automation:";
const SUMMARY_LIMIT: usize = 240;
const RUN_HISTORY: i64 = 50;

/// What the developer edits.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct AutomationInput {
    /// None to create a new automation.
    pub id: Option<i64>,
    pub name: String,
    pub agent_id: String,
    pub cwd: String,
    pub instruction: String,
    pub schedule: Schedule,
    pub enabled: bool,
    /// run_once | skip | ask
    pub missed: String,
    /// failure | always | never
    pub notify: String,
    pub max_minutes: i64,
    pub wake: bool,
}

impl From<Automation> for AutomationInput {
    fn from(a: Automation) -> Self {
        AutomationInput {
            id: Some(a.id),
            name: a.name,
            agent_id: a.agent_id,
            cwd: a.cwd,
            instruction: a.instruction,
            schedule: a.schedule,
            enabled: a.enabled,
            missed: a.missed,
            notify: a.notify,
            max_minutes: a.max_minutes,
            wake: a.wake,
        }
    }
}

/// Who a task says asked for it, when an automation did.
pub fn requester(id: i64) -> String {
    format!("{REQUESTER_PREFIX}{id}")
}

/// The automation behind a task's `requested_by`, if it was one.
pub fn automation_of(requested_by: &str) -> Option<i64> {
    requested_by.strip_prefix(REQUESTER_PREFIX)?.parse().ok()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The next run after `after_ms`, in this Mac's local time.
fn next_run(schedule: &Schedule, after_ms: i64) -> Option<i64> {
    let after = chrono::Local.timestamp_millis_opt(after_ms).single()?;
    crate::schedule::next_after(schedule, &after).map(|t| t.timestamp_millis())
}

/// "Mon 5 Oct at 2:00 AM", in local time.
fn when(ms: i64) -> String {
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|t| t.format("%a %-d %b at %-I:%M %p").to_string())
        .unwrap_or_else(|| "earlier".into())
}

fn changed(app: &tauri::AppHandle) {
    let _ = app.emit("automations://changed", ());
}

fn ledger(app: &tauri::AppHandle) -> Result<tauri::State<'_, crate::AppState>, String> {
    app.try_state::<crate::AppState>().ok_or_else(|| "Starkline isn't ready yet.".into())
}

/// What's wrong with an automation as entered, if anything.
pub fn problem(input: &AutomationInput, agent_known: bool) -> Option<String> {
    if input.name.trim().is_empty() {
        return Some("Give the automation a name.".into());
    }
    if !agent_known {
        return Some("Choose an agent from the roster to own it.".into());
    }
    if input.instruction.trim().is_empty() {
        return Some("Say what the agent should do each run.".into());
    }
    if input.cwd.trim().is_empty() || !std::path::Path::new(input.cwd.trim()).is_dir() {
        return Some("Choose a project folder that exists on this Mac.".into());
    }
    if let Some(reason) = crate::schedule::problem(&input.schedule) {
        return Some(reason.into());
    }
    if !(MIN_MINUTES..=MAX_MINUTES).contains(&input.max_minutes) {
        return Some(format!("Allow a run between {MIN_MINUTES} minutes and {} hours.", MAX_MINUTES / 60));
    }
    if !MISSED_POLICIES.contains(&input.missed.as_str()) || !NOTIFY_POLICIES.contains(&input.notify.as_str()) {
        return Some("Pick what happens after a missed run, and when to hear about results.".into());
    }
    None
}

// ---- Reading ---------------------------------------------------------------

pub fn list(app: &tauri::AppHandle) -> Vec<Automation> {
    ledger(app).map(|s| s.ledger.automations()).unwrap_or_default()
}

pub fn runs(app: &tauri::AppHandle, id: i64) -> Vec<AutomationRun> {
    ledger(app).map(|s| s.ledger.automation_runs(id, RUN_HISTORY)).unwrap_or_default()
}

/// The automation's name, when `requested_by` names one.
pub fn name_of(app: &tauri::AppHandle, requested_by: &str) -> Option<String> {
    let id = automation_of(requested_by)?;
    ledger(app).ok()?.ledger.automation(id).map(|a| a.name)
}

/// Whether the developer hears how an automation's task ended.
pub fn wants_notice(app: &tauri::AppHandle, requested_by: &str, failed: bool) -> bool {
    let Some(a) = automation_of(requested_by).and_then(|id| ledger(app).ok()?.ledger.automation(id)) else {
        return false;
    };
    match a.notify.as_str() {
        "always" => true,
        "failure" => failed,
        _ => false,
    }
}

// ---- Editing ---------------------------------------------------------------

pub fn save(app: &tauri::AppHandle, input: AutomationInput) -> Result<Automation, String> {
    let state = ledger(app)?;
    let agent_known = state.config.lock().unwrap().agents.iter().any(|a| a.id == input.agent_id && a.enabled);
    if let Some(reason) = problem(&input, agent_known) {
        return Err(reason);
    }
    let existing = input.id.and_then(|id| state.ledger.automation(id));
    if input.id.is_some() && existing.is_none() {
        return Err("That automation doesn't exist any more.".into());
    }
    // A new schedule, or switching it back on, counts from now; otherwise the next run stands.
    let keeps_its_slot = existing.as_ref().is_some_and(|a| a.enabled && a.schedule == input.schedule && a.next_run.is_some());
    let next = match (input.enabled, keeps_its_slot) {
        (false, _) => None,
        (true, true) => existing.as_ref().and_then(|a| a.next_run),
        (true, false) => next_run(&input.schedule, now_ms()),
    };
    let draft = Automation {
        id: existing.as_ref().map(|a| a.id).unwrap_or(0),
        name: input.name.trim().to_string(),
        agent_id: input.agent_id,
        cwd: input.cwd.trim().to_string(),
        instruction: input.instruction.trim().to_string(),
        schedule: input.schedule,
        enabled: input.enabled,
        missed: input.missed,
        notify: input.notify,
        max_minutes: input.max_minutes,
        wake: input.wake,
        created: existing.as_ref().map(|a| a.created).unwrap_or(0),
        updated: 0,
        next_run: next,
        last_run: existing.as_ref().and_then(|a| a.last_run),
        last_status: existing.as_ref().and_then(|a| a.last_status.clone()),
    };
    let saved = state.ledger.save_automation(&draft).ok_or("The automation couldn't be saved.")?;
    if !saved.enabled {
        crate::notify::automation_settled(app, saved.id, "Paused");
    }
    changed(app);
    Ok(saved)
}

pub fn set_enabled(app: &tauri::AppHandle, id: i64, enabled: bool) -> Result<Automation, String> {
    let a = ledger(app)?.ledger.automation(id).ok_or("That automation doesn't exist.")?;
    save(app, AutomationInput { enabled, ..a.into() })
}

pub fn delete(app: &tauri::AppHandle, id: i64) -> Result<(), String> {
    let state = ledger(app)?;
    if running(&state, id) {
        return Err("It's running right now. Close its task first, then delete it.".into());
    }
    crate::notify::automation_settled(app, id, "Deleted");
    state.ledger.delete_automation(id);
    changed(app);
    Ok(())
}

// ---- Running ---------------------------------------------------------------

fn running(state: &crate::AppState, id: i64) -> bool {
    state.ledger.automation_runs(id, 1).first().is_some_and(|r| r.finished.is_none())
}

/// Start a run: a task for the owner, in the automation's folder. The schedule
/// moves on to the next slot whatever happens to this run. `trigger` says what
/// started it: its schedule, a missed slot made up late, or the developer.
fn run(app: &tauri::AppHandle, a: &Automation, scheduled_for: i64, trigger: &str) -> Result<AutomationRun, String> {
    let state = ledger(app)?;
    let next = if a.enabled { next_run(&a.schedule, now_ms()) } else { None };
    state.ledger.set_automation_schedule_state(a.id, next, Some(now_ms()), Some("running"));
    let prompt = format!("{}\n\n(This is a scheduled run of the automation \"{}\".)", a.instruction, a.name);
    let requested_by = requester(a.id);
    let first_note = format!("Scheduled by {}", a.name);
    let origin = crate::tasks::Origin { requested_by: &requested_by, title: Some(&a.name), note: &first_note };
    let result = match crate::tasks::start_for(app, &a.agent_id, &prompt, Some(a.cwd.clone()), &origin) {
        Ok(task) => state
            .ledger
            .add_automation_run(a.id, scheduled_for, trigger, "running", Some(&task.id), "")
            .ok_or_else(|| "The run couldn't be recorded.".to_string()),
        Err(e) => {
            state.ledger.add_automation_run(a.id, scheduled_for, trigger, "failed", None, &format!("Couldn't start: {e}"));
            state.ledger.set_automation_status(a.id, "failed");
            crate::notify::automation_failed(app, a, &e);
            Err(e)
        }
    };
    changed(app);
    result
}

/// The developer asked for a run right away (from the screen, or a missed-run notice).
pub fn run_now(app: &tauri::AppHandle, id: i64) -> Result<AutomationRun, String> {
    let state = ledger(app)?;
    let a = state.ledger.automation(id).ok_or("That automation doesn't exist.")?;
    if running(&state, id) {
        return Err("It's running right now. Wait for this run to finish.".into());
    }
    crate::notify::automation_settled(app, id, "Ran it now");
    run(app, &a, now_ms(), "you")
}

/// The developer chose not to make up a missed run.
pub fn skip_missed(app: &tauri::AppHandle, id: i64) {
    crate::notify::automation_settled(app, id, "Skipped");
}

/// What to do with a slot that has come due. Pure, so the policy can be tested.
#[derive(Debug, PartialEq, Eq)]
enum Due {
    /// On time: run it.
    Run,
    /// Late, and set to run once anyway.
    RunLate,
    /// Late, and set to skip it (or to ask first).
    Missed { ask: bool },
    /// The previous run is still going: don't pile another on top.
    Busy,
}

fn decide(late_by_ms: i64, policy: &str, still_running: bool) -> Due {
    if still_running {
        Due::Busy
    } else if late_by_ms <= LATE_AFTER_MS {
        Due::Run
    } else {
        match policy {
            "run_once" => Due::RunLate,
            "ask" => Due::Missed { ask: true },
            _ => Due::Missed { ask: false },
        }
    }
}

/// Start what's due, deal with what was missed, and stop runs that took too long.
pub fn tick(app: &tauri::AppHandle) {
    let Ok(state) = ledger(app) else { return };
    let now = now_ms();
    for a in state.ledger.automations().into_iter().filter(|a| a.enabled) {
        let Some(due) = a.next_run.filter(|due| *due <= now) else { continue };
        let due_at = when(due);
        match decide(now - due, &a.missed, running(&state, a.id)) {
            Due::Run => {
                let _ = run(app, &a, due, "schedule");
            }
            Due::RunLate => {
                let _ = run(app, &a, due, "late");
            }
            Due::Missed { ask } => {
                let (status, summary) = if ask {
                    ("missed", "The Mac was asleep or Starkline was closed, so you were asked what to do.")
                } else {
                    ("skipped", "The Mac was asleep or Starkline was closed, so it was skipped.")
                };
                state.ledger.add_automation_run(a.id, due, "schedule", status, None, summary);
                state.ledger.set_automation_schedule_state(a.id, next_run(&a.schedule, now), None, Some("missed"));
                crate::notify::automation_missed(app, &a, &due_at, ask);
                changed(app);
            }
            Due::Busy => {
                state.ledger.add_automation_run(a.id, due, "schedule", "skipped", None, "The previous run was still going.");
                state.ledger.set_automation_schedule_state(a.id, next_run(&a.schedule, now), None, None);
                changed(app);
            }
        }
    }
    // Runs in flight: stop one that outlasts its limit, and settle any whose task already ended.
    for r in state.ledger.unfinished_runs() {
        let Some(task) = r.task_id.as_deref().and_then(|id| state.ledger.task(id)) else {
            state.ledger.finish_run(r.id, "failed", "Its task no longer exists.");
            changed(app);
            continue;
        };
        match task.status.as_str() {
            "todo" => {}
            "doing" => {
                let limit = state.ledger.automation(r.automation_id).map(|a| a.max_minutes).unwrap_or(MAX_MINUTES);
                if task.started.is_some_and(|started| now - started > limit * MINUTE_MS) {
                    crate::tasks::time_out(app, &task.id, limit);
                }
            }
            _ => task_settled(app, &task.id),
        }
    }
}

/// An automation's task finished, was blocked or was closed: its run gets the result.
pub fn task_settled(app: &tauri::AppHandle, task_id: &str) {
    let Ok(state) = ledger(app) else { return };
    let Some(task) = state.ledger.task(task_id) else { return };
    if automation_of(&task.requested_by).is_none() {
        return;
    }
    let Some(run) = state.ledger.run_for_task(task_id).filter(|r| r.finished.is_none()) else { return };
    let (status, summary) = match task.status.as_str() {
        "done" | "reviewed" => ("succeeded", crate::tasks::last_reply(app, &task).unwrap_or_else(|| "Finished".into())),
        "closed" => ("failed", "You closed the task before it finished.".to_string()),
        "blocked" => ("failed", task.detail.clone().unwrap_or_else(|| "Stopped before it finished.".into())),
        _ => return,
    };
    state.ledger.finish_run(run.id, status, &crate::chat::truncate(&summary, SUMMARY_LIMIT));
    state.ledger.set_automation_status(run.automation_id, status);
    changed(app);
}

/// The scheduler. It starts after recovery, so work interrupted by a quit is
/// settled before anything new comes due.
pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        crate::tasks::recover(&app);
        loop {
            tick(&app);
            std::thread::sleep(TICK);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(over: impl FnOnce(&mut AutomationInput)) -> AutomationInput {
        let mut i = AutomationInput {
            id: None,
            name: "Nightly review".into(),
            agent_id: "jarvis".into(),
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            instruction: "Review today's changes".into(),
            schedule: Schedule::Daily { time: "02:00".into() },
            enabled: true,
            missed: "run_once".into(),
            notify: "failure".into(),
            max_minutes: 60,
            wake: false,
        };
        over(&mut i);
        i
    }

    #[test]
    fn says_what_is_missing_before_saving() {
        assert_eq!(problem(&input(|_| {}), true), None);
        assert!(problem(&input(|i| i.name = " ".into()), true).unwrap().contains("name"));
        assert!(problem(&input(|_| {}), false).unwrap().contains("agent"));
        assert!(problem(&input(|i| i.instruction = String::new()), true).unwrap().contains("each run"));
        assert!(problem(&input(|i| i.cwd = "/no/such/folder".into()), true).unwrap().contains("folder"));
        assert!(problem(&input(|i| i.max_minutes = 1), true).is_some());
        assert!(problem(&input(|i| i.max_minutes = MAX_MINUTES + 1), true).is_some());
        assert!(problem(&input(|i| i.missed = "whenever".into()), true).is_some());
        assert!(problem(&input(|i| i.notify = "sometimes".into()), true).is_some());
        assert!(problem(&input(|i| i.schedule = Schedule::EveryHours { hours: 30 }), true).is_some());
    }

    #[test]
    fn tasks_know_which_automation_asked() {
        assert_eq!(automation_of(&requester(42)), Some(42));
        assert_eq!(automation_of("you"), None);
        assert_eq!(automation_of("jarvis"), None);
        assert_eq!(automation_of("automation:x"), None);
    }

    #[test]
    fn missed_runs_follow_their_policy_and_never_pile_up() {
        let late = LATE_AFTER_MS + 1;
        assert_eq!(decide(0, "skip", false), Due::Run, "on time runs whatever the policy");
        assert_eq!(decide(LATE_AFTER_MS, "ask", false), Due::Run, "a little late still counts as on time");
        assert_eq!(decide(late, "run_once", false), Due::RunLate);
        assert_eq!(decide(late, "skip", false), Due::Missed { ask: false });
        assert_eq!(decide(late, "ask", false), Due::Missed { ask: true });
        assert_eq!(decide(0, "run_once", true), Due::Busy);
        assert_eq!(decide(late, "run_once", true), Due::Busy);
    }

    #[test]
    fn next_runs_are_in_the_future() {
        let now = now_ms();
        let next = next_run(&Schedule::Daily { time: "02:00".into() }, now).unwrap();
        // At most a day ahead, plus an hour for a daylight-saving change.
        assert!(next > now && next - now <= 25 * 60 * MINUTE_MS);
        assert_eq!(next_run(&Schedule::EveryHours { hours: 4 }, now), Some(now + 4 * 60 * MINUTE_MS));
    }
}
