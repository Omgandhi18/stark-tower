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
}
