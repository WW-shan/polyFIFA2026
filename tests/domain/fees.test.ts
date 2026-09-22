import { describe, expect, test } from "vitest";
import { netReturnRate, SPORTS_TAKER_FEE_RATE, sportsTakerFeePerShare } from "../../src/domain/fees.js";

describe("sports fee math", () => {
  test("charges the official 5% sports taker rate per share", () => {
    expect(SPORTS_TAKER_FEE_RATE).toBe(0.05);
    expect(sportsTakerFeePerShare(0.70)).toBeCloseTo(0.0105, 10);
    expect(sportsTakerFeePerShare(0.97)).toBeCloseTo(0.001455, 10);
    expect(sportsTakerFeePerShare(0.98)).toBeCloseTo(0.00098, 10);
  });

  test("0.97 entry produces about 2.94% net return after sports taker fee", () => {
    expect(netReturnRate(0.97)).toBeCloseTo(0.029428, 5);
  });

  test("0.98 entry produces about 1.94% net return after sports taker fee", () => {
    expect(netReturnRate(0.98)).toBeCloseTo(0.019408, 5);
  });

  test("100 shares at 0.70 cost 1.05 USDC in taker fees, matching the published fee table", () => {
    expect(sportsTakerFeePerShare(0.70) * 100).toBeCloseTo(1.05, 10);
  });
});
