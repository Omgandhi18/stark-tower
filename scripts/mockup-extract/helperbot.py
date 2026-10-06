#!/usr/bin/env python3
"""DUM-E's own face: the `helperbot` figure's portraits, in its own look and in
each theme's outfits, painted by Codex in the style of the team's portraits.

    python3 scripts/mockup-extract/helperbot.py generate [own|office|mori ...]
    python3 scripts/mockup-extract/helperbot.py build

`generate` asks Codex (this machine's Codex sign-in) for each portrait that
isn't on disk yet; `build` frames and sizes them for the app like outfits.py.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

from codex_image import generate_image
from outfits import PORTRAIT_SIZE, framed, panel

ROOT = Path(__file__).resolve().parents[2]
FIGURE = "helperbot"
RAW_DIR = ROOT / "assets/helperbot"
TEAM = ["commander", "engineer", "architect", "recon", "specialist", "operative"]
OWN_SIZE = 64

ROBOT = (
    "DUM-E, the team's maintenance robot: a friendly, eager, slightly clumsy workshop robot arm. Its 'head' is a "
    "two-finger claw gripper with a single round camera lens above it that glows soft {glow}, on a sturdy jointed "
    "arm painted in worn safety yellow and graphite grey, with a few black cables running along it and scuffed, "
    "well-used panels. A small white paper dunce cap sits crookedly on top of the camera. {outfit}"
)
LOOKS = {
    "own": {
        "portraits": "src/assets/portraits",
        "out": "src/assets/portraits",
        "background": "#24434c",
        "glow": "cyan",
        "outfit": "",
    },
    "office": {
        "portraits": "src/assets/themes/studio-office/portraits",
        "out": "src/assets/themes/studio-office/portraits",
        "background": "#efe6d6",
        "glow": "warm amber",
        "outfit": "For the office it wears a small knitted green scarf wrapped around the arm below the claw.",
    },
    "mori": {
        "portraits": "src/assets/themes/mori-cafe/portraits",
        "out": "src/assets/themes/mori-cafe/portraits",
        "background": "#1d3a3e",
        "glow": "warm amber",
        "outfit": "For the cafe it wears a small dark navy cafe apron tied around the arm and holds a folded tea towel in its claw.",
    },
}

PROMPT = (
    "Use your image generation tool to create a new 1024x1024 image, using the attached reference sheet. The sheet's "
    "STYLE panels are the portraits of DUM-E's teammates. Paint a portrait of {robot} Paint it exactly in the style "
    "of the STYLE panels: the same pixel-art rendering, outlines, shading, lighting, level of detail and framing, as "
    "if it were the seventh portrait of the set. The camera and claw face the viewer, turned slightly, and fill the "
    "upper half; the arm's elbow joint and shoulder reach the bottom edge. Fill the whole background with the flat "
    "colour {background}. No frame, no border, no text, no people and nothing else. After generating, copy the "
    "generated image file to ./portrait.png in the current folder."
)


def reference_sheet(look: dict) -> Image.Image:
    panels = []
    for figure in TEAM:
        portrait = Image.open(ROOT / look["portraits"] / f"{figure}.png").convert("RGBA")
        flat = Image.new("RGB", portrait.size, look["background"])
        flat.paste(portrait, mask=portrait)
        panels.append(panel(flat, "STYLE"))
    sheet = Image.new("RGB", (sum(p.width for p in panels), panels[0].height), "#ffffff")
    for i, p in enumerate(panels):
        sheet.paste(p, (i * p.width, 0))
    return sheet


def generate_one(look_id: str) -> str:
    look = LOOKS[look_id]
    with tempfile.TemporaryDirectory(prefix=f"helperbot-{look_id}-") as tmp:
        work = Path(tmp)
        reference_sheet(look).save(work / "reference.png")
        robot = ROBOT.format(glow=look["glow"], outfit=look["outfit"]).strip()
        made, tail = generate_image(work, work / "reference.png", PROMPT.format(robot=robot, background=look["background"]), "portrait.png")
        if made is None:
            return f"{look_id}: no image came back ({tail})"
        RAW_DIR.mkdir(parents=True, exist_ok=True)
        Image.open(made).convert("RGB").save(RAW_DIR / f"{look_id}.png", optimize=True)
    return f"{look_id}: generated"


def generate(only: list[str]) -> None:
    todo = [k for k in LOOKS if k in only] if only else [k for k in LOOKS if not (RAW_DIR / f"{k}.png").exists()]
    if not todo:
        print("Every portrait is already generated.")
        return
    with ThreadPoolExecutor(max_workers=3) as pool:
        for line in pool.map(generate_one, todo):
            print(line, flush=True)


def build() -> None:
    for look_id, look in LOOKS.items():
        raw = RAW_DIR / f"{look_id}.png"
        if not raw.exists():
            print(f"{look_id}: not generated yet")
            continue
        portrait = framed(Image.open(raw).convert("RGB"))
        out = ROOT / look["out"] / f"{FIGURE}.png"
        if look_id == "own":
            # The agents' own portraits are round: borrow a teammate's circle.
            mask = Image.open(ROOT / look["portraits"] / "commander.png").convert("RGBA").getchannel("A")
            small = portrait.resize((OWN_SIZE, OWN_SIZE), Image.LANCZOS).convert("RGBA")
            small.putalpha(mask)
            small.save(out, optimize=True)
        else:
            portrait.resize((PORTRAIT_SIZE, PORTRAIT_SIZE), Image.LANCZOS).save(out, optimize=True)
        print(f"{look_id}: {out.relative_to(ROOT)}")


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in ("generate", "build"):
        sys.exit(__doc__)
    if sys.argv[1] == "generate":
        if shutil.which("codex") is None:
            sys.exit("Codex isn't installed.")
        generate(sys.argv[2:])
    else:
        build()


if __name__ == "__main__":
    main()
