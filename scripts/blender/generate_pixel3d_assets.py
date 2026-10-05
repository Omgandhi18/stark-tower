from __future__ import annotations

import math
from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "src" / "assets" / "3d" / "after-hours-rnd"
OUTPUT.mkdir(parents=True, exist_ok=True)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
        if datablocks is bpy.data.materials:
            continue
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def srgb_to_linear(channel: float) -> float:
    if channel <= 0.04045:
        return channel / 12.92
    return ((channel + 0.055) / 1.055) ** 2.4


def rgba(hex_color: str) -> tuple[float, float, float, float]:
    value = hex_color.lstrip("#")
    srgb = tuple(int(value[index:index + 2], 16) / 255 for index in (0, 2, 4))
    return tuple(srgb_to_linear(channel) for channel in srgb) + (1.0,)


def material(
    name: str,
    color: str,
    *,
    metallic: float = 0.0,
    roughness: float = 0.65,
    emission: str | None = None,
    emission_strength: float = 0.0,
    alpha: float = 1.0,
) -> bpy.types.Material:
    existing = bpy.data.materials.get(name)
    if existing:
        return existing
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*rgba(color)[:3], alpha)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = rgba(color)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        bsdf.inputs["Emission Color"].default_value = rgba(emission)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    if alpha < 1:
        bsdf.inputs["Alpha"].default_value = alpha
        mat.surface_render_method = "DITHERED"
    return mat


def assign(obj: bpy.types.Object, mat: bpy.types.Material) -> bpy.types.Object:
    obj.data.materials.append(mat)
    return obj


