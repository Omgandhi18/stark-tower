import { useRef, type ReactNode } from "react";
import { FilePlus2 } from "lucide-react";
import { cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { useFileDrop } from "./useFileDrop";
import type { AttachmentDraft } from "./useAttachmentDraft";

interface FileDropZoneProps {
  draft: AttachmentDraft;
  /** Why files can't be attached right now (a question waits for an answer); drops are then refused. */
  blocked?: string;
  /** What dropping does, said on the overlay. */
  hint?: string;
  className?: string;
  children: ReactNode;
}

/** An area files can be dropped on from Finder; they're attached to the message being written. */
export function FileDropZone({ draft, blocked, hint = "Drop files to attach them", className, children }: FileDropZoneProps) {
  const zoneRef = useRef<HTMLDivElement>(null);
  const { dragging, dropProps } = useFileDrop(zoneRef, {
    onPaths: (paths) => {
      if (!blocked) draft.addPaths(paths);
    },
    onFiles: (files) => {
      if (!blocked) draft.addBlobs(files);
    },
  });
  return (
    <div ref={zoneRef} className={cx("file-drop-zone", className)} {...dropProps}>
      {children}
      {dragging && (
        <div className={cx("file-drop-overlay", blocked && "is-blocked")} role="status">
          <FilePlus2 aria-hidden size={ICON_SIZE.xl} strokeWidth={ICON_STROKE} />
          {blocked ?? hint}
        </div>
      )}
    </div>
  );
}
