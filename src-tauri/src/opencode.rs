//! OpenCode, driven over the Agent Client Protocol (`opencode acp`: JSON-RPC
//! over stdio). Each agent session is one OpenCode session. Starkline sets
//! OpenCode to ask before commands, edits and fetches, and the gate answers, or
//! asks the developer. OpenCode's subagents are turned off: their actions can't
//! be seen or approved from here.

use crate::chat::{self, Input, Launch, Sink, TurnUsage};
use crate::rpc::{Incoming, Rpc, METHOD_NOT_FOUND};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::Manager;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// A session waits for its MCP servers (Starkline's bridge) to start.
const SESSION_TIMEOUT: Duration = Duration::from_secs(90);
const PROTOCOL_VERSION: u64 = 1;
/// Starkline's bridge, as OpenCode knows the MCP server (its tools read `stark_<tool>`).
const BRIDGE_NAME: &str = "stark";
/// OpenCode reads a prompt that starts with "/" as one of its own commands, and
/// drops an unknown one silently. This invisible character keeps a message a message.
const NOT_A_COMMAND: char = '\u{200B}';

/// Ask before anything that changes or reaches outside the project; Starkline's
/// gate decides. Reads stay automatic (OpenCode still asks about `.env` files).
fn permissions() -> Value {
    json!({
        "edit": "ask",
        "bash": "ask",
        "webfetch": "ask",
        "websearch": "ask",
        "external_directory": "ask",
        "task": "deny",
    })
}

struct Call {
    /// The call's fields, merged across updates.
    raw: Value,
    /// Already shown in the transcript and told to the task engine.
    shown: bool,
}

#[derive(Default)]
struct Turn {
    session: Option<String>,
    /// A prompt is running; messages sent meanwhile wait their turn.
    busy: bool,
    queued: VecDeque<chat::UserTurn>,
    /// Streamed text, by message, until the message is complete.
    text: Option<(String, String)>,
    thought: Option<(String, String)>,
    /// Each tool call as streamed so far. OpenCode names the tool first and
    /// sends its details (a command, a path) in later updates.
    calls: HashMap<String, Call>,
    /// The latest thing the agent said in this turn: a delegated task's result.
    said: String,
    context_tokens: u64,
    input_tokens: u64,
    output_tokens: u64,
    /// OpenCode reports the session's total cost; a turn's is the difference.
    cost_total: Option<f64>,
    cost_before: f64,
    cost_reported: bool,
    finished: Option<mpsc::Sender<Result<String, String>>>,
}

struct OpenCode {
    app: tauri::AppHandle,
    agent_id: String,
    cwd: String,
    sink: Sink,
    rpc: Rpc,
    turn: Mutex<Turn>,
}

