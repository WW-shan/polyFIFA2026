import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { OrderbookSnapshot, TradeResult } from "../../src/domain/types.js";
import { LiveLedger } from "../../src/persistence/ledger.js";
import { DEFAULT_TENNIS_TAIL_LADDER, type TennisTailMarket } from "../../src/execution/tennis-tail-orchestrator.js";
import {
  runTennisTailWatch,
  type TennisTailArmRecord,
  type TennisTailEvent,
  type TennisTailScoreObservation
} from "../../src/execution/tennis-tail-live.js";
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
  gameId: "6374886",
  markets: [market]
};

const score: TennisTailScoreObservation = {
  score: "6-3, 5-3",
  homeName: "Iga Swiatek",
  awayName: "Coco Gauff",
  observedAtMs: Date.parse("2026-10-04T12:00:00Z"),
  receivedAtMs: Date.parse("2026-10-04T12:00:00Z"),
  live: true,
  ended: false
};

const book: OrderbookSnapshot = {
  tokenId: "token-swiatek",
  bids: [{ price: 0.93, size: 500 }],
  asks: [{ price: 0.95, size: 500 }],
  tickSize: "0.01",
  negRisk: false
};

/** Favoured book plus the other outcome's book, keyed by token id. */
function bookFetcher(books: Record<string, OrderbookSnapshot>) {
  return async (tokenId: string): Promise<OrderbookSnapshot> => {
    const found = books[tokenId];
    if (!found) throw new Error(`no book for ${tokenId}`);
    return found;
  };
}

function opponentBook(bid: number): OrderbookSnapshot {
  return { tokenId: "token-gauff", bids: [{ price: bid, size: 500 }], asks: [{ price: bid + 0.01, size: 500 }], tickSize: "0.01" };
}

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
        latestScore: () => score,
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
        latestScore: () => score,
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
        latestScore: () => score,
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
        latestScore: () => ({ ...score, score: "6-3, 4-3" }),
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
        latestScore: () => score,
        fetchOrderbook: async () => book,
        placeLadder,
        ledger
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: false, intervalMs: 0, maxIterations: 1 }
    );

    // The seeded 0.90 level is already resting (budget 3.50, price memory), so
    // only the levels the ledger does not know about are added.
    expect(placeLadder.mock.calls[0]![0].map((level) => level.price)).toEqual([0.80, 0.85, 0.88, 0.92]);
  });
});

