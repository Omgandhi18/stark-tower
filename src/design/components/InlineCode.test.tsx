import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { InlineCode } from "./InlineCode";

describe("InlineCode", () => {
  it("turns backticked spans into code and leaves odd backticks alone", () => {
    const { container, rerender } = render(<InlineCode text="Allow `npm run` commands" />);
    expect(container.querySelector("code")?.textContent).toBe("npm run");
    expect(container.textContent).toBe("Allow npm run commands");
    rerender(<InlineCode text="it's a ` stray" />);
    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).toBe("it's a ` stray");
  });
});
