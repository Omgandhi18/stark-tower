import { useEffect, useId, useState } from "react";
import { Circle, FileText, Moon, Square, Video } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button, Dialog, IconButton, OverflowMenu, SelectField, TextArea, TextField, ICON_SIZE, ICON_STROKE } from "../../design";
import { onSimulatorLogs, simulatorExtra } from "../../lib/api";
import type { ExtraState, ExtraArgs } from "../../lib/types";
import { selectQuestionFor, useAttention } from "../../stores/attention";
import { useChats, type ChatRef } from "../../stores/chats";
import { errorMessage } from "../../lib/errors";
import { useNow } from "../../lib/useNow";
import { addPoint } from "./pointComposer";

const PRESETS = [
  { label: "Apple Park", value: "37.3349,-122.0090" },
  { label: "London", value: "51.5074,-0.1278" },
  { label: "New York", value: "40.7128,-74.0060" },
  { label: "Tokyo", value: "35.6762,139.6503" },
  { label: "Bengaluru", value: "12.9716,77.5946" },
  { label: "Custom", value: "custom" },
];
const INITIAL: ExtraState = { recording: null, saved: null, appearance: "", last_bundle: "", status_bar: false, logs: "" };

export default function SimulatorTools({ udid, running, active, chat }: { udid: string; running: boolean; active: boolean; chat: ChatRef | null }) {
  const agentId = chat?.agentId ?? null;
  const conversationId = useChats((s) => (chat ? s.threads[chat.key]?.conversationId ?? null : null));
  const question = useAttention(selectQuestionFor(agentId ?? "", conversationId));
  const formId = useId();
  const [state, setState] = useState<ExtraState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [dialog, setDialog] = useState<"location" | "push" | null>(null);
  const [preset, setPreset] = useState(PRESETS[0].value);
  const [latitude, setLatitude] = useState("37.3349");
  const [longitude, setLongitude] = useState("-122.0090");
  const [bundle, setBundle] = useState("");
  const [payload, setPayload] = useState(
    '{\n  "aps": { "alert": { "title": "Test notification", "body": "Your push notification arrived." }, "sound": "default" }\n}',
  );
  const now = useNow(1000);
  const disabled = busy || !running;
  const reason = !running ? "Boot this simulator first" : undefined;
  useEffect(() => {
    if (!active || !running) return;
    let live = true;
    const refresh = () =>
      simulatorExtra(udid, "state")
        .then((s) => {
          if (live) setState(s);
        })
        .catch((e) => {
          if (live) setError(errorMessage(e, "The simulator controls couldn't be read."));
        });
    void refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [udid, running, active]);

  useEffect(() => {
    if (!logsOpen || !active || !running) return;
    let live = true;
    const listener = onSimulatorLogs((e) => {
      if (live && e.udid === udid) setState((s) => ({ ...s, logs: e.text }));
    });
    simulatorExtra(udid, "logs_start")
      .then((s) => {
        if (live) setState(s);
      })
      .catch((e) => {
        if (live) setError(errorMessage(e, "Device logs couldn't start."));
      });
    return () => {
      live = false;
      void listener.then((stop) => stop());
      void simulatorExtra(udid, "logs_stop").catch(() => {});
    };
  }, [udid, logsOpen, active, running]);

  const act = async (action: string, args: ExtraArgs = {}) => {
    setBusy(true);
    setError(null);
    try {
      setState(await simulatorExtra(udid, action, args));
      return true;
    } catch (e) {
      setError(errorMessage(e, "The simulator control failed. Try again."));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const push = async () => {
    try {
      const value = JSON.parse(payload);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    } catch {
      setError("The push payload must be a JSON object. Fix it before sending.");
      return;
    }
    if (await act("push", { bundle_id: bundle, payload })) setDialog(null);
  };
  const location = async () => {
    if (
      !latitude.trim() ||
      !longitude.trim() ||
      !Number.isFinite(Number(latitude)) ||
      !Number.isFinite(Number(longitude)) ||
      Math.abs(Number(latitude)) > 90 ||
      Math.abs(Number(longitude)) > 180
    ) {
      setError("Enter latitude between −90 and 90 and longitude between −180 and 180.");
      return;
    }
    if (await act("location", { latitude: Number(latitude), longitude: Number(longitude) })) setDialog(null);
  };
  const shownLogs = state.logs
    .split("\n")
    .filter((line) => line.toLowerCase().includes(filter.toLowerCase()))
    .join("\n");
  const seconds = state.recording ? Math.max(0, Math.floor((now - state.recording.started) / 1000)) : 0;
  const errorCopy = error && (
    <p role="alert" className="field-error">
      {error}
    </p>
  );
  return (
    <>
      <div className="simulator-toolbar simulator-extras" title={reason}>
        <IconButton
          icon={state.recording ? Square : Video}
          label={state.recording ? "Stop recording" : "Record a video"}
          size="sm"
          disabled={busy || (!running && !state.recording)}
          onClick={() => void act(state.recording ? "record_stop" : "record_start")}
        />
        {state.recording && (
          <span className="simulator-recording" role="status">
            <Circle aria-hidden size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} fill="currentColor" /> {Math.floor(seconds / 60)}:
            {String(seconds % 60).padStart(2, "0")}
          </span>
        )}
        <IconButton icon={FileText} label="Logs" size="sm" aria-pressed={logsOpen} disabled={disabled} onClick={() => setLogsOpen((on) => !on)} />
        <IconButton
          icon={Moon}
          label="Dark appearance"
          size="sm"
          aria-pressed={state.appearance === "dark"}
          disabled={disabled || !state.appearance}
          onClick={() => void act("appearance", { mode: state.appearance === "dark" ? "light" : "dark" })}
        />
        <OverflowMenu
          label="More simulator actions"
          items={[
            {
              id: "location",
              label: "Set location…",
              disabled,
              onSelect: () => {
                setError(null);
                setDialog("location");
              },
            },
            {
              id: "clear-location",
              label: "Clear location",
              disabled,
              onSelect: () => {
                void act("location", { clear: true });
              },
            },
            {
              id: "push",
              label: "Send a test push…",
              disabled,
              onSelect: () => {
                setBundle(state.last_bundle);
                setError(null);
                setDialog("push");
              },
            },
            {
              id: "status-bar",
              label: state.status_bar ? "Restore status bar" : "Clean status bar",
              disabled,
              onSelect: () => {
                void act("status_bar", { enabled: !state.status_bar });
              },
            },
          ]}
        />
        {!running && <span className="simulator-control-note">Boot this simulator first</span>}
      </div>
      {!dialog && errorCopy}
      {state.saved && (
        <div className="simulator-saved" role="status">
          <span>Recording saved</span>
          <Button
            size="sm"
            disabled={!chat || Boolean(question)}
            title={question ? "Answer the agent’s question first, then add files." : undefined}
            onClick={() => {
              if (chat) addPoint(chat, "", state.saved);
            }}
          >
            Add to chat
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void revealItemInDir(state.saved!.path).catch((e) => setError(errorMessage(e, "The recording couldn't be shown. Try again.")))}
          >
            Show in Finder
          </Button>
        </div>
      )}
      {logsOpen && running && (
        <section className="simulator-logs" aria-label="Device logs">
          <div className="simulator-toolbar">
            <TextField
              label="Filter device logs"
              hideLabel
              placeholder="Process, subsystem or text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <Button
              size="sm"
              onClick={() =>
                void navigator.clipboard.writeText(shownLogs).catch(() => setError("Device logs couldn't be copied. Select and copy the text instead."))
              }
            >
              Copy
            </Button>
            <Button size="sm" onClick={() => void act("logs_clear")}>
              Clear
            </Button>
          </div>
          <pre className="selectable">{shownLogs || "No device logs yet. Use your app to see its messages here."}</pre>
        </section>
      )}
      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        title={dialog === "location" ? "Set location" : "Send a test push"}
        actions={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="primary" type="submit" form={formId} disabled={disabled || (dialog === "push" && !bundle.trim())}>
              {dialog === "location" ? "Set location" : "Send push"}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          onSubmit={(e) => {
            e.preventDefault();
            if (!disabled) void (dialog === "location" ? location() : push());
          }}
        >
          {dialog === "location" ? (
            <div className="simulator-fields">
              <SelectField
                label="Location preset"
                value={preset}
                options={PRESETS}
                onChange={(value) => {
                  setPreset(value);
                  if (value !== "custom") {
                    const [lat, lon] = value.split(",");
                    setLatitude(lat);
                    setLongitude(lon);
                  }
                }}
              />
              <TextField
                label="Latitude"
                value={latitude}
                onChange={(e) => {
                  setLatitude(e.target.value);
                  setPreset("custom");
                }}
              />
              <TextField
                label="Longitude"
                value={longitude}
                onChange={(e) => {
                  setLongitude(e.target.value);
                  setPreset("custom");
                }}
              />
            </div>
          ) : (
            <div className="simulator-fields">
              <TextField label="Bundle id" value={bundle} onChange={(e) => setBundle(e.target.value)} />
              <TextArea label="Push payload" rows={8} value={payload} onChange={(e) => setPayload(e.target.value)} />
            </div>
          )}
          {errorCopy}
        </form>
      </Dialog>
    </>
  );
}
