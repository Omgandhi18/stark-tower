import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { AppWindow, Circle, Power, Smartphone } from "lucide-react";
import { Button, EmptyState, IconButton, SelectField, SkeletonRows } from "../../design";
import { simulatorBoot, simulatorFrame, simulatorHome, simulatorOpenApp, simulatorShutdown, simulatorStatus, simulatorTap, simulatorType } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { SimulatorStatus } from "../../lib/types";
import { usePreview } from "../../stores/preview";

/** A pause between screenshots: a few frames a second, without keeping the Mac busy. */
const FRAME_GAP_MS = 250;

/**
 * The iOS Simulator: pick a device, boot it, and watch its screen, refreshed while
 * the panel shows it. Clicks tap the device and the text box types on it (both need idb).
 */
export default function SimulatorView({ active }: { active: boolean }) {
  const chosen = usePreview((s) => s.simulator);
  const choose = usePreview((s) => s.showSimulator);
  const [status, setStatus] = useState<SimulatorStatus | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState("");
  const [busy, setBusy] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);

  const refresh = useCallback(() => {
    simulatorStatus()
      .then(setStatus)
      .catch((e) => setError(errorMessage(e, "The simulators couldn't be listed.")));
  }, []);

  useEffect(() => {
    if (active) refresh();
  }, [active, refresh, chosen]);

  const devices = status?.devices ?? [];
  const device = devices.find((d) => d.udid === chosen) ?? devices.find((d) => d.booted) ?? devices[0] ?? null;
  const running = device?.booted === true;

  // The screen, while it's on show and the device is running.
  useEffect(() => {
    if (!active || !device || !running) return;
    let live = true;
    let timer = 0;
    const next = () => {
      simulatorFrame(device.udid)
        .then((jpeg) => {
          if (!live) return;
          setFrame(`data:image/jpeg;base64,${jpeg}`);
          timer = window.setTimeout(next, FRAME_GAP_MS);
        })
        .catch((e) => live && setError(errorMessage(e, "The simulator's screen couldn't be read.")));
    };
    next();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [active, device, running]);

  const act = (action: () => Promise<unknown>, failure: string, after?: () => void) => {
    setBusy(true);
    setError(null);
    action()
      .then(() => after?.())
      .catch((e) => setError(errorMessage(e, failure)))
      .finally(() => setBusy(false));
  };

  const tap = (e: MouseEvent<HTMLImageElement>) => {
    const img = imageRef.current;
    if (!img || !device) return;
    if (!status?.touch) {
      setError("Taps from Starkline need idb: run `brew install facebook/fb/idb-companion` and `pip3 install fb-idb`. Until then, use Open in Simulator.");
      return;
    }
    const box = img.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * img.naturalWidth;
    const y = ((e.clientY - box.top) / box.height) * img.naturalHeight;
    act(() => simulatorTap(device.udid, device.name, x, y), "The tap didn't go through.");
  };

  const type = (e: FormEvent) => {
    e.preventDefault();
    if (!device || !typing) return;
    act(() => simulatorType(device.udid, typing), "The text didn't go through.", () => setTyping(""));
  };

  if (!status) return <SkeletonRows rows={2} label="Looking for simulators" className="simulator-loading" />;
  if (!status.available || !device) {
    return <EmptyState compact icon={Smartphone} title="No simulator" body={status.problem ?? "Xcode has no iOS simulators."} />;
  }

  return (
    <div className="simulator-view">
      <div className="simulator-toolbar">
        <SelectField
          label="Simulator"
          hideLabel
          icon={Smartphone}
          value={device.udid}
          options={devices.map((d) => ({ value: d.udid, label: `${d.name} · ${d.runtime}${d.booted ? " · running" : ""}` }))}
          onChange={(udid) => {
            setFrame(null);
            choose(udid);
          }}
          className="simulator-device"
        />
        {running ? (
          <>
            <IconButton icon={Circle} label="Home" size="sm" disabled={busy || !status.touch} onClick={() => act(() => simulatorHome(device.udid), "Home didn't go through.")} />
            <IconButton icon={AppWindow} label="Open in Simulator" size="sm" onClick={() => act(() => simulatorOpenApp(device.udid), "The Simulator app couldn't open.")} />
            <IconButton
              icon={Power}
              label="Shut down"
              size="sm"
              disabled={busy}
              onClick={() => act(() => simulatorShutdown(device.udid), "The simulator couldn't shut down.", refresh)}
            />
          </>
        ) : (
          <Button size="sm" variant="primary" icon={Power} disabled={busy} onClick={() => act(() => simulatorBoot(device.udid), "The simulator couldn't start.", refresh)}>
            Boot
          </Button>
        )}
      </div>
      {error && (
        <p className="field-error simulator-error" role="alert">
          {error}
        </p>
      )}
      <div className="simulator-screen">
        {running && frame ? (
          <img ref={imageRef} src={frame} alt={`${device.name}'s screen`} className="simulator-frame" onClick={tap} draggable={false} />
        ) : running ? (
          <SkeletonRows rows={2} label="Reading the screen" />
        ) : (
          <EmptyState compact icon={Smartphone} title={`${device.name} isn't running`} body="Boot it to see its screen here, or ask an agent to build and run your app on it." />
        )}
      </div>
      {running && status.touch && (
        <form className="simulator-type" onSubmit={type}>
          <input className="input" aria-label="Type on the simulator" placeholder="Type on the simulator…" value={typing} onChange={(e) => setTyping(e.target.value)} />
          <Button size="sm" type="submit" disabled={busy || !typing}>
            Send
          </Button>
        </form>
      )}
    </div>
  );
}
