import { useEffect, useRef, useState } from "react";
import { Button, Dialog, TextArea, TextField } from "../../design";
import { cancelDeliveryDraft, commitTask, createTaskRequest, deliveryInfo, draftDelivery, pushTask } from "../../lib/api";
import type { DeliveryInfo, FileChange, Task } from "../../lib/types";
import { useAgents } from "../../stores/agents";
import { useWorkspace } from "../../stores/workspace";
import { changeLetter } from "./taskPresentation";
import "./delivery.css";

function DeliveryError({ error }: { error: string | null }) {
  if (!error) return null;
  const [message, detail] = error.split("\n\nDetails\n");
  return (
    <div className="delivery-error" role="alert">
      <p>{message}</p>
      {detail && (
        <details>
          <summary>Details</summary>
          <pre className="selectable">{detail}</pre>
        </details>
      )}
    </div>
  );
}

function DeliveryDialog({
  task,
  changes,
  info,
  mode,
  onClose,
  onDone,
}: {
  task: Task;
  changes: readonly FileChange[];
  info: DeliveryInfo;
  mode: "commit" | "request";
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const name = useAgents((s) => s.agents.find((a) => a.id === task.assignee)?.name ?? task.assignee);
  const [paths, setPaths] = useState(changes.map((c) => c.path));
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState(info.request_title);
  const [base, setBase] = useState(info.default_branch);
  const [branch, setBranch] = useState(info.new_branch);
  const [newBranch, setNewBranch] = useState(info.branch === info.default_branch);
  const [draft, setDraft] = useState(false);
  const [writing, setWriting] = useState(true);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState(false);
  const token = useRef<string | null>(null);
  const [initialPaths] = useState(() => changes.map((c) => c.path));
  const request = mode === "request";
  const noun = info.host?.kind === "gitlab" ? "merge request" : "pull request";
  const cancel = () => {
    const current = token.current;
    token.current = null;
    if (current) void cancelDeliveryDraft(current);
  };
  const write = () => {
    cancel();
    const current = crypto.randomUUID();
    token.current = current;
    setWriting(true);
    setWarning(null);
    draftDelivery(task.id, paths, request, current)
      .then((result) => {
        if (token.current !== current) return;
        setMessage(result.text);
        setWarning(result.warning);
        setWriting(false);
        token.current = null;
      })
      .catch((e: unknown) => {
        if (token.current !== current) return;
        setMessage(request ? "" : task.title);
        setWarning(String(e));
        setWriting(false);
        token.current = null;
      });
  };
  useEffect(() => {
    const current = crypto.randomUUID();
    token.current = current;
    // The promise updates the box only while this draft still owns it.
    draftDelivery(task.id, initialPaths, request, current)
      .then((result) => {
        if (token.current !== current) return;
        setMessage(result.text);
        setWarning(result.warning);
        setWriting(false);
        token.current = null;
      })
      .catch((e: unknown) => {
        if (token.current !== current) return;
        setMessage(request ? "" : task.title);
        setWarning(String(e));
        setWriting(false);
        token.current = null;
      });
    return () => {
      const active = token.current;
      token.current = null;
      if (active) void cancelDeliveryDraft(active);
    };
  }, [task.id, task.title, initialPaths, request]);
  const isWriting = writing;
  const close = () => {
    cancel();
    onClose();
  };
  const submit = async (push: boolean) => {
    cancel();
    setBusy(true);
    setError(null);
    try {
      if (committed) await pushTask(task.id);
      else if (request) await createTaskRequest(task.id, { title, body: message, base, draft });
      else await commitTask(task.id, { paths, message, branch: newBranch ? branch : null, push });
      await onDone();
      onClose();
    } catch (e) {
      const failure = e instanceof Error ? e.message : String(e);
      if (failure.startsWith("The commit is saved.")) setCommitted(true);
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={close}
      dismissible={!busy}
      title={request ? `Open ${noun}` : "Commit changes"}
      size="lg"
      actions={
        <>
          <Button onClick={close} disabled={busy}>
            Cancel
          </Button>
          {!request && !committed && (
            <Button disabled={busy || !message.trim() || paths.length === 0} onClick={() => void submit(false)}>
              Commit
            </Button>
          )}
          <Button
            variant="primary"
            disabled={busy || (!request && !committed && (!message.trim() || paths.length === 0)) || (request && (!title.trim() || !base.trim()))}
            onClick={() => void submit(!request)}
          >
            {busy ? "Working…" : committed ? "Push branch" : request ? `Open ${noun}` : "Commit and push"}
          </Button>
        </>
      }
    >
      <form
        className="delivery-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && (request ? title.trim() && base.trim() : message.trim() && paths.length)) void submit(false);
        }}
      >
        {!request && !committed && (
          <fieldset className="delivery-files">
            <legend>Files to commit</legend>
            {changes.map((c) => (
              <label key={c.path}>
                <input
                  type="checkbox"
                  checked={paths.includes(c.path)}
                  onChange={(e) => {
                    cancel();
                    setWriting(false);
                    setPaths((p) => (e.target.checked ? [...p, c.path] : p.filter((f) => f !== c.path)));
                  }}
                />
                <span className={`change-letter is-${c.status}`}>{changeLetter(c)}</span>
                <span className="mono">{c.path}</span>
                <span className="is-add">{c.added !== null ? `+${c.added}` : ""}</span>
                <span className="is-remove">{c.removed !== null ? `−${c.removed}` : ""}</span>
              </label>
            ))}
          </fieldset>
        )}
        {request && <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />}
        <TextArea
          readOnly={committed}
          label={request ? "Description" : "Commit message"}
          rows={6}
          value={message}
          placeholder={isWriting ? `${name} is writing the message…` : "Write the message"}
          onChange={(e) => {
            cancel();
            setWriting(false);
            setMessage(e.target.value);
          }}
        />
        {isWriting && (
          <p className="delivery-note" role="status">
            {name} is writing the message…
          </p>
        )}
        {warning && <p className="delivery-note">{warning}</p>}
        {!committed && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={write}>
            Write it again
          </Button>
        )}
        {request ? (
          <>
            <TextField label="Base branch" value={base} onChange={(e) => setBase(e.target.value)} />
            <label>
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft
            </label>
          </>
        ) : (
          <>
            <p>
              Branch: <span className="mono">{info.branch}</span>
            </p>
            {info.branch === info.default_branch && (
              <label>
                <input type="checkbox" disabled={committed} checked={newBranch} onChange={(e) => setNewBranch(e.target.checked)} /> Commit to a new branch
              </label>
            )}
            {newBranch && <TextField readOnly={committed} label="New branch name" value={branch} onChange={(e) => setBranch(e.target.value)} />}
          </>
        )}
        <DeliveryError error={error} />
        <button type="submit" className="visually-hidden" tabIndex={-1} aria-label="Submit delivery" />
      </form>
    </Dialog>
  );
}

