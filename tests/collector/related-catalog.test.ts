import { describe, expect, test } from "vitest";
import { normalizeCollectorEvent, type CatalogDependencies } from "../../src/collector/catalog.js";
import { expandRelatedEvents } from "../../src/collector/related-catalog.js";
import type { CollectorEvent, JsonRequester } from "../../src/collector/types.js";

type Options = Parameters<typeof expandRelatedEvents>[1];
type RequestAudit = Parameters<NonNullable<CatalogDependencies["onRequest"]>>[0];
type PageAudit = Parameters<NonNullable<CatalogDependencies["onPage"]>>[0];

const gameId = "6210652";
const nowMs = Date.parse("2026-09-12T12:00:00.000Z");
const parentSlug = "atp-zverev-khachan-2026-09-11";

function market(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    conditionId: `condition-${id}`,
    slug: `market-${id}`,
    outcomes: '["Yes","No"]',
    clobTokenIds: JSON.stringify([`token-${id}-yes`, `token-${id}-no`]),
    ...overrides
  };
}

function event(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, slug: `event-${id}`, gameId: 6210652, markets: [], ...overrides };
}

function seed(id = "seed", overrides: Record<string, unknown> = {}): CollectorEvent {
  const normalized = normalizeCollectorEvent(event(id, overrides));
  if (!normalized) throw new Error("Invalid seed fixture");
  return normalized;
}

function pages(responses: readonly unknown[]): { request: JsonRequester; urls: URL[] } {
  const urls: URL[] = [];
  return {
    urls,
    request: async (url) => {
      const index = urls.push(new URL(url)) - 1;
      if (index >= responses.length) throw new Error("Unexpected extra related catalog request");
      return responses[index];
    }
  };
}

