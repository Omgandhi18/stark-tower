import { ExternalLink, FolderOpen, Globe } from "lucide-react";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "../../design";
import type { Attachment } from "../../lib/types";
import { openInBuiltInBrowser } from "../preview/openInBrowser";

const report = (what: string) => (e: unknown) => console.error(`[attachments] couldn't ${what}`, e);

interface FileButtonsProps {
  file: Attachment;
  /** Called once a web page is open in the built-in browser (a viewer over it closes). */
  onOpened?: () => void;
}

/** Open a kept file: a web page in the built-in browser beside the chat, anything else in its own app; or show it in Finder. */
export default function FileButtons({ file, onOpened }: FileButtonsProps) {
  const open = () =>
    file.kind === "html"
      ? openInBuiltInBrowser(file.path).then(() => onOpened?.())
      : openPath(file.path);
  return (
    <>
      <Button size="sm" variant="ghost" icon={file.kind === "html" ? Globe : ExternalLink} onClick={() => void open().catch(report("open the file"))}>
        {file.kind === "html" ? "Open in browser" : "Open"}
      </Button>
      <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => void revealItemInDir(file.path).catch(report("show the file"))}>
        Show in Finder
      </Button>
    </>
  );
}
