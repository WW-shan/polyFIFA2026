import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  decodeInitialStatePayload,
  extractNextInitialState,
  fetchEventMatchState,
  fetchEventStrategyMarkets,
  findMatchState,
  findSpreadMarkets,
  findStrategyMarkets,
  findStrategyMarketsFromSportsPageHtml,
  normalizeSpreadMarket,
  normalizeStrategyMarket,
  parseSpreadLine
} from "../../src/polymarket/event-page.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const requestedSlug = "fifwc-esp-ksa-2026-06-21";
const foreignSlug = "fifwc-fra-irq-2026-06-22";

function eventMarkets(prefix: string) {
  return [
    {
      slug: `${prefix}-total-2pt5`,
      question: "Home vs. Away: O/U 2.5",
      conditionId: `${prefix}-total-condition`,
      outcomes: ["Over", "Under"],
      clobTokenIds: [`${prefix}-over`, `${prefix}-under`],
      sportsMarketType: "totals"
    },
    {
      slug: `${prefix}-spread`,
      question: "Spread: Home (-2.5)",
      conditionId: `${prefix}-spread-condition`,
      outcomes: ["Home", "Away"],
      clobTokenIds: [`${prefix}-home`, `${prefix}-away`],
      sportsMarketType: "spreads"
    }
  ];
}

