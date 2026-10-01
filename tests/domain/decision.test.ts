import { describe, expect, test } from "vitest";
import { buildRestingBidDecision, buildTradeDecision } from "../../src/domain/decision.js";
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
    expect(decision.action === "BUY" ? decision.estimatedNetReturn : 0).toBeCloseTo(0.029428, 5);
    expect(decision.action === "BUY" ? decision.estimatedFee : 0).toBeCloseTo(0.1455, 4);
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

describe("buildRestingBidDecision", () => {
  const restingMatch: MatchState = { ...match, minute: 88, remainingSeconds: 120 };
  const book = (asks: Array<{ price: number; size: number }>, minimumOrderSize?: number): OrderbookSnapshot => ({
    tokenId: selected.tokenId,
    bids: [],
    asks,
    tickSize: "0.001",
    ...(minimumOrderSize === undefined ? {} : { minimumOrderSize })
  });

  test("rests a maker bid at the requested price with zero fee", () => {
    const decision = buildRestingBidDecision(restingMatch, [selected], [book([{ price: 0.97, size: 100 }])], thresholds, { price: 0.7 });

    expect(decision.action).toBe("BUY");
    if (decision.action !== "BUY") throw new Error("expected BUY");
    expect(decision.resting).toBe(true);
    expect(decision.bestAsk).toBe(0.7);
    expect(decision.legs?.[0]).toMatchObject({
      price: 0.7,
      shares: 138.57,
      notional: 96.999,
      estimatedFee: 0,
      resting: true
    });
    // Makers pay no fee, so the return is the raw (1 - price) / price.
    expect(decision.estimatedNetReturn).toBeCloseTo((1 - 0.7) / 0.7, 10);
  });

  test("refuses to rest a bid that crosses the best ask", () => {
    const decision = buildRestingBidDecision(restingMatch, [selected], [book([{ price: 0.6, size: 100 }])], thresholds, { price: 0.7 });

    expect(decision).toMatchObject({ action: "NO_TRADE", reason: "PRICE_TOO_HIGH" });
  });

  test("enforces the venue minimum order size reported by the book", () => {
    const decision = buildRestingBidDecision(restingMatch, [selected], [book([{ price: 0.97, size: 100 }], 5)], { ...thresholds, maxNotional: 3 }, { price: 0.7 });

    expect(decision).toMatchObject({ action: "NO_TRADE", reason: "DEPTH_TOO_SMALL" });
  });

  test("applies the locked floor to a resting bid on a locked outcome", () => {
    const locked: SelectedStrategyMarket = { ...selected, strategy: "total_over_locked", lossRequiresGoals: 999, locked: true };
    const doubted = buildRestingBidDecision(restingMatch, [locked], [book([{ price: 0.4, size: 100 }])], thresholds, { price: 0.3 });
    expect(doubted).toMatchObject({ action: "NO_TRADE", reason: "DEPTH_TOO_SMALL" });

    const noAsks = buildRestingBidDecision(restingMatch, [locked], [book([])], thresholds, { price: 0.9 });
    expect(noAsks).toMatchObject({ action: "NO_TRADE", reason: "DEPTH_TOO_SMALL" });

    const believed = buildRestingBidDecision(restingMatch, [locked], [book([{ price: 0.97, size: 100 }])], thresholds, { price: 0.9 });
    expect(believed.action).toBe("BUY");
  });

  test("does not rest a bid before the tail window opens", () => {
    const early: MatchState = { ...restingMatch, minute: 10, remainingSeconds: 3000 };
    const decision = buildRestingBidDecision(early, [selected], [book([{ price: 0.97, size: 100 }])], thresholds, { price: 0.7 });

    expect(decision).toMatchObject({ action: "NO_TRADE", reason: "MATCH_NOT_LATE_ENOUGH" });
  });
});
