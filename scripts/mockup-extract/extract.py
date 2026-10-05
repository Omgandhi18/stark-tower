#!/usr/bin/env python3
"""Cut an approved mockup into runtime layers that recompose to it exactly.

Plates are regions of the mockup with their live parts filled in. Sprites are
matted against their plate's filled background, so drawing a sprite back at its
original rect reproduces the source pixels. Panels are opaque overlay cards with
their live text cleared. The manifest records every rect and sampled colour so
the app never places anything by guesswork.

Usage:
    python3 scripts/mockup-extract/extract.py scripts/mockup-extract/specs/rnd-environment.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

LUMA = np.array([0.299, 0.587, 0.114], dtype=np.float32)
BRIGHT_QUANTILE = 0.9
EPSILON = 1e-6


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def local(rect: list[int], origin: list[int]) -> tuple[int, int, int, int]:
    """Convert an absolute [x0, y0, x1, y1) rect into plate-local coordinates."""
    return rect[0] - origin[0], rect[1] - origin[1], rect[2] - origin[0], rect[3] - origin[1]


def fill_vertical(img: np.ndarray, rect: tuple[int, int, int, int]) -> None:
    x0, y0, x1, y1 = rect
    height = img.shape[0]
    top = img[y0 - 1, x0:x1] if y0 > 0 else img[min(y1, height - 1), x0:x1]
    bottom = img[y1, x0:x1] if y1 < height else top
    span = (y1 - y0) + 1
    for row in range(y0, y1):
        t = (row - (y0 - 1)) / span
        img[row, x0:x1] = top * (1 - t) + bottom * t


def fill_horizontal(img: np.ndarray, rect: tuple[int, int, int, int]) -> None:
    x0, y0, x1, y1 = rect
    width = img.shape[1]
    left = img[y0:y1, x0 - 1] if x0 > 0 else img[y0:y1, min(x1, width - 1)]
    right = img[y0:y1, x1] if x1 < width else left
    span = (x1 - x0) + 1
    for col in range(x0, x1):
        t = (col - (x0 - 1)) / span
        img[y0:y1, col] = left * (1 - t) + right * t


FILLS = {"vertical": fill_vertical, "horizontal": fill_horizontal}


def difference_matte(src: np.ndarray, bg: np.ndarray, threshold: float) -> np.ndarray:
    """RGBA whose composite over `bg` reproduces `src`."""
    diff = src - bg
    # The smallest alpha that keeps the un-premultiplied colour inside 0..255,
    # so dark outlines on a dark background don't clip.
    headroom = np.where(diff > 0, diff / np.maximum(255.0 - bg, EPSILON), -diff / np.maximum(bg, EPSILON))
    gamut = np.clip(headroom.max(axis=2), 0.0, 1.0)
    alpha = np.maximum(np.clip(np.abs(diff).max(axis=2) / threshold, 0.0, 1.0), gamut)
    color = bg + diff / np.maximum(alpha, EPSILON)[..., None]
    color = np.where(alpha[..., None] > 0, np.clip(color, 0, 255), 0)
    return np.dstack([color, alpha * 255.0])


def projection_alpha(src: np.ndarray, bg: np.ndarray, ink: np.ndarray) -> np.ndarray:
    """Coverage of a single-colour `ink` drawn over `bg`."""
    direction = ink[None, None, :] - bg
    denom = np.maximum((direction * direction).sum(axis=2), EPSILON)
    return np.clip(((src - bg) * direction).sum(axis=2) / denom, 0.0, 1.0)


def bright_color(img: np.ndarray, rect: list[int]) -> np.ndarray:
    patch = img[rect[1]:rect[3], rect[0]:rect[2]].reshape(-1, 3)
    luma = patch @ LUMA
    return np.median(patch[luma >= np.quantile(luma, BRIGHT_QUANTILE)], axis=0)


def median_color(img: np.ndarray, rect: list[int]) -> np.ndarray:
    return np.median(img[rect[1]:rect[3], rect[0]:rect[2]].reshape(-1, 3), axis=0)


COLOR_SAMPLERS = {"bright": bright_color, "median": median_color}


def hex_color(rgb: np.ndarray) -> str:
    r, g, b = (int(round(v)) for v in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def save(img: np.ndarray, path: Path) -> None:
    mode = "RGBA" if img.shape[2] == 4 else "RGB"
    Image.fromarray(np.clip(np.round(img), 0, 255).astype(np.uint8)).convert(mode).save(path, optimize=True)


def build_plates(source: np.ndarray, spec: dict) -> dict[str, dict]:
    plates: dict[str, dict] = {}
    for plate in spec["plates"]:
        x0, y0, x1, y1 = plate["rect"]
        original = source[y0:y1, x0:x1].copy()
        img = original.copy()
        for fill in plate.get("fills", []):
            FILLS[fill["method"]](img, local(fill["rect"], [x0, y0]))
        for mirror in plate.get("mirrors", []):
            mx0, my0, mx1, my1 = local(mirror["rect"], [x0, y0])
            sum_x = mirror["sumX"] - 2 * x0
            for col in range(mx0, mx1):
                img[my0:my1, col] = original[my0:my1, sum_x - col]
        # Generated art for what the mockup hides (behind cards, people, ...).
        for patch in plate.get("patches", []):
            px0, py0, px1, py1 = local(patch["rect"], [x0, y0])
            art = np.asarray(Image.open(repo_root() / patch["file"]).convert("RGB"), dtype=np.float32)
            if art.shape[:2] != (py1 - py0, px1 - px0):
                raise SystemExit(f"Patch {patch['id']} is {art.shape[1]}x{art.shape[0]}, rect needs {px1 - px0}x{py1 - py0}")
            img[py0:py1, px0:px1] = art
        plates[plate["id"]] = {"rect": plate["rect"], "image": img}
    return plates


def clear_text(src: np.ndarray, origin: list[int], spec: dict) -> None:
    cx, cy = spec["center"][0] - origin[0], spec["center"][1] - origin[1]
    ys, xs = np.mgrid[0:src.shape[0], 0:src.shape[1]]
    inside = (xs - cx) ** 2 + (ys - cy) ** 2 <= spec["radius"] ** 2
    luma = src @ LUMA
    text = inside & (luma >= spec["minLuma"])
    base = np.median(src[inside & ~text], axis=0)
    src[text] = base


def build_sprites(source: np.ndarray, plates: dict, panels: dict, spec: dict, out: Path) -> dict[str, dict]:
    """Sprites sit on a plate or on a panel; either way they are matted against what's under them."""
    sprites: dict[str, dict] = {}
    for sprite in spec["sprites"]:
        base = plates[sprite["plate"]] if "plate" in sprite else panels[sprite["panel"]]
        px0, py0 = base["rect"][0], base["rect"][1]
        x0, y0, x1, y1 = sprite["rect"]
        src = source[y0:y1, x0:x1].copy()
        if "clearText" in sprite:
            clear_text(src, [x0, y0], sprite["clearText"])
        bg = base["image"][y0 - py0:y1 - py0, x0 - px0:x1 - px0]
        file = f"sprite-{sprite['id']}.png"
        save(difference_matte(src, bg, sprite["threshold"]), out / file)
        sprites[sprite["id"]] = {"file": file, "rect": sprite["rect"]}
    return sprites


