import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { cx } from "../cx";
import { registerOverlay } from "../overlays";

/** Space kept between a popover and the window's edge, and between it and its trigger (as menus keep). */
const EDGE_GAP = 8;
const TRIGGER_GAP = 4;
const FOCUSABLE = "input, button, select, textarea, [tabindex]:not([tabindex='-1'])";

/** What the trigger needs to open the popover and say that it has. */
export interface PopoverTriggerProps {
  ref: Ref<HTMLButtonElement>;
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  onClick: () => void;
}

interface PopoverProps {
  /** Draws the button that opens it. */
  trigger: (props: PopoverTriggerProps) => ReactNode;
  /** What it shows; `close` closes it and puts focus back on the trigger. */
  children: (close: () => void) => ReactNode;
  /** Names the panel ("Model for FRIDAY"). */
  label: string;
  /** Which edge of the trigger it lines up with: "start" grows rightwards, "end" leftwards. */
  align?: "start" | "end";
  /** At least as wide as the trigger (a field's dropdown). */
  matchWidth?: boolean;
  className?: string;
}

/**
 * A panel drawn over the page from the button that opens it: under it, or above it when there's
 * more room there, and kept on that side as what it shows grows or shrinks. Inside an open dialog
 * it's drawn in the dialog. Focus moves in (to `data-autofocus`, else the first control); Escape,
 * a click elsewhere, a scroll that moves its trigger, or a window resize closes it.
 */
export function Popover({ trigger, children, label, align = "start", matchWidth = false, className }: PopoverProps) {
  /** Where the open panel is drawn (null while it's closed), and whether closing puts focus back on the trigger. */
  const [state, setState] = useState<{ layer: Element | null; refocus: boolean }>({ layer: null, refocus: false });
  const layer = state.layer;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const id = useId();

  const close = useCallback(() => setState({ layer: null, refocus: true }), []);
  const dismiss = useCallback(() => setState({ layer: null, refocus: false }), []);

  useEffect(() => {
    if (!layer && state.refocus) triggerRef.current?.focus();
  }, [layer, state.refocus]);

  // Measured where it first renders (hidden), then moved into place, and again whenever it resizes.
  const placePanel = useCallback(
    (panel: HTMLDivElement | null) => {
      panelRef.current = panel;
      const anchor = triggerRef.current;
      if (!panel || !anchor) return;
      let side: "below" | "above" | null = null;
      const place = () => {
        const t = anchor.getBoundingClientRect();
        const below = window.innerHeight - EDGE_GAP - t.bottom - TRIGGER_GAP;
        const above = t.top - TRIGGER_GAP - EDGE_GAP;
        if (matchWidth) panel.style.minWidth = `${t.width}px`;
        panel.style.maxHeight = "none";
        const size = panel.getBoundingClientRect();
        side ??= size.height <= below || below >= above ? "below" : "above";
        const room = Math.max(0, side === "below" ? below : above);
        panel.style.maxHeight = `${room}px`;
        const wanted = align === "end" ? t.right - size.width : t.left;
        panel.style.left = `${Math.max(EDGE_GAP, Math.min(wanted, window.innerWidth - size.width - EDGE_GAP))}px`;
        panel.style.top = `${side === "below" ? t.bottom + TRIGGER_GAP : t.top - TRIGGER_GAP - Math.min(size.height, room)}px`;
        panel.style.visibility = "visible";
      };
      place();
      const unregister = registerOverlay(panel);
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
      observer?.observe(panel);
      return () => {
        observer?.disconnect();
        unregister();
      };
    },
    [align, matchWidth],
  );

  useEffect(() => {
    if (!layer) return;
    const inside = (target: EventTarget | null) => target instanceof Node && Boolean(triggerRef.current?.contains(target) || panelRef.current?.contains(target));
    const onPointer = (e: PointerEvent) => {
      if (!inside(e.target)) dismiss();
    };
    // It stays where it opened, so it closes when its trigger moves: when something that holds
    // the trigger scrolls. Other scrolling (a chat log following a streaming reply) leaves it be.
    const onScroll = (e: Event) => {
      const scrolled = e.target === document ? document.documentElement : e.target;
      if (scrolled instanceof Node && !inside(scrolled) && triggerRef.current && scrolled.contains(triggerRef.current)) dismiss();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", dismiss);
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>("[data-autofocus]") ?? panel?.querySelector<HTMLElement>(FOCUSABLE))?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [layer, dismiss]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  // Focus that leaves for another control (Tab past the end) closes it.
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (next instanceof Node && !panelRef.current?.contains(next) && !triggerRef.current?.contains(next)) dismiss();
  };

  // A modal dialog sits in the browser's top layer; a popover opened inside one must live in it too.
  const toggle = () =>
    setState((current) => ({ layer: current.layer ? null : (triggerRef.current?.closest("dialog") ?? document.body), refocus: false }));

  return (
    <>
      {trigger({ ref: triggerRef, "aria-expanded": layer !== null, "aria-controls": layer ? id : undefined, onClick: toggle })}
      {layer &&
        createPortal(
          <div id={id} ref={placePanel} role="dialog" aria-label={label} className={cx("popover", className)} onKeyDown={onKeyDown} onBlur={onBlur}>
            {children(close)}
          </div>,
          layer,
        )}
    </>
  );
}
