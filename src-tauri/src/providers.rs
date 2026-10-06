//! What Starkline can do with an agent on each provider, as built: the adapter
//! that drives it, and what that adapter supports. The Agents screen compares
//! providers with this; nothing here is the provider's marketing.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Support {
    Yes,
    /// Works in part (no built-in provider is limited today, but the interface shows it).
    #[allow(dead_code)]
    Limited,
    No,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Capability {
    pub support: Support,
    /// One plain sentence on what that means here.
    pub note: String,
}

fn cap(support: Support, note: &str) -> Capability {
    Capability { support, note: note.into() }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ProviderCapabilities {
    /// claude-code | codex | opencode | generic-cli
    pub kind: String,
    pub label: String,
    /// A chat continues where it left off, even after Starkline restarts.
    pub resume: Capability,
    /// Starkline sees messages, commands, edits and plans as they happen.
    pub events: Capability,
    /// Risky calls wait for Starkline's permission gate and your approval.
    pub approvals: Capability,
    /// The provider confines the agent's commands with the operating system's sandbox.
    pub sandbox: Capability,
    /// The agent can start temporary helpers of its own.
    pub helpers: Capability,
    /// Starkline's team tools: delegate, ask you, message teammates, report bugs.
    pub team_tools: Capability,
}

pub const KINDS: [&str; 4] = ["claude-code", "codex", "opencode", "generic-cli"];

pub fn capabilities(kind: &str) -> ProviderCapabilities {
    use Support::*;
    match kind {
        "claude-code" => ProviderCapabilities {
            kind: kind.into(),
            label: "Claude Code".into(),
            resume: cap(Yes, "Chats resume from Claude Code's saved session."),
            events: cap(Yes, "Streams messages, tool calls and results."),
            approvals: cap(Yes, "A pre-tool hook sends every call through the gate first."),
            sandbox: cap(No, "Starkline doesn't turn on Claude Code's sandbox; the gate is the safeguard."),
            helpers: cap(Yes, "Claude Code subagents, on a model you can choose."),
            team_tools: cap(Yes, "Through Starkline's MCP bridge."),
        },
        "codex" => ProviderCapabilities {
            kind: kind.into(),
            label: "Codex".into(),
            resume: cap(Yes, "Chats resume from the Codex thread."),
            events: cap(Yes, "Streams messages, commands, file changes and plans."),
            approvals: cap(Yes, "Codex asks before commands and edits; the gate answers, or asks you."),
            sandbox: cap(Yes, "Commands run in Codex's workspace sandbox: writes stay in the project, with no network unless approved."),
            helpers: cap(No, "Codex doesn't start helpers in this setup."),
            team_tools: cap(Yes, "Through Starkline's MCP bridge."),
        },
        "opencode" => ProviderCapabilities {
            kind: kind.into(),
            label: "OpenCode".into(),
            resume: cap(Yes, "Chats resume from the saved OpenCode session."),
            events: cap(Yes, "Streams messages, tool calls and to-do lists over ACP."),
            approvals: cap(Yes, "OpenCode asks before commands, edits and fetches; the gate answers, or asks you."),
            sandbox: cap(No, "OpenCode runs commands without a sandbox; the gate is the safeguard."),
            helpers: cap(No, "Starkline keeps OpenCode's subagents off: their actions can't be seen or approved from here."),
            team_tools: cap(Yes, "Through Starkline's MCP bridge."),
        },
        _ => ProviderCapabilities {
            kind: kind.into(),
            label: "Other CLI".into(),
            resume: cap(No, "Starkline can't resume a chat with a generic CLI."),
            events: cap(No, "Starkline only sees what it prints."),
            approvals: cap(No, "Its calls don't pass through the gate."),
            sandbox: cap(No, "Unknown."),
            helpers: cap(No, "Unknown."),
            team_tools: cap(No, "It can't use Starkline's bridge."),
        },
    }
}

pub fn all() -> Vec<ProviderCapabilities> {
    KINDS.iter().map(|k| capabilities(k)).collect()
}

/// A model an agent can run on.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct ModelChoice {
    /// What the provider is told ("gpt-5.6-sol", "anthropic/claude-sonnet-4-5", "claude-opus-5-5").
    pub id: String,
    pub name: String,
    /// The provider's own default.
    pub default: bool,
    /// What it's for, in the provider's words ("" when it doesn't say).
    pub description: String,
    /// The effort levels it takes, lowest first; empty when it has none to choose.
    pub efforts: Vec<String>,
    /// The level it runs at when the agent doesn't choose one, where the provider says.
    pub default_effort: Option<String>,
    /// An older or less common model: offered under "More models" rather than up front.
    pub older: bool,
}

