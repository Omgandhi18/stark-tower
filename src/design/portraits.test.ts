import { describe, expect, it } from "vitest";
import { portraitKey, portraitUrl, portraitUrls } from "./portraits";
import type { Look } from "../lib/bindings";
const look: Look = {
  id: "look-test",
  choices: { figure: "recon", options: {}, note: "" },
  paths: { own: "/looks/look-test/own.png", "studio-office": "/looks/look-test/studio-office.png" },
  progress: {},
  errors: {},
  revision: 2,
  saved: true,
};
describe("agent portraits", () => {
  it("keys by the agent's look and base figure, including disabled agents", () => {
    expect(portraitKey({ figure: "recon", look: "look-test" })).toEqual({ figure: "recon", look: "look-test" });
    expect(portraitKey(undefined)).toBeUndefined();
    expect(portraitKey({ figure: "recon" })).toEqual({ figure: "recon", look: undefined });
  });
  it("resolves custom outfits, own look and figure in order", () => {
    const key = portraitKey({ figure: "recon", look: look.id });
    const looks = { [look.id]: look };
    expect(portraitUrl(key, "studio-office", looks)).toBe("/looks/look-test/studio-office.png?v=2");
    expect(portraitUrl(key, "mori-cafe", looks)).toBe("/looks/look-test/own.png?v=2");
    expect(portraitUrl(key, null, looks)).toBe("/looks/look-test/own.png?v=2");
    expect(portraitUrls(key, "studio-office", looks)).toHaveLength(3);
    expect(portraitUrl(key, "studio-office")).toContain("recon.png");
    expect(portraitUrl(undefined)).toBeUndefined();
  });
});
