import { Gauge } from "lucide-react";
import { Popover, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { useLimits } from "../../stores/limits";
import { useNavigation } from "../../stores/navigation";
import LimitsDetail from "./LimitsDetail";
import { chipText, percentLeft, providerTone, tightest } from "./limitsModel";
import "./limits.css";

const report = (e: unknown) => console.error("[limits] couldn't read usage limits", e);

/** The top bar's glance at each provider's usage limit, opening the detail. */
export default function LimitsMeter() {
  const limits = useLimits((s) => s.limits);
  const openSettings = useNavigation((s) => s.openSettings);
  if (!limits || limits.providers.length === 0) return null;
  const spoken = limits.providers
    .map((p) => {
      const worst = tightest(p);
      return worst ? `${p.name} ${percentLeft(worst)}% left (${worst.label})` : `${p.name} unavailable`;
    })
    .join(", ");

  return (
    <Popover
      label="Usage limits"
      align="end"
      className="limits-popover"
      trigger={(p) => (
        <button type="button" className="limits-chip" {...p} aria-label={`Usage limits: ${spoken}`} title="Usage limits left">
          <Gauge aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
          {limits.providers.map((provider) => {
            const worst = tightest(provider);
            return (
              <span key={provider.provider} className={cx("limits-chip-item", `limits-tone-${providerTone(provider)}`)}>
                {chipText(provider)}
                {worst && (
                  <span className="limits-chip-bar" aria-hidden>
                    <span style={{ width: `${100 - percentLeft(worst)}%` }} />
                  </span>
                )}
              </span>
            );
          })}
        </button>
      )}
    >
      {(close) => (
        <div className="limits-popover-body">
          <LimitsDetail limits={limits} onRefresh={() => void useLimits.getState().refresh().catch(report)} />
          <button
            type="button"
            className="limits-link"
            onClick={() => {
              close();
              openSettings("spend");
            }}
          >
            Open Spend settings
          </button>
        </div>
      )}
    </Popover>
  );
}
