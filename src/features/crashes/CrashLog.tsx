import { useState } from "react";
import { CircleCheck, FolderOpen, MessageSquare, OctagonAlert, Wrench } from "lucide-react";
import { Button, EmptyState, IconButton, Tag, ICON_SIZE, ICON_STROKE } from "../../design";
import { revealCrash } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { Crash } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { useAgents } from "../../stores/agents";
import { useCrashes } from "../../stores/crashes";
import { useNavigation } from "../../stores/navigation";
import { crashTimeLabel, newestFirst, presentStatus, undiagnosed } from "./crashModel";
import "./crashes.css";

const CLOCK_MS = 60_000;

/** Starkline's own crash log: when it crashed, what went wrong, and what's being done about it. */
export default function CrashLog() {
  const crashes = useCrashes((s) => s.items);
  const loaded = useCrashes((s) => s.loaded);
  const diagnose = useCrashes((s) => s.diagnose);
  const maintainer = useAgents((s) => s.agents.find((a) => a.kind === "maintenance"));
  const openTask = useNavigation((s) => s.openTask);
  const now = useNow(CLOCK_MS);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = maintainer?.name ?? "the maintenance agent";
  const waiting = undiagnosed(crashes);

  const start = async (ids: string[]) => {
    setStarting(true);
    setError(null);
    try {
      openTask((await diagnose(ids)).id);
    } catch (e) {
      setError(errorMessage(e, "The diagnosis couldn't start."));
    } finally {
      setStarting(false);
    }
  };

  const reveal = (crash: Crash) => {
    revealCrash(crash.folder).catch((e) => setError(errorMessage(e, "The crash's files couldn't be shown.")));
  };

  return (
    <section className="settings-card" aria-labelledby="crash-log-title">
      <div className="settings-card-head">
        <h2 id="crash-log-title" className="settings-card-title">
          Crashes
        </h2>
        {waiting.length > 1 && maintainer && (
          <Button size="sm" variant="ghost" icon={Wrench} disabled={starting} onClick={() => void start(waiting.map((c) => c.id))}>
            Diagnose all {waiting.length}
          </Button>
        )}
      </div>
      <p className="settings-card-text">
        When Starkline quits unexpectedly, it keeps what went wrong and the reports macOS wrote, so {name} can work out why and fix it.
      </p>
      {loaded && crashes.length === 0 ? (
        <EmptyState compact icon={CircleCheck} title="No crashes" body="Starkline hasn't crashed since it started keeping track." />
      ) : (
        <ul className="crash-list" aria-label="Crash log">
          {newestFirst(crashes).map((crash) => {
            const status = presentStatus(crash, maintainer?.name ?? "the maintenance agent");
            return (
              <li key={crash.id} className="crash-row">
                <OctagonAlert aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} className="crash-icon" />
                <div className="crash-text">
                  <span className="crash-when">
                    {crashTimeLabel(crash.crashedAt, now)} · version {crash.version}
                  </span>
                  <span className="crash-reason">{crash.reason}</span>
                  {crash.place && <span className="crash-place">{crash.place}</span>}
                </div>
                <Tag tone={status.tone}>{status.label}</Tag>
                <div className="crash-actions">
                  {crash.status === "diagnosing" && crash.taskId ? (
                    <Button size="sm" icon={MessageSquare} onClick={() => crash.taskId && openTask(crash.taskId)}>
                      Open chat
                    </Button>
                  ) : (
                    <Button size="sm" icon={Wrench} disabled={starting || !maintainer} onClick={() => void start([crash.id])}>
                      Diagnose and fix
                    </Button>
                  )}
                  <IconButton size="sm" icon={FolderOpen} label={`Show the files for the crash ${crashTimeLabel(crash.crashedAt, now).toLowerCase()}`} onClick={() => reveal(crash)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!maintainer && crashes.length > 0 && <p className="settings-card-text">Add a maintenance agent on Agents to have crashes fixed.</p>}
      {error && (
        <p className="crash-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
