# Stark Tower: Product and Experience Design

**Status:** Validated product direction  
**Date:** 2026-09-16  
**Scope:** Product architecture, agent orchestration, permissions, task workflow, automations, notifications, themes, environments, and visual direction  
**Implementation status:** Design only

## 1. Product thesis

Stark Tower becomes a local-first operating environment for AI-assisted software work. It is not primarily a terminal multiplexer and not merely an animated agent floor. Its primary job is to make multi-agent work understandable, controllable, recoverable, and pleasant for one developer working across multiple local projects.

The product has two equally important surfaces:

1. **Work** is the operational surface. It answers what is running, what changed, what needs the developer, and what is ready for review.
2. **Environment** is the living spatial surface. It makes agents, collaboration, activity, and organizational identity visible without becoming the only way to operate the product.

The Environment is themeable. Stark Tower is one theme rather than the permanent identity of the entire product. Other themes can include a contemporary office, a Japanese cafe and forest, a space station, a library atelier, or future community-created environments.

The product is installed and configured locally per developer. There is no initial organization account, shared company control plane, or cross-machine delegation system. Each developer can choose their own agents, providers, permissions, themes, appearance packs, and automation behavior.

## 2. Product principles

- **Task-first, world-enhanced.** Work is organized around durable tasks; the environment visualizes those tasks.
- **One accountable owner.** The agent that receives a task owns the final report, even when other agents or temporary subagents contribute.
- **Local-first.** Tasks, memory, approvals, event history, schedules, and configuration live locally.
- **Human authority is structural.** Models cannot loosen permissions, rewrite policy, or grant themselves capabilities.
- **Provider truth over fake parity.** Claude Code, Codex, and OpenCode expose different capabilities. Stark Tower reports those differences honestly.
- **Progressive disclosure.** Human summaries come first; terminals, raw events, logs, and provider payloads remain available on demand.
- **Recoverable by default.** Crashes, sleep, lost provider sessions, and interrupted verification must leave an inspectable state.
- **Visual identity without operational ambiguity.** Themes may change atmosphere, vocabulary, characters, and sound, but never task semantics, permissions, or execution behavior.
- **No silent Git manipulation.** Stark Tower never silently stashes, discards, switches, resets, or cleans developer work.

## 3. Users and operating model

The primary user is a developer using Stark Tower as a personal daily driver. The same product can be used independently by other developers, including an internal team, but each installation remains locally owned and locally configured.

The organizational metaphor is:

- The developer is the CEO.
- JARVIS is the CTO or supervisor. JARVIS receives compact awareness of activity across the office without needing to participate in every task.
- Named agents such as FRIDAY, VISION, EDITH, KAREN, and VERONICA are durable employees with stable identity, memory, provider, model, and appearance.
- Temporary subagents are short-lived helpers owned by a parent agent. They are not promoted to full employees merely because they performed work.

Reporting follows assignment:

- Developer to JARVIS to workers: workers report to JARVIS; JARVIS reports to the developer.
- Developer directly to FRIDAY: FRIDAY reports directly to the developer, even when VISION or temporary helpers contributed.
- The developer may directly steer any subagent. The intervention is recorded in the task timeline and the owning agent is notified automatically.

JARVIS may pause unsafe work automatically. JARVIS must ask before changing scope, reassigning ownership, or transferring a task to a different named agent.

## 4. Core domain model

The execution model uses neutral concepts so themes cannot leak into core behavior:

- **Developer:** the human authority for the local installation.
- **Supervisor:** the globally aware named agent, commonly JARVIS.
- **Agent:** a durable named worker with identity, memory, provider, model, and appearance.
- **Subagent:** a temporary worker attached to a parent agent and task.
- **Task:** the durable unit of work, ownership, conversation, permissions, workspace, and completion.
- **Workspace:** the checkout or worktree assigned to a top-level task.
- **Provider adapter:** the bridge to Claude Code, Codex, or OpenCode.
- **Approval:** a human decision granting or denying one action or a persisted permission rule.
- **Automation:** a schedule that creates normal tasks under a named owner.
- **Theme:** a visual and experiential presentation layer.
- **Roster pack:** a set of character appearances that can be applied independently of theme.

