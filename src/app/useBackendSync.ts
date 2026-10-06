// Keeps every store in step with the backend: one initial load, one
// subscription per backend event, and a slow reconcile for anything missed.
import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  checkUpdate,
  onSpendChanged,
  onCodeReviewsChanged,
  refreshCodeReviews,
  getConfig,
  listAgents,
  onAgentStatus,
  onAutomationsChanged,
  browserPage,
  browserNavigate,
  devserverList,
  onDevserverChanged,
  onDevserverOutput,
  onBrowserChanged,
  onBrowserReveal,
  onSimulatorReveal,
  onRemindersChanged,
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
  onWorkspacesChanged,
  onUpdateStatus,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { IS_TAURI } from "../lib/platform";
import { useCodeReviews } from "../stores/codeReviews";
import { useActivity } from "../stores/activity";
import { useAgents } from "../stores/agents";
import { useAttention } from "../stores/attention";
import { useAutomations } from "../stores/automations";
import { useDevServers } from "../stores/devservers";
import { usePreview } from "../stores/preview";
import { useReminders } from "../stores/reminders";
import { useChats } from "../stores/chats";
import { useConfig } from "../stores/config";
import { useNotifications } from "../stores/notifications";
import { useSystem } from "../stores/system";
import { useSpend } from "../stores/spend";
import { useWorkspace } from "../stores/workspace";

/** Statuses arrive as events; this only catches anything that slipped past. */
const AGENT_RECONCILE_MS = 10_000;
/** Provider installs and the bridge rarely change; re-check now and then. */
const HEALTH_REFRESH_MS = 60_000;
/** The first reads are retried, waiting a little longer each time: a failed one would leave its screen loading for good. */
const FIRST_LOAD_ATTEMPTS = 8;
const FIRST_LOAD_BACKOFF_MS = 400;
const FIRST_LOAD_BACKOFF_MAX_MS = 4_000;

const report = (what: string) => (error: unknown) => {
  console.error(`[sync] couldn't load ${what}: ${errorMessage(error, "unknown error")}`);
};

const reloadAgents = () => listAgents().then(useAgents.getState().replace).catch(report("agents"));

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Load something the app needs from the start, retrying until it works or `stopped` says to give up. */
async function firstLoad(load: () => Promise<unknown>, onFailure: (error: unknown) => void, stopped: () => boolean): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await load();
      return;
    } catch (error) {
      if (stopped()) return;
      if (attempt >= FIRST_LOAD_ATTEMPTS) {
        onFailure(error);
        return;
      }
      await wait(Math.min(FIRST_LOAD_BACKOFF_MS * 2 ** (attempt - 1), FIRST_LOAD_BACKOFF_MAX_MS));
      if (stopped()) return;
    }
  }
}

export function useBackendSync() {
  useEffect(() => {
    if (!IS_TAURI) return;

    const refreshReviews = () => void refreshCodeReviews().catch(report("code review"));
    window.addEventListener("focus", refreshReviews);
    const workspace = useWorkspace.getState();
    const system = useSystem.getState();
    let unmounted = false;
    const stopped = () => unmounted;
    const first = (what: string, load: () => Promise<unknown>) => void firstLoad(load, report(what), stopped);

    first("agents", () => listAgents().then(useAgents.getState().replace));
    void firstLoad(
      () => getConfig().then(useConfig.getState().apply),
      (e) => useConfig.getState().fail(errorMessage(e, "The configuration couldn't be read.")),
      stopped,
    );
    first("spending", useSpend.getState().refresh);
    first("projects", workspace.refreshProjects);
    first("saved chats", workspace.refreshConversations);
    first("worktrees", workspace.refreshWorktrees);
    first("tasks", workspace.refreshTasks);
    first("code review", useCodeReviews.getState().refresh);
    first("bugs", workspace.refreshBugs);
    first("pending reviews", useAttention.getState().refresh);
    first("notifications", useNotifications.getState().refresh);
    first("automations", useAutomations.getState().refresh);
    first("reminders", useReminders.getState().refresh);
    first("dev servers", () => devserverList().then((servers) => servers.forEach(useDevServers.getState().apply)));
    first("browser", () => browserPage().then(usePreview.getState().applyPage));
    first("runtime health", system.refreshHealth);
    first("keep-awake state", system.refreshPower);
    first("update status", checkUpdate);

    const subscriptions: Array<Promise<UnlistenFn>> = [
      onCodeReviewsChanged(useCodeReviews.getState().apply),
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
      onSpendChanged(() => useSpend.getState().changed().catch(report("spending"))),
      onWorkspacesChanged(() => useWorkspace.getState().refreshWorktrees().catch(report("worktrees"))),
      onTasksChanged(() => useWorkspace.getState().refreshTasks().catch(report("tasks"))),
      onConversationsChanged(() => useWorkspace.getState().refreshConversations().catch(report("saved chats"))),
      onBugsChanged(() => useWorkspace.getState().refreshBugs().catch(report("bugs"))),
      onUpdateStatus((s) => useSystem.getState().applyUpdate(s)),
      onPowerState((p) => useSystem.getState().applyPower(p)),
      onNotificationsChanged(() => useNotifications.getState().refresh().catch(report("notifications"))),
      onAutomationsChanged(() => useAutomations.getState().refreshAll().catch(report("automations"))),
      onRemindersChanged(() => useReminders.getState().refresh().catch(report("reminders"))),
      onDevserverChanged((server) => {
        const previous = useDevServers.getState().servers[server.folder];
        useDevServers.getState().apply(server);
        if (server.status === "running" && server.address && (previous?.generation !== server.generation || previous?.address !== server.address || previous?.status !== "running")) {
          if (server.open_page || !usePreview.getState().page.url) browserNavigate(server.address).catch(report("dev server page"));
        }
      }),
      onDevserverOutput((output) => useDevServers.getState().append(output)),
      onBrowserChanged((page) => usePreview.getState().applyPage(page)),
      onBrowserReveal(() => usePreview.getState().show("browser")),
      onSimulatorReveal((udid) => {
        usePreview.getState().showSimulator(udid);
        usePreview.getState().show("simulator");
      }),
      onHealthChanged(() => useSystem.getState().refreshHealth().catch(report("runtime health"))),
    ];
    // Background checks started by the first health read may answer before their listener
    // exists; one more read once every listener is in place picks those answers up.
    Promise.all(subscriptions)
      .then(() => firstLoad(useSystem.getState().refreshHealth, report("runtime health"), stopped))
      .catch(report("runtime health"));

    const agentTimer = window.setInterval(reloadAgents, AGENT_RECONCILE_MS);
    const spendTimer = window.setInterval(() => useSpend.getState().refresh().catch(report("spending")), HEALTH_REFRESH_MS);
    const healthTimer = window.setInterval(() => useSystem.getState().refreshHealth().catch(report("runtime health")), HEALTH_REFRESH_MS);
    return () => {
      unmounted = true;
      window.removeEventListener("focus", refreshReviews);
      window.clearInterval(agentTimer);
      window.clearInterval(healthTimer);
      window.clearInterval(spendTimer);
      for (const unlisten of subscriptions) unlisten.then((off) => off()).catch(() => {});
    };
  }, []);
}