/// How many models a picker offers up front; the rest go under "More models".
pub const MAIN_MODELS: usize = 4;

/// Effort levels from least to most thinking, as providers name them. Lists are put in this
/// order whatever order a provider reports them in; unknown names go last.
const EFFORT_ORDER: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

pub fn sort_efforts(levels: &mut Vec<String>) {
    let rank = |l: &String| EFFORT_ORDER.iter().position(|o| o == l).unwrap_or(EFFORT_ORDER.len());
    levels.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.cmp(b)));
    levels.dedup();
}

/// Lists change rarely, and asking a CLI takes a moment.
const MODELS_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const LIST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Each provider's model list, by kind and CLI path, with when it was asked for.
type ModelCache = std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, Vec<ModelChoice>)>>;

fn model_cache() -> &'static ModelCache {
    static CACHE: std::sync::OnceLock<ModelCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

const EVERY_EFFORT: &[&str] = &["low", "medium", "high", "xhigh", "max"];
/// Opus 4.6 and Sonnet 4.6 came before "xhigh".
const NO_XHIGH: &[&str] = &["low", "medium", "high", "max"];

/// (full name, name, what it's for, effort levels, its own default level, older)
type ClaudeModel = (&'static str, &'static str, &'static str, &'static [&'static str], Option<&'static str>, bool);

/// Claude Code's models by full name, newest first. Claude Code has no command that lists them
/// for a subscription sign-in, so this list is kept here: add a model when it ships. The bare
/// family names at the end always mean that family's newest model.
const CLAUDE_MODELS: &[ClaudeModel] = &[
    ("claude-opus-5-5", "Opus 5.5", "The current Opus: deep, careful work", EVERY_EFFORT, Some("medium"), false),
    ("claude-fable-5-1", "Fable 5.1", "The most capable, for the hardest, longest work", EVERY_EFFORT, Some("high"), false),
    ("claude-sonnet-5-5", "Sonnet 5.5", "Fast and capable for everyday work", EVERY_EFFORT, Some("high"), false),
    ("claude-haiku-4-5", "Haiku 4.5", "The quickest, for simple tasks", &[], None, false),
    ("claude-sonnet-5", "Sonnet 5", "The previous Sonnet", EVERY_EFFORT, Some("xhigh"), true),
    ("claude-opus-5", "Opus 5", "The previous Opus", EVERY_EFFORT, Some("high"), true),
    ("claude-fable-5", "Fable 5", "The previous Fable", EVERY_EFFORT, Some("xhigh"), true),
    ("claude-opus-4-8", "Opus 4.8", "An earlier Opus", EVERY_EFFORT, Some("xhigh"), true),
    ("claude-opus-4-7", "Opus 4.7", "An earlier Opus", EVERY_EFFORT, Some("xhigh"), true),
    ("claude-opus-4-6", "Opus 4.6", "An earlier Opus", NO_XHIGH, Some("high"), true),
    ("claude-sonnet-4-6", "Sonnet 4.6", "An earlier Sonnet", NO_XHIGH, Some("high"), true),
    ("opus", "Newest Opus", "Whichever Opus is newest", EVERY_EFFORT, Some("medium"), true),
    ("fable", "Newest Fable", "Whichever Fable is newest", EVERY_EFFORT, Some("high"), true),
    ("sonnet", "Newest Sonnet", "Whichever Sonnet is newest", EVERY_EFFORT, Some("high"), true),
    ("haiku", "Newest Haiku", "Whichever Haiku is newest", &[], None, true),
];

fn claude_models() -> Vec<ModelChoice> {
    CLAUDE_MODELS
        .iter()
        .map(|(id, name, about, efforts, default_effort, older)| ModelChoice {
            id: (*id).into(),
            name: (*name).into(),
            default: false,
            description: (*about).into(),
            efforts: efforts.iter().map(|e| (*e).into()).collect(),
            default_effort: default_effort.map(Into::into),
            older: *older,
        })
        .collect()
}

/// `opencode models` prints one `provider/model` per line.
pub fn parse_opencode_models(out: &str) -> Vec<ModelChoice> {
    out.lines()
        .map(str::trim)
        .filter(|l| l.contains('/') && !l.contains(' '))
        .map(|id| ModelChoice {
            id: id.into(),
            name: id.into(),
            default: false,
            description: String::new(),
            efforts: vec![],
            default_effort: None,
            older: false,
        })
        .collect()
}

/// `opencode models --verbose` prints each `provider/model` followed by its details as JSON:
/// a name, a release date and the reasoning "variants" it takes (OpenCode's effort levels).
/// Newest releases come first; all but the first few go under "More models".
pub fn parse_opencode_verbose(out: &str) -> Vec<ModelChoice> {
    let mut blocks: Vec<(String, String)> = vec![];
    for line in out.lines() {
        let starts_block = !line.is_empty() && !line.starts_with(char::is_whitespace) && !line.starts_with('{') && !line.starts_with('}');
        if starts_block && line.contains('/') && !line.contains(' ') {
            blocks.push((line.trim().to_string(), String::new()));
        } else if let Some((_, json)) = blocks.last_mut() {
            json.push_str(line);
            json.push('\n');
        }
    }
    let mut models: Vec<(String, ModelChoice)> = blocks
        .into_iter()
        .filter_map(|(id, json)| {
            let details: serde_json::Value = serde_json::from_str(&json).ok()?;
            let name = details["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(&id).to_string();
            let mut efforts: Vec<String> = details["variants"].as_object().map(|v| v.keys().cloned().collect()).unwrap_or_default();
            sort_efforts(&mut efforts);
            let released = details["release_date"].as_str().unwrap_or("").to_string();
            Some((released, ModelChoice { id, name, default: false, description: String::new(), efforts, default_effort: None, older: false }))
        })
        .collect();
    models.sort_by(|a, b| b.0.cmp(&a.0));
    models
        .into_iter()
        .enumerate()
        .map(|(i, (_, model))| ModelChoice { older: i >= MAIN_MODELS, ..model })
        .collect()
}

fn opencode_models(program: &str) -> Result<Vec<ModelChoice>, String> {
    let mut child = std::process::Command::new(program)
        .args(["models", "--verbose"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("OpenCode couldn't start: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("OpenCode has no output stream.")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut text);
        let _ = tx.send(text);
    });
    let out = rx.recv_timeout(LIST_TIMEOUT);
    let _ = child.kill();
    let _ = child.wait();
    let text = out.map_err(|_| "OpenCode didn't list its models in time.".to_string())?;
    // An OpenCode too old for --verbose still prints the plain list.
    let detailed = parse_opencode_verbose(&text);
    Ok(if detailed.is_empty() { parse_opencode_models(&text) } else { detailed })
}

/// The models an installed provider offers right now, as it lists them itself.
pub fn models(kind: &str, program: &str) -> Result<Vec<ModelChoice>, String> {
    let key = format!("{kind}:{program}");
    if let Some((at, cached)) = model_cache().lock().unwrap().get(&key) {
        if at.elapsed() < MODELS_TTL {
            return Ok(cached.clone());
        }
    }
    let listed = match kind {
        "claude-code" => Ok(claude_models()),
        "codex" => crate::codex::list_models(program),
        "opencode" => opencode_models(program),
        _ => Ok(vec![]),
    }?;
    model_cache().lock().unwrap().insert(key, (std::time::Instant::now(), listed.clone()));
    Ok(listed)
}

/// What people call a model: its name in a provider's list ("Opus 4.6"), else its ID.
pub fn model_name(id: &str) -> String {
    if let Some((_, name, ..)) = CLAUDE_MODELS.iter().find(|m| m.0 == id) {
        return (*name).to_string();
    }
    let cache = model_cache().lock().unwrap();
    cache.values().flat_map(|(_, listed)| listed.iter()).find(|m| m.id == id).map_or_else(|| id.to_string(), |m| m.name.clone())
}

/// An effort level as said in a sentence ("extra high").
pub fn effort_words(level: &str) -> String {
    if level == "xhigh" { "extra high".to_string() } else { level.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_opencodes_model_list() {
        let out = "opencode/big-pickle\nopenai/gpt-5.4-mini\n\nsome warning text\n";
        let ids: Vec<String> = parse_opencode_models(out).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["opencode/big-pickle", "openai/gpt-5.4-mini"]);
    }

    #[test]
    fn reads_opencodes_models_with_their_effort_levels() {
        let out = "opencode/old\n{\n  \"name\": \"Old One\",\n  \"release_date\": \"2024-01-02\",\n  \"variants\": {}\n}\n\
opencode/new\n{\n  \"name\": \"New One\",\n  \"release_date\": \"2026-09-01\",\n  \"variants\": { \"max\": {}, \"low\": {}, \"xhigh\": {}, \"medium\": {} }\n}\n";
        let models = parse_opencode_verbose(out);
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["opencode/new", "opencode/old"], "newest first");
        assert_eq!(models[0].name, "New One");
        assert_eq!(models[0].efforts, vec!["low", "medium", "xhigh", "max"], "levels in order, whatever order OpenCode lists them in");
        assert!(models[1].efforts.is_empty());
        assert!(models.iter().all(|m| !m.older), "a short list is all up front");
    }

    #[test]
    fn claude_models_are_named_by_version_with_their_own_effort_levels() {
        let models = claude_models();
        let upfront: Vec<&str> = models.iter().filter(|m| !m.older).map(|m| m.name.as_str()).collect();
        assert_eq!(upfront, vec!["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5"]);
        let by_id = |id: &str| models.iter().find(|m| m.id == id).unwrap().clone();
        assert_eq!(by_id("claude-opus-5-5").default_effort.as_deref(), Some("medium"));
        assert!(by_id("claude-haiku-4-5").efforts.is_empty(), "Haiku has no effort setting");
        assert!(!by_id("claude-sonnet-4-6").efforts.contains(&"xhigh".to_string()));
        assert!(models.iter().all(|m| m.default_effort.as_ref().is_none_or(|d| m.efforts.contains(d))));
    }

    #[test]
    fn models_and_levels_are_named_as_people_say_them() {
        assert_eq!(model_name("claude-opus-4-6"), "Opus 4.6");
        assert_eq!(model_name("someone/unlisted-model"), "someone/unlisted-model");
        assert_eq!(effort_words("xhigh"), "extra high");
        assert_eq!(effort_words("max"), "max");
    }

    #[test]
    fn effort_levels_sort_from_least_to_most() {
        let mut levels: Vec<String> = ["max", "ultra", "low", "custom", "minimal", "high"].iter().map(|s| s.to_string()).collect();
        sort_efforts(&mut levels);
        assert_eq!(levels, vec!["minimal", "low", "high", "max", "ultra", "custom"]);
    }

    #[test]
    fn every_kind_is_described_and_unknown_ones_promise_nothing() {
        assert_eq!(all().len(), KINDS.len());
        let other = capabilities("something-else");
        assert_eq!(other.kind, "something-else");
        assert!([other.resume, other.events, other.approvals, other.team_tools].iter().all(|c| c.support == Support::No));
        assert_eq!(capabilities("codex").approvals.support, Support::Yes);
    }
}
