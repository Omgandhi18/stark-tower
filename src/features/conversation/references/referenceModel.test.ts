import { describe, expect, it } from "vitest";
import type { Attachment } from "../../../lib/types";
import type { ComposerReference } from "../../../stores/chats";
import { browserPointText } from "../../preview/pointModel";
import { composeFiles, composeMessage, describeReference, hasReferences, parseMessage, quoteMarkdown, tidyExcerpt } from "./referenceModel";

const shot: Attachment = { path: "/a/point.jpg", name: "point.jpg", kind: "image", mime: "image/jpeg", size: 10 };
const quote = (id: number, text: string): ComposerReference => ({ id, kind: "quote", text });
const pointText = browserPointText({
  tag: "a",
  id: "",
  classes: [],
  selector: "a",
  role: "link",
  accessible_name: "Docs",
  text: "Docs",
  attributes: {},
  styles: {},
  bounds: { x: 1, y: 2, width: 30, height: 10 },
  url: "http://localhost:3000/",
  title: "",
  viewport: {},
  device_pixel_ratio: 1,
  outer_html: "<a>Docs</a>",
});

describe("quotes", () => {
  it("become blockquotes that keep their blank lines", () => {
    expect(quoteMarkdown("one\n\ntwo")).toBe("> one\n>\n> two");
  });
  it("are tidied from a selection", () => {
    expect(tidyExcerpt("  one\r\n\n\n\ntwo \n")).toBe("one\n\ntwo");
  });
});

describe("composing and reading a message", () => {
  it("sends quotes and points before the words", () => {
    const text = composeMessage([quote(1, "first"), { id: 2, kind: "point", text: pointText, image: shot }, quote(3, "a\nb")], "Why?");
    expect(text.startsWith("> first\n\nIn the browser at http://localhost:3000/")).toBe(true);
    expect(text.endsWith("> a\n> b\n\nWhy?")).toBe(true);
  });
  it("sends only the words when nothing is attached", () => {
    expect(composeMessage([], "Hi")).toBe("Hi");
    expect(composeMessage([quote(1, "x")], "")).toBe("> x");
  });
  it("keeps a slash command first, with the quotes and points after it as its arguments", () => {
    const text = composeMessage([quote(1, "first"), { id: 2, kind: "point", text: pointText }], "/review the tone");
    expect(text.startsWith("/review the tone\n\n> first\n\nIn the browser at http://localhost:3000/")).toBe(true);
    expect(composeMessage([quote(1, "x")], "/review")).toBe("/review\n\n> x");
    expect(parseMessage(composeMessage([quote(1, "x")], "/review")).map((p) => p.type)).toEqual(["text", "quote"]);
  });
  it("puts references first when a slash only looks like a command", () => {
    expect(composeMessage([quote(1, "x")], "/Users/dev/app is broken")).toBe("> x\n\n/Users/dev/app is broken");
    expect(composeMessage([quote(1, "x")], "see /review")).toBe("> x\n\nsee /review");
  });
  it("reads back what it composed", () => {
    const parts = parseMessage(composeMessage([quote(1, "first\n\nsecond"), { id: 2, kind: "point", text: pointText }, quote(3, "third")], "Why?"));
    expect(parts.map((p) => p.type)).toEqual(["quote", "point", "quote", "text"]);
    expect(parts[0]).toEqual({ type: "quote", text: "first\n\nsecond" });
    expect(parts[3]).toEqual({ type: "text", text: "Why?" });
    expect(hasReferences(parts)).toBe(true);
  });
  it("shows a plain message as one text part", () => {
    expect(hasReferences(parseMessage("Hello\nthere"))).toBe(false);
    expect(parseMessage("Hello\nthere")).toEqual([{ type: "text", text: "Hello\nthere" }]);
  });
  it("sends each point's screenshot once, after the attached files", () => {
    const other: Attachment = { ...shot, path: "/a/other.png", name: "other.png" };
    const refs: ComposerReference[] = [{ id: 1, kind: "point", text: pointText, image: shot }, quote(2, "q")];
    expect(composeFiles(refs, [other])).toEqual([other, shot]);
    expect(composeFiles(refs, [shot])).toEqual([shot]);
  });
});

describe("what a chip shows", () => {
  it("is the quote itself, or the point's name, place and size", () => {
    expect(describeReference(quote(1, "hello"))).toEqual({ title: "hello", meta: [] });
    expect(describeReference({ id: 2, kind: "point", text: pointText })).toEqual({ title: "a “Docs”", meta: ["localhost:3000", "30 × 10"] });
  });
});
