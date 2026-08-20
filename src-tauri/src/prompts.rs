//! Prompt assembly and roster resolution: the agent charter constants, the
//! per-agent/orchestrator system-prompt builders, and the config-backed helpers
//! that resolve an agent's engine, model, name, and orchestrator role. Split out
//! of chat.rs; these are pure string/state reads with no session side effects.

use crate::agents::{AgentKind, AgentStatus};
use crate::config::EngineConfig;
use tauri::Manager;

/// App-level delegation mechanics, appended to JARVIS's (editable) personality
/// only when his engine supports the MCP bridge. Kept in code — not user-editable
/// — because it describes how *this app* wires delegation, not JARVIS's character.
const JARVIS_MECHANICS: &str = "How delegation works here: to parallelize, emit multiple \
`delegate` calls in the SAME turn (e.g. KAREN on the frontend and FRIDAY on the backend at once, \
or the same task across two directories) — they run concurrently. Delegation is NON-BLOCKING: the \
`delegate` tool returns IMMEDIATELY with just an acknowledgement, NOT the worker's output. So after \
delegating, briefly tell Om what you dispatched and to whom, then END YOUR TURN — do not wait or \
claim you have results yet. When the workers finish you'll automatically receive their outputs as a \
`[DELEGATION RESULTS]` message; THAT is when you synthesize everything into one clear reply for Om.\n\n\
Write each `delegate` task as a complete, self-contained CONTRACT — the worker never sees this \
conversation, so it must stand on its own. Cover four parts:\n\
- OBJECTIVE: the concrete outcome to achieve.\n\
- OUTPUT: exactly what to report back to you (a summary, a diff, a decision, findings…).\n\
- CONTEXT: the paths, commands, versions, and facts it needs — pass the right `directory`.\n\
- BOUNDARIES: what it must NOT touch or do, and anything to leave for a human.\n\
Keep it tight for a small task, but never omit the OBJECTIVE and OUTPUT.";

/// The current project map, so JARVIS can delegate to the right directory when
/// the user names a repo. Empty when no projects are configured.
fn project_map(app: &tauri::AppHandle) -> String {
    let mut s = String::new();
    if let Some(state) = app.try_state::<crate::AppState>() {
        let projects = state.projects.lock().unwrap().clone();
        let active = state.project.lock().unwrap().clone();
        if !projects.is_empty() {
            s.push_str(
                "Known projects you can delegate into (pass the absolute path as the `directory` argument):\n",
            );
            for p in &projects {
                s.push_str(&format!("- {} → {}\n", crate::chat::base_name(p), p));
            }
            s.push_str(&format!(
                "The active/default project is {active}. When the user names a project, map it to its path above. To work across several projects at once, delegate in parallel with the matching `directory` for each."
            ));
        }
    }
    s
}

/// The agent's editable personality (falls back to the built-in default).
fn personality_for(app: &tauri::AppHandle, agent_id: &str) -> String {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let cfg = state.config.lock().unwrap();
        if let Some(a) = cfg.agent(agent_id) {
            if !a.personality.trim().is_empty() {
                return a.personality.clone();
            }
        }
    }
    crate::config::default_personality(agent_id).to_string()
}

/// The engine an agent runs on (falls back to the built-in Claude Code engine).
pub(crate) fn agent_engine(app: &tauri::AppHandle, agent_id: &str) -> EngineConfig {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let cfg = state.config.lock().unwrap();
        if let Some(e) = cfg.engine_for(agent_id) {
            return e.clone();
        }
    }
    crate::config::claude_default()
}

/// The model to run (agent override → engine default → "" for the engine's own).
pub(crate) fn agent_model(app: &tauri::AppHandle, agent_id: &str, engine: &EngineConfig) -> String {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let cfg = state.config.lock().unwrap();
        if let Some(a) = cfg.agent(agent_id) {
            if !a.model.trim().is_empty() {
                return a.model.clone();
            }
        }
    }
    engine.model.clone()
}

