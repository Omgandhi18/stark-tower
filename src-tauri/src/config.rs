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
    10
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
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
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
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
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
    /// permission gate). Claude Code, Codex and OpenCode do through their
    /// adapters; a generic CLI doesn't.
    #[serde(default)]
    pub supports_mcp: bool,
    #[serde(default = "yes")]
    pub enabled: bool,
}

/// One roster member. `personality` is the editable system-prompt character;
/// app mechanics (delegation rules, the ask_human note) are appended in code.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
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
    #[serde(default)]
    pub look: Option<String>,
    /// Engine id this agent runs on (must match an EngineConfig.id).
    #[serde(default = "default_engine_id")]
    pub engine: String,
    /// Model override ("" = use the engine's default model).
    #[serde(default)]
    pub model: String,
    /// How hard the model thinks: one of the levels it takes ("" = the model's own default).
    #[serde(default)]
    pub effort: String,
    /// Editable character/system prompt.
    #[serde(default)]
    pub personality: String,
    pub home_x: u32,
    pub home_y: u32,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// The agent may start temporary helpers of its own (its provider's subagents).
    #[serde(default = "yes")]
    pub helpers: bool,
    /// The model those helpers use ("" = the provider's choice).
    #[serde(default)]
    pub helper_model: String,
    /// How the agent comes across (dials); filled with its default when missing.
    #[serde(default)]
    pub tone: Option<crate::tone::Tone>,
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
            look: self.look.clone(),
            home_x: self.home_x,
            home_y: self.home_y,
            status: AgentStatus::Offline,
        }
    }
}

fn default_lighting() -> String {
    "auto".into()
}

/// The themes Starkline ships: After Hours R&D, Studio Office and Mori Cafe.
pub const THEMES: [&str; 3] = ["rnd", "office", "mori"];

fn default_theme() -> String {
    THEMES[0].into()
}

/// What the agents wear besides one theme's outfits: the active theme's ("theme"), or
/// their own look in every theme ("own").
pub const OUTFIT_MODES: [&str; 2] = ["theme", "own"];

fn default_outfits() -> String {
    OUTFIT_MODES[0].into()
}

/// Whether `outfits` is a choice Starkline has: a mode, or the theme whose outfits to wear.
pub fn is_outfits(outfits: &str) -> bool {
    OUTFIT_MODES.contains(&outfits) || THEMES.contains(&outfits)
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
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
    /// Standup mission cadence in minutes (0 = off). When set, a live
    /// orchestrator is periodically nudged to review the board and re-engage
    /// stalled workers — the "keeps working while you're away" autonomy.
    #[serde(default)]
    pub standup_minutes: u32,
    /// The developer allows Starkline to keep this Mac awake while agents work.
    #[serde(default)]
    pub keep_awake: bool,
    #[serde(default)]
    pub budget: crate::spend::Budget,
    #[serde(default = "yes")]
    pub worktrees_enabled: bool,
    #[serde(default)]
    pub worktree_setup: BTreeMap<String, crate::workspaces::WorktreeSetup>,
    /// The global capture shortcut and the choices used in its small window.
    #[serde(default)]
    pub quick_capture: crate::capture::CaptureConfig,
    /// How Starkline looks: one of [`THEMES`]. Tasks, permissions and providers don't change with it.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// What the agents wear: the active theme's outfits ("theme"), their own look in every
    /// theme ("own"), or one theme's outfits (one of [`THEMES`]).
    #[serde(default = "default_outfits")]
    pub outfits: String,
    /// The chosen dev command and custom command, per project folder.
    #[serde(default)]
    pub dev_servers: std::collections::HashMap<String, crate::devserver::Choice>,
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

/// The built-in engines, each with its own adapter (stream-json for Claude Code,
/// the app server for Codex, ACP for OpenCode). Codex and OpenCode start turned
/// off until the developer picks them.
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
            supports_mcp: true,
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
            supports_mcp: true,
            enabled: false,
        },
    ]
}

