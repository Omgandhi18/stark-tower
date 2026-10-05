#!/usr/bin/env python3
"""Each theme's outfits: the six figures as portraits, dressed for that theme.

    python3 scripts/mockup-extract/outfits.py generate scripts/mockup-extract/specs/outfits.json [theme[/figure] ...]
    python3 scripts/mockup-extract/outfits.py build    scripts/mockup-extract/specs/outfits.json

`generate` asks Codex for each portrait that isn't on disk yet. Codex sees one
reference sheet: the agent's own portrait (their face), the outfit as the
mockups draw it, and one of the theme's mockup portraits (the style). `build`
sizes the portraits for the app and writes a contact sheet for review.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from codex_image import generate_image

GENERATION_SIZE = 1024
# Twice the largest portrait the app draws (64 px), for Retina screens.
PORTRAIT_SIZE = 128
PARALLEL_GENERATIONS = 2
PANEL = 512
LABEL_BAND = 56
LABEL_SIZE = 32
SHEET_BACKGROUND = "#ffffff"
LABEL_INK = "#111111"
# Framing like the agents' own portraits: a square this share of the picture, starting a
# little above the hair, centred on the head.
FRAME_SHARE = 0.72
HEAD_ROOM = 0.03
HEAD_DEPTH = 0.4
# How far a pixel may be from the backdrop (sampled in the corners) and still be backdrop.
BACKDROP_TOLERANCE = 40
CORNER = 16

PROMPT = (
    "Use your image generation tool to create a new {size}x{size} image, using the attached reference sheet. "
    "The sheet has labelled panels. Paint a pixel-art portrait of one character, head and shoulders, facing the "
    "viewer and turned slightly, in exactly the style of the STYLE panel: the same pixel-art rendering, outlines, "
    "shading and level of detail. The character is {face}; the FACE panel shows them, so keep their face, skin "
    "tone and hair, and give them glasses only if this description says so. They wear {outfit}, as the OUTFIT "
    "panels show it. Fill the whole background with the "
    "flat colour {background}. No frame, no border, no text and nobody else. Centre the head in the upper half; "
    "the shoulders reach the bottom edge. After generating, copy the generated image file to ./{out} in the "
    "current folder."
)


def root() -> Path:
    return Path(__file__).resolve().parents[2]


def raw_path(outfits: dict, figure: str) -> Path:
    return root() / outfits["rawDir"] / f"{figure}.png"


def panel(image: Image.Image, label: str) -> Image.Image:
    """An image scaled to fit a square panel (pixel-sharp when enlarged), under its label."""
    scale = PANEL / max(image.size)
    resample = Image.NEAREST if scale >= 1 else Image.LANCZOS
    fitted = image.resize((round(image.width * scale), round(image.height * scale)), resample)
    out = Image.new("RGB", (PANEL, PANEL + LABEL_BAND), SHEET_BACKGROUND)
    out.paste(fitted, ((PANEL - fitted.width) // 2, LABEL_BAND + (PANEL - fitted.height) // 2))
    ImageDraw.Draw(out).text((12, 10), label, fill=LABEL_INK, font=ImageFont.load_default(size=LABEL_SIZE))
    return out


def reference_sheet(spec: dict, outfits: dict, figure: str) -> Image.Image:
    mockups = {key: Image.open(root() / path).convert("RGB") for key, path in spec["mockups"].items()}
    crop = lambda ref: mockups[ref["source"]].crop(tuple(ref["rect"]))  # noqa: E731
    face = Image.open(root() / "src/assets/portraits" / f"{figure}.png").convert("RGBA")
    flat = Image.new("RGB", face.size, SHEET_BACKGROUND)
    flat.paste(face, mask=face)
    panels = [panel(flat, "FACE")]
    panels += [panel(crop(ref), "OUTFIT") for ref in outfits["figures"][figure]["refs"]]
    panels.append(panel(crop(outfits["style"]), "STYLE"))
    sheet = Image.new("RGB", (PANEL * len(panels), PANEL + LABEL_BAND), SHEET_BACKGROUND)
    for i, p in enumerate(panels):
        sheet.paste(p, (i * PANEL, 0))
    return sheet


def framed(image: Image.Image) -> Image.Image:
    """Head and shoulders, framed like the agents' own portraits."""
    px = np.asarray(image.convert("RGB"), dtype=np.int16)
    corners = np.concatenate([px[:CORNER, :CORNER], px[:CORNER, -CORNER:], px[-CORNER:, :CORNER], px[-CORNER:, -CORNER:]]).reshape(-1, 3)
    figure = np.abs(px - np.median(corners, axis=0)).max(axis=2) > BACKDROP_TOLERANCE
    rows = np.nonzero(figure.any(axis=1))[0]
    top = int(rows[0]) if len(rows) else 0
    head = figure[top:top + int(image.height * HEAD_DEPTH)]
    cols = np.nonzero(head.any(axis=0))[0]
    centre = (cols[0] + cols[-1]) / 2 if len(cols) else image.width / 2
    side = int(image.width * FRAME_SHARE)
    x0 = int(min(max(centre - side / 2, 0), image.width - side))
    y0 = int(min(max(top - image.height * HEAD_ROOM, 0), image.height - side))
    return image.crop((x0, y0, x0 + side, y0 + side))


