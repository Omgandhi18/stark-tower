import { Activity, Moon, Palette, Plug, ShieldCheck, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { EmptyState, SkeletonRows, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { useConfig } from "../../stores/config";
import { useNavigation, type SettingsSection } from "../../stores/navigation";
import DiagnosticsSettings from "./DiagnosticsSettings";
import GeneralSettings from "./GeneralSettings";
import PermissionsSettings from "./PermissionsSettings";
import PowerSettings from "./PowerSettings";
import ProviderSettings from "./ProviderSettings";
import ThemeStudio from "./ThemeStudio";
import "./settings.css";

const SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string; icon: LucideIcon }> = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "providers", label: "Providers", icon: Plug },
  { id: "permissions", label: "Permissions", icon: ShieldCheck },
  { id: "power", label: "Power", icon: Moon },
  { id: "themes", label: "Theme Studio", icon: Palette },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
];

export default function SettingsScreen() {
  const section = useNavigation((s) => s.settingsSection);
  const openSettings = useNavigation((s) => s.openSettings);
  const config = useConfig((s) => s.config);
  const configError = useConfig((s) => s.error);

  const content = (() => {
    switch (section) {
      case "providers":
        if (config) return <ProviderSettings config={config} />;
        return configError ? (
          <EmptyState icon={Plug} title="Providers couldn't be loaded" body={configError} />
        ) : (
          <SkeletonRows rows={3} label="Loading providers" />
        );
      case "permissions":
        return <PermissionsSettings />;
      case "power":
        return <PowerSettings />;
      case "themes":
        return <ThemeStudio />;
      case "diagnostics":
        return <DiagnosticsSettings />;
      default:
        return <GeneralSettings />;
    }
  })();

  return (
    <div className="settings-screen">
      <nav className="settings-nav" aria-label="Settings">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={cx("settings-nav-item", id === section && "is-current")}
            aria-current={id === section ? "page" : undefined}
            onClick={() => openSettings(id)}
          >
            <Icon aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-content">{content}</div>
    </div>
  );
}