Agent identity and appearance are intentionally separate. Changing a character sprite must not change the agent's provider, memory, name, role, or personality.

## 5. Local architecture

Stark Tower uses a small local Rust supervisor process that survives the desktop window closing.

```text
Desktop UI
  | authenticated local IPC
  v
Local Rust Supervisor
  |- Task engine
  |- Agent registry
  |- Provider adapters
  |- Permission engine
  |- Workspace manager
  |- Automation scheduler
  |- Notification service
  |- Power manager
  `- SQLite event store
        |
        `- local projects, provider processes, Git, and OS services
```

The desktop UI is a client of the supervisor. Closing the window does not terminate valid background work. The supervisor is authoritative for task state, provider processes, permissions, approvals, schedules, notifications, wake assertions, and recovery.

SQLite stores tasks, relationships, conversations, approvals, permission decisions, provider sessions, workspace ownership, file claims, verification results, notification records, wake schedules, and recovery metadata. An append-only event table provides a reconstructable history for every task.

On restart, the supervisor validates provider processes, workspaces, locks, and filesystem state. It marks each interrupted task as resumable, recovery required, attention required, or failed. It never infers successful completion from a vanished process.

Themes live in the UI and asset system. The supervisor never needs to know whether a running task is represented by a holographic engineer, a cafe patron, or a forest spirit.

## 6. Task engine

The primary task states are:

```text
Queued -> Running -> Verifying -> Ready for review -> Closed
             |           |
             v           v
      Waiting for approval
             |
             v
          Blocked

Terminal states: Failed, Cancelled
```

A task records:

- Requester and report owner
- Project, branch, checkout, and workspace
- Named owner and participating agents
- Parent, child, and temporary subagent relationships
- Effective permission policy
- Provider sessions and capabilities
- Claimed files and sensitive shared resources
- Approvals, warnings, questions, and human interventions
- Verification commands and results
- Final human-readable handoff

The owning agent is responsible for synthesis. Child agents return findings and results to their parent. Their raw transcripts remain inspectable but do not become parallel conversations the developer must manually reconcile.

JARVIS receives compact office events: task created, delegated, blocked, approval requested, verification failed, ready for review, closed, failed, or recovered. JARVIS may request deeper detail when needed.

## 7. Workspace and collaboration rules

One top-level task owns one workspace. Multiple agents may collaborate inside it when their work belongs to the same task.

- The first writer may use the current checkout if no other task owns it.
- A separate top-level task that needs write access receives a separate worktree when the current checkout already has a writer.
- Read-only agents may inspect a workspace concurrently.
- The task owner controls Git operations.
- Collaborators claim intended files or areas before editing.
- Overlapping claims are blocked and surfaced to the owner and developer.
- Lockfiles, migrations, generated output, shared types, and other sensitive shared files require exclusive ownership.
- Stark Tower never automatically stashes, switches branches, discards changes, cleans files, or removes a dirty worktree.
- A worktree with uncommitted or unmerged work cannot be deleted automatically.

The UI explains workspace decisions in plain language, for example:

> This task is using the current checkout because no other task is editing it.

or:

> A separate worktree was created because another task is already writing to this project.

## 8. Provider adapter contract

Claude Code, Codex, and OpenCode are implemented as first-class adapters behind a shared contract:

- `detectInstallation`
- `validateAuthentication`
- `startSession`
- `resumeSession`
- `sendMessage`
- `interrupt`
- `stop`
- `parseEvents`
- `requestApproval`
- `capabilities`

Each adapter explicitly reports support for structured events, session resume, lifecycle hooks, approval bridging, filesystem sandboxing, network controls, native subagents, usage metrics, and MCP.

