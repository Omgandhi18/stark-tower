#!/usr/bin/env python3
"""Every named agent as an animated character in every theme's room.

    python3 scripts/mockup-extract/characters.py generate scripts/mockup-extract/specs/characters.json [room[/figure[/sheet]] ...]
    python3 scripts/mockup-extract/characters.py build    scripts/mockup-extract/specs/characters.json [room[/figure] ...]

`generate` asks Codex (this machine's Codex sign-in) for each sheet that isn't
on disk yet. Codex sees one reference sheet: the character's station cut-out
(how the room paints them, outfit included), their portrait (the face) and,
once it exists, their front sheet (so every sheet draws the same person). The
front sheet is made first; the rest follow from it.

`build` keys each sheet against its green, cuts it into equal cells, scales the
figures to the room's standing height, and packs every frame of a character
into one atlas (<figure>.png) with <figure>.json listing each animation's
frames, anchor (feet centre), speed and, for walks, stride.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

import codex_image
from codex_image import generate_image

ROOT = Path(__file__).resolve().parents[2]
SHEET_SIZE = (1536, 1024)
PARALLEL_GENERATIONS = 3
codex_image.START_GAP_S = 8
PANEL = 512
LABEL_BAND = 56
LABEL_SIZE = 32
PANEL_BACKGROUND = "#8a8f96"
SHEET_BACKGROUND = "#ffffff"
LABEL_INK = "#111111"
# Made first: every other sheet copies the character from it.
LEAD_SHEET = "front"

PROMPT = (
    "Use your image generation tool to create a new {w}x{h} image, using the attached reference sheet. "
    "Draw the character shown in the CHARACTER panel: {face}, wearing {outfit}. Keep their face, skin tone, hair, "
    "glasses (only if they have them) and clothes exactly as the reference panels show them{same}. "
    "Make it a sprite sheet in exactly the pixel-art style of the CHARACTER panel: crisp square pixels, dark outlines, "
    "the same shading and colours, lit as in {lighting}. "
    "Show this one character {n} times in a single row, evenly spaced across the whole width, each a full-body figure "
    "from the top of the head to the shoes, all exactly the same size, with their feet on one shared baseline, seen "
    "from a slightly high angle like the room in the CHARACTER panel. Every figure is {facing}. {walk}"
    "From left to right: {poses}. "
    "Keep clear green space between the figures so nothing touches or overlaps. Fill the whole background with flat "
    "pure green #00FF00: no floor, no shadow, no text, no numbers, no labels, no frame and no other objects apart "
    "from what a pose holds. After generating, copy the generated image file to ./{out} in the current folder."
)
WALK = (
    "These are the {n} frames of one smooth, natural walk cycle, in order, as an animator would draw them: the legs "
    "and arms move a little further in each frame, and the head stays at nearly the same height. "
)
SAME = "; the SAME CHARACTER panel shows this exact person, so match it"


def load_spec(path: str) -> dict:
    return json.loads(Path(path).read_text())


# Raw sheets are kept as high-quality WebP: a sixth of the PNG's size, and the green still keys cleanly.
RAW_QUALITY = 92


def raw_path(room: dict, figure: str, sheet: str) -> Path:
    return ROOT / room["rawDir"] / figure / f"{sheet}.webp"


def cutout_path(room: dict, figure: str) -> Path:
    stem = room["figures"][figure]["station"]
    return ROOT / room["cutouts"] / f"cutout-{stem}.png"


def panel(image: Image.Image, label: str, width: int = PANEL) -> Image.Image:
    """An image scaled to fit its panel (pixel-sharp when enlarged), on grey, under its label."""
    scale = min(width / image.width, PANEL / image.height)
    resample = Image.NEAREST if scale >= 1 else Image.LANCZOS
    fitted = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), resample)
    out = Image.new("RGB", (width, PANEL + LABEL_BAND), SHEET_BACKGROUND)
    out.paste(Image.new("RGB", (width, PANEL), PANEL_BACKGROUND), (0, LABEL_BAND))
    if fitted.mode == "RGBA":
        out.paste(fitted, ((width - fitted.width) // 2, LABEL_BAND + (PANEL - fitted.height) // 2), fitted)
    else:
        out.paste(fitted, ((width - fitted.width) // 2, LABEL_BAND + (PANEL - fitted.height) // 2))
    ImageDraw.Draw(out).text((12, 10), label, fill=LABEL_INK, font=ImageFont.load_default(size=LABEL_SIZE))
    return out


def reference_sheet(room: dict, figure: str, sheet: str) -> Image.Image:
    panels = [panel(Image.open(cutout_path(room, figure)).convert("RGBA"), "CHARACTER")]
    face = ROOT / room["portraits"] / f"{figure}.png"
    if face.exists():
        panels.append(panel(Image.open(face).convert("RGBA"), "FACE"))
    lead = raw_path(room, figure, LEAD_SHEET)
    if sheet != LEAD_SHEET and lead.exists():
        panels.append(panel(Image.open(lead).convert("RGB"), "SAME CHARACTER", width=PANEL * 3 // 2))
    out = Image.new("RGB", (sum(p.width for p in panels), PANEL + LABEL_BAND), SHEET_BACKGROUND)
    x = 0
    for p in panels:
        out.paste(p, (x, 0))
        x += p.width
    return out


def prompt_for(spec: dict, room: dict, figure: str, sheet_id: str) -> str:
    sheet = spec["sheets"][sheet_id]
    poses = [p.replace("{mug}", room["mug"]) for p in sheet["poses"]]
    return PROMPT.format(
        w=SHEET_SIZE[0],
        h=SHEET_SIZE[1],
        face=spec["faces"][figure],
        outfit=room["figures"][figure]["outfit"],
        same=SAME if sheet_id != LEAD_SHEET and raw_path(room, figure, LEAD_SHEET).exists() else "",
        lighting=room["lighting"],
        n=len(poses),
        facing=sheet["facing"],
        walk=WALK.format(n=len(poses)) if sheet.get("walk") else "",
        poses="; ".join(f"{i + 1}) {p}" for i, p in enumerate(poses)),
        out="sheet.png",
    )


def generate_one(spec: dict, room_id: str, figure: str, sheet_id: str) -> str:
    room = spec["rooms"][room_id]
    with tempfile.TemporaryDirectory(prefix=f"characters-{room_id}-{figure}-{sheet_id}-") as tmp:
        work = Path(tmp)
        reference_sheet(room, figure, sheet_id).save(work / "reference.png")
        made, tail = generate_image(work, work / "reference.png", prompt_for(spec, room, figure, sheet_id), "sheet.png")
        if made is None:
            return f"{room_id}/{figure}/{sheet_id}: no image came back ({tail})"
        out = raw_path(room, figure, sheet_id)
        out.parent.mkdir(parents=True, exist_ok=True)
        Image.open(made).convert("RGB").save(out, quality=RAW_QUALITY, method=6)
    return f"{room_id}/{figure}/{sheet_id}: generated"


def selected(spec: dict, only: list[str]) -> list[tuple[str, str, str]]:
    jobs = []
    for room_id, room in spec["rooms"].items():
        for figure in room["figures"]:
            for sheet_id in spec["sheets"]:
                keys = (room_id, f"{room_id}/{figure}", f"{room_id}/{figure}/{sheet_id}", f"*/{figure}", f"*/*/{sheet_id}")
                if only and not any(k in only for k in keys):
                    continue
                jobs.append((room_id, figure, sheet_id))
    return jobs


def generate(spec: dict, only: list[str], force: bool) -> None:
    jobs = [j for j in selected(spec, only) if force or not raw_path(spec["rooms"][j[0]], j[1], j[2]).exists()]
    if not jobs:
        print("Every sheet is already generated.")
        return
    lead = [j for j in jobs if j[2] == LEAD_SHEET]
    rest = [j for j in jobs if j[2] != LEAD_SHEET]
    with ThreadPoolExecutor(max_workers=PARALLEL_GENERATIONS) as pool:
        for batch in (lead, rest):
            for line in pool.map(lambda job: generate_one(spec, *job), batch):
                print(line, flush=True)


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--force"]
    if len(args) < 2 or args[0] not in ("generate", "build"):
        sys.exit(__doc__)
    spec = load_spec(args[1])
    if args[0] == "generate":
        if shutil.which("codex") is None:
            sys.exit("Codex isn't installed.")
        generate(spec, args[2:], "--force" in sys.argv)
    else:
        from character_build import build

        build(spec, args[2:])


if __name__ == "__main__":
    main()