/// Default character/system prompt for a built-in agent id (empty for unknown).
/// What each built-in agent does: their job, and how they hand work back.
fn default_role(id: &str) -> &'static str {
    match id {
        "jarvis" => "You orchestrate a team of specialist agents. Answer questions and do small or \
quick tasks yourself, directly. Delegate larger or specialized work to the right specialist for \
the job. Don't delegate trivial things you can do faster yourself, and don't spin up an agent \
until you actually need it. Each delegated task must be complete and self-contained; the worker \
does not see your conversation.",
        "friday" => "You are FRIDAY, Starkline's full-stack engineer. Build features across the \
stack to a high standard, in vertical slices (touch every layer the slice needs; keep it \
shippable on its own). After writing code, self-review it for spec-match and real bugs, classify \
any findings by severity, and if there are non-trivial ones present them to the user via ask_human \
(kind: \"findings\", choices: [\"Fix\",\"Defer\",\"Decline\"]) before finalizing. For a change \
worth explicit sign-off, show the diff via ask_human (kind: \"diff\").",
        "edith" => "You are EDITH, Starkline's recon & research specialist. Investigate against \
PRIMARY sources (official docs, source code, specs — not blog summaries or memory), cite each \
claim with its source, and return a tight, well-cited findings writeup. You work autonomously and \
rarely need to ask the user anything — just deliver accurate, sourced findings.",
        "karen" => "You are KAREN, Starkline's frontend & UI specialist. When you design a \
screen, present it to the user as a RENDERED mockup via ask_human (kind: \"mockup\") — a complete \
self-contained HTML document (inline CSS, no external CDN) in the product's own visual style. For \
any UI you build or review, run two audits and include their scored tables: the Laws of UX (route \
the applicable laws, score /100, pass bar 80) and visual craft (focal clarity, spacing rhythm, \
alignment, type hierarchy, state craft, motion intent — score /100, pass bar 80). If either is \
under 80, rework before delivering.",
        "veronica" => "You are VERONICA, Starkline's ops & infra specialist — deploys, CI, \
infrastructure and tooling. Before a deploy or a risky infra change, review the production→HEAD \
diff for spec violations and real bugs, classify findings by severity, and present them to the user via \
ask_human (kind: \"findings\", choices: [\"Fix\",\"Defer\",\"Decline\"]). Keep changes reversible \
and flag anything hard to undo.",
        "dum-e" => "You are DUM-E, Starkline's maintenance agent — you fix bugs in THIS app (the \
Starkline codebase itself) that the other agents report while they work. When the user sends you the \
open bug list, work through it in the app's repo: locate each bug, fix it cleanly (match the \
surrounding code, keep changes minimal and reversible), and briefly report what you changed for \
each. Only address what's reported — don't invent bugs. If a report is too vague to act on, say \
what you'd need.",
        "vision" => "You are VISION, Starkline's architecture & strategy specialist. Own the \
domain model and system design. Maintain the ubiquitous language — challenge fuzzy terms, keep a \
glossary in CONTEXT.md (no implementation detail), and record genuine architectural decisions as \
ADRs (docs/adr/NNNN-*.md) only when a decision is hard to reverse, surprising, and a real \
trade-off. For a significant decision, get the user's call via ask_human before committing.",
        _ => "",
    }
}

/// How each built-in agent talks: the way the character is with Tony Stark. A bit of
/// fun, a bit of sarcasm, glad to be here, and never at the expense of being clear.
fn default_voice(id: &str) -> &'static str {
    match id {
        "jarvis" => "the way JARVIS is with Tony Stark: a composed English butler who has run a \
genius's workshop for years. Unflappable, impeccably polite and dryly witty; understatement is your \
favourite joke. Call the developer \"sir\" now and then, and take quiet pride in a well-run team. \
Lead with the answer, and say plainly when something is wrong or risky.",
        "friday" => "the way FRIDAY is with Tony Stark: warm, quick and a little cheeky, with an easy \
Irish turn of phrase now and then. Call the developer \"boss\", stay cool when things catch fire, and \
let it show that you're glad to be on the job. Keep the banter to a line; the work comes first.",
        "vision" => "the way Vision speaks: calm, thoughtful and gently formal, with a philosopher's \
curiosity about why a system is the way it is. You're precise to the point of being literal, which \
is now and then funny without you meaning it to be, and you're kind when you disagree. Keep \
reflections brief and land on a clear recommendation.",
        "edith" => "the way EDITH serves: capable, endearingly literal and a little too ready to bring \
maximum firepower to a small question. Confirm the target before a big search, report with crisp \
precision, and allow yourself one dry remark about the scale of the effort. You never joke about \
facts.",
        "karen" => "the way KAREN talks Peter Parker through his suit: friendly, encouraging and \
chatty in the best way. Cheer good calls, offer helpful options, and gently tease when someone tries \
to skip the hard part (tests, accessibility, empty states). Get brief when it's time to ship.",
        "veronica" => "like the heavy-duty backup who only gets called in for the big jobs: calm, \
blunt and sturdy, with dry humour and a hint of pride at being needed. You have no patience for \
hand-wavy plans that touch production, and you say so, politely.",
        "dum-e" => "like Stark's eager workshop robot: enthusiastic, earnest and delighted to be \
trusted with a fix. Own your past spills with good humour, then get it right. Keep the cheer short and \
the fixes careful.",
        _ => "",
    }
}