fn usage_tokens(usage: &Value) -> (u64, u64) {
    let token = |key| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    (token("inputTokens"), token("outputTokens"))
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// A message OpenCode won't mistake for one of its slash commands.
fn as_message(text: &str) -> String {
    if text.trim_start().starts_with('/') {
        format!("{NOT_A_COMMAND}{text}")
    } else {
        text.to_string()
    }
}

/// A local file as a `file://` URI (spaces and the like percent-encoded).
fn file_uri(path: &str) -> String {
    let mut uri = String::from("file://");
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
            uri.push(byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

/// A developer turn as ACP prompt content: the words (naming the files), images
/// inline, and other files as links OpenCode can read.
fn prompt_blocks(turn: &chat::UserTurn) -> Value {
    let mut blocks = vec![json!({ "type": "text", "text": as_message(&turn.text_with_files()) })];
    for a in &turn.attachments {
        match crate::attachments::image_data(a) {
            Some((mime, data)) => blocks.push(json!({ "type": "image", "mimeType": mime, "data": data })),
            None => blocks.push(json!({ "type": "resource_link", "uri": file_uri(&a.path), "name": a.name, "mimeType": a.mime, "size": a.size })),
        }
    }
    Value::Array(blocks)
}

/// Starkline's bridge as an ACP MCP server entry (args and env must be arrays).
fn bridge(launch: &Launch) -> Value {
    let server = chat::bridge_server(launch);
    let env: Vec<Value> = server.env.into_iter().map(|(name, value)| json!({ "name": name, "value": value })).collect();
    json!([{ "name": BRIDGE_NAME, "command": server.command, "args": server.args, "env": env }])
}

fn todos(raw: &Value) -> Option<Value> {
    let items = raw.get("todos")?.as_array()?;
    let todos: Vec<Value> = items
        .iter()
        .filter(|t| str_of(t, "status") != "cancelled")
        .map(|t| json!({ "content": str_of(t, "content"), "status": str_of(t, "status"), "activeForm": str_of(t, "content") }))
        .collect();
    Some(json!({ "todos": todos }))
}

/// An ACP tool call in Starkline's tool vocabulary (Bash, Edit, Write, Read, ...).
fn as_tool(call: &Value, cwd: &str) -> (String, Value) {
    let raw = call.get("rawInput").cloned().unwrap_or(Value::Null);
    let title = str_of(call, "title");
    let located = call.pointer("/locations/0/path").and_then(Value::as_str);
    let path = located.or_else(|| raw.get("filePath").and_then(Value::as_str)).or_else(|| raw.get("path").and_then(Value::as_str)).unwrap_or("");
    let path = if path.is_empty() || std::path::Path::new(path).is_absolute() {
        path.to_string()
    } else {
        std::path::Path::new(cwd).join(path).to_string_lossy().to_string()
    };
    let text = |key: &str, fallback: &str| raw.get(key).and_then(Value::as_str).unwrap_or(fallback).to_string();
    // A shell call's title is its command, once OpenCode knows it (before that, the tool's name).
    let command_title = if matches!(title, "bash" | "shell") { "" } else { title };
    match str_of(call, "kind") {
        "execute" => ("Bash".into(), json!({ "command": text("command", command_title) })),
        "edit" if raw.get("content").is_some() && raw.get("oldString").is_none() => ("Write".into(), json!({ "file_path": path })),
        "edit" | "delete" | "move" => ("Edit".into(), json!({ "file_path": path })),
        "read" => ("Read".into(), json!({ "file_path": path })),
        "search" => ("Grep".into(), json!({ "pattern": text("pattern", title) })),
        "fetch" => ("WebFetch".into(), json!({ "url": text("url", title) })),
        "think" => ("Task".into(), json!({ "description": text("description", title) })),
        _ => match todos(&raw) {
            Some(list) => ("TodoWrite".into(), list),
            // Starkline's own tools arrive as `stark_<tool>`.
            None => (title.strip_prefix(&format!("{BRIDGE_NAME}_")).unwrap_or(title).to_string(), raw),
        },
    }
}

/// OpenCode's error text, readable, with what to do about sign-in trouble.
fn readable(message: &str) -> String {
    let message = message.strip_prefix("Internal error: ").unwrap_or(message).trim();
    let signed_out = ["Authentication required", "Token refresh failed", "401"].iter().any(|s| message.contains(s));
    if signed_out {
        "OpenCode isn't signed in to this model's provider, or its sign-in expired. Run `opencode auth login` in Terminal, or choose another model on Agents, under Provider.".into()
    } else if message.contains("model not found") {
        format!("{message}. Choose another model on Agents, under Provider.")
    } else {
        message.to_string()
    }
}

/// Whether a mapped call says what it does yet: a command, or a file.
fn described(tool: &str, input: &Value) -> bool {
    let filled = |key: &str| input.get(key).and_then(Value::as_str).is_some_and(|v| !v.trim().is_empty());
    match tool {
        "Bash" => filled("command"),
        "Edit" | "Write" | "Read" => filled("file_path"),
        _ => true,
    }
}

/// Fold an update into what's known about a call (fields it doesn't carry stay as they were).
fn merge(into: &mut Value, update: &Value) {
    for key in ["title", "kind", "rawInput", "locations"] {
        if let Some(v) = update.get(key).filter(|v| !v.is_null()) {
            into[key] = v.clone();
        }
    }
}

/// Whether a finished tool call failed: its status, or a shell command's exit code.
fn call_failed(update: &Value) -> bool {
    str_of(update, "status") == "failed" || update.pointer("/rawOutput/metadata/exit").and_then(Value::as_i64).is_some_and(|code| code != 0)
}

impl OpenCode {
    fn handle(self: &Arc<Self>, incoming: Incoming) {
        match incoming {
            Incoming::Notification { method, params } if method == "session/update" => self.updated(&params),
            Incoming::Notification { .. } => {}
            Incoming::Request { id, method, params } => self.answer(id, method, params),
        }
    }

    /// Say what's been streamed so far: a finished message, or thought.
    fn flush(&self, turn: &mut Turn) {
        let (app, sink, agent) = (&self.app, &self.sink, self.agent_id.as_str());
        if let Some((_, text)) = turn.thought.take() {
            chat::thought(app, sink, agent, &text);
        }
        if let Some((_, text)) = turn.text.take() {
            chat::said(app, sink, agent, &text);
            if !text.trim().is_empty() {
                turn.said = text;
            }
        }
    }

    fn updated(&self, params: &Value) {
        let mut turn = self.turn.lock().unwrap();
        if turn.session.as_deref() != Some(str_of(params, "sessionId")) {
            return;
        }
        let update = params.get("update").cloned().unwrap_or(Value::Null);
        let (app, sink, agent) = (self.app.clone(), self.sink.clone(), self.agent_id.clone());
        match str_of(&update, "sessionUpdate") {
            kind @ ("agent_message_chunk" | "agent_thought_chunk") => {
                let message = str_of(&update, "messageId").to_string();
                let delta = update.pointer("/content/text").and_then(Value::as_str).unwrap_or("");
                let thinking = kind == "agent_thought_chunk";
                let slot = if thinking { &turn.thought } else { &turn.text };
                if slot.as_ref().is_some_and(|(id, _)| *id != message) {
                    self.flush(&mut turn);
                }
                let slot = if thinking { &mut turn.thought } else { &mut turn.text };
                slot.get_or_insert_with(|| (message, String::new())).1.push_str(delta);
                crate::pty::emit_status(&app, &agent, crate::agents::AgentStatus::Working);
            }
            "tool_call" => {
                self.flush(&mut turn);
                let id = str_of(&update, "toolCallId").to_string();
                let (tool, input) = as_tool(&update, &self.cwd);
                let shown = described(&tool, &input);
                turn.calls.insert(id.clone(), Call { raw: update.clone(), shown });
                drop(turn);
                if shown {
                    chat::tool_called(&app, &sink, &agent, &id, &tool, &input);
                }
            }
            "tool_call_update" => {
                let id = str_of(&update, "toolCallId").to_string();
                let status = str_of(&update, "status");
                let finished = status == "completed" || status == "failed";
                let Some(call) = turn.calls.get_mut(&id) else { return };
                merge(&mut call.raw, &update);
                let (tool, input) = as_tool(&call.raw, &self.cwd);
                // Shown once its details arrive, or when it ends without them.
                let show = !call.shown && (described(&tool, &input) || finished);
                call.shown |= show;
                if finished {
                    turn.calls.remove(&id);
                }
                drop(turn);
                if show {
                    chat::tool_called(&app, &sink, &agent, &id, &tool, &input);
                }
                if finished {
                    chat::tool_returned(&app, &id, call_failed(&update));
                }
            }
            "usage_update" => {
                turn.context_tokens = update.get("used").and_then(Value::as_u64).unwrap_or(turn.context_tokens);
                turn.input_tokens = update.get("inputTokens").and_then(Value::as_u64).unwrap_or(turn.input_tokens);
                turn.output_tokens = update.get("outputTokens").and_then(Value::as_u64).unwrap_or(turn.output_tokens);
                if let Some(total) = update.pointer("/cost/amount").and_then(Value::as_f64) {
                    turn.cost_total = Some(total);
                    turn.cost_reported = true;
                }
            }
            _ => {}
        }
    }

    /// OpenCode asks before acting; each answer may wait on the developer.
    fn answer(self: &Arc<Self>, id: Value, method: String, params: Value) {
        match method.as_str() {
            "session/request_permission" => {
                let me = self.clone();
                std::thread::spawn(move || {
                    // The request describes the call itself; what was streamed fills any gaps.
                    let call = params.get("toolCall").cloned().unwrap_or(Value::Null);
                    let own = as_tool(&call, &me.cwd);
                    let streamed = me.turn.lock().unwrap().calls.get(str_of(&call, "toolCallId")).map(|c| as_tool(&c.raw, &me.cwd));
                    let (tool, input) = match streamed {
                        Some(streamed) if !described(&own.0, &own.1) => streamed,
                        _ => own,
                    };
                    let allowed = crate::bridge::decide(&me.app, &me.agent_id, &tool, &input).approved;
                    // Never "always": standing permissions are Starkline's rules, not OpenCode's.
                    let option = if allowed { "once" } else { "reject" };
                    let _ = me.rpc.respond(&id, json!({ "outcome": { "outcome": "selected", "optionId": option } }));
                });
            }
            // OpenCode writes the file itself and tells the client; nothing to do here.
            "fs/write_text_file" => {
                let _ = self.rpc.respond(&id, json!({}));
            }
            _ => {
                let _ = self.rpc.respond_error(&id, METHOD_NOT_FOUND, "Starkline doesn't handle this request.");
            }
        }
    }

    /// Start a prompt, or queue the message while one runs.
    fn send(self: &Arc<Self>, message: &chat::UserTurn) -> Result<(), String> {
        let session = {
            let mut turn = self.turn.lock().unwrap();
            let session = turn.session.clone().ok_or("OpenCode has no session open.")?;
            if turn.busy {
                turn.queued.push_back(message.clone());
                return Ok(());
            }
            turn.busy = true;
            turn.said.clear();
            turn.cost_before = turn.cost_total.unwrap_or(0.0);
            turn.cost_reported = false;
            turn.input_tokens = 0;
            turn.output_tokens = 0;
            turn.context_tokens = 0;
            session
        };
        let me = self.clone();
        let params = json!({ "sessionId": session, "prompt": prompt_blocks(message) });
        let sent = self.rpc.request_then("session/prompt", params, move |reply| me.prompt_ended(reply));
        if sent.is_err() {
            self.turn.lock().unwrap().busy = false;
        }
        sent
    }

    /// The prompt came back: the turn is over (or failed). The next queued message goes.
    fn prompt_ended(self: &Arc<Self>, reply: crate::rpc::Reply) {
        let (app, sink, agent) = (&self.app, &self.sink, self.agent_id.as_str());
        let (said, usage, waiter, next) = {
            let mut turn = self.turn.lock().unwrap();
            self.flush(&mut turn);
            turn.busy = false;
            let context = match &reply {
                Ok(r) => r.pointer("/usage/totalTokens").and_then(Value::as_u64).filter(|_| turn.context_tokens == 0).unwrap_or(turn.context_tokens),
                Err(_) => turn.context_tokens,
            };
            if let Ok(response) = &reply {
                if let Some(usage) = response.get("usage") {
                    let (input, output) = usage_tokens(usage);
                    turn.input_tokens = input;
                    turn.output_tokens = output;
                }
            }
            let running_total = turn.cost_total.filter(|_| turn.cost_reported);
            let cost = running_total.map(|total| crate::spend::cost_delta(total, turn.cost_before));
            (std::mem::take(&mut turn.said), TurnUsage { cost_usd: cost, context_tokens: context, input_tokens: turn.input_tokens, output_tokens: turn.output_tokens, running_total }, turn.finished.take(), turn.queued.pop_front())
        };
        let failure = reply.err().map(|e| readable(&e.message));
        if let Some(message) = &failure {
            chat::failed(app, sink, agent, message);
        }
        let mut sink = sink.clone();
        if let Some(session) = &mut sink.usage_session { session.session_id = self.turn.lock().unwrap().session.clone(); }
        chat::turn_finished(app, &sink, agent, (!said.is_empty()).then(|| said.clone()), usage);
        if let Some(waiter) = waiter {
            let _ = waiter.send(match failure {
                Some(message) if said.is_empty() => Err(message),
                _ => Ok(said),
            });
        }
        if let Some(next) = next {
            if let Err(e) = self.send(&next) {
                chat::failed(app, &sink, agent, &e);
            }
        }
    }
}

const INLINE_CONFIG: &str = "OPENCODE_CONFIG_CONTENT";

/// An inline OpenCode config that adds `file` to its instructions, keeping whatever inline
/// config was already set. OpenCode adds an inline config's instructions to the developer's
/// own (their opencode.json and the project's AGENTS.md), so nothing of theirs is replaced.
fn with_instructions(existing: Option<&str>, file: &std::path::Path) -> String {
    let mut config = existing.and_then(|s| serde_json::from_str::<Value>(s).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    let path = Value::String(file.to_string_lossy().into());
    match config.get_mut("instructions").and_then(Value::as_array_mut) {
        Some(list) if list.contains(&path) => {}
        Some(list) => list.push(path),
        None => config["instructions"] = json!([path]),
    }
    config.to_string()
}

/// ACP has no system prompt, so Starkline's instructions for the agent (who they are, their
/// memory, how Starkline's tools work) go in a file OpenCode reads as instructions. It's
/// rewritten at every launch, so it carries the agent's current memory and tone.
fn pass_instructions(app: &tauri::AppHandle, cmd: &mut Command, launch: &Launch) -> Result<(), String> {
    if launch.system_prompt.trim().is_empty() {
        return Ok(());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("opencode");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name: String = launch.agent_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    let file = dir.join(format!("{name}.md"));
    std::fs::write(&file, &launch.system_prompt).map_err(|e| e.to_string())?;
    // An inline config from the engine's settings wins over one inherited from Starkline's environment.
    let set_here = cmd.get_envs().find(|(k, _)| *k == INLINE_CONFIG).and_then(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()));
    let existing = set_here.or_else(|| std::env::var(INLINE_CONFIG).ok());
    cmd.env(INLINE_CONFIG, with_instructions(existing.as_deref(), &file));
    Ok(())
}

/// Spawn `opencode acp`, read it on its own thread, and shake hands.
fn connect(app: &tauri::AppHandle, launch: &Launch, sink: Sink, gen: Option<u64>) -> Result<(Child, Arc<OpenCode>), String> {
    let mut cmd = Command::new(&launch.program);
    cmd.arg("acp").current_dir(&launch.cwd);
    chat::provider_env(&mut cmd, launch);
    cmd.env("OPENCODE_PERMISSION", permissions().to_string());
    cmd.env("OPENCODE_DISABLE_AUTOUPDATE", "1");
    pass_instructions(app, &mut cmd, launch).map_err(|e| format!("Starkline couldn't write this agent's instructions for OpenCode: {e}"))?;
    chat::detach(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("OpenCode couldn't start: {e}"))?;
    let stdin = child.stdin.take().ok_or("OpenCode has no input stream.")?;
    let stdout = child.stdout.take().ok_or("OpenCode has no output stream.")?;
    if let Some(stderr) = child.stderr.take() {
        // OpenCode logs to a file; whatever reaches stderr is read so the pipe never fills.
        std::thread::spawn(move || for _ in BufReader::new(stderr).lines().map_while(Result::ok) {});
    }
    let opencode = Arc::new(OpenCode {
        app: app.clone(),
        agent_id: launch.agent_id.clone(),
        cwd: launch.cwd.clone(),
        sink: sink.launched(launch),
        rpc: Rpc::new(stdin),
        turn: Mutex::new(Turn::default()),
    });
    {
        let opencode = opencode.clone();
        let orchestrator = launch.orchestrator;
        std::thread::spawn(move || {
            crate::rpc::pump(stdout, &opencode.rpc, |incoming| opencode.handle(incoming));
            if let Some(waiter) = opencode.turn.lock().unwrap().finished.take() {
                let _ = waiter.send(Err("OpenCode stopped before it finished.".into()));
            }
            if let Some(gen) = gen {
                chat::session_finished(&opencode.app, &opencode.agent_id, gen, false, orchestrator);
            }
        });
    }
    let handshake = opencode.rpc.request(
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
            "clientInfo": { "name": "starkline", "title": "Starkline", "version": env!("CARGO_PKG_VERSION") },
        }),
        HANDSHAKE_TIMEOUT,
    );
    if let Err(e) = handshake {
        crate::proc::kill_tree(child.id());
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("OpenCode didn't answer: {e}"));
    }
    Ok((child, opencode))
}

/// Open the session (resuming the saved one when it still exists) on the agent's model.
fn open_session(opencode: &OpenCode, launch: &Launch) -> Result<String, String> {
    let rpc = &opencode.rpc;
    let mut session = None;
    if let Some(saved) = &launch.resume {
        let params = json!({ "sessionId": saved, "cwd": launch.cwd, "mcpServers": bridge(launch) });
        match rpc.request("session/resume", params, SESSION_TIMEOUT) {
            Ok(_) => session = Some(saved.clone()),
            Err(_) => chat::note_in(&opencode.app, &opencode.sink, &opencode.agent_id, "The previous OpenCode session couldn't be continued, so this chat started a new one."),
        }
    }
    let session = match session {
        Some(id) => id,
        None => {
            let reply = rpc.request("session/new", json!({ "cwd": launch.cwd, "mcpServers": bridge(launch) }), SESSION_TIMEOUT)?;
            reply.get("sessionId").and_then(Value::as_str).map(str::to_string).ok_or("OpenCode didn't open a session.")?
        }
    };
    opencode.turn.lock().unwrap().session = Some(session.clone());
    let model = launch.model.trim();
    if !model.is_empty() {
        let params = json!({ "sessionId": session, "configId": "model", "value": model });
        if let Err(e) = rpc.request("session/set_config_option", params, HANDSHAKE_TIMEOUT) {
            let note = format!("OpenCode couldn't switch to {model} ({e}), so it's using its default model.");
            chat::note_in(&opencode.app, &opencode.sink, &opencode.agent_id, &note);
        }
    }
    // OpenCode offers an "effort" option (its reasoning variants) for models that have levels.
    // A resumed session keeps the level it had, so "default" is set back explicitly too.
    let effort = launch.effort.trim();
    let params = json!({ "sessionId": session, "configId": "effort", "value": if effort.is_empty() { "default" } else { effort } });
    if let Err(e) = rpc.request("session/set_config_option", params, HANDSHAKE_TIMEOUT) {
        if !effort.is_empty() {
            let note = format!("OpenCode couldn't set {effort} effort ({e}), so the model runs at its own.");
            chat::note_in(&opencode.app, &opencode.sink, &opencode.agent_id, &note);
        }
    }
    Ok(session)
}

fn stop(child: &mut Child) {
    crate::proc::kill_tree(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

/// An agent's chat session on OpenCode.
pub(crate) fn start_chat(app: &tauri::AppHandle, launch: &Launch, gen: u64) -> Result<(Child, Input), String> {
    let (mut child, opencode) = connect(app, launch, Sink::chat(), Some(gen))?;
    let session = match open_session(&opencode, launch) {
        Ok(session) => session,
        Err(e) => {
            stop(&mut child);
            return Err(e);
        }
    };
    chat::session_ready(app, &launch.agent_id, &opencode.sink, Some(&session), Some(launch.cwd.clone()));
    Ok((child, Input::Turns(Box::new(move |turn| opencode.send(turn)))))
}

/// A delegated task on OpenCode: one prompt in a session of its own, and its final answer.
pub(crate) fn run_once(app: &tauri::AppHandle, launch: &Launch, task: &str, sink: &Sink) -> Result<String, String> {
    let (mut child, opencode) = connect(app, launch, sink.clone(), None)?;
    let pid = child.id();
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.oneshot_pids.lock().unwrap().insert(pid);
    }
    let outcome = (|| {
        open_session(&opencode, launch)?;
        let (tx, rx) = mpsc::channel();
        opencode.turn.lock().unwrap().finished = Some(tx);
        chat::session_ready(app, &launch.agent_id, sink, None, Some(launch.cwd.clone()));
        opencode.send(&chat::UserTurn::plain(task))?;
        rx.recv().unwrap_or_else(|_| Err("OpenCode stopped before it finished.".into()))
    })();
    stop(&mut child);
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.oneshot_pids.lock().unwrap().remove(&pid);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_usage_keeps_the_reported_input_and_output_counts() {
        assert_eq!(usage_tokens(&json!({ "inputTokens": 100, "outputTokens": 20, "cachedReadTokens": 30, "cachedWriteTokens": 10 })), (100, 20));
        assert_eq!(usage_tokens(&json!({})), (0, 0));
    }

    #[test]
    fn messages_that_look_like_commands_stay_messages() {
        assert_eq!(as_message("Fix the bug"), "Fix the bug");
        let guarded = as_message("/Users/dev/app is the folder");
        assert!(guarded.starts_with(NOT_A_COMMAND) && guarded.ends_with("/Users/dev/app is the folder"));
    }

    #[test]
    fn tool_calls_read_in_starklines_vocabulary() {
        let cwd = "/w/app";
        let bash = json!({ "kind": "execute", "title": "npm test", "rawInput": { "command": "npm test", "description": "Run tests" } });
        assert_eq!(as_tool(&bash, cwd), ("Bash".into(), json!({ "command": "npm test" })));
        let write = json!({ "kind": "edit", "title": "write", "locations": [{ "path": "src/new.ts" }], "rawInput": { "filePath": "src/new.ts", "content": "x" } });
        assert_eq!(as_tool(&write, cwd), ("Write".into(), json!({ "file_path": "/w/app/src/new.ts" })));
        let edit = json!({ "kind": "edit", "rawInput": { "filePath": "/w/app/a.ts", "oldString": "a", "newString": "b" } });
        assert_eq!(as_tool(&edit, cwd).0, "Edit");
        let todo = json!({ "kind": "other", "title": "todowrite", "rawInput": { "todos": [
            { "content": "Read", "status": "completed", "priority": "high" },
            { "content": "Dropped", "status": "cancelled", "priority": "low" },
        ] } });
        let (tool, input) = as_tool(&todo, cwd);
        assert_eq!(tool, "TodoWrite");
        assert_eq!(crate::tasks::plan_from(&input).unwrap().len(), 1, "cancelled steps aren't part of the plan");
        let bridge_tool = json!({ "kind": "other", "title": "stark_delegate", "rawInput": { "agent": "friday", "task": "x" } });
        assert_eq!(as_tool(&bridge_tool, cwd).0, "delegate");
    }

    #[test]
    fn a_call_is_shown_once_opencode_says_what_it_runs() {
        let cwd = "/w/app";
        // As streamed live: the tool's name first, the command in a later update.
        let mut call = json!({ "toolCallId": "c1", "kind": "execute", "title": "bash", "status": "pending", "rawInput": {} });
        let (tool, input) = as_tool(&call, cwd);
        assert_eq!(tool, "Bash");
        assert!(!described(&tool, &input), "\"bash\" is the tool, not the command");
        merge(&mut call, &json!({ "toolCallId": "c1", "status": "in_progress", "title": "npm test", "rawInput": { "command": "npm test" } }));
        let (tool, input) = as_tool(&call, cwd);
        assert!(described(&tool, &input));
        assert_eq!(input["command"], "npm test");
        merge(&mut call, &json!({ "toolCallId": "c1", "status": "completed", "rawInput": null }));
        assert_eq!(call["rawInput"]["command"], "npm test", "an update without details keeps the ones known");
    }

    #[test]
    fn errors_read_plainly() {
        assert!(readable("Internal error: Token refresh failed: 401").contains("opencode auth login"));
        assert!(readable("Authentication required: provider authentication required").contains("opencode auth login"));
        assert_eq!(readable("Internal error: Insufficient balance or no resource package. Please recharge."), "Insufficient balance or no resource package. Please recharge.");
    }

    #[test]
    fn a_shell_command_that_exits_badly_failed() {
        assert!(call_failed(&json!({ "status": "failed" })));
        assert!(call_failed(&json!({ "status": "completed", "rawOutput": { "metadata": { "exit": 1 } } })));
        assert!(!call_failed(&json!({ "status": "completed", "rawOutput": { "metadata": { "exit": 0 } } })));
        assert!(!call_failed(&json!({ "status": "completed" })));
    }

    #[test]
    fn instructions_join_any_inline_config_without_replacing_it() {
        let file = std::path::Path::new("/data/opencode/friday.md");
        let fresh: Value = serde_json::from_str(&with_instructions(None, file)).unwrap();
        assert_eq!(fresh, json!({ "instructions": ["/data/opencode/friday.md"] }));
        let theirs = r#"{"model":"anthropic/claude","instructions":["docs/rules.md"]}"#;
        let merged: Value = serde_json::from_str(&with_instructions(Some(theirs), file)).unwrap();
        assert_eq!(merged, json!({ "model": "anthropic/claude", "instructions": ["docs/rules.md", "/data/opencode/friday.md"] }));
        // Launching twice doesn't list the file twice, and unreadable config is set aside.
        let again: Value = serde_json::from_str(&with_instructions(Some(&merged.to_string()), file)).unwrap();
        assert_eq!(again["instructions"].as_array().unwrap().len(), 2);
        let broken: Value = serde_json::from_str(&with_instructions(Some("not json"), file)).unwrap();
        assert_eq!(broken, fresh);
    }

    /// Talks to the real OpenCode with this Mac's sign-in, in a throwaway git folder:
    /// `STARK_SMOKE_DIR=/tmp/x cargo test live_opencode -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_opencode_runs_a_prompt_and_asks_before_a_command() {
        use std::time::Instant;
        let dir = std::env::var("STARK_SMOKE_DIR").expect("set STARK_SMOKE_DIR to a throwaway git folder");
        let launch = crate::codex::tests::smoke_launch("opencode", &dir);
        let mut child = Command::new(&launch.program)
            .arg("acp")
            .current_dir(&dir)
            .env("OPENCODE_PERMISSION", permissions().to_string())
            .env("OPENCODE_DISABLE_AUTOUPDATE", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let rpc = Arc::new(Rpc::new(child.stdin.take().unwrap()));
        let (tx, rx) = mpsc::channel::<Incoming>();
        let stdout = child.stdout.take().unwrap();
        {
            let rpc = rpc.clone();
            std::thread::spawn(move || crate::rpc::pump(stdout, &rpc, |i| drop(tx.send(i))));
        }
        let init = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
            "clientInfo": { "name": "starkline", "title": "Starkline", "version": "smoke" },
        });
        println!("initialize: {}", rpc.request("initialize", init, HANDSHAKE_TIMEOUT).unwrap());
        let session = rpc.request("session/new", json!({ "cwd": dir, "mcpServers": bridge(&launch) }), SESSION_TIMEOUT).unwrap();
        let session_id = session["sessionId"].as_str().unwrap().to_string();
        let model = session["configOptions"].as_array().and_then(|o| o.iter().find(|c| c["id"] == "model")).map(|c| c["currentValue"].clone());
        println!("session: {session_id} on {model:?}");
        if let Some(options) = session["configOptions"].as_array().and_then(|o| o.iter().find(|c| c["id"] == "model")) {
            let ids: Vec<&str> = options["options"].as_array().map(|o| o.iter().filter_map(|m| m["value"].as_str()).collect()).unwrap_or_default();
            println!("models offered ({}): {:?}", ids.len(), ids.iter().filter(|m| m.starts_with("opencode/") || m.contains("free")).collect::<Vec<_>>());
        }
        if let Ok(chosen) = std::env::var("STARK_SMOKE_MODEL") {
            let set = json!({ "sessionId": session_id, "configId": "model", "value": chosen });
            println!("switched model: {}", rpc.request("session/set_config_option", set, HANDSHAKE_TIMEOUT).map(|_| chosen).unwrap_or_else(|e| e));
        }
        let (done_tx, done_rx) = mpsc::channel();
        let prompt = "Run the shell command `node -e \"console.log('starkline-' + 'smoke')\"` and reply with only its output.";
        rpc.request_then("session/prompt", json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": as_message(prompt) }] }), move |r| {
            let _ = done_tx.send(r);
        })
        .unwrap();

        let deadline = Instant::now() + Duration::from_secs(240);
        let (mut asked, mut ran, mut said, mut stop) = (0, false, String::new(), String::new());
        let mut tools: HashMap<String, (String, Value)> = HashMap::new();
        while Instant::now() < deadline {
            if let Ok(reply) = done_rx.try_recv() {
                let reply = reply.expect("the prompt succeeded");
                println!("prompt ended: {reply}");
                stop = reply["stopReason"].as_str().unwrap_or("").to_string();
                break;
            }
            let Ok(incoming) = rx.recv_timeout(Duration::from_millis(200)) else { continue };
            match incoming {
                Incoming::Request { id, method, params } => {
                    println!("asked: {method} {}", params["toolCall"]);
                    if method == "session/request_permission" {
                        asked += 1;
                        let (tool, input) = as_tool(&params["toolCall"], &dir);
                        println!("  as Starkline sees it: {tool} {input}");
                        rpc.respond(&id, json!({ "outcome": { "outcome": "selected", "optionId": "once" } })).unwrap();
                    } else {
                        rpc.respond(&id, json!({})).unwrap();
                    }
                }
                Incoming::Notification { params, .. } => {
                    let update = &params["update"];
                    match update["sessionUpdate"].as_str().unwrap_or("") {
                        "agent_message_chunk" => said.push_str(update["content"]["text"].as_str().unwrap_or("")),
                        "tool_call" => {
                            let mapped = as_tool(update, &dir);
                            println!("tool_call {} {} -> {} {}", update["kind"], update["title"], mapped.0, mapped.1);
                            tools.insert(update["toolCallId"].as_str().unwrap_or("").to_string(), mapped);
                        }
                        "tool_call_update" if update["status"] == "completed" || update["status"] == "failed" => {
                            let tool = tools.get(update["toolCallId"].as_str().unwrap_or("")).map(|t| t.0.clone()).unwrap_or_default();
                            println!("tool done: {tool} failed={} meta={}", call_failed(update), update.pointer("/rawOutput/metadata").unwrap_or(&Value::Null));
                            if tool == "Bash" {
                                ran = !call_failed(update);
                            }
                        }
                        "usage_update" => println!("usage: {update}"),
                        other => println!("update: {other}"),
                    }
                }
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(stop, "end_turn");
        assert!(asked >= 1, "OpenCode asked before running the command");
        assert!(ran, "the approved command ran and exited cleanly");
        assert!(said.contains("starkline-smoke"), "the answer carries the output: {said}");
    }

    #[test]
    fn asks_before_changes_and_keeps_helpers_off() {
        let p = permissions();
        assert_eq!((p["edit"].as_str(), p["bash"].as_str(), p["task"].as_str()), (Some("ask"), Some("ask"), Some("deny")));
    }
}
