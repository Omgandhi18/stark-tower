import { lazy, memo, Suspense } from "react";
import { cx } from "../cx";

// The parser and syntax highlighter are large; they load the first time markdown is shown.
const MarkdownRenderer = lazy(() => import("./MarkdownRenderer"));

interface MarkdownProps {
  text: string;
  className?: string;
}

/** Markdown from agents. Shows the plain text until the renderer has loaded. */
export const Markdown = memo(function Markdown({ text, className }: MarkdownProps) {
  return (
    <Suspense fallback={<div className={cx("markdown markdown-plain selectable", className)}>{text}</div>}>
      <MarkdownRenderer text={text} className={className} />
    </Suspense>
  );
});
