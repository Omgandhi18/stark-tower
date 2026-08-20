//! Persisted, user-editable configuration for the tower: the engines agents can
//! run on (Claude Code, Codex, OpenCode, custom CLIs, …) and the roster itself
//! (names, roles, sprites, accents, personalities, which engine/model each uses).
//!
//! At startup [`load`] reads `config.json` from the app data dir; if it's absent
//! or unreadable we fall back to [`default_config`] (the built-in Stark roster)
//! and write it out so the user has something to edit. Everything the UI lets a
//! user customize lives here — the hardcoded Rust roster is only the seed.

use crate::agents::{Agent, AgentKind, AgentStatus};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

fn yes() -> bool {
    true
}
fn cfg_version() -> u32 {
    6
}

/// v4→v5: the floor became a full facility with a desk bullpen; seat the built-in
/// roster at bullpen desks (id, home_x, home_y).
const V5_DESKS: &[(&str, u32, u32)] = &[
    ("jarvis", 2, 10), ("vision", 5, 10), ("friday", 8, 10),
    ("edith", 11, 10), ("karen", 14, 10), ("veronica", 8, 13),
];

/// v3→v4: the old sprite-library ids map to procedural character presets.
const V4_FIGURE_MAP: &[(&str, &str)] = &[
    ("sentinel", "commander"),
    ("oracle", "architect"),
    ("mechanic", "engineer"),
    ("scout", "recon"),
    ("artisan", "specialist"),
    ("warden", "operative"),
];

/// v2→v3: (built-in id, sprite id, home_x, home_y). Adopts the neutral tinted
/// sprite library + the lab floor layout for the built-in roster.
const V3_ROSTER: &[(&str, &str, u32, u32)] = &[
    ("jarvis", "sentinel", 8, 6),
    ("vision", "oracle", 12, 4),
    ("friday", "mechanic", 3, 9),
    ("edith", "scout", 6, 10),
    ("karen", "artisan", 10, 9),
    ("veronica", "warden", 13, 7),
];

/// Signature of the v1 default orchestrator personality (which hardcoded the
/// team by name). The v1→v2 migration refreshes any prompt still carrying it to
/// the new name-agnostic default, since the roster is now injected live.
const LEGACY_ROSTER_SIGNATURE: &str = "Your team of worker agents:";

/// How an engine authenticates. `cli-login` = whatever the CLI is already logged
/// into on this machine; `api-key-env` = inject `env` vars (e.g. an API key) into
/// the spawned process; `none` = no auth needed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthConfig {
    #[serde(default = "default_auth_method")]
    pub method: String,
    /// Environment variables to inject into the engine process (API keys etc.).
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}
fn default_auth_method() -> String {
    "cli-login".into()
}
impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            method: default_auth_method(),
            env: BTreeMap::new(),
        }
    }
}

/// A backend an agent can run on. `kind` selects the adapter (how we build the
/// command and parse its output); `command`/`extra_args` are the concrete CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineConfig {
    pub id: String,
    pub label: String,
    /// Adapter type: "claude-code" | "codex" | "opencode" | "generic-cli".
    pub kind: String,
    pub command: String,
    #[serde(default)]
    pub extra_args: Vec<String>,
    /// Default model for this engine ("" = the engine's own default).
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub auth: AuthConfig,
    /// Whether this engine speaks our MCP bridge (delegation, ask_human, the
    /// permission gate). Only Claude Code does today; others are basic until
    /// their adapter is written.
    #[serde(default)]
    pub supports_mcp: bool,
    #[serde(default = "yes")]
    pub enabled: bool,
}

/// One roster member. `personality` is the editable system-prompt character;
/// app mechanics (delegation rules, the ask_human note) are appended in code.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub role: String,
    pub kind: AgentKind,
    #[serde(default)]
    pub accent: String,
    /// Sprite silhouette / pack ref ("masc" | "fem" | "synth" | custom id).
    #[serde(default)]
    pub figure: String,
    /// Engine id this agent runs on (must match an EngineConfig.id).
    #[serde(default = "default_engine_id")]
    pub engine: String,
    /// Model override ("" = use the engine's default model).
    #[serde(default)]
    pub model: String,
    /// Editable character/system prompt.
    #[serde(default)]
    pub personality: String,
    pub home_x: u32,
    pub home_y: u32,
    #[serde(default = "yes")]
    pub enabled: bool,
}
fn default_engine_id() -> String {
    "claude-code".into()
}

