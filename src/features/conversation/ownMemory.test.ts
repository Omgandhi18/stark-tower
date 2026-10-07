import { describe, expect, it } from "vitest";
import type { Attachment } from "../../lib/types";
import type { ChatMessage } from "../../stores/chats";
import { withoutOwnMemory } from "./ownMemory";

const file = (name: string): Attachment => ({ path: `/kept/${name}`, name, mime: "text/markdown", kind: "markdown", size: 10 });
const made = (id: number, names: string[], detail = "made"): ChatMessage => ({ id, role: "artifact", detail, attachments: names.map(file) });

describe("withoutOwnMemory", () => {
  it("drops the agent's own memory from what a turn made, and the card when that was all", () => {
    const messages: ChatMessage[] = [
      { id: 1, role: "agent", text: "Noted." },
      made(2, ["jarvis.md"]),
      made(3, ["JARVIS.md", "chart.png"]),
      made(4, ["friday.md"]),
    ];
    expect(withoutOwnMemory(messages, "jarvis")).toEqual([
      { id: 1, role: "agent", text: "Noted." },
      { ...made(3, ["chart.png"]) },
      made(4, ["friday.md"]),
    ]);
  });

  it("keeps it when the agent shared it on purpose, and leaves other messages alone", () => {
    const shared = made(5, ["jarvis.md"], "shared");
    const user: ChatMessage = { id: 6, role: "user", text: "Here", attachments: [file("jarvis.md")] };
    expect(withoutOwnMemory([shared, user], "jarvis")).toEqual([shared, user]);
  });
});
