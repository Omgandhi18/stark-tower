import { useCallback, useEffect, useRef, useState } from "react";

/** Within this distance of the end, the view counts as "following" new messages. */
const NEAR_END_PX = 48;

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Keeps a scrolling transcript pinned to its newest content while the reader
 * is at the end, and leaves it alone once they scroll back to read.
 */
export function useStickToBottom() {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [atEnd, setAtEnd] = useState(true);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const measure = () => {
      const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= NEAR_END_PX;
      following.current = near;
      setAtEnd(near);
    };
    const follow = () => {
      if (following.current) scroller.scrollTop = scroller.scrollHeight;
    };
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    observer.observe(scroller);
    scroller.addEventListener("scroll", measure, { passive: true });
    follow();
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", measure);
    };
  }, []);

  const jumpToEnd = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    following.current = true;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
  }, []);

  return { scrollerRef, contentRef, atEnd, jumpToEnd };
}
