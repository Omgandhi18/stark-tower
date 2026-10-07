import { useState } from "react";
import { Send, Trash2 } from "lucide-react";
import { Button, Dialog, OverflowMenu, SelectField } from "../../design";
import { errorMessage } from "../../lib/errors";
import type { TodoList } from "../../lib/types";
import { selectOrchestrator, useAgents } from "../../stores/agents";
import { useNavigation } from "../../stores/navigation";
import { useWorkspace } from "../../stores/workspace";
import { handList, removeList, updateList } from "./todoActions";
import { projectOptions, startHint, startOptions } from "./listFields";
import type { StartMode } from "./todoModel";

interface TodoListHeaderProps {
  list: TodoList;
  openCount: number;
}

/** A list's name and settings, handing it to the lead agent, and deleting it. */
export default function TodoListHeader({ list, openCount }: TodoListHeaderProps) {
  const projects = useWorkspace((s) => s.projects);
  const lead = useAgents(selectOrchestrator);
  const openTask = useNavigation((s) => s.openTask);
  const openTodoList = useNavigation((s) => s.openTodoList);
  const [name, setName] = useState(list.name);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e, failure));
    } finally {
      setBusy(false);
    }
  };
  const rename = () => {
    if (name.trim() && name !== list.name) void run(() => updateList(list, { name: name.trim() }), "The list couldn't be renamed.");
    else setName(list.name);
  };

  return (
    <header className="todo-list-head">
      <div className="todo-list-title-row">
        <input
          className="todo-list-title"
          value={name}
          aria-label="List name"
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <div className="todo-list-actions">
          {lead && (
            <Button
              icon={Send}
              disabled={busy || openCount === 0}
              title={openCount === 0 ? "Everything on this list is done." : `${lead.name} works through what's open, in order, doing or delegating each.`}
              onClick={() => void run(async () => openTask((await handList(list, lead.id)).id), "The list couldn't be handed over.")}
            >
              Hand to {lead.name}
            </Button>
          )}
          <OverflowMenu label={`More for ${list.name}`} items={[{ id: "delete", label: "Delete list", icon: Trash2, danger: true, onSelect: () => setDeleting(true) }]} />
        </div>
      </div>
      <div className="todo-list-settings">
        <SelectField
          label="Project"
          value={list.project}
          options={projectOptions(projects)}
          disabled={busy}
          onChange={(project) => void run(() => updateList(list, { project }), "The list's project couldn't be changed.")}
        />
        <SelectField
          label="When you assign an agent"
          value={list.start_mode}
          options={startOptions}
          helper={startHint(list.start_mode)}
          disabled={busy}
          onChange={(mode) => void run(() => updateList(list, { start_mode: mode as StartMode }), "That setting couldn't be changed.")}
        />
      </div>
      {error && (
        <p className="todo-error" role="alert">
          {error}
        </p>
      )}
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        icon={Trash2}
        tone="danger"
        title={`Delete “${list.name}”?`}
        description="Its to-dos go with it. Work agents did for them stays in your tasks."
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                void run(async () => {
                  await removeList(list.id);
                  setDeleting(false);
                  openTodoList(null);
                }, "The list couldn't be deleted.")
              }
            >
              Delete list
            </Button>
          </>
        }
      />
    </header>
  );
}
