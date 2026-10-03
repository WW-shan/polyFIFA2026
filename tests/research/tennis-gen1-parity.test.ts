import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { OrderbookSnapshot, TradeResult } from "../../src/domain/types.js";
import type { LiveRestingLevel } from "../../src/execution/live-executor.js";
import { runTennisTailWatch, type TennisTailEvent } from "../../src/execution/tennis-tail-live.js";
import { tennisGen1 } from "../../src/domain/tennis-gen1.js";
import {
  DEFAULT_TENNIS_TAIL_LADDER,
  planTennisTailFromScore,
  resolveTennisTailToken,
  type TennisTailMarket
} from "../../src/execution/tennis-tail-orchestrator.js";
import {
  replayTennisGen1Orders,
  type ReplayBookSnapshot,
  type ReplaySportsFrame,
  type ReplayTokenSeries,
  type TennisGen1Fixture
} from "../../scripts/research/tennis-gen1-backtest.js";

const fixture = JSON.parse(readFileSync(
  new URL("../fixtures/tennis-gen1/game-6374478.json", import.meta.url), "utf8"
)) as TennisGen1Fixture;

function latestAtOrBefore<T extends { tMs: number }>(rows: readonly T[], atMs: number): T | undefined {
  let found: T | undefined;
  for (const row of rows) {
    if (row.tMs > atMs) break;
    found = row;
  }
  return found;
}

function orderbookFromSnapshot(tokenId: string, snapshot: ReplayBookSnapshot): OrderbookSnapshot {
  return {
    tokenId,
    bids: snapshot.bid !== null ? [{ price: snapshot.bid, size: 500 }] : [],
    asks: snapshot.ask !== null ? [{ price: snapshot.ask, size: 500 }] : [],
    tickSize: "0.01",
    negRisk: false,
    minimumOrderSize: 5
  };
}

/** Live-path replay: one sweep per archived snapshot, driven by the score feed. */
function replayLiveEntries(input: {
  market: TennisTailMarket;
  tokens: readonly (ReplayTokenSeries & { tokenId: string; outcome: string })[];
  sports: readonly ReplaySportsFrame[];
  setsToWin: number;
}): Array<{ tokenId: string; price: number; tMs: number }> {
  const placed = new Map<string, number[]>();
  const entries: Array<{ tokenId: string; price: number; tMs: number }> = [];
  const times = [...new Set(input.tokens.flatMap((token) => token.snapshots.map((snapshot) => snapshot.tMs)))]
    .sort((a, b) => a - b);
  for (const tMs of times) {
    const scored = latestAtOrBefore(input.sports, tMs);
    if (!scored || !scored.homeName || !scored.awayName) continue;
    const decision = tennisGen1(scored.score, input.setsToWin);
    if (!decision) continue;
    const resolved = resolveTennisTailToken(input.market, {
      homeName: scored.homeName, awayName: scored.awayName
    }, decision.side);
    if (!resolved) continue;
    const token = input.tokens.find((candidate) => candidate.tokenId === resolved.tokenId);
    const snapshot = token?.snapshots.find((candidate) => candidate.tMs === tMs);
    if (!token || !snapshot) continue;
    const other = input.tokens.find((candidate) => candidate.tokenId !== token.tokenId);
    const otherSnapshot = other ? latestAtOrBefore(other.snapshots, tMs) : undefined;
    const plan = planTennisTailFromScore({
      market: input.market,
      score: scored.score,
      setsToWin: input.setsToWin,
      homeName: scored.homeName,
      awayName: scored.awayName,
      orderbook: orderbookFromSnapshot(token.tokenId, snapshot),
      config: DEFAULT_TENNIS_TAIL_LADDER,
      alreadyPlacedPrices: placed.get(token.tokenId) ?? [],
      ...(otherSnapshot?.bid !== undefined && otherSnapshot.bid !== null ? { otherBestBid: otherSnapshot.bid } : {})
    });
    if (plan.action !== "ARM") continue;
    for (const level of plan.plan.levels) entries.push({ tokenId: token.tokenId, price: level.price, tMs });
    placed.set(token.tokenId, [
      ...(placed.get(token.tokenId) ?? []),
      ...plan.plan.levels.map((level) => Number(level.price.toFixed(6)))
    ]);
  }
  return entries;
}

