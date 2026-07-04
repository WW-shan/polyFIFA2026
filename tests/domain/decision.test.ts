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
  isLive: true,
  remainingSeconds: 120,
  remainingSecondsSource: "365scores_added_time_precise_game_time"
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
  entryWindowMinutes: 3,
  maxEntryPrice: 0.98,
  minimumNetReturn: 0.019,
  minimumNotional: 5,
  maxNotional: 97
};

function book(asks: Array<[number, number]>): OrderbookSnapshot {
  return bookFor(selected.tokenId, asks);
}

function bookFor(tokenId: string, asks: Array<[number, number]>): OrderbookSnapshot {
  return {
    tokenId,
    asks: asks.map(([price, size]) => ({ price, size })),
    bids: [],
    tickSize: "0.001",
    negRisk: false
  };
}

describe("buildTradeDecision", () => {
  test("rejects candidates that do not satisfy the three-goal safety filter", () => {
    const decision = buildTradeDecision(match, selected, book([[0.97, 200]]), thresholds);

    expect(decision).toMatchObject({
      action: "NO_TRADE",
      reason: "NO_ELIGIBLE_STRATEGY",
      eventSlug: match.eventSlug
    });
  });

  test("rejects candidates that only require two adverse goals to lose", () => {
    const decision = buildTradeDecision(match, { ...selected, lossRequiresGoals: 2 }, book([[0.97, 200]]), thresholds);

    expect(decision).toMatchObject({
      action: "NO_TRADE",
      reason: "NO_ELIGIBLE_STRATEGY",
      eventSlug: match.eventSlug
    });
  });

  test("best ask 0.97 with enough size returns a BUY decision", () => {
    const decision = buildTradeDecision(match, { ...selected, lossRequiresGoals: 3 }, book([[0.97, 200]]), thresholds);

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
    const decision = buildTradeDecision(match, { ...selected, lossRequiresGoals: 3 }, book([[0.995, 200]]), thresholds);

    expect(decision).toMatchObject({ action: "NO_TRADE", reason: "PRICE_TOO_HIGH" });
  });

  test("eligible price with no usable depth returns DEPTH_TOO_SMALL", () => {
    const decision = buildTradeDecision(match, { ...selected, lossRequiresGoals: 3 }, book([[0.97, 0]]), thresholds);

    expect(decision).toMatchObject({ action: "NO_TRADE", reason: "DEPTH_TOO_SMALL" });
  });

  test("does not count worse ask levels as size available at the best edge", () => {
    const decision = buildTradeDecision(match, { ...selected, lossRequiresGoals: 3 }, book([[0.97, 1], [0.98, 200]]), {
      ...thresholds,
      minimumNetReturn: 0.02
    });

    expect(decision).toMatchObject({ action: "NO_TRADE", reason: "DEPTH_TOO_SMALL" });
  });

  test("uses the next profitable ask level when best ask depth is too small", () => {
    const decision = buildTradeDecision(match, { ...selected, lossRequiresGoals: 3 }, book([[0.97, 1], [0.98, 200]]), {
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
    const decision = buildTradeDecision(match, { ...selected, lossRequiresGoals: 3 }, book([[0.981, 200]]), {
      ...thresholds,
      maxEntryPrice: 0.99,
      minimumNetReturn: 0.02
    });

    expect(decision).toMatchObject({ action: "NO_TRADE", reason: "RETURN_TOO_LOW" });
  });

  test("available notional below minimum returns DEPTH_TOO_SMALL", () => {
    const decision = buildTradeDecision(match, { ...selected, lossRequiresGoals: 3 }, book([[0.97, 1]]), thresholds);

    expect(decision).toMatchObject({ action: "NO_TRADE", reason: "DEPTH_TOO_SMALL" });
  });

  test("rejects locked candidates at implausibly low prices", () => {
    const decision = buildTradeDecision(match, {
      ...selected,
      strategy: "total_over_locked",
      outcome: "Over",
      lossRequiresGoals: 999,
      locked: true
    }, book([[0.18, 10_000]]), {
      ...thresholds,
      maxEntryPrice: 0.995,
      minimumNetReturn: 0.005
    });

    expect(decision).toMatchObject({ action: "NO_TRADE", reason: "DEPTH_TOO_SMALL" });
  });

  test("rejects locked candidates below 0.85", () => {
    const decision = buildTradeDecision(match, {
      ...selected,
      strategy: "total_over_locked",
      outcome: "Over",
      lossRequiresGoals: 999,
      locked: true
    }, book([[0.84, 10_000]]), {
      ...thresholds,
      maxEntryPrice: 0.995,
      minimumNetReturn: 0.005
    });

    expect(decision).toMatchObject({ action: "NO_TRADE", reason: "DEPTH_TOO_SMALL" });
  });

  test("rejects locked candidates when a sub-floor ask is in front of executable depth", () => {
    const decision = buildTradeDecision(match, {
      ...selected,
      strategy: "total_over_locked",
      outcome: "Over",
      lossRequiresGoals: 999,
      locked: true
    }, book([[0.84, 10], [0.99, 10_000]]), {
      ...thresholds,
      maxEntryPrice: 0.995,
      minimumNetReturn: 0.005
    });

    expect(decision).toMatchObject({ action: "NO_TRADE", reason: "DEPTH_TOO_SMALL" });
  });

  test("allows locked candidates at 0.85 or above", () => {
    const decision = buildTradeDecision(match, {
      ...selected,
      strategy: "total_over_locked",
      outcome: "Over",
      lossRequiresGoals: 999,
      locked: true
    }, book([[0.85, 10_000]]), {
      ...thresholds,
      maxEntryPrice: 0.995,
      minimumNetReturn: 0.005
    });

    expect(decision).toMatchObject({
      action: "BUY",
      bestAsk: 0.85,
      strategy: "total_over_locked",
      locked: true
    });
  });

  test("rejects a locked total-over candidate when the current score has not locked the market", () => {
    const tokenId = "col-total-over";
    const decision = buildTradeDecision({
      ...match,
      eventSlug: "fifwc-col-prt-2026-06-27",
      homeTeam: "Colombia",
      awayTeam: "Portugal",
      homeGoals: 0,
      awayGoals: 0
    }, {
      eventSlug: "fifwc-col-prt-2026-06-27",
      marketSlug: "fifwc-col-prt-2026-06-27-total-0pt5",
      question: "Colombia vs. Portugal: O/U 0.5",
      conditionId: "cond-col-prt-total-0p5",
      clobTokenIds: [tokenId, "col-total-under"],
      outcomes: ["Over", "Under"],
      line: 0.5,
      marketType: "total",
      outcome: "Over",
      tokenId,
      outcomeIndex: 0,
      strategy: "total_over_locked",
      lossRequiresGoals: 999,
      locked: true
    }, bookFor(tokenId, [[0.99, 10_000]]), {
      ...thresholds,
      maxEntryPrice: 0.995,
      minimumNetReturn: 0.005
    });

    expect(decision).toMatchObject({
      action: "NO_TRADE",
      reason: "NO_ELIGIBLE_STRATEGY",
      eventSlug: "fifwc-col-prt-2026-06-27"
    });
  });
});
