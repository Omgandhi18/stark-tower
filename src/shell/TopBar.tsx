import { Bell, Bot, Moon, Sprout } from "lucide-react";
import { useActiveTheme } from "../app/theme";
import { CountBadge, IconButton, Toggle, cx, ICON_SIZE, ICON_STROKE } from "../design";
import { selectNeedsYouCount, useNotifications } from "../stores/notifications";
import { useNavigation } from "../stores/navigation";
import { useMemo } from "react";
import { useConfig } from "../stores/config";
import { runtimeStatus, useSystem } from "../stores/system";
import { budgetMeter } from "../features/spend/spendModel";
import { formatCost } from "../lib/format";
import { useSpend } from "../stores/spend";
import "../features/spend/spend.css";

/** Brand, runtime status, the attention bell and Keep Awake. Drags the window. */
export default function TopBar() {
  // The R&D tower's robot; the office and the cafe grow a sprout, as their mockups draw it.
  const BrandIcon = useActiveTheme() === "rnd" ? Bot : Sprout;
  const health = useSystem((s) => s.health);
  const power = useSystem((s) => s.power);
  const toggleKeepAwake = useSystem((s) => s.toggleKeepAwake);
  const spend = useSpend((s) => s.summary);
  const spendTone = spend ? budgetMeter(spend.budget, spend.budget_spend).tone : "quiet";
  const spendTitle = spendTone === "danger" ? "Budget used up. Open Spend settings." : spendTone === "attention" ? "Budget warning reached. Open Spend settings." : "Open Spend settings";
  const pending = useNotifications(selectNeedsYouCount);
  const navigate = useNavigation((s) => s.navigate);
  const openSettings = useNavigation((s) => s.openSettings);
  const agents = useConfig((s) => s.config?.agents);
  // Only the providers someone runs on need to be signed in.
  const usedEngines = useMemo(() => new Set((agents ?? []).filter((a) => a.enabled !== false).map((a) => a.engine ?? "")), [agents]);
  const verdict = runtimeStatus(health, usedEngines);

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <span className="brand-mark" aria-hidden>
          <BrandIcon size={ICON_SIZE.lg} strokeWidth={ICON_STROKE} />
        </span>
        <span className="brand-text" data-tauri-drag-region>
          <span className="brand-name">Starkline</span>
          <span className="brand-tagline">Local-first AI orchestration</span>
        </span>
      </div>

      <div className="topbar-spacer" data-tauri-drag-region />

      {spend?.has_spend && (
        <button type="button" className={cx("spend-chip", `spend-tone-${spendTone}`)} onClick={() => openSettings("spend")} title={spendTitle}>
          {formatCost(spend.today.cost_usd)} today
        </button>
      )}

      <button
        type="button"
        className="runtime-status"
        onClick={() => openSettings("diagnostics")}
        title={`${verdict.detail} Open Diagnostics for details.`}
        aria-label={`Agent runtime: ${verdict.label}. ${verdict.detail} Open Diagnostics.`}
      >
        <span className={cx("runtime-dot", `tone-${verdict.tone}`)} aria-hidden />
        <span className="runtime-text">
          <span className="runtime-name">Agent runtime</span>
          <span className={cx("runtime-verdict", `tone-${verdict.tone}`)}>{verdict.label}</span>
        </span>
      </button>

      <span className="topbar-divider" aria-hidden />

      <span className="bell">
        <IconButton icon={Bell} label={pending ? `Notifications, ${pending} need you` : "Notifications"} onClick={() => navigate("notifications")} />
        <CountBadge count={pending} label="need you" className="bell-badge" />
      </span>

      <span className="topbar-divider" aria-hidden />

      <div className="keep-awake" title={power?.reason}>
        <Moon aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} className="keep-awake-icon" />
        <Toggle
          label="Keep Awake"
          checked={power?.enabled ?? false}
          disabled={!power || !power.supported}
          onChange={(on) => {
            toggleKeepAwake(on).catch((e) => console.error("[power] couldn't change Keep Awake", e));
          }}
        />
      </div>
    </header>
  );
}
