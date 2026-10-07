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
delegating, briefly tell the user what you dispatched and to whom, then END YOUR TURN — do not wait or \
claim you have results yet. When the workers finish you'll automatically receive their outputs as a \
`[DELEGATION RESULTS]` message; THAT is when you synthesize everything into one clear reply for the user.\n\n\
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

/// The agent's editable personality (falls back to the built-in default), then its tone dials.
fn personality_for(app: &tauri::AppHandle, agent_id: &str) -> String {
    let (personality, tone) = match app.try_state::<crate::AppState>() {
        Some(state) => {
            let cfg = state.config.lock().unwrap();
            let agent = cfg.agent(agent_id);
            let written = agent.map(|a| a.personality.clone()).filter(|p| !p.trim().is_empty());
            (written.unwrap_or_else(|| crate::config::default_personality(agent_id)), agent.and_then(|a| a.tone))
        }
        None => (crate::config::default_personality(agent_id), None),
    };
    let tone = tone.unwrap_or_else(|| crate::tone::default_for(agent_id));
    format!("{personality}\n\n{}", tone.describe())
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
pub(crate) fn agent_name(app: &tauri::AppHandle, agent_id: &str) -> String {
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

const ASK_HUMAN_NOTE: &str = "You have the `ask_human` tool — your review surface with the user. \
Use it for any sign-off, decision, findings gate, question, or to show a UI mockup \
(kind: \"mockup\", with a COMPLETE self-contained HTML document in `body` — inline CSS, no \
external CDN). It renders in the app and BLOCKS until the user decides, then returns their decision. \
Use it instead of any lavish or browser step.";

const PERMISSION_NOTE: &str = "Starkline checks every tool call against the user's policy. Work \
inside the project (reading, editing, running its build, lint and test commands) runs straight away. \
Installing or updating packages, creating or switching branches, touching files outside the project, \
database migrations, network access and unrecognised commands wait for the user's approval. Committing, \
pushing, deploying, publishing, deleting branches, discarding or stashing changes and destructive \
commands never run without them. If a call is denied, do not retry it in another form: find another \
way that stays within the policy, or explain what you need with ask_human.";

const MESSAGE_NOTE: &str = "You can also `message` a teammate directly by their agent id — a \
question, a heads-up, or a hand-off note. It's delivered to them when they're next free (no reply \
on the call). Teammates' messages to you arrive inline as [MESSAGE from …]; read and act on them. \
Use `message` to coordinate with a specialist; use `ask_human` for anything that needs the user. If you \
hit a bug or error in the Starkline APP itself (a broken tool, a crash, wrong behavior — not the \
project you're working on), file it with `report_bug` and carry on; the maintenance agent fixes \
those later.";

const SHARE_NOTE: &str = "When you make something the developer should see — an image, chart, video, \
audio, PDF, web page or document — `share` it (its path, and a short caption if it helps) and it shows \
up in the chat as a preview they can open. Save it in the project or a temporary folder first. Share \
finished results, not every file you touch. Files the developer attaches to a message are listed with \
their paths in Starkline's attachments folder; read them with your tools.";

const JARVIS_PLAYBOOK: &str = "Planning playbook (the sarathi funnel) — for a large or foggy \
request, think before delegating: (1) if the idea is foggy, open it into a few distinct \
directions and settle on one; (2) stress-test the plan by asking the user the key open decisions via \
ask_human (kind: \"questions\") and folding in their answers; (3) cut the settled plan into small \
VERTICAL slices — each shippable on its own, no forward dependencies — and get sign-off via \
ask_human; (4) delegate one slice at a time to the right specialist. Skip all this for small, \
clear tasks. Route every human checkpoint through ask_human, never a browser.";

/// Named pieces shared by the launch prompt and the context inspector.
pub(crate) struct PromptSection {
    pub key: &'static str,
    pub text: String,
}

fn assemble_sections(personality: String, name: &str, orchestrator: bool, mcp: bool, memory: String) -> Vec<PromptSection> {
    let mut sections = vec![PromptSection {
        key: "identity",
        text: if orchestrator { format!("You are {name}, the orchestrator of this agent lab. {personality}") } else { personality },
    }];
    if mcp {
        if orchestrator {
            sections.push(PromptSection { key: "delegation", text: JARVIS_MECHANICS.into() });
            sections.push(PromptSection { key: "planning", text: JARVIS_PLAYBOOK.into() });
        }
        for (key, text) in [("ask_human", ASK_HUMAN_NOTE), ("permission", PERMISSION_NOTE), ("messaging", MESSAGE_NOTE), ("sharing", SHARE_NOTE)] {
            sections.push(PromptSection { key, text: text.into() });
        }
        if orchestrator {
            sections.push(PromptSection { key: "live_state", text: "Your current team and the projects you can delegate into are provided with each of the user's messages under [CURRENT TEAM & PROJECTS] — always use that list; it supersedes any roster mentioned earlier in this conversation.".into() });
        }
    }
    if !memory.is_empty() {
        sections.push(PromptSection { key: "memory", text: memory });
    }
    sections
}

pub(crate) fn system_prompt_sections(app: &tauri::AppHandle, agent_id: &str) -> Vec<PromptSection> {
    assemble_sections(personality_for(app, agent_id), &agent_name(app, agent_id), agent_is_orchestrator(app, agent_id), agent_engine(app, agent_id).supports_mcp, memory_block(app, agent_id))
}

fn join_sections(sections: &[PromptSection]) -> String {
    sections.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join("\n\n")
}

/// The provider launch and inspector use the same pieces, including memory and tone.
pub(crate) fn system_prompt_for(app: &tauri::AppHandle, agent_id: &str) -> String {
    join_sections(&system_prompt_sections(app, agent_id))
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

/// Whether a file is in Starkline's memory folder, where each agent keeps notes for itself.
pub(crate) fn is_memory_file(app: &tauri::AppHandle, path: &std::path::Path) -> bool {
    let Some(state) = app.try_state::<crate::AppState>() else { return false };
    in_folder(path, std::path::Path::new(&state.memory_dir))
}

/// Whether `path` is inside `folder`, through any symlinks either has.
fn in_folder(path: &std::path::Path, folder: &std::path::Path) -> bool {
    let real = |p: &std::path::Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    !folder.as_os_str().is_empty() && (path.starts_with(folder) || real(path).starts_with(real(folder)))
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

/// How much of a failed worktree setup's output an agent is shown: its last lines.
const SETUP_TAIL: usize = 1_500;

/// Workspace and collaboration facts, sent with a request only when they matter: the agent
/// is in a separate worktree, or shares its folder with teammates. Empty otherwise.
pub(crate) fn workspace_context(app: &tauri::AppHandle, agent: &str, cwd: &str) -> String {
    let state = app.state::<crate::AppState>();
    let mut lines: Vec<String> = Vec::new();
    if let Some(w) = state.ledger.worktrees().into_iter().find(|w| w.path == cwd && w.removed.is_none()) {
        lines.push(format!(
            "You're working in a separate git worktree of {} at {cwd}, on branch {} (from {}). Don't switch branches. Commits are the developer's to make.",
            crate::chat::base_name(&w.project),
            w.branch,
            w.base
        ));
        // A setup that went wrong is worth knowing about; a successful one's output isn't.
        let task = crate::tasks::active_task_for(app, agent).and_then(|id| state.ledger.task(&id));
        if let Some(task) = task {
            let events = state.ledger.task_events(&task.id, 400);
            for e in events.iter().filter(|e| e.kind == "workspace" && !e.data.is_empty() && !e.summary.ends_with("finished")) {
                let start = e.data.len().saturating_sub(SETUP_TAIL);
                let start = (start..e.data.len()).find(|i| e.data.is_char_boundary(*i)).unwrap_or(e.data.len());
                lines.push(format!("{}\n{}", e.summary, &e.data[start..]));
            }
        }
    }
    if crate::claims::shared(app, cwd, agent) {
        let names: Vec<String> = crate::claims::peers(app, cwd, agent).iter().map(|id| agent_name(app, id)).collect();
        lines.push(format!(
            "You're sharing this folder with {}. Use claim_files before editing; lockfiles, migrations, generated output and shared contracts need an explicit exclusive claim. Overlapping claims are refused. Coordinate with the task owner and release_files when done. Only the task owner runs git commands that change repository state.",
            names.join(", ")
        ));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_files_are_told_apart_from_everything_else() {
        let root = std::env::temp_dir().join(format!("starkline-memory-{}", std::process::id()));
        let memory = root.join("memory");
        std::fs::create_dir_all(&memory).unwrap();
        std::fs::write(memory.join("jarvis.md"), "notes").unwrap();
        assert!(in_folder(&memory.join("jarvis.md"), &memory));
        assert!(in_folder(&memory.join("friday.md"), &memory), "another agent's, not written yet");
        assert!(!in_folder(&root.join("notes.md"), &memory));
        assert!(!in_folder(&root.join("memory-old/jarvis.md"), &memory), "a neighbour that only shares the name");
        assert!(!in_folder(&memory.join("jarvis.md"), std::path::Path::new("")), "no memory folder");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&memory, root.join("link")).unwrap();
            assert!(in_folder(&root.join("link/jarvis.md"), &memory), "reached through a link");
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn sections_are_exactly_the_launch_prompt() {
        for orchestrator in [false, true] {
            for mcp in [false, true] {
                let sections = assemble_sections("Personality and tone".into(), "FRIDAY", orchestrator, mcp, "Memory".into());
                let mut expected = if orchestrator { "You are FRIDAY, the orchestrator of this agent lab. Personality and tone".to_string() } else { "Personality and tone".to_string() };
                if mcp {
                    if orchestrator {
                        expected.push_str(&format!("\n\n{JARVIS_MECHANICS}\n\n{JARVIS_PLAYBOOK}"));
                    }
                    expected.push_str(&format!("\n\n{ASK_HUMAN_NOTE}\n\n{PERMISSION_NOTE}\n\n{MESSAGE_NOTE}\n\n{SHARE_NOTE}"));
                    if orchestrator {
                        expected.push_str("\n\nYour current team and the projects you can delegate into are provided with each of the user's messages under [CURRENT TEAM & PROJECTS] — always use that list; it supersedes any roster mentioned earlier in this conversation.");
                    }
                }
                expected.push_str("\n\nMemory");
                assert_eq!(join_sections(&sections), expected);
                assert_eq!(sections.last().unwrap().key, "memory");
                assert_eq!(sections.iter().any(|s| s.key == "permission"), mcp);
            }
        }
        assert_eq!(assemble_sections("Identity".into(), "Worker", false, false, String::new()).len(), 1);
    }
}
