import { useState } from "react";
import { CircleAlert, CircleCheck, ClipboardCopy, Info, RefreshCw, type LucideIcon } from "lucide-react";
import { Button, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { errorMessage } from "../../lib/errors";
import type { StateTone } from "../../lib/status";
import { useSystem } from "../../stores/system";
import { installSummary, signInSummary } from "./providerDraft";

const COPIED_MS = 1600;

interface CheckRowProps {
  label: string;
  value: string;
  detail?: string;
  tone: StateTone;
}

const TONE_ICON: Partial<Record<StateTone, LucideIcon>> = { success: CircleCheck, danger: CircleAlert, attention: CircleAlert };

function CheckRow({ label, value, detail, tone }: CheckRowProps) {
  const Icon = TONE_ICON[tone] ?? Info;
  return (
    <div className={cx("check-row", `tone-${tone}`)}>
      <Icon aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} className="check-icon" />
      <span className="check-label">{label}</span>
      <span className="check-value">
        {value}
        {detail && <span className="check-detail">{detail}</span>}
      </span>
    </div>
  );
}

/** What the agent runtime can do right now, in plain words, plus a report to share. */
export default function DiagnosticsSettings() {
  const health = useSystem((s) => s.health);
  const refreshHealth = useSystem((s) => s.refreshHealth);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recheck = async () => {
    setChecking(true);
    setError(null);
    try {
      await refreshHealth();
    } catch (e) {
      setError(errorMessage(e, "The runtime couldn't be checked."));
    } finally {
      setChecking(false);
    }
  };

  const copyReport = () => {
    const report = JSON.stringify({ checkedAt: new Date().toISOString(), userAgent: navigator.userAgent, health }, null, 2);
    navigator.clipboard
      .writeText(report)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), COPIED_MS);
      })
      .catch((e) => setError(errorMessage(e, "The report couldn't be copied.")));
  };

  return (
    <div className="settings-section">
      <header className="screen-header">
        <h1 className="screen-title">Diagnostics</h1>
        <p className="screen-subtitle">Whether agents can run, talk to each other and reach you.</p>
      </header>

      <section className="settings-card">
        <div className="settings-card-head">
          <h2 className="settings-card-title">Runtime</h2>
          <Button size="sm" variant="ghost" icon={RefreshCw} disabled={checking} onClick={recheck}>
            Check again
          </Button>
        </div>
        {health ? (
          <div className="check-list">
            <CheckRow
              label="Agent sessions"
              value="Keep running with the window closed"
              detail="They run inside the Starkline app, so quitting it stops them. Interrupted tasks can be continued afterwards."
              tone="success"
            />
            <CheckRow
              label="Node.js"
              value={health.nodePath ? (health.node ? `Installed, ${health.node}` : "Installed") : "Not found"}
              detail={
                health.nodePath ? health.nodePath : "Agents need it to delegate, ask you questions and request approval. Install Node.js, then check again."
              }
              tone={health.nodePath ? "success" : "danger"}
            />
            <CheckRow
              label="Local data"
              value={health.dataStore ? "Reading and writing" : "Not responding"}
              detail={health.dataStore ? undefined : "Chats, tasks and saved work can't be stored until this recovers."}
              tone={health.dataStore ? "success" : "danger"}
            />
            <CheckRow
              label="Agent bridge"
              value={health.bridge ? "Listening" : "Not listening"}
              detail={
                health.bridge ? undefined : `Agents can't delegate, ask you questions or request approval for commands. ${health.bridgeError ?? ""}`.trim()
              }
              tone={health.bridge ? "success" : "danger"}
            />
            <CheckRow label="Live sessions" value={health.liveSessions === 1 ? "1 agent session" : `${health.liveSessions} agent sessions`} tone="idle" />
          </div>
        ) : (
          <p className="settings-card-text">Checking the runtime…</p>
        )}
      </section>

      <section className="settings-card">
        <h2 className="settings-card-title">Providers</h2>
        <table className="provider-table">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Status</th>
              <th scope="col">Sign-in</th>
              <th scope="col">Location</th>
            </tr>
          </thead>
          <tbody>
            {(health?.engines ?? []).map((engine) => (
              <tr key={engine.id}>
                <td>{engine.label}</td>
                <td className={cx(!engine.enabled ? "tone-idle" : engine.installed ? "tone-success" : "tone-attention", "provider-table-status")}>
                  {engine.enabled ? installSummary(engine) : "Turned off"}
                </td>
                <td className={cx(engine.signIn?.signedIn ? "tone-success" : engine.signIn ? "tone-attention" : "tone-idle", "provider-table-status")}>
                  {signInSummary(engine) || "Not applicable"}
                </td>
                <td className="mono provider-table-path selectable">{engine.path ?? "Not found"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="settings-card-actions">
        <Button icon={ClipboardCopy} onClick={copyReport} disabled={!health}>
          {copied ? "Copied" : "Copy a report"}
        </Button>
      </div>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
