import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Agent } from "../lib/types";
import { onPtyData, ptyResize, ptyWrite, spawnAgent } from "../lib/api";

interface Props {
  agent: Agent;
  active: boolean;
}

/**
 * A live terminal bound to one agent's pty. Terminals stay mounted once opened
 * (hidden when inactive) so scrollback survives switching between agents.
 */
export default function AgentTerminal({ agent, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current!;
    const term = new Terminal({
      fontFamily:
        'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: "#0a0f18",
        foreground: "#cfe6ff",
        cursor: "#4fd0ff",
        selectionBackground: "#24344a",
        black: "#0a0f18",
        blue: "#4fd0ff",
        cyan: "#7cf5c4",
        green: "#7cf5c4",
        yellow: "#ffd166",
        red: "#ff4d4d",
        magenta: "#c08cff",
        white: "#cfe6ff",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    try {
      fit.fit();
    } catch {
      /* not visible yet */
    }
    const { cols, rows } = term;
    spawnAgent(agent.id, cols || 80, rows || 24).catch(() => {});

    // pty output -> terminal
    const unlistenP = onPtyData((e) => {
      if (e.agentId === agent.id) {
        term.write(new Uint8Array(e.data));
      }
    });

    // terminal input -> pty
    const dataSub = term.onData((d) => {
      ptyWrite(agent.id, d).catch(() => {});
    });

    // resize handling
    const ro = new ResizeObserver(() => {
      if (!hostRef.current || hostRef.current.clientWidth === 0) return;
      try {
        fit.fit();
        ptyResize(agent.id, term.cols, term.rows).catch(() => {});
      } catch {
        /* ignore */
      }
    });
    ro.observe(host);

    return () => {
      unlistenP.then((f) => f());
      dataSub.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [agent.id]);

  // Refit + focus whenever this terminal becomes the active one.
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      try {
        fit.fit();
        ptyResize(agent.id, term.cols, term.rows).catch(() => {});
        term.focus();
      } catch {
        /* ignore */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [active, agent.id]);

  return (
    <div
      className="agent-terminal"
      style={{ display: active ? "block" : "none" }}
      ref={hostRef}
    />
  );
}
