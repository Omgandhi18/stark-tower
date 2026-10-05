import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw, RotateCcw, TriangleAlert, Wand2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button, Dialog, Toggle } from "../../design";
import { checkUpdate, loginItemEnabled, resetConfig, setLoginItem, setOnboarded } from "../../lib/api";
import { IS_TAURI } from "../../lib/platform";
import { errorMessage } from "../../lib/errors";
import type { UpdateStatus } from "../../lib/types";
import { useConfig } from "../../stores/config";
import { useSystem } from "../../stores/system";

function updateLine(update: UpdateStatus | null): string {
  if (!update) return "Not checked yet.";
  if (update.error) return `The update check failed: ${update.error}`;
  if (update.available && update.latest) return `Starkline ${update.latest} is available. You have ${update.current}.`;
  return `You're up to date with ${update.current}.`;
}

/** Version and updates, the setup guide, and starting over. */
export default function GeneralSettings() {
  const update = useSystem((s) => s.update);
  const apply = useConfig((s) => s.apply);
  const [checking, setChecking] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [atLogin, setAtLogin] = useState<boolean | null>(null);

  useEffect(() => {
    if (!IS_TAURI) return;
    loginItemEnabled()
      .then(setAtLogin)
      .catch(() => setAtLogin(false));
  }, []);

  const changeLoginItem = (enabled: boolean) => {
    setError(null);
    setLoginItem(enabled)
      .then(setAtLogin)
      .catch((e) => setError(errorMessage(e, "The login setting couldn't be changed.")));
  };

  const check = async () => {
    setChecking(true);
    try {
      await checkUpdate();
    } catch (e) {
      setError(errorMessage(e, "The update check couldn't run."));
    } finally {
      setChecking(false);
    }
  };

  const run = (action: () => Promise<unknown>, failure: string) => {
    setError(null);
    action().catch((e) => setError(errorMessage(e, failure)));
  };

  return (
    <div className="settings-section">
      <header className="screen-header">
        <h1 className="screen-title">General</h1>
      </header>

      <section className="settings-card">
        <h2 className="settings-card-title">Running in the background</h2>
        <p className="settings-card-text">
          Closing the window doesn't stop your agents: Starkline stays in the menu bar and keeps working. Quit it from there or with Command-Q.
        </p>
        <Toggle
          label="Open Starkline when you log in"
          description="It starts in the background, so scheduled automations have somewhere to run."
          checked={atLogin ?? false}
          disabled={atLogin === null}
          onChange={changeLoginItem}
        />
      </section>

      <section className="settings-card">
        <h2 className="settings-card-title">Updates</h2>
        <p className="settings-card-text">{updateLine(update)}</p>
        <div className="settings-card-actions">
          <Button icon={RefreshCw} disabled={checking} onClick={check}>
            Check for updates
          </Button>
          {update?.available && update.url && (
            <Button variant="primary" icon={ExternalLink} onClick={() => run(() => openUrl(update.url ?? ""), "The release page couldn't be opened.")}>
              View release
            </Button>
          )}
        </div>
      </section>

      <section className="settings-card">
        <h2 className="settings-card-title">Setup guide</h2>
        <p className="settings-card-text">Walk through choosing a provider, adding a project and meeting the team again.</p>
        <div className="settings-card-actions">
          <Button icon={Wand2} onClick={() => run(async () => apply(await setOnboarded(false)), "The guide couldn't be opened.")}>
            Show the setup guide
          </Button>
        </div>
      </section>

      <section className="settings-card is-danger">
        <h2 className="settings-card-title">Start over</h2>
        <p className="settings-card-text">Restore the built-in agents and providers. Your projects, chats and task history are kept.</p>
        <div className="settings-card-actions">
          <Button variant="secondary" icon={RotateCcw} onClick={() => setConfirmReset(true)}>
            Reset agents and providers
          </Button>
        </div>
      </section>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}

      <Dialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        tone="danger"
        icon={TriangleAlert}
        title="Reset agents and providers?"
        description="Names, personalities, models and API keys you changed go back to the defaults. This can't be undone."
        actions={
          <>
            <Button onClick={() => setConfirmReset(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmReset(false);
                run(async () => apply(await resetConfig()), "The reset didn't go through.");
              }}
            >
              Reset
            </Button>
          </>
        }
      />
    </div>
  );
}