/// Is this agent the lab's orchestrator (the one that can delegate)?
pub(crate) fn agent_is_orchestrator(app: &tauri::AppHandle, agent_id: &str) -> bool {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let cfg = state.config.lock().unwrap();
        if let Some(a) = cfg.agent(agent_id) {
            return a.kind == AgentKind::Orchestrator;
        }
    }
    agent_id == "jarvis"
}

/// The agent's current display name (falls back to its id).
fn agent_name(app: &tauri::AppHandle, agent_id: &str) -> String {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let cfg = state.config.lock().unwrap();
        if let Some(a) = cfg.agent(agent_id) {
            return a.name.clone();
        }
    }
    agent_id.to_string()
}

/// The live team the orchestrator can delegate to, built from the current config
/// so renamed and newly-added specialists show up automatically.
fn team_block(app: &tauri::AppHandle, self_id: &str) -> String {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return String::new();
    };
    // Snapshot the roster first (drop the config lock before taking statuses, so
    // the two locks are never held at once).
    let workers: Vec<(String, String, String)> = {
        let cfg = state.config.lock().unwrap();
        cfg.agents
            .iter()
            .filter(|a| a.enabled && a.id != self_id && a.kind == AgentKind::Worker)
            .map(|a| (a.id.clone(), a.name.clone(), a.role.clone()))
            .collect()
    };
    if workers.is_empty() {
        return String::new();
    }
    let statuses = state.statuses.lock().unwrap();
    let lines: Vec<String> = workers
        .iter()
        .map(|(id, name, role)| {
            let word = match statuses.get(id).copied().unwrap_or(AgentStatus::Offline) {
                AgentStatus::Idle => "idle",
                AgentStatus::Thinking | AgentStatus::Working => "busy",
                AgentStatus::Blocked => "blocked",
                AgentStatus::Offline => "offline",
            };
            format!("- `{id}`: {name} ({role}) — {word}")
        })
        .collect();
    format!(
        "Your team — live status shown. Prefer an `idle` or `offline` worker; avoid piling work onto one that's already `busy` or `blocked`. Delegate by passing the worker's id to the `delegate` tool:\n{}",
        lines.join("\n")
    )
}

/// Resolve a delegate target (given by id or display name) to a canonical worker
/// id, or "" if it isn't an enabled worker.
pub(crate) fn resolve_worker_id(app: &tauri::AppHandle, input: &str) -> String {
    let q = input.trim().to_lowercase();
    if q.is_empty() {
        return String::new();
    }
    if let Some(state) = app.try_state::<crate::AppState>() {
        let cfg = state.config.lock().unwrap();
        for a in &cfg.agents {
            if a.enabled && a.kind == AgentKind::Worker && a.id.to_lowercase() == q {
                return a.id.clone();
            }
        }
        for a in &cfg.agents {
            if a.enabled && a.kind == AgentKind::Worker && a.name.to_lowercase() == q {
                return a.id.clone();
            }
        }
    }
    String::new()
}

const ASK_HUMAN_NOTE: &str = "You have the `ask_human` tool — your review surface with Om. \
Use it for any sign-off, decision, findings gate, question, or to show a UI mockup \
(kind: \"mockup\", with a COMPLETE self-contained HTML document in `body` — inline CSS, no \
external CDN). It renders in the app and BLOCKS until Om decides, then returns his decision. \
Use it instead of any lavish or browser step.";

const MESSAGE_NOTE: &str = "You can also `message` a teammate directly by their agent id — a \
question, a heads-up, or a hand-off note. It's delivered to them when they're next free (no reply \
on the call). Teammates' messages to you arrive inline as [MESSAGE from …]; read and act on them. \
Use `message` to coordinate with a specialist; use `ask_human` for anything that needs Om.";

const JARVIS_PLAYBOOK: &str = "Planning playbook (the sarathi funnel) — for a large or foggy \
request, think before delegating: (1) if the idea is foggy, open it into a few distinct \
directions and settle on one; (2) stress-test the plan by asking Om the key open decisions via \
ask_human (kind: \"questions\") and folding in his answers; (3) cut the settled plan into small \
VERTICAL slices — each shippable on its own, no forward dependencies — and get sign-off via \
ask_human; (4) delegate one slice at a time to the right specialist. Skip all this for small, \
clear tasks. Route every human checkpoint through ask_human, never a browser.";

