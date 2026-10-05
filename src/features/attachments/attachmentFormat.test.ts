import { describe, expect, it } from "vitest";
import { ARTIFACT_POLICY, formatSize, pastedName, sandboxedHtml } from "./attachmentFormat";

describe("attachment formatting", () => {
  it("states sizes the way Finder does", () => {
    expect(formatSize(1)).toBe("1 byte");
    expect(formatSize(900)).toBe("900 bytes");
    expect(formatSize(640 * 1024)).toBe("640 KB");
    expect(formatSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  it("names pasted images by when they were pasted", () => {
    const at = new Date(2026, 9, 6, 9, 5, 7);
    expect(pastedName("image.png", "image/png", at)).toBe("Pasted 2026-10-06 at 09.05.07.png");
    expect(pastedName("", "image/jpeg", at)).toBe("Pasted 2026-10-06 at 09.05.07.jpeg");
    expect(pastedName("diagram.png", "image/png", at)).toBe("diagram.png");
  });

  it("puts the preview policy first in an HTML artifact's head", () => {
    expect(sandboxedHtml("<html><head><title>x</title></head></html>")).toBe(
      `<html><head><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_POLICY}"><title>x</title></head></html>`,
    );
    expect(sandboxedHtml("<html lang=en><body>hi</body></html>")).toContain(`<html lang=en><head><meta http-equiv="Content-Security-Policy"`);
    expect(sandboxedHtml("<p>bare</p>").startsWith(`<meta http-equiv="Content-Security-Policy"`)).toBe(true);
    expect(ARTIFACT_POLICY).toContain("default-src 'none'");
  });
});
