import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { Globe } from "lucide-react";
import { TabStrip } from "./TabStrip";

const strip = (iconSrc?: string) => (
  <TabStrip label="Tabs" idPrefix="t" newLabel="New" tabs={[{ id: "1", label: "Docs", icon: Globe, iconSrc }]} value="1" onSelect={() => {}} onClose={() => {}} onNew={() => {}} />
);

describe("TabStrip icons", () => {
  it("show a page's own icon, and the fallback icon when there is none or it won't load", () => {
    const { container, rerender } = render(strip());
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".tab-strip-tab svg")).not.toBeNull();
    rerender(strip("https://a.dev/favicon.ico"));
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://a.dev/favicon.ico");
    fireEvent.error(img!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".tab-strip-tab svg")).not.toBeNull();
    // Another page, another icon to try.
    rerender(strip("https://b.dev/favicon.ico"));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://b.dev/favicon.ico");
  });
});
