import { describe, expect, it } from "vitest";
import { clampHeight, localTerminalLink, terminalLabel, unseenOutput } from "./terminalModel";

describe("terminal presentation", () => {
  it("keeps the drawer between its minimum and seventy percent of the column", () => {
    expect(clampHeight(50, 800)).toBe(120);
    expect(clampHeight(700, 800)).toBe(560);
    expect(clampHeight(240, 800)).toBe(240);
  });
  it("names a terminal for its folder and reported program", () => {
    expect(terminalLabel("/code/app/", "zsh", "zsh")).toBe("app");
    expect(terminalLabel("/code/app", "npm run dev", "zsh")).toBe("app · npm run dev");
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
