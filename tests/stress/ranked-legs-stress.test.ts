import { describe, expect, test, vi } from "vitest";
import { netReturnRate } from "../../src/domain/fees.js";
import { runDecisionFlow } from "../../src/runner.js";
import { LiveExecutor, liveConfigFromEnv, type LiveOrderRequest } from "../../src/execution/live-executor.js";
import type { BuyTradeDecision, MatchState, OrderbookSnapshot, PriceLevel, StrategyMarket, TradeResult } from "../../src/domain/types.js";

const MIN_RETURN = 0.005;
const MIN_NOTIONAL = 1;
const MAX_ENTRY_PRICE = 0.999999;
const EPSILON = 1e-8;

const match: MatchState = {
  eventSlug: "fifwc-stress-home-away-2026-06-27",
  homeTeam: "Stress Home",
  awayTeam: "Stress Away",
  homeGoals: 1,
  awayGoals: 0,
  minute: 90,
  period: "2H",
  isLive: true,
  remainingSeconds: 120,
  remainingSecondsSource: "365scores_added_time_precise_game_time"
};

describe("ranked leg stress coverage", () => {
  test("ranked allocation matches a reference allocator across deterministic random orderbooks", () => {
    const random = seededRandom(0x3652026);

    for (let caseIndex = 0; caseIndex < 1500; caseIndex += 1) {
      const marketCount = 1 + Math.floor(random() * 8);
      const stake = round(1 + random() * 250, 6);
      const { markets, orderbooks } = randomMarketsAndOrderbooks(random, marketCount);
      const expected = referenceAllocation(markets, orderbooks, stake);
      const decision = runDecisionFlow({
        match,
        markets,
        orderbooks,
        stake,
        thresholds: {
          minimumNetReturn: MIN_RETURN,
          minimumNotional: MIN_NOTIONAL,
          maxEntryPrice: MAX_ENTRY_PRICE
        }
      });

      if (expected.length === 0) {
        expect(decision.action, `case ${caseIndex}`).toBe("NO_TRADE");
        continue;
      }

      expect(decision.action, `case ${caseIndex}`).toBe("BUY");
      if (decision.action !== "BUY") continue;
      expect(decision.legs?.length, `case ${caseIndex}`).toBe(expected.length);
      expect(decision.notional, `case ${caseIndex}`).toBeLessThanOrEqual(stake + EPSILON);
      expect(decision.notional, `case ${caseIndex}`).toBeCloseTo(sum(expected, "notional"), 8);

      for (const [legIndex, expectedLeg] of expected.entries()) {
        const actual = decision.legs?.[legIndex];
        expect(actual, `case ${caseIndex} leg ${legIndex}`).toBeDefined();
        expect(actual?.tokenId, `case ${caseIndex} leg ${legIndex}`).toBe(expectedLeg.tokenId);
        expect(actual?.price, `case ${caseIndex} leg ${legIndex}`).toBe(expectedLeg.price);
        expect(actual?.notional, `case ${caseIndex} leg ${legIndex}`).toBeCloseTo(expectedLeg.notional, 8);
        expect(actual?.shares, `case ${caseIndex} leg ${legIndex}`).toBeCloseTo(expectedLeg.notional / expectedLeg.price, 8);
        expect(actual?.estimatedNetReturn ?? 0, `case ${caseIndex} leg ${legIndex}`).toBeGreaterThanOrEqual(MIN_RETURN - EPSILON);
        expect(actual?.notional ?? 0, `case ${caseIndex} leg ${legIndex}`).toBeGreaterThanOrEqual(MIN_NOTIONAL - EPSILON);
        if (legIndex > 0) {
          const previous = decision.legs?.[legIndex - 1];
          expect(previous?.estimatedNetReturn ?? 0, `case ${caseIndex} leg ${legIndex}`).toBeGreaterThanOrEqual((actual?.estimatedNetReturn ?? 0) - EPSILON);
        }
      }
    }
  });

  test("live refresh and submit path keeps every random order inside the return floor", async () => {
    const random = seededRandom(0xf00d2026);

    for (let caseIndex = 0; caseIndex < 300; caseIndex += 1) {
      const decision = randomBuyDecision(random, caseIndex);
      const refreshBooks = new Map(decision.legs?.map((leg) => [leg.tokenId, randomRefreshBook(random, leg.tokenId)]) ?? []);
      const orders: LiveOrderRequest[] = [];
      const placeLimitBuy = vi.fn(async (order: LiveOrderRequest): Promise<TradeResult> => {
        orders.push(order);
        return {
          mode: "live",
          status: "filled",
          orderId: `stress-${caseIndex}-${order.tokenId}`,
          tokenId: order.tokenId,
          price: order.price,
          shares: order.size,
          notional: order.notional,
          fee: order.estimatedFee,
          estimatedPayout: order.size,
          estimatedProfit: order.size - order.notional - order.estimatedFee
        };
      });
      const executor = new LiveExecutor(liveConfigFromEnv(liveEnv()), async () => ({ placeLimitBuy }));
      const result = await executor.execute(decision, {
        orderType: "FAK",
        refreshOrderbook: async (tokenId) => refreshBooks.get(tokenId) ?? emptyBook(tokenId),
        minimumNotional: MIN_NOTIONAL,
        minimumNetReturn: MIN_RETURN,
        maxEntryPrice: MAX_ENTRY_PRICE
      });

      for (const order of orders) {
        expect(order.notional, `case ${caseIndex} ${order.tokenId}`).toBeGreaterThanOrEqual(MIN_NOTIONAL - EPSILON);
        expect(order.notional, `case ${caseIndex} ${order.tokenId}`).toBeLessThanOrEqual((decision.legs?.find((leg) => leg.tokenId === order.tokenId)?.notional ?? 0) + EPSILON);
        expect(order.price, `case ${caseIndex} ${order.tokenId}`).toBeLessThanOrEqual(MAX_ENTRY_PRICE);
        expect(netReturnRate(order.price), `case ${caseIndex} ${order.tokenId}`).toBeGreaterThanOrEqual(MIN_RETURN - EPSILON);
      }

      if (orders.length === 0) {
        expect(result.status, `case ${caseIndex}`).toBe("rejected");
        expect(result.notional, `case ${caseIndex}`).toBe(0);
      } else {
        expect(result.notional, `case ${caseIndex}`).toBeCloseTo(orders.reduce((total, order) => total + order.notional, 0), 8);
      }
    }
  });
});