def build_panels(source: np.ndarray, spec: dict, out: Path) -> dict[str, dict]:
    panels: dict[str, dict] = {}
    for panel in spec["panels"]:
        x0, y0, x1, y1 = panel["rect"]
        img = source[y0:y1, x0:x1].copy()
        for rect in panel["clear"]:
            fill_vertical(img, local(rect, [x0, y0]))
        file = f"panel-{panel['id']}.png"
        save(img, out / file)
        panels[panel["id"]] = {"file": file, "rect": panel["rect"], "image": img}
    return panels


def build_cutouts(source: np.ndarray, spec: dict, out: Path) -> dict[str, dict]:
    """Original pixels of things that move (people, occupied seats), cut with an authored mask."""
    cutouts: dict[str, dict] = {}
    for cutout in spec.get("cutouts", []):
        x0, y0, x1, y1 = cutout["rect"]
        mask = np.asarray(Image.open(repo_root() / cutout["mask"]).convert("L"), dtype=np.float32)
        if mask.shape != (y1 - y0, x1 - x0):
            raise SystemExit(f"Cutout {cutout['id']} mask is {mask.shape[1]}x{mask.shape[0]}, rect needs {x1 - x0}x{y1 - y0}")
        rgba = np.dstack([source[y0:y1, x0:x1], np.where(mask > 0, 255.0, 0.0)])
        file = f"cutout-{cutout['id']}.png"
        save(rgba, out / file)
        cutouts[cutout["id"]] = {"file": file, "rect": cutout["rect"]}
    return cutouts


