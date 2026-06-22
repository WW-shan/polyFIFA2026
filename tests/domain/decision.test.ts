import { describe, expect, test } from "vitest";
import { buildTradeDecision } from "../../src/domain/decision.js";
import type { DecisionThresholds, MatchState, OrderbookSnapshot, SelectedStrategyMarket } from "../../src/domain/types.js";

const match: MatchState = {
  eventSlug: "fifwc-esp-ksa-2026-06-21",
  homeTeam: "Spain",
  awayTeam: "Saudi Arabia",
  homeGoals: 4,
  awayGoals: 0,
  minute: 90,
  period: "2H",
  isLive: true
};

const selected: SelectedStrategyMarket = {
  eventSlug: match.eventSlug,
  marketSlug: "fifwc-esp-ksa-2026-06-21-spread-home-3pt5",
  question: "Spread: Spain (-3.5)",
  conditionId: "0xcondition-spain-3p5",
  clobTokenIds: ["token-spain-3p5", "token-saudi-plus-3p5"],
  outcomes: ["Spain", "Saudi Arabia"],
  line: -3.5,
  tickSize: "0.001",
  negRisk: false,
  outcome: "Spain",
  tokenId: "token-spain-3p5",
  outcomeIndex: 0,
  strategy: "spread_tight_loss_ge2",
  lossRequiresGoals: 1
};

const thresholds: DecisionThresholds = {
  watchStartMinute: 82,
  maxEntryPrice: 0.98,
  minimumNetReturn: 0.019,
  minimumNotional: 5,
  maxNotional: 97
};

function book(asks: Array<[number, number]>): OrderbookSnapshot {
  return {
    tokenId: selected.tokenId,
    asks: asks.map(([price, size]) => ({ price, size })),
    bids: [],
    tickSize: "0.001",
    negRisk: false
  };
}

describe("buildTradeDecision", () => {
  test("best ask 0.97 with enough size returns a BUY decision", () => {
    const decision = buildTradeDecision(match, selected, book([[0.97, 200]]), thresholds);

    expect(decision).toMatchObject({
      action: "BUY",
      eventSlug: match.eventSlug,
      marketSlug: selected.marketSlug,
      tokenId: selected.tokenId,
      conditionId: selected.conditionId,
      outcome: "Spain",
      line: -3.5,
      bestAsk: 0.97,
      availableSize: 200,
      shares: 100,
      notional: 97
    });
    expect(decision.action === "BUY" ? decision.estimatedNetReturn : 0).toBeCloseTo(0.03003, 5);
    expect(decision.action === "BUY" ? decision.estimatedFee : 0).toBeCloseTo(0.0873, 4);
  });

  test("best ask above max entry price returns PRICE_TOO_HIGH", () => {
    const decision = buildTradeDecision(match, selected, book([[0.995, 200]]), thresholds);

    expect(decision).toMatchObject({ action: "NO_TRADE", reason: "PRICE_TOO_HIGH" });
  });

  test("eligible price with no usable depth returns DEPTH_TOO_SMALL", () => {
    const decision = buildTradeDecision(match, selected, book([[0.97, 0]]), thresholds);

    expect(decision).toMatchObject({ action: "NO_TRADE", reason: "DEPTH_TOO_SMALL" });
  });

  test("does not count worse ask levels as size available at the best edge", () => {
    const decision = buildTradeDecision(match, selected, book([[0.97, 1], [0.98, 200]]), {
      ...thresholds,
      minimumNetReturn: 0.02
    });

    expect(decision).toMatchObject({ action: "NO_TRADE", reason: "DEPTH_TOO_SMALL" });
  });

  test("uses the next profitable ask level when best ask depth is too small", () => {
    const decision = buildTradeDecision(match, selected, book([[0.97, 1], [0.98, 200]]), {
      ...thresholds,
      minimumNetReturn: 0
    });

    expect(decision).toMatchObject({
      action: "BUY",
      bestAsk: 0.98,
      availableSize: 200,
      shares: expect.closeTo(97 / 0.98, 8),
      notional: 97
    });
  });

  test("net return below minimum returns RETURN_TOO_LOW", () => {
    const decision = buildTradeDecision(match, selected, book([[0.981, 200]]), {
      ...thresholds,
      maxEntryPrice: 0.99,
      minimumNetReturn: 0.02
    });

    expect(decision).toMatchObject({ action: "NO_TRADE", reason: "RETURN_TOO_LOW" });
  });

  test("available notional below minimum returns DEPTH_TOO_SMALL", () => {
    const decision = buildTradeDecision(match, selected, book([[0.97, 1]]), thresholds);

    expect(decision).toMatchObject({ action: "NO_TRADE", reason: "DEPTH_TOO_SMALL" });
  });
});
