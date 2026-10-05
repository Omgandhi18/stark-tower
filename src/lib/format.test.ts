import { describe, expect, it } from "vitest";
import { formatCost, formatTokens } from "./format";

describe("formatCost", () => {
  it("shows dollars and cents, and flags sub-cent spend", () => {
    expect(formatCost(0.4213)).toBe("$0.42");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.004)).toBe("<$0.01");
  });
});

describe("formatTokens", () => {
  it("abbreviates thousands and millions", () => {
    expect(formatTokens(870)).toBe("870");
    expect(formatTokens(38_400)).toBe("38k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(2_000_000)).toBe("2M");
  });
});
