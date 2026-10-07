# Stark Tower: Exact-Fidelity Implementation Requirements

**Status:** Implementation contract  
**Date:** 2026-09-16  
**Depends on:** `2026-09-16-stark-tower-product-and-experience-design.md`  
**Visual references:** `docs/mockups/2026-09-16/`  
**Implementation status:** Renderer foundation in progress

## 1. Contract

The approved mockups are the minimum visual-quality bar for the redesign. They are not moodboards and they do not authorize a simpler dashboard, a reskinned version of the existing floor, generic avatars, or an environment made from interchangeable low-resolution office tiles.

"Exact" means preserving the mockups' observable qualities:

- Overall composition, hierarchy, density, spacing, and information balance
- Detailed pixel-character style and consistent agent identity
- Material depth, authored lighting, atmosphere, reflections, shadows, and weather
- Theme-wide treatment of the application shell, not only the Environment screen
- Clear operational status without terminal-first presentation
- Task ownership, delegation, subagent visibility, approvals, review, and notifications shown in human language
- Smooth motion, camera behavior, and state transitions appropriate to a premium desktop application

It does not mean embedding the generated mockup PNGs as the product UI, copying their placeholder text, or reproducing accidental generative artifacts. Real data, real provider capabilities, accessible controls, and the validated product behavior remain authoritative.

No material downgrade may be made to meet a deadline or simplify implementation without explicit approval. If performance, accessibility, platform restrictions, or asset cost threatens the target, the issue must be surfaced before the target changes.

## 2. Required rendering approach

### 2.1 Precision Diorama is the production renderer

The Environment must be implemented as a layered, authored 2.5D diorama in PixiJS 8.

It must not be implemented as:

- A single procedural floor texture with code-drawn desks and props
- A generic tile set with palette swaps standing in for distinct themes
- A DOM recreation of the room
- A full 3D world with realistic human models
- One flattened screenshot with invisible hotspots
- A flattened room plate with character images positioned over it
- One-pose character cutouts that only translate or bob while work state changes

The runtime world is an object-level scene graph. Architecture, floors, windows, furniture, chairs, screens, weather, lighting, occluders, navigation anchors, and characters remain independently addressable even when several static objects share a production texture atlas. Texture atlases are an asset-delivery optimization; they are never the scene model.

Every named workstation defines a seat, standing point, screen interaction point, and departure point. A seated agent uses an actual seated pose aligned to the chair and desk. JARVIS is seated at the command deck and FRIDAY is seated at the build bay while operating those stations; neither may appear as a standing sprite placed in front of a chair.

Character motion uses pose-aware rigs or sprite animation families for standing, walking, turning, sitting, typing, thinking, presenting, blocked, and handoff states. Task and provider state selects an animation; it must not be represented only by a floating label or colored ring.

Each theme contains authored environment layers plus structured spatial metadata. PixiJS composites the layers and live entities using WebGL in production. WebGPU may be evaluated later but cannot be required while Pixi marks it as less mature than WebGL.

Required scene layers, back to front:

1. Distant background and parallax exterior
2. Architectural shell and static floor
3. Rear props and wall-mounted displays
4. Rear atmospheric effects
5. Interactive stations and animated props
6. Named agents and temporary companions
7. Foreground occluders
8. Lighting, shadow, reflection, and weather masks
9. World-space state indicators and selection treatment
10. Screen-space navigation, focus, and accessibility overlays

Logical parenting and visual ordering must be separate. Agents remain attached to their task and movement controllers while Pixi render layers place them correctly between authored occluders. Static and dynamic portions of the scene use a small number of deliberate render groups; they are not split into hundreds of groups.

### 2.2 Reference canvas and responsiveness

The principal visual acceptance viewport is **1584 x 993 CSS pixels**, matching the approved images. Production must also pass at:

- 1440 x 900
- 1728 x 1117
- 1920 x 1080
- 2560 x 1440
- macOS Retina scaling at 1x and 2x device pixel ratio

The shell uses responsive constraints rather than scaling one screenshot. At smaller supported widths, secondary rails may collapse into drawers, but primary task actions and the world focal point must remain visible. The desktop minimum supported content area is 1280 x 800. Below it, the app may show an explicit compact-layout notice instead of silently crushing the composition.

### 2.3 Camera and spatial behavior

The Environment requires:

- Smooth pan and cursor-centered zoom
- Fit entire environment
- Fit active work
- Focus selected agent, task, or semantic zone
- A compact minimap when the world exceeds the viewport materially
- Soft camera guidance for a new important event that never overrides active manual inspection
- Persisted camera state per theme
- Keyboard navigation and a non-spatial equivalent for every action

Movement uses authored walkable polygons or a navigation mesh, named destinations, interaction anchors, and short local avoidance. The current hardcoded tile-grid geometry is insufficient for the new angled environments.

### 2.4 Visual performance budgets

The primary target is a stable 60 frames per second on the project's supported Apple Silicon Macs, with no task-state loss at lower frame rates.

Per loaded theme:

- Maximum uncompressed GPU texture budget: 256 MB in full mode
- Maximum steady-state Environment memory contribution: 400 MB
- Initial visible bundle: 80 MB compressed or less
- First meaningful environment render from a warm app launch: under 1.5 seconds
- Theme switch after assets are installed: under 2.5 seconds to interactive
- Normal frame CPU time: under 6 ms at the reference viewport
- Normal frame GPU time: under 10 ms at the reference viewport
- No single texture dimension above the verified target GPU limit; large scenes must be tiled or split by layer
- Ambient particles must be pooled and capped

The scene must pause or sharply reduce ambient work when hidden or unfocused. Expensive passes may be disabled in a user-selected performance mode, but character detail, state readability, interaction anchors, and essential lighting contrast may not disappear.

### 2.5 Hardware floor and dependency policy

Additional dependencies are allowed when they give Stark Tower a smaller, safer, or more maintainable implementation. Avoiding a good library is not a product goal. Every added dependency must nevertheless have one clear responsibility, an acceptable license, active maintenance, a bounded runtime cost, and no authority beyond what its feature requires.

The full-quality reference mode must run well on a **2020 Apple Silicon M1 Mac with 8 GB RAM** at 1440 x 900. A 16 GB Apple Silicon Mac is recommended for running several provider sessions simultaneously, but must not be required merely to render or operate Stark Tower. Higher-end Pro, Max, or Ultra hardware may support more concurrent agents and higher display resolutions; it must not unlock the intended visual quality.

Application budgets exclude the provider CLIs and the developer's own build processes, which Stark Tower must measure and report separately:

- Work screen idle resident memory: 300 MB or less
- Environment resident memory in full-quality mode: 650 MB or less
- Background supervisor with no active task: 80 MB or less
- Idle shell CPU: 2% or less on the baseline machine
- Animated Environment CPU: 15% of one performance core on average
- Cold launch to usable Work screen: under 3 seconds
- Installed application plus all three bundled themes: target under 2 GB
- One optional downloaded theme pack: target under 500 MB

The product must not add Electron, embed a general-purpose game engine, require an always-running local LLM, or require Docker, a local server stack, or an external database to display the UI. Tauri, the system webview, PixiJS, and the Rust supervisor remain the runtime foundation.

Theme packs are loaded on demand. Only the selected environment, active roster atlases, and immediately required UI assets stay resident. Inactive themes are unloaded from Pixi's asset cache. Texture atlases, static-layer caching, render groups, pooled effects, visibility culling, and frozen off-screen animation are mandatory optimizations rather than late cleanup.

Performance mode is an explicit user choice. It may reduce particle density, weather animation rate, reflection refresh, parallax depth, and ambient prop activity. It may not substitute lower-detail characters, remove environment architecture, flatten the themed shell, hide task state, or alter the approved composition. The baseline machine must pass the full-quality visual gate before the low-effects mode is considered complete.

## 3. Theme production contract

### 3.1 Every theme is an authored environment

The initial release requires three independently art-directed themes:

1. After Hours R&D
2. Contemporary Office
3. Japanese Cafe and Forest

These are not color variants. Each needs its own layout, architecture, prop language, lighting, ambient motion, soundscape, companion treatment, roster outfit pack, and complete application-shell skin.

The shell's navigation positions and task semantics remain stable. A theme may change:

- Surface and text palette
- Window chrome and divider treatment
- Background texture and material
- Shadow, glow, highlight, and focus treatment
- Typography pairing within the approved legibility constraints
- Control shapes within shared hit-area constraints
- Decorative motion
- Environment-specific terminology used only as secondary flavor text

Semantic meaning cannot be remapped. Approval, danger, success, running, waiting, and blocked must remain distinguishable across every theme and cannot rely on color alone.

### 3.2 Theme package contents

Every production theme must ship with:

- Versioned manifest and compatibility version
- Authored world dimensions and reference camera
- Background, architecture, prop, occlusion, lighting, reflection, and weather atlases
- Semantic-zone definitions
- Navigation mesh and movement portals
- Named station and interaction anchors
- Agent home anchors
- Collaboration, review, approval, recovery, and report-presentation anchors
- Animated-prop definitions
- Lighting presets for normal, attention, blocked, and reduced-effects modes
- Theme-wide CSS variable tokens for the React shell
- Bitmap or web fonts with redistribution rights
- Icon treatment built on Lucide, not emojis
- Ambient audio and event cues with independent volume controls
- Reduced-motion definitions
- Low-effects assets that preserve hierarchy
- Theme-specific temporary companion pack
- Recommended roster outfit pack
- Thumbnail, preview scene, and theme-change transition art

A validator must reject a theme that is missing semantic anchors, navigation data, accessibility tokens, required state visuals, or compatible asset versions. Decorative omissions may use an explicitly designed fallback; structural omissions may not.

### 3.3 Environment asset inventory per theme

The minimum production inventory per theme is:

- 1 hero environment with source art large enough for the 2560 x 1440 acceptance viewport
- 6 semantic zones with distinct silhouette and lighting
- 25-40 unique static props
- 8-12 animated or stateful props
- 6 task-state presentation moments: start, delegate, collaborate, verify, approval, ready for review
- 3 ambient condition sets where appropriate, such as clear, rain, and late-night
- 3 depth bands of background parallax where the scene exposes an exterior
- Foreground occluders and corresponding interaction-safe masks
- Shadow and light masks for every interactive station
- At least 3 temporary companion designs with four operational states each
- One deliberate loading composition and one failure/fallback composition

Source art must be retained in an editable format, with layer names and export rules. Runtime exports use lossless PNG/WebP where edge treatment requires it, atlas JSON, and compressed texture variants only after visual comparison confirms no visible damage.

## 4. Character production contract

### 4.1 Character style

All people remain detailed pixel characters. No realistic faces, AI portrait photography, 3D humans, flat circular initials, or generic low-detail 8-bit bodies may appear in the operational UI or Environment.

The character system uses a **72 x 112 pixel native body canvas** as the default authoring grid, with overflow allowed for hair, coats, tools, and companions. Sprites render at integer or half-integer scale chosen for the active display so pixel edges remain deliberate. Portraits are produced from the same identity definition at 128 x 128 and 256 x 256 outputs.

The initial named roster requires six complete identities:

- JARVIS
- FRIDAY
- VISION
- EDITH
- KAREN
- VERONICA

Each identity needs a recognizable silhouette, face treatment, hair, personal accent, and signature accessory that survive outfit changes.

### 4.2 Rigs and animation

The exported character contract supports eight directions. Symmetrical directions may be derived by controlled mirroring during authoring, but the manifest still exposes all eight and asymmetric clothing or accessories require corrected frames.

Required animation families:

- Idle and breathing
- Walk
- Sit down and stand up
- Seated work and typing
- Think
- Read and review
- Pair collaboration
- Present report
- Wait for approval
- Blocked
- Recover
- Receive direct steering
- Delegate to a named agent
- Dispatch and receive temporary companions
- Return to idle

Each loop needs enough authored frames to read as intentional rather than as two-frame toggling. Walk cycles require at least eight frames per direction; primary work loops require at least six; transitions require at least four. Timing is state-authored rather than globally uniform.

Character animation communicates status before text. Permanent labels are prohibited. Names and human summaries appear on hover, keyboard focus, selection, or important transitions.

### 4.3 Character Studio

Character Studio is a constrained, production-quality builder, not an unrestricted pixel editor in the first release. It provides compatible choices for:

- Body silhouette and proportions
- Skin tone and facial treatment
- Hair and facial hair
- Glasses and headwear
- Personal accent color
- Signature accessory
- Companion preference
- Outfit pack and individual overrides

Every selectable part must include all required directions, actions, occlusion masks, anchors, and portrait variants. Incompatible combinations must be prevented in the picker rather than allowed to fail on the floor.

Runtime composition may layer parts for preview, but the app should generate and cache a flattened per-agent atlas after confirmation to keep Environment draw calls predictable. The editable character definition remains separate, so changing an outfit regenerates visuals without touching agent identity, provider, memory, role, or personality.

### 4.4 Roster packs

The initial art scope includes three complete outfit packs for all six named agents:

- After Hours R&D technical uniform
- Contemporary Office workwear
- Japanese Cafe and Forest indigo workwear

A roster pack changes clothing and contextual accessories while retaining identity anchors. The user may:

- Keep current appearances during a theme change
- Apply the theme's suggested roster pack
- Browse any installed roster pack
- Override one agent without affecting the rest
- Preview the floor composition before applying

