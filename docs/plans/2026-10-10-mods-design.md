# Starkline mods — design proposal

Status: proposal for to-do #15 ("Mods support like Claude, so the user can customise their chat screen or interface the way they want, with hot reload"). Design only; no product code written. Author: VISION, 2026-10-10.

## 0. What we borrowed from Claude Code mods, and what we did not

Claude's `plugin-authoring` skill describes a mod as a folder (`.claude-plugin/plugin.json` + `hooks/hooks.json` + one module) exporting `register(on, options)`. Hooks have the shape `($, e, next)`; `next` is a middleware chain, so a hook can answer, rewrite or defer. UI is drawn by `ui.render` hooks on named slots (`Pane`, `AbovePrompt`), plus `$.ui.status`, `$.ui.toast`, `$.command.register`, atoms in `$.state`. The module runs in an isolated environment with no DOM, and everything outside is reached through `$`. A file watcher reloads the module when the turn ends, and the host keeps the state across reloads.

Borrowed:
- a manifest plus one entry module;
- a typed API object and named slots;
- host-held state that survives reload;
- an error-isolated reload;
- an opt-in switch for hot reload;
- an authoring skill the agent loads.

Deliberately not borrowed:
- **The `next()` middleware chain.** Claude needs it because mods intercept tool calls. In Starkline, the permission gate, tool calls and delivery are Rust and must not be interceptable by UI customisation. Starkline mods are additive and observational, so there is no `next`.
- **The isolated environment.** Starkline's UI is React in one webview and the user wants to restyle real components, so mods run in the main webview (see §4 for the consequences).

## 1. What a mod can do

Term used throughout: **mod** = a user-owned folder that extends Starkline's interface. **Slot** = a named place in the interface a mod can draw into. **Contribution** = one thing a mod adds to a slot. (Proposed glossary entries for CONTEXT.md, which does not exist yet.)

| Capability | Slot / API | v1 | Later |
|---|---|---|---|
| Theme and CSS override | `theme` in manifest (token overrides of `--surface-*`, `--accent`, `--radius-*`...) plus an optional `style.css` scoped under `[data-mod="<id>"]` and `:root` tokens | yes | Per-agent or per-project themes; a mod-supplied room |
| Chat header band | `taskHeader.band` (under `TaskHeader`) | yes | |
| Above-composer band | `composer.above` (between `MessageList` and `ChatComposer`) | yes | |
| Side-panel tab or pane | `taskRight.tab` (the tool rail beside the chat: terminal, browser, simulator) | yes | Left column tab, full-screen route |
| Composer action | `composer.action` (a chip or button next to `ModelChips`) that can insert text, attach or submit | yes (insert text only) | Submit, transform on send |
| Status line | `status` text in the top bar | yes | |
| Toast | `starkline.toast(text, tone)` | yes | |
| Event hooks | `starkline.on("chat.message" \| "task.status" \| "task.review" \| "agent.status" \| "reminder.due", fn)`, read-only | yes (4 events) | More events |
| Message decorators | Add a badge or footer to a message, and restyle by role | no | Yes, after v1 (see below) |
| Message renderers | Replace the renderer for a content kind (for example, tool output of kind `Bash`) | no | Yes, after v1 |
| Slash commands | `starkline.command.register` into the composer | no | Yes |
| Mutating hooks | Rewrite a prompt, deny a tool call | **never** | Stays in Rust (gate, policy) |

Reasons for the cuts:
- Message decorators and renderers depend on `MessageList` exposing stable per-row props. That is a refactor to do deliberately, not in v1.
- Mutating hooks stay out of v1 and are out of scope in general. A mod must never sit between an agent and the permission gate.

## 2. Format and API

Folder layout:

```
my-mod/
  mod.json          manifest
  index.js          entry (single-file ES module; see decision 3 for TS/JSX)
  style.css         optional
  assets/           optional (images, sounds)
```

`mod.json`:

```json
{
  "id": "focus-band",
  "name": "Focus band",
  "version": "0.1.0",
  "api": "1",
  "entry": "index.js",
  "style": "style.css",
  "theme": { "--accent": "#ff7a59" },
  "slots": ["composer.above", "status"],
  "events": ["task.status"]
}
```

`slots` and `events` are declared up front so the Mods page can say what a mod touches and so a call outside them is refused.