def build_nav(source: np.ndarray, plates: dict, spec: dict, out: Path) -> dict:
    nav = spec["nav"]
    plate = plates[nav["plate"]]
    px0, py0 = plate["rect"][0], plate["rect"][1]
    hx0, hy0, hx1, hy1 = nav["highlightRect"]
    inactive_ink = bright_color(source, nav["inactiveColorFrom"])
    active_ink = bright_color(source, nav["activeColorFrom"])
    items = {item["id"]: item for item in nav["items"]}
    active_id = nav["activeItem"]

    # The highlight box with its own icon and label removed.
    empty_box = source[hy0:hy1, hx0:hx1].copy()
    ax0, ay0, ax1, ay1 = local(items[active_id]["content"], [hx0, hy0])
    fill_horizontal(empty_box, (ax0, ay0, ax1, ay1))

    # Bake the active item back into the sidebar in its inactive colour.
    active_src = source[hy0:hy1, hx0:hx1][ay0:ay1, ax0:ax1]
    coverage = projection_alpha(active_src, empty_box[ay0:ay1, ax0:ax1], active_ink)
    sx0, sy0 = hx0 - px0 + ax0, hy0 - py0 + ay0
    region = plate["image"][sy0:sy0 + coverage.shape[0], sx0:sx0 + coverage.shape[1]]
    region += coverage[..., None] * (inactive_ink[None, None, :] - region)

    box_height = hy1 - hy0
    active_center = (items[active_id]["content"][1] + items[active_id]["content"][3]) / 2
    center_offset = active_center - hy0
    result = {"highlightX": [hx0, hx1], "items": {}}
    for item_id, item in items.items():
        cx0, cy0, cx1, cy1 = item["content"]
        top = int(round((cy0 + cy1) / 2 - center_offset))
        file = f"nav-active-{item_id}.png"
        if item_id == active_id:
            save(source[hy0:hy1, hx0:hx1], out / file)
        else:
            box = empty_box.copy()
            src = source[cy0:cy1, cx0:cx1]
            padded = source[cy0 - 1:cy1 + 1, cx0:cx1].copy()
            fill_vertical(padded, (0, 1, cx1 - cx0, cy1 - cy0 + 1))
            item_coverage = projection_alpha(src, padded[1:-1], inactive_ink)
            bx0, by0 = cx0 - hx0, cy0 - top
            target = box[by0:by0 + item_coverage.shape[0], bx0:bx0 + item_coverage.shape[1]]
            target += item_coverage[..., None] * (active_ink[None, None, :] - target)
            save(box, out / file)
        result["items"][item_id] = {"file": file, "rect": [hx0, top, hx1, top + box_height]}
    result["activeItem"] = active_id
    result["inkInactive"] = hex_color(inactive_ink)
    result["inkActive"] = hex_color(active_ink)
    return result


def main(spec_path: str) -> None:
    root = repo_root()
    spec = json.loads(Path(spec_path).read_text())
    out = root / spec["outDir"]
    out.mkdir(parents=True, exist_ok=True)
    source = np.asarray(Image.open(root / spec["source"]).convert("RGB"), dtype=np.float32)

    plates = build_plates(source, spec)
    panels = build_panels(source, spec, out)
    sprites = build_sprites(source, plates, panels, spec, out)
    cutouts = build_cutouts(source, spec, out)
    nav = build_nav(source, plates, spec, out)

    plate_entries = {}
    for plate_id, plate in plates.items():
        file = f"plate-{plate_id}.png"
        save(plate["image"], out / file)
        plate_entries[plate_id] = {"file": file, "rect": plate["rect"]}

    manifest = {
        "source": spec["source"],
        "viewport": spec["viewport"],
        "plates": plate_entries,
        "sprites": sprites,
        "cutouts": cutouts,
        "panels": {key: {"file": p["file"], "rect": p["rect"]} for key, p in panels.items()},
        "nav": nav,
        "colors": {
            key: hex_color(COLOR_SAMPLERS[sample["mode"]](source, sample["rect"]))
            for key, sample in spec["colors"].items()
        },
        "text": spec["text"],
        # Deliberate departures from the mockup (e.g. the empty pod: the roster has six people).
        "intended": [
            {"id": patch["id"], "rect": patch["rect"]}
            for plate in spec["plates"]
            for patch in plate.get("patches", [])
            if patch.get("intended")
        ],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {len(plate_entries)} plates, {len(sprites)} sprites, {len(cutouts)} cutouts, {len(panels)} panels, "
          f"{len(nav['items'])} nav states to {out.relative_to(root)}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
