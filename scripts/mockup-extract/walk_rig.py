#!/usr/bin/env python3
"""Animate a side-view walk cycle from a cut-out rig.

Generated sheets can't be trusted to draw a real gait (passing poses, feet that
stay planted), so the walk is posed procedurally instead. The character is cut
into torso, upper arm, forearm, thigh, shin and shoe from two side-view stills:
one with the near arm (the arm's source), one armless with the feet together
(everything else). Each frame then places those pieces from a gait model:

- a stance foot stays planted while the body passes over it, so moving the
  sprite `stride` px per cycle keeps it still on the floor;
- the heel strikes, the foot rolls flat, the heel lifts and the toe pushes off;
- knees come from two-bone IK and the hips ride as high as the stance legs allow;
- arms swing against the legs; far-side limbs are shaded and drawn behind.

Frames are scaled to scene height like sprite_sheet.py and written facing right
plus a mirrored set facing left, with a standing side view for turning into and
out of the walk. The animations (frames, fps, anchor, stride, startFrame) are
printed as JSON on the last line of stdout.

Usage:
    python3 scripts/mockup-extract/walk_rig.py <rig.json> <out-dir> <name> --height 165 [--preview <dir>]
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from sprite_sheet import PADDING, TORSO_BAND, chroma_alpha, despill

ROOT = Path(__file__).resolve().parents[2]
OPAQUE = 255.0
# IK never fully straightens a knee; a locked leg pops when it bends again.
MAX_EXTENSION = 0.998
# Samples per cycle when solving hip height, before picking the frames.
HIP_SAMPLES = 240
TOE_CLEARANCE = 3.0  # source px a swinging shoe keeps above the floor
FAR_LIMB_OFFSET = 0.5  # the far leg/arm run half a cycle apart from the near ones
SWING_LIFT_SKEW = 0.6  # < 1 moves the swing foot's highest point earlier (peaks at s = 0.5 ** (1 / skew))
LOADING_PEAK = 0.05  # cycle fraction after heel strike where the hips are lowest


@dataclass(frozen=True)
class Gait:
    frames: int
    fps: float
    stride: float  # source px the body travels per cycle (two steps)
    stance: float  # cycle fraction a foot spends on the floor
    stance_center: float  # ankle x relative to the hip at mid-stance, source px
    heel_strike: float  # toe-up degrees as the heel lands
    flat_at: float  # cycle fraction where the foot is flat after heel strike
    heel_rise: float  # cycle fraction where the heel starts to lift
    toe_off: float  # heel-up degrees as the toe leaves the floor
    lift: float  # extra ankle lift mid-swing, source px
    stance_knee: float  # knee bend of the supporting leg, degrees; sets how high the hips ride
    loading_drop: float  # source px the hips sink after heel strike as the leg takes the weight
    lean: float  # forward torso lean, degrees
    arm_swing: float  # shoulder swing amplitude, degrees
    arm_bias: float  # mean shoulder angle, degrees (+ = forward)
    arm_lag: float  # arm swing delay behind the legs, cycle fraction
    elbow_flex: float  # extra elbow bend at the front of the swing, degrees
    far_shade: float  # brightness of the far-side limbs


@dataclass
class Piece:
    image: np.ndarray  # premultiplied RGBA, float32 0..255
    pivot: np.ndarray  # rest position of the joint it hangs from


@dataclass
class Rig:
    torso: Piece
    upper_arm: Piece
    forearm: Piece
    thigh: Piece
    shin: Piece
    shoe: Piece
    hip: np.ndarray
    knee: np.ndarray
    ankle: np.ndarray
    shoulder: np.ndarray
    elbow: np.ndarray
    heel: np.ndarray  # heel contact point at rest
    ball: np.ndarray  # ball-of-foot contact point at rest
    ground: float
    top: float


@dataclass
class Foot:
    ankle: np.ndarray  # hip-relative x, absolute y
    pitch: float  # clockwise degrees: + heel up, - toe up


# --- geometry -----------------------------------------------------------------


def snake_case(name: str) -> str:
    return "".join(f"_{c.lower()}" if c.isupper() else c for c in name)


def vec(p) -> np.ndarray:
    return np.asarray(p, dtype=np.float64)


def rot(degrees: float) -> np.ndarray:
    """Rotation matrix, clockwise on screen (y points down)."""
    r = math.radians(degrees)
    c, s = math.cos(r), math.sin(r)
    return np.array([[c, -s], [s, c]])


def angle_of(v: np.ndarray) -> float:
    return math.degrees(math.atan2(v[1], v[0]))


def smoothstep(t: float) -> float:
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


# --- cutting the pieces -----------------------------------------------------------


def load_keyed(path: Path) -> np.ndarray:
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32)
    alpha = chroma_alpha(rgb)
    rgb = despill(rgb)
    return np.dstack([rgb * alpha[..., None], alpha * OPAQUE]).astype(np.float32)


def polygon_mask(shape: tuple[int, int], points) -> np.ndarray:
    img = Image.new("L", (shape[1], shape[0]), 0)
    ImageDraw.Draw(img).polygon([tuple(p) for p in points], fill=255)
    return np.asarray(img) > 0


def disk_mask(shape: tuple[int, int], center: np.ndarray, radius: float) -> np.ndarray:
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    return (xx + 0.5 - center[0]) ** 2 + (yy + 0.5 - center[1]) ** 2 <= radius**2


def rows_mask(shape: tuple[int, int], top: float, bottom: float) -> np.ndarray:
    yy = np.arange(shape[0])[:, None] + 0.5
    return np.broadcast_to((yy >= top) & (yy < bottom), shape)


def cut(image: np.ndarray, mask: np.ndarray, pivot: np.ndarray) -> Piece:
    return Piece(image * mask[..., None], pivot)


def fill_rows_down(image: np.ndarray, region: np.ndarray, source_row: int) -> np.ndarray:
    """Paint `region` with the colours of one row (opaque), e.g. trousers under a jacket hem."""
    out = image.copy()
    ys, xs = np.nonzero(region)
    out[ys, xs] = image[source_row, xs]
    out[ys, xs, 3] = OPAQUE
    return out


def fill_flat(image: np.ndarray, region: np.ndarray, sample: np.ndarray) -> np.ndarray:
    """Paint `region` with the median opaque colour found under `sample`."""
    out = image.copy()
    picked = image[sample & (image[..., 3] >= OPAQUE)]
    colour = np.median(picked[:, :3], axis=0)
    out[region, :3] = colour
    out[region, 3] = OPAQUE
    return out


def build_rig(spec: dict) -> Rig:
    arm_spec, body_spec = spec["arm"], spec["body"]
    arm_src = load_keyed(ROOT / arm_spec["source"])
    body = load_keyed(ROOT / body_spec["source"])
    shape = body.shape[:2]

    hip, knee, ankle = vec(body_spec["hip"]), vec(body_spec["knee"]), vec(body_spec["ankle"])
    shoulder, elbow = vec(arm_spec["shoulder"]), vec(arm_spec["elbow"])
    torso_bottom = body_spec["torsoBottom"]

    # Arm: polygon around the near arm, split at the elbow with a round cap on both halves.
    arm = polygon_mask(shape, arm_spec["polygon"])
    elbow_cap = disk_mask(shape, elbow, arm_spec["elbowRadius"]) & arm
    upper_arm = cut(arm_src, (arm & rows_mask(shape, 0, elbow[1])) | elbow_cap, shoulder)
    forearm = cut(arm_src, (arm & rows_mask(shape, elbow[1], shape[0])) | elbow_cap, elbow)

    # Torso: everything above the jacket hem (armless still).
    torso = cut(body, rows_mask(shape, 0, torso_bottom), hip)

    # Leg: below the hem. The hip and knee get round caps so rotations never open a gap;
    # the part of the hip cap hidden under the jacket is painted as trousers.
    hip_cap = disk_mask(shape, hip, body_spec["hipRadius"])
    knee_cap = disk_mask(shape, knee, body_spec["kneeRadius"])
    shoe = polygon_mask(shape, body_spec["shoe"])
    leg = fill_rows_down(body, hip_cap & rows_mask(shape, 0, torso_bottom), body_spec["trouserRow"])
    thigh = cut(leg, (rows_mask(shape, torso_bottom, knee[1]) & (leg[..., 3] > 0)) | hip_cap | knee_cap, hip)
    # Ankle under the shoe collar, so a tilting shoe shows ankle rather than a hole.
    ankle_fill = polygon_mask(shape, body_spec["ankleFill"])
    shin_src = fill_flat(leg, ankle_fill & ~(leg[..., 3] >= OPAQUE) | ankle_fill & shoe,
                         polygon_mask(shape, body_spec["skinSample"]))
    shin = cut(shin_src, (rows_mask(shape, knee[1], shape[0]) & ~shoe) | knee_cap | ankle_fill, knee)
    shoe_piece = cut(body, shoe, ankle)

    return Rig(
        torso=torso, upper_arm=upper_arm, forearm=forearm, thigh=thigh, shin=shin, shoe=shoe_piece,
        hip=hip, knee=knee, ankle=ankle, shoulder=shoulder, elbow=elbow,
        heel=vec(body_spec["heel"]), ball=vec(body_spec["ball"]),
        ground=float(body_spec["ground"]), top=float(body_spec["top"]),
    )


# --- gait ---------------------------------------------------------------------------


def stance_foot(q: float, gait: Gait, rig: Rig) -> Foot:
    """Planted foot at its own phase q in [0, stance): heel rocker, flat, heel rise."""
    heel_to_ankle = rig.ankle - rig.heel
    ball_to_ankle = rig.ankle - rig.ball
    # Where the heel lands (hip-relative) so the ankle passes `stance_center` at mid-stance.
    landing = gait.stance_center + gait.stride * gait.stance / 2 - heel_to_ankle[0]
    travelled = gait.stride * q  # the hip has moved on by this much since heel strike
    heel = vec([landing - travelled, rig.heel[1]])
    if q < gait.flat_at:
        pitch = -gait.heel_strike * (1 - smoothstep(q / gait.flat_at))
        return Foot(heel + rot(pitch) @ heel_to_ankle, pitch)
    if q < gait.heel_rise:
        return Foot(heel + heel_to_ankle, 0.0)
    ball = heel + (rig.ball - rig.heel)
    pitch = gait.toe_off * smoothstep((q - gait.heel_rise) / (gait.stance - gait.heel_rise))
    return Foot(ball + rot(pitch) @ ball_to_ankle, pitch)


def lowest_point(foot: Foot, rig: Rig, toe: np.ndarray) -> float:
    points = [rig.heel, rig.ball, toe]
    return max((foot.ankle + rot(foot.pitch) @ (p - rig.ankle))[1] for p in points)


def swing_foot(q: float, gait: Gait, rig: Rig, toe: np.ndarray) -> Foot:
    """Foot in the air, from toe-off to the next heel strike (world-space ease, so it
    leaves and lands with no horizontal speed)."""
    s = (q - gait.stance) / (1 - gait.stance)
    start = stance_foot(gait.stance - 1e-9, gait, rig)
    end = stance_foot(0.0, gait, rig)
    # Hip-relative → world: the hip has travelled stride * q since this foot's heel strike.
    start_x = start.ankle[0] + gait.stride * gait.stance
    end_x = end.ankle[0] + gait.stride
    x = lerp(start_x, end_x, smoothstep(s)) - gait.stride * q
    y = lerp(start.ankle[1], end.ankle[1], s) - gait.lift * math.sin(math.pi * s**SWING_LIFT_SKEW)
    pitch = gait.toe_off * (1 - smoothstep(s / 0.45)) - gait.heel_strike * smoothstep((s - 0.35) / 0.65)
    foot = Foot(vec([x, y]), pitch)
    # Clearance fades in and out so lift-off and heel strike still touch the floor.
    dip = lowest_point(foot, rig, toe) - (rig.ground - TOE_CLEARANCE * math.sin(math.pi * s))
    if dip > 0:
        foot.ankle = foot.ankle - vec([0, dip])
    return foot


def foot_at(q: float, gait: Gait, rig: Rig, toe: np.ndarray) -> Foot:
    q %= 1.0
    return stance_foot(q, gait, rig) if q < gait.stance else swing_foot(q, gait, rig, toe)


def leg_length(rig: Rig, knee_bend: float) -> float:
    """Hip-to-ankle distance with the knee bent by `knee_bend` degrees."""
    thigh = float(np.linalg.norm(rig.knee - rig.hip))
    shin = float(np.linalg.norm(rig.ankle - rig.knee))
    return math.sqrt(thigh**2 + shin**2 + 2 * thigh * shin * math.cos(math.radians(knee_bend)))


def hip_heights(gait: Gait, rig: Rig, toe: np.ndarray) -> np.ndarray:
    """Hip y per sample: the classic two-bumps-per-cycle path. Highest at mid-stance, with
    the supporting knee bent `stance_knee`; lowest just after each heel strike, where the
    landing leg can only just reach the floor. Never higher than a planted leg allows."""
    length = leg_length(rig, gait.stance_knee)

    def hip_over(ankle: np.ndarray) -> float:
        return float(ankle[1] - math.sqrt(max(length**2 - ankle[0] ** 2, 0.0)))

    high = hip_over(stance_foot(gait.stance / 2, gait, rig).ankle)
    low = hip_over(stance_foot(0.0, gait, rig).ankle) + gait.loading_drop
    phases = np.arange(HIP_SAMPLES) / HIP_SAMPLES
    path = high + (low - high) * (1 + np.cos(4 * math.pi * (phases - LOADING_PEAK))) / 2

    reach = (np.linalg.norm(rig.knee - rig.hip) + np.linalg.norm(rig.ankle - rig.knee)) * MAX_EXTENSION
    limit = np.full(HIP_SAMPLES, -math.inf)
    for i, p in enumerate(phases):
        for offset in (0.0, FAR_LIMB_OFFSET):
            q = (p + offset) % 1.0
            if q < gait.stance:
                a = stance_foot(q, gait, rig).ankle
                limit[i] = max(limit[i], a[1] - math.sqrt(max(reach**2 - a[0] ** 2, 0.0)))
    return np.maximum(path, limit)


def solve_knee(hip: np.ndarray, ankle: np.ndarray, thigh: float, shin: float) -> tuple[np.ndarray, np.ndarray]:
    """Two-bone IK with the knee bending forward (+x). Returns (knee, reachable ankle)."""
    to_ankle = ankle - hip
    d = float(np.linalg.norm(to_ankle))
    d_max = (thigh + shin) * MAX_EXTENSION
    if d > d_max:
        to_ankle *= d_max / d
        d = d_max
    u = to_ankle / d
    cos_a = (thigh**2 + d**2 - shin**2) / (2 * thigh * d)
    a = math.degrees(math.acos(min(max(cos_a, -1.0), 1.0)))
    # Rotating the hip→ankle direction anticlockwise on screen swings the knee forward.
    return hip + thigh * (rot(-a) @ u), hip + to_ankle


# --- posing & rendering ----------------------------------------------------------------


@dataclass
class Placement:
    piece: Piece
    at: np.ndarray
    angle: float  # clockwise degrees relative to the piece's rest orientation


def leg_placements(rig: Rig, hip: np.ndarray, foot: Foot) -> list[Placement]:
    thigh_len = float(np.linalg.norm(rig.knee - rig.hip))
    shin_len = float(np.linalg.norm(rig.ankle - rig.knee))
    knee, ankle = solve_knee(hip, foot.ankle, thigh_len, shin_len)
    thigh_angle = angle_of(knee - hip) - angle_of(rig.knee - rig.hip)
    shin_angle = angle_of(ankle - knee) - angle_of(rig.ankle - rig.knee)
    return [
        Placement(rig.shin, knee, shin_angle),
        Placement(rig.shoe, ankle, foot.pitch),
        Placement(rig.thigh, hip, thigh_angle),
    ]


def arm_placements(rig: Rig, torso_at: np.ndarray, torso_angle: float, swing: float, flex: float) -> list[Placement]:
    # Forward swing moves the hand to +x: anticlockwise on screen for a hanging limb.
    shoulder = torso_at + rot(torso_angle) @ (rig.shoulder - rig.hip)
    upper_angle = torso_angle - swing
    elbow = shoulder + rot(upper_angle) @ (rig.elbow - rig.shoulder)
    return [
        Placement(rig.forearm, elbow, upper_angle - flex),
        Placement(rig.upper_arm, shoulder, upper_angle),
    ]


def arm_angles(p: float, gait: Gait) -> tuple[float, float]:
    """Shoulder swing (+ forward) and extra elbow bend for an arm at leg phase p.
    At p = 0 the same-side leg lands in front, so this arm is at the back of its swing."""
    swing = gait.arm_bias - gait.arm_swing * math.cos(2 * math.pi * (p - gait.arm_lag))
    forwardness = (swing - (gait.arm_bias - gait.arm_swing)) / (2 * gait.arm_swing)
    return swing, gait.elbow_flex * forwardness


def shaded(placements: list[Placement], shade: float) -> list[Placement]:
    out = []
    for pl in placements:
        img = pl.piece.image.copy()
        img[..., :3] *= shade
        out.append(Placement(Piece(img, pl.piece.pivot), pl.at, pl.angle))
    return out


def pose(p: float, gait: Gait, rig: Rig, hips: np.ndarray, toe: np.ndarray, rest_x: float) -> list[Placement]:
    """Back-to-front placements for leg phase p (p = 0: near heel strike)."""
    hip_y = float(np.interp(p * HIP_SAMPLES, np.arange(HIP_SAMPLES + 1), np.append(hips, hips[0])))
    hip = vec([rest_x, hip_y])

    def leg(q: float) -> list[Placement]:
        foot = foot_at(q, gait, rig, toe)
        foot.ankle = foot.ankle + vec([rest_x, 0])
        return leg_placements(rig, hip, foot)

    far_swing, far_flex = arm_angles(p + FAR_LIMB_OFFSET, gait)
    near_swing, near_flex = arm_angles(p, gait)
    far = arm_placements(rig, hip, gait.lean, far_swing, far_flex) + leg(p + FAR_LIMB_OFFSET)
    near_leg = leg(p)
    near_arm = arm_placements(rig, hip, gait.lean, near_swing, near_flex)
    return shaded(far, gait.far_shade) + near_leg + [Placement(rig.torso, hip, gait.lean)] + near_arm


def rest_pose(rig: Rig) -> list[Placement]:
    return [
        Placement(rig.shin, rig.knee, 0.0), Placement(rig.shoe, rig.ankle, 0.0), Placement(rig.thigh, rig.hip, 0.0),
        Placement(rig.torso, rig.hip, 0.0), Placement(rig.forearm, rig.elbow, 0.0), Placement(rig.upper_arm, rig.shoulder, 0.0),
    ]


def bilinear(img: np.ndarray, sx: np.ndarray, sy: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    x0, y0 = np.floor(sx).astype(int), np.floor(sy).astype(int)
    fx, fy = (sx - x0)[..., None], (sy - y0)[..., None]

    def tap(yy, xx):
        ok = (xx >= 0) & (xx < w) & (yy >= 0) & (yy < h)
        out = np.zeros(xx.shape + (4,), dtype=np.float32)
        out[ok] = img[yy[ok], xx[ok]]
        return out

    return (tap(y0, x0) * (1 - fx) * (1 - fy) + tap(y0, x0 + 1) * fx * (1 - fy)
            + tap(y0 + 1, x0) * (1 - fx) * fy + tap(y0 + 1, x0 + 1) * fx * fy)


def composite(canvas: np.ndarray, pl: Placement) -> None:
    img = pl.piece.image
    ys, xs = np.nonzero(img[..., 3] > 0)
    if len(xs) == 0:
        return
    r = rot(pl.angle)
    corners = np.array([[xs.min(), ys.min()], [xs.max() + 1, ys.min()], [xs.min(), ys.max() + 1], [xs.max() + 1, ys.max() + 1]], float)
    moved = (corners - pl.piece.pivot) @ r.T + pl.at
    h, w = canvas.shape[:2]
    x0, y0 = np.maximum(np.floor(moved.min(axis=0)).astype(int) - 1, 0)
    x1, y1 = np.minimum(np.ceil(moved.max(axis=0)).astype(int) + 1, [w, h])
    gy, gx = np.mgrid[y0:y1, x0:x1] + 0.5
    inv = r.T  # inverse rotation
    dx, dy = gx - pl.at[0], gy - pl.at[1]
    sx = inv[0, 0] * dx + inv[0, 1] * dy + pl.piece.pivot[0] - 0.5
    sy = inv[1, 0] * dx + inv[1, 1] * dy + pl.piece.pivot[1] - 0.5
    src = np.clip(bilinear(img, sx, sy), 0, OPAQUE)
    dst = canvas[y0:y1, x0:x1]
    canvas[y0:y1, x0:x1] = src + dst * (1 - src[..., 3:4] / OPAQUE)


def render(placements: list[Placement], shape: tuple[int, int]) -> np.ndarray:
    canvas = np.zeros(shape + (4,), dtype=np.float32)
    for pl in placements:
        composite(canvas, pl)
    return canvas


def to_straight_image(premultiplied: np.ndarray) -> Image.Image:
    a = premultiplied[..., 3:4]
    rgb = np.where(a > 0, premultiplied[..., :3] * OPAQUE / np.maximum(a, 1e-6), 0)
    return Image.fromarray(np.clip(np.round(np.dstack([rgb, a])), 0, 255).astype(np.uint8))


# --- output ---------------------------------------------------------------------------


def torso_x(alpha: np.ndarray) -> float:
    """Same torso centre sprite_sheet.py uses, so walk and pose frames line up."""
    rows = np.nonzero((alpha > 127).any(axis=1))[0]
    h = rows.max() - rows.min() + 1
    band = alpha[rows.min() + int(h * TORSO_BAND[0]):rows.min() + int(h * TORSO_BAND[1])].astype(float)
    weights = band.sum(axis=0)
    return float((weights * np.arange(len(weights))).sum() / max(weights.sum(), 1e-6))


def passing_frame(gait: Gait, rig: Rig, toe: np.ndarray) -> int:
    """First-half frame where the swinging foot passes the planted one — the pose closest
    to standing, so walks start and stop on it (or half a cycle later)."""
    best, best_gap = 0, math.inf
    for i in range(gait.frames // 2):
        p = i / gait.frames
        feet = [(q % 1.0, foot_at(q, gait, rig, toe)) for q in (p, p + FAR_LIMB_OFFSET)]
        planted = [f for q, f in feet if q < gait.stance]
        swinging = [f for q, f in feet if q >= gait.stance]
        if len(planted) == 1 and len(swinging) == 1:
            gap = abs(swinging[0].ankle[0] - planted[0].ankle[0])
            if gap < best_gap:
                best, best_gap = i, gap
    return best


def crop_box(images: list[Image.Image], ground: float) -> tuple[int, int, int, int]:
    """One crop for every frame (so the cycle can't jitter), reaching down to the floor line."""
    union = np.any([np.asarray(im)[..., 3] > 0 for im in images], axis=0)
    ys, xs = np.nonzero(union)
    y1 = max(ys.max() + 1, math.ceil(ground)) + PADDING
    return int(xs.min() - PADDING), int(ys.min() - PADDING), int(xs.max() + 1 + PADDING), int(y1)


def save_pair(image: Image.Image, out: Path, right_name: str, left_name: str) -> None:
    image.save(out / right_name, optimize=True)
    image.transpose(Image.FLIP_LEFT_RIGHT).save(out / left_name, optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("rig")
    parser.add_argument("out_dir")
    parser.add_argument("name")
    parser.add_argument("--height", type=int, required=True, help="figure height in scene px")
    parser.add_argument("--preview", help="also write a contact sheet and GIF here")
    args = parser.parse_args()

    spec = json.loads(Path(args.rig).read_text())
    gait = Gait(**{snake_case(k): v for k, v in spec["gait"].items()})
    rig = build_rig(spec)
    toe = vec(spec["body"]["toe"])
    shape = rig.torso.image.shape[:2]
    hips = hip_heights(gait, rig, toe)

    scale = args.height / (rig.ground - rig.top)
    small = (round(shape[1] * scale), round(shape[0] * scale))

    def draw(placements: list[Placement]) -> Image.Image:
        return to_straight_image(render(placements, shape)).resize(small, Image.LANCZOS)

    frames = [draw(pose(i / gait.frames, gait, rig, hips, toe, rig.hip[0])) for i in range(gait.frames)]
    stand = draw(rest_pose(rig))
    box = crop_box(frames + [stand], rig.ground * scale)
    frames = [f.crop(box) for f in frames]
    stand = stand.crop(box)
    width = box[2] - box[0]
    anchor = [round(torso_x(np.asarray(stand)[..., 3])), round(rig.ground * scale - box[1])]
    mirrored = [width - anchor[0], anchor[1]]

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    right = [f"{args.name}-walk-right-{i}.png" for i in range(gait.frames)]
    left = [f"{args.name}-walk-left-{i}.png" for i in range(gait.frames)]
    for frame, r, l in zip(frames, right, left):
        save_pair(frame, out, r, l)
    side = (f"{args.name}-side-right.png", f"{args.name}-side-left.png")
    save_pair(stand, out, *side)

    stride = round(gait.stride * scale, 2)
    if args.preview:
        write_preview(Path(args.preview), frames, stand, gait, stride)
    walk = {"fps": gait.fps, "stride": stride, "startFrame": passing_frame(gait, rig, toe)}
    print(json.dumps({"animations": {
        "walkRight": {"frames": right, "anchor": anchor, **walk},
        "walkLeft": {"frames": left, "anchor": mirrored, **walk},
        "sideRight": {"frames": [side[0]], "fps": 1, "anchor": anchor},
        "sideLeft": {"frames": [side[1]], "fps": 1, "anchor": mirrored},
    }}))


def write_preview(out: Path, frames: list[Image.Image], stand: Image.Image, gait: Gait, stride: float) -> None:
    """Contact sheet (rest pose + every frame, 3x) and a GIF of the cycle moving at its
    real speed over a dashed floor, so sliding feet are easy to spot."""
    out.mkdir(parents=True, exist_ok=True)
    zoom = 3
    w, h = stand.size
    background = (54, 62, 74, 255)
    sheet = Image.new("RGBA", ((w + 4) * (len(frames) + 1), h), background)
    for i, f in enumerate([stand] + frames):
        sheet.alpha_composite(f, (i * (w + 4), 0))
    sheet.resize((sheet.width * zoom, sheet.height * zoom), Image.NEAREST).save(out / "walk-sheet.png")

    cycles = 2
    floor_w = round(w + stride * cycles)
    dash = 12
    gif = []
    for i in range(gait.frames * cycles):
        img = Image.new("RGBA", (floor_w, h + 2), background)
        d = ImageDraw.Draw(img)
        for x in range(0, floor_w, dash):
            d.line([(x, h - 3), (x + dash // 2, h - 3)], fill=(90, 100, 115, 255))
        img.alpha_composite(frames[i % gait.frames], (round(i * stride / gait.frames), 0))
        gif.append(img.resize((img.width * zoom, img.height * zoom), Image.NEAREST).convert("RGB"))
    gif[0].save(out / "walk.gif", save_all=True, append_images=gif[1:], duration=round(1000 / gait.fps), loop=0)


if __name__ == "__main__":
    main()
