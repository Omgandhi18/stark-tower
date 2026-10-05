import { describe, expect, it } from "vitest";
import { detectMention, insertMention, rankPaths } from "./fileMentions";

describe("detectMention", () => {
  it("finds the @token under the caret", () => {
    expect(detectMention("look at @src/Ap", 15)).toEqual({ start: 8, query: "src/Ap" });
    expect(detectMention("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("ignores plain words and email-like text after the caret", () => {
    expect(detectMention("look at src", 11)).toBeNull();
    expect(detectMention("hi @there friend", 16)).toBeNull();
  });
});

describe("rankPaths", () => {
  const entries = [
    { path: "src/components/AppShell.tsx", dir: false },
    { path: "src/App.tsx", dir: false },
    { path: "docs/app-notes.md", dir: false },
    { path: "src", dir: true },
  ];

  it("puts names that start with the query first, shorter paths first", () => {
    expect(rankPaths(entries, "app").map((e) => e.path)).toEqual([
      "src/App.tsx",
      "docs/app-notes.md",
      "src/components/AppShell.tsx",
    ]);
  });
});

describe("insertMention", () => {
  it("replaces the token and leaves the caret after it", () => {
    const text = "read @sr please";
    const result = insertMention(text, { start: 5, query: "sr" }, 8, { path: "src", dir: true });
    expect(result).toEqual({ text: "read @src/  please", caret: 11 });
  });
});
