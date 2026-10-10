import { describe, expect, it } from "vitest";
import type { TerminalInfo } from "../../lib/bindings";
import { clampHeight, localTerminalLink, terminalLabels, unseenOutput } from "./terminalModel";

const shell = (id: string, patch: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, folder: "/code/app", title: "zsh", shell: "zsh", alive: true, exit_code: null, program_running: false, note: null, ...patch });

describe("terminal presentation", () => {
  it("keeps the drawer between its minimum and seventy percent of the column", () => {
    expect(clampHeight(50, 800)).toBe(120);
    expect(clampHeight(700, 800)).toBe(560);
    expect(clampHeight(240, 800)).toBe(240);
  });
  it("names terminals for their program, numbering repeats in the order they opened", () => {
    const labels = terminalLabels([shell("a"), shell("b"), shell("c", { title: "npm run dev" }), shell("d")], "/code/app");
    expect([...labels.values()]).toEqual(["zsh", "zsh 2", "npm run dev", "zsh 3"]);
  });
  it("says where a terminal from another folder is, and when it has exited", () => {
    const labels = terminalLabels([shell("a"), shell("b", { folder: "/code/api" }), shell("c", { alive: false, exit_code: 0 })], "/code/app");
    expect([...labels.values()]).toEqual(["zsh", "zsh · api", "zsh 2 · Exited"]);
  });
  it("opens only local web links in the built-in browser", () => {
    expect(localTerminalLink("http://localhost:5173/test")).toBe(true);
    expect(localTerminalLink("http://[::1]:3000")).toBe(true);
    expect(localTerminalLink("https://localhost.example.com")).toBe(false);
    expect(localTerminalLink("file:///etc/passwd")).toBe(false);
  });
  it("reconciles a replay with split UTF-8 and overlapping live bytes", () => {
    expect([...unseenOutput({ data: [0xf0, 0x9f, 0x98, 0x80], offset: 14, exit_code: null }, 12)]).toEqual([0x98, 0x80]);
    expect([...unseenOutput({ data: [1, 2], offset: 10, exit_code: null }, 12)]).toEqual([]);
    expect([...unseenOutput({ data: [1, 2], offset: 1, exit_code: null }, 0xffffffff)]).toEqual([1, 2]);
  });
});
