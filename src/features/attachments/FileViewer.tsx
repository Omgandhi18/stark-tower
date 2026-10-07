import { Markdown } from "../../design";
import type { Attachment } from "../../lib/types";
import FullscreenViewer from "../viewer/FullscreenViewer";
import FileButtons from "./FileButtons";
import { formatSize, KIND_LABEL, sandboxedHtml } from "./attachmentFormat";
import { fileUrl } from "./fileUrl";
import { useFileText } from "./useFileText";

/** A kept file's words, loaded once it's open. */
function FileText({ file }: { file: Attachment }) {
  const { text, error } = useFileText(file.path);
  if (error) return <p className="viewer-error">{error}</p>;
  if (text === null) return null;
  switch (file.kind) {
    case "html":
      // Scripts run, but in an opaque origin with no network: it can't reach Starkline or your files.
      return <iframe className="viewer-frame" title={file.name} sandbox="allow-scripts" srcDoc={sandboxedHtml(text)} referrerPolicy="no-referrer" />;
    case "markdown":
      return (
        <div className="viewer-document">
          <Markdown text={text} />
        </div>
      );
    default:
      return <pre className="viewer-text selectable">{text}</pre>;
  }
}

function FileStage({ file }: { file: Attachment }) {
  switch (file.kind) {
    case "image":
      return <img className="viewer-image" src={fileUrl(file.path)} alt={file.name} />;
    case "video":
      return <video className="viewer-video" controls autoPlay src={fileUrl(file.path)} aria-label={file.name} />;
    case "pdf":
      return <iframe className="viewer-frame" title={file.name} src={fileUrl(file.path)} />;
    default:
      return <FileText file={file} />;
  }
}

interface FileViewerProps {
  file: Attachment;
  open: boolean;
  onClose: () => void;
}

/** A file an agent made or shared (or you attached), filling the window. */
export default function FileViewer({ file, open, onClose }: FileViewerProps) {
  return (
    <FullscreenViewer open={open} onClose={onClose} title={file.name} subtitle={`${KIND_LABEL[file.kind]} · ${formatSize(file.size)}`} actions={<FileButtons file={file} onOpened={onClose} />}>
      <FileStage file={file} />
    </FullscreenViewer>
  );
}
