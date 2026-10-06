import { useState } from "react";
import { Button, Dialog, TextArea, TextField } from "../../design";
import { saveWorktreeSetup } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { useConfig } from "../../stores/config";
import "./workspaces.css";

export default function WorktreeSetupDialog({ project, onClose }: { project: string; onClose: () => void }) {
  const config = useConfig((s) => s.config);
  const apply = useConfig((s) => s.apply);
  const saved = config?.worktree_setup?.[project];
  const [copy, setCopy] = useState((saved?.copy ?? [".env*", "node_modules"]).join("\n"));
  const [command, setCommand] = useState(saved?.command ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      apply(await saveWorktreeSetup(project, { copy: copy.split(/\n/).map((s) => s.trim()).filter(Boolean), command }));
      onClose();
    } catch (e) { setError(errorMessage(e, "The worktree setup couldn't be saved.")); }
    finally { setSaving(false); }
  };
  return <Dialog open onClose={onClose} title="Worktree setup" description="Choose what a new worktree carries over, then how to prepare it before an agent starts." actions={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={saving} onClick={() => void save()}>Save setup</Button></>}>
    <form id="worktree-setup" className="workspace-content" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <TextArea label="Files and folders to copy" value={copy} onChange={(e) => setCopy(e.target.value)} helper="One ignored path per line. A final * matches names such as .env.local. On this Mac, copies use APFS clones when available." />
      <TextField label="Setup command" value={command} onChange={(e) => setCommand(e.target.value)} helper="Optional. Runs in your login shell in the worktree. Its output stays with the task; if it fails, the agent is told and continues." />
      {error && <p role="alert">{error}</p>}
    </form>
  </Dialog>;
}
