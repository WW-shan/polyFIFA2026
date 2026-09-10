import { describe, expect, test } from "vitest";
import { buyDecisionFromLegs } from "../../src/domain/decision.js";
import type { BuyTradeLeg, TradeResult } from "../../src/domain/types.js";
import {
  LiveExecutionError,
  LiveExecutor,
  normalizeConfirmedLiveOrderResult,
  type LiveOrderRequest
} from "../../src/execution/live-executor.js";

const config = {
  host: "https://unused.invalid", chainId: 137, signatureType: 1,
  privateKey: "offline-key", apiKey: "offline-key", apiSecret: "offline-secret", passphrase: "offline-passphrase"
};

const legs: BuyTradeLeg[] = ["a", "b"].map((id) => ({
  eventSlug: "event", marketSlug: `market-${id}`, question: "O/U 0.5",
  tokenId: `token-${id}`, conditionId: `condition-${id}`, outcome: "Over",
  strategy: "total_over_locked", locked: true,
  price: 0.97, availableSize: 100, shares: 100, notional: 97,
  estimatedFee: 0.0873, estimatedNetReturn: 0.03
}));

const order: LiveOrderRequest = {
  tokenId: "token-a", price: 0.97, size: 100, notional: 97,
  orderType: "FAK", tickSize: "0.001", negRisk: false, estimatedFee: 0.0873
};

function fill(request: LiveOrderRequest): TradeResult {
  return {
    mode: "live", status: "filled", orderId: `order-${request.tokenId}`,
    tokenId: request.tokenId, price: request.price, shares: request.size,
    notional: request.notional, fee: request.estimatedFee,
    estimatedPayout: request.size,
    estimatedProfit: request.size - request.notional - request.estimatedFee
  };
}

function matchedOrder(status = "MATCHED", size = "100") {
  return {
    id: "order-a", asset_id: order.tokenId, status,
    original_size: "100", size_matched: size, price: "0.97"
  };
}

function matchingTrade(patch: Record<string, unknown> = {}) {
  return {
    id: "trade-a", taker_order_id: "order-a", asset_id: order.tokenId,
    side: "BUY", size: "100", price: "0.97", status: "CONFIRMED", ...patch
  };
}

