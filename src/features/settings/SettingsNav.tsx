import { Activity, Moon, Palette, Plug, ShieldCheck, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { useNavigation, type SettingsSection } from "../../stores/navigation";

const SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string; icon: LucideIcon }> = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "providers", label: "Providers", icon: Plug },
  { id: "permissions", label: "Permissions", icon: ShieldCheck },
  { id: "power", label: "Power", icon: Moon },
  { id: "themes", label: "Theme Studio", icon: Palette },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
];

/** Settings' sections, nested under it in the sidebar. */
export default function SettingsNav() {
  const section = useNavigation((s) => s.settingsSection);
  const openSettings = useNavigation((s) => s.openSettings);
  return (
    <ul className="nav-sub" aria-label="Settings sections">
      {SECTIONS.map(({ id, label, icon: Icon }) => (
        <li key={id}>
          <button
            type="button"
            className={cx("nav-sub-item", id === section && "is-current")}
            aria-current={id === section ? "page" : undefined}
            onClick={() => openSettings(id)}
          >
            <Icon aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
            <span className="nav-sub-label">{label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
