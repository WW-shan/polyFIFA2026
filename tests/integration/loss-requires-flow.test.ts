import { describe, expect, test } from "vitest";
import { runDecisionFlow } from "../../src/runner.js";
import type { MatchState, OrderbookSnapshot, StrategyMarket } from "../../src/domain/types.js";

const match: MatchState = {
  eventSlug: "fifwc-strong-weak-2026-06-23",
  homeTeam: "Strong",
  awayTeam: "Weak",
  homeGoals: 2,
  awayGoals: 0,
  minute: 88,
  period: "2H",
  isLive: true,
  remainingSeconds: 120,
  remainingSecondsSource: "365scores_added_time_precise_game_time"
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
    marketSlug: "match-total-4p5",
    question: "Strong vs. Weak: O/U 4.5",
    conditionId: "cond-total-4p5",
    outcomes: ["Over", "Under"],
    clobTokenIds: ["total-over", "total-under"],
    line: 4.5
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
  test("buys locked overs immediately without verified remaining time", () => {
    const {
      remainingSeconds: _remainingSeconds,
      remainingSecondsSource: _remainingSecondsSource,
      ...matchWithoutRemainingSeconds
    } = match;
    const earlyLocked = {
      ...matchWithoutRemainingSeconds,
      homeGoals: 1,
      awayGoals: 0,
      minute: 60,
      elapsedSeconds: 60 * 60
    };

    const decision = runDecisionFlow({
      match: earlyLocked,
      markets: [{
        eventSlug: match.eventSlug,
        marketSlug: "match-total-0p5",
        question: "Strong vs. Weak: O/U 0.5",
        conditionId: "cond-total-0p5",
        outcomes: ["Over", "Under"],
        clobTokenIds: ["total0-over", "total0-under"],
        line: 0.5,
        marketType: "total"
      }],
      orderbooks: [book("total0-over", 0.98, 100)],
      stake: 10
    });

    expect(decision).toMatchObject({
      action: "BUY",
      strategy: "total_over_locked",
      locked: true,
      tokenId: "total0-over",
      bestAsk: 0.98
    });
  });

  test("still refuses non-locked candidates without verified remaining time", () => {
    const {
      remainingSeconds: _remainingSeconds,
      remainingSecondsSource: _remainingSecondsSource,
      ...matchWithoutRemainingSeconds
    } = match;

    const decision = runDecisionFlow({
      match: {
        ...matchWithoutRemainingSeconds,
        elapsedSeconds: 60 * 60
      },
      markets,
      orderbooks: [book("weak-no", 0.98, 100)],
      stake: 10
    });

    expect(decision).toMatchObject({
      action: "NO_TRADE",
      reason: "MATCH_NOT_LATE_ENOUGH"
    });
  });

  test("skips a 0.999 positive-net opportunity below the default 0.5% minimum return", () => {
    const decision = runDecisionFlow({
      match,
      markets,
      orderbooks: [book("weak-no", 0.999, 25)],
      stake: 10
    });

    expect(decision).toMatchObject({
      action: "NO_TRADE",
      reason: "RETURN_TOO_LOW"
    });
  });

  test("can explicitly lower the minimum return for experiments", () => {
    const decision = runDecisionFlow({
      match,
      markets,
      orderbooks: [book("weak-no", 0.999, 25)],
      stake: 10,
      thresholds: { minimumNetReturn: 0 }
    });

    expect(decision).toMatchObject({
      action: "BUY",
      strategy: "loser_no",
      tokenId: "weak-no",
      bestAsk: 0.999,
      lossRequiresGoals: 3
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

  test("builds a ranked buy plan across all profitable candidates until the return floor is reached", () => {
    const decision = runDecisionFlow({
      match,
      markets,
      orderbooks: [
        {
          tokenId: "weak-no",
          bids: [],
          asks: [
            { price: 0.97, size: 5.02 },
            { price: 0.995, size: 100 }
          ]
        },
        {
          tokenId: "total-under",
          bids: [],
          asks: [
            { price: 0.96, size: 3 },
            { price: 0.98, size: 20 },
            { price: 0.995, size: 100 }
          ]
        }
      ],
      stake: 40
    });

    expect(decision).toMatchObject({
      action: "BUY",
      notional: expect.closeTo(27.3494, 6),
      legs: [
        {
          tokenId: "total-under",
          price: 0.96,
          shares: 3,
          notional: 2.88
        },
        {
          tokenId: "weak-no",
          price: 0.97,
          shares: 5.02,
          notional: expect.closeTo(4.8694, 8)
        },
        {
          tokenId: "total-under",
          price: 0.98,
          shares: expect.closeTo(20, 8),
          notional: 19.6
        }
      ]
    });
    expect(decision.action === "BUY" ? decision.legs?.map((leg) => leg.price) : []).not.toContain(0.995);
  });

  test("does not prefer higher lossRequiresGoals over a larger tradable edge", () => {
    const twoGoalLead = { ...match, homeGoals: 2, awayGoals: 0 };
    const decision = runDecisionFlow({
      match: twoGoalLead,
      markets: [
        markets[0]!,
        {
          eventSlug: match.eventSlug,
          marketSlug: "match-total-4p5",
          question: "Strong vs. Weak: O/U 4.5",
          conditionId: "cond-total-4p5",
          outcomes: ["Over", "Under"],
          clobTokenIds: ["total4-over", "total4-under"],
          line: 4.5
        }
      ],
      orderbooks: [
        book("weak-no", 0.99, 100),
        book("total4-under", 0.98, 100)
      ],
      stake: 10
    });

    expect(decision).toMatchObject({
      action: "BUY",
      strategy: "total_under_loss_ge2",
      tokenId: "total4-under",
      bestAsk: 0.98,
      lossRequiresGoals: 3
    });
  });

  test("does not use 90-plus elapsed time when verified 365Scores time is unavailable", () => {
    const {
      remainingSeconds: _remainingSeconds,
      remainingSecondsSource: _remainingSecondsSource,
      ...matchWithoutRemainingSeconds
    } = match;
    const ninetyPlusMatch = {
      ...matchWithoutRemainingSeconds,
      elapsedSeconds: 95 * 60
    };

    const decision = runDecisionFlow({
      match: ninetyPlusMatch,
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

  test("does not trade at 89:30 without remaining time", () => {
    const {
      remainingSeconds: _remainingSeconds,
      remainingSecondsSource: _remainingSecondsSource,
      ...matchWithoutRemainingMinutes
    } = match;
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