interface ExpectedLeg {
  tokenId: string;
  price: number;
  notional: number;
  estimatedNetReturn: number;
  lossRequiresGoals: number;
}

function randomMarketsAndOrderbooks(
  random: () => number,
  marketCount: number
): { markets: StrategyMarket[]; orderbooks: OrderbookSnapshot[] } {
  const markets: StrategyMarket[] = [];
  const orderbooks: OrderbookSnapshot[] = [];
  for (let index = 0; index < marketCount; index += 1) {
    const line = 2.5 + index;
    const underToken = `stress-under-${index}`;
    markets.push({
      eventSlug: match.eventSlug,
      marketSlug: `stress-total-${index}`,
      question: `Stress Home vs. Stress Away: O/U ${line}`,
      conditionId: `cond-stress-total-${index}`,
      outcomes: ["Over", "Under"],
      clobTokenIds: [`stress-over-${index}`, underToken],
      line,
      marketType: "total"
    });
    orderbooks.push({
      tokenId: underToken,
      bids: [],
      asks: randomAsks(random, 1 + Math.floor(random() * 10))
    });
  }
  return { markets, orderbooks };
}

function referenceAllocation(markets: readonly StrategyMarket[], orderbooks: readonly OrderbookSnapshot[], stake: number): ExpectedLeg[] {
  const levels = markets.flatMap((market, index) => {
    const tokenId = market.clobTokenIds[1];
    if (!tokenId) return [];
    const book = orderbooks.find((candidate) => candidate.tokenId === tokenId);
    if (!book) return [];
    const grouped = groupAskSizesByPrice(book.asks);
    const lossRequiresGoals = Math.floor(market.line ?? 0) + 1 - (match.homeGoals + match.awayGoals);
    return [...grouped.entries()].flatMap(([price, size]) => {
      if (lossRequiresGoals < 3 || price > MAX_ENTRY_PRICE || netReturnRate(price) < MIN_RETURN) return [];
      return [{
        tokenId,
        price,
        notional: price * size,
        estimatedNetReturn: netReturnRate(price),
        lossRequiresGoals,
        originalIndex: index
      }];
    });
  }).sort((a, b) => {
    const returnDelta = b.estimatedNetReturn - a.estimatedNetReturn;
    if (returnDelta !== 0) return returnDelta;
    return b.lossRequiresGoals - a.lossRequiresGoals;
  });

  let remaining = stake;
  const legs: ExpectedLeg[] = [];
  for (const level of levels) {
    if (remaining < MIN_NOTIONAL) break;
    if (level.notional < MIN_NOTIONAL) continue;
    const notional = Math.min(remaining, level.notional);
    if (notional < MIN_NOTIONAL) break;
    legs.push({
      tokenId: level.tokenId,
      price: level.price,
      notional,
      estimatedNetReturn: level.estimatedNetReturn,
      lossRequiresGoals: level.lossRequiresGoals
    });
    remaining -= notional;
  }
  return legs;
}

