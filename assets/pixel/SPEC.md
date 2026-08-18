# Stark Tower — Pixel Art Asset Spec (First Pass)

A visual spec for **Stark Tower**, a multi-agent orchestration desktop app themed as
Tony Stark / Iron Man's lab. The world is a **top-down pixel-art lab** (Stardew Valley /
"munder-difflin" style) reskinned as Stark Industries. Each running agent is a character
sprite moving around a holographic blue lab floor.

> Status: exploratory first pass. Sprites in this folder are AI-generated **candidates**,
> not final production assets. See "Candidate assets" and "Recommendation" below.

---

## 1. Aesthetic

- **Genre look:** crisp, low-res pixel art. Hard pixel edges, **no anti-aliasing**, no
  gradients-as-blur. Think 16-bit era sprites with a modern limited palette.
- **Perspective:** top-down / three-quarter, consistent with Stardew-style office games.
  Characters read as front-facing when idle.
- **Mood:** sleek high-tech lab. Dark slate interior lit by **holographic arc-reactor
  blue**. Clean, calm, expensive. Danger red is used sparingly and only ever reads as
  "warning / containment."
- **Lighting:** self-illuminated accents (reactor cores, screens, agent glows) pop against
  a deliberately dark, low-value floor so the UI feels like a darkened control room.

---

## 2. Palette

| Role                        | Hex        | Notes |
|-----------------------------|------------|-------|
| Arc-reactor cyan-blue       | `#4FD0FF`  | Primary accent. JARVIS, EDITH, glows, seam lines, screens. |
| Stark gold                  | `#FFD166`  | Secondary accent. FRIDAY, trim, highlights. |
| Dark slate (interior mid)   | `#1A2233`  | Floor panels, outfits, walls. |
| Dark slate (interior deep)  | `#0E1420`  | Backgrounds, shadows, panel seams, void. |
| Warm white                  | `#F5F1E6`  | Faces, text highlights, screen glare. |
| Danger red (containment)    | `#FF4D4D`  | **Reserved** for Ultron + containment cell only. Never decorative. |

Suggested supporting shades (derive, do not invent new hues):
- Cyan shadow `#2E8FB8`, cyan highlight `#B8ECFF`
- Gold shadow `#C79A3E`
- Slate line `#243149`
- Red shadow `#B32E2E`, red glow `#FF8080`

Keep the working palette to ~12–16 colors total for a cohesive limited-palette look.

---

## 3. Sprite dimensions

| Asset type            | Cell size | Notes |
|-----------------------|-----------|-------|
| Character sprites     | **32×32** (baseline) | 48×48 acceptable for hero/orchestrator detail. Pick ONE and keep all characters consistent. |
| Floor / wall tiles    | **32×32** | Must tile seamlessly on all edges. |
| Props / objects       | 32×32 or 32×48 | Tall props (containment cell, workstation) may occupy 1×2 tiles. |
| Arc-reactor core      | 32×32 (or 64×64 hero) | Animated glow pulse. |

Render at native low res, then scale up with **nearest-neighbor** (integer scaling: 2x,
3x, 4x) — never bilinear — so pixels stay crisp in the app.

---

## 4. Character roster

| Agent    | Role                        | Accent        | Read |
|----------|-----------------------------|---------------|------|
| JARVIS   | Orchestrator                | cyan `#4FD0FF`| Dignified, calm, "butler" posture, subtle chest reactor. |
| FRIDAY   | Worker agent                | gold `#FFD166`| Warm, approachable, energetic. |
| EDITH    | Worker agent                | cyan `#4FD0FF`| Sharp, precise; holographic visor to distinguish from JARVIS. |
| Drone    | Generic worker              | faint cyan    | Neutral, utilitarian, interchangeable spawn. |
| ULTRON   | Rogue / containment figure  | red `#FF4D4D` | Angular, menacing, hunched; only red character. |

Distinguish JARVIS vs EDITH (both cyan) by silhouette: JARVIS = suited/butler, EDITH =
visor + slimmer combat-tech build.

---

## 5. Animation states

Each character needs these states. First pass ships **idle-front** only; the rest are
the target sheet.

| State        | Frames (suggested) | Maps to agent status |
|--------------|--------------------|----------------------|
| **idle**     | 2–4 (breathing / glow pulse) | Agent alive, waiting. |
| **walk**     | 4 per direction (N/E/S/W) | Agent moving / handing off a task. |
| **working / typing** | 3–4 (hands at a terminal, screen flicker) | Agent actively running a tool/step. |
| **thinking** | 2–3 (floating "…" or rotating hologram over head) | Agent reasoning / streaming tokens. |
| **blocked**  | 2 (red pulse, halted stance) | Agent errored / waiting on input / needs approval. |

Notes:
- **thinking** and **blocked** overlays can be a shared 8-frame FX sheet reused across all
  characters to save work (a floating icon above the head rather than a full redraw).