Unsupported capabilities remain unsupported. Terminal parsing may improve presentation but cannot enforce permissions, determine completion, or create a false claim of provider parity. Providers without enforceable approval or sandbox hooks cannot run unattended writes.

Named agents remain tied to their configured provider until a developer changes configuration. JARVIS follows the same rule. Provider failure blocks the task with a clear explanation rather than silently moving the agent to another provider.

Temporary subagent policy is configurable per named agent:

- Inherit provider and model
- Inherit provider but use a different model
- Use a fixed provider and model
- Disable temporary subagents
- Set concurrency, nesting depth, runtime, and usage limits

Codex integration must preserve `AGENTS.md`, project instructions, installed skills and plugins, account configuration, and native session behavior. Stark Tower adds task context without replacing the user's existing Codex profile. Claude Code and OpenCode receive equivalent respect for their native instruction and session systems.

## 9. Instructions and memory

Context precedence is deterministic:

1. Developer rules
2. Project instructions
3. Agent identity and durable memory
4. Task contract and live state

An **Active context** inspector lists every source, its precedence, its scope, and whether the active provider accepted it.

Memory is separated into:

- Agent memory
- Project memory
- Immutable task history
- Optional developer memory

Temporary subagents receive only the task and project context needed for their assignment. They do not inherit unrelated personal or agent memory. The parent decides which findings should be promoted into durable memory.

SQLite remains authoritative. Agents use a controlled memory API rather than rewriting entire memory files. Writes are transactional and carry source, scope, creation time, and last-verification metadata. Markdown snapshots may exist for portability and inspection, but they are derived views rather than the transactional source of truth.

## 10. Permissions and approvals

Permissions are enforced by the Rust supervisor and operating-system boundaries, not by prompts. A model cannot change configuration, loosen policy, issue itself a capability, or bypass a denial.

Subagents inherit the same or stricter permissions than their parent. Delegating across providers cannot expand permissions.

Recommended defaults:

**Automatic**

- Read and search within the assigned project
- Edit inside the assigned workspace
- Run existing build, lint, type-check, and test commands
- Use task-scoped temporary files
- Spawn allowed subagents within configured limits

**Approval required**

- Install or update dependencies
- Create or switch branches
- Access files outside the project
- Run database migrations
- Start externally accessible services
- Add credentials
- Reassign ownership or change scope

**Never automatic**

- Commit, push, deploy, or publish
- Delete branches or worktrees
- Discard, reset, clean, or stash developer changes
- Send external messages or perform external business actions
- Execute destructive commands

Developers may loosen policy globally, per project, or for a task. The UI always shows the effective policy and its inherited sources.

Approval cards show the exact action, command where applicable, working directory, requesting agent, reason, affected resources, and blocking rule. Available decisions are:

- Deny
- Allow once
- Allow for this task
- Always allow

Choosing **Always allow** opens a human confirmation sheet showing the exact stored rule and asks whether it applies to this project or all projects. The user chooses the scope; the agent cannot preselect it. High-impact rules require stronger confirmation. Every decision is audited and can be revoked from Settings.

## 11. Completion and closure

Completion has two separate states:

- **Ready for review:** all child results are collected, the combined diff has been reviewed by the owner, configured verification has run, and failures or skipped checks are disclosed.
- **Closed:** the developer accepts the work, or an eligible task satisfies a developer-enabled automatic closure policy.

Automatic closure is off by default and controlled by the developer. It requires an eligible task type, no unresolved approval, warning, or child task, successful required checks, no changes outside claimed areas, a complete handoff, and explicit project policy.

Automatic closure never means commit, push, deploy, branch deletion, worktree deletion, or cleanup of developer changes.

The handoff is written for a human and includes:

- Outcome
- Agent contribution chain
- What changed and why
- Behaviors or screens affected
- Verification performed and results
- Skipped checks or uncertainty
- Warnings and remaining decisions
- Clear next actions

Raw JSON, provider events, commands, logs, and full diffs live behind expandable technical details.

## 12. Automations, sleep, and scheduled wake

