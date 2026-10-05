import { Circle, CircleCheck, LoaderCircle, ListChecks } from "lucide-react";
import { EmptyState, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import type { PlanItem } from "../../lib/types";
import { stepLabel, stepState } from "./taskPresentation";

const STEP_ICON = { done: CircleCheck, doing: LoaderCircle, todo: Circle } as const;
const STEP_STATUS = { done: "Done", doing: "In progress", todo: "To do" } as const;

/** The owner's own plan for the task, as it keeps it. */
export default function PlanList({ plan, ownerName }: { plan: readonly PlanItem[]; ownerName: string }) {
  if (plan.length === 0) {
    return <EmptyState icon={ListChecks} title="No plan yet" body={`When ${ownerName} breaks the work into steps, they show up here as they're done.`} />;
  }
  return (
    <ol className="plan-list">
      {plan.map((item, i) => {
        const state = stepState(item);
        const Icon = STEP_ICON[state];
        return (
          <li key={`${i}-${item.content}`} className={cx("plan-step", `is-${state}`)}>
            <Icon aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} className={state === "doing" ? "spin-slow" : undefined} />
            <span className="plan-step-text">{stepLabel(item)}</span>
            <span className="visually-hidden">{STEP_STATUS[state]}</span>
          </li>
        );
      })}
    </ol>
  );
}
