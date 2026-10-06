// Projects (folders agents work in), saved chats, task cards and reported bugs:
// durable records owned by the backend, cached here for every screen.
import { create } from "zustand";
import { getBugs, getTasks, listConversations, listProjects, listWorktrees } from "../lib/api";
import type { Bug, Conversation, ProjectInfo, ProjectsState, Task, Worktree } from "../lib/types";

interface WorkspaceState {
  projects: ProjectInfo[];
  activeProject: string;
  conversations: Conversation[];
  tasks: Task[];
  bugs: Bug[];
  worktrees: Worktree[];
  refreshWorktrees: () => Promise<void>;
  loaded: { projects: boolean; conversations: boolean; tasks: boolean; bugs: boolean };
  applyProjects: (s: ProjectsState) => void;
  refreshProjects: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  refreshTasks: () => Promise<void>;
  refreshBugs: () => Promise<void>;
}

const TASK_LIMIT = 200;

export const useWorkspace = create<WorkspaceState>((set) => ({
  projects: [],
  activeProject: "",
  conversations: [],
  tasks: [],
  bugs: [],
  worktrees: [],
  refreshWorktrees: async () => { set({ worktrees: await listWorktrees() }); },
  loaded: { projects: false, conversations: false, tasks: false, bugs: false },
  applyProjects: (s) => set((st) => ({ projects: s.projects, activeProject: s.active, loaded: { ...st.loaded, projects: true } })),
  refreshProjects: async () => {
    const s = await listProjects();
    set((st) => ({ projects: s.projects, activeProject: s.active, loaded: { ...st.loaded, projects: true } }));
  },
  refreshConversations: async () => {
    const list = await listConversations();
    set((st) => ({ conversations: list, loaded: { ...st.loaded, conversations: true } }));
  },
  refreshTasks: async () => {
    const list = await getTasks(TASK_LIMIT);
    set((st) => ({ tasks: list, loaded: { ...st.loaded, tasks: true } }));
  },
  refreshBugs: async () => {
    const list = await getBugs();
    set((st) => ({ bugs: list, loaded: { ...st.loaded, bugs: true } }));
  },
}));

/** The last path segment: how a project folder is named in the UI. */
export const folderName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;
