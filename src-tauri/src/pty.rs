use crate::agents::AgentStatus;
use portable_pty::{native_pty_system, Child, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{Emitter, Manager};

/// One live agent process: its pty master (for resize), a writer (for stdin),
/// the child handle (for kill), plus bookkeeping for status + runaway detection.
pub struct Session {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn Child + Send + Sync>,
    pub status: AgentStatus,
    pub last_activity: Instant,
    pub out_window_count: u32,
    pub window_start: Instant,
}

/// Owns every running agent session, keyed by agent id.
#[derive(Default)]
pub struct PtyManager {
    pub sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Clone, Serialize)]
pub struct PtyData {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub data: Vec<u8>,
}

#[derive(Clone, Serialize)]
pub struct StatusEvent {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub status: AgentStatus,
}

/// Runaway threshold: more than this many output chunks inside the 5s window
/// trips Ultron containment and blocks the agent.
const RUNAWAY_CHUNKS: u32 = 6000;

pub fn emit_status(app: &tauri::AppHandle, agent_id: &str, status: AgentStatus) {
    // Record into the single source of truth so the roster reconcile is accurate.
    if let Some(state) = app.try_state::<crate::AppState>() {
        state
            .statuses
            .lock()
            .unwrap()
            .insert(agent_id.to_string(), status);
    }
    let _ = app.emit(
        "agent://status",
        StatusEvent {
            agent_id: agent_id.to_string(),
            status,
        },
    );
}

/// Spawn an engine process in a pty, stream its output to the frontend, and
/// register the session in shared state.
pub fn spawn_session(
    app: &tauri::AppHandle,
    agent_id: &str,
    cmd: portable_pty::CommandBuilder,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Drop the slave so the child gets EOF (and we notice it exit).
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let session = Session {
        master: pair.master,
        writer,
        child,
        status: AgentStatus::Idle,
        last_activity: Instant::now(),
        out_window_count: 0,
        window_start: Instant::now(),
    };

    {
        let state = app.state::<crate::AppState>();
        state
            .pty
            .sessions
            .lock()
            .unwrap()
            .insert(agent_id.to_string(), session);
    }
    emit_status(app, agent_id, AgentStatus::Idle);

    // Reader thread: pump pty output to the webview.
    let app2 = app.clone();
    let id = agent_id.to_string();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = app2.emit(
                        "pty://data",
                        PtyData {
                            agent_id: id.clone(),
                            data: buf[..n].to_vec(),
                        },
                    );
                    on_activity(&app2, &id);
                }
                Err(_) => break,
            }
        }
        // Session ended — clean up and mark offline.
        let state = app2.state::<crate::AppState>();
        state.pty.sessions.lock().unwrap().remove(&id);
        emit_status(&app2, &id, AgentStatus::Offline);
    });

    Ok(())
}

/// Called on each output chunk: refresh activity, flip Idle→Working, and run
/// the runaway circuit breaker (Ultron containment).
fn on_activity(app: &tauri::AppHandle, agent_id: &str) {
    let state = app.state::<crate::AppState>();
    let mut became_working = false;
    let mut tripped = false;
    {
        let mut map = state.pty.sessions.lock().unwrap();
        if let Some(s) = map.get_mut(agent_id) {
            s.last_activity = Instant::now();

            if s.status != AgentStatus::Working && s.status != AgentStatus::Blocked {
                s.status = AgentStatus::Working;
                became_working = true;
            }

            if s.window_start.elapsed().as_secs() >= 5 {
                s.window_start = Instant::now();
                s.out_window_count = 0;
            }
            s.out_window_count += 1;
            if s.out_window_count > RUNAWAY_CHUNKS && s.status != AgentStatus::Blocked {
                s.status = AgentStatus::Blocked;
                tripped = true;
            }
        }
    }
    if became_working {
        emit_status(app, agent_id, AgentStatus::Working);
    }
    if tripped {
        emit_status(app, agent_id, AgentStatus::Blocked);
        let _ = app.emit("breaker://trip", agent_id.to_string());
        let entry = state.ledger.record(
            agent_id,
            "containment",
            "Ultron containment: runaway output — agent paused",
            9,
        );
        let _ = app.emit("ledger://entry", entry);
    }
}

pub fn write_bytes(app: &tauri::AppHandle, agent_id: &str, data: &[u8]) -> Result<(), String> {
    let state = app.state::<crate::AppState>();
    let mut map = state.pty.sessions.lock().unwrap();
    let s = map
        .get_mut(agent_id)
        .ok_or_else(|| format!("agent {agent_id} is not running"))?;
    s.writer.write_all(data).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn resize(app: &tauri::AppHandle, agent_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let state = app.state::<crate::AppState>();
    let map = state.pty.sessions.lock().unwrap();
    if let Some(s) = map.get(agent_id) {
        s.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn kill(app: &tauri::AppHandle, agent_id: &str) -> Result<(), String> {
    let state = app.state::<crate::AppState>();
    let removed = { state.pty.sessions.lock().unwrap().remove(agent_id) };
    if let Some(mut s) = removed {
        let _ = s.child.kill();
    }
    emit_status(app, agent_id, AgentStatus::Offline);
    Ok(())
}

/// Manually release Ultron containment (the UI's "release" action): reset the
/// runaway window and put a Blocked session back to Idle right away.
pub fn unblock(app: &tauri::AppHandle, agent_id: &str) {
    let released = {
        let state = app.state::<crate::AppState>();
        let mut map = state.pty.sessions.lock().unwrap();
        match map.get_mut(agent_id) {
            Some(s) if s.status == AgentStatus::Blocked => {
                s.status = AgentStatus::Idle;
                s.out_window_count = 0;
                s.window_start = Instant::now();
                true
            }
            _ => false,
        }
    };
    if released {
        emit_status(app, agent_id, AgentStatus::Idle);
    }
}

/// Background monitor that demotes Working→Idle after a lull, so sprites settle
/// back down when an agent stops streaming.
pub fn start_idle_monitor(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(1000));
        let mut to_idle = Vec::new();
        {
            let state = app.state::<crate::AppState>();
            let mut map = state.pty.sessions.lock().unwrap();
            for (id, s) in map.iter_mut() {
                let quiet = s.last_activity.elapsed().as_secs();
                if s.status == AgentStatus::Working && quiet >= 4 {
                    s.status = AgentStatus::Idle;
                    to_idle.push(id.clone());
                } else if s.status == AgentStatus::Blocked && quiet >= 8 {
                    // Ultron containment auto-releases once the runaway output has
                    // actually stopped, so a tripped agent never gets stuck
                    // Blocked forever. Reset the runaway window too.
                    s.status = AgentStatus::Idle;
                    s.out_window_count = 0;
                    s.window_start = Instant::now();
                    to_idle.push(id.clone());
                }
            }
        }
        for id in to_idle {
            emit_status(&app, &id, AgentStatus::Idle);
        }
    });
}
