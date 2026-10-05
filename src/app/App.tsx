import { lazy, Suspense, useEffect, useState } from "react";
import { KeepAlive, PortraitOutfits, SkeletonRows } from "../design";
import { IS_TAURI } from "../lib/platform";
import AgentsScreen from "../features/agents/AgentsScreen";
import AutomationsScreen from "../features/automations/AutomationsScreen";
import ConversationScreen from "../features/conversation/ConversationScreen";
import NotificationsScreen from "../features/notifications/NotificationsScreen";
import Onboarding from "../features/onboarding/Onboarding";
import SettingsScreen from "../features/settings/SettingsScreen";
import TaskScreen from "../features/task/TaskScreen";
import WorkScreen from "../features/work/WorkScreen";
import AppShell from "../shell/AppShell";
import { useConfig } from "../stores/config";
import { useNavigation, type RouteId } from "../stores/navigation";
import CloseGuard from "./CloseGuard";
import { useOutfitsFolder, useThemeSync } from "./theme";
import { useBackendSync } from "./useBackendSync";
import { useShortcuts } from "./useShortcuts";

// The room pulls in the WebGL renderer; load it the first time it's opened.
const EnvironmentScreen = lazy(() => import("../features/environment/EnvironmentScreen"));
// Dev-only: overlays the approved mockup for pixel comparison (stripped from builds).
const MockupCompare = import.meta.env.DEV ? lazy(() => import("../devtools/MockupCompare")) : null;

const ROUTE_LABEL: Record<RouteId, string> = {
  work: "Work",
  task: "Task",
  conversation: "Conversation",
  environment: "Environment",
  agents: "Agents",
  automations: "Automations",
  notifications: "Notifications",
  settings: "Settings",
};

/** Each route's screen. Component types stay stable, so a kept-alive screen is never remounted. */
function screenFor(route: RouteId, comparing: boolean) {
  switch (route) {
    case "work":
      return <WorkScreen />;
    case "task":
      return <TaskScreen />;
    case "conversation":
      return <ConversationScreen />;
    case "environment":
      return (
        <Suspense fallback={<SkeletonRows rows={3} label="Loading the room" className="route-loading" />}>
          <EnvironmentScreen comparing={comparing} />
        </Suspense>
      );
    case "agents":
      return <AgentsScreen />;
    case "automations":
      return <AutomationsScreen />;
    case "notifications":
      return <NotificationsScreen />;
    case "settings":
      return <SettingsScreen />;
  }
}

export default function App() {
  useBackendSync();
  useThemeSync();
  useShortcuts();
  const outfits = useOutfitsFolder();
  const route = useNavigation((s) => s.route);
  const visited = useNavigation((s) => s.visited);
  const navigate = useNavigation((s) => s.navigate);
  const config = useConfig((s) => s.config);
  const [comparing, setComparing] = useState(false);

  // Comparing against the mockup always shows the room.
  useEffect(() => {
    if (comparing) navigate("environment");
  }, [comparing, navigate]);

  return (
    <PortraitOutfits.Provider value={outfits}>
      <AppShell>
        {visited.map((id) => (
          <KeepAlive key={id} active={id === route} label={ROUTE_LABEL[id]}>
            {screenFor(id, comparing)}
          </KeepAlive>
        ))}
        {!IS_TAURI && (
          <p className="preview-notice" role="note">
            This is a browser preview. Agents, projects and settings load only inside the Starkline app.
          </p>
        )}
      </AppShell>
      {config && !config.onboarded && <Onboarding config={config} />}
      <CloseGuard />
      {MockupCompare && (
        <Suspense fallback={null}>
          <MockupCompare onActiveChange={setComparing} />
        </Suspense>
      )}
    </PortraitOutfits.Provider>
  );
}
