import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, ChevronRight, Search } from "lucide-react";
import { FieldShell, ICON_SIZE, ICON_STROKE, Popover, cx } from "../../design";
import type { ModelChoice } from "../../lib/types";
import { findModel, isChosen, modelRows, type ModelRow } from "./modelSettings";
import "./modelSettings.css";

interface ModelMenuProps {
  models: readonly ModelChoice[];
  /** The chosen model's ID; "" for the default. */
  value: string;
  /** What the default runs on, and where that's set. */
  fallback: { name: string; note: string };
  /** Why there are no models to show yet (loading, not installed, failed). */
  status?: string | null;
  label: string;
  onPick: (id: string) => void;
}

const optionId = (listId: string, index: number) => `${listId}-${index}`;

function RowText({ row, fallback }: { row: ModelRow; fallback: ModelMenuProps["fallback"] }) {
  if (row.kind === "default") return <Lines name={fallback.name} note={fallback.note} />;
  if (row.kind === "custom") return <Lines name={row.typed ? `Use “${row.id}”` : row.id} note={row.typed ? "A model ID of your own" : "Not in the provider's list"} />;
  if (row.kind === "more") return <Lines name="More models" note={`${row.count} older or less common`} />;
  const { model } = row;
  return <Lines name={model.name} note={model.description || (model.name === model.id ? "" : model.id)} />;
}

function Lines({ name, note }: { name: string; note: string }) {
  return (
    <span className="model-option-text">
      <span className="model-option-name">{name}</span>
      {note && <span className="model-option-note">{note}</span>}
    </span>
  );
}

/** A searchable model list: the current models, older ones under "More models", and any ID typed in. */
export function ModelMenu({ models, value, fallback, status, label, onPick }: ModelMenuProps) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(() => Boolean(findModel(models, value)?.older));
  const rows = modelRows(models, value, query, expanded);
  const [active, setActive] = useState(() => ({ query: "", index: Math.max(0, rows.findIndex((r) => isChosen(r, value))) }));
  const index = active.query === query ? Math.min(active.index, rows.length - 1) : 0;

  useEffect(() => {
    document.getElementById(optionId(listId, index))?.scrollIntoView?.({ block: "nearest" });
  }, [listId, index]);

  const choose = (row: ModelRow) => {
    if (row.kind === "more") setExpanded((open) => !open);
    else onPick(row.kind === "default" ? "" : row.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive({ query, index: (index + step + rows.length) % rows.length });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[index]) choose(rows[index]);
    }
  };

  return (
    <div className="model-menu">
      <label className="model-search">
        <Search aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
        <input
          data-autofocus
          className="model-search-input"
          role="combobox"
          aria-label="Find a model"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows.length ? optionId(listId, index) : undefined}
          placeholder="Find a model, or type its ID"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      {status && <p className="model-menu-status">{status}</p>}
      <div id={listId} role="listbox" aria-label={label} className="model-list">
        {rows.map((row, i) => {
          const chosen = isChosen(row, value);
          return (
            <div
              key={row.key}
              id={optionId(listId, i)}
              role="option"
              aria-selected={chosen}
              className={cx("model-option", i === index && "is-active", row.kind === "more" && "is-more", row.kind === "model" && row.older && "is-older")}
              onPointerMove={() => i !== index && setActive({ query, index: i })}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(row)}
            >
              <RowText row={row} fallback={fallback} />
              {chosen && <Check aria-hidden className="model-option-mark" size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />}
              {row.kind === "more" && <ChevronRight aria-hidden className={cx("model-option-mark", expanded && "is-open")} size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />}
            </div>
          );
        })}
        {!rows.length && <p className="model-menu-status">Nothing matches “{query.trim()}”.</p>}
      </div>
    </div>
  );
}

interface ModelPickerProps extends Omit<ModelMenuProps, "label" | "onPick"> {
  label: string;
  helper?: string;
  onChange: (id: string) => void;
}

/** A field that shows the chosen model by name and opens the model list. */
export default function ModelPicker({ label, helper, models, value, fallback, status, onChange }: ModelPickerProps) {
  const shown = value ? (findModel(models, value)?.name ?? value) : fallback.name;
  return (
    <FieldShell label={label} helper={helper}>
      {({ id, describedBy }) => (
        <Popover
          label={`Choose the ${label.toLowerCase()}`}
          matchWidth
          className="model-popover"
          trigger={(props) => (
            <span className="select-wrap">
              <button {...props} id={id} type="button" role="combobox" aria-haspopup="dialog" aria-describedby={describedBy} className="input model-trigger">
                <span className="model-trigger-name">{shown}</span>
              </button>
              <ChevronDown aria-hidden className="select-chevron" size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
            </span>
          )}
        >
          {(close) => (
            <ModelMenu
              models={models}
              value={value}
              fallback={fallback}
              status={status}
              label={`${label} choices`}
              onPick={(next) => {
                close();
                onChange(next);
              }}
            />
          )}
        </Popover>
      )}
    </FieldShell>
  );
}
