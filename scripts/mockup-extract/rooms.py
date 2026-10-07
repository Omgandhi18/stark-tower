#!/usr/bin/env python3
"""Build a theme's room from its approved mockup: the room with every station
empty (a plate), each agent and helper as a cut-out of the mockup's own pixels,
and the interface the mockup paints over the room (cards, labels, controls)
removed for good.

Codex's image generation paints what each agent or overlay hides; an agent's
cut-out covers every pixel its fill changed, so with everyone present the room
recomposes to the mockup exactly. The one exception is an agent target with an
"outfit": Codex redresses them, and their cut-out wears that instead of what the
mockup paints (the developer's choice, so the room matches the agent's portrait).

    python3 scripts/mockup-extract/rooms.py generate scripts/mockup-extract/specs/office-room.json [region or target ...]
    python3 scripts/mockup-extract/rooms.py compose  scripts/mockup-extract/specs/office-room.json

`generate` asks Codex for each region's fill and each outfit that isn't on disk
yet (it uses this Mac's Codex sign-in); naming a region or target redoes it.
`compose` builds the plate, the cut-outs and the manifest, then checks the
recomposition against the mockup.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

from codex_image import generate_image

GENERATION_SIZE = 1024
PARALLEL_GENERATIONS = 2
# A pixel belongs to what was removed when the fill differs from the mockup by more than this.
CHANGE_THRESHOLD = 44.0
# Close small gaps in a mask, then give it a margin, so no edge of what was removed survives.
CLOSE_RADIUS = 2
MARGIN_RADIUS = 3
FEATHER_RADIUS = 1.6
# Below this blend weight a pixel keeps the mockup's own value.
BLEND_FLOOR = 0.004
# Colour correction uses pixels the fill barely changed.
CALM_QUANTILE = 60
LUMA = np.array([0.299, 0.587, 0.114], dtype=np.float32)

PROMPT = (
    "Use your image generation tool to edit the attached image. It is a crop of an isometric pixel-art "
    "illustration of a room, enlarged to {size}x{size}. Remove {targets}. Paint exactly what each one hid. "
    "Keep everything else the same: the same framing and camera angle, the same pixel-art style, the same "
    "colours, lighting and shadows, and every other object exactly where it is. Keep furniture such as chairs, "
    "stools and armchairs, shown empty. Do not add anything new and do not add any people. After generating, "
    "copy the generated image file to ./{out} in the current folder."
)


# For a region whose kind is "add": a character the mockup doesn't paint, painted into a free seat.
ADD_PROMPT = (
    "Use your image generation tool to edit the attached image. It is a crop of an isometric pixel-art "
    "illustration of a room, enlarged to {size}x{size}. Add {targets}. Draw them in exactly the same pixel-art "
    "style as the room, with the same outlines, colours, lighting and shadows, and sized naturally for the "
    "furniture they use. Keep everything else exactly the same: the same framing and camera angle, and every "
    "object exactly where it is. Do not add anything else and nobody else. After generating, copy the generated "
    "image file to ./{out} in the current folder."
)


# For an agent target with an "outfit": the same person, dressed differently, in the same place.
OUTFIT_PROMPT = (
    "Use your image generation tool to edit the attached image. It is a crop of an isometric pixel-art "
    "illustration of a room, enlarged to {size}x{size}. Change only the clothes of {who}: dress them in {outfit}. "
    "Keep their face, hair, skin, pose, hands and outline exactly as they are, and draw the new clothes in exactly "
    "the same pixel-art style, with the same outlines, lighting and shadows. Keep everything else exactly the same: "
    "the same framing and camera angle, and every object exactly where it is. Do not add anything else. After "
    "generating, copy the generated image file to ./{out} in the current folder."
)


def root() -> Path:
    return Path(__file__).resolve().parents[2]


def load_spec(path: str) -> dict:
    return json.loads(Path(path).read_text())


def rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)


def save(img: np.ndarray, path: Path) -> None:
    mode = "RGBA" if img.shape[2] == 4 else "RGB"
    Image.fromarray(np.clip(np.round(img), 0, 255).astype(np.uint8)).convert(mode).save(path, optimize=True)


# ---- Generation ----------------------------------------------------------------


def fill_path(spec: dict, region: dict) -> Path:
    return root() / spec["fillDir"] / f"{region['id']}.png"


def base_path(spec: dict) -> Path:
    """The mockup without its painted interface: kept beside the fills for checking, not shipped."""
    return (root() / spec["fillDir"]).parent / "base.png"


def outfit_path(spec: dict, target: dict) -> Path:
    return root() / spec["fillDir"] / f"{target['id']}-outfit.png"


def generate_one(spec: dict, region: dict, target: dict | None = None) -> str:
    """A region's fill or, given a target with an outfit, that target redressed."""
    label = target["id"] if target else region["id"]
    out = outfit_path(spec, target) if target else fill_path(spec, region)
    source = Image.open(root() / spec["source"]).convert("RGB")
    x0, y0, x1, y1 = region["crop"]
    crop = source.crop((x0, y0, x1, y1))
    with tempfile.TemporaryDirectory(prefix=f"room-{label}-") as tmp:
        work = Path(tmp)
        crop.resize((GENERATION_SIZE, GENERATION_SIZE), Image.LANCZOS).save(work / "reference.png")
        if target:
            outfit = target["outfit"]
            prompt = OUTFIT_PROMPT.format(size=GENERATION_SIZE, who=outfit["who"], outfit=outfit["wears"], out="fill.png")
        else:
            targets = "; ".join(t["describe"] for t in region["targets"])
            template = ADD_PROMPT if region.get("kind") == "add" else PROMPT
            prompt = template.format(size=GENERATION_SIZE, targets=targets, out="fill.png")
        made, tail = generate_image(work, work / "reference.png", prompt, "fill.png")
        if made is None:
            return f"{label}: no image came back ({tail})"
        out.parent.mkdir(parents=True, exist_ok=True)
        # Kept at the crop's own size: that's all compose needs.
        Image.open(made).convert("RGB").resize(crop.size, Image.LANCZOS).save(out, optimize=True)
    return f"{label}: generated"