describe("runTennisTailWatch ladder parity", () => {
  test("re-sweeps and adds levels that only become restable later", async () => {
    const file = await ledgerFile();
    const ledger = new LiveLedger(file);
    const placeLadder = vi.fn(async (levels: readonly LiveRestingLevel[], _options?: unknown) => levels.map(posted));
    const books: Record<string, OrderbookSnapshot> = {
      "token-swiatek": { ...book, bids: [{ price: 0.90, size: 500 }] }, // 0.92 cannot rest yet
      "token-gauff": opponentBook(0.05)
    };
    const summary = await runTennisTailWatch(
      {
        discover: async () => [event],
        latestScore: () => score,
        fetchOrderbook: bookFetcher(books),
        placeLadder,
        ledger,
        sleep: async () => { books["token-swiatek"] = book; } // next poll the bid rises to 0.93
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: false, intervalMs: 0, maxIterations: 2 }
    );

    expect(placeLadder).toHaveBeenCalledTimes(2);
    expect(placeLadder.mock.calls[0]![0].map((level) => level.price)).toEqual([0.80, 0.85, 0.88, 0.90]);
    expect(placeLadder.mock.calls[1]![0].map((level) => level.price)).toEqual([0.92]);
    expect(summary.levelsPlaced).toBe(5);
  });

  test("keeps sweeping while a quiet book can still rest a higher level", async () => {
    const file = await ledgerFile();
    const ledger = new LiveLedger(file);
    const placeLadder = vi.fn(async (levels: readonly LiveRestingLevel[], _options?: unknown) => levels.map(posted));
    const books: Record<string, OrderbookSnapshot> = {
      "token-swiatek": { ...book, bids: [{ price: 0.90, size: 500 }], asks: [{ price: 0.95, size: 500 }] },
      "token-gauff": opponentBook(0.05)
    };
    let sleeps = 0;
    const summary = await runTennisTailWatch(
      {
        discover: async () => [event],
        latestScore: () => score,
        fetchOrderbook: bookFetcher(books),
        placeLadder,
        ledger,
        sleep: async () => {
          sleeps += 1;
          // The book sits unchanged for one poll, then the bid rises to 0.93.
          if (sleeps >= 2) books["token-swiatek"] = { ...book, bids: [{ price: 0.93, size: 500 }], asks: [{ price: 0.95, size: 500 }] };
        }
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: false, intervalMs: 0, maxIterations: 3 }
    );

    expect(placeLadder).toHaveBeenCalledTimes(2);
    expect(placeLadder.mock.calls[0]![0].map(level => level.price)).toEqual([0.80, 0.85, 0.88, 0.90]);
    expect(placeLadder.mock.calls[1]![0].map(level => level.price)).toEqual([0.92]);
    expect(summary.levelsPlaced).toBe(5);
  });

  test("does not re-place a level that is already resting in the ledger", async () => {
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
      orderId: "resting-092",
      price: 0.92,
      shares: 0,
      notional: 0,
      reservedNotional: 4.6
    });
    const placeLadder = vi.fn(async (levels: readonly LiveRestingLevel[], _options?: unknown) => levels.map(posted));

    await runTennisTailWatch(
      {
        discover: async () => [event],
        latestScore: () => score,
        fetchOrderbook: bookFetcher({ "token-swiatek": book, "token-gauff": opponentBook(0.05) }),
        placeLadder,
        ledger
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: false, intervalMs: 0, maxIterations: 1 }
    );

    expect(placeLadder).toHaveBeenCalledTimes(1);
    const placed = placeLadder.mock.calls[0]![0].map((level) => level.price);
    expect(placed).toEqual([0.80, 0.85, 0.88, 0.90]);
  });

  test("waits for the favoured token to hold the market's best bid", async () => {
    const placeLadder = vi.fn(async (levels: readonly LiveRestingLevel[], _options?: unknown) => levels.map(posted));
    const books: Record<string, OrderbookSnapshot> = {
      "token-swiatek": book,
      "token-gauff": opponentBook(0.97) // stale/inverted book: the other side is the market leader
    };
    const summary = await runTennisTailWatch(
      {
        discover: async () => [event],
        latestScore: () => score,
        fetchOrderbook: bookFetcher(books),
        placeLadder,
        sleep: async () => { books["token-gauff"] = opponentBook(0.05); }
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: false, intervalMs: 0, maxIterations: 2 }
    );

    expect(placeLadder).toHaveBeenCalledTimes(1);
    expect(summary.armed).toHaveLength(1);
    const skipped = summary.skipped;
    expect(skipped).toBeGreaterThanOrEqual(1);
  });

  test("reports a repeated skip once instead of every poll", async () => {
    const records: TennisTailArmRecord[] = [];
    const books: Record<string, OrderbookSnapshot> = {
      "token-swiatek": book,
      "token-gauff": opponentBook(0.97)
    };
    const summary = await runTennisTailWatch(
      {
        discover: async () => [event],
        latestScore: () => score,
        fetchOrderbook: bookFetcher(books),
        placeLadder: vi.fn(),
        onRecord: (record) => { records.push(record); }
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: true, intervalMs: 0, maxIterations: 3 }
    );

    expect(summary.skipped).toBe(3);
    expect(records.filter((record) => record.kind === "skipped")).toHaveLength(1);
  });

  test("retries a level the venue rejected", async () => {
    const file = await ledgerFile();
    const ledger = new LiveLedger(file);
    let call = 0;
    const placeLadder = vi.fn(async (levels: readonly LiveRestingLevel[], _options?: unknown) => {
      call += 1;
      return levels.map((level) => {
        if (level.price !== 0.88 || call !== 1) return posted(level);
        const { reservedNotional: _reservation, ...rest } = posted(level);
        return { ...rest, status: "rejected" as const };
      });
    });
    const summary = await runTennisTailWatch(
      {
        discover: async () => [event],
        latestScore: () => score,
        fetchOrderbook: bookFetcher({ "token-swiatek": book, "token-gauff": opponentBook(0.05) }),
        placeLadder,
        ledger
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: false, intervalMs: 0, maxIterations: 2 }
    );

    expect(placeLadder).toHaveBeenCalledTimes(2);
    expect(placeLadder.mock.calls[1]![0].map((level) => level.price)).toEqual([0.88]);
    expect(summary.levelsPlaced).toBe(6);
  });
});

