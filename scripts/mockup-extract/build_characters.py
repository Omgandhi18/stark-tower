#!/usr/bin/env python3
"""Build animation frames for the reference scene's characters.

Generated sheets are sliced to scene scale (sprite_sheet.py). Walks are posed
from a cut-out rig (walk_rig.py), since generated sheets don't draw a real gait.
Seated frames are derived from the mockup cut-out itself — a hand block tapping
1 px — so frame 0 is still the mockup's own pixels. Writes PNG frames plus
<id>.json describing each animation (frames, fps, anchor = torso x / feet y in
frame pixels; walks add stride and startFrame).

Usage:
    python3 scripts/mockup-extract/build_characters.py scripts/mockup-extract/specs/rnd-characters.json
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SLICER = Path(__file__).with_name("sprite_sheet.py")
WALK_RIG = Path(__file__).with_name("walk_rig.py")


def tap_frame(base: np.ndarray, rect: list[int], dy: int) -> np.ndarray:
    """Shift a block down by `dy` px, repeating its top row into the gap."""
    x0, y0, x1, y1 = rect
    out = base.copy()
    block = base[y0:y1 - dy, x0:x1]
    out[y0 + dy:y1, x0:x1] = block
    out[y0:y0 + dy, x0:x1] = base[y0:y0 + 1, x0:x1]
    return out


def build_seated(spec: dict, out: Path, name: str) -> dict:
    base = np.asarray(Image.open(ROOT / spec["cutout"]).convert("RGBA"))
    frames = [base]
    for tap in spec["taps"]:
        frames += [tap_frame(base, tap["rect"], tap["dy"]), base]
    files = []
    for i, frame in enumerate(frames):
        file = f"{name}-seated-{i}.png"
        Image.fromarray(frame).save(out / file, optimize=True)
        files.append(file)
    # Seated frames are placed by the cut-out's own rect, not by an anchor.
    return {"frames": files, "fps": spec["fps"], "anchor": [0, 0], "cutout": True}


def slice_sheet(sheet: dict, height: int, out: Path, name: str) -> tuple[list[str], list[int]]:
    with tempfile.TemporaryDirectory() as tmp:
        result = subprocess.run(
            [sys.executable, str(SLICER), str(ROOT / sheet["file"]), tmp, "f",
             "--height", str(height), "--frames", str(sheet["frames"])],
            check=True, capture_output=True, text=True,
        )
        anchor_text = result.stdout.rsplit("=", 1)[1].strip(" ()\n")
        anchor = [int(v) for v in anchor_text.split(",")]
        files = []
        for i in range(sheet["frames"]):
            file = f"{name}-{i}.png"
            Image.open(Path(tmp) / f"f-{i}.png").save(out / file, optimize=True)
            files.append(file)
    return files, anchor


def build_walk(rig_spec: str, height: int, out: Path, name: str) -> dict:
    """Walk and side-view turn animations posed from a cut-out rig."""
    result = subprocess.run(
        [sys.executable, str(WALK_RIG), str(ROOT / rig_spec), str(out), name, "--height", str(height)],
        check=True, capture_output=True, text=True,
    )
    return json.loads(result.stdout.strip().splitlines()[-1])["animations"]


def main(spec_path: str) -> None:
    spec = json.loads(Path(spec_path).read_text())
    for character in spec["characters"]:
        cid = character["id"]
        out = ROOT / spec["outDir"] / cid
        out.mkdir(parents=True, exist_ok=True)
        animations = {"seated": build_seated(character["seated"], out, cid)}
        if "walkRig" in character:
            animations.update(build_walk(character["walkRig"], character["height"], out, cid))
        for sheet in character["sheets"]:
            stem = Path(sheet["file"]).stem.replace("-sheet", "")
            files, anchor = slice_sheet(sheet, character["height"], out, f"{cid}-{stem}")
            for anim, info in sheet["animations"].items():
                animations[anim] = {"frames": [files[i] for i in info["frames"]], "fps": info["fps"], "anchor": anchor}
        (out / f"{cid}.json").write_text(json.dumps({"id": cid, "height": character["height"], "animations": animations}, indent=2) + "\n")
        summary = ", ".join(f"{k} ({len(v['frames'])})" for k, v in animations.items())
        print(f"{cid}: {summary}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
