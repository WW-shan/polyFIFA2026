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
  isLive: true
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
});
