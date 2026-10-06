"""Build step of characters.py: generated sheets → one atlas per character.

Each sheet is keyed against its green and cut into its poses (gaps between
figures, else equal cells). Figures are scaled so the sheet's typical figure
stands at the room's height (times the figure's own scale), so every sheet of a
character agrees on size. Poses an agent idles in also get a breathing frame
(upper body 1 px higher). Frames are packed into <figure>.png; <figure>.json
lists each frame as [x, y, w, h, anchorX, anchorY] (anchor = torso centre over
the feet), which way each sheet faces, and each walk's stride.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

from sprite_sheet import TORSO_BAND, chroma_alpha, despill, find_figures, isolate_figure

ROOT = Path(__file__).resolve().parents[2]
ATLAS_WIDTH = 2048
PAD = 2
# Where the hips are, as a share of the figure's height from the top: breathing lifts what's above.
BREATH_CUT = 0.56
# Sheets whose poses an agent rests in; their frames get a breathing twin (name + "~").
BREATHES = {"front": {"stand", "listen", "think", "coffee", "read"}, "front2": {"folder"}, "back": {"stand", "listen", "think", "coffee"}}
FOOT_BAND = 0.08


def keyed(path: Path) -> tuple[np.ndarray, np.ndarray]:
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    alpha = chroma_alpha(rgb)
    return despill(rgb), alpha


def figure_spans(alpha: np.ndarray, count: int) -> list[tuple[int, int]]:
    try:
        spans = find_figures(alpha, count)
    except SystemExit:
        cell = alpha.shape[1] / count
        spans = [(round(i * cell), round((i + 1) * cell)) for i in range(count)]
    return spans


def cut_figures(path: Path, count: int, walk: bool = False) -> list[dict]:
    rgb, alpha = keyed(path)
    figures = []
    for x0, x1 in figure_spans(alpha, count):
        a = isolate_figure(alpha[:, x0:x1].copy())
        solid = a > 0.5
        rows = np.nonzero(solid.any(axis=1))[0]
        cols = np.nonzero(solid.any(axis=0))[0]
        if len(rows) == 0:
            raise SystemExit(f"{path}: an empty pose between x={x0} and {x1}")
        y0, y1 = int(rows[0]), int(rows[-1]) + 1
        c0, c1 = int(cols[0]), int(cols[-1]) + 1
        crop_a = a[y0:y1, c0:c1]
        crop_rgb = rgb[y0:y1, x0 + c0:x0 + c1]
        h = y1 - y0
        band = crop_a[int(h * TORSO_BAND[0]):int(h * TORSO_BAND[1])]
        weights = band.sum(axis=0)
        torso_x = float((weights * np.arange(len(weights))).sum() / max(weights.sum(), 1e-6))
        feet = crop_a[int(h * (1 - FOOT_BAND)):]
        feet_cols = np.nonzero((feet > 0.5).any(axis=0))[0]
        figures.append({"rgba": np.dstack([crop_rgb * crop_a[..., None], crop_a * 255.0]), "torso_x": torso_x, "height": h,
                        "feet": (int(feet_cols[0]), int(feet_cols[-1]) + 1) if len(feet_cols) else (0, crop_a.shape[1]),
                        "lean": facing_lean(crop_rgb, crop_a, torso_x, walk)})
    return figures


def walking_toward(figures: list[dict]) -> str:
    """A walk cycle's direction: the planted foot slides back under the body from frame to frame."""
    contacts = []
    for fig in figures:
        a = fig["rgba"][..., 3] / 255.0
        h = a.shape[0]
        cols = np.nonzero(a[int(h * 0.96):] > 0.5)[1]
        contacts.append((cols.mean() - fig["torso_x"]) / h if len(cols) else 0.0)
    drift = [contacts[(i + 1) % len(contacts)] - contacts[i] for i in range(len(contacts))]
    return "right" if float(np.median(drift)) < 0 else "left"


def facing_lean(rgb: np.ndarray, a: np.ndarray, torso_x: float, walk: bool) -> float:
    """> 0 when the figure faces the picture's right: in three-quarter view the shoes point the way
    they face (not mid-stride, when they spread both ways), and the face sits on that side of the head."""
    h, w = a.shape
    solid = a > 0.5
    feet = solid[int(h * (1 - FOOT_BAND)):]
    cols = np.nonzero(feet)[1]
    shoes = (cols.mean() - torso_x) / w if len(cols) else 0.0
    head = slice(0, int(h * 0.16))
    r, g, b = rgb[head, :, 0], rgb[head, :, 1], rgb[head, :, 2]
    skin = solid[head] & (r > 90) & (r > g) & (g > b) & (r - b > 30)
    sx = np.nonzero(skin)[1]
    hx = np.nonzero(solid[head])[1]
    face = (sx.mean() - hx.mean()) / w if len(sx) > 20 and len(hx) else 0.0
    return float(face if walk else shoes * 2 + face)


