//! The built-in browser: pages in tabs, shown beside a conversation, that the
//! developer and the agents both use. Each tab is a real browser view (WebKit on macOS),
//! so it keeps its own scroll, history and form input; the active one is laid over the
//! panel the interface draws for it and the rest stay hidden, so any site works. Agents
//! open pages, read them, click, type, run JavaScript, read the console and take
//! screenshots through the `browser` tool. Pages on this Mac (localhost) are
//! theirs to use; a page on the internet goes through the permission gate like
//! any other network access, so the developer's rules for sites apply.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};

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
    /// The page's icon, as an address the interface can show ("" until it has told us one).
    pub favicon: String,
}

/// One tab, as the panel's tab strip shows it.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
pub struct BrowserTab {
    pub id: u32,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub favicon: String,
}

/// The open tabs and which one is showing.
#[derive(Debug, Clone, Default, PartialEq, Serialize, specta::Type)]
pub struct BrowserTabs {
    pub tabs: Vec<BrowserTab>,
    pub active: Option<u32>,
}

/// Where the panel is, in the window's own coordinates.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct BrowserPick {
    pub selector: String,
    pub tag: String,
    pub id: String,
    pub classes: Vec<String>,
    pub role: String,
    pub accessible_name: String,
    pub text: String,
    pub attributes: std::collections::BTreeMap<String, String>,
    pub styles: std::collections::BTreeMap<String, String>,
    pub bounds: Bounds,
    pub url: String,
    pub title: String,
    pub viewport: std::collections::BTreeMap<String, f64>,
    pub device_pixel_ratio: f64,
    pub outer_html: String,
}

#[derive(Debug, Serialize, Deserialize, specta::Type)]
pub struct PickerResult {
    pub active: bool,
    pub pick: Option<BrowserPick>,
    #[serde(default)]
    pub attachment: Option<crate::attachments::Attachment>,
}

/// What the page's picker handed back, checked: a pick needs a real size and viewport.
fn parse_pick(value: Value) -> Result<PickerResult, String> {
    let result: PickerResult = serde_json::from_value(value).map_err(|_| "The page's pick couldn't be read.".to_string())?;
    if let Some(pick) = &result.pick {
        let b = pick.bounds;
        let positive = |n: f64| n.is_finite() && n > 0.0;
        let viewport = ["width", "height"].iter().all(|key| pick.viewport.get(*key).is_some_and(|n| positive(*n)));
        if !(b.x.is_finite() && b.y.is_finite() && positive(b.width) && positive(b.height) && positive(pick.device_pixel_ratio) && viewport) {
            return Err("The element's size couldn't be read.".into());
        }
    }
    Ok(result)
}

/// The picked element with 16 CSS pixels around it, clipped to the viewport, in the view's points at `zoom`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn pick_rect(pick: &BrowserPick, zoom: f64) -> Result<Bounds, String> {
    let b = pick.bounds;
    let (width, height) = (pick.viewport["width"], pick.viewport["height"]);
    let x = (b.x - 16.0).clamp(0.0, width);
    let y = (b.y - 16.0).clamp(0.0, height);
    let right = (b.x + b.width + 16.0).clamp(0.0, width);
    let bottom = (b.y + b.height + 16.0).clamp(0.0, height);
    if right <= x || bottom <= y {
        return Err("The element is outside the visible page.".into());
    }
    Ok(Bounds { x: x * zoom, y: y * zoom, width: (right - x) * zoom, height: (bottom - y) * zoom })
}

/// Ends pointing on a page (the one being left, when the tab changes).
const PICKER_CANCEL: &str = "(() => { window.__starkPicker?.cleanup(); if (window.__starkPicker) window.__starkPicker.pick = null; return {active:false,pick:null}; })()";

