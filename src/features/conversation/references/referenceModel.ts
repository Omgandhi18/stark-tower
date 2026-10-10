// How quotes and points travel with a message. The composer keeps them as chips; what is sent
// (and saved) is plain text: quotes as markdown blockquotes, points as the text pointModel makes,
// then what the developer typed. The transcript reads that text back into cards, so a message
// from before chips existed shows the same way.
import type { Attachment } from "../../../lib/types";
import type { ComposerReference } from "../../../stores/chats";
import { parsePoints, type PointSummary } from "../../preview/pointModel";
import { startsWithCommand } from "../../slash/slashLogic";

/** An excerpt as a markdown blockquote. */
export function quoteMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/** A selection as a clean excerpt: no outer blank space, no runs of empty lines. */
export const tidyExcerpt = (selected: string) => selected.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/**
 * The text the agent receives: each quote and point, then the developer's words. A message that
 * opens with a slash command keeps the command first, since it only expands as the first thing in
 * the message and context in front of it makes the agent run it indirectly; the quotes and points
 * follow, where they read as the command's arguments.
 */
export function composeMessage(references: readonly ComposerReference[], text: string): string {
  const blocks = references.map((ref) => (ref.kind === "quote" ? quoteMarkdown(ref.text) : ref.text.trim()));
  if (!text) return blocks.join("\n\n");
  return (startsWithCommand(text) ? [text, ...blocks] : [...blocks, text]).join("\n\n");
}

/** The files that go with a message: the ones attached, then the marked screenshot of each point. */
export function composeFiles(references: readonly ComposerReference[], files: readonly Attachment[]): Attachment[] {
  const images = references.flatMap((ref) => (ref.kind === "point" && ref.image ? [ref.image] : []));
  return [...files, ...images.filter((image) => !files.some((file) => file.path === image.path))];
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "quote"; text: string }
  | { type: "point"; point: PointSummary; text: string };

/** Blockquote runs in a stretch of plain text, kept apart from the words around them. */
function splitQuotes(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let words: string[] = [];
  let quote: string[] | null = null;
  const flushWords = () => {
    const joined = words.join("\n").trim();
    if (joined) parts.push({ type: "text", text: joined });
    words = [];
  };
  const flushQuote = () => {
    if (quote) parts.push({ type: "quote", text: quote.join("\n").trim() });
    quote = null;
  };
  for (const line of text.split("\n")) {
    const quoted = /^>[ \t]?(.*)$/.exec(line);
    if (quoted) {
      flushWords();
      (quote ??= []).push(quoted[1]);
    } else {
      flushQuote();
      words.push(line);
    }
  }
  flushQuote();
  flushWords();
  return parts.filter((part) => part.type !== "quote" || part.text);
}

/** A message you sent, in the order it reads: quotes, points and your own words. */
export function parseMessage(text: string): MessagePart[] {
  return parsePoints(text).flatMap((part): MessagePart[] => (part.type === "point" ? [part] : splitQuotes(part.text)));
}

/** Whether a message has anything but words, so plain messages keep their plain bubble. */
export const hasReferences = (parts: readonly MessagePart[]) => parts.some((part) => part.type !== "text");

export interface ReferenceLook {
  title: string;
  /** Smaller details beside the title. */
  meta: string[];
}

/** What a chip shows for a reference. */
export function describeReference(ref: ComposerReference): ReferenceLook {
  if (ref.kind === "quote") return { title: ref.text, meta: [] };
  const point = parsePoints(ref.text).find((part) => part.type === "point");
  if (point?.type !== "point") return { title: "A point in the preview", meta: [] };
  return { title: point.point.title, meta: [point.point.place, point.point.size].filter((v): v is string => Boolean(v)) };
}
