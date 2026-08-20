import { useEffect, useState } from "react";
import { ArrowUpCircle } from "lucide-react";
import { checkUpdate, onUpdateStatus } from "../lib/api";

/**
 * Notify-only update badge. Kicks off a check on mount and shows a pill when a
 * newer GitHub release exists. (Signed auto-install needs release infra; this is
 * the fail-loud notify path — errors go to updater.log server-side.)
 */
export default function UpdateBadge() {
  const [latest, setLatest] = useState<string | null>(null);

  useEffect(() => {
    const unsub = onUpdateStatus((s) => {
      setLatest(s.available ? s.latest : null);
    });
    checkUpdate().catch(() => {});
    return () => {
      unsub.then((f) => f());
    };
  }, []);

  if (!latest) return null;

  return (
    <span className="update-badge" title={`A newer release (${latest}) is available on GitHub`}>
      <ArrowUpCircle size={13} />
      Update {latest}
    </span>
  );
}
