import { useContext } from "react";
import { useLooks } from "../../stores/looks";
import { cx } from "../cx";
import { PortraitOutfits, portraitUrls, type PortraitKey } from "../portraits";
import { AGENT_STATUS } from "../../lib/status";
import type { AgentStatus } from "../../lib/types";

export type PortraitSize = 20 | 24 | 32 | 40 | 48 | 64;

interface PortraitProps {
  name: string;
  figure?: string | PortraitKey | null;
  size?: PortraitSize;
  /** Shows a small state dot; the state is also stated in text nearby. */
  status?: AgentStatus;
  /** The agent's own colour, used for the initials fallback. */
  accent?: string | null;
  /** Dress them in this theme folder's outfits rather than the app's current ones (Theme Studio's previews). */
  outfits?: string | null;
  className?: string;
}

const initialsOf = (name: string) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

export function Portrait({ name, figure, size = 40, status, accent, outfits, className }: PortraitProps) {
  const current = useContext(PortraitOutfits);
  const looks = useLooks((s) => s.looks);
  const urls = portraitUrls(figure, outfits === undefined ? current : outfits, looks);
  const url = urls[0];
  return (
    <span
      className={cx("portrait", className)}
      style={{ width: size, height: size, fontSize: size, ["--portrait-accent" as string]: accent ?? undefined }}
      aria-hidden
    >
      {url ? <img key={url} src={url} alt="" draggable={false} onError={(e) => {
        const img = e.currentTarget;
        const at = Number(img.dataset.fallback ?? "0") + 1;
        if (urls[at]) { img.dataset.fallback = String(at); img.src = urls[at]; }
        else img.style.visibility = "hidden";
      }} /> : <span className="portrait-initials">{initialsOf(name)}</span>}
      {status && <span className={cx("portrait-dot", `tone-${AGENT_STATUS[status].tone}`)} />}
    </span>
  );
}
