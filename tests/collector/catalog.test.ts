import { describe, expect, test } from "vitest";
import {
  collectableTokenIds,
  discoverSportsEvents,
  fetchCollectorEvent,
  normalizeCollectorEvent,
  type CatalogDependencies,
  type CatalogOptions
} from "../../src/collector/catalog.js";
import type { JsonRequester } from "../../src/collector/types.js";

const nowMs = Date.parse("2026-09-10T12:00:00.000Z");
const largeYes = "109371518861475539362972369963857462012251129849853325400000000000000000000001";
const largeNo = "109371518861475539362972369963857462012251129849853325400000000000000000000002";

function market(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "market-1",
    conditionId: "0xcondition",
    slug: "game-winner",
    question: "Will the home team win?",
    outcomes: '["Yes","No"]',
    clobTokenIds: JSON.stringify([largeYes, largeNo]),
    closed: false,
    enableOrderBook: true,
    ...overrides
  };
}

function event(id = "1", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    slug: `game-${id}`,
    title: `Game ${id}`,
    sport: "soccer",
    tags: [{ slug: "soccer" }],
    markets: [market()],
    ...overrides
  };
}

function pages(responses: unknown[]): { request: JsonRequester; urls: URL[] } {
  const urls: URL[] = [];
  return {
    urls,
    request: async (url) => {
      const index = urls.push(new URL(url)) - 1;
      if (index >= responses.length) throw new Error("Unexpected extra catalog request");
      return responses[index];
    }
  };
}