describe("live execution recovery", () => {
  test.each(["token-a", "token-b"])("T1 preserves the successful leg when %s throws after submission", async (failedToken) => {
    const decision = buyDecisionFromLegs(legs);
    const executor = new LiveExecutor(config, async () => ({
      async placeLimitBuy(request) {
        if (request.tokenId === failedToken) throw new Error("connection lost after posting");
        return fill(request);
      }
    }));

    const result = await executor.execute(decision);

    expect(result).toMatchObject({ status: "partial", shares: 100, notional: 97 });
    expect(result.legs).toHaveLength(2);
    expect(result.legs?.find((leg) => leg.tokenId === failedToken)).toMatchObject({
      status: "posted", shares: 0, notional: 0, fee: 0, estimatedPayout: 0,
      raw: { message: "connection lost after posting" }
    });
    expect(result.legs?.find((leg) => leg.tokenId !== failedToken)).toMatchObject({
      status: "filled", shares: 100, notional: 97
    });
    expect(result.legs).toEqual(legs.map((leg) => expect.objectContaining({
      tokenId: leg.tokenId, conditionId: leg.conditionId, marketSlug: leg.marketSlug,
      eventSlug: leg.eventSlug, outcome: leg.outcome, strategy: leg.strategy
    })));
  });

  test("T1 waits for a slower successful leg after another submission throws", async () => {
    let resolveFill!: (result: TradeResult) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const slowFill = new Promise<TradeResult>((resolve) => { resolveFill = resolve; });
    const executor = new LiveExecutor(config, async () => ({
      async placeLimitBuy(request) {
        if (request.tokenId === "token-a") throw new Error("submission outcome unknown");
        signalStarted();
        return slowFill;
      }
    }));
    let finished = false;
    const resultPromise = executor.execute(buyDecisionFromLegs(legs)).then(
      (result) => { finished = true; return result; },
      (error: unknown) => { finished = true; throw error; }
    );
    // Attach a rejection handler while checking whether the entire basket returned early.
    void resultPromise.catch(() => {});
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const finishedBeforeFill = finished;
    resolveFill(fill({ ...order, tokenId: "token-b" }));

    expect(finishedBeforeFill).toBe(false);
    expect((await resultPromise).legs?.[1]).toMatchObject({ status: "filled", notional: 97 });
  });

  test("T1 retains a known order id and diagnostics for an uncertain single submission", async () => {
    const decision = buyDecisionFromLegs([legs[0]!]);
    delete decision.legs;
    const executor = new LiveExecutor(config, async () => ({
      async placeLimitBuy() {
        throw new LiveExecutionError("LIVE_ORDER_CONFIRMATION_FAILED", "confirmation interrupted", {
          raw: { postResponse: { orderID: "accepted-order-a" } }
        });
      }
    }));

    expect(await executor.execute(decision)).toMatchObject({
      status: "posted", orderId: "accepted-order-a", shares: 0, notional: 0,
      raw: { code: "LIVE_ORDER_CONFIRMATION_FAILED", message: "confirmation interrupted" }
    });
  });

  test.each(["CANCELED", "ORDER_STATUS_CANCELED"])("T3 keeps %s with matched shares active while trades lag", (status) => {
    const result = normalizeConfirmedLiveOrderResult(order, {
      postResponse: { success: true, orderID: "order-a", status: "matched" },
      order: matchedOrder(status, "40"), trades: [], openOrders: [],
      cancelResponse: { canceled: ["order-a"] }
    });

    expect(result).toMatchObject({ status: "posted", shares: 0, notional: 0 });
    expect(result.raw).toMatchObject({ order: { size_matched: "40" } });
  });

  test("T3 keeps verified partial fills after cancellation of the remainder", () => {
    const result = normalizeConfirmedLiveOrderResult(order, {
      postResponse: { success: true, orderID: "order-a", status: "matched" },
      order: matchedOrder("CANCELED", "40"),
      trades: [matchingTrade({ size: "40" })], openOrders: [],
      cancelResponse: { canceled: ["order-a"] }
    });

    expect(result).toMatchObject({ status: "partial", shares: 40, notional: 38.8 });
  });

  test.each([
    [matchingTrade({ id: "failed-10", size: "10", status: "FAILED" })],
    Array.from({ length: 4 }, () => matchingTrade({ id: "same-failed-10", size: "10", status: "FAILED" })),
    [{
      id: "maker-trade", status: "FAILED", asset_id: order.tokenId, size: "40",
      maker_orders: [{ order_id: "order-a", asset_id: order.tokenId, matched_amount: "10", price: "0.97" }]
    }]
  ].map((trades) => ({ trades })))("T3 retains unmatched accounting remainder after cancellation: %j", ({ trades }) => {
    const result = normalizeConfirmedLiveOrderResult(order, {
      postResponse: { success: true, orderID: "order-a", status: "matched" },
      order: matchedOrder("CANCELED", "40"), trades, openOrders: [], cancelResponse: { canceled: ["order-a"] }
    });
    expect(result).toMatchObject({ status: "posted", shares: 0, notional: 0 });
  });

  test.each([
    [matchingTrade({ id: "failed-40", size: "40", status: "FAILED" })],
    [10, 30].map((size) => matchingTrade({ id: `failed-${size}`, size: String(size), status: "FAILED" }))
  ].map((trades) => ({ trades })))("T3 permits an inactive result when distinct failed executions explain all matched shares: %j", ({ trades }) => {
    const result = normalizeConfirmedLiveOrderResult(order, {
      postResponse: { success: true, orderID: "order-a", status: "matched" },
      order: matchedOrder("CANCELED", "40"), trades, openOrders: [], cancelResponse: { canceled: ["order-a"] }
    });
    expect(["canceled", "rejected"]).toContain(result.status);
    expect(result).toMatchObject({ shares: 0, notional: 0 });
  });

  test("T3 preserves verified fills and reserves the unexplained remainder of a canceled match", () => {
    const result = normalizeConfirmedLiveOrderResult(order, {
      postResponse: { success: true, orderID: "order-a", status: "matched" },
      order: matchedOrder("CANCELED", "40"),
      trades: [matchingTrade({ id: "confirmed-10", size: "10" }), matchingTrade({ id: "failed-10", size: "10", status: "FAILED" })],
      openOrders: [], cancelResponse: { canceled: ["order-a"] }
    });
    expect(result).toMatchObject({ status: "posted", shares: 10, notional: 9.7 });
    expect(result.reservedNotional).toBeGreaterThanOrEqual(19.4);
  });

  test("T3 duplicate confirmed rows cannot account for the unresolved canceled remainder", () => {
    const result = normalizeConfirmedLiveOrderResult(order, {
      postResponse: { success: true, orderID: "order-a", status: "matched" },
      order: matchedOrder("CANCELED", "40"),
      trades: [
        ...Array.from({ length: 3 }, () => matchingTrade({ id: "confirmed-10", size: "10" })),
        matchingTrade({ id: "failed-10", size: "10", status: "FAILED" })
      ],
      openOrders: [], cancelResponse: { canceled: ["order-a"] }
    });
    expect(result).toMatchObject({ status: "posted", shares: 10, notional: 9.7 });
  });

  test("T3/O3 the same execution cannot count as both a confirmed fill and a failed quantity", () => {
    const result = normalizeConfirmedLiveOrderResult(order, {
      postResponse: { success: true, orderID: "order-a", status: "matched" },
      order: matchedOrder("CANCELED", "40"),
      trades: [
        matchingTrade({ id: "execution-10", size: "10" }),
        matchingTrade({ id: "execution-10", size: "10", status: "FAILED", err_msg: "execution reverted" })
      ],
      openOrders: [], cancelResponse: { canceled: ["order-a"] }
    });
    expect(result).toMatchObject({ status: "posted", shares: 0, notional: 0 });
  });

  test.each([
    { status: "FAILED", err_msg: "execution reverted" },
    { status: "TRADE_STATUS_FAILED" },
    { status: "CONFIRMED", err_msg: "execution reverted" }
  ])("O3 does not replace explicit trade failure with a matched order fill: %j", (patch) => {
    const result = normalizeConfirmedLiveOrderResult(order, {
      postResponse: { success: true, orderID: "order-a", status: "matched" },
      order: matchedOrder(), trades: [matchingTrade(patch)], openOrders: []
    });

    expect(result).toMatchObject({ status: "rejected", shares: 0, notional: 0, estimatedPayout: 0 });
    expect(result.raw).toMatchObject({ trades: [expect.objectContaining(patch)] });
  });

  test.each(["TRADE_STATUS_MATCHED", "TRADE_STATUS_MINED", "TRADE_STATUS_RETRYING"])(
    "O3 preserves pending %s evidence despite a MATCHED order snapshot", (status) => {
      const result = normalizeConfirmedLiveOrderResult(order, {
        postResponse: { success: true, orderID: "order-a", status: "matched" },
        order: matchedOrder(), trades: [matchingTrade({ status })], openOrders: []
      });

      expect(result).toMatchObject({ status: "posted", shares: 0, notional: 0 });
    }
  );

  test.each(["parent", "maker"])("O3 respects failure evidence on the %s of a matching maker order", (source) => {
    const failed = { status: "FAILED", err_msg: "execution reverted" };
    const result = normalizeConfirmedLiveOrderResult(order, {
      postResponse: { success: true, orderID: "order-a", status: "matched" },
      order: matchedOrder(),
      trades: [{
        id: "trade-maker", asset_id: order.tokenId, status: "CONFIRMED", price: "0.97",
        ...(source === "parent" ? failed : {}),
        maker_orders: [{
          order_id: "order-a", asset_id: order.tokenId, matched_amount: "100", price: "0.97",
          ...(source === "maker" ? failed : {})
        }]
      }],
      openOrders: []
    });

    expect(result).toMatchObject({ status: "rejected", shares: 0, notional: 0 });
  });

  test("O3 unrelated failed trades do not suppress the valid order snapshot fallback", () => {
    const result = normalizeConfirmedLiveOrderResult(order, {
      postResponse: { success: true, orderID: "order-a", status: "matched" },
      order: matchedOrder(),
      trades: [matchingTrade({ taker_order_id: "other-order", status: "FAILED" })], openOrders: []
    });

    expect(result).toMatchObject({ status: "filled", shares: 100, notional: 97 });
  });
});
