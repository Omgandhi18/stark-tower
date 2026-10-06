//! Codex, driven through its app server (`codex app-server`: JSON-RPC over
//! stdio). Each agent session is one Codex thread. Codex asks before running
//! commands and changing files (approval policy "untrusted"), and Starkline's
//! gate answers, or asks the developer; commands run in Codex's workspace
//! sandbox. Codex's events become the same transcript, task and check events
//! as every other provider's.

use crate::chat::{self, Input, Launch, Sink, TurnUsage};
use crate::rpc::{Incoming, Rpc, METHOD_NOT_FOUND};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::Manager;

/// The app server answers its handshake quickly; a thread waits for MCP servers to start.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
const THREAD_TIMEOUT: Duration = Duration::from_secs(90);
const CLIENT_NAME: &str = "starkline";
/// Codex asks before anything but its own known-safe reads; Starkline decides.
const APPROVAL_POLICY: &str = "untrusted";
/// Starkline's bridge, as Codex knows the MCP server.
const BRIDGE_NAME: &str = "stark";
/// How much of Codex's log to keep for explaining an unexpected exit.
const LOG_LINES: usize = 40;
/// What Codex says when a thread can't be resumed (it never ran a turn, or was removed).
const NOT_RESUMABLE: [&str; 2] = ["no rollout found", "not found"];

/// What a Codex session keeps track of between events.
#[derive(Default)]
struct Turns {
    thread: Option<String>,
    /// The turn running now; a message sent meanwhile steers it.
    active: Option<String>,
    /// File changes by item, for answering approvals: (path, Edit | Write).
    changes: HashMap<String, Vec<(String, &'static str)>>,
    /// The latest thing the agent said in this turn: a delegated task's result.
    said: String,
    usage: TurnUsage,
    /// An error was already shown for this turn.
    errored: bool,
    /// A one-shot run waits for its turn to end.
    finished: Option<mpsc::Sender<Result<String, String>>>,
}

struct Codex {
    app: tauri::AppHandle,
    agent_id: String,
    cwd: String,
    sink: Sink,
    rpc: Rpc,
    turns: Mutex<Turns>,
    log: Mutex<VecDeque<String>>,
    /// The agent's effort level for each turn ("" = the model's own).
    effort: String,
}

/// The sandbox each turn runs in: writes inside the project, no network. A
/// command that needs more asks first, and the gate decides.
fn sandbox() -> Value {
    json!({ "type": "workspaceWrite", "writableRoots": [], "networkAccess": false })
}

/// A developer turn as Codex input: the words (naming the files), images as images,
/// and other files as mentions Codex can open.
fn turn_input(turn: &chat::UserTurn) -> Value {
    let mut items = vec![json!({ "type": "text", "text": turn.text_with_files(), "text_elements": [] })];
    for a in &turn.attachments {
        if crate::attachments::is_inline_image(a) {
            items.push(json!({ "type": "localImage", "path": a.path }));
        } else {
            items.push(json!({ "type": "mention", "name": a.name, "path": a.path }));
        }
    }
    Value::Array(items)
}

/// Thread settings Codex doesn't keep between runs, so every start and resume sends them.
fn thread_params(launch: &Launch, ephemeral: bool) -> Value {
    let server = chat::bridge_server(launch);
    let env: serde_json::Map<String, Value> = server.env.into_iter().map(|(k, v)| (k, Value::String(v))).collect();
    let mut params = json!({
        "cwd": launch.cwd,
        "approvalPolicy": APPROVAL_POLICY,
        "developerInstructions": launch.system_prompt,
        "config": {
            format!("mcp_servers.{BRIDGE_NAME}"): { "command": server.command, "args": server.args, "env": env }
        },
    });
    if !launch.model.trim().is_empty() {
        params["model"] = json!(launch.model.trim());
    }
    if ephemeral {
        params["ephemeral"] = json!(true);
    }
    params
}

/// A path Codex reported, made absolute against the session's folder.
fn absolute(path: &str, cwd: &str) -> String {
    if std::path::Path::new(path).is_absolute() {
        path.to_string()
    } else {
        std::path::Path::new(cwd).join(path).to_string_lossy().to_string()
    }
}

/// A file change in Starkline's tool vocabulary: a new file is written, anything else edited.
fn change_tool(change: &Value) -> &'static str {
    if change.pointer("/kind/type").and_then(Value::as_str) == Some("add") {
        "Write"
    } else {
        "Edit"
    }
}

