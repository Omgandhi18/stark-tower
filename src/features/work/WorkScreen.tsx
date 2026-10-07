import { useCallback, useState } from "react";
import type { Attachment } from "../../lib/types";
import { useNavigation } from "../../stores/navigation";
import AttentionRail from "../attention/AttentionRail";
import { FileDropZone } from "../attachments/FileDropZone";
import { useAttachmentDraft, type FilesUpdate } from "../attachments/useAttachmentDraft";
import Composer from "./Composer";
import WorkBoard from "./WorkBoard";
import "./work.css";

/**
 * Work in the middle (for the project chosen in the sidebar) with the request box under it,
 * what needs you on the right. Files dropped on it go with the next request.
 */
export default function WorkScreen() {
  const project = useNavigation((s) => s.workProject);
  const [attached, setAttached] = useState<Attachment[]>([]);
  const changeFiles = useCallback<FilesUpdate>((change) => setAttached((current) => change(current)), []);
  const attachments = useAttachmentDraft(attached, changeFiles);
  return (
    <div className="work-screen">
      <FileDropZone draft={attachments} className="work-canvas" hint="Drop files to attach them to your request">
        <section className="work-canvas-body" aria-label="Work">
          <WorkBoard project={project} />
          <Composer project={project} attachments={attachments} />
        </section>
      </FileDropZone>
      <AttentionRail />
    </div>
  );
}
