import { useState } from "react";
import { ListPlus } from "lucide-react";
import { Button, Dialog, SelectField, TextField } from "../../design";
import { errorMessage } from "../../lib/errors";
import type { TodoList } from "../../lib/types";
import { useWorkspace } from "../../stores/workspace";
import { createList } from "./todoActions";
import { NO_PROJECT, projectOptions, startHint, startOptions } from "./listFields";
import type { StartMode } from "./todoModel";

interface NewListDialogProps {
  open: boolean;
  /** The project to suggest (the one Work shows). */
  project: string | null;
  onClose: () => void;
  onCreated: (list: TodoList) => void;
}

/** Name a new list, tie it to a project or not, and say what assigning an agent does on it. */
export default function NewListDialog({ open, project, onClose, onCreated }: NewListDialogProps) {
  const projects = useWorkspace((s) => s.projects);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState(project ?? NO_PROJECT);
  const [mode, setMode] = useState<StartMode>("manual");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = await createList(name.trim(), folder, mode);
      setName("");
      onCreated(list);
    } catch (e) {
      setError(errorMessage(e, "The list couldn't be made."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      icon={ListPlus}
      title="New to-do list"
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void create()}>
            Make the list
          </Button>
        </>
      }
    >
      <div className="todo-list-form">
        <TextField
          label="Name"
          value={name}
          placeholder="bi-whole release"
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) void create();
          }}
        />
        <SelectField label="Project" value={folder} options={projectOptions(projects)} helper="Where its agent work runs." onChange={setFolder} />
        <SelectField
          label="When you assign an agent"
          value={mode}
          options={startOptions}
          helper={startHint(mode)}
          onChange={(value) => setMode(value as StartMode)}
        />
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