describe("market event ownership (T6)", () => {
  const ownEvent = { slug: requestedSlug, markets: eventMarkets("own") };
  const foreignEvent = { slug: foreignSlug, markets: eventMarkets("foreign") };
  test.each([
    { name: "events map", state: { events: { [requestedSlug]: ownEvent, [foreignSlug]: foreignEvent } } },
    { name: "events array", state: { events: [foreignEvent, ownEvent] } },
    { name: "root event array", state: [foreignEvent, ownEvent] },
    { name: "map keys without child slugs", state: { events: {
      [requestedSlug]: { markets: ownEvent.markets },
      [foreignSlug]: { markets: foreignEvent.markets }
    } } },
    { name: "nested event", state: { event: { slug: foreignSlug, nested: { markets: foreignEvent.markets } } } },
    { name: "query data", state: { dehydratedState: { queries: [
      { queryKey: ["event", foreignSlug], state: { data: foreignEvent } },
      { queryKey: ["event", requestedSlug], state: { data: ownEvent } }
    ] } } },
    { name: "query ownership without data slug", state: { queries: [
      { queryKey: ["event", foreignSlug], state: { data: { markets: foreignEvent.markets } } },
      { queryKey: ["event", requestedSlug], state: { data: { markets: ownEvent.markets } } }
    ] } }
  ])("inherits ownership in $name for both market paths", ({ name, state }) => {
    const expected = name === "nested event" ? [] : ["own-total-condition", "own-spread-condition"];
    expect(findStrategyMarkets(state, requestedSlug).map((market) => market.conditionId)).toEqual(expected);
    expect(findSpreadMarkets(state, requestedSlug).map((market) => market.conditionId))
      .toEqual(expected.filter((id) => id.includes("spread")));
  });

  test("does not let explicit child ownership override a conflicting parent", () => {
    const state = { events: { [foreignSlug]: {
      slug: foreignSlug,
      markets: eventMarkets("conflict").map((market) => ({ ...market, eventSlug: requestedSlug }))
    } } };
    expect(findStrategyMarkets(state, requestedSlug)).toEqual([]);
    expect(findSpreadMarkets(state, requestedSlug)).toEqual([]);
  });

  test("rejects event records whose slug conflicts with their map key", () => {
    const state = { events: { [foreignSlug]: ownEvent } };
    expect(findStrategyMarkets(state, requestedSlug)).toEqual([]);
    expect(findSpreadMarkets(state, requestedSlug)).toEqual([]);
  });

  test("does not assign unowned sibling markets from a multi-event page to the request", () => {
    const state = { events: [ownEvent, foreignEvent], markets: eventMarkets("unowned") };
    expect(findStrategyMarkets(state, requestedSlug).map((market) => market.conditionId))
      .toEqual(["own-total-condition", "own-spread-condition"]);
    expect(findSpreadMarkets(state, requestedSlug).map((market) => market.conditionId))
      .toEqual(["own-spread-condition"]);
  });

  test("does not use fixture fallback when another event cache is nested beside markets", () => {
    const state = { markets: eventMarkets("unowned"), cache: { events: [ownEvent, foreignEvent] } };
    expect(findStrategyMarkets(state, requestedSlug).map((market) => market.conditionId))
      .toEqual(["own-total-condition", "own-spread-condition"]);
    expect(findSpreadMarkets(state, requestedSlug).map((market) => market.conditionId))
      .toEqual(["own-spread-condition"]);
  });

  test("inherits a sibling event object's ownership before considering a fixture fallback", () => {
    const state = { event: { slug: foreignSlug }, markets: eventMarkets("foreign") };
    expect(findStrategyMarkets(state, requestedSlug)).toEqual([]);
    expect(findSpreadMarkets(state, requestedSlug)).toEqual([]);
    expect(findStrategyMarkets({ ...state, event: { slug: requestedSlug } }, requestedSlug)).toHaveLength(2);
  });

  test("does not confuse a page slug with the identities in its event collection", () => {
    const state = { slug: "world-cup", events: [ownEvent, foreignEvent] };
    expect(findStrategyMarkets(state, requestedSlug).map((market) => market.conditionId))
      .toEqual(["own-total-condition", "own-spread-condition"]);
  });

  test.each([
    { name: "strategy", find: findStrategyMarkets, expected: ["own-total-condition", "own-spread-condition"] },
    { name: "spread", find: findSpreadMarkets, expected: ["own-spread-condition"] }
  ])("preserves event ownership through wrapped market lists on the $name path", ({ find, expected }) => {
    const foreign = [{ slug: foreignSlug, nested: { markets: eventMarkets("foreign")
      .map((market) => ({ ...market, eventSlug: requestedSlug })) } }];
    expect(find(foreign, requestedSlug)).toEqual([]);
    const own = { slug: requestedSlug, nested: { markets: eventMarkets("own") } };
    expect(find([own], requestedSlug).map((market) => market.conditionId)).toEqual(expected);
    expect(find({ data: own }, requestedSlug).map((market) => market.conditionId)).toEqual(expected);
  });

  test("rejects wrapped foreign event children from compressed Flight data", () => {
    const state = [{ slug: foreignSlug, nested: { markets: eventMarkets("foreign")
      .map((market) => ({ ...market, eventSlug: requestedSlug })) } }];
    const encoded = deflateSync(JSON.stringify(state)).toString("base64url");
    const chunk = `23:T${encoded.length.toString(16)},${encoded}\n`;
    const html = `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`;
    expect(findStrategyMarketsFromSportsPageHtml(html, requestedSlug)).toEqual([]);
  });

  test.each([
    { name: "array", events: [ownEvent, foreignEvent] },
    { name: "map", events: { [requestedSlug]: ownEvent, [foreignSlug]: foreignEvent } }
  ])("does not let a page slug own its nested event $name cache", ({ events }) => {
    const state = { slug: "world-cup", markets: [], cache: { events } };
    expect(findStrategyMarkets(state, requestedSlug).map((market) => market.conditionId))
      .toEqual(["own-total-condition", "own-spread-condition"]);
    expect(findSpreadMarkets(state, requestedSlug).map((market) => market.conditionId))
      .toEqual(["own-spread-condition"]);
  });

  test.each([
    { name: "strategy", find: findStrategyMarkets, expected: ["own-total-condition", "own-spread-condition"] },
    { name: "spread", find: findSpreadMarkets, expected: ["own-spread-condition"] },
    { name: "Flight", find: (state: unknown, slug: string) => {
      const encoded = deflateSync(JSON.stringify(state)).toString("base64url");
      const chunk = `23:T${encoded.length.toString(16)},${encoded}\n`;
      return findStrategyMarketsFromSportsPageHtml(`<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`, slug);
    }, expected: ["own-total-condition", "own-spread-condition"] }
  ])("metadata collections cannot change direct event ownership on the $name path", ({ find, expected }) => {
    const series = [{ slug: "world-cup-2026", events: [] }];
    expect(find({ ...ownEvent, series }, requestedSlug).map((market) => market.conditionId)).toEqual(expected);
    expect(find({
      ...foreignEvent,
      markets: foreignEvent.markets.map((market) => ({ ...market, eventSlug: requestedSlug })),
      series
    }, requestedSlug)).toEqual([]);
  });

  test("nested events establish new boundaries even through conflicting series metadata", () => {
    const state = { ...foreignEvent, series: [{ slug: "world-cup-2026", events: [ownEvent] }] };
    expect(findStrategyMarkets(state, requestedSlug).map((market) => market.conditionId))
      .toEqual(["own-total-condition", "own-spread-condition"]);
    expect(findSpreadMarkets(state, requestedSlug).map((market) => market.conditionId)).toEqual(["own-spread-condition"]);
    expect(findStrategyMarkets({ ...foreignEvent, series: [{
      slug: "world-cup-2026", events: { [foreignSlug]: ownEvent }
    }] }, requestedSlug)).toEqual([]);
  });

  test("event query boundaries ignore page ownership while checking the query against its data", () => {
    const state = { slug: "world-cup", cache: { queries: [
      { queryKey: ["event", requestedSlug], state: { data: ownEvent } },
      { queryKey: ["event", foreignSlug], state: { data: { slug: requestedSlug, markets: eventMarkets("conflict") } } }
    ] } };
    expect(findStrategyMarkets(state, requestedSlug).map((market) => market.conditionId))
      .toEqual(["own-total-condition", "own-spread-condition"]);
  });

  test("retains actual ownership when no event filter is supplied", () => {
    const markets = findStrategyMarkets({ events: [ownEvent, foreignEvent] });
    expect(markets.map((market) => market.eventSlug)).toEqual([requestedSlug, requestedSlug, foreignSlug, foreignSlug]);
  });

  test.each([
    { name: "direct Gamma event", state: ownEvent },
    { name: "direct market fixture", state: eventMarkets("own")[0] },
    { name: "market array fixture", state: eventMarkets("own") },
    { name: "market wrapper fixture", state: { markets: eventMarkets("own") } }
  ])("preserves isolated $name compatibility", ({ state }) => {
    expect(findStrategyMarkets(state, requestedSlug)[0]).toMatchObject({
      eventSlug: requestedSlug,
      conditionId: "own-total-condition"
    });
  });

  test.each([
    { name: "spread", normalize: normalizeSpreadMarket },
    { name: "strategy", normalize: normalizeStrategyMarket }
  ])("validates explicit market event associations in $name normalization", ({ normalize }) => {
    const market = eventMarkets("relation")[1]!;
    expect(normalize({ ...market, events: [{ slug: foreignSlug }] }, requestedSlug)).toBeNull();
    expect(normalize({ ...market, events: [foreignSlug] }, requestedSlug)).toBeNull();
    expect(normalize({ ...market, eventSlug: requestedSlug, event_slug: foreignSlug }, requestedSlug)).toBeNull();
    expect(normalize({ ...market, events: [{ slug: requestedSlug }, { slug: foreignSlug }] }, requestedSlug)).toBeNull();
    expect(normalize({ ...market, events: [{ slug: requestedSlug }] }, requestedSlug))
      .toMatchObject({ eventSlug: requestedSlug });
  });
});

