import { useState } from "react";
import { Plus, X } from "lucide-react";
import type { ProjectInfo, ProjectsState } from "../lib/types";
import { addProject, removeProject, setProject } from "../lib/api";

interface Props {
  projects: ProjectInfo[];
  active: string;
  onChange: (s: ProjectsState) => void;
}

/**
 * Manage the set of project directories. The active one (highlighted) is the
 * default for direct chats; JARVIS can delegate into any of them.
 */
export default function ProjectsBar({ projects, active, onChange }: Props) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    const p = draft.trim();
    if (!p) return;
    setErr(null);
    try {
      onChange(await addProject(p));
      setDraft("");
    } catch (e) {
      setErr(typeof e === "string" ? e : "invalid path");
    }
  };

  const activate = async (path: string) => {
    try {
      onChange(await setProject(path));
    } catch {
      /* ignore */
    }
  };

  const remove = async (path: string) => {
    try {
      onChange(await removeProject(path));
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="projectbar">
      <span className="pb-label">PROJECTS</span>
      <div className="pb-chips">
        {projects.map((p) => (
          <span
            key={p.path}
            className={`pb-chip ${p.path === active ? "active" : ""}`}
            title={p.path}
          >
            <button className="pb-chip-name" onClick={() => activate(p.path)}>
              {p.name}
            </button>
            <button
              className="pb-chip-x"
              onClick={() => remove(p.path)}
              title="Remove"
            >
              <X size={12} strokeWidth={2.25} />
            </button>
          </span>
        ))}
      </div>
      <input
        className="pb-input"
        value={draft}
        spellCheck={false}
        placeholder="~/Documents/another-repo"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
        }}
      />
      <button className="pb-set" onClick={add}>
        <Plus size={12} strokeWidth={2.25} />
        add
      </button>
      {err && <span className="pb-err">{err}</span>}
    </div>
  );
}
