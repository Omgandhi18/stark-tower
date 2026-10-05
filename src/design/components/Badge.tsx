import { cx } from "../cx";

export type BadgeTone = "danger" | "attention" | "neutral" | "accent";

interface CountBadgeProps {
  count: number;
  /** What is being counted, for screen readers ("3 items need you"). */
  label: string;
  tone?: BadgeTone;
  className?: string;
  /** Show the badge even at zero (e.g. section headers). */
  showZero?: boolean;
}

const MAX_SHOWN = 99;

/** A small numeric badge. Hidden at zero unless asked. */
export function CountBadge({ count, label, tone = "danger", className, showZero = false }: CountBadgeProps) {
  if (count <= 0 && !showZero) return null;
  const shown = count > MAX_SHOWN ? `${MAX_SHOWN}+` : String(count);
  return (
    <span className={cx("count-badge", `count-badge-${tone}`, className)} aria-label={`${count} ${label}`}>
      {shown}
    </span>
  );
}

interface TagProps {
  children: string;
  tone?: "neutral" | "accent" | "attention" | "danger" | "review" | "success";
  className?: string;
}

/** A quiet label chip (project, type, provider). */
export function Tag({ children, tone = "neutral", className }: TagProps) {
  return <span className={cx("tag", `tag-${tone}`, className)}>{children}</span>;
}