def generate(spec: dict, only: list[str]) -> None:
    """Fills and outfits not on disk yet; named regions or targets are redone."""
    todo: list[tuple[dict, dict | None]] = []
    for region in spec["regions"]:
        if (region["id"] in only) if only else not fill_path(spec, region).exists():
            todo.append((region, None))
        for target in (t for t in region["targets"] if t.get("outfit")):
            if (target["id"] in only) if only else not outfit_path(spec, target).exists():
                todo.append((region, target))
    if not todo:
        print("Every region already has its fill, and every outfit is painted.")
        return
    with ThreadPoolExecutor(max_workers=PARALLEL_GENERATIONS) as pool:
        for line in pool.map(lambda job: generate_one(spec, *job), todo):
            print(line)


# ---- Composition ---------------------------------------------------------------


def grow(mask: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return mask
    img = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(radius * 2 + 1))
    return np.asarray(img) > 127


def shrink(mask: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return mask
    img = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(radius * 2 + 1))
    return np.asarray(img) > 127


def colour_matched(fill: np.ndarray, original: np.ndarray) -> np.ndarray:
    """The fill with its colours fitted to the mockup's, from pixels it barely changed."""
    change = np.abs(fill - original).max(axis=2)
    calm = change < np.percentile(change, CALM_QUANTILE)
    out = fill.copy()
    for c in range(3):
        gain, offset = np.polyfit(fill[..., c][calm], original[..., c][calm], 1)
        out[..., c] = fill[..., c] * gain + offset
    return np.clip(out, 0, 255)


def target_mask(change: np.ndarray, box: list[int], crop: list[int]) -> np.ndarray:
    """What a target covered: pixels the fill changed, inside the target's box."""
    x0, y0, x1, y1 = (box[0] - crop[0], box[1] - crop[1], box[2] - crop[0], box[3] - crop[1])
    inside = np.zeros(change.shape, dtype=bool)
    inside[max(y0, 0):y1, max(x0, 0):x1] = True
    mask = (change > CHANGE_THRESHOLD) & inside
    mask = shrink(grow(mask, CLOSE_RADIUS), CLOSE_RADIUS)
    return grow(mask, MARGIN_RADIUS) & inside


def soft(mask: np.ndarray) -> np.ndarray:
    """A mask's blend weight: full inside, a short feathered edge outside."""
    blurred = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(FEATHER_RADIUS))
    return np.maximum(np.asarray(blurred, dtype=np.float32) / 255, mask.astype(np.float32))


def within(region: dict, plate: list[int]) -> list[int]:
    """The part of a region's crop that lies on the plate (a crop may reach into the mockup's frame)."""
    cx0, cy0, cx1, cy1 = region["crop"]
    return [max(cx0, plate[0]), max(cy0, plate[1]), min(cx1, plate[2]), min(cy1, plate[3])]