Applying an appearance never changes name, reporting role, provider, model, permissions, memory, or personality.

## 5. Operational interface requirements

### 5.1 Application structure

The monolithic application surface must be replaced with route-level product areas:

- Work
- Task detail
- Environment
- Agents
- Character Studio
- Automations
- Notification Centre
- Settings and Diagnostics

The current fixed floor-and-chat split is not a retained layout. Environment becomes a full-screen alternate view. The terminal becomes an inspectable task drawer.

### 5.2 Work screen

The Work screen must match the approved three-column composition:

- Project and saved-view rail
- Main work canvas with delegation composer, active work, and review-ready work
- Attention rail for approvals, questions, collisions, failures, and blocked tasks

The main surface must answer, without opening a terminal:

- What is running?
- Who owns it?
- Which project, branch, and workspace is involved?
- Who else is contributing?
- What requires the developer?
- What changed?
- What is ready to review?

### 5.3 Task detail

The task screen must provide one coherent conversation with the assigned owner and an expandable execution tree for named collaborators and temporary subagents. It must show:

- Owner, provider, model, project, branch, workspace, elapsed time, and effective permissions
- Plain-language current activity
- Contribution tree and reporting chain
- Claimed files and sensitive-resource locks
- Approvals, direct interventions, decisions, and assumptions
- Combined changed-file review and readable diff
- Verification results and skipped checks
- Active instruction and memory context
- Provider logs and raw terminal only behind technical detail

The developer can directly steer any subagent. The instruction is stored on that node, visible in the task timeline, and automatically summarized to the accountable owner. Direct steering does not silently change ownership.

### 5.4 Human-readable review

No product-critical review may require reading JSON, provider event packets, or raw terminal output. The default handoff has:

- Outcome
- What changed and why
- Agent contribution chain
- Behavior and screens affected
- Verification performed, with pass/fail state
- Skipped checks and uncertainty
- Warnings and unresolved decisions
- Clear actions: Review, Resume, Close, Commit, or other contextually valid operations

Technical evidence remains available in progressive disclosure. The readable summary and technical evidence are linked to the same immutable task events so they cannot drift silently.

### 5.5 Notification Centre

The in-app Notification Centre is a durable, cross-project action inbox with:

- Needs you, Updates, and History views
- Project, agent, type, urgency, and time filters
- Search over human summaries, task titles, and project names
- Grouped evolving notifications with event timelines
- Inline actions where safe
- Confirmation sheets for sensitive actions
- Deep links to the exact task, agent, automation, approval, or verification result
- Synchronized read and handled state with macOS notifications
- Configurable archival and no automatic deletion

macOS notification buttons cannot be assumed for desktop from Tauri's current cross-platform action API. The product must treat native notifications primarily as permission-gated alerts and deep links; all reliable actions live in the in-app centre.

## 6. Runtime architecture required before the UI can be truthful

### 6.1 Standalone local supervisor

The task engine cannot remain owned by the Tauri window process. A bundled Rust supervisor must run independently, communicate over authenticated local IPC, and survive closing or reopening the UI.

Required supervisor modules:

- Task engine and append-only event store
- Agent registry and reporting graph
- Provider session manager
- Permission and approval engine
- Workspace and file-claim manager
- Verification runner
- Automation scheduler
- Notification service
- Power manager
- Recovery coordinator
- Theme/appearance metadata service
- Diagnostics and redacted-support-bundle service

Tauri becomes a client and presentation shell. Bundling the supervisor as a sidecar is supported by Tauri, but lifetime, launch-at-login, upgrades, crash recovery, and IPC authentication must be owned explicitly rather than delegated to the webview.

### 6.2 Provider adapters

The current Claude-specific implementation must be extracted behind a provider contract. Claude Code, Codex, and OpenCode each need a real adapter with tested behavior for:

- Installation and version detection
- Authentication validation
- Session start, resume, interruption, and stop
- Structured event parsing
- Tool and approval requests
- Capability reporting
- Context injection without replacing provider-native instructions
- Native or simulated subagent relationships
- Usage and limit reporting when genuinely available
- Crash and lost-session recovery

Terminal text parsing is presentation assistance, not authority. It cannot determine task completion, permission grants, or successful external actions.

Named agents, including JARVIS, stay bound to their configured provider until the developer changes configuration. A temporary subagent follows its parent's configured policy: same provider/model, same provider/different model, fixed provider/model, or disabled. Cross-provider delegation occurs through an explicit named-agent edge or configured subagent policy and is visible in the execution tree.

### 6.3 Permission enforcement

Prompts are not security controls. The supervisor must classify requested operations and issue narrow capabilities for only the approved action.

Persisted permission scope must support:

- Once
- This task
- This project
- All projects

The approval UI may offer **Always allow** from the task window. Selecting it opens a confirmation that shows the exact rule and asks whether it applies to this project or all projects. A model cannot select, write, edit, or broaden that rule.

Required enforcement boundaries include:

- Assigned project and workspace paths
- Command and executable allowlists
- Network access policy
- Dependency installation
- Git operations
- External messaging and publication
- Destructive filesystem operations
- Credentials and secrets
- Provider and subagent creation limits

Every denial, grant, use, expiry, and revocation is an immutable task event. Children receive the same or a stricter effective policy than their parent.

### 6.4 Workspace manager

Workspace ownership is task-based:

- A new top-level writer uses the current checkout when no other task owns it.
- Agents collaborating on the same task may use that checkout concurrently when file claims do not conflict.
- A separate top-level writer gets an isolated worktree if the checkout is already owned.
- Read-only participants may inspect concurrently.
- Shared-sensitive paths are exclusive.
- Dirty work is never silently stashed, reset, cleaned, switched, or deleted.

The UI must explain every workspace decision in human language and expose current ownership and claims.

### 6.5 Durable data model

SQLite remains authoritative and needs migrations for at least:

- Projects and project policies
- Agents, roles, identities, provider bindings, and subagent policies
- Tasks, task relationships, report owners, and state transitions
- Task events and readable projections
- Provider sessions and capability snapshots
- Workspaces, branches, worktrees, file claims, and locks
- Approvals, permission rules, rule uses, and revocations
- Verification definitions and runs
- Notifications and notification actions
- Automations and automation runs
- Power assertions and scheduled wake events
- Theme, roster, and character selections
- Agent, project, and task memory references
- Recovery checkpoints and diagnostics

The event stream is append-only. Read models may be rebuilt from it. Provider transcripts, terminal data, and diffs are linked by stable IDs and stored with retention controls.

## 7. Background execution, power, and schedules

The product-wide settings require independent toggles for:

- Allow Stark Tower to keep this Mac awake while useful work is active
- Allow Stark Tower to schedule system wake events

Keep-awake uses a named macOS power assertion only while tasks are running, delegating, verifying, or recovering. When every active task waits for approval, the assertion remains for the configured grace period and is then released.

Each automation separately chooses whether it may wake the Mac. Scheduled wake is not achievable through ordinary in-app timers when the machine is asleep. Apple's scheduling API can persist a wake event, but it requires root authority. Therefore the release needs a signed, narrowly scoped privileged helper that can only:

- Schedule one Stark Tower-owned wake event
- List Stark Tower-owned wake events
- Cancel a Stark Tower-owned wake event

It cannot execute arbitrary commands. Installation and revocation require explicit developer consent. The model never receives administrator credentials or direct access to the helper. Pausing or editing an automation reconciles its wake event; disabling the global setting removes all Stark Tower-owned wake events.

The supervisor also needs launch-at-login support so scheduled or background tasks have a process available after wake. Missed runs never execute in an uncontrolled burst; the automation's declared missed-run policy decides whether to run once, skip, or request attention.

## 8. Frontend architecture refactor

The current single `App.tsx`, monolithic `App.css`, procedural `StarkFloor`, and duplicated color tokens cannot support the approved product safely.

Required frontend boundaries:

- Route and shell composition
- Design tokens and theme runtime
- Work and task feature modules
- Agent and appearance feature modules
- Automation and notification feature modules
- Environment renderer package
- Environment simulation and navigation package
- Character runtime and atlas compiler
- Typed supervisor client and event subscriptions
- Shared accessible controls
- Visual test fixtures and fake-provider scenarios

Theme values must use semantic CSS custom properties. Environment assets and shell tokens share a theme manifest but render through their appropriate systems. Task state colors and accessibility constraints are generated and validated; raw theme hex values must not be spread through components.

State management must separate durable supervisor state, cached projections, ephemeral UI state, and 60 fps scene state. React must not re-render the Pixi scene tree for every animation tick.

## 9. Art and design pipeline

The approved PNGs are concept references, not usable production sprite sheets or editable UI sources. Reaching their bar requires an explicit asset-production pipeline.

Required working sources:

- Figma component and screen library for the operational shell
- Editable layered environment source for every theme
- Aseprite or equivalent pixel-source files for identities, outfits, companions, props, and effects
- Export manifests and deterministic atlas build scripts
- Font and audio licenses
- Color, material, lighting, perspective, scale, animation, and edge-treatment art bible

AI image generation may be used for concept exploration and texture ideation. Generated compositions must be manually rebuilt into consistent, licensed, editable production assets. A generated whole-room image cannot serve as the only source because characters must pass behind objects, stations must react to state, lights must change, and hit targets and navigation must remain exact.

The minimum people requirement for this fidelity is:

- One product/UI engineer with strong React and interaction-design ability
- One Rust systems engineer for supervisor, permissions, providers, scheduling, and recovery
- One pixel/technical artist responsible for the character rig and theme assets
- Part-time visual design and QA ownership

One senior engineer can cover both code roles with AI assistance, but the art workload does not disappear. If the project remains solo, a dedicated contracted pixel/technical artist is the highest-leverage addition.

## 10. Verification and acceptance gates

### 10.1 Automated engineering checks

The repository needs:

- TypeScript strict build
- ESLint with no-warning CI gate
- Vitest unit and component tests
- Playwright desktop-flow and screenshot tests
- Rust formatting, Clippy, and test gates
- Provider contract suite using a deterministic fake provider
- Temporary-repository tests for workspace behavior
- SQLite migration and event-replay tests
- Permission-boundary tests
- Supervisor restart and recovery tests
- Power-event reconciliation tests with a mock platform adapter
- Theme-manifest and character-part validators
- Atlas integrity and missing-frame checks

### 10.2 Visual acceptance

Every approved mockup gets a corresponding deterministic fixture and screenshot test at 1584 x 993. Additional responsive captures cover the supported viewport matrix.

Automated pixel comparison is a guard, not final approval. It should flag:

- More than 0.5% changed pixels outside declared dynamic masks
- More than a 2-pixel shift in primary alignment anchors
- Missing or substituted character assets
- Incorrect typography, palette, spacing, or shell density
- Missing lighting, reflection, weather, or material layers
- Text clipping and control overlap

Dynamic regions such as timestamps, rain, particles, and animated characters use frozen clocks, seeded randomness, and fixed animation frames for capture. Each milestone also requires human comparison at full size because a low aggregate pixel difference can still hide a meaningful hierarchy or character-quality regression.

### 10.3 Interaction and accessibility acceptance

The product must pass:

- Full keyboard operation for every non-decorative action
- Visible focus across all themes
- VoiceOver labels for controls, tasks, agents, status, and world interactions
- Text zoom without hidden approvals or truncated primary actions
- Reduced-motion mode with equivalent status communication
- Color-independent state distinctions
- High-contrast verification for every theme token set
- Usable Work and Task views when Environment rendering is disabled

### 10.4 Truthfulness acceptance

No screen may claim:

- An agent is working when the provider session is not running
- A task is complete before configured verification and owner synthesis
- A permission is enforced when it exists only in a prompt
- A provider supports a capability that the adapter cannot verify
- A scheduled wake will occur when the global capability or helper is unavailable
- Work is isolated when two top-level writers share a checkout

## 11. Current implementation gap

| Area | Current Stark Tower | Required implementation |
|---|---|---|
| Product shell | Fixed floor/chat layout in one large app component | Routed Work-first product with themed shell and dedicated operational surfaces |
| Environment | Procedural low-resolution room baked into one texture | Layered authored 2.5D diorama with semantic zones, occlusion, lighting, weather, and camera |
| Characters | 18 x 32 procedural front/back figures | 72 x 112 detailed identities, eight directions, complete state animation, outfit packs, portraits, and Character Studio |
| Theme system | One graphite/cyan palette, partly duplicated | Manifest-driven full-shell and Environment themes with validation and independent roster selection |
| State authority | Tauri window process and mixed in-memory state | Independent local Rust supervisor with authenticated IPC and recovery |
| Providers | Deep Claude-specific path plus best-effort CLI fallback | First-class Claude Code, Codex, and OpenCode adapters with truthful capabilities |
| Tasks | Basic title, assignee, status, and detail | Durable ownership graph, event history, workspace, claims, approvals, verification, review, and recovery |
| Permissions | Blocking allow/deny command prompt | Enforced scoped policy with once/task/project/global grants that models cannot change |
| Workspaces | No complete task ownership and claim engine | Current-checkout reuse, task collaboration, top-level isolation, and sensitive-file locking |
| Background work | Closing the app terminates provider processes | Persistent supervisor, launch-at-login, restart reconciliation, and resumable work |
| Automations | Live-process mission nudges | Durable scheduled task creation, missed-run policy, wake integration, and unattended bounds |
| Notifications | In-view alerts only | Persistent in-app Notification Centre plus native permission-gated alerts and deep links |
| Power | No complete keep-awake/wake subsystem | Global keep-awake and scheduled-wake permissions, grace period, per-automation wake toggle, helper audit |
| Review | Conversation and terminal oriented | Plain-language review with contribution chain, combined changes, verification, warnings, and actions |
| Quality system | Build scripts only | Unit, contract, E2E, visual regression, accessibility, recovery, and performance gates |

