// Files in the transcript: what the developer attached, and what agents made or
// shared. Each kind previews in place; every file can be opened in its own app or
// shown in Finder.
import { useEffect, useState } from "react";
import { ExternalLink, FolderOpen, Maximize2 } from "lucide-react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button, Dialog, Markdown, ICON_SIZE, ICON_STROKE, cx } from "../../design";
import { readAttachmentText } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { Attachment } from "../../lib/types";
import { formatSize, KIND_ICON, KIND_LABEL, sandboxedHtml } from "./attachmentFormat";
import { fileUrl } from "./fileUrl";
import "./attachments.css";

/** Text previews show this many lines until expanded. */
const TEXT_PREVIEW_LINES = 40;

const report = (what: string) => (e: unknown) => console.error(`[attachments] couldn't ${what}`, e);

/** The start of a kept text, Markdown or HTML file. */
function useFileText(path: string) {
  const [state, setState] = useState<{ path: string; text: string | null; error: string | null }>({ path, text: null, error: null });
  useEffect(() => {
    let current = true;
    readAttachmentText(path)
      .then((text) => current && setState({ path, text, error: null }))
      .catch((e) => current && setState({ path, text: null, error: errorMessage(e, "The file couldn't be read.") }));
    return () => {
      current = false;
    };
  }, [path]);
  return state.path === path ? state : { path, text: null, error: null };
}

function FileActions({ file }: { file: Attachment }) {
  return (
    <span className="attachment-actions">
      <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => void openPath(file.path).catch(report("open the file"))}>
        {file.kind === "html" ? "Open in browser" : "Open"}
      </Button>
      <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => void revealItemInDir(file.path).catch(report("show the file"))}>
        Show in Finder
      </Button>
    </span>
  );
}

function FileHeader({ file }: { file: Attachment }) {
  const Icon = KIND_ICON[file.kind];
  return (
    <div className="attachment-head">
      <Icon aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} className="attachment-head-icon" />
      <span className="attachment-head-text">
        <span className="attachment-name" title={file.name}>
          {file.name}
        </span>
        <span className="attachment-meta">
          {KIND_LABEL[file.kind]} · {formatSize(file.size)}
        </span>
      </span>
      <FileActions file={file} />
    </div>
  );
}

function ImageView({ file, compact }: { file: Attachment; compact: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <figure className={cx("attachment-image", compact ? "is-compact" : "attachment-card")}>
      {!compact && <FileHeader file={file} />}
      <button type="button" className="attachment-image-button" aria-label={`View ${file.name}`} onClick={() => setOpen(true)}>
        <img src={fileUrl(file.path)} alt={file.name} loading="lazy" />
        <span className="attachment-image-zoom" aria-hidden>
          <Maximize2 size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
        </span>
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title={file.name}
        description={`${KIND_LABEL[file.kind]} · ${formatSize(file.size)}`}
        actions={
          <>
            <FileActions file={file} />
            <Button onClick={() => setOpen(false)}>Close</Button>
          </>
        }
      >
        <img className="attachment-lightbox" src={fileUrl(file.path)} alt={file.name} />
      </Dialog>
    </figure>
  );
}

function HtmlView({ file }: { file: Attachment }) {
  const { text, error } = useFileText(file.path);
  return (
    <div className="attachment-card">
      <FileHeader file={file} />
      {error ? (
        <p className="attachment-error">{error}</p>
      ) : (
        text !== null && (
          // Scripts run, but in an opaque origin with no network: it can't reach Starkline or your files.
          <iframe
            className="attachment-frame"
            title={`Preview of ${file.name}`}
            sandbox="allow-scripts"
            srcDoc={sandboxedHtml(text)}
            referrerPolicy="no-referrer"
          />
        )
      )}
    </div>
  );
}

function MarkdownView({ file }: { file: Attachment }) {
  const { text, error } = useFileText(file.path);
  const [expanded, setExpanded] = useState(false);
  const long = (text?.split("\n").length ?? 0) > TEXT_PREVIEW_LINES;
  return (
    <div className="attachment-card">
      <FileHeader file={file} />
      {error && <p className="attachment-error">{error}</p>}
      {text !== null && (
        <>
          <div className={cx("attachment-document", long && !expanded && "is-clipped")}>
            <Markdown text={text} />
          </div>
          {long && (
            <button type="button" className="attachment-more" onClick={() => setExpanded((e) => !e)}>
              {expanded ? "Show less" : "Show all"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function TextView({ file }: { file: Attachment }) {
  const { text, error } = useFileText(file.path);
  const [expanded, setExpanded] = useState(false);
  const lines = text?.split("\n") ?? [];
  const long = lines.length > TEXT_PREVIEW_LINES;
  return (
    <div className="attachment-card">
      <FileHeader file={file} />
      {error && <p className="attachment-error">{error}</p>}
      {text !== null && (
        <>
          <pre className="attachment-text selectable">{long && !expanded ? lines.slice(0, TEXT_PREVIEW_LINES).join("\n") : text}</pre>
          {long && (
            <button type="button" className="attachment-more" onClick={() => setExpanded((e) => !e)}>
              {expanded ? "Show less" : `Show all ${lines.length} lines`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** One file, previewed as its kind allows. */
export function AttachmentView({ file, compact = false }: { file: Attachment; compact?: boolean }) {
  switch (file.kind) {
    case "image":
      return <ImageView file={file} compact={compact} />;
    case "video":
      return (
        <div className="attachment-card">
          <video className="attachment-video" controls preload="metadata" src={fileUrl(file.path)} aria-label={file.name} />
          <FileHeader file={file} />
        </div>
      );
    case "audio":
      return (
        <div className="attachment-card">
          <FileHeader file={file} />
          <audio className="attachment-audio" controls preload="metadata" src={fileUrl(file.path)} aria-label={file.name} />
        </div>
      );
    case "pdf":
      return compact ? (
        <div className="attachment-card">
          <FileHeader file={file} />
        </div>
      ) : (
        <div className="attachment-card">
          <FileHeader file={file} />
          <iframe className="attachment-frame" title={`Preview of ${file.name}`} src={fileUrl(file.path)} />
        </div>
      );
    case "html":
      return compact ? (
        <div className="attachment-card">
          <FileHeader file={file} />
        </div>
      ) : (
        <HtmlView file={file} />
      );
    case "markdown":
      return compact ? (
        <div className="attachment-card">
          <FileHeader file={file} />
        </div>
      ) : (
        <MarkdownView file={file} />
      );
    case "text":
      return compact ? (
        <div className="attachment-card">
          <FileHeader file={file} />
        </div>
      ) : (
        <TextView file={file} />
      );
    default:
      return (
        <div className="attachment-card">
          <FileHeader file={file} />
        </div>
      );
  }
}

/**
 * A message's files. `compact` (what the developer attached): images as thumbnails,
 * everything else as a card. Otherwise (what an agent made or shared) each previews in full.
 */
export function AttachmentGallery({ files, compact = false }: { files: readonly Attachment[]; compact?: boolean }) {
  const images = compact ? files.filter((f) => f.kind === "image") : [];
  const rest = compact ? files.filter((f) => f.kind !== "image") : files;
  return (
    <div className={cx("attachment-gallery", compact && "is-compact")}>
      {images.length > 0 && (
        <div className="attachment-thumbs">
          {images.map((f) => (
            <AttachmentView key={f.path} file={f} compact />
          ))}
        </div>
      )}
      {rest.map((f) => (
        <AttachmentView key={f.path} file={f} compact={compact} />
      ))}
    </div>
  );
}
