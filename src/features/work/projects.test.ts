import { describe, expect, it } from "vitest";
import { inProject, parentFolder } from "./projects";

describe("projects", () => {
  it("shows the parent folder with the home directory abbreviated", () => {
    expect(parentFolder("/Users/om/Documents/stark-tower")).toBe("~/Documents");
    expect(parentFolder("/opt/work/app/")).toBe("/opt/work");
  });

  it("matches work inside a project folder, not a sibling with the same prefix", () => {
    expect(inProject("/w/app/src", "/w/app")).toBe(true);
    expect(inProject("/w/app", "/w/app/")).toBe(true);
    expect(inProject("/w/app-two", "/w/app")).toBe(false);
    expect(inProject("", "/w/app")).toBe(false);
    expect(inProject("/anything", null)).toBe(true);
  });
});