describe("sports page match-state formats (O6)", () => {
  const state = {
    games: { [requestedSlug]: { event: requestedSlug, score: "3-0", period: "2H", elapsed: "90+1'", live: true } },
    events: { [requestedSlug]: { slug: requestedSlug, title: "Spain vs. Saudi Arabia" } }
  };
  const encoded = deflateSync(JSON.stringify(state)).toString("base64url");
  const splitAt = Math.floor(encoded.length / 2);
  const flight = [
    `<script>self.__next_f.push([1,${JSON.stringify(`23:T${encoded.length.toString(16)},${encoded.slice(0, splitAt)}`)}])</script>`,
    `<script>self.__next_f.push([1,${JSON.stringify(`${encoded.slice(splitAt)}\n`)}])</script>`
  ].join("");

  test.each([
    { name: "Flight without NEXT_DATA", html: flight },
    { name: "malformed NEXT_DATA with Flight", html: `<script id="__NEXT_DATA__">{invalid}</script>${flight}` },
    { name: "NEXT_DATA lacking the match with Flight", html: nextStateHtml({}) + flight },
    { name: "legacy NEXT_DATA", html: nextStateHtml(state) }
  ])("reads $name", async ({ html }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(html));
    await expect(fetchEventMatchState(requestedSlug)).resolves.toEqual({
      eventSlug: requestedSlug,
      homeTeam: "Spain",
      awayTeam: "Saudi Arabia",
      homeGoals: 3,
      awayGoals: 0,
      period: "2H",
      minute: 91,
      isLive: true
    });
  });

  test("reports a missing requested match after searching Flight states", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(flight));
    await expect(fetchEventMatchState(foreignSlug)).rejects.toThrow(`MATCH_STATE_NOT_FOUND: ${foreignSlug}`);
  });
});

