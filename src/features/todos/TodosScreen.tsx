import { useMemo, useState } from "react";
import { ListChecks, ListPlus } from "lucide-react";
import { Button, EmptyState, SkeletonRows } from "../../design";
import type { TodoList } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { useNavigation } from "../../stores/navigation";
import { useTodos } from "../../stores/todos";
import NewListDialog from "./NewListDialog";
import TodoAdd from "./TodoAdd";
import TodoDetail from "./TodoDetail";
import TodoListHeader from "./TodoListHeader";
import TodoRow from "./TodoRow";
import { addTodo, createList } from "./todoActions";
import { openCounts, splitTodos } from "./todoModel";
import "./todos.css";

const CLOCK_MS = 30_000;
/** Where a to-do goes when it's added with no list to put it on. */
const FIRST_LIST = "Inbox";

/**
 * Your to-do lists: one list (or what's open on all of them), and the to-do you picked in full.
 * Each can be handed to an agent, who does it as an ordinary task in its chat for the project.
 */
export default function TodosScreen() {
  const lists = useTodos((s) => s.lists);
  const todos = useTodos((s) => s.todos);
  const loaded = useTodos((s) => s.loaded);
  const listId = useNavigation((s) => s.todoList);
  const workProject = useNavigation((s) => s.workProject);
  const openTodoList = useNavigation((s) => s.openTodoList);
  const creating = useTodos((s) => s.creating);
  const [selected, setSelected] = useState<number | null>(null);
  const now = useNow(CLOCK_MS);
  const list = lists.find((l) => l.id === listId);
  const counts = useMemo(() => openCounts(todos), [todos]);
  const picked = todos.find((t) => t.id === selected);

  const row = (todo: (typeof todos)[number], showList = false) => (
    <TodoRow
      key={todo.id}
      todo={todo}
      list={lists.find((l) => l.id === todo.list_id)}
      now={now}
      showList={showList}
      selected={todo.id === selected}
      onSelect={() => setSelected(todo.id === selected ? null : todo.id)}
    />
  );

  // Added with no list open: onto the first list, or a new Inbox.
  const addAnywhere = async (title: string) => {
    const target: TodoList = lists[0] ?? (await createList(FIRST_LIST, "", "manual"));
    return addTodo(target.id, title);
  };

  const body = () => {
    if (!loaded) return <SkeletonRows rows={4} label="Loading your to-dos" />;
    if (list) {
      const { open, done } = splitTodos(todos.filter((t) => t.list_id === list.id));
      return (
        <>
          <TodoListHeader key={list.id} list={list} openCount={open.length} />
          <TodoAdd placeholder={`Add a to-do to ${list.name}`} onAdd={(title) => addTodo(list.id, title)} />
          {open.length === 0 ? (
            <EmptyState compact icon={ListChecks} title="Nothing left to do" body="Add a to-do above. Agents add the follow-ups they find, too." />
          ) : (
            <ul className="todo-rows" aria-label={`Open on ${list.name}`}>
              {open.map((t) => row(t))}
            </ul>
          )}
          {done.length > 0 && (
            <details className="todo-done">
              <summary>Done ({done.length})</summary>
              <ul className="todo-rows" aria-label={`Done on ${list.name}`}>
                {done.map((t) => row(t))}
              </ul>
            </details>
          )}
        </>
      );
    }
    const open = splitTodos(todos).open;
    return (
      <>
        <header className="screen-header">
          <h1 className="screen-title">To-dos</h1>
          <p className="screen-subtitle">
            Keep lists of what needs doing, for yourself or for the team. Assign a to-do to an agent and it does it as a task in its chat for the
            list's project; agents tick off what they finish and add the follow-ups they find.
          </p>
        </header>
        <TodoAdd placeholder={lists[0] ? `Add a to-do to ${lists[0].name}` : "Add a to-do"} onAdd={addAnywhere} />
        {lists.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="No lists yet"
            body="Add a to-do above to start an Inbox, or make a list for a project."
            action={
              <Button icon={ListPlus} onClick={() => useTodos.getState().setCreating(true)}>
                New list
              </Button>
            }
          />
        ) : (
          lists.map((l) => {
            const items = open.filter((t) => t.list_id === l.id);
            return (
              <section key={l.id} className="todo-group" aria-label={l.name}>
                <button type="button" className="todo-group-title" onClick={() => openTodoList(l.id)}>
                  {l.name}
                  <span className="todo-group-count">{counts.get(l.id) ?? 0}</span>
                </button>
                {items.length > 0 ? <ul className="todo-rows">{items.map((t) => row(t))}</ul> : <p className="todo-group-empty">Nothing left to do.</p>}
              </section>
            );
          })
        )}
      </>
    );
  };

  return (
    <div className="todos-screen">
      <div className="todos-page">{body()}</div>
      {picked && <TodoDetail key={picked.id} todo={picked} lists={lists} now={now} onClose={() => setSelected(null)} />}
      <NewListDialog
        open={creating}
        project={workProject}
        onClose={() => useTodos.getState().setCreating(false)}
        onCreated={(created) => {
          useTodos.getState().setCreating(false);
          openTodoList(created.id);
        }}
      />
    </div>
  );
}
