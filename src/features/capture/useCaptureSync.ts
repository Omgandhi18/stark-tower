import { useEffect, useState } from "react";
import { getConfig, listAgents, listProjects, onConfigChanged, onCaptureShown } from "../../lib/api";
import { IS_TAURI } from "../../lib/platform";
import { errorMessage } from "../../lib/errors";
import { useAgents } from "../../stores/agents";
import { useConfig } from "../../stores/config";
import { useWorkspace } from "../../stores/workspace";

/** This window needs the roster, projects and theme, without the app's background UI. */
export function useCaptureSync() {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!IS_TAURI) return;
    let stopped = false;
    const load = async () => {
      try {
        const [agents, config, projects] = await Promise.all([listAgents(), getConfig(), listProjects()]);
        if (stopped) return;
        useAgents.getState().replace(agents);
        useConfig.getState().apply(config);
        useWorkspace.getState().applyProjects(projects);
        setError(null);
      } catch (e) {
        if (!stopped) setError(errorMessage(e, "Quick capture couldn't load. Close it and try again."));
      }
    };
    const subscriptions = [onConfigChanged(() => void load()), onCaptureShown(() => void load())];
    void load();
    return () => {
      stopped = true;
      for (const subscription of subscriptions) void subscription.then((off) => off()).catch(() => {});
    };
  }, []);
  return IS_TAURI ? error : "Quick capture works inside the Starkline app. Open it there to ask an agent or set a reminder.";
}
