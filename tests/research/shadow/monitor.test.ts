import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { createRunState, runLateGameShadow, shadowTick, type ShadowMonitorDeps, type ShadowMonitorOptions } from "../../../src/research/shadow/monitor.js";
import { parseLateScoreModel, type LateScoreModel } from "../../../src/research/shadow/model.js";
import { selectMoneyline, SHADOW_LEAGUES, type MarketBook, type ShadowMarketRef } from "../../../src/research/shadow/market.js";
import type { CollectorEvent } from "../../../src/collector/types.js";
import type { EspnGame } from "../../../src/research/shadow/espn.js";

const fixture = JSON.parse(readFileSync(resolve("tests/fixtures/shadow/late-score-model.json"), "utf8")) as Record<string, unknown>;

function modelWith(probability: number): LateScoreModel {
  const intercept = Math.log(probability / (1 - probability));
  return parseLateScoreModel({ ...fixture, coefficients: [intercept, 0, 0, 0, 0, 0], mean: [0, 0, 0, 0, 0], scale: [1, 1, 1, 1, 1], selfTest: [] });
}

const market: ShadowMarketRef = selectMoneyline({
  eventId: "123", eventSlug: "nfl-phi-chi-2026-09-29", title: "Eagles vs. Bears", tags: [], sport: "nfl", gameId: null, parentEventId: null,
  markets: [{ marketId: "2", conditionId: "0xmoney", marketSlug: "nfl-phi-chi-2026-09-29", question: "Eagles vs. Bears",
    outcomes: ["Eagles", "Bears"], tokenIds: ["AWAY", "HOME"], closed: false, collectable: true, raw: { sportsMarketType: "moneyline" } }],
  raw: { startTime: "2026-09-29T00:15:00Z" }
} as CollectorEvent, "nfl")!;

function espnGame(state: "pre" | "in" | "post", overrides: Partial<EspnGame> = {}): EspnGame {
  const status = state === "pre"
    ? { state, completed: false, period: 0, clock: "0:00", clockSeconds: 0, detail: "Scheduled" }
    : state === "in"
      ? { state, completed: false, period: 4, clock: "0:45", clockSeconds: 45, detail: "4th Quarter" }
      : { state, completed: true, period: 4, clock: "0:00", clockSeconds: 0, detail: "Final" };
  return {
    espnId: "401872963", startMs: Date.parse("2026-09-29T00:15:00Z"), name: "Eagles at Bears",
    status: status as EspnGame["status"],
    home: { id: "3", homeAway: "home", displayName: "Chicago Bears", names: ["chicagobears", "bears", "chi"] },
    away: { id: "21", homeAway: "away", displayName: "Philadelphia Eagles", names: ["philadelphiaeagles", "eagles", "phi"] },
    homeScore: state === "pre" ? 0 : 27, awayScore: state === "pre" ? 0 : 20,
    winner: state === "post" ? "home" : null,
    ...overrides
  };
}

function book(tokenId: string, ask: number, size = 50, timestampMs = 1_700_000_000_000): MarketBook {
  const started = timestampMs - 250;
  return {
    tokenId, requestStartedAtMs: started, receivedAtMs: timestampMs + 500, bookTimestampMs: timestampMs,
    book: { tokenId, bids: [{ price: ask - 0.02, size: 100 }], asks: [{ price: ask, size }] }
  };
}

interface Harness {
  options: ShadowMonitorOptions;
  deps: ShadowMonitorDeps;
  records: Array<Record<string, unknown>>;
  clock: { ms: number };
  scoreboards: Map<string, EspnGame[]>;
  books: Map<string, MarketBook[]>;
}

function harness(probability = 0.95, overrides: Partial<ShadowMonitorOptions> = {}): Harness {
  const clock = { ms: Date.parse("2026-09-29T01:00:00Z") };
  const records: Array<Record<string, unknown>> = [];
  const scoreboards = new Map<string, EspnGame[]>();
  const books = new Map<string, MarketBook[]>();
  const options: ShadowMonitorOptions = {
    league: SHADOW_LEAGUES.nfl!, model: modelWith(probability), shadowOnly: true,
    pollIntervalMs: 5_000, idlePollIntervalMs: 30_000, discoveryIntervalMs: 60_000, recordWindowSeconds: 900,
    windowSeconds: 180, minProbability: 0.9, minEdge: 0.03, limitOffset: 0.01, maxPrice: 0.99, shares: 5,
    delaySeconds: 30, followupWindowSeconds: 60, followupStepSeconds: 15, heartbeatIntervalMs: 60_000,
    lookbackHours: 6, aheadHours: 24,
    ...overrides
  };
  const deps: ShadowMonitorDeps = {
    now: () => clock.ms,
    discoverMarkets: async () => [market],
    fetchScoreboard: async (_league, date) => scoreboards.get(date) ?? [],
    fetchSummary: async () => { throw new Error("summary should not be fetched in these tests"); },
    fetchBook: async tokenId => {
      const next = books.get(tokenId)?.shift();
      return next ?? book(tokenId, tokenId === "HOME" ? 0.92 : 0.35);
    },
    sink: record => { records.push(record as unknown as Record<string, unknown>); },
    log: () => {}
  };
  return { options, deps, records, clock, scoreboards, books };
}

