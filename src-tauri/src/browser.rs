//! The built-in browser: one page, shown beside a conversation, that the
//! developer and the agents both use. It's a real browser view (WebKit on macOS)
//! laid over the panel the interface draws for it, so any site works. Agents
//! open pages, read them, click, type, run JavaScript, read the console and take
//! screenshots through the `browser` tool. Pages on this Mac (localhost) are
//! theirs to use; a page on the internet goes through the permission gate like
//! any other network access, so the developer's rules for sites apply.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};

const LABEL: &str = "browser";
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(10);
const LOAD_TIMEOUT: Duration = Duration::from_secs(20);
/// After a click or a key, how long a page gets to start navigating before it counts as settled.
const SETTLE: Duration = Duration::from_millis(400);
const BLANK: &str = "about:blank";
const SEARCH: &str = "https://duckduckgo.com/?q=";

/// The page as the panel shows it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, specta::Type)]
pub struct BrowserPage {
    /// "" before anything has been opened.
    pub url: String,
    pub title: String,
    pub loading: bool,
}

/// Where the panel is, in the window's own coordinates.
#[derive(Debug, Clone, Copy, Deserialize, specta::Type)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Default)]
pub struct Browser {
    view: Mutex<Option<tauri::Webview>>,
    page: Mutex<BrowserPage>,
}

/// Records what the page writes to its console (and its uncaught errors), for agents to read.
const CONSOLE_HOOK: &str = r#"(() => {
  if (window.__starkConsole) return;
  const lines = [];
  window.__starkConsole = lines;
  const keep = (level, args) => {
    try {
      const text = Array.from(args).map((a) => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch (_) { return String(a); } }).join(" ");
      lines.push({ level, text: text.slice(0, 2000) });
      if (lines.length > 200) lines.splice(0, lines.length - 200);
    } catch (_) {}
  };
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level];
    console[level] = function (...args) { keep(level, args); return original.apply(this, args); };
  }
  window.addEventListener("error", (e) => keep("error", [String(e.message) + (e.filename ? " (" + e.filename + ":" + e.lineno + ")" : "")]));
  window.addEventListener("unhandledrejection", (e) => keep("error", ["Unhandled rejection: " + String((e.reason && e.reason.message) || e.reason)]));
})();"#;

/// Helpers every agent script starts with: how a control is named, and finding one.
const PRELUDE: &str = r#"
const __label = (el) => (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.title || el.name || el.alt || "").trim().replace(/\s+/g, " ").slice(0, 80);
const __find = (target, fields) => {
  if (typeof target === "number") return document.querySelector('[data-stark-n="' + target + '"]');
  const text = String(target).trim();
  try { const el = document.querySelector(text); if (el) return el; } catch (_) {}
  const wanted = text.toLowerCase();
  const pool = Array.from(document.querySelectorAll(fields
    ? "input, textarea, select, [contenteditable=true]"
    : "a, button, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], input[type=submit], input[type=button], summary, label"));
  const name = (el) => (__label(el) + " " + (el.getAttribute("placeholder") || "") + " " + (el.getAttribute("name") || "")).toLowerCase();
  return pool.find((el) => __label(el).toLowerCase() === wanted) || pool.find((el) => name(el).includes(wanted)) || null;
};
"#;

/// Reads the page: its text, and its controls numbered for `click` and `type`.
const READ: &str = r#"(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  document.querySelectorAll("[data-stark-n]").forEach((el) => el.removeAttribute("data-stark-n"));
  const controls = [];
  let n = 0;
  for (const el of document.querySelectorAll("a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=menuitem], [contenteditable=true]")) {
    if (el.type === "hidden" || el.disabled || !visible(el)) continue;
    if (++n > 150) break;
    el.setAttribute("data-stark-n", String(n));
    const tag = el.tagName.toLowerCase();
    const kind = tag === "a" ? "link" : tag === "input" ? "input " + (el.type || "text") : tag === "textarea" ? "text area" : (el.getAttribute("role") || tag);
    const field = tag === "input" || tag === "textarea" || tag === "select";
    controls.push({ n, kind, label: __label(el), href: tag === "a" ? el.getAttribute("href") : null, value: field ? String(el.value || "").slice(0, 80) : null });
  }
  const text = (document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n").trim();
  return { url: location.href, title: document.title, text: text.slice(0, 12000), cut: text.length > 12000, controls };
})()"#;

