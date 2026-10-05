//! JSON-RPC 2.0 over a child process's stdin and stdout, one message per line.
//! Codex (`codex app-server`) and OpenCode (`opencode acp`) both speak it. The
//! transport matches responses to the requests that asked for them, and hands
//! everything the provider starts (notifications, and requests such as asking
//! permission) to the adapter that reads the stream.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

/// A response's error, as the provider sent it.
#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub type Reply = Result<Value, RpcError>;
type Callback = Box<dyn FnOnce(Reply) + Send>;

/// Something the provider sent that isn't a response to us.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// It wants an answer (approvals, client-side file access).
    Request { id: Value, method: String, params: Value },
    Notification { method: String, params: Value },
}

/// Read a provider's output until it exits: replies settle their requests, and
/// everything else goes to `handle`. Then any request still waiting fails.
pub fn pump(stdout: impl std::io::Read, rpc: &Rpc, mut handle: impl FnMut(Incoming)) {
    use std::io::BufRead;
    for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        if let Some(incoming) = rpc.dispatch(&line) {
            handle(incoming);
        }
    }
    rpc.close("The provider stopped.");
}

/// The error code for a method this client doesn't implement.
pub const METHOD_NOT_FOUND: i64 = -32601;
/// The error code a dropped request is failed with.
const CONNECTION_CLOSED: i64 = -32000;

pub struct Rpc {
    out: Mutex<Box<dyn Write + Send>>,
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, Callback>>,
}

impl Rpc {
    pub fn new(out: impl Write + Send + 'static) -> Rpc {
        Rpc { out: Mutex::new(Box::new(out)), next: AtomicU64::new(1), waiting: Mutex::new(HashMap::new()) }
    }

    fn write(&self, message: &Value) -> Result<(), String> {
        let mut out = self.out.lock().unwrap();
        out.write_all(format!("{message}\n").as_bytes()).map_err(|e| e.to_string())?;
        out.flush().map_err(|e| e.to_string())
    }

    /// Send a request; `then` runs with the reply, on the thread reading the stream.
    pub fn request_then(&self, method: &str, params: Value, then: impl FnOnce(Reply) + Send + 'static) -> Result<(), String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.waiting.lock().unwrap().insert(id, Box::new(then));
        let sent = self.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        if sent.is_err() {
            self.waiting.lock().unwrap().remove(&id);
        }
        sent
    }