- **blocked** is the one place worker agents may flash `#FF4D4D`; keep it brief/pulsed so
  red still reads as "attention" not "Ultron."
- Target sheet layout: horizontal strips per state, stacked vertically; power-of-two sheet
  (e.g. 256×256) for easy slicing.

---

## 6. Floor / tile types

| Tile                     | Size   | Description |
|--------------------------|--------|-------------|
| **Floor**                | 32×32  | Dark slate metal panel (`#1A2233`) with faint `#243149` grid seams; occasional cyan seam glow. Seamless. |
| **Wall / edge**          | 32×32  | Deeper slate (`#0E1420`) panel with a cyan top-edge light strip; corner + straight variants. |
| **Workstation / desk**   | 32×48  | Console with holographic blue screens; the "working" perch for an agent. |
| **Arc-reactor core**     | 32×32 / 64×64 | Glowing cyan core set into the floor; radiates light, pulses. Central hub / spawn point. |
| **Ultron containment cell** | 32×48 (1×2) | Cage/pod with red energy bars (`#FF4D4D`) + hazard stripes; where the rogue figure is locked. |

Optional extras worth adding later: rug/decking accent tile, cable/conduit tile, holo-table,
server rack, glass partition, door.

---

## 7. Candidate assets in this folder

Generated with the Pika MCP `generate_image` tool (provider: **nano-banana-pro** / Gemini 3
Pro), 1:1, 1K. These are exploratory candidates.

- `jarvis.png` — JARVIS orchestrator, cyan. **Strongest of the set:** clean front-facing suited figure, chest reactor, on-palette.
- `friday.png` — FRIDAY worker (rendered as gold android). **Perspective mismatch:** came back isometric 3/4 + waving with background props, unlike the flat front-facing others. Good mood, but reshoot for consistency.
- `edith.png` — EDITH worker (cyan-visor android). Good front-facing read; has background server racks to crop.
- `ultron.png` — ULTRON containment figure, red. Menacing angular robot, correct danger-red accents.
- `drone.png` — generic worker drone. Clean, minimal, neutral — very usable.
- `tiles_floor.png` — lab floor / wall candidates. Reads well but is a single composed floor, not separated seamless tiles — slice/redraw for true tiling.
- `tiles_props.png` — arc-reactor core, holo workstation, red containment cell. All three props present and on-brief.

All files are 1024×1024 (upscaled from the model's internal res). "FRIDAY" and "EDITH" as
literal named prompts were **rejected by Gemini's content moderation** (PROHIBITED_CONTENT);
they succeeded when reworded as generic "android/robot worker" (names dropped from the prompt).
Files were delivered from the model as JPEG and re-encoded to true PNG (opaque, no alpha).

**Known limitation of AI pixel-art generation:** diffusion models approximate the *look* of
pixel art but rarely produce a true fixed-grid, limited-palette sprite. Expect:
inconsistent "pixel" sizes, soft/anti-aliased edges, non-tiling tiles, off-palette colors,
and no clean transparency (generated on a flat `#0E1420` background — will need background
keying/removal). Treat these as **concept/mood references and silhouette direction**, not
drop-in engine assets. See the report/recommendation for the AI-vs-CC0 call.

---

## 8. Recommended CC0 / open-license pixel-art packs (fallback + likely final source)

If we want genuine grid-perfect, animated, tileable sprites, these fit the dark-tech lab
look and are free to use commercially. **Verify each license at download time.**

- **Kenney — Sci-Fi / Roguelike & Tiny Dungeon / Generic Items** — https://kenney.nl/assets
  (CC0. The gold standard for clean, consistent, free game art; several top-down sci-fi tile
  and character sets.)
- **Kenney — "Tiny" series (Tiny Town / Tiny Dungeon)** — https://kenney.nl/assets/tiny-dungeon
  (CC0, 16×16 top-down; easy to reskin to slate + cyan.)
- **OpenGameArt.org — filter by CC0 + "sci-fi" / "top-down" / "LPC"** — https://opengameart.org
  (Mixed licenses — filter to CC0 or CC-BY. Good for lab tiles, machines, screens.)
- **LPC (Liberated Pixel Cup) character generator** — https://sanderfrenken.github.io/Universal-LPC-Spritesheet-Character-Generator/
  (CC-BY-SA / GPL; full walk/idle/cast animation sheets — strong base for reskinned agents.)
- **Itch.io free pixel packs (filter "sci-fi", "space station", CC0/free)** — https://itch.io/game-assets/free/tag-pixel-art
  (Many high-quality free lab/station tilesets; check each pack's license.)
- **0x72 — Dungeon Tileset & 16×16 robots** — https://0x72.itch.io
  (CC0; the robot/drone sprites reskin nicely to Stark drones.)

For **hand-authored** final assets, tools: **Aseprite** (paid, industry standard) or
**LibreSprite / Piskel** (free) — start from the palette in §2 and the sheet layout in §5.