`api` is an integer major version. The host supports the current major and the previous one for one release; a mod with an unknown major is listed as incompatible, not loaded.

Entry module:

```js
export default function activate(starkline) {
  const { h, useState } = starkline.react;        // host's React; mods never bundle their own
  starkline.slot("composer.above", ({ chat, task }) =>
    h("div", { className: "focus-band" }, `Focus: ${task?.title ?? "no task"}`));
  starkline.on("task.status", (t) => t.status === "review" && starkline.toast(`${t.title} is ready`));
  return () => { /* optional cleanup; host also unregisters everything on reload */ };
}
```

The host injects a frozen `starkline` object (one version per major):
- `starkline.react`: `h`, `Fragment`, hooks. This avoids two Reacts and hook mismatches, which is the main failure of in-process UI plugins.
- `starkline.ui`: the design-system primitives already in `src/design` (Button, Chip, EmptyState, Tabs, icons), so mods match every theme for free.
- `starkline.slot(id, Component)`, `starkline.on(event, fn)`, `starkline.toast`, `starkline.status`.
- `starkline.read`: read-only snapshots and hooks of stores (`useTask`, `useAgents`, current chat id, theme id). Plain data, not the zustand stores themselves.
- `starkline.storage`: per-mod key/value persisted by Rust at `<mod dir>/.data.json`. Survives reload, unlike module variables (the `$.state` analogue).
- `starkline.options`: values declared by `options` in the manifest (typed controls rendered on the Mods page).

Types ship as `src-tauri/resources/mods/starkline-mods.d.ts` (or `docs/mods/`), copied into each mod's folder on first load so editors and agents see them, mirroring Claude's `.claude-plugin/types/`.

The slot components are rendered by a host `<ModSlot id=... context=.../>` component; each slot passes a typed context prop. Adding a slot is one line in a core component, so the list grows without API churn.

## 3. Where mods live, and hot reload

Locations (later wins on id clash, with a warning):
1. **User mods:** `$APPDATA/mods/<id>/` (`~/Library/Application Support/com.omgandhi.starktower/mods/`). Always applies.
2. **Project mods:** `<project>/.starkline/mods/<id>/`, applying only while that project is the active workspace. `.starkline/` already exists in the repo conventions (`workspaces.rs`). These are committable and shareable, so they are treated as untrusted-by-default (§4).

Rust side, new `mods.rs` (one responsibility: discover, watch, serve, record state):
- `mods_list()` returns manifests, status, error and content hash. State (enabled, approved hash, last error) lives in `config`.
- **Watching without a new dependency:** a thread polls mtimes of the mod directories every 500 ms (cheap, a handful of files), debounces 150 ms, and on change emits `mods://changed { id, version }`. If the developer prefers a real FS watcher, the `notify` crate is the one install and would need approval; polling is the recommended v1.
- **Serving module code, no Vite needed:** a Rust command `mods_source(id, path)` returns the file text, and the frontend turns it into a `Blob` URL and `import()`s it. Every reload creates a new Blob URL, so the cache-busting problem does not exist. This works identically in `tauri dev` and the built `.app`, and needs no CSP change (`csp` is currently `null`) and no new scheme. Limitation: a single-file module, since relative `import`s inside a Blob do not resolve.
  - *Alternative if multi-file mods are wanted:* register `starkline-mod://` with `register_uri_scheme_protocol`, serve `<mods>/<id>/<path>?v=<hash>` with `text/javascript`, and `import()` that URL. The existing `assetProtocol` (already scoped to `$APPDATA/attachments` and `looks`) could also serve `$APPDATA/mods/**`, but module imports through `asset://` and WKWebView CORS are not verified here; confirm in a spike before relying on it.
- `style.css` and `theme` tokens are not code: the frontend injects/replaces a `<style data-mod-id>` element directly, which is instant and needs no module reload.

Frontend side, new `src/features/mods/` and `src/stores/mods.ts`:
- `ModHost` mounts once in `App.tsx`. On `mods://changed` (and at start) it unmounts the old instance (runs cleanup, drops its slot registrations and listeners, removes its `<style>`), then dynamically imports the new module and calls `activate`. Slot registry is a zustand store keyed by `modId:slotId`, so `<ModSlot>` re-renders on its own.
- Storage and options survive because Rust holds them; component state inside a slot is lost on reload, as in Claude.
- Dev (`tauri dev`) and built app behave the same, because neither depends on Vite. The only difference is that in dev the Vite HMR continues to reload the host app itself, which re-runs `ModHost` and re-imports mods.

