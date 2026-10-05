import { describe, expect, it } from "vitest";
import { folderOptions } from "./folders";

const projects = [
  { path: "/w/app", name: "app" },
  { path: "/w/site", name: "site" },
];

describe("folderOptions", () => {
  it("lists the projects", () => {
    expect(folderOptions(projects, "/w/app").map((o) => o.value)).toEqual(["/w/app", "/w/site"]);
  });

  it("keeps a chat's folder that isn't a project", () => {
    expect(folderOptions(projects, "/tmp/scratch")[0]).toEqual({ value: "/tmp/scratch", label: "scratch" });
  });

  it("says so when there is nowhere to run", () => {
    expect(folderOptions([], "")).toEqual([{ value: "", label: "No project folder yet", disabled: true }]);
  });
});
