#!/usr/bin/env python3
"""Recompose extracted layers in their reference state and diff them against the mockup.

Everything should match except the areas the app fills with live content
(status values, badges, card text, control labels). Writes a heatmap so the
remaining differences can be inspected.

Usage:
    python3 scripts/mockup-extract/verify.py <manifest.json> <heatmap.png>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

TOLERANCE = 2
HEAT_GAIN = 4


def load(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGBA"), dtype=np.float32)


def paste(canvas: np.ndarray, layer: np.ndarray, rect: list[int]) -> None:
    x0, y0 = rect[0], rect[1]
    h, w = layer.shape[:2]
    alpha = layer[..., 3:4] / 255.0
    region = canvas[y0:y0 + h, x0:x0 + w]
    region[:] = region * (1 - alpha) + layer[..., :3] * alpha


def main(manifest_path: str, heatmap_path: str) -> None:
    manifest_file = Path(manifest_path).resolve()
    root = manifest_file.parents[5]
    base = manifest_file.parent
    manifest = json.loads(manifest_file.read_text())
    source = np.asarray(Image.open(root / manifest["source"]).convert("RGB"), dtype=np.float32)
    canvas = np.zeros_like(source)

    # Same stacking as the app: plates, characters at rest, active nav highlight, panels, then sprites.
    for plate in manifest["plates"].values():
        paste(canvas, load(base / plate["file"]), plate["rect"])
    for cutout in manifest.get("cutouts", {}).values():
        paste(canvas, load(base / cutout["file"]), cutout["rect"])
    active = manifest["nav"]["items"][manifest["nav"]["activeItem"]]
    paste(canvas, load(base / active["file"]), active["rect"])
    for panel in manifest["panels"].values():
        paste(canvas, load(base / panel["file"]), panel["rect"])
    for sprite in manifest["sprites"].values():
        paste(canvas, load(base / sprite["file"]), sprite["rect"])

    diff = np.abs(canvas - source).max(axis=2)
    live = np.zeros(diff.shape, dtype=bool)
    for entry in manifest["text"].values():
        x0, y0, x1, y1 = entry["rect"]
        live[y0:y1, x0:x1] = True

    intended = np.zeros(diff.shape, dtype=bool)
    for entry in manifest.get("intended", []):
        x0, y0, x1, y1 = entry["rect"]
        intended[y0:y1, x0:x1] = True

    off = diff > TOLERANCE
    expected = live | intended
    print(f"pixels: {diff.size}")
    print(f"differing (> {TOLERANCE}): {int(off.sum())}  live-text areas: {int((off & live).sum())}  "
          f"intended changes: {int((off & intended & ~live).sum())}  elsewhere: {int((off & ~expected).sum())}")
    ys, xs = np.nonzero(off & ~expected)
    if len(xs):
        print(f"elsewhere spans x {xs.min()}..{xs.max()} y {ys.min()}..{ys.max()}")

    heat = np.clip(diff * HEAT_GAIN, 0, 255).astype(np.uint8)
    Image.fromarray(heat).save(heatmap_path)
    print(f"heatmap: {heatmap_path}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
