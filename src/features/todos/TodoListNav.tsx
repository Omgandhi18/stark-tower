import { useMemo } from "react";
import { Folder, List, ListChecks, ListPlus } from "lucide-react";
import { cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { useNavigation } from "../../stores/navigation";
import { useTodos } from "../../stores/todos";
import { openCounts } from "./todoModel";

/** To-dos' places, nested under it in the sidebar: everything open, each list, making one. */
export default function TodoListNav() {
  const lists = useTodos((s) => s.lists);
  const todos = useTodos((s) => s.todos);
  const current = useNavigation((s) => s.todoList);
  const openTodoList = useNavigation((s) => s.openTodoList);
  const counts = useMemo(() => openCounts(todos), [todos]);
  const all = useMemo(() => [...counts.values()].reduce((sum, n) => sum + n, 0), [counts]);

  return (
    <ul className="nav-sub" aria-label="To-do lists">
      <li>
        <button type="button" className={cx("nav-sub-item", current === null && "is-current")} aria-pressed={current === null} onClick={() => openTodoList(null)}>
          <ListChecks aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
          <span className="nav-sub-label">All to-dos</span>
          {all > 0 && <span className="nav-sub-count">{all}</span>}
        </button>
      </li>
      {lists.map((list) => {
        const Icon = list.project ? Folder : List;
        const count = counts.get(list.id) ?? 0;
        return (
          <li key={list.id}>
            <button
              type="button"
              className={cx("nav-sub-item", current === list.id && "is-current")}
              aria-pressed={current === list.id}
              title={list.project ? `${list.name} · ${list.project}` : list.name}
              onClick={() => openTodoList(list.id)}
            >
              <Icon aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
              <span className="nav-sub-label">{list.name}</span>
              {count > 0 && <span className="nav-sub-count">{count}</span>}
            </button>
          </li>
        );
      })}
      <li>
        <button type="button" className="nav-sub-item is-quiet" onClick={() => useTodos.getState().setCreating(true)}>
          <ListPlus aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
          <span className="nav-sub-label">New list</span>
        </button>
      </li>
    </ul>
  );
}
