# Starkline mods, v2: event middleware across every provider

Status: revised proposal for to-do #15. Design only; no product code written. Author: VISION, 2026-10-10. Supersedes `2026-10-10-mods-design.md` (v1, kept for comparison).

## 0. What changed from v1, and why

v1 read a Claude Code mod as "a way to draw extra UI" and built an additive, UI-only, Claude-agnostic-by-accident system that ran arbitrary JS with the host's React inside the main webview. That misread the thing. A Claude Code mod is **event middleware**: hooks of the form `($, e, next)` that can pass an event through, rewrite it, observe its result, or answer it in place. UI is one family of events among many.

v2 keeps the same idea and moves it to where Starkline actually sits, between the developer and every engine:

| | v1 | v2 |
|---|---|---|
| What a mod is | UI slots plus read-only events | Middleware over Starkline's own event set: prompts, tool calls, permissions, turns, commands, UI |
| Can intercept | Nothing, by design | Prompts and tool calls, **tighten-only** relative to the gate |
| Providers | Not considered | One mod behaves the same for Claude Code, Codex and OpenCode; each event states what it can do per engine (§3) |
| API | Own `starkline.*` object | Claude Code's mod API shape (`register(on)`, `($, e, next)`, element trees, `$.state`), a declared subset plus Starkline additions (§4) |
| Runs in | Main webview, shared realm | A Rust-supervised Node "mod host", one worker per mod, Node permission model on (§6) |
| Window hidden | Mods stop | Engine-side hooks keep working (§6) |
| Trust | "Trusted code, like installing an app" | Mod effects are mediated by the gate; hash approval; monotonic (§7) |

What survives from v1 unchanged: the Mods page in Settings, polling for hot reload, hash approval, safe mode, naming ("Mods"), the Environment room being off limits, and the slice-by-slice shipping habit. v1's iframe, Blob-URL import and host-React ideas are dropped.

## 1. What Claude Code mods are, and what I verified