function nextStateHtml(state: unknown): string {
  const initialState = deflateSync(JSON.stringify(state)).toString("base64");
  return `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { initialState } } })}</script>`;
}

describe("event page initial state parsing", () => {
  test("extracts base64 zlib initialState and normalizes spread markets", () => {
    const state = {
      event: {
        slug: "fifwc-esp-ksa-2026-06-21",
        nested: {
          markets: [
            {
              sportsMarketType: "spreads",
              eventSlug: "fifwc-esp-ksa-2026-06-21",
              slug: "fifwc-esp-ksa-2026-06-21-spread-home-3pt5",
              question: "Spread: Spain (-3.5)",
              conditionId: "cond-spain-3p5",
              clobTokenIds: "[\"token-spain-3p5\",\"token-saudi-plus-3p5\"]",
          outcomes: "[\"Spain\",\"Saudi Arabia\"]",
              orderPriceMinTickSize: 0.01,
              tickSize: "0.001",
              negRisk: false
            }
          ]
        }
      }
    };
    const initialState = deflateSync(JSON.stringify(state)).toString("base64");
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialState } } })}</script></html>`;

    const payload = extractNextInitialState(html);
    expect(payload).toBe(initialState);
    const decoded = decodeInitialStatePayload(payload);
    const markets = findSpreadMarkets(decoded, "fifwc-esp-ksa-2026-06-21");

    expect(markets).toHaveLength(1);
    expect(markets[0]).toMatchObject({
      eventSlug: "fifwc-esp-ksa-2026-06-21",
      marketSlug: "fifwc-esp-ksa-2026-06-21-spread-home-3pt5",
      question: "Spread: Spain (-3.5)",
      conditionId: "cond-spain-3p5",
      clobTokenIds: ["token-spain-3p5", "token-saudi-plus-3p5"],
      outcomes: ["Spain", "Saudi Arabia"],
      line: -3.5,
      tickSize: "0.001",
      negRisk: false
    });
  });

  test("normalizes numeric Polymarket order price tick size when tickSize is absent", () => {
    const markets = findStrategyMarkets({
      markets: [
        {
          eventSlug: "fifwc-fra-irq-2026-06-22",
          slug: "fifwc-fra-irq-2026-06-22-fra",
          question: "Will France win on 2026-06-22?",
          conditionId: "cond-france",
          clobTokenIds: "[\"yes\",\"no\"]",
          outcomes: "[\"Yes\",\"No\"]",
          sportsMarketType: "moneyline",
          orderPriceMinTickSize: 0.01
        }
      ]
    }, "fifwc-fra-irq-2026-06-22");

    expect(markets[0]?.tickSize).toBe("0.01");
  });

  test("falls back to Gamma event markets when the sports page has no strategy markets", async () => {
    const emptyState = deflateSync(JSON.stringify({ markets: [] })).toString("base64");
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialState: emptyState } } })}</script></html>`;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(html, { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({
      slug: "fifwc-fra-irq-2026-06-22",
      markets: [
        {
          slug: "fifwc-fra-irq-2026-06-22-fra",
          question: "Will France win on 2026-06-22?",
          conditionId: "cond-france",
          clobTokenIds: "[\"yes\",\"no\"]",
          outcomes: "[\"Yes\",\"No\"]",
          sportsMarketType: "moneyline",
          orderPriceMinTickSize: 0.01,
          negRisk: true
        }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const markets = await fetchEventStrategyMarkets("fifwc-fra-irq-2026-06-22");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(markets).toEqual([
      expect.objectContaining({
        eventSlug: "fifwc-fra-irq-2026-06-22",
        marketSlug: "fifwc-fra-irq-2026-06-22-fra",
        marketType: "moneyline",
        clobTokenIds: ["yes", "no"],
        tickSize: "0.01",
        negRisk: true
      })
    ]);
  });

  test("merges Gamma event markets when the sports page only has non-locked strategy markets", async () => {
    const eventSlug = "fifwc-mex-ecu-2026-06-30";
    const partialState = deflateSync(JSON.stringify({
      markets: [
        {
          eventSlug,
          slug: `${eventSlug}-ecuador`,
          question: "Will Ecuador win on 2026-06-30?",
          conditionId: "cond-ecuador",
          clobTokenIds: "[\"ecuador-yes\",\"ecuador-no\"]",
          outcomes: "[\"Yes\",\"No\"]",
          sportsMarketType: "moneyline"
        }
      ]
    })).toString("base64");
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialState: partialState } } })}</script></html>`;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(html, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        slug: eventSlug,
        markets: [
          {
            eventSlug,
            slug: `${eventSlug}-ecuador`,
            question: "Will Ecuador win on 2026-06-30?",
            conditionId: "cond-ecuador",
            clobTokenIds: "[\"ecuador-yes\",\"ecuador-no\"]",
            outcomes: "[\"Yes\",\"No\"]",
            sportsMarketType: "moneyline"
          },
          {
            eventSlug,
            slug: `${eventSlug}-total-0pt5`,
            question: "Mexico vs. Ecuador: O/U 0.5",
            conditionId: "cond-total",
            clobTokenIds: "[\"total-over\",\"total-under\"]",
            outcomes: "[\"Over\",\"Under\"]",
            sportsMarketType: "totals"
          },
          {
            eventSlug,
            slug: `${eventSlug}-mexico-team-total-0pt5`,
            question: "Mexico vs. Ecuador: Mexico O/U 0.5",
            conditionId: "cond-team-total",
            clobTokenIds: "[\"team-over\",\"team-under\"]",
            outcomes: "[\"Over\",\"Under\"]",
            sportsMarketType: "totals"
          }
        ]
      }), { status: 200, headers: { "content-type": "application/json" } }));

    const markets = await fetchEventStrategyMarkets(eventSlug);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(markets).toContainEqual(expect.objectContaining({ marketSlug: `${eventSlug}-ecuador`, marketType: "moneyline" }));
    expect(markets).toContainEqual(expect.objectContaining({ marketSlug: `${eventSlug}-total-0pt5`, marketType: "total", line: 0.5 }));
    expect(markets).toContainEqual(expect.objectContaining({ marketSlug: `${eventSlug}-mexico-team-total-0pt5`, marketType: "team_total", team: "Mexico", line: 0.5 }));
    expect(markets.filter((market) => market.conditionId === "cond-ecuador")).toHaveLength(1);
  });

  test("keeps partial sports page markets when Gamma fallback is unavailable", async () => {
    const eventSlug = "fifwc-partial-gamma-down-2026-07-01";
    const partialState = deflateSync(JSON.stringify({
      markets: [
        {
          eventSlug,
          slug: `${eventSlug}-home`,
          question: "Will Partial win on 2026-07-01?",
          conditionId: "cond-partial-home",
          clobTokenIds: "[\"home-yes\",\"home-no\"]",
          outcomes: "[\"Yes\",\"No\"]",
          sportsMarketType: "moneyline"
        }
      ]
    })).toString("base64");
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialState: partialState } } })}</script></html>`;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(html, { status: 200 }))
      .mockRejectedValueOnce(new Error("gamma down"));

    const markets = await fetchEventStrategyMarkets(eventSlug);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(markets).toEqual([
      expect.objectContaining({
        marketSlug: `${eventSlug}-home`,
        marketType: "moneyline"
      })
    ]);
  });

  test("extracts strategy markets from compressed Next flight data when NEXT_DATA is absent", async () => {
    const eventSlug = "fifwc-strong-weak-2026-06-23";
    const flightState = {
      events: {
        [eventSlug]: {
          slug: eventSlug,
          markets: [
            {
              eventSlug,
              slug: "total-2pt5",
              question: "Strong vs. Weak: O/U 2.5",
              conditionId: "cond-total",
              clobTokenIds: ["over", "under"],
              outcomes: ["Over", "Under"],
              sportsMarketType: "totals"
            },
            {
              eventSlug,
              slug: "weak-team-total-1pt5",
              question: "Strong vs. Weak: Weak O/U 1.5",
              conditionId: "cond-team-total",
              clobTokenIds: ["team-over", "team-under"],
              outcomes: ["Over", "Under"],
              sportsMarketType: "soccer_team_totals"
            },
            {
              eventSlug,
              slug: "btts",
              question: "Strong vs. Weak: Both Teams to Score",
              conditionId: "cond-btts",
              clobTokenIds: ["btts-yes", "btts-no"],
              outcomes: ["Yes", "No"],
              sportsMarketType: "both_teams_to_score"
            }
          ]
        }
      }
    };
    const encoded = deflateSync(JSON.stringify(flightState)).toString("base64url");
    const flight = `23:T${encoded.length.toString(16)},${encoded}\n`;
    const html = `<html><script>self.__next_f.push([1,${JSON.stringify(flight)}])</script></html>`;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(html, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ slug: eventSlug, markets: [] }), { status: 200, headers: { "content-type": "application/json" } }));

    const markets = await fetchEventStrategyMarkets(eventSlug);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markets).toContainEqual(expect.objectContaining({ marketSlug: "total-2pt5", marketType: "total", line: 2.5 }));
    expect(markets).toContainEqual(expect.objectContaining({ marketSlug: "weak-team-total-1pt5", marketType: "team_total", team: "Weak", line: 1.5 }));
    expect(markets).toContainEqual(expect.objectContaining({ marketSlug: "btts", marketType: "btts" }));
  });

  test("reassembles split Next flight chunks before decoding compressed market state", async () => {
    const eventSlug = "fifwc-strong-weak-2026-06-23";
    const flightState = {
      events: {
        [eventSlug]: {
          slug: eventSlug,
          markets: [
            {
              slug: "total-3pt5",
              question: "Strong vs. Weak: O/U 3.5",
              conditionId: "cond-total-3pt5",
              clobTokenIds: ["over-3pt5", "under-3pt5"],
              outcomes: ["Over", "Under"],
              sportsMarketType: "totals"
            }
          ]
        }
      }
    };
    const encoded = deflateSync(JSON.stringify(flightState)).toString("base64url");
    const tag = `23:T${encoded.length.toString(16)},`;
    const splitAt = Math.floor(encoded.length / 2);
    const html = [
      `<script>self.__next_f.push([1,${JSON.stringify(tag)}])</script>`,
      `<script>self.__next_f.push([1,${JSON.stringify(encoded.slice(0, splitAt))}])</script>`,
      `<script>self.__next_f.push([1,${JSON.stringify(`${encoded.slice(splitAt)}\n`)}])</script>`
    ].join("");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(html, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ slug: eventSlug, markets: [] }), { status: 200, headers: { "content-type": "application/json" } }));

    const markets = await fetchEventStrategyMarkets(eventSlug);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markets).toContainEqual(expect.objectContaining({ marketSlug: "total-3pt5", marketType: "total", line: 3.5 }));
  });

  test("parses spread line from question text", () => {
    expect(parseSpreadLine("Spread: Japan (-3.5)")).toBe(-3.5);
    expect(parseSpreadLine("Spread: Saudi Arabia (+3.5)")).toBe(3.5);
  });

  test("normalizes latest strategy markets beyond spreads", () => {
    const state = {
      markets: [
        {
          eventSlug: "fifwc-strong-weak-2026-06-23",
          slug: "weak-moneyline",
          question: "Will Weak win on 2026-06-23?",
          conditionId: "cond-weak",
          clobTokenIds: "[\"weak-yes\",\"weak-no\"]",
          outcomes: "[\"Yes\",\"No\"]"
        },
        {
          eventSlug: "fifwc-strong-weak-2026-06-23",
          slug: "total-2pt5",
          question: "Strong vs. Weak: O/U 2.5",
          conditionId: "cond-total",
          clobTokenIds: "[\"over\",\"under\"]",
          outcomes: "[\"Over\",\"Under\"]"
        },
        {
          eventSlug: "fifwc-strong-weak-2026-06-23",
          slug: "weak-team-total-1pt5",
          question: "Strong vs. Weak: Weak O/U 1.5",
          conditionId: "cond-team-total",
          clobTokenIds: "[\"team-over\",\"team-under\"]",
          outcomes: "[\"Over\",\"Under\"]"
        },
        {
          eventSlug: "fifwc-strong-weak-2026-06-23",
          slug: "btts",
          question: "Strong vs. Weak: Both Teams to Score",
          conditionId: "cond-btts",
          clobTokenIds: "[\"btts-yes\",\"btts-no\"]",
          outcomes: "[\"Yes\",\"No\"]"
        }
      ]
    };

    const markets = findStrategyMarkets(state, "fifwc-strong-weak-2026-06-23");

    expect(markets).toContainEqual(expect.objectContaining({ marketSlug: "weak-moneyline", marketType: "moneyline" }));
    expect(markets).toContainEqual(expect.objectContaining({ marketSlug: "total-2pt5", marketType: "total", line: 2.5 }));
    expect(markets).toContainEqual(expect.objectContaining({ marketSlug: "weak-team-total-1pt5", marketType: "team_total", team: "Weak", line: 1.5 }));
    expect(markets).toContainEqual(expect.objectContaining({ marketSlug: "btts", marketType: "btts" }));
  });

  test("classifies draw questions as draw even when the raw sports type is moneyline", () => {
    const markets = findStrategyMarkets({
      markets: [
        {
          eventSlug: "fifwc-eng-gha-2026-06-23",
          slug: "fifwc-eng-gha-2026-06-23-draw",
          question: "Will England vs. Ghana end in a draw?",
          conditionId: "cond-draw",
          clobTokenIds: "[\"draw-yes\",\"draw-no\"]",
          outcomes: "[\"Yes\",\"No\"]",
          sportsMarketType: "moneyline"
        }
      ]
    }, "fifwc-eng-gha-2026-06-23");

    expect(markets).toEqual([
      expect.objectContaining({
        marketSlug: "fifwc-eng-gha-2026-06-23-draw",
        marketType: "draw"
      })
    ]);
  });

  test("does not treat corners/cards prop markets as goal-total strategy markets", () => {
    const markets = findStrategyMarkets({
      markets: [
        {
          eventSlug: "fifwc-eng-gha-2026-06-23",
          slug: "fifwc-eng-gha-2026-06-23-corners-total-6pt5",
          question: "England vs. Ghana: O/U 6.5 Total Corners",
          conditionId: "cond-corners",
          clobTokenIds: "[\"over\",\"under\"]",
          outcomes: "[\"Over\",\"Under\"]"
        },
        {
          eventSlug: "fifwc-eng-gha-2026-06-23",
          slug: "fifwc-eng-gha-2026-06-23-cards-total-3pt5",
          question: "England vs. Ghana: O/U 3.5 Total Cards",
          conditionId: "cond-cards",
          clobTokenIds: "[\"cards-over\",\"cards-under\"]",
          outcomes: "[\"Over\",\"Under\"]"
        }
      ]
    }, "fifwc-eng-gha-2026-06-23");

    expect(markets).toEqual([]);
  });

  test("does not treat first-half period markets as full-match strategy markets", () => {
    const markets = findStrategyMarkets({
      markets: [
        {
          eventSlug: "fifwc-eng-gha-2026-06-23",
          slug: "fifwc-eng-gha-2026-06-23-first-half-team-total-home-1pt5",
          question: "England vs. Ghana: England 1st Half O/U 1.5",
          conditionId: "cond-first-half",
          clobTokenIds: "[\"over\",\"under\"]",
          outcomes: "[\"Over\",\"Under\"]"
        }
      ]
    }, "fifwc-eng-gha-2026-06-23");

    expect(markets).toEqual([]);
  });

  test("extracts live match state but does not derive tail remaining time from page fields", () => {
    const state = {
      games: {
        "fifwc-fra-irq-2026-06-22": {
          event: "fifwc-fra-irq-2026-06-22",
          live: true,
          ended: false,
          score: "3-1",
          period: "2H",
          elapsed: "90+3'",
          stoppageTime: "5'"
        }
      },
      events: {
        "fifwc-fra-irq-2026-06-22": {
          slug: "fifwc-fra-irq-2026-06-22",
          title: "France vs. Iraq"
        }
      }
    };

    expect(findMatchState(state, "fifwc-fra-irq-2026-06-22")).toEqual({
      eventSlug: "fifwc-fra-irq-2026-06-22",
      homeTeam: "France",
      awayTeam: "Iraq",
      homeGoals: 3,
      awayGoals: 1,
      minute: 93,
      period: "2H",
      isLive: true
    });
  });

  test("parses stoppage-time elapsed values into absolute minutes", () => {
    const state = {
      games: {
        "fifwc-fra-irq-2026-06-22": {
          event: "fifwc-fra-irq-2026-06-22",
          live: true,
          score: "1-0",
          period: "2H",
          elapsed: "90+4'"
        }
      },
      events: {
        "fifwc-fra-irq-2026-06-22": {
          title: "France vs. Iraq"
        }
      }
    };

    expect(findMatchState(state, "fifwc-fra-irq-2026-06-22")?.minute).toBe(94);
  });

  test("parses absolute expected-end values like 90+5 instead of treating them as five minutes", () => {
    const state = {
      games: {
        "fifwc-fra-irq-2026-06-22": {
          event: "fifwc-fra-irq-2026-06-22",
          live: true,
          score: "3-1",
          period: "2H",
          elapsed: "90+3'",
          expectedEndMinute: "90+5'"
        }
      },
      events: {
        "fifwc-fra-irq-2026-06-22": {
          title: "France vs. Iraq"
        }
      }
    };

    const match = findMatchState(state, "fifwc-fra-irq-2026-06-22");
    expect(match).toMatchObject({ minute: 93 });
    expect(match).not.toHaveProperty("expectedEndMinute");
    expect(match).not.toHaveProperty("remainingMinutes");
  });
});
