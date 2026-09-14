import { describe, expect, test } from "vitest";
import { collectableTokenIds, normalizeCollectorEvent, type CatalogOptions } from "../../src/collector/catalog.js";
import { discoverContinuousEvents, type DiscoveryIssue } from "../../src/collector/continuous-discovery.js";
import { EventLifecycle } from "../../src/collector/lifecycle.js";
import { classifyMatchScope } from "../../src/collector/match-scope.js";

const now = Date.parse("2026-09-14T12:00:00.000Z");
const startTime = new Date(now).toISOString();

function market(id: string, overrides: Record<string, unknown> = {}) {
  return { id, slug: id, conditionId: `condition-${id}`, question: "Match winner", sportsMarketType: "moneyline",
    outcomes: ["Yes", "No"], clobTokenIds: [`${id}-yes`, `${id}-no`], volume: 0, liquidity: 0,
    outcomePrices: '["1","0"]', closed: false, ...overrides };
}

function event(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, slug: id, title: "ITF: Aziz Dougaz vs. Skander Mansouri", gameId: null, sport: "tennis",
    tags: [{ slug: "tennis" }], startTime, markets: [market(id)], ...overrides };
}

async function discover(roots: Record<string, unknown>[], options: CatalogOptions = { singleMatchOnly: true }, related: Record<string, unknown>[] = []) {
  const requests: URL[] = [];
  const issues: DiscoveryIssue[] = [];
  const pages: unknown[] = [];
  const result = await discoverContinuousEvents({ allOpen: true, now: () => now, ...options }, {
    request: async value => {
      const url = new URL(value); requests.push(url);
      if (url.pathname === "/events") return roots;
      if (url.pathname === "/events/keyset") return { events: related.filter(raw => String(raw.gameId) === url.searchParams.get("game_id")) };
      throw new Error(`Unexpected fixture URL: ${value}`);
    },
    onPage: page => { pages.push(page.response); }
  }, [{ name: "tennis", tagId: "864" }], issue => issues.push(issue));
  return { result, requests, issues, pages };
}

