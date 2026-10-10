import { describe, expect, it } from "vitest";
import type { Agent } from "../../lib/types";
import { leadingAgent, mentionSuggestions, routeMessage } from "./mentions";

const agent = (id: string, name: string): Agent => ({
  id,
  name,
  role: "",
  kind: "worker",
  engine: "claude-code",
  accent: "#fff",
  figure: "engineer",
  home_x: 0,
  home_y: 0,
  status: "idle",
});

const team = [agent("jarvis", "JARVIS"), agent("friday", "FRIDAY"), agent("vision", "Vision")];

describe("routeMessage", () => {
  it("sends plain messages to the orchestrator", () => {
    expect(routeMessage("  plan the release ", team, "jarvis")).toEqual({ ok: true, agentId: "jarvis", message: "plan the release" });
  });

  it("routes @mentions by name or id, ignoring case", () => {
    expect(routeMessage("@friday fix the build", team, "jarvis")).toEqual({ ok: true, agentId: "friday", message: "fix the build" });
    expect(routeMessage("@VISION review this", team, "jarvis")).toMatchObject({ ok: true, agentId: "vision" });
  });

  it("keeps multi-line messages intact", () => {
    expect(routeMessage("@friday line one\nline two", team, "jarvis")).toMatchObject({ message: "line one\nline two" });
  });

  it("explains what is wrong instead of guessing", () => {
    expect(routeMessage("", team, "jarvis")).toMatchObject({ ok: false });
    expect(routeMessage("@nobody hi", team, "jarvis")).toEqual({ ok: false, reason: "No agent is called nobody." });
    expect(routeMessage("@friday", team, "jarvis")).toEqual({ ok: false, reason: "Add a message for FRIDAY." });
    expect(routeMessage("hello", team, undefined)).toMatchObject({ ok: false });
  });
});

describe("mentionSuggestions", () => {
  it("suggests while the mention is being typed", () => {
    expect(mentionSuggestions("@", team)).toHaveLength(3);
    expect(mentionSuggestions("@fr", team).map((a) => a.id)).toEqual(["friday"]);
  });

  it("stops once the message has started", () => {
    expect(mentionSuggestions("@friday do it", team)).toEqual([]);
    expect(mentionSuggestions("no mention", team)).toEqual([]);
  });
});

describe("leadingAgent", () => {
  it("names the agent a message opens with and the text before what follows", () => {
    expect(leadingAgent("@friday /review the diff", team)).toMatchObject({ agent: { id: "friday" }, prefix: "@friday " });
    expect(leadingAgent("@VISION  \n/review", team)?.prefix).toBe("@VISION  \n");
  });

  it("is null without an agent by that name, or with nothing after it yet", () => {
    expect(leadingAgent("@nobody /review", team)).toBeNull();
    expect(leadingAgent("@friday", team)).toBeNull();
    expect(leadingAgent("/review @friday", team)).toBeNull();
    expect(leadingAgent("plain", team)).toBeNull();
  });

  it("routes the command after it to that agent, and a bare command to the orchestrator", () => {
    expect(routeMessage("@friday /review the diff", team, "jarvis")).toEqual({ ok: true, agentId: "friday", message: "/review the diff" });
    expect(routeMessage("/review the diff", team, "jarvis")).toEqual({ ok: true, agentId: "jarvis", message: "/review the diff" });
  });
});
