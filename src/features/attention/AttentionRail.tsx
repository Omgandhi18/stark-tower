import { CircleCheck, TriangleAlert } from "lucide-react";
import { EmptyState, SectionHeader } from "../../design";
import { useNow } from "../../lib/useNow";
import { useAttention } from "../../stores/attention";
import UpcomingReminders from "../reminders/UpcomingReminders";
import AttentionCard from "./AttentionCard";
import "./attention.css";

const CLOCK_MS = 30_000;

/** The right-hand rail on Work: everything agents are waiting on you for, then your reminders. */
export default function AttentionRail() {
  const pending = useAttention((s) => s.pending);
  const now = useNow(CLOCK_MS);

  return (
    <aside className="attention-rail" aria-label="Needs your attention">
      <div className="attention-scroll">
        <SectionHeader title="Attention" icon={TriangleAlert} count={pending.length} />
        {pending.length === 0 ? (
          <EmptyState
            compact
            icon={CircleCheck}
            title="Nothing needs you"
            body="Approvals, questions and reviews from your agents appear here."
          />
        ) : (
          <div className="attention-list">
            {pending.map((review) => (
              <AttentionCard key={review.id} review={review} now={now} />
            ))}
          </div>
        )}
      </div>
      <UpcomingReminders now={now} />
    </aside>
  );
}