This is a product-level reconstruction on top of useful foundations, not a visual reskin.

## 12. Implementation sequence with fidelity gates

Work must scale from one approved vertical slice rather than building all themes with temporary visuals and hoping to replace them later.

### Gate A: production art proof

Build one static After Hours R&D scene fragment, one final-quality JARVIS rig, one temporary companion, and the Work shell token set. Validate perspective, pixel scale, lighting, typography, and runtime texture budgets at the reference viewport. Placeholder art does not pass this gate.

### Gate B: truthful vertical slice

Run one real Claude Code task through the external supervisor and show it in Work, Task detail, Notification Centre, and the After Hours R&D Environment. Include one delegation, one approval, one verification result, one direct subagent steering event, recovery after UI closure, and one human-readable handoff.

### Gate C: provider and safety parity

Add Codex and OpenCode adapters, persistent permissions, workspace ownership, file claims, and fake-provider failure coverage. Each capability shown in UI must be contract-tested.

### Gate D: complete initial R&D product

Finish all six identities, Character Studio, R&D roster, environment zones, responsive shell, automations, keep-awake, scheduled wake, diagnostics, and all acceptance tests.

### Gate E: theme scalability proof

Ship Contemporary Office through the same contracts without branching task logic or duplicating operational components. Theme change and roster selection must work independently.

### Gate F: third-theme release bar

Ship Japanese Cafe and Forest at the same art, animation, performance, accessibility, and workflow quality. Only after three genuinely distinct themes pass can the architecture be considered a complete theme platform.

## 13. Effort reality

At the specified quality, this is not a two-week redesign and not a single frontend sprint.

With two senior engineers, one dedicated pixel/technical artist, and part-time QA/design, a credible range for the complete three-theme product is **four to six months**, assuming provider CLI behavior remains accessible and the signed wake helper does not encounter distribution blockers.

With one senior engineer using AI assistance and a contracted artist, a credible range is **six to ten months**. A solo code-and-art effort will take longer or reduce throughput; it must not reduce the acceptance bar silently.

The largest uncertainty is not React layout. It is the combined surface of provider lifecycle truth, permission enforcement, persistent recovery, macOS privileged wake scheduling, and the amount of final-quality character/environment art. The correct way to control that risk is the vertical-slice gate, not placeholder-heavy parallel construction.

## 14. Definition of done

The exact implementation is complete only when:

- All ten approved reference surfaces exist as functional product screens or states at their accepted quality
- The three themes materially transform the shell and Environment while preserving navigation and semantics
- Six named agents remain unmistakably the same identities across three roster packs
- Custom character selections render correctly in portraits and on the floor
- Real Claude Code, Codex, and OpenCode sessions are represented truthfully
- Reporting ownership and direct subagent steering work as specified
- Permissions are enforced outside model control and persisted at the chosen scope
- Multiple agents collaborate safely inside one task checkout and unrelated writers are isolated
- Closing the UI does not terminate valid work
- Notifications, automations, keep-awake, scheduled wake, recovery, and human-readable review are production-capable
- The screenshot, interaction, accessibility, provider, permission, recovery, and performance gates pass
- Any approved visual deviation is recorded explicitly rather than introduced as an implementation shortcut

Until those conditions are met, the product may be a useful milestone, but it is not the exact implementation represented by the approved mockups.

## 15. Technical references