/// Start pointing at the page, check for a pick, or stop. A pick is handed back once, with a
/// picture of it on macOS.
pub fn picker(app: &tauri::AppHandle, action: &str) -> Result<PickerResult, String> {
    let script = match action {
        "start" => include_str!("picker.js"),
        "cancel" => PICKER_CANCEL,
        "poll" => "(() => { const s = window.__starkPicker; if (!s) return {active:false,pick:null}; const pick = s.pick; s.pick = null; return {active:s.active,pick}; })()",
        _ => return Err("That picker action isn't available.".into()),
    };
    #[allow(unused_mut)]
    let mut result = parse_pick(run(app, script)?)?;
    #[cfg(target_os = "macos")]
    if let Some(pick) = &result.pick {
        // The words matter most: a pick still reaches the chat when its picture can't be taken.
        match picture(app, pick) {
            Ok(attachment) => result.attachment = Some(attachment),
            Err(e) => eprintln!("[browser] couldn't take a picture of the picked element: {e}"),
        }
    }
    Ok(result)
}

#[cfg(target_os = "macos")]
fn picture(app: &tauri::AppHandle, pick: &BrowserPick) -> Result<crate::attachments::Attachment, String> {
    use base64::Engine;
    let zoom = state(app)?.zoom.lock().unwrap().unwrap_or(1.0);
    let jpeg = snapshot_rect(app, Some(pick_rect(pick, zoom)?))?;
    let data = base64::engine::general_purpose::STANDARD.encode(jpeg);
    crate::attachments::store_data(&crate::attachments::root(app), "browser-point.jpg", &data)
}

struct Tab {
    id: u32,
    view: tauri::Webview,
    page: BrowserPage,
    /// Brought back from the last run but not opened yet: the page loads when the tab is first shown.
    restore: Option<String>,
}

#[derive(Default)]
struct TabList {
    tabs: Vec<Tab>,
    active: Option<u32>,
    /// The last id given out; ids are never reused, so an agent's "tab 2" stays that tab.
    last_id: u32,
}

// The locks are never held while a view is created or driven: the webview calls wait on the
// main thread, where the page callbacks take these same locks.
#[derive(Default)]
pub struct Browser {
    list: Mutex<TabList>,
    zoom: Mutex<Option<f64>>,
    /// Where the active tab is laid; none while the browser is out of the way.
    bounds: Mutex<Option<Bounds>>,
    /// What was last written to disk, so a change that isn't about the tabs doesn't rewrite it.
    saved: Mutex<String>,
    /// Tabs are only written once the last run's have been brought back, or they'd be overwritten.
    saving: std::sync::atomic::AtomicBool,
}

/// Where the open tabs are kept between runs.
const SAVED_FILE: &str = "browser-tabs.json";
/// Longest favicon address kept (a data: icon can be large, and every tab change carries it).
const FAVICON_LIMIT: usize = 4096;

/// A tab as kept between runs: where it was and what it was called.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct SavedTab {
    url: String,
    title: String,
}

/// The open tabs as kept between runs: in order, with the one showing.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct SavedTabs {
    tabs: Vec<SavedTab>,
    active: Option<usize>,
}

/// What to keep of the open tabs. Empty tabs and pages that can't come back (a kept file is
/// served from a port that is gone next run) are left out; the active one moves with them.
fn to_saved(all: &BrowserTabs, keep: impl Fn(&str) -> bool) -> SavedTabs {
    let mut saved = SavedTabs::default();
    for tab in all.tabs.iter().filter(|t| !t.url.is_empty() && keep(&t.url)) {
        if Some(tab.id) == all.active {
            saved.active = Some(saved.tabs.len());
        }
        saved.tabs.push(SavedTab { url: tab.url.clone(), title: tab.title.clone() });
    }
    saved
}

/// The icon address a page reported, if it's one the interface can show: a web address or an inline image.
fn parse_favicon(raw: &str) -> String {
    let address: String = serde_json::from_str(raw).unwrap_or_default();
    let shown = address.starts_with("https://") || address.starts_with("http://") || address.starts_with("data:image/");
    if shown && address.len() <= FAVICON_LIMIT {
        address
    } else {
        String::new()
    }
}

