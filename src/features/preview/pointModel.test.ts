import { describe, expect, it } from "vitest";
import { browserPointText, fenceFor, insertPoint, simulatorPointText } from "./pointModel";
import type { BrowserPick } from "../../lib/types";

describe("pointing into a draft", () => {
  it("names the browser element, geometry, styles and collapsed HTML", () => {
    const pick: BrowserPick = {
      tag: "button",
      id: "save",
      classes: ["primary"],
      selector: "#save",
      role: "button",
      accessible_name: "Save changes",
      text: "Save changes",
      attributes: {},
      styles: {
        "background-color": "rgb(20, 120, 110)",
        color: "#fff",
        "font-size": "14px",
        "line-height": "20px",
        "font-family": "Inter",
        "font-weight": "600",
        padding: "8px 16px",
        "border-radius": "8px",
      },
      bounds: { x: 840, y: 412, width: 120, height: 32 },
      url: "http://localhost:5173/settings",
      title: "Settings",
      viewport: { width: 1280, height: 800 },
      device_pixel_ratio: 2,
      outer_html: '<button id="save">Save changes</button>',
    };
    const text = browserPointText(pick);
    expect(text).toContain('button.primary "Save changes" (#save)');
    expect(text).toContain("120 × 32 at 840, 412");
    expect(text).toContain("14px/20px Inter 600");
    expect(text).toContain("<details><summary>Element HTML</summary>");
    expect(text).toContain(pick.url);
  });
  it("fences code past the longest run of backticks in it", () => {
    expect(fenceFor("<p>plain</p>")).toBe("```");
    expect(fenceFor("a ``` b `` c")).toBe("````");
    expect(fenceFor("`````")).toBe("``````");
  });
  it("includes device points, accessibility value and frame", () => {
    expect(
      simulatorPointText({
        device: "iPhone 17 Pro",
        x: 120,
        y: 640,
        element: { role: "Button", label: "Sign in", value: "Ready", frame: { x: 20, y: 620, width: 350, height: 50 } },
      }),
    ).toBe("On iPhone 17 Pro, at 120, 640 (points): Button “Sign in” · value Ready (20, 620, 350 × 50)\n");
    expect(simulatorPointText({ device: "iPad", x: 1, y: 2, element: null })).toContain("No accessibility element");
  });
  it("inserts at the caret and adds repeated picks without losing the rest", () => {
    expect(insertPoint("before after", "point\n", 7)).toEqual({ text: "before \npoint\nafter", caret: 14 });
    expect(insertPoint("abc", "point\n", 1, 2).text).toBe("a\npoint\nc");
    const first = insertPoint("", "first\n", 0);
    expect(insertPoint(first.text, "second\n", first.caret).text).toBe("first\nsecond\n");
  });
});
