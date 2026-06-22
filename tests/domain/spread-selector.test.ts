import { describe, expect, test } from "vitest";
import { selectCoveredSpread } from "../../src/domain/spread-selector.js";
import type { MatchState, SpreadMarket } from "../../src/domain/types.js";

const baseMatch: MatchState = {
  eventSlug: "fifwc-esp-ksa-2026-06-21",
  homeTeam: "Spain",
  awayTeam: "Saudi Arabia",
  homeGoals: 4,
  awayGoals: 0,
  minute: 90,
  period: "2H",
  isLive: true
};

function market(outcome: string, line: number, eventSlug = baseMatch.eventSlug): SpreadMarket {
  const lineSlug = String(Math.abs(line)).replace(".", "pt");
  return {
    eventSlug,
    marketSlug: `${baseMatch.eventSlug}-spread-home-${lineSlug}`,
    question: `Spread: ${outcome} (${line > 0 ? "+" : ""}${line})`,
    conditionId: `0x${outcome.toLowerCase().replaceAll(" ", "")}${lineSlug}`,
    clobTokenIds: [`token-${outcome}-${lineSlug}`, `token-other-${lineSlug}`],
    outcomes: [outcome, "Other"],
    line,
    tickSize: "0.001",
    negRisk: false
  };
}

describe("selectCoveredSpread", () => {
  test("4-0 Spain selects Spain -3.5 instead of lower covered lines", () => {
    const result = selectCoveredSpread(baseMatch, [market("Spain", -1.5), market("Spain", -2.5), market("Spain", -3.5)]);

    expect(result.action).toBe("SELECTED");
    expect(result.market?.outcome).toBe("Spain");
    expect(result.market?.line).toBe(-3.5);
  });

  test("3-0 Argentina selects Argentina -2.5", () => {
    const match = { ...baseMatch, eventSlug: "fifwc-arg-alg-2026-06-12", homeTeam: "Argentina", awayTeam: "Algeria", homeGoals: 3, awayGoals: 0 };
    const result = selectCoveredSpread(match, [market("Argentina", -1.5, match.eventSlug), market("Argentina", -2.5, match.eventSlug), market("Argentina", -3.5, match.eventSlug)]);

    expect(result.action).toBe("SELECTED");
    expect(result.market?.outcome).toBe("Argentina");
    expect(result.market?.line).toBe(-2.5);
  });

  test("2-0 Australia selects Australia -1.5", () => {
    const match = { ...baseMatch, eventSlug: "fifwc-aus-tur-2026-06-18", homeTeam: "Australia", awayTeam: "Türkiye", homeGoals: 2, awayGoals: 0 };
    const result = selectCoveredSpread(match, [market("Australia", -1.5, match.eventSlug), market("Australia", -2.5, match.eventSlug)]);

    expect(result.action).toBe("SELECTED");
    expect(result.market?.outcome).toBe("Australia");
    expect(result.market?.line).toBe(-1.5);
  });

  test("one-goal lead returns LEAD_TOO_SMALL", () => {
    const result = selectCoveredSpread({ ...baseMatch, homeGoals: 1, awayGoals: 0 }, [market("Spain", -1.5)]);

    expect(result).toMatchObject({ action: "NO_TRADE", reason: "LEAD_TOO_SMALL" });
  });

  test("covered lead without matching spread returns NO_COVERED_SPREAD", () => {
    const result = selectCoveredSpread(baseMatch, [market("Saudi Arabia", -1.5)]);

    expect(result).toMatchObject({ action: "NO_TRADE", reason: "NO_COVERED_SPREAD" });
  });
});
