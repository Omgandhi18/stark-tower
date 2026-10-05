// How each kind of pending review is named and shown, and how decisions are
// phrased back to the agent.
import {
  FileDiff,
  FileSearch,
  LayoutTemplate,
  ListChecks,
  MessageCircleQuestion,
  ShieldAlert,
  Split,
  type LucideIcon,
} from "lucide-react";
import type { StateTone } from "../../lib/status";
import type { ReviewKind, ReviewRequest } from "../../lib/types";

export interface ReviewPresentation {
  /** Short heading ("Approval needed"). */
  label: string;
  /** What the agent did, after its name ("wants to run a command"). */
  verb: string;
  tone: StateTone;
  icon: LucideIcon;
}

const PRESENTATION: Record<ReviewKind, ReviewPresentation> = {
  command: { label: "Approval needed", verb: "wants to run a command", tone: "attention", icon: ShieldAlert },
  permission: { label: "Approval needed", verb: "needs your permission", tone: "attention", icon: ShieldAlert },
  questions: { label: "Question", verb: "asked you a question", tone: "review", icon: MessageCircleQuestion },
  plan: { label: "Plan to review", verb: "proposed a plan", tone: "review", icon: ListChecks },
  diff: { label: "Changes to review", verb: "has changes for you to review", tone: "review", icon: FileDiff },
  findings: { label: "Findings", verb: "reported findings", tone: "review", icon: FileSearch },
  mockup: { label: "Mockup to review", verb: "made a mockup for you", tone: "review", icon: LayoutTemplate },
  choice: { label: "Decision needed", verb: "needs you to choose", tone: "attention", icon: Split },
};

export function presentReview(review: ReviewRequest): ReviewPresentation {
  return PRESENTATION[review.kind as ReviewKind] ?? PRESENTATION.choice;
}

/** How strongly the policy holds this kind of action back. */
export function tierNote(tier: string | null): string | null {
  if (tier === "never") return "Never runs without you";
  if (tier === "approval") return "Needs your approval";
  return null;
}

export const DEFAULT_CHOICES = ["Approve", "Request changes"] as const;

/** The options offered for a decision (agents may name their own). */
export function choicesFor(review: ReviewRequest): readonly string[] {
  return review.choices.length ? review.choices : DEFAULT_CHOICES;
}

/** The decision as the agent receives it: the choice, then any note. */
export function decisionText(choice: string, note: string): string {
  const trimmed = note.trim();
  return trimmed ? `${choice}: ${trimmed}` : choice;
}

const EXCERPT_LIMIT = 180;

/** A plain-text preview of a markdown body for cards and lists. */
export function excerpt(markdown: string, limit = EXCERPT_LIMIT): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_>~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
