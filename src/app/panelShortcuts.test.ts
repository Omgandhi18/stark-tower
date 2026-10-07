import { describe, expect, it } from "vitest";
import { panelFor } from "./panelShortcuts";

const press = (mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>, code = "KeyB") => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("panelFor", () => {
  it("collapses the sidebar with ⌘B anywhere", () => {
    expect(panelFor(press({ metaKey: true }), "environment")).toBe("sidebar");
    expect(panelFor(press({ metaKey: true }), "task")).toBe("sidebar");
  });

  it("collapses a task's columns only while a task is on screen", () => {
    expect(panelFor(press({ metaKey: true, shiftKey: true }), "task")).toBe("taskLeft");
    expect(panelFor(press({ metaKey: true, altKey: true }), "task")).toBe("taskRight");
    expect(panelFor(press({ metaKey: true, shiftKey: true }), "work")).toBeNull();
    expect(panelFor(press({ metaKey: true, altKey: true }), "work")).toBeNull();
  });

  it("leaves other keys and combinations alone", () => {
    expect(panelFor(press({}), "task")).toBeNull();
    expect(panelFor(press({ ctrlKey: true }), "task")).toBeNull();
    expect(panelFor(press({ metaKey: true, ctrlKey: true }), "task")).toBeNull();
    expect(panelFor(press({ metaKey: true, altKey: true, shiftKey: true }), "task")).toBeNull();
    expect(panelFor(press({ metaKey: true }, "KeyN"), "task")).toBeNull();
  });
});