/// Asks a loaded page which icon it has: the one it links, else the site's /favicon.ico.
const FAVICON_SCRIPT: &str = r#"(() => { try {
  const link = document.querySelector('link[rel~="icon"]');
  const href = link && link.getAttribute("href");
  if (href) return new URL(href, location.href).href;
  return /^https?:$/.test(location.protocol) ? location.origin + "/favicon.ico" : "";
} catch (_) { return ""; } })()"#;

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

fn snapshot_tabs(list: &TabList) -> BrowserTabs {
    BrowserTabs {
        tabs: list
            .tabs
            .iter()
            .map(|t| BrowserTab { id: t.id, url: t.page.url.clone(), title: t.page.title.clone(), loading: t.page.loading, favicon: t.page.favicon.clone() })
            .collect(),
        active: list.active,
    }
}

fn changed(app: &tauri::AppHandle) {
    let all = tabs(app);
    let _ = app.emit("browser://changed", &all);
    persist(app, &all);
}

/// Keep the open tabs for the next run, when they've changed.
fn persist(app: &tauri::AppHandle, all: &BrowserTabs) {
    let Ok(s) = state(app) else { return };
    if !s.saving.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let Ok(json) = serde_json::to_string(&to_saved(all, |url| !crate::file_server::serves(url))) else { return };
    let mut last = s.saved.lock().unwrap();
    if *last == json {
        return;
    }
    let file = saved_path(app);
    let temp = file.with_extension("json.tmp");
    if std::fs::write(&temp, &json).and_then(|_| std::fs::rename(&temp, &file)).is_ok() {
        *last = json;
    }
}

fn saved_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join(SAVED_FILE)
}

/// Bring back the tabs the last run had open. The one that was showing opens its page now; the rest
/// open theirs when first shown, so a restart doesn't load every page at once.
pub fn restore(app: &tauri::AppHandle) {
    let Ok(s) = state(app) else { return };
    let text = std::fs::read_to_string(saved_path(app)).ok();
    let saved: SavedTabs = match text.as_deref().map(serde_json::from_str) {
        Some(Ok(saved)) => saved,
        // Nothing kept yet is fine; a file that can't be read is left for the developer, not overwritten.
        Some(Err(_)) => return,
        None => SavedTabs::default(),
    };
    *s.saved.lock().unwrap() = text.unwrap_or_default().trim().to_string();
    let active = saved.active.filter(|i| *i < saved.tabs.len()).unwrap_or(0);
    let mut showing = None;
    for (i, tab) in saved.tabs.iter().enumerate() {
        let Ok(url) = tab.url.parse::<tauri::Url>() else { continue };
        let now = i == active;
        let Ok(id) = create_tab_at(app, now.then_some(url)) else { return };
        if !now {
            if let Some(t) = s.list.lock().unwrap().tabs.iter_mut().find(|t| t.id == id) {
                t.restore = Some(tab.url.clone());
                t.page.url = tab.url.clone();
                t.page.title = tab.title.clone();
            }
        } else {
            showing = Some(id);
            set_page(app, id, |p| {
                p.url = tab.url.clone();
                p.title = tab.title.clone();
                p.loading = true;
            });
        }
    }
    if let Some(id) = showing {
        let _ = activate(app, id);
    }
    s.saving.store(true, std::sync::atomic::Ordering::SeqCst);
    changed(app);
}

/// The open tabs, and the one showing.
pub fn tabs(app: &tauri::AppHandle) -> BrowserTabs {
    state(app).map(|s| snapshot_tabs(&s.list.lock().unwrap())).unwrap_or_default()
}

fn set_page(app: &tauri::AppHandle, id: u32, f: impl FnOnce(&mut BrowserPage)) {
    if let Ok(s) = state(app) {
        if let Some(tab) = s.list.lock().unwrap().tabs.iter_mut().find(|t| t.id == id) {
            f(&mut tab.page);
        }
    }
    changed(app);
}

