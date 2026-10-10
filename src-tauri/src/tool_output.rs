//! What a tool call put out, kept with the call so the transcript can show it.
//!
//! Each engine reports a result its own way; they're all reduced to [`Output`] (text
//! and images), size-capped, and stored with the call's transcript row. Images become
//! kept files (the attachments store), never bytes in the database. Outputs can hold
//! secrets, so they stay in the local ledger and app data and are never logged.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

/// Most characters of a call's output kept; the rest is replaced by a note.
pub const TEXT_LIMIT: usize = 64 * 1024;
/// Most bytes of a call's input kept (long strings inside it are shortened to fit).
const INPUT_LIMIT: usize = 32 * 1024;
/// A string inside an input is shortened past this many characters when the input is over the limit.
const INPUT_STRING_LIMIT: usize = 2 * 1024;
/// Most calls awaiting their result at once; past this the oldest bookkeeping is dropped.
const PENDING_LIMIT: usize = 2048;
/// Most images kept per call.
const IMAGE_LIMIT: usize = 8;

/// What a finished call put out, as stored with its row.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    /// The output, shortened past [`TEXT_LIMIT`] (with a note saying so).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
    /// The text was cut short.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    /// The call failed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_error: bool,
    /// Images the call returned that weren't kept (too large for the attachments store).
    #[serde(default, skip_serializing_if = "is_zero")]
    pub images_dropped: u32,
    /// The turn ended without the call ever reporting back (parallel calls cut short).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_result: bool,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

impl ToolResult {
    /// A call the turn ended on before its result came back.
    pub fn none() -> Self {
        ToolResult { no_result: true, ..Default::default() }
    }
}

/// An image a tool returned, as the engine sent it.
#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    pub media_type: String,
    pub base64: String,
}

/// A tool's output before it's stored.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Output {
    pub text: String,
    pub images: Vec<Image>,
}

impl Output {
    pub fn text(text: impl Into<String>) -> Self {
        Output { text: text.into(), images: Vec::new() }
    }

    pub fn is_empty(&self) -> bool {
        self.text.trim().is_empty() && self.images.is_empty()
    }

    /// Claude Code's `tool_result` content: a string, or text and image blocks.
    pub fn from_claude(content: &Value) -> Self {
        match content {
            Value::String(s) => Output::text(s.clone()),
            Value::Array(blocks) => Output::from_blocks(blocks),
            _ => Output::default(),
        }
    }

    /// Text and image blocks in either Anthropic (`source.data`) or MCP (`data`, `mimeType`) form.
    pub fn from_blocks(blocks: &[Value]) -> Self {
        let mut texts = Vec::new();
        let mut images = Vec::new();
        for block in blocks {
            // ACP wraps each block: { type: "content", content: { ... } }.
            let block = if block.get("type").and_then(Value::as_str) == Some("content") { block.get("content").unwrap_or(block) } else { block };
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(Value::as_str) {
                        texts.push(t.to_string());
                    }
                }
                Some("image") => {
                    let source = block.get("source").unwrap_or(block);
                    let data = source.get("data").and_then(Value::as_str);
                    let media = source.get("media_type").or_else(|| source.get("mimeType")).or_else(|| block.get("mimeType")).and_then(Value::as_str);
                    if let (Some(data), Some(media)) = (data, media) {
                        images.push(Image { media_type: media.to_string(), base64: data.to_string() });
                    }
                }
                _ => {}
            }
        }
        Output { text: texts.join("\n"), images }
    }
}

/// `text` cut to [`TEXT_LIMIT`] characters, with a note of how much was left out.
pub fn cap_text(text: &str) -> (String, bool) {
    let total = text.chars().count();
    if total <= TEXT_LIMIT {
        return (text.to_string(), false);
    }
    let kept: String = text.chars().take(TEXT_LIMIT).collect();
    (format!("{kept}\n… output truncated ({} more characters not kept)", total - TEXT_LIMIT), true)
}