/// A script's result, made safe to hand back: always a JSON string (WebKit can't
/// serialize everything a page might return, and an exception becomes `{error}`).
fn wrapped(body: &str) -> String {
    format!(
        "(() => {{ try {{ {PRELUDE} const __value = ({body}); return JSON.stringify(__value === undefined ? null : __value); }} catch (e) {{ return JSON.stringify({{ error: String((e && e.message) || e) }}); }} }})()"
    )
}

fn state(app: &tauri::AppHandle) -> Result<tauri::State<'_, Browser>, String> {
    app.try_state::<Browser>().ok_or_else(|| "Starkline isn't ready yet.".into())
}

fn changed(app: &tauri::AppHandle) {
    if let Ok(s) = state(app) {
        let page = s.page.lock().unwrap().clone();
        let _ = app.emit("browser://changed", page);
    }
}

fn set_page(app: &tauri::AppHandle, f: impl FnOnce(&mut BrowserPage)) {
    if let Ok(s) = state(app) {
        f(&mut s.page.lock().unwrap());
    }
    changed(app);
}

pub fn page(app: &tauri::AppHandle) -> BrowserPage {
    state(app).map(|s| s.page.lock().unwrap().clone()).unwrap_or_default()
}

/// The browser view, made the first time it's needed (hidden, until the panel places it).
fn view(app: &tauri::AppHandle) -> Result<tauri::Webview, String> {
    let s = state(app)?;
    let mut slot = s.view.lock().unwrap();
    if let Some(view) = slot.as_ref() {
        return Ok(view.clone());
    }
    let window = app.get_window("main").ok_or("The main window isn't open.")?;
    let on_load = app.clone();
    let on_title = app.clone();
    let on_new = app.clone();
    let builder = tauri::WebviewBuilder::new(LABEL, WebviewUrl::External(BLANK.parse().map_err(|_| "bad blank page")?))
        .initialization_script(CONSOLE_HOOK)
        .on_page_load(move |_, payload| {
            let url = payload.url().to_string();
            let loading = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            set_page(&on_load, |p| {
                p.url = if url == BLANK { String::new() } else { url };
                p.loading = loading;
            });
        })
        .on_document_title_changed(move |_, title| set_page(&on_title, |p| p.title = title))
        // The panel is one page: a link that would open a new window opens here instead.
        .on_new_window(move |url, _| {
            let app = on_new.clone();
            let url = url.to_string();
            std::thread::spawn(move || {
                let _ = navigate(&app, &url);
            });
            tauri::webview::NewWindowResponse::Deny
        });
    let created = window
        .add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
        .map_err(|e| format!("The browser couldn't open: {e}"))?;
    let _ = created.hide();
    *slot = Some(created.clone());
    Ok(created)
}

/// Place the browser over the panel and show it.
pub fn show(app: &tauri::AppHandle, bounds: Bounds) -> Result<(), String> {
    let v = view(app)?;
    v.set_position(LogicalPosition::new(bounds.x, bounds.y)).map_err(|e| e.to_string())?;
    v.set_size(LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0))).map_err(|e| e.to_string())?;
    v.show().map_err(|e| e.to_string())
}

/// Out of the way: the panel is closed, covered, or on another screen.
pub fn hide(app: &tauri::AppHandle) {
    if let Some(v) = state(app).ok().and_then(|s| s.view.lock().unwrap().clone()) {
        let _ = v.hide();
    }
}

