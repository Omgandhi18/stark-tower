import { describe, expect, it } from "vitest";
import type { ContextSource } from "../../lib/types";
import { contextSize, emptyLabel, groupSources, totalSize } from "./contextModel";

const source = (group: number, extra: Partial<ContextSource> = {}): ContextSource => ({
  group,
  name: "Instructions",
  scope: "this project",
  delivery: "Read by Claude Code itself",
  accepted: true,
  conditional: false,
  path: "/project/CLAUDE.md",
  characters: 12,
  tokens: 3,
  text: "Instructions",
  omitted_characters: 0,
  markdown: true,
  ...extra,
});

describe("active context", () => {
  it("keeps the four groups in order and preserves source precedence within them", () => {
    const first = source(2, { name: "Local rules" });
    const second = source(2, { name: "Project rules" });
    const groups = groupSources([source(4), first, source(1), second, source(3)]);
    expect(groups.map((g) => g.label)).toEqual(["Starkline and your rules", "Project instructions", "Agent identity and memory", "This task and live state"]);
    expect(groups[1].sources).toEqual([first, second]);
    expect(groupSources([])).toHaveLength(4);
  });
  it("totals only accepted, unconditional sources and labels empty files", () => {
    expect(totalSize([source(1), source(2, { accepted: false }), source(2, { conditional: true }), source(3, { characters: 5, tokens: 2 })])).toBe(
      contextSize(17, 5),
    );
    expect(emptyLabel(source(2, { characters: 0 }))).toBe("CLAUDE.md is empty");
    expect(emptyLabel(source(3, { path: null, name: "Memory", characters: 0 }))).toBe("Memory is empty");
  });
});
