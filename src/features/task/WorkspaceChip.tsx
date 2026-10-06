import { useState } from "react";
import { FolderOpen, GitBranch } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button, Dialog, Popover } from "../../design";
import { getTaskDetail, removeWorktree } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { TaskDetail, WorkspaceInfo } from "../../lib/types";
import "../workspaces/workspaces.css";

/** The task's workspace, why it was chosen, and the developer's cleanup action. */
export default function WorkspaceChip({ detail }: { detail: TaskDetail }) {
  const workspace = detail.workspace;
  const [confirm, setConfirm] = useState<WorkspaceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const dirty = confirm && (confirm.changes.length > 0 || confirm.unmerged.length > 0);
  const askRemove = async () => {
    setError(null);
    try {
      const fresh = await getTaskDetail(detail.task.id);
      if (fresh) setConfirm(fresh.workspace);
    } catch (e) {
      setError(errorMessage(e, "The worktree couldn't be checked. Try again."));
    }
  };
  const remove = async () => {
    setRemoving(true);
    setError(null);
    try {
      await removeWorktree(detail.task.id, Boolean(dirty));
      setConfirm(null);
    } catch (e) {
      setError(errorMessage(e, "The worktree couldn't be removed. Try again."));
    } finally {
      setRemoving(false);
    }
  };
  return (
    <>
      <Popover
        label="Task workspace"
        className="workspace-popover"
        trigger={(props) => (
          <Button {...props} size="sm" icon={GitBranch}>
            {workspace.kind === "worktree" ? "Worktree" : "Current checkout"} · {workspace.branch || "No branch"}
          </Button>
        )}
      >
        {(close) => (
          <div className="workspace-content">
            <p>{workspace.decision || "This task is using the project's own checkout."}</p>
            <dl>
              <dt>Folder</dt>
              <dd className="mono">{workspace.path}</dd>
              <dt>Branch</dt>
              <dd className="mono">{workspace.branch || "No branch"}</dd>
              {workspace.base && (
                <>
                  <dt>Base</dt>
                  <dd>
                    {workspace.base} at {workspace.base_commit.slice(0, 7)}
                  </dd>
                  <dt>Ahead</dt>
                  <dd>
                    {workspace.ahead} {workspace.ahead === 1 ? "commit" : "commits"}
                  </dd>
                </>
              )}
            </dl>
            {workspace.removed ? (
              <p>The worktree was removed. Its branch was kept.</p>
            ) : (
              <div className="workspace-actions">
                <Button
                  icon={FolderOpen}
                  onClick={() => {
                    void revealItemInDir(workspace.path).catch((e) => setError(errorMessage(e, "The folder couldn't be shown.")));
                  }}
                >
                  Show in Finder
                </Button>
                {workspace.removable && (
                  <Button
                    onClick={() => {
                      close();
                      void askRemove();
                    }}
                  >
                    Remove worktree
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </Popover>
      <Dialog
        open={confirm !== null}
        onClose={() => {
          if (!removing) setConfirm(null);
        }}
        title="Remove worktree?"
        description="The folder will be removed. Its branch will be kept."
        dismissible={!removing}
        actions={
          <>
            <Button disabled={removing} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button disabled={removing} variant={dirty ? "danger" : "primary"} onClick={() => void remove()}>
              {dirty ? "Remove anyway" : "Remove worktree"}
            </Button>
          </>
        }
      >
        {dirty && (
          <>
            <p>This worktree has work you may want to keep:</p>
            <ul>
              {confirm?.changes.map((c) => (
                <li key={c.path}>
                  {c.path} · {c.status}
                </li>
              ))}
              {confirm?.unmerged.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </Dialog>
      {error && !confirm && <p role="alert">{error}</p>}
    </>
  );
}
