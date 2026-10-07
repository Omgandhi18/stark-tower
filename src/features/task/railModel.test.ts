import { describe, expect, it } from "vitest";
import { clampRailWidth, isPreviewTab, MIN_CHAT_WIDTH, railTab } from "./railModel";

describe("railTab", () => {
  const closed = { open: false, tab: "browser" as const };

  it("shows the tab you picked while no tool is open", () => {
    expect(railTab("changes", false, closed)).toBe("changes");
  });

  it("shows the terminal when it's put in the panel", () => {
    expect(railTab("attention", true, closed)).toBe("terminal");
  });

  it("shows the browser or simulator when one is open, even over the terminal", () => {
    expect(railTab("checks", false, { open: true, tab: "simulator" })).toBe("simulator");
    expect(railTab("checks", true, { open: true, tab: "browser" })).toBe("browser");
  });
});

describe("isPreviewTab", () => {
  it("is true only for the browser and simulator", () => {
    expect(isPreviewTab("browser")).toBe(true);
    expect(isPreviewTab("simulator")).toBe(true);
    expect(isPreviewTab("terminal")).toBe(false);
    expect(isPreviewTab("attention")).toBe(false);
  });
});

describe("clampRailWidth", () => {
  const min = 360;
  const room = 1200;

  it("takes the width asked for when it fits", () => {
    expect(clampRailWidth(560, room, min)).toBe(560);
  });

  it("leaves the chat its floor", () => {
    expect(clampRailWidth(1100, room, min)).toBe(room - MIN_CHAT_WIDTH);
  });

  it("never goes under the minimum, even with little room", () => {
    expect(clampRailWidth(200, room, min)).toBe(min);
    expect(clampRailWidth(560, 600, min)).toBe(min);
  });

  it("rounds a dragged width to whole pixels", () => {
    expect(clampRailWidth(480.6, room, min)).toBe(481);
  });
});