describe("collector event normalization", () => {
  test("preserves a child event, unknown market fields, and exact JSON token IDs", () => {
    const rawMarket = market({
      sportsMarketType: "unrecognized_future_market",
      volume: "0",
      liquidity: 0,
      acceptingOrders: false,
      active: false,
      feesEnabled: true,
      feeSchedule: { rate: "0.02" },
      resolutionSource: "https://example.test/rules",
      futureMetadata: { arbitrary: [1, 2, 3] }
    });
    const raw = event("42", {
      slug: "valorant-match-more-markets",
      title: "Valorant Match: More Markets",
      sport: { sport: "VAL" },
      tags: [{ slug: "Esports" }, { slug: "valorant" }],
      gameId: 98765,
      parentEventId: "41",
      volume: 0,
      teams: [{ name: "Team A" }],
      markets: [rawMarket],
      unknownEventField: { retained: true }
    });

    const normalized = normalizeCollectorEvent(raw);

    expect(normalized).toMatchObject({
      eventId: "42",
      eventSlug: "valorant-match-more-markets",
      title: "Valorant Match: More Markets",
      sport: "VAL",
      tags: ["Esports", "valorant"],
      gameId: "98765",
      parentEventId: "41"
    });
    expect(normalized?.raw).toBe(raw);
    expect(normalized?.markets[0]?.raw).toBe(rawMarket);
    expect(normalized?.markets[0]).toMatchObject({
      marketId: "market-1",
      conditionId: "0xcondition",
      marketSlug: "game-winner",
      question: "Will the home team win?",
      outcomes: ["Yes", "No"],
      tokenIds: [largeYes, largeNo],
      collectable: true,
      closed: false
    });
  });

  test.each(["corners", "first_half_total", "second_half_result", "esports_map", "future_type"])(
    "retains %s markets without a strategy-specific filter",
    (sportsMarketType) => {
      const raw = event("1", { markets: [market({ sportsMarketType, volume: 0, liquidity: 0 })] });
      expect(normalizeCollectorEvent(raw)?.markets[0]?.raw.sportsMarketType).toBe(sportsMarketType);
    }
  );

  test("accepts array mappings and falls back to slugs, IDs, and event metadata", () => {
    const normalized = normalizeCollectorEvent(event("1", {
      title: "",
      sport: "NBA",
      eventMetadata: { gameId: 123456 },
      parentEventId: 0,
      tags: [{ slug: "nba" }, null, { name: "ignored" }],
      markets: [market({ id: "fallback-id", slug: "", question: "", outcomes: ["Over", "Under"], clobTokenIds: ["000123", "000124"] })]
    }));

    expect(normalized).toMatchObject({ title: "game-1", sport: "NBA", gameId: "123456", parentEventId: "0", tags: ["nba"] });
    expect(normalized?.markets[0]).toMatchObject({ marketSlug: "fallback-id", question: "fallback-id", outcomes: ["Over", "Under"], tokenIds: ["000123", "000124"] });
    expect(normalizeCollectorEvent(event("1", { gameId: 0, eventMetadata: { gameId: 99 } }))?.gameId).toBe("0");
    expect(normalizeCollectorEvent(event("1", { sport: null }))?.sport).toBeNull();
    expect(normalizeCollectorEvent(event())?.parentEventId).toBeNull();
  });

  test("skips malformed individual markets while retaining the full event response", () => {
    const raw = event("1", { markets: [
      null,
      market({ id: "" }),
      market({ conditionId: "" }),
      market({ outcomes: "not JSON" }),
      market({ outcomes: ["Yes"] }),
      market({ clobTokenIds: [largeYes] }),
      market({ clobTokenIds: [largeYes, ""] }),
      market({ clobTokenIds: [123, 456] }),
      market({ outcomes: ["Yes", 1] }),
      market({ clobTokenIds: '{}' }),
      market()
    ] });

    expect(normalizeCollectorEvent(raw)?.markets).toHaveLength(1);
    expect(normalizeCollectorEvent(raw)?.raw).toBe(raw);
    expect(normalizeCollectorEvent(event("empty", { markets: [null, {}] }))?.markets).toEqual([]);
    expect(normalizeCollectorEvent({ id: "metadata-only", slug: "metadata-only" })?.markets).toEqual([]);
  });

  test.each([null, [], {}, { id: "1" }, { slug: "game" }, { id: "", slug: "game" }, { id: "1", slug: "  " }])(
    "rejects malformed event %j",
    (raw) => expect(normalizeCollectorEvent(raw)).toBeNull()
  );

  test.each([
    { eventFields: {}, marketFields: { closed: true }, collectable: false },
    { eventFields: {}, marketFields: { archived: true }, collectable: false },
    { eventFields: {}, marketFields: { enableOrderBook: false }, collectable: false },
    { eventFields: { closed: true }, marketFields: {}, collectable: false },
    { eventFields: { archived: true }, marketFields: {}, collectable: false },
    { eventFields: { active: false }, marketFields: { active: false }, collectable: true },
    { eventFields: {}, marketFields: { acceptingOrders: false }, collectable: true }
  ])("marks token eligibility from explicit closed/archive/orderbook flags: %j", ({ eventFields, marketFields, collectable }) => {
    const rawMarket = market(marketFields);
    const normalized = normalizeCollectorEvent(event("1", { ...eventFields, markets: [rawMarket] }));
    expect(normalized?.markets).toHaveLength(1);
    expect(normalized?.markets[0]?.raw).toBe(rawMarket);
    expect(normalized?.markets[0]?.collectable).toBe(collectable);
    expect(collectableTokenIds(normalized ? [normalized] : [])).toEqual(collectable ? [largeYes, largeNo] : []);
  });

  test("deduplicates collectable token IDs while retaining closed market metadata", () => {
    const first = normalizeCollectorEvent(event("1", { markets: [market(), market({ id: "closed", closed: true, clobTokenIds: ["closed-yes", "closed-no"] })] }));
    const second = normalizeCollectorEvent(event("2", { markets: [market({ clobTokenIds: [largeNo, "other-token"] })] }));
    expect(first?.markets).toHaveLength(2);
    expect(first?.markets[1]?.closed).toBe(true);
    expect(collectableTokenIds([first!, second!])).toEqual([largeYes, largeNo, "other-token"]);
  });
});

