import { describe, expect, test, vi } from "vitest";
import { SPORTS_TAKER_FEE_RATE } from "../../src/domain/fees.js";
import { capStakeToAvailableBalance, DEFAULT_POLYGON_RPC_URL, readPusdBalance } from "../../src/execution/balance.js";

describe("live pUSD balance helpers", () => {
  test("uses a public Polygon RPC that does not require a private API key by default", () => {
    expect(DEFAULT_POLYGON_RPC_URL).toBe("https://polygon-bor-rpc.publicnode.com");
  });

  test("caps stake to balance after keeping a small buffer and the taker fee reserve", () => {
    expect(capStakeToAvailableBalance(97, 1.825, { minimumNotional: 1, buffer: 0.05 })).toEqual({
      action: "USE_STAKE",
      stake: 1.690476
    });
  });

  test("uses the full fee-aware balance when requested stake is omitted", () => {
    expect(capStakeToAvailableBalance(undefined, 2.34, { minimumNotional: 1, buffer: 0.05 })).toEqual({
      action: "USE_STAKE",
      stake: 2.180952
    });
  });

  test("reserves the taker fee charged on top of the notional so the order stays affordable", () => {
    const decision = capStakeToAvailableBalance(100, 100, { minimumNotional: 1, buffer: 0 });
    expect(decision.action).toBe("USE_STAKE");
    const stake = decision.action === "USE_STAKE" ? decision.stake : 0;
    // Worst-case BUY fee per notional is feeRate * (1 - price) <= feeRate.
    expect(stake + stake * SPORTS_TAKER_FEE_RATE).toBeLessThanOrEqual(100);
    expect(stake).toBeCloseTo(95.238095, 6);
  });

  test("keeps an explicit stake that already covers its own fees", () => {
    expect(capStakeToAvailableBalance(50, 100, { minimumNotional: 1, buffer: 0 })).toEqual({
      action: "USE_STAKE",
      stake: 50
    });
  });

  test("honours an explicit fee reserve override", () => {
    expect(capStakeToAvailableBalance(undefined, 100, { minimumNotional: 1, buffer: 0, feeReserveRate: 0 })).toEqual({
      action: "USE_STAKE",
      stake: 100
    });
  });

  test("does not trade when buffered balance is below minimum notional", () => {
    expect(capStakeToAvailableBalance(97, 1.02, { minimumNotional: 1, buffer: 0.05 })).toMatchObject({
      action: "NO_TRADE",
      reason: "INSUFFICIENT_BALANCE"
    });
  });

  test("reads a six-decimal pUSD balance from an injected client", async () => {
    const readContract = vi.fn(async () => 1_234_567n);

    await expect(readPusdBalance("0x0000000000000000000000000000000000000001", undefined, { readContract })).resolves.toBe(1.234567);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: "balanceOf",
      args: ["0x0000000000000000000000000000000000000001"]
    }));
  });
});
