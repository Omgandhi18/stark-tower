// Where the developer is in the app. Routes are mounted the first time they are
// visited and then kept alive, so switching screens never loses a chat draft,
// a camera position or a scroll offset.
import { create } from "zustand";

export type RouteId = "work" | "task" | "environment" | "agents" | "automations" | "reminders" | "notifications" | "settings";

export type SettingsSection = "general" | "notifications" | "voices" | "spend" | "providers" | "permissions" | "power" | "themes" | "diagnostics";

interface NavigationState {
  route: RouteId;
  /** The agent in focus: the selection on Agents and the Environment, or whose chat was opened last. */
  agentId: string | null;
  /** An agent whose current chat is opening on the task screen; null once its task is known. */
  chatAgent: string | null;
  settingsSection: SettingsSection;
  /** The project Work is showing (its tasks, its chats in the sidebar); null for all work. */
  workProject: string | null;
  /** The review open in the Notification Centre. */
  reviewId: string | null;
  /** The task open on the task screen. */
  taskId: string | null;
  /** The notification open in the Notification Centre. */
  notificationId: number | null;
  /** The automation open on Automations. */
  automationId: number | null;
  /** Agents whose chats were opened this session (the Environment's drawer keeps them mounted). */
  openChats: string[];
  visited: RouteId[];
  navigate: (route: RouteId) => void;
  /** Open the chat an agent talks in now, as its task (starting one if they have none). */
  openConversation: (agentId: string) => void;
  /** Focus an agent without leaving the current screen. */
  focusAgent: (agentId: string) => void;
  openSettings: (section: SettingsSection) => void;
  /** Show one project's work (null: all work) on Work. */
  showProject: (path: string | null) => void;
  /** Open a pending review in the Notification Centre. */
  focusReview: (reviewId: string | null) => void;
  /** Open a task's screen. */
  openTask: (taskId: string) => void;
  /** Open a notification in the Notification Centre. */
  focusNotification: (id: number | null) => void;
  /** Open an automation on Automations. */
  openAutomation: (id: number | null) => void;
}

const markVisited = (visited: RouteId[], route: RouteId) => (visited.includes(route) ? visited : [...visited, route]);

const remember = (openChats: string[], agentId: string) => (openChats.includes(agentId) ? openChats : [...openChats, agentId]);

/** Going anywhere else drops a chat that's still opening, so it can't pull you back when it's found. */
const goTo = (route: RouteId, visited: RouteId[]) => ({ route, chatAgent: null, visited: markVisited(visited, route) });

export const useNavigation = create<NavigationState>((set) => ({
  route: "work",
  agentId: null,
  chatAgent: null,
  settingsSection: "general",
  workProject: null,
  reviewId: null,
  taskId: null,
  notificationId: null,
  automationId: null,
  openChats: [],
  visited: ["work"],
  navigate: (route) => set((s) => goTo(route, s.visited)),
  openConversation: (agentId) =>
    set((s) => ({ ...goTo("task", s.visited), agentId, chatAgent: agentId, taskId: null, openChats: remember(s.openChats, agentId) })),
  focusAgent: (agentId) => set((s) => ({ agentId, openChats: remember(s.openChats, agentId) })),
  openSettings: (section) => set((s) => ({ ...goTo("settings", s.visited), settingsSection: section })),
  showProject: (workProject) => set((s) => ({ ...goTo("work", s.visited), workProject })),
  focusReview: (reviewId) => set((s) => ({ ...goTo("notifications", s.visited), reviewId, notificationId: null })),
  focusNotification: (notificationId) => set((s) => ({ ...goTo("notifications", s.visited), notificationId, reviewId: null })),
  openTask: (taskId) => set((s) => ({ ...goTo("task", s.visited), taskId })),
  openAutomation: (automationId) => set((s) => ({ ...goTo("automations", s.visited), automationId })),
}));
