import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { PanelBottomClose, Plus, SquareTerminal, X } from "lucide-react";
import { Button, Dialog, EmptyState, IconButton, InlineCode, Tabs } from "../../design";
import type { TerminalInfo } from "../../lib/bindings";
import { useTerminal } from "../../stores/terminal";
import { clampHeight, MIN_HEIGHT, terminalLabel } from "./terminalModel";
import { disposeTerminal, getTerminalRuntime } from "./terminalRuntime";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

function TerminalView({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const runtime = getTerminalRuntime(id);
    host.append(runtime.element);
    const fit = () => {
      if (host.getBoundingClientRect().width && host.getBoundingClientRect().height) runtime.fit.fit();
    };
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    fit();
    // Arrow keys in the tab list keep their roving focus.
    if (document.activeElement?.getAttribute("role") !== "tab") runtime.terminal.focus();
    return () => {
      observer.disconnect();
      runtime.element.remove();
    };
  }, [id]);
  return <div ref={ref} className="terminal-host" />;
}

export default function TerminalDrawer({ folder, active = true }: { folder: string; active?: boolean }) {
  const state = useTerminal();
  const ref = useRef<HTMLElement>(null);
  const prefix = useId();
  const [closing, setClosing] = useState<TerminalInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [maxHeight, setMaxHeight] = useState(600);
  const items = [...state.items].sort((a, b) => Number(b.folder === folder) - Number(a.folder === folder));
  const selected = items.find((t) => t.id === state.selected) ?? items[0];
  const height = clampHeight(state.height, maxHeight / 0.7);

  useEffect(() => {
    if (!state.open || !active) return;
    void useTerminal.getState().refresh().catch(() => {
      useTerminal.getState().report("Couldn't find your terminals. Try opening the drawer again.");
    });
  }, [state.open, active]);

  useEffect(() => {
    const column = ref.current?.parentElement;
    if (!column) return;
    const observer = new ResizeObserver(() => {
      setMaxHeight(Math.max(MIN_HEIGHT, column.getBoundingClientRect().height * 0.7));
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, [state.open]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    state.report(null);
    try {
      await action();
    } catch {
      state.report("Couldn't change this terminal. Try again, or open a new terminal.");
    } finally {
      setBusy(false);
    }
  };
  const close = (id: string) => run(async () => {
    await state.remove(id);
    disposeTerminal(id);
    setClosing(null);
  });
  const requestClose = () => run(async () => {
    if (!selected) return;
    const latest = (await state.refresh()).find((t) => t.id === selected.id);
    if (latest?.program_running) {
      setClosing({ ...latest, title: selected.title });
    } else {
      await state.remove(selected.id);
      disposeTerminal(selected.id);
    }
  });
  const restart = () => run(async () => {
    if (!selected) return;
    await state.add(selected.folder);
    await state.remove(selected.id);
    disposeTerminal(selected.id);
  });
  const focusComposer = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || closing) return;
    event.preventDefault();
    const column = ref.current?.parentElement;
    const inputs = column?.querySelectorAll<HTMLTextAreaElement>("textarea.chat-input") ?? [];
    const composer = [...inputs].find((input) => !input.closest("[inert]"));
    if (composer) composer.focus();
    else column?.closest(".task-screen")?.querySelector<HTMLButtonElement>('button[aria-label="Terminal"]')?.focus();
  };
  const resizeWithKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowUp" ? 20 : event.key === "ArrowDown" ? -20 : 0;
    if (delta) {
      event.preventDefault();
      state.setHeight(clampHeight(height + delta, maxHeight / 0.7));
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      state.setHeight(event.key === "Home" ? MIN_HEIGHT : maxHeight);
    }
  };
  const resizeWithPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !ref.current) return;
    state.setHeight(clampHeight(ref.current.getBoundingClientRect().bottom - event.clientY, maxHeight / 0.7));
  };

  if (!state.open) return null;
  return (
    <section ref={ref} className="terminal-drawer" aria-label="Terminal" style={{ height }} onKeyDown={focusComposer}>
      <div
        role="separator"
        aria-label="Resize terminal"
        aria-orientation="horizontal"
        tabIndex={0}
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={Math.round(maxHeight)}
        aria-valuenow={Math.round(height)}
        className="terminal-resize"
        onKeyDown={resizeWithKeys}
        onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={resizeWithPointer}
        onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      />
      <div className="terminal-toolbar">
        <Tabs
          label="Terminals"
          idPrefix={prefix}
          tabs={items.map((t) => ({ id: t.id, label: `${terminalLabel(t.folder, t.title, t.shell)}${t.alive ? "" : " · Exited"}` }))}
          value={selected?.id ?? ""}
          onChange={state.select}
        />
        <IconButton icon={Plus} label="Open new terminal" disabled={busy} onClick={() => void run(() => state.add(folder))} />
        {selected && <IconButton icon={X} label="Close terminal tab" disabled={busy} onClick={() => void requestClose()} />}
        <IconButton icon={PanelBottomClose} label="Hide terminal" onClick={state.toggle} />
      </div>
      {state.error && <p className="terminal-note" role="alert">{state.error}</p>}
      {selected ? (
        <div role="tabpanel" id={`${prefix}-panel-${selected.id}`} aria-labelledby={`${prefix}-tab-${selected.id}`} className="terminal-panel">
          {selected.note && <p className="terminal-note">{selected.note}</p>}
          {!selected.alive && (
            <div className="terminal-exited" role="status">
              Shell exited{selected.exit_code !== null ? ` (${selected.exit_code})` : ""}.
              <Button size="sm" disabled={busy} onClick={() => void restart()}>Restart</Button>
            </div>
          )}
          {active && <TerminalView key={selected.id} id={selected.id} />}
        </div>
      ) : (
        <EmptyState
          icon={SquareTerminal}
          title="Open a terminal in this folder"
          body="Your shell stays running when you switch chats or hide the drawer."
          action={<Button disabled={busy} onClick={() => void run(() => state.add(folder))}>Open terminal</Button>}
        />
      )}
      <Dialog
        open={closing !== null}
        onClose={() => setClosing(null)}
        title={<>Stop <InlineCode text={closing?.title === closing?.shell ? "the running program" : closing?.title ?? "the running program"} /> and close this terminal?</>}
        description="The program and shell will stop. This tab's scrollback will be removed."
        actions={
          <>
            <Button disabled={busy} onClick={() => setClosing(null)}>Keep terminal</Button>
            <Button variant="danger" disabled={busy} onClick={() => closing && void close(closing.id)}>Stop and close</Button>
          </>
        }
      />
    </section>
  );
}
