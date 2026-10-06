import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button, IconButton, Popover, SelectField, TextField } from "../../design";
import { devserverCandidates, devserverRestart, devserverSelect, devserverStart, devserverStop } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { Candidates } from "../../lib/types";
import { useDevServers } from "../../stores/devservers";

export default function DevServerToolbar({ folder, outputOpen, toggleOutput }: { folder: string; outputOpen: boolean; toggleOutput: () => void }) {
  const server = useDevServers((s) => s.servers[s.folders[folder] ?? folder]);
  const [found, setFound] = useState<Candidates | null>(null);
  const [custom, setCustom] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!folder) return;
    let stopped = false;
    devserverCandidates(folder)
      .then((c) => {
        if (stopped) return;
        useDevServers.getState().rememberFolder(folder, c.folder);
        setFound(c);
        setCustom(c.custom);
        setEditing(false);
        setError(null);
      })
      .catch((e) => {
        if (!stopped) setError(errorMessage(e, "The dev commands couldn't be read. Check the project folder and try again."));
      });
    return () => {
      stopped = true;
    };
  }, [folder]);

  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e, "The dev server couldn't be changed. Check the command and try again."));
    } finally {
      setBusy(false);
    }
  };
  const choose = (selected: string) =>
    perform(async () => {
      const choices = await devserverSelect(folder, selected, found?.custom ?? "");
      setFound(choices);
    });
  const live = server?.status === "starting" || server?.status === "running";

  return (
    <div className="devserver-controls">
      <div className="browser-toolbar devserver-toolbar" role="group" aria-label="Dev server">
        <span className={`devserver-dot is-${server?.status ?? "stopped"}`} aria-hidden />
        {live ? (
          <>
            <span className="devserver-status" role="status">
              {server.status === "starting" ? "Starting…" : server.address}
            </span>
            <Button size="sm" disabled={busy} onClick={() => void perform(() => devserverStop(folder))}>
              Stop
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void perform(() => devserverRestart(folder))}>
              Restart
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              disabled={!folder || !found?.selected || busy}
              title={found?.options.find((o) => o.id === found.selected)?.command}
              onClick={() => void perform(() => devserverStart(folder, found?.selected))}
            >
              Run
            </Button>
            {server?.status === "crashed" && (
              <span role="status">Crashed{server.exit_code !== null ? ` (exit ${server.exit_code})` : ""}. Check the command and output.</span>
            )}
          </>
        )}
        <Popover
          label="Dev command"
          trigger={(props) => <IconButton {...props} icon={ChevronDown} label="Choose dev command" size="sm" disabled={!folder || busy} />}
        >
          {(close) => (
            <div className="devserver-menu">
              {found?.options.length ? (
                <SelectField
                  label="Dev command"
                  value={found.selected}
                  options={found.options.map((o) => ({ value: o.id, label: `${o.label} — ${o.command}` }))}
                  onChange={(id) => void choose(id)}
                  disabled={busy}
                />
              ) : (
                <p>No dev command found. Use a custom command to run this project.</p>
              )}
              <Button size="sm" onClick={() => setEditing(true)}>
                Use a custom command…
              </Button>
              {editing && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void perform(async () => {
                      const choices = await devserverSelect(folder, "custom", custom);
                      setFound(choices);
                      close();
                    });
                  }}
                >
                  <TextField label="Custom command" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="npm run dev" autoFocus />
                  <Button type="submit" size="sm" disabled={!custom.trim() || busy}>
                    Save command
                  </Button>
                </form>
              )}
            </div>
          )}
        </Popover>
        <Button size="sm" className="devserver-output-toggle" aria-pressed={outputOpen} onClick={toggleOutput}>
          {server?.status === "crashed" && !outputOpen ? "Show output" : "Output"}
        </Button>
      </div>
      {!folder && <p className="browser-error">Choose a folder for this chat to run its dev server.</p>}
      {error && (
        <p className="field-error browser-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