def generate_one(spec: dict, theme_id: str, figure: str) -> str:
    outfits = spec["themes"][theme_id]
    with tempfile.TemporaryDirectory(prefix=f"outfits-{theme_id}-{figure}-") as tmp:
        work = Path(tmp)
        reference_sheet(spec, outfits, figure).save(work / "reference.png")
        prompt = PROMPT.format(
            size=GENERATION_SIZE,
            face=spec["faces"][figure],
            outfit=outfits["figures"][figure]["outfit"],
            background=outfits["background"],
            out="portrait.png",
        )
        made, tail = generate_image(work, work / "reference.png", prompt, "portrait.png")
        if made is None:
            return f"{theme_id}/{figure}: no image came back ({tail})"
        out = raw_path(outfits, figure)
        out.parent.mkdir(parents=True, exist_ok=True)
        Image.open(made).convert("RGB").save(out, optimize=True)
    return f"{theme_id}/{figure}: generated"


def generate(spec: dict, only: list[str]) -> None:
    def wanted(theme_id: str, figure: str) -> bool:
        if not only:
            return not raw_path(spec["themes"][theme_id], figure).exists()
        return theme_id in only or f"{theme_id}/{figure}" in only

    todo = [(theme_id, figure) for theme_id, outfits in spec["themes"].items() for figure in outfits["figures"] if wanted(theme_id, figure)]
    if not todo:
        print("Every portrait is already generated.")
        return
    with ThreadPoolExecutor(max_workers=PARALLEL_GENERATIONS) as pool:
        for line in pool.map(lambda job: generate_one(spec, *job), todo):
            print(line)


def build(spec: dict) -> None:
    for theme_id, outfits in spec["themes"].items():
        out_dir = root() / outfits["outDir"]
        out_dir.mkdir(parents=True, exist_ok=True)
        tiles = []
        for figure in outfits["figures"]:
            raw = raw_path(outfits, figure)
            if not raw.exists():
                print(f"{theme_id}/{figure}: not generated yet")
                continue
            portrait = framed(Image.open(raw).convert("RGB")).resize((PORTRAIT_SIZE, PORTRAIT_SIZE), Image.LANCZOS)
            portrait.save(out_dir / f"{figure}.png", optimize=True)
            tiles.append(portrait)
        if tiles:
            sheet = Image.new("RGB", (PORTRAIT_SIZE * len(tiles), PORTRAIT_SIZE))
            for i, tile in enumerate(tiles):
                sheet.paste(tile, (i * PORTRAIT_SIZE, 0))
            sheet.save(root() / outfits["rawDir"] / "contact-sheet.png")
        print(f"{outfits['outDir']}: {len(tiles)} portraits")


def main() -> None:
    if len(sys.argv) < 3 or sys.argv[1] not in ("generate", "build"):
        sys.exit(__doc__)
    spec = json.loads(Path(sys.argv[2]).read_text())
    if sys.argv[1] == "generate":
        if shutil.which("codex") is None:
            sys.exit("Codex isn't installed.")
        generate(spec, sys.argv[3:])
    else:
        build(spec)


if __name__ == "__main__":
    main()
