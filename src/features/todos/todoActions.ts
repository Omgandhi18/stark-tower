// What the to-do views can do, kept apart from how they look: each saves through the backend
// and puts the result in the store at once (the change event's refresh follows).
import { deleteTodo, deleteTodoList, handTodoList, saveTodo, saveTodoList, setTodoDone, startTodo } from "../../lib/api";
import type { Task, Todo, TodoList } from "../../lib/types";
import { useTodos } from "../../stores/todos";
import type { StartMode } from "./todoModel";

type TodoChange = Partial<Pick<Todo, "title" | "notes" | "agent_id" | "due" | "list_id">>;

const refresh = () => void useTodos.getState().refresh().catch(() => undefined);

/** Add a to-do at the end of a list. */
export async function addTodo(listId: number, title: string): Promise<Todo> {
  const saved = await saveTodo({ id: null, list_id: listId, title, notes: "", agent_id: null, due: null });
  useTodos.getState().put(saved);
  return saved;
}

/** Change a to-do. Assigning an agent on a list that starts work at once starts it. */
export async function updateTodo(todo: Todo, change: TodoChange): Promise<Todo> {
  const next = { ...todo, ...change };
  const saved = await saveTodo({ id: todo.id, list_id: next.list_id, title: next.title, notes: next.notes, agent_id: next.agent_id, due: next.due });
  useTodos.getState().put(saved);
  return saved;
}

/** Tick it off, or back on. */
export async function toggleDone(todo: Todo): Promise<Todo> {
  const saved = await setTodoDone(todo.id, todo.done === null);
  useTodos.getState().put(saved);
  return saved;
}

export async function removeTodo(id: number): Promise<void> {
  await deleteTodo(id);
  useTodos.setState((s) => ({ todos: s.todos.filter((t) => t.id !== id) }));
}

/** Hand it to its agent now. */
export async function startWork(todo: Todo): Promise<Task> {
  const task = await startTodo(todo.id);
  useTodos.getState().put({ ...todo, task_id: task.id });
  refresh();
  return task;
}

export async function createList(name: string, project: string, startMode: StartMode): Promise<TodoList> {
  const saved = await saveTodoList({ id: null, name, project, start_mode: startMode });
  useTodos.getState().putList(saved);
  return saved;
}

export async function updateList(list: TodoList, change: Partial<Pick<TodoList, "name" | "project" | "start_mode">>): Promise<TodoList> {
  const next = { ...list, ...change };
  const saved = await saveTodoList({ id: list.id, name: next.name, project: next.project, start_mode: next.start_mode });
  useTodos.getState().putList(saved);
  return saved;
}

export async function removeList(id: number): Promise<void> {
  await deleteTodoList(id);
  useTodos.setState((s) => ({ lists: s.lists.filter((l) => l.id !== id), todos: s.todos.filter((t) => t.list_id !== id) }));
}

/** Hand a whole list to an agent, who works through what's open on it. */
export async function handList(list: TodoList, agentId: string): Promise<Task> {
  return handTodoList(list.id, agentId);
}

/** A project's list to add to: the first one tied to it, or a new one named after it. */
export async function listForProject(lists: readonly TodoList[], project: string, name: string): Promise<TodoList> {
  return lists[0] ?? createList(name, project, "manual");
}
