//! Files in chats: what the developer attaches to a message, and what agents make
//! and share. Every such file is copied into Starkline's attachments folder (one
//! folder per file, keeping its name), so a chat keeps what was there even when the
//! original moves or changes. Agents may read that folder; nothing else in the app
//! data is open to them.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The largest file a chat keeps a copy of.
pub const MAX_FILE_BYTES: u64 = 200 * 1024 * 1024;
/// Images up to this size go to a provider inline (Claude's per-image limit).
pub const INLINE_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// PDFs up to this size go to Claude inline as documents.
pub const INLINE_PDF_BYTES: u64 = 32 * 1024 * 1024;
/// How much of a text or HTML file the chat reads to preview it.
pub const PREVIEW_TEXT_BYTES: u64 = 2 * 1024 * 1024;
/// The attachments folder, inside the app's data folder.
pub const FOLDER: &str = "attachments";
/// Random characters naming each file's own folder.
const ID_LEN: usize = 16;
/// Longest file name kept (characters), extension included.
const NAME_LIMIT: usize = 120;

/// How a file previews in the chat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentKind {
    Image,
    Video,
    Audio,
    Pdf,
    Html,
    /// Markdown documents: shown rendered.
    Markdown,
    /// Plain text, data and source code.
    Text,
    /// Office and iWork documents, e-books: opened in their own app.
    Document,
    File,
}

impl AttachmentKind {
    /// Worth showing the developer when an agent makes one (code and plain files are
    /// already shown as file changes).
    pub fn is_output(self) -> bool {
        !matches!(self, AttachmentKind::Text | AttachmentKind::File)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
pub struct Attachment {
    /// Where the file is kept: Starkline's copy.
    pub path: String,
    pub name: String,
    /// Its media type, e.g. "image/png".
    pub mime: String,
    pub kind: AttachmentKind,
    pub size: u64,
}

/// Media type and preview kind from a file's extension.
fn classify(path: &Path) -> (&'static str, AttachmentKind) {
    use AttachmentKind::*;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => ("image/png", Image),
        "jpg" | "jpeg" => ("image/jpeg", Image),
        "gif" => ("image/gif", Image),
        "webp" => ("image/webp", Image),
        "svg" => ("image/svg+xml", Image),
        "bmp" => ("image/bmp", Image),
        "tif" | "tiff" => ("image/tiff", Image),
        "heic" => ("image/heic", Image),
        "avif" => ("image/avif", Image),
        "ico" => ("image/x-icon", Image),
        "mp4" => ("video/mp4", Video),
        "m4v" => ("video/x-m4v", Video),
        "mov" => ("video/quicktime", Video),
        "webm" => ("video/webm", Video),
        "mkv" => ("video/x-matroska", Video),
        "avi" => ("video/x-msvideo", Video),
        "mp3" => ("audio/mpeg", Audio),
        "wav" => ("audio/wav", Audio),
        "m4a" => ("audio/mp4", Audio),
        "aac" => ("audio/aac", Audio),
        "ogg" | "oga" => ("audio/ogg", Audio),
        "flac" => ("audio/flac", Audio),
        "opus" => ("audio/opus", Audio),
        "pdf" => ("application/pdf", Pdf),
        "html" | "htm" => ("text/html", Html),
        "md" | "markdown" => ("text/markdown", Markdown),
        "csv" => ("text/csv", Text),
        "json" => ("application/json", Text),
        "txt" | "log" | "tsv" | "yaml" | "yml" | "toml" | "xml" | "ini" | "conf" | "env" | "sql" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "rs"
        | "py" | "rb" | "go" | "java" | "kt" | "swift" | "c" | "h" | "cc" | "cpp" | "hpp" | "cs" | "php" | "sh" | "zsh" | "bash" | "css" | "scss"
        | "less" | "vue" | "svelte" | "graphql" | "proto" | "lua" | "r" | "dart" | "scala" | "ex" | "exs" | "erl" | "hs" | "clj" | "tex" => {
            ("text/plain", Text)
        }
        "docx" => ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", Document),
        "xlsx" => ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Document),
        "pptx" => ("application/vnd.openxmlformats-officedocument.presentationml.presentation", Document),
        "doc" => ("application/msword", Document),
        "xls" => ("application/vnd.ms-excel", Document),
        "ppt" => ("application/vnd.ms-powerpoint", Document),
        "key" => ("application/x-iwork-keynote-sffkey", Document),
        "numbers" => ("application/x-iwork-numbers-sffnumbers", Document),
        "pages" => ("application/x-iwork-pages-sffpages", Document),
        "odt" => ("application/vnd.oasis.opendocument.text", Document),
        "ods" => ("application/vnd.oasis.opendocument.spreadsheet", Document),
        "odp" => ("application/vnd.oasis.opendocument.presentation", Document),
        "rtf" => ("application/rtf", Document),
        "epub" => ("application/epub+zip", Document),
        _ => ("application/octet-stream", File),
    }
}

