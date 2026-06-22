import { describe, expect, test } from "vitest";
import { selectLossRequiresCandidates } from "../../src/domain/loss-requires-strategy.js";
import type { MatchState, StrategyMarket } from "../../src/domain/types.js";

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

function market(overrides: Partial<StrategyMarket> & Pick<StrategyMarket, "question" | "outcomes" | "clobTokenIds">): StrategyMarket {
  const { question, outcomes, clobTokenIds, eventSlug, marketSlug, conditionId, ...rest } = overrides;
  return {
    ...rest,
    eventSlug: eventSlug ?? match.eventSlug,
    marketSlug: marketSlug ?? question.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"),
    question,
    conditionId: conditionId ?? `cond-${question.length}`,
    clobTokenIds,
    outcomes
  };
}

describe("selectLossRequiresCandidates", () => {
  test("one-goal lead buys trailing team No as strong team not lose", () => {
    const candidates = selectLossRequiresCandidates(match, [
      market({
        question: "Will Weak win on 2026-06-23?",
        outcomes: ["Yes", "No"],
        clobTokenIds: ["weak-yes", "weak-no"]
      })
    ]);

    expect(candidates).toContainEqual(expect.objectContaining({
      strategy: "loser_no",
      outcome: "No",
      tokenId: "weak-no",
      lossRequiresGoals: 2
    }));
  });

  test("does not impose a fixed strategy priority before pricing is known", () => {
    const candidates = selectLossRequiresCandidates(match, [
      market({
        question: "Will Weak win on 2026-06-23?",
        outcomes: ["Yes", "No"],
        clobTokenIds: ["weak-yes", "weak-no"]
      }),
      market({
        question: "Strong vs. Weak: O/U 2.5",
        outcomes: ["Over", "Under"],
        clobTokenIds: ["total-over", "total-under"],
        line: 2.5
      })
    ]);

    expect(candidates.map((candidate) => candidate.strategy)).toEqual([
      "loser_no",
      "total_under_loss_ge2"
    ]);
  });

  test("two-goal lead includes leader Yes and draw No", () => {
    const twoGoalLead = { ...match, homeGoals: 2, awayGoals: 0 };
    const candidates = selectLossRequiresCandidates(twoGoalLead, [
      market({
        question: "Will Strong win on 2026-06-23?",
        outcomes: ["Yes", "No"],
        clobTokenIds: ["strong-yes", "strong-no"]
      }),
      market({
        question: "Will Strong vs. Weak end in a draw?",
        outcomes: ["Yes", "No"],
        clobTokenIds: ["draw-yes", "draw-no"]
      })
    ]);

    expect(candidates).toContainEqual(expect.objectContaining({
      strategy: "leader_yes_lead_ge2",
      outcome: "Yes",
      tokenId: "strong-yes",
      lossRequiresGoals: 2
    }));
    expect(candidates).toContainEqual(expect.objectContaining({
      strategy: "draw_no_lead_ge2",
      outcome: "No",
      tokenId: "draw-no",
      lossRequiresGoals: 2
    }));
  });

  test("total and team total under are selected when two more goals are required to lose", () => {
    const candidates = selectLossRequiresCandidates(match, [
      market({
        question: "Strong vs. Weak: O/U 2.5",
        outcomes: ["Over", "Under"],
        clobTokenIds: ["total-over", "total-under"],
        line: 2.5
      }),
      market({
        question: "Strong vs. Weak: Weak O/U 1.5",
        outcomes: ["Over", "Under"],
        clobTokenIds: ["weak-team-over", "weak-team-under"],
        line: 1.5
      })
    ]);

    expect(candidates).toContainEqual(expect.objectContaining({
      strategy: "total_under_loss_ge2",
      outcome: "Under",
      tokenId: "total-under",
      lossRequiresGoals: 2
    }));
    expect(candidates).toContainEqual(expect.objectContaining({
      strategy: "team_total_under_loss_ge2",
      outcome: "Under",
      tokenId: "weak-team-under",
      team: "Weak",
      lossRequiresGoals: 2
    }));
  });

  test("spread tight can buy the other side when favorite needs two goals to beat the line", () => {
    const draw = { ...match, homeGoals: 0, awayGoals: 0 };
    const candidates = selectLossRequiresCandidates(draw, [
      market({
        question: "Spread: Strong (-1.5)",
        outcomes: ["Strong", "Weak"],
        clobTokenIds: ["strong-minus-1p5", "weak-plus-1p5"],
        line: -1.5
      })
    ]);

    expect(candidates).toContainEqual(expect.objectContaining({
      strategy: "spread_tight_loss_ge2",
      outcome: "Weak",
      tokenId: "weak-plus-1p5",
      lossRequiresGoals: 2,
      spreadSide: "other_side"
    }));
  });

  test("spread tight maps Yes/No outcomes to spread question direction", () => {
    const draw = { ...match, homeGoals: 0, awayGoals: 0 };
    const candidates = selectLossRequiresCandidates(draw, [
      market({
        question: "Spread: Strong (-1.5)",
        outcomes: ["Yes", "No"],
        clobTokenIds: ["strong-minus-yes", "strong-minus-no"],
        line: -1.5
      })
    ]);

    expect(candidates).toContainEqual(expect.objectContaining({
      strategy: "spread_tight_loss_ge2",
      outcome: "No",
      tokenId: "strong-minus-no",
      lossRequiresGoals: 2,
      spreadSide: "other_side"
    }));
  });

  test("locked overs are included when the market condition is already true", () => {
    const candidates = selectLossRequiresCandidates({ ...match, homeGoals: 1, awayGoals: 1 }, [
      market({
        question: "Strong vs. Weak: O/U 1.5",
        outcomes: ["Over", "Under"],
        clobTokenIds: ["total-over-locked", "total-under"]
      }),
      market({
        question: "Strong vs. Weak: Both Teams to Score",
        outcomes: ["Yes", "No"],
        clobTokenIds: ["btts-yes", "btts-no"]
      })
    ]);

    expect(candidates).toContainEqual(expect.objectContaining({
      strategy: "total_over_locked",
      outcome: "Over",
      tokenId: "total-over-locked",
      lossRequiresGoals: 999,
      locked: true
    }));
    expect(candidates).toContainEqual(expect.objectContaining({
      strategy: "btts_yes_locked",
      outcome: "Yes",
      tokenId: "btts-yes",
      lossRequiresGoals: 999,
      locked: true
    }));
  });
});
