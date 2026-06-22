import { describe, expect, test } from "vitest";
import { netReturnRate, sportsTakerFeePerShare } from "../../src/domain/fees.js";

describe("sports fee math", () => {
  test("0.97 entry produces about 3.00% net return after sports taker fee", () => {
    expect(sportsTakerFeePerShare(0.97)).toBeCloseTo(0.000873, 6);
    expect(netReturnRate(0.97)).toBeCloseTo(0.03003, 5);
  });

  test("0.98 entry produces about 1.98% net return after sports taker fee", () => {
    expect(sportsTakerFeePerShare(0.98)).toBeCloseTo(0.000588, 6);
    expect(netReturnRate(0.98)).toBeCloseTo(0.01981, 5);
  });
});
