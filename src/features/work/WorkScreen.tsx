import { useState } from "react";
import AttentionRail from "../attention/AttentionRail";
import Composer from "./Composer";
import ProjectRail from "./ProjectRail";
import WorkBoard from "./WorkBoard";
import "./work.css";

/** Projects on the left, work in the middle, what needs you on the right. */
export default function WorkScreen() {
  const [project, setProject] = useState<string | null>(null);
  return (
    <div className="work-screen">
      <ProjectRail selected={project} onSelect={setProject} />
      <section className="work-canvas" aria-label="Work">
        <Composer project={project} />
        <WorkBoard project={project} />
      </section>
      <AttentionRail />
    </div>
  );
}