def downscale(fig: dict, scale: float) -> tuple[np.ndarray, int, int, float]:
    """The figure at scene scale on a padded canvas; returns (rgba uint8, anchor x, anchor y, feet spread)."""
    src = fig["rgba"]
    w = max(1, round(src.shape[1] * scale))
    h = max(1, round(src.shape[0] * scale))
    small = np.asarray(Image.fromarray(np.clip(src, 0, 255).astype(np.uint8)).resize((w, h), Image.LANCZOS), dtype=np.float32)
    a = small[..., 3:4] / 255.0
    color = np.where(a > 0, small[..., :3] / np.maximum(a, 1e-6), 0)
    canvas = np.zeros((h + PAD * 2, w + PAD * 2, 4), dtype=np.float32)
    canvas[PAD:PAD + h, PAD:PAD + w, :3] = color
    canvas[PAD:PAD + h, PAD:PAD + w, 3] = small[..., 3]
    out = np.clip(np.round(canvas), 0, 255).astype(np.uint8)
    out[out[..., 3] < 8] = 0
    spread = (fig["feet"][1] - fig["feet"][0]) * scale
    return out, PAD + round(fig["torso_x"] * scale), PAD + h, spread


def breathe(frame: np.ndarray, anchor_y: int) -> np.ndarray:
    """The upper body raised by one pixel; the row it leaves is held, so nothing tears."""
    top = PAD
    cut = top + round((anchor_y - top) * BREATH_CUT)
    out = frame.copy()
    out[top - 1:cut - 1] = frame[top:cut]
    return out


def pack(frames: dict[str, tuple[np.ndarray, int, int]]) -> tuple[np.ndarray, dict]:
    order = sorted(frames, key=lambda k: -frames[k][0].shape[0])
    placed, x, y, row_h = {}, 0, 0, 0
    for name in order:
        img = frames[name][0]
        h, w = img.shape[:2]
        if x + w > ATLAS_WIDTH:
            x, y, row_h = 0, y + row_h, 0
        placed[name] = (x, y)
        x += w
        row_h = max(row_h, h)
    atlas = np.zeros((y + row_h, ATLAS_WIDTH, 4), dtype=np.uint8)
    rects = {}
    for name, (px, py) in placed.items():
        img, ax, ay = frames[name]
        h, w = img.shape[:2]
        atlas[py:py + h, px:px + w] = img
        rects[name] = [px, py, w, h, ax, ay]
    used = max(px + frames[n][0].shape[1] for n, (px, _) in placed.items())
    return atlas[:, :used], dict(sorted(rects.items()))


def build_character(spec: dict, room: dict, figure: str) -> str:
    height = room["height"] * room["figures"][figure].get("scale", 1.0)
    frames: dict[str, tuple[np.ndarray, int, int]] = {}
    meta: dict = {"id": figure, "height": round(height), "faces": {}, "walks": {}}
    overrides = room["figures"][figure].get("faces", {})
    for sheet_id, sheet in spec["sheets"].items():
        raw = ROOT / room["rawDir"] / figure / f"{sheet_id}.webp"
        if not raw.exists():
            return f"{figure}: {sheet_id} not generated yet"
        names = sheet["names"]
        figures = cut_figures(raw, len(names), walk=bool(sheet.get("walk")))
        typical = float(np.median([f["height"] for f in figures]))
        scale = height / typical
        spreads = []
        for name, fig in zip(names, figures):
            img, ax, ay, spread = downscale(fig, scale)
            frames[f"{sheet_id}.{name}"] = (img, ax, ay)
            spreads.append(spread)
            if name in BREATHES.get(sheet_id, ()):
                frames[f"{sheet_id}.{name}~"] = (breathe(img, ay), ax, ay)
        if sheet.get("walk"):
            facing = walking_toward(figures)
        else:
            facing = "right" if sum(np.sign(f["lean"]) for f in figures) >= 0 else "left"
        meta["faces"][sheet_id] = overrides.get(sheet_id, facing)
        if sheet.get("walk"):
            # Two steps a cycle; a step is about the widest the feet get apart.
            meta["walks"][sheet_id] = {"frames": len(names), "stride": round(2 * max(spreads) * 0.9, 1)}
    atlas, rects = pack(frames)
    out_dir = ROOT / room["outDir"]
    out_dir.mkdir(parents=True, exist_ok=True)
    Image.fromarray(atlas).save(out_dir / f"{figure}.png", optimize=True)
    meta["frames"] = rects
    (out_dir / f"{figure}.json").write_text(json.dumps(meta, separators=(",", ":")) + "\n")
    return f"{figure}: {len(rects)} frames, atlas {atlas.shape[1]}x{atlas.shape[0]}, height {meta['height']}"


def build(spec: dict, only: list[str]) -> None:
    for room_id, room in spec["rooms"].items():
        for figure in room["figures"]:
            if only and not any(k in only for k in (room_id, f"{room_id}/{figure}")):
                continue
            print(f"{room_id}/{build_character(spec, room, figure)}", flush=True)
