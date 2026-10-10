import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { runTabShortcut, useTabShortcuts } from "./useTabShortcuts";

function Panel({ onNew, onClose, native }: { onNew: () => void; onClose: () => void; native?: () => boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useTabShortcuts(ref, onNew, onClose, native);
  return (
    <div ref={ref} data-testid="panel">
      <input aria-label="inside" />
    </div>
  );
}

const outside = () => {
  const button = document.createElement("button");
  document.body.append(button);
  button.focus();
  return button;
};

describe("tab shortcuts from the app menu", () => {
  it("go to the tab strip panel that has focus, and to none otherwise", () => {
    const [onNew, onClose] = [vi.fn(), vi.fn()];
    const { getByLabelText } = render(<Panel onNew={onNew} onClose={onClose} />);
    const later = Date.now() + 10_000;
    outside();
    expect(runTabShortcut("close", later)).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    getByLabelText("inside").focus();
    expect(runTabShortcut("close", later)).toBe(true);
    expect(runTabShortcut("new", later)).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("count a native view laid over the panel as the panel having focus", () => {
    const onClose = vi.fn();
    let over = false;
    render(<Panel onNew={vi.fn()} onClose={onClose} native={() => over} />);
    const later = Date.now() + 20_000;
    outside();
    expect(runTabShortcut("close", later)).toBe(false);
    over = true;
    expect(runTabShortcut("close", later)).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("run once when the key reaches the page first and the menu then repeats it", () => {
    const onClose = vi.fn();
    const { getByLabelText } = render(<Panel onNew={vi.fn()} onClose={onClose} />);
    getByLabelText("inside").focus();
    fireEvent.keyDown(getByLabelText("inside"), { code: "KeyW", metaKey: true });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(runTabShortcut("close")).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stop once the panel is gone", () => {
    const onClose = vi.fn();
    const { getByLabelText, unmount } = render(<Panel onNew={vi.fn()} onClose={onClose} />);
    getByLabelText("inside").focus();
    unmount();
    expect(runTabShortcut("close", Date.now() + 30_000)).toBe(false);
  });
});
