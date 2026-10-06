import { useEffect, useState } from "react";
import { openContextFile, activeContext } from "../../lib/api";
import type { ActiveContext, ContextSource } from "../../lib/types";
import { Button, Markdown, SkeletonRows, Tag } from "../../design";
import { FolderOpen, RefreshCw, ExternalLink } from "lucide-react";
import { errorMessage } from "../../lib/errors";
import { contextSize, emptyLabel, groupSources, totalSize } from "./contextModel";
import "./context.css";

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: ActiveContext };

function SourceRow({ source, agentId, folder, taskId }: { source: ContextSource; agentId: string; folder: string; taskId?: string }) {
  const [error, setError] = useState<string | null>(null);
  const open = async (reveal: boolean) => {
    if (!source.path) return;
    setError(null);
    try {
      await openContextFile(agentId, folder, source.path, reveal, taskId);
    } catch (e) {
      setError(errorMessage(e, "The file couldn't be opened. Check that it still exists, then refresh."));
    }
  };
  return (
    <details className="context-source">
      <summary>
        <span className="context-source-heading">
          <strong>{source.name}</strong> <Tag>{source.scope}</Tag>
        </span>
        <span className={source.accepted ? "context-delivery" : "context-delivery context-ignored"}>{source.delivery}</span>
        <span className="context-size">
          {source.characters === 0 ? emptyLabel(source) : contextSize(source.characters, source.tokens)}
          {source.conditional && " · When used"}
        </span>
      </summary>
      <div className="context-source-body">
        {source.path && (
          <div className="context-file-actions">
            <span className="context-path">{source.path}</span>
            <Button size="sm" icon={ExternalLink} onClick={() => void open(false)}>
              Open
            </Button>
            <Button size="sm" icon={FolderOpen} onClick={() => void open(true)}>
              Show in Finder
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="context-error">
            {error}
          </p>
        )}
        {source.characters === 0 ? <p>{emptyLabel(source)}</p> : source.markdown ? <Markdown text={source.text} /> : <pre>{source.text}</pre>}
        {source.omitted_characters > 0 && <p className="context-note">and {source.omitted_characters.toLocaleString()} more characters</p>}
      </div>
    </details>
  );
}

/** Reads on mount and refresh; closing a drawer discards its snapshot. */
export default function ContextPanel({
  agentId,
  name,
  folder = "",
  taskId,
  heading = true,
}: {
  agentId: string;
  name: string;
  folder?: string;
  taskId?: string;
  heading?: boolean;
}) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    activeContext(agentId, folder, taskId)
      .then((data) => live && setState({ status: "ready", data }))
      .catch((e) => live && setState({ status: "error", message: errorMessage(e, "The context couldn't be read. Refresh to try again.") }));
    return () => {
      live = false;
    };
  }, [agentId, folder, taskId, revision]);
  return (
    <section className="context-panel" aria-label={`${name}'s active context`}>
      <div className="context-toolbar">
        <div>
          {heading && <h2>What {name} is working from</h2>}
          {state.status === "ready" && (
            <p className="context-note">
              {state.data.provider} · {state.data.model || "Provider's default model"}
              <br />
              {totalSize(state.data.sources)}
            </p>
          )}
        </div>
        <Button
          size="sm"
          icon={RefreshCw}
          disabled={state.status === "loading"}
          onClick={() => {
            setState({ status: "loading" });
            setRevision((r) => r + 1);
          }}
        >
          Refresh
        </Button>
      </div>
      <p className="context-precedence">Earlier sources win where they disagree. Provider file rules can differ; see the notes below.</p>
      {state.status === "loading" && <SkeletonRows rows={4} label="Loading active context" />}
      {state.status === "error" && (
        <p className="context-error" role="alert">
          {state.message}
        </p>
      )}
      {state.status === "ready" && (
        <>
          {groupSources(state.data.sources).map((group) => (
            <section key={group.id} className="context-group" aria-label={group.label}>
              <h3>{group.label}</h3>
              {group.id === 2 && state.data.project_hint && <p className="context-note">{state.data.project_hint}</p>}
              {group.sources.length === 0 && <p className="context-note">No sources in this group.</p>}
              {group.sources.map((source, i) => (
                <SourceRow key={`${source.path || source.name}-${i}`} source={source} agentId={agentId} folder={folder} taskId={taskId} />
              ))}
            </section>
          ))}
          <details className="context-notes">
            <summary>How this snapshot works</summary>
            {state.data.notes.map((note) => (
              <p className="context-note" key={note}>
                {note}
              </p>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