/// A call's input as JSON for storage: whole when it fits, else with long strings shortened.
pub fn cap_input(input: &Value) -> Option<String> {
    if input.is_null() {
        return None;
    }
    let whole = serde_json::to_string(input).ok()?;
    if whole.len() <= INPUT_LIMIT {
        return Some(whole);
    }
    serde_json::to_string(&shorten_strings(input)).ok()
}

fn shorten_strings(value: &Value) -> Value {
    match value {
        Value::String(s) if s.chars().count() > INPUT_STRING_LIMIT => {
            let kept: String = s.chars().take(INPUT_STRING_LIMIT).collect();
            Value::String(format!("{kept}… ({} more characters not kept)", s.chars().count() - INPUT_STRING_LIMIT))
        }
        Value::Array(items) => Value::Array(items.iter().map(shorten_strings).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), shorten_strings(v))).collect()),
        other => other.clone(),
    }
}

/// A file name for a returned image.
pub fn image_name(media_type: &str, n: usize) -> String {
    let ext = match media_type {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "png",
    };
    format!("tool-output-{}.{ext}", n + 1)
}

/// Keep the output's images as files and cap its text. Images that can't be kept are left out.
pub fn settle(root: &std::path::Path, output: &Output, is_error: bool) -> (ToolResult, Vec<crate::attachments::Attachment>) {
    let (text, truncated) = cap_text(&output.text);
    let files: Vec<_> = output
        .images
        .iter()
        .take(IMAGE_LIMIT)
        .enumerate()
        .filter_map(|(n, image)| crate::attachments::store_data(root, &image_name(&image.media_type, n), &image.base64).ok())
        .collect();
    // Every image that didn't become a file is said on the row, not dropped quietly.
    let images_dropped = (output.images.len() - files.len()) as u32;
    (ToolResult { text, truncated, is_error, images_dropped, no_result: false }, files)
}

/// A call whose result hasn't come back: which transcript row to fill in.
#[derive(Debug, Clone)]
pub struct Pending {
    pub message_id: i64,
    pub conversation: Option<i64>,
    pub agent_id: String,
    pub task_id: Option<String>,
}

static PENDING: Mutex<Option<HashMap<String, Pending>>> = Mutex::new(None);

pub fn remember(tool_use_id: &str, call: Pending) {
    let mut guard = PENDING.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    if map.len() >= PENDING_LIMIT {
        map.clear();
    }
    map.insert(tool_use_id.to_string(), call);
}

/// The call, still waiting (output may keep streaming).
pub fn pending(tool_use_id: &str) -> Option<Pending> {
    PENDING.lock().unwrap().as_ref().and_then(|m| m.get(tool_use_id).cloned())
}

/// Every call of this chat still waiting, taken: the turn ended without their results.
pub fn take_unanswered(agent_id: &str, conversation: Option<i64>) -> Vec<Pending> {
    let mut guard = PENDING.lock().unwrap();
    let Some(map) = guard.as_mut() else { return Vec::new() };
    let ids: Vec<String> = map.iter().filter(|(_, p)| p.agent_id == agent_id && p.conversation == conversation).map(|(id, _)| id.clone()).collect();
    ids.iter().filter_map(|id| map.remove(id)).collect()
}

