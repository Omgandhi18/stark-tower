import { useState } from "react";
import { Layers } from "lucide-react";
import { Button, Dialog } from "../../design";
import ContextPanel from "./ContextPanel";
import "./context.css";

export default function ContextButton({ agentId, name, folder, taskId }: { agentId: string; name: string; folder: string; taskId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={Layers} title={`What ${name} is working from`} onClick={() => setOpen(true)}>
        Context
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`What ${name} is working from`}
        icon={Layers}
        size="lg"
        className="context-sheet"
        actions={<Button onClick={() => setOpen(false)}>Close</Button>}
      >
        <ContextPanel key={`${agentId}-${folder}-${taskId || "chat"}`} agentId={agentId} name={name} folder={folder} taskId={taskId} heading={false} />
      </Dialog>
    </>
  );
}
