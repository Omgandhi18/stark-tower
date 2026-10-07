import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { CircleCheck, CircleX, FileDiff, Globe, ListChecks, PanelRightOpen, ShieldCheck, Smartphone, SquareTerminal } from "lucide-react";
import { Button, EmptyState, Rail, RailButton, RailDivider, Tabs, cx, ICON_SIZE, ICON_STROKE, usePeek, type TabItem } from "../../design";
import { PANEL_SHORTCUT } from "../../app/panelShortcuts";
import { formatElapsed, formatRelative } from "../../lib/time";
import type { CheckRun, FileChange, ReviewRequest } from "../../lib/types";
import DeliveryActions from "./DeliveryActions";
import DiscardFile from "./DiscardFile";
import AttentionCard from "../attention/AttentionCard";
import AutoModeSwitch from "../automode/AutoModeSwitch";
import BrowserView from "../preview/BrowserView";
import SimulatorView from "../preview/SimulatorView";
import TerminalDrawer from "../terminal/TerminalDrawer";
import { usePanels } from "../../stores/panels";
import type { ChatRef } from "../../stores/chats";
import { MIN_WIDTH, usePreview } from "../../stores/preview";
import { useTerminal } from "../../stores/terminal";
import { clampRailWidth, isPreviewTab, railTab, type RailTab, type StatusTab } from "./railModel";
import { changeLetter, changeSummary } from "./taskPresentation";

const TOP_CHANGES = 5;
/** An arrow key on the panel's edge moves it this far. */
const RESIZE_STEP = 24;

interface TaskSideRailProps {
  taskId: string;
  /** The task's folder, where a new terminal opens and whose dev server the browser runs. */
  folder: string;
  /** The task screen is the one showing (a terminal, page or simulator is drawn in one place at a time). */
  active: boolean;
  /** The conversation the task works in: its auto mode is switched here. */
  conversationId: number | null;
  /** The chat pointing at the page or simulator adds to: the task's own, while you can talk in it here. */
  pointChat: ChatRef | null;
  reviews: readonly ReviewRequest[];
  changes: readonly FileChange[];
  checks: readonly CheckRun[];
  now: number;
  onShowFiles: () => void;
}

/** Keeps one tool in the panel: whichever opened last (here, from the header, or by an agent) takes it. */
function useOneToolAtATime() {
  useEffect(() => {
    const hideTerminal = () => {
      const terminal = useTerminal.getState();
      if (terminal.open && terminal.place === "side") terminal.setOpen(false);
    };
    if (usePreview.getState().open) hideTerminal();
    const stopPreview = usePreview.subscribe((next, previous) => {
      if (next.open && !(previous.open && next.tab === previous.tab)) hideTerminal();
    });
    const stopTerminal = useTerminal.subscribe((next, previous) => {
      const arrived = next.open && next.place === "side" && !(previous.open && previous.place === "side");
      if (arrived && usePreview.getState().open) usePreview.getState().close();
    });
    return () => {
      stopPreview();
      stopTerminal();
    };
  }, []);
}

const terminalAtSide = (terminal: { open: boolean; place: string }) => terminal.open && terminal.place === "side";

/**
 * A tool needs the panel's room: one opening (here, on the rail, from the header, or by an agent)
 * brings a collapsed panel back, and collapsing the panel puts its tool away.
 */
function useToolsNeedRoom() {
  useEffect(() => {
    const expand = () => {
      if (usePanels.getState().collapsed.taskRight) usePanels.getState().setCollapsed("taskRight", false);
    };
    if (usePreview.getState().open || terminalAtSide(useTerminal.getState())) expand();
    const stopPreview = usePreview.subscribe((next, previous) => {
      if (next.open && !(previous.open && next.tab === previous.tab)) expand();
    });
    const stopTerminal = useTerminal.subscribe((next, previous) => {
      if (terminalAtSide(next) && !terminalAtSide(previous)) expand();
    });
    const stopPanels = usePanels.subscribe((next, previous) => {
      if (!next.collapsed.taskRight || previous.collapsed.taskRight) return;
      if (terminalAtSide(useTerminal.getState())) useTerminal.getState().setOpen(false);
      usePreview.getState().close();
    });
    return () => {
      stopPreview();
      stopTerminal();
      stopPanels();
    };
  }, []);
}