/// What was typed in the address bar as an address: a web address as it is,
/// "localhost:3000" over http, a bare domain over https, anything else a search.
pub fn address(input: &str) -> Result<String, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("Type an address.".into());
    }
    let lower = text.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Ok(text.to_string());
    }
    if lower.contains("://") || lower.starts_with("javascript:") || lower.starts_with("data:") || lower.starts_with("file:") {
        return Err("The browser opens web pages (http and https) only.".into());
    }
    if !text.contains(char::is_whitespace) {
        let host = text.split(['/', '?', '#']).next().unwrap_or("");
        let host_only = host.split(':').next().unwrap_or("").to_lowercase();
        let local = matches!(host_only.as_str(), "localhost" | "127.0.0.1" | "0.0.0.0" | "[::1]") || host_only.ends_with(".localhost");
        if local {
            return Ok(format!("http://{text}"));
        }
        if host.contains('.') {
            return Ok(format!("https://{text}"));
        }
    }
    let query: String = text
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect();
    Ok(format!("{SEARCH}{query}"))
}

/// Open an address (as the address bar takes it).
pub fn navigate(app: &tauri::AppHandle, input: &str) -> Result<BrowserPage, String> {
    let url = address(input)?;
    let parsed: tauri::Url = url.parse().map_err(|_| format!("\"{input}\" isn't an address the browser can open."))?;
    view(app)?.navigate(parsed).map_err(|e| e.to_string())?;
    set_page(app, |p| {
        p.url = url.clone();
        p.loading = true;
    });
    Ok(page(app))
}

/// Back, forward, reload or stop.
pub fn go(app: &tauri::AppHandle, action: &str) -> Result<(), String> {
    let script = match action {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        "stop" => "window.stop()",
        other => return Err(format!("The browser can't {other}.")),
    };
    view(app)?.eval(script).map_err(|e| e.to_string())
}

/// Run a script on the page and hand back what it returned.
fn run(app: &tauri::AppHandle, body: &str) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(Some(tx));
    view(app)?
        .eval_with_callback(wrapped(body), move |result| {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(result);
            }
        })
        .map_err(|e| e.to_string())?;
    let raw = rx.recv_timeout(SCRIPT_TIMEOUT).map_err(|_| "The page didn't answer in time (it may still be loading).".to_string())?;
    let text: String = serde_json::from_str(&raw).map_err(|_| "The page gave back nothing readable.".to_string())?;
    let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    match value.get("error").and_then(|e| e.as_str()) {
        Some(error) => Err(error.to_string()),
        None => Ok(value),
    }
}

