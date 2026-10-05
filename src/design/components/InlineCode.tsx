import { Fragment } from "react";

/** Text where `backticked` spans read as code (rule names, short reasons). */
export function InlineCode({ text }: { text: string }) {
  const parts = text.split("`");
  // An unmatched backtick leaves the text as it is.
  if (parts.length % 2 === 0) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="inline-code">
            {part}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
