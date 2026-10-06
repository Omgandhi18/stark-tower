import { describe, expect, it } from "vitest";
import { defaultVoice, VOICE_GROUPS } from "./voiceModel";

describe("English voice choices", () => {
  it("groups all 28 English voices with plain labels and unique model names", () => {
    expect(VOICE_GROUPS.map((g) => g.label)).toEqual(["American female", "American male", "British female", "British male"]);
    const options = VOICE_GROUPS.flatMap((g) => g.options);
    expect(options).toHaveLength(28);
    expect(new Set(options.map((o) => o.value)).size).toBe(28);
    expect(options.find((o) => o.value === "bm_george")?.label).toBe("George, British man");
    expect(options.find((o) => o.value === "af_heart")?.label).toBe("Heart, American woman");
    expect(options.every((o) => /^(af|am|bf|bm)_/.test(o.value))).toBe(true);
  });
  it("uses built-in ids and gives custom agents the same default regardless of name", () => {
    expect(defaultVoice("jarvis")).toEqual({ name: "bm_george", speed: 0.95, pitch: 0 });
    expect(defaultVoice("dum-e")).toEqual({ name: "am_puck", speed: 1.15, pitch: 4 });
    expect(defaultVoice("George")).toEqual(defaultVoice("Alice"));
  });
});
