// How chat files are described and prepared for display; no React, so it's easy to test.
import { File as FileIcon, FileAudio, FileCode, FileImage, FileText, FileType, FileVideo, Globe, type LucideIcon } from "lucide-react";
import type { AttachmentKind } from "../../lib/types";

const KB = 1024;
const MB = KB * 1024;

/** "2.4 MB", "640 KB", "12 bytes". */
export function formatSize(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
}

export const KIND_ICON: Record<AttachmentKind, LucideIcon> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileType,
  html: Globe,
  markdown: FileText,
  text: FileCode,
  document: FileText,
  file: FileIcon,
};

export const KIND_LABEL: Record<AttachmentKind, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  pdf: "PDF",
  html: "Web page",
  markdown: "Markdown",
  text: "Text",
  document: "Document",
  file: "File",
};

/**
 * What an HTML artifact may do in its preview: run its own inline scripts and styles,
 * show inline images and media, and nothing else — no network, no other files. The
 * frame is also sandboxed without same-origin access, so it can't reach Starkline.
 */
export const ARTIFACT_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:";

const POLICY_TAG = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_POLICY}">`;

/** An HTML artifact with the preview policy as the first thing in its head. */
export function sandboxedHtml(html: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}${POLICY_TAG}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (open) => `${open}<head>${POLICY_TAG}</head>`);
  return `${POLICY_TAG}${html}`;
}

/** Pasted images arrive as "image.png"; give them a name that says when. */
export function pastedName(name: string, type: string, at: Date): string {
  if (name && !/^image\.\w+$/i.test(name)) return name;
  const extension = type.split("/")[1]?.split("+")[0] || "png";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Pasted ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} at ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}.${extension}`;
}

/** A file's contents as base64 (what the backend keeps pasted files from). */
export function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("The file couldn't be read."));
    reader.readAsDataURL(file);
  });
}
