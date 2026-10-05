import { Plug } from "lucide-react";
import { EmptyState, SkeletonRows } from "../../design";
import { useConfig } from "../../stores/config";
import { useNavigation } from "../../stores/navigation";
import DiagnosticsSettings from "./DiagnosticsSettings";
import GeneralSettings from "./GeneralSettings";
import PermissionsSettings from "./PermissionsSettings";
import PowerSettings from "./PowerSettings";
import ProviderSettings from "./ProviderSettings";
import ThemeStudio from "./ThemeStudio";
import "./settings.css";

/** The settings section chosen in the sidebar. */
export default function SettingsScreen() {
  const section = useNavigation((s) => s.settingsSection);
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
      <div className="settings-content">{content}</div>
    </div>
  );
}
