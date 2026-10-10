import { afterEach, describe, expect, it } from "vitest";
import type { Attachment } from "../../lib/types";
import { useAttention } from "../../stores/attention";
import { useChats } from "../../stores/chats";
import { addPoint } from "./pointComposer";

const friday = { agentId: "friday", key: "friday" };

const file: Attachment = { path: "/attachments/movie.mp4", name: "movie.mp4", kind: "video", mime: "video/mp4", size: 100 };
afterEach(() => {
  useChats.setState({ threads: {} });
  useAttention.setState({ pending: [] });
  document.body.replaceChildren();
});

describe("adding preview references to the composer", () => {
  it("refuses a delayed pick when a question arrived while it was being captured", () => {
    useChats.getState().setDraft("friday", "Keep this draft");
    useAttention
      .getState()
      .add({
        id: "question",
        agentId: "friday",
        kind: "questions",
        title: "Which page?",
        body: "",
        choices: [],
        created: 0,
        command: null,
        cwd: null,
        rule: null,
        tier: null,
        taskId: null,
        conversationId: null,
        grant: null,
        project: null,
      });
    expect(() => addPoint(friday, "Point\n", file)).toThrow("Answer the agent’s question first");
    expect(useChats.getState().threads.friday.draft).toBe("Keep this draft");
    expect(useChats.getState().threads.friday.files).toEqual([]);
  });
  it("adds a point as a chip with its screenshot, leaving the draft and files alone", () => {
    useChats.getState().setDraft("friday", "Before after");
    useChats.getState().setDraft("edith", "Other chat");
    addPoint(friday, "Point\n", file);
    const thread = useChats.getState().threads.friday;
    expect(thread.draft).toBe("Before after");
    expect(thread.files).toEqual([]);
    expect(thread.references).toMatchObject([{ kind: "point", text: "Point\n", image: file }]);
    expect(useChats.getState().threads.edith.draft).toBe("Other chat");
    expect(useChats.getState().threads.edith.references ?? []).toEqual([]);
  });
  it("attaches a recording once without touching the draft", () => {
    useChats.getState().setDraft("friday", "Keep this draft");
    addPoint(friday, "", file);
    addPoint(friday, "", file);
    expect(useChats.getState().threads.friday.draft).toBe("Keep this draft");
    expect(useChats.getState().threads.friday.files).toEqual([file]);
    expect(useChats.getState().threads.friday.references).toEqual([]);
  });
  it("refuses a delayed result when that agent has switched to another saved chat", () => {
    useChats.getState().setDraft("friday", "New chat");
    const thread = useChats.getState().threads.friday;
    useChats.setState({ threads: { friday: { ...thread, conversationId: 12 } } });
    expect(() => addPoint(friday, "Old pick\n", file, 11)).toThrow("That chat changed");
    expect(useChats.getState().threads.friday.draft).toBe("New chat");
    expect(useChats.getState().threads.friday.files).toEqual([]);
    expect(useChats.getState().threads.friday.references).toEqual([]);
  });
});
