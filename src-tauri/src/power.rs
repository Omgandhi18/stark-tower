//! Keep the Mac awake while agents do useful work.
//!
//! A named IOKit power assertion ("Starkline: agents are working", visible in
//! Activity Monitor and `pmset -g assertions`) is held only while the developer
//! allows it AND an agent is working. An agent that is only waiting on the
//! developer keeps the Mac awake for a short grace period, then it may sleep.

use crate::agents::AgentStatus;
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// How long the Mac stays awake for agents that are only waiting on you.
pub const WAITING_GRACE: Duration = Duration::from_secs(10 * 60);
/// How often the grace period is re-checked when no status changes.
pub const RECHECK_EVERY: Duration = Duration::from_secs(20);
const ASSERTION_NAME: &str = "Starkline: agents are working";

#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PowerState {
    /// The developer allows Starkline to keep this Mac awake.
    pub enabled: bool,
    /// A power assertion is held right now.
    pub holding: bool,
    /// Why it is held, or why not, in plain words.
    pub reason: String,
    /// False where keep-awake isn't available on this platform.
    pub supported: bool,
}

#[derive(Default)]
pub struct PowerManager {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    enabled: bool,
    assertion: Option<platform::Assertion>,
    last_busy: Option<Instant>,
    published: Option<PowerState>,
}

/// Whether to hold the assertion, and why, given every agent's status.
pub fn decide(enabled: bool, statuses: &[AgentStatus], last_busy: Option<Instant>, now: Instant) -> (bool, String) {
    if !enabled {
        return (false, "Keep Awake is off.".into());
    }
    let working = statuses
        .iter()
        .filter(|s| matches!(s, AgentStatus::Working | AgentStatus::Thinking))
        .count();
    if working > 0 {
        let who = if working == 1 { "1 agent is".to_string() } else { format!("{working} agents are") };
        return (true, format!("Awake while {who} working."));
    }
    let waiting = statuses.iter().any(|s| matches!(s, AgentStatus::Blocked));
    if waiting {
        if let Some(busy) = last_busy {
            if now.duration_since(busy) < WAITING_GRACE {
                return (true, "Awake a little longer: an agent is waiting on you.".into());
            }
        }
        return (false, "Agents are waiting on you, so the Mac may sleep.".into());
    }
    (false, "No agent is working, so the Mac may sleep.".into())
}

impl PowerManager {
    pub fn set_enabled(&self, enabled: bool) {
        self.inner.lock().unwrap().enabled = enabled;
    }

    /// Re-evaluate against the current statuses, acquiring or releasing the
    /// assertion. Returns the state if it changed since it was last published.
    pub fn evaluate(&self, statuses: &[AgentStatus], now: Instant) -> Option<PowerState> {
        let mut inner = self.inner.lock().unwrap();
        if statuses.iter().any(|s| matches!(s, AgentStatus::Working | AgentStatus::Thinking)) {
            inner.last_busy = Some(now);
        }
        let (hold, reason) = decide(inner.enabled, statuses, inner.last_busy, now);
        if hold && inner.assertion.is_none() {
            inner.assertion = platform::Assertion::acquire(ASSERTION_NAME);
        } else if !hold {
            inner.assertion = None; // Drop releases it.
        }
        let state = PowerState {
            enabled: inner.enabled,
            holding: inner.assertion.is_some(),
            reason: if hold && inner.assertion.is_none() {
                "macOS refused the keep-awake request.".into()
            } else {
                reason
            },
            supported: platform::SUPPORTED,
        };
        if inner.published.as_ref() == Some(&state) {
            return None;
        }
        inner.published = Some(state.clone());
        Some(state)
    }

    pub fn current(&self) -> Option<PowerState> {
        self.inner.lock().unwrap().published.clone()
    }
}