/// The preview kind a path would have, from its name alone.
pub fn kind_of(path: &Path) -> AttachmentKind {
    classify(path).1
}

/// Starkline's attachments folder.
pub fn root(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join(FOLDER)
}

/// A file as the chat shows it. None if it isn't a regular file.
pub fn describe(path: &Path) -> Option<Attachment> {
    let meta = std::fs::metadata(path).ok().filter(|m| m.is_file())?;
    let (mime, kind) = classify(path);
    Some(Attachment {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name()?.to_string_lossy().into_owned(),
        mime: mime.to_string(),
        kind,
        size: meta.len(),
    })
}

/// A file name that's safe as one path component and not too long.
fn safe_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if c == '/' || c == '\\' || c == '\0' || c.is_control() { '_' } else { c }).collect();
    let trimmed = cleaned.trim().trim_start_matches('.');
    let name = if trimmed.is_empty() { "file" } else { trimmed };
    if name.chars().count() <= NAME_LIMIT {
        return name.to_string();
    }
    let path = Path::new(name);
    let ext = path.extension().and_then(|e| e.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    let keep = NAME_LIMIT.saturating_sub(ext.chars().count());
    let stem: String = name.chars().take(keep).collect();
    format!("{stem}{ext}")
}

fn random_id() -> String {
    let mut bytes = [0u8; ID_LEN / 2];
    let filled = std::fs::File::open("/dev/urandom").and_then(|mut f| std::io::Read::read_exact(&mut f, &mut bytes)).is_ok();
    if !filled {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        bytes.copy_from_slice(&nanos.to_le_bytes()[..ID_LEN / 2]);
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A new, empty folder for one file.
fn new_slot(root: &Path) -> Result<PathBuf, String> {
    let slot = root.join(random_id());
    std::fs::create_dir_all(&slot).map_err(|e| format!("The attachments folder couldn't be written ({e})."))?;
    Ok(slot)
}

fn too_big(name: &str, size: u64) -> String {
    format!("{name} is {} MB; files up to {} MB can be attached.", size / (1024 * 1024), MAX_FILE_BYTES / (1024 * 1024))
}

/// Keep a copy of a file in the attachments folder.
pub fn store_copy(root: &Path, source: &Path) -> Result<Attachment, String> {
    let shown = source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| source.to_string_lossy().into_owned());
    let meta = std::fs::metadata(source).map_err(|_| format!("{shown} can't be found."))?;
    if !meta.is_file() {
        return Err(format!("{shown} is a folder; attach the files in it instead."));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(too_big(&shown, meta.len()));
    }
    let slot = new_slot(root)?;
    let dest = slot.join(safe_name(&shown));
    std::fs::copy(source, &dest).map_err(|e| format!("{shown} couldn't be copied ({e})."))?;
    describe(&dest).ok_or_else(|| format!("{shown} couldn't be read after copying."))
}

/// Keep bytes the developer pasted or dropped (a screenshot, say) as a file.
pub fn store_data(root: &Path, name: &str, base64_data: &str) -> Result<Attachment, String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64_data.trim()).map_err(|_| "That file's contents couldn't be read.".to_string())?;
    let name = safe_name(name);
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(too_big(&name, bytes.len() as u64));
    }
    let slot = new_slot(root)?;
    let dest = slot.join(&name);
    std::fs::write(&dest, bytes).map_err(|e| format!("{name} couldn't be saved ({e})."))?;
    describe(&dest).ok_or_else(|| format!("{name} couldn't be read after saving."))
}

