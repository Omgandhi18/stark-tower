import { useNavigation } from "../../stores/navigation";
import AttentionRail from "../attention/AttentionRail";
import Composer from "./Composer";
import WorkBoard from "./WorkBoard";
import "./work.css";

/** Work in the middle (for the project chosen in the sidebar), what needs you on the right. */
export default function WorkScreen() {
  const project = useNavigation((s) => s.workProject);
  return (
    <div className="work-screen">
      <section className="work-canvas" aria-label="Work">
        <Composer project={project} />
        <WorkBoard project={project} />
      </section>
      <AttentionRail />
    </div>
  );
}
