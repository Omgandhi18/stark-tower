import { useState } from "react";
import { Plus } from "lucide-react";
import { ICON_SIZE, ICON_STROKE } from "../../design";
import { errorMessage } from "../../lib/errors";

interface TodoAddProps {
  /** Add it; rejects with the reason it couldn't be. */
  onAdd: (title: string) => Promise<unknown>;
  placeholder: string;
}

/** Type a to-do and press Return; the box stays ready for the next. */
export default function TodoAdd({ onAdd, placeholder }: TodoAddProps) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    const text = title.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(text);
      setTitle("");
    } catch (e) {
      setError(errorMessage(e, "That to-do couldn't be added."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="todo-add">
      <Plus aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} className="todo-add-icon" />
      <input
        className="todo-add-input"
        value={title}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void add();
          }
        }}
      />
      {error && (
        <p className="todo-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
