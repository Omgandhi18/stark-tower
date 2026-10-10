import { describe, expect, it } from "vitest";
import type { SlashItem } from "../../lib/types";
import { detectSlash, groupCommands, insertCommand, isMcpRequest, rankCommands, serversNeedingAttention, startsWithCommand, toolCount } from "./slashLogic";

const item = (name: string, source: SlashItem["source"], origin = "", description = ""): SlashItem => ({ name, description, hint: "", kind: "skill", source, origin });

describe("detectSlash", () => {
  it("finds a command being typed at the start of the message", () => {
    expect(detectSlash("/", 1)).toEqual({ query: "" });
    expect(detectSlash("/rev", 4)).toEqual({ query: "rev" });
    expect(detectSlash("/sarathi:re", 11)).toEqual({ query: "sarathi:re" });
    expect(detectSlash("/mcp__docs__sum", 15)).toEqual({ query: "mcp__docs__sum" });
  });

  it("is quiet once the command is done, or when it isn't one", () => {
    expect(detectSlash("/review the diff", 16)).toBeNull();
    expect(detectSlash("/review ", 8)).toBeNull();
    expect(detectSlash("look at /review", 15)).toBeNull();
    expect(detectSlash("/Users/dev/app", 14)).toBeNull();
    expect(detectSlash("", 0)).toBeNull();
  });

  it("follows the caret back into the command", () => {
    expect(detectSlash("/review the diff", 4)).toEqual({ query: "rev" });
  });
});

describe("startsWithCommand", () => {
  it("is true for a command at the start, with or without arguments", () => {
    expect(startsWithCommand("/review")).toBe(true);
    expect(startsWithCommand("/sarathi:review the diff")).toBe(true);
    expect(startsWithCommand("/review\nthe diff")).toBe(true);
  });
  it("is false for anything else", () => {
    expect(startsWithCommand("/")).toBe(false);
    expect(startsWithCommand("/Users/dev/app")).toBe(false);
    expect(startsWithCommand("see /review")).toBe(false);
    expect(startsWithCommand("")).toBe(false);
  });
});

describe("rankCommands", () => {
  const items = [item("deploy", "project", "", "Ship it"), item("sarathi:review", "plugin", "sarathi"), item("review", "user"), item("pdf", "user", "", "Review PDFs")];

  it("puts exact and prefix matches first, then the part after a plugin name, then descriptions", () => {
    expect(rankCommands(items, "review").map((i) => i.name)).toEqual(["review", "sarathi:review", "pdf"]);
    expect(rankCommands(items, "dep").map((i) => i.name)).toEqual(["deploy"]);
    expect(rankCommands(items, "nothing")).toEqual([]);
  });

  it("keeps the catalog's order when nothing is typed", () => {
    expect(rankCommands(items, "").map((i) => i.name)).toEqual(["deploy", "sarathi:review", "review", "pdf"]);
  });
});

describe("groupCommands", () => {
  it("heads each run of commands from the same place, numbering them for the keyboard", () => {
    const groups = groupCommands([item("a", "project"), item("b", "plugin", "sarathi"), item("c", "plugin", "sarathi"), item("d", "mcp", "docs")]);
    expect(groups.map((g) => g.label)).toEqual(["This project", "Plugin · sarathi", "MCP server · docs"]);
    expect(groups.flatMap((g) => g.entries.map((e) => [e.item.name, e.index]))).toEqual([["a", 0], ["b", 1], ["c", 2], ["d", 3]]);
  });
});

describe("the command line", () => {
  it("inserts a command ready for its arguments", () => {
    expect(insertCommand("hello")).toEqual({ text: "/hello ", caret: 7 });
  });

  it("treats /mcp on its own as a request to see the servers", () => {
    expect(isMcpRequest(" /MCP ")).toBe(true);
    expect(isMcpRequest("/mcp reconnect")).toBe(false);
  });
});

describe("MCP servers", () => {
  const server = (status: "connected" | "failed" | "needs-auth", tools: number | null) => ({ name: "s", status, source: "user", tools, error: null, transport: "stdio" });

  it("counts the ones that want attention and the tools they offer", () => {
    expect(serversNeedingAttention([server("connected", 2), server("failed", null), server("needs-auth", null)])).toBe(2);
    expect(toolCount(server("connected", 1))).toBe("1 tool");
    expect(toolCount(server("connected", 4))).toBe("4 tools");
    expect(toolCount(server("failed", null))).toBeNull();
  });
});
