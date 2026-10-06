import { useState } from "react";
import { Button, Dialog, OverflowMenu } from "../../design";
import { discardTaskFile } from "../../lib/api";
import type { FileChange } from "../../lib/types";

export default function DiscardFile({ taskId, change }: { taskId: string; change: FileChange }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const consequence =
    change.status === "untracked" || change.status === "added"
      ? "This new file will be deleted."
      : change.status === "deleted"
        ? "This file will come back from its last commit."
        : change.status === "renamed"
          ? "This file will go back to its original name and content from its last commit."
          : "This file will go back to its last commit. Its staged and unstaged edits will be lost.";
  const discard = async () => {
    setBusy(true);
    setError(null);
    try {
      await discardTaskFile(taskId, change.path);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <OverflowMenu
        label="File actions"
        items={[
          {
            id: "discard",
            label: "Discard changes",
            danger: true,
            onSelect: () => {
              setError(null);
              setOpen(true);
            },
          },
        ]}
      />
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        dismissible={!busy}
        title={`Discard ${change.path}?`}
        description={consequence}
        tone="danger"
        actions={
          <>
            <Button disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy} variant="danger" onClick={() => void discard()}>
              {busy ? "Discarding…" : "Discard"}
            </Button>
          </>
        }
      >
        {error && (
          <p className="delivery-error" role="alert">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}
