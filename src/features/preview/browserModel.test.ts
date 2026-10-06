import { describe, expect, it } from "vitest";
import { fitBrowser, mergeOutput } from "./browserModel";

describe("browser sizes", () => {
  it("centres a CSS viewport and scales it to whichever edge runs out first", () => {
    const phone = fitBrowser({ x: 10, y: 20, width: 344, height: 900 }, "phone");
    expect(phone.zoom).toBeCloseTo(320 / 390);
    expect(phone.bounds.x).toBe(22);
    expect(phone.bounds.height / phone.zoom).toBeCloseTo(844);
    expect(phone.label).toBe("390 × 844 · 82%");
    const tablet = fitBrowser({ x: 0, y: 0, width: 1000, height: 500 }, "tablet");
    expect(tablet.bounds.height).toBeCloseTo(476);
    expect(tablet.bounds.width / tablet.zoom).toBeCloseTo(820);
  });
  it("never enlarges a device and restores full bounds for Fit panel", () => {
    const panel = { x: 10, y: 20, width: 1800, height: 1400 };
    expect(fitBrowser(panel, "laptop").zoom).toBe(1);
    expect(fitBrowser(panel, "fit")).toEqual({ bounds: panel, zoom: 1, label: "" });
  });
});

it("merges output snapshots and batches without duplicates, bounds memory, and ignores old runs", () => {
  const first = { folder: "/app", generation: 1, cursor: 2, lines: ["a", "b"] };
  const next = mergeOutput(first, { ...first, cursor: 3, lines: ["a", "b", "c"] });
  expect(next.lines).toEqual(["a", "b", "c"]);
  expect(mergeOutput(next, first)).toBe(next);
  expect(mergeOutput({ ...first, lines: ["b"] }, first).lines).toEqual(["a", "b"]);
  expect(mergeOutput({ ...first, cursor: 3, lines: ["c"] }, first).lines).toEqual(["a", "b", "c"]);
  expect(mergeOutput(next, { ...first, generation: 2, cursor: 1, lines: ["restarted"] }).lines).toEqual(["restarted"]);
  expect(mergeOutput(undefined, { ...first, lines: Array(2100).fill("line") }).lines).toHaveLength(2000);
});
