import { describe, expect, test, vi } from "vitest";
import { LiveExecutor, liveConfigFromEnv } from "../../src/execution/live-executor.js";
import type { LiveOrderRequest, LiveRestingLevel } from "../../src/execution/live-executor.js";
import type { TradeResult } from "../../src/domain/types.js";

const levels: LiveRestingLevel[] = [0.80, 0.85, 0.88, 0.90, 0.92].map((price) => ({
  tokenId: "token-swiatek",
  price,
  shares: 1,
  notional: price,
  tickSize: "0.01",
  negRisk: false,
  eventSlug: "atp-swiatek-gauff-2026-10-03",
  marketSlug: "atp-swiatek-gauff-2026-10-03-moneyline",
  conditionId: "cond-ml",
  outcome: "Iga Swiatek"
}));

function config() {
  return liveConfigFromEnv({
    POLY_PRIVATE_KEY: "0xabc",
    POLY_API_KEY: "key",
    POLY_API_SECRET: "secret",
    POLY_PASSPHRASE: "passphrase",
    POLY_FUNDER_ADDRESS: "0xfunder",
    POLY_SIGNATURE_TYPE: "1"
  });
}

function posted(order: LiveOrderRequest): TradeResult {
  return {
    mode: "live",
    status: "posted",
    orderId: `order-${order.price}`,
    tokenId: order.tokenId,
    price: order.price,
    shares: order.size,
    notional: order.notional,
    fee: order.estimatedFee,
    estimatedPayout: order.size,
    estimatedProfit: order.size - order.notional,
    raw: { success: true }
  };
}

describe("LiveExecutor.placeRestingLadder", () => {
  test("submits one resting GTC order per level without merging", async () => {
    const placeLimitBuy = vi.fn(async (order: LiveOrderRequest) => posted(order));
    const executor = new LiveExecutor(config(), async () => ({ placeLimitBuy }));

    const results = await executor.placeRestingLadder(levels);

    expect(results).toHaveLength(5);
    expect(placeLimitBuy).toHaveBeenCalledTimes(5);
    expect(placeLimitBuy.mock.calls.map(([order]) => order.price)).toEqual([0.80, 0.85, 0.88, 0.90, 0.92]);
    for (const [order] of placeLimitBuy.mock.calls) {
      expect(order.orderType).toBe("GTC");
      expect(order.postOnly).toBe(true);
      expect(order.size).toBe(1);
    }
  });

  test("ignores a taker order type and always rests the ladder", async () => {
    const placeLimitBuy = vi.fn(async (order: LiveOrderRequest) => posted(order));
    const executor = new LiveExecutor(config(), async () => ({ placeLimitBuy }));

    await executor.placeRestingLadder(levels, { orderType: "FAK" });

    expect(placeLimitBuy).toHaveBeenCalledWith(expect.objectContaining({ orderType: "GTC", postOnly: true }));
  });

  test("signs a bounded GTD expiry when requested", async () => {
    const placeLimitBuy = vi.fn(async (order: LiveOrderRequest) => posted(order));
    const executor = new LiveExecutor(config(), async () => ({ placeLimitBuy }));

    await executor.placeRestingLadder(levels, { orderType: "GTD", restSeconds: 180 });

    const [order] = placeLimitBuy.mock.calls[0]!;
    expect(order.expiration).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("a beforeSubmit veto rejects only that level", async () => {
    const placeLimitBuy = vi.fn(async (order: LiveOrderRequest) => posted(order));
    const executor = new LiveExecutor(config(), async () => ({ placeLimitBuy }));

    const results = await executor.placeRestingLadder(levels, {
      beforeSubmit: (order) => {
        if (order.price === 0.88) throw new Error("crossed before submit");
      }
    });

    expect(placeLimitBuy).toHaveBeenCalledTimes(4);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ price: 0.88 });
  });

  test("returns nothing for an empty ladder without touching credentials", async () => {
    const placeLimitBuy = vi.fn();
    const executor = new LiveExecutor(liveConfigFromEnv({}), async () => ({ placeLimitBuy }));
    await expect(executor.placeRestingLadder([])).resolves.toEqual([]);
    expect(placeLimitBuy).not.toHaveBeenCalled();
  });
});
