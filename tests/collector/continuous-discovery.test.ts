import { describe, expect, test } from "vitest";
import type { CatalogDependencies, CatalogOptions } from "../../src/collector/catalog.js";
import type { SportProfile } from "../../src/collector/continuous-config.js";
import { discoverContinuousEvents, type DiscoveryIssue } from "../../src/collector/continuous-discovery.js";

const now = Date.parse("2026-09-13T12:00:00.000Z");
const options: CatalogOptions = {
  baseUrl: "https://gamma.fixture.test/api",
  now: () => now,
  lookbackHours: 6,
  aheadHours: 2
};
const profiles: readonly SportProfile[] = Object.freeze([
  Object.freeze({ name: "tennis", tagId: "864" }),
  Object.freeze({ name: "table-tennis", tagId: "103767" })
]);

function event(id: string, gameId: string | number | null, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, slug: `event-${id}`, title: `Event ${id}`, gameId,
    sport: "unfamiliar-league-alias", tags: [],
    startTime: new Date(now).toISOString(), markets: [], ...overrides
  };
}

function fixture(routes: Record<string, readonly unknown[]>) {
  const queues = new Map(Object.entries(routes).map(([key, responses]) => [key, [...responses]]));
  const urls: URL[] = [];
  const issues: DiscoveryIssue[] = [];
  const pages: Parameters<NonNullable<CatalogDependencies["onPage"]>>[0][] = [];
  const requests: Parameters<NonNullable<CatalogDependencies["onRequest"]>>[0][] = [];
  const deps: CatalogDependencies = {
    request: async (value) => {
      const url = new URL(value);
      urls.push(url);
      const key = url.pathname.includes("/events/slug/")
        ? `slug:${decodeURIComponent(url.pathname.split("/events/slug/")[1]!)}`
        : url.pathname.endsWith("/events/keyset")
        ? `related:${url.searchParams.get("game_id")}`
        : `profile:${url.searchParams.get("tag_id")}`;
      const queue = queues.get(key);
      if (!queue?.length) throw new Error(`Unexpected fixture request: ${key}`);
      const response = queue.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    onPage: (page) => { pages.push(page); },
    onRequest: (request) => requests.push(request)
  };
  return { deps, urls, issues, pages, requests, onIssue: (issue: DiscoveryIssue) => issues.push(issue) };
}

describe("continuous discovery", () => {
  test("continues another profile after an isolated request failure", async () => {
    const fresh = event("fresh", null);
    const input = fixture({
      "profile:864": [new Error("tennis unavailable")],
      "profile:103767": [[fresh]]
    });

    const result = await discoverContinuousEvents(options, input.deps, profiles, input.onIssue);

    expect(result.map((item) => item.eventId)).toEqual(["fresh"]);
    expect(result[0]?.raw).toBe(fresh);
    expect(input.issues).toEqual([{ scope: "profile", key: "tennis", message: "tennis unavailable" }]);
  });

  test("admits growing fresh results without replaying a failed profile's previous metadata", async () => {
    const oldTennis = event("tennis", "a");
    const oldTable = event("table", "b");
    const freshTable = event("table", "b", { title: "fresh table metadata" });
    const newGame = event("new", "c");
    const freshCompanion = event("table-child", "b", { title: "fresh companion metadata" });
    const input = fixture({
      "profile:864": [[oldTennis], new Error("profile offline")],
      "profile:103767": [[oldTable], [freshTable, newGame]],
      "related:a": [{ events: [event("tennis-child", "a")] }],
      "related:b": [{ events: [event("table-child", "b")] }, { events: [freshCompanion] }],
      "related:c": [{ events: [] }]
    });

    const first = await discoverContinuousEvents(options, input.deps, profiles, input.onIssue);
    const second = await discoverContinuousEvents(options, input.deps, profiles, input.onIssue);

    expect(first.map((item) => item.eventId)).toEqual(["tennis", "table", "tennis-child", "table-child"]);
    expect(second.map((item) => item.eventId)).toEqual(["table", "new", "table-child"]);
    expect(second[0]?.raw).toBe(freshTable);
    expect(second[2]?.raw).toBe(freshCompanion);
    expect(input.issues).toEqual([{ scope: "profile", key: "tennis", message: "profile offline" }]);
  });

  test("throws CONTINUOUS_DISCOVERY_FAILED when every profile fails after an earlier successful sweep", async () => {
    const input = fixture({
      "profile:864": [[event("previous-a", null)], new Error("a offline")],
      "profile:103767": [[event("previous-b", null)], new Error("b offline")]
    });
    expect(await discoverContinuousEvents(options, input.deps, profiles, input.onIssue)).toHaveLength(2);

    const failed = discoverContinuousEvents(options, input.deps, profiles, input.onIssue);

    await expect(failed).rejects.toThrow("CONTINUOUS_DISCOVERY_FAILED");
    await expect(failed).rejects.toMatchObject({ name: "CONTINUOUS_DISCOVERY_FAILED" });
    expect(input.issues.map(({ scope, key }) => ({ scope, key }))).toEqual([
      { scope: "profile", key: "tennis" }, { scope: "profile", key: "table-tennis" }
    ]);
  });

  test("treats an empty successful profile as success even when another profile fails", async () => {
    const input = fixture({ "profile:864": [new Error("offline")], "profile:103767": [[]] });
    expect(await discoverContinuousEvents(options, input.deps, profiles, input.onIssue)).toEqual([]);
    expect(input.issues).toHaveLength(1);
  });

  test("returns no results without reporting network failures", async () => {
    const input = fixture({ "profile:864": [[]], "profile:103767": [{ events: [] }] });
    expect(await discoverContinuousEvents(options, input.deps, profiles, input.onIssue)).toEqual([]);
    expect(input.issues).toEqual([]);
    expect(input.urls).toHaveLength(2);
  });

  test("retains roots without a game ID and makes no invented related requests", async () => {
    const root = event("orphan", null, { parentEventId: "parent", markets: [] });
    const input = fixture({ "profile:864": [[root]], "profile:103767": [[]] });
    const result = await discoverContinuousEvents(options, input.deps, profiles, input.onIssue);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ gameId: null, parentEventId: "parent", markets: [] });
    expect(result[0]?.raw).toBe(root);
    expect(input.issues).toEqual([]);
    expect(input.urls).toHaveLength(2);
  });

  test("keeps every fresh base event and another game's expansion when one related page fails", async () => {
    const roots = [event("one", "a"), event("one-extra", "a"), event("two", "b"), event("orphan", null)];
    const companion = event("two-child", "b");
    const failure = new Error("related page unavailable");
    const input = fixture({
      "profile:864": [roots], "profile:103767": [[]],
      "related:a": [{ events: [event("partial-child", "a")], next_cursor: "next" }, failure],
      "related:b": [{ events: [companion] }]
    });

    const result = await discoverContinuousEvents(options, input.deps, profiles, input.onIssue);

    expect(result.map((item) => item.eventId)).toEqual(["one", "one-extra", "two", "orphan", "two-child"]);
    roots.forEach((raw, index) => expect(result[index]?.raw).toBe(raw));
    expect(result[4]?.raw).toBe(companion);
    expect(input.issues).toEqual([{ scope: "related", key: "a", message: failure.message }]);
    expect(input.urls.filter((url) => url.pathname.endsWith("/keyset")).map((url) => url.searchParams.get("game_id")))
      .toEqual(["a", "a", "b"]);
    expect(input.requests).toHaveLength(5);
    expect(input.pages).toHaveLength(4);
    expect(input.requests.find((request) => request.error)?.error).toBe(failure);
  });

  test("preserves successful base discovery even if every related game fails", async () => {
    const input = fixture({
      "profile:864": [[event("a", "a"), event("b", "b")]], "profile:103767": [[]],
      "related:a": [new Error("a offline")], "related:b": [new Error("b offline")]
    });
    const result = await discoverContinuousEvents(options, input.deps, profiles, input.onIssue);
    expect(result.map((item) => item.eventId)).toEqual(["a", "b"]);
    expect(input.issues.map((issue) => issue.scope)).toEqual(["related", "related"]);
  });

  test("uses each configured tag and game-start bounds without excluding league aliases", async () => {
    const scheduled = (id: string, hours: number) => event(id, null, {
      startTime: new Date(now + hours * 3_600_000).toISOString(), endDate: "2030-01-01T00:00:00Z"
    });
    const input = fixture({ "profile:custom-tag": [[
      scheduled("too-old", -3.01), scheduled("past-boundary", -3), scheduled("inside", 0),
      scheduled("future-boundary", 0.5), scheduled("too-new", 0.51),
      event("live", null, { live: true, startTime: "2020-01-01T00:00:00Z" }),
      event("unknown-clock", null, { startTime: undefined })
    ]] });
    const bounded = Object.freeze({ ...options, dateWindow: "metadata-end" as const, sports: ["tennis"], tagId: "ignored", lookbackHours: 3, aheadHours: 0.5 });

    const result = await discoverContinuousEvents(bounded, input.deps, [{ name: "custom sport", tagId: "custom-tag" }], input.onIssue);

    expect(result.map((item) => item.eventId)).toEqual(["past-boundary", "inside", "future-boundary", "live", "unknown-clock"]);
    expect(input.urls[0]?.pathname).toBe("/api/events");
    expect(Object.fromEntries(input.urls[0]!.searchParams)).toEqual({
      tag_id: "custom-tag", closed: "false", limit: "100", offset: "0", order: "id", ascending: "true"
    });
    expect(bounded.sports).toEqual(["tennis"]);
    expect(input.issues).toEqual([]);
  });

  test("preserves explicit all-open and slug options", async () => {
    const old = event("old", null, { startTime: "2020-01-01T00:00:00Z" });
    const open = fixture({ "profile:864": [[old]] });
    expect(await discoverContinuousEvents({ ...options, allOpen: true }, open.deps, profiles.slice(0, 1))).toHaveLength(1);
    const selected = fixture({ "slug:chosen/game": [old] });
    expect(await discoverContinuousEvents({ ...options, eventSlugs: ["chosen/game"] }, selected.deps, profiles.slice(0, 1)))
      .toHaveLength(1);
    expect(selected.urls[0]?.pathname).toBe("/api/events/slug/chosen%2Fgame");
  });

  test.each([
    { maxPages: undefined, cap: 20 }, { maxPages: 100, cap: 20 }, { maxPages: 2, cap: 2 }
  ])("bounds related pagination to $cap pages with maxPages=$maxPages", async ({ maxPages, cap }) => {
    const input = fixture({
      "profile:864": [[event("root", "a")]],
      "related:a": Array.from({ length: 21 }, (_, index) => ({
        events: [event(`child-${index}`, "a")], next_cursor: `cursor-${index}`
      }))
    });
    const bounded = { ...options, pageSize: 2, ...(maxPages === undefined ? {} : { maxPages }) };

    const result = await discoverContinuousEvents(bounded, input.deps, profiles.slice(0, 1), input.onIssue);

    expect(result.map((item) => item.eventId)).toEqual(["root"]);
    const related = input.urls.filter((url) => url.pathname.endsWith("/keyset"));
    expect(related).toHaveLength(cap);
    expect(related.every((url) => url.searchParams.get("limit") === "2")).toBe(true);
    expect(input.issues).toEqual([{ scope: "related", key: "a", message: expect.stringContaining("RELATED_CATALOG_PAGINATION_LIMIT") }]);
  });

  test("keeps the caller's larger page budget for profile discovery", async () => {
    const input = fixture({ "profile:864": [...Array.from({ length: 21 }, (_, index) => [event(String(index), null)]), []] });
    const result = await discoverContinuousEvents({ ...options, pageSize: 1, maxPages: 22 }, input.deps, profiles.slice(0, 1));
    expect(result).toHaveLength(21);
    expect(input.urls).toHaveLength(22);
  });

  test("retains all market types, prices, volumes, and both outcomes in base and related events", async () => {
    const markets = ["moneyline", "spread", "total", "set_winner", "exact_score", "future_market_type"].map((type, index) => ({
      id: `market-${index}`, conditionId: `condition-${index}`, slug: `market-${index}`,
      sportsMarketType: type, outcomes: '["Yes","No"]', clobTokenIds: JSON.stringify([`000${index}1`, `000${index}2`]),
      outcomePrices: '["1","0"]', bestBid: index % 2 === 0 ? 0 : 1, volume: 0, liquidity: 0,
      closed: index === 5, acceptingOrders: false
    }));
    const input = fixture({
      "profile:864": [[event("root", 0, { markets: markets.slice(0, 2) })]],
      "related:0": [{ events: [event("child", 0, { closed: true, markets: markets.slice(2) })] }]
    });

    const result = await discoverContinuousEvents(options, input.deps, profiles.slice(0, 1), input.onIssue);

    const retained = result.flatMap((item) => item.markets);
    expect(retained).toHaveLength(markets.length);
    markets.forEach((raw, index) => {
      expect(retained[index]?.raw).toBe(raw);
      expect(retained[index]?.outcomes).toEqual(["Yes", "No"]);
      expect(retained[index]?.tokenIds).toEqual([`000${index}1`, `000${index}2`]);
    });
    expect(result.map((item) => item.gameId)).toEqual(["0", "0"]);
    expect(input.issues).toEqual([]);
  });
});

