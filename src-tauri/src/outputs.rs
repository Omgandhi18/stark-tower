//! What an agent makes during a turn, for the chat to show: files it writes with its
//! tools, and files its reply names that changed while it worked (a chart a script
//! drew, a video it rendered, a report it wrote). Only media and documents, Markdown
//! included, count; code changes already show as file changes. Files the agent shares
//! on purpose are left to that.

use crate::attachments::kind_of;
use crate::chat::Sink;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

/// The most files one turn's output card shows.
pub const MAX_PER_TURN: usize = 8;
/// A file counts as made during a turn if it changed this soon before the turn began
/// (file times are coarse, and a turn's first write can land before we note the start).
const CLOCK_SLACK: Duration = Duration::from_secs(2);

/// File extensions a reply might name as something it made.
const MADE_EXTENSIONS: &str =
    "png|jpe?g|gif|webp|svg|bmp|tiff?|heic|avif|mp4|m4v|mov|webm|mkv|avi|mp3|wav|m4a|aac|ogg|flac|opus|pdf|html?|md|markdown|docx?|xlsx?|pptx?|key|numbers|pages|odt|ods|odp|rtf|epub";

struct Turn {
    sink: Sink,
    cwd: PathBuf,
    started: SystemTime,
    written: Vec<PathBuf>,
    said: String,
    shared: HashSet<PathBuf>,
}

fn turns() -> &'static Mutex<HashMap<String, Turn>> {
    static TURNS: OnceLock<Mutex<HashMap<String, Turn>>> = OnceLock::new();
    TURNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// An agent's turn began, working in `cwd`, its messages going where `sink` says.
pub fn started(agent_id: &str, sink: &Sink, cwd: &str) {
    let turn = Turn { sink: sink.clone(), cwd: PathBuf::from(cwd), started: SystemTime::now(), written: Vec::new(), said: String::new(), shared: HashSet::new() };
    turns().lock().unwrap().insert(agent_id.to_string(), turn);
}

/// Where the agent's current turn posts (its chat, or a delegated task's own conversation).
pub fn sink_for(agent_id: &str) -> Sink {
    turns().lock().unwrap().get(agent_id).map(|t| t.sink.clone()).unwrap_or_else(Sink::chat)
}

/// The folder the agent's current turn works in, if a turn is going.
pub fn cwd_for(agent_id: &str) -> Option<PathBuf> {
    turns().lock().unwrap().get(agent_id).map(|t| t.cwd.clone())
}

/// The agent wrote or edited a file with its tools.
pub fn wrote(agent_id: &str, path: &str) {
    if let Some(turn) = turns().lock().unwrap().get_mut(agent_id) {
        let path = resolve(&turn.cwd, path);
        if !turn.written.contains(&path) {
            turn.written.push(path);
        }
    }
}

/// The agent said something (its reply may name files it made).
pub fn said(agent_id: &str, text: &str) {
    if let Some(turn) = turns().lock().unwrap().get_mut(agent_id) {
        turn.said.push('\n');
        turn.said.push_str(text);
    }
}

/// The agent shared these files on purpose; the turn's card leaves them out.
pub fn shared(agent_id: &str, paths: &[PathBuf]) {
    if let Some(turn) = turns().lock().unwrap().get_mut(agent_id) {
        turn.shared.extend(paths.iter().cloned());
    }
}

/// The turn ended: the media and documents it made, oldest mention first, and how
/// many more there were than the card shows.
pub fn finished(agent_id: &str) -> (Vec<PathBuf>, usize) {
    let Some(turn) = turns().lock().unwrap().remove(agent_id) else { return (Vec::new(), 0) };
    let since = turn.started.checked_sub(CLOCK_SLACK).unwrap_or(turn.started);
    let named = named_paths(&turn.said).into_iter().map(|p| resolve(&turn.cwd, &p));
    let mut made: Vec<PathBuf> = Vec::new();
    for path in turn.written.into_iter().chain(named) {
        let fresh = std::fs::metadata(&path).ok().filter(|m| m.is_file()).and_then(|m| m.modified().ok()).is_some_and(|t| t >= since);
        if fresh && kind_of(&path).is_output() && !turn.shared.contains(&path) && !made.contains(&path) {
            made.push(path);
        }
    }
    let extra = made.len().saturating_sub(MAX_PER_TURN);
    made.truncate(MAX_PER_TURN);
    (made, extra)
}