An automation creates an ordinary task on a schedule. It defines instructions, project, explicit named owner, permission policy, verification requirements, notification behavior, missed-run behavior, and maximum runtime. JARVIS is preselected as owner, but the developer may choose any named agent.

Every run receives its own task and history.

The local supervisor executes automations even when the desktop window is closed. Unattended runs may use only permissions already granted. A new approval pauses the task and places it in Attention and the Notification Centre.

Stark Tower exposes two installation-level capabilities:

- **Allow Stark Tower to keep this Mac awake while agents are working**
- **Allow Stark Tower to schedule system wake events**

The keep-awake capability is active only while useful work is running, delegating, verifying, or recovering. It does not keep the Mac awake merely because the app, terminal, or environment is open. When all work is waiting for approval, Stark Tower keeps the Mac awake for a configurable grace period and then releases the assertion.

Each automation has its own **Wake this Mac to run** toggle under the global scheduled-wake capability. Enabling it schedules a system wake shortly before the next run. Editing, pausing, or deleting the automation updates or cancels only Stark Tower-owned events. Revoking the global capability cancels all Stark Tower wake events.

On wake, the supervisor confirms the automation is still enabled, validates its workspace and permissions, starts it at the scheduled time, keeps the Mac awake while it runs, and schedules the next event. Wake failures and missed runs are recorded in plain language.

The privileged helper used for wake scheduling exposes only narrowly defined schedule, inspect, and cancel operations. Models never receive administrator credentials or arbitrary privileged execution.

## 13. Recovery and failure handling

After restart, interrupted tasks are classified as:

- **Resumable:** provider session and workspace are intact
- **Needs recovery:** workspace exists but the provider session was lost
- **Needs attention:** state or filesystem changes are ambiguous
- **Failed:** required resources are unavailable

Automatic resume is allowed only when the provider supports reliable continuation and permissions remain unchanged. Otherwise the owner receives a recovery task containing the conversation, workspace state, completed child reports, and outstanding work.

Transient provider crashes and temporary network failures may retry with bounded backoff. Irreversible or externally visible actions are never replayed unless Stark Tower can prove they did not execute.

Recovery messages describe the event and response in plain language rather than exposing process codes as the primary explanation.

## 14. Information architecture

The default screen is **Work**.

Global destinations are:

- Work
- Environment
- Agents
- Automations
- Notifications
- Settings

### Work

The Work screen uses a three-part composition:

- **Project rail:** All work, projects, and saved views
- **Work canvas:** command input, running work, and ready-for-review work
- **Attention rail:** approvals, questions, collisions, failures, and blockers

The command input supports natural delegation and explicit mentions such as `@FRIDAY review the settings redesign`. It always makes the resulting owner and project visible before execution when either is ambiguous.

### Task page

The task header shows state, owner, provider and model, project, branch, workspace, runtime, and effective permission policy.

The center is one continuous conversation with the owning agent. An expandable execution tree reveals contributors without mixing all transcripts together:

