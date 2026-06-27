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

  test("places every leg of a ranked BUY plan in order", async () => {
    const decision = {
      ...buyDecision,
      bestAsk: 0.96,
      shares: 8.02,
      notional: 7.7494,
      estimatedFee: 0.00783846,
      estimatedNetReturn: 0.03,
      legs: [
        {
          eventSlug: buyDecision.eventSlug,
          marketSlug: "total-2p5",
          question: "Strong vs. Weak: O/U 2.5",
          tokenId: "total-under",
          conditionId: "cond-total-2p5",
          outcome: "Under",
          strategy: "total_under_loss_ge2",
          lossRequiresGoals: 2,
          price: 0.96,
          availableSize: 3,
          shares: 3,
          notional: 2.88,
          estimatedFee: 0.003456,
          estimatedNetReturn: 0.04,
          tickSize: "0.001",
          negRisk: false
        },
        {
          eventSlug: buyDecision.eventSlug,
          marketSlug: "weak-moneyline",
          question: "Will Weak win?",
          tokenId: "weak-no",
          conditionId: "cond-weak",
          outcome: "No",
          strategy: "loser_no",
          lossRequiresGoals: 2,
          price: 0.97,
          availableSize: 5.02,
          shares: 5.02,
          notional: 4.8694,
          estimatedFee: 0.00438246,
          estimatedNetReturn: 0.03,
          tickSize: "0.001",
          negRisk: false
        }
      ]
    } as BuyTradeDecision;
    const placeLimitBuy = vi.fn(async (order: LiveOrderRequest): Promise<TradeResult> => ({
      mode: "live",
      status: "filled",
      orderId: `live-${order.tokenId}`,
      tokenId: order.tokenId,
      price: order.price,
      shares: order.size,
      notional: order.notional,
      fee: order.estimatedFee,
      estimatedPayout: order.size,
      estimatedProfit: order.size - order.notional - order.estimatedFee
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

    const result = await executor.execute(decision, { orderType: "FAK" });

    expect(result).toMatchObject({
      mode: "live",
      status: "filled",
      shares: expect.closeTo(8.02, 8),
      notional: expect.closeTo(7.7494, 8),
      legs: [
        { tokenId: "total-under", price: 0.96 },
        { tokenId: "weak-no", price: 0.97 }
      ]
    });
    expect(placeLimitBuy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      tokenId: "total-under",
      price: 0.96,
      notional: 2.88,
      orderType: "FAK"
    }));
    expect(placeLimitBuy).toHaveBeenNthCalledWith(2, expect.objectContaining({
      tokenId: "weak-no",
      price: 0.97,
      notional: expect.closeTo(4.8694, 8),
      orderType: "FAK"
    }));
  });

  test("refreshes depth before live legs and skips prices below the return floor", async () => {
    const decision = {
      ...buyDecision,
      bestAsk: 0.96,
      shares: 8.02,
      notional: 7.7494,
      estimatedFee: 0.00783846,
      estimatedNetReturn: 0.03,
      legs: [
        {
          eventSlug: buyDecision.eventSlug,
          marketSlug: "total-2p5",
          question: "Strong vs. Weak: O/U 2.5",
          tokenId: "total-under",
          conditionId: "cond-total-2p5",
          outcome: "Under",
          strategy: "total_under_loss_ge2",
          lossRequiresGoals: 2,
          price: 0.96,
          availableSize: 3,
          shares: 3,
          notional: 2.88,
          estimatedFee: 0.003456,
          estimatedNetReturn: 0.04,
          tickSize: "0.001",
          negRisk: false
        },
        {
          eventSlug: buyDecision.eventSlug,
          marketSlug: "weak-moneyline",
          question: "Will Weak win?",
          tokenId: "weak-no",
          conditionId: "cond-weak",
          outcome: "No",
          strategy: "loser_no",
          lossRequiresGoals: 2,
          price: 0.97,
          availableSize: 5.02,
          shares: 5.02,
          notional: 4.8694,
          estimatedFee: 0.00438246,
          estimatedNetReturn: 0.03,
          tickSize: "0.001",
          negRisk: false
        }
      ]
    } as BuyTradeDecision;
    const placeLimitBuy = vi.fn(async (order: LiveOrderRequest): Promise<TradeResult> => ({
      mode: "live",
      status: "filled",
      orderId: `live-${order.tokenId}`,
      tokenId: order.tokenId,
      price: order.price,
      shares: order.size,
      notional: order.notional,
      fee: order.estimatedFee,
      estimatedPayout: order.size,
      estimatedProfit: order.size - order.notional - order.estimatedFee
    }));
    const refreshOrderbook = vi.fn(async (tokenId: string) => ({
      tokenId,
      bids: [],
      asks: tokenId === "total-under"
        ? [{ price: 0.96, size: 3 }]
        : [{ price: 0.995, size: 100 }]
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

    const result = await executor.execute(decision, {
      orderType: "FAK",
      refreshOrderbook,
      minimumNotional: 1,
      minimumNetReturn: 0.005,
      maxEntryPrice: 0.999999
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "filled",
      tokenId: "total-under",
      notional: 2.88,
      legs: [
        { tokenId: "total-under", price: 0.96, notional: 2.88 }
      ]
    });
    expect(refreshOrderbook).toHaveBeenCalledTimes(2);
    expect(placeLimitBuy).toHaveBeenCalledTimes(1);
    expect(placeLimitBuy).toHaveBeenCalledWith(expect.objectContaining({
      tokenId: "total-under",
      price: 0.96
    }));
  });

  test("reprices a live leg when the refreshed price still clears the return floor", async () => {
    const decision = {
      ...buyDecision,
      bestAsk: 0.97,
      shares: 5.02,
      notional: 4.8694,
      estimatedFee: 0.00438246,
      estimatedNetReturn: 0.03,
      legs: [
        {
          eventSlug: buyDecision.eventSlug,
          marketSlug: "weak-moneyline",
          question: "Will Weak win?",
          tokenId: "weak-no",
          conditionId: "cond-weak",
          outcome: "No",
          strategy: "loser_no",
          lossRequiresGoals: 2,
          price: 0.97,
          availableSize: 5.02,
          shares: 5.02,
          notional: 4.8694,
          estimatedFee: 0.00438246,
          estimatedNetReturn: 0.03,
          tickSize: "0.001",
          negRisk: false
        }
      ]
    } as BuyTradeDecision;
    const placeLimitBuy = vi.fn(async (order: LiveOrderRequest): Promise<TradeResult> => ({
      mode: "live",
      status: "filled",
      orderId: `live-${order.tokenId}`,
      tokenId: order.tokenId,
      price: order.price,
      shares: order.size,
      notional: order.notional,
      fee: order.estimatedFee,
      estimatedPayout: order.size,
      estimatedProfit: order.size - order.notional - order.estimatedFee
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

    const result = await executor.execute(decision, {
      orderType: "FAK",
      refreshOrderbook: async () => ({
        tokenId: "weak-no",
        bids: [],
        asks: [{ price: 0.975, size: 100 }]
      }),
      minimumNotional: 1,
      minimumNetReturn: 0.005,
      maxEntryPrice: 0.999999
    });

    expect(result).toMatchObject({
      status: "filled",
      tokenId: "weak-no",
      price: 0.975,
      notional: expect.closeTo(4.8694, 8)
    });
    expect(placeLimitBuy).toHaveBeenCalledWith(expect.objectContaining({
      tokenId: "weak-no",
      price: 0.975,
      notional: expect.closeTo(4.8694, 8)
    }));
  });

  test("refreshes planned live legs concurrently before placing orders", async () => {
    const decision = {
      ...buyDecision,
      bestAsk: 0.96,
      shares: 8.02,
      notional: 7.7494,
      estimatedFee: 0.00783846,
      estimatedNetReturn: 0.03,
      legs: [
        {
          eventSlug: buyDecision.eventSlug,
          marketSlug: "total-2p5",
          question: "Strong vs. Weak: O/U 2.5",
          tokenId: "total-under",
          conditionId: "cond-total-2p5",
          outcome: "Under",
          strategy: "total_under_loss_ge2",
          lossRequiresGoals: 2,
          price: 0.96,
          availableSize: 3,
          shares: 3,
          notional: 2.88,
          estimatedFee: 0.003456,
          estimatedNetReturn: 0.04,
          tickSize: "0.001",
          negRisk: false
        },
        {
          eventSlug: buyDecision.eventSlug,
          marketSlug: "weak-moneyline",
          question: "Will Weak win?",
          tokenId: "weak-no",
          conditionId: "cond-weak",
          outcome: "No",
          strategy: "loser_no",
          lossRequiresGoals: 2,
          price: 0.97,
          availableSize: 5.02,
          shares: 5.02,
          notional: 4.8694,
          estimatedFee: 0.00438246,
          estimatedNetReturn: 0.03,
          tickSize: "0.001",
          negRisk: false
        }
      ]
    } as BuyTradeDecision;
    const placeLimitBuy = vi.fn(async (order: LiveOrderRequest): Promise<TradeResult> => ({
      mode: "live",
      status: "filled",
      orderId: `live-${order.tokenId}`,
      tokenId: order.tokenId,
      price: order.price,
      shares: order.size,
      notional: order.notional,
      fee: order.estimatedFee,
      estimatedPayout: order.size,
      estimatedProfit: order.size - order.notional - order.estimatedFee
    }));
    const refreshResolvers = new Map<string, (book: { tokenId: string; bids: never[]; asks: Array<{ price: number; size: number }> }) => void>();
    const refreshOrderbook = vi.fn((tokenId: string) => new Promise<{ tokenId: string; bids: never[]; asks: Array<{ price: number; size: number }> }>((resolve) => {
      refreshResolvers.set(tokenId, resolve);
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

    const executePromise = executor.execute(decision, {
      orderType: "FAK",
      refreshOrderbook,
      minimumNotional: 1
    });
    await Promise.resolve();
    const callsBeforeAnyRefreshResolved = refreshOrderbook.mock.calls.length;

    expect(placeLimitBuy).not.toHaveBeenCalled();
    refreshResolvers.get("total-under")?.({ tokenId: "total-under", bids: [], asks: [{ price: 0.96, size: 3 }] });
    await Promise.resolve();
    refreshResolvers.get("weak-no")?.({ tokenId: "weak-no", bids: [], asks: [{ price: 0.97, size: 5.02 }] });
    const result = await executePromise;

    expect(callsBeforeAnyRefreshResolved).toBe(2);
    expect(result).toMatchObject({
      status: "filled",
      legs: [
        { tokenId: "total-under" },
        { tokenId: "weak-no" }
      ]
    });
  });

  test("places refreshed live legs concurrently", async () => {
    const decision = {
      ...buyDecision,
      bestAsk: 0.96,
      shares: 8.02,
      notional: 7.7494,
      estimatedFee: 0.00783846,
      estimatedNetReturn: 0.03,
      legs: [
        {
          eventSlug: buyDecision.eventSlug,
          marketSlug: "total-2p5",
          question: "Strong vs. Weak: O/U 2.5",
          tokenId: "total-under",
          conditionId: "cond-total-2p5",
          outcome: "Under",
          strategy: "total_under_loss_ge2",
          lossRequiresGoals: 2,
          price: 0.96,
          availableSize: 3,
          shares: 3,
          notional: 2.88,
          estimatedFee: 0.003456,
          estimatedNetReturn: 0.04,
          tickSize: "0.001",
          negRisk: false
        },
        {
          eventSlug: buyDecision.eventSlug,
          marketSlug: "weak-moneyline",
          question: "Will Weak win?",
          tokenId: "weak-no",
          conditionId: "cond-weak",
          outcome: "No",
          strategy: "loser_no",
          lossRequiresGoals: 2,
          price: 0.97,
          availableSize: 5.02,
          shares: 5.02,
          notional: 4.8694,
          estimatedFee: 0.00438246,
          estimatedNetReturn: 0.03,
          tickSize: "0.001",
          negRisk: false
        }
      ]
    } as BuyTradeDecision;
    const orderResolvers = new Map<string, (result: TradeResult) => void>();
    const placeLimitBuy = vi.fn((order: LiveOrderRequest) => new Promise<TradeResult>((resolve) => {
      orderResolvers.set(order.tokenId, resolve);
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

    const executePromise = executor.execute(decision, { orderType: "FAK" });
    await vi.waitFor(() => {
      expect(placeLimitBuy).toHaveBeenCalledTimes(2);
    });
    const callsBeforeAnyOrderResolved = placeLimitBuy.mock.calls.length;

    orderResolvers.get("total-under")?.({
      mode: "live",
      status: "filled",
      orderId: "live-total-under",
      tokenId: "total-under",
      price: 0.96,
      shares: 3,
      notional: 2.88,
      fee: 0.003456,
      estimatedPayout: 3,
      estimatedProfit: 3 - 2.88 - 0.003456
    });
    orderResolvers.get("weak-no")?.({
      mode: "live",
      status: "filled",
      orderId: "live-weak-no",
      tokenId: "weak-no",
      price: 0.97,
      shares: 5.02,
      notional: 4.8694,
      fee: 0.00438246,
      estimatedPayout: 5.02,
      estimatedProfit: 5.02 - 4.8694 - 0.00438246
    });
    const result = await executePromise;

    expect(callsBeforeAnyOrderResolved).toBe(2);
    expect(result).toMatchObject({
      status: "filled",
      legs: [
        { tokenId: "total-under" },
        { tokenId: "weak-no" }
      ]
    });
  });

  test("keeps successful concurrent legs when one live leg is rejected", async () => {
    const decision = {
      ...buyDecision,
      bestAsk: 0.96,
      shares: 8.02,
      notional: 7.7494,
      estimatedFee: 0.00783846,
      estimatedNetReturn: 0.03,
      legs: [
        {
          eventSlug: buyDecision.eventSlug,
          marketSlug: "total-2p5",
          question: "Strong vs. Weak: O/U 2.5",
          tokenId: "total-under",
          conditionId: "cond-total-2p5",
          outcome: "Under",
          strategy: "total_under_loss_ge2",
          lossRequiresGoals: 2,
          price: 0.96,
          availableSize: 3,
          shares: 3,
          notional: 2.88,
          estimatedFee: 0.003456,
          estimatedNetReturn: 0.04,
          tickSize: "0.001",
          negRisk: false
        },
        {
          eventSlug: buyDecision.eventSlug,
          marketSlug: "weak-moneyline",
          question: "Will Weak win?",
          tokenId: "weak-no",
          conditionId: "cond-weak",
          outcome: "No",
          strategy: "loser_no",
          lossRequiresGoals: 2,
          price: 0.97,
          availableSize: 5.02,
          shares: 5.02,
          notional: 4.8694,
          estimatedFee: 0.00438246,
          estimatedNetReturn: 0.03,
          tickSize: "0.001",
          negRisk: false
        }
      ]
    } as BuyTradeDecision;
    const placeLimitBuy = vi.fn(async (order: LiveOrderRequest): Promise<TradeResult> => {
      if (order.tokenId === "total-under") {
        throw new LiveExecutionError("LIVE_ORDER_REJECTED", "order couldn't be fully filled", {
          raw: { success: false, errorMsg: "order couldn't be fully filled" }
        });
      }
      return {
        mode: "live",
        status: "filled",
        orderId: "live-weak-no",
        tokenId: order.tokenId,
        price: order.price,
        shares: order.size,
        notional: order.notional,
        fee: order.estimatedFee,
        estimatedPayout: order.size,
        estimatedProfit: order.size - order.notional - order.estimatedFee
      };
    });
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

    const result = await executor.execute(decision, { orderType: "FAK" });

    expect(result).toMatchObject({
      status: "partial",
      shares: 5.02,
      notional: 4.8694,
      legs: [
        { tokenId: "total-under", status: "rejected", shares: 0, notional: 0 },
        { tokenId: "weak-no", status: "filled", shares: 5.02, notional: 4.8694 }
      ]
    });
    expect(placeLimitBuy).toHaveBeenCalledTimes(2);
  });

  test("returns a rejected basket instead of throwing when every live leg is rejected", async () => {
    const decision = {
      ...buyDecision,
      bestAsk: 0.96,
      shares: 8.02,
      notional: 7.7494,
      estimatedFee: 0.00783846,
      estimatedNetReturn: 0.03,
      legs: [
        {
          eventSlug: buyDecision.eventSlug,
          marketSlug: "total-2p5",
          question: "Strong vs. Weak: O/U 2.5",
          tokenId: "total-under",
          conditionId: "cond-total-2p5",
          outcome: "Under",
          strategy: "total_under_loss_ge2",
          lossRequiresGoals: 2,
          price: 0.96,
          availableSize: 3,
          shares: 3,
          notional: 2.88,
          estimatedFee: 0.003456,
          estimatedNetReturn: 0.04,
          tickSize: "0.001",
          negRisk: false
        },
        {
          eventSlug: buyDecision.eventSlug,
          marketSlug: "weak-moneyline",
          question: "Will Weak win?",
          tokenId: "weak-no",
          conditionId: "cond-weak",
          outcome: "No",
          strategy: "loser_no",
          lossRequiresGoals: 2,
          price: 0.97,
          availableSize: 5.02,
          shares: 5.02,
          notional: 4.8694,
          estimatedFee: 0.00438246,
          estimatedNetReturn: 0.03,
          tickSize: "0.001",
          negRisk: false
        }
      ]
    } as BuyTradeDecision;
    const placeLimitBuy = vi.fn(async (order: LiveOrderRequest): Promise<TradeResult> => {
      throw new LiveExecutionError("LIVE_ORDER_REJECTED", `depth moved for ${order.tokenId}`, {
        raw: { success: false, errorMsg: "order couldn't be fully filled" }
      });
    });
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

    const result = await executor.execute(decision, { orderType: "FAK" });

    expect(result).toMatchObject({
      mode: "live",
      status: "rejected",
      shares: 0,
      notional: 0,
      estimatedProfit: 0,
      legs: [
        { tokenId: "total-under", status: "rejected", shares: 0, notional: 0 },
        { tokenId: "weak-no", status: "rejected", shares: 0, notional: 0 }
      ]
    });
    expect(placeLimitBuy).toHaveBeenCalledTimes(2);
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
