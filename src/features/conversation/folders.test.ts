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

it("offers live worktrees beside their project, without repeating the current folder", () => {
  const tree = { path: "/home/dev/.starkline/worktrees/app/fix", project: "/w/app", branch: "starkline/fix", base: "main", base_commit: "abc", task_id: "task", created: 0, removed: null };
  const options = folderOptions(projects, tree.path, [tree, { ...tree, path: "/removed", removed: 1 }]);
  expect(options.map((o) => o.value)).toEqual(["/w/app", "/w/site", tree.path]);
  expect(options[2].label).toBe("app · starkline/fix");
});
