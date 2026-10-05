import { useEffect, useState } from "react";
import { Power } from "lucide-react";
import { Button, Dialog } from "../design";
import { onQuitRequested, quitApp } from "../lib/api";
import { IS_TAURI } from "../lib/platform";

/**
 * Closing the window keeps agents working (Starkline stays in the menu bar).
 * Quitting stops them, so while any are busy the app asks first.
 */
export default function CloseGuard() {
  const [busy, setBusy] = useState(0);

  useEffect(() => {
    if (!IS_TAURI) return;
    const off = onQuitRequested(setBusy);
    return () => {
      off.then((stop) => stop()).catch(() => undefined);
    };
  }, []);

  const agents = busy === 1 ? "1 agent is" : `${busy} agents are`;
  return (
    <Dialog
      open={busy > 0}
      onClose={() => setBusy(0)}
      tone="attention"
      icon={Power}
      title={`${agents} still working`}
      description="Quitting Starkline stops them, and work they haven't saved is lost. To keep them going, close the window instead: Starkline stays in the menu bar."
      actions={
        <>
          <Button onClick={() => setBusy(0)}>Keep working</Button>
          <Button variant="danger" onClick={() => void quitApp().catch((e) => console.error("[app] couldn't quit", e))}>
            Quit anyway
          </Button>
        </>
      }
    />
  );
}