describe("same-game companion catalog", () => {
  test.each(["parent", "exact-score"])("finds both tennis companions from the %s seed", async (seedId) => {
    const parent = event("parent", { slug: parentSlug });
    const exactScore = event("exact-score", { slug: `${parentSlug}-exact-score` });
    const original = normalizeCollectorEvent(seedId === "parent" ? parent : exactScore)!;
    const seeds = Object.freeze([Object.freeze(original)]);
    const deps = pages([{ events: [parent, exactScore], next_cursor: null, $schema: "events-keyset" }]);

    const result = await expandRelatedEvents(seeds, {}, deps);

    expect(result.map((item) => item.eventId)).toEqual([seedId, seedId === "parent" ? "exact-score" : "parent"]);
    expect(result[0]).toBe(original);
    expect(result[1]?.raw).toBe(seedId === "parent" ? exactScore : parent);
    expect(result).not.toBe(seeds);
    expect(deps.urls).toHaveLength(1);
    expect(deps.urls[0]?.origin).toBe("https://gamma-api.polymarket.com");
    expect(deps.urls[0]?.pathname).toBe("/events/keyset");
    expect(Object.fromEntries(deps.urls[0]!.searchParams)).toEqual({ game_id: gameId, limit: "100" });
  });

  test("preserves every seed and closed, archived, paused, unknown, and metadata-only companions", async () => {
    const seeds = Object.freeze([seed("seed", { closed: true }), seed("orphan", { gameId: null })]);
    const closed = market("closed", { closed: true, outcomePrices: '["1","0"]', bestBid: 1 });
    const archived = market("archived", { archived: true });
    const paused = market("paused", { active: false, acceptingOrders: false, enableOrderBook: false });
    const unknown = market("unknown", {
      sportsMarketType: "future_market_type", volume: 0, liquidity: 0, bestBid: 0,
      outcomes: ["2-0", "2-1", "1-2", "0-2"], clobTokenIds: ["001", "002", "003", "004"],
      futureMetadata: { retained: true }
    });
    const related = [
      event("closed", { closed: true, markets: [closed] }),
      event("archived", { archived: true, markets: [archived] }),
      event("paused", { active: false, markets: [paused] }),
      event("unknown", { sport: "unrecognized", tags: [], markets: [unknown] }),
      event("metadata", { markets: undefined })
    ];

    const result = await expandRelatedEvents(seeds, {}, pages([{ events: related }]));

    expect(result.map((item) => item.eventId)).toEqual(["seed", "orphan", "closed", "archived", "paused", "unknown", "metadata"]);
    seeds.forEach((original, index) => expect(result[index]).toBe(original));
    related.forEach((raw, index) => expect(result[index + seeds.length]?.raw).toBe(raw));
    [closed, archived, paused, unknown].forEach((raw, index) => expect(result[index + 2]?.markets[0]?.raw).toBe(raw));
    expect(result.slice(2, 5).map((item) => item.markets[0]?.collectable)).toEqual([false, false, false]);
    expect(result[5]?.markets[0]?.tokenIds).toEqual(["001", "002", "003", "004"]);
    expect(result[6]?.markets).toEqual([]);
  });

  test("queries each nonnull seed game once with independent cursors and page budgets", async () => {
    const seeds = [seed("a"), seed("b"), seed("orphan", { gameId: null }), seed("zero", { gameId: 0 }), seed("other", { gameId: "other" })];
    const deps = pages([
      { events: [event("companion")], next_cursor: "shared-cursor" },
      { events: [], next_cursor: null },
      { events: [], next_cursor: "shared-cursor" },
      { events: [event("zero-companion", { gameId: 0 })], next_cursor: "" },
      { events: [event("other-companion", { gameId: "other" })] }
    ]);

    const result = await expandRelatedEvents(seeds, { pageSize: 2, maxPages: 2 }, deps);

    expect(result.map((item) => item.eventId)).toEqual([...seeds.map((item) => item.eventId), "companion", "zero-companion", "other-companion"]);
    expect(deps.urls.map((url) => url.searchParams.get("game_id"))).toEqual([gameId, gameId, "0", "0", "other"]);
    expect(deps.urls.map((url) => url.searchParams.get("after_cursor"))).toEqual([null, "shared-cursor", null, "shared-cursor", null]);
  });

  test.each([{ seeds: [] }, { seeds: [seed("orphan", { gameId: null })] }])("does not request data without a seed game: $seeds", async ({ seeds }) => {
    const deps = pages([]);
    const result = await expandRelatedEvents(seeds, {}, deps);
    expect(result).toEqual(seeds);
    expect(result).not.toBe(seeds);
    expect(deps.urls).toHaveLength(0);
  });

  test("deduplicates matching identities across seeds and pages while preserving first objects", async () => {
    const original = seed();
    const first = event("2", { id: 2 });
    const deps = pages([
      { events: [original.raw, first], next_cursor: "next" },
      { events: [event("seed", { volume: "100" }), event("2", { volume: "999" }), event("3")] }
    ]);

    const result = await expandRelatedEvents([original, seed("seed", { title: "duplicate seed" })], {}, deps);

    expect(result.map((item) => item.eventId)).toEqual(["seed", "2", "3"]);
    expect(result[0]).toBe(original);
    expect(result[1]?.raw).toBe(first);
  });

  test("uses normalized game IDs including the eventMetadata fallback", async () => {
    const raw = event("metadata-game", { gameId: null, eventMetadata: { gameId: 6210652 } });
    const result = await expandRelatedEvents([seed()], {}, pages([{ events: [raw] }]));
    expect(result[1]?.gameId).toBe(gameId);
    expect(result[1]?.raw).toBe(raw);
  });

  test("follows short and empty pages with opaque, safely encoded cursors", async () => {
    const queryGame = "game/+ &=雪";
    const cursor = "cursor/+?=&% 雪";
    const deps = pages([
      { events: [event("first", { gameId: queryGame })], next_cursor: cursor },
      { events: [], next_cursor: " " },
      { events: [event("last", { gameId: queryGame })], next_cursor: null }
    ]);

    const result = await expandRelatedEvents([seed("seed", { gameId: queryGame })], {
      baseUrl: "https://gamma.example.test/api///", pageSize: 10, maxPages: 3
    }, deps);

    expect(result.map((item) => item.eventId)).toEqual(["seed", "first", "last"]);
    expect(deps.urls.map((url) => url.pathname)).toEqual(Array(3).fill("/api/events/keyset"));
    expect(deps.urls.map((url) => Object.fromEntries(url.searchParams))).toEqual([
      { game_id: queryGame, limit: "10" },
      { game_id: queryGame, limit: "10", after_cursor: cursor },
      { game_id: queryGame, limit: "10", after_cursor: " " }
    ]);
  });

  test.each([{}, { next_cursor: null }, { next_cursor: "" }])("accepts an explicit end on a full final allowed page: %j", async (ending) => {
    const deps = pages([
      { events: [event("first")], next_cursor: "next" },
      { events: [event("last")], ...ending }
    ]);
    const result = await expandRelatedEvents([seed()], { pageSize: 1, maxPages: 2 }, deps);
    expect(result.map((item) => item.eventId)).toEqual(["seed", "first", "last"]);
    expect(deps.urls).toHaveLength(2);
  });
});