```text
FRIDAY - Owner
|- KAREN - Settings UI
|- VISION - Review
`- Helper 1 - Tests
```

Each contributor shows status, current activity, claimed files, and returned findings. The developer can steer any node directly; the owner is notified.

The review rail includes:

- Attention
- Changed files and combined diff
- Verification
- Decisions and assumptions
- Active context

The terminal is a bottom drawer rather than the dominant default surface.

## 15. Notification Centre

The Notification Centre is a persistent cross-project action inbox, accessible from global navigation and a title-bar badge.

Its views are:

- **Needs you:** approvals, questions, collisions, blocked work, and failed automations
- **Updates:** ready-for-review tasks, completed work, recoveries, and warnings
- **History:** resolved, dismissed, expired, and automatically handled events

Notifications use human language and carry relevant actions such as Deny, Allow once, Always allow, Answer, Retry, Resume, Review changes, Close task, Reassign, Steer agent, and Open automation. Sensitive actions open a confirmation sheet.

Related events collapse into one evolving notification with an expandable timeline. Filters include project, agent, type, urgency, and time. Search covers human summaries, task titles, and project names.

macOS notifications deep-link to the same item and synchronize handled state. Dismissing a notification removes it from the active inbox but never cancels or changes its task. History archival is configurable. Stark Tower never automatically deletes notification history.

Routine progress such as started, delegated, or test running remains inside the product. System notifications are reserved for human-required action, failure, readiness, and meaningful completion.

## 16. Environment and theme system

The Environment is a full-screen alternate view of the same task system. It is not a second source of truth.

Named agents occupy the environment as durable characters. Temporary subagents appear as small theme-specific companions near their parent. The scene caps visible companions and replaces overflow with a `+N` group marker to prevent crowding.

A theme pack may define:

- Environment geometry and zones
- Tilemaps, props, surfaces, and lighting
- Typography, palette, and material treatment
- Ambient sound and interaction sounds
- Character presentation rules
- Companion presentation rules
- Motion language
- Vocabulary labels
- Optional starter roster appearance pack

A theme never changes execution, task states, permissions, memory, provider settings, or agent identity.

When changing themes, the user chooses:

- Keep current agent appearances
- Use the theme's roster pack
- Browse another roster pack

The user previews the result before applying it. Cancelling restores the current environment. Applying a roster pack is visual by default. A separate explicit action may apply theme character names or personalities.

## 17. What to learn from the Munder Duflin reference

The supplied reference demonstrates three valuable qualities:

- The workplace is continuously visible.
- Character position and posture communicate activity without opening a task.
- The roster establishes a memorable relationship between names and workers.

It also shows constraints Stark Tower should avoid:

- The terminal dominates the operating experience.
- Small labels and speech bubbles overlap the environment.
- A fixed multi-pane layout becomes crowded as the roster grows.
- Status is repeated across the floor, terminal, and roster without a clear hierarchy.
- Low-resolution sprites and office furniture can become visually interchangeable.

Stark Tower should borrow ambient legibility, not the exact layout or art direction.

## 18. Visual direction ideations

### Direction A: Precision Diorama - recommended

This is a hybrid of pixel art and restrained realism. Characters remain readable, charming sprites, while architecture, materials, lighting, reflections, fog, screens, and particles create a premium miniature world.

The camera uses a 2.5D three-quarter or shallow-isometric view rather than a strict top-down plan. Characters use crisp modular sprite rigs at a higher native resolution than classic pixel games. The world may render at device resolution, while character edges retain intentional pixel structure.

**Strengths**

- Preserves the warmth and collectability of pixel characters
- Supports expressive themed environments
- Fits Pixi.js and sprite-atlas rendering well
- Looks distinct from both a generic dashboard and a copied pixel office
- Scales to dozens of themes without requiring full 3D character production

**Risks**

- Requires disciplined lighting and asset direction
- Mixed-resolution assets can look incoherent if not governed by an art bible

### Direction B: Illustrated Miniature Realism

The environment resembles a hand-painted architectural model. Characters are stylized illustrated people with soft proportions, layered shadows, and smoother animation.

**Strengths**

- More premium and emotionally rich
- Excellent for cafe, forest, and library themes
- Can create beautiful screenshots and product marketing

**Risks**

- Higher asset cost
- Harder to customize rosters consistently
- Greater uncanny-valley risk
- More difficult to maintain across community themes

### Direction C: Graphic Operations World

The environment becomes a sharp, diagrammatic simulation: bold silhouettes, architectural grids, flat materials, limited colors, and data woven into the space.

**Strengths**

- Extremely legible and performant
- Easy to theme through tokens and vector assets
- Strong professional identity

**Risks**

- Less emotionally engaging
- Characters may feel like status icons rather than coworkers

### Recommendation

Use **Precision Diorama** as the foundation. It gives Stark Tower the character presence of Munder Duflin without inheriting its visual limits. Themes can move along a realism slider, but every pack must preserve the same silhouette readability, state language, and interaction points.

## 19. Recommended visual identity

### Application shell

The operational shell should be calm and editorial so the Environment can be expressive. Avoid a permanently glowing sci-fi dashboard. Use deep neutral surfaces, high-contrast type, fine dividers, restrained status color, and dense but breathable information.

Suggested typography direction:

- A precise grotesk or humanist sans for operating text
- A compact technical face for metadata, paths, branches, and commands
- Theme-specific display lettering only inside Environment titles and decorative surfaces

The application shell's information architecture remains stable across themes, but its complete visual skin changes with the selected theme. A theme controls surface hues, accents, typography treatment, divider style, icon treatment, textures, shadows, window chrome, and decorative motion in addition to the Environment. Primary controls remain in predictable locations and task-state meaning does not change. Semantic states use accessible theme-specific equivalents rather than one permanently cyan shell.

### Stark Tower theme: After Hours R&D

The new Stark Tower floor should not look like rows of desks placed on a black canvas. It should feel like a private research tower operating after dark.

Zones:

- **Command deck:** JARVIS's central observation point and office-wide status core
- **Build bays:** active implementation workstations
- **Review gallery:** agents reviewing diffs and verification results
- **Systems lab:** automations, provider health, and diagnostics
- **Quiet pods:** blocked, waiting, or deep-thinking work
- **Launch platform:** tasks ready for review, represented as sealed report capsules rather than celebrations

Materials and atmosphere:

- Graphite, smoked glass, brushed titanium, and warm dark wood
- Cool cyan for active computation
- Amber for human attention
- Muted red only for blocked or dangerous state
- Reflections and bloom used sparingly
- Exterior city parallax and weather to establish time and place
- No generic purple gradients

### Contemporary office theme

This is not a direct Dunder Mifflin recreation. It is a warm, characterful studio office with clear zones, personal desks, pinboards, plants, meeting nooks, and a kitchen. The palette uses parchment, tobacco, oxidized green, faded burgundy, and charcoal. The feeling is lived-in rather than corporate.

### Japanese cafe and forest theme

The environment blends a small kissaten with a garden edge rather than treating Japanese culture as decorative shorthand. It uses dark timber, paper light, rain, ceramic details, moss, stone, and seasonal foliage. Agents work at counters, low tables, window seats, and garden shelters. Status comes through lantern light, table objects, and posture rather than floating neon UI.

Temporary subagents may appear as compact service companions, paper birds, tanuki-like helpers, or small tool spirits depending on the chosen pack. These remain optional and avoid caricature.

## 20. Character system

Named agents need stronger individual recognition than a label above a generic sprite.

The default onboarding path offers a polished library of existing characters. A developer may use a preset unchanged or open Character Studio to customize it. Character Studio exposes controlled choices for skin tone, facial features, hair, body silhouette, personal accent, glasses, signature accessory, and optional companion. It does not require the developer to draw sprites.

The same character definition produces the agent's conversation portrait, roster portrait, full-body floor sprite, and animation frames. Realistic human portraits are not used anywhere in the product.

Each character is composed from controlled layers:

- Body silhouette and proportions
- Skin and facial features
- Hair
- Outfit base
- Role accessory
- Theme adaptation layer
- Personal color accent
- Optional companion anchor

Identity remains recognizable across themes through silhouette, face, personal accent, and one signature accessory. Theme adaptation changes material and clothing context without turning the character into a different person.

Roster packs provide outfits for the existing identities. For example, FRIDAY keeps the same face, hair, silhouette, personal accent, and signature earpiece while changing between an After Hours R&D technical uniform, Studio Office workwear, and Mori Cafe indigo workwear. The developer may apply one roster to the whole team or override the outfit pack for an individual agent.

Core animation set:

- Idle and breathing
- Walking in eight directions
- Sitting and standing
- Thinking
- Typing or operating equipment
- Reading or reviewing
- Pair collaboration
- Presenting a report
- Waiting for approval
- Blocked
- Recovering
- Returning to idle

Animations must communicate state without relying on floating text. Labels appear on hover, selection, or important state changes rather than remaining permanently over every head.

Temporary subagents use a smaller companion rig with working, waiting, returning, and failed states. They never receive full-size desks or roster cards.

## 21. Spatial status language

The environment communicates work through position, light, motion, and props:

- **Queued:** agent preparing at their home station
- **Running:** focused work animation with an active desk light
- **Delegating:** companion departs or a visible task thread connects agents
- **Collaborating:** agents share a table or paired work surface
- **Verifying:** agent moves to the review gallery or activates a scanning surface
- **Waiting for approval:** warm amber lamp and paused posture
- **Blocked:** restrained red boundary marker, never frantic alarm effects
- **Ready for review:** report object moves to the launch platform
- **Failed:** equipment powers down and the notification centre receives the actionable explanation
- **Closed:** agent returns to ordinary ambient behavior

Clicking an agent opens their current task. Clicking a task object opens the task page. Hover reveals a compact human summary, not provider logs.

The world should have ambient life, but agents never wander in ways that imply work they are not doing. Movement is tied to real state transitions or clearly decorative idle behavior.

## 22. Floor composition and crowd control

The floor is organized around semantic zones, not a fixed desk per process. Named agents may have home locations, but they move to collaboration, review, or systems areas as task state changes.

The camera supports pan, zoom, fit-to-active-work, and focus-agent. A compact minimap appears only in sufficiently large environments. Important events can gently guide the camera but never steal control while the developer is inspecting something else.

Crowd controls:

- Only named agents are full-size characters.
- Temporary helpers cluster around the parent as companions.
- Extra companions collapse into `+N`.
- Status labels are contextual, not permanent.
- Inactive agents occupy quieter zones and use reduced animation.
- The scene can filter to one project or task.

## 23. Theme asset contract

Every theme pack should provide a validated manifest containing:

- Theme identifier and version
- Supported environment layouts
- Tile, prop, and background atlases
- Lighting and weather presets
- Navigation mesh and interaction anchors
- Semantic zones
- Character adaptation mappings
- Companion mappings
- Soundscape and sound-event mappings
- Typography and color tokens
- Reduced-motion behavior
- Performance tier and fallback assets
- Optional roster pack

Themes must pass validation before activation. Missing decorative assets may fall back safely. Missing semantic anchors, task-state visuals, or navigation data block activation and explain the problem.

The Environment must remain usable with sound disabled, reduced motion enabled, and low-performance rendering selected.

## 24. Motion, sound, and performance

Motion should reveal state and hierarchy, not create constant noise.

- Reserve large movement for task transitions and delegation.
- Use subtle breathing, screen flicker, rain, foliage, or city movement for ambience.
- Avoid bouncing status badges and looping celebration effects.
- Reduce or stop ambient motion when the app is unfocused.
- Respect macOS Reduce Motion and provide an in-product motion level.
- Keep status distinguishable without animation.

Sound is optional and off or quiet by default. Themes may provide ambient loops and restrained event cues. Approval requests and failures may use system notifications rather than loud in-scene alarms.

Rendering should target a stable 60 fps on the primary development machines. Asset budgets, sprite counts, particle counts, and lighting passes are declared per theme. A fallback mode disables expensive lighting and particles without losing task-state legibility.

## 25. Diagnostics and privacy

Diagnostics remain local-only for the initial product. There is no telemetry.

The Diagnostics screen shows supervisor health, provider availability, active processes, wake assertions, scheduled wake events, database state, workspace locks, and recoverable problems in human language. Technical logs and identifiers are available in an expandable drawer.

The user may generate a redacted diagnostics bundle manually. Before saving, Stark Tower shows exactly what it contains. Prompts, source code, credentials, task conversations, and file contents are excluded by default.

## 26. Test strategy

Every provider adapter must pass a shared contract suite covering installation, authentication, session lifecycle, structured events, approvals, interruption, recovery, subagents, and capability reporting.

A fake provider simulates delays, malformed output, approval requests, crashes, partial writes, and lost sessions so the task engine and UI can be tested deterministically.

End-to-end tests use temporary Git repositories to verify:

- Effective permissions cannot be exceeded
- Subagents cannot expand parent permissions
- File claims and sensitive-file locks work
- Independent writers receive isolated worktrees
- Dirty checkouts are never silently modified
- Supervisor restart reconstructs state correctly
- Automatic closure never performs delivery or cleanup actions
- Theme changes never alter execution state
- Notification actions update the underlying task once
- Wake events are scheduled, reconciled, and cancelled correctly
- The keep-awake assertion is released after completion, cancellation, or approval grace timeout

Visual regression tests cover every task state, theme fallback, roster pack, density tier, and reduced-motion mode.

## 27. Delivery order

The work should be delivered in product slices that each leave Stark Tower usable:

1. Extract the local supervisor and append-only task engine.
2. Establish provider adapter contracts and move Claude Code behind the contract.
3. Build the task-first Work surface, task page, approval cards, and human handoffs.
4. Add permission enforcement and workspace ownership with file claims.
5. Add Codex and OpenCode adapters according to truthful capability levels.
6. Add notifications, recovery, and durable background execution.
7. Add automations, keep-awake behavior, and scheduled wake helper.
8. Build Environment v2 with the theme and character contracts.
9. Ship the new Stark Tower Precision Diorama theme.
10. Add the contemporary office and Japanese cafe/forest themes.

Each slice requires task-engine tests, provider-contract tests where applicable, UI verification, and a recovery check before moving forward.

## 28. Explicit non-goals for the initial product

- Shared organization accounts or a team control plane
- Cross-machine task delegation
- Cloud-hosted prompt or transcript storage
- Provider switching without developer configuration
- Automatic commits, pushes, deploys, or destructive cleanup
- Full photorealistic 3D characters
- Rendering temporary subagents as permanent full-size employees
- Theme-specific changes to task semantics
- Anonymous telemetry

## 29. Product naming note

Starkline is the approved product name shown in the shell (2026-10-05). Stark Tower can remain the personal theme and current project identity. If the product is distributed publicly, the core product and publicly shipped tower theme should use an original name, visual language, and character identity unless the relevant intellectual-property rights are secured. The architecture in this document deliberately keeps the product core neutral so this does not require redesigning the workflow engine.

## 30. Success criteria

The redesign succeeds when:

- A developer can understand all active work and required actions without reading terminals.
- Any task has one accountable owner and one coherent final report.
- Claude Code, Codex, and OpenCode behave consistently where their real capabilities overlap.
- Permission and workspace safety remain enforced even when a model attempts otherwise.
- Closing or crashing the UI does not lose valid work.
- Automated tasks can wake the Mac when explicitly enabled and remain safely bounded.
- The Notification Centre makes cross-project intervention fast.
- The Environment communicates real work at a glance without overcrowding.
- Named agents remain recognizable across themes and roster packs.
- The new Stark Tower floor feels like a premium living diorama rather than a reskinned terminal or copied pixel office.

## 31. Visual acceptance references

The approved mockup set in `docs/mockups/2026-09-16/` is the visual-quality target for implementation, not loose inspiration. Functional behavior in this specification remains authoritative, while the mockups are authoritative for composition, density, atmosphere, character quality, material treatment, theme differentiation, and information hierarchy.

Implementation must not silently replace the detailed pixel characters with realistic portraits, generic avatars, flat placeholders, or low-detail 8-bit sprites. It must not reduce the environments to rows of desks on a plain background or reduce the operational interface to a terminal-first layout.

Generated copy, sample project names, dates, provider capability values, and decorative microtext in the mockups are illustrative. Production copy and provider capability claims must come from the real product state.

Each implemented surface should be captured at the same reference viewport and compared against its approved mockup during visual review. Material deviations in layout, atmosphere, character treatment, or information hierarchy require explicit developer approval. Performance or accessibility constraints must be raised before changing the visual target.
