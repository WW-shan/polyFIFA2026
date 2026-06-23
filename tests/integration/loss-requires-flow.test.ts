import { describe, expect, test } from "vitest";
import { runDecisionFlow } from "../../src/runner.js";
import type { MatchState, OrderbookSnapshot, StrategyMarket } from "../../src/domain/types.js";

const match: MatchState = {
  eventSlug: "fifwc-strong-weak-2026-06-23",
  homeTeam: "Strong",
  awayTeam: "Weak",
  homeGoals: 1,
  awayGoals: 0,
  minute: 88,
  period: "2H",
  isLive: true,
  stoppageMinutes: 5,
  expectedEndMinute: 95,
  remainingMinutes: 2
};

const markets: StrategyMarket[] = [
  {
    eventSlug: match.eventSlug,
    marketSlug: "weak-moneyline",
    question: "Will Weak win on 2026-06-23?",
    conditionId: "cond-weak-win",
    outcomes: ["Yes", "No"],
    clobTokenIds: ["weak-yes", "weak-no"]
  },
  {
    eventSlug: match.eventSlug,
    marketSlug: "match-total-2p5",
    question: "Strong vs. Weak: O/U 2.5",
    conditionId: "cond-total-2p5",
    outcomes: ["Over", "Under"],
    clobTokenIds: ["total-over", "total-under"],
    line: 2.5
  }
];

function book(tokenId: string, price: number, size = 100): OrderbookSnapshot {
  return {
    tokenId,
    bids: [],
    asks: [{ price, size }]
  };
}

describe("loss-requires decision flow", () => {
  test("buys a 0.999 positive-net opportunity when no minimum profit threshold is set", () => {
    const decision = runDecisionFlow({
      match,
      markets,
      orderbooks: [book("weak-no", 0.999, 25)],
      stake: 10
    });

    expect(decision).toMatchObject({
      action: "BUY",
      strategy: "loser_no",
      tokenId: "weak-no",
      bestAsk: 0.999,
      lossRequiresGoals: 2
    });
    expect(decision.action === "BUY" ? decision.estimatedNetReturn : 0).toBeGreaterThan(0);
  });

  test("chooses the highest net-return candidate across all latest strategies", () => {
    const decision = runDecisionFlow({
      match,
      markets,
      orderbooks: [
        book("weak-no", 0.99, 100),
        book("total-under", 0.97, 100)
      ],
      stake: 10
    });

    expect(decision).toMatchObject({
      action: "BUY",
      strategy: "total_under_loss_ge2",
      tokenId: "total-under",
      bestAsk: 0.97
    });
  });

  test("does not prefer higher lossRequiresGoals over a larger tradable edge", () => {
    const twoGoalLead = { ...match, homeGoals: 2, awayGoals: 0 };
    const decision = runDecisionFlow({
      match: twoGoalLead,
      markets: [
        markets[0]!,
        {
          eventSlug: match.eventSlug,
          marketSlug: "match-total-3p5",
          question: "Strong vs. Weak: O/U 3.5",
          conditionId: "cond-total-3p5",
          outcomes: ["Over", "Under"],
          clobTokenIds: ["total3-over", "total3-under"],
          line: 3.5
        }
      ],
      orderbooks: [
        book("weak-no", 0.99, 100),
        book("total3-under", 0.98, 100)
      ],
      stake: 10
    });

    expect(decision).toMatchObject({
      action: "BUY",
      strategy: "total_under_loss_ge2",
      tokenId: "total3-under",
      bestAsk: 0.98,
      lossRequiresGoals: 2
    });
  });

  test("uses conservative 90-plus tail window when remaining time is unavailable", () => {
    const { remainingMinutes: _remainingMinutes, ...matchWithoutRemainingMinutes } = match;
    const ninetyPlusMatch = {
      ...matchWithoutRemainingMinutes,
      elapsedSeconds: 90 * 60
    };

    const decision = runDecisionFlow({
      match: ninetyPlusMatch,
      markets,
      orderbooks: [book("weak-no", 0.99, 100)],
      stake: 10,
      thresholds: { entryWindowMinutes: 3 }
    });

    expect(decision).toMatchObject({
      action: "BUY",
      strategy: "loser_no",
      tailWindowSource: "conservative_90_plus"
    });
  });

  test("does not trade at 89:30 without remaining time", () => {
    const { remainingMinutes: _remainingMinutes, ...matchWithoutRemainingMinutes } = match;
    const earlyMatch = {
      ...matchWithoutRemainingMinutes,
      elapsedSeconds: 89 * 60 + 30
    };

    const decision = runDecisionFlow({
      match: earlyMatch,
      markets,
      orderbooks: [book("weak-no", 0.99, 100)],
      stake: 10,
      thresholds: { entryWindowMinutes: 3 }
    });

    expect(decision).toMatchObject({
      action: "NO_TRADE",
      reason: "MATCH_NOT_LATE_ENOUGH"
    });
  });
});
