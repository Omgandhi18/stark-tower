# Stark Tower

A multi-agent orchestration desktop app — think *munder-difflin*, reskinned as
Tony Stark's lab. **JARVIS** routes tasks to a roster of worker AIs
(**FRIDAY, EDITH, KAREN, VERONICA**), each a real Claude Code session running in
its own terminal, visualized as a pixel-art lab floor.

Built for a **Claude Max** subscription: agents are Claude Code processes (no API
keys, flat-rate), and the engine layer is pluggable for other CLIs later.

## Stack

- **Tauri v2** — Rust core + system webview (lightweight desktop shell)
- **Rust core** (`src-tauri/src/`)
  - `engine.rs` — pluggable engine abstraction (Claude Code default)
  - `pty.rs` — real terminal processes via `portable-pty`, streamed to the UI
  - `agents.rs` — the Stark roster, roles, and status model
  - `ledger.rs` — SQLite audit trail ("reactor ledger")
  - `lib.rs` — JARVIS orchestration + Tauri commands/events
- **Frontend** (`src/`) — React 19 + TypeScript + Vite
  - `components/StarkFloor.tsx` — Pixi.js pixel lab, status-animated sprites
  - `components/AgentTerminal.tsx` — xterm.js terminal bound to each agent's pty
  - `components/CommandCenter.tsx` — JARVIS task dispatch
  - `components/{Roster,LedgerFeed,ReactorMeter}.tsx`

## Concepts

| Concept | Iron Man theme |
|---|---|
| Orchestrator agent | **JARVIS** — routes tasks to free workers |
| Worker agents | FRIDAY, EDITH, KAREN, VERONICA (Claude Code sessions) |
| Circuit breaker | **Ultron containment** — trips on runaway output, blocks the agent |
| Cost/activity ledger | **Reactor load** (activity gauge — Max is flat-rate, so no $) |
| Office floor | Pixel-art Stark lab with an arc-reactor core |

## Run

```bash
npm install
npm run tauri dev
```

Click an agent (on the floor or in the roster) to open its terminal and bring it
online. Or type a task into the JARVIS command line — it routes to a free worker,
spawning one if needed.

## Status: v0.1 (prototype)

Working: engine abstraction, pty streaming, JARVIS routing, live status →
pixel-sprite animation, SQLite ledger, runaway containment.

Placeholder art (blocky pixel figures). Candidate AI-generated sprites and a full
aesthetic spec live in `assets/pixel/` — see `assets/pixel/SPEC.md` for the plan
to swap in production CC0/hand-authored assets.

## Roadmap

- Real sprite sheets (idle/walk/working/thinking/blocked) + walking pathfinding
- Per-agent working directory + project picker
- Memory layer (semantic markdown recall) + inter-agent mailboxes
- Human-in-the-loop gate detection (permission prompts → "blocked" escalation)
- Additional engines (Codex, Grok) via the `engine.rs` seam
