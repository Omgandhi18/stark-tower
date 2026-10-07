// Your to-do lists and their to-dos, kept in step with the backend (agents change them too).
import { create } from "zustand";
import { listTodoLists, listTodos } from "../lib/api";
import type { Todo, TodoList } from "../lib/types";

interface TodosState {
  lists: TodoList[];
  todos: Todo[];
  loaded: boolean;
  /** The new-list dialog is open (it opens from the sidebar too). */
  creating: boolean;
  setCreating: (creating: boolean) => void;
  /** Re-read both from the backend. */
  refresh: () => Promise<void>;
  /** Put a saved to-do in place at once, before the change event's refresh. */
  put: (todo: Todo) => void;
  putList: (list: TodoList) => void;
}

export const useTodos = create<TodosState>((set) => ({
  lists: [],
  todos: [],
  loaded: false,
  creating: false,
  setCreating: (creating) => set({ creating }),
  refresh: async () => {
    const [lists, todos] = await Promise.all([listTodoLists(), listTodos()]);
    set({ lists, todos, loaded: true });
  },
  put: (todo) => set((s) => ({ todos: s.todos.some((t) => t.id === todo.id) ? s.todos.map((t) => (t.id === todo.id ? todo : t)) : [...s.todos, todo] })),
  putList: (list) => set((s) => ({ lists: s.lists.some((l) => l.id === list.id) ? s.lists.map((l) => (l.id === list.id ? list : l)) : [...s.lists, list] })),
}));
