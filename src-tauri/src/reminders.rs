//! Reminders. The developer sets one on the Reminders screen, on a task, or by
//! asking an agent in chat; when it comes due, the agent it belongs to reminds
//! them: a needs-you notification with a macOS banner, a line in that agent's
//! chat and, in the room, the agent walking over to hand it in. A repeating
//! reminder then waits for its next time; a one-off waits to be marked done or
//! snoozed. One that came due while the Mac slept or Starkline was closed goes
//! off when Starkline next runs, and says when it was due.

use crate::ledger::Reminder;
use crate::schedule::Schedule;
use chrono::{DateTime, Datelike, Local, NaiveDateTime, TimeZone};
use serde::Deserialize;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// How often due reminders are looked for.
const TICK: Duration = Duration::from_secs(10);
/// Later than this, a reminder says when it was due.
const LATE_AFTER_MS: i64 = 10 * 60 * 1000;
const TEXT_LIMIT: usize = 300;
/// The furthest ahead an agent may set one.
const MAX_MINUTES_AHEAD: i64 = 366 * 24 * 60;
pub const BY_DEVELOPER: &str = "you";

/// What the developer enters.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct ReminderInput {
    /// None to create one.
    pub id: Option<i64>,
    pub text: String,
    /// Who reminds the developer.
    pub agent_id: String,
    pub task_id: Option<String>,
    /// When it goes off. A repeating reminder goes off on its schedule instead.
    pub due: i64,
    pub repeat: Option<Schedule>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// "Tue 7 Oct at 9:00 AM", in this Mac's local time.
pub fn when(ms: i64) -> String {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|t| t.format("%a %-d %b at %-I:%M %p").to_string())
        .unwrap_or_else(|| "earlier".into())
}

/// The schedule's next time after `after_ms`, in local time.
fn next_after(schedule: &Schedule, after_ms: i64) -> Option<i64> {
    let after = Local.timestamp_millis_opt(after_ms).single()?;
    crate::schedule::next_after(schedule, &after).map(|t| t.timestamp_millis())
}

fn changed(app: &tauri::AppHandle) {
    let _ = app.emit("reminders://changed", ());
}

fn ledger(app: &tauri::AppHandle) -> Result<tauri::State<'_, crate::AppState>, String> {
    app.try_state::<crate::AppState>().ok_or_else(|| "Starkline isn't ready yet.".into())
}

fn agent_known(app: &tauri::AppHandle, agent_id: &str) -> bool {
    app.try_state::<crate::AppState>()
        .is_some_and(|s| s.config.lock().unwrap().agents.iter().any(|a| a.enabled && a.id == agent_id))
}

/// What's wrong with a reminder as entered, if anything. A time already past is
/// fine only when it's the one the reminder already had (an edit to its words).
pub fn problem(input: &ReminderInput, agent_known: bool, now: i64, kept_due: Option<i64>) -> Option<String> {
    let text = input.text.trim();
    if text.is_empty() {
        return Some("Say what to remind you of.".into());
    }
    if text.chars().count() > TEXT_LIMIT {
        return Some(format!("Keep it under {TEXT_LIMIT} characters."));
    }
    if !agent_known {
        return Some("Choose who reminds you.".into());
    }
    match &input.repeat {
        Some(schedule) => crate::schedule::problem(schedule).map(Into::into),
        None if input.due <= now && kept_due != Some(input.due) => Some("Pick a time that hasn't passed.".into()),
        None => None,
    }
}

pub fn list(app: &tauri::AppHandle) -> Vec<Reminder> {
    ledger(app).map(|s| s.ledger.reminders()).unwrap_or_default()
}

/// Create a reminder (no id) or change one.
pub fn save(app: &tauri::AppHandle, input: ReminderInput) -> Result<Reminder, String> {
    store(app, input, BY_DEVELOPER)
}

fn store(app: &tauri::AppHandle, input: ReminderInput, set_by: &str) -> Result<Reminder, String> {
    let state = ledger(app)?;
    let now = now_ms();
    let existing = match input.id {
        Some(id) => Some(state.ledger.reminder(id).ok_or("That reminder no longer exists.")?),
        None => None,
    };
    if let Some(p) = problem(&input, agent_known(app, &input.agent_id), now, existing.as_ref().map(|r| r.due)) {
        return Err(p);
    }
    let due = match &input.repeat {
        // A schedule that keeps its time keeps the next slot it already had.
        Some(schedule) => match existing.as_ref().filter(|r| r.repeat.as_ref() == Some(schedule) && r.status == "waiting") {
            Some(r) => r.due,
            None => next_after(schedule, now).ok_or("That schedule never comes round.")?,
        },
        None => input.due,
    };
    let rescheduled = existing.as_ref().is_none_or(|r| r.due != due || r.repeat != input.repeat);
    let reminder = Reminder {
        id: input.id.unwrap_or(0),
        text: input.text.trim().to_string(),
        agent_id: input.agent_id.clone(),
        task_id: input.task_id.filter(|t| !t.trim().is_empty()),
        due,
        repeat: input.repeat,
        status: match &existing {
            Some(r) if !rescheduled => r.status.clone(),
            _ => "waiting".into(),
        },
        fired: existing.as_ref().and_then(|r| r.fired),
        set_by: existing.as_ref().map_or_else(|| set_by.to_string(), |r| r.set_by.clone()),
        created: 0,
        updated: 0,
    };
    let saved = state.ledger.save_reminder(&reminder).ok_or("The reminder couldn't be saved.")?;
    if rescheduled && existing.is_some() {
        crate::notify::reminder_settled(app, saved.id, &format!("Moved to {}", when(saved.due)));
    }
    changed(app);
    Ok(saved)
}

