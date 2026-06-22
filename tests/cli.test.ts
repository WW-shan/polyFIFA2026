import { describe, expect, test } from "vitest";
import { fetchCandidateOrderbooks, runCli } from "../src/cli.js";
import type { MatchState, OrderbookSnapshot, StrategyMarket } from "../src/domain/types.js";

const liveMatch: MatchState = {
  eventSlug: "fifwc-strong-weak-2026-06-23",
  homeTeam: "Strong",
  awayTeam: "Weak",
  homeGoals: 1,
  awayGoals: 0,
  minute: 88,
  period: "2H",
  isLive: true
};

const liveMarkets: StrategyMarket[] = [
  {
    eventSlug: liveMatch.eventSlug,
    marketSlug: "weak-moneyline",
    question: "Will Weak win on 2026-06-23?",
    conditionId: "cond-weak",
    outcomes: ["Yes", "No"],
    clobTokenIds: ["weak-yes", "weak-no"]
  },
  {
    eventSlug: liveMatch.eventSlug,
    marketSlug: "total-2p5",
    question: "Strong vs. Weak: O/U 2.5",
    conditionId: "cond-total",
    outcomes: ["Over", "Under"],
    clobTokenIds: ["total-over", "total-under"],
    line: 2.5
  }
];

describe("CLI", () => {
  test("paper mode prints a filled JSON trade result", async () => {
    const result = await runCli([
      "--mode", "paper",
      "--match-file", "tests/fixtures/matches/spain-4-0.json",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97"
    ]);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      mode: "paper",
      status: "filled",
      action: "BUY",
      marketSlug: "fifwc-esp-ksa-2026-06-21-spread-home-2pt5",
      outcome: "Spain",
      line: -2.5,
      strategy: "spread_tight_loss_ge2",
      lossRequiresGoals: 2,
      bestAsk: 0.97
    });
  });

  test("live mode without credentials returns LIVE_CREDENTIALS_MISSING", async () => {
    const result = await runCli([
      "--mode", "live",
      "--match-file", "tests/fixtures/matches/spain-4-0.json",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "5",
      "--order-type", "FOK"
    ], {});

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("LIVE_CREDENTIALS_MISSING");
  });

  test("paper mode can fetch match state from an event slug", async () => {
    const result = await runCli([
      "--mode", "paper",
      "--event-slug", "fifwc-esp-ksa-2026-06-21",
      "--markets-file", "tests/fixtures/markets/spain-spreads.json",
      "--orderbook-file", "tests/fixtures/orderbooks/spain-2p5-ask-097.json",
      "--stake", "97"
    ], {}, {
      fetchMatchState: async () => ({
        eventSlug: "fifwc-esp-ksa-2026-06-21",
        homeTeam: "Spain",
        awayTeam: "Saudi Arabia",
        homeGoals: 4,
        awayGoals: 0,
        minute: 88,
        period: "2H",
        isLive: true
      })
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "paper",
      status: "filled",
      action: "BUY",
      eventSlug: "fifwc-esp-ksa-2026-06-21"
    });
  });

  test("fetchCandidateOrderbooks keeps usable books when one candidate fetch fails", async () => {
    const books = await fetchCandidateOrderbooks(liveMatch, liveMarkets, 82, async (tokenId): Promise<OrderbookSnapshot> => {
      if (tokenId === "weak-no") {
        throw new Error("No orderbook exists for the requested token id");
      }
      return {
        tokenId,
        bids: [],
        asks: [{ price: 0.97, size: 100 }]
      };
    });

    expect(books).toEqual([
      {
        tokenId: "total-under",
        bids: [],
        asks: [{ price: 0.97, size: 100 }]
      }
    ]);
  });
});