function kinds(records: Array<Record<string, unknown>>): string[] {
  return records.map(record => String(record.kind));
}

function today(): string {
  return "20260928";
}

describe("shadowTick", () => {
  test("links the Gamma market to the ESPN game and records a non-signal state", async () => {
    const h = harness();
    const state = createRunState(h.clock.ms);
    h.scoreboards.set(today(), [espnGame("in")]);
    h.books.set("HOME", [book("HOME", 0.9)]);
    h.books.set("AWAY", [book("AWAY", 0.35)]);
    h.deps.fetchSummary = async () => ({ status: { state: "in", completed: false, period: 4, clock: "0:52", clockSeconds: 52, detail: "4th Quarter" },
      homeScore: 27, awayScore: 20, winner: null,
      lastPlay: { wallclockMs: h.clock.ms - 12_000, period: 4, clock: "0:52", clockSeconds: 52, homeScore: 27, awayScore: 20 } });
    await shadowTick(state, h.options, h.deps);
    expect(kinds(h.records)).toContain("discovery");
    expect(kinds(h.records)).toContain("game-linked");
    expect(kinds(h.records)).toContain("state");
    const linked = h.records.find(record => record.kind === "game-linked")!;
    expect(linked.espnId).toBe("401872963");
    expect(linked.homeToken).toBe("HOME");
    const signal = h.records.find(record => record.kind === "signal");
    expect(signal).toBeDefined();
    expect(signal!.side).toBe("home");
    expect(signal!.limitPrice).toBeCloseTo(0.94, 9);
    expect(signal!.edge).toBeCloseTo(0.05, 9);
    const fill = signal!.fill as Record<string, unknown>;
    expect(fill.filledShares).toBe(5);
    expect(fill.averagePrice).toBeCloseTo(0.9, 9);
    const summary = signal!.espnSummary as Record<string, unknown>;
    expect(summary.lastPlayAgeMs).toBe(12_000);
    expect(summary.clockDeltaSeconds).toBe(7);
  });

  test("does not fire twice for the same game and side", async () => {
    const h = harness();
    const state = createRunState(h.clock.ms);
    h.scoreboards.set(today(), [espnGame("in")]);
    h.books.set("HOME", [book("HOME", 0.9), book("HOME", 0.9)]);
    h.books.set("AWAY", [book("AWAY", 0.35), book("AWAY", 0.35)]);
    await shadowTick(state, h.options, h.deps);
    h.clock.ms += 5_000;
    await shadowTick(state, h.options, h.deps);
    expect(kinds(h.records).filter(kind => kind === "signal")).toHaveLength(1);
  });

  test("records the delayed fill checks used by the walk-forward rule", async () => {
    const h = harness();
    const state = createRunState(h.clock.ms);
    h.scoreboards.set(today(), [espnGame("in")]);
    h.books.set("HOME", [book("HOME", 0.9)]);
    h.books.set("AWAY", [book("AWAY", 0.35)]);
    await shadowTick(state, h.options, h.deps);
    for (const delay of [31_000, 16_000, 46_000]) {
      h.clock.ms += delay;
      h.books.set("HOME", [book("HOME", 0.92)]);
      await shadowTick(state, h.options, h.deps);
    }
    const checks = h.records.filter(record => record.kind === "fill-check");
    expect(checks.map(check => check.elapsedMs)).toEqual([31_000, 47_000, 93_000, 93_000, 93_000]);
    expect(checks.at(-1)!.limitPrice).toBeCloseTo(0.94, 9);
    expect((checks.at(-1)!.fill as Record<string, unknown>).averagePrice).toBeCloseTo(0.92, 9);
  });

  test("settles every signal against the final score", async () => {
    const h = harness();
    const state = createRunState(h.clock.ms);
    h.scoreboards.set(today(), [espnGame("in")]);
    h.books.set("HOME", [book("HOME", 0.9)]);
    h.books.set("AWAY", [book("AWAY", 0.35)]);
    await shadowTick(state, h.options, h.deps);
    h.clock.ms += 120_000;
    h.scoreboards.set(today(), [espnGame("post")]);
    await shadowTick(state, h.options, h.deps);
    const settlement = h.records.find(record => record.kind === "settlement")!;
    expect((settlement.final as Record<string, unknown>).winner).toBe("home");
    const signal = (settlement.signals as Array<Record<string, unknown>>)[0]!;
    expect(signal.won).toBe(true);
    expect(signal.netReturn).toBeCloseTo((1 - 0.9 - 0.05 * 0.9 * 0.1) / 0.9, 9);
  });

  test("shares one scoreboard request across games in the same tick", async () => {
    const h = harness();
    const state = createRunState(h.clock.ms);
    const second = { ...market, eventId: "456", eventSlug: "nfl-lac-buf-2026-09-27", eventTitle: "Chargers vs. Bills", startMs: Date.parse("2026-09-27T17:00:00Z"),
      marketSlug: "nfl-lac-buf-2026-09-27", conditionId: "0xsecond",
      outcomes: ["Chargers", "Bills"] as [string, string], tokens: ["LAC", "BUF"] as [string, string] };
    h.deps.discoverMarkets = async () => [market, second];
    const espnCalls: string[] = [];
    h.deps.fetchScoreboard = async (_league, date) => {
      espnCalls.push(date);
      if (date === "20260927") {
        return [espnGame("in", { espnId: "401872953", name: "Chargers at Bills", startMs: Date.parse("2026-09-27T17:00:00Z"),
          home: { id: "2", homeAway: "home", displayName: "Buffalo Bills", names: ["buffalobills", "bills", "buf"] },
          away: { id: "24", homeAway: "away", displayName: "Los Angeles Chargers", names: ["losangeleschargers", "chargers", "lac"] } })];
      }
      return [espnGame("in")];
    };
    await shadowTick(state, h.options, h.deps);
    expect(state.tracked.size).toBe(2);
    expect(new Set(espnCalls).size).toBe(espnCalls.length);
    expect(espnCalls).toEqual(["20260928", "20260927"]);
    expect(kinds(h.records).filter(kind => kind === "game-linked")).toHaveLength(2);
  });

  test("keeps running and reports discovery failures", async () => {
    const h = harness();
    h.deps.discoverMarkets = async () => { throw new Error("gamma exploded"); };
    const state = createRunState(h.clock.ms);
    const result = await shadowTick(state, h.options, h.deps);
    expect(kinds(h.records)).toContain("error");
    expect(h.records.find(record => record.kind === "error")!.message).toContain("gamma exploded");
    expect(result.activeGames).toBe(0);
    expect(result.nextDelayMs).toBeGreaterThan(0);
  });

  test("does not repeat an unlinked-game error on every poll", async () => {
    const h = harness();
    const state = createRunState(h.clock.ms);
    h.scoreboards.set(today(), []);
    await shadowTick(state, h.options, h.deps);
    h.clock.ms += 30_000;
    await shadowTick(state, h.options, h.deps);
    const errors = h.records.filter(record => record.kind === "error" && record.scope === "espn-match");
    expect(errors).toHaveLength(1);
  });

  test("records a heartbeat outside the final window without signalling", async () => {
    const h = harness();
    const state = createRunState(h.clock.ms);
    h.scoreboards.set(today(), [espnGame("in", { status: { state: "in", completed: false, period: 3, clock: "5:00", clockSeconds: 300, detail: "3rd Quarter" } })]);
    await shadowTick(state, h.options, h.deps);
    const stateRecord = h.records.find(record => record.kind === "state")!;
    expect(stateRecord.decision).toMatchObject({ fire: false, reason: "outside-window" });
    expect(stateRecord.books).toBeUndefined();
    expect(kinds(h.records)).not.toContain("signal");
  });
});

describe("runLateGameShadow", () => {
  test("writes a run-start and run-end record and stops after the iteration cap", async () => {
    const h = harness();
    let sleeps = 0;
    const summary = await runLateGameShadow({ ...h.options, maxIterations: 2 }, { ...h.deps, sleep: async () => { sleeps += 1; } });
    expect(summary.iterations).toBe(2);
    expect(sleeps).toBe(1);
    expect(kinds(h.records)[0]).toBe("run-start");
    expect(kinds(h.records).at(-1)).toBe("run-end");
  });

  test("refuses to run without the shadowOnly flag", async () => {
    const h = harness();
    await expect(runLateGameShadow({ ...h.options, shadowOnly: false }, h.deps)).rejects.toThrow(/SHADOW_ONLY_REQUIRED/);
  });
});