/// Whether a path is one of Starkline's kept files (and not anything else on disk).
pub fn is_kept(root: &Path, path: &Path) -> bool {
    match (root.canonicalize(), path.canonicalize()) {
        (Ok(root), Ok(path)) => path.starts_with(&root) && path != root,
        _ => false,
    }
}

/// Attachments the page sent, re-read from disk: only kept files pass, and their
/// details come from the file rather than from the request.
pub fn checked(root: &Path, attachments: &[Attachment]) -> Result<Vec<Attachment>, String> {
    attachments
        .iter()
        .map(|a| {
            let path = Path::new(&a.path);
            if !is_kept(root, path) {
                return Err(format!("{} isn't one of this chat's attachments.", a.name));
            }
            describe(path).ok_or_else(|| format!("{} is no longer there.", a.name))
        })
        .collect()
}

/// Delete kept files (each with its own folder). Anything outside the folder is left alone.
pub fn remove(root: &Path, attachments: &[Attachment]) {
    for a in attachments {
        let path = Path::new(&a.path);
        if !is_kept(root, path) {
            continue;
        }
        if let Some(slot) = path.parent().filter(|slot| is_kept(root, slot)) {
            let _ = std::fs::remove_dir_all(slot);
        }
    }
}

/// Delete kept files nothing refers to any more (attached to a message that was never
/// sent), once they're older than `older_than`. `in_use` says whether a path is still referred to.
pub fn sweep_unused(root: &Path, in_use: impl Fn(&str) -> bool, older_than: std::time::Duration) -> usize {
    let Ok(slots) = std::fs::read_dir(root) else { return 0 };
    let now = std::time::SystemTime::now();
    let mut removed = 0;
    for slot in slots.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
        let old = std::fs::metadata(&slot).and_then(|m| m.modified()).ok().and_then(|t| now.duration_since(t).ok()).is_some_and(|age| age >= older_than);
        if !old {
            continue;
        }
        let files: Vec<PathBuf> = std::fs::read_dir(&slot).map(|d| d.flatten().map(|e| e.path()).collect()).unwrap_or_default();
        if files.iter().all(|f| !in_use(&f.to_string_lossy())) && std::fs::remove_dir_all(&slot).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// The start of a kept text, Markdown or HTML file, for its preview.
pub fn preview_text(root: &Path, path: &Path) -> Result<String, String> {
    if !is_kept(root, path) {
        return Err("Only a chat's own files can be previewed.".into());
    }
    let file = std::fs::File::open(path).map_err(|_| "The file is no longer there.".to_string())?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(file, PREVIEW_TEXT_BYTES), &mut bytes).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// A line for the agent naming each attached file, so its own tools can open them.
pub fn note_for_agent(attachments: &[Attachment]) -> String {
    if attachments.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = attachments.iter().map(|a| format!("- {} ({}, {})", a.path, a.mime, shown_size(a.size))).collect();
    format!("\n\n[Attached files: read any of them with your tools]\n{}", lines.join("\n"))
}

fn shown_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{} KB", bytes / KB)
    } else {
        format!("{bytes} bytes")
    }
}

