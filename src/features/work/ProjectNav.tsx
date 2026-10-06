import { useState } from "react";
import { Folder, FolderPlus, Layers, Star, Trash2 } from "lucide-react";
import { OverflowMenu, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { addProject, pickFolder, removeProject, setProject } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { useNavigation } from "../../stores/navigation";
import { useWorkspace } from "../../stores/workspace";
import WorktreeSetupDialog from "../workspaces/WorktreeSetupDialog";
import ProjectChats from "./ProjectChats";

/** Work's places, nested under it in the sidebar: all work, each project (with its chats while it's open), adding one. */
export default function ProjectNav() {
  const projects = useWorkspace((s) => s.projects);
  const defaultProject = useWorkspace((s) => s.activeProject);
  const applyProjects = useWorkspace((s) => s.applyProjects);
  const selected = useNavigation((s) => s.workProject);
  const showProject = useNavigation((s) => s.showProject);
  const [setupProject, setSetupProject] = useState<string | null>(null);
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
      showProject(path);
    }, "That folder couldn't be added.");

  return (
    <ul className="nav-sub" aria-label="Projects">
      <li>
        <button
          type="button"
          className={cx("nav-sub-item", selected === null && "is-current")}
          aria-pressed={selected === null}
          onClick={() => showProject(null)}
        >
          <Layers aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
          <span className="nav-sub-label">All work</span>
        </button>
      </li>
      {projects.map((p) => {
        const isDefault = p.path === defaultProject;
        return (
          <li key={p.path} className="nav-sub-row">
            <button
              type="button"
              className={cx("nav-sub-item", selected === p.path && "is-current")}
              aria-pressed={selected === p.path}
              title={isDefault ? `${p.path} (default project)` : p.path}
              onClick={() => showProject(p.path)}
            >
              <Folder aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
              <span className="nav-sub-label">{p.name}</span>
              {isDefault && <Star aria-label="Default project" size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} className="nav-sub-default" />}
            </button>
            <OverflowMenu
              label={`More actions for ${p.name}`}
              align="start"
              items={[
                { id: "setup", label: "Worktree setup…", onSelect: () => setSetupProject(p.path) },
                {
                  id: "default",
                  label: "Use as default",
                  icon: Star,
                  disabled: isDefault,
                  onSelect: () => run(async () => applyProjects(await setProject(p.path)), "The default project couldn't be changed."),
                },
                {
                  id: "remove",
                  label: "Remove from list",
                  icon: Trash2,
                  danger: true,
                  onSelect: () =>
                    run(async () => {
                      applyProjects(await removeProject(p.path));
                      if (selected === p.path) showProject(null);
                    }, "The project couldn't be removed."),
                },
              ]}
            />
            {selected === p.path && <ProjectChats path={p.path} name={p.name} />}
          </li>
        );
      })}
      <li>
        <button type="button" className="nav-sub-item is-quiet" onClick={() => void add()}>
          <FolderPlus aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
          <span className="nav-sub-label">Add project</span>
        </button>
      </li>
      {setupProject && <li><WorktreeSetupDialog key={setupProject} project={setupProject} onClose={() => setSetupProject(null)} /></li>}
      {error && (
        <li>
          <p className="nav-sub-error" role="alert">
            {error}
          </p>
        </li>
      )}
    </ul>
  );
}
