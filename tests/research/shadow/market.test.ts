import { describe, expect, test, vi } from "vitest";
import { assetIdOf, bookTokenIds, discoverLeagueMarkets, linkMarketToGame, selectMoneyline, SHADOW_LEAGUES } from "../../../src/research/shadow/market.js";
import { parseScoreboard } from "../../../src/research/shadow/espn.js";
import { normalizeOrderbook } from "../../../src/polymarket/clob.js";
import type { CollectorEvent } from "../../../src/collector/types.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function event(overrides: Partial<CollectorEvent> = {}): CollectorEvent {
  const raw = {
    id: "3695205", slug: "nfl-phi-chi-2026-09-29", title: "Eagles vs. Bears",
    startTime: "2026-09-29T00:15:00Z", live: false,
    markets: [
      { id: "1", conditionId: "0xspread", slug: "spread", question: "Spread", sportsMarketType: "spread", closed: false,
        outcomes: "[\"Eagles -3.5\",\"Bears +3.5\"]", clobTokenIds: "[\"S1\",\"S2\"]" },
      { id: "2", conditionId: "0xmoney", slug: "nfl-phi-chi-2026-09-29", question: "Eagles vs. Bears", sportsMarketType: "moneyline", closed: false,
        outcomes: "[\"Eagles\",\"Bears\"]", clobTokenIds: "[\"T1\",\"T2\"]" }
    ]
  };
  return {
    eventId: "123", eventSlug: "nfl-phi-chi-2026-09-29", title: "Eagles vs. Bears", tags: ["nfl"], sport: "nfl", gameId: null, parentEventId: null,
    markets: [
      { marketId: "1", conditionId: "0xspread", marketSlug: "spread", question: "Spread", outcomes: ["Eagles -3.5", "Bears +3.5"], tokenIds: ["S1", "S2"], closed: false, collectable: true, raw: { sportsMarketType: "spread" } },
      { marketId: "2", conditionId: "0xmoney", marketSlug: "nfl-phi-chi-2026-09-29", question: "Eagles vs. Bears", outcomes: ["Eagles", "Bears"], tokenIds: ["T1", "T2"], closed: false, collectable: true, raw: { sportsMarketType: "moneyline" } }
    ],
    raw, ...overrides
  };
}

const espnGames = parseScoreboard(JSON.parse(readFileSync(resolve("tests/fixtures/shadow/espn-scoreboard-pre.json"), "utf8")));

describe("selectMoneyline", () => {
  test("selects only the two-outcome moneyline market", () => {
    const market = selectMoneyline(event(), "nfl");
    expect(market).not.toBeNull();
    expect(market!.conditionId).toBe("0xmoney");
    expect(market!.outcomes).toEqual(["Eagles", "Bears"]);
    expect(market!.tokens).toEqual(["T1", "T2"]);
    expect(market!.startMs).toBe(Date.parse("2026-09-29T00:15:00Z"));
  });

  test("refuses a closed or missing moneyline", () => {
    const closed = event();
    closed.markets[1]!.closed = true;
    expect(selectMoneyline(closed, "nfl")).toBeNull();
    const missing = event({ markets: [event().markets[0]!] });
    expect(selectMoneyline(missing, "nfl")).toBeNull();
  });
});

describe("linkMarketToGame", () => {
  const market = selectMoneyline(event(), "nfl")!;

  test("maps Polymarket outcomes onto ESPN home and away", () => {
    const link = linkMarketToGame(market, espnGames);
    expect(link).not.toBeNull();
    expect(link!.game.espnId).toBe("401872963");
    expect(link!.homeIndex).toBe(1);
    expect(link!.awayIndex).toBe(0);
    expect(bookTokenIds(market, link!.homeIndex)).toEqual({ home: "T2", away: "T1" });
  });

  test("refuses mismatched team names or start times", () => {
    expect(linkMarketToGame({ ...market, outcomes: ["Cowboys", "Bears"] }, espnGames)).toBeNull();
    expect(linkMarketToGame({ ...market, startMs: Date.parse("2026-10-05T00:15:00Z") }, espnGames)).toBeNull();
  });
});

describe("discoverLeagueMarkets", () => {
  test("maps Gamma pages and keeps the configured league ids", async () => {
    expect(SHADOW_LEAGUES.nfl!.tagId).toBe("450");
    expect(SHADOW_LEAGUES.nfl!.espnSport).toBe("football/nfl");
    const request = vi.fn(async (url: string) => {
      expect(url).toContain("tag_id=450");
      expect(url).toContain("start_time_min=");
      return [event().raw];
    });
    const markets = await discoverLeagueMarkets(SHADOW_LEAGUES.nfl!, { request, now: () => Date.parse("2026-09-28T22:30:00Z"), lookbackHours: 1, aheadHours: 3 });
    expect(markets).toHaveLength(1);
    expect(markets[0]!.eventSlug).toBe("nfl-phi-chi-2026-09-29");
    expect(markets[0]!.league).toBe("nfl");
  });
});

describe("asset ids", () => {
  test("reads asset id aliases from raw books", () => {
    expect(assetIdOf({ asset_id: "A" })).toBe("A");
    expect(assetIdOf({ assetId: "B" })).toBe("B");
    expect(assetIdOf({})).toBeNull();
    expect(normalizeOrderbook({ asset_id: "A", bids: [], asks: [] }).tokenId).toBe("A");
  });
});