/// The page in the tab that's showing.
pub fn page(app: &tauri::AppHandle) -> BrowserPage {
    let Ok(s) = state(app) else { return BrowserPage::default() };
    let list = s.list.lock().unwrap();
    list.tabs.iter().find(|t| Some(t.id) == list.active).map(|t| t.page.clone()).unwrap_or_default()
}

/// A new, empty tab (hidden, until the panel places it). It doesn't become the active one.
fn create_tab(app: &tauri::AppHandle) -> Result<u32, String> {
    create_tab_at(app, None)
}

/// A new tab, opened on `url` if given (else blank).
fn create_tab_at(app: &tauri::AppHandle, first: Option<tauri::Url>) -> Result<u32, String> {
    let s = state(app)?;
    let id = {
        let mut list = s.list.lock().unwrap();
        list.last_id += 1;
        list.last_id
    };
    let window = app.get_window("main").ok_or("The main window isn't open.")?;
    let on_load = app.clone();
    let on_title = app.clone();
    let on_new = app.clone();
    let start = match first {
        Some(url) => url,
        None => BLANK.parse().map_err(|_| "bad blank page")?,
    };
    let builder = tauri::WebviewBuilder::new(format!("browser-{id}"), WebviewUrl::External(start))
        .initialization_script(CONSOLE_HOOK)
        .on_page_load(move |view, payload| {
            // A tab brought back from the last run keeps its page and name until it's first shown.
            if awaiting_restore(&on_load, id) {
                return;
            }
            let url = payload.url().to_string();
            let started = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            set_page(&on_load, id, |p| {
                if started {
                    p.favicon.clear();
                }
                p.url = if url == BLANK { String::new() } else { url.clone() };
                p.loading = started;
            });
            if !started && url != BLANK {
                ask_favicon(&on_load, id, &url, view);
            }
        })
        .on_document_title_changed(move |_, title| {
            if !awaiting_restore(&on_title, id) {
                set_page(&on_title, id, |p| p.title = title)
            }
        })
        // A link that would open a new window opens in a new tab instead.
        .on_new_window(move |url, _| {
            let app = on_new.clone();
            let url = url.to_string();
            std::thread::spawn(move || {
                let _ = new_tab(&app, Some(&url));
            });
            tauri::webview::NewWindowResponse::Deny
        });
    let created = window
        .add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
        .map_err(|e| format!("The browser couldn't open: {e}"))?;
    let _ = created.hide();
    s.list.lock().unwrap().tabs.push(Tab { id, view: created, page: BrowserPage::default(), restore: None });
    Ok(id)
}

/// Whether the tab is one brought back that hasn't been opened yet.
fn awaiting_restore(app: &tauri::AppHandle, id: u32) -> bool {
    state(app).map(|s| s.list.lock().unwrap().tabs.iter().any(|t| t.id == id && t.restore.is_some())).unwrap_or(false)
}

/// Ask a loaded page for its icon and record it, unless the tab has moved on by the time it answers.
fn ask_favicon(app: &tauri::AppHandle, id: u32, url: &str, view: tauri::Webview) {
    let (app, url) = (app.clone(), url.to_string());
    // Driving a view waits on the main thread, which is where page callbacks run.
    std::thread::spawn(move || {
        let answer = app.clone();
        let _ = view.eval_with_callback(FAVICON_SCRIPT, move |raw| {
            let icon = parse_favicon(&raw);
            let current = state(&answer).map(|s| s.list.lock().unwrap().tabs.iter().any(|t| t.id == id && t.page.url == url)).unwrap_or(false);
            if current && !icon.is_empty() {
                set_page(&answer, id, |p| p.favicon = icon);
            }
        });
    });
}

/// The tab being acted on: the active one, made (blank) if there are none yet.
fn active_view(app: &tauri::AppHandle) -> Result<(u32, tauri::Webview), String> {
    let s = state(app)?;
    let current = {
        let list = s.list.lock().unwrap();
        list.tabs.iter().find(|t| Some(t.id) == list.active).map(|t| (t.id, t.view.clone()))
    };
    if let Some(found) = current {
        return Ok(found);
    }
    let id = create_tab(app)?;
    activate(app, id)?;
    let view = s.list.lock().unwrap().tabs.iter().find(|t| t.id == id).map(|t| t.view.clone()).ok_or("The browser couldn't open.")?;
    Ok((id, view))
}

