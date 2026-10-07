import { useNow } from "../../lib/useNow";
import { useNavigation } from "../../stores/navigation";
import { folderName } from "../../stores/workspace";
import TodoAdd from "./TodoAdd";
import TodoRow from "./TodoRow";
import { addTodo, listForProject } from "./todoActions";
import { useProjectTodos } from "./useProjectTodos";
import "./todos.css";

const CLOCK_MS = 30_000;

/** On Work, for the project it shows: what's left to do there, added to, assigned and started from here. */
export default function ProjectTodos({ project }: { project: string }) {
  const { lists, open } = useProjectTodos(project);
  const openTodoList = useNavigation((s) => s.openTodoList);
  const now = useNow(CLOCK_MS);
  const name = folderName(project);

  return (
    <div className="project-todos">
      <TodoAdd
        placeholder={`Add a to-do for ${name}`}
        onAdd={async (title) => addTodo((await listForProject(lists, project, name)).id, title)}
      />
      {open.length > 0 && (
        <ul className="todo-rows" aria-label={`To-dos for ${name}`}>
          {open.map((t) => (
            <TodoRow key={t.id} todo={t} list={lists.find((l) => l.id === t.list_id)} now={now} showList={lists.length > 1} onSelect={() => openTodoList(t.list_id)} />
          ))}
        </ul>
      )}
      {lists.length > 0 && (
        <button type="button" className="link-button project-todos-open" onClick={() => openTodoList(lists[0].id)}>
          {lists.length === 1 ? `Open “${lists[0].name}” in To-dos` : "Open in To-dos"}
        </button>
      )}
    </div>
  );
}
