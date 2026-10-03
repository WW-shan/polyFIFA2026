import { describe, expect, test } from "vitest";
import { cliOptions, discoverTennisTailEvents } from "../../src/execution/tennis-tail-cli.js";
import type { CatalogDependencies } from "../../src/collector/catalog.js";

function gammaEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    slug: "atp-swiatek-gauff-2026-10-04",
    title: "Iga Swiatek vs. Coco Gauff",
    live: true,
    closed: false,
    sport: "tennis",
    tags: [{ slug: "tennis" }],
    markets: [
      {
        id: "mkt-ml",
        slug: "atp-swiatek-gauff-2026-10-04-moneyline",
        conditionId: "cond-ml",
        question: "Iga Swiatek vs. Coco Gauff",
        outcomes: JSON.stringify(["Iga Swiatek", "Coco Gauff"]),
        clobTokenIds: JSON.stringify(["token-swiatek", "token-gauff"]),
        closed: false,
        sportsMarketType: "moneyline",
        orderPriceMinTickSize: 0.01,
        negRisk: false
      },
      {
        id: "mkt-handicap",
        slug: "atp-swiatek-gauff-2026-10-04-handicap",
        conditionId: "cond-handicap",
        question: "Game handicap",
        outcomes: JSON.stringify(["Swiatek -3.5", "Gauff +3.5"]),
        clobTokenIds: JSON.stringify(["token-a", "token-b"]),
        closed: false,
        sportsMarketType: "tennis_game_handicap"
      }
    ],
    ...overrides
  };
}

function deps(events: unknown[]): CatalogDependencies {
  return {
    request: async () => events
  };
}

describe("cliOptions", () => {
  test("dry-run is the default and --live flips it", () => {
    expect(cliOptions(new Map()).dryRun).toBe(true);
    expect(cliOptions(new Map([["live", "true"]])).dryRun).toBe(false);
    expect(cliOptions(new Map([["dry-run", "true"], ["live", "true"]])).dryRun).toBe(true);
  });

  test("parses ladder, sizing and exposure flags", () => {
    const options = cliOptions(new Map<string, string | true>([
      ["ladder", "0.7,0.8,0.9"],
      ["shares-per-level", "10"],
      ["max-per-event", "25"],
      ["max-per-day", "200"],
      ["order-type", "gtd"],
      ["interval-ms", "5000"]
    ]));
    expect(options.config).toMatchObject({
      prices: [0.7, 0.8, 0.9],
      sharesPerLevel: 10,
      maxNotionalPerEvent: 25,
      maxNotionalPerDay: 200
    });
    expect(options.orderType).toBe("GTD");
    expect(options.intervalMs).toBe(5000);
  });

  test("rejects invalid ladders and order types", () => {
    expect(() => cliOptions(new Map([["ladder", "0.9,1.2"]]))).toThrow(/ladder/);
    expect(() => cliOptions(new Map([["order-type", "FAK"]]))).toThrow(/order-type/);
  });
});

describe("discoverTennisTailEvents", () => {
  test("keeps only the moneyline market of a live singles tennis event", async () => {
    const events = await discoverTennisTailEvents(deps([gammaEvent()]));
    expect(events).toHaveLength(1);
    expect(events[0]!.markets).toHaveLength(1);
    expect(events[0]!.markets[0]).toMatchObject({
      eventSlug: "atp-swiatek-gauff-2026-10-04",
      marketSlug: "atp-swiatek-gauff-2026-10-04-moneyline",
      conditionId: "cond-ml",
      marketType: "moneyline",
      tickSize: "0.01"
    });
  });

  test("drops doubles and events without a moneyline market", async () => {
    const doubles = gammaEvent({
      id: "evt-2",
      slug: "atp-doubles-2026-10-04",
      title: "A./B. vs C./D."
    });
    const noMoneyline = gammaEvent({
      id: "evt-3",
      slug: "atp-no-ml-2026-10-04",
      markets: [gammaEvent().markets[1]]
    });
    const events = await discoverTennisTailEvents(deps([gammaEvent(), doubles, noMoneyline]));
    expect(events.map((event) => event.eventSlug)).toEqual(["atp-swiatek-gauff-2026-10-04"]);
  });
});
