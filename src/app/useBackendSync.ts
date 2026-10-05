// Keeps every store in step with the backend: one initial load, one
// subscription per backend event, and a slow reconcile for anything missed.
import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  checkUpdate,
  getConfig,
  listAgents,
  onAgentStatus,
  onAutomationsChanged,
  onBugsChanged,
  onChatEvent,
  onChatSwitched,
  onConfigChanged,
  onConversationsChanged,
  onHealthChanged,
  onNotificationsChanged,
  onPowerState,
  onReviewRequest,
  onReviewResolved,
  onTasksChanged,
  onUpdateStatus,
  onUsageUpdate,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { IS_TAURI } from "../lib/platform";
import { useActivity } from "../stores/activity";
import { useAgents } from "../stores/agents";
import { useAttention } from "../stores/attention";
import { useAutomations } from "../stores/automations";
import { useChats } from "../stores/chats";
import { useConfig } from "../stores/config";
import { useNotifications } from "../stores/notifications";
import { useSystem } from "../stores/system";
import { useUsage } from "../stores/usage";
import { useWorkspace } from "../stores/workspace";

/** Statuses arrive as events; this only catches anything that slipped past. */
const AGENT_RECONCILE_MS = 10_000;
/** Provider installs and the bridge rarely change; re-check now and then. */
const HEALTH_REFRESH_MS = 60_000;

const report = (what: string) => (error: unknown) => {
  console.error(`[sync] couldn't load ${what}: ${errorMessage(error, "unknown error")}`);
};

const reloadAgents = () => listAgents().then(useAgents.getState().replace).catch(report("agents"));

export function useBackendSync() {
  useEffect(() => {
    if (!IS_TAURI) return;

    const workspace = useWorkspace.getState();
    const system = useSystem.getState();

    reloadAgents();
    getConfig()
      .then(useConfig.getState().apply)
      .catch((e) => useConfig.getState().fail(errorMessage(e, "The configuration couldn't be read.")));
    workspace.refreshProjects().catch(report("projects"));
    workspace.refreshConversations().catch(report("saved chats"));
    workspace.refreshTasks().catch(report("tasks"));
    workspace.refreshBugs().catch(report("bugs"));
    useAttention.getState().refresh().catch(report("pending reviews"));
    useNotifications.getState().refresh().catch(report("notifications"));
    useAutomations.getState().refresh().catch(report("automations"));
    system.refreshHealth().catch(report("runtime health"));
    system.refreshPower().catch(report("keep-awake state"));
    checkUpdate().catch(report("update status"));

    const subscriptions: Array<Promise<UnlistenFn>> = [
      onAgentStatus((e) => useAgents.getState().setStatus(e.agentId, e.status)),
      onConfigChanged((c) => {
        useConfig.getState().apply(c);
        reloadAgents();
        useSystem.getState().refreshHealth().catch(report("runtime health"));
      }),
      onReviewRequest((r) => useAttention.getState().add(r)),
      onReviewResolved((id) => useAttention.getState().remove(id)),
      onChatEvent((e) => {
        useActivity.getState().record(e);
        useChats.getState().apply(e);
      }),
      onChatSwitched((s) => useChats.getState().switchTo(s.agentId, s.conversationId)),
      onUsageUpdate((u) => useUsage.getState().record(u)),
      onTasksChanged(() => useWorkspace.getState().refreshTasks().catch(report("tasks"))),
      onConversationsChanged(() => useWorkspace.getState().refreshConversations().catch(report("saved chats"))),
      onBugsChanged(() => useWorkspace.getState().refreshBugs().catch(report("bugs"))),
      onUpdateStatus((s) => useSystem.getState().applyUpdate(s)),
      onPowerState((p) => useSystem.getState().applyPower(p)),
      onNotificationsChanged(() => useNotifications.getState().refresh().catch(report("notifications"))),
      onAutomationsChanged(() => useAutomations.getState().refreshAll().catch(report("automations"))),
      onHealthChanged(() => useSystem.getState().refreshHealth().catch(report("runtime health"))),
    ];
    // Background checks started by the first health read may answer before their listener
    // exists; one more read once every listener is in place picks those answers up.
    Promise.all(subscriptions)
      .then(() => useSystem.getState().refreshHealth())
      .catch(report("runtime health"));

    const agentTimer = window.setInterval(reloadAgents, AGENT_RECONCILE_MS);
    const healthTimer = window.setInterval(() => useSystem.getState().refreshHealth().catch(report("runtime health")), HEALTH_REFRESH_MS);
    return () => {
      window.clearInterval(agentTimer);
      window.clearInterval(healthTimer);
      for (const unlisten of subscriptions) unlisten.then((off) => off()).catch(() => {});
    };
  }, []);
}
