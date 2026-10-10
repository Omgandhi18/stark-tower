import { describe, expect, it } from "vitest";
import { browserPointText, fenceFor, parsePoints, simulatorPointText } from "./pointModel";
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
});

const savePick: BrowserPick = {
  tag: "button",
  id: "save",
  classes: ["primary"],
  selector: "li:nth-child(2) > #save",
  role: "button",
  accessible_name: "Save changes",
  text: "Save changes",
  attributes: { id: "save" },
  styles: { color: "#fff", padding: "8px 16px" },
  bounds: { x: 840, y: 412, width: 120, height: 32 },
  url: "http://localhost:5173/settings",
  title: "Settings",
  viewport: { width: 1280, height: 800 },
  device_pixel_ratio: 2,
  outer_html: '<button id="save">```Save```</button>',
};

describe("reading a point back", () => {
  it("turns a browser point into a summary with its details and HTML", () => {
    const text = browserPointText(savePick);
    const [part, ...rest] = parsePoints(text);
    expect(rest).toEqual([]);
    expect(part.type).toBe("point");
    if (part.type !== "point") return;
    expect(part.point.title).toBe("button “Save changes”");
    expect(part.point.place).toBe("localhost:5173");
    expect(part.point.size).toBe("120 × 32");
    expect(part.point.html).toBe('<button id="save">```Save```</button>');
    const facts = Object.fromEntries(part.point.facts.map((f) => [f.label, f.value]));
    expect(facts.Selector).toBe("li:nth-child(2) > #save");
    expect(facts.Page).toBe("Settings · http://localhost:5173/settings");
    expect(facts.Size).toBe("120 × 32 at 840, 412");
    expect(facts.Styles).toBe("color: #fff\npadding: 8px 16px");
    expect(facts.Window).toBe("1280 × 800");
    expect(part.text).toBe(text.trimEnd());
  });
  it("keeps the words around points, in order", () => {
    const sim = simulatorPointText({ device: "iPhone 17 Pro", x: 120, y: 640, element: { role: "Button", label: "Sign in", value: "", frame: { x: 20, y: 620, width: 350, height: 50 } } });
    const parts = parsePoints(`Look at this\n${browserPointText(savePick)}\n${sim}\nand fix both`);
    expect(parts.map((p) => p.type)).toEqual(["text", "point", "point", "text"]);
    expect(parts[0]).toEqual({ type: "text", text: "Look at this" });
    expect(parts[3]).toEqual({ type: "text", text: "and fix both" });
    const second = parts[2];
    if (second.type !== "point") throw new Error("expected a point");
    expect(second.point).toMatchObject({ kind: "simulator", title: "Button “Sign in”", place: "iPhone 17 Pro", size: "350 × 50" });
  });
  it("reads a point without an accessibility element or any details", () => {
    const [part] = parsePoints(simulatorPointText({ device: "iPad", x: 1, y: 2, element: null }));
    expect(part.type === "point" && part.point.title).toBe("A point on the screen");
    const bare = browserPointText({ ...savePick, outer_html: "" }).replace(/\n<details>[\s\S]*<\/details>/, "");
    const [browser] = parsePoints(bare);
    expect(browser.type === "point" && browser.point.title).toBe("button “Save changes”");
    expect(browser.type === "point" && browser.point.html).toBeNull();
  });
  it("leaves ordinary messages alone", () => {
    expect(parsePoints("Just words\nover two lines")).toEqual([{ type: "text", text: "Just words\nover two lines" }]);
    expect(parsePoints("")).toEqual([]);
  });
});
