import { useEffect, useRef, useState } from "react";
import { Button } from "../../design";
import { devserverLogs } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { useDevServers } from "../../stores/devservers";

export default function DevServerOutput({ folder }: { folder: string }) {
  const output = useDevServers((s) => s.output[s.folders[folder] ?? folder]);
  const generation = useDevServers((s) => s.servers[s.folders[folder] ?? folder]?.generation);
  const cleared = useDevServers((s) => s.cleared[s.folders[folder] ?? folder]);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (generation === undefined) return;
    let stopped = false;
    devserverLogs(folder)
      .then((lines) => {
        if (!stopped) useDevServers.getState().append(lines);
      })
      .catch((e) => {
        if (!stopped) setError(errorMessage(e, "The output couldn't be read. Close Output and try again."));
      });
    return () => {
      stopped = true;
    };
  }, [folder, generation]);
  useEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [output, cleared]);
  const hidden = output && cleared && cleared.generation === output.generation ? Math.max(0, cleared.cursor - (output.cursor - output.lines.length)) : 0;
  const text = output?.lines.slice(hidden).join("\n") ?? "";
  return (
    <section className="devserver-output" aria-label="Dev server output">
      <div className="devserver-output-head">
        <span>Output</span>
        <Button
          size="sm"
          disabled={!text}
          onClick={() => {
            navigator.clipboard.writeText(text).catch((e) => setError(errorMessage(e, "Couldn't copy the output. Select the text and copy it.")));
          }}
        >
          Copy
        </Button>
        <Button
          size="sm"
          disabled={!text}
          onClick={() => {
            useDevServers.getState().clear(folder);
          }}
        >
          Clear
        </Button>
      </div>
      {error && (
        <p className="field-error browser-error" role="alert">
          {error}
        </p>
      )}
      <pre
        ref={scroll}
        tabIndex={0}
        aria-label="Server logs"
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {text || "No output yet. Run the project to see its output here."}
      </pre>
    </section>
  );
}
