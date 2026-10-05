// Conversation panel that slides in over the right of the Environment, so an
// agent can be talked to where they stand instead of on another screen.
// Kept mounted while closed so every open thread keeps its state.
import type { ReactNode } from "react";
import { X } from "lucide-react";

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export default function ChatDrawer({ open, title, onClose, children }: Props) {
  return (
    <aside className={`rnd-chat-drawer${open ? " open" : ""}`} aria-label={title} inert={!open}>
      <div className="rnd-chat-drawer-bar">
        <span className="rnd-chat-drawer-title">{title}</span>
        <button type="button" className="rnd-chat-drawer-close" aria-label="Close conversation" onClick={onClose}>
          <X size={16} strokeWidth={2} />
        </button>
      </div>
      <div className="chat-rail rnd-chat-drawer-body">{children}</div>
    </aside>
  );
}
