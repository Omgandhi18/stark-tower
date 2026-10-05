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
    /// What the provider is told ("gpt-5.6-sol", "anthropic/claude-sonnet-4-5", "sonnet").
    pub id: String,
    pub name: String,
    /// The provider's own default.
    pub default: bool,
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

/// Claude Code takes these names for its current models.
fn claude_models() -> Vec<ModelChoice> {
    [("opus", "Opus, the most capable"), ("sonnet", "Sonnet, fast and capable"), ("haiku", "Haiku, the quickest")]
        .iter()
        .map(|(id, name)| ModelChoice { id: (*id).into(), name: (*name).into(), default: false })
        .collect()
}

/// `opencode models` prints one `provider/model` per line.
pub fn parse_opencode_models(out: &str) -> Vec<ModelChoice> {
    out.lines()
        .map(str::trim)
        .filter(|l| l.contains('/') && !l.contains(' '))
        .map(|id| ModelChoice { id: id.into(), name: id.into(), default: false })
        .collect()
}

fn opencode_models(program: &str) -> Result<Vec<ModelChoice>, String> {
    let mut child = std::process::Command::new(program)
        .arg("models")
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
    out.map(|text| parse_opencode_models(&text)).map_err(|_| "OpenCode didn't list its models in time.".into())
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
    fn every_kind_is_described_and_unknown_ones_promise_nothing() {
        assert_eq!(all().len(), KINDS.len());
        let other = capabilities("something-else");
        assert_eq!(other.kind, "something-else");
        assert!([other.resume, other.events, other.approvals, other.team_tools].iter().all(|c| c.support == Support::No));
        assert_eq!(capabilities("codex").approvals.support, Support::Yes);
    }
}