describe("tennis Gen1 replay parity", () => {
  test("the production watcher places the same ladder at the same archived snapshots", async () => {
    const event: TennisTailEvent = {
      eventSlug: fixture.market.eventSlug,
      eventTitle: fixture.market.eventTitle,
      gameId: fixture.gameId,
      setsToWin: fixture.setsToWin,
      markets: [fixture.market]
    };
    const snapshotTimes = [...new Set(fixture.tokens.flatMap((token) => token.snapshots.map((snapshot) => snapshot.tMs)))]
      .sort((a, b) => a - b);
    let clock = snapshotTimes[0]!;
    let nextSnapshot = 1;
    const placements: Array<{ tokenId: string; price: number; tMs: number }> = [];
    const placeLadder = async (levels: readonly LiveRestingLevel[]): Promise<TradeResult[]> => {
      for (const level of levels) placements.push({ tokenId: level.tokenId, price: level.price, tMs: clock });
      return levels.map((level, index) => ({
        mode: "live" as const,
        status: "posted" as const,
        orderId: `parity-${index}`,
        tokenId: level.tokenId,
        price: level.price,
        shares: level.shares,
        notional: level.notional,
        fee: 0,
        estimatedPayout: level.shares,
        estimatedProfit: level.shares - level.notional,
        reservedNotional: level.notional
      }));
    };
    const latestSports = () => latestAtOrBefore(fixture.sports, clock);
    const latestSnapshot = (tokenId: string) => {
      const token = fixture.tokens.find((candidate) => candidate.tokenId === tokenId);
      return token ? latestAtOrBefore(token.snapshots, clock) : undefined;
    };

    const summary = await runTennisTailWatch(
      {
        discover: async () => [event],
        latestScore: () => {
          const frame = latestSports();
          return frame && frame.homeName && frame.awayName ? {
            score: frame.score,
            homeName: frame.homeName,
            awayName: frame.awayName,
            observedAtMs: frame.tMs,
            receivedAtMs: frame.tMs,
            live: true,
            ended: false
          } : undefined;
        },
        fetchOrderbook: async (tokenId) => {
          const snapshot = latestSnapshot(tokenId);
          return snapshot
            ? orderbookFromSnapshot(tokenId, snapshot)
            : { tokenId, bids: [], asks: [], tickSize: "0.01", negRisk: false, minimumOrderSize: 5 };
        },
        placeLadder,
        sleep: async () => {
          if (nextSnapshot < snapshotTimes.length) clock = snapshotTimes[nextSnapshot++]!;
        }
      },
      {
        config: DEFAULT_TENNIS_TAIL_LADDER,
        dryRun: false,
        intervalMs: 0,
        discoveryIntervalMs: Number.MAX_SAFE_INTEGER,
        reconcileEveryIterations: Number.MAX_SAFE_INTEGER,
        heartbeatEveryIterations: 0,
        maxIterations: snapshotTimes.length + 1
      }
    );

    const expected = fixture.expectedOrders
      .map((order) => ({ tokenId: order.tokenKey, price: order.price, tMs: order.entryAtMs }))
      .sort((a, b) => a.tMs - b.tMs || a.price - b.price);
    const actual = placements.sort((a, b) => a.tMs - b.tMs || a.price - b.price);
    expect(actual).toEqual(expected);
    expect(summary.armed).toHaveLength(3);
    expect(summary.levelsPlaced).toBe(5);
    expect(summary.errors).toBe(0);
  });

  test("the archived per-price replay matches the frozen fixture entries", () => {
    const replayed = replayTennisGen1Orders(fixture.sports, fixture.tokens, {
      prices: fixture.prices,
      setsToWin: fixture.setsToWin,
      marketLeaderGuard: true,
      ...(fixture.finishedAtMs !== null ? { finishAtMs: fixture.finishedAtMs } : {})
    });
    expect(replayed).toEqual(fixture.expectedOrders);
  });

  test("the live decision path arms every price at the same snapshot as the backtest", () => {
    const market: TennisTailMarket = { ...fixture.market };
    const reference = fixture.expectedOrders
      .map((order) => ({ tokenId: order.tokenKey, price: order.price, tMs: order.entryAtMs }))
      .sort((a, b) => a.tMs - b.tMs || a.price - b.price);
    const live = replayLiveEntries({
      market,
      tokens: fixture.tokens.map((token) => ({ ...token, tokenKey: token.tokenId })),
      sports: fixture.sports,
      setsToWin: fixture.setsToWin
    }).sort((a, b) => a.tMs - b.tMs || a.price - b.price);
    expect(live).toEqual(reference);
  });

  test("the frozen fixture keeps the staged ladder timing", () => {
    // 0.80/0.85 arm on the first qualifying snapshot, 0.88/0.90 ten seconds of
    // feed time later, and 0.92 once the bid finally reaches it.
    const byPrice = new Map(fixture.expectedOrders.map((order) => [order.price, order]));
    expect(byPrice.get(0.80)!.entryAtMs).toBe(byPrice.get(0.85)!.entryAtMs);
    expect(byPrice.get(0.88)!.entryAtMs).toBe(byPrice.get(0.90)!.entryAtMs);
    expect(byPrice.get(0.92)!.entryAtMs).toBeGreaterThan(byPrice.get(0.90)!.entryAtMs);
    for (const order of fixture.expectedOrders) {
      expect(order.marketLeaderBlocks).toBe(0);
      expect(order.entryScore).toBe("4-6, 6-4, 5-3");
      expect(order.entryKind).toBe("game");
    }
  });

  test("a deciding-set 6-6 tiebreak names no side in either path", () => {
    const sports: ReplaySportsFrame[] = [
      { tMs: 1_000, score: "6-3, 3-6, 6-6", homeName: "A Player", awayName: "B Player" }
    ];
    const snapshots: ReplayBookSnapshot[] = [{ tMs: 2_000, bid: 0.95, ask: 0.97 }];
    const tokens: ReplayTokenSeries[] = [
      { tokenKey: "a", side: "home", snapshots, otherTokenKey: "b" },
      { tokenKey: "b", side: "away", snapshots, otherTokenKey: "a" }
    ];
    expect(replayTennisGen1Orders(sports, tokens, { prices: [0.90], setsToWin: 2 })).toEqual([]);

    const market: TennisTailMarket = {
      eventSlug: "synthetic",
      eventTitle: "A Player vs. B Player",
      marketSlug: "synthetic-moneyline",
      conditionId: "synthetic",
      outcomes: ["A Player", "B Player"],
      tokenIds: ["a", "b"],
      marketType: "moneyline",
      tickSize: "0.01"
    };
    expect(planTennisTailFromScore({
      market,
      score: "6-3, 3-6, 6-6",
      setsToWin: 2,
      homeName: "A Player",
      awayName: "B Player",
      orderbook: orderbookFromSnapshot("a", snapshots[0]!),
      config: DEFAULT_TENNIS_TAIL_LADDER
    })).toMatchObject({ action: "SKIP", reason: "NOT_GEN1" });
  });
});
