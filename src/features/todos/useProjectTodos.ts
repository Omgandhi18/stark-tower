import { useMemo } from "react";
import type { Todo, TodoList } from "../../lib/types";
import { useTodos } from "../../stores/todos";
import { listsFor, splitTodos } from "./todoModel";

/** A project's lists, and what's open on them. */
export function useProjectTodos(project: string): { lists: TodoList[]; open: Todo[] } {
  const lists = useTodos((s) => s.lists);
  const todos = useTodos((s) => s.todos);
  return useMemo(() => {
    const mine = listsFor(lists, project);
    const ids = new Set(mine.map((l) => l.id));
    return { lists: mine, open: splitTodos(todos.filter((t) => ids.has(t.list_id))).open };
  }, [lists, todos, project]);
}
