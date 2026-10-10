import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, MousePointerClick, RotateCw, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EmptyState, IconButton, SelectField, TabStrip, covered, cx, onOverlaysChanged, useTabShortcuts } from "../../design";
import { browserCloseTab, browserGo, browserNewTab, browserPicker, browserHide, browserNavigate, browserSelectTab, browserShow } from "../../lib/api";
import { selectQuestionFor, useAttention } from "../../stores/attention";
import { errorMessage } from "../../lib/errors";
import { useNavigation } from "../../stores/navigation";
import { useChats, type ChatRef } from "../../stores/chats";
import { addPoint } from "./pointComposer";
import { browserPointText } from "./pointModel";
import DevServerToolbar from "./DevServerToolbar";
import DevServerOutput from "./DevServerOutput";
import { BROWSER_SIZES, fitBrowser, tabLabel, type BrowserSize } from "./browserModel";
import { usePreview } from "../../stores/preview";
import "./preview.css";

/** How often the browser checks it's still over its panel (things move without resizing it). */
const TRACK_MS = 400;

const report = (what: string) => (e: unknown) => console.error(`[browser] couldn't ${what}`, e);

interface BrowserViewProps {
  /** Its screen is the one showing, so the page is laid over it. */
  active: boolean;
  /** Whose chat "Point at something" adds to; null while there's no chat to talk in beside it. */
  /** The chat pointing adds to; none while there's no chat to talk in here. */
  chat: ChatRef | null;
  /** The project whose dev server the toolbar runs. */
  folder: string;
}

/**
 * The built-in browser: an address bar over a real browser view, which the backend lays over
 * this panel. It follows the panel as it moves and steps aside while anything is drawn over it.
 */