/// Assemble an agent's full system prompt: its editable personality, plus the
/// app mechanics its engine can actually use. JARVIS also gets the live project
/// map and, on an MCP engine, the delegation mechanics + planning playbook. The
/// ask_human note is appended only when the engine speaks our MCP bridge.
pub(crate) fn system_prompt_for(app: &tauri::AppHandle, agent_id: &str) -> String {
    let personality = personality_for(app, agent_id);
    let mcp = agent_engine(app, agent_id).supports_mcp;

    let mut s = if agent_is_orchestrator(app, agent_id) {
        // Identity comes from config (so a renamed orchestrator introduces itself
        // correctly). The team roster + project map are NOT baked in here — they
        // change while a session is live, so they'd go stale and (worse) bust the
        // prompt cache. They ride each user turn instead (orchestrator_turn_context).
        let name = agent_name(app, agent_id);
        let mut s = format!("You are {name}, the orchestrator of this agent lab. {personality}");
        if mcp {
            s.push_str("\n\n");
            s.push_str(JARVIS_MECHANICS);
            s.push_str("\n\n");
            s.push_str(JARVIS_PLAYBOOK);
            s.push_str("\n\n");
            s.push_str(ASK_HUMAN_NOTE);
            s.push_str("\n\n");
            s.push_str(MESSAGE_NOTE);
            s.push_str("\n\nYour current team and the projects you can delegate into are provided \
with each of Om's messages under [CURRENT TEAM & PROJECTS] — always use that list; it supersedes \
any roster mentioned earlier in this conversation.");
        }
        s
    } else {
        let mut s = personality;
        if mcp {
            s.push_str("\n\n");
            s.push_str(ASK_HUMAN_NOTE);
            s.push_str("\n\n");
            s.push_str(MESSAGE_NOTE);
        }
        s
    };

    // Durable memory (all agents): the curation instruction + the current file.
    let mem = memory_block(app, agent_id);
    if !mem.is_empty() {
        s.push_str("\n\n");
        s.push_str(&mem);
    }
    s
}

/// Absolute path to an agent's durable memory file.
pub(crate) fn memory_file_path(app: &tauri::AppHandle, agent_id: &str) -> String {
    app.try_state::<crate::AppState>()
        .map(|s| {
            std::path::Path::new(&s.memory_dir)
                .join(format!("{agent_id}.md"))
                .to_string_lossy()
                .to_string()
        })
        .unwrap_or_default()
}

/// The memory section for a system prompt: a standing instruction to curate the
/// file, plus its current contents so the agent recalls without a read.
fn memory_block(app: &tauri::AppHandle, agent_id: &str) -> String {
    let path = memory_file_path(app, agent_id);
    if path.is_empty() {
        return String::new();
    }
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let mut s = format!(
        "You keep a durable MEMORY file at {path} (also in $STARK_MEMORY_FILE). It persists across \
sessions. When you learn something durable — a project convention, a decision, a gotcha, where \
something lives — append a tight bullet to it with your Write/Edit tools. Keep it concise and \
prune stale lines; it is your long-term memory, not a log."
    );
    if content.trim().is_empty() {
        s.push_str("\n\n[YOUR MEMORY] (empty so far)");
    } else {
        s.push_str("\n\n[YOUR MEMORY]\n");
        s.push_str(content.trim());
    }
    s
}

/// The live team + project map, prepended to each of the orchestrator's user
/// turns so routing always reflects the current roster/projects — without baking
/// volatile state into the (cache-stable) system prompt.
pub(crate) fn orchestrator_turn_context(app: &tauri::AppHandle, agent_id: &str) -> String {
    let team = team_block(app, agent_id);
    let map = project_map(app);
    if team.is_empty() && map.is_empty() {
        return String::new();
    }
    let mut s = String::from("[CURRENT TEAM & PROJECTS] (this list supersedes any earlier one)\n");
    if !team.is_empty() {
        s.push_str(&team);
    }
    if !map.is_empty() {
        s.push_str("\n\n");
        s.push_str(&map);
    }
    s
}