/// Make a tab the active one: pointing ends on the page being left, and the new one takes its place.
fn activate(app: &tauri::AppHandle, id: u32) -> Result<(), String> {
    let s = state(app)?;
    let (left, opening) = {
        let mut list = s.list.lock().unwrap();
        if !list.tabs.iter().any(|t| t.id == id) {
            return Err(format!("There is no tab {id}."));
        }
        let left = list.tabs.iter().find(|t| Some(t.id) == list.active && t.id != id).map(|t| t.view.clone());
        list.active = Some(id);
        let opening = list.tabs.iter_mut().find(|t| t.id == id).and_then(|t| t.restore.take().map(|url| (url, t.view.clone())));
        (left, opening)
    };
    if let Some((url, view)) = opening {
        if let Ok(url) = url.parse::<tauri::Url>() {
            let _ = view.navigate(url);
        }
    }
    if let Some(view) = left {
        let _ = view.eval(PICKER_CANCEL);
    }
    changed(app);
    layout(app);
    Ok(())
}

/// Show the active tab over the panel and hide the rest (all of them, while the browser is out of the way).
fn layout(app: &tauri::AppHandle) {
    let Ok(s) = state(app) else { return };
    let bounds = *s.bounds.lock().unwrap();
    let zoom = s.zoom.lock().unwrap().unwrap_or(1.0);
    let views: Vec<(bool, tauri::Webview)> = {
        let list = s.list.lock().unwrap();
        list.tabs.iter().map(|t| (Some(t.id) == list.active && !t.page.url.is_empty(), t.view.clone())).collect()
    };
    for (front, view) in views {
        match bounds {
            Some(b) if front => {
                let _ = view.set_zoom(zoom);
                let _ = view.set_position(LogicalPosition::new(b.x, b.y));
                let _ = view.set_size(LogicalSize::new(b.width.max(1.0), b.height.max(1.0)));
                let _ = view.show();
            }
            _ => {
                let _ = view.hide();
            }
        }
    }
}

/// Place the active tab over the panel and show it.
pub fn show(app: &tauri::AppHandle, bounds: Bounds, zoom: f64) -> Result<(), String> {
    if !zoom.is_finite() || !(0.01..=1.0).contains(&zoom) || [bounds.x, bounds.y, bounds.width, bounds.height].iter().any(|n| !n.is_finite()) {
        return Err("The browser size or zoom is invalid.".into());
    }
    let s = state(app)?;
    *s.zoom.lock().unwrap() = Some(zoom);
    *s.bounds.lock().unwrap() = Some(bounds);
    layout(app);
    Ok(())
}

/// Out of the way: the panel is closed, covered, or on another screen.
pub fn hide(app: &tauri::AppHandle) {
    if let Ok(s) = state(app) {
        *s.bounds.lock().unwrap() = None;
    }
    layout(app);
}

/// Open a new tab and switch to it, on an address if given (as the address bar takes it).
pub fn new_tab(app: &tauri::AppHandle, input: Option<&str>) -> Result<BrowserTabs, String> {
    let url = input.filter(|i| !i.trim().is_empty()).map(|i| address(i).and_then(|u| u.parse::<tauri::Url>().map_err(|_| format!("\"{i}\" isn't an address the browser can open.")))).transpose()?;
    let id = create_tab(app)?;
    activate(app, id)?;
    if let Some(url) = url {
        navigate(app, url.as_str())?;
    }
    Ok(tabs(app))
}

/// Switch to a tab.
pub fn select_tab(app: &tauri::AppHandle, id: u32) -> Result<BrowserTabs, String> {
    activate(app, id)?;
    Ok(tabs(app))
}

