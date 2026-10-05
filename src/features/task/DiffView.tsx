import { cx } from "../../design";
import { diffLines } from "./taskPresentation";

/** Longest diff shown inline; the rest is summarised. */
const MAX_LINES = 1500;

export default function DiffView({ diff }: { diff: string }) {
  const lines = diffLines(diff);
  const shown = lines.slice(0, MAX_LINES);
  return (
    <div className="diff-view selectable">
      <pre>
        {shown.map((line, i) => (
          <span key={i} className={cx("diff-line", `is-${line.kind}`)}>
            {line.text || " "}
            {"\n"}
          </span>
        ))}
      </pre>
      {lines.length > MAX_LINES && <p className="diff-more">{lines.length - MAX_LINES} more lines not shown.</p>}
    </div>
  );
}
