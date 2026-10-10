import { useCallback, useEffect, useState, type RefObject } from "react";
import { Quote } from "lucide-react";
import { ICON_SIZE, ICON_STROKE, Kbd } from "../../../design";
import { tidyExcerpt } from "./referenceModel";
import "./references.css";

/** Only an agent's own words can be replied to. */
const QUOTABLE = ".msg-agent, .msg-artifact-caption";
const BUTTON_HEIGHT = 32;
const BUTTON_WIDTH = 132;
const GAP = 8;

interface Anchor {
  text: string;
  /** Viewport position of the button's top-left corner. */
  left: number;
  top: number;
}

const quotableAt = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest(QUOTABLE) ?? null;

/**
 * The selected words that are an agent's prose. A selection that runs across a tool call, a file
 * card or one of your own messages is cut at those rows: only what sits in an agent message stays.
 */
function proseOf(range: Range, selection: Selection): string {
  if (quotableAt(range.commonAncestorContainer)) return selection.toString();
  // Rendered off-screen, so each message's text reads with its own line breaks.
  const holder = document.createElement("div");
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = "position:fixed;left:-9999px;top:0;width:640px;pointer-events:none";
  holder.append(range.cloneContents());
  document.body.append(holder);
  const prose = Array.from(holder.querySelectorAll<HTMLElement>(QUOTABLE))
    .filter((el) => !el.parentElement?.closest(QUOTABLE))
    .map((el) => tidyExcerpt(el.innerText))
    .filter(Boolean);
  holder.remove();
  return prose.join("\n\n");
}

/** The selected words, and where to put the button, if they sit inside agent messages of `column`. */
function readSelection(column: HTMLElement): Anchor | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!column.contains(range.commonAncestorContainer)) return null;
  if (!quotableAt(range.startContainer) || !quotableAt(range.endContainer)) return null;
  const text = tidyExcerpt(proseOf(range, selection));
  if (!text) return null;
  const rect = range.getBoundingClientRect();
  const bounds = column.getBoundingClientRect();
  const above = rect.top - BUTTON_HEIGHT - GAP;
  return {
    text,
    left: Math.max(bounds.left, Math.min(rect.right - BUTTON_WIDTH / 2, bounds.right - BUTTON_WIDTH)),
    top: above > 0 ? above : rect.bottom + GAP,
  };
}

interface SelectionReplyProps {
  /** The transcript the selection must be in. */
  columnRef: RefObject<HTMLElement | null>;
  /** The scroller holding it: the button follows the text as it scrolls. */
  scrollerRef: RefObject<HTMLElement | null>;
  onQuote: (text: string) => void;
}

/**
 * A small "Reply" that appears by selected text in an agent's message and quotes it in the
 * composer. It shows once the selection is made (mouse released, or keys lifted) so it never
 * gets in the way of selecting, and Cmd+Shift+R does the same without the mouse.
 */
export default function SelectionReply({ columnRef, scrollerRef, onQuote }: SelectionReplyProps) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  const refresh = useCallback(() => {
    const column = columnRef.current;
    setAnchor(column ? readSelection(column) : null);
  }, [columnRef]);

  const quote = useCallback(
    (text: string) => {
      onQuote(text);
      window.getSelection()?.removeAllRanges();
      setAnchor(null);
    },
    [onQuote],
  );

  useEffect(() => {
    let dragging = false;
    // Wait a beat after the mouse comes up: the selection settles after the event.
    const settle = () => window.setTimeout(refresh, 0);
    const down = (e: MouseEvent) => {
      dragging = e.target instanceof Node && Boolean(columnRef.current?.contains(e.target));
      if (!(e.target instanceof Element && e.target.closest(".selection-reply"))) setAnchor(null);
    };
    const up = () => {
      if (dragging) settle();
      dragging = false;
    };
    const changed = () => {
      if (!dragging) refresh();
    };
    const keys = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "KeyR") {
        const column = columnRef.current;
        const found = column && readSelection(column);
        if (!found) return;
        e.preventDefault();
        quote(found.text);
      } else if (e.shiftKey) {
        settle();
      }
    };
    const scroller = scrollerRef.current;
    document.addEventListener("mousedown", down);
    document.addEventListener("mouseup", up);
    document.addEventListener("selectionchange", changed);
    document.addEventListener("keydown", keys);
    document.addEventListener("keyup", keys);
    scroller?.addEventListener("scroll", refresh, { passive: true });
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("mouseup", up);
      document.removeEventListener("selectionchange", changed);
      document.removeEventListener("keydown", keys);
      document.removeEventListener("keyup", keys);
      scroller?.removeEventListener("scroll", refresh);
    };
  }, [columnRef, scrollerRef, refresh, quote]);

  if (!anchor) return null;
  return (
    <button
      type="button"
      className="selection-reply"
      style={{ left: anchor.left, top: anchor.top }}
      // Pressing it must not clear the selection it is about to quote.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => quote(anchor.text)}
      aria-label="Reply to the selected text"
    >
      <Quote aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
      Reply
      <Kbd>⌘⇧R</Kbd>
    </button>
  );
}