/// Wait for the page to finish loading (a click may or may not navigate).
fn settle(app: &tauri::AppHandle) {
    std::thread::sleep(SETTLE);
    let started = Instant::now();
    while page(app).loading && started.elapsed() < LOAD_TIMEOUT {
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// What an agent's action produced: words, or a picture with a caption.
pub enum Outcome {
    Text(String),
    Image { jpeg: Vec<u8>, caption: String },
}

/// An agent may use a page on this Mac freely; any other page is network access.
fn allowed(app: &tauri::AppHandle, agent_id: &str, url: &str) -> Result<(), String> {
    if url.is_empty() || url == BLANK || crate::gate::is_local_url(url) {
        return Ok(());
    }
    let verdict = crate::bridge::decide(app, agent_id, "WebFetch", &json!({ "url": url }));
    if verdict.approved {
        Ok(())
    } else {
        Err(verdict.reason)
    }
}

fn describe(p: &BrowserPage) -> String {
    match (p.title.trim(), p.url.as_str()) {
        (_, "") => "The browser is empty.".into(),
        ("", url) => format!("Now on {url}."),
        (title, url) => format!("Now on \"{title}\" ({url})."),
    }
}

/// The page as an agent reads it: its words, then its numbered controls.
pub fn format_read(page: &Value) -> String {
    let text = |key: &str| page.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut out = format!("{} ({})\n\n{}", text("title"), text("url"), text("text"));
    if page.get("cut").and_then(|c| c.as_bool()).unwrap_or(false) {
        out.push_str("\n\n(The page goes on; this is the first part.)");
    }
    let controls = page.get("controls").and_then(|c| c.as_array()).cloned().unwrap_or_default();
    if !controls.is_empty() {
        out.push_str("\n\nControls (pass the number as `target` to click or type):");
        for c in controls {
            let n = c.get("n").and_then(|v| v.as_i64()).unwrap_or(0);
            let kind = c.get("kind").and_then(|v| v.as_str()).unwrap_or("");
            let label = c.get("label").and_then(|v| v.as_str()).unwrap_or("");
            out.push_str(&format!("\n[{n}] {kind} \"{label}\""));
            if let Some(href) = c.get("href").and_then(|v| v.as_str()).filter(|h| !h.is_empty()) {
                out.push_str(&format!(" -> {href}"));
            }
            if let Some(value) = c.get("value").and_then(|v| v.as_str()).filter(|v| !v.is_empty()) {
                out.push_str(&format!(" = \"{value}\""));
            }
        }
    }
    out
}

/// An element to act on: a number from `read`, a CSS selector, or its visible words.
fn target_of(args: &Value) -> Result<Value, String> {
    match args.get("target") {
        Some(Value::Number(n)) => Ok(Value::Number(n.clone())),
        Some(Value::String(s)) if s.trim().parse::<i64>().is_ok() => Ok(json!(s.trim().parse::<i64>().unwrap())),
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(json!(s)),
        _ => Err("Say which element: `target`, a number from `read`, a CSS selector, or its words.".into()),
    }
}

/// An agent's `browser` call.
pub fn act(app: &tauri::AppHandle, agent_id: &str, action: &str, args: &Value) -> Result<Outcome, String> {
    let current = page(app).url;
    match action {
        "open" => {
            let url = address(args.get("url").and_then(|u| u.as_str()).unwrap_or(""))?;
            allowed(app, agent_id, &url)?;
            navigate(app, &url)?;
            let _ = app.emit("browser://reveal", json!({ "agentId": agent_id }));
            settle(app);
            Ok(Outcome::Text(format!("{} Use `read` to see it.", describe(&page(app)))))
        }
        "back" | "forward" | "reload" => {
            go(app, action)?;
            settle(app);
            Ok(Outcome::Text(describe(&page(app))))
        }
        "read" => {
            allowed(app, agent_id, &current)?;
            Ok(Outcome::Text(format_read(&run(app, READ)?)))
        }
        "click" => {
            allowed(app, agent_id, &current)?;
            let target = target_of(args)?;
            let clicked = run(
                app,
                &format!(
                    "(() => {{ const el = __find({target}, false); if (!el) return {{ error: 'Nothing on the page matches ' + JSON.stringify({target}) + '. Read the page for its numbered controls.' }}; el.scrollIntoView({{ block: 'center' }}); if (el.focus) el.focus(); el.click(); return {{ clicked: __label(el) || el.tagName.toLowerCase() }}; }})()"
                ),
            )?;
            settle(app);
            let what = clicked.get("clicked").and_then(|c| c.as_str()).unwrap_or("it");
            Ok(Outcome::Text(format!("Clicked \"{what}\". {}", describe(&page(app)))))
        }
        "type" => {
            allowed(app, agent_id, &current)?;
            let target = target_of(args)?;
            let text = json!(args.get("text").and_then(|t| t.as_str()).unwrap_or(""));
            let submit = args.get("submit").and_then(|s| s.as_bool()).unwrap_or(false);
            let typed = run(
                app,
                &format!(
                    "(() => {{ const el = __find({target}, true); if (!el) return {{ error: 'No field on the page matches ' + JSON.stringify({target}) + '. Read the page for its numbered controls.' }};
                      el.focus();
                      if (el.isContentEditable) {{ el.textContent = {text}; el.dispatchEvent(new InputEvent('input', {{ bubbles: true }})); }}
                      else {{
                        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
                        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, {text});
                        el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                        el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                      }}
                      if ({submit}) {{
                        el.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Enter', code: 'Enter', bubbles: true }}));
                        const form = el.form || el.closest('form');
                        if (form) {{ if (form.requestSubmit) form.requestSubmit(); else form.submit(); }}
                      }}
                      return {{ into: __label(el) || el.getAttribute('name') || el.tagName.toLowerCase() }}; }})()"
                ),
            )?;
            if submit {
                settle(app);
            }
            let into = typed.get("into").and_then(|c| c.as_str()).unwrap_or("the field");
            Ok(Outcome::Text(format!("Typed into \"{into}\"{}. {}", if submit { " and submitted" } else { "" }, describe(&page(app)))))
        }
        "run_js" => {
            allowed(app, agent_id, &current)?;
            let script = args.get("script").and_then(|s| s.as_str()).unwrap_or("").trim();
            if script.is_empty() {
                return Err("Give the JavaScript to run as `script`: an expression, or statements inside (() => { ... })().".into());
            }
            let value = run(app, script)?;
            Ok(Outcome::Text(crate::chat::truncate(&value.to_string(), 12_000)))
        }
        "console" => {
            allowed(app, agent_id, &current)?;
            let lines = run(app, "(window.__starkConsole || []).slice(-100)")?;
            let lines = lines.as_array().cloned().unwrap_or_default();
            if lines.is_empty() {
                return Ok(Outcome::Text("Nothing in the console since the page loaded.".into()));
            }
            let text = lines
                .iter()
                .map(|l| format!("[{}] {}", l.get("level").and_then(|v| v.as_str()).unwrap_or("log"), l.get("text").and_then(|v| v.as_str()).unwrap_or("")))
                .collect::<Vec<_>>()
                .join("\n");
            Ok(Outcome::Text(text))
        }
        "screenshot" => {
            allowed(app, agent_id, &current)?;
            let jpeg = snapshot(app)?;
            Ok(Outcome::Image { jpeg, caption: describe(&page(app)) })
        }
        other => Err(format!("The browser has no \"{other}\" action. Use open, read, click, type, run_js, console, screenshot, back, forward or reload.")),
    }
}