def cube(
    name: str,
    location: tuple[float, float, float],
    dimensions: tuple[float, float, float],
    mat: bpy.types.Material,
    *,
    bevel: float = 0.04,
    rotation: tuple[float, float, float] = (0, 0, 0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        modifier = obj.modifiers.new("EdgeSoftness", "BEVEL")
        modifier.width = min(bevel, min(dimensions) * 0.22)
        modifier.segments = 2
    return assign(obj, mat)


def cylinder(
    name: str,
    location: tuple[float, float, float],
    radius: float,
    depth: float,
    mat: bpy.types.Material,
    *,
    vertices: int = 12,
    rotation: tuple[float, float, float] = (0, 0, 0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    return assign(obj, mat)


def sphere(
    name: str,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    mat: bpy.types.Material,
    *,
    segments: int = 12,
    rings: int = 8,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return assign(obj, mat)


def empty(name: str, location: tuple[float, float, float], parent: bpy.types.Object | None = None) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 0.18
    obj.location = location
    bpy.context.scene.collection.objects.link(obj)
    if parent:
        obj.parent = parent
    return obj


def parent_keep_transform(child: bpy.types.Object, parent: bpy.types.Object) -> None:
    world = child.matrix_world.copy()
    child.parent = parent
    child.matrix_world = world


def optimize_static_tower() -> None:
    preserved_meshes = {"holo_core"}
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.name not in preserved_meshes]

    for obj in meshes:
        world = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = world
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        for modifier in list(obj.modifiers):
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.select_set(False)

    material_groups: dict[str, list[bpy.types.Object]] = {}
    for obj in meshes:
        material_name = obj.data.materials[0].name if obj.data.materials else "unmaterialed"
        material_groups.setdefault(material_name, []).append(obj)

    for material_name, objects in material_groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
        objects[0].name = f"tower_{material_name.lower()}"

    socket_prefixes = ("seat_", "station_")
    for obj in list(bpy.context.scene.objects):
        if obj.type == "EMPTY" and not obj.name.startswith(socket_prefixes):
            bpy.data.objects.remove(obj, do_unlink=True)


def glow_strip(name: str, location: tuple[float, float, float], dimensions: tuple[float, float, float], mat: bpy.types.Material) -> None:
    cube(name, location, dimensions, mat, bevel=0.012)


def floor_deck(name: str, location: tuple[float, float, float], size: tuple[float, float, float], floor_mat, edge_mat, cyan_mat) -> None:
    cube(f"{name}_slab", location, size, floor_mat, bevel=0.08)
    top_y = location[1] + size[1] / 2 + 0.008
    for x_index in range(1, max(2, int(size[0] / 0.8))):
        x = location[0] - size[0] / 2 + x_index * 0.8
        cube(f"{name}_grid_x_{x_index}", (x, top_y, location[2]), (0.012, 0.012, size[2] - 0.2), edge_mat, bevel=0)
    for z_index in range(1, max(2, int(size[2] / 0.8))):
        z = location[2] - size[2] / 2 + z_index * 0.8
        cube(f"{name}_grid_z_{z_index}", (location[0], top_y, z), (size[0] - 0.2, 0.012, 0.012), edge_mat, bevel=0)
    glow_strip(f"{name}_front_glow", (location[0], top_y + 0.02, location[2] + size[2] / 2 - 0.05), (size[0] - 0.16, 0.035, 0.045), cyan_mat)


def rail(name: str, location: tuple[float, float, float], length: float, metal_mat, glass_mat, *, rotate=False) -> None:
    root = empty(name, location)
    root.rotation_euler[1] = math.pi / 2 if rotate else 0
    cube(f"{name}_top", (0, 0.74, 0), (length, 0.07, 0.07), metal_mat, bevel=0.025).parent = root
    panel = cube(f"{name}_glass", (0, 0.42, 0), (length - 0.12, 0.55, 0.025), glass_mat, bevel=0.015)
    panel.parent = root
    count = max(2, math.ceil(length / 1.15))
    for index in range(count + 1):
        x = -length / 2 + index * length / count
        post = cube(f"{name}_post_{index}", (x, 0.38, 0), (0.065, 0.78, 0.08), metal_mat, bevel=0.02)
        post.parent = root


def stairs(name: str, location: tuple[float, float, float], steps: int, rise: float, dark_mat, glow_mat, *, rotation_y=0.0) -> None:
    root = empty(name, location)
    root.rotation_euler[1] = rotation_y
    for index in range(steps):
        height = ((index + 1) / steps) * rise
        step = cube(f"{name}_step_{index}", (0, height / 2, index * 0.34), (1.65, height, 0.36), dark_mat, bevel=0.025)
        step.parent = root
        strip = cube(f"{name}_light_{index}", (0, height + 0.018, index * 0.34 + 0.12), (1.48, 0.03, 0.05), glow_mat, bevel=0.01)
        strip.parent = root


def monitor(name: str, location: tuple[float, float, float], rotation_y: float, width: float, frame_mat, screen_mat, cyan_mat, amber_mat) -> None:
    root = empty(name, location)
    root.rotation_euler[1] = rotation_y
    body = cube(f"{name}_frame", (0, 0, 0), (width, 0.74, 0.1), frame_mat, bevel=0.045)
    body.parent = root
    screen = cube(f"{name}_screen", (0, 0, 0.058), (width - 0.1, 0.62, 0.018), screen_mat, bevel=0.025)
    screen.parent = root
    for index, y in enumerate((0.18, 0.06, -0.08, -0.21)):
        bar = cube(f"{name}_data_{index}", (-0.08 + index * 0.04, y, 0.071), (width * (0.46 + index * 0.07), 0.026, 0.01), amber_mat if index == 2 else cyan_mat, bevel=0)
        bar.parent = root
    stem = cube(f"{name}_stem", (0, -0.54, -0.02), (0.1, 0.34, 0.09), frame_mat, bevel=0.02)
    stem.parent = root


def desk(name: str, location: tuple[float, float, float], rotation_y: float, width: float, body_mat, top_mat, cyan_mat) -> None:
    root = empty(name, location)
    root.rotation_euler[1] = rotation_y
    top = cube(f"{name}_top", (0, 0.86, 0), (width, 0.16, 0.82), top_mat, bevel=0.07)
    top.parent = root
    for side in (-1, 1):
        leg = cube(f"{name}_leg_{side}", (side * (width / 2 - 0.2), 0.43, 0), (0.26, 0.86, 0.68), body_mat, bevel=0.045)
        leg.parent = root
    trim = cube(f"{name}_trim", (0, 0.95, 0.35), (width - 0.16, 0.03, 0.035), cyan_mat, bevel=0.01)
    trim.parent = root
    keyboard = cube(f"{name}_keyboard", (0, 0.98, 0.03), (0.72, 0.035, 0.27), body_mat, bevel=0.025)
    keyboard.parent = root


def chair(name: str, location: tuple[float, float, float], rotation_y: float, dark_mat, metal_mat) -> None:
    root = empty(name, location)
    root.rotation_euler[1] = rotation_y
    seat = cube(f"{name}_seat", (0, 0.62, -0.12), (0.72, 0.16, 0.68), dark_mat, bevel=0.09)
    seat.parent = root
    back = cube(f"{name}_back", (0, 1.04, -0.45), (0.74, 0.86, 0.15), dark_mat, bevel=0.09)
    back.parent = root
    post = cylinder(f"{name}_post", (0, 0.28, -0.1), 0.055, 0.55, metal_mat, vertices=10)
    post.parent = root
    base = cylinder(f"{name}_base", (0, 0.07, -0.1), 0.32, 0.06, metal_mat, vertices=8)
    base.parent = root


def server_rack(name: str, location: tuple[float, float, float], body_mat, cyan_mat, amber_mat) -> None:
    body = cube(name, (location[0], location[1] + 1.15, location[2]), (0.78, 2.3, 0.78), body_mat, bevel=0.055)
    for row in range(6):
        cube(f"{name}_slot_{row}", (location[0], location[1] + 0.35 + row * 0.31, location[2] + 0.405), (0.58, 0.16, 0.025), body_mat, bevel=0.012)
        for column in (-0.19, 0.19):
            cube(f"{name}_led_{row}_{column}", (location[0] + column, location[1] + 0.35 + row * 0.31, location[2] + 0.424), (0.07, 0.035, 0.012), amber_mat if (row + int(column > 0)) % 3 == 0 else cyan_mat, bevel=0)


def plant(name: str, location: tuple[float, float, float], pot_mat, leaf_a, leaf_b, scale=1.0) -> None:
    cube(f"{name}_pot", (location[0], location[1] + 0.3 * scale, location[2]), (0.55 * scale, 0.6 * scale, 0.55 * scale), pot_mat, bevel=0.06)
    for index, x in enumerate((-0.25, -0.1, 0.08, 0.23)):
        bpy.ops.mesh.primitive_cone_add(vertices=7, radius1=0.2 * scale, radius2=0.035, depth=0.7 * scale, location=(location[0] + x * scale, location[1] + (0.87 + (index % 2) * 0.13) * scale, location[2] + (index - 1.5) * 0.07 * scale))
        leaf = bpy.context.object
        leaf.name = f"{name}_leaf_{index}"
        leaf.rotation_euler[2] = x * 0.85
        assign(leaf, leaf_a if index % 2 else leaf_b)


def floor_inlays(name: str, center: tuple[float, float, float], size: tuple[float, float], metal_a, metal_b) -> None:
    width, depth = size
    x_count = max(2, int(width / 0.8))
    z_count = max(2, int(depth / 0.8))
    for x_index in range(x_count):
        for z_index in range(z_count):
            pattern = (x_index * 7 + z_index * 11) % 13
            if pattern not in (0, 3):
                continue
            x = center[0] - width / 2 + 0.4 + x_index * (width - 0.8) / max(1, x_count - 1)
            z = center[2] - depth / 2 + 0.4 + z_index * (depth - 0.8) / max(1, z_count - 1)
            cube(
                f"{name}_{x_index}_{z_index}",
                (x, center[1], z),
                (0.66, 0.018, 0.66),
                metal_a if pattern == 0 else metal_b,
                bevel=0.018,
            )


def glass_pod(name: str, center: tuple[float, float, float], width: float, depth: float, height: float, frame_mat, glass_mat, glow_mat) -> None:
    x, base_y, z = center
    half_width = width / 2
    half_depth = depth / 2
    for side_x in (-half_width, half_width):
        for side_z in (-half_depth, half_depth):
            cube(f"{name}_post_{side_x}_{side_z}", (x + side_x, base_y + height / 2, z + side_z), (0.11, height, 0.11), frame_mat, bevel=0.025)
    cube(f"{name}_roof_front", (x, base_y + height, z + half_depth), (width + 0.12, 0.11, 0.11), frame_mat, bevel=0.025)
    cube(f"{name}_roof_back", (x, base_y + height, z - half_depth), (width + 0.12, 0.11, 0.11), frame_mat, bevel=0.025)
    cube(f"{name}_roof_left", (x - half_width, base_y + height, z), (0.11, 0.11, depth), frame_mat, bevel=0.025)
    cube(f"{name}_roof_right", (x + half_width, base_y + height, z), (0.11, 0.11, depth), frame_mat, bevel=0.025)
    cube(f"{name}_glass_back", (x, base_y + height / 2, z - half_depth), (width - 0.13, height - 0.14, 0.035), glass_mat, bevel=0.012)
    cube(f"{name}_glass_left", (x - half_width, base_y + height / 2, z), (0.035, height - 0.14, depth - 0.13), glass_mat, bevel=0.012)
    cube(f"{name}_glass_right", (x + half_width, base_y + height / 2, z), (0.035, height - 0.14, depth - 0.13), glass_mat, bevel=0.012)
    glow_strip(f"{name}_base_light", (x, base_y + 0.025, z + half_depth), (width - 0.12, 0.035, 0.04), glow_mat)


def equipment_cart(name: str, location: tuple[float, float, float], body_mat, metal_mat, cyan_mat, amber_mat) -> None:
    x, y, z = location
    cube(f"{name}_body", (x, y + 0.5, z), (0.72, 0.86, 0.56), body_mat, bevel=0.055)
    for row in range(3):
        cube(f"{name}_drawer_{row}", (x, y + 0.35 + row * 0.23, z + 0.292), (0.56, 0.15, 0.025), metal_mat, bevel=0.012)
    cube(f"{name}_handle", (x, y + 1.0, z - 0.18), (0.76, 0.06, 0.08), metal_mat, bevel=0.02)
    for index, offset in enumerate((-0.22, 0, 0.22)):
        cylinder(f"{name}_canister_{index}", (x + offset, y + 1.11, z), 0.07, 0.26, cyan_mat if index != 1 else amber_mat, vertices=8)
    for side_x in (-0.25, 0.25):
        for side_z in (-0.18, 0.18):
            cylinder(f"{name}_wheel_{side_x}_{side_z}", (x + side_x, y + 0.05, z + side_z), 0.08, 0.06, body_mat, vertices=8, rotation=(math.pi / 2, 0, 0))


def deck_understructure(name: str, center: tuple[float, float, float], size: tuple[float, float], depth: float, structure_mat, glow_mat) -> None:
    x, top_y, z = center
    width, length = size
    bottom_y = top_y - depth
    cube(f"{name}_fascia_front", (x, top_y - depth / 2, z + length / 2), (width, depth, 0.22), structure_mat, bevel=0.035)
    cube(f"{name}_fascia_left", (x - width / 2, top_y - depth / 2, z), (0.22, depth, length), structure_mat, bevel=0.035)
    cube(f"{name}_light_front", (x, top_y - depth * 0.34, z + length / 2 + 0.12), (width - 0.35, 0.055, 0.025), glow_mat, bevel=0.01)
    for offset in (-width * 0.34, 0, width * 0.34):
        cube(f"{name}_rib_{offset}", (x + offset, bottom_y, z), (0.18, 0.22, length - 0.3), structure_mat, bevel=0.025)


def wall_panels(name: str, center: tuple[float, float, float], width: float, height: float, structure_mat, inset_mat, glow_mat) -> None:
    x, y, z = center
    cube(f"{name}_body", center, (width, height, 0.24), structure_mat, bevel=0.07)
    columns = max(3, int(width / 0.85))
    for index in range(columns):
        panel_width = width / columns - 0.08
        panel_x = x - width / 2 + panel_width / 2 + 0.04 + index * width / columns
        cube(f"{name}_panel_{index}", (panel_x, y, z + 0.132), (panel_width, height - 0.28, 0.025), inset_mat, bevel=0.025)
        if index % 2 == 0:
            glow_strip(f"{name}_light_{index}", (panel_x + panel_width / 2 - 0.045, y, z + 0.152), (0.035, height - 0.4, 0.018), glow_mat)


def create_tower() -> None:
    clear_scene()
    floor_mat = material("Floor", "#3b5c68", metallic=0.2, roughness=0.42)
    grid_mat = material("FloorGrid", "#718d96", metallic=0.12, roughness=0.48)
    floor_inset_a = material("FloorInsetA", "#496a75", metallic=0.24, roughness=0.34)
    floor_inset_b = material("FloorInsetB", "#2b454f", metallic=0.2, roughness=0.4)
    structure = material("Structure", "#24373f", metallic=0.3, roughness=0.4)
    structure_light = material("StructureLight", "#647b84", metallic=0.34, roughness=0.34)
    panel_inset = material("PanelInset", "#18272d", metallic=0.22, roughness=0.48)
    dark = material("Dark", "#0e171c", metallic=0.22, roughness=0.58)
    cyan = material("CyanGlow", "#29cced", emission="#29cced", emission_strength=5.0, roughness=0.28)
    amber = material("AmberGlow", "#f6a23d", emission="#f6a23d", emission_strength=4.5, roughness=0.3)
    screen = material("Screen", "#0a4356", emission="#0ba2cb", emission_strength=1.5, roughness=0.25)
    review_screen = material("ReviewScreen", "#082f3c", emission="#087694", emission_strength=0.58, roughness=0.3)
    glass = material("Glass", "#133845", metallic=0.08, roughness=0.08, alpha=0.2)
    green_a = material("LeavesA", "#2fc18a", roughness=0.9)
    green_b = material("LeavesB", "#176f55", roughness=0.9)

    floor_deck("lower", (0, -0.18, 2.05), (12.4, 0.36, 6.5), floor_mat, grid_mat, cyan)
    floor_deck("middle", (0, 0.82, -1.05), (12.5, 0.36, 7.0), floor_mat, grid_mat, amber)
    floor_deck("command", (0, 2.82, -3.05), (6.2, 0.36, 4.1), floor_mat, grid_mat, amber)
    floor_deck("lounge", (-4.7, 1.82, -3.0), (3.3, 0.36, 3.1), floor_mat, grid_mat, amber)
    floor_inlays("lower_tile", (0, 0.012, 2.05), (12.0, 6.1), floor_inset_a, floor_inset_b)
    floor_inlays("middle_tile", (0, 1.012, -1.05), (12.1, 6.6), floor_inset_a, floor_inset_b)
    floor_inlays("command_tile", (0, 3.012, -3.05), (5.8, 3.7), floor_inset_a, floor_inset_b)
    deck_understructure("lower_support", (0, -0.02, 2.05), (12.4, 6.5), 0.62, structure, cyan)
    deck_understructure("middle_support", (0, 0.98, -1.05), (12.5, 7.0), 0.7, structure, amber)
    deck_understructure("command_support", (0, 2.98, -3.05), (6.2, 4.1), 0.78, structure, amber)

    stairs("lower_stairs", (-3.1, 0, 0.7), 8, 1.0, structure, amber, rotation_y=math.pi)
    stairs("command_stairs", (-2.35, 1.0, -1.55), 10, 2.0, structure, amber, rotation_y=math.pi)
    rail("middle_front", (2.7, 1.02, 2.37), 6.8, structure_light, glass)
    rail("middle_right", (6.08, 1.02, -1.05), 6.8, structure_light, glass, rotate=True)
    rail("middle_left", (-6.08, 1.02, -1.05), 6.8, structure_light, glass, rotate=True)
    rail("middle_back_left", (-4.35, 1.02, -4.48), 3.2, structure_light, glass)
    rail("middle_back_right", (4.35, 1.02, -4.48), 3.2, structure_light, glass)
    rail("command_front", (0, 3.02, -1.08), 6.05, structure_light, glass)
    rail("command_right", (3.02, 3.02, -3.05), 3.9, structure_light, glass, rotate=True)
    rail("command_left", (-3.02, 3.02, -3.05), 3.9, structure_light, glass, rotate=True)
    rail("lounge_front", (-4.7, 2.02, -1.5), 3.15, structure_light, glass)
    rail("lower_front_left", (-3.85, 0.02, 5.24), 4.3, structure_light, glass)
    rail("lower_front_right", (3.85, 0.02, 5.24), 4.3, structure_light, glass)
    rail("lower_right", (6.08, 0.02, 3.35), 3.7, structure_light, glass, rotate=True)

    wall_panels("command_backdrop", (0, 4.55, -5.02), 6.15, 3.25, structure, panel_inset, amber)

    for index, position in enumerate(((-6.05, -0.18, 4.85), (6.05, -0.18, 4.85), (-6.05, -0.18, -4.35), (6.05, -0.18, -4.35), (-3.05, 0.82, -4.75), (3.05, 0.82, -4.75))):
        height = 4.8 if index < 2 else 6.6 if index < 4 else 4.9
        cube(f"pillar_{index}", (position[0], position[1] + height / 2, position[2]), (0.46, height, 0.46), structure, bevel=0.055)
        glow_strip(f"pillar_light_{index}", (position[0], position[1] + height / 2, position[2] + 0.245), (0.075, height - 0.24, 0.025), amber)

    desk("command_desk", (0, 3.05, -2.1), 0, 3.5, structure, structure_light, cyan)
    chair("jarvis_chair", (0.65, 3.05, -1.55), -0.25, dark, structure_light)
    monitor("command_monitor_l", (-1.08, 4.08, -2.78), 0.22, 1.55, dark, screen, cyan, amber)
    monitor("command_monitor_c", (0, 4.18, -2.92), 0, 1.6, dark, screen, cyan, amber)
    monitor("command_monitor_r", (1.08, 4.08, -2.78), -0.22, 1.55, dark, screen, cyan, amber)

    cube("build_bay_pad", (-4.25, 0.035, 2.55), (4.25, 0.05, 2.5), floor_inset_b, bevel=0.08)
    glow_strip("build_bay_pad_front", (-4.25, 0.07, 3.77), (4.05, 0.035, 0.045), cyan)
    glow_strip("build_bay_pad_left", (-6.32, 0.07, 2.55), (0.045, 0.035, 2.3), cyan)
    desk("friday_desk", (-4.25, 0.05, 1.58), math.pi, 3.4, structure, structure_light, cyan)
    chair("friday_chair", (-4.25, 0.05, 2.55), math.pi, dark, structure_light)
    monitor("friday_monitor_l", (-5.3, 1.12, 1.88), math.pi - 0.22, 1.35, dark, screen, cyan, amber)
    monitor("friday_monitor_c", (-4.25, 1.22, 1.72), math.pi, 1.5, dark, screen, cyan, amber)
    monitor("friday_monitor_r", (-3.2, 1.12, 1.88), math.pi + 0.22, 1.35, dark, screen, cyan, amber)
    equipment_cart("tool_cart", (-5.55, 1.02, -0.2), dark, structure_light, cyan, amber)

    cube("review_wall_frame", (5.05, 2.25, -0.55), (0.18, 2.2, 3.85), dark, bevel=0.08)
    cube("review_wall_screen", (5.155, 2.25, -0.55), (0.02, 2.0, 3.64), review_screen, bevel=0.035)
    for index in range(6):
        cube(f"review_data_{index}", (5.175, 2.78 - index * 0.24, -1.15 + index * 0.16), (0.012, 0.045, 1.55 + index * 0.18), amber if index == 2 else cyan, bevel=0)

    for index, z in enumerate((1.85, 2.68, 3.51, 4.34)):
        server_rack(f"server_{index}", (5.05, 0.05, z), dark, cyan, amber)

    sofa_root = empty("lounge_sofa", (-4.7, 2.05, -3.0))
    cube("sofa_seat", (0, 0.48, 0.25), (2.1, 0.55, 0.86), structure_light, bevel=0.14).parent = sofa_root
    cube("sofa_back", (0, 1.0, -0.15), (2.12, 1.05, 0.28), structure_light, bevel=0.14).parent = sofa_root
    cylinder("lounge_lamp_stem", (-3.45, 2.58, -2.75), 0.035, 1.0, structure_light, vertices=10)
    sphere("lounge_lamp", (-3.45, 3.22, -2.75), (0.24, 0.19, 0.24), amber, segments=10, rings=6)
    glass_pod("lounge_pod", (-4.7, 2.02, -3.0), 2.9, 2.6, 2.45, structure_light, glass, amber)
    cube("lounge_pillow_a", (-5.1, 2.72, -3.18), (0.5, 0.42, 0.18), floor_inset_a, bevel=0.1, rotation=(0, 0, -0.12))
    cube("lounge_pillow_b", (-4.55, 2.7, -3.2), (0.48, 0.38, 0.18), floor_inset_b, bevel=0.1, rotation=(0, 0, 0.1))
    cylinder("lounge_mug", (-3.95, 2.64, -2.45), 0.1, 0.22, cyan, vertices=10)

    cylinder("holo_base", (5.25, 0.27, 0.95), 1.02, 0.42, structure, vertices=16)
    cylinder("holo_glass", (5.25, 1.25, 0.95), 0.72, 1.85, glass, vertices=20)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.38, location=(5.25, 1.35, 0.95))
    core = bpy.context.object
    core.name = "holo_core"
    assign(core, cyan)

    plant("plant_command", (-2.55, 3.02, -4.05), structure_light, green_a, green_b, 0.9)
    plant("plant_middle", (2.65, 1.02, -2.2), structure_light, green_a, green_b, 0.95)
    plant("plant_lower_a", (-1.7, 0.02, 3.45), structure_light, green_a, green_b, 0.85)
    plant("plant_lower_b", (2.2, 0.02, 4.2), structure_light, green_a, green_b, 0.8)
    plant("plant_lounge", (-5.8, 2.02, -3.85), structure_light, green_a, green_b, 0.65)
    plant("plant_review", (4.25, 1.02, -2.55), structure_light, green_a, green_b, 0.72)

    for name, location, rotation_y in (
        ("seat_jarvis", (0.65, 3.05, -1.55), -0.25),
        ("seat_friday", (-4.25, 0.05, 2.55), math.pi),
        ("seat_veronica", (-4.7, 2.05, -2.75), 0),
        ("station_vision", (3.7, 1.05, -0.55), math.pi / 2),
        ("station_edith", (-0.65, 0.05, 3.25), math.pi),
        ("station_karen", (3.75, 0.05, 3.1), math.pi / 2),
        ("station_dum_e", (0.85, 0.05, 3.45), -math.pi / 4),
    ):
        socket = empty(name, location)
        socket.rotation_euler[1] = rotation_y

    optimize_static_tower()

    bpy.ops.export_scene.gltf(
        filepath=str(OUTPUT / "tower.glb"),
        export_format="GLB",
        export_yup=False,
        export_apply=True,
        export_cameras=False,
        export_lights=False,
    )


CHARACTERS = {
    "jarvis": {"skin": "#a96545", "hair": "#151619", "uniform": "#172b34", "accent": "#35dcff", "hair_style": "short"},
    "friday": {"skin": "#a96145", "hair": "#111419", "uniform": "#142b31", "accent": "#36d9e9", "hair_style": "ponytail"},
    "vision": {"skin": "#7d4a35", "hair": "#241916", "uniform": "#302a35", "accent": "#ef65c3", "hair_style": "bald"},
    "edith": {"skin": "#a8684a", "hair": "#8c3f27", "uniform": "#183128", "accent": "#5de7ba", "hair_style": "bob"},
    "karen": {"skin": "#a66b51", "hair": "#40271f", "uniform": "#2b2b38", "accent": "#b88cff", "hair_style": "bob"},
    "veronica": {"skin": "#633823", "hair": "#171215", "uniform": "#302c29", "accent": "#ffad55", "hair_style": "braids"},
}


def create_character(identity: str, spec: dict[str, str]) -> None:
    clear_scene()
    skin = material(f"{identity}_skin", spec["skin"], roughness=0.82)
    hair = material(f"{identity}_hair", spec["hair"], roughness=0.92)
    uniform = material(f"{identity}_uniform", spec["uniform"], metallic=0.12, roughness=0.7)
    dark = material(f"{identity}_dark", "#11181e", metallic=0.18, roughness=0.66)
    inner = material(f"{identity}_inner", "#26333a", metallic=0.08, roughness=0.76)
    hardware = material(f"{identity}_hardware", "#73838b", metallic=0.7, roughness=0.28)
    accent = material(f"{identity}_accent", spec["accent"], emission=spec["accent"], emission_strength=2.2, roughness=0.36)
    eye = material(f"{identity}_eyes", "#15100e", roughness=0.8)

    root = empty("rig_root", (0, 0, 0))
    hips = empty("hips", (0, 0.74, 0), root)
    spine = empty("spine", (0, 0.42, 0), hips)
    head_joint = empty("head_joint", (0, 0.55, 0), spine)
    arm_l = empty("arm_l", (-0.42, 0.29, 0), spine)
    arm_r = empty("arm_r", (0.42, 0.29, 0), spine)
    forearm_l = empty("forearm_l", (0, -0.42, 0), arm_l)
    forearm_r = empty("forearm_r", (0, -0.42, 0), arm_r)
    thigh_l = empty("thigh_l", (-0.18, 0, 0), hips)
    thigh_r = empty("thigh_r", (0.18, 0, 0), hips)
    shin_l = empty("shin_l", (0, -0.42, 0), thigh_l)
    shin_r = empty("shin_r", (0, -0.42, 0), thigh_r)

    torso = cube("torso_mesh", (0, 1.18, 0), (0.7, 0.68, 0.38), uniform, bevel=0.1)
    parent_keep_transform(torso, spine)
    shirt_panel = cube("shirt_panel", (0, 1.18, 0.207), (0.28, 0.58, 0.035), inner, bevel=0.02)
    parent_keep_transform(shirt_panel, spine)
    for side in (-1, 1):
        lapel = cube(f"lapel_{side}", (side * 0.16, 1.34, 0.23), (0.18, 0.32, 0.035), uniform, bevel=0.018, rotation=(0, 0, side * 0.34))
        parent_keep_transform(lapel, spine)
        shoulder = cube(f"shoulder_pad_{side}", (side * 0.39, 1.35, 0), (0.18, 0.2, 0.42), uniform, bevel=0.055)
        parent_keep_transform(shoulder, spine)
    waist = cube("waist_mesh", (0, 0.79, 0), (0.56, 0.24, 0.36), dark, bevel=0.07)
    parent_keep_transform(waist, hips)
    belt = cube("belt", (0, 0.88, 0.2), (0.58, 0.1, 0.055), dark, bevel=0.015)
    parent_keep_transform(belt, hips)
    buckle = cube("belt_buckle", (0, 0.88, 0.235), (0.12, 0.11, 0.035), hardware, bevel=0.018)
    parent_keep_transform(buckle, hips)
    chest_light = cube("chest_light", (0, 1.2, 0.205), (0.085, 0.5, 0.035), accent, bevel=0.012)
    parent_keep_transform(chest_light, spine)

    head = cube("head_mesh", (0, 1.78, 0), (0.52, 0.62, 0.5), skin, bevel=0.12)
    parent_keep_transform(head, head_joint)
    for side in (-1, 1):
        eye_obj = cube(f"eye_{side}", (side * 0.105, 1.82, 0.276), (0.055, 0.045, 0.025), eye, bevel=0.008)
        parent_keep_transform(eye_obj, head_joint)
        brow = cube(f"brow_{side}", (side * 0.105, 1.9, 0.282), (0.12, 0.025, 0.018), hair, bevel=0.006, rotation=(0, 0, side * -0.05))
        parent_keep_transform(brow, head_joint)
        ear = cube(f"ear_{side}", (side * 0.285, 1.78, 0), (0.06, 0.15, 0.11), skin, bevel=0.025)
        parent_keep_transform(ear, head_joint)
    nose = cube("nose", (0, 1.75, 0.29), (0.07, 0.1, 0.055), skin, bevel=0.02)
    parent_keep_transform(nose, head_joint)
    mouth = cube("mouth", (0, 1.63, 0.285), (0.16, 0.025, 0.018), hair if identity == "jarvis" else dark, bevel=0.006)
    parent_keep_transform(mouth, head_joint)

    style = spec["hair_style"]
    if style != "bald":
        hair_cap = sphere("hair_cap", (0, 1.98, -0.035), (0.3, 0.22, 0.3), hair, segments=8, rings=5)
        parent_keep_transform(hair_cap, head_joint)
        for index, x in enumerate((-0.22, -0.08, 0.08, 0.22)):
            lock = cube(f"hair_lock_{index}", (x, 1.99 - (index % 2) * 0.045, 0.19), (0.13, 0.25, 0.12), hair, bevel=0.045, rotation=(0, 0, (index - 1.5) * 0.12))
            parent_keep_transform(lock, head_joint)
    if style == "ponytail":
        pony = sphere("ponytail", (0, 1.72, -0.32), (0.18, 0.28, 0.16), hair, segments=9, rings=6)
        parent_keep_transform(pony, head_joint)
    elif style == "bob":
        for side in (-1, 1):
            bob = sphere(f"bob_{side}", (side * 0.24, 1.75, -0.05), (0.13, 0.3, 0.2), hair, segments=9, rings=6)
            parent_keep_transform(bob, head_joint)
    elif style == "braids":
        for index, x in enumerate((-0.22, -0.11, 0, 0.11, 0.22)):
            braid = cylinder(f"braid_{index}", (x, 1.62 - (index % 2) * 0.05, -0.22), 0.035, 0.72, hair, vertices=6)
            parent_keep_transform(braid, head_joint)

    if identity == "jarvis":
        beard = cube("beard", (0, 1.65, 0.245), (0.36, 0.14, 0.06), hair, bevel=0.03)
        parent_keep_transform(beard, head_joint)
    if identity in ("jarvis", "vision"):
        bridge = cube("glasses_bridge", (0, 1.82, 0.31), (0.12, 0.035, 0.025), hardware, bevel=0.006)
        parent_keep_transform(bridge, head_joint)
        for side in (-1, 1):
            lens_top = cube(f"glasses_top_{side}", (side * 0.14, 1.87, 0.31), (0.2, 0.025, 0.025), hardware, bevel=0.005)
            lens_bottom = cube(f"glasses_bottom_{side}", (side * 0.14, 1.77, 0.31), (0.2, 0.025, 0.025), hardware, bevel=0.005)
            lens_outer = cube(f"glasses_outer_{side}", (side * 0.235, 1.82, 0.31), (0.025, 0.12, 0.025), hardware, bevel=0.005)
            for glasses_piece in (lens_top, lens_bottom, lens_outer):
                parent_keep_transform(glasses_piece, head_joint)

    for side, joint, forearm in ((-1, arm_l, forearm_l), (1, arm_r, forearm_r)):
        upper = cube(f"upper_arm_{side}", (side * 0.42, 1.18, 0), (0.22, 0.58, 0.24), uniform, bevel=0.07)
        parent_keep_transform(upper, joint)
        accent_band = cube(f"arm_band_{side}", (side * 0.42, 1.05, 0.13), (0.235, 0.075, 0.035), accent, bevel=0.01)
        parent_keep_transform(accent_band, joint)
        lower = cube(f"forearm_mesh_{side}", (side * 0.42, 0.82, 0), (0.2, 0.45, 0.22), uniform, bevel=0.06)
        parent_keep_transform(lower, forearm)
        hand = sphere(f"hand_{side}", (side * 0.42, 0.55, 0), (0.11, 0.13, 0.11), skin, segments=8, rings=5)
        parent_keep_transform(hand, forearm)

    for side, thigh, shin in ((-1, thigh_l, shin_l), (1, thigh_r, shin_r)):
        upper_leg = cube(f"thigh_mesh_{side}", (side * 0.18, 0.5, 0), (0.27, 0.64, 0.3), uniform, bevel=0.07)
        parent_keep_transform(upper_leg, thigh)
        lower_leg = cube(f"shin_mesh_{side}", (side * 0.18, 0.18, 0), (0.25, 0.55, 0.28), dark, bevel=0.065)
        parent_keep_transform(lower_leg, shin)
        knee = cube(f"knee_pad_{side}", (side * 0.18, 0.4, 0.17), (0.19, 0.16, 0.055), hardware, bevel=0.035)
        parent_keep_transform(knee, shin)
        boot = cube(f"boot_{side}", (side * 0.18, 0.04, 0.13), (0.31, 0.17, 0.48), dark, bevel=0.06)
        parent_keep_transform(boot, shin)
        sole = cube(f"sole_{side}", (side * 0.18, -0.035, 0.15), (0.33, 0.055, 0.5), accent, bevel=0.015)
        parent_keep_transform(sole, shin)

    bpy.ops.export_scene.gltf(
        filepath=str(OUTPUT / f"agent-{identity}.glb"),
        export_format="GLB",
        export_yup=False,
        export_apply=True,
        export_cameras=False,
        export_lights=False,
    )


def create_dum_e() -> None:
    clear_scene()
    shell = material("dum_e_shell", "#637680", metallic=0.42, roughness=0.46)
    dark = material("dum_e_dark", "#162229", metallic=0.34, roughness=0.55)
    joint = material("dum_e_joint", "#91a5ae", metallic=0.74, roughness=0.28)
    cyan = material("dum_e_cyan", "#39ddff", emission="#39ddff", emission_strength=3.2, roughness=0.24)
    amber = material("dum_e_amber", "#ffad4f", emission="#ffad4f", emission_strength=2.4, roughness=0.3)

    root = empty("rig_root", (0, 0, 0))
    body_joint = empty("body_joint", (0, 0.58, 0), root)
    head_joint = empty("head_joint", (0, 0.5, 0), body_joint)
    arm_joint = empty("arm_joint", (0.36, 0.2, 0), body_joint)
    claw_joint = empty("claw_joint", (0, 0.55, 0), arm_joint)

    body = cube("body", (0, 0.58, 0), (0.72, 0.58, 0.55), shell, bevel=0.11)
    parent_keep_transform(body, body_joint)
    belly = cube("belly_panel", (0, 0.57, 0.294), (0.48, 0.3, 0.035), dark, bevel=0.035)
    parent_keep_transform(belly, body_joint)
    status = cube("status_bar", (0, 0.69, 0.317), (0.31, 0.055, 0.018), amber, bevel=0.01)
    parent_keep_transform(status, body_joint)

    for side in (-1, 1):
        wheel = cylinder(
            f"wheel_{side}",
            (side * 0.29, 0.2, 0.02),
            0.2,
            0.16,
            dark,
            vertices=12,
            rotation=(0, math.pi / 2, 0),
        )
        parent_keep_transform(wheel, root)
        hub = cylinder(
            f"hub_{side}",
            (side * 0.378, 0.2, 0.02),
            0.075,
            0.02,
            cyan,
            vertices=10,
            rotation=(0, math.pi / 2, 0),
        )
        parent_keep_transform(hub, root)

    neck = cylinder("neck", (0, 0.94, 0), 0.075, 0.32, joint, vertices=10)
    parent_keep_transform(neck, body_joint)
    head = cube("head", (0, 1.18, 0), (0.56, 0.38, 0.46), dark, bevel=0.09)
    parent_keep_transform(head, head_joint)
    lens_outer = cylinder("lens_outer", (0, 1.18, 0.245), 0.135, 0.04, joint, vertices=12, rotation=(math.pi / 2, 0, 0))
    parent_keep_transform(lens_outer, head_joint)
    lens = cylinder("lens", (0, 1.18, 0.27), 0.08, 0.025, cyan, vertices=12, rotation=(math.pi / 2, 0, 0))
    parent_keep_transform(lens, head_joint)

    upper_arm = cylinder("arm_upper", (0.36, 0.99, 0), 0.08, 0.62, shell, vertices=8)
    parent_keep_transform(upper_arm, arm_joint)
    elbow = sphere("arm_elbow", (0.36, 1.31, 0), (0.13, 0.13, 0.13), joint, segments=8, rings=5)
    parent_keep_transform(elbow, arm_joint)
    forearm = cylinder("arm_forearm", (0.36, 1.56, 0), 0.07, 0.44, shell, vertices=8)
    parent_keep_transform(forearm, claw_joint)
    for side in (-1, 1):
        claw = cube(f"claw_{side}", (0.36 + side * 0.09, 1.83, 0), (0.08, 0.25, 0.1), dark, bevel=0.025)
        claw.rotation_euler[2] = side * 0.28
        parent_keep_transform(claw, claw_joint)

    bpy.ops.export_scene.gltf(
        filepath=str(OUTPUT / "agent-dum-e.glb"),
        export_format="GLB",
        export_yup=False,
        export_apply=True,
        export_cameras=False,
        export_lights=False,
    )


if __name__ == "__main__":
    create_tower()
    for character_id, character_spec in CHARACTERS.items():
        create_character(character_id, character_spec)
    create_dum_e()
    print(f"Generated production assets in {OUTPUT}")