/// A path an agent gave, as an absolute path (`~/` expanded, relative ones from `cwd`).
pub fn resolve(cwd: &Path, raw: &str) -> PathBuf {
    let raw = raw.trim();
    let expanded = match raw.strip_prefix("~/") {
        Some(rest) => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(rest),
        None => PathBuf::from(raw),
    };
    if expanded.is_absolute() {
        expanded
    } else {
        cwd.join(expanded)
    }
}

/// Paths a reply names with an output's extension: absolute, home-relative or relative.
fn named_paths(text: &str) -> Vec<String> {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        // The character before a path is consumed; the end is only a word boundary, so a
        // path right after another one is still found.
        regex::Regex::new(&format!(r#"(?i)(?:^|[\s`'"(\[<:=])((?:~/|/|\.{{1,2}}/)?[^\s`'"()\[\]<>]*?[^\s`'"()\[\]<>/.,;:!?]\.(?:{MADE_EXTENSIONS}))\b"#))
            .expect("the path pattern compiles")
    });
    let mut found: Vec<String> = Vec::new();
    for capture in pattern.captures_iter(text) {
        let path = capture[1].to_string();
        if !path.contains("://") && !found.contains(&path) {
            found.push(path);
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_names_the_files_it_made() {
        let text = "Saved the chart to `out/chart.png` and the deck to /Users/dev/Deck.pptx.\nAlso see ~/Movies/demo.mp4, report.pdf, [page](site/index.html) and https://example.com/a.png.";
        assert_eq!(named_paths(text), vec!["out/chart.png", "/Users/dev/Deck.pptx", "~/Movies/demo.mp4", "report.pdf", "site/index.html"]);
        assert!(named_paths("Edited src/main.rs and config.toml").is_empty(), "code isn't an output");
        assert_eq!(named_paths("The plan is in docs/PLAN.md."), vec!["docs/PLAN.md"], "Markdown documents are");
        assert_eq!(named_paths("a.png b.png"), vec!["a.png", "b.png"], "neighbours are both found");
    }

    #[test]
    fn a_turn_shows_what_it_made_and_not_what_it_shared_or_only_mentioned() {
        let dir = std::env::temp_dir().join(format!("stark-outputs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("out")).unwrap();
        let old = dir.join("old.png");
        std::fs::write(&old, b"x").unwrap();
        let earlier = SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::options().write(true).open(&old).unwrap().set_modified(earlier).unwrap();

        let agent = "outputs-test-agent";
        started(agent, &Sink::chat(), &dir.to_string_lossy());
        std::fs::write(dir.join("out/chart.png"), b"x").unwrap();
        std::fs::write(dir.join("page.html"), b"<p>").unwrap();
        std::fs::write(dir.join("shared.pdf"), b"%PDF").unwrap();
        std::fs::write(dir.join("main.rs"), b"fn main() {}").unwrap();
        wrote(agent, "page.html");
        wrote(agent, "main.rs");
        said(agent, "Done: out/chart.png, old.png (unchanged) and shared.pdf.");
        shared(agent, &[dir.join("shared.pdf")]);
        let (made, extra) = finished(agent);
        assert_eq!(made, vec![dir.join("page.html"), dir.join("out/chart.png")]);
        assert_eq!(extra, 0);
        assert_eq!(finished(agent), (Vec::new(), 0), "a turn is reported once");
        std::fs::remove_dir_all(&dir).ok();
    }
}
