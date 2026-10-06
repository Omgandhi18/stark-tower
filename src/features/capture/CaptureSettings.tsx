import { useEffect, useState } from "react";
import { Button, Kbd, TextField, Toggle } from "../../design";
import { captureError, onCaptureError, setCaptureShortcut } from "../../lib/api";
import { IS_TAURI } from "../../lib/platform";
import { errorMessage } from "../../lib/errors";
import { useConfig } from "../../stores/config";
import { recordedShortcut, shortcutLabel } from "./captureModel";
import "./capture.css";

export default function CaptureSettings() {
  const config = useConfig((s) => s.config?.quick_capture);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!IS_TAURI) return;
    let stopped = false;
    void captureError()
      .then((message) => {
        if (!stopped) setError(message);
      })
      .catch(() => {});
    const subscription = onCaptureError(setError);
    return () => {
      stopped = true;
      void subscription.then((off) => off()).catch(() => {});
    };
  }, []);

  const save = async (enabled: boolean, shortcut: string) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      useConfig.getState().apply(await setCaptureShortcut(enabled, shortcut));
      setRecording(false);
    } catch (e) {
      setError(errorMessage(e, "The shortcut couldn't be changed. Try another combination."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-card" aria-label="Quick capture">
      <h2 className="settings-card-title">Quick capture</h2>
      <Toggle
        label="Enable quick capture"
        description="Ask an agent or set a reminder from any app. The menu bar can always open it."
        checked={config?.enabled ?? true}
        disabled={!config || saving}
        onChange={(enabled) => void save(enabled, config?.shortcut ?? "")}
      />
      <div className="capture-shortcut">
        <Kbd>{config?.shortcut ? shortcutLabel(config.shortcut) : "No shortcut"}</Kbd>
        {!recording ? (
          <Button disabled={!config || saving} onClick={() => setRecording(true)}>
            Change shortcut
          </Button>
        ) : (
          <TextField
            label="Quick capture shortcut"
            autoFocus
            readOnly
            value="Press a new combination"
            helper="Include Command, Control or Option. Esc cancels. Backspace clears."
            onKeyDown={(event) => {
              event.preventDefault();
              if (event.key === "Escape") {
                setRecording(false);
                return;
              }
              if (event.key === "Backspace") {
                void save(config?.enabled ?? true, "");
                return;
              }
              const shortcut = recordedShortcut(event);
              if (shortcut) void save(config?.enabled ?? true, shortcut);
            }}
          />
        )}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