/// The call, no longer waiting.
pub fn take(tool_use_id: &str) -> Option<Pending> {
    PENDING.lock().unwrap().as_mut().and_then(|m| m.remove(tool_use_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_result_as_string_or_blocks() {
        assert_eq!(Output::from_claude(&json!("done")).text, "done");
        let out = Output::from_claude(&json!([
            { "type": "text", "text": "a" },
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAAA" } },
            { "type": "text", "text": "b" }
        ]));
        assert_eq!(out.text, "a\nb");
        assert_eq!(out.images, vec![Image { media_type: "image/png".into(), base64: "AAAA".into() }]);
        assert!(Output::from_claude(&Value::Null).is_empty());
    }

    // Captured from `claude -p --output-format stream-json` (Claude Code, Oct 2026): a Read of a PNG
    // comes back as one image block, and a failing Bash command as an error string.
    #[test]
    fn real_claude_results_carry_the_image_and_the_error() {
        let read = json!({ "tool_use_id": "toolu_1", "type": "tool_result", "content": [
            { "type": "image", "source": { "type": "base64", "data": "iVBORw0KGgo=", "media_type": "image/png" } }
        ] });
        let out = Output::from_claude(&read["content"]);
        assert!(out.text.is_empty());
        assert_eq!(out.images, vec![Image { media_type: "image/png".into(), base64: "iVBORw0KGgo=".into() }]);
        let failed = json!({ "type": "tool_result", "content": "Exit code 1\nls: /nonexistent-dir-xyz: No such file or directory", "is_error": true, "tool_use_id": "toolu_2" });
        assert_eq!(failed["is_error"], true);
        assert!(Output::from_claude(&failed["content"]).text.starts_with("Exit code 1"));
    }

    #[test]
    fn images_that_are_not_kept_are_counted_on_the_result() {
        let root = std::env::temp_dir().join(format!("stark-settle-{}", std::process::id()));
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";
        let output = Output {
            text: String::new(),
            images: vec![Image { media_type: "image/png".into(), base64: png.into() }, Image { media_type: "image/png".into(), base64: "not base64!".into() }],
        };
        let (result, files) = settle(&root, &output, false);
        assert_eq!(files.len(), 1);
        assert_eq!(result.images_dropped, 1);
        assert!(!result.no_result);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unanswered_calls_are_taken_for_their_chat_only() {
        let call = |agent: &str, conv| Pending { message_id: 9, conversation: conv, agent_id: agent.into(), task_id: None };
        remember("u-1", call("unanswered-a", Some(7)));
        remember("u-2", call("unanswered-a", Some(7)));
        remember("u-3", call("unanswered-a", Some(8)));
        remember("u-4", call("unanswered-b", Some(7)));
        assert_eq!(take_unanswered("unanswered-a", Some(7)).len(), 2);
        assert!(pending("u-1").is_none() && pending("u-3").is_some() && pending("u-4").is_some());
        assert!(take_unanswered("unanswered-a", Some(7)).is_empty());
        take("u-3");
        take("u-4");
    }

    #[test]
    fn acp_wrapped_and_mcp_images() {
        let out = Output::from_blocks(&[
            json!({ "type": "content", "content": { "type": "text", "text": "hi" } }),
            json!({ "type": "image", "data": "BBBB", "mimeType": "image/jpeg" }),
        ]);
        assert_eq!(out.text, "hi");
        assert_eq!(out.images[0].media_type, "image/jpeg");
    }

    #[test]
    fn long_text_is_cut_with_a_note() {
        let text = "é".repeat(TEXT_LIMIT + 10);
        let (capped, truncated) = cap_text(&text);
        assert!(truncated);
        assert!(capped.contains("10 more characters"));
        assert_eq!(cap_text("short"), ("short".to_string(), false));
    }

    #[test]
    fn long_inputs_keep_their_shape() {
        let big = "x".repeat(INPUT_LIMIT + 1);
        let stored: Value = serde_json::from_str(&cap_input(&json!({ "file_path": "/a", "content": big })).unwrap()).unwrap();
        assert_eq!(stored["file_path"], "/a");
        assert!(stored["content"].as_str().unwrap().contains("more characters not kept"));
        assert_eq!(cap_input(&Value::Null), None);
    }

    #[test]
    fn pending_calls_are_taken_once() {
        remember("t-1", Pending { message_id: 4, conversation: Some(1), agent_id: "a".into(), task_id: None });
        assert_eq!(pending("t-1").map(|p| p.message_id), Some(4));
        assert_eq!(take("t-1").map(|p| p.message_id), Some(4));
        assert!(take("t-1").is_none());
    }
}
