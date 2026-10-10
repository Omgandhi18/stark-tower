import { useRef, useState, type KeyboardEvent } from "react";
import { Plus, X, type LucideIcon } from "lucide-react";
import { cx } from "../cx";
import { ICON_SIZE, ICON_STROKE } from "../icons";
import { IconButton } from "./Button";

export interface TabStripItem {
  id: string;
  label: string;
  /** Before the label: what kind of thing the tab holds. */
  icon?: LucideIcon;
  /** Shown in place of `icon` (a page's own favicon); `icon` stands in while there is none or it won't load. */
  iconSrc?: string;
  /** Hover text, when the label is cut short (a full address, say). */
  title?: string;
  /** Working on something: the tab shows a progress line. */
  busy?: boolean;
}

interface TabStripProps {
  tabs: readonly TabStripItem[];
  /** The tab showing; none while there are no tabs. */
  value: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** Names the tab list for screen readers ("Browser tabs"). */
  label: string;
  /** id prefix linking tabs to their panels (`${idPrefix}-panel-${id}`). */
  idPrefix: string;
  /** Names the "+" button ("New tab"). */
  newLabel: string;
  disabled?: boolean;
  /** Controls placed after the "+", at the strip's end. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * Closable, addable tabs for the things a tool panel holds several of (a browser's pages,
 * a terminal's shells). Arrow keys move between tabs; middle-click or Delete closes one.
 */
export function TabStrip({ tabs, value, onSelect, onClose, onNew, label, idPrefix, newLabel, disabled, children, className }: TabStripProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusTab = (index: number) => {
    const next = (index + tabs.length) % tabs.length;
    refs.current[next]?.focus();
    onSelect(tabs[next].id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onClose(tabs[index].id);
      return;
    }
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 };
    if (!(e.key in moves)) return;
    e.preventDefault();
    focusTab(moves[e.key]);
  };

  return (
    <div className={cx("tab-strip", className)}>
      <div role="tablist" aria-label={label} className="tab-strip-list">
        {tabs.map((tab, i) => {
          const selected = tab.id === value;
          const Icon = tab.icon;
          return (
            <div key={tab.id} role="presentation" className={cx("tab-strip-item", selected && "is-selected", tab.busy && "is-busy")}>
              <button
                ref={(el) => {
                  refs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`${idPrefix}-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`${idPrefix}-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                className="tab-strip-tab"
                title={tab.title ?? tab.label}
                onClick={() => onSelect(tab.id)}
                onAuxClick={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  onClose(tab.id);
                }}
                onKeyDown={(e) => onKeyDown(e, i)}
              >
                <TabIcon icon={Icon} src={tab.iconSrc} />
                <span className="tab-strip-label">{tab.label}</span>
              </button>
              <button type="button" tabIndex={-1} className="tab-strip-close" aria-label={`Close ${tab.label}`} title="Close" disabled={disabled} onClick={() => onClose(tab.id)}>
                <X aria-hidden size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
              </button>
            </div>
          );
        })}
      </div>
      <IconButton icon={Plus} size="sm" label={newLabel} disabled={disabled} onClick={onNew} />
      {children}
    </div>
  );
}

/** A tab's picture: its own image when it has one that loads, else the kind-of-thing icon. */
function TabIcon({ icon: Icon, src }: { icon?: LucideIcon; src?: string }) {
  // Remembers which address failed, so a tab that moves to another page tries its new icon.
  const [failed, setFailed] = useState<string | null>(null);
  if (src && src !== failed) return <img src={src} alt="" aria-hidden className="tab-strip-favicon" draggable={false} onError={() => setFailed(src)} />;
  return Icon ? <Icon aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} /> : null;
}