/// Image formats every provider accepts inline.
fn inline_image(a: &Attachment) -> bool {
    a.kind == AttachmentKind::Image && matches!(a.mime.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp") && a.size <= INLINE_IMAGE_BYTES
}

/// An image to hand a provider inline: (media type, base64 data).
pub fn image_data(a: &Attachment) -> Option<(String, String)> {
    if !inline_image(a) {
        return None;
    }
    std::fs::read(&a.path).ok().map(|bytes| (a.mime.clone(), base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// A PDF to hand Claude inline, as base64.
pub fn pdf_data(a: &Attachment) -> Option<String> {
    if a.kind != AttachmentKind::Pdf || a.size > INLINE_PDF_BYTES {
        return None;
    }
    std::fs::read(&a.path).ok().map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Whether a provider can take this image inline (otherwise it reads the file by path).
pub fn is_inline_image(a: &Attachment) -> bool {
    inline_image(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("stark-attach-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn copies_keep_the_name_and_know_what_they_are() {
        let dir = tmp("copy");
        let root = dir.join(FOLDER);
        let source = dir.join("Quarterly report.pdf");
        std::fs::write(&source, b"%PDF-1.4 tiny").unwrap();
        let kept = store_copy(&root, &source).unwrap();
        assert_eq!((kept.name.as_str(), kept.mime.as_str(), kept.kind), ("Quarterly report.pdf", "application/pdf", AttachmentKind::Pdf));
        assert!(is_kept(&root, Path::new(&kept.path)));
        assert!(!is_kept(&root, &source), "the original isn't one of ours");
        std::fs::write(&source, b"changed").unwrap();
        assert_eq!(std::fs::read(&kept.path).unwrap(), b"%PDF-1.4 tiny", "the chat keeps what was attached");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pasted_data_becomes_a_file_with_a_safe_name() {
        let dir = tmp("paste");
        let root = dir.join(FOLDER);
        let kept = store_data(&root, "../../etc/screen shot.png", "iVBORw0KGgo=").unwrap();
        assert_eq!(kept.kind, AttachmentKind::Image);
        assert!(kept.name.ends_with("screen shot.png") && !kept.name.contains('/'));
        assert!(is_kept(&root, Path::new(&kept.path)));
        assert!(store_data(&root, "x.png", "not base64!").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn only_kept_files_pass_and_their_details_come_from_disk() {
        let dir = tmp("check");
        let root = dir.join(FOLDER);
        let source = dir.join("notes.md");
        std::fs::write(&source, "# hi").unwrap();
        let kept = store_copy(&root, &source).unwrap();
        let forged = Attachment { size: 1, mime: "image/png".into(), kind: AttachmentKind::Image, ..kept.clone() };
        assert_eq!(checked(&root, &[forged]).unwrap(), vec![kept.clone()]);
        let outside = Attachment { path: source.to_string_lossy().into_owned(), ..kept.clone() };
        assert!(checked(&root, &[outside]).is_err());
        remove(&root, std::slice::from_ref(&kept));
        assert!(!Path::new(&kept.path).exists());
        assert!(source.exists(), "removing never touches files outside the folder");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unused_copies_are_swept_once_old_and_used_ones_stay() {
        let dir = tmp("sweep");
        let root = dir.join(FOLDER);
        let used = store_data(&root, "used.png", "iVBORw0KGgo=").unwrap();
        let unused = store_data(&root, "unused.png", "iVBORw0KGgo=").unwrap();
        let in_use = |p: &str| p == used.path;
        assert_eq!(sweep_unused(&root, in_use, std::time::Duration::from_secs(3600)), 0, "nothing is old enough yet");
        assert_eq!(sweep_unused(&root, in_use, std::time::Duration::ZERO), 1);
        assert!(Path::new(&used.path).exists());
        assert!(!Path::new(&unused.path).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_agent_hears_where_each_file_is() {
        let a = Attachment { path: "/x/a.csv".into(), name: "a.csv".into(), mime: "text/csv".into(), kind: AttachmentKind::Text, size: 2048 };
        assert!(note_for_agent(&[a]).contains("- /x/a.csv (text/csv, 2 KB)"));
        assert_eq!(note_for_agent(&[]), "");
    }

    #[test]
    fn outputs_are_media_and_documents_not_code() {
        for (name, output) in [("a.png", true), ("b.mp4", true), ("c.pdf", true), ("d.html", true), ("e.docx", true), ("h.md", true), ("f.ts", false), ("g.bin", false)] {
            assert_eq!(kind_of(Path::new(name)).is_output(), output, "{name}");
        }
    }
}