/// Done with it: a one-off is finished; a repeating one waits for its next time.
pub fn complete(app: &tauri::AppHandle, id: i64) -> Result<(), String> {
    let state = ledger(app)?;
    let r = state.ledger.reminder(id).ok_or("That reminder no longer exists.")?;
    if r.repeat.is_none() {
        state.ledger.save_reminder(&Reminder { status: "done".into(), ..r });
    }
    crate::notify::reminder_settled(app, id, "Done");
    changed(app);
    Ok(())
}

/// Remind me again at `until`.
pub fn snooze(app: &tauri::AppHandle, id: i64, until: i64) -> Result<Reminder, String> {
    let state = ledger(app)?;
    let r = state.ledger.reminder(id).ok_or("That reminder no longer exists.")?;
    if until <= now_ms() {
        return Err("Pick a time that hasn't passed.".into());
    }
    let saved = state
        .ledger
        .save_reminder(&Reminder { due: until, status: "waiting".into(), ..r })
        .ok_or("The reminder couldn't be snoozed.")?;
    crate::notify::reminder_settled(app, id, &format!("Snoozed until {}", when(until)));
    changed(app);
    Ok(saved)
}

pub fn delete(app: &tauri::AppHandle, id: i64) -> Result<(), String> {
    let state = ledger(app)?;
    state.ledger.delete_reminder(id);
    crate::notify::reminder_settled(app, id, "Deleted");
    changed(app);
    Ok(())
}

/// Set a reminder an agent was asked for in chat; it reminds the developer itself.
pub fn set_by_agent(app: &tauri::AppHandle, agent_id: &str, text: &str, due: DateTime<Local>, repeat: Option<Schedule>) -> Result<Reminder, String> {
    let input = ReminderInput { id: None, text: text.to_string(), agent_id: agent_id.to_string(), task_id: None, due: due.timestamp_millis(), repeat };
    store(app, input, agent_id)
}

/// When an agent asked for it: `in_minutes` from now, or at a local time
/// ("2026-10-07 09:00", "2026-10-07T09:00", RFC 3339, or "17:30" for the next
/// time the clock shows it). It has to be in the future, and within a year.
pub fn parse_when(at: &str, in_minutes: Option<i64>, now: DateTime<Local>) -> Result<DateTime<Local>, String> {
    let at = at.trim();
    let due = if let Some(minutes) = in_minutes.filter(|_| at.is_empty()) {
        if !(1..=MAX_MINUTES_AHEAD).contains(&minutes) {
            return Err("in_minutes has to be between 1 and a year's worth.".into());
        }
        now + chrono::Duration::minutes(minutes)
    } else if at.is_empty() {
        return Err("Say when: `at` (a local time) or `in_minutes`.".into());
    } else if let Ok(t) = DateTime::parse_from_rfc3339(at) {
        t.with_timezone(&Local)
    } else if let Some(naive) = ["%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"]
        .iter()
        .find_map(|f| NaiveDateTime::parse_from_str(at, f).ok())
    {
        Local.from_local_datetime(&naive).earliest().ok_or("That time doesn't exist here (a clock change).")?
    } else if let Some(time) = crate::schedule::parse_time(at) {
        let today = Local.from_local_datetime(&now.date_naive().and_time(time)).earliest().ok_or("That time doesn't exist today.")?;
        if today > now { today } else { today + chrono::Duration::days(1) }
    } else {
        return Err(format!("\"{at}\" isn't a time I can read. Use \"YYYY-MM-DD HH:MM\" or \"HH:MM\"."));
    };
    if due <= now {
        return Err(format!("{} has already passed.", due.format("%a %-d %b %H:%M")));
    }
    if due > now + chrono::Duration::minutes(MAX_MINUTES_AHEAD) {
        return Err("That's more than a year away.".into());
    }
    Ok(due)
}

