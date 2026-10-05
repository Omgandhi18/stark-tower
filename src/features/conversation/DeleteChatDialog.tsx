import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button, Dialog } from "../../design";
import { deleteConversation } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { Conversation } from "../../lib/types";

const UNTITLED = "Untitled chat";

interface DeleteChatDialogProps {
  /** The chat to delete; null while closed. Key the dialog by the chat's id so each opens fresh. */
  chat: Conversation | null;
  onClose: () => void;
}

/** Asks before a chat is deleted for good, and says why if it can't be. */
export default function DeleteChatDialog({ chat, onClose }: DeleteChatDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!chat) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteConversation(chat.id);
      onClose();
    } catch (e) {
      setError(errorMessage(e, "The chat couldn't be deleted."));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog
      open={chat !== null}
      onClose={onClose}
      tone="danger"
      icon={Trash2}
      title={`Delete “${chat?.title.trim() || UNTITLED}”?`}
      description="Its messages are deleted for good. Tasks that ran in it stay in history."
      actions={
        <>
          <Button onClick={onClose}>Keep it</Button>
          <Button variant="danger" icon={Trash2} disabled={deleting} onClick={() => void confirm()}>
            Delete chat
          </Button>
        </>
      }
    >
      {error && (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
