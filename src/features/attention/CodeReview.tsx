import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GitPullRequest } from "lucide-react";
import { Button, SectionHeader, SelectField } from "../../design";
import { askCodeReview, seeCodeReview } from "../../lib/api";
import type { CodeReviewItem } from "../../lib/types";
import { useAgents } from "../../stores/agents";
import { useCodeReviews } from "../../stores/codeReviews";
import { useNavigation } from "../../stores/navigation";
import { orderReviews, reviewCopy } from "./codeReviewModel";

function ReviewCard({ item }: { item: CodeReviewItem }) {
  const agents = useAgents((s) => s.agents);
  const [agentId, setAgentId] = useState(item.agent_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = reviewCopy(item);
  const name = agents.find((a) => a.id === agentId)?.name ?? agentId;
  const run = async (ask: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (ask) {
        const task = await askCodeReview(item.id, agentId);
        useNavigation.getState().openTask(task.id);
      } else {
        await openUrl(item.url);
        await seeCodeReview(item.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className={`attention-card tone-${copy.tone}`} aria-label={copy.title}>
      <h3 className="attention-title">{copy.title}</h3>
      {item.failed_checks.length > 0 && <p className="attention-excerpt">{item.failed_checks.join(", ")}</p>}
      <SelectField label="Ask agent" value={agentId} options={agents.map((a) => ({ value: a.id, label: a.name }))} onChange={setAgentId} />
      {error && (
        <p role="alert" className="attention-error">
          {error}
        </p>
      )}
      <div className="attention-actions">
        <Button size="sm" disabled={busy} onClick={() => void run(false)}>
          Open
        </Button>
        <Button size="sm" disabled={busy || !agentId} onClick={() => void run(true)}>
          Ask {name} to {copy.action}
        </Button>
      </div>
    </article>
  );
}
export default function CodeReview() {
  const items = useCodeReviews((s) => s.items);
  const connections = useCodeReviews((s) => s.connections);
  const hasHost = useCodeReviews((s) => s.has_host);
  if (!hasHost && !items.length && !connections.length) return null;
  return (
    <section aria-label="Code review" className="code-review">
      <SectionHeader title="Code review" count={items.length} icon={GitPullRequest} />
      {connections.map((note) => (
        <p key={note} className="delivery-note">
          {note}
        </p>
      ))}
      <div className="attention-list">
        {orderReviews(items).map((item) => (
          <ReviewCard key={`${item.id}-${item.reason}`} item={item} />
        ))}
      </div>
    </section>
  );
}
