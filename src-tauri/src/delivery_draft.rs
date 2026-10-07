//! A private one-shot writer: no transcript, bridge, or tool permissions.
use crate::rpc::{Incoming, Rpc};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::Command;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;

static WRITERS: OnceLock<Mutex<HashMap<String, Option<u32>>>> = OnceLock::new();
pub fn cancel(token: &str) {
    let mut writers = WRITERS.get_or_init(Mutex::default).lock().unwrap();
    if let Some(pid) = writers.insert(token.into(), None).flatten() {
        crate::proc::kill_tree(pid);
    }
}
pub fn write(app: &tauri::AppHandle, agent: &str, cwd: &str, prompt: &str, token: &str) -> Result<String, String> {
    let mut launch = crate::chat::launch_for(app, agent, None, cwd, None)?;
    launch
        .system_prompt
        .push_str("\nFor this private draft, write text only. Never call any tools, read files, or change anything. All evidence is in the request.");
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut cmd = Command::new(&launch.program);
    // No project configuration or instructions are needed: all evidence is in the prompt.
    cmd.current_dir(std::env::temp_dir());
    crate::chat::provider_env(&mut cmd, &launch);
    let kind = launch.engine.kind.as_str();
    match kind {
        "codex" => {
            cmd.arg("app-server");
        }
        "opencode" => {
            cmd.arg("acp")
                .env("OPENCODE_PERMISSION", json!({ "*": "deny" }).to_string())
                .env(
                    "OPENCODE_CONFIG_CONTENT",
                    json!({ "tools": { "*": false }, "permission": { "*": "deny" }, "mcp": {} }).to_string(),
                )
                .env("OPENCODE_DISABLE_AUTOUPDATE", "1");
        }
        _ => {
            cmd.args([
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--tools",
                "",
                "--strict-mcp-config",
                "--mcp-config",
                "{\"mcpServers\":{}}",
                "--no-session-persistence",
                "--system-prompt",
                &launch.system_prompt,
            ]);
            if !launch.model.is_empty() {
                cmd.args(["--model", &launch.model]);
            }
            // A short message needs no extra thinking, so the model's own default effort keeps it quick.
        }
    }
    crate::chat::detach(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    {
        let mut writers = WRITERS.get_or_init(Mutex::default).lock().unwrap();
        if writers.get(token) == Some(&None) {
            crate::proc::kill_tree(pid);
            let _ = child.wait();
            writers.remove(token);
            return Err("Draft cancelled.".into());
        }
        writers.insert(token.into(), Some(pid));
    }
    app.state::<crate::AppState>().oneshot_pids.lock().unwrap().insert(pid);
    let stderr = child.stderr.take().unwrap();
    std::thread::spawn(move || for _ in BufReader::new(stderr).lines().map_while(Result::ok) {});
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let outcome = if kind != "codex" && kind != "opencode" {
        let (tx, rx) = mpsc::channel();
        let prompt = prompt.to_string();
        std::thread::spawn(move || {
            let mut stdin = stdin;
            let _ = writeln!(stdin, "{}", json!({"type":"user", "message":{"role":"user", "content":prompt}}));
            drop(stdin);
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(v) = serde_json::from_str::<Value>(&line).ok().filter(|v| v["type"] == "result") {
                    let result = if v["is_error"] == true {
                        Err("The provider couldn't write the draft. Check its sign-in in Terminal.".into())
                    } else {
                        Ok(v["result"].as_str().unwrap_or("").to_string())
                    };
                    let _ = tx.send(result);
                    return;
                }
            }
            let _ = tx.send(Err("The provider stopped before writing the draft.".into()));
        });
        rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|_| Err("The draft took longer than 60 seconds.".into()))
    } else {
        let rpc = Arc::new(Rpc::new(stdin));
        let text = Arc::new(Mutex::new(String::new()));
        let (tx, rx) = mpsc::channel();
        let reader = rpc.clone();
        let said = text.clone();
        std::thread::spawn(move || {
            crate::rpc::pump(stdout, &reader, |incoming| match incoming {
                Incoming::Request { id, method, .. } => {
                    let result = if method == "session/request_permission" {
                        json!({ "outcome": { "outcome": "cancelled" } })
                    } else if method.ends_with("requestApproval") {
                        json!({ "decision": "decline" })
                    } else {
                        json!({ "success": false, "contentItems": [] })
                    };
                    let _ = reader.respond(&id, result);
                }
                Incoming::Notification { method, params } => {
                    if method == "item/started"
                        && matches!(
                            params["item"]["type"].as_str(),
                            Some("commandExecution" | "fileChange" | "mcpToolCall" | "dynamicToolCall" | "webSearch")
                        )
                    {
                        let _ = tx.send(Err("The provider tried to use a tool while drafting.".into()));
                    }
                    if method == "session/update" && params["update"]["sessionUpdate"] == "tool_call" {
                        let _ = tx.send(Err("The provider tried to use a tool while drafting.".into()));
                    }
                    if method == "item/completed" && params["item"]["type"] == "agentMessage" {
                        *said.lock().unwrap() = params["item"]["text"].as_str().unwrap_or("").into();
                    }
                    if method == "session/update" && params["update"]["sessionUpdate"] == "agent_message_chunk" {
                        if let Some(chunk) = params["update"]["content"]["text"].as_str() {
                            said.lock().unwrap().push_str(chunk);
                        }
                    }
                    if method == "turn/completed" {
                        let result = if params["turn"]["status"] == "failed" {
                            Err("Codex couldn't write the draft. Check its sign-in in Terminal.".into())
                        } else {
                            Ok(said.lock().unwrap().clone())
                        };
                        let _ = tx.send(result);
                    }
                }
            });
            let _ = tx.send(Err("The provider stopped before writing the draft.".into()));
        });
        let request = |method: &str, params| rpc.request(method, params, deadline.saturating_duration_since(Instant::now()));
        (|| -> Result<String, String> {
            if kind == "codex" {
                request(
                    "initialize",
                    json!({ "clientInfo": { "name":"starkline", "version":env!("CARGO_PKG_VERSION") }, "capabilities":null }),
                )?;
                rpc.notify("initialized", Value::Null)?;
                let config = request("config/read", json!({}))?;
                let mut overrides = json!({ "web_search":"disabled", "features.shell_tool":false, "features.unified_exec":false, "features.view_image":false, "features.multi_agent":false, "features.multi_agent_v2":false, "features.apps":false, "features.stable_environment_tools":false, "features.search_tool":false, "features.code_mode":false });
                if let Some(servers) = config.pointer("/config/mcp_servers").and_then(Value::as_object) {
                    for name in servers.keys() {
                        overrides[format!("mcp_servers.{name}.enabled")] = json!(false);
                    }
                }
                let mut params = json!({ "cwd":std::env::temp_dir(), "ephemeral":true, "approvalPolicy":"untrusted", "sandbox":"read-only", "developerInstructions":launch.system_prompt, "config":overrides, "dynamicTools":[] });
                if !launch.model.is_empty() {
                    params["model"] = json!(launch.model);
                }
                let opened = request("thread/start", params)?;
                let thread = opened
                    .pointer("/thread/id")
                    .and_then(Value::as_str)
                    .ok_or("Codex didn't open a draft session.")?;
                let mut turn =
                    json!({ "threadId":thread, "input":[{ "type":"text", "text":prompt, "text_elements":[] }], "sandboxPolicy":{"type":"readOnly"} });
                if !launch.effort.is_empty() {
                    turn["effort"] = json!(launch.effort);
                }
                request("turn/start", turn)?;
                rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .unwrap_or_else(|_| Err("The draft took longer than 60 seconds.".into()))
            } else {
                request(
                    "initialize",
                    json!({ "protocolVersion":1, "clientCapabilities":{ "fs":{"readTextFile":false,"writeTextFile":false},"terminal":false }, "clientInfo":{"name":"starkline","version":env!("CARGO_PKG_VERSION")} }),
                )?;
                let opened = request("session/new", json!({ "cwd":std::env::temp_dir(), "mcpServers":[] }))?;
                let session = opened["sessionId"].as_str().ok_or("OpenCode didn't open a draft session.")?;
                if !launch.model.is_empty() {
                    request(
                        "session/set_config_option",
                        json!({ "sessionId":session,"configId":"model","value":launch.model }),
                    )?;
                }
                if !launch.effort.is_empty() {
                    request(
                        "session/set_config_option",
                        json!({ "sessionId":session,"configId":"effort","value":launch.effort }),
                    )?;
                }
                request(
                    "session/prompt",
                    json!({ "sessionId":session,"prompt":[{"type":"text","text":format!("{}\n{prompt}", launch.system_prompt)}] }),
                )?;
                if let Ok(result) = rx.try_recv() {
                    result?;
                }
                Ok(text.lock().unwrap().clone())
            }
        })()
    };
    crate::proc::kill_tree(pid);
    let _ = child.kill();
    let _ = child.wait();
    app.state::<crate::AppState>().oneshot_pids.lock().unwrap().remove(&pid);
    WRITERS.get_or_init(Mutex::default).lock().unwrap().remove(token);
    outcome
}