describe("related catalog completeness and identity checks", () => {
  test.each([
    null, [], [event("array")], {}, { error: "rate limited" }, { events: null }, { events: {} }, "[]",
    { events: [], next_cursor: 0 }, { events: [], next_cursor: false },
    { events: [], next_cursor: {} }, { events: [], next_cursor: [] }
  ].map((response) => ({ response })))("rejects malformed page data: $response", async ({ response }) => {
    await expect(expandRelatedEvents([seed()], {}, pages([response])))
      .rejects.toMatchObject({ name: "RELATED_CATALOG_RESPONSE_INVALID" });
  });

  test.each([null, [], {}, { id: "bad" }, { slug: "bad" }, event("bad", { slug: " " }), event("bad", { id: 1.5 })].map((invalid) => ({ invalid })))(
    "rejects an invalid event instead of returning a partial page: $invalid", async ({ invalid }) => {
      await expect(expandRelatedEvents([seed()], {}, pages([{ events: [event("valid"), invalid] }])))
        .rejects.toMatchObject({ name: "RELATED_CATALOG_RESPONSE_INVALID" });
    }
  );

  test.each([null, undefined, "other", " 6210652 ", 0, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a mismatched normalized game ID even for a seed duplicate: %j", async (returnedGameId) => {
      const deps = pages([{ events: [event("seed", { gameId: returnedGameId })] }]);
      await expect(expandRelatedEvents([seed()], {}, deps))
        .rejects.toMatchObject({ name: "RELATED_CATALOG_GAME_ID_MISMATCH" });
      expect(deps.urls).toHaveLength(1);
    }
  );

  test.each([
    { label: "same ID, different slug", seeds: [seed()], raw: event("seed", { slug: "different-slug" }) },
    { label: "same slug, different ID", seeds: [seed()], raw: event("different-id", { slug: "event-seed" }) },
    { label: "crossed ID and slug", seeds: [seed("a"), seed("b")], raw: event("a", { slug: "event-b" }) },
    { label: "identity from a different seed game", seeds: [seed("a"), seed("b", { gameId: "other" })], raw: event("b") },
    { label: "identity from a null-game seed", seeds: [seed("a"), seed("b", { gameId: null })], raw: event("b") }
  ])("fails closed on $label", async ({ seeds, raw }) => {
    await expect(expandRelatedEvents(seeds, {}, pages([{ events: [raw] }])))
      .rejects.toMatchObject({ name: "RELATED_CATALOG_IDENTITY_CONFLICT" });
  });

  test.each([
    seed("seed", { slug: "renamed" }), seed("another", { slug: "event-seed" }),
    seed("seed", { gameId: "other" }), seed("seed", { gameId: null })
  ])("rejects conflicting seed identities before requesting data: %j", async (conflicting) => {
    const deps = pages([]);
    await expect(expandRelatedEvents([seed(), conflicting], {}, deps))
      .rejects.toMatchObject({ name: "RELATED_CATALOG_IDENTITY_CONFLICT" });
    expect(deps.urls).toHaveLength(0);
  });

  test("checks identity conflicts between related events on different pages", async () => {
    const deps = pages([
      { events: [event("companion")], next_cursor: "next" },
      { events: [event("new-id", { slug: "event-companion" })] }
    ]);
    await expect(expandRelatedEvents([seed()], {}, deps))
      .rejects.toMatchObject({ name: "RELATED_CATALOG_IDENTITY_CONFLICT" });
  });

  test.each([{ cursors: ["one", "one"] }, { cursors: ["one", "two", "one"] }])("rejects a repeated or cycling cursor: $cursors", async ({ cursors }) => {
    const deps = pages(cursors.map((next_cursor, index) => ({ events: [event(`page-${index}`)], next_cursor })));
    await expect(expandRelatedEvents([seed()], { maxPages: 10 }, deps))
      .rejects.toMatchObject({ name: "RELATED_CATALOG_PAGINATION_STALLED" });
    expect(deps.urls).toHaveLength(cursors.length);
  });

  test("rejects repeated nonempty page identities despite changed ordering, volume, and cursor", async () => {
    const deps = pages([
      { events: [event("a"), event("b")], next_cursor: "one" },
      { events: [event("b", { volume: 20 }), event("a", { volume: 100 })], next_cursor: "two" }
    ]);
    await expect(expandRelatedEvents([seed()], {}, deps))
      .rejects.toMatchObject({ name: "RELATED_CATALOG_PAGINATION_STALLED" });
    expect(deps.urls).toHaveLength(2);
  });

  test.each([false, true])("throws at the page cap without an explicit end (empty pages: %j)", async (empty) => {
    const deps = pages([0, 1].map((index) => ({ events: empty ? [] : [event(`page-${index}`)], next_cursor: `cursor-${index}` })));
    await expect(expandRelatedEvents([seed()], { maxPages: 2 }, deps))
      .rejects.toMatchObject({ name: "RELATED_CATALOG_PAGINATION_LIMIT" });
    expect(deps.urls).toHaveLength(2);
  });

  test("defaults to a cap of twenty pages per game", async () => {
    const deps = pages(Array.from({ length: 20 }, (_, index) => ({ events: [event(`page-${index}`)], next_cursor: `cursor-${index}` })));
    await expect(expandRelatedEvents([seed()], {}, deps))
      .rejects.toMatchObject({ name: "RELATED_CATALOG_PAGINATION_LIMIT" });
    expect(deps.urls).toHaveLength(20);
  });
});