#[cfg(target_os = "macos")]
fn snapshot(app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    let (tx, rx) = mpsc::channel();
    view(app)?
        .with_webview(move |platform| {
            // SAFETY: on macOS the platform view is the page's WKWebView, alive for this call.
            unsafe { crate::snapshot::capture(platform.inner(), tx) }
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(SCRIPT_TIMEOUT).map_err(|_| "The page didn't give a screenshot in time.".to_string())?
}

#[cfg(not(target_os = "macos"))]
fn snapshot(_app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    Err("Screenshots of the browser need macOS.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_address_bar_takes_addresses_and_searches() {
        assert_eq!(address("https://example.com/a").unwrap(), "https://example.com/a");
        assert_eq!(address("localhost:5173/settings").unwrap(), "http://localhost:5173/settings");
        assert_eq!(address("127.0.0.1:8080").unwrap(), "http://127.0.0.1:8080");
        assert_eq!(address("react.dev").unwrap(), "https://react.dev");
        assert_eq!(address("react hooks").unwrap(), "https://duckduckgo.com/?q=react+hooks");
        assert!(address("file:///etc/passwd").is_err());
        assert!(address("javascript:alert(1)").is_err());
        assert!(address("  ").is_err());
    }

    #[test]
    fn a_read_page_lists_its_words_and_numbered_controls() {
        let page = json!({
            "url": "http://localhost:5173/",
            "title": "Settings",
            "text": "Account\nNotifications",
            "cut": false,
            "controls": [
                { "n": 1, "kind": "link", "label": "Docs", "href": "/docs", "value": null },
                { "n": 2, "kind": "input text", "label": "Search settings", "href": null, "value": "dark" },
            ],
        });
        let text = format_read(&page);
        assert!(text.starts_with("Settings (http://localhost:5173/)\n\nAccount"));
        assert!(text.contains("[1] link \"Docs\" -> /docs"));
        assert!(text.contains("[2] input text \"Search settings\" = \"dark\""));
    }

    #[test]
    fn scripts_always_hand_back_a_string() {
        let script = wrapped("1 + 1");
        assert!(script.contains("JSON.stringify"));
        assert!(script.contains("catch (e)"));
        assert_eq!(target_of(&json!({ "target": "3" })).unwrap(), json!(3));
        assert_eq!(target_of(&json!({ "target": "#save" })).unwrap(), json!("#save"));
        assert!(target_of(&json!({})).is_err());
    }
}