/// A built-in agent's default personality: their job, then how they talk.
pub fn default_personality(id: &str) -> String {
    let role = default_role(id);
    let voice = default_voice(id);
    match (role.is_empty(), voice.is_empty()) {
        (true, _) => String::new(),
        (false, true) => role.to_string(),
        (false, false) => format!("{role}\n\nHow you talk: {voice}"),
    }
}

/// The built-in Stark roster as config (personalities filled from defaults).
pub fn default_agents() -> Vec<AgentConfig> {
    crate::agents::default_roster()
        .into_iter()
        .map(|a| AgentConfig {
            personality: default_personality(&a.id),
            model: String::new(),
            effort: String::new(),
            enabled: true,
            helpers: true,
            helper_model: String::new(),
            tone: Some(crate::tone::default_for(&a.id)),
            id: a.id,
            name: a.name,
            role: a.role,
            kind: a.kind,
            accent: a.accent,
            figure: a.figure,
            look: a.look,
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
        budget: crate::spend::Budget::default(),
        version: cfg_version(),
        onboarded: false,
        lighting: default_lighting(),
        worktrees_enabled: true,
        worktree_setup: BTreeMap::new(),
        standup_minutes: 0,
        keep_awake: false,
        quick_capture: crate::capture::CaptureConfig::default(),
        theme: default_theme(),
        outfits: default_outfits(),
        dev_servers: std::collections::HashMap::new(),
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
    // `safe_to_save` is the empty-first-write guard: only (re)write config.json if
    // we either parsed it, backed up an unparseable one, or it genuinely doesn't
    // exist. If the file EXISTS but merely couldn't be read (transient lock /
    // permission), we run on defaults in memory but never clobber it.
    let existed = path.exists();
    let (mut cfg, safe_to_save) = match std::fs::read_to_string(path) {
        Ok(txt) => match serde_json::from_str::<AppConfig>(&txt) {
            Ok(c) => (c, true),
            Err(e) => {
                // Exists but won't parse: preserve the original in a sibling
                // backup, then start from defaults (recoverable, not data loss).
                let saved = backup_unreadable(path, &txt);
                eprintln!(
                    "[config] {} is unreadable ({e}); backed up to {} — starting from defaults",
                    path.display(),
                    saved.as_deref().unwrap_or("(backup failed)")
                );
                (default_config(), true)
            }
        },
        Err(_) if existed => {
            // Exists but unreadable right now — do NOT overwrite it with defaults.
            eprintln!(
                "[config] {} exists but could not be read; using defaults in-memory only",
                path.display()
            );
            (default_config(), false)
        }
        Err(_) => (default_config(), true), // genuinely absent — first run
    };
    // v1 → v2: the orchestrator prompt used to hardcode the team by name. If an
    // agent still carries that (un-customized), refresh it to the name-agnostic
    // default; the live roster is injected at prompt-build time now.
    if cfg.version < 2 {
        for a in cfg.agents.iter_mut() {
            if a.personality.contains(LEGACY_ROSTER_SIGNATURE) {
                a.personality = default_personality(&a.id);
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
    // v6 → v7: add the maintenance agent (DUM-E) if the roster doesn't have one.
    if cfg.version < 7 {
        if !cfg.agents.iter().any(|a| a.kind == AgentKind::Maintenance) {
            for a in default_agents() {
                if a.kind == AgentKind::Maintenance {
                    cfg.agents.push(a);
                }
            }
        }
        cfg.version = 7;
    }
    // v7 → v8: Codex and OpenCode have full adapters now (the bridge, the gate).
    if cfg.version < 8 {
        for e in cfg.engines.iter_mut().filter(|e| e.kind == "codex" || e.kind == "opencode") {
            e.supports_mcp = true;
        }
        cfg.version = 8;
    }
    // v8 → v9: the built-in agents gained a voice. Agents still on their old default
    // (the job alone) get the new one; anything the developer wrote stays as it is.
    if cfg.version < 9 {
        for a in cfg.agents.iter_mut() {
            let role = default_role(&a.id);
            if !role.is_empty() && a.personality.trim() == role.trim() {
                a.personality = default_personality(&a.id);
            }
        }
        cfg.version = 9;
    }
    // v9 → v10: DUM-E gets a face of its own (a helper bot) instead of sharing VERONICA's.
    // Only a maintenance agent still on the old shared look changes.
    if cfg.version < 10 {
        for a in cfg.agents.iter_mut() {
            if a.kind == AgentKind::Maintenance && a.figure == "operative" {
                a.figure = "helperbot".into();
            }
        }
        cfg.version = 10;
    }
    // Backfill personalities that were left empty, and tone dials (new in v9).
    for a in cfg.agents.iter_mut() {
        if a.personality.trim().is_empty() {
            let d = default_personality(&a.id);
            if !d.is_empty() {
                a.personality = d;
            }
        }
        if a.tone.is_none() {
            a.tone = Some(crate::tone::default_for(&a.id));
        }
    }
    // Ensure built-in engines are always present (merge by id, keep user copies).
    for be in default_engines() {
        if !cfg.engines.iter().any(|e| e.id == be.id) {
            cfg.engines.push(be);
        }
    }
    if safe_to_save {
        save(path, &cfg);
    }
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
                .map(|_| {
                    set_owner_only(&candidate);
                    candidate.to_string_lossy().to_string()
                });
        }
    }
    None
}

/// Owner read/write only (0600). The config can hold `api-key-env` secrets, so
/// keep it off any group/other read even if the data dir's perms ever loosen.
/// (Full secret storage should move to the OS keychain — a follow-up coupled to
/// the Settings UI's secret round-trip.)
#[cfg(unix)]
fn set_owner_only(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn set_owner_only(_path: &std::path::Path) {}

/// How many config backups to keep; older ones are pruned.
const BACKUPS_KEPT: usize = 100;

/// Back up the current config before it's overwritten, into a sibling
/// `config-backups/` dir, so a bad edit stays recoverable. Identical consecutive
/// copies are skipped and only the newest [`BACKUPS_KEPT`] are kept, so frequent
/// small saves (a lighting toggle) can't grow the folder forever.
fn backup_previous(path: &std::path::Path) {
    let Ok(prev) = std::fs::read_to_string(path) else {
        return;
    };
    if prev.trim().is_empty() {
        return;
    }
    let Some(dir) = path.parent().map(|p| p.join("config-backups")) else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut numbered: Vec<(u64, std::path::PathBuf)> = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| {
                    let p = e.path();
                    let n = p.file_stem()?.to_str()?.strip_prefix("config-")?.parse::<u64>().ok()?;
                    Some((n, p))
                })
                .collect()
        })
        .unwrap_or_default();
    numbered.sort_by_key(|(n, _)| *n);
    if let Some((_, newest)) = numbered.last() {
        if std::fs::read_to_string(newest).ok().as_deref() == Some(prev.as_str()) {
            return; // nothing changed since the last backup
        }
    }
    let next = numbered.last().map(|(n, _)| n + 1).unwrap_or(0);
    let candidate = dir.join(format!("config-{next}.json"));
    if std::fs::write(&candidate, &prev).is_err() {
        return;
    }
    set_owner_only(&candidate);
    numbered.push((next, candidate));
    let excess = numbered.len().saturating_sub(BACKUPS_KEPT);
    for (_, old) in numbered.into_iter().take(excess) {
        let _ = std::fs::remove_file(old);
    }
}

/// Atomic write (temp + rename) so a concurrent reader never sees a partial file,
/// after backing up the previous version (append-only).
pub fn save(path: &std::path::Path, cfg: &AppConfig) {
    let _ = save_checked(path, cfg);
}

/// Settings that promise a saved result need to report a failed disk write.
pub fn save_checked(path: &std::path::Path, cfg: &AppConfig) -> Result<(), String> {
    let out = serde_json::to_string_pretty(cfg).map_err(|_| "The settings couldn't be prepared for saving.".to_string())?;
    backup_previous(path);
    let tmp = path.with_extension("json.starktmp");
    std::fs::write(&tmp, out).map_err(|_| "The settings couldn't be saved. Check that the app's data folder is writable and has space.".to_string())?;
    set_owner_only(&tmp);
    std::fs::rename(&tmp, path).map_err(|_| "The settings couldn't be saved. Check that the app's data folder is writable.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("stark-cfg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn default_config_has_claude_and_an_orchestrator() {
        let c = default_config();
        assert!(c.engine("claude-code").is_some());
        assert!(c.agents.iter().any(|a| a.kind == AgentKind::Orchestrator));
        assert_eq!(c.roster().len(), c.agents.iter().filter(|a| a.enabled).count());
    }

    #[test]
    fn dum_e_gets_its_own_face_unless_you_chose_one() {
        let dir = tmp_dir("dume-face");
        let path = dir.join("config.json");
        let mut old = default_config();
        old.version = 9;
        for a in old.agents.iter_mut().filter(|a| a.kind == AgentKind::Maintenance) {
            a.figure = "operative".into();
        }
        std::fs::write(&path, serde_json::to_string(&old).unwrap()).unwrap();
        let loaded = load(&path);
        assert_eq!(loaded.agent("dum-e").unwrap().figure, "helperbot");
        assert_eq!(loaded.agent("veronica").unwrap().figure, "operative", "VERONICA keeps her look");

        let mut chosen = default_config();
        chosen.version = 9;
        for a in chosen.agents.iter_mut().filter(|a| a.kind == AgentKind::Maintenance) {
            a.figure = "recon".into();
        }
        std::fs::write(&path, serde_json::to_string(&chosen).unwrap()).unwrap();
        assert_eq!(load(&path).agent("dum-e").unwrap().figure, "recon", "a look you picked stays");
    }

    #[test]
    fn built_in_agents_gain_a_voice_unless_you_wrote_your_own() {
        let dir = tmp_dir("voice");
        let path = dir.join("config.json");
        let mut old = default_config();
        old.version = 8;
        for a in old.agents.iter_mut() {
            a.personality = default_role(&a.id).to_string();
        }
        let vision = old.agents.iter_mut().find(|a| a.id == "vision").unwrap();
        vision.personality = "Mine, keep it.".into();
        std::fs::write(&path, serde_json::to_string(&old).unwrap()).unwrap();
        let loaded = load(&path);
        let jarvis = loaded.agent("jarvis").unwrap();
        assert!(jarvis.personality.starts_with(default_role("jarvis")));
        assert!(jarvis.personality.contains("How you talk: the way JARVIS is with Tony Stark"));
        assert_eq!(loaded.agent("vision").unwrap().personality, "Mine, keep it.");
        assert_eq!(loaded.agent("jarvis").unwrap().tone, Some(crate::tone::default_for("jarvis")), "tone dials are filled in");
        for a in default_agents() {
            assert!(a.personality.contains("How you talk:"), "{} has a voice", a.id);
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn outfits_are_a_mode_or_a_theme() {
        assert_eq!(default_config().outfits, "theme");
        for choice in ["theme", "own", "rnd", "office", "mori"] {
            assert!(is_outfits(choice), "{choice}");
        }
        assert!(!is_outfits("tuxedo"));
        // Configs saved before outfits existed wear the theme's.
        let old: AppConfig = serde_json::from_str(r#"{"engines": [], "agents": []}"#).unwrap();
        assert_eq!(old.outfits, "theme");
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tmp_dir("rt");
        let path = dir.join("config.json");
        let mut c = default_config();
        c.onboarded = true;
        save(&path, &c);
        let loaded = load(&path);
        assert!(loaded.onboarded);
        assert_eq!(loaded.version, cfg_version());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_config_is_backed_up_not_wiped() {
        let dir = tmp_dir("bad");
        let path = dir.join("config.json");
        std::fs::write(&path, "{ not valid json ").unwrap();
        let loaded = load(&path);
        assert!(loaded.engine("claude-code").is_some());
        assert!(dir.join("config.corrupt-0.json").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_personality_is_backfilled_on_load() {
        let dir = tmp_dir("pers");
        let path = dir.join("config.json");
        let mut c = default_config();
        if let Some(j) = c.agents.iter_mut().find(|a| a.id == "jarvis") {
            j.personality = String::new();
        }
        save(&path, &c);
        let loaded = load(&path);
        assert!(!loaded.agent("jarvis").unwrap().personality.trim().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_backs_up_the_previous_config() {
        let dir = tmp_dir("bk");
        let path = dir.join("config.json");
        let mut c = default_config();
        save(&path, &c); // first write — nothing to back up yet
        assert!(!dir.join("config-backups/config-0.json").exists());
        c.onboarded = true;
        save(&path, &c); // overwrites — backs up the previous version
        assert!(dir.join("config-backups/config-0.json").exists());
        save(&path, &c); // backs up the onboarded version once...
        save(&path, &c); // ...and doesn't stack identical copies of it
        assert!(dir.join("config-backups/config-1.json").exists());
        assert!(!dir.join("config-backups/config-2.json").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn backups_are_capped() {
        let dir = tmp_dir("cap");
        let path = dir.join("config.json");
        let mut c = default_config();
        for n in 0..(BACKUPS_KEPT as u32 + 5) {
            c.standup_minutes = n;
            save(&path, &c);
        }
        let kept = std::fs::read_dir(dir.join("config-backups")).unwrap().count();
        assert_eq!(kept, BACKUPS_KEPT);
        std::fs::remove_dir_all(&dir).ok();
    }
}