def region_view(img: np.ndarray, region: dict, origin: tuple[int, int]) -> np.ndarray:
    vx0, vy0, vx1, vy1 = region["view"]
    return img[vy0 - origin[1]:vy1 - origin[1], vx0 - origin[0]:vx1 - origin[0]]


def fill_on_plate(region: dict, path: Path) -> np.ndarray:
    """A fill of a region's crop, trimmed to the part of the crop on the plate."""
    cx0, cy0 = region["crop"][:2]
    vx0, vy0, vx1, vy1 = region["view"]
    return rgb(path)[vy0 - cy0:vy1 - cy0, vx0 - cx0:vx1 - cx0]


def redressed(current: np.ndarray, outfit: np.ndarray, touched: np.ndarray) -> np.ndarray:
    """A cut-out's pixels in its new outfit: the mockup's own, with the outfit fill blended
    in wherever it changed them, kept inside the cut-out."""
    change = np.abs(outfit - current).max(axis=2)
    clothes = shrink(grow((change > CHANGE_THRESHOLD) & touched, CLOSE_RADIUS), CLOSE_RADIUS)
    weight = (soft(clothes) * touched)[..., None]
    return current * (1 - weight) + outfit * weight


def compose(spec: dict) -> None:
    """Three passes. First the mockup's painted interface goes, giving the base: the
    room as the app shows it with everyone in place. Then agents and helpers are
    lifted out of the base, leaving the plate, and become cut-outs of the base.
    Last, characters the mockup doesn't paint become cut-outs of their fills."""
    out = root() / spec["outDir"]
    out.mkdir(parents=True, exist_ok=True)
    source = rgb(root() / spec["source"])
    px0, py0, px1, py1 = spec["plate"]
    origin = (px0, py0)
    base = source[py0:py1, px0:px1].copy()
    for region in spec["regions"]:
        region["view"] = within(region, spec["plate"])
    fills = {r["id"]: colour_matched(fill_on_plate(r, fill_path(spec, r)), region_view(base, r, origin)) for r in spec["regions"]}
    owned = np.zeros(base.shape[:2], dtype=bool)
    intended: list[dict] = []

    def apply(img: np.ndarray, region: dict, mask: np.ndarray, taken: np.ndarray, label: str) -> np.ndarray:
        weight = soft(mask)
        touched = (weight > BLEND_FLOOR) & ~taken
        weight = np.where(touched, weight, 0.0)
        own = region_view(owned, region, origin)
        if (own & touched).any():
            raise SystemExit(f"{label} overlaps pixels another target already changed")
        own |= touched
        view = region_view(img, region, origin)
        view[:] = view * (1 - weight[..., None]) + fills[region["id"]] * weight[..., None]
        return touched

    # Pass 1: the interface the mockup paints over the room, removed for good.
    for region in spec["regions"]:
        change = np.abs(fills[region["id"]] - region_view(base, region, origin)).max(axis=2)
        taken = np.zeros(change.shape, dtype=bool)
        for target in (t for t in region["targets"] if t.get("kind") == "interface"):
            mask = target_mask(change, target["box"], region["view"])
            taken |= apply(base, region, mask, taken, f"{region['id']}/{target['id']}")
            intended.append({"id": target["id"], "rect": target["box"]})
    save(base, base_path(spec))

    # Pass 2: agents and helpers lifted out of the base. Front ones claim shared pixels first.
    # The base is settled, so an agent's edge may re-blend what pass 1 painted (a label beside them).
    # An agent with an outfit keeps the mockup's outline but wears the outfit fill's clothes.
    owned[:] = False
    plate = base.copy()
    cutouts: dict[str, dict] = {}
    for region in spec["regions"]:
        current = region_view(base, region, origin)
        change = np.abs(fills[region["id"]] - current).max(axis=2)
        movable = sorted((t for t in region["targets"] if t.get("kind") in ("agent", "helper")), key=lambda t: -t.get("floorY", 0))
        claimed = np.zeros(change.shape, dtype=bool)
        masks = []
        for target in movable:
            mask = target_mask(change, target["box"], region["view"]) & ~claimed
            claimed |= mask
            masks.append((target, mask))
        taken = np.zeros(change.shape, dtype=bool)
        for target, mask in masks:
            touched = apply(plate, region, mask, taken | (claimed & ~mask), f"{region['id']}/{target['id']}")
            taken |= touched
            ys, xs = np.nonzero(touched)
            bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
            pixels = current
            if target.get("outfit"):
                outfit = colour_matched(fill_on_plate(region, outfit_path(spec, target)), current)
                pixels = redressed(current, outfit, touched)
            rgba = np.dstack([pixels[by0:by1, bx0:bx1], np.where(touched[by0:by1, bx0:bx1], 255.0, 0.0)])
            file = f"cutout-{target['id']}.png"
            save(rgba, out / file)
            cx0, cy0 = region["view"][0], region["view"][1]
            cutouts[target["id"]] = {"file": file, "rect": [int(cx0 + bx0), int(cy0 + by0), int(cx0 + bx1), int(cy0 + by1)]}
            if target.get("outfit"):
                cutouts[target["id"]]["redressed"] = True

    # Pass 3: characters painted into free seats. The plate keeps the seat empty; the
    # cut-out is the fill itself, feathered into the room, and the mockup never shows it.
    for region in spec["regions"]:
        change = np.abs(fills[region["id"]] - region_view(base, region, origin)).max(axis=2)
        for target in (t for t in region["targets"] if t.get("kind") == "added"):
            weight = soft(target_mask(change, target["box"], region["view"]))
            ys, xs = np.nonzero(weight > BLEND_FLOOR)
            bx0, by0, bx1, by1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
            alpha = np.where(weight > BLEND_FLOOR, weight, 0.0)[by0:by1, bx0:bx1] * 255
            file = f"cutout-{target['id']}.png"
            save(np.dstack([fills[region["id"]][by0:by1, bx0:bx1], alpha]), out / file)
            cx0, cy0 = region["view"][0], region["view"][1]
            rect = [int(cx0 + bx0), int(cy0 + by0), int(cx0 + bx1), int(cy0 + by1)]
            cutouts[target["id"]] = {"file": file, "rect": rect, "added": True}

    save(plate, out / "plate.png")
    manifest = {
        "source": spec["source"],
        "viewport": spec["viewport"],
        "plate": {"file": "plate.png", "rect": spec["plate"]},
        "cutouts": cutouts,
        # The mockup's interface painted over the room, removed on purpose.
        "intended": intended,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    verify(spec, out, manifest)


def verify(spec: dict, out: Path, manifest: dict) -> None:
    """Everyone back in place must reproduce the base exactly, apart from the agents
    wearing a new outfit, and the base must be the mockup everywhere but the interface
    it removed."""
    source = rgb(root() / spec["source"])
    px0, py0, px1, py1 = spec["plate"]
    base = rgb(base_path(spec))
    scene = rgb(out / "plate.png")
    dressed = np.zeros(scene.shape[:2], dtype=bool)
    for cut in manifest["cutouts"].values():
        if cut.get("added"):
            continue
        x0, y0, x1, y1 = cut["rect"]
        layer = np.asarray(Image.open(out / cut["file"]).convert("RGBA"), dtype=np.float32)
        alpha = layer[..., 3:] / 255
        region = scene[y0 - py0:y1 - py0, x0 - px0:x1 - px0]
        region[:] = region * (1 - alpha) + layer[..., :3] * alpha
        if cut.get("redressed"):
            dressed[y0 - py0:y1 - py0, x0 - px0:x1 - px0] |= alpha[..., 0] > 0
    differs = np.abs(np.round(scene) - base).max(axis=2) > 1
    recomposed = int((differs & ~dressed).sum())
    off = np.abs(base - source[py0:py1, px0:px1]).max(axis=2) > 1
    for item in manifest["intended"]:
        x0, y0, x1, y1 = item["rect"]
        pad = MARGIN_RADIUS + 3
        off[max(y0 - py0 - pad, 0):y1 - py0 + pad, max(x0 - px0 - pad, 0):x1 - px0 + pad] = False
    added = sum(1 for cut in manifest["cutouts"].values() if cut.get("added"))
    print(f"{out.relative_to(root())}: plate + {len(manifest['cutouts'])} cut-outs ({added} painted in), {len(manifest['intended'])} interface removals; "
          f"{recomposed} px off when everyone's back, {int((differs & dressed).sum())} px in new outfits, "
          f"{int(off.sum())} px off the mockup outside the removed interface")
    if recomposed or off.sum():
        raise SystemExit("The room doesn't recompose to the mockup.")


def main() -> None:
    if len(sys.argv) < 3 or sys.argv[1] not in ("generate", "compose"):
        sys.exit(__doc__)
    spec = load_spec(sys.argv[2])
    if shutil.which("codex") is None and sys.argv[1] == "generate":
        sys.exit("Codex isn't installed.")
    if sys.argv[1] == "generate":
        generate(spec, sys.argv[3:])
    else:
        compose(spec)


if __name__ == "__main__":
    main()