## 4. Safety

**What "runs in the main webview" means, said plainly.** A mod is arbitrary JavaScript in the same window as Starkline's UI. Anything it can reach, the app can reach, including `window.__TAURI_INTERNALS__.invoke`, which today exposes every Tauri command. That includes the commands that start agents, approve permission requests and open a terminal. We cannot truthfully promise an API-only sandbox while the module shares the realm. Mods are therefore **trusted code, equivalent to installing an app**, and the design must make that visible rather than pretend otherwise.

Specific risk to design around: **agent-authored mods are a privilege-escalation path.** Today an agent's file writes go through the permission gate. A mod is code that runs ungated in the privileged webview. If an agent can write into `$APPDATA/mods` or `.starkline/mods` and it loads automatically, the gate is bypassed. Required controls:

1. **Nothing runs until the developer approves it.** A new mod, or a mod whose content hash changed, starts as "Needs review" and is not imported. Approval records the hash.
2. **Per-mod "Trust edits while developing" toggle.** Off by default. When on, hash changes of that mod auto-reload (this is what makes hot reload useful for the authoring loop) and the Mods page shows a persistent "auto-reloading unreviewed edits" badge. Project mods under `.starkline/mods` never get this on by default, because a cloned repo is untrusted input.
3. **Agent writes to mod folders are gate-classified as "executable config"**: the existing permission gate (`gate.rs`/`policy.rs`) asks for these paths the way it would for a shell command, even in auto mode. (Needs a check of how `policy.rs` classifies paths; this is the main backend dependency of the whole feature.)
4. Mods cannot be fetched from the network by Starkline in v1 (no gallery, no URL install).

**Reducing the blast radius without a sandbox:**
- The `starkline` object is the only documented surface; `Object.freeze`d and per-mod-scoped (calls outside the declared `slots`/`events` throw). This is a guard against mistakes, not against malice, and the Mods page copy says so.
- Optional later hardening: run "pure UI" mods in a sandboxed `<iframe sandbox="allow-scripts">` with a `postMessage` RPC. That gives a real boundary for panes and bands, but cannot cover composer actions, decorators or restyling of host elements. See decision 2.
- CSP: stays `null` for v1 and mods add no remote origins. Do not loosen anything for mods. When a CSP is introduced later, `script-src` needs `blob:` if the Blob approach is kept (a known cost of that choice; the custom-scheme variant would instead need the scheme listed).
- Tauri capabilities (`capabilities/default.json`) are per window, not per script, so they cannot constrain a mod. No new permissions are required for v1; `mods.rs` commands are ordinary app commands.

**Error isolation (a broken mod must not break the chat):**
- Every slot render is wrapped in its own React error boundary (`ModSlot`). A throw renders nothing (or a small "Mod X failed. Details" chip) and records the error; the host component beside it is unaffected.
- `activate`, event handlers and storage calls are wrapped in try/catch; errors go to the mod's error log.
- `activate` and each event handler run under a time budget. Synchronous infinite loops cannot be interrupted in a shared realm, so a **hang guard** is needed: `ModHost` sets a "loading mod X" marker in `localStorage` before import and clears it after `activate`. If the webview restarts with the marker still set (the user force-quits or reloads), that mod is auto-disabled with an explanation. Starkline already has a crash log and guard (`event_guard.rs`, crash log); this reuses the same idea.
- Async handlers get a 2 s timeout wrapper and are dropped if late. Rendering is limited to the React tree, so a slow render is visible in React but does not block the other mods' slots from mounting.
- Safe mode: holding Option at launch, or a `--no-mods` flag, starts with all mods off. The Mods page and the crash banner offer "Disable all and restart".

**Mods settings page** (a new `mods` section in `SettingsNav`, `src/features/settings/ModsSettings.tsx`):
- Rows: name, id, source (User / Project: name), version, slots touched, status (Running, Disabled, Needs review, Error, Incompatible), last reload time.
- Actions: Enable/Disable, Reload, Approve (shows the file list and content hash, and a read-only view of the source for review), Trust edits toggle, Open folder in Finder, Copy path, View errors (last 50 with stack), Remove.
- A footer "Reload all" and "Disable all", and the one-line trust statement above.