Taken from the brief (JARVIS's research), the bundled `plugin-authoring` skill and its type file for Claude Code 2.1.289 (installed here), and my own run. Anything I did not see myself is marked.

**Shape (from the skill and types, read directly):**
- A mod is a plugin: `.claude-plugin/plugin.json`, `hooks/hooks.json` `{ "modules": ["./register.ts"] }`, and a module exporting `register(on, options)`.
- Every hook is `on(event, matcher?, ($, e, next) => …)`. Pass (`next(e)`), rewrite (`next({...e, x})`), observe (`await next(e)`), or answer in place (return without `next`, e.g. `{ deny }`). Mods stack; the first loaded sees an event first and its result last.
- Events include `session.start/end`, `prompt.submit`, `prompt.compose`, `tool.call`, `turn.start/complete/step`, `command.run`, `session.append`, `session.attach`, `ui.render` and others; the settings hooks are hookable as `classic.<Event>`.
- `$` is the only channel out of the module: `$.state`, `$.store`, `$.ui` (`resolve`, `open`, `status`, `toast`, `invalidate`), `$.command`, `$.tool.register`, `$.agent`, `$.model`, `$.clock`, `$.fs`, `$.process`, `$.plugin.root`.
- The module has no DOM and no Node. `claude plugin validate` reads the source statically: **it refused my first draft because I passed `$` to a helper that was not a top-level function declaration.** So mods are analysable, which matters for review (§7).
- Element trees (`Box`, `Text`, `Button`, `Input`, `Select`, `Markdown`, `Image`, `Raster`, `Client`, `Svg`) are resolved per surface with `$.ui.resolve(e)`; `e.surface` is `terminal | desktop | vscode | mobile`, and the element table narrows with it (`mobile` has no `Input`/`Select`/`Client`; only `terminal` has `Raster`).

**Verified headless, with evidence** (scratch dir `/tmp/vision-modtest`, throwaway `CLAUDE_CONFIG_DIR=/tmp/vision-modtest/cfg`, mod loaded with `--plugin-dir`, `~/.claude` untouched, run exactly like Starkline spawns Claude: `-p --input-format stream-json --output-format stream-json --verbose`):

1. **Hooks modules load in headless stream-json.** The `system/init` message lists the mod: `plugins: [{"name":"probe","source":"probe@inline",…}, + three builtins]`, and the debug log says `hooks worker spawned`, `hooks module probe@inline loaded (worker, environment 1, tier user); events: session.start,prompt.submit,tool.call,turn.complete,ui.render`.
2. **Event hooks fire headless.** The probe's own log file, written by the mod through `$.fs`, shows `session.start`, `prompt.submit text="Run the shell command: …"` and `turn.complete` for the one headless turn.
3. **`ui.render` was never raised.** The log has no `ui.render` line, and the engine logs `session.start: raised (surface none, not interactive)`. With no attached surface there is nothing to draw, so UI hooks are inert in Starkline's subprocesses today. The init message advertises a `ui_surface_v1` capability and the types document `session.attach` ("a surface joined… the desktop app connected… said so (`ui_attach`)"): a stream-json host can apparently attach as a surface and receive trees. **Not verified; the wire protocol is not in anything I could read.** It is a possible later slice (§9), not a dependency.
4. **`tool.call` deny and pass-through**: verified in the engine's own test harness (`claude plugin test`): `{deny: "probe mod: forbidden-marker is blocked"}` for the marked command, pass-through (`next`) for another. **Not verified live in a headless session**: the throwaway config dir has no login (the turn returned "Not logged in" with `apiKeySource: none`), and I would not borrow credentials from `~/.claude`. Treat "tool.call guards apply headless" as expected because hooks load and `prompt.submit` fires on the same path, not as proven.
5. **Ordering relative to Starkline's gate** (from the reference, `claude plugin test` docs): a plugin's `tool.call` chain sits *above* the settings-hook `PreToolUse` it calls `classic.PreToolUse`. Starkline's gate is exactly that settings hook (`--settings` JSON with `PreToolUse` → `gate-hook.mjs`, `chat.rs:785`). So an in-subprocess Claude mod acts first, and Starkline's gate judges the call as the mod left it. Documented, not exercised live.
6. **Availability is rolled out, not guaranteed**: the debug log shows `installed plugins' hooks modules held … for the rollout flag (tengu_plugin_hooks_modules): the fetch settled with no payload`. It loaded for me; other accounts may differ.

Starkline passes no `--bare`, `--setting-sources` or `--strict-mcp-config` (`chat.rs:700-800`), so the developer's own installed Claude plugins load in every Claude subprocess Starkline spawns. I did not list the developer's installed plugins (that reads `~/.claude`); the init message's `plugins` array is how Starkline itself can see them at run time.

## 2. What a Starkline mod is

Proposed glossary entries for `CONTEXT.md` (it does not exist yet; I may only write this file today):

- **Mod**: a folder of hook modules, in Claude Code's mod format, that sits between the developer and the engines and can observe, rewrite or answer Starkline's events.
- **Event**: something that happens in Starkline, named the same whichever engine the agent uses (`prompt.submit`, `tool.call`, …).
- **Guard**: a mod hook that tightens what the gate decided (deny, or require approval). A mod never loosens.
- **Mod host**: the process that runs mods. Not the webview.
- **Engine** / **provider**: Claude Code, Codex, OpenCode. Used as in the existing code (`engine.kind`).

A mod is **provider-agnostic by construction**: it is written against Starkline's events, which are built from the normalised events every adapter already produces (`chat.rs`: `session_ready`, `said`, `thought`, `tool_called`, `tool_returned`, `turn_finished`; `codex.rs` and `opencode.rs` call the same functions), and from the two funnels Starkline owns: `chat::send` for prompts and `bridge::decide` / `bridge::assess` for permissions. Tool names are already normalised (`Bash`, `Edit`, `Write`, `delegate`; see `opencode.rs` `as_tool`), so `on("tool.call", { tool: "Bash" }, …)` means the same on all three.

## 3. Events, and what each engine allows

"Intercept" = before or instead of the engine acting (rewrite, deny, answer). "Observe" = Starkline learns it after the fact.

Where interception happens:
- **Prompts**: `chat::send` (`chat.rs:1335`) and its callers (`chat_send`, `tasks`, delegation, schedules). Starkline owns it for every engine, so prompt interception is engine-independent.
- **Tool calls and permissions**: every engine reaches `bridge::assess` / `bridge::decide`. Claude Code gets there through the PreToolUse hook (`classify`, then the `approve` MCP tool); Codex through `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` and MCP elicitation (`codex.rs:343-370`); OpenCode through `session/request_permission` (`opencode.rs:340`). One insertion point inside `assess` covers all three.

| Event | Claude Code | Codex | OpenCode |
|---|---|---|---|
| `prompt.submit` (developer, delegated task, automation; `e.origin` says which) | **Intercept**: rewrite, answer in place (consumed, never sent) | same | same |
| `prompt.compose` (system prompt sections) | Intercept at **session creation only**; a resumed session keeps its earlier prompt (`chat.rs:731`: `--append-system-prompt` only without `--resume`) | session creation only (channel to confirm in `codex.rs`) | session creation only (channel to confirm) |
| `tool.call` guard | **Every tool**, via the `*` PreToolUse hook: deny, require approval, pass | **Only calls Codex asks about** (approval policy "untrusted" in a workspace-write sandbox): approve or decline. Calls it runs inside its sandbox unasked are **observe-only** | **Only calls OpenCode asks about** (`edit`, `bash`, `webfetch`, `websearch`, `external_directory` are `ask`; reads are automatic): approve or reject. Reads are **observe-only** |
| `tool.call` **rewrite** of the input | Possible in principle (Claude Code's PreToolUse can return an updated input); Starkline's hook does not use it today and I did not exercise it | **No**: the answer is accept or decline | **No**: the answer is once or reject |
| `permission.request` (answering an ask) | Mods may only **deny**; they cannot approve (§7) | same | same |
| Starkline's own MCP tools (`ask_human`, `delegate`, `message`, tools a mod registers) | **Full intercept**: the call arrives at Starkline's bridge | same | same |
| `tool.result` | **Observe**, and rewrite what *Starkline shows and stores* (redaction in transcript and ledger). The model has already seen the real output | same | same |
| `turn.start` / `turn.complete`, `session.start` / `session.end`, `message.said`, `message.thought` | Observe | Observe | Observe |
| `command.run` (Starkline slash commands, `src-tauri/src/slash`) | **Intercept** (handled in Starkline before send) | same | same |
| `task.status`, `task.review`, `agent.status`, `reminder.due` (Starkline-only events, from v1) | Observe | Observe | Observe |
| `ui.render`, `ui.press`, `ui.message`, `ui.close` | Starkline draws; engine-independent | same | same |

Consequences stated plainly:
- A mod cannot rely on seeing or stopping *every* tool call on Codex or OpenCode; those engines decide what to ask about. A guard that must be absolute needs the engine's own sandbox as well. The mod's manifest declares `guards: ["Bash","Edit"]`, and the Mods page shows per engine whether that guard is **full**, **ask-only** or **observe-only** for the agents currently using it.
- Rewrite is Claude-only. On the other two a mod that asks for a rewrite gets `canRewrite === false` in `e.engine` and should deny with a reason that tells the agent what to do instead ("use `rg`, not `grep -r`"). Denial reasons reach every engine. v2 refuses a rewrite on a non-rewritable engine with a visible notice, never silently drops it.
- A Claude-subprocess-only extra exists for free: Claude mods installed in Claude Code can rewrite model-visible tool results (§5). That is not a Starkline event.

## 4. API: adopt Claude Code's mod API shape, as a declared subset

**Recommendation: adopt it.** Same manifest (`.claude-plugin/plugin.json` plus `hooks/hooks.json`, with a `starkline` block for Starkline-only fields), same `register(on, options)`, same `($, e, next)`, same event names where meaning matches, same element trees, same `$.state`/`$.store`. Reasons:
- The community's mods, the developer's own, and the agents' trained familiarity with the `plugin-authoring` skill carry over. Agents asked to "write a mod" already know the format; there is nothing for a Starkline-only skill to teach except the differences.
- The design problems (middleware order, atoms that survive reload, element trees that degrade by size) are already solved there, and the shape is proven.
- A Starkline mod can be validated, typed and tested with the tools that exist (`claude plugin validate`, `claude plugin test`, `tsc`) wherever the `claude` CLI is installed, at no cost to us.

Costs, owned plainly:
- **It is Anthropic's moving target.** The API is build-specific (the types file is regenerated per build) and still behind a rollout flag. Starkline therefore pins its own declared subset with its own version (`starkline-api: 1`), writes its own `claude-code` type shim into each mod's `.starkline/types/`, and does not promise to track Claude Code changes. A mod that stays inside the subset runs on both.
- Starkline needs a surface name. A mod sees `e.surface === "starkline"` with a Starkline element table (below). A Claude mod that narrows on `terminal | desktop | vscode | mobile` and falls through to a default will draw; one that assumes it will be one of those four may not.

**Maps as is:** `on/next` semantics; `session.start/end`, `prompt.submit`, `tool.call` (guard), `turn.start/complete`, `command.run`, `ui.render` for `AbovePrompt` and `Pane`; `$.state`, `$.store`, `$.clock`, `$.command.register`, `$.ui.status/toast/open/invalidate`, `$.tool.register` (served through the existing MCP bridge, so all three engines get it: `mcp__stark__<name>` for Claude, `stark_<name>` for OpenCode; Codex via its MCP config), `$.plugin.root`, `$.fs` / `$.process` / `$.http` (mediated by the gate, §7).

**Does not map, and what v2 does:**

| Claude Code | In Starkline v2 |
|---|---|
| `Raster`, `Image` via the kitty protocol, terminal `Box` border styles, cell-based `columns` / `rows` / `viewport.isFullscreen` | Not in the element table. A tree using them fails validation with a named reason. `Box`, `Text`, `Button`, `Input`, `Select`, `Markdown`, `Image` (file or URL) and `Svg` are in |
| `Client` (interactive widget module drawn by the surface) | Out of v2 |
| `$.model.complete` / `fork` | Out of v2. Starkline has no engine-neutral model call; one would be a priced call through some engine's session. Later, via the spend ledger |
| `$.agent.spawn` / `register` (Claude subagent types) | Out of v2. The Starkline equivalent is delegation (`delegate`), a different model |
| `session.append`, streaming `turn.step`, `process.spawn` | Not mapped |
| `classic.<Event>` (Claude settings hooks), `telemetry.*`, `engine.*` | Not mapped; `classic.*` is Claude-only by definition |
| `tool.call` model-visible result rewrite, per-turn `prompt.compose` | Claude-only / not available (§3) |
| `plugin dependencies`, `userConfig`, marketplaces (`/plugin`) | `userConfig`-style `options` yes (typed controls on the Mods page); marketplaces later |
| `e.surface` in `terminal`/`desktop`/`vscode`/`mobile` | `starkline` |

**Starkline additions:** `e.provider` (`claude-code | codex | opencode`) and `e.engine.{canRewrite, interceptsAll}` on agent events; `e.agent`, `e.task`, `e.conversation`, `e.project`; events `task.*`, `agent.status`, `reminder.due`; `e.tier` (the gate's verdict, read-only) on `tool.call`; theme tokens in `plugin.json` (`starkline.theme`, from v1) so CSS-only mods need no JS.

## 5. Coexistence with mods that already run inside `claude`

Two layers exist, and they do different jobs:

```
developer ─▶ Starkline ──[Starkline mods: prompt.submit, tool.call guard]──▶ engine subprocess
                                                       ▲                       (Claude: installed Claude mods run in here,
                                                       │                        then Starkline's PreToolUse gate hook beneath)
                                                       └── gate: bridge::assess/decide
```

Rules:
1. **Starkline does not load Claude's installed plugins, and does not suppress them.** The two folders stay separate (`$APPDATA/mods` and `<project>/.starkline/mods` for Starkline). Starkline never reads `~/.claude`.
2. **Order is deterministic for Claude agents.** A Claude mod's `tool.call` acts first, Starkline's gate hook next, Starkline mods inside `assess` last. Starkline's view of the call is the final one the engine will run. Each layer can only make the call stricter or leave it, so "double-guarding" means two denials, never a conflict; the denial text names the plugin (`probe: …` from Claude's mod; `mod:<id>: …` from Starkline's) so the transcript says who said no.
3. **Prompts**: a Claude mod's `prompt.submit` rewrite happens inside `claude` after Starkline has recorded the developer's text. Starkline's transcript shows the original; the model saw the rewrite. Starkline cannot see this. The Mods page lists, read-only, the plugins Claude reports in its init message (`plugins[]`) for each running Claude agent, with the note "runs inside Claude; Starkline can't see or change what it does".
4. **No duplicate runs of the same mod.** A mod folder shared by both (same `name`) would fire twice for Claude agents. Starkline checks the init `plugins[]` and, when a Starkline mod's `name` is already running inside that Claude session, skips it for that agent's events and says so on the Mods page ("already running in Claude").
5. **UI trees of in-Claude mods are inert** (no surface attached, §1 item 3). Nothing for them to collide with. If Starkline later attaches as a surface, in-Claude mod UI would arrive there; decide then.
6. **Optional switch**: "Run Claude agents without the developer's installed plugins" (`--setting-sources` narrowing). Off by default, because silently changing an agent's behaviour is worse than showing it. Needs the developer's call only if they want it.

## 6. Where the mod runtime runs

Requirements, from the brief: engine-side hooks must work while the window is hidden, for every engine; the gate path is latency-sensitive; hot reload; a broken mod must not hurt the app.

| | Rust-managed Node mod host | Web Worker in the webview | Embedded JS engine in Rust (new crate) |
|---|---|---|---|
| Works with window hidden / closed | **Yes**, independent of the webview | **No**: a hidden WKWebView throttles timers and a closed window is gone. Disqualifying for `tool.call` | **Yes** |
| Every engine | Yes | Only while the app is up | Yes |
| Gate-path latency | Long-lived process; a worker round trip measured here is about **35 µs** (Node 26.9), plus socket/stdio hop. The current gate hook starts a fresh `node` per tool call, which costs **0.2–0.28 s** here, so a persistent host is *faster* than today's gate | Webview round trip through Tauri IPC; worse and not available when hidden | In process, fastest |
| Isolation | Node `--permission` verified here: with no `--allow-*` flags a script's `fs` read, `fs` write and `child_process` all fail with `ERR_ACCESS_DENIED`. Network is its own flag (`--allow-net`, off). A mod only reaches the world through `$` ops, as in Claude | Browser worker has no fs but has `fetch` and a shared origin; weaker | Strongest by default: no ambient authority at all (QuickJS / similar), ops only |
| Crash containment | One `worker_thread` per mod with `resourceLimits`; a hang is killed by `worker.terminate()` after a timeout. Host crash: Rust restarts it and replays registrations | Worker crash isolated; a runaway main-thread task is not | Panic or hang takes the Rust process unless run on a guarded thread; `event_guard.rs` exists for AppKit, not this |
| Hot reload | New worker per save; `$.state` kept in the host (survives), `$.store` persisted by Rust. Same as Claude's own model | Same, but dies with the window | Possible; need own module loader |
| TypeScript | Node strips types natively (`node t.ts` ran here), so `register.ts` works with no build step | Needs a compile step | Needs a compile step (swc/esbuild) |
| New dependency | None: Node is already required for the bridge | None | **A new crate**, approval needed |
| Element trees to UI | JSON over the Rust↔webview channel | Direct | JSON over the same channel |

**Recommendation: the Node mod host.** One long-lived `node --permission` process under a new `mods.rs`, which speaks newline-delimited JSON to Rust, plus one `worker_thread` per mod. Rust is the only client; the host does not inherit `STARK_DELEGATE_SOCK` or its token, so a mod cannot call the bridge directly. It needs a Node version floor (type stripping and `--permission` are recent; the app already resolves and version-probes `node` in `lib.rs:1334`; the minimum is a decision, §10).

Event flow on a guarded tool call: `bridge::assess` computes the gate's verdict first, sends `{event: "tool.call", tool, input, tier, provider, agent, …}` to the host, waits up to a budget (proposed 1 s), and combines: the final result is the stricter of the gate's and every mod's. Mods never see an event the gate has already refused (no point), and never receive secrets (`secrets.rs` values are not event fields).

What the host renders: `ui.render` returns an element tree (JSON). The webview maps it onto `src/design` components (a small `ElementTree` renderer: `Box` → flex container with token-based gap/padding, `Text`/`Markdown` → existing text and markdown components, `Button`/`Input`/`Select` → design-system controls with `key`s that raise `ui.press` / `ui.message` back to the host). Mods draw no HTML, take no host React, and use the theme tokens for free. Slots: `AbovePrompt` (composer band), `Pane` (a tab in the tool rail), status line, toast, and a task-header band (Starkline extra). Rendering only happens while the window is visible; the host caches the last tree.

Failure modes and defaults:
- Host dead or a mod late: **observers and UI mods fail open** (skipped, error logged on the Mods page); **guards fail to "ask"**, not deny and not allow, matching `gate-hook.mjs` ("fail closed: the prompt goes to Starkline's approve tool"). A broken guard cannot silently stop guarding and cannot freeze every tool call.
- Three timeouts in a row disable that mod and say why. Safe mode (`--no-mods`, or holding Option at launch) starts with the host off.
- Watching: poll mtimes every 500 ms in Rust (as v1), no new dependency. Evidence for hot reload exists in Claude's own design (reload on save, `register` and `session.start` re-run, module variables reset, `$.state` kept).

## 7. Security

A mod that can rewrite prompts, deny tool calls and answer permissions is as powerful as the gate. The model is therefore built around one rule and four supports.

**The rule: monotonic.** Final verdict = the strictest of the gate and all mods. A mod may raise `Automatic → Approval`, `Approval/Never → refused`, and add a denial reason. It may **never** lower a tier, answer an Approval or Never request with "yes", create a standing permission rule (those remain developer-only, `policy.rs` header), or remove a `Never` outcome. `gate.rs` stays the floor and is not exposed to mods for editing. Tiers use the existing three (`Automatic`, `Approval`, `Never`); a mod-forced ask behaves as `Approval` (and is covered by the developer's standing rules and auto mode as `Approval` is today), a mod denial is final and is not overridable by auto mode.

**Support 1: mod effects go through the gate.** `$.fs`, `$.process.run`, `$.http` do not execute in the host (which has no such permissions anyway). They are ops served by Rust under a pseudo-actor `mod:<id>`, and each is run through `gate::assess` as the equivalent `Bash` / `Edit` / `WebFetch` call. Anything at Approval or Never asks the developer ("Mod *focus-band* wants to run `git status`"). Claude's mods run unsandboxed with Claude's own access ("They aren't sandboxed"); Starkline can do better because the effect path is ours.

**Support 2: approval by content hash, and capabilities.** `plugin.json` declares `starkline.capabilities` from: `observe`, `ui`, `guard`, `prompt` (rewrite or answer prompts), `tools` (register tools), `fs`, `process`, `http`. A mod runs only after the developer approves **its hash and capabilities** on a sheet that shows the file list, the validated hook list (the static analysis `claude plugin validate` does, which we can reproduce or call) and the capabilities. A changed hash returns it to "Needs review". An op outside the approved capabilities throws at the host.

**Support 3: agent-written mods are staged, never loaded in place.** `bridge::assess` already marks Starkline's app-data directory as protected (`bridge.rs:617`), so an agent cannot write into `$APPDATA/mods` at all. That settles v1's worry and removes v1's "gate-classify the mods folder" control; it needs only a test that mods live under app data. Agents write to `<project>/.starkline/mods/<id>/` (an ordinary project file). That folder is a **staging area, never executed**. The Mods page shows "Ready to install" with the diff against the installed version. **Install copies the approved bytes into `$APPDATA/mods`**, so later agent edits to the project copy cannot change running code. For the authoring loop, a per-mod "Trust edits while developing" toggle, **allowed only for mods whose approved capabilities are within `observe` and `ui`**, auto-reloads the staged folder on every save with a persistent badge; any mod with `guard`, `prompt`, `tools`, `fs`, `process` or `http` always needs re-approval on each hash change. Project mods from a cloned repo are untrusted input and never get the toggle by default.

**Support 4: visibility and kill switches.** A rewritten prompt is shown in the transcript with a badge ("rewritten by *mod-id*", original one click away) and a ledger entry; a mod denial is a visible row with the mod's name; mods cannot read or alter Starkline's own safety sections of the system prompt (`prompt.compose` sees only mod-owned sections plus read-only labels for Starkline's). Safe mode, auto-disable on repeated timeouts, per-mod enable switch, and "Disable all mods" on the crash banner (v1).

**What stays true, said once:** a mod with `process` or `fs` and a developer's approval of an Approval-tier ask is still doing what the developer approved; a mod the developer approves with `prompt` can steer an agent. The design makes this visible and gated, not impossible. Mods are not a sandbox for malicious *developers*; they are a bounded way to extend a machine the developer already owns.

## 8. Authoring by agents

- The format is Claude's, so the agent's existing `plugin-authoring` knowledge mostly applies. Starkline adds `docs/mods/AUTHORING.md` (differences only: surface, events, per-engine interception table, capabilities, staging) and a `.starkline/types/` shim written into each mod folder.
- Delivery: a pointer in `prompts.rs` instructions ("To change Starkline, write a mod in `.starkline/mods/`; read `<abs path>/AUTHORING.md`; do not edit Starkline's source"), which reaches all three engines. For Claude agents, the built-in skill already exists and Starkline's extra guide corrects it.
- A read-only `mods_status` bridge tool lets an agent read its own mod's last error, closing the write → fail → fix loop without the developer relaying it.

## 9. Slice plan (each shippable alone)

1. **Mod host, observers, the Mods page, theme tokens.** `mods.rs` (discover, validate manifest, polling watcher, enable and hash-approval state), the Node host with a worker per mod and `--permission`, the event bus from `chat.rs` events and `task.*`, `$.state`/`$.store`/`$.clock`/`$.ui.status`/`$.ui.toast`, `starkline.theme` token overrides, Settings → Mods (list, enable, approve with hash, errors, reload, safe mode). *Done when:* a mod that toasts when a task reaches review works identically for a Claude, a Codex and an OpenCode agent, with the window hidden; a mod that throws or hangs shows an error row and the chat is unaffected.
2. **Guards and prompts.** `prompt.submit` interception in `chat::send`, `tool.call` guard inside `bridge::assess` (tighten-only, `e.tier` visible, per-engine coverage on the Mods page), `command.run` with `$.command.register`, `$.tool.register` via the bridge, rewrite/denial badges and ledger rows, fail-to-ask. *Done when:* one `deny rm -rf` / `rewrite prompt` mod behaves the same on all three engines, `canRewrite` is false and reported on Codex/OpenCode, and a mod cannot turn a gate refusal into an approval (tested).
3. **Element-tree UI.** `ui.render` for `AbovePrompt`, `Pane` (a tab in the tool rail), task header band; the `ElementTree` renderer onto `src/design`; `ui.press` / `ui.message` back to the host; gate-mediated `$.fs` / `$.process` / `$.http`. *Done when:* a mod pane with a Button that runs a command asks the developer first.
4. **Agent authoring and install.** Staging in `.starkline/mods`, diff and Install copying approved bytes, capability-limited "Trust edits", `AUTHORING.md`, the `prompts.rs` pointer, `mods_status`, the Claude-mod compatibility corpus (the same sample mods run in both). *Done when:* "put my open task count in the status line" yields a staged mod that runs only after approval.
5. **Later, not committed:** attach Starkline as a surface to Claude subprocesses to show in-Claude mod UI (needs the `ui_attach` protocol, unverified); `$.model.complete` through the spend ledger; message renderers; marketplace install; per-agent mod scoping.

Files a builder will touch: new `src-tauri/src/mods.rs` and `src-tauri/mods-host/*`; `bridge.rs` (`assess`), `chat.rs` (`send`, event fan-out), `lib.rs`, `config.rs`; `src/features/mods/*`, `src/stores/mods.ts`; settings files as in v1; later `ChatComposer.tsx`, `TaskSideRail.tsx`. Slices 1 and 2 touch `bridge.rs`/`chat.rs` while FRIDAY and KAREN are active there: claim exclusively before starting.

## 10. Decisions for the developer

1. **Adopt Claude Code's mod API as a declared subset.** Or define a Starkline-only API. *Recommend adopt* (§4): carries over community mods, the developer's mods and agent knowledge, with a pinned `starkline-api` version and our own type shim.
2. **Runtime: Rust-managed Node mod host, a worker per mod, `--permission`.** Or Web Worker, or an embedded engine crate. *Recommend the Node host* (§6): works hidden, faster than today's per-call hook, no new dependency, native TypeScript.
3. **Tighten-only.** Mods can deny or require approval, never approve, never create standing rules. *Recommend yes.* A later `grants` capability (a hash-approved, scope-limited standing rule written by a mod) is a separate decision, off the table now.
4. **Mod effects (`fs`, `process`, `http`) mediated by the gate under `mod:<id>`.** *Recommend yes*; this is what makes mods safer than Claude's unsandboxed ones.
5. **Agent-written mods are staged in `.starkline/mods`, installed by copying approved bytes to `$APPDATA/mods`; "Trust edits" only for `observe`/`ui` mods.** *Recommend yes.*
6. **Claude's installed plugins: leave them alone, show them read-only, de-duplicate by `name`; no `--bare`.** *Recommend yes*; the optional "run Claude without my plugins" switch off by default.
7. **Rewrite on Codex and OpenCode.** Refuse with a visible notice and let mods deny-with-guidance instead (they cannot rewrite those engines' calls). *Recommend yes.*
8. **Guard failure mode: fail to "ask".** *Recommend yes*, matching `gate-hook.mjs`.
9. **Node floor.** Require the Node version that supports type stripping and `--permission` for mods (mods disabled with a clear message below it), rather than shipping a compile step. *Recommend yes;* the exact minimum to be confirmed by a short spike on the oldest Node the app supports (not measured; this machine has 26.9).
10. **Slice order 1 → 2 → 3 → 4**, observers before guards so the gate's insertion point is changed once, with tests, after the host is proven. *Recommend yes.*
11. **v1's smaller decisions carry over unchanged:** "Mods" naming, a Settings section, polling not `notify`, user mods first and project mods staged-only, no mod access to the Environment room, safe mode and hang guard (now done by killing a worker).

An ADR (`docs/adr/0001-mod-trust-model.md`) should be written once 2, 3 and 4 are answered: hard to reverse, surprising, a real trade-off.

## 11. Not verified, and risks

- **Headless `tool.call` live** and **a rewritten prompt reaching the model**: not run (no login in the throwaway config; I did not use `~/.claude`). Hooks loading and `prompt.submit` firing headless are verified.
- **`ui_attach` protocol** for attaching Starkline as a surface: types mention it; wire format unseen.
- **PreToolUse `updatedInput`** in Claude Code: from my knowledge of Claude Code hooks, not exercised here.
- **Codex and OpenCode system-prompt channel** (`prompt.compose` at session creation) and **Codex's `$.tool.register` path** (MCP config): not read in detail.
- **Which Codex calls it asks about** under "untrusted" policy varies by Codex version; the Mods page should state coverage from observed behaviour, not from this table.
- **Claude-side API churn and the rollout flag** can break compatibility; the pinned subset limits the blast radius but does not remove it.
- **Node `--permission` and network**: `--allow-net` exists as a flag; I verified fs and child-process denial but did not test network denial.
- Scratch files from the run are in `/tmp/vision-modtest` (throwaway mod `probe`, its log, `out.jsonl`, `debug.log`); nothing outside `/tmp` was written except this document.
