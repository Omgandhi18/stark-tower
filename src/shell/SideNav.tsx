import type { ComponentType } from "react";
import { ArrowUpCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CountBadge, cx, ICON_SIZE, ICON_STROKE } from "../design";
import { NAV_ITEMS, navRouteFor } from "../app/routes";
import SettingsNav from "../features/settings/SettingsNav";
import ProjectNav from "../features/work/ProjectNav";
import { useNavigation, type RouteId } from "../stores/navigation";
import { selectNeedsYouCount, useNotifications } from "../stores/notifications";
import { useSystem } from "../stores/system";

/** A destination's own places, nested under it while it's open. */
const NESTED: Partial<Record<RouteId, ComponentType>> = { work: ProjectNav, settings: SettingsNav };

/** The six destinations, with the open one's places nested under it. Notifications carries the count of things that need you. */
export default function SideNav() {
  const current = useNavigation((s) => navRouteFor(s.route));
  const navigate = useNavigation((s) => s.navigate);
  const pending = useNotifications(selectNeedsYouCount);
  const update = useSystem((s) => s.update);

  return (
    <nav className="sidenav" aria-label="Main">
      <ul className="nav-list">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.route === current;
          const Nested = active ? NESTED[item.route] : undefined;
          return (
            <li key={item.route}>
              <button
                type="button"
                className={cx("nav-item", active && "is-active")}
                aria-current={active ? "page" : undefined}
                title={`${item.label}  ⌘${item.shortcut}`}
                onClick={() => navigate(item.route)}
              >
                <Icon aria-hidden size={ICON_SIZE.lg} strokeWidth={ICON_STROKE} />
                <span className="nav-label">{item.label}</span>
                {item.route === "notifications" && <CountBadge count={pending} label="need you" />}
              </button>
              {Nested && <Nested />}
            </li>
          );
        })}
      </ul>

      {update?.available && update.latest && (
        <button
          type="button"
          className="nav-update"
          onClick={() => {
            if (update.url) openUrl(update.url).catch((e) => console.error("[update] couldn't open the release page", e));
          }}
        >
          <ArrowUpCircle aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
          <span>
            Update {update.latest}
            <span className="nav-update-sub">available on GitHub</span>
          </span>
        </button>
      )}
    </nav>
  );
}