impl AgentConfig {
    /// Project to the UI/runtime `Agent` (status is layered on separately).
    pub fn to_agent(&self) -> Agent {
        Agent {
            id: self.id.clone(),
            name: self.name.clone(),
            role: self.role.clone(),
            kind: self.kind,
            engine: self.engine.clone(),
            accent: self.accent.clone(),
            figure: self.figure.clone(),
            home_x: self.home_x,
            home_y: self.home_y,
            status: AgentStatus::Offline,
        }
    }
}

fn default_lighting() -> String {
    "auto".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default = "cfg_version")]
    pub version: u32,
    /// Whether the user has completed (or skipped) the first-run setup wizard.
    #[serde(default)]
    pub onboarded: bool,
    /// Floor lighting mode: "auto" (clock) | "system" | "morning" | "day" |
    /// "evening" | "night".
    #[serde(default = "default_lighting")]
    pub lighting: String,
    pub engines: Vec<EngineConfig>,
    pub agents: Vec<AgentConfig>,
}

impl AppConfig {
    pub fn agent(&self, id: &str) -> Option<&AgentConfig> {
        self.agents.iter().find(|a| a.id == id)
    }
    pub fn engine(&self, id: &str) -> Option<&EngineConfig> {
        self.engines.iter().find(|e| e.id == id)
    }
    /// The engine an agent runs on, resolving through the agent's `engine` id.
    pub fn engine_for(&self, agent_id: &str) -> Option<&EngineConfig> {
        let eid = self.agent(agent_id).map(|a| a.engine.as_str())?;
        self.engine(eid)
    }
    /// The enabled roster as UI/runtime agents.
    pub fn roster(&self) -> Vec<Agent> {
        self.agents
            .iter()
            .filter(|a| a.enabled)
            .map(|a| a.to_agent())
            .collect()
    }
}

// ---- defaults ---------------------------------------------------------------

/// The built-in engines. Claude Code is fully wired; the others are declared
/// (so users can select and configure them) with their adapters filled in over
/// time. `supports_mcp` reflects whether delegation / ask_human work today.
pub fn default_engines() -> Vec<EngineConfig> {
    vec![
        EngineConfig {
            id: "claude-code".into(),
            label: "Claude Code".into(),
            kind: "claude-code".into(),
            command: "claude".into(),
            extra_args: vec![],
            model: String::new(),
            auth: AuthConfig {
                method: "cli-login".into(),
                env: BTreeMap::new(),
            },
            supports_mcp: true,
            enabled: true,
        },
        EngineConfig {
            id: "codex".into(),
            label: "Codex CLI".into(),
            kind: "codex".into(),
            command: "codex".into(),
            extra_args: vec![],
            model: String::new(),
            auth: AuthConfig {
                method: "cli-login".into(),
                env: BTreeMap::new(),
            },
            supports_mcp: false,
            enabled: false,
        },
        EngineConfig {
            id: "opencode".into(),
            label: "OpenCode".into(),
            kind: "opencode".into(),
            command: "opencode".into(),
            extra_args: vec![],
            model: String::new(),
            auth: AuthConfig {
                method: "cli-login".into(),
                env: BTreeMap::new(),
            },
            supports_mcp: false,
            enabled: false,
        },
    ]
}

