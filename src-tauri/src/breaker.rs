//! Pure runaway-loop policy: it counts consecutive identical tool calls per
//! agent and decides when that's a loop. The side-effecting containment —
//! marking an agent Blocked, killing its session — lives in the caller; this
//! module only answers "is this a runaway yet?", so it's trivial to unit-test.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Consecutive identical tool calls that count as a runaway loop.
pub const RUNAWAY_TOOL_REPEATS: u32 = 10;

fn tracker() -> &'static Mutex<HashMap<String, (String, u32)>> {
    static T: OnceLock<Mutex<HashMap<String, (String, u32)>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record a tool call for an agent and return the current consecutive-run
/// length (1 = the first appearance of this signature in a row).
pub fn note_tool_call(agent_id: &str, sig: &str) -> u32 {
    let mut m = tracker().lock().unwrap();
    let entry = m.entry(agent_id.to_string()).or_insert_with(|| (String::new(), 0));
    if entry.0 == sig {
        entry.1 += 1;
    } else {
        entry.0 = sig.to_string();
        entry.1 = 1;
    }
    entry.1
}

/// Clear an agent's run (call on a clean turn `result`, or after a trip).
pub fn reset(agent_id: &str) {
    tracker().lock().unwrap().remove(agent_id);
}

/// Has this run length crossed into runaway territory?
pub fn is_runaway(run: u32) -> bool {
    run >= RUNAWAY_TOOL_REPEATS
}

// ---- containment ladder ----------------------------------------------------
//
// Steer first, escalate one rung per trip, de-escalate to Healthy on a clean
// turn. `Stopped` (kill) is only reachable when the caller opts in.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Healthy,
    Steering,
    Constrained,
    Stopped,
}

/// One rung up. `hard_stop=false` caps at Constrained (kill off by default).
pub fn escalate(level: Level, hard_stop: bool) -> Level {
    match level {
        Level::Healthy => Level::Steering,
        Level::Steering => Level::Constrained,
        Level::Constrained if hard_stop => Level::Stopped,
        other => other,
    }
}

/// One rung down (used per calm beat).
pub fn deescalate(level: Level) -> Level {
    match level {
        Level::Stopped => Level::Constrained,
        Level::Constrained => Level::Steering,
        Level::Steering | Level::Healthy => Level::Healthy,
    }
}

fn levels() -> &'static Mutex<HashMap<String, Level>> {
    static L: OnceLock<Mutex<HashMap<String, Level>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Escalate an agent one rung and return the new level.
pub fn bump(agent_id: &str, hard_stop: bool) -> Level {
    let mut m = levels().lock().unwrap();
    let cur = m.get(agent_id).copied().unwrap_or(Level::Healthy);
    let next = escalate(cur, hard_stop);
    m.insert(agent_id.to_string(), next);
    next
}

/// De-escalate an agent one rung (call on a clean turn — one level per healthy
/// beat). Drops the entry once it's back to Healthy.
pub fn step_down(agent_id: &str) {
    let mut m = levels().lock().unwrap();
    let cur = m.get(agent_id).copied().unwrap_or(Level::Healthy);
    match deescalate(cur) {
        Level::Healthy => {
            m.remove(agent_id);
        }
        lower => {
            m.insert(agent_id.to_string(), lower);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_consecutively_and_resets_on_change() {
        let a = "breaker-test-agent";
        reset(a);
        assert_eq!(note_tool_call(a, "Read|foo"), 1);
        assert_eq!(note_tool_call(a, "Read|foo"), 2);
        assert_eq!(note_tool_call(a, "Read|bar"), 1); // different sig restarts the run
        assert_eq!(note_tool_call(a, "Read|bar"), 2);
        reset(a);
        assert_eq!(note_tool_call(a, "Read|bar"), 1);
    }

    #[test]
    fn is_runaway_at_threshold() {
        assert!(!is_runaway(RUNAWAY_TOOL_REPEATS - 1));
        assert!(is_runaway(RUNAWAY_TOOL_REPEATS));
        assert!(is_runaway(RUNAWAY_TOOL_REPEATS + 5));
    }

    #[test]
    fn ladder_steers_first_and_de_escalates() {
        // soft: caps at Constrained, never kills.
        assert_eq!(escalate(Level::Healthy, false), Level::Steering);
        assert_eq!(escalate(Level::Steering, false), Level::Constrained);
        assert_eq!(escalate(Level::Constrained, false), Level::Constrained);
        // hard: one more rung to Stopped.
        assert_eq!(escalate(Level::Constrained, true), Level::Stopped);
        assert_eq!(escalate(Level::Stopped, true), Level::Stopped);
        // de-escalation walks back one rung at a time to Healthy.
        assert_eq!(deescalate(Level::Stopped), Level::Constrained);
        assert_eq!(deescalate(Level::Steering), Level::Healthy);
        assert_eq!(deescalate(Level::Healthy), Level::Healthy);
    }

    #[test]
    fn bump_and_step_down_track_per_agent() {
        let a = "breaker-ladder-agent";
        step_down(a); // ensure Healthy start
        assert_eq!(bump(a, true), Level::Steering);
        assert_eq!(bump(a, true), Level::Constrained);
        assert_eq!(bump(a, true), Level::Stopped);
        step_down(a); // one rung down: Stopped -> Constrained
        assert_eq!(bump(a, true), Level::Stopped); // Constrained -> Stopped again
        step_down(a); // -> Constrained
        step_down(a); // -> Steering
        step_down(a); // -> Healthy
        assert_eq!(bump(a, true), Level::Steering); // back at the bottom
    }
}
