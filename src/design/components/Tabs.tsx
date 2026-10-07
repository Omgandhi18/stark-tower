import { useRef, type KeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { cx } from "../cx";
import { ICON_SIZE, ICON_STROKE } from "../icons";
import { CountBadge } from "./Badge";

export interface TabItem<T extends string> {
  id: T;
  label: string;
  count?: number;
  /** Shown before the label; with `iconOnly`, instead of it (the label stays for screen readers and the tooltip). */
  icon?: LucideIcon;
  iconOnly?: boolean;
}

interface TabsProps<T extends string> {
  tabs: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Names the tab list for screen readers. */
  label: string;
  /** id prefix linking tabs to their panels (`${idPrefix}-panel-${id}`). */
  idPrefix: string;
  className?: string;
}

/** Tabs with roving focus: arrow keys move between tabs, Home/End jump. */
export function Tabs<T extends string>({ tabs, value, onChange, label, idPrefix, className }: TabsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusTab = (index: number) => {
    const next = (index + tabs.length) % tabs.length;
    refs.current[next]?.focus();
    onChange(tabs[next].id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 };
    if (!(e.key in moves)) return;
    e.preventDefault();
    focusTab(moves[e.key]);
  };

  return (
    <div role="tablist" aria-label={label} className={cx("tabs", className)}>
      {tabs.map((tab, i) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            className={cx("tab", selected && "is-selected", tab.iconOnly && "is-icon-only")}
            title={tab.iconOnly ? tab.label : undefined}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {tab.icon && <tab.icon aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />}
            {tab.iconOnly ? <span className="visually-hidden">{tab.label}</span> : <span className="tab-label">{tab.label}</span>}
            {tab.count !== undefined && <CountBadge count={tab.count} label={tab.label} tone="neutral" />}
          </button>
        );
      })}
    </div>
  );
}
