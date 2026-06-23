import { describe, expect, test, vi } from "vitest";
import { LiveExecutionError, LiveExecutor, liveConfigFromEnv, normalizeLiveOrderResult } from "../../src/execution/live-executor.js";
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
      fee: buyDecision.estimatedFee,
      estimatedProfit: buyDecision.shares - buyDecision.notional - buyDecision.estimatedFee
    });
  });

  test("accepts matched CLOB responses with an empty errorMsg", () => {
    const result = normalizeLiveOrderResult(liveOrder, {
      success: true,
      errorMsg: "",
      orderID: "order-1",
      status: "matched",
      transactionsHashes: ["0xtx"]
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "filled",
      orderId: "order-1"
    });
  });

  test("normalizes live results with the decision notional instead of recomputing floating math", () => {
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

    expect(result.notional).toBe(1);
    expect(result.estimatedProfit).toBeCloseTo(order.size - order.notional - order.estimatedFee);
  });
});
