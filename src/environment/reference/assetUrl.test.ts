import { path } from "pixi.js";
import { describe, expect, it } from "vitest";
import { fullUrl } from "./assetUrl";

const BUILT_APP = "tauri://localhost/index.html";

describe("asset addresses for the room renderer", () => {
  it("resolves bundled files against the page they're loaded from", () => {
    expect(fullUrl("/assets/cutout-x.png", BUILT_APP)).toBe("tauri://localhost/assets/cutout-x.png");
    expect(fullUrl("/src/assets/x.png", "http://localhost:1420/")).toBe("http://localhost:1420/src/assets/x.png");
    expect(fullUrl("data:image/png;base64,AAAA", BUILT_APP)).toBe("data:image/png;base64,AAAA");
  });

  it("gives Pixi an address it keeps as it is in the built app", () => {
    // Pixi drops the host from a root-relative path on a tauri:// page...
    expect(path.toAbsolute("/assets/cutout-x.png", BUILT_APP)).toBe("tauri://assets/cutout-x.png");
    // ...and leaves a full address alone.
    const url = fullUrl("/assets/cutout-x.png", BUILT_APP);
    expect(path.toAbsolute(url, BUILT_APP)).toBe(url);
  });
});
