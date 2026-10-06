import type { CodeReviewItem } from "../../lib/types";

export const requestNumber = (item: CodeReviewItem) => `${item.host_kind === "gitlab" ? "!" : "#"}${item.number}`;
export function reviewCopy(item: CodeReviewItem) {
  const number = requestNumber(item);
  switch (item.reason) {
    case "failed":
      return { title: `Checks failed on ${number} ${item.title}`, action: "fix it", tone: "danger" };
    case "changes":
      return { title: `Changes requested on ${number} ${item.title}`, action: "address it", tone: "attention" };
    case "comments":
      return { title: `New comments on ${number} ${item.title}`, action: "address it", tone: "attention" };
    default:
      return { title: `Review requested: ${number} ${item.title}`, action: "review it", tone: "neutral" };
  }
}
const priority = (item: CodeReviewItem) => (item.reason === "failed" ? 0 : ["changes", "comments"].includes(item.reason) ? 1 : 2);
export const orderReviews = (items: readonly CodeReviewItem[]) => [...items].sort((a, b) => priority(a) - priority(b) || b.updated.localeCompare(a.updated));