/**
 * What the task needs from you, what it changed and how its checks went; and the tools you
 * share with the agents: the terminal (if you put it here), the built-in browser and the iOS Simulator.
 * Collapsed, it's a rail of the same, with their counts: resting on it brings the panel out over the chat.
 */
export default function TaskSideRail({ taskId, folder, active, conversationId, pointChat, reviews, changes, checks, now, onShowFiles }: TaskSideRailProps) {
  const [chosen, setChosen] = useState<StatusTab>(reviews.length ? "attention" : "checks");
  // The Terminal tab is the terminal's side place: it's open there exactly when the terminal is shown at the side.
  const terminalHere = useTerminal((s) => s.open && s.place === "side");
  const previewOpen = usePreview((s) => s.open);
  const previewTab = usePreview((s) => s.tab);
  const width = usePreview((s) => s.width);
  const collapsed = usePanels((s) => s.collapsed.taskRight);
  const setCollapsed = usePanels((s) => s.setCollapsed);
  const { ref, panelRef, peeking, open, handlers } = usePeek<HTMLElement>(collapsed);
  // Collapsed, a tool is never drawn: the browser and simulator are native views that don't hide with the page.
  const tab = collapsed ? chosen : railTab(chosen, terminalHere, { open: previewOpen, tab: previewTab });
  const previewing = isPreviewTab(tab);
  const drag = useRef<{ x: number; width: number } | null>(null);
  useOneToolAtATime();
  useToolsNeedRoom();

  const setTab = (next: RailTab) => {
    if (next === "terminal") useTerminal.getState().moveTo("side");
    else if (isPreviewTab(next)) usePreview.getState().show(next);
    else {
      if (terminalHere) useTerminal.getState().setOpen(false);
      usePreview.getState().close();
      setChosen(next);
    }
  };

  // The room the panel shares with the chat: the task body, less the column on its left (hidden on a small window).
  const resizeTo = (wanted: number) => {
    const body = ref.current?.parentElement;
    const left = body?.querySelector<HTMLElement>(".task-left");
    const room = (body?.getBoundingClientRect().width ?? window.innerWidth) - (left?.getBoundingClientRect().width ?? 0);
    usePreview.getState().setWidth(clampRailWidth(wanted, room, MIN_WIDTH));
  };
  const startResize = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const resize = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current) resizeTo(drag.current.width + (drag.current.x - e.clientX));
  };
  const resizeWithKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowLeft" ? RESIZE_STEP : e.key === "ArrowRight" ? -RESIZE_STEP : 0;
    if (!step) return;
    e.preventDefault();
    resizeTo(width + step);
  };

  const tabs: TabItem<RailTab>[] = [
    { id: "attention", label: "Attention", count: reviews.length },
    { id: "changes", label: "Changes", count: changes.length },
    { id: "checks", label: "Checks", count: checks.length },
    { id: "terminal", label: "Terminal", icon: SquareTerminal, iconOnly: true },
    { id: "browser", label: "Browser", icon: Globe, iconOnly: true },
    { id: "simulator", label: "Simulator", icon: Smartphone, iconOnly: true },
  ];
  const summary = changeSummary(changes);
  const failed = checks.filter((run) => !run.passed).length;
  const shortcut = PANEL_SHORTCUT.taskRight;
  const peekAt = (next: StatusTab) => (fromKeyboard: boolean) => {
    setChosen(next);
    open(fromKeyboard);
  };

  return (
    <aside
      ref={ref}
      className={cx("task-rail", collapsed && "is-collapsed", tab === "terminal" && "has-terminal", previewing && "has-preview")}
      style={previewing ? { width } : undefined}
      aria-label="Task side panel"
      {...handlers}
    >
      {previewing && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the side panel"
          aria-valuemin={MIN_WIDTH}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          className="task-rail-resize"
          onPointerDown={startResize}
          onPointerMove={resize}
          onPointerUp={() => (drag.current = null)}
          onKeyDown={resizeWithKeys}
        />
      )}
      {collapsed && (
        <Rail label="Task side panel, collapsed">
          <RailButton home icon={PanelRightOpen} label="Expand the side panel" title={`Expand the side panel  ${shortcut}`} onClick={() => setCollapsed("taskRight", false)} />
          <RailButton icon={ShieldCheck} label="Attention" count={reviews.length} tone="attention" onClick={peekAt("attention")} />
          <RailButton icon={FileDiff} label="Changes" count={changes.length} onClick={peekAt("changes")} />
          <RailButton
            icon={failed ? CircleX : ListChecks}
            label={failed ? "Checks failed" : "Checks"}
            count={failed || checks.length}
            tone={failed ? "danger" : "neutral"}
            onClick={peekAt("checks")}
          />
          <RailDivider />
          <RailButton icon={SquareTerminal} label="Terminal" onClick={() => useTerminal.getState().moveTo("side")} />
          <RailButton icon={Globe} label="Browser" onClick={() => usePreview.getState().show("browser")} />
          <RailButton icon={Smartphone} label="Simulator" onClick={() => usePreview.getState().show("simulator")} />
        </Rail>
      )}
      <div ref={panelRef} className={cx("task-rail-inner", peeking && "is-peeking")} tabIndex={collapsed ? -1 : undefined}>
        <Tabs tabs={tabs} value={tab} onChange={setTab} label="Task side panel" idPrefix="task-rail" />
        <div role="tabpanel" id={`task-rail-panel-${tab}`} aria-labelledby={`task-rail-tab-${tab}`} className={cx("task-rail-body", (tab === "terminal" || previewing) && "is-tool")}>
          {tab === "terminal" && <TerminalDrawer folder={folder} active={active} dock="side" movable />}
          {tab === "browser" && <BrowserView active={active} chat={pointChat} folder={folder} />}
          {tab === "simulator" && <SimulatorView active={active} chat={pointChat} />}
          {tab === "attention" && conversationId !== null && <AutoModeSwitch conversationId={conversationId} className="task-rail-auto-mode" />}
          {tab === "attention" &&
            (reviews.length === 0 ? (
              <EmptyState compact icon={ShieldCheck} title="Nothing needs you" body="Approvals and questions from this task's agents show up here." />
            ) : (
              <div className="attention-list">
                {reviews.map((review) => (
                  <AttentionCard key={review.id} review={review} now={now} />
                ))}
              </div>
            ))}

          {tab === "changes" && <DeliveryActions taskId={taskId} changes={changes} />}
          {tab === "changes" &&
            (changes.length === 0 ? (
              <EmptyState compact icon={CircleCheck} title="No uncommitted changes" body="The folder matches its last commit." />
            ) : (
              <div className="rail-changes">
                <p className="delivery-note">Everything uncommitted in the task’s folder, including changes made outside this task.</p>
                <p className="rail-changes-summary">
                  {summary.added} added, {summary.modified} modified, {summary.deleted} deleted
                  <span className="tabular">
                    <span className="is-add"> +{summary.linesAdded}</span>
                    <span className="is-remove"> −{summary.linesRemoved}</span>
                  </span>
                </p>
                <ul className="rail-change-list">
                  {changes.slice(0, TOP_CHANGES).map((c) => (
                    <li key={c.path} aria-label={`Changes to ${c.path}`}>
                      <span className={cx("change-letter", `is-${c.status}`)}>{changeLetter(c)}</span>
                      <span className="mono rail-change-path" title={c.path}>
                        {c.path}
                      </span>
                      <DiscardFile taskId={taskId} change={c} />
                    </li>
                  ))}
                </ul>
                <Button size="sm" variant="ghost" onClick={onShowFiles}>
                  {changes.length > TOP_CHANGES ? `See all ${changes.length} files` : "See the changes"}
                </Button>
              </div>
            ))}

          {tab === "checks" &&
            (checks.length === 0 ? (
              <EmptyState
                compact
                icon={CircleCheck}
                title="No checks run yet"
                body="When the owner runs tests, a type check, lint or a build, whether it passed shows up here."
              />
            ) : (
              <ul className="check-runs">
                {[...checks].reverse().map((run) => {
                  const Icon = run.passed ? CircleCheck : CircleX;
                  return (
                    <li key={run.command} className={cx("check-run", run.passed ? "tone-success" : "tone-danger")}>
                      <Icon aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} className="check-run-icon" />
                      <span className="check-run-text">
                        <span className="check-run-kind">
                          {run.kind} {run.passed ? "passed" : "failed"}
                        </span>
                        <span className="check-run-command mono" title={run.command}>
                          {run.command}
                        </span>
                      </span>
                      <span className="check-run-time">
                        {formatRelative(run.at, now)}
                        {run.duration_ms !== null && <span className="tabular">, took {formatElapsed(run.duration_ms)}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ))}
        </div>
      </div>
    </aside>
  );
}
