import { CalendarPlus, Plus, Search } from "lucide-react";
import { portraitKey, Button, EmptyState, Portrait, Toggle, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { formatRelative } from "../../lib/time";
import type { Agent, Automation } from "../../lib/types";
import { folderName } from "../../stores/workspace";
import { formatWhen, presentRun, type AutomationFilter } from "./automationModel";
import type { BuiltIn, BuiltInId } from "./builtIns";

const FILTERS: ReadonlyArray<{ id: AutomationFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "paused", label: "Paused" },
];

interface AutomationListProps {
  items: readonly Automation[];
  total: number;
  loaded: boolean;
  agents: readonly Agent[];
  builtIns: readonly BuiltIn[];
  selected: number | BuiltInId | null;
  onSelect: (id: number | BuiltInId) => void;
  onToggle: (automation: Automation, enabled: boolean) => void;
  onCreate: () => void;
  filter: AutomationFilter;
  onFilter: (filter: AutomationFilter) => void;
  query: string;
  onQuery: (query: string) => void;
  now: number;
}

/** Every automation, searchable and filtered, with the two built into Starkline below. */
export default function AutomationList(props: AutomationListProps) {
  const { items, total, loaded, agents, builtIns, selected, onSelect, onToggle, onCreate, filter, onFilter, query, onQuery, now } = props;
  return (
    <aside className="automation-sidebar" aria-label="Automations">
      <header className="automation-sidebar-head">
        <h1 className="screen-title">Automations</h1>
        <Button icon={Plus} onClick={onCreate}>
          New automation
        </Button>
      </header>
      <div className="automation-tools">
        <label className="automation-search">
          <Search aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
          <input
            type="search"
            className="selectable"
            placeholder="Search automations"
            aria-label="Search automations"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
        </label>
        <div className="automation-filters" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={cx("automation-filter", f.id === filter && "is-current")}
              aria-pressed={f.id === filter}
              onClick={() => onFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="automation-sidebar-scroll">
        {loaded && total === 0 ? (
          <EmptyState
            compact
            icon={CalendarPlus}
            title="No automations yet"
            body="Have an agent review code every night, write a morning brief, or audit dependencies each week."
            action={
              <Button variant="primary" icon={Plus} onClick={onCreate}>
                New automation
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <p className="automation-none">{query ? "No automations match your search." : "No automations here."}</p>
        ) : (
          <ul className="automation-rows">
            {items.map((a) => {
              const agent = agents.find((ag) => ag.id === a.agent_id);
              const last = a.last_status ? presentRun(a.last_status) : null;
              return (
                <li key={a.id} className={cx("automation-row", a.id === selected && "is-selected", !a.enabled && "is-paused")}>
                  <button type="button" className="automation-row-main" aria-current={a.id === selected ? "true" : undefined} onClick={() => onSelect(a.id)}>
                    <Portrait name={agent?.name ?? a.agent_id} figure={portraitKey(agent)} accent={agent?.accent} size={40} />
                    <span className="automation-row-text">
                      <span className="automation-row-name">{a.name}</span>
                      <span className="automation-row-meta">
                        {agent?.name ?? a.agent_id}
                        <span aria-hidden> · </span>
                        {folderName(a.cwd)}
                      </span>
                      <span className="automation-row-next">{a.enabled && a.next_run !== null ? `Next: ${formatWhen(a.next_run, now)}` : "Paused"}</span>
                    </span>
                  </button>
                  <span className="automation-row-side">
                    <Toggle label={`Run ${a.name} on its schedule`} hideLabel checked={a.enabled} onChange={(on) => onToggle(a, on)} />
                    {last && a.last_run !== null && (
                      <span className={cx("automation-row-last", `tone-${last.tone}`)}>
                        <span className="automation-row-last-label">{last.label}</span>
                        <span className="automation-row-last-when">{formatRelative(a.last_run, now)}</span>
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <section className="automation-builtins" aria-labelledby="automation-builtins-title">
          <h2 id="automation-builtins-title" className="automation-group-title">
            Built into Starkline
          </h2>
          <ul className="automation-rows">
            {builtIns.map((b) => {
              const Icon = b.icon;
              return (
                <li key={b.id} className={cx("automation-row", b.id === selected && "is-selected")}>
                  <button type="button" className="automation-row-main" aria-current={b.id === selected ? "true" : undefined} onClick={() => onSelect(b.id)}>
                    <span className="automation-builtin-icon" aria-hidden>
                      <Icon size={ICON_SIZE.lg} strokeWidth={ICON_STROKE} />
                    </span>
                    <span className="automation-row-text">
                      <span className="automation-row-name">{b.name}</span>
                      <span className="automation-row-meta">{b.status}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </aside>
  );
}
