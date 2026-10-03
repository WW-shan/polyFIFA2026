import { describe, expect, test, vi } from "vitest";
import { cancelLiveOrder, getLiveOrder, LiveExecutionError, LiveExecutor, liveConfigFromEnv, normalizeConfirmedLiveOrderResult, normalizeLiveOrderResult } from "../../src/execution/live-executor.js";
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

  test("treats blank env values as unset instead of overriding defaults", () => {
    expect(liveConfigFromEnv({
      POLY_CLOB_HOST: "",
      POLY_CHAIN_ID: "",
      POLY_SIGNATURE_TYPE: "",
      POLY_DEPOSIT_WALLET_ADDRESS: ""
    })).toMatchObject({
      host: "https://clob.polymarket.com",
      chainId: 137,
      signatureType: 1
    });
    expect(liveConfigFromEnv({ POLY_CLOB_HOST: "  ", POLY_CHAIN_ID: "  " })).toMatchObject({
      host: "https://clob.polymarket.com",
      chainId: 137
    });
  });

  test("treats blank credential and RPC aliases as unset", () => {
    expect(liveConfigFromEnv({
      POLY_API_KEY: "   ",
      CLOB_API_KEY: "key",
      POLY_API_SECRET: "",
      CLOB_SECRET: "secret",
      POLY_PASSPHRASE: "  ",
      CLOB_PASS_PHRASE: "passphrase",
      POLY_RPC_URL: "   "
    })).toMatchObject({
      apiKey: "key",
      apiSecret: "secret",
      passphrase: "passphrase"
    });
  });

  test("reads an explicit proxy for the SDK transport", () => {
    expect(liveConfigFromEnv({ POLY_PROXY_URL: "http://127.0.0.1:10808" })).toMatchObject({
      proxyUrl: "http://127.0.0.1:10808"
    });
    expect(liveConfigFromEnv({ HTTPS_PROXY: "http://127.0.0.1:10809" })).toMatchObject({
      proxyUrl: "http://127.0.0.1:10809"
    });
  });

  test("routes order lookup and cancellation through the SDK client", async () => {
    const config = liveConfigFromEnv({
      POLY_PRIVATE_KEY: "0xabc",
      POLY_API_KEY: "key",
      POLY_API_SECRET: "secret",
      POLY_PASSPHRASE: "passphrase"
    });
    const getOrder = vi.fn(async (orderId: string) => ({ id: orderId, status: "LIVE" }));
    const cancelOrder = vi.fn(async (payload: { orderID: string }) => ({ canceled: payload.orderID }));
    const seenConfigs: Array<{ proxyUrl?: string }> = [];
    const factory = async (required: { proxyUrl?: string }) => {
      seenConfigs.push(required);
      return {
        async placeLimitBuy(): Promise<TradeResult> {
          throw new Error("not used");
        },
        getOrder,
        cancelOrder
      };
    };

    const proxyConfig = { ...config, proxyUrl: "http://127.0.0.1:10808" };
    await expect(getLiveOrder(proxyConfig, "order-1", factory)).resolves.toEqual({ id: "order-1", status: "LIVE" });
    await expect(cancelLiveOrder(proxyConfig, "order-1", factory)).resolves.toEqual({ canceled: "order-1" });
    expect(getOrder).toHaveBeenCalledWith("order-1");
    expect(cancelOrder).toHaveBeenCalledWith({ orderID: "order-1" });
    expect(seenConfigs).toEqual([
      expect.objectContaining({ proxyUrl: "http://127.0.0.1:10808" }),
      expect.objectContaining({ proxyUrl: "http://127.0.0.1:10808" })
    ]);
  });

  test("treats blank private key, funder, and boolean settings as unset", () => {
    const config = liveConfigFromEnv({
      POLY_PRIVATE_KEY: "   ",
      POLY_FUNDER_ADDRESS: "   ",
      POLY_SYNC_BALANCE_ALLOWANCE: "   "
    });
    expect(config).not.toHaveProperty("privateKey");
    expect(config).not.toHaveProperty("funderAddress");
    expect(config).not.toHaveProperty("syncBalanceAllowance");
  });

  test("rejects invalid numeric live configuration instead of passing NaN downstream", () => {
    expect(() => liveConfigFromEnv({ POLY_CHAIN_ID: "not-a-number" })).toThrow(/POLY_CHAIN_ID/);
    expect(() => liveConfigFromEnv({ POLY_SIGNATURE_TYPE: "9" })).toThrow(/POLY_SIGNATURE_TYPE/);
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

  test("adopts the live book tick size and neg-risk flag instead of the stale decision values", async () => {
    const decision: BuyTradeDecision = {
      ...buyDecision,
      legs: [{
        eventSlug: buyDecision.eventSlug,
        marketSlug: buyDecision.marketSlug,
        question: buyDecision.question,
        tokenId: buyDecision.tokenId,
        conditionId: buyDecision.conditionId,
        outcome: buyDecision.outcome,
        price: 0.97,
        availableSize: 100,
        shares: 100,
        notional: 97,
        estimatedFee: 0.0873,
        estimatedNetReturn: 0.029428,
        tickSize: "0.001",
        negRisk: false
      }]
    };
    const placeLimitBuy = vi.fn(async (order: LiveOrderRequest): Promise<TradeResult> => ({
      mode: "live",
      status: "filled",
      orderId: "live-1",
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

    await executor.execute(decision, {
      orderType: "FAK",
      refreshOrderbook: async (tokenId) => ({
        tokenId,
        bids: [],
        asks: [{ price: 0.97, size: 100 }],
        tickSize: "0.01",
        negRisk: true
      }),
      minimumNotional: 1
    });

    expect(placeLimitBuy).toHaveBeenCalledWith(expect.objectContaining({
      tokenId: buyDecision.tokenId,
      price: 0.97,
      tickSize: "0.01",
      negRisk: true
    }));
  });

  test("never reprices a resting leg to the current ask", async () => {
    const decision: BuyTradeDecision = {
      ...buyDecision,
      resting: true,
      bestAsk: 0.7,
      shares: 138.57,
      notional: 96.999,
      estimatedFee: 0,
      legs: [{
        eventSlug: buyDecision.eventSlug,
        marketSlug: buyDecision.marketSlug,
        question: buyDecision.question,
        tokenId: buyDecision.tokenId,
        conditionId: buyDecision.conditionId,
        outcome: buyDecision.outcome,
        price: 0.7,
        availableSize: 138.57,
        shares: 138.57,
        notional: 96.999,
        estimatedFee: 0,
        estimatedNetReturn: (1 - 0.7) / 0.7,
        resting: true
      }]
    };
    const placeLimitBuy = vi.fn(async (order: LiveOrderRequest): Promise<TradeResult> => ({
      mode: "live",
      status: "posted",
      orderId: "live-rest",
      tokenId: order.tokenId,
      price: order.price,
      shares: 0,
      notional: 0,
      fee: 0,
      estimatedPayout: 0,
      estimatedProfit: 0,
      reservedNotional: order.notional
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

    await executor.execute(decision, {
      orderType: "GTD",
      // The book's asks are far above the bid: a taker repricing would buy 0.97.
      refreshOrderbook: async (tokenId) => ({
        tokenId,
        bids: [],
        asks: [{ price: 0.97, size: 500 }],
        tickSize: "0.001"
      }),
      minimumNotional: 1
    });

    expect(placeLimitBuy).toHaveBeenCalledWith(expect.objectContaining({
      price: 0.7,
      size: 138.57,
      orderType: "GTD"
    }));
  });

  test("skips a resting leg whose bid now crosses the live ask", async () => {
    const decision: BuyTradeDecision = {
      ...buyDecision,
      resting: true,
      bestAsk: 0.7,
      shares: 138.57,
      notional: 96.999,
      estimatedFee: 0,
      legs: [{
        eventSlug: buyDecision.eventSlug,
        marketSlug: buyDecision.marketSlug,
        question: buyDecision.question,
        tokenId: buyDecision.tokenId,
        conditionId: buyDecision.conditionId,
        outcome: buyDecision.outcome,
        price: 0.7,
        availableSize: 138.57,
        shares: 138.57,
        notional: 96.999,
        estimatedFee: 0,
        estimatedNetReturn: (1 - 0.7) / 0.7,
        resting: true
      }]
    };
    const placeLimitBuy = vi.fn();
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
      orderType: "GTD",
      refreshOrderbook: async (tokenId) => ({
        tokenId,
        bids: [],
        asks: [{ price: 0.65, size: 500 }],
        tickSize: "0.001"
      }),
      minimumNotional: 1
    });

    expect(placeLimitBuy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "rejected", raw: { reason: "STALE_PLAN" } });
  });

  test("skips a leg sized below the venue minimum order size", async () => {
    const decision: BuyTradeDecision = {
      ...buyDecision,
      legs: [{
        eventSlug: buyDecision.eventSlug,
        marketSlug: buyDecision.marketSlug,
        question: buyDecision.question,
        tokenId: buyDecision.tokenId,
        conditionId: buyDecision.conditionId,
        outcome: buyDecision.outcome,
        price: 0.97,
        availableSize: 4,
        shares: 4,
        notional: 3.88,
        estimatedFee: 0.0058,
        estimatedNetReturn: 0.029428,
        tickSize: "0.001",
        negRisk: false
      }]
    };
    const placeLimitBuy = vi.fn();
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
      refreshOrderbook: async (tokenId) => ({
        tokenId,
        bids: [],
        asks: [{ price: 0.97, size: 4 }],
        tickSize: "0.001",
        minimumOrderSize: 5
      }),
      minimumNotional: 1
    });

    expect(placeLimitBuy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "rejected", shares: 0, notional: 0, raw: { reason: "STALE_PLAN" } });
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

  test("does not refresh a locked live leg into an implausibly low price", async () => {
    const decision = {
      ...buyDecision,
      marketSlug: "fifwc-col-prt-2026-06-27-total-0pt5",
      question: "Colombia vs. Portugal: O/U 0.5",
      tokenId: "col-over",
      conditionId: "cond-col-total-0p5",
      outcome: "Over",
      line: 0.5,
      strategy: "total_over_locked",
      lossRequiresGoals: 999,
      locked: true,
      bestAsk: 0.99,
      shares: 100,
      notional: 99,
      estimatedFee: 0.0297,
      estimatedNetReturn: 0.0098,
      legs: [
        {
          eventSlug: "fifwc-col-prt-2026-06-27",
          marketSlug: "fifwc-col-prt-2026-06-27-total-0pt5",
          question: "Colombia vs. Portugal: O/U 0.5",
          tokenId: "col-over",
          conditionId: "cond-col-total-0p5",
          outcome: "Over",
          line: 0.5,
          strategy: "total_over_locked",
          lossRequiresGoals: 999,
          locked: true,
          price: 0.99,
          availableSize: 100,
          shares: 100,
          notional: 99,
          estimatedFee: 0.0297,
          estimatedNetReturn: 0.0098,
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
        tokenId: "col-over",
        bids: [],
        asks: [{ price: 0.18, size: 10_000 }]
      }),
      minimumNotional: 1,
      minimumNetReturn: 0.005,
      maxEntryPrice: 0.999999
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "rejected",
      orderId: "live-stale-plan"
    });
    expect(placeLimitBuy).not.toHaveBeenCalled();
  });

  test("does not cross a locked live leg over lower implausible asks", async () => {
    const decision = {
      ...buyDecision,
      marketSlug: "fifwc-bel-sen-2026-07-01-total-4pt5",
      question: "Belgium vs. Senegal: O/U 4.5",
      tokenId: "bel-sen-over-4p5",
      conditionId: "cond-bel-sen-total-4p5",
      outcome: "Over",
      line: 4.5,
      strategy: "total_over_locked",
      lossRequiresGoals: 999,
      locked: true,
      bestAsk: 0.9,
      shares: 48,
      notional: 43.2,
      estimatedFee: 0.1296,
      estimatedNetReturn: 0.108,
      legs: [
        {
          eventSlug: "fifwc-bel-sen-2026-07-01",
          marketSlug: "fifwc-bel-sen-2026-07-01-total-4pt5",
          question: "Belgium vs. Senegal: O/U 4.5",
          tokenId: "bel-sen-over-4p5",
          conditionId: "cond-bel-sen-total-4p5",
          outcome: "Over",
          line: 4.5,
          strategy: "total_over_locked",
          lossRequiresGoals: 999,
          locked: true,
          price: 0.9,
          availableSize: 48,
          shares: 48,
          notional: 43.2,
          estimatedFee: 0.1296,
          estimatedNetReturn: 0.108,
          tickSize: "0.01",
          negRisk: false
        }
      ]
    } as BuyTradeDecision;
    const placeLimitBuy = vi.fn(async (order: LiveOrderRequest): Promise<TradeResult> => ({
      mode: "live",
      status: "filled",
      orderId: `live-${order.tokenId}`,
      tokenId: order.tokenId,
      price: 0.001,
      shares: order.notional / 0.001,
      notional: order.notional,
      fee: order.estimatedFee,
      estimatedPayout: order.notional / 0.001,
      estimatedProfit: order.notional / 0.001 - order.notional - order.estimatedFee
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
        tokenId: "bel-sen-over-4p5",
        bids: [],
        asks: [
          { price: 0.001, size: 100_000 },
          { price: 0.9, size: 100 }
        ]
      }),
      minimumNotional: 1,
      minimumNetReturn: 0.005,
      maxEntryPrice: 0.999999
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "rejected",
      orderId: "live-stale-plan"
    });
    expect(placeLimitBuy).not.toHaveBeenCalled();
  });

  test("rejects a locked live leg refreshed with a 0.84 ask in front", async () => {
    const decision = {
      ...buyDecision,
      marketSlug: "fifwc-bel-sen-2026-07-01-total-4pt5",
      question: "Belgium vs. Senegal: O/U 4.5",
      tokenId: "bel-sen-over-4p5",
      conditionId: "cond-bel-sen-total-4p5",
      outcome: "Over",
      line: 4.5,
      strategy: "total_over_locked",
      lossRequiresGoals: 999,
      locked: true,
      bestAsk: 0.85,
      shares: 50,
      notional: 42.5,
      estimatedFee: 0.19125,
      estimatedNetReturn: 0.176,
      legs: [
        {
          eventSlug: "fifwc-bel-sen-2026-07-01",
          marketSlug: "fifwc-bel-sen-2026-07-01-total-4pt5",
          question: "Belgium vs. Senegal: O/U 4.5",
          tokenId: "bel-sen-over-4p5",
          conditionId: "cond-bel-sen-total-4p5",
          outcome: "Over",
          line: 4.5,
          strategy: "total_over_locked",
          lossRequiresGoals: 999,
          locked: true,
          price: 0.85,
          availableSize: 50,
          shares: 50,
          notional: 42.5,
          estimatedFee: 0.19125,
          estimatedNetReturn: 0.176,
          tickSize: "0.01",
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
        tokenId: "bel-sen-over-4p5",
        bids: [],
        asks: [
          { price: 0.84, size: 100 },
          { price: 0.9, size: 100 }
        ]
      }),
      minimumNotional: 1,
      minimumNetReturn: 0.005,
      maxEntryPrice: 0.999999
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "rejected",
      orderId: "live-stale-plan"
    });
    expect(placeLimitBuy).not.toHaveBeenCalled();
  });

  test("allows a locked live leg refreshed at 0.85 or above", async () => {
    const decision = {
      ...buyDecision,
      marketSlug: "fifwc-bel-sen-2026-07-01-total-4pt5",
      question: "Belgium vs. Senegal: O/U 4.5",
      tokenId: "bel-sen-over-4p5",
      conditionId: "cond-bel-sen-total-4p5",
      outcome: "Over",
      line: 4.5,
      strategy: "total_over_locked",
      lossRequiresGoals: 999,
      locked: true,
      bestAsk: 0.85,
      shares: 50,
      notional: 42.5,
      estimatedFee: 0.19125,
      estimatedNetReturn: 0.176,
      legs: [
        {
          eventSlug: "fifwc-bel-sen-2026-07-01",
          marketSlug: "fifwc-bel-sen-2026-07-01-total-4pt5",
          question: "Belgium vs. Senegal: O/U 4.5",
          tokenId: "bel-sen-over-4p5",
          conditionId: "cond-bel-sen-total-4p5",
          outcome: "Over",
          line: 4.5,
          strategy: "total_over_locked",
          lossRequiresGoals: 999,
          locked: true,
          price: 0.85,
          availableSize: 50,
          shares: 50,
          notional: 42.5,
          estimatedFee: 0.19125,
          estimatedNetReturn: 0.176,
          tickSize: "0.01",
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
        tokenId: "bel-sen-over-4p5",
        bids: [],
        asks: [{ price: 0.85, size: 100 }]
      }),
      minimumNotional: 1,
      minimumNetReturn: 0.005,
      maxEntryPrice: 0.999999
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "filled",
      tokenId: "bel-sen-over-4p5",
      price: 0.85
    });
    expect(placeLimitBuy).toHaveBeenCalledWith(expect.objectContaining({
      tokenId: "bel-sen-over-4p5",
      price: 0.85
    }));
  });

  test("combines same-token ask levels into one refreshed live order", async () => {
    const decision = {
      ...buyDecision,
      bestAsk: 0.96,
      shares: 8,
      notional: 7.73,
      estimatedFee: 0.0078201,
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
          marketSlug: "total-2p5",
          question: "Strong vs. Weak: O/U 2.5",
          tokenId: "total-under",
          conditionId: "cond-total-2p5",
          outcome: "Under",
          strategy: "total_under_loss_ge2",
          lossRequiresGoals: 2,
          price: 0.97,
          availableSize: 5,
          shares: 5,
          notional: 4.85,
          estimatedFee: 0.0043649999999999995,
          estimatedNetReturn: 0.03,
          tickSize: "0.001",
          negRisk: false
        }
      ]
    } as BuyTradeDecision;
    const placeLimitBuy = vi.fn(async (order: LiveOrderRequest): Promise<TradeResult> => ({
      mode: "live",
      status: "filled",
      orderId: "live-total-under",
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
        tokenId: "total-under",
        bids: [],
        asks: [
          { price: 0.96, size: 3 },
          { price: 0.97, size: 5 }
        ]
      }),
      minimumNotional: 1,
      minimumNetReturn: 0.005,
      maxEntryPrice: 0.999999
    });

    expect(placeLimitBuy).toHaveBeenCalledTimes(1);
    expect(placeLimitBuy).toHaveBeenCalledWith(expect.objectContaining({
      tokenId: "total-under",
      price: 0.97,
      notional: expect.closeTo(7.73, 8),
      orderType: "FAK"
    }));
    expect(result).toMatchObject({
      status: "filled",
      tokenId: "total-under",
      price: 0.97,
      notional: expect.closeTo(7.73, 8),
      legs: [
        { tokenId: "total-under", price: 0.97, notional: expect.closeTo(7.73, 8) }
      ]
    });
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

  test("uses matched order size when trade lookup lags behind CLOB order state", () => {
    const result = normalizeConfirmedLiveOrderResult(liveOrder, {
      postResponse: { success: true, orderID: "order-1", status: "matched" },
      trades: [],
      openOrders: [],
      order: {
        id: "order-1",
        status: "MATCHED",
        asset_id: liveOrder.tokenId,
        side: "BUY",
        original_size: "210.74725",
        size_matched: "101",
        price: "0.91",
        order_type: "FAK"
      }
    });

    expect(result).toMatchObject({
      mode: "live",
      status: "partial",
      orderId: "order-1",
      tokenId: liveOrder.tokenId,
      shares: 101
    });
    expect(result.price).toBeCloseTo(0.91);
    expect(result.notional).toBeCloseTo(91.91);
    expect(result.estimatedPayout).toBe(101);
    expect(result.estimatedProfit).toBeCloseTo(101 - 91.91 - result.fee);
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
