import { describe, expect, it } from "vitest";
import type { Agent, Automation } from "./types";
import { askedByDeveloper, automationOf, requesterName } from "./requester";

const agents = [{ id: "jarvis", name: "JARVIS" }] as Agent[];
const automations = [{ id: 3, name: "Nightly review" }] as Automation[];

describe("who asked for a task", () => {
  it("reads an automation's id", () => {
    expect(automationOf("automation:3")).toBe(3);
    expect(automationOf("automation:x")).toBeNull();
    expect(automationOf("jarvis")).toBeNull();
  });

  it("counts scheduled work as the developer's, not a delegation", () => {
    expect(askedByDeveloper("you")).toBe(true);
    expect(askedByDeveloper("automation:3")).toBe(true);
    expect(askedByDeveloper("jarvis")).toBe(false);
  });

  it("names the requester", () => {
    expect(requesterName("you", agents, automations)).toBe("You");
    expect(requesterName("automation:3", agents, automations)).toBe("Automation: Nightly review");
    expect(requesterName("automation:9", agents, automations)).toBe("An automation");
    expect(requesterName("jarvis", agents, automations)).toBe("JARVIS");
  });
});
