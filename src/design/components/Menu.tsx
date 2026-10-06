import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { cx } from "../cx";
import { registerOverlay } from "../overlays";
import { ICON_SIZE, ICON_STROKE } from "../icons";
import { IconButton } from "./Button";

export interface MenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface OverflowMenuProps {
  items: readonly MenuItem[];
  /** Names the trigger ("More actions for FRIDAY"). */
  label: string;
  /** Which edge of the trigger the menu lines up with: "end" grows leftwards, "start" rightwards. */
  align?: "start" | "end";
}

/** Space kept between a menu and the window's edge. */
const EDGE_GAP = 8;
/** Space between a menu and its trigger. */
const TRIGGER_GAP = 4;

/**
 * Where an open menu goes, in window coordinates: under its trigger (above it when there's no
 * room below), lined up with one of the trigger's edges, and always inside the window.
 */
function placement(trigger: DOMRect, menu: DOMRect, align: "start" | "end"): { top: number; left: number } {
  const wanted = align === "end" ? trigger.right - menu.width : trigger.left;
  const left = Math.max(EDGE_GAP, Math.min(wanted, window.innerWidth - menu.width - EDGE_GAP));
  const below = trigger.bottom + TRIGGER_GAP;
  const top = below + menu.height <= window.innerHeight - EDGE_GAP ? below : Math.max(EDGE_GAP, trigger.top - TRIGGER_GAP - menu.height);
  return { top, left };
}

/**
 * A "more actions" menu: arrow keys move, Enter selects, Escape closes. The menu is drawn over
 * the page (inside an open dialog, over the dialog), so a scrolling sidebar or card never clips it.
 */
export function OverflowMenu({ items, label, align = "end" }: OverflowMenuProps) {
  /** Where the open menu is drawn; null while it's closed. */
  const [layer, setLayer] = useState<Element | null>(null);
  const open = layer !== null;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  // The menu is measured where it first renders (hidden), then moved into place.
  const placeMenu = useCallback(
    (menu: HTMLDivElement | null) => {
      menuRef.current = menu;
      const trigger = triggerRef.current;
      if (!menu || !trigger) return;
      const { top, left } = placement(trigger.getBoundingClientRect(), menu.getBoundingClientRect(), align);
      menu.style.top = `${top}px`;
      menu.style.left = `${left}px`;
      menu.style.visibility = "visible";
      return registerOverlay(menu);
    },
    [align],
  );

  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node && Boolean(rootRef.current?.contains(target) || menuRef.current?.contains(target));
    const onPointer = (e: PointerEvent) => {
      if (!inside(e.target)) setLayer(null);
    };
    // Close when the trigger moves; a chat following new messages doesn't move a menu elsewhere.
    const onMove = (e: Event) => {
      const trigger = triggerRef.current;
      if (trigger && e.target instanceof Node && e.target.contains(trigger)) setLayer(null);
    };
    const onResize = () => setLayer(null);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onResize);
    itemRefs.current.find((el) => el && !el.disabled)?.focus();
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const close = () => {
    setLayer(null);
    triggerRef.current?.focus();
  };

  // A modal dialog sits in the browser's top layer; a menu opened inside one must live in it too.
  const toggle = () => setLayer((current) => (current ? null : (triggerRef.current?.closest("dialog") ?? document.body)));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = itemRefs.current.filter((el): el is HTMLButtonElement => Boolean(el && !el.disabled));
    const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      enabled[(at + step + enabled.length) % enabled.length]?.focus();
    } else if (e.key === "Tab") {
      setLayer(null);
    }
  };

  return (
    <div className="menu-root" ref={rootRef}>
      <IconButton
        ref={triggerRef}
        icon={MoreHorizontal}
        label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
      />
      {layer &&
        createPortal(
          <div id={menuId} ref={placeMenu} role="menu" aria-label={label} className="menu" onKeyDown={onKeyDown}>
            {items.map((item, i) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  className={cx("menu-item", item.danger && "is-danger")}
                  onClick={() => {
                    close();
                    item.onSelect();
                  }}
                >
                  {Icon && <Icon aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />}
                  {item.label}
                </button>
              );
            })}
          </div>,
          layer,
        )}
    </div>
  );
}
