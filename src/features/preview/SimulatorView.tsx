import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { AppWindow, Circle, Copy, Power, Smartphone, MousePointerClick } from "lucide-react";
import { Button, EmptyState, IconButton, InlineCode, SelectField, SkeletonRows } from "../../design";
import {
  attachData,
  simulatorPoint,
  simulatorBoot,
  simulatorFrame,
  simulatorHome,
  simulatorOpenApp,
  simulatorShutdown,
  simulatorStatus,
  simulatorSwipe,
  simulatorTap,
  simulatorType,
} from "../../lib/api";
import { selectQuestionFor, useAttention } from "../../stores/attention";
import { errorMessage } from "../../lib/errors";
import type { SimulatorStatus } from "../../lib/types";
import { useChats } from "../../stores/chats";
import { useNavigation } from "../../stores/navigation";
import SimulatorTools from "./SimulatorTools";
import { addPoint, markedFrame } from "./pointComposer";
import { simulatorPointText } from "./pointModel";
import { usePreview } from "../../stores/preview";

/** A pause between screenshots: a few frames a second, without keeping the Mac busy. */
const FRAME_GAP_MS = 250;
/** A press that moves further than this (in screen pixels) is a swipe, not a tap. */
const SWIPE_AFTER_PX = 10;
const INSTALL_AXE = "brew install cameroncooke/axe/axe";

/** Where a pointer is on the screenshot, in its own pixels. */
function onImage(img: HTMLImageElement, clientX: number, clientY: number): [number, number] {
  const box = img.getBoundingClientRect();
  return [((clientX - box.left) / box.width) * img.naturalWidth, ((clientY - box.top) / box.height) * img.naturalHeight];
}

/**
 * The iOS Simulator: pick a device, boot it, and watch its screen, refreshed while the
 * panel shows it. Click to tap, drag to swipe, and type in the box below (with AXe or idb).
 */
export default function SimulatorView({ active }: { active: boolean }) {
  const agentId = useNavigation(s => s.agentId);
  const question = useAttention(selectQuestionFor(agentId ?? ""));
  const [picking, setPicking] = useState(false);
  const chosen = usePreview((s) => s.simulator);
  const choose = usePreview((s) => s.showSimulator);
  const [status, setStatus] = useState<SimulatorStatus | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const press = useRef<{ x: number; y: number; at: [number, number]; picking: boolean; chat: string | null } | null>(null);

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

  const startPress = (e: PointerEvent<HTMLImageElement>) => {
    const img = imageRef.current;
    if (!img || (!status?.touch && !picking) || busy) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { x: e.clientX, y: e.clientY, at: onImage(img, e.clientX, e.clientY), picking, chat: agentId };
  };

  // A press is a tap where it started, or a swipe to where it ended.
  const endPress = (e: PointerEvent<HTMLImageElement>) => {
    const img = imageRef.current;
    const start = press.current;
    press.current = null;
    if (!img || !start || !device) return;
    if (start.picking) {
      if (!picking || !start.chat) return;
      const chat = start.chat;
      const conversationId = useChats.getState().threads[chat]?.conversationId ?? null;
      setPicking(false);
      act(async () => {
        const png = markedFrame(img, start.at[0], start.at[1]);
        const [point, attachment] = await Promise.all([
          simulatorPoint(device.udid, device.name, start.at[0], start.at[1], img.naturalWidth),
          attachData("simulator-point.png", png),
        ]);
        addPoint(chat, simulatorPointText(point), attachment, conversationId);
      }, "The simulator point couldn't be added. Try again.");
      return;
    }
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    const width = img.naturalWidth;
    if (moved > SWIPE_AFTER_PX) {
      const end = onImage(img, e.clientX, e.clientY);
      act(() => simulatorSwipe(device.udid, device.name, start.at, end, width), "The swipe didn't go through.");
    } else {
      act(() => simulatorTap(device.udid, device.name, start.at[0], start.at[1], width), "The tap didn't go through.");
    }
  };

  useEffect(() => useAttention.subscribe(state => {
    if (agentId && selectQuestionFor(agentId)(state)) setPicking(false);
  }), [agentId]);

  useEffect(() => useNavigation.subscribe((next, previous) => {
    if (next.agentId !== previous.agentId || next.route !== "conversation") { setPicking(false); press.current = null; }
  }), []);

  useEffect(() => {
    if (!picking) return;
    const escape = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setPicking(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [picking]);

  const type = (e: FormEvent) => {
    e.preventDefault();
    if (!device || !typing) return;
    act(() => simulatorType(device.udid, typing), "The text didn't go through.", () => setTyping(""));
  };

  const copyInstall = () => {
    navigator.clipboard
      .writeText(INSTALL_AXE)
      .then(() => setCopied(true))
      .catch(() => setError("The command couldn't be copied; select it and copy it instead."));
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
            setPicking(false);
            setFrame(null);
            choose(udid);
          }}
          className="simulator-device"
        />
        <IconButton icon={MousePointerClick} label="Point at something" size="sm" aria-pressed={picking} disabled={!running || !frame || busy || !agentId || Boolean(question)} title={!running ? "Boot this simulator first" : question ? "Answer the agent’s question first, then point at the screen." : undefined} onClick={() => setPicking(on => !on)} />
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
      <SimulatorTools key={device.udid} udid={device.udid} running={running} active={active} agentId={agentId} />
      {error && (
        <p className="field-error simulator-error" role="alert">
          <InlineCode text={error} />
        </p>
      )}
      <div className="simulator-screen">
        {running && frame ? (
          <img
            ref={imageRef}
            src={frame}
            alt={`${device.name}'s screen`}
            className={status.touch || picking ? "simulator-frame is-touchable" : "simulator-frame"}
            draggable={false}
            onPointerDown={startPress}
            onPointerUp={endPress}
            onPointerCancel={() => (press.current = null)}
          />
        ) : running ? (
          <SkeletonRows rows={2} label="Reading the screen" />
        ) : (
          <EmptyState compact icon={Smartphone} title={`${device.name} isn't running`} body="Boot it to see its screen here, or ask an agent to build and run your app on it." />
        )}
      </div>
      {running &&
        (status.touch ? (
          <form className="simulator-type" onSubmit={type}>
            <input className="input" aria-label="Type on the simulator" placeholder="Type on the simulator…" value={typing} onChange={(e) => setTyping(e.target.value)} />
            <Button size="sm" type="submit" disabled={busy || !typing}>
              Send
            </Button>
          </form>
        ) : (
          <div className="simulator-hint" role="note">
            <p>
              <InlineCode text={`To tap, swipe and type here, install AXe: \`${INSTALL_AXE}\` in Terminal. Until then, use Open in Simulator.`} />
            </p>
            <div className="simulator-hint-actions">
              <Button size="sm" icon={Copy} onClick={copyInstall}>
                {copied ? "Copied" : "Copy command"}
              </Button>
              <Button size="sm" variant="ghost" onClick={refresh}>
                Check again
              </Button>
            </div>
          </div>
        ))}
    </div>
  );
}