describe("related catalog options and audit records", () => {
  test.each([
    { pageSize: 0 }, { pageSize: -1 }, { pageSize: 1.5 }, { pageSize: NaN }, { pageSize: Infinity },
    { pageSize: Number.MAX_SAFE_INTEGER + 1 }, { pageSize: "2" }, { pageSize: null },
    { maxPages: 0 }, { maxPages: -1 }, { maxPages: 1.5 }, { maxPages: NaN }, { maxPages: Infinity },
    { maxPages: Number.MAX_SAFE_INTEGER + 1 }, { maxPages: "2" }, { maxPages: null },
    { baseUrl: "" }, { baseUrl: "/relative" }, { baseUrl: "ftp://gamma.example.test" },
    { baseUrl: "https://gamma.example.test?query=1" }, { baseUrl: "https://gamma.example.test#fragment" },
    { baseUrl: null }, { baseUrl: 123 }, { now: null }, { now: 123 }
  ])("validates options before any request, including for an empty catalog: %j", async (options) => {
    for (const seeds of [[], [seed()]]) {
      const deps = pages([]);
      await expect(expandRelatedEvents(seeds, options as unknown as Options, deps))
        .rejects.toMatchObject({ name: "RELATED_CATALOG_OPTIONS_INVALID" });
      expect(deps.urls).toHaveLength(0);
    }
  });

  test.each([NaN, Infinity, 8.64e15 + 1])("rejects an invalid request clock before fetching: %j", async (timestamp) => {
    const deps = pages([]);
    await expect(expandRelatedEvents([seed()], { now: () => timestamp }, deps))
      .rejects.toMatchObject({ name: "RELATED_CATALOG_OPTIONS_INVALID" });
    expect(deps.urls).toHaveLength(0);
  });

  test("audits each request with start/end clocks and original responses before delivering pages", async () => {
    let current = nowMs;
    const raw = event("companion");
    const responses = [
      Object.freeze({ events: Object.freeze([raw]), next_cursor: "next", $schema: { future: true } }),
      Object.freeze({ events: [], next_cursor: null })
    ];
    const requests: RequestAudit[] = [];
    const recorded: PageAudit[] = [];
    const order: string[] = [];
    const deps = pages(responses);

    const result = await expandRelatedEvents([seed()], { now: () => current }, {
      request: async (url) => { order.push("request"); current += 1500; return deps.request(url); },
      onRequest: (audit) => { order.push("onRequest"); requests.push(audit); },
      onPage: (page) => { order.push("onPage"); recorded.push(page); }
    });

    expect(order).toEqual(["request", "onRequest", "onPage", "request", "onRequest", "onPage"]);
    expect(result[1]?.raw).toBe(raw);
    responses.forEach((response, index) => {
      const audit = {
        url: deps.urls[index]!.href,
        requestStartedAt: new Date(nowMs + index * 1500).toISOString(),
        requestEndedAt: new Date(nowMs + (index + 1) * 1500).toISOString(),
        response
      };
      expect(requests[index]).toEqual(audit);
      expect(recorded[index]).toEqual(audit);
      expect(requests[index]?.response).toBe(response);
      expect(recorded[index]?.response).toBe(response);
    });
  });

  test("records the original invalid response before rejecting page data", async () => {
    const response = { events: [event("valid"), null], next_cursor: "next", $schema: { retained: true } };
    const requests: RequestAudit[] = [];
    const recorded: PageAudit[] = [];
    await expect(expandRelatedEvents([seed()], { now: () => nowMs }, {
      ...pages([response]), onRequest: (audit) => requests.push(audit), onPage: (page) => { recorded.push(page); }
    })).rejects.toMatchObject({ name: "RELATED_CATALOG_RESPONSE_INVALID" });
    expect(requests).toHaveLength(1);
    expect(recorded).toHaveLength(1);
    expect(requests[0]?.response).toBe(response);
    expect(recorded[0]?.response).toBe(response);
    expect(requests[0]).not.toHaveProperty("error");
  });

  test.each([new Error("offline"), { status: 429, reason: "rate limited" }])("audits and rethrows the original request error: %j", async (failure) => {
    let current = nowMs;
    const requests: RequestAudit[] = [];
    const recorded: PageAudit[] = [];
    await expect(expandRelatedEvents([seed()], { now: () => current }, {
      request: async () => { current += 750; throw failure; },
      onRequest: (audit) => requests.push(audit),
      onPage: (page) => { recorded.push(page); }
    })).rejects.toBe(failure);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: "https://gamma-api.polymarket.com/events/keyset?game_id=6210652&limit=100",
      requestStartedAt: "2026-09-12T12:00:00.000Z",
      requestEndedAt: "2026-09-12T12:00:00.750Z",
      error: failure
    });
    expect(requests[0]?.error).toBe(failure);
    expect(recorded).toEqual([]);
  });

  test.each(["onRequest", "onPage"])("propagates %s failures without double auditing or requesting another page", async (failingHook) => {
    const response = { events: [event("companion")], next_cursor: "next" };
    const deps = pages([response]);
    const failure = new Error("journal unavailable");
    const requests: RequestAudit[] = [];
    const recorded: PageAudit[] = [];
    await expect(expandRelatedEvents([seed()], {}, {
      ...deps,
      onRequest: (audit) => { requests.push(audit); if (failingHook === "onRequest") throw failure; },
      onPage: (page) => { recorded.push(page); if (failingHook === "onPage") throw failure; }
    })).rejects.toBe(failure);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.response).toBe(response);
    expect(requests[0]).not.toHaveProperty("error");
    expect(recorded).toHaveLength(failingHook === "onRequest" ? 0 : 1);
    expect(deps.urls).toHaveLength(1);
  });
});