describe("continuous discovery identity integrity", () => {
  test("deduplicates matching identities while preserving the first fresh base metadata", async () => {
    const first = event("root", "a", { title: "first" });
    const child = event("child", "a");
    const input = fixture({
      "profile:864": [[first]], "profile:103767": [[event("root", "a", { title: "later" })]],
      "related:a": [{ events: [event("root", "a", { title: "related" }), child, event("child", "a", { volume: 12 })] }]
    });
    const result = await discoverContinuousEvents(options, input.deps, profiles, input.onIssue);
    expect(result.map((item) => item.eventId)).toEqual(["root", "child"]);
    expect(result[0]?.raw).toBe(first);
    expect(result[1]?.raw).toBe(child);
    expect(input.issues).toEqual([]);
    expect(input.urls.filter((url) => url.pathname.endsWith("/keyset"))).toHaveLength(1);
  });

  test.each([
    { id: "one", slug: "renamed", gameId: "a" },
    { id: "different", slug: "event-one", gameId: "a" },
    { id: "one", slug: "event-one", gameId: "b" },
    { id: "one", slug: "event-one", gameId: null }
  ])("rejects a conflicting profile batch atomically: %j", async (conflicting) => {
    const first = event("one", "a");
    const input = fixture({
      "profile:864": [[first]], "profile:103767": [[event("uncommitted", null), event("conflict", "a", conflicting)]],
      "related:a": [{ events: [] }]
    });
    const result = await discoverContinuousEvents(options, input.deps, profiles, input.onIssue);
    expect(result.map((item) => item.eventId)).toEqual(["one"]);
    expect(result[0]?.raw).toBe(first);
    expect(input.issues).toEqual([{ scope: "profile", key: "table-tennis", message: expect.stringContaining("IDENTITY_CONFLICT") }]);
  });

  test.each([false, true])("detects conflicting IDs before the base catalog drops duplicates (across pages: %j)", async (acrossPages) => {
    const first = event("one", "a");
    const conflict = event("one", "a", { slug: "renamed" });
    const input = fixture({
      "profile:864": acrossPages ? [[first, event("two", "a")], [conflict]] : [[first, conflict]],
      "profile:103767": [[event("fresh", null)]]
    });
    const result = await discoverContinuousEvents({ ...options, pageSize: acrossPages ? 2 : 100 }, input.deps, profiles, input.onIssue);
    expect(result.map((item) => item.eventId)).toEqual(["fresh"]);
    expect(input.issues).toEqual([{ scope: "profile", key: "tennis", message: expect.stringContaining("IDENTITY_CONFLICT") }]);
    expect(input.pages[0]?.response).toEqual(acrossPages ? [first, event("two", "a")] : [first, conflict]);
  });

  test.each(["root", "companion"])("rejects related identities conflicting with another game's %s", async (source) => {
    const rootA = event("a", "a");
    const rootB = event("b", "b");
    const companionA = event("shared", "a");
    const collision = source === "root" ? event("a", "b") : event("shared", "b");
    const input = fixture({
      "profile:864": [[rootA, rootB]], "profile:103767": [[]],
      "related:a": [{ events: [companionA] }],
      "related:b": [{ events: [event("uncommitted", "b"), collision] }]
    });
    const result = await discoverContinuousEvents(options, input.deps, profiles, input.onIssue);
    expect(result.map((item) => item.eventId)).toEqual(["a", "b", "shared"]);
    expect(result[0]?.raw).toBe(rootA);
    expect(result[1]?.raw).toBe(rootB);
    expect(result[2]?.raw).toBe(companionA);
    expect(input.issues).toEqual([{ scope: "related", key: "b", message: expect.stringContaining("IDENTITY_CONFLICT") }]);
  });

  test("keeps fresh seeds when a related response repeats an ID with a conflicting slug", async () => {
    const root = event("root", "a");
    const input = fixture({
      "profile:864": [[root]], "related:a": [{ events: [event("root", "a", { slug: "renamed" })] }]
    });
    const result = await discoverContinuousEvents(options, input.deps, profiles.slice(0, 1), input.onIssue);
    expect(result).toHaveLength(1);
    expect(result[0]?.raw).toBe(root);
    expect(input.issues).toEqual([{ scope: "related", key: "a", message: expect.stringContaining("RELATED_CATALOG_IDENTITY_CONFLICT") }]);
  });

  test("redacts proxy credentials from issue messages", async () => {
    const input = fixture({
      "profile:864": [new Error("request failed through http://proxy-user:proxy-secret@localhost:8080")],
      "profile:103767": [[]]
    });
    expect(await discoverContinuousEvents(options, input.deps, profiles, input.onIssue)).toEqual([]);
    expect(input.issues).toHaveLength(1);
    expect(input.issues[0]?.message).toContain("request failed");
    expect(input.issues[0]?.message).not.toContain("proxy-user");
    expect(input.issues[0]?.message).not.toContain("proxy-secret");
  });
});
