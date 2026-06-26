import { describe, expect, test, vi } from "vitest";
import { LiveExecutionError, LiveExecutor, liveConfigFromEnv, normalizeConfirmedLiveOrderResult, normalizeLiveOrderResult } from "../../src/execution/live-executor.js";
import type { LiveOrderRequest } from "../../src/execution/live-executor.js";
import type { BuyTradeDecision, TradeResult } from "../../src/domain/types.js";

const buyDecision: BuyTradeDecision = {
  action: "BUY",
  eventSlug: "fifwc-esp-ksa-2026-06-21",
  marketSlug: "fifwc-esp-ksa-2026-06-21-spread-home-3pt5",
  question: "Spread: Spain (-3.5)",
  tokenId: "token-spain-3p5",
  conditionId: "cond-spain-3p5",
  outcome: "Spain",
  line: -3.5,
  bestAsk: 0.97,
  availableSize: 200,
  shares: 100,
  notional: 97,
  estimatedFee: 0.0873,
  estimatedNetReturn: 0.03003,
  tickSize: "0.001",
  negRisk: false
};

const liveOrder: LiveOrderRequest = {
  tokenId: buyDecision.tokenId,
  price: buyDecision.bestAsk,
  size: buyDecision.shares,
  notional: buyDecision.notional,
  orderType: "FOK",
  tickSize: "0.001",
  negRisk: false,
  estimatedFee: buyDecision.estimatedFee
};

