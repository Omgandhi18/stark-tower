import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { cx } from "../cx";
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
  align?: "start" | "end";
}

/** A "more actions" menu: arrow keys move, Enter selects, Escape closes. */
export function OverflowMenu({ items, label, align = "end" }: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    itemRefs.current.find((el) => el && !el.disabled)?.focus();
    return () => window.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

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
      setOpen(false);
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
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div id={menuId} role="menu" aria-label={label} className={cx("menu", `menu-${align}`)} onKeyDown={onKeyDown}>
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
        </div>
      )}
    </div>
  );
}