export default function BrowserView({ active, chat, folder }: BrowserViewProps) {
  const agentId = chat?.agentId ?? null;
  const key = chat?.key ?? null;
  const page = usePreview((s) => s.page);
  const tabs = usePreview((s) => s.tabs);
  const size = usePreview((s) => s.size);
  const setSize = usePreview((s) => s.setSize);
  const conversationId = useChats(s => key ? s.threads[key]?.conversationId ?? null : null);
  const question = useAttention(selectQuestionFor(agentId ?? "", conversationId));
  // Pointing is for one agent's chat while this screen shows: another agent or screen ends it.
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  const picking = active && key !== null && pickingFor === key;
  const [outputOpen, setOutputOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const fitted = fitBrowser(panel, size);
  const viewportRef = useRef<HTMLDivElement>(null);
  // The page is laid over the panel while it shows; a click into it moves focus out of this document.
  const overPanelRef = useRef(false);
  const [typed, setTyped] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasPage = page.url !== "";
  const activeTab = tabs.active;
  // Another tab is another page: what was half-typed, and any pointing, belongs to the one left.
  const [seenTab, setSeenTab] = useState(activeTab);
  if (seenTab !== activeTab) {
    setSeenTab(activeTab);
    setTyped(null);
    setPickingFor(null);
  }
  const tabId = (id: number) => String(id);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        setPanel((old) => old.width === r.width && old.height === r.height ? old : { x: 0, y: 0, width: r.width, height: r.height });
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    measure();
    return () => { observer?.disconnect(); window.cancelAnimationFrame(frame); };
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !active || !hasPage) {
      browserHide().catch(report("hide"));
      return;
    }
    let last = "";
    const sync = () => {
      const r = el.getBoundingClientRect();
      const away = r.width < 2 || r.height < 2 || covered(r);
      overPanelRef.current = !away;
      const key = away ? "away" : `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
      if (key === last) return;
      last = key;
      if (away) browserHide().catch(report("hide"));
      else browserShow({ x: r.left, y: r.top, width: r.width, height: r.height }, fitted.zoom).catch(report("show"));
    };
    sync();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(el);
    const stopOverlays = onOverlaysChanged(sync);
    const timer = window.setInterval(sync, TRACK_MS);
    window.addEventListener("resize", sync);
    return () => {
      observer?.disconnect();
      stopOverlays();
      window.clearInterval(timer);
      window.removeEventListener("resize", sync);
      overPanelRef.current = false;
      browserHide().catch(report("hide"));
    };
  }, [active, hasPage, fitted.zoom, size]);

  useEffect(() => useChats.subscribe((next, previous) => {
    if (key && next.threads[key]?.conversationId !== previous.threads[key]?.conversationId) setPickingFor(null);
  }), [key]);

  useEffect(() => useAttention.subscribe(state => {
    if (agentId && selectQuestionFor(agentId, conversationId)(state)) setPickingFor(null);
  }), [agentId, conversationId]);

  useEffect(() => useNavigation.subscribe((next, previous) => {
    if (next.route !== previous.route) setPickingFor(null);
  }), []);

  useEffect(() => {
    if (!picking || !active || !chat) return;
    let live = true;
    let timer = 0;
    const poll = async () => {
      try {
        const result = await browserPicker("poll");
        if (result.pick) addPoint(chat, browserPointText(result.pick), result.attachment, conversationId);
        if (!live) return;
        if (!result.active) { setPickingFor(null); return; }
        timer = window.setTimeout(poll, 150);
      } catch (e) { if (live) { setError(errorMessage(e, "The element couldn't be picked. Try again.")); setPickingFor(null); } }
    };
    browserPicker("start").then(() => { if (live) void poll(); }).catch(e => { if (live) { setError(errorMessage(e, "The picker couldn't start.")); setPickingFor(null); } });
    const escape = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setPickingFor(null); };
    window.addEventListener("keydown", escape);
    return () => { live = false; window.clearTimeout(timer); window.removeEventListener("keydown", escape); browserPicker("cancel").catch(report("cancel picking")); };
  }, [picking, active, chat, conversationId]);

  const open = (address: string) => {
    setError(null);
    browserNavigate(address)
      .then(() => setTyped(null))
      .catch((e) => setError(errorMessage(e, "That page couldn't be opened.")));
  };

  const newTab = () => {
    setError(null);
    browserNewTab()
      .then(() => addressRef.current?.focus())
      .catch((e) => setError(errorMessage(e, "A new tab couldn't be opened.")));
  };
  const closeTab = (id: number) => {
    setError(null);
    browserCloseTab(id).catch((e) => setError(errorMessage(e, "That tab couldn't be closed.")));
  };
  useTabShortcuts(rootRef, newTab, () => { if (activeTab !== null) closeTab(activeTab); }, () => overPanelRef.current && !document.hasFocus());

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && typed?.trim()) {
      e.preventDefault();
      open(typed);
    } else if (e.key === "Escape") {
      setTyped(null);
    }
  };

  return (
    <div ref={rootRef} className="browser-view">
      <TabStrip
        label="Browser tabs"
        idPrefix="browser"
        newLabel="New tab"
        tabs={tabs.tabs.map((t) => ({ id: tabId(t.id), label: tabLabel(t), title: t.url || undefined, icon: Globe, iconSrc: t.favicon || undefined, busy: t.loading }))}
        value={activeTab === null ? null : tabId(activeTab)}
        onSelect={(id) => browserSelectTab(Number(id)).catch(report("switch tabs"))}
        onClose={(id) => closeTab(Number(id))}
        onNew={newTab}
      />
      <div className="browser-toolbar">
        <IconButton icon={ArrowLeft} label="Back" size="sm" disabled={!hasPage} onClick={() => browserGo("back").catch(report("go back"))} />
        <IconButton icon={ArrowRight} label="Forward" size="sm" disabled={!hasPage} onClick={() => browserGo("forward").catch(report("go forward"))} />
        {page.loading ? (
          <IconButton icon={X} label="Stop loading" size="sm" onClick={() => browserGo("stop").catch(report("stop"))} />
        ) : (
          <IconButton icon={RotateCw} label="Reload" size="sm" disabled={!hasPage} onClick={() => browserGo("reload").catch(report("reload"))} />
        )}
        <input
          ref={addressRef}
          className="input browser-address"
          aria-label="Address"
          placeholder="Type an address, or localhost:5173"
          spellCheck={false}
          autoComplete="off"
          value={typed ?? page.url}
          onChange={(e) => setTyped(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={onKeyDown}
        />
        <IconButton icon={MousePointerClick} label="Point at something" size="sm" aria-pressed={picking} disabled={!hasPage || !key || Boolean(question)} title={question ? "Answer the agent’s question first, then point at the page." : undefined} onClick={() => { setError(null); setPickingFor(picking ? null : key); }} />
        <IconButton icon={ExternalLink} label="Open in your browser" size="sm" disabled={!hasPage} onClick={() => openUrl(page.url).catch(report("open the page outside"))} />
        <span className={cx("browser-progress", page.loading && "is-loading")} aria-hidden />
      </div>
      <DevServerToolbar key={`command:${folder}`} folder={folder} outputOpen={outputOpen} toggleOutput={() => setOutputOpen((open) => !open)} />
      <div className="browser-toolbar browser-size-toolbar">
        <SelectField label="Browser size" hideLabel value={size} options={BROWSER_SIZES} onChange={(value) => setSize(value as BrowserSize)} />
        {fitted.label && <span className="browser-size-label">{fitted.label}</span>}
      </div>
      {error && (
        <p className="field-error browser-error" role="alert">
          {error}
        </p>
      )}
      <div ref={stageRef} className="browser-stage">
        <div ref={viewportRef} style={size === "fit" ? undefined : { width: fitted.bounds.width, height: fitted.bounds.height }} className={cx("browser-viewport", size !== "fit" && "is-device")} aria-label={page.title || page.url || "Browser"} role="region" id={activeTab === null ? undefined : `browser-panel-${activeTab}`}>
          {!hasPage && (
            <EmptyState
              compact
              icon={Globe}
              title="Open a page"
              body="Type an address above, or ask an agent to open your app: “open localhost:5173 in the browser and check the settings page.”"
            />
          )}
        </div>
      </div>
      {outputOpen && <DevServerOutput key={`output:${folder}`} folder={folder} />}
    </div>
  );
}
