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
