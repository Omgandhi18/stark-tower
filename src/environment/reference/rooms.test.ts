import { describe, expect, it } from "vitest";
import { THEMES } from "../../app/theme";
import type { Agent } from "../../lib/types";
import { cardPlacement, helpersShown, layoutOf } from "./roomLayout";
import { hasRoom, roomFor } from "./rooms";
import { assignSlots, slotsOf } from "./slots";

const THEME_IDS = THEMES.map((t) => t.id);
const VIEW = { width: 1000, height: 700 };
const CARD = { width: 248, height: 64 };

const agent = (id: string, figure: string, kind: Agent["kind"] = "worker"): Agent => ({
  id,
  name: id.toUpperCase(),
  role: "",
  kind,
  engine: "claude-code",
  accent: "#ffffff",
  figure,
  home_x: 0,
  home_y: 0,
  status: "idle",
});

describe("every theme's room", () => {
  it("is built", () => {
    for (const id of THEME_IDS) expect(hasRoom(id), id).toBe(true);
  });

  it.each(THEME_IDS)("%s: names only stations, cut-outs and slots that exist", (id) => {
    const room = roomFor(id);
    const scene = room.scene;
    const slots = new Set(scene.slots.map((s) => s.id));
    // A slot's character is a painted station, or a seat whose character can get up (R&D's build bay).
    for (const slot of slots) expect(room.cutouts[scene.stations[slot]?.cutout ?? scene.actors?.[slot]?.seatCutout ?? ""], slot).toBeDefined();
    for (const slot of Object.keys(scene.stations)) expect(slots.has(slot), slot).toBe(true);
    for (const part of scene.helpers.flatMap((h) => h.parts)) expect(room.cutouts[part], part).toBeDefined();
    for (const [slot, light] of Object.entries(scene.lights)) if (typeof light !== "string") expect(slots.has(slot), slot).toBe(true);
    for (const slot of Object.keys(scene.tags ?? {})) expect(slots.has(slot), slot).toBe(true);
    for (const [slot, actor] of Object.entries(scene.actors ?? {})) {
      expect(slots.has(slot), slot).toBe(true);
      expect(room.cutouts[actor.seatCutout], actor.seatCutout).toBeDefined();
    }
    for (const slot of [scene.card.slot, scene.orchestratorSlot, scene.helperSlot]) if (slot) expect(slots.has(slot), slot).toBe(true);
  });

  it.each(THEME_IDS)("%s: keeps every cut-out and hit area inside the room", (id) => {
    const room = roomFor(id);
    const [x0, y0, x1, y1] = room.rect;
    for (const [name, cut] of Object.entries(room.cutouts)) {
      const [cx0, cy0, cx1, cy1] = cut.rect;
      expect(cx0 >= x0 && cy0 >= y0 && cx1 <= x1 && cy1 <= y1, name).toBe(true);
    }
    const { world } = layoutOf(room);
    for (const slot of slotsOf(room)) {
      expect(slot.hit[0] >= 0 && slot.hit[1] >= 0 && slot.hit[2] <= world.width && slot.hit[3] <= world.height, slot.id).toBe(true);
      expect(slot.head.y, slot.id).toBeLessThan(slot.hit[3]);
    }
  });
});

describe("seating", () => {
  const office = slotsOf(roomFor("office"));

  it("puts the orchestrator at the room's orchestrator station and everyone else by figure", () => {
    const seats = assignSlots([agent("jarvis", "engineer", "orchestrator"), agent("friday", "engineer"), agent("vision", "architect")], office, "glassOffice");
    expect(seats.get("glassOffice")?.id).toBe("jarvis");
    expect(seats.get("researchDesk")?.id).toBe("friday");
    expect(seats.get("armchair")?.id).toBe("vision");
  });

  it("seats agents without a painted figure in the stations left, and never maintenance bots", () => {
    const seats = assignSlots([agent("a", "engineer"), agent("b", "engineer"), agent("dum-e", "operative", "maintenance")], office, "glassOffice");
    expect([...seats.values()].map((a) => a.id).sort()).toEqual(["a", "b"]);
    expect(seats.get("researchDesk")?.id).toBe("a");
  });

  it("stops when the stations run out", () => {
    const crowd = Array.from({ length: office.length + 2 }, (_, i) => agent(`agent-${i}`, "engineer"));
    expect(assignSlots(crowd, office).size).toBe(office.length);
  });
});

describe("the agent card", () => {
  it("floats beside the head it labels, inside the view", () => {
    const card = { slot: "s", anchor: "head" as const, offset: [-83, -91] };
    expect(cardPlacement(card, { x: 300, y: 300 }, VIEW, CARD)).toEqual({ left: 217, top: 209 });
    expect(cardPlacement(card, { x: 20, y: 40 }, VIEW, CARD)).toEqual({ left: 0, top: 0 });
    expect(cardPlacement(card, { x: 990, y: 690 }, VIEW, CARD)).toEqual({ left: VIEW.width - CARD.width, top: 599 });
  });

  it("docks in the room's corner when the room says so", () => {
    expect(cardPlacement({ slot: "s", anchor: "top-right", inset: [15, 51] }, { x: 0, y: 0 }, VIEW, CARD)).toEqual({ right: 15, top: 51 });
    expect(cardPlacement({ slot: "s", anchor: "bottom-left", inset: [7, 30] }, { x: 0, y: 0 }, VIEW, CARD)).toEqual({ left: 7, bottom: 30 });
  });
});

describe("helper bots", () => {
  const seats = new Map([
    ["researchDesk", agent("friday", "engineer")],
    ["armchair", agent("vision", "architect")],
  ]);
  const helpers = { friday: 2, vision: 1 };

  it("stand for one station's helpers where the room says whose", () => {
    expect(helpersShown("researchDesk", seats, helpers)).toBe(2);
    expect(helpersShown("glassOffice", seats, helpers)).toBe(0);
  });

  it("stand for everyone's helpers otherwise", () => {
    expect(helpersShown(null, seats, helpers)).toBe(3);
  });
});