    /// Send a request and wait for its reply. Never call this from the reading thread.
    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        self.request_then(method, params, move |reply| {
            let _ = tx.send(reply);
        })?;
        match rx.recv_timeout(timeout) {
            Ok(reply) => reply.map_err(|e| e.message),
            Err(_) => Err(format!("No answer to {method} in time.")),
        }
    }

    /// A notification; `Value::Null` sends none of `params` at all.
    pub fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let mut message = json!({ "jsonrpc": "2.0", "method": method });
        if !params.is_null() {
            message["params"] = params;
        }
        self.write(&message)
    }

    /// Answer a request the provider sent.
    pub fn respond(&self, id: &Value, result: Value) -> Result<(), String> {
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }

    pub fn respond_error(&self, id: &Value, code: i64, message: &str) -> Result<(), String> {
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }))
    }

    /// Take one line from the provider: a response settles its request; anything
    /// else is returned for the adapter. Lines that aren't JSON-RPC are ignored.
    pub fn dispatch(&self, line: &str) -> Option<Incoming> {
        let message: Value = serde_json::from_str(line.trim()).ok()?;
        let method = message.get("method").and_then(Value::as_str).map(str::to_string);
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match (message.get("id").filter(|id| !id.is_null()), method) {
            (Some(id), Some(method)) => Some(Incoming::Request { id: id.clone(), method, params }),
            (None, Some(method)) => Some(Incoming::Notification { method, params }),
            (Some(id), None) => {
                let callback = id.as_u64().and_then(|n| self.waiting.lock().unwrap().remove(&n));
                if let Some(callback) = callback {
                    let reply = match message.get("error") {
                        Some(error) => Err(RpcError {
                            code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
                            message: error.get("message").and_then(Value::as_str).unwrap_or("The provider reported an error.").to_string(),
                        }),
                        None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    callback(reply);
                }
                None
            }
            (None, None) => None,
        }
    }

    /// The provider went away: every request still waiting fails with `reason`.
    pub fn close(&self, reason: &str) {
        let waiting: Vec<Callback> = self.waiting.lock().unwrap().drain().map(|(_, c)| c).collect();
        for callback in waiting {
            callback(Err(RpcError { code: CONNECTION_CLOSED, message: reason.to_string() }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Collects what the client writes, line by line.
    #[derive(Clone, Default)]
    struct Pipe(Arc<Mutex<Vec<u8>>>);

    impl Write for Pipe {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Pipe {
        fn lines(&self) -> Vec<Value> {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
        }
    }

    #[test]
    fn matches_replies_to_requests() {
        let pipe = Pipe::default();
        let rpc = Rpc::new(pipe.clone());
        let got = Arc::new(Mutex::new(None));
        let sink = got.clone();
        rpc.request_then("thread/start", json!({ "cwd": "/w" }), move |r| *sink.lock().unwrap() = Some(r)).unwrap();
        let sent = pipe.lines();
        assert_eq!(sent[0]["method"], "thread/start");
        assert_eq!(sent[0]["jsonrpc"], "2.0");
        let id = sent[0]["id"].as_u64().unwrap();
        assert_eq!(rpc.dispatch(&json!({ "id": id, "result": { "thread": { "id": "th-1" } } }).to_string()), None);
        assert_eq!(got.lock().unwrap().clone().unwrap().unwrap()["thread"]["id"], "th-1");
    }

    #[test]
    fn errors_and_closing_fail_the_request() {
        let rpc = Rpc::new(Pipe::default());
        let got = Arc::new(Mutex::new(Vec::new()));
        for _ in 0..2 {
            let sink = got.clone();
            rpc.request_then("turn/start", json!({}), move |r| sink.lock().unwrap().push(r)).unwrap();
        }
        rpc.dispatch(&json!({ "id": 1, "error": { "code": -32600, "message": "Not logged in" } }).to_string());
        rpc.close("The provider exited.");
        let replies = got.lock().unwrap().clone();
        assert_eq!(replies[0], Err(RpcError { code: -32600, message: "Not logged in".into() }));
        assert_eq!(replies[1].clone().unwrap_err().message, "The provider exited.");
    }

    #[test]
    fn hands_over_requests_and_notifications() {
        let rpc = Rpc::new(Pipe::default());
        let request = json!({ "jsonrpc": "2.0", "id": "a1", "method": "session/request_permission", "params": { "sessionId": "s" } });
        assert_eq!(
            rpc.dispatch(&request.to_string()),
            Some(Incoming::Request { id: json!("a1"), method: "session/request_permission".into(), params: json!({ "sessionId": "s" }) })
        );
        let note = json!({ "method": "item/completed", "params": { "item": {} } });
        assert!(matches!(rpc.dispatch(&note.to_string()), Some(Incoming::Notification { method, .. }) if method == "item/completed"));
        assert_eq!(rpc.dispatch("not json"), None);
        assert_eq!(rpc.dispatch("{\"id\": 99, \"result\": 1}"), None, "a reply nobody waits for is dropped");
    }

    #[test]
    fn answers_requests_with_results_or_errors() {
        let pipe = Pipe::default();
        let rpc = Rpc::new(pipe.clone());
        rpc.respond(&json!(7), json!({ "decision": "accept" })).unwrap();
        rpc.respond_error(&json!("x"), METHOD_NOT_FOUND, "Not supported").unwrap();
        let sent = pipe.lines();
        assert_eq!(sent[0], json!({ "jsonrpc": "2.0", "id": 7, "result": { "decision": "accept" } }));
        assert_eq!(sent[1]["error"]["code"], METHOD_NOT_FOUND);
    }

    #[test]
    fn a_notification_without_params_sends_none() {
        let pipe = Pipe::default();
        let rpc = Rpc::new(pipe.clone());
        rpc.notify("initialized", Value::Null).unwrap();
        assert_eq!(pipe.lines()[0], json!({ "jsonrpc": "2.0", "method": "initialized" }));
    }

    #[test]
    fn pumps_a_stream_until_it_ends() {
        let rpc = Rpc::new(Pipe::default());
        let failed = Arc::new(Mutex::new(None));
        let sink = failed.clone();
        rpc.request_then("turn/start", json!({}), move |r| *sink.lock().unwrap() = Some(r)).unwrap();
        let stream = "{\"method\":\"turn/started\",\"params\":{}}\n\n{\"method\":\"item/completed\",\"params\":{}}\n";
        let mut seen = Vec::new();
        pump(stream.as_bytes(), &rpc, |incoming| {
            if let Incoming::Notification { method, .. } = incoming {
                seen.push(method);
            }
        });
        assert_eq!(seen, vec!["turn/started", "item/completed"]);
        assert!(failed.lock().unwrap().clone().unwrap().is_err(), "a request still waiting fails when the stream ends");
    }

    #[test]
    fn a_blocking_request_times_out() {
        let rpc = Rpc::new(Pipe::default());
        let err = rpc.request("initialize", json!({}), Duration::from_millis(10)).unwrap_err();
        assert!(err.contains("initialize"));
    }
}
