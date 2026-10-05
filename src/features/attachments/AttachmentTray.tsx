import { LoaderCircle, Paperclip, X } from "lucide-react";
import { IconButton, ICON_SIZE, ICON_STROKE } from "../../design";
import { pickFiles } from "../../lib/api";
import { formatSize, KIND_ICON } from "./attachmentFormat";
import { fileUrl } from "./fileUrl";
import "./attachments.css";
import type { AttachmentDraft } from "./useAttachmentDraft";

/** The paperclip: pick files to attach with the macOS picker. */
export function AttachButton({ draft, disabled, title }: { draft: AttachmentDraft; disabled?: boolean; title?: string }) {
  const pick = () => {
    pickFiles("Attach files")
      .then((paths) => draft.addPaths(paths))
      .catch((e) => console.error("[attachments] the file picker failed", e));
  };
  return <IconButton icon={Paperclip} label="Attach files" title={title} size="sm" disabled={disabled} onClick={pick} />;
}

/** The files attached to the message being written, each removable, and any that are still being added. */
export function AttachmentTray({ draft }: { draft: AttachmentDraft }) {
  if (!draft.files.length && !draft.adding && !draft.error) return null;
  return (
    <div className="attachment-tray">
      {(draft.files.length > 0 || draft.adding > 0) && (
        <ul className="attachment-chips" aria-label="Attached files">
          {draft.files.map((file) => {
            const Icon = KIND_ICON[file.kind];
            return (
              <li key={file.path} className="attachment-chip" title={file.name}>
                {file.kind === "image" ? (
                  <img className="attachment-chip-thumb" src={fileUrl(file.path)} alt="" />
                ) : (
                  <span className="attachment-chip-icon" aria-hidden>
                    <Icon size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
                  </span>
                )}
                <span className="attachment-chip-text">
                  <span className="attachment-chip-name">{file.name}</span>
                  <span className="attachment-chip-size">{formatSize(file.size)}</span>
                </span>
                <IconButton icon={X} label={`Remove ${file.name}`} size="sm" onClick={() => draft.remove(file)} />
              </li>
            );
          })}
          {draft.adding > 0 && (
            <li className="attachment-chip is-adding" role="status">
              <LoaderCircle aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} className="spin-slow" />
              Adding {draft.adding === 1 ? "a file" : `${draft.adding} files`}…
            </li>
          )}
        </ul>
      )}
      {draft.error && (
        <p className="attachment-error" role="alert">
          {draft.error}
        </p>
      )}
    </div>
  );
}
