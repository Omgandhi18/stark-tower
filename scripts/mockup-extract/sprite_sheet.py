#!/usr/bin/env python3
"""Turn a generated character sheet (poses on a flat chroma-green background) into
aligned animation frames at scene scale.

Each pose is found as a column of non-green pixels, keyed to alpha, then scaled
so the character stands `--height` px tall. Frames share one canvas size; the
torso centre and the feet baseline line up across frames so a cycle does not
jitter.

Usage:
    python3 scripts/mockup-extract/sprite_sheet.py <sheet.png> <out-dir> <name> --height 165 [--frames 8]
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

KEY_GREEN = np.array([0, 255, 0], dtype=np.float32)
KEY_TOLERANCE = 120.0  # distance in RGB at which a pixel is fully foreground
KEY_SOFTNESS = 60.0
MIN_COLUMN_GAP = 6
TORSO_BAND = (0.15, 0.45)  # rows (fraction of figure height) used to find the torso centre
PADDING = 2


def chroma_alpha(rgb: np.ndarray) -> np.ndarray:
    # Green dominance: how much greener than red/blue the pixel is.
    g_excess = rgb[..., 1] - np.maximum(rgb[..., 0], rgb[..., 2])
    distance = np.linalg.norm(rgb - KEY_GREEN, axis=2)
    alpha = np.clip((distance - (KEY_TOLERANCE - KEY_SOFTNESS)) / KEY_SOFTNESS, 0, 1)
    alpha[g_excess > 90] = 0
    return alpha


def despill(rgb: np.ndarray) -> np.ndarray:
    out = rgb.copy()
    limit = np.maximum(out[..., 0], out[..., 2])
    out[..., 1] = np.minimum(out[..., 1], limit + 12)
    return out


def find_figures(alpha: np.ndarray, expected: int | None) -> list[tuple[int, int]]:
    """Columns of foreground separated by background gaps."""
    cols = (alpha > 0.5).sum(axis=0) > 3
    spans, start, gap = [], None, 0
    for x, on in enumerate(cols):
        if on:
            if start is None:
                start = x
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= MIN_COLUMN_GAP:
                spans.append((start, x - gap + 1))
                start, gap = None, 0
    if start is not None:
        spans.append((start, len(cols)))
    spans = [s for s in spans if s[1] - s[0] > 20]
    if expected and len(spans) != expected:
        raise SystemExit(f"Found {len(spans)} figures, expected {expected}: {spans}")
    return spans


def isolate_figure(alpha: np.ndarray) -> np.ndarray:
    """Keep only the figure connected to the cell's torso; drop neighbours' stray limbs."""
    solid = alpha > 0.5
    rows = np.nonzero(solid.any(axis=1))[0]
    if len(rows) == 0:
        return alpha
    seed_y = int(rows.min() + (rows.max() - rows.min()) * 0.3)
    xs = np.nonzero(solid[seed_y])[0]
    if len(xs) == 0:
        return alpha
    seed_x = int(xs[np.argmin(np.abs(xs - alpha.shape[1] / 2))])
    mask = Image.fromarray((solid * 255).astype(np.uint8)).copy()  # flood fill needs a writable image
    ImageDraw.floodfill(mask, (seed_x, seed_y), 128)
    keep = np.asarray(mask) == 128
    # Grow by a couple of pixels so soft edges next to the figure survive.
    grown = np.asarray(Image.fromarray((keep * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))) > 0
    return np.where(grown, alpha, 0.0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("sheet")
    parser.add_argument("out_dir")
    parser.add_argument("name")
    parser.add_argument("--height", type=int, required=True, help="figure height in scene px")
    parser.add_argument("--frames", type=int, default=None)
    args = parser.parse_args()

    rgb = np.asarray(Image.open(args.sheet).convert("RGB"), dtype=np.float32)
    alpha = chroma_alpha(rgb)
    rgb = despill(rgb)
    if args.frames:
        # Generated sheets space poses evenly; limbs can nearly touch, so split into equal cells.
        cell = alpha.shape[1] / args.frames
        spans = [(round(i * cell), round((i + 1) * cell)) for i in range(args.frames)]
    else:
        spans = find_figures(alpha, None)

    for x0, x1 in spans:
        alpha[:, x0:x1] = isolate_figure(alpha[:, x0:x1])

    figures = []
    for x0, x1 in spans:
        a = alpha[:, x0:x1]
        rows = np.nonzero((a > 0.5).sum(axis=1) > 0)[0]
        y0, y1 = rows.min(), rows.max() + 1
        figures.append((x0, x1, y0, y1))
    tallest = max(y1 - y0 for _, _, y0, y1 in figures)
    scale = args.height / tallest

    frames = []
    for x0, x1, y0, y1 in figures:
        a = alpha[y0:y1, x0:x1]
        h = y1 - y0
        band = a[int(h * TORSO_BAND[0]):int(h * TORSO_BAND[1])]
        weights = band.sum(axis=0)
        torso_x = float((weights * np.arange(len(weights))).sum() / max(weights.sum(), 1e-6))
        rgba = np.dstack([rgb[y0:y1, x0:x1] * a[..., None], a * 255.0])  # premultiplied for resampling
        frames.append((rgba, torso_x, h))

    left = max(int(np.ceil(tx * scale)) for _, tx, _ in frames) + PADDING
    right = max(int(np.ceil((f.shape[1] - tx) * scale)) for f, tx, _ in frames) + PADDING
    height = int(np.ceil(tallest * scale)) + PADDING
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for i, (rgba, tx, h) in enumerate(frames):
        w = max(1, round(rgba.shape[1] * scale))
        hh = max(1, round(h * scale))
        small = np.asarray(Image.fromarray(np.clip(rgba, 0, 255).astype(np.uint8)).resize((w, hh), Image.LANCZOS),
                           dtype=np.float32)
        a = small[..., 3:4] / 255.0
        color = np.where(a > 0, small[..., :3] / np.maximum(a, 1e-6), 0)  # un-premultiply
        canvas = np.zeros((height, left + right, 4), dtype=np.float32)
        ox = left - round(tx * scale)
        oy = height - PADDING - hh
        canvas[oy:oy + hh, ox:ox + w, :3] = color
        canvas[oy:oy + hh, ox:ox + w, 3] = small[..., 3]
        Image.fromarray(np.clip(np.round(canvas), 0, 255).astype(np.uint8)).save(out / f"{args.name}-{i}.png")
    print(f"{len(frames)} frames, {left + right}x{height}px, anchor (torso x, feet y) = ({left}, {height - PADDING})")


if __name__ == "__main__":
    main()
