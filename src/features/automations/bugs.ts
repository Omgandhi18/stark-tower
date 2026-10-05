import type { Bug } from "../../lib/types";

export type BugStatus = "open" | "doing" | "fixed" | "wontfix";

interface BugStatusPresentation {
  label: string;
  /** Menu wording for moving a bug into this state. */
  action: string;
  tone: "attention" | "accent" | "success" | "neutral";
}

export const BUG_STATUS: Record<BugStatus, BugStatusPresentation> = {
  open: { label: "Open", action: "Reopen", tone: "attention" },
  doing: { label: "Being fixed", action: "Mark as being fixed", tone: "accent" },
  fixed: { label: "Fixed", action: "Mark as fixed", tone: "success" },
  wontfix: { label: "Won't fix", action: "Won't fix", tone: "neutral" },
};

const ORDER: readonly BugStatus[] = ["open", "doing", "fixed", "wontfix"];

/** How a stored status is shown (unknown values read as open). */
export const presentBugStatus = (status: string): BugStatusPresentation => (status in BUG_STATUS ? BUG_STATUS[status as BugStatus] : BUG_STATUS.open);

/** Where a bug can move from its current state. */
export const nextStatuses = (status: string): BugStatus[] => ORDER.filter((s) => s !== status);

export function bugCounts(bugs: readonly Bug[]) {
  return {
    open: bugs.filter((b) => b.status === "open").length,
    fixing: bugs.filter((b) => b.status === "doing").length,
  };
}
