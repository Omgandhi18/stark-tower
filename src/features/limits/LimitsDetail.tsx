import { RefreshCw } from "lucide-react";
import { Button, Tag, cx } from "../../design";
import type { LimitWindow, ProviderLimits, UsageLimits } from "../../lib/bindings";
import { formatRelative } from "../../lib/time";
import { percentLeft, resetText, windowTone } from "./limitsModel";
import "./limits.css";

function WindowRow({ provider, window, limited }: { provider: string; window: LimitWindow; limited: boolean }) {
  const used = Math.round(window.used_percent);
  const left = percentLeft(window);
  const reset = resetText(window);
  return (
    <div className="limits-window">
      <div className="limits-window-head">
        <span>{window.label}</span>
        <strong>{left}% left</strong>
      </div>
      <div
        className={cx("limits-bar", `limits-tone-${windowTone(window, limited)}`)}
        role="meter"
        aria-label={`${provider} ${window.label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, used)}
        aria-valuetext={`${used}% used, ${left}% left`}
      >
        <span style={{ width: `${Math.min(100, Math.max(0, used))}%` }} />
      </div>
      <p className="limits-note">
        {used}% used{reset && ` · ${reset}`}
      </p>
    </div>
  );
}

function ProviderSection({ limits }: { limits: ProviderLimits }) {
  const { name, plan, windows, unavailable, limited, updated_at, checking } = limits;
  return (
    <section className="limits-provider" aria-label={`${name} usage limits`}>
      <header className="limits-provider-head">
        <strong>{name}</strong>
        {plan && <span className="limits-plan">{plan}</span>}
        {limited && <Tag tone="danger">Limit reached</Tag>}
      </header>
      {windows.length === 0 ? (
        <p className="limits-note">{unavailable ? `Unavailable: ${unavailable}` : checking ? "Checking…" : "Not checked yet."}</p>
      ) : (
        windows.map((w) => <WindowRow key={w.id} provider={name} window={w} limited={limited} />)
      )}
      {windows.length > 0 && unavailable && <p className="limits-note limits-stale">Couldn't refresh: {unavailable}</p>}
      {updated_at !== null && windows.length > 0 && <p className="limits-note">Checked {formatRelative(updated_at)}</p>}
    </section>
  );
}

/** Each provider's usage limits: how much is left in each window and when it resets. */
export default function LimitsDetail({ limits, onRefresh }: { limits: UsageLimits; onRefresh: () => void }) {
  const checking = limits.providers.some((p) => p.checking);
  if (limits.providers.length === 0) {
    return <p className="limits-note">Turn on Claude Code or Codex in Agents settings to see its usage limits.</p>;
  }
  return (
    <div className="limits-detail">
      {limits.providers.map((p) => (
        <ProviderSection key={p.provider} limits={p} />
      ))}
      <Button size="sm" icon={RefreshCw} onClick={onRefresh} disabled={checking} className="limits-refresh">
        {checking ? "Checking…" : "Check now"}
      </Button>
    </div>
  );
}