describe("single-match continuous discovery", () => {
  test.each<CatalogOptions>([{}, { singleMatchOnly: false }])("preserves existing discovery unless requested: %j", async options => {
    const roots = [event("match"), event("outright", { title: "US Open Winner" }), event("unknown", { title: "Tennis special", markets: [] })];
    const { result } = await discover(roots, options);
    expect(result.map(value => value.eventId)).toEqual(["match", "outright", "unknown"]);
  });

  test("accepts match game IDs, including numeric zero and nested event metadata", async () => {
    const roots = [event("match", { gameId: 0 }), event("nested", { gameId: undefined, eventMetadata: { gameId: 123 } })];
    const { result, requests } = await discover(roots);
    expect(result.map(value => value.gameId)).toEqual(["0", "123"]);
    expect(requests.filter(url => url.pathname.endsWith("/keyset")).map(url => url.searchParams.get("game_id"))).toEqual(["0", "123"]);
  });

  test.each([
    { title: "ITF M15 Monastir: Aziz Dougaz vs. Skander Mansouri", sport: null, tags: [{ slug: "itf" }] },
    { title: "Setka Cup: Oleksandr Tymofieiev vs. Yurii Misiats", sport: "table-tennis", tags: [{ slug: "setka-cup" }] },
    { title: "TT Elite Series: Jakub Goldir v. Jakub Zelinka", sport: null, tags: [] },
    { title: "ITF Women's Doubles: E. Pridankina / E. Maklakova vs. M. Kozyreva / V. Miroshnichenko" },
    { title: "N. Lammons / J. Withrow versus M. Purcell / J. Thompson" },
    { title: "Table Tennis: Ivan Ivanov - Oleksandr Petrov" },
    { title: "US Open Final: Carlos Alcaraz vs. Jannik Sinner — Match Winner" },
    { title: "NBA Regular Season: Lakers vs. Celtics — Total Points", sport: "nba" }
  ])("retains a real no-gameId match shape: $title", async raw => {
    const root = event("match", raw);
    const { result, requests } = await discover([root]);
    expect(result).toHaveLength(1);
    expect(result[0]!.gameId).toBeNull();
    expect(result[0]!.raw).toBe(root);
    expect(result[0]!.markets[0]!.tokenIds).toEqual(["match-yes", "match-no"]);
    expect(requests).toHaveLength(1);
  });

  test.each([
    { participants: ["Aziz Dougaz", "Skander Mansouri"] },
    { teams: [{ name: "N. Lammons / J. Withrow" }, { name: "M. Purcell / J. Thompson" }] },
    { markets: [market("match", { outcomes: ["Oleksandr Tymofieiev", "Yurii Misiats"], gameStartTime: startTime })] }
  ])("accepts participant evidence with sports market or scheduled-start evidence: %j", async evidence => {
    const { result } = await discover([event("match", { title: "ITF Court 3", startTime: undefined, ...evidence })]);
    expect(result).toHaveLength(1);
    expect(result[0]!.gameId).toBeNull();
  });

  test("accepts a scheduled match when the sports market type is missing", async () => {
    const { result } = await discover([event("match", { markets: [market("match", { sportsMarketType: undefined })] })]);
    expect(result).toHaveLength(1);
  });

  test.each([
    "US Open Winner", "2026 US Open (Women's) Winner", "Will Carlos Alcaraz win the US Open?",
    "Who will win Wimbledon 2027?", "2026 ATP Year-End No. 1", "WTA year-end top 10 ranking",
    "ATP Rankings: Sinner vs. Alcaraz at end of 2026", "Will Iga Swiatek end 2026 ranked #1?",
    "Which player will win the most ATP titles in 2026?", "Carlos Alcaraz 2026 Season: total aces",
    "How many Grand Slams will Novak Djokovic win in 2026?", "NBA 2026-27 regular season points leader",
    "$10 Tennis Coupon: Sinner vs. Alcaraz", "Will my tennis parlay coupon win?"
  ])("excludes clearly non-match scope: %s", async title => {
    const { result, requests, pages } = await discover([event("excluded", { title })]);
    expect(result).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(pages).toHaveLength(1);
  });

  test("a game ID cannot turn a coupon or tournament winner into a single match", async () => {
    const { result, requests } = await discover([
      event("coupon", { title: "Tennis Coupon", gameId: "coupon-game" }),
      event("outright", { title: "US Open Winner", gameId: "outright-game" })
    ]);
    expect(result).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  test("uses outright market questions when an event title alone is inconclusive", async () => {
    const raw = event("event-109", { title: "US Open 2026", markets: [
      market("sinner", { question: "Will Jannik Sinner win the US Open?" }),
      market("alcaraz", { question: "Will Carlos Alcaraz win the US Open?" })
    ] });
    expect(classifyMatchScope(normalizeCollectorEvent(raw)!)).toEqual({ kind: "non-match", reason: "tournament-outright" });
    const { result } = await discover([raw]);
    expect(result).toEqual([]);
  });

  test("retains related side markets and both outcomes regardless of volume, price, or closure", async () => {
    const root = event("root", { gameId: "game" });
    const types = ["total", "tennis_first_set_winner", "exact_score", "future_market_type"];
    const child = event("child", { gameId: "game", parentEventId: "root", title: "First set and more markets",
      markets: types.map((type, index) => market(type, { sportsMarketType: type, closed: index === 3 })) });
    const { result } = await discover([root], { singleMatchOnly: true }, [child]);
    expect(result.map(value => value.eventId)).toEqual(["root", "child"]);
    expect(result[1]!.raw).toBe(child);
    const retained = result[1]!.markets;
    expect(retained.map(value => value.raw.sportsMarketType)).toEqual(types);
    for (const [index, value] of retained.entries()) {
      expect(value.outcomes).toEqual(["Yes", "No"]);
      expect(value.tokenIds).toEqual([`${types[index]}-yes`, `${types[index]}-no`]);
      expect(value.raw.volume).toBe(0);
      expect(value.raw.outcomePrices).toBe('["1","0"]');
    }
    expect(collectableTokenIds(result)).toEqual(["root-yes", "root-no", ...types.slice(0, 3).flatMap(type => [`${type}-yes`, `${type}-no`])]);
  });

  test("filters explicitly non-match companions as well as profile roots", async () => {
    const { result } = await discover([event("root", { gameId: "game" })], { singleMatchOnly: true }, [
      event("coupon", { gameId: "game", title: "Matchday coupon" }),
      event("side", { gameId: "game", title: "First set winner" })
    ]);
    expect(result.map(value => value.eventId)).toEqual(["root", "side"]);
  });

  test("retains explicit parent-linked side markets without inventing a game ID", async () => {
    const root = event("root");
    const side = event("side", { title: "Total sets", parentEventId: "root", markets: [market("sets", { outcomes: ["Over", "Under"] })] });
    const grandchild = event("grandchild", { title: "Exact score", parentEventId: "side" });
    const unrelated = event("unrelated", { title: "Total sets", parentEventId: "missing", markets: [market("unrelated", { outcomes: ["Over", "Under"] })] });
    const coupon = event("coupon", { title: "Tennis coupon", parentEventId: "root" });
    const { result, requests, issues } = await discover([grandchild, side, root, unrelated, coupon]);
    expect(result.map(value => value.eventId)).toEqual(["grandchild", "side", "root"]);
    expect(result.map(value => value.gameId)).toEqual([null, null, null]);
    expect(result[1]!.markets[0]!.outcomes).toEqual(["Over", "Under"]);
    expect(result[1]!.raw).toBe(side);
    expect(requests).toHaveLength(1);
    expect(issues.map(issue => issue.key)).toEqual(["unrelated"]);
  });

  test("does not invent identity for ambiguous events", async () => {
    const unknown = event("unknown", { title: "Tennis special", startTime: undefined, markets: [] });
    const { result, requests, issues } = await discover([unknown]);
    expect(result).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(issues).toEqual([{ scope: "match-scope", key: "unknown", message: expect.stringContaining("AMBIGUOUS_MATCH_SCOPE") }]);
    expect(normalizeCollectorEvent(unknown)!.gameId).toBeNull();
  });

  test("metadata endDate neither excludes a match nor establishes its actual finish", async () => {
    const { result } = await discover([event("match", { endDate: "2000-01-01T00:00:00Z" })]);
    expect(result).toHaveLength(1);
    const lifecycle = new EventLifecycle(1);
    expect(lifecycle.select(result, now).tokenIds).toEqual(["match-yes", "match-no"]);
    expect(lifecycle.states[0]).toMatchObject({ gameId: null, phase: "watching", finishedAtMs: null, terminalObservedAtMs: null });
  });
});

describe("match scope classification", () => {
  test.each(["ITF: TBD vs. TBD", "ITF: Aziz Dougaz vs. Aziz Dougaz", "ITF: TBD vs. Aziz Dougaz"])(
    "distinguishes unresolved participants from known matches: %s", title => {
      const normalized = normalizeCollectorEvent(event("unknown", { title }))!;
      expect(classifyMatchScope(normalized)).toEqual({ kind: "ambiguous", reason: "missing-participants" });
      expect(normalized.gameId).toBeNull();
    }
  );

  test("requires match evidence beyond participant names and metadata dates", () => {
    const normalized = normalizeCollectorEvent(event("unknown", {
      startTime: undefined, startDate: startTime, endDate: startTime,
      markets: [market("unknown", { sportsMarketType: undefined, gameStartTime: "invalid" })]
    }))!;
    expect(classifyMatchScope(normalized)).toEqual({ kind: "ambiguous", reason: "missing-match-evidence" });
  });

  test("does not confuse a tournament final's match question with an outright", async () => {
    const root = event("final", { title: "US Open Final: Carlos Alcaraz vs. Jannik Sinner", markets: [
      market("final", { question: "Will Carlos Alcaraz win the US Open final?" })
    ] });
    expect(classifyMatchScope(normalizeCollectorEvent(root)!)).toMatchObject({ kind: "single-match" });
    expect((await discover([root])).result).toHaveLength(1);
  });

  test("keeps an actual year-end finals match and its per-match statistical question", async () => {
    const root = event("final", { title: "ATP Year-End Finals: Carlos Alcaraz vs. Jannik Sinner", markets: [
      market("aces", { question: "How many aces will Alcaraz serve in the 2026 ATP Finals match?", sportsMarketType: "totals" })
    ] });
    expect(classifyMatchScope(normalizeCollectorEvent(root)!)).toMatchObject({ kind: "single-match" });
    expect((await discover([root])).result).toHaveLength(1);
  });

  test.each([
    "Sinner vs. Alcaraz: Who will win more titles this season?",
    "Sinner vs. Alcaraz: Who will serve more aces throughout the season?",
    "Sinner vs. Alcaraz: season statistics",
    "Sinner vs. Alcaraz: career statistics"
  ])("recognizes multi-match statistics despite a versus title: %s", title => {
    expect(classifyMatchScope(normalizeCollectorEvent(event("event-110", { title }))!))
      .toEqual({ kind: "non-match", reason: "season-or-statistic" });
  });

  test.each(["outright", "tournament_winner", "season_winner", "futures"])("recognizes explicit non-match market type %s", sportsMarketType => {
    const normalized = normalizeCollectorEvent(event("special", { title: "Tennis special", markets: [
      market("winner", { sportsMarketType, outcomes: ["Iga Swiatek", "Aryna Sabalenka"] })
    ] }))!;
    expect(classifyMatchScope(normalized)).toMatchObject({ kind: "non-match" });
  });

  test("does not promote circular parent links or mutate the supplied identities", async () => {
    const first = event("first", { title: "First set", parentEventId: "second" });
    const second = event("second", { title: "Second set", parentEventId: "first" });
    const before = JSON.stringify([first, second]);
    const { result, issues } = await discover([first, second]);
    expect(result).toEqual([]);
    expect(issues.map(issue => issue.key)).toEqual(["first", "second"]);
    expect(JSON.stringify([first, second])).toBe(before);
  });
});

describe("match scope review regressions", () => {
  test("retains ranked participants in an actual Year-End Finals match", async () => {
    const title = "ATP Year-End Finals: No. 1 Jannik Sinner vs. No. 2 Carlos Alcaraz";
    const raw = event("ranked-finals", { title, gameId: "real-game", markets: [market("finals", { question: title })] });
    expect(classifyMatchScope(normalizeCollectorEvent(raw)!)).toEqual({ kind: "single-match", reason: "game-id" });
    const { result, issues } = await discover([raw]);
    expect(result.map(value => value.eventId)).toEqual(["ranked-finals"]);
    expect(result[0]!.raw).toBe(raw);
    expect(issues).toEqual([]);
  });

  test("excludes a ranking prediction when its rank precedes the end-of-year phrase", async () => {
    const raw = event("year-position", { title: "ATP No. 1 at the end of 2026: Sinner vs. Alcaraz" });
    expect(classifyMatchScope(normalizeCollectorEvent(raw)!)).toEqual({ kind: "non-match", reason: "ranking" });
    const { result, issues } = await discover([raw]);
    expect(result).toEqual([]);
    expect(issues).toEqual([]);
  });

  test("excludes annual match-count predictions with a versus title", async () => {
    const raw = event("annual-count", { title: "Sinner vs. Alcaraz: Who will win more matches in 2026?" });
    expect(classifyMatchScope(normalizeCollectorEvent(raw)!)).toEqual({ kind: "non-match", reason: "season-or-statistic" });
    expect((await discover([raw])).result).toEqual([]);
  });

  test("leaves generic parity outcomes explicitly ambiguous without participant identity", async () => {
    const raw = event("parity", { title: "Tennis special", markets: [
      market("parity", { outcomes: ["Odd", "Even"], sportsMarketType: "total_games_odd_even" })
    ] });
    const normalized = normalizeCollectorEvent(raw)!;
    expect(normalized).toMatchObject({ gameId: null, parentEventId: null });
    expect(classifyMatchScope(normalized)).toEqual({ kind: "ambiguous", reason: "missing-participants" });
    const { result, issues } = await discover([raw]);
    expect(result).toEqual([]);
    expect(issues).toEqual([{ scope: "match-scope", key: "parity", message: "AMBIGUOUS_MATCH_SCOPE: missing-participants" }]);
    expect(normalized.markets[0]!.outcomes).toEqual(["Odd", "Even"]);
  });
});

describe("match scope review boundary cases", () => {
  test.each([
    "ATP Year-End Finals: No. 1 Jannik Sinner vs. No. 2 Carlos Alcaraz",
    "WTA Year-End Finals: World No. 1 Aryna Sabalenka vs. World No. 2 Iga Swiatek",
    "ATP Year-End Finals: #1 Jannik Sinner vs. #2 Carlos Alcaraz",
    "ATP Year-End Tour Finals: top-ranked Jannik Sinner vs. No. 2 Carlos Alcaraz",
    "ATP Year-End Championship: No. 1 Jannik Sinner vs. No. 2 Carlos Alcaraz"
  ])("retains an actual Finals match without gameId: %s", async title => {
    const raw = event("finals-fixture", { title, markets: [market("fixture", { question: title })] });
    expect(classifyMatchScope(normalizeCollectorEvent(raw)!)).toEqual({ kind: "single-match", reason: "participants-and-match-evidence" });
    const { result, issues } = await discover([raw]);
    expect(result).toHaveLength(1);
    expect(result[0]!.gameId).toBeNull();
    expect(issues).toEqual([]);
  });

  test.each([
    "Sinner vs. Alcaraz: ATP No. 1 at the end of 2026",
    "ATP No. 1 at the end of the year: Sinner vs. Alcaraz",
    "ATP Finals: Who will be year-end No. 1, Sinner or Alcaraz?",
    "ATP Year-End Finals: Sinner vs. Alcaraz — Who will end 2026 ranked No. 1?"
  ])("excludes ranking targets independently of rank/date order or Finals wording: %s", title => {
    expect(classifyMatchScope(normalizeCollectorEvent(event("position-target", { title }))!))
      .toEqual({ kind: "non-match", reason: "ranking" });
  });

  test.each([
    "Sinner vs. Alcaraz: Who will win the most matches in 2026?",
    "Sinner vs. Alcaraz: How many matches will Sinner win in 2026?"
  ])("excludes related annual match-count expressions: %s", title => {
    expect(classifyMatchScope(normalizeCollectorEvent(event("annual-total", { title }))!))
      .toEqual({ kind: "non-match", reason: "season-or-statistic" });
  });

  test.each([
    "ATP Year-End Finals: No. 1 Jannik Sinner vs. No. 2 Carlos Alcaraz — Match winner",
    "ATP Year-End Finals: No. 1 Jannik Sinner vs. No. 2 Carlos Alcaraz — How many games in this match?",
    "ATP Year-End Finals: No. 1 Jannik Sinner vs. No. 2 Carlos Alcaraz — Who will serve more aces in this match?"
  ])("retains actual Finals match statistics: %s", title => {
    const raw = event("match-statistic", { title, markets: [market("stats", { question: title, sportsMarketType: "totals" })] });
    expect(classifyMatchScope(normalizeCollectorEvent(raw)!)).toMatchObject({ kind: "single-match" });
  });

  test.each([
    { sportsMarketType: "moneyline", outcomes: ["Odd", "Even"] },
    { sportsMarketType: undefined, outcomes: ["Odd", "Even"] },
    { sportsMarketType: "total_games", outcomes: ["High", "Low"] },
    { sportsMarketType: "moneyline", outcomes: ["Higher", "Lower"] },
    { sportsMarketType: "match_period", outcomes: ["First Half", "Second Half"] }
  ])("does not infer participants from generic outcome labels: %j", fields => {
    const raw = event("category", { title: "Tennis special", markets: [market("category", fields)] });
    expect(classifyMatchScope(normalizeCollectorEvent(raw)!)).toEqual({ kind: "ambiguous", reason: "missing-participants" });
  });

  test.each(["moneyline", "tennis_first_set_winner", undefined])("retains named outcome-only participants with type %s and a scheduled start", sportsMarketType => {
    const raw = event("itf-court", { title: "ITF Court 3", markets: [
      market("players", { sportsMarketType, outcomes: ["Aziz Dougaz", "Skander Mansouri"] })
    ] });
    expect(classifyMatchScope(normalizeCollectorEvent(raw)!)).toMatchObject({ kind: "single-match" });
  });

  test.each([
    { title: "Odd vs. Brann" },
    { title: "League match", teams: [{ name: "Odd" }, { name: "Brann" }] }
  ])("preserves known participants and all parity outcomes: %j", identity => {
    const raw = event("known-match", { ...identity, sport: "soccer", markets: [
      market("parity", { sportsMarketType: "total_goals_odd_even", outcomes: ["Odd", "Even"] })
    ] });
    const normalized = normalizeCollectorEvent(raw)!;
    expect(classifyMatchScope(normalized)).toMatchObject({ kind: "single-match" });
    expect(normalized.markets[0]!.outcomes).toEqual(["Odd", "Even"]);
  });
});

describe("named-side spread and handicap review", () => {
  test.each([
    "spread", "spreads", "handicap", "handicaps", "tennis_first_set_spreads",
    "tennis_games_handicap", "asian_handicap", "first_half_spread"
  ])("retains an outcomes-only ITF match with %s", async sportsMarketType => {
    const outcomes = ["Aziz Dougaz", "Skander Mansouri"];
    const raw = event("itf-court", { title: "ITF Court 3", gameId: null, startTime, markets: [
      market("named-sides", { sportsMarketType, outcomes, volume: 0 })
    ] });
    const normalized = normalizeCollectorEvent(raw)!;
    expect(normalized).toMatchObject({ gameId: null, parentEventId: null });
    expect(classifyMatchScope(normalized)).toEqual({ kind: "single-match", reason: "participants-and-match-evidence" });
    const { result, requests, issues } = await discover([raw]);
    expect(result).toHaveLength(1);
    expect(result[0]!.raw).toBe(raw);
    expect(result[0]!.gameId).toBeNull();
    expect(result[0]!.markets[0]).toMatchObject({ outcomes, tokenIds: ["named-sides-yes", "named-sides-no"], raw: { volume: 0 } });
    expect(collectableTokenIds(result)).toEqual(["named-sides-yes", "named-sides-no"]);
    expect(requests).toHaveLength(1);
    expect(issues).toEqual([]);
  });

  test.each(["spread", "spreads", "handicap", "handicaps"].flatMap(sportsMarketType => [
    ["Odd", "Even"], ["Over", "Under"], ["Over 2.5", "Under 2.5"]
  ].map(outcomes => ({ sportsMarketType, outcomes }))))("keeps generic outcomes ambiguous with %j", async fields => {
    const raw = event("unknown-sides", { title: "ITF Court 3", gameId: null, startTime,
      markets: [market("category", fields)] });
    expect(classifyMatchScope(normalizeCollectorEvent(raw)!)).toEqual({ kind: "ambiguous", reason: "missing-participants" });
    const { result, issues } = await discover([raw]);
    expect(result).toEqual([]);
    expect(issues).toEqual([{ scope: "match-scope", key: "unknown-sides", message: "AMBIGUOUS_MATCH_SCOPE: missing-participants" }]);
  });

  test("keeps named doubles opponents and their handicap lines intact", async () => {
    const outcomes = ["E. Pridankina / E. Maklakova (-2.5)", "M. Kozyreva / V. Miroshnichenko (+2.5)"];
    const raw = event("doubles", { title: "ITF Court 3", markets: [
      market("doubles-sides", { sportsMarketType: "handicap", outcomes })
    ] });
    expect(classifyMatchScope(normalizeCollectorEvent(raw)!)).toMatchObject({ kind: "single-match" });
    const { result } = await discover([raw]);
    expect(result).toHaveLength(1);
    expect(result[0]!.gameId).toBeNull();
    expect(result[0]!.markets[0]!.outcomes).toEqual(outcomes);
  });
});

describe("consolidated scope evidence", () => {
  test("does not turn a descriptive winner dash into opponents", async () => {
    const raw = event("event-201", { title: "US Open - Winner", volume: 0, markets: [
      market("market-201", { question: "Will Carlos Alcaraz win?", sportsMarketType: undefined, outcomes: ["Yes", "No"] })
    ] });
    expect(classifyMatchScope(normalizeCollectorEvent(raw)!)).toEqual({ kind: "non-match", reason: "tournament-outright" });
    expect((await discover([raw])).result).toEqual([]);
  });

  test("recognizes home/away roles through handicap annotations without changing labels", async () => {
    const outcomes = ["Home (-1.5)", "Away (+1.5)"];
    const raw = event("event-202", { title: "ITF Court 3", volume: 0,
      markets: [market("market-202", { sportsMarketType: "handicap", outcomes })] });
    const normalized = normalizeCollectorEvent(raw)!;
    expect(classifyMatchScope(normalized)).toEqual({ kind: "ambiguous", reason: "missing-participants" });
    expect(normalized.markets[0]!.outcomes).toEqual(outcomes);
    expect(normalized.raw).toBe(raw);
    const { result, issues } = await discover([raw]);
    expect(result).toEqual([]);
    expect(issues).toEqual([{ scope: "match-scope", key: "event-202", message: "AMBIGUOUS_MATCH_SCOPE: missing-participants" }]);
  });

  test.each(["title", "question"])("detects annual match wins in the %s with a neutral slug", async field => {
    const prediction = "Sinner vs. Alcaraz: Who will have the most match wins in 2026?";
    const raw = event("event-203", { title: field === "title" ? prediction : "ITF Court 3", volume: 0,
      markets: [market("market-203", { question: field === "question" ? prediction : "Match winner",
        outcomes: ["Jannik Sinner", "Carlos Alcaraz"] })] });
    expect(classifyMatchScope(normalizeCollectorEvent(raw)!)).toEqual({ kind: "non-match", reason: "season-or-statistic" });
    const { result, issues } = await discover([raw]);
    expect(result).toEqual([]);
    expect(issues).toEqual([]);
  });

  test("accepts a named club even when its name is also a category word", async () => {
    const outcomes = ["Odd", "Brann"];
    const raw = event("event-204", { title: "Soccer match", sport: "soccer", volume: 0,
      markets: [market("market-204", { sportsMarketType: "spread", outcomes })] });
    const normalized = normalizeCollectorEvent(raw)!;
    expect(classifyMatchScope(normalized)).toEqual({ kind: "single-match", reason: "participants-and-match-evidence" });
    const { result, issues } = await discover([raw]);
    expect(result).toHaveLength(1);
    expect(result[0]!.gameId).toBeNull();
    expect(result[0]!.markets[0]!.outcomes).toEqual(outcomes);
    expect(collectableTokenIds(result)).toEqual(["market-204-yes", "market-204-no"]);
    expect(issues).toEqual([]);
  });

  test.each([
    ["Away (+1.5)", "Home (-1.5)"], ["Home(-2.5)", "Away(+2.5)"],
    ["Even (-1.5)", "Odd (+1.5)"], ["Under (2.5)", "Over (2.5)"],
    ["Under 2.5", "Over 2.5"], ["First Half", "Second Half"], ["1st Half", "2nd Half"]
  ])("recognizes an annotated categorical pair %s / %s", (first, second) => {
    const outcomes = [first, second];
    const normalized = normalizeCollectorEvent(event("event-211", { title: "ITF Court 3",
      markets: [market("market-211", { sportsMarketType: "handicap", outcomes })] }))!;
    expect(classifyMatchScope(normalized)).toEqual({ kind: "ambiguous", reason: "missing-participants" });
    expect(normalized.markets[0]!.outcomes).toEqual(outcomes);
  });

  test.each([
    ["Brann", "Odd"], ["Odd (-1.5)", "Brann (+1.5)"], ["High Point", "Longwood"],
    ["Overton", "Underhill"], ["Schalke 04", "Schalke 08"]
  ])("preserves distinct named sides %s / %s", (first, second) => {
    const outcomes = [first, second];
    const normalized = normalizeCollectorEvent(event("event-212", { title: "Soccer match",
      markets: [market("market-212", { sportsMarketType: "spread", outcomes })] }))!;
    expect(classifyMatchScope(normalized)).toMatchObject({ kind: "single-match" });
    expect(normalized.markets[0]!.outcomes).toEqual(outcomes);
  });

  test("handicap annotations cannot make one participant into two opponents", () => {
    const normalized = normalizeCollectorEvent(event("event-213", { title: "ITF Court 3", markets: [
      market("market-213", { sportsMarketType: "handicap", outcomes: ["Aziz Dougaz (-1.5)", "Aziz Dougaz (+1.5)"] })
    ] }))!;
    expect(classifyMatchScope(normalized)).toEqual({ kind: "ambiguous", reason: "missing-participants" });
  });

  test.each(["US Open — Winner", "Winner - US Open", "US Open - Women's Singles Winner"])(
    "keeps market-heading dashes out of participant evidence: %s", title => {
      const normalized = normalizeCollectorEvent(event("event-214", { title,
        markets: [market("market-214", { question: "Will Carlos Alcaraz win?", sportsMarketType: undefined })] }))!;
      expect(classifyMatchScope(normalized)).toEqual({ kind: "non-match", reason: "tournament-outright" });
    }
  );

  test.each([
    "US Open: Jannik Sinner - Carlos Alcaraz",
    "US Open: Jannik Sinner - Carlos Alcaraz - Match Winner"
  ])("retains dashed match titles and their market headings: %s", title => {
    expect(classifyMatchScope(normalizeCollectorEvent(event("event-215", { title }))!)).toMatchObject({ kind: "single-match" });
  });

  test.each([
    "How many aces will Sinner serve in the 2026 ATP Finals match?",
    "Sinner vs. Alcaraz: Who will win more games in this match in 2026?",
    "Sinner vs. Alcaraz: Their first meeting this season"
  ])("keeps a match reference distinct from an annual statistic: %s", title => {
    const normalized = normalizeCollectorEvent(event("event-216", { title, markets: [
      market("market-216", { question: title, outcomes: ["Jannik Sinner", "Carlos Alcaraz"] })
    ] }))!;
    expect(classifyMatchScope(normalized)).toMatchObject({ kind: "single-match" });
  });

  test.each([
    "Sinner vs. Alcaraz: Who will have the most game wins in 2026?",
    "Sinner vs. Alcaraz: Who will have the most set wins in 2026?",
    "Sinner vs. Alcaraz: Who will have more match victories during the year?"
  ])("uses the statistic's period rather than a bare contest noun: %s", title => {
    const normalized = normalizeCollectorEvent(event("event-217", { title }))!;
    expect(classifyMatchScope(normalized)).toEqual({ kind: "non-match", reason: "season-or-statistic" });
  });

  test.each([
    "Sinner vs. Alcaraz Match: Who will have the most match wins in 2026?",
    "Sinner vs. Alcaraz: This match: Who will have the most match wins in 2026?"
  ])("does not let a match heading override a later annual question: %s", title => {
    const normalized = normalizeCollectorEvent(event("event-218", { title }))!;
    expect(classifyMatchScope(normalized)).toEqual({ kind: "non-match", reason: "season-or-statistic" });
  });

  test("keeps a per-match reference before the quantitative question", () => {
    const title = "Sinner vs. Alcaraz: In this match in 2026, who will win more games?";
    expect(classifyMatchScope(normalizeCollectorEvent(event("event-219", { title }))!))
      .toMatchObject({ kind: "single-match" });
  });
});

describe("dated match questions and outcome units", () => {
  test.each([
    "How many aces will Sinner serve in the 2026 ATP Finals match against Alcaraz?",
    "How many aces will Sinner serve in the 2026 ATP Finals match against Alcaraz (including tiebreaks)?",
    "How many aces will Sinner serve in the 2026 ATP Finals match (including tiebreaks)?"
  ])("retains an identified match's qualified totals question: %s", async question => {
    const raw = event("event-301", {
      title: "ATP Year-End Finals: No. 1 Jannik Sinner vs. No. 2 Carlos Alcaraz", gameId: "g1", volume: 0,
      markets: [market("market-301", { sportsMarketType: "totals", question, outcomes: ["Over", "Under"] })]
    });
    expect(classifyMatchScope(normalizeCollectorEvent(raw)!)).toEqual({ kind: "single-match", reason: "game-id" });
    const { result, issues } = await discover([raw]);
    expect(result).toHaveLength(1);
    expect(result[0]!.raw).toBe(raw);
    expect(result[0]!.markets[0]!.outcomes).toEqual(["Over", "Under"]);
    expect(collectableTokenIds(result)).toEqual(["market-301-yes", "market-301-no"]);
    expect(issues).toEqual([]);
  });

  test.each(["games", "sets", "points"])("keeps untyped amount-and-%s outcomes ambiguous", async unit => {
    const outcomes = [`Over 2.5 ${unit}`, `Under 2.5 ${unit}`];
    const raw = event("event-302", { title: "ITF Court 3", gameId: null, startTime, volume: 0,
      markets: [market("market-302", { sportsMarketType: undefined, outcomes })] });
    const normalized = normalizeCollectorEvent(raw)!;
    expect(classifyMatchScope(normalized)).toEqual({ kind: "ambiguous", reason: "missing-participants" });
    expect(normalized.markets[0]!.outcomes).toEqual(outcomes);
    const { result, issues } = await discover([raw]);
    expect(result).toEqual([]);
    expect(issues).toEqual([{ scope: "match-scope", key: "event-302", message: "AMBIGUOUS_MATCH_SCOPE: missing-participants" }]);
  });

  test.each([
    "Who will have the most match wins in 2026?",
    "How many match wins will Sinner have during the 2026 season (including tiebreaks)?"
  ])("still excludes explicit annual totals on a named match: %s", question => {
    const raw = event("event-303", { title: "ATP Year-End Finals: Jannik Sinner vs. Carlos Alcaraz", gameId: "g1",
      markets: [market("market-303", { sportsMarketType: "totals", question })] });
    expect(classifyMatchScope(normalizeCollectorEvent(raw)!)).toEqual({ kind: "non-match", reason: "season-or-statistic" });
  });

  test.each(["before", "including"])("explicit season scope outranks later match references: %s", async relation => {
    const question = `How many match wins will Sinner have during the 2026 season ${relation} the ATP Finals match against Alcaraz?`;
    const raw = event("event-304", {
      title: "ATP Year-End Finals: No. 1 Jannik Sinner vs. No. 2 Carlos Alcaraz", gameId: "g1", volume: 0,
      markets: [market("market-304", { sportsMarketType: "totals", question, outcomes: ["Over", "Under"] })]
    });
    expect(classifyMatchScope(normalizeCollectorEvent(raw)!)).toEqual({ kind: "non-match", reason: "season-or-statistic" });
    const { result, issues, requests } = await discover([raw]);
    expect(result).toEqual([]);
    expect(issues).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  test.each(["ending", "opening", "closing"])("preserves season compound modifiers: season-%s", async modifier => {
    const question = `How many aces will Sinner serve in the 2026 season-${modifier} match against Alcaraz?`;
    const raw = event("event-305", {
      title: "ATP Year-End Finals: No. 1 Jannik Sinner vs. No. 2 Carlos Alcaraz", gameId: "g1", volume: 0,
      markets: [market("market-305", { sportsMarketType: "totals", question, outcomes: ["Over", "Under"] })]
    });
    expect(classifyMatchScope(normalizeCollectorEvent(raw)!)).toEqual({ kind: "single-match", reason: "game-id" });
    const { result, issues } = await discover([raw]);
    expect(result).toHaveLength(1);
    expect(result[0]!.raw).toBe(raw);
    expect(issues).toEqual([]);
  });
});
