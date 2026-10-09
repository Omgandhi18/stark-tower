import { useState } from "react";
import { MessageSquare, OctagonAlert, Wrench } from "lucide-react";
import { Button, Dialog } from "../../design";
import { errorMessage } from "../../lib/errors";
import { useNow } from "../../lib/useNow";
import { useAgents } from "../../stores/agents";
import { useConfig } from "../../stores/config";
import { useCrashes } from "../../stores/crashes";
import { useNavigation } from "../../stores/navigation";
import { crashTime, crashTimeLabel, promptTitle, unasked } from "./crashModel";
import "./crashes.css";

const CLOCK_MS = 60_000;
/** Crashes listed in the question; the rest are counted. */
const LISTED = 3;

/**
 * After Starkline crashed, the next launch asks once: should the maintenance agent work out why
 * and fix it now, in a chat of its own, or should it wait in Settings > Diagnostics?
 */
export default function CrashPrompt() {
  const crashes = useCrashes((s) => s.items);
  const diagnose = useCrashes((s) => s.diagnose);
  const keepForLater = useCrashes((s) => s.keepForLater);
  const onboarded = useConfig((s) => s.config?.onboarded ?? false);
  const maintainer = useAgents((s) => s.agents.find((a) => a.kind === "maintenance"));
  const openTask = useNavigation((s) => s.openTask);
  const now = useNow(CLOCK_MS);
  const [started, setStarted] = useState<{ taskId: string; agent: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = unasked(crashes);
  const ids = pending.map((c) => c.id);
  const name = maintainer?.name ?? "The maintenance agent";

  const later = async () => {
    setBusy(true);
    setError(null);
    try {
      await keepForLater(ids);
    } catch (e) {
      setError(errorMessage(e, "The crashes couldn't be kept for later."));
    } finally {
      setBusy(false);
    }
  };

  const fixNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const task = await diagnose(ids);
      setStarted({ taskId: task.id, agent: name });
    } catch (e) {
      setError(errorMessage(e, "The diagnosis couldn't start."));
    } finally {
      setBusy(false);
    }
  };

  if (started) {
    return (
      <Dialog
        open
        onClose={() => setStarted(null)}
        icon={Wrench}
        title={`${started.agent} is on it`}
        description="They're working out what happened, in a new chat in Starkline's own code. Carry on meanwhile: the chat is on Work, and the crash stays in Settings > Diagnostics."
        actions={
          <>
            <Button onClick={() => setStarted(null)}>Close</Button>
            <Button
              variant="primary"
              icon={MessageSquare}
              onClick={() => {
                openTask(started.taskId);
                setStarted(null);
              }}
            >
              Open the chat
            </Button>
          </>
        }
      />
    );
  }

  const latest = pending[pending.length - 1];
  if (!latest || !onboarded) return null;
  const when = pending.length === 1 ? `It happened ${crashTime(latest.crashedAt, now)}.` : `The last time was ${crashTime(latest.crashedAt, now)}.`;
  const listed = pending.slice(-LISTED).reverse();
  const unlisted = pending.length - listed.length;

  return (
    <Dialog
      open
      size="md"
      tone="attention"
      icon={OctagonAlert}
      // Escape or a click outside keeps them for later: the safe choice.
      onClose={() => void later()}
      dismissible={!busy}
      title={promptTitle(pending.length)}
      description={`${when} ${name} can work out why and fix it in Starkline's code, in a chat of its own, while you carry on.`}
      actions={
        <>
          <Button disabled={busy} onClick={() => void later()}>
            Keep for later
          </Button>
          <Button variant="primary" icon={Wrench} disabled={busy || !maintainer} onClick={() => void fixNow()}>
            Diagnose and fix now
          </Button>
        </>
      }
    >
      <ul className="crash-prompt-list" aria-label="Crashes">
        {listed.map((crash) => (
          <li key={crash.id} className="crash-prompt-item">
            <span className="crash-when">{crashTimeLabel(crash.crashedAt, now)}</span>
            <span className="crash-reason">{crash.reason}</span>
            {crash.place && <span className="crash-place">{crash.place}</span>}
          </li>
        ))}
      </ul>
      {unlisted > 0 && <p className="crash-prompt-more">and {unlisted === 1 ? "1 earlier crash" : `${unlisted} earlier crashes`}</p>}
      {!maintainer && <p className="crash-prompt-note">Add a maintenance agent on Agents to have crashes fixed. Until then they're kept in Settings &gt; Diagnostics.</p>}
      {error && (
        <p className="crash-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