describe("sports catalog discovery", () => {
  test("uses the Games tag, stable ID order, and the default metadata end-date window", async () => {
    const deps = pages([[]]);
    await expect(discoverSportsEvents({ now: () => nowMs }, deps)).resolves.toEqual([]);
    expect(deps.urls[0]?.origin).toBe("https://gamma-api.polymarket.com");
    expect(deps.urls[0]?.pathname).toBe("/events");
    expect(Object.fromEntries(deps.urls[0]!.searchParams)).toEqual({
      tag_id: "100639", closed: "false", limit: "100", offset: "0", order: "id", ascending: "true",
      end_date_min: "2026-09-08T12:00:00.000Z", end_date_max: "2026-09-11T12:00:00.000Z"
    });
  });

  test("game-start omits every server date filter while preserving catalog request settings", async () => {
    const deps = pages([[]]);
    await discoverSportsEvents({
      dateWindow: "game-start", tagId: "custom-games", lookbackHours: 6, aheadHours: 2,
      pageSize: 3, now: () => nowMs
    }, deps);

    expect(Object.fromEntries(deps.urls[0]!.searchParams)).toEqual({
      tag_id: "custom-games", closed: "false", limit: "3", offset: "0", order: "id", ascending: "true"
    });
  });

  test("game-start discovers tennis with an endDate seven days after its scheduled start", async () => {
    const raw = event("tennis", {
      slug: "atp-brunold-heide-2026-09-11", sport: "ATP", tags: [{ slug: "Tennis" }],
      startTime: "2026-09-11T10:00:00Z", finishedTimestamp: "2026-09-11T11:26:00Z",
      startDate: "2026-09-01T00:00:00Z", endDate: "2026-09-18T10:00:00Z",
      markets: [market(), market({ id: "sets", sportsMarketType: "total" }), market({ id: "closed", closed: true })]
    });
    const result = await discoverSportsEvents({
      dateWindow: "game-start", sports: ["tennis"], lookbackHours: 6, aheadHours: 2,
      now: () => Date.parse("2026-09-11T12:00:00Z")
    }, {
      request: async (url) => {
        const params = new URL(url).searchParams;
        const min = params.get("end_date_min");
        const max = params.get("end_date_max");
        const end = Date.parse(String(raw.endDate));
        // Mirror Gamma's metadata filtering to reproduce the missed tennis event.
        return (min !== null && end < Date.parse(min)) || (max !== null && end > Date.parse(max)) ? [] : [raw];
      }
    });

    expect(result.map((item) => item.eventSlug)).toEqual(["atp-brunold-heide-2026-09-11"]);
    expect(result[0]?.raw).toBe(raw);
    expect(result[0]?.markets.map((item) => item.raw)).toEqual(raw.markets);
  });

  test.each([
    ["2026-09-10T05:59:59.999Z", false],
    ["2026-09-10T06:00:00.000Z", true],
    ["2026-09-10T12:00:00.000Z", true],
    ["2026-09-10T14:00:00.000Z", true],
    ["2026-09-10T14:00:00.001Z", false]
  ])("game-start applies inclusive scheduled bounds to %s (retained=%s)", async (startTime, retained) => {
    const result = await discoverSportsEvents({
      dateWindow: "game-start", lookbackHours: 6, aheadHours: 2, now: () => nowMs
    }, pages([[event("1", { startTime, endDate: "2026-09-10T12:00:00Z" })]]));

    expect(result.map((item) => item.eventId)).toEqual(retained ? ["1"] : []);
  });

  test.each([undefined, null, "", "invalid"])("game-start falls back to market gameStartTime when startTime is %j", async (startTime) => {
    const raw = ["2026-09-10T05:00:00Z", "2026-09-10T12:00:00Z", "2026-09-10T15:00:00Z"].map((gameStartTime, index) => event(String(index), {
      startTime,
      markets: [market({ gameStartTime: "invalid" }), market({ id: "scheduled", gameStartTime })]
    }));
    const result = await discoverSportsEvents({
      dateWindow: "game-start", lookbackHours: 6, aheadHours: 2, now: () => nowMs
    }, pages([raw]));

    expect(result.map((item) => item.eventId)).toEqual(["1"]);
    expect(result[0]?.markets.map((item) => item.raw)).toEqual(raw[1]?.markets);
  });

  test("game-start prefers a valid event startTime over the market fallback", async () => {
    const result = await discoverSportsEvents({ dateWindow: "game-start", now: () => nowMs }, pages([[
      event("inside", { startTime: "2026-09-10T12:00:00Z", markets: [market({ gameStartTime: "1999-01-01T00:00:00Z" })] }),
      event("outside", { startTime: "1999-01-01T00:00:00Z", markets: [market({ gameStartTime: "2026-09-10T12:00:00Z" })] })
    ]]));

    expect(result.map((item) => item.eventId)).toEqual(["inside"]);
  });

  test.each(["1999-01-01T00:00:00Z", "2099-01-01T00:00:00Z"])("game-start retains live events with out-of-window start %s", async (startTime) => {
    const result = await discoverSportsEvents({ dateWindow: "game-start", now: () => nowMs }, pages([[
      event("live", { live: true, startTime }),
      event("not-live", { live: false, startTime }),
      event("string-live", { live: "true", startTime })
    ]]));

    expect(result.map((item) => item.eventId)).toEqual(["live"]);
  });

  test.each([undefined, null, "", "invalid", 0])("game-start retains unknown start %j without using creation, end, or finish dates", async (startTime) => {
    const metadataDates = {
      startDate: "1999-01-01T00:00:00Z", endDate: "2099-01-01T00:00:00Z",
      closedTime: "1999-01-01T01:00:00Z", finishedTimestamp: "1999-01-01T01:00:00Z"
    };
    const result = await discoverSportsEvents({ dateWindow: "game-start", now: () => nowMs }, pages([[
      event("unknown", { ...metadataDates, startTime, markets: [market({ ...metadataDates, gameStartTime: startTime })] }),
      event("metadata-only", { ...metadataDates, markets: [] })
    ]]));

    expect(result.map((item) => item.eventId)).toEqual(["unknown", "metadata-only"]);
  });

  test("game-start audits complete pages and paginates past pages with no local matches", async () => {
    const first = [event("old", { startTime: "1999-01-01T00:00:00Z" }), event("future", { startTime: "2099-01-01T00:00:00Z" })];
    const last = [event("tennis", { sport: "ATP", tags: [{ slug: "Tennis" }], startTime: "2026-09-10T12:00:00Z" })];
    const deps = pages([first, last]);
    const recorded: unknown[] = [];
    const audited: unknown[] = [];
    const result = await discoverSportsEvents({ dateWindow: "game-start", sports: ["soccer", "tennis"], pageSize: 2, now: () => nowMs }, {
      ...deps, onPage: (page) => recorded.push(page.response), onRequest: (request) => audited.push(request.response)
    });

    expect(result.map((item) => item.eventId)).toEqual(["tennis"]);
    expect(deps.urls.map((url) => url.searchParams.get("offset"))).toEqual(["0", "2"]);
    expect(recorded).toEqual([first, last]);
    expect(audited).toEqual([first, last]);
    for (const url of deps.urls) expect([...url.searchParams.keys()].some((key) => /date/.test(key))).toBe(false);
  });

  test("explicit metadata-end preserves server filtering without local scheduled-start selection", async () => {
    const deps = pages([[event("1", { startTime: "1999-01-01T00:00:00Z" })]]);
    const result = await discoverSportsEvents({ dateWindow: "metadata-end", now: () => nowMs }, deps);

    expect(result.map((item) => item.eventId)).toEqual(["1"]);
    expect(deps.urls[0]?.searchParams.get("end_date_min")).toBe("2026-09-08T12:00:00.000Z");
    expect(deps.urls[0]?.searchParams.get("end_date_max")).toBe("2026-09-11T12:00:00.000Z");
  });

  test("paginates through all sports and deduplicates both event IDs and slugs", async () => {
    const first = [event("1"), event("2", { sport: "tennis" })];
    const second = [event("1", { slug: "same-id-another-slug" }), event("3", { sport: { sport: "cs2" }, title: "More Markets" })];
    const last = [event("other-id", { slug: "game-3" })];
    const deps = pages([first, second, last]);
    const recorded: Parameters<NonNullable<CatalogDependencies["onPage"]>>[0][] = [];

    const events = await discoverSportsEvents({ pageSize: 2, now: () => nowMs }, { ...deps, onPage: (page) => recorded.push(page) });

    expect(events.map((item) => item.eventId)).toEqual(["1", "2", "3"]);
    expect(events.map((item) => item.sport)).toEqual(["soccer", "tennis", "cs2"]);
    expect(deps.urls.map((url) => url.searchParams.get("offset"))).toEqual(["0", "2", "4"]);
    expect(recorded).toHaveLength(3);
    expect(recorded[0]?.response).toBe(first);
    expect(recorded[1]?.response).toBe(second);
    expect(recorded[2]?.response).toBe(last);
    expect(recorded[0]?.url).toBe(deps.urls[0]?.href);
  });

  test("records the request start before awaiting the original response", async () => {
    let current = nowMs;
    const raw = { events: [event()] };
    const recorded: Parameters<NonNullable<CatalogDependencies["onPage"]>>[0][] = [];
    const result = await discoverSportsEvents({ now: () => current }, {
      request: async () => { current += 1500; return raw; },
      onPage: (page) => recorded.push(page)
    });

    expect(result).toHaveLength(1);
    expect(recorded[0]?.requestStartedAt).toBe("2026-09-10T12:00:00.000Z");
    expect(recorded[0]?.response).toBe(raw);
  });

  test("filters arbitrary tag slugs and league codes case insensitively", async () => {
    const deps = pages([[
      event("1", { sport: { sport: "NBA" } }),
      event("2", { sport: "tennis", tags: [{ slug: "WTA" }] }),
      event("3", { sport: "alien-ball", tags: [] }),
      event("4", { sport: "soccer" })
    ]]);
    const events = await discoverSportsEvents({ sports: ["nba", "wTa", "ALIEN-BALL"], now: () => nowMs }, deps);
    expect(events.map((item) => item.eventId)).toEqual(["1", "2", "3"]);
  });

  test("does not stop pagination when a full page has no sports matches", async () => {
    const deps = pages([[event("1"), event("2")], [event("3", { sport: "NBA" })]]);
    const events = await discoverSportsEvents({ sports: ["nba"], pageSize: 2 }, deps);
    expect(events.map((item) => item.eventId)).toEqual(["3"]);
    expect(deps.urls).toHaveLength(2);
  });

  test("supports a custom window, base URL, and safely encoded tag ID", async () => {
    const deps = pages([[]]);
    await discoverSportsEvents({ baseUrl: "https://gamma.example.test/api/", tagId: "tag&value=1", lookbackHours: 6, aheadHours: 2, pageSize: 3, now: () => nowMs }, deps);
    expect(deps.urls[0]?.pathname).toBe("/api/events");
    expect(deps.urls[0]?.searchParams.get("tag_id")).toBe("tag&value=1");
    expect(deps.urls[0]?.searchParams.get("limit")).toBe("3");
    expect(deps.urls[0]?.searchParams.get("end_date_min")).toBe("2026-09-10T06:00:00.000Z");
    expect(deps.urls[0]?.searchParams.get("end_date_max")).toBe("2026-09-10T14:00:00.000Z");
  });

  test("allOpen removes both date bounds while retaining closed=false", async () => {
    const deps = pages([[]]);
    await discoverSportsEvents({ allOpen: true }, deps);
    expect(deps.urls[0]?.searchParams.has("end_date_min")).toBe(false);
    expect(deps.urls[0]?.searchParams.has("end_date_max")).toBe(false);
    expect(deps.urls[0]?.searchParams.get("closed")).toBe("false");
  });

  test("allOpen bypasses game-start filtering while retaining sports matching", async () => {
    const deps = pages([[
      event("old", { sport: "Tennis", startTime: "1999-01-01T00:00:00Z" }),
      event("future", { sport: "ATP", tags: [{ slug: "tennis" }], startTime: "2099-01-01T00:00:00Z" }),
      event("other-sport", { live: true })
    ]]);
    const result = await discoverSportsEvents({ dateWindow: "game-start", allOpen: true, sports: ["tennis"], now: () => nowMs }, deps);

    expect(result.map((item) => item.eventId)).toEqual(["old", "future"]);
    expect(Object.fromEntries(deps.urls[0]!.searchParams)).toEqual({
      tag_id: "100639", closed: "false", limit: "100", offset: "0", order: "id", ascending: "true"
    });
  });

  test.each<CatalogOptions>([{}, { dateWindow: "game-start" }])("explicit encoded slugs override both the date window and sports filter: %j", async (options) => {
    const slug = "nba/finals?x & y";
    const raw = event("1", { slug, sport: "nba", closed: true, startTime: "1999-01-01T00:00:00Z", endDate: "1999-01-01T00:00:00Z" });
    const deps = pages([raw]);
    const recorded: unknown[] = [];
    const result = await discoverSportsEvents({ ...options, baseUrl: "https://gamma.example.test/", eventSlugs: [slug, slug], sports: ["soccer"], now: () => nowMs }, { ...deps, onPage: (page) => recorded.push(page.response) });

    expect(result.map((item) => item.eventSlug)).toEqual([slug]);
    expect(deps.urls).toHaveLength(1);
    expect(deps.urls[0]?.pathname).toBe(`/events/slug/${encodeURIComponent(slug)}`);
    expect(deps.urls[0]?.search).toBe("");
    expect(recorded[0]).toBe(raw);
    expect(collectableTokenIds(result)).toEqual([]);
  });

  test.each([null, {}, { error: "rate limited" }, { events: {} }, "[]"])("rejects malformed successful response %j", async (response) => {
    const recorded: unknown[] = [];
    await expect(discoverSportsEvents({}, { ...pages([response]), onPage: (page) => recorded.push(page.response) })).rejects.toThrow("CATALOG_RESPONSE_INVALID");
    expect(recorded).toEqual([response]);
  });

  test("skips malformed event entries without dropping valid metadata-only events", async () => {
    const result = await discoverSportsEvents({}, pages([[null, {}, { id: "metadata", slug: "metadata" }]]));
    expect(result.map((item) => item.eventId)).toEqual(["metadata"]);
  });

  test.each<CatalogOptions>([{}, { dateWindow: "game-start" }])("throws on a repeated nonempty page even if order or market metadata changes: %j", async (options) => {
    const deps = pages([
      [event("1", { startTime: "1999-01-01T00:00:00Z" }), event("2", { startTime: "1999-01-01T00:00:00Z" })],
      [event("2", { volume: "100", startTime: "1999-01-01T00:00:00Z" }), event("1", { volume: "200", startTime: "1999-01-01T00:00:00Z" })]
    ]);
    await expect(discoverSportsEvents({ ...options, pageSize: 2, maxPages: 10, now: () => nowMs }, deps)).rejects.toThrow("CATALOG_PAGINATION_STALLED");
    expect(deps.urls).toHaveLength(2);
  });

  test.each<CatalogOptions>([{}, { dateWindow: "game-start" }])("throws instead of returning a partial catalog at the page cap: %j", async (options) => {
    const deps = pages([[event("1", { startTime: "1999-01-01T00:00:00Z" })], [event("2", { startTime: "1999-01-01T00:00:00Z" })]]);
    await expect(discoverSportsEvents({ ...options, pageSize: 1, maxPages: 2, now: () => nowMs }, deps)).rejects.toThrow("CATALOG_PAGINATION_LIMIT");
    expect(deps.urls).toHaveLength(2);
  });

  test("defaults to a finite cap of 200 pages", async () => {
    let count = 0;
    await expect(discoverSportsEvents({ pageSize: 1 }, { request: async () => [event(String(++count))] })).rejects.toThrow("CATALOG_PAGINATION_LIMIT");
    expect(count).toBe(200);
  });

  test("accepts a short page at the final allowed page", async () => {
    const result = await discoverSportsEvents({ pageSize: 2, maxPages: 2 }, pages([[event("1"), event("2")], []]));
    expect(result.map((item) => item.eventId)).toEqual(["1", "2"]);
  });

  test.each<CatalogOptions>([
    { pageSize: 0 }, { pageSize: 1.5 }, { maxPages: 0 }, { maxPages: Infinity },
    { lookbackHours: -1 }, { aheadHours: NaN }, { eventSlugs: [" "] }
  ])("rejects invalid options before requesting data: %j", async (options) => {
    const deps = pages([]);
    await expect(discoverSportsEvents(options, deps)).rejects.toThrow("CATALOG_OPTIONS_INVALID");
    expect(deps.urls).toHaveLength(0);
  });

  test.each(["start-date", "", null])("rejects invalid dateWindow %j before requesting data", async (dateWindow) => {
    const deps = pages([[]]);
    await expect(discoverSportsEvents({ dateWindow } as unknown as CatalogOptions, deps))
      .rejects.toThrow("CATALOG_OPTIONS_INVALID: dateWindow must be metadata-end or game-start");
    expect(deps.urls).toHaveLength(0);
  });

  test("propagates request and recording failures", async () => {
    const requestError = new Error("offline");
    await expect(discoverSportsEvents({}, { request: async () => { throw requestError; } })).rejects.toBe(requestError);
    const recordingError = new Error("disk failure");
    await expect(discoverSportsEvents({}, { request: async () => [], onPage: () => { throw recordingError; } })).rejects.toBe(recordingError);
  });

  test("audits a completed request only once when the page consumer fails", async () => {
    const audits: Parameters<NonNullable<CatalogDependencies["onRequest"]>>[0][] = [];
    const failure = new Error("journal unavailable");
    await expect(discoverSportsEvents({}, {
      request: async () => [],
      onRequest: (request) => audits.push(request),
      onPage: () => { throw failure; }
    })).rejects.toBe(failure);

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ requestStartedAt: expect.any(String), requestEndedAt: expect.any(String), response: [] });
    expect(audits[0]).not.toHaveProperty("error");
  });
});

describe("single collector event lookup", () => {
  test("fetches and audits closed event metadata through an encoded slug URL", async () => {
    const raw = event("1", { closed: true });
    const deps = pages([raw]);
    const recorded: Parameters<NonNullable<CatalogDependencies["onPage"]>>[0][] = [];
    const before = Date.now();
    const result = await fetchCollectorEvent("game/1", { ...deps, onPage: (page) => recorded.push(page) }, "https://gamma.example.test/v1/");
    const after = Date.now();

    expect(result.eventId).toBe("1");
    expect(result.markets[0]?.collectable).toBe(false);
    expect(deps.urls[0]?.href).toBe("https://gamma.example.test/v1/events/slug/game%2F1");
    expect(recorded[0]?.response).toBe(raw);
    expect(Date.parse(recorded[0]!.requestStartedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(recorded[0]!.requestStartedAt)).toBeLessThanOrEqual(after);
    expect(recorded[0]?.requestStartedAt).toMatch(/Z$/);
  });

  test("rejects invalid event responses instead of returning empty metadata", async () => {
    await expect(fetchCollectorEvent("missing", pages([{ error: "not found" }]))).rejects.toThrow("CATALOG_RESPONSE_INVALID");
  });
});