- [PixiJS v8 Assets](https://pixijs.com/8.x/guides/components/assets)
- [PixiJS v8 Render Layers](https://pixijs.com/8.x/guides/concepts/render-layers)
- [PixiJS v8 Render Groups](https://pixijs.com/8.x/guides/concepts/render-groups)
- [PixiJS v8 Renderers](https://pixijs.com/8.x/guides/components/renderers)
- [Tauri v2 sidecar binaries](https://v2.tauri.app/develop/sidecar/)
- [Tauri v2 autostart API](https://v2.tauri.app/reference/javascript/autostart/)
- [Tauri v2 notifications](https://v2.tauri.app/plugin/notification/)
- [Apple IOPMSchedulePowerEvent](https://developer.apple.com/documentation/iokit/1557076-iopmschedulepowerevent)
- [Apple IOPMAssertionCreateWithName](https://developer.apple.com/documentation/iokit/1557134-iopmassertioncreatewithname)

## 16. Decision log

### 2026-10-05: pixel-identical reference build

The developer requires the implemented screens to be pixel-identical to the approved mockups, not a reconstruction of similar quality. This amends section 9 for the After Hours R&D theme: the approved mockup pixels are themselves the production art.

- `scripts/mockup-extract/` cuts a mockup into plates, sprites and panels (live text cleared, everything matted against what is beneath it) and writes a manifest of every rect and sampled colour. `verify.py` recomposes the layers and diffs them against the mockup.
- Static chrome and scenery are the mockup's own pixels. Live values (status, counts, names, zoom) are real text positioned by measured cap height, so they differ from the mockup only at glyph level.
- Native window controls follow the OS; on macOS the brand shifts right to clear the traffic lights. This, and live text, are the accepted differences from the mockups.
- Anything the mockup has no pixels for (motion frames, areas hidden behind characters or overlays, other window sizes, other themes' versions of a screen) is produced to match and is not claimed to be identical.
- "Starkline" is approved as the product name shown in the shell.

### 2026-10-05: real interface around a pixel-identical room

The developer narrowed the pixel-identical requirement to the environment itself: "Only the environments needs to be this pixel screen not the whole app." This amends the entry above.

- The After Hours R&D room (plate, stations, characters) stays the mockup's own pixels and is still verified by `scripts/mockup-extract/verify.py`.
- Everything around and over it is an ordinary native-feeling interface built from one design system (`src/design`): semantic tokens, one teal accent, state colours that always come with a label and an icon, Lucide icons at one stroke weight, 8 px controls, 12 px cards, full-round pills, and no hand-drawn icons. The shell, the agent card over a character, the camera controls and the conversation panel are now real UI.
- The application is split into route-level areas that stay mounted when you leave them: Work (with Conversation), Environment, Agents, Automations, Notifications and Settings (General, Providers, Power, Diagnostics). Task detail and Character Studio remain to be built.
- Nothing ships demo data. A screen with nothing to show says so and how to fill it. Browser previews say that data loads only inside the app; end-to-end tests run the real UI against a fake backend (`e2e/fakeBackend.ts`) in WebKit at the 1584 x 993 reference viewport.

### 2026-10-05: background mode and automations without a separate supervisor or wake helper

Section 7 asks for a supervisor that keeps agents alive independently of the window, and for scheduled wake through a signed privileged helper. This build takes the smaller honest step and says so in the product.

- **Background mode, not a separate supervisor.** Agent sessions are still hosted by the Starkline process. Closing the window hides it and agents keep working; a menu bar item shows how many are busy; the Dock icon reopens the window; quitting while agents work asks first. Starkline can open at login without a window (`--background`), so scheduled work has a process to run in. On the next start, work that was running when Starkline quit is marked blocked with the reason and can be continued in its own conversation; queued work starts as its agents are free. Diagnostics states this ("They run inside the Starkline app, so quitting it stops them").
- **Automations are real scheduled tasks.** Each has an owner, a project folder, an instruction, a schedule (every day, every weekday, one day a week at a local time, or every 1 to 24 hours), a time limit (5 minutes to 24 hours), a missed-run setting (run once, skip, or ask) and a notify setting (on failure, always, never). The scheduler checks every 30 seconds, after startup recovery. Each run starts an ordinary task for the owner, requested by `automation:<id>`, so it shows on Work, has its own conversation, goes through the same permission gate, and is recorded as a run with its result. A run more than 10 minutes late counts as missed; missed runs never pile up (one decision per missed slot, and a slot is skipped while the previous run is still going). A run past its limit is stopped and recorded as failed.
- **No scheduled wake in this build.** Waking a sleeping Mac needs the signed, narrowly scoped privileged helper from section 7, which is not built. The per-automation wake setting is shown, disabled, with that reason; a run that comes due while the Mac sleeps follows its missed-run setting. Keep Awake (Settings, Power) still prevents idle sleep while agents work.
- The two existing automations stay as built-ins on the same screen: standup check-ins (the orchestrator's live-session nudges) and app maintenance (bugs agents report in Starkline itself).

### 2026-10-05: Codex and OpenCode adapters, and agent configuration

Every provider now goes through the same permission gate, transcript, task engine and team tools. Each adapter translates its provider's events into Claude Code's tool vocabulary (Bash, Edit, Write, Read, TodoWrite, ...), so checks, plans, changed files and the loop guard work the same whichever provider runs.

- **Codex** runs as `codex app-server` (JSON-RPC over stdio). Each agent session is one Codex thread, resumed by id. The approval policy is "untrusted" and each turn runs in Codex's workspace sandbox (writes inside the project, no network unless approved). Codex's command and file-change approval requests are answered by Starkline's gate, which asks the developer when the policy says so. Starkline's bridge is passed as an MCP server per thread, and missing sign-in is caught up front (`account/read`). The sandbox is set per turn rather than per thread because a thread-level `workspace-write` marks the folder trusted in `~/.codex/config.toml`. Verified live against Codex 0.148: a command Codex had to ask about reached the gate, ran once approved, and the answer came back.
- **OpenCode** runs as `opencode acp` (Agent Client Protocol). Starkline sets `OPENCODE_PERMISSION` so OpenCode asks before edits, shell commands, fetches, searches and work outside the project, and the gate answers each `session/request_permission` (never "always": standing permissions are Starkline's rules). Sessions resume with `session/resume`, which doesn't replay history. Messages that start with "/" are kept from being read as OpenCode commands. OpenCode's subagents are turned off, because their actions aren't forwarded over ACP and so can't be seen or approved. Verified live against OpenCode 1.18.18 on one of OpenCode's free models: the permission request reached the gate, the approved command ran, and the turn ended normally.
- Provider health reports each CLI's version and its own sign-in state (`claude auth status`, `codex login status`, `opencode auth list`), asked off the main thread. A provider that isn't signed in says which command to run in Terminal; Starkline never signs in on the developer's behalf.
- Agent configuration (mockup 10) is built from real data. **Provider:** the provider and model, with the provider's own model list. **Temporary helpers:** Claude Code subagents, optionally on a cheaper model, and off where they can't be observed. **Permissions:** what the agent may do in the current project, from the gate's policy and the rules the developer granted. **Comparison:** what each provider supports, from the adapters themselves.
- Not built, because no provider exposes them: per-agent permission overrides (agents can't loosen the policy; rules are scoped to a task, a project or everywhere), and limits on concurrent helpers, helper depth or helper runtime.

### 2026-10-05: a truthful room, and themes before their rooms

- **The After Hours R&D room tells the truth for all six agents.** Everyone on the roster is at their station; an agent turned off leaves it empty. A working or thinking agent's station lights up: its screens glow (a reading lamp, in the glass pod). An agent waiting on the developer has warm amber pooled at its feet. That covers a question, an approval or a review, and outranks working, so the room agrees with the agent's card. The build bay's helper bots appear only while that agent has temporary helpers running in the current turn: up to three bots, then the "+1" badge. The lights are drawn over the plate and never change reference mode, which stays pixel-identical to mockup 04.
- **Themes reskin the whole shell.** Studio Office (parchment, tobacco, oxidized green, with burgundy for the current place and a serif display face) and Mori Cafe (ink indigo, moss green, lantern amber) are complete token sets, including the sidebar and top bar. The theme is saved in the configuration and applied before the first paint. The Theme Studio (Settings) previews a theme across the whole app before applying it. Its previews are crops of the approved mockups 04, 06 and 07.
- **Not built, because it needs new art:** the Studio Office and Mori Cafe rooms (their mockups paint every agent into the scene, so each station needs its character lifted out and the space behind it filled, as was done for R&D), each theme's outfits for the roster, and the Character Studio's part-by-part customisation (skin, hair, outfit, accessories, companion) with its pose previews. Until a theme's room exists, the Environment says so and the team works in After Hours R&D; agents keep one look across themes.
- Claude Code's gate is verified live (2026-10-05, Claude Code 2.1.289, launched exactly as Starkline launches an agent, against a stand-in bridge). A shell command went to Starkline's classifier first. Because the policy said it needs approval, Claude Code then called Starkline's approve tool, and the command ran only when approved; refused, it never ran and the agent reported the refusal. A failed Claude Code turn (an expired sign-in, a turn limit) now says so in the chat with what to do, instead of ending silently. The bridge and the hook run on the Node.js that Diagnostics reports, by absolute path, so they don't depend on the PATH a Finder-launched app gets.

### 2026-10-06: the Studio Office and Mori Cafe rooms, and each theme's outfits

This builds what the entry above lists as not built, except the Character Studio. The developer asked for Codex's image generation to be used (their Codex sign-in), in place of a contracted artist.

- **Both rooms follow the R&D contract.** Each is its mockup (06, 07) cut into a plate, with every station empty, and cut-outs of the mockup's own pixels that put each agent and helper back. `scripts/mockup-extract/rooms.py` asks Codex to paint what each agent or overlay hides. It fits the fill's colours to the mockup and takes only pixels the fill changed inside each target's box. Then it checks that the plate and cut-outs reproduce the room exactly with everyone in place, and that the room equals the mockup everywhere outside the interface it removed.
- **The mockups' painted interface is removed and rebuilt as real UI**: cards, name labels, the clock, the caption, camera controls, and the three status lines on Mori Cafe's "Starkline Today" board. Studio Office has a title bar with the theme's name, description and motto, and docks the agent card bottom-left. Mori Cafe labels each seated agent with a name tag (name, role, state) and docks the card top-right. It also shows the local time and its caption, and writes the real counts on the board: agents running, items waiting on the developer, and blocked agents. Its clock leaves out the mockup's "Rainy", because Starkline has no weather data.
- **One renderer and one view draw every room from data**: stations, lights, helpers, the card's placement, name tags and the board, kept in each room's scene file. Only After Hours R&D has a character who walks (FRIDAY's animation frames), and R&D is unchanged.
- **VERONICA has no station in either mockup**, so Codex paints her into a free seat: the far side of the Studio Office meeting table, and a floor cushion in Mori Cafe's tatami lounge. Those two cut-outs are generated art, not mockup pixels. Reference mode leaves the two seats empty, as the mockups show them.
- **Theme outfits.** Studio Office and Mori Cafe each have a portrait for every figure in that theme's outfits (`scripts/mockup-extract/outfits.py`). Each comes from three references: the agent's own portrait (their face), the mockups' drawings of the outfit, and one of the theme's mockup portraits (the style). Theme Studio's Agent appearance (mockup 05) offers three choices: keep current appearance, use theme outfits (the default), or choose another theme's outfits. The choice is saved with the theme (`outfits` in the configuration), works independently of it (gate E), and is previewed with it. After Hours R&D's outfits are the agents' own look. The rooms always show their own outfits, because they're painted, so the setting changes portraits only.
- Where the mockups disagree about an outfit, the developer chose: Studio Office's JARVIS keeps the tweed jacket from 05 in his portrait (aprons are Mori Cafe's look), while the room keeps the apron 06 paints.
- Still not built: the Character Studio's part-by-part customisation and pose previews.

### 2026-10-06: chats per project, one session per chat, and marking work reviewed

The developer saw "Session started" before every reply and asked that a session last until they start a new chat, with chats kept inside a project, and that a finished task can be marked reviewed.

- **The repeated "Session started" line was misleading.** Claude Code sends its `init` at the start of every turn of one live session (checked: same session id, same process). Starkline now announces only the first `init` of a session.
- **A chat keeps its session until the developer starts a new one.** A request from Work no longer opens a new chat. It goes into the developer's chat with that agent in that project: the one open, if it's in that folder, else the latest there. It's still tracked as its own task card. A chat can therefore hold several tasks, and a task's page shows its own part of the chat, from when it started until the next task there started. Delegations still run in chats of their own and never count as the developer's chat.
- **Chats live under their project.** Selecting a project on Work lists its chats, newest first, with who they're with and when. "New chat" starts a fresh session there with the orchestrator. Opening a chat never interrupts an agent that is mid-task in another one.
- **Mark as reviewed.** A task that's ready for review is marked reviewed from its Work card, its page or its notification. It leaves the board and stays in history as reviewed. "Close task" is kept for setting aside work that isn't ready (cancelling it, or giving up on a blocked task).

### 2026-10-06: one nested sidebar, and the team's voices

- **One sidebar.** The developer asked for "a continuous single nested sidebar instead of two sidebars". The open destination's own places now sit nested under it in the main sidebar, under a guide line, as mockup 06 draws Settings. Work holds All work, each project (the selected one with its chats and New chat) and Add project. Settings holds its sections. The Work and Settings screens lost their second navigation column. The sidebar keeps its width, so the Environment room still sits where its mockup puts it; long names truncate, and hovering shows them whole.
- **Menus draw over the page.** A "more actions" menu is placed from its trigger, inside the window, and over everything else (inside an open dialog it stays in the dialog's layer), so the sidebar or a scrolling card no longer clips it. A row's menu shows while that row is hovered or focused.
- **Chats can be deleted** from their menu in the sidebar or in a conversation's "Earlier with" list, after a confirmation. The messages go for good, and tasks that ran in the chat stay in history without their transcript. The chat an agent is working in can't be deleted until they finish. Deleting the open chat gives way to a fresh one in the same folder.
- **The built-in agents have voices.** Each default personality is now the job, then how the agent talks: the way the character is with Tony Stark. JARVIS is the dryly witty butler who says "sir", FRIDAY the warm, cheeky "boss" type, VISION calm and literal, EDITH eager and precise, KAREN chatty and encouraging, VERONICA the blunt heavy-lifter, DUM-E the eager helper-bot. All of them have a bit of fun and never at the expense of clarity. Configuration v9 gives the voice to agents still on their old default and leaves any personality the developer wrote alone.
- **Tone dials.** Each agent has five dials, each from 0 to 4: humour, sarcasm, formality, enthusiasm and detail (Profile, under the personality). The built-in agents start where their characters are (JARVIS very formal with dry wit, KAREN bursting with enthusiasm and thorough), and custom agents start neutral. The dials become a line of the system prompt that wins where it and the written personality disagree. Every tone keeps the same floor: clear, accurate and kind, and no joke may hide a problem. "Use <name>'s usual tone" puts the dials back.
- **The app no longer starts on endless loading.** Tauri creates a configured window before it runs the app's setup, so the page could ask for its data before the app's state existed; those first requests failed, nothing retried them, and the screens stayed on placeholders until a reload. The window is now created at the end of setup (`create: false`, then `lifecycle::create_main`), and the first loads also retry with backoff. An end-to-end test starts the fake backend late and checks that everything still loads. With the retries switched off, that test fails.

### 2026-10-06: attachments and what agents make

The developer asked to attach files to chats, and to see "output attachments/artifacts/videos, everything that Claude can do", with drag and drop and Markdown included. They chose to keep attachments in Starkline's own folder, to show outputs both automatically and through a share tool, and to run HTML previews live but sandboxed.

- **Attaching.** Files are added with the paperclip (the macOS picker), by pasting (a screenshot, say) or by dropping them from Finder on a message box: any chat, the Environment's side panel or the Work box. Up to 10 go with a message, at up to 200 MB each. Each is copied into the attachments folder in the app's data, so the chat keeps it as it was. A copy whose chip was removed is deleted; one attached to a message that was never sent is swept after a day. Deleting a chat deletes its files. A task started from the Work box keeps its files, so a queued task starts with them. A question waiting for an answer takes words only.
- **How each provider gets them.** Every message names each file's path, so an agent can open it with its own tools. Claude Code also gets images and PDFs inline (image and document blocks over stream-json, verified live), and the attachments folder via `--add-dir`. Codex gets images as `localImage` (verified live) and other files as `mention`s. OpenCode gets images as ACP image blocks and other files as `resource_link`s: OpenCode accepts them, and whether the agent can see an image depends on the model. The permission gate lets agents read the attachments folder freely, and never write to it.
- **What agents make.** When a turn ends, the media and documents the agent wrote or named, and that changed during the turn, are posted as "Made in this turn": images, video, audio, PDFs, web pages, Markdown and office documents, up to 8 a turn. Code isn't included, because it already shows as file changes. Agents also have a `share` tool to post a finished file, with a caption, as "Shared". Either way Starkline keeps a copy. Only files the agent may read without approval (the project, a temporary folder, the attachments folder) can be shown, so sharing can't carry anything past the gate.
- **Previews.** Images open larger. Video and audio play inline (the asset protocol serves byte ranges). PDFs show in a viewer. Markdown is rendered and text shows its first lines. Office documents are cards. Every file can be opened in its own app or shown in Finder. HTML runs in a sandboxed frame without same-origin access and under a content security policy that blocks the network, so its scripts can't reach Starkline, your files or the internet. "Open in browser" shows the full page.

### 2026-10-06: the team comes alive in every room

The developer asked for "full on animations and proper directional for all agents with proper interactions with the environment and other agents", keeping each agent's starting position, direction and current work, and for DUM-E to stop sharing VERONICA's face. Codex's image generation (their sign-in) drew the new art.

- **Every agent, every theme, four directions.** Each of the six figures has a character in each room's own outfits (`scripts/mockup-extract/characters.py`): poses facing toward and away from the viewer (stand, talk, listen, think, coffee, read, wave, present, stretch, get up, folder, reach) and an eight-frame walk each way. Codex draws each sheet from that agent's station cut-out, so the walking agent wears what the room paints them in. The build keys the green, scales every sheet to the room's standing height, adds a breathing frame to resting poses and packs one atlas per character. Left-facing directions mirror the right-facing art, and which way each sheet faces is measured (the face and shoes in a pose, the planted foot sliding back in a walk) and was checked by eye; a sheet measured wrong can be set with `faces` in the spec.
- **At the station, the room's own pixels move.** An agent at their desk is still the mockup's cut-out, animated in place: hands tap keys in bursts while working, the head looks about while thinking, breathes while idle, and holds still (slow breaths) while waiting on the developer. Frame 0 is always the mockup itself.
- **Getting up follows real reasons.** A director (`src/environment/life`) gives each agent a plan: an agent handing work to another walks over to brief them (a new task whose requester is an agent); the one who did it walks back to report when it's done; work the developer asked for is handed in at the room's review spot (R&D's launch pad, the Studio Office meeting table, Mori Cafe's review box). Idle agents take breaks: coffee or tea, the bookshelf, the window, the cat, a stretch, or a chat with another idle colleague at a meeting spot. Thinking agents sometimes pace to a board or screen. Working agents stay heads-down, and an agent waiting on you goes straight back to their desk. Seated colleagues nod along when visited; standing ones turn to talk.
- **Each room says where people can go** (`*-life.json`): walkways, each station's stand-up point, facing and visit point, the head and hand boxes its in-place animation moves, the spots around the room, meeting spots, and furniture redrawn over anyone behind it (occluders). Where a room's art leaves no way through (JARVIS behind the Studio Office desk and the Mori counter, VISION on the Mori terrace, VERONICA's R&D corner, KAREN at the whiteboard, EDITH at the Studio Office racks), the agent's breaks happen at their own station and colleagues check in where they can reach.
- **Reference mode and reduced motion hold the room still**, exactly as the mockup paints it; end-to-end tests run under reduced motion. The room rests while it's off screen. Clicking an agent works wherever they are; Mori Cafe's name tags wait at the station while their agent is away.
- **DUM-E has its own face**: the `helperbot` figure, a yellow workshop robot arm with a camera eye and a paper dunce cap, in its own look and in each theme's outfits (`helperbot.py`). Configuration v10 moves a maintenance agent still on the shared look to it; a look the developer picked stays.
- FRIDAY's earlier side-view walk rig (`walk_rig.py`, `build_characters.py`) is kept as a tool but no longer used by the app.

### 2026-10-06: choosing each agent's model by version, and how hard it thinks

The developer asked for "proper model name with version selection" like Claude Code's model picker, "and effort selection for the agents as well", like its Faster to Smarter effort slider.

- **Models are named by version.** Claude Code has no command that lists models for a subscription sign-in, so Starkline keeps the list (`providers.rs`, newest first; add a model when it ships): Opus 5.5, Fable 5.1, Sonnet 5.5 and Haiku 4.5 up front, and under "More models" Sonnet 5, Opus 5, Fable 5, Opus 4.8, 4.7 and 4.6, Sonnet 4.6, and the bare family names, which always mean that family's newest model. Codex's list comes from its own `model/list`, including each model's description, effort levels and default level. OpenCode's comes from `opencode models --verbose`, newest release first, where a model's reasoning "variants" are its effort levels. With either of those, the first four models are up front and the rest go under "More models".
- **Effort is set per agent** (`effort`, "" = the model's own default) and reaches each provider its own way: `--effort` for Claude Code, the turn's `effort` for Codex, and OpenCode's `effort` session option, which exists only for models with variants. Each model offers only the levels it takes: Haiku 4.5 has none, and Opus 4.6 and Sonnet 4.6 have no Extra high. The level a model runs at by default is marked on the slider. Moving to another model keeps the effort if that model takes it, else the nearest level it does (the lower one on a tie). Moving to a provider of another kind starts the model and effort over.
- **A change takes effect on the next message.** A chat's session records the model and effort it was started with. The next message to an agent that isn't mid-turn restarts the session on the new settings and resumes the conversation, and the chat notes the switch ("Now on Opus 4.6 at max effort.").
- **Where it's chosen:** the agent's Provider tab, which has a searchable model list, the effort slider under it, and the helper model picked from the same list. The composer also has a model chip and an effort chip that save straight away. Typing in the search finds models by name or ID, and anything typed can be used as a model ID of its own (a model the provider hasn't listed yet).

### 2026-10-06: reminders, from the agent you pick

The developer asked for "a task view with reminders so i can set reminders ... and the agent then reminds me by notifying me about it."

- **Where reminders are set.** There are three places:
  - the new **Reminders** screen (⌘5; Notifications moves to ⌘6 and Settings to ⌘7), which says what to remember, when (quick times or a date and time of your own), whether it repeats (every day, every weekday, every week) and which agent reminds you;
  - **Remind me** on a task, where the task's owner reminds you and the reminder links back to the task;
  - asking any agent in chat ("remind me at 5 to check the deploy"), through the agents' new `remind` tool. It takes a local time or minutes from now, and the agent that set the reminder is the one that reminds you.
- **When one comes due,** that agent reminds you in four ways:
  - a needs-you notification under its name, with Done and Snooze (10 minutes, an hour, tomorrow morning);
  - a macOS banner, shown even while Starkline is in front, because a reminder is about the time;
  - a line in that agent's chat;
  - in the room, the agent walking over to hand it in.
- **While you're in Starkline,** the reminder also pops up in the corner from that agent until you deal with it.
- **A reminder about a task** says how the task stands when it goes off ("“Write the release notes” is ready for your review").
- **Repeats and missed times.** A repeating reminder waits for its next time straight away. One that came due while the Mac slept or Starkline was closed goes off at the next launch and says when it was due. Reminders are checked every 10 seconds, apart from automations, so neither waits on the other.

### 2026-10-06: a built-in browser and the iOS Simulator, beside the chat

The developer asked for "an inbuilt browser and an ios simulator like Claude Desktop app does."

- **The preview panel.**
  - It sits beside a conversation and opens from the panel button in the conversation's header. It has two tabs, Browser and Simulator, and you and the agents share both.
  - It opens by itself when an agent opens a page, boots a simulator or launches an app.
  - It can be resized by dragging its edge.
  - On windows narrower than 1440 px, the conversation list gives way to it.
- **The browser** is a real WebKit view inside the window (Tauri's multi-webview, which needs the `unstable` feature), so any site works.
  - The panel has an address bar (an address, `localhost:5173` over http, a bare domain over https, anything else a search), back, forward, reload or stop, and open in your browser.
  - Links that would open a new window open in the panel.
  - It follows the panel as the layout moves, and steps aside while a menu, popover, dialog or reminder pop-up is drawn over it, since a native view always draws on top of the page.
  - Remote pages get no IPC: the app's capability covers its own pages only.
- **What agents can do in the browser** (the `browser` tool):
  - open pages;
  - read them (their text, and their controls numbered for `click` and `type`);
  - click, and type with or without submitting;
  - run JavaScript;
  - read the console (captured from page load, uncaught errors included);
  - take a screenshot, which WebKit draws and hands back as a JPEG;
  - go back, forward or reload.

  Pages on this Mac (`localhost`) are theirs to use. Any other page goes through the permission gate as network access, so the developer's rules for sites apply.
- **The Simulator** uses Xcode's `simctl`.
  - The panel lists the iOS simulators (running ones first, then the newest iOS) and can boot or shut one down, open it in the Simulator app, and show its screen, refreshed a few times a second while the panel shows it.
  - Clicking the screen taps the device, and a text box types on it. Both need idb (Meta's iOS Development Bridge); without it, the panel says how to install it, and the Simulator app takes input instead.
  - Agents get the `simulator` tool: list the devices, boot one, install a built `.app`, launch it by bundle id, open a link, take a screenshot, and tap (in points), type or go home with idb.
  - Without Xcode, the panel says so.
- **Verified here, and not.**
  - The browser view and the simulator need macOS, so the end-to-end tests drive the panels against a stand-in backend.
  - The macOS screenshot code was type-checked and linted against the macOS target. The rest builds and runs its tests on the macOS CI.
  - Address handling, page reading, script safety (every script hands back a JSON string, so a page can't return something WebKit can't serialize), and the simulator's device list have unit tests.

### 2026-10-06: the app's own icon, and reminders beside your work

- **Icon.** Starkline had Tauri's default icon. The new one is a dark night sky with a single futuristic tower: a landing platform near the top, a glowing cyan core, and a low skyline at its foot. Codex drew it from a composition sketch, alongside a glossy and a pixel-art version. This one won because it still reads at 32 px, where the other two thin out into a line. It sits in Apple's icon grid: a 1024 canvas with an 824 px rounded-square body, a soft shadow and a faint rim light. Every size is generated from `src-tauri/icons/source/icon-1024.png` with `npx tauri icon`. The menu-bar tray icon stays the monochrome template. The program itself is now called Starkline (`[[bin]]` in Cargo.toml, with `default-run`), so in dev mode the Dock names it Starkline, as a built app is named by productName.
- **Upcoming reminders on Work's right-hand rail**, below Attention: any that went off (with Done and Snooze), then the next few coming up, with a link to the rest and a + to set one. The attention cards scroll above it, so the reminders stay in view however many cards there are.

### 2026-10-06: the simulator fits its panel, and taps without idb's two installs

- **The whole device fits the panel.** The screen was shown at the screenshot's own size (an iPhone 17 Pro's is 1206 x 2622 pixels), cropped by the panel. It now scales down to whichever of the panel's width and height runs out first.
- **Taps go through AXe first.** AXe is one `brew install cameroncooke/axe/axe` and needs no Python. Starkline uses it when it's installed, and idb when that's what's there.
- **Click to tap, drag to swipe.** Swipes are also new in the agents' `simulator` tool (`swipe` from x, y to to_x, to_y).
- **Screen scale.** The pixels-per-point used to place taps comes from idb's description of the device, else from the width AXe reports in points, else from the screen size (iPads and narrow iPhones are 2x, the rest 3x).
- **When nothing can send taps,** the panel says so as a note: the install command shown as code, a Copy button, and Check again. Before, a red error with raw backticks appeared after the click.

### 2026-10-06: your own terminal, below the conversation

- **A bottom drawer in conversations and tasks.** The Terminal header button and Control + backtick open it. Its top edge drags, or moves with arrow keys, between 120 px and 70% of the column. This window remembers the height and open state. The chat shrinks above it; the browser stays beside it at its own bounds.
- **Your login shell in the folder you're working in.** New tabs use the chat's folder or the task's folder. If that folder isn't available, the shell opens at home and says why. Tabs name the folder and any program title the shell reports. Current-folder tabs come first. A foreground program prompts before its tab closes; an exited shell keeps its output and offers Restart.
- **Sessions last until Starkline quits.** Hiding the drawer, switching chats or routes, and reloading the window leave shells running. A per-terminal IPC channel sends the bytes intact: a keystroke's echo at once, a flood of output once a frame (16 ms). An idle terminal only wakes twice a second, to notice its shell exiting. The backend retains the last 256 KB, with byte positions to reconcile replay and live output. Closing a tab or quitting stops the terminal's process groups, including background jobs in its session. Scrollback is kept in memory, not across app restarts; a program that deliberately detaches into another session is outside this terminal's lifetime.
- **Keyboard, theme and links.** xterm uses the current theme's surface, text, accent and mono font, updates when the theme changes, fits its box and enables screen-reader support. Command + C copies selected text, Command + V pastes and Command + K clears. Escape returns to the active chat composer, or the task's Terminal button when no composer exists. A local web link (localhost) opens in the built-in browser beside the chat; on a task page, and for any other site, links open in the default browser.
- **Agents get no terminal tool.** These shells belong to the developer. Their typed commands have the developer's authority and do not enter the agent permission gate. Agents keep using their existing gated tools.
- **Verified here.** Linux Rust tests exercise a real login shell, its folder, output, resize, foreground jobs, exit and scrollback, channel replay and background-job teardown. Pure frontend tests cover drawer limits, tab names, local links and replay overlap. Chromium drives typing, tab creation, close confirmation, restart, reload reattachment, chat and route switches, saved height and drag resizing beside the preview. TypeScript, ESLint, Vitest, Rust and Clippy are checked, and bindings are regenerated. The existing GNU echo health test is the brief's allowed Linux exception. A real Mac still needs to verify the developer's shell startup, native WebKit placement, clipboard shortcuts and VoiceOver.

### 2026-10-06: seeing what each agent is working from

- **Context, beside the conversation and task.** A Context button opens a side sheet titled "What FRIDAY is working from" (using the agent's current name). The Agents screen also has a Context tab, using that agent's working folder. Every opening and Refresh reads the local sources again. The sheet uses the design system's Dialog, so focus stays inside, Escape closes it, and the native preview steps aside.
- **Four groups, in order.** Starkline and your rules, project instructions, identity and memory, then the task and live state. Each source says its scope, how it reaches this provider, and its character and estimated token counts. Expand one to read it, open its file in its app, or show it in Finder. Empty files say so; missing files are omitted. Text stops at 20 KiB on a character boundary and says how many characters remain. The total excludes ignored and conditional sources; it is not the provider's full context-window usage.
- **The prompt cannot drift from the inspector.** The personality, tone, permission note, app mechanics and durable memory are named sections shared with the actual system-prompt builder. The orchestrator's changing team and project map uses the actual per-message builder. Task pages inspect the selected task, including delegated requests and attachments, rather than silently showing another active task.
- **Provider rules, with their limits visible.** Claude instructions are found through the working folder's parents, including local notes and `.claude/rules`; Codex instructions stop at the repository root and respect override files; OpenCode uses its nearest instruction file and Claude fallback. Home instructions and skill files are included. Skills and path rules are marked conditional. A CLAUDE.md under Codex says "Not read by Codex", and a project without native instructions says which file to add. MCP settings show server names only, keeping credentials and environments out of the inspector.
- **What agents receive.** This adds no agent tool or permission bypass. Claude Code receives Starkline's system prompt when a session starts, and a resumed session keeps its original prompt. Codex receives it as developer instructions. OpenCode's ACP connection has no system prompt, and until now Starkline sent OpenCode agents nothing of it (the inspector showed the gap). Now each launch writes the agent's instructions to a file in Starkline's data folder (`opencode/<agent>.md`) and points OpenCode at it through its inline config (`OPENCODE_CONFIG_CONTENT`'s `instructions`), which OpenCode adds to the developer's own instructions rather than replacing them. Verified live against OpenCode 1.18.34 on one of its free models: with the file, the agent answered from it; without it, it didn't.
- **What the snapshot proves.** It shows current files and what the adapters send, with provider acceptance inferred from default discovery rules. It does not claim a receipt from a running provider. Imports, plugins, native memory, conversation history, custom discovery settings and provider instruction budgets can change the final context. No workspace-line source is invented: this checkout has no `workspaces.rs` integration.
- **Verified here, and on a Mac.** Rust tests cover prompt-section equality, parent and repository discovery, home overrides, ignored files, empty files, conditional rules and skills, MCP credential redaction, task attachments, and Unicode truncation. Vitest covers grouping and size labels. Chromium tests cover both provider labels, the four groups, expansion, opening files, refresh, empty files, and the task and Agents entry points. TypeScript, ESLint, the full Rust suite (apart from the brief's known GNU echo test), clippy and the existing browser suite are checked here. Native file opening, Finder and the preview moving aside still need a real Mac.
- **Sources checked.** The local CLIs reported Claude Code 2.1.291, Codex 0.160.1 and OpenCode 1.18.34. Discovery follows the [Claude Code memory](https://code.claude.com/docs/en/memory) and [skills](https://code.claude.com/docs/en/skills) documentation, [Codex project instructions](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and [skills](https://learn.chatgpt.com/docs/build-skills), and [OpenCode rules](https://opencode.ai/docs/rules/). Newer Codex `.agents/skills` locations are included alongside the spec's `.codex/skills` location.

### 2026-10-06: what the agents spend, and a budget that warns you

- **Spend in Settings** shows today, this Monday-starting week and this month; a thirty-day chart with a screen-reader table; and this month's work by agent, project and model, sorted by cost and then tokens. Agent rows have their portraits, names, turns and reported input and output tokens. Turns without a reported price are counted separately. Before any turns are recorded, the screen explains how to start.
- **A budget the developer sets.** Off by default, or per day, week or month, with a dollar limit and a warning from 50% to 95% (80% to start). Periods follow the Mac's local calendar. Crossing the warning posts an update; using up the limit posts a needs-you notification. Each happens once per period, remembered in SQLite across restarts. Alerts link to Spend; saving the budget acknowledges them without resetting the once-per-period record. Agents keep working. Budget saves report a disk failure instead of claiming it was saved.
- **What is recorded.** Each finished turn, including failed turns that report usage, keeps its time, agent, chat and task, launch folder, provider and model, price when known, provider session and running cost total, and input, output and context tokens. Claude's running total becomes the difference from that session's last persisted reading; a smaller reading means the counter restarted, including `/clear`. OpenCode's running totals use the same persisted baseline when resumed. This stays local; agents get no new tool or authority over the budget.
- **Beside the work.** The top bar shows today's cost after any priced work has been recorded, opens Spend, and takes the budget's warning or danger colour. The chat header reads its saved conversation total and latest context fill, including after relaunch or opening an older chat. Recorded turns announce `spend://changed` so both refresh; the summary also refreshes each minute for a calendar rollover. The former in-memory usage store is gone.
- **Honest limits.** Claude Code's API-price estimate is not a subscription bill. Codex reports tokens and no price. Only work recorded from this feature's first saved turn is included; previous sessions are not backfilled. There are no pricing tables, conversions or hard stops.
- **Verified here.** Rust tests cover persisted session deltas, counter resets, local dates and Monday/month boundaries, warning crossings and restart suppression, and the ledger round trip. Vitest covers formatting and meter/chart arithmetic; Chromium tests use the fake backend to exercise totals, breakdowns, editing, the chip, empty state and chat/event refresh. TypeScript, ESLint and Rust Clippy pass, as do 159 Vitest tests, 141 Rust tests (three live-provider tests ignored) and all 83 Chromium tests, including six for Spend. The brief's existing GNU-echo health test fails on Linux and is excluded from the passing Rust run. The shared Playwright config needed a temporary local module resolver because it otherwise loaded two Playwright installations. The full browser suite passed with one worker after the existing animation test timed out during concurrent builds. Live provider sessions, Mac-local calendar behaviour and native notification banners still need a real Mac.

### 2026-10-06: separate task workspaces and claimed files

- **Each task chooses a place to work.** The first writer uses the current checkout. A second top-level task gets a git worktree under `~/.starkline/worktrees` when another task or busy agent is editing that exact folder. Queued, blocked and ready-for-review tasks don't count as writers. A task keeps the place it already chose; its delegates inherit it. The General setting turns automatic worktrees off.
- **Preparation belongs to the project.** The sidebar's Worktree setup dialog saves ignored paths to carry over (by default `.env*` and `node_modules`) and an optional command in the login shell. macOS uses clone copies; Linux copies files and links `node_modules`. Setup output stays in the task's history, and a failed setup tells the agent and lets the task continue. A failed worktree creation falls back to the checkout with an explanation. New worktrees start from the last commit; local uncommitted changes stay in the checkout.
- **The workspace stays visible.** The task's chip explains the decision and shows its folder, branch, base and commits ahead. Worktree chats stay under their main project with a branch tag, project filters include their tasks, and Works in offers live worktrees. Project permission grants apply there too.
- **Collaborators reserve their files.** Agents have `claim_files` and `release_files`; allowed edits also reserve their file. While a folder is shared, overlapping files or folders are refused without a developer approval, with who holds them and why. Lockfiles, migrations, generated files and shared contracts need an explicit exclusive claim, including a lockfile before a dependency install. Only the task's owner can request git commands that change its repository; those commands still go through the existing permission gate. Claims end with the agent's part, the task or the session. The execution tree shows claims and refused edits; the developer gets an update notification.
- **Codex's limit is explicit.** Codex can edit inside its sandbox without a pre-edit approval. Its reported changes reserve files afterwards; overlaps are recorded and reported, not prevented or undone. Claude Code's hook and the other approval paths enforce reservations before allowing edits, including requests covered by a saved permission grant.
- **Removing a worktree is the developer's action.** Finished, reviewed and closed tasks offer removal and Show in Finder. The confirmation lists uncommitted files and commits absent from both its base and all remote branches; those need Remove anyway. Removal keeps the branch, refuses workspaces still in use, and never stashes, switches branches or cleans up automatically. Startup only marks vanished folders as removed.
- **Verification here.** Temporary git repositories cover workspace choices, branch collisions, copies, setup output and failures, removal and branch retention, persistence and project grant mapping. Claim tests cover overlaps, sensitive paths and generated headers, ownership, dependency commands and release; MCP tests cover claims, release and immediate hook refusal. Browser tests use the stand-in backend for the chip, project grouping, removal confirmations, setup and claimed files. Finder, APFS clone behavior and real provider sessions still need a Mac.


### 2026-10-06: delivering a task, and GitHub and GitLab beside your work

- **Delivery belongs to the developer.** Changes on a task, in the rail and the full file list, now have Commit, push and request actions. The commit dialog starts with every changed file selected, shows line counts, and offers a new `starkline/` branch by default on the repository's default branch. Only selected files enter the commit, including when other files were already staged. Hooks run normally. A failed hook keeps the dialog open with its output under Details; a rejected push asks the developer to pull first. Nothing amends, force-pushes or skips hooks.
- **Discard names the file first.** Each file's menu has a confirmation saying whether the file goes back to its last commit, is deleted, comes back, or returns to its original name. Paths must stay inside the task folder, including through parent symlinks. Untracked directories are shown as individual files; Starkline never recursively deletes a folder.
- **The owner writes the draft.** Commit messages and request descriptions use the owner's own provider, model and effort in a private one-shot session, with no chat messages or bridge tools. The writer has 60 seconds. Typing cancels it, and Write it again starts a fresh draft from the selected files. It receives the task's request, handoff, check evidence, recent commit subjects and at most 40 KB of diff. A failed draft leaves the task title for the developer to edit and says what happened.
- **Both hosts.** Remotes are read from the branch's upstream, then origin, and parsed as SSH or HTTPS, including ports and nested GitLab groups. GitHub Enterprise and self-hosted GitLab use the developer's existing `gh` or `glab` sign-in. Missing CLIs and signed-out accounts say which Terminal command to run. Starkline stores no hosting credentials. Unknown hosts can still commit and push. Creating a pull or merge request asks for a title, description, base branch and Draft; its URL and number stay on the task and open from the header. Text is passed as process arguments or a private temporary body file, never through a shell.
- **Code review in Attention.** A background poll every three minutes, plus a focus refresh limited to once a minute, lists failed head checks, review feedback, new comments and requests waiting for review. Quiet running and passing requests stay out. Open marks the request seen; seen times and failed heads survive restart in the ledger. A failed head posts one update notification. An agent picker starts an ordinary task in the request's project, choosing the task owner first. Agents are asked to fix or review, report back, and push or post nothing. Their existing permission gate still forbids automatic delivery and discard.
- **Verified here.** Rust tests cover remote parsing and detection, CLI JSON fixtures for both hosts, safe request arguments, prompt trimming, selected commits, hooks, every kind of discard and durable review memory. Frontend tests cover ordering and wording. Chromium tests drive both hosting flows through the fake backend, including sign-in instructions, cancelling a late draft and retrying a rejected push without another commit. Typecheck, lint and Clippy pass; 157 frontend tests, 12 MCP tests, 146 Rust tests and all 86 Chromium tests pass. Rust keeps its three existing ignored tests and the known Linux GNU echo exception. Live drafting and request creation need configured providers and signed-in hosting CLIs. Native browser opening and notifications need a real Mac. No dependencies were added.


### 2026-10-06: run the project beside the chat, and check phone and tablet layouts

- **Run in the Browser tab.** Starkline reads `.claude/launch.json`, then the usual package scripts with the project's package manager, then `bin/dev` and Django's `manage.py`. The menu shows each command and remembers the developer's choice and custom command per project. It reads launch.json without changing it. An empty project says how to add a custom command.
- **One server per project.** Run uses the developer's login shell, the project's folder (or launch.json's relative working folder), and a separate process group. The toolbar shows Starting, the ready address, or a crash with its exit code and a way to see the output. Stop sends TERM to the whole group, then KILL after three seconds. Restart reruns that server's last command. Quitting stops every server, including its children.
- **The page and its output.** The first printed local address opens in the shared browser; Vite's Local line takes precedence, and a configured port can become ready without a printed address. Output keeps the last 2,000 lines, strips terminal escapes, follows the end until the developer scrolls up, and has Copy and Clear. Clear hides the current output for this app session; the backend keeps its recent log for agents. The native page shrinks when output opens.
- **What agents can do.** The `dev_server` tool lists servers, starts the project's remembered command or a supplied command, stops or restarts it, reports status, and reads recent output with an optional text filter. Both start and restart pass the actual command, working folder and launch environment through the shell permission gate before creating a process. An agent's start reveals the browser and opens the address when ready. Agent-supplied commands apply to that run; they don't replace the developer's saved choice.
- **Responsive sizes.** Fit panel is the default. Phone (390 × 844), large phone (430 × 932), tablet (820 × 1180) and laptop (1280 × 800) keep their CSS viewport size, centred with a thin outline and a size/zoom label. The native view scales down to fit, and Fit panel restores normal bounds and zoom. Navigation, reading the page and screenshots use the same browser. Server controls and output are separate components so the toolbar can grow in the next preview work.
- **Limits and verification.** Launch working folders are resolved relative to the project, including sibling folders; the gate sees that resolved folder. Aliases of the same project share one server. Output lines and pipe queues are bounded as well as the log. Rust tests cover discovery, package managers, old configuration files, local URLs, output, crashes, port readiness, restarts and real process-group teardown, including a server that ignores TERM. Vitest checks size fitting and overlapping output batches; MCP tests check every action and a denied start. Chromium drives the real UI against the fake backend, including bounds and zoom. Native WebKit scaling, screenshots at those sizes, and login-shell paths from a Finder launch still need a real Mac.

### 2026-10-06: point at a page or simulator screen, and test more of the device

- **Point into the chat.** Both preview tabs have Point at something. A browser pick outlines and names the element, blocks that click from reaching the page, then adds its selector, name, box, key styles and shortened HTML to the message at the caret. Closed code disclosures carry the full page address and title, attributes, computed styles, viewport, pixel ratio and HTML; the chat renders their contents as literal code, fenced with more backticks than the page's text contains so it can't end its block early. Input values are left out. Escape, the button again, leaving the panel or changing chats cancels the picker; its listeners and outline are removed. Repeated picks add to the draft and its attachment chips, then focus the message box. A delayed result cannot land in a different saved chat. As with other file attachments, a waiting question must be answered before pointing or adding a recording to the chat.
- **Pictures and device points.** On macOS, WebKit captures the picked element with 16 CSS pixels around it, clipped to the viewport and scaled with the browser's preview zoom; other platforms add the words without a browser picture. If WebKit can't take the picture, the words still go in. Simulator pointing draws a ring on a copy of the displayed frame instead of tapping. Its text gives the device and point, and the deepest accessibility element there when AXe or idb can describe it. Without those tools, the point and marked picture still work.
- **Simulator controls.** Record a video shows a recording dot and elapsed time, sends SIGINT on Stop and waits for the file before offering Add to chat and Show in Finder. Recordings live in their own folders under attachments. Logs streams while its pane is visible, shown in batches four times a second rather than line by line, with a text filter, Copy and Clear, and stops when hidden. Appearance reads the current light/dark setting (asking simctl at most every 30 seconds while the panel polls) and switches it. The overflow menu sets a preset or custom location, clears it, sends a JSON push to the last app launched through Starkline, and cleans or restores the status bar. Controls that need a booted device say so and are disabled. Recording and log processes have their own process groups and are stopped and reaped when Starkline quits.
- **What agents can do.** The simulator tool adds record_start, record_stop (the saved path, ready to share), logs (up to the last hour, optional predicate and process; only the last 20 KB is kept while reading), appearance, location, push and status_bar. They pass through the permission gate as Starkline's local simulator tool. Every simctl invocation uses separate arguments, and push JSON goes on stdin. Appearance, the last launched bundle and recording/log state are shared between the panel and agents for this app session; simctl runs outside that shared state's lock, so a slow call doesn't hold up the panel or the log stream.
- **Limits and verification.** The browser picker works on elements in the current document; embedded documents and shadow-root contents do not expose an internal selector. Native screenshots, real simulator controls and AXe/idb output need a Mac. Rust tests cover pick parsing and crop clipping at preview zoom, the deepest element in an accessibility tree, simctl arguments, UTF-8 log trimming, keeping the end of long log output past bytes that aren't UTF-8, batching streamed lines, and recording process/state transitions. Vitest covers message text, fences around code that has backticks, caret insertion and keeping picks in their chat. MCP tests cover each added action and its arguments. Chromium tests run the picker script itself and the real panels against the fake backend, including attachments, recording, logs, appearance, location, push validation and the status bar. The snapshot.rs change was type-checked against the Apple-silicon macOS target; it still needs a real Mac to run.


### 2026-10-06: ask an agent or set a reminder from any app

- **Quick capture.** Shift-Command-Space opens a small, reusable window, centred on the screen with the pointer. It floats above other windows, has no title bar, grows with the message and reminder controls up to 420 points, and stays out of the Mac's Window menu and Mission Control. It works while the main window is closed. Pressing the shortcut again, Escape, or clicking away hides it and keeps an unsent draft.
- **Tasks and reminders.** Task is the starting mode. Choose an agent and project or begin with an @mention, using Work's existing routing. Beginning with “remind me” switches to Reminder and removes those two words; Tab in the message switches modes. Reminder offers the same quick times as the Reminders screen (currently 30 minutes, one hour, this evening when still ahead, and tomorrow morning), plus a date and time. A trailing quick-time phrase preselects that time and is left out of the saved reminder. Otherwise an hour is selected. Enter sends; Shift-Enter adds a line.
- **After sending.** A short confirmation stays for 1.2 seconds, then the window hides and clears. A task confirmation has Open, which focuses the main window on that task. Failed submissions keep the text and show the error. The last task agent, project and reminder agent are saved in configuration; missing choices fall back to the orchestrator and active project.
- **Choose the shortcut.** Settings → General has an enabled-by-default toggle, the shortcut, and a recorder. Escape cancels recording; Backspace removes the shortcut, leaving the menu-bar entry available. Changing a shortcut first acquires the replacement, so a combination taken by another app leaves the old one working and says to pick another. Startup registration errors appear in Settings too. Resetting agents and providers keeps these capture settings.
- **What agents can do, and limits.** Captured work goes through the existing task and reminder APIs. Agent actions still use the existing permission gate. There is no new agent tool, credential storage, delivery action or external service. The capture page loads only the roster, projects and configuration; the main shell and preview never mount there. Shortcut registration uses the Rust plugin, with no JavaScript shortcut dependency.
- **Verified here, and on a Mac.** Unit tests cover shortcut validation, old configuration defaults and saved choices, placement across displays with different pixel densities, mode switching, prefix boundaries, time phrases and shortcut recording. Browser tests use the fake backend for task and reminder arguments, mention routing, last-choice fallbacks, custom dates, Enter/Tab/Escape, draft retention, confirmations, opening tasks, errors and shortcut conflicts. Native global hotkeys, focus and blur, monitor placement, Dock behaviour and rounded window appearance need a real Mac.


### 2026-10-06: a personal look for each agent, in every theme

- **Character Studio** opens from an agent's Profile and Theme Studio's agent appearance list. Start with their figure or choose another, then pick skin tone, hair, facial hair, glasses, headwear, an accessory, expression and personal accent, with a short note for details. Unchosen features stay as the figure draws them. Choosing a different base also changes their station when the new look is applied.
- **Drawing uses the developer's Codex sign-in.** Starkline asks the installed Codex CLI to draw three portraits from the base figure's own and themed portraits: After Hours R&D, Studio Office and Mori Cafe. Starts are spaced 20 seconds apart, with at most two running across all Studio jobs. Each theme shows its progress and can be tried again; closing the Studio cancels its work. Without Codex or a sign-in, the choices still open and explain how to install Codex and run `codex login`. Failed drawings keep Codex's last lines behind “What Codex said”.
- **Preview before using it.** All three results appear large and at 20, 40 and 64 pixels. “Use this look” applies the finished set; “Back to choices” discards it. Codex paints over the reference portrait and keeps its framing and backdrop, so Rust gives each drawing its reference's exact size and shape: scaled down (Lanczos) to 64 pixels for the own look and 128 for a theme, with the reference's own transparency (a circle for the own look, a full square for a theme). A round reference is flattened onto its own backdrop colour before Codex sees it, so no light rim appears where the circle is cut out again. (The first version re-framed the head and keyed out the backdrop like the outfit script; on real drawings that cropped too tight and lost the themes' backgrounds.) Originals and choices stay beside the portraits in the app's `looks` folder and are served through its local asset protocol. Removing or replacing a look, removing its last agent, or resetting the roster removes its files.
- **Every agent portrait follows their look**, including cards, chats, notifications, the room's agent card and Theme Studio previews. A missing themed image falls back to their custom own look, then their built-in figure. Existing configuration files load with no custom look; no configuration version change is needed.
- **Rooms stay painted scenes.** The Studio says plainly which base station the agent keeps. Custom floor sprites, new room art and pose previews are outside this build; the After Hours R&D room's pixels are unchanged. Agents receive no new drawing tool or authority. Drawing is a developer action, and Starkline neither signs in for them nor uploads their files itself.
- **Verified on Linux.** Unit tests cover every prompt option, the reference's size and shape for every theme, the backdrop colour of a round reference, stored looks and configuration removal, argument-based Codex invocation, missing-CLI guidance, cancellation and portrait fallback. Chromium tests drive the Studio against the fake backend, including per-theme retry, applying and removing a look, the chat and list portraits, Theme Studio and no-Codex guidance. The ignored integration test ran once with the real signed-in Codex pipeline and left three sample PNGs and 1024-pixel originals in the requested review folder. TypeScript, lint, all 160 Vitest tests, all 82 Chromium tests, Rust tests (apart from the brief's GNU echo exception) and strict Clippy passed. Native macOS asset serving, overlays over WebKit and quitting the app during a drawing still need a real Mac.



### 2026-10-06: the team speaks in natural voices on this Mac

- **Voices stay on this Mac.** Settings → Voices downloads Kokoro once, only when the developer asks, checks its size and SHA-256, and unpacks it into the app's data folder. Progress, Cancel, retry and Remove are available. Voices start off; after the download the developer can turn them on. There is no speech service, account, credential or new agent tool.
- **Each agent sounds different.** The seven built-in agents have their chosen original Kokoro voices, pace and pitch; custom agents start with Heart regardless of their name. The team settings and each agent's Profile offer the 28 English voices in four groups, speed and pitch controls, and Preview. Agent messages have Read aloud and Stop. These choices load safely from older configurations without a version migration. A chat following its newest messages no longer closes a task menu elsewhere; only scrolling the menu's trigger does.
- **Starkline decides when to speak.** Reminders, work ready for review, approvals, questions, reviews and failures (blocked work, automations that couldn't start) speak by default once voices are enabled. An agent's own failed checks don't speak; they're routine while it works, and Mac notifications leave them off by default too. Replies are optional and limited to the first two sentences when their chat isn't being read, including conversations in the room and on a task. The master switch, category switches, background-only setting, local quiet hours and volume apply in the backend even with the window closed. Matching quiet-hour times mean quiet all day. What the developer asks to hear (Preview, Read aloud) plays whenever voices are on; background-only and quiet hours hold back only the automatic lines. Reminders give the time and what was asked for, with no honorific.
- **Speech waits its turn.** One background worker loads one model lazily, releases it after ten quiet minutes or when voices are turned off, and keeps about five waiting lines. New updates replace older waiting ones about the same thing; older routine lines give way first, and reminders are kept. Stop clears the queue and interrupts synthesis and playback. macOS plays through afplay; Linux uses paplay or aplay when available. Quitting kills playback and any download or extraction process.
- **Text and audio are prepared for listening.** Markdown, code blocks, links and paths are simplified, and a small tested table spells out development terms. Pitch resampling compensates Kokoro's speed to keep the chosen pace; DUM-E starts four semitones higher. Loudness targets −18 dBFS RMS with peaks limited to −1 dBFS. WAVs are saved atomically and cached by model, voice, speed, pitch and text, with the oldest files removed above 150.
- **The release changed under the same model name.** The supplied September 2026 archive and its ONNX metadata have 54 speakers: Spanish Santa was appended at ID 53. The 28 English IDs match the documented order exactly. The pinned archive remains 349,906,910 bytes, with SHA-256 `c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298`, checked against the release's published digest. The archive wasn't downloaded again here; the already extracted model was used.
- **Licences.** Kokoro-82M and sherpa-onnx are Apache-2.0. sherpa-onnx's prebuilt libraries include espeak-ng under GPL-3.0 for words missing from the lexicon. This is suitable for the developer's own use; distributing a public build requires replacing that component or complying with the GPL.
- **Verified here.** Rust covers text, loudness and peaks, pitch and tempo maths, cache keys and eviction, queue replacement and overflow, Stop, quiet hours, old configurations and saved choices, download validation, failure, cancellation and restart. The ignored real-model test (`STARKLINE_VOICE_MODEL=<folder> cargo test real_model_samples -- --ignored`) verifies the English speaker metadata and writes four non-silent WAV samples outside the repository (JARVIS 4.56 seconds, FRIDAY 2.91, VISION 3.58, DUM-E 1.57). Vitest covers voice groups and labels, and Chromium drives download progress, cancellation, enabling, settings, both preview locations and chat Read aloud/Stop against the fake backend. Native macOS audio, volume, window focus and the packaged Apple-silicon build still need a real Mac.


### 2026-10-06: reminders and updates reach this Mac

- **Real Mac notifications.** The bundled app uses Apple's UserNotifications framework, asks for permission when notifications are enabled and macOS has not asked yet, and can show a banner, sound and Notification Centre entry while Starkline is in front. Each notification carries its ledger id and groups with its agent: the headline ("FRIDAY needs your approval") over the item's title and details, and for a reminder its text, with how its task stands or that it was due while the Mac was asleep. Clicking one brings Starkline forward and opens that item in its own Notification Centre.
- **The developer chooses what reaches them.** Settings → Notifications shows the system permission, offers its System Settings page when notifications are off or delivered quietly, and can send a test. The master switch and foreground switch start on. Reminders, approvals, questions, reviews, ready or blocked work, pull and merge request failures, missed or failed automations and budget warnings start on; agents' failed checks and refused file claims start off. Rules that already allowed a call and unknown notification kinds never post. Each change saves immediately; old and partial configurations receive the defaults without a version migration. Permission refreshes when the app regains focus.
- **The two centres agree.** Reading an item or settling its review, task, automation or reminder removes its delivered Mac notification. Reviewing the budget removes its notices too. The ledger returns the affected ids, so unrelated items stay. Starkline's own records and history are kept regardless of the switches. The test ignores those switches. If macOS hasn't asked yet, it asks first, since macOS drops anything posted before permission; if permission is off, it says how to turn it on.
- **Agents keep their existing tools and authority.** Their reminders and existing work events can reach the Mac according to these settings; they get no new permission, delivery action or notification-settings tool. Everything stays on the developer's machine.
- **Limits.** Outside a bundled Mac app, including `tauri dev`, the existing notification plugin remains the fallback and the settings explain that the system controls delivery. That fallback cannot route clicks or remove delivered notices. Permission reads wait at most five seconds; requesting permission waits up to two minutes on a worker while the developer answers. If macOS does not answer, the UI reports system-controlled delivery rather than claiming permission was granted.
- **Verified here, and on a Mac.** Rust tests cover every notification kind across all toggle combinations and both focus states, old and partial settings, returned ledger ids, and headline, subtitle and reminder body selection. Frontend and Chromium tests cover permission wording and actions, category saves, disabled switches, test success and denied permission, and opening and reading a notification from a backend click event. The native module was type-checked against the Apple-silicon macOS target (`aarch64-apple-darwin`) with Clippy warnings denied. The permission prompt, banners while in front, native clicks, removal from macOS Notification Centre, and the bundled app versus `tauri dev` still need a real Mac.


### 2026-10-06: auto mode, and Always allow from a task's approval cards

- **Auto mode belongs to a conversation.** A task works in its owner's conversation, so the task's Attention tab, the message box under that conversation and the task header all show and change the same setting. It's stored on the conversation (`conversations.auto_mode`, added empty to older databases), so it survives a restart and applies to later tasks that continue in the same chat. The message box shows "Ask first" or "Auto mode"; the header's Permissions field says the same.
- **It lets through what would ask, never what never runs on its own.** In auto mode the gate's approval tier (installs, branches, files outside the project, the network, migrations, credentials, reachable services, unrecognised commands, this Mac's settings) goes ahead without a card. The never tier still asks: committing, pushing or publishing, deleting branches or worktrees, discarding changes, acting on other machines or services, destructive commands and changes to Starkline's safeguards. The decision is made in `bridge::decide`, after the developer's own rules and before a card would open, so Claude Code, Codex and OpenCode behave alike. File claims still apply.
- **Delegated work follows the work it came from.** A delegation copies the auto mode of the conversation it was delegated from when it starts, and turning auto mode on or off for a task's conversation changes every task delegated from it, at any depth. Each conversation's switch shows its own state.
- **Turning it on settles what's waiting.** Approval-tier requests already waiting in the conversations it reached go ahead, recorded as "Allowed by auto mode". Questions, plans and reviews still wait for the developer.
- **It stays on the record.** Each request auto mode lets through is written to the agent's ledger, to the task's history ("You allowed: … (auto mode)") and to the Notification Centre's history as "Allowed by auto mode", the same way a rule's use is. These entries never post a Mac notification. Agents get no way to read or change auto mode.
- **Always allow from the task panel.** A permission card in a task's Attention tab, and anywhere else the compact card appears, now offers Always allow… next to Deny and Allow once when a rule can cover the request. Its dialog adds "Only for this task" to "Only in <project>" and "In every project" when the request belongs to a task; the rule is still built from the request itself, and the stronger confirmation for actions that never run on their own is unchanged.
- **Agents keep their own notes without asking.** Each agent's memory file lives in Starkline's data folder, which the gate protects. An agent's file tools may now read and change its own memory file. Other agents' files, the rest of the folder, shell writes there and a memory file replaced by a link still count as changing Starkline's safeguards.
- **Verified here.** Rust tests cover storing auto mode, the delegation tree it reaches, which commands and edits it lets through or still asks about, reading the developer's decisions, and the memory-file exception. Chromium tests drive the task switch (including a waiting request in delegated work going ahead), the message-box chip and the matching header, and Always allow for a task from the card. TypeScript, all Vitest tests and all Chromium tests passed. Real agents running in auto mode still need a run on a real Mac.


### 2026-10-07: Work's request box at the bottom, a terminal beside a task, and memory out of the chat

- **The request box sits under Work's board**, like a chat's message box. The board fills the screen and scrolls above it; the agent list and attached files open above the box, and "has started · Open task" shows under it. ⌘K still focuses it.
- **A task's side panel can hold the terminal.** It gets a Terminal tab (an icon, to fit beside Attention, Changes and Checks). A shell is drawn in one place at a time, so the terminal moves between the bottom drawer and the side panel rather than appearing in both; the same shells keep running. Picking another tab hides it, the header's Terminal button shows it again where it was, and the panel widens while the terminal is in it. Chats have no side panel, so there it stays at the bottom. Where it sits is remembered with the drawer's height. The panel's tabs sit closer together and scroll on their own in a narrow window rather than widening the page.
- **The message box no longer says "Enter to send, Shift+Enter for a new line"**; it was being cut off.
- **An agent's memory isn't something it made for you.** Since agents may update their own memory file without asking, each update was showing in the chat as a file it made. Files in Starkline's memory folder now never appear in a turn's "Made in this turn". Chats saved before that still held those cards, so the transcript also leaves out a "made" file named after the agent itself (`jarvis.md` from JARVIS); a turn's card goes when that was all it held, and a memory file the agent shared on purpose still shows. Instead, chat and task headers have a small Memory button beside Context that shows the agent's notes, with a dot when it has changed them since you last looked.


### 2026-10-07: review only what changed, and a project's chats open as their task

- **Only work that changed something waits for review.** When an agent's turn ends, Starkline asks whether that round of work changed the project. It counts:
  - files the agent wrote or edited in the task's folder (not its own memory, not files elsewhere, such as `/tmp`);
  - a different commit, status or uncommitted diff in the folder, measured by git before and after, which catches edits made by commands, merges and commits;
  - work it delegated that changed something.

  If so, the task is "Ready for review" as before, with its notification. If not, it's **idle**: finished, nothing to review, no notification, and off the board. A round that follows changes still waiting for review stays ready for review. If Starkline can't tell (it restarted mid-round), it asks for review, the safe side. A delegation that changed nothing ends idle too, so its parent isn't held for review on its account.
- **Answered work has its own place on the board.** Work that was asked for and finished with nothing to review shows under **Answered**, below Ready for review and Blocked, newest first, with the start of the answer. It needs nothing from you: each stays a day, then lives on in its chat. Its menu can close it sooner. A chat that was opened and never asked anything doesn't show, and blocked work delegated from something answered long ago still does.
- **What you ask in a chat is a task.** A message in a chat with no open work starts a task there, in the chat's own folder (it doesn't move to a new worktree). So every chat has a task page, delegations from a chat are tied to it, and its approvals and auto mode belong to it. Follow-ups continue idle or blocked work. After work has been reviewed or closed, the next request starts a new task in the same chat.
- **A project's chats open as their task.** Under each project in the sidebar, a chat opens on the task page: header with status, permissions and auto mode; who's working; Conversation, Plan, Files and Activity; and the Attention, Changes, Checks and Terminal panel, where blocked work can be continued or closed. A chat with no task yet gets an idle one when it's opened. New chat opens straight onto its page. When a chat moves on to newer work (more asked after a review, or a new request from Work), a page showing its finished task follows. The chat stays the agent's current one when they're free; if they're busy elsewhere, the page shows it until it's picked back up. The Agents screen keeps its plain chat.

### 2026-10-07: one screen for every chat, with the browser and simulator beside it

- **Every chat opens on the task page.** "Talk to" an agent (Work's Team list, Agents, the Environment, a notification) opens the chat they talk in now, as its task: the same page a project's chats open on. The separate chat screen is gone. An agent who has never talked gets a chat in the open project.
- **The browser and the iOS Simulator are tabs in the side panel**, as icons after Terminal, beside Attention, Changes and Checks. While one shows, the panel takes the width you last gave it (drag its left edge, or use the arrow keys on it), and the chat keeps at least 400 pixels; on a window up to 1440 pixels wide, the left column gives way. An agent opening a page or booting a simulator switches the panel to it, and a local link in a terminal opens there. One tool shows at a time: whichever of the terminal, browser and simulator opened last takes the panel, and the others keep running. Pointing at a page or a simulator screen adds to the chat on the page while it's the one its owner talks in.
- **The chat's own controls are on the task header:** where the chat works ("Works in"), New chat, and what the chat has cost ("Chat cost", with its latest context fill). New chat starts a fresh chat with the owner in the task's project and opens it; while the owner works it says to wait, because starting one ends their session. "Talk to …" shows only on an older or delegated chat, and goes to the one they talk in now.
- **The left column keeps the earlier chats.** Under Execution, "Earlier with …" lists the owner's chats in every project, newest first (five, then Show all), marks the one on the page, and opens any of them here, as its task. Each can be deleted from its menu.
- **Six tabs fit the side panel.** It's 372 pixels wide (340 on a window up to 1360), and the tools keep to the end of the row; on a small window the status tabs' labels shorten first, so the tools never hide.
- **Verified here.** Unit tests cover which tab the panel shows and how wide it may be dragged. The WebKit end-to-end tests that drove the chat screen now drive the task page (talking, pointing, the dev server, the simulator, the terminal, spend and the studio), with new ones for New chat waiting while the agent works and for a link from the side-panel terminal opening the browser in its place.

### 2026-10-07: claim notes written for you, and a delegated task leads back

- **What an agent is told isn't what you read.** When an agent is stopped in a folder it shares, it still gets its instruction ("bun.lock needs an exclusive claim… Call claim_files…", "Only FRIDAY… runs git here"). The task's history now says what happened instead: "KAREN was asked to claim bun.lock before changing it, as other agents work in this folder", "KAREN wanted to change src/types.ts, which VISION has claimed (Shared types)", or, when a provider's sandbox already made the edit, "KAREN changed src/types.ts while VISION had claimed it".
- **Routine steps stay in the activity.** Claiming a shared file first and leaving git to the owner are steps the agent takes itself: they're recorded as `claim_needed`, and no longer notify you or show in the execution tree. A clash with another agent's claim is still `claim_refused`, with its notification.
- **The tree shows a clash while it matters**, under the agent it happened to, lined up with their name: from when it happens until their part of the work is over (idle, reviewed or closed), so a reviewer still sees it. Events saved before this change that carry an agent's instruction count as routine.
- **A delegated task leads back.** Its execution tree starts with the task it came from (tagged "Asked by", as in its header), which opens from there. The task's details carry it as `parent`, so the way back works for older work too.
- **Verified here.** Rust tests cover each refusal's two wordings and which are conflicts; unit tests cover when a clash shows; WebKit tests go from a task to a delegated one and back, and check that a clash shows in the tree while routine steps stay in the activity.

### 2026-10-07: one entry per agent in the execution tree, and stopping a task

- **Each agent shows once.** An agent asked for several parts of a task appears once in its execution tree, with each of those tasks listed under them (a dot in its state's colour, then its title; the state is in its name). Their line counts the tasks by state, most pressing first ("1 waiting on you · 1 ready for review"). With one task, they show as before and open it directly. Files, claims and clashes were already counted per agent, so they no longer repeat; a clash shows only for their tasks that aren't over.
- **On one of those tasks, the rest are still there.** A delegated task's owner lists every task they were given from the same parent, this one marked, so you can move between them without going back up. Task details carry them as `siblings`.
- **Stop, in the task header,** while anything in the task runs. It stops the task and everything still running beneath it: the owner's chat session if it's on the task, and the one-shot workers doing the work it delegated, which were out of reach before (Stop ended only the owner's session, and a delegated task couldn't be stopped at all). Each part that stops is blocked with "You stopped the task before it finished", which is also what the agent that delegated it hears. Workers are now tracked by task, alongside the list app-quit uses.
- **Verified here.** Rust tests cover how each running part is stopped, and that stopping old work leaves an agent who has moved on alone. Unit tests cover grouping and the state line. WebKit tests stop a delegated part on its own and then a whole task with the work it delegated, and list an agent's tasks under them from both sides.

### 2026-10-07: side panels collapse to rails that still work

The developer asked for "the side panels - all of them including the sidebar" to be collapsible, "but still interactive. so I don't have to expand it to do something."

- **Three panels collapse to a 56-pixel rail of icons:** the sidebar (button at its foot, ⌘B), a task's left column (button beside Execution, ⇧⌘B) and its side panel (Side panel toggle in the task header, beside Terminal, ⌥⌘B; on the panel itself it would have cost the tabs their labels). Each choice is remembered on this Mac.
- **A rail still does the panel's jobs.** The sidebar's rail is the sidebar itself with the names hidden: every destination, project and chat keeps its icon or portrait in the same row, and Notifications keeps its count. The left column's rail shows everyone on the task as a portrait (the owner marked; anyone with one task of their own opens it), then the owner's earlier chats. The side panel's rail shows Attention, Changes and Checks with their counts (Checks in red with the number failing), then Terminal, Browser and Simulator.
- **Resting on a rail brings the whole panel out over the screen**, without moving anything under it, after a quarter of a second, so passing over it on the way elsewhere doesn't. It goes away once the pointer has gone for a moment, unless a menu or dialog opened from it is still up. Clicking a status icon brings the panel out on that tab; from the keyboard, focus moves into it and Escape puts it away. Right after you collapse a panel, it stays put until the pointer comes back to it. In the panel that has come out, the collapse button reads "Keep … open".
- **A tool needs room.** The terminal, browser and simulator open only in a full side panel: opening one (on the rail, from the header, or by an agent) brings a collapsed panel back, and collapsing the panel puts its tool away, since the browser and simulator are native views that don't hide with the page. Beside the browser or simulator on a window up to 1440 pixels wide, the left column now keeps to its rail (still peeking) instead of disappearing.
- **The Environment room** takes the width the sidebar gives up; at the mockups' window size with the sidebar open it sits where it did.
- **Verified here.** Unit tests cover which panel each shortcut collapses. WebKit tests collapse each panel, use its rail (a destination, the owner's portrait, a failed check), bring it out on hover and put it away, open the browser from a collapsed panel, and reload with the sidebar still collapsed.

### 2026-10-07: the execution tree drawn as a tree

The developer asked for the execution tree to be "better in UI too". It now follows mockup 02's tree.

- **A trunk and branches.** Who asked (on a delegated task) and the owner sit on the trunk with 40-pixel portraits; the owner's teammates and temporary helpers hang off it on branches, indented, with 32-pixel portraits. A line runs from under each trunk portrait down to the last branch, and where each branch leaves it a dot shows, in the colour of how their part is going.
- **The task on the page** is the owner's card, marked with the accent tint and an accent bar down its left edge. On a branch the "Delegated" tag is left out (being on a branch says so, and the name needs the room); screen readers still hear it.
- **Quieter text.** A person's line is in the secondary colour, as in the mockup, except when it needs you or went wrong (then in that colour). Files changed show with a file icon, and not at all at zero. Someone's tasks keep their state dots and may take two lines before shortening. Claimed files fold behind a chevron when there are more than three.
- **Opening someone's task.** Their portrait and text are one button; their list of tasks, claimed files and a clash stay separate under it.
- **Verified here.** The WebKit task tests (following a delegation and back, a clash under the agent, an agent's tasks listed once, stopping a delegated part) pass against the new tree, in both the After Hours and Office themes by eye.

### 2026-10-07: an agent works in several chats at once

The developer found that an agent couldn't work in two chats at once ("It gives an error like Jarvis already working in a chat") and asked for it.

- **One session per chat, not per agent.** Each of an agent's chats keeps its own provider session, by conversation: writing in one never ends another's. New chat, opening an earlier chat and deleting an idle chat no longer stop anything. "Talk to" still goes to the chat the agent is open in, which is now just where it last worked (a task starting, or a chat opened).
- **Work never waits its turn.** Handing work to a busy agent (from Work, a quick capture or an automation) starts it at once: in the agent's chat in that project, or in a new chat beside it while that one is busy. A second chat of the same agent in the same project counts as another writer there, so it gets its own worktree, as a second agent would. Work still waiting from before this change starts at launch.
- **Everything a session does is kept per chat:** the task it's on, its folder (for the permission gate, claims, dev servers and shared files), what its turn made, the loop guard, and delegation results, which go back into the orchestrator chat that delegated them. The bridge and gate scripts say which chat they're in (`STARK_CONVERSATION_ID`), so an approval, question or delegation lands in that chat and is judged in its folder.
- **An agent's status is the busiest of its chats** (waiting on you, then working, then thinking, then idle); each chat's own state is reported as `chat://status`, so a chat shows "working" only while it is. A chat that's waiting on you reads as your turn.
- **At most four live sessions per agent.** Past that, the one idle longest stops; it resumes where it was the next time you write there.
- **Stop stops one chat.** Stopping a task ends only its chat's session; stopping an agent (turning it off or removing it) ends all of them.
- **Verified here.** Rust tests cover an agent's status across its chats, the per-chat keys, which session makes way, and stopping one chat while another runs. Script tests cover the chat id reaching the app. Unit tests cover each chat's thread and status. WebKit tests start a new chat while the agent works in another, send into the chat it was written in, and hand work to a busy agent, who starts it in a new chat.

### 2026-10-07: decisions in the chat, as in Notifications

The developer asked for the Notification Centre's decision view "integrated into the chat", and for it to stay in Notifications too.

- **What an agent waits on you for shows at the end of the chat it came from**, in full: the kind and when, the title, everything the agent wrote, and the same decision bar as in Notifications (a note and the options; Deny, Allow once, Allow for this task and Always allow… for an approval; a plan's or mockup's choices). A question with no options says to reply below, where the message box answers it. The pinned question card above the message box is gone.
- **It stays in Notifications and the task's Attention tab**, and deciding in any of them settles all three. A request from one chat shows only there (one from an older bridge script, which didn't say, shows in each of that agent's chats).
- **Verified here.** WebKit tests decide JARVIS's "which backend?" choice with a note from his chat and see it leave Notifications, keep it out of FRIDAY's chat, and deny an approval from the chat.