/// Default character/system prompt for a built-in agent id (empty for unknown).
pub fn default_personality(id: &str) -> &'static str {
    match id {
        "jarvis" => "You orchestrate a team of specialist agents. Answer questions and do small or \
quick tasks yourself, directly. Delegate larger or specialized work to the right specialist for \
the job. Don't delegate trivial things you can do faster yourself, and don't spin up an agent \
until you actually need it. Each delegated task must be complete and self-contained; the worker \
does not see your conversation.",
        "friday" => "You are FRIDAY, Stark Tower's full-stack engineer. Build features across the \
stack to a high standard, in vertical slices (touch every layer the slice needs; keep it \
shippable on its own). After writing code, self-review it for spec-match and real bugs, classify \
any findings by severity, and if there are non-trivial ones present them to Om via ask_human \
(kind: \"findings\", choices: [\"Fix\",\"Defer\",\"Decline\"]) before finalizing. For a change \
worth explicit sign-off, show the diff via ask_human (kind: \"diff\").",
        "edith" => "You are EDITH, Stark Tower's recon & research specialist. Investigate against \
PRIMARY sources (official docs, source code, specs — not blog summaries or memory), cite each \
claim with its source, and return a tight, well-cited findings writeup. You work autonomously and \
rarely need to ask Om anything — just deliver accurate, sourced findings.",
        "karen" => "You are KAREN, Stark Tower's frontend & UI specialist. When you design a \
screen, present it to Om as a RENDERED mockup via ask_human (kind: \"mockup\") — a complete \
self-contained HTML document (inline CSS, no external CDN) in the product's own visual style. For \
any UI you build or review, run two audits and include their scored tables: the Laws of UX (route \
the applicable laws, score /100, pass bar 80) and visual craft (focal clarity, spacing rhythm, \
alignment, type hierarchy, state craft, motion intent — score /100, pass bar 80). If either is \
under 80, rework before delivering.",
        "veronica" => "You are VERONICA, Stark Tower's ops & infra specialist — deploys, CI, \
infrastructure and tooling. Before a deploy or a risky infra change, review the production→HEAD \
diff for spec violations and real bugs, classify findings by severity, and present them to Om via \
ask_human (kind: \"findings\", choices: [\"Fix\",\"Defer\",\"Decline\"]). Keep changes reversible \
and flag anything hard to undo.",
        "vision" => "You are VISION, Stark Tower's architecture & strategy specialist. Own the \
domain model and system design. Maintain the ubiquitous language — challenge fuzzy terms, keep a \
glossary in CONTEXT.md (no implementation detail), and record genuine architectural decisions as \
ADRs (docs/adr/NNNN-*.md) only when a decision is hard to reverse, surprising, and a real \
trade-off. For a significant decision, get Om's call via ask_human before committing.",
        _ => "",
    }
}

/// The built-in Stark roster as config (personalities filled from defaults).
pub fn default_agents() -> Vec<AgentConfig> {
    crate::agents::default_roster()
        .into_iter()
        .map(|a| AgentConfig {
            personality: default_personality(&a.id).to_string(),
            model: String::new(),
            enabled: true,
            id: a.id,
            name: a.name,
            role: a.role,
            kind: a.kind,
            accent: a.accent,
            figure: a.figure,
            engine: a.engine,
            home_x: a.home_x,
            home_y: a.home_y,
        })
        .collect()
}

/// The built-in Claude Code engine, used as a fallback when config is missing.
pub fn claude_default() -> EngineConfig {
    default_engines()
        .into_iter()
        .next()
        .expect("default_engines is non-empty")
}

pub fn default_config() -> AppConfig {
    AppConfig {
        version: cfg_version(),
        onboarded: false,
        lighting: default_lighting(),
        engines: default_engines(),
        agents: default_agents(),
    }
}

// ---- persistence ------------------------------------------------------------