/// Re-evaluate keep-awake for the app's current agent statuses and tell the UI
/// if anything changed.
pub fn sync(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return;
    };
    let statuses: Vec<AgentStatus> = state.statuses.lock().unwrap().values().copied().collect();
    if let Some(changed) = state.power.evaluate(&statuses, Instant::now()) {
        let _ = app.emit("power://state", changed);
    }
}

/// The current state, evaluating once if nothing has been published yet.
pub fn state(app: &tauri::AppHandle) -> PowerState {
    sync(app);
    app.state::<crate::AppState>().power.current().unwrap_or(PowerState {
        enabled: false,
        holding: false,
        reason: "Keep Awake is off.".into(),
        supported: platform::SUPPORTED,
    })
}

#[cfg(target_os = "macos")]
mod platform {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            level: u32,
            name: CFStringRef,
            out_id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }

    const ASSERTION_LEVEL_ON: u32 = 255;
    const IO_RETURN_SUCCESS: i32 = 0;
    pub const SUPPORTED: bool = true;

    /// A held power assertion; dropping it releases it.
    pub struct Assertion(u32);

    impl Assertion {
        pub fn acquire(name: &str) -> Option<Self> {
            let kind = CFString::new("PreventUserIdleSystemSleep");
            let name = CFString::new(name);
            let mut id = 0u32;
            // SAFETY: both CFStrings outlive the call and `id` is a valid out pointer.
            let rc = unsafe {
                IOPMAssertionCreateWithName(kind.as_concrete_TypeRef(), ASSERTION_LEVEL_ON, name.as_concrete_TypeRef(), &mut id)
            };
            (rc == IO_RETURN_SUCCESS).then_some(Self(id))
        }
    }

    impl Drop for Assertion {
        fn drop(&mut self) {
            // SAFETY: the id came from a successful IOPMAssertionCreateWithName.
            unsafe {
                IOPMAssertionRelease(self.0);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub const SUPPORTED: bool = false;
    pub struct Assertion;
    impl Assertion {
        pub fn acquire(_name: &str) -> Option<Self> {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use AgentStatus::*;

    #[test]
    fn off_never_holds() {
        let now = Instant::now();
        assert!(!decide(false, &[Working], Some(now), now).0);
    }

    #[test]
    fn working_agents_hold() {
        let now = Instant::now();
        let (hold, reason) = decide(true, &[Idle, Working, Thinking], None, now);
        assert!(hold);
        assert!(reason.contains("2 agents"), "{reason}");
    }

    #[test]
    fn waiting_holds_only_within_the_grace_period() {
        let start = Instant::now();
        assert!(decide(true, &[Blocked], Some(start), start + Duration::from_secs(60)).0);
        assert!(!decide(true, &[Blocked], Some(start), start + WAITING_GRACE + Duration::from_secs(1)).0);
        assert!(!decide(true, &[Blocked], None, start).0);
    }

    #[test]
    fn idle_or_offline_releases() {
        let now = Instant::now();
        assert!(!decide(true, &[Idle, Offline], Some(now), now).0);
    }

    /// Talks to the real power manager, so it only runs on request:
    /// `cargo test -- --ignored real_assertion`.
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn real_assertion_is_listed_by_pmset_and_released() {
        let listed = || {
            let out = std::process::Command::new("pmset").args(["-g", "assertions"]).output().unwrap();
            String::from_utf8_lossy(&out.stdout).contains(ASSERTION_NAME)
        };
        let held = platform::Assertion::acquire(ASSERTION_NAME).expect("macOS grants the assertion");
        assert!(listed(), "pmset should list the held assertion");
        drop(held);
        assert!(!listed(), "dropping releases it");
    }

    #[test]
    fn evaluate_publishes_only_changes() {
        let pm = PowerManager::default();
        pm.set_enabled(true);
        let now = Instant::now();
        let first = pm.evaluate(&[Idle], now).expect("first evaluation publishes");
        assert!(!first.holding);
        assert!(pm.evaluate(&[Idle], now).is_none(), "unchanged state is not re-published");
    }
}
