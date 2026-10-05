import { describe, expect, it } from "vitest";
import { helpersAfter } from "../../stores/activity";
import type { ChatEvent } from "../../lib/types";
import { lightFor } from "./stationLights";

describe("the room tells the truth", () => {
  it("lights a station by what its agent is doing", () => {
    expect(lightFor({ status: "working" })).toBe("working");
    expect(lightFor({ status: "thinking" })).toBe("working");
    expect(lightFor({ status: "blocked" })).toBe("waiting");
    expect(lightFor({ status: "idle" })).toBeUndefined();
    expect(lightFor({ status: "offline" })).toBeUndefined();
  });

  it("shows an agent waiting on you, even mid-turn", () => {
    expect(lightFor({ status: "working" }, true)).toBe("waiting");
    expect(lightFor({ status: "idle" }, true)).toBe("waiting");
  });

  it("counts helpers from the moment they start until the turn ends", () => {
    const event = (kind: string, tool?: string) => ({ agentId: "friday", kind, tool }) as ChatEvent;
    let running = 0;
    running = helpersAfter(running, event("tool", "Task"));
    running = helpersAfter(running, event("tool", "Read"));
    running = helpersAfter(running, event("tool", "Agent"));
    expect(running).toBe(2);
    expect(helpersAfter(running, event("text"))).toBe(2);
    expect(helpersAfter(running, event("result"))).toBe(0);
    expect(helpersAfter(running, event("exit"))).toBe(0);
  });
});