export default function DeliveryActions({ taskId, changes }: { taskId: string; changes: readonly FileChange[] }) {
  const task = useWorkspace((s) => s.tasks.find((t) => t.id === taskId));
  const [info, setInfo] = useState<DeliveryInfo | null>(null);
  const [mode, setMode] = useState<"commit" | "request" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    deliveryInfo(taskId)
      .then((value) => {
        if (live) setInfo(value);
      })
      .catch((e: unknown) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [taskId, changes]);
  if (!task || !task.cwd || !info?.branch) return null;
  const reload = async () => {
    setInfo(await deliveryInfo(taskId));
    await useWorkspace.getState().refreshTasks();
  };
  const noun = info.host?.kind === "gitlab" ? "merge request" : "pull request";
  const push = async () => {
    setBusy(true);
    setError(null);
    try {
      await pushTask(taskId);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="delivery-actions">
      <div className="delivery-buttons">
        {changes.length > 0 && (
          <Button size="sm" onClick={() => setMode("commit")}>
            Commit…
          </Button>
        )}
        {!info.pushed && (
          <Button size="sm" disabled={busy} onClick={() => void push()}>
            {busy ? "Pushing…" : "Push branch"}
          </Button>
        )}
        {info.pushed && !info.request_url && info.host && info.host.kind !== "unknown" && (
          <Button size="sm" onClick={() => setMode("request")}>
            Open {noun}
          </Button>
        )}
      </div>
      {info.host?.connection && <p className="delivery-note">{info.host.connection}</p>}
      <DeliveryError error={error} />
      {mode && <DeliveryDialog key={`${mode}-${taskId}`} task={task} changes={changes} info={info} mode={mode} onClose={() => setMode(null)} onDone={reload} />}
    </div>
  );
}
