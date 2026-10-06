import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import MarkdownRenderer from "./MarkdownRenderer";

it("renders picked HTML as literal code inside a closed disclosure", () => {
  const { container } = render(
    <MarkdownRenderer text={'A pick\n<details><summary>Element HTML</summary>\n\n```html\n<img src="x" onerror="bad()">\n```\n</details>'} />,
  );
  const summary = screen.getByText("Element HTML");
  expect(summary.closest("details")).not.toHaveAttribute("open");
  expect(container.querySelector("code")?.textContent).toBe('<img src="x" onerror="bad()">\n');
  expect(container.querySelector("img")).toBeNull();
});
