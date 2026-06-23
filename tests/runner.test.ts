import { describe, expect, test } from "vitest";
import { buildThresholds } from "../src/runner.js";

describe("buildThresholds", () => {
  test("defaults to Polymarket's 1 pUSD minimum notional so small live balances can trade", () => {
    expect(buildThresholds(1.2).minimumNotional).toBe(1);
  });
});