describe("LiveExecutor", () => {
  test("fails clearly when required credentials are missing", async () => {
    const executor = new LiveExecutor(liveConfigFromEnv({}));

    await expect(executor.execute(buyDecision)).rejects.toMatchObject({
      code: "LIVE_CREDENTIALS_MISSING",
      missing: ["POLY_PRIVATE_KEY", "POLY_API_KEY", "POLY_API_SECRET", "POLY_PASSPHRASE"]
    });
  });

  test("passes order details to injected live client", async () => {
    const placeLimitBuy = vi.fn(async (): Promise<TradeResult> => ({
      mode: "live",
      status: "posted",
      orderId: "live-order-1",
      tokenId: buyDecision.tokenId,
      price: buyDecision.bestAsk,
      shares: buyDecision.shares,
      notional: buyDecision.notional,
      fee: buyDecision.estimatedFee,
      estimatedPayout: buyDecision.shares,
      estimatedProfit: buyDecision.shares - buyDecision.notional - buyDecision.estimatedFee,
      raw: { success: true }
    }));
    const executor = new LiveExecutor(
      liveConfigFromEnv({
        POLY_PRIVATE_KEY: "0xabc",
        POLY_API_KEY: "key",
        POLY_API_SECRET: "secret",
        POLY_PASSPHRASE: "passphrase",
        POLY_FUNDER_ADDRESS: "0xfunder",
        POLY_SIGNATURE_TYPE: "1"
      }),
      async () => ({ placeLimitBuy })
    );

    const result = await executor.execute(buyDecision, { orderType: "FAK" });

    expect(result).toMatchObject({ mode: "live", status: "posted", orderId: "live-order-1" });
    expect(placeLimitBuy).toHaveBeenCalledWith({
      tokenId: "token-spain-3p5",
      price: 0.97,
      size: 100,
      notional: 97,
      orderType: "FAK",
      tickSize: "0.001",
      negRisk: false,
      estimatedFee: 0.0873
    });
  });

  test("uses deposit wallet env as the live funder with POLY_1271 signing", async () => {
    const placeLimitBuy = vi.fn(async (): Promise<TradeResult> => ({
      mode: "live",
      status: "posted",
      orderId: "live-order-1",
      tokenId: buyDecision.tokenId,
      price: buyDecision.bestAsk,
      shares: buyDecision.shares,
      notional: buyDecision.notional,
      fee: buyDecision.estimatedFee,
      estimatedPayout: buyDecision.shares,
      estimatedProfit: buyDecision.shares - buyDecision.notional - buyDecision.estimatedFee,
      raw: { success: true }
    }));
    let capturedConfig: { signatureType: number; funderAddress?: string } | undefined;
    const executor = new LiveExecutor(
      liveConfigFromEnv({
        POLY_PRIVATE_KEY: "0xabc",
        POLY_API_KEY: "key",
        POLY_API_SECRET: "secret",
        POLY_PASSPHRASE: "passphrase",
        POLY_FUNDER_ADDRESS: "0xrelayerSignerAddress",
        POLY_DEPOSIT_WALLET_ADDRESS: "0xdepositWalletAddress",
        POLY_SIGNATURE_TYPE: "1"
      }),
      async (config) => {
        capturedConfig = config;
        return { placeLimitBuy };
      }
    );

    await executor.execute(buyDecision);

    expect(capturedConfig).toMatchObject({
      signatureType: 3,
      funderAddress: "0xdepositWalletAddress"
    });
  });

  test("LiveExecutionError exposes a stable error code", () => {
    const error = new LiveExecutionError("LIVE_ORDER_REJECTED", "rejected");

    expect(error.code).toBe("LIVE_ORDER_REJECTED");
    expect(error.message).toBe("rejected");
  });

  test("rejects CLOB error objects without success false", () => {
    expect(() => normalizeLiveOrderResult(liveOrder, { error: "not enough balance", status: 400 })).toThrow(LiveExecutionError);
  });

  test("does not treat unmatched live status as filled", () => {
    const result = normalizeLiveOrderResult(liveOrder, {
      success: true,
      orderID: "order-1",
      status: "unmatched"
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "posted",
      orderId: "order-1",
      shares: 0,
      notional: 0,
      fee: 0,
      estimatedPayout: 0,
      estimatedProfit: 0
    });
  });

  test("legacy normalization does not fabricate fills from matched post responses", () => {
    const result = normalizeLiveOrderResult(liveOrder, {
      success: true,
      errorMsg: "",
      orderID: "order-1",
      status: "matched",
      transactionsHashes: ["0xtx"]
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "posted",
      orderId: "order-1",
      shares: 0,
      notional: 0,
      fee: 0,
      estimatedPayout: 0,
      estimatedProfit: 0
    });
  });

  test("legacy normalization does not fabricate decision notional from matched post responses", () => {
    const order: LiveOrderRequest = {
      ...liveOrder,
      price: 0.91,
      size: 1.098901098901099,
      notional: 1
    };

    const result = normalizeLiveOrderResult(order, {
      success: true,
      orderID: "order-1",
      status: "matched"
    });

    expect(result.shares).toBe(0);
    expect(result.notional).toBe(0);
    expect(result.estimatedProfit).toBe(0);
  });

  test("normalizes confirmed partial fills from matching trades", () => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "matched" },
      trades: [
        {
          id: "trade-1",
          taker_order_id: "order-1",
          asset_id: liveOrder.tokenId,
          side: "BUY",
          size: "0.5",
          price: "0.97",
          fee_rate_bps: "0",
          status: "CONFIRMED"
        }
      ],
      openOrders: []
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "partial",
      orderId: "order-1",
      tokenId: liveOrder.tokenId,
      price: 0.97,
      shares: 0.5,
      notional: 0.485
    });
    expect(result.fee).toBeCloseTo(0.0004365);
    expect(result.estimatedPayout).toBe(0.5);
    expect(result.estimatedProfit).toBeCloseTo(0.0145635);
  });

  test("normalizes Polymarket MATCHED trades with transaction hashes as filled", () => {
    const matchedOrder: LiveOrderRequest = {
      ...liveOrder,
      tokenId: "70002980913954115591354587263173571697242905332674012331302887342474232856448",
      price: 0.99,
      size: 2.968309090909091,
      notional: 2.938626,
      tickSize: "0.01",
      estimatedFee: 0.0008815878000000007
    };

    const result = normalizeConfirmedLiveOrderResult(matchedOrder, {
      postResponse: {
        success: true,
        errorMsg: "",
        orderID: "0x17dfa002745392a84456a7783c88e3c4875d676b050dc68cff64d407c696019f",
        takingAmount: "2.959594",
        makingAmount: "2.929998",
        status: "matched",
        transactionsHashes: ["0x913ee80995286fb7316eef8443061ec5864c83c306e4572483d83e1bbb3bc1da"]
      },
      trades: [
        {
          taker_order_id: "0x17dfa002745392a84456a7783c88e3c4875d676b050dc68cff64d407c696019f",
          asset_id: matchedOrder.tokenId,
          side: "BUY",
          size: "2.959594",
          price: "0.99",
          status: "MATCHED",
          transaction_hash: "0x913ee80995286fb7316eef8443061ec5864c83c306e4572483d83e1bbb3bc1da"
        }
      ],
      openOrders: [],
      order: {
        id: "0x17dfa002745392a84456a7783c88e3c4875d676b050dc68cff64d407c696019f",
        status: "MATCHED",
        asset_id: matchedOrder.tokenId,
        side: "BUY",
        original_size: "2.9595",
        size_matched: "2.959594",
        price: "0.99",
        order_type: "FOK"
      }
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "filled",
      orderId: "0x17dfa002745392a84456a7783c88e3c4875d676b050dc68cff64d407c696019f",
      tokenId: matchedOrder.tokenId,
      price: 0.99,
      shares: 2.959594
    });
    expect(result.notional).toBeCloseTo(2.92999806);
  });

  test("counts TRADE_STATUS_CONFIRMED as a confirmed fill", () => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "matched" },
      trades: [
        {
          id: "trade-1",
          taker_order_id: "order-1",
          asset_id: liveOrder.tokenId,
          side: "BUY",
          size: "0.5",
          price: "0.97",
          status: "TRADE_STATUS_CONFIRMED"
        }
      ],
      openOrders: []
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "partial",
      orderId: "order-1",
      shares: 0.5,
      notional: 0.485
    });
  });

  test("returns posted when confirmation reads fail after a successful post", () => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "matched" },
      confirmationErrors: [
        { source: "getTrades", error: "timeout" },
        { source: "getOpenOrders", error: new Error("temporarily unavailable") }
      ]
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "posted",
      orderId: "order-1",
      tokenId: liveOrder.tokenId,
      shares: 0,
      notional: 0,
      fee: 0,
      estimatedPayout: 0,
      estimatedProfit: 0,
      raw: {
        postResponse: { success: true, orderID: "order-1", status: "matched" },
        confirmationErrors: [
          { source: "getTrades", error: "timeout" },
          { source: "getOpenOrders", error: expect.any(Error) }
        ]
      }
    });
  });

  test.each([
    ["failed status", { status: "FAILED" }],
    ["TRADE_STATUS_FAILED", { status: "TRADE_STATUS_FAILED" }],
    ["errored payload", { status: "CONFIRMED", err_msg: "execution reverted" }]
  ])("ignores matching trades with %s", (_caseName, tradePatch) => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "matched" },
      trades: [
        {
          id: "trade-1",
          taker_order_id: "order-1",
          asset_id: liveOrder.tokenId,
          side: "BUY",
          size: "0.5",
          price: "0.97",
          ...tradePatch
        }
      ],
      openOrders: []
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "rejected",
      orderId: "order-1",
      shares: 0,
      notional: 0,
      fee: 0,
      estimatedPayout: 0,
      estimatedProfit: 0
    });
  });

  test.each([
    "TRADE_STATUS_MATCHED",
    "TRADE_STATUS_MINED",
    "TRADE_STATUS_RETRYING"
  ])("reports posted for matching pending %s trades", (status) => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "matched" },
      trades: [
        {
          id: "trade-1",
          taker_order_id: "order-1",
          asset_id: liveOrder.tokenId,
          side: "BUY",
          size: "0.5",
          price: "0.97",
          status
        }
      ],
      openOrders: []
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "posted",
      orderId: "order-1",
      tokenId: liveOrder.tokenId,
      shares: 0,
      notional: 0,
      fee: 0,
      estimatedPayout: 0,
      estimatedProfit: 0
    });
  });

  test("keeps matched FOK post responses active when confirmations are temporarily empty", () => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "matched" },
      trades: [],
      openOrders: []
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "posted",
      orderId: "order-1",
      tokenId: liveOrder.tokenId,
      price: liveOrder.price,
      shares: 0,
      notional: 0,
      fee: 0,
      estimatedPayout: 0,
      estimatedProfit: 0
    });
  });

  test("reports posted when order lookup fails and no fill or open order confirms the post", () => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "matched" },
      orderError: new Error("order lookup 404"),
      trades: [],
      openOrders: []
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "posted",
      orderId: "order-1",
      tokenId: liveOrder.tokenId,
      shares: 0,
      notional: 0,
      fee: 0,
      estimatedPayout: 0,
      estimatedProfit: 0
    });
    expect(result.raw).toMatchObject({
      orderError: expect.any(Error)
    });
  });

  test("normalizes confirmed fills when order lookup fails", () => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "matched" },
      orderError: new Error("order lookup timeout"),
      trades: [
        {
          id: "trade-1",
          taker_order_id: "order-1",
          asset_id: liveOrder.tokenId,
          side: "BUY",
          size: "100",
          price: "0.97",
          status: "TRADE_STATUS_CONFIRMED"
        }
      ],
      openOrders: []
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "filled",
      orderId: "order-1",
      shares: 100,
      notional: 97
    });
    expect(result.raw).toMatchObject({
      orderError: expect.any(Error)
    });
  });

  test("reports posted when a matching open order remains without confirmed trades", () => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "unmatched" },
      trades: [],
      openOrders: [{ id: "order-1", asset_id: liveOrder.tokenId }]
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "posted",
      orderId: "order-1",
      tokenId: liveOrder.tokenId,
      price: liveOrder.price,
      shares: 0,
      notional: 0,
      fee: 0,
      estimatedPayout: 0,
      estimatedProfit: 0
    });
  });

  test("does not let ORDER_STATUS_MATCHED order state keep a fully confirmed fill partial", () => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "matched" },
      order: { id: "order-1", asset_id: liveOrder.tokenId, status: "ORDER_STATUS_MATCHED" },
      trades: [
        {
          id: "trade-1",
          taker_order_id: "order-1",
          asset_id: liveOrder.tokenId,
          side: "BUY",
          size: "100",
          price: "0.97",
          status: "TRADE_STATUS_CONFIRMED"
        }
      ],
      openOrders: []
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "filled",
      orderId: "order-1",
      shares: 100,
      notional: 97
    });
  });

  test("keeps ORDER_STATUS_LIVE order state active without getOpenOrders evidence", () => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "unmatched" },
      order: { id: "order-1", asset_id: liveOrder.tokenId, status: "ORDER_STATUS_LIVE" },
      trades: [],
      openOrders: []
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "posted",
      orderId: "order-1",
      shares: 0,
      notional: 0
    });
  });

  test("does not let stale ORDER_STATUS_LIVE order state keep a fully confirmed fill partial", () => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "matched" },
      order: { id: "order-1", asset_id: liveOrder.tokenId, status: "ORDER_STATUS_LIVE" },
      trades: [
        {
          id: "trade-1",
          taker_order_id: "order-1",
          asset_id: liveOrder.tokenId,
          side: "BUY",
          size: "100",
          price: "0.97",
          status: "TRADE_STATUS_CONFIRMED"
        }
      ],
      openOrders: []
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "filled",
      orderId: "order-1",
      shares: 100,
      notional: 97
    });
  });

  test("reports canceled for terminal ORDER_STATUS_CANCELED order state with no fills", () => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "unmatched" },
      order: { id: "order-1", asset_id: liveOrder.tokenId, status: "ORDER_STATUS_CANCELED" },
      trades: [],
      openOrders: []
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "canceled",
      orderId: "order-1",
      shares: 0,
      notional: 0
    });
  });

  test("keeps posted status when cancel response does not confirm cancellation", () => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "unmatched" },
      trades: [],
      openOrders: [{ id: "order-1", asset_id: liveOrder.tokenId }],
      cancelResponse: { success: false, errorMsg: "order was not canceled" }
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "posted",
      orderId: "order-1",
      tokenId: liveOrder.tokenId,
      shares: 0,
      notional: 0,
      fee: 0,
      estimatedPayout: 0,
      estimatedProfit: 0
    });
  });

  test("reports canceled only when cancel response confirms cancellation", () => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "unmatched" },
      trades: [],
      openOrders: [{ id: "order-1", asset_id: liveOrder.tokenId }],
      cancelResponse: { canceled: ["order-1"], not_canceled: {} }
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "canceled",
      orderId: "order-1",
      tokenId: liveOrder.tokenId,
      shares: 0,
      notional: 0,
      fee: 0,
      estimatedPayout: 0,
      estimatedProfit: 0
    });
  });

  test("keeps posted status when a pending trade exists after canceling open residual", () => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "matched" },
      trades: [
        {
          id: "trade-1",
          taker_order_id: "order-1",
          asset_id: liveOrder.tokenId,
          side: "BUY",
          size: "0.5",
          price: "0.97",
          status: "TRADE_STATUS_MATCHED"
        }
      ],
      openOrders: [{ id: "order-1", asset_id: liveOrder.tokenId }],
      cancelResponse: { canceled: ["order-1"], not_canceled: {} }
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "posted",
      orderId: "order-1",
      tokenId: liveOrder.tokenId,
      shares: 0,
      notional: 0,
      fee: 0,
      estimatedPayout: 0,
      estimatedProfit: 0
    });
  });
});
