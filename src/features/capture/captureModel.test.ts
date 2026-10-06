import { describe, expect, it } from "vitest";
import { captureText, recordedShortcut, reminderPhrase, shortcutLabel, toggleMode } from "./captureModel";
const morning = new Date(2026, 9, 6, 10).getTime();

describe("capture text", () => {
  it("switches modes and strips only the leading whole phrase", () => {
    expect(captureText("REMIND ME to stretch", "task")).toEqual({ mode: "reminder", text: "to stretch" });
    expect(captureText("remind me", "task")).toEqual({ mode: "reminder", text: "" });
    for (const text of ["remind melon", "write remind me in the docs", "remind meander"]) {
      expect(captureText(text, "task")).toEqual({ mode: "task", text });
    }
    expect(toggleMode(toggleMode("task"))).toBe("task");
  });
  it("detects and removes trailing quick times, leaving other prose alone", () => {
    for (const [phrase, choice] of [
      ["in 30 minutes", "30m"],
      ["in 1 hour", "1h"],
      ["this evening", "evening"],
      ["tomorrow morning", "morning"],
    ]) {
      expect(reminderPhrase(`to stretch ${phrase}.`, morning)).toEqual({ text: "to stretch", choice });
    }
    expect(reminderPhrase("in 1 hour review the build", morning).choice).toBeNull();
    expect(reminderPhrase("stretch this evening", new Date(2026, 9, 6, 19).getTime()).choice).toBeNull();
  });
});

it("records physical keys with a modifier and renders the shortcut", () => {
  const event = { code: "Space", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true };
  expect(recordedShortcut(event)).toBe("Super+Shift+Space");
  expect(shortcutLabel("Super+Shift+Space")).toBe("⇧⌘Space");
  expect(recordedShortcut({ ...event, metaKey: false })).toBeNull();
  expect(recordedShortcut({ ...event, code: "ShiftLeft" })).toBeNull();
});
