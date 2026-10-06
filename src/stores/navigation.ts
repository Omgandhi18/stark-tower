// Where the developer is in the app. Routes are mounted the first time they are
// visited and then kept alive, so switching screens never loses a chat draft,
// a camera position or a scroll offset.
import { create } from "zustand";

export type RouteId = "work" | "task" | "conversation" | "environment" | "agents" | "automations" | "reminders" | "notifications" | "settings";

export type SettingsSection = "general" | "providers" | "permissions" | "power" | "themes" | "diagnostics";

interface NavigationState {
  route: RouteId;
  /** The agent in focus: the open conversation, or the selection on Agents and the Environment. */
  agentId: string | null;
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
  /** Agents whose conversations were opened this session (their chats stay mounted). */
  openChats: string[];
  visited: RouteId[];
  navigate: (route: RouteId) => void;
  /** Open an agent's conversation screen. */
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

export const useNavigation = create<NavigationState>((set) => ({
  route: "work",
  agentId: null,
  settingsSection: "general",
  workProject: null,
  reviewId: null,
  taskId: null,
  notificationId: null,
  automationId: null,
  openChats: [],
  visited: ["work"],
  navigate: (route) => set((s) => ({ route, visited: markVisited(s.visited, route) })),
  openConversation: (agentId) =>
    set((s) => ({
      route: "conversation",
      agentId,
      openChats: remember(s.openChats, agentId),
      visited: markVisited(s.visited, "conversation"),
    })),
  focusAgent: (agentId) => set((s) => ({ agentId, openChats: remember(s.openChats, agentId) })),
  openSettings: (section) =>
    set((s) => ({ route: "settings", settingsSection: section, visited: markVisited(s.visited, "settings") })),
  showProject: (workProject) => set((s) => ({ route: "work", workProject, visited: markVisited(s.visited, "work") })),
  focusReview: (reviewId) =>
    set((s) => ({ route: "notifications", reviewId, notificationId: null, visited: markVisited(s.visited, "notifications") })),
  focusNotification: (notificationId) =>
    set((s) => ({ route: "notifications", notificationId, reviewId: null, visited: markVisited(s.visited, "notifications") })),
  openTask: (taskId) => set((s) => ({ route: "task", taskId, visited: markVisited(s.visited, "task") })),
  openAutomation: (automationId) =>
    set((s) => ({ route: "automations", automationId, visited: markVisited(s.visited, "automations") })),
}));
