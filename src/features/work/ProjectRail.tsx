import { useState } from "react";
import { Folder, FolderPlus, Layers, Star, Trash2 } from "lucide-react";
import { Button, OverflowMenu, SectionHeader, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { addProject, pickFolder, removeProject, setProject } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { useWorkspace } from "../../stores/workspace";
import { parentFolder } from "./projects";

interface ProjectRailProps {
  /** The project Work is filtered to, or null for all work. */
  selected: string | null;
  onSelect: (path: string | null) => void;
}

/** Project folders: filter Work to one, add new ones, choose the default. */
export default function ProjectRail({ selected, onSelect }: ProjectRailProps) {
  const projects = useWorkspace((s) => s.projects);
  const defaultProject = useWorkspace((s) => s.activeProject);
  const applyProjects = useWorkspace((s) => s.applyProjects);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>, failure: string) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e, failure));
    }
  };

  const add = () =>
    run(async () => {
      const path = await pickFolder("Add a project folder");
      if (!path) return;
      applyProjects(await addProject(path));
      onSelect(path);
    }, "That folder couldn't be added.");

  return (
    <aside className="project-rail" aria-label="Projects">
      <SectionHeader title="Projects" />
      <ul className="project-list">
        <li>
          <button
            type="button"
            className={cx("project-item", selected === null && "is-selected")}
            aria-pressed={selected === null}
            onClick={() => onSelect(null)}
          >
            <span className="project-glyph" aria-hidden>
              <Layers size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
            </span>
            <span className="project-text">
              <span className="project-name">All work</span>
            </span>
          </button>
        </li>
        {projects.map((p) => (
          <li key={p.path} className="project-row">
            <button
              type="button"
              className={cx("project-item", selected === p.path && "is-selected")}
              aria-pressed={selected === p.path}
              title={p.path}
              onClick={() => onSelect(p.path)}
            >
              <span className="project-glyph" aria-hidden>
                <Folder size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
              </span>
              <span className="project-text">
                <span className="project-name">{p.name}</span>
                <span className="project-path">
                  {parentFolder(p.path)}
                  {p.path === defaultProject && <span className="project-default"> · Default</span>}
                </span>
              </span>
            </button>
            <OverflowMenu
              label={`More actions for ${p.name}`}
              items={[
                {
                  id: "default",
                  label: "Use as default",
                  icon: Star,
                  disabled: p.path === defaultProject,
                  onSelect: () =>
                    run(async () => applyProjects(await setProject(p.path)), "The default project couldn't be changed."),
                },
                {
                  id: "remove",
                  label: "Remove from list",
                  icon: Trash2,
                  danger: true,
                  onSelect: () =>
                    run(async () => {
                      applyProjects(await removeProject(p.path));
                      if (selected === p.path) onSelect(null);
                    }, "The project couldn't be removed."),
                },
              ]}
            />
          </li>
        ))}
      </ul>
      {error && (
        <p className="rail-error" role="alert">
          {error}
        </p>
      )}
      <Button variant="ghost" icon={FolderPlus} className="project-add" onClick={add}>
        Add project
      </Button>
    </aside>
  );
}