function randomBuyDecision(random: () => number, caseIndex: number): BuyTradeDecision {
  const legs = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, index) => {
    const price = randomPrice(random, 0.94, 0.994);
    const notional = round(1 + random() * 30, 6);
    const shares = notional / price;
    return {
      eventSlug: match.eventSlug,
      marketSlug: `stress-live-market-${caseIndex}-${index}`,
      question: `Stress live ${caseIndex}-${index}`,
      tokenId: `stress-live-token-${caseIndex}-${index}`,
      conditionId: `cond-stress-live-${caseIndex}-${index}`,
      outcome: "Under",
      strategy: "total_under_loss_ge2" as const,
      lossRequiresGoals: 2 + index,
      price,
      availableSize: shares,
      shares,
      notional,
      estimatedFee: shares * (0.03 * price * (1 - price)),
      estimatedNetReturn: netReturnRate(price),
      tickSize: "0.001" as const,
      negRisk: false
    };
  });
  const first = legs[0]!;
  const shares = legs.reduce((total, leg) => total + leg.shares, 0);
  const notional = legs.reduce((total, leg) => total + leg.notional, 0);
  const estimatedFee = legs.reduce((total, leg) => total + leg.estimatedFee, 0);
  return {
    action: "BUY",
    eventSlug: match.eventSlug,
    marketSlug: first.marketSlug,
    question: first.question,
    tokenId: first.tokenId,
    conditionId: first.conditionId,
    outcome: first.outcome,
    strategy: first.strategy,
    lossRequiresGoals: first.lossRequiresGoals,
    bestAsk: first.price,
    availableSize: shares,
    shares,
    notional,
    estimatedFee,
    estimatedNetReturn: (shares - notional - estimatedFee) / notional,
    tickSize: "0.001",
    negRisk: false,
    legs
  };
}

function randomRefreshBook(random: () => number, tokenId: string): OrderbookSnapshot {
  return {
    tokenId,
    bids: [],
    asks: randomAsks(random, 1 + Math.floor(random() * 8))
  };
}

function randomAsks(random: () => number, count: number): PriceLevel[] {
  return Array.from({ length: count }, () => ({
    price: randomPrice(random, 0.93, 0.999),
    size: round(random() * 40, 6)
  }));
}

function randomPrice(random: () => number, min: number, max: number): number {
  return round(min + random() * (max - min), 4);
}

function groupAskSizesByPrice(asks: readonly PriceLevel[]): Map<number, number> {
  const grouped = new Map<number, number>();
  for (const ask of asks) {
    if (!Number.isFinite(ask.price) || !Number.isFinite(ask.size) || ask.price <= 0 || ask.price >= 1 || ask.size <= 0) continue;
    grouped.set(ask.price, (grouped.get(ask.price) ?? 0) + ask.size);
  }
  return grouped;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function sum<T extends Record<K, number>, K extends keyof T>(values: readonly T[], key: K): number {
  return values.reduce((total, value) => total + value[key], 0);
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function emptyBook(tokenId: string): OrderbookSnapshot {
  return { tokenId, bids: [], asks: [] };
}

function liveEnv(): Record<string, string> {
  return {
    POLY_PRIVATE_KEY: "0xabc",
    POLY_API_KEY: "key",
    POLY_API_SECRET: "secret",
    POLY_PASSPHRASE: "passphrase",
    POLY_FUNDER_ADDRESS: "0xfunder",
    POLY_SIGNATURE_TYPE: "1"
  };
}