/// Load the config, falling back to (and writing) defaults if absent/invalid.
/// Also backfills a couple of things so old files stay usable: an empty
/// personality gets the built-in default, and the engine list always contains
/// the built-in engines (merged by id).
pub fn load(path: &std::path::Path) -> AppConfig {
    let mut cfg = match std::fs::read_to_string(path) {
        Ok(txt) => match serde_json::from_str::<AppConfig>(&txt) {
            Ok(c) => c,
            Err(e) => {
                // The file exists but won't parse. Do NOT silently overwrite the
                // user's roster with defaults — preserve the original in a sibling
                // backup first, so a hand-edit mistake or a schema change is
                // recoverable rather than a permanent data loss.
                let saved = backup_unreadable(path, &txt);
                eprintln!(
                    "[config] {} is unreadable ({e}); backed up to {} — starting from defaults",
                    path.display(),
                    saved.as_deref().unwrap_or("(backup failed)")
                );
                default_config()
            }
        },
        Err(_) => default_config(), // genuinely absent — first run
    };
    // v1 → v2: the orchestrator prompt used to hardcode the team by name. If an
    // agent still carries that (un-customized), refresh it to the name-agnostic
    // default; the live roster is injected at prompt-build time now.
    if cfg.version < 2 {
        for a in cfg.agents.iter_mut() {
            if a.personality.contains(LEGACY_ROSTER_SIGNATURE) {
                a.personality = default_personality(&a.id).to_string();
            }
        }
        cfg.version = 2;
    }
    // v2 → v3: legacy `figure` values (masc/fem/synth) aren't sprite ids. Adopt
    // the neutral sprite library + the lab floor positions for the built-ins.
    if cfg.version < 3 {
        for &(id, sprite, hx, hy) in V3_ROSTER {
            if let Some(a) = cfg.agents.iter_mut().find(|a| a.id == id) {
                a.figure = sprite.to_string();
                a.home_x = hx;
                a.home_y = hy;
            }
        }
        cfg.version = 3;
    }
    // v3 → v4: characters are now procedural recipes; map the old sprite ids to
    // the matching character preset.
    if cfg.version < 4 {
        for a in cfg.agents.iter_mut() {
            if let Some(&(_, preset)) = V4_FIGURE_MAP.iter().find(|(old, _)| *old == a.figure) {
                a.figure = preset.to_string();
            }
        }
        cfg.version = 4;
    }
    // v4 → v5: seat the built-in roster at the new bullpen desks.
    if cfg.version < 5 {
        for &(id, hx, hy) in V5_DESKS {
            if let Some(a) = cfg.agents.iter_mut().find(|a| a.id == id) {
                a.home_x = hx;
                a.home_y = hy;
            }
        }
        cfg.version = 5;
    }
    // v5 → v6: the orchestrator commands from the reactor bay (not a bullpen desk).
    if cfg.version < 6 {
        if let Some(a) = cfg.agents.iter_mut().find(|a| a.kind == AgentKind::Orchestrator) {
            a.home_x = 4;
            a.home_y = 5;
        }
        cfg.version = 6;
    }
    // Backfill personalities that were left empty.
    for a in cfg.agents.iter_mut() {
        if a.personality.trim().is_empty() {
            let d = default_personality(&a.id);
            if !d.is_empty() {
                a.personality = d.to_string();
            }
        }
    }
    // Ensure built-in engines are always present (merge by id, keep user copies).
    for be in default_engines() {
        if !cfg.engines.iter().any(|e| e.id == be.id) {
            cfg.engines.push(be);
        }
    }
    save(path, &cfg);
    cfg
}

/// Preserve an unparseable config next to the original before it's replaced, so
/// an editing mistake or a schema change never costs the user their roster.
/// Writes to `config.corrupt-N.json` (first free N). Returns the path written.
fn backup_unreadable(path: &std::path::Path, contents: &str) -> Option<String> {
    if contents.trim().is_empty() {
        return None; // nothing worth keeping
    }
    for n in 0..1000 {
        let candidate = path.with_extension(format!("corrupt-{n}.json"));
        if !candidate.exists() {
            return std::fs::write(&candidate, contents)
                .ok()
                .map(|_| candidate.to_string_lossy().to_string());
        }
    }
    None
}

/// Atomic write (temp + rename) so a concurrent reader never sees a partial file.
pub fn save(path: &std::path::Path, cfg: &AppConfig) {
    if let Ok(out) = serde_json::to_string_pretty(cfg) {
        let tmp = path.with_extension("json.starktmp");
        if std::fs::write(&tmp, out).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}
