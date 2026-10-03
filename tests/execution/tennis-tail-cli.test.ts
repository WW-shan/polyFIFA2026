import { describe, expect, test, vi } from "vitest";
import { cliOptions, discoverTennisTailEvents, tennisTailBalancePreflight } from "../../src/execution/tennis-tail-cli.js";
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

  test("defaults to ATP/WTA and honours --leagues all", () => {
    expect(cliOptions(new Map()).leagues).toEqual(["atp", "wta"]);
    expect(cliOptions(new Map([["leagues", "ATP, itf"]])).leagues).toEqual(["atp", "itf"]);
    expect(cliOptions(new Map([["leagues", "all"]])).leagues).toEqual([]);
  });

  test("rejects invalid ladders and order types", () => {
    expect(() => cliOptions(new Map([["ladder", "0.9,1.2"]]))).toThrow(/ladder/);
    expect(() => cliOptions(new Map([["order-type", "FAK"]]))).toThrow(/order-type/);
  });
});

describe("tennisTailBalancePreflight", () => {
  test("flags a deposit wallet that cannot afford the cheapest ladder level", async () => {
    const options = cliOptions(new Map<string, string | true>());
    const seen: string[] = [];
    const preflight = await tennisTailBalancePreflight(
      options,
      { POLY_DEPOSIT_WALLET_ADDRESS: "0xdeposit" },
      async (wallet) => { seen.push(wallet); return 3.5; }
    );
    expect(seen).toEqual(["0xdeposit"]);
    expect(preflight).toEqual({ wallet: "0xdeposit", pUSD: 3.5, minimumLevelCost: 4, sufficient: false });
  });

  test("passes when the balance covers the cheapest level and falls back to the funder", async () => {
    const options = cliOptions(new Map<string, string | true>([["ladder", "0.9,0.92"], ["shares-per-level", "5"]]));
    const preflight = await tennisTailBalancePreflight(options, { POLY_FUNDER_ADDRESS: "0xfunder" }, async () => 4.5);
    expect(preflight).toEqual({ wallet: "0xfunder", pUSD: 4.5, minimumLevelCost: 4.5, sufficient: true });
  });

  test("returns null when no wallet is configured", async () => {
    const options = cliOptions(new Map<string, string | true>());
    const preflight = await tennisTailBalancePreflight(options, {}, async () => {
      throw new Error("must not read without a wallet");
    });
    expect(preflight).toBeNull();
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

  test("excludes ITF by default and includes it when opted in", async () => {
    const itf = gammaEvent({
      id: "evt-itf",
      slug: "itf-palan1-chen9-2026-10-03",
      title: "M25 Yinchuan: Dominik Palan vs Kuan-Shou Chen",
      // A separate market identity, as Gamma always publishes for a new match.
      markets: [{
        ...gammaEvent().markets[0],
        id: "mkt-itf-ml",
        slug: "itf-palan1-chen9-2026-10-03-moneyline",
        conditionId: "cond-itf-ml",
        outcomes: JSON.stringify(["Dominik Palan", "Kuan-Shou Chen"]),
        clobTokenIds: JSON.stringify(["token-palan", "token-chen"])
      }]
    });
    expect((await discoverTennisTailEvents(deps([gammaEvent(), itf]))).map((event) => event.eventSlug))
      .toEqual(["atp-swiatek-gauff-2026-10-04"]);
    expect((await discoverTennisTailEvents(deps([gammaEvent(), itf]), ["atp", "wta", "itf"])).map((event) => event.eventSlug))
      .toEqual(["atp-swiatek-gauff-2026-10-04", "itf-palan1-chen9-2026-10-03"]);
  });

  test("keeps one event per match when Gamma lists the same match twice", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Same players, new conditionId: a relisted market would otherwise arm a
      // second ladder on the same point feed.
      const relisted = gammaEvent({
        id: "evt-relisted",
        slug: "atp-swiatek-gauff-2026-10-04-alt",
        markets: [{ ...gammaEvent().markets[0], id: "mkt-ml-2", slug: "atp-swiatek-gauff-2026-10-04-alt-moneyline", conditionId: "cond-ml-2" }]
      });
      const duplicateMarkets = await discoverTennisTailEvents(deps([gammaEvent(), relisted]));
      expect(duplicateMarkets.map((event) => event.eventSlug)).toEqual(["atp-swiatek-gauff-2026-10-04"]);

      // Same conditionId, new slug: the literal same market under two events.
      const copied = gammaEvent({ id: "evt-copy", slug: "atp-swiatek-gauff-2026-10-04-copy" });
      const duplicateConditions = await discoverTennisTailEvents(deps([gammaEvent(), copied]));
      expect(duplicateConditions.map((event) => event.eventSlug)).toEqual(["atp-swiatek-gauff-2026-10-04"]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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