/// Codex's plan, as the to-do list the task engine reads.
fn plan_as_todos(plan: &Value) -> Value {
    let todos: Vec<Value> = plan
        .as_array()
        .map(|steps| {
            steps
                .iter()
                .map(|s| {
                    let status = match s.get("status").and_then(Value::as_str) {
                        Some("completed") => "completed",
                        Some("inProgress") => "in_progress",
                        _ => "pending",
                    };
                    let step = s.get("step").and_then(Value::as_str).unwrap_or("");
                    json!({ "content": step, "status": status, "activeForm": step })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({ "todos": todos })
}

/// Codex's error text, readable: it often nests the API's JSON error in the message.
pub(crate) fn readable(message: &str) -> String {
    let inner = serde_json::from_str::<Value>(message)
        .ok()
        .and_then(|v| v.pointer("/error/message").or(v.get("message")).and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| message.to_string());
    if inner.contains("model is not supported") || inner.contains("model not found") {
        format!("{inner} Choose a model for this agent on Agents, under Provider.")
    } else {
        inner
    }
}

/// A log line without terminal colour codes.
fn plain(line: &str) -> String {
    let mut out = String::new();
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out.trim().to_string()
}

impl Codex {
    fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
        v.get(key).and_then(Value::as_str).unwrap_or("")
    }

    /// The newest error Codex logged, for explaining why it stopped.
    fn last_error(&self) -> Option<String> {
        self.log.lock().unwrap().iter().rev().find(|l| l.contains("ERROR") || l.to_lowercase().contains("error:")).cloned()
    }

    fn handle(self: &Arc<Self>, incoming: Incoming) {
        match incoming {
            Incoming::Notification { method, params } => self.notified(&method, &params),
            Incoming::Request { id, method, params } => self.answer(id, method, params),
        }
    }

    fn notified(&self, method: &str, params: &Value) {
        let (app, sink, agent) = (&self.app, &self.sink, self.agent_id.as_str());
        match method {
            "turn/started" => {
                let turn = params.pointer("/turn/id").and_then(Value::as_str).map(str::to_string);
                let mut turns = self.turns.lock().unwrap();
                turns.active = turn;
                turns.said.clear();
                turns.errored = false;
                turns.usage = TurnUsage::default();
                crate::pty::emit_status(app, agent, crate::agents::AgentStatus::Thinking);
            }
            "item/started" => {
                let item = params.get("item").cloned().unwrap_or(Value::Null);
                let id = Self::str_of(&item, "id").to_string();
                match Self::str_of(&item, "type") {
                    "commandExecution" => {
                        chat::tool_called(app, sink, agent, &id, "Bash", &json!({ "command": Self::str_of(&item, "command") }));
                    }
                    "fileChange" => {
                        let changes: Vec<(String, &'static str)> = item
                            .get("changes")
                            .and_then(Value::as_array)
                            .map(|cs| cs.iter().map(|c| (absolute(Self::str_of(c, "path"), &self.cwd), change_tool(c))).collect())
                            .unwrap_or_default();
                        for (n, (path, tool)) in changes.iter().enumerate() {
                            chat::tool_called(app, sink, agent, &format!("{id}:{n}"), tool, &json!({ "file_path": path }));
                        }
                        self.turns.lock().unwrap().changes.insert(id, changes);
                    }
                    "mcpToolCall" => {
                        let tool = Self::str_of(&item, "tool");
                        chat::tool_called(app, sink, agent, &id, tool, &item.get("arguments").cloned().unwrap_or(Value::Null));
                    }
                    "webSearch" => {
                        chat::tool_called(app, sink, agent, &id, "WebSearch", &json!({ "query": Self::str_of(&item, "query") }));
                    }
                    _ => {}
                }
            }
            "item/completed" => {
                let item = params.get("item").cloned().unwrap_or(Value::Null);
                let id = Self::str_of(&item, "id");
                let status = Self::str_of(&item, "status");
                match Self::str_of(&item, "type") {
                    "agentMessage" => {
                        let text = Self::str_of(&item, "text");
                        chat::said(app, sink, agent, text);
                        self.turns.lock().unwrap().said = text.to_string();
                    }
                    "reasoning" => {
                        let parts = |key: &str| {
                            item.get(key)
                                .and_then(Value::as_array)
                                .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n\n"))
                                .unwrap_or_default()
                        };
                        let summary = parts("summary");
                        let text = if summary.trim().is_empty() { parts("content") } else { summary };
                        chat::thought(app, sink, agent, &text);
                    }
                    "commandExecution" => {
                        let exit = item.get("exitCode").and_then(Value::as_i64);
                        chat::tool_returned(app, id, status != "completed" || exit.is_some_and(|code| code != 0));
                    }
                    "fileChange" => {
                        let changes = self.turns.lock().unwrap().changes.remove(id).unwrap_or_default();
                        for n in 0..changes.len() {
                            chat::tool_returned(app, &format!("{id}:{n}"), status != "completed");
                        }
                    }
                    "mcpToolCall" => chat::tool_returned(app, id, status == "failed"),
                    _ => {}
                }
            }
            "turn/plan/updated" => {
                let turn = Self::str_of(params, "turnId");
                chat::tool_called(app, sink, agent, &format!("plan-{turn}"), "TodoWrite", &plan_as_todos(params.get("plan").unwrap_or(&Value::Null)));
            }
            "thread/tokenUsage/updated" => {
                let last = |k: &str| params.pointer(&format!("/tokenUsage/last/{k}")).and_then(Value::as_u64).unwrap_or(0);
                self.turns.lock().unwrap().usage = TurnUsage { input_tokens: last("inputTokens"), output_tokens: last("outputTokens"), context_tokens: last("inputTokens") + last("outputTokens"), ..Default::default() };
            }
            "error" if params.get("willRetry").and_then(Value::as_bool) != Some(true) => {
                let message = params.pointer("/error/message").and_then(Value::as_str).unwrap_or("Codex reported an error.");
                self.turns.lock().unwrap().errored = true;
                chat::failed(app, sink, agent, &readable(message));
            }
            "turn/completed" => {
                let turn = params.get("turn").cloned().unwrap_or(Value::Null);
                let failure = (Self::str_of(&turn, "status") == "failed")
                    .then(|| readable(turn.pointer("/error/message").and_then(Value::as_str).unwrap_or("The turn failed.")));
                let (said, usage, waiter, errored) = {
                    let mut turns = self.turns.lock().unwrap();
                    turns.active = None;
                    (std::mem::take(&mut turns.said), turns.usage, turns.finished.take(), turns.errored)
                };
                // Say a failure once: its `error` notification usually said it already.
                if let (Some(message), false) = (&failure, errored) {
                    chat::failed(app, sink, agent, message);
                }
                let mut sink = sink.clone();
                if let Some(session) = &mut sink.usage_session { session.session_id = self.turns.lock().unwrap().thread.clone(); }
                chat::turn_finished(app, &sink, agent, (!said.is_empty()).then(|| said.clone()), usage);
                if let Some(waiter) = waiter {
                    let _ = waiter.send(match failure {
                        Some(message) if said.is_empty() => Err(message),
                        _ => Ok(said),
                    });
                }
            }
            _ => {}
        }
    }

    /// Codex asks before acting. Each answer may wait on the developer, so it's
    /// worked out on its own thread while the stream keeps flowing.
    fn answer(self: &Arc<Self>, id: Value, method: String, params: Value) {
        let me = self.clone();
        std::thread::spawn(move || {
            let decide = |tool: &str, input: Value| crate::bridge::decide(&me.app, &me.agent_id, tool, &input).approved;
            let decision = |ok: bool| json!({ "decision": if ok { "accept" } else { "decline" } });
            let reply = match method.as_str() {
                "item/commandExecution/requestApproval" => decision(decide("Bash", json!({ "command": Self::str_of(&params, "command") }))),
                "item/fileChange/requestApproval" => {
                    let item = Self::str_of(&params, "itemId");
                    let changes = me.turns.lock().unwrap().changes.get(item).cloned().unwrap_or_default();
                    // Every file must be allowed; the first refusal settles it.
                    decision(!changes.is_empty() && changes.iter().all(|(path, tool)| decide(tool, json!({ "file_path": path }))))
                }
                // Wider sandbox permissions aren't granted; a command that needs them asks on its own.
                "item/permissions/requestApproval" => json!({ "permissions": {}, "scope": "turn" }),
                "mcpServer/elicitation/request" => {
                    let server = Self::str_of(&params, "serverName");
                    let ok = server == BRIDGE_NAME || decide(&format!("mcp__{server}"), params.clone());
                    json!({ "action": if ok { "accept" } else { "decline" }, "content": null, "_meta": null })
                }
                "item/tool/requestUserInput" => json!({ "answers": {} }),
                _ => {
                    let _ = me.rpc.respond_error(&id, METHOD_NOT_FOUND, "Starkline doesn't handle this request.");
                    return;
                }
            };
            let _ = me.rpc.respond(&id, reply);
        });
    }

    /// Start a turn, or steer the one running.
    fn send(&self, turn: &chat::UserTurn) -> Result<(), String> {
        let (thread, active) = {
            let turns = self.turns.lock().unwrap();
            (turns.thread.clone().ok_or("Codex has no thread open.")?, turns.active.clone())
        };
        let (app, sink, agent) = (self.app.clone(), self.sink.clone(), self.agent_id.clone());
        let report = move |reply: crate::rpc::Reply| {
            if let Err(e) = reply {
                chat::failed(&app, &sink, &agent, &format!("Codex didn't take the message: {e}"));
                crate::pty::emit_status(&app, &agent, crate::agents::AgentStatus::Idle);
            }
        };
        match active {
            Some(running) => self.rpc.request_then("turn/steer", json!({ "threadId": thread, "input": turn_input(turn), "expectedTurnId": running }), report),
            None => {
                let mut params = json!({ "threadId": thread, "input": turn_input(turn), "approvalPolicy": APPROVAL_POLICY, "sandboxPolicy": sandbox() });
                if !self.effort.is_empty() {
                    params["effort"] = json!(self.effort);
                }
                self.rpc.request_then("turn/start", params, report)
            }
        }
    }
}

/// Spawn Codex's app server, read it on its own thread, and shake hands. `gen`
/// marks a chat session (its end is reported); a one-shot run has none.
fn connect(app: &tauri::AppHandle, launch: &Launch, sink: Sink, gen: Option<u64>) -> Result<(Child, Arc<Codex>), String> {
    let mut cmd = Command::new(&launch.program);
    cmd.arg("app-server").current_dir(&launch.cwd);
    chat::provider_env(&mut cmd, launch);
    chat::detach(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Codex couldn't start: {e}"))?;
    let stdin = child.stdin.take().ok_or("Codex has no input stream.")?;
    let stdout = child.stdout.take().ok_or("Codex has no output stream.")?;
    let stderr = child.stderr.take();
    let codex = Arc::new(Codex {
        app: app.clone(),
        agent_id: launch.agent_id.clone(),
        cwd: launch.cwd.clone(),
        sink: sink.launched(launch),
        rpc: Rpc::new(stdin),
        turns: Mutex::new(Turns::default()),
        log: Mutex::new(VecDeque::new()),
        effort: launch.effort.trim().to_string(),
    });
    // Codex logs to stderr; it's read continuously (a full pipe would stall it) and the tail kept.
    if let Some(stderr) = stderr {
        let codex = codex.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut log = codex.log.lock().unwrap();
                log.push_back(plain(&line));
                if log.len() > LOG_LINES {
                    log.pop_front();
                }
            }
        });
    }
    {
        let codex = codex.clone();
        let orchestrator = launch.orchestrator;
        std::thread::spawn(move || {
            crate::rpc::pump(stdout, &codex.rpc, |incoming| codex.handle(incoming));
            let why = codex.last_error().unwrap_or_else(|| "Codex stopped before it finished.".into());
            if let Some(waiter) = codex.turns.lock().unwrap().finished.take() {
                let _ = waiter.send(Err(why));
            }
            if let Some(gen) = gen {
                chat::session_finished(&codex.app, &codex.agent_id, gen, false, orchestrator);
            }
        });
    }
    let handshake = || -> Result<(), String> {
        let rpc = &codex.rpc;
        rpc.request(
            "initialize",
            json!({ "clientInfo": { "name": CLIENT_NAME, "title": "Starkline", "version": env!("CARGO_PKG_VERSION") }, "capabilities": null }),
            HANDSHAKE_TIMEOUT,
        )?;
        rpc.notify("initialized", Value::Null)?;
        let account = rpc.request("account/read", json!({}), HANDSHAKE_TIMEOUT)?;
        let signed_out = account.get("account").is_none_or(Value::is_null) && account.get("requiresOpenaiAuth").and_then(Value::as_bool) == Some(true);
        if signed_out && launch.engine.auth.method != "api-key-env" {
            return Err("Codex isn't signed in. Run `codex login` in Terminal, then try again.".into());
        }
        Ok(())
    };
    if let Err(e) = handshake() {
        crate::proc::kill_tree(child.id());
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    Ok((child, codex))
}

/// Open the thread: resume the saved one when there is one, else start a new one.
fn open_thread(codex: &Codex, launch: &Launch, ephemeral: bool) -> Result<String, String> {
    let rpc = &codex.rpc;
    let started = |reply: Value| reply.pointer("/thread/id").and_then(Value::as_str).map(str::to_string).ok_or("Codex didn't open a thread.".to_string());
    if let Some(saved) = &launch.resume {
        let mut params = thread_params(launch, false);
        params["threadId"] = json!(saved);
        match rpc.request("thread/resume", params, THREAD_TIMEOUT) {
            Ok(reply) => return started(reply),
            Err(e) if NOT_RESUMABLE.iter().any(|s| e.contains(s)) => {
                chat::note_in(&codex.app, &codex.sink, &codex.agent_id, "The previous Codex session couldn't be continued, so this chat started a new one.");
            }
            Err(e) => return Err(e),
        }
    }
    started(rpc.request("thread/start", thread_params(launch, ephemeral), THREAD_TIMEOUT)?)
}

/// The models this Codex sign-in can use, as Codex lists them.
pub(crate) fn list_models(program: &str) -> Result<Vec<crate::providers::ModelChoice>, String> {
    let mut child = Command::new(program)
        .arg("app-server")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Codex couldn't start: {e}"))?;
    let rpc = Arc::new(Rpc::new(child.stdin.take().ok_or("Codex has no input stream.")?));
    let stdout = child.stdout.take().ok_or("Codex has no output stream.")?;
    {
        let rpc = rpc.clone();
        std::thread::spawn(move || crate::rpc::pump(stdout, &rpc, |_| {}));
    }
    let listed = (|| {
        let info = json!({ "clientInfo": { "name": CLIENT_NAME, "title": "Starkline", "version": env!("CARGO_PKG_VERSION") }, "capabilities": null });
        rpc.request("initialize", info, HANDSHAKE_TIMEOUT)?;
        rpc.notify("initialized", Value::Null)?;
        rpc.request("model/list", json!({}), HANDSHAKE_TIMEOUT)
    })();
    let _ = child.kill();
    let _ = child.wait();
    Ok(parse_model_list(&listed?))
}

/// Codex's `model/list` answer: each visible model with the reasoning efforts it takes and its
/// own default. Codex lists its newest first, so all but the first few go under "More models".
pub(crate) fn parse_model_list(models: &Value) -> Vec<crate::providers::ModelChoice> {
    models["data"]
        .as_array()
        .map(|all| {
            all.iter()
                .filter(|m| m["hidden"] != true)
                .filter_map(|m| {
                    let id = m["model"].as_str()?.to_string();
                    let name = m["displayName"].as_str().filter(|n| !n.is_empty()).unwrap_or(&id).to_string();
                    let mut efforts: Vec<String> = m["supportedReasoningEfforts"]
                        .as_array()
                        .map(|levels| {
                            levels
                                .iter()
                                .filter_map(|l| l["reasoningEffort"].as_str().or_else(|| l.as_str()).map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default();
                    crate::providers::sort_efforts(&mut efforts);
                    let default_effort = m["defaultReasoningEffort"].as_str().filter(|d| efforts.iter().any(|e| e == d)).map(str::to_string);
                    Some(crate::providers::ModelChoice {
                        id,
                        name,
                        default: m["isDefault"] == true,
                        description: m["description"].as_str().unwrap_or("").to_string(),
                        efforts,
                        default_effort,
                        older: false,
                    })
                })
                .enumerate()
                .map(|(i, model)| crate::providers::ModelChoice { older: i >= crate::providers::MAIN_MODELS, ..model })
                .collect()
        })
        .unwrap_or_default()
}

/// An agent's chat session on Codex.
pub(crate) fn start_chat(app: &tauri::AppHandle, launch: &Launch, gen: u64) -> Result<(Child, Input), String> {
    let (mut child, codex) = connect(app, launch, Sink::chat(), Some(gen))?;
    let thread = match open_thread(&codex, launch, false) {
        Ok(thread) => thread,
        Err(e) => {
            crate::proc::kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    codex.turns.lock().unwrap().thread = Some(thread.clone());
    chat::session_ready(app, &launch.agent_id, &codex.sink, Some(&thread), Some(launch.cwd.clone()));
    Ok((child, Input::Turns(Box::new(move |turn| codex.send(turn)))))
}

/// A delegated task on Codex: one turn in a thread of its own, and its final answer.
pub(crate) fn run_once(app: &tauri::AppHandle, launch: &Launch, task: &str, sink: &Sink) -> Result<String, String> {
    let (mut child, codex) = connect(app, launch, sink.clone(), None)?;
    let pid = child.id();
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.oneshot_pids.lock().unwrap().insert(pid);
    }
    let outcome = (|| {
        let thread = open_thread(&codex, launch, true)?;
        let (tx, rx) = mpsc::channel();
        {
            let mut turns = codex.turns.lock().unwrap();
            turns.thread = Some(thread);
            turns.finished = Some(tx);
        }
        chat::session_ready(app, &launch.agent_id, sink, None, Some(launch.cwd.clone()));
        codex.send(&chat::UserTurn::plain(task))?;
        rx.recv().unwrap_or_else(|_| Err("Codex stopped before it finished.".into()))
    })();
    crate::proc::kill_tree(pid);
    let _ = child.kill();
    let _ = child.wait();
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.oneshot_pids.lock().unwrap().remove(&pid);
    }
    outcome
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn lists_models_with_the_efforts_each_one_takes() {
        let reply = json!({ "data": [
            { "model": "gpt-new", "displayName": "GPT New", "isDefault": true, "description": "Latest.", "defaultReasoningEffort": "low",
              "supportedReasoningEfforts": [{ "reasoningEffort": "ultra" }, { "reasoningEffort": "low" }, { "reasoningEffort": "high" }] },
            { "model": "gpt-hidden", "hidden": true },
            { "model": "gpt-a" }, { "model": "gpt-b" }, { "model": "gpt-c" }, { "model": "gpt-old", "defaultReasoningEffort": "medium" }
        ] });
        let models = parse_model_list(&reply);
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["gpt-new", "gpt-a", "gpt-b", "gpt-c", "gpt-old"]);
        assert_eq!(models[0].efforts, vec!["low", "high", "ultra"]);
        assert_eq!(models[0].default_effort.as_deref(), Some("low"));
        assert!(models[0].default && models[0].description == "Latest.");
        assert!(models[4].older && !models[3].older, "the first few up front, the rest under More models");
        assert_eq!(models[4].default_effort, None, "a default it doesn't list isn't offered");
    }

    #[test]
    fn plans_become_the_task_engines_todo_list() {
        let plan = json!([
            { "step": "Read the code", "status": "completed" },
            { "step": "Write tests", "status": "inProgress" },
            { "step": "Ship", "status": "pending" },
        ]);
        let todos = plan_as_todos(&plan);
        let parsed = crate::tasks::plan_from(&todos).unwrap();
        assert_eq!(parsed.iter().map(|p| p.status.as_str()).collect::<Vec<_>>(), vec!["completed", "in_progress", "pending"]);
        assert_eq!(parsed[1].content, "Write tests");
    }

    #[test]
    fn file_changes_read_as_writes_or_edits_with_absolute_paths() {
        assert_eq!(change_tool(&json!({ "path": "a.ts", "kind": { "type": "add" } })), "Write");
        assert_eq!(change_tool(&json!({ "path": "a.ts", "kind": { "type": "update", "move_path": null } })), "Edit");
        assert_eq!(change_tool(&json!({ "path": "a.ts", "kind": { "type": "delete" } })), "Edit");
        assert_eq!(absolute("src/a.ts", "/w/app"), "/w/app/src/a.ts");
        assert_eq!(absolute("/w/app/b.ts", "/elsewhere"), "/w/app/b.ts");
    }

    #[test]
    fn errors_read_plainly() {
        let nested = r#"{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}}"#;
        let shown = readable(nested);
        assert!(shown.starts_with("The 'gpt-6.1-sol' model is not supported"));
        assert!(shown.ends_with("under Provider."));
        assert_eq!(readable("Rate limited"), "Rate limited");
    }

    #[test]
    fn logs_lose_their_colours() {
        assert_eq!(plain("\u{1b}[2m2026-10-05\u{1b}[0m \u{1b}[31mERROR\u{1b}[0m auth failed  "), "2026-10-05 ERROR auth failed");
    }

    /// A launch like an agent's, for talking to a real CLI in a throwaway folder.
    pub(crate) fn smoke_launch(kind: &str, dir: &str) -> Launch {
        let engine = crate::config::default_engines().into_iter().find(|e| e.kind == kind).unwrap();
        let scripts_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/mcp");
        Launch {
            program: chat::resolve_program(&engine.command).expect("the CLI is installed"),
            engine,
            model: String::new(),
            cwd: dir.to_string(),
            agent_id: "smoke".into(),
            orchestrator: false,
            system_prompt: "You are being smoke-tested by Starkline. Be brief.".into(),
            resume: None,
            sock_path: "/nonexistent/starkline-smoke.sock".into(),
            sock_token: "smoke".into(),
            memory_file: String::new(),
            scripts: crate::health::BridgeScripts {
                mcp: format!("{scripts_dir}/delegate-mcp.mjs"),
                hook: format!("{scripts_dir}/gate-hook.mjs"),
                dir: scripts_dir.into(),
            },
            node: chat::resolve_program("node").unwrap_or_else(|| "node".into()),
            helpers: false,
            helper_model: String::new(),
            effort: String::new(),
            shared_dir: String::new(),
        }
    }

    /// Talks to the real Codex with this Mac's sign-in, in a throwaway git folder:
    /// `STARK_SMOKE_DIR=/tmp/x cargo test live_codex -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_codex_runs_a_turn_and_asks_before_a_command() {
        use std::time::Instant;
        let dir = std::env::var("STARK_SMOKE_DIR").expect("set STARK_SMOKE_DIR to a throwaway git folder");
        let launch = smoke_launch("codex", &dir);
        let mut child = Command::new(&launch.program)
            .arg("app-server")
            .current_dir(&dir)
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
        let info = json!({ "clientInfo": { "name": CLIENT_NAME, "title": "Starkline", "version": "smoke" }, "capabilities": null });
        rpc.request("initialize", info, HANDSHAKE_TIMEOUT).unwrap();
        rpc.notify("initialized", Value::Null).unwrap();
        let account = rpc.request("account/read", json!({}), HANDSHAKE_TIMEOUT).unwrap();
        println!("signed in: {}", account["account"]["type"]);
        let models = rpc.request("model/list", json!({}), HANDSHAKE_TIMEOUT).unwrap();
        let default = models["data"].as_array().and_then(|m| m.iter().find(|m| m["isDefault"] == true)).map(|m| m["model"].as_str().unwrap_or("").to_string());
        println!("models: {:?}, default {default:?}", models["data"].as_array().map(|m| m.iter().map(|m| m["model"].clone()).collect::<Vec<_>>()));
        let mut launch = launch;
        launch.model = default.expect("Codex names a default model");
        let thread = rpc.request("thread/start", thread_params(&launch, true), THREAD_TIMEOUT).unwrap();
        let thread_id = thread.pointer("/thread/id").and_then(Value::as_str).unwrap().to_string();
        println!("thread: {thread_id}, sandbox before the turn: {}", thread["sandbox"]);
        // Not on Codex's list of known-safe commands, so it has to ask first.
        let prompt = "Run the shell command `node -e \"console.log('starkline-' + 'smoke')\"` and reply with only its output.";
        let turn = json!({ "threadId": thread_id, "input": turn_input(&chat::UserTurn::plain(prompt)), "approvalPolicy": APPROVAL_POLICY, "sandboxPolicy": sandbox() });
        rpc.request("turn/start", turn, HANDSHAKE_TIMEOUT).unwrap();

        let deadline = Instant::now() + Duration::from_secs(240);
        let (mut approvals, mut ran, mut said, mut status) = (0, false, String::new(), String::new());
        while Instant::now() < deadline {
            let Ok(incoming) = rx.recv_timeout(Duration::from_secs(5)) else { continue };
            match incoming {
                Incoming::Request { id, method, params } => {
                    println!("asked: {method} {}", params);
                    approvals += 1;
                    let reply = if method == "mcpServer/elicitation/request" {
                        json!({ "action": "accept", "content": null, "_meta": null })
                    } else {
                        json!({ "decision": "accept" })
                    };
                    rpc.respond(&id, reply).unwrap();
                }
                Incoming::Notification { method, params } => {
                    if method.starts_with("item/") && !method.contains("delta") {
                        let item = &params["item"];
                        println!("{method}: {} {}", item["type"], item.get("command").or(item.get("text")).unwrap_or(&Value::Null));
                        if method == "item/completed" && item["type"] == "commandExecution" {
                            ran = item["exitCode"] == 0 && item["command"].as_str().unwrap_or("").contains("node");
                        }
                        if method == "item/completed" && item["type"] == "agentMessage" {
                            said = item["text"].as_str().unwrap_or("").to_string();
                        }
                    } else if matches!(method.as_str(), "error" | "warning" | "turn/completed") {
                        println!("{method}: {params}");
                    } else if !method.contains("delta") && method != "mcpServer/startupStatus/updated" {
                        println!("{method}");
                    }
                    if method == "turn/completed" {
                        status = params.pointer("/turn/status").and_then(Value::as_str).unwrap_or("").to_string();
                        break;
                    }
                }
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(status, "completed");
        assert!(approvals >= 1, "Codex asked before running the command");
        assert!(ran, "the approved command ran and exited cleanly");
        assert!(said.contains("starkline-smoke"), "the answer carries the output: {said}");
    }

    #[test]
    fn turns_run_sandboxed_and_ask_first() {
        assert_eq!(sandbox()["type"], "workspaceWrite");
        assert_eq!(sandbox()["networkAccess"], false);
        assert_eq!(turn_input(&chat::UserTurn::plain("hi"))[0]["text"], "hi");
    }
}