/// The schedule for "repeat daily / weekdays / weekly" at `due`'s time of day.
pub fn repeat_at(repeat: &str, due: &DateTime<Local>) -> Result<Option<Schedule>, String> {
    let time = due.format("%H:%M").to_string();
    Ok(match repeat.trim() {
        "" | "never" | "once" => None,
        "daily" => Some(Schedule::Daily { time }),
        "weekdays" => Some(Schedule::Weekdays { time }),
        "weekly" => Some(Schedule::Weekly { day: due.weekday().num_days_from_monday() as u8, time }),
        other => return Err(format!("repeat can be daily, weekdays or weekly, not \"{other}\".")),
    })
}

/// Set off what's due.
pub fn tick(app: &tauri::AppHandle) {
    let Ok(state) = ledger(app) else { return };
    let now = now_ms();
    let due: Vec<Reminder> = state.ledger.reminders().into_iter().filter(|r| r.status == "waiting" && r.due <= now).collect();
    for r in due {
        let late = (now - r.due > LATE_AFTER_MS).then(|| when(r.due));
        // An earlier time a repeating reminder went off, still unanswered, gives way to this one.
        crate::notify::reminder_settled(app, r.id, "Went off again");
        let next = r.repeat.as_ref().and_then(|s| next_after(s, now));
        state.ledger.save_reminder(&Reminder {
            status: if next.is_some() { "waiting" } else { "due" }.into(),
            due: next.unwrap_or(r.due),
            fired: Some(now),
            ..r.clone()
        });
        crate::notify::reminder_due(app, &r, late.as_deref());
        crate::chat::note(app, &r.agent_id, &format!("Reminder for you: {}", r.text));
        let _ = app.emit("reminders://due", serde_json::json!({ "id": r.id, "agentId": r.agent_id }));
        changed(app);
    }
}

pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        tick(&app);
        std::thread::sleep(TICK);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(over: impl FnOnce(&mut ReminderInput)) -> ReminderInput {
        let mut i = ReminderInput { id: None, text: "Check the deploy".into(), agent_id: "friday".into(), task_id: None, due: 2_000, repeat: None };
        over(&mut i);
        i
    }

    fn at(text: &str) -> DateTime<Local> {
        Local.from_local_datetime(&NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M").unwrap()).earliest().unwrap()
    }

    #[test]
    fn a_reminder_needs_words_someone_to_remind_and_a_time_to_come() {
        assert_eq!(problem(&input(|_| {}), true, 1_000, None), None);
        assert_eq!(problem(&input(|i| i.text = "  ".into()), true, 1_000, None).as_deref(), Some("Say what to remind you of."));
        assert_eq!(problem(&input(|_| {}), false, 1_000, None).as_deref(), Some("Choose who reminds you."));
        assert_eq!(problem(&input(|_| {}), true, 3_000, None).as_deref(), Some("Pick a time that hasn't passed."));
        // Rewording one that already went off keeps its time.
        assert_eq!(problem(&input(|_| {}), true, 3_000, Some(2_000)), None);
        let bad = input(|i| i.repeat = Some(Schedule::Daily { time: "25:00".into() }));
        assert_eq!(problem(&bad, true, 3_000, None).as_deref(), Some("Use a time like 09:30."));
    }

    #[test]
    fn agents_say_when_in_minutes_or_as_a_local_time() {
        let now = at("2026-10-06 16:00");
        assert_eq!(parse_when("", Some(30), now).unwrap(), at("2026-10-06 16:30"));
        assert_eq!(parse_when("2026-10-07 09:00", None, now).unwrap(), at("2026-10-07 09:00"));
        assert_eq!(parse_when("2026-10-07T09:00", None, now).unwrap(), at("2026-10-07 09:00"));
        // A clock time is its next time round: later today, else tomorrow.
        assert_eq!(parse_when("17:30", None, now).unwrap(), at("2026-10-06 17:30"));
        assert_eq!(parse_when("09:00", None, now).unwrap(), at("2026-10-07 09:00"));
        assert!(parse_when("2026-10-06 15:00", None, now).unwrap_err().contains("already passed"));
        assert!(parse_when("whenever", None, now).unwrap_err().contains("isn't a time"));
        assert!(parse_when("", None, now).is_err());
        assert!(parse_when("", Some(0), now).is_err());
    }

    #[test]
    fn repeats_keep_the_time_of_day() {
        let due = at("2026-10-07 09:00");
        assert_eq!(repeat_at("daily", &due).unwrap(), Some(Schedule::Daily { time: "09:00".into() }));
        assert_eq!(repeat_at("weekly", &due).unwrap(), Some(Schedule::Weekly { day: 2, time: "09:00".into() }));
        assert_eq!(repeat_at("", &due).unwrap(), None);
        assert!(repeat_at("hourly", &due).is_err());
    }
}
