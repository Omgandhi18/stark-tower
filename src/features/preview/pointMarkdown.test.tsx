import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import MarkdownRenderer from "../../design/components/MarkdownRenderer";
import type { BrowserPick } from "../../lib/types";
import { browserPointText } from "./pointModel";

it("keeps a page's own backticks inside the picked HTML", () => {
  const outer = "<pre>```\n</details>\n<img src=x></pre>";
  const pick: BrowserPick = {
    tag: "pre",
    id: "",
    classes: [],
    selector: "pre",
    role: "pre",
    accessible_name: "",
    text: "```",
    attributes: {},
    styles: {},
    bounds: { x: 0, y: 0, width: 100, height: 40 },
    url: "http://localhost:5173/docs",
    title: "Docs",
    viewport: { width: 1280, height: 800 },
    device_pixel_ratio: 2,
    outer_html: outer,
  };
  const { container } = render(<MarkdownRenderer text={browserPointText(pick)} />);
  const html = screen.getByText("Element HTML").closest("details");
  expect(html?.querySelector("code")?.textContent).toBe(`${outer}\n`);
  expect(container.querySelectorAll("details")).toHaveLength(2);
  expect(container.querySelector("img")).toBeNull();
});