describe("runTennisTailWatch timing", () => {
  test("keeps sweeping while a reconciliation is still in flight", async () => {
    const placeLadder = vi.fn(async (levels: readonly LiveRestingLevel[], _options?: unknown) => levels.map(posted));
    const summary = await runTennisTailWatch(
      {
        discover: async () => [event],
        latestScore: () => score,
        fetchOrderbook: bookFetcher({ "token-swiatek": book, "token-gauff": opponentBook(0.05) }),
        placeLadder,
        // A venue read that never settles must not block the signal path.
        reconcile: () => new Promise<void>(() => {})
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: false, intervalMs: 0, maxIterations: 1 }
    );

    expect(summary.iterations).toBe(1);
    expect(placeLadder).toHaveBeenCalledTimes(1);
  });

  test("records the signal age and book latency on every arm", async () => {
    const records: TennisTailArmRecord[] = [];
    let tick = score.observedAtMs;
    await runTennisTailWatch(
      {
        discover: async () => [event],
        latestScore: () => score,
        fetchOrderbook: bookFetcher({ "token-swiatek": book, "token-gauff": opponentBook(0.05) }),
        now: () => { tick += 250; return tick; },
        onRecord: (record) => { records.push(record); }
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: true, intervalMs: 0, maxIterations: 1 }
    );

    const armed = records.find((record) => record.kind === "armed");
    expect(armed?.timing).toBeDefined();
    expect(armed!.timing!.scoreObservedAtMs).toBe(score.observedAtMs);
    expect(armed!.timing!.signalAgeMs).toBeGreaterThanOrEqual(0);
    expect(armed!.timing!.orderbookMs).toBeGreaterThanOrEqual(0);
    expect(armed!.timing!.sweepMs).toBeGreaterThanOrEqual(0);
  });
});

describe("runTennisTailWatch shutdown", () => {
  test("finishes the current sweep and stops when asked", async () => {
    let stop = false;
    const summary = await runTennisTailWatch(
      {
        discover: async () => [event],
        latestScore: () => score,
        fetchOrderbook: async () => book,
        placeLadder: vi.fn(),
        shouldStop: () => stop,
        onRecord: (record) => { if (record.kind === "armed") stop = true; }
      },
      // No maxIterations: only shouldStop can end this run.
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: true, intervalMs: 0 }
    );

    expect(summary.iterations).toBe(1);
    expect(summary.armed).toHaveLength(1);
  });
});