## 5. Agents authoring mods on request

- Ship a **mod-authoring guide** that agents can load on demand: `docs/mods/AUTHORING.md` (embedded in the app bundle and also written to `$APPDATA/mods/AUTHORING.md` and `starkline-mods.d.ts` on first run so it exists outside the repo). Contents: manifest, the `starkline` API, slot list with context shapes, the design tokens list (`--surface-*`, `--accent`...), do/don't (use tokens; never hardcode colours; keep a mod to one folder; declare slots), and the loop (write → page shows "Needs review" → ask the developer to approve → edit freely with Trust edits on).
- Delivery to the agent: a short pointer in the instructions Starkline already gives agents (`prompts.rs`): "To change how Starkline looks or behaves, write a mod, see <path>/AUTHORING.md. Do not edit Starkline's own source." Because agents run in a project folder and not in this repo, the guide is the only way they know the format, so the path must be absolute and stable. For Claude Code agents this can also be a real skill file placed in Starkline's per-agent skills location, if one exists for the other providers (Codex/OpenCode read AGENTS.md instead, so the prompt pointer is the provider-neutral route).
- Add one **mod CLI-free verification path**: the Mods page lists the manifest errors in plain language so the agent can be told "fix this error" by the developer pasting it. Later, a read-only `mods_status` tool for agents (their own mod's last error), which closes the loop without the developer relaying errors. This is in slice 4, and is the one agent-facing API; it is read-only and gated like any other tool.
- Writes by the agent to the mods folder go through the gate (control 3 above). The developer sees an approval request that says "adds code that runs inside Starkline" instead of a plain file write.

## 6. Slice plan (each shippable alone)

1. **Themes and CSS mods, with the Mods page.** `mods.rs` (discover, manifest validation, polling watcher, enabled/approval state), `mods://changed`, `style.css` + token overrides injected live, `ModsSettings` page with list, enable/disable, reload, errors, Needs-review approval by hash. No JavaScript executed yet, so no trust problem: this alone delivers hot-reloading restyling, covers the commonest ask ("customise the interface"), and lets us settle the folder layout, state and approval UX. *Done when:* dropping a folder with a token override into the mods dir restyles a running built `.app` within about a second, and a malformed manifest shows an error row and nothing else changes.
2. **Mod runtime: slots on the task page.** `ModHost`, Blob-URL import, `starkline` API v1 (`react`, `ui`, `slot`, `toast`, `status`, `storage`), `<ModSlot>` with error boundary and hang guard in `composer.above`, `taskHeader.band` and `status`. Types file and an example mod. *Done when:* a mod draws a band above the composer, an edit reloads it with storage kept, and a mod that throws in render or in `activate` leaves chat usable and shows the error on the Mods page.
3. **Panes, composer actions and events.** `taskRight.tab` (a mod tab in the tool rail), `composer.action` (insert text), read-only events (`chat.message`, `task.status`, `task.review`, `agent.status`) bridged from the existing `chat://event`/store updates, per-project mods from `.starkline/mods` with the project trust rules, `options` controls. *Done when:* a mod adds a side-panel tab fed by task events, and a project mod stays "Needs review" until approved.
4. **Agent authoring.** `AUTHORING.md` and `.d.ts` written to `$APPDATA/mods` at startup, the prompt pointer in `prompts.rs`, gate classification of writes to mod folders as executable config, "Trust edits while developing", read-only `mods_status` for agents. *Done when:* asking JARVIS "put my open task count in the status line" produces a mod that shows "Needs review", runs after approval, and reloads on the agent's later edits without further prompts.
5. **Later (not committed): message decorators and renderers**, slash commands, optional iframe-sandboxed tier, multi-file mods via a custom scheme, TS/JSX build step, sharing/gallery. Each needs its own design; none is required by the earlier slices.

Slices 1 and 2 are independent of each other in code (slice 2 only needs the discovery and state from slice 1), so two people can overlap after the `mods.rs` manifest/state contract is agreed.

Files a builder will touch (for claiming): new `src-tauri/src/mods.rs`; `lib.rs` (register commands, manage state); `config.rs` (mod state); new `src/features/mods/*`, `src/stores/mods.ts`; `src/app/App.tsx` (mount `ModHost`); `src/features/settings/{SettingsNav,SettingsScreen,ModsSettings}.tsx` and `src/stores/navigation.ts` (`SettingsSection` gains `"mods"`); slice 2+ also `TaskHeader.tsx`, `TaskConversation.tsx`/`ChatComposer.tsx`, `TaskSideRail.tsx`, and `src/shell/TopBar.tsx`.

## 7. Open decisions for the developer

See the numbered list in the hand-off summary; they are repeated here in full.

1. **Trust model.** Run mod JavaScript in the main webview as trusted code (this design), or sandbox it in an iframe from day one?
   - *Recommend:* trusted main-webview for v1 with the approval-by-hash rules; add an iframe tier later for "pure UI" mods. Sandbox-first would rule out composer actions and restyling host elements.
2. **Who may author?** Allow agents to write mods at all in v1?
   - *Recommend:* yes, but with approval-by-hash, writes to mod folders classified as executable config by the gate, and project mods untrusted by default.
3. **Authoring language.** Plain JS single-file ES modules in v1 (with `h()` or a tagged `html` helper and a `.d.ts` for JSDoc types), or accept TS/JSX and add a compile step?
   - *Recommend:* plain JS in v1. Agents write it fine, no toolchain is shipped; TS/JSX is a later add (bundled `esbuild` binary or `swc` in Rust).
4. **Multi-file mods.** Single file only (Blob import), or serve folders through a custom `starkline-mod://` scheme now?
   - *Recommend:* single file in v1; spike the custom scheme in slice 3 only if a real mod needs a second file. Assets (images) are fetched through the existing asset protocol scope or Rust command either way.
5. **File watching.** Poll mtimes in Rust (no new dependency), or add the `notify` crate?
   - *Recommend:* poll (500 ms). Adding a crate needs approval and gains nothing at this scale.
6. **Project mods (`.starkline/mods`).** Support in v1 (slice 3) or user mods only?
   - *Recommend:* user mods first, project mods in slice 3 with per-mod approval, never auto-approved, never "Trust edits" by default.
7. **Mutating hooks.** Confirm that mods will never intercept prompts or tool calls (no `next()` chain, permissions stay in Rust).
   - *Recommend:* confirm. This keeps the permission model unbreakable by UI customisation.
8. **Scope of v1 slots.** Is the v1 list in §1 right, in particular: no message decorators/renderers in v1, composer action limited to inserting text?
   - *Recommend:* yes. Decorators/renderers need a stable per-message props contract in `MessageList`, which is its own piece of work.
9. **Where the Mods page lives and what it is called.** A "Mods" section in Settings (this design), or a top-level route?
   - *Recommend:* Settings section, between Theme Studio and Diagnostics. Theme Studio keeps built-in themes; a theme mod appears there as an extra entry later.
10. **Relationship to Theme Studio and the pixel-art Environment.** Do mods get to touch the Environment room?
    - *Recommend:* no. Per the roadmap the room stays pixel-identical; mods affect the real UI only (tokens, task page, settings), never the Environment canvas.
11. **Safe mode and the hang guard.** Is auto-disabling a mod that was loading when the webview died acceptable, plus an Option-at-launch safe mode?
    - *Recommend:* yes.
12. **Naming.** "Mods" (matches the to-do and Claude's terminology) vs "Extensions"/"Plugins".
    - *Recommend:* "Mods". Reserve "plugin" for Tauri plugins and provider plugins to avoid confusion.

An ADR (`docs/adr/0001-mod-trust-model.md`) should be written once decisions 1–2 are answered, since they are the hard-to-reverse, surprising, genuinely traded-off ones. The remaining decisions are cheap to change.

## 8. Risks and things not verified

- **Not verified:** whether WKWebView in the built app imports a Blob URL module without restriction while `csp` is `null` (expected to work; confirm in a slice 2 spike before building around it). Also how `policy.rs` classifies writes by path (control 3 depends on it).
- **Not verified:** which provider-specific skill locations Starkline controls for delivering the authoring guide; the prompt pointer in `prompts.rs` is the provider-neutral fallback.
- **Cost of the shared realm:** a mod can monkey-patch globals (`fetch`, `localStorage`, the Tauri bridge). The design treats this as accepted under "trusted code".
- **API stability:** the `starkline` API is a public contract once mods exist in the wild. Version it from slice 2 (`api: "1"`), keep it small, and prefer adding slots to changing signatures.