/// Which tab is next to show once the one at `index` is closed, out of `remaining` left.
fn after_close(remaining: usize, index: usize) -> Option<usize> {
    (remaining > 0).then(|| index.min(remaining - 1))
}

/// Close a tab; the one beside it takes over if it was showing.
pub fn close_tab(app: &tauri::AppHandle, id: u32) -> Result<BrowserTabs, String> {
    let s = state(app)?;
    let gone = {
        let mut list = s.list.lock().unwrap();
        let index = list.tabs.iter().position(|t| t.id == id).ok_or_else(|| format!("There is no tab {id}."))?;
        let gone = list.tabs.remove(index);
        let next = after_close(list.tabs.len(), index).map(|i| list.tabs[i].id);
        if list.active == Some(id) {
            list.active = next;
        }
        gone
    };
    let _ = gone.view.eval(PICKER_CANCEL);
    let _ = gone.view.close();
    changed(app);
    layout(app);
    Ok(tabs(app))
}

/// Show a page in a tab of its own, or in the tab that's already on it (a kept file opened from a chat).
/// A tab with nothing in it is used rather than left behind.
pub fn open_tab(app: &tauri::AppHandle, input: &str) -> Result<BrowserTabs, String> {
    let url = address(input)?;
    let existing = tabs(app);
    let same = |a: &str| a.trim_end_matches('/') == url.trim_end_matches('/');
    if let Some(tab) = existing.tabs.iter().find(|t| same(&t.url)) {
        return select_tab(app, tab.id);
    }
    match existing.tabs.iter().find(|t| Some(t.id) == existing.active && t.url.is_empty()) {
        Some(_) => {
            navigate(app, &url)?;
            Ok(tabs(app))
        }
        None => new_tab(app, Some(&url)),
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

/// Open an address (as the address bar takes it) in the active tab.
pub fn navigate(app: &tauri::AppHandle, input: &str) -> Result<BrowserPage, String> {
    let url = address(input)?;
    let parsed: tauri::Url = url.parse().map_err(|_| format!("\"{input}\" isn't an address the browser can open."))?;
    let (id, view) = active_view(app)?;
    view.navigate(parsed).map_err(|e| e.to_string())?;
    set_page(app, id, |p| {
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
    active_view(app)?.1.eval(script).map_err(|e| e.to_string())
}

/// Run a script on the page and hand back what it returned.
fn run(app: &tauri::AppHandle, body: &str) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(Some(tx));
    active_view(app)?
        .1
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
fn allowed(app: &tauri::AppHandle, who: &crate::runs::Actor, url: &str) -> Result<(), String> {
    if url.is_empty() || url == BLANK || crate::gate::is_local_url(url) {
        return Ok(());
    }
    let verdict = crate::bridge::decide(app, who, "WebFetch", &json!({ "url": url }));
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

/// The open tabs as an agent lists them, the one it's acting on marked.
fn describe_tabs(all: &BrowserTabs) -> String {
    if all.tabs.is_empty() {
        return "No tabs are open.".into();
    }
    let lines: Vec<String> = all
        .tabs
        .iter()
        .map(|t| {
            let name = match (t.title.trim(), t.url.as_str()) {
                (_, "") => "(empty)".to_string(),
                ("", url) => url.to_string(),
                (title, url) => format!("\"{title}\" ({url})"),
            };
            format!("[{}] {}{}", t.id, name, if Some(t.id) == all.active { "  <- you are here" } else { "" })
        })
        .collect();
    format!("Tabs:\n{}", lines.join("\n"))
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
            allowed(app, &crate::bridge::actor_for(agent_id, args), &url)?;
            navigate(app, &url)?;
            let _ = app.emit("browser://reveal", json!({ "agentId": agent_id }));
            settle(app);
            Ok(Outcome::Text(format!("{} Use `read` to see it.", describe(&page(app)))))
        }
        "tabs" => Ok(Outcome::Text(describe_tabs(&tabs(app)))),
        "new_tab" => {
            let url = args.get("url").and_then(|u| u.as_str()).filter(|u| !u.trim().is_empty());
            if let Some(url) = url {
                allowed(app, &crate::bridge::actor_for(agent_id, args), &address(url)?)?;
            }
            new_tab(app, url)?;
            let _ = app.emit("browser://reveal", json!({ "agentId": agent_id }));
            if url.is_some() {
                settle(app);
            }
            Ok(Outcome::Text(format!("Opened a new tab and switched to it. {}", describe_tabs(&tabs(app)))))
        }
        "switch_tab" => {
            let id = args.get("tab").and_then(|t| t.as_u64().or_else(|| t.as_str().and_then(|s| s.trim().parse().ok())));
            let id = id.and_then(|n| u32::try_from(n).ok()).ok_or("Say which tab: `tab`, its number from `tabs`.")?;
            select_tab(app, id)?;
            Ok(Outcome::Text(format!("Switched to tab {id}. {}", describe(&page(app)))))
        }
        "back" | "forward" | "reload" => {
            go(app, action)?;
            settle(app);
            Ok(Outcome::Text(describe(&page(app))))
        }
        "read" => {
            allowed(app, &crate::bridge::actor_for(agent_id, args), &current)?;
            Ok(Outcome::Text(format_read(&run(app, READ)?)))
        }
        "click" => {
            allowed(app, &crate::bridge::actor_for(agent_id, args), &current)?;
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
            allowed(app, &crate::bridge::actor_for(agent_id, args), &current)?;
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
            allowed(app, &crate::bridge::actor_for(agent_id, args), &current)?;
            let script = args.get("script").and_then(|s| s.as_str()).unwrap_or("").trim();
            if script.is_empty() {
                return Err("Give the JavaScript to run as `script`: an expression, or statements inside (() => { ... })().".into());
            }
            let value = run(app, script)?;
            Ok(Outcome::Text(crate::chat::truncate(&value.to_string(), 12_000)))
        }
        "console" => {
            allowed(app, &crate::bridge::actor_for(agent_id, args), &current)?;
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
            allowed(app, &crate::bridge::actor_for(agent_id, args), &current)?;
            let jpeg = snapshot(app)?;
            Ok(Outcome::Image { jpeg, caption: describe(&page(app)) })
        }
        other => Err(format!("The browser has no \"{other}\" action. Use open, read, click, type, run_js, console, screenshot, back, forward, reload, tabs, new_tab or switch_tab.")),
    }
}

#[cfg(target_os = "macos")]
fn snapshot_rect(app: &tauri::AppHandle, rect: Option<Bounds>) -> Result<Vec<u8>, String> {
    let (tx, rx) = mpsc::channel();
    active_view(app)?
        .1
        .with_webview(move |platform| {
            // SAFETY: on macOS the platform view is the page's WKWebView, alive for this call.
            unsafe { crate::snapshot::capture(platform.inner(), rect, tx) }
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(SCRIPT_TIMEOUT).map_err(|_| "The page didn't give a screenshot in time.".to_string())?
}

#[cfg(target_os = "macos")]
fn snapshot(app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    snapshot_rect(app, None)
}

#[cfg(not(target_os = "macos"))]
fn snapshot(_app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    Err("Screenshots of the browser need macOS.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_picker_results_and_clips_the_snapshot_to_the_zoomed_viewport() {
        let pick = json!({
            "selector":"#save", "tag":"button", "id":"save", "classes":["primary"],
            "role":"button", "accessible_name":"Save", "text":"Save", "attributes":{"type":"submit"},
            "styles":{"padding":"8px"}, "bounds":{"x":-4,"y":10,"width":120,"height":32},
            "url":"http://localhost/settings", "title":"Settings", "viewport":{"width":100,"height":80},
            "device_pixel_ratio":2, "outer_html":"<button id=\"save\">Save</button>"
        });
        let result = parse_pick(json!({"active":false,"pick":pick})).unwrap();
        assert!(result.attachment.is_none());
        let rect = pick_rect(result.pick.as_ref().unwrap(), 0.5).unwrap();
        assert_eq!((rect.x, rect.y, rect.width, rect.height), (0.0, 0.0, 50.0, 29.0));
        assert!(parse_pick(json!({"active":false,"pick":null})).unwrap().pick.is_none());
        assert!(parse_pick(json!({"active":true,"pick":{"selector":"#save"}})).is_err());
        for (path, value) in [("/bounds/width", json!(-1)), ("/viewport/width", Value::Null), ("/device_pixel_ratio", json!(0))] {
            let mut bad = pick.clone();
            *bad.pointer_mut(path).unwrap() = value;
            assert!(parse_pick(json!({"active":false,"pick":bad})).is_err());
        }
        let mut outside = result.pick.unwrap();
        outside.bounds.x = 300.0;
        assert!(pick_rect(&outside, 1.0).is_err());
        assert!(wrapped(include_str!("picker.js")).contains("JSON.stringify"));
    }

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

    fn tab(id: u32, url: &str, title: &str) -> BrowserTab {
        BrowserTab { id, url: url.into(), title: title.into(), loading: false, favicon: String::new() }
    }

    #[test]
    fn tabs_are_kept_in_order_with_the_active_one_and_without_empty_or_unservable_pages() {
        let all = BrowserTabs {
            tabs: vec![tab(1, "https://a.dev/", "A"), tab(2, "", ""), tab(3, "http://127.0.0.1:5555/tok/x.png", "x.png"), tab(4, "http://localhost:5173/", "App")],
            active: Some(4),
        };
        let saved = to_saved(&all, |url| !url.starts_with("http://127.0.0.1:5555/"));
        assert_eq!(saved.tabs, vec![SavedTab { url: "https://a.dev/".into(), title: "A".into() }, SavedTab { url: "http://localhost:5173/".into(), title: "App".into() }]);
        assert_eq!(saved.active, Some(1));
        // A showing tab that can't be kept leaves none marked; the first opens on restore.
        let lost = BrowserTabs { tabs: vec![tab(1, "https://a.dev/", "A"), tab(2, "", "")], active: Some(2) };
        assert_eq!(to_saved(&lost, |_| true).active, None);
        let round: SavedTabs = serde_json::from_str(&serde_json::to_string(&saved).unwrap()).unwrap();
        assert_eq!(round, saved);
    }

    #[test]
    fn a_page_icon_is_shown_only_when_it_is_an_image_address() {
        assert_eq!(parse_favicon("\"https://a.dev/favicon.ico\""), "https://a.dev/favicon.ico");
        assert_eq!(parse_favicon("\"data:image/svg+xml,%3Csvg%3E%3C/svg%3E\""), "data:image/svg+xml,%3Csvg%3E%3C/svg%3E");
        assert_eq!(parse_favicon("\"javascript:alert(1)\""), "");
        assert_eq!(parse_favicon("\"file:///etc/passwd\""), "");
        assert_eq!(parse_favicon("\"\""), "");
        assert_eq!(parse_favicon("null"), "");
        assert_eq!(parse_favicon(&format!("\"data:image/png;base64,{}\"", "A".repeat(FAVICON_LIMIT))), "");
    }

    #[test]
    fn closing_a_tab_hands_over_to_the_one_beside_it() {
        assert_eq!(after_close(0, 0), None);
        assert_eq!(after_close(3, 1), Some(1));
        assert_eq!(after_close(2, 2), Some(1));
    }

    #[test]
    fn agents_see_their_tabs_with_the_active_one_marked() {
        let tab = |id, url: &str, title: &str| BrowserTab { id, url: url.into(), title: title.into(), loading: false, favicon: String::new() };
        assert_eq!(describe_tabs(&BrowserTabs::default()), "No tabs are open.");
        let all = BrowserTabs { tabs: vec![tab(1, "http://localhost:5173/", "App"), tab(3, "", "")], active: Some(3) };
        assert_eq!(describe_tabs(&all), "Tabs:\n[1] \"App\" (http://localhost:5173/)\n[3] (empty)  <- you are here");
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