describe("runTennisTailWatch score feed scheduling", () => {
  test("does not touch the book while the score is not Gen1", async () => {
    const fetched: string[] = [];
    const summary = await runTennisTailWatch(
      {
        discover: async () => [event],
        latestScore: () => ({ ...score, score: "6-3, 4-3" }),
        fetchOrderbook: async (tokenId) => { fetched.push(tokenId); return book; },
        placeLadder: vi.fn()
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: false, intervalMs: 0, maxIterations: 3 }
    );

    expect(summary.armed).toHaveLength(0);
    expect(fetched).toEqual([]);
  });

  test("sweeps the book as soon as a monitored score becomes Gen1", async () => {
    const fetched: string[] = [];
    let current: TennisTailScoreObservation = { ...score, score: "6-3, 4-3" };
    let version = 0;
    let waits = 0;
    const summary = await runTennisTailWatch(
      {
        discover: async () => [event],
        latestScore: () => current,
        scoreVersion: () => version,
        waitForScore: async () => {
          waits += 1;
          // Simulate the sports feed pushing the Gen1 score while the loop
          // waits on its 60s cadence.
          if (waits === 1) {
            current = { ...score, observedAtMs: score.observedAtMs + 5_000, receivedAtMs: score.observedAtMs + 5_000 };
            version += 1;
          }
        },
        fetchOrderbook: async (tokenId) => { fetched.push(tokenId); return book; },
        now: () => score.observedAtMs + 6_000,
        onRecord: () => undefined
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: true, intervalMs: 60_000, maxIterations: 3 }
    );

    expect(summary.armed).toHaveLength(1);
    expect(summary.armed[0]!.levels.map((level) => level.price)).toEqual([0.80, 0.85, 0.88, 0.90, 0.92]);
    expect(fetched).toContain("token-swiatek");
  });

  test("re-runs immediately when a score lands while the sweep is in flight", async () => {
    let version = 0;
    let current = score;
    const sleep = vi.fn(async (_ms: number) => undefined);
    const summary = await runTennisTailWatch(
      {
        discover: async () => [event],
        latestScore: () => current,
        scoreVersion: () => version,
        waitForScore: async () => undefined,
        sleep,
        fetchOrderbook: async () => {
          // The feed advances mid-sweep; the next iteration must not wait out
          // the 60s cadence.
          if (version === 0) {
            current = { ...score, score: "6-3, 5-4", observedAtMs: score.observedAtMs + 1_000,
              receivedAtMs: score.observedAtMs + 1_000 };
            version += 1;
          }
          return book;
        },
        placeLadder: vi.fn()
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: true, intervalMs: 60_000, maxIterations: 2 }
    );

    expect(summary.armed).toHaveLength(1);
    expect(summary.iterations).toBe(2);
    // Iteration 1 saw the mid-sweep bump and looped again without sleeping.
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("runTennisTailWatch multi-event isolation", () => {
  const secondMarket: TennisTailMarket = {
    eventSlug: "wta-andreeva-keys-2026-10-04",
    eventTitle: "Mirra Andreeva vs. Madison Keys",
    marketSlug: "wta-andreeva-keys-2026-10-04-moneyline",
    conditionId: "cond-ml-2",
    outcomes: ["Mirra Andreeva", "Madison Keys"],
    tokenIds: ["token-andreeva", "token-keys"],
    marketType: "moneyline",
    tickSize: "0.01",
    negRisk: false
  };
  const secondEvent: TennisTailEvent = {
    eventSlug: secondMarket.eventSlug,
    eventTitle: secondMarket.eventTitle,
    gameId: "6374748",
    markets: [secondMarket]
  };
  const secondScore: TennisTailScoreObservation = {
    ...score,
    homeName: "Mirra Andreeva",
    awayName: "Madison Keys"
  };
  const secondBook: OrderbookSnapshot = {
    tokenId: "token-andreeva",
    bids: [{ price: 0.94, size: 500 }],
    asks: [{ price: 0.96, size: 500 }],
    tickSize: "0.01",
    negRisk: false
  };
  const secondOpponentBook: OrderbookSnapshot = {
    tokenId: "token-keys",
    bids: [{ price: 0.04, size: 500 }],
    asks: [{ price: 0.06, size: 500 }],
    tickSize: "0.01"
  };

  test("arms two concurrent Gen1 events on their own tokens only", async () => {
    const file = await ledgerFile();
    const ledger = new LiveLedger(file);
    const placeLadder = vi.fn(async (levels: readonly LiveRestingLevel[], _options?: unknown) => levels.map(posted));
    const books: Record<string, OrderbookSnapshot> = {
      "token-swiatek": book,
      "token-gauff": opponentBook(0.05),
      "token-andreeva": secondBook,
      "token-keys": secondOpponentBook
    };

    const summary = await runTennisTailWatch(
      {
        discover: async () => [event, secondEvent],
        latestScore: (gameId) => (gameId === event.gameId ? score : secondScore),
        fetchOrderbook: bookFetcher(books),
        placeLadder,
        ledger
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: false, intervalMs: 0, maxIterations: 1 }
    );

    expect(summary.armed).toHaveLength(2);
    expect(placeLadder).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = placeLadder.mock.calls;
    expect(firstCall![0].every((level) => level.tokenId === "token-swiatek" && level.eventSlug === event.eventSlug)).toBe(true);
    expect(secondCall![0].every((level) => level.tokenId === "token-andreeva" && level.eventSlug === secondEvent.eventSlug)).toBe(true);

    const entries = await ledger.readEntries();
    expect(entries.filter((entry) => entry.eventSlug === event.eventSlug).every((entry) => entry.tokenId === "token-swiatek")).toBe(true);
    expect(entries.filter((entry) => entry.eventSlug === secondEvent.eventSlug).every((entry) => entry.tokenId === "token-andreeva")).toBe(true);
  });

  test("arms only the event whose own signal is Gen1", async () => {
    const fetched: string[] = [];
    const placeLadder = vi.fn(async (levels: readonly LiveRestingLevel[], _options?: unknown) => levels.map(posted));
    const books: Record<string, OrderbookSnapshot> = {
      "token-swiatek": book,
      "token-gauff": opponentBook(0.05),
      "token-andreeva": secondBook,
      "token-keys": secondOpponentBook
    };

    const summary = await runTennisTailWatch(
      {
        discover: async () => [event, secondEvent],
        latestScore: (gameId) => (gameId === event.gameId ? { ...score, score: "6-3, 4-3" } : secondScore),
        fetchOrderbook: async (tokenId) => { fetched.push(tokenId); return bookFetcher(books)(tokenId); },
        placeLadder
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: false, intervalMs: 0, maxIterations: 1 }
    );

    expect(summary.armed).toHaveLength(1);
    expect(summary.armed[0]!.eventSlug).toBe(secondEvent.eventSlug);
    expect(fetched).toContain("token-andreeva");
    expect(fetched).not.toContain("token-swiatek");
  });

  test("refuses to arm when a score names another event's players", async () => {
    const records: TennisTailArmRecord[] = [];
    const placeLadder = vi.fn(async (levels: readonly LiveRestingLevel[], _options?: unknown) => levels.map(posted));

    const summary = await runTennisTailWatch(
      {
        discover: async () => [secondEvent],
        // The event says Andreeva/Keys, but the score frame is the Swiatek/Gauff match.
        latestScore: () => score,
        fetchOrderbook: bookFetcher({ "token-andreeva": secondBook, "token-keys": secondOpponentBook }),
        placeLadder,
        onRecord: (record) => { records.push(record); }
      },
      { config: DEFAULT_TENNIS_TAIL_LADDER, dryRun: false, intervalMs: 0, maxIterations: 1 }
    );

    expect(summary.armed).toHaveLength(0);
    expect(placeLadder).not.toHaveBeenCalled();
    expect(records.some((record) => record.kind === "skipped" && record.details.includes("no outcome maps to the sports-feed favoured side"))).toBe(true);
  });

  test("heartbeat reports an event that never matched a sports game", async () => {
    const records: TennisTailArmRecord[] = [];
    await runTennisTailWatch(
      {
        discover: async () => [event, secondEvent],
        latestScore: (gameId) => (gameId === event.gameId ? score : undefined),
        fetchOrderbook: async () => book,
        onRecord: (record) => { records.push(record); }
      },
      {
        config: DEFAULT_TENNIS_TAIL_LADDER,
        dryRun: true,
        intervalMs: 0,
        maxIterations: 2,
        heartbeatEveryIterations: 2
      }
    );

    const heartbeat = records.find((record) => record.kind === "heartbeat")?.heartbeat;
    expect(heartbeat).toBeDefined();
    expect(heartbeat!.discovered).toBe(2);
    expect(heartbeat!.monitored).toBe(1);
    expect(heartbeat!.neverPolled).toEqual([secondEvent.eventSlug]);
  });
});
