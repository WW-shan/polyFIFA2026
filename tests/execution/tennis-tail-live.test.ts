import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { OrderbookSnapshot, TradeResult } from "../../src/domain/types.js";
import type { TennisEntrySignal, TennisPointFrame } from "../../src/collector/tennis-points.js";
import { LiveLedger } from "../../src/persistence/ledger.js";
import { DEFAULT_TENNIS_TAIL_LADDER, type TennisTailMarket } from "../../src/execution/tennis-tail-orchestrator.js";
import { runTennisTailWatch, type TennisTailArmRecord, type TennisTailEvent } from "../../src/execution/tennis-tail-live.js";
import type { LiveRestingLevel } from "../../src/execution/live-executor.js";

const market: TennisTailMarket = {
  eventSlug: "atp-swiatek-gauff-2026-10-04",
  eventTitle: "Iga Swiatek vs. Coco Gauff",
  marketSlug: "atp-swiatek-gauff-2026-10-04-moneyline",
  conditionId: "cond-ml",
  outcomes: ["Iga Swiatek", "Coco Gauff"],
  tokenIds: ["token-swiatek", "token-gauff"],
  marketType: "moneyline",
  tickSize: "0.01",
  negRisk: false
};

const event: TennisTailEvent = {
  eventSlug: market.eventSlug,
  eventTitle: market.eventTitle,
  markets: [market]
};

const frame: TennisPointFrame = {
  observedAtMs: Date.parse("2026-10-04T12:00:00Z"),
  scores365GameId: 1,
  startTime: null,
  statusText: null,
  statusGroup: null,
  competition: null,
  homeName: "Iga Swiatek",
  awayName: "Coco Gauff",
  setsWon: { home: 1, away: 0 },
  sets: [],
  setsToWin: 2,
  game: null
};

const gen1: TennisEntrySignal = {
  favored: "home",
  favoredSets: 1,
  trailerSets: 0,
  setsToWin: 2,
  oneSetFromMatch: true,
  setGames: { home: 5, away: 3 },
  lateSet: true,
  tiebreak: false,
  regularGame: true,
  favoriteLeadsSet: true,
  favoriteServing: true,
  serverLostPoints: 1,
  recentPointLoss: true,
  breakPointAgainstFavorite: false,
  candidate: false
};

const book: OrderbookSnapshot = {
  tokenId: "token-swiatek",
  bids: [{ price: 0.93, size: 500 }],
  asks: [{ price: 0.95, size: 500 }],
  tickSize: "0.01",
  negRisk: false
};

function posted(order: LiveRestingLevel): TradeResult {
  return {
    mode: "live",
    status: "posted",
    orderId: `order-${order.price}`,
    tokenId: order.tokenId,
    price: order.price,
    shares: 0,
    notional: 0,
    fee: 0,
    estimatedPayout: 0,
    estimatedProfit: 0,
    reservedNotional: order.notional,
    raw: { success: true }
  };
}

async function ledgerFile() {
  const dir = await mkdtemp(join(tmpdir(), "tennis-tail-live-"));
  return join(dir, "ledger.json");
}

describe("runTennisTailWatch", () => {
  test("dry-run arms the default ladder without submitting", async () => {
    const records: TennisTailArmRecord[] = [];
    const summary = await runTennisTailWatch(
      {
        discover: async () => [event],
        pollPoints: async () => [{ eventSlug: event.eventSlug, frame, signal: gen1 }],
        fetchOrderbook: async () => book,
        onRecord: (record) => { records.push(record); }
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: true, intervalMs: 0, maxIterations: 1 }
    );

    expect(summary.armed).toHaveLength(1);
    expect(summary.armed[0]!.levels.map((level) => level.price)).toEqual([0.80, 0.85, 0.88, 0.90, 0.92]);
    expect(records.some((record) => record.kind === "armed" && record.details === "dry-run")).toBe(true);
  });

  test("live submits one order per level and records them in the ledger", async () => {
    const file = await ledgerFile();
    const ledger = new LiveLedger(file);
    const placeLadder = vi.fn(async (levels: readonly LiveRestingLevel[], _options?: unknown) => levels.map(posted));

    const summary = await runTennisTailWatch(
      {
        discover: async () => [event],
        pollPoints: async () => [{ eventSlug: event.eventSlug, frame, signal: gen1 }],
        fetchOrderbook: async () => book,
        placeLadder,
        ledger
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: false, intervalMs: 0, maxIterations: 1 }
    );

    expect(summary.armed).toHaveLength(1);
    expect(placeLadder).toHaveBeenCalledTimes(1);
    expect(placeLadder.mock.calls[0]![0]).toHaveLength(5);
    expect(placeLadder.mock.calls[0]![1]).toMatchObject({ orderType: "GTC", postOnly: true });

    const entries = await ledger.readEntries();
    expect(entries).toHaveLength(5);
    expect(entries.every((entry) => entry.status === "posted")).toBe(true);
    expect(entries.map((entry) => entry.price)).toEqual([0.80, 0.85, 0.88, 0.90, 0.92]);
    expect(entries.every((entry) => entry.eventSlug === event.eventSlug)).toBe(true);
  });

  test("does not re-arm the same event on later polls", async () => {
    const placeLadder = vi.fn(async (levels: readonly LiveRestingLevel[], _options?: unknown) => levels.map(posted));
    const summary = await runTennisTailWatch(
      {
        discover: async () => [event],
        pollPoints: async () => [{ eventSlug: event.eventSlug, frame, signal: gen1 }],
        fetchOrderbook: async () => book,
        placeLadder
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: false, intervalMs: 0, maxIterations: 3 }
    );

    expect(summary.armed).toHaveLength(1);
    expect(placeLadder).toHaveBeenCalledTimes(1);
  });

  test("ignores frames that are not Gen1", async () => {
    const placeLadder = vi.fn();
    const summary = await runTennisTailWatch(
      {
        discover: async () => [event],
        pollPoints: async () => [{
          eventSlug: event.eventSlug,
          frame,
          signal: { ...gen1, lateSet: false }
        }],
        fetchOrderbook: async () => book,
        placeLadder
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: false, intervalMs: 0, maxIterations: 1 }
    );

    expect(summary.armed).toHaveLength(0);
    expect(summary.skipped).toBe(0);
    expect(placeLadder).not.toHaveBeenCalled();
  });

  test("subtracts notional already resting on the event", async () => {
    const file = await ledgerFile();
    const ledger = new LiveLedger(file);
    await ledger.recordTrade({
      timestamp: new Date().toISOString(),
      mode: "live",
      status: "posted",
      eventSlug: event.eventSlug,
      marketSlug: market.marketSlug,
      tokenId: "token-swiatek",
      conditionId: market.conditionId,
      outcome: "Iga Swiatek",
      orderId: "already-resting",
      price: 0.90,
      shares: 0,
      notional: 0,
      reservedNotional: 3.5
    });
    const placeLadder = vi.fn(async (levels: readonly LiveRestingLevel[], _options?: unknown) => levels.map(posted));

    await runTennisTailWatch(
      {
        discover: async () => [event],
        pollPoints: async () => [{ eventSlug: event.eventSlug, frame, signal: gen1 }],
        fetchOrderbook: async () => book,
        placeLadder,
        ledger
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: false, intervalMs: 0, maxIterations: 1 }
    );

    // 21.75 event cap - 3.50 already resting = 18.25, so the 0.92 level drops.
    expect(placeLadder.mock.calls[0]![0].map((level) => level.price)).toEqual([0.80, 0.85, 0.88, 0.90]);
  });
});
