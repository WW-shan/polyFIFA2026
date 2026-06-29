import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import { netReturnRate } from "../../src/domain/fees.js";
import type { MatchState, OrderbookSnapshot, PriceLevel, StrategyMarket, TradeResult } from "../../src/domain/types.js";
import { LiveExecutionError, LiveExecutor, liveConfigFromEnv, type LiveOrderRequest } from "../../src/execution/live-executor.js";

const MIN_RETURN = 0.005;
const MIN_NOTIONAL = 1;
const BALANCE_BUFFER = 5;
const EPSILON = 1e-8;

describe("two-match full live chain stress coverage", () => {
  test("drives simultaneous locked and tail matches through depth ranking, refresh, and live order posting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-two-match-live-chain-stress-"));

    for (const [caseIndex, spec] of stressCases().entries()) {
      const fixture = fixtureFor(caseIndex);
      const marketsFile = join(dir, `markets-${caseIndex}.json`);
      const ledgerFile = join(dir, `ledger-${caseIndex}.json`);
      const postedOrders: RecordedOrder[] = [];
      const decisions: RecordedDecision[] = [];
      const clockCalls: string[] = [];
      const executionCounts = new Map<string, number>();
      const tokenPostCounts = new Map<string, number>();
      const latestMatches = new Map<string, MatchState>();
      let balance = spec.initialBalance;
      let refreshPhase = false;

      await writeFile(marketsFile, JSON.stringify(marketsFor(fixture)));

      const executor = new LiveExecutor(liveConfigFromEnv(liveEnv()), async () => ({
        placeLimitBuy: async (order) => {
          const orderNumber = (tokenPostCounts.get(order.tokenId) ?? 0) + 1;
          tokenPostCounts.set(order.tokenId, orderNumber);
          postedOrders.push({ ...order, caseName: spec.name, orderNumber, balanceBefore: balance });

          expect(order.orderType, spec.name).toBe("FAK");
          expect(order.notional, `${spec.name} ${order.tokenId}`).toBeGreaterThanOrEqual(MIN_NOTIONAL - EPSILON);
          expect(netReturnRate(order.price), `${spec.name} ${order.tokenId}`).toBeGreaterThanOrEqual(MIN_RETURN - EPSILON);
          if (order.tokenId === fixture.lockedOverToken) {
            expect(order.price, spec.name).toBeGreaterThanOrEqual(0.9);
          }

          if (spec.rejectTailTeamPost && order.tokenId === fixture.tailTeamUnderToken) {
            throw new LiveExecutionError("LIVE_ORDER_REJECTED", "stress CLOB rejection", { raw: { tokenId: order.tokenId } });
          }
          if (spec.postLockedFirst && order.tokenId === fixture.lockedOverToken && orderNumber === 1) {
            return postedResult(order, `posted-${caseIndex}-${orderNumber}`);
          }
          return filledResult(order, `filled-${caseIndex}-${order.tokenId}-${orderNumber}`);
        }
      }));

      const result = await runCli([
        "--mode", "live",
        "--watch", "true",
        "--worldcup", "true",
        "--markets-file", marketsFile,
        "--ledger-file", ledgerFile,
        "--order-type", "FAK",
        "--balance-buffer", String(BALANCE_BUFFER),
        "--interval-ms", "0",
        "--max-iterations", "8"
      ], liveEnv(), {
        fetchWorldCupEventRefs: async () => [
          { eventSlug: fixture.lockedSlug, homeTeam: "Locked", awayTeam: "Opponent" },
          { eventSlug: fixture.tailSlug, homeTeam: "Tail", awayTeam: "Opponent" }
        ],
        watchSportsUpdates: async () => trackUpdates(updatesFor(fixture, spec, postedOrders), latestMatches),
        fetchMatchState: async (eventSlug) => latestMatches.get(eventSlug) ?? initialMatchFor(eventSlug, fixture),
        fetchVerifiedClock: async (match) => {
          clockCalls.push(match.eventSlug);
          if (match.eventSlug !== fixture.tailSlug) return null;
          return {
            minute: 90,
            elapsedSeconds: 90 * 60,
            remainingSeconds: 120,
            remainingSecondsSource: "365scores_added_time_precise_game_time"
          };
        },
        readPusdBalance: async () => balance,
        fetchOrderbook: async (tokenId) => orderbookFor(tokenId, fixture, spec, executionCounts, refreshPhase),
        executeLive: async (decision, options) => {
          decisions.push({
            eventSlug: decision.eventSlug,
            tokenId: decision.tokenId,
            locked: decision.locked === true,
            strategy: decision.strategy,
            legCount: decision.legs?.length ?? 1,
            legTokens: decision.legs?.map((leg) => leg.tokenId) ?? [decision.tokenId],
            legPrices: decision.legs?.map((leg) => leg.price) ?? [decision.bestAsk],
            notional: decision.notional,
            tailWindowSource: decision.tailWindowSource
          });

          refreshPhase = true;
          try {
            const trade = await executor.execute(decision, options);
            if (trade.status === "filled" || trade.status === "partial") {
              balance = round(balance - trade.notional, 8);
            }
            return trade;
          } finally {
            refreshPhase = false;
            executionCounts.set(decision.eventSlug, (executionCounts.get(decision.eventSlug) ?? 0) + 1);
          }
        }
      });

      expect(result.exitCode, `${spec.name}: ${result.stderr}\n${result.stdout}`).toBe(0);

      const lockedOrders = postedOrders.filter((order) => order.tokenId === fixture.lockedOverToken);
      const tailOrders = postedOrders.filter((order) => order.tokenId === fixture.tailTotalUnderToken || order.tokenId === fixture.tailTeamUnderToken);
      expect(lockedOrders.length, `${spec.name} locked posts`).toBe(spec.expectedLockedPosts);
      expect(tailOrders.length, `${spec.name} tail posts`).toBe(spec.expectedTailPosts);
      expect(clockCalls, `${spec.name} clock calls`).not.toContain(fixture.lockedSlug);
      expect(clockCalls, `${spec.name} clock calls`).toContain(fixture.tailSlug);

      const tailDecision = decisions.find((decision) => decision.eventSlug === fixture.tailSlug);
      expect(tailDecision, `${spec.name} tail decision`).toBeDefined();
      expect(tailDecision?.locked, spec.name).toBe(false);
      expect(tailDecision?.tailWindowSource, spec.name).toBe("remaining_seconds");
      expect(new Set(tailDecision?.legTokens).size, `${spec.name} tail leg tokens`).toBeGreaterThanOrEqual(2);
      expect(tailDecision?.legCount, `${spec.name} tail leg count`).toBeGreaterThanOrEqual(2);
      expect(tailDecision?.legPrices, `${spec.name} tail ranked prices`).toEqual([...tailDecision!.legPrices].sort((a, b) => a - b));

      for (const order of tailOrders) {
        expect(order.notional, `${spec.name} ${order.tokenId} balance`).toBeLessThanOrEqual(order.balanceBefore - BALANCE_BUFFER + EPSILON);
      }
      if (spec.assertTailCappedByBalance) {
        const tailNotional = tailOrders.reduce((total, order) => total + order.notional, 0);
        const lockedFilledNotional = lockedOrders
          .filter((order) => !spec.postLockedFirst)
          .reduce((total, order) => total + order.notional, 0);
        expect(tailNotional, `${spec.name} tail balance cap`).toBeLessThanOrEqual(spec.initialBalance - lockedFilledNotional - BALANCE_BUFFER + EPSILON);
      }

      const ledger = JSON.parse(await readFile(ledgerFile, "utf8")) as Array<Record<string, unknown>>;
      expect(ledger.map((entry) => [eventRole(entry.eventSlug, fixture), entry.status]), spec.name).toEqual(spec.expectedLedger);
    }
  }, 30_000);
});

interface StressFixture {
  lockedSlug: string;
  tailSlug: string;
  lockedOverToken: string;
  tailTotalUnderToken: string;
  tailTeamUnderToken: string;
}

interface StressCase {
  name: string;
  initialBalance: number;
  lockedStages: LockedStage[];
  postLockedFirst?: boolean;
  rejectTailTeamPost?: boolean;
  expectedLockedPosts: number;
  expectedTailPosts: number;
  expectedLedger: Array<[string, string]>;
  assertTailCappedByBalance?: boolean;
}

interface LockedStage {
  decisionAsks: PriceLevel[];
  refreshAsks: PriceLevel[];
}

interface RecordedOrder extends LiveOrderRequest {
  caseName: string;
  orderNumber: number;
  balanceBefore: number;
}

interface RecordedDecision {
  eventSlug: string;
  tokenId: string;
  locked: boolean;
  strategy: string | undefined;
  legCount: number;
  legTokens: string[];
  legPrices: number[];
  notional: number;
  tailWindowSource: string | undefined;
}

function stressCases(): StressCase[] {
  return [
    {
      name: "locked refill plus tail multi-leg fills",
      initialBalance: 40,
      lockedStages: [
        stage([{ price: 0.98, size: 3 }], [{ price: 0.981, size: 3 }]),
        stage([{ price: 0.972, size: 2.5 }], [{ price: 0.973, size: 2.5 }]),
        stopStage()
      ],
      expectedLockedPosts: 2,
      expectedTailPosts: 2,
      expectedLedger: [
        ["LOCKED", "filled"],
        ["LOCKED", "filled"],
        ["TAIL", "filled"]
      ]
    },
    {
      name: "stale locked refresh then tail partial after CLOB rejection",
      initialBalance: 35,
      lockedStages: [
        stage([{ price: 0.98, size: 5 }], [{ price: 0.996, size: 5 }]),
        stopStage()
      ],
      rejectTailTeamPost: true,
      expectedLockedPosts: 0,
      expectedTailPosts: 2,
      expectedLedger: [
        ["LOCKED", "rejected"],
        ["TAIL", "partial"]
      ]
    },
    {
      name: "posted locked order completes without refill and tail still fills",
      initialBalance: 30,
      lockedStages: [
        stage([{ price: 0.97, size: 4 }], [{ price: 0.971, size: 4 }]),
        stage([{ price: 0.96, size: 4 }], [{ price: 0.961, size: 4 }])
      ],
      postLockedFirst: true,
      expectedLockedPosts: 1,
      expectedTailPosts: 2,
      expectedLedger: [
        ["LOCKED", "posted"],
        ["TAIL", "filled"]
      ]
    },
    {
      name: "balance buffer caps tail after locked refill spends first",
      initialBalance: 14.2,
      lockedStages: [
        stage([{ price: 0.98, size: 3 }], [{ price: 0.981, size: 3 }]),
        stage([{ price: 0.974, size: 2 }], [{ price: 0.975, size: 2 }]),
        stopStage()
      ],
      expectedLockedPosts: 2,
      expectedTailPosts: 2,
      expectedLedger: [
        ["LOCKED", "filled"],
        ["LOCKED", "filled"],
        ["TAIL", "filled"]
      ],
      assertTailCappedByBalance: true
    }
  ];
}

function fixtureFor(caseIndex: number): StressFixture {
  const suffix = `${caseIndex}-2026-06-28`;
  return {
    lockedSlug: `fifwc-chain-locked-${suffix}`,
    tailSlug: `fifwc-chain-tail-${suffix}`,
    lockedOverToken: `chain-locked-over-${caseIndex}`,
    tailTotalUnderToken: `chain-tail-total-under-${caseIndex}`,
    tailTeamUnderToken: `chain-tail-team-under-${caseIndex}`
  };
}

function marketsFor(fixture: StressFixture): StrategyMarket[] {
  return [
    {
      eventSlug: fixture.lockedSlug,
      marketSlug: `${fixture.lockedSlug}-total-0pt5`,
      question: "Locked vs. Opponent: O/U 0.5",
      conditionId: `cond-${fixture.lockedSlug}-total`,
      outcomes: ["Over", "Under"],
      clobTokenIds: [fixture.lockedOverToken, `${fixture.lockedOverToken}-under`],
      line: 0.5,
      marketType: "total"
    },
    {
      eventSlug: fixture.tailSlug,
      marketSlug: `${fixture.tailSlug}-total-4pt5`,
      question: "Tail vs. Opponent: O/U 4.5",
      conditionId: `cond-${fixture.tailSlug}-total`,
      outcomes: ["Over", "Under"],
      clobTokenIds: [`${fixture.tailTotalUnderToken}-over`, fixture.tailTotalUnderToken],
      line: 4.5,
      marketType: "total"
    },
    {
      eventSlug: fixture.tailSlug,
      marketSlug: `${fixture.tailSlug}-opponent-team-total-2pt5`,
      question: "Tail vs. Opponent: Opponent O/U 2.5",
      conditionId: `cond-${fixture.tailSlug}-team-total`,
      outcomes: ["Over", "Under"],
      clobTokenIds: [`${fixture.tailTeamUnderToken}-over`, fixture.tailTeamUnderToken],
      line: 2.5,
      marketType: "team_total",
      team: "Opponent"
    }
  ];
}

async function* updatesFor(
  fixture: StressFixture,
  spec: StressCase,
  postedOrders: readonly RecordedOrder[]
): AsyncIterable<MatchState> {
  yield {
    eventSlug: fixture.lockedSlug,
    homeTeam: "Locked",
    awayTeam: "Opponent",
    homeGoals: 1,
    awayGoals: 0,
    minute: 60,
    period: "2H",
    isLive: true,
    elapsedSeconds: 60 * 60
  };

  if (spec.expectedLockedPosts > 1) {
    await waitUntil(() => postedOrders.filter((order) => order.tokenId === fixture.lockedOverToken).length >= spec.expectedLockedPosts, 50);
  } else {
    await delay(2);
  }

  yield {
    eventSlug: fixture.tailSlug,
    homeTeam: "Tail",
    awayTeam: "Opponent",
    homeGoals: 2,
    awayGoals: 0,
    minute: 60,
    period: "2H",
    isLive: true,
    elapsedSeconds: 60 * 60
  };
  yield {
    eventSlug: fixture.tailSlug,
    homeTeam: "Tail",
    awayTeam: "Opponent",
    homeGoals: 2,
    awayGoals: 0,
    minute: 90,
    period: "2H",
    isLive: true,
    elapsedSeconds: 90 * 60
  };
}

async function* trackUpdates(
  updates: AsyncIterable<MatchState>,
  latestMatches: Map<string, MatchState>
): AsyncIterable<MatchState> {
  for await (const update of updates) {
    latestMatches.set(update.eventSlug, update);
    yield update;
  }
}

function initialMatchFor(eventSlug: string, fixture: StressFixture): MatchState {
  if (eventSlug === fixture.lockedSlug) {
    return {
      eventSlug,
      homeTeam: "Locked",
      awayTeam: "Opponent",
      homeGoals: 1,
      awayGoals: 0,
      minute: 60,
      period: "2H",
      isLive: true,
      elapsedSeconds: 60 * 60
    };
  }
  return {
    eventSlug,
    homeTeam: "Tail",
    awayTeam: "Opponent",
    homeGoals: 2,
    awayGoals: 0,
    minute: 60,
    period: "2H",
    isLive: true,
    elapsedSeconds: 60 * 60
  };
}

function orderbookFor(
  tokenId: string,
  fixture: StressFixture,
  spec: StressCase,
  executionCounts: ReadonlyMap<string, number>,
  refreshPhase: boolean
): OrderbookSnapshot {
  if (tokenId === fixture.lockedOverToken) {
    const stageIndex = Math.min(executionCounts.get(fixture.lockedSlug) ?? 0, spec.lockedStages.length - 1);
    const lockedStage = spec.lockedStages[stageIndex] ?? stopStage();
    return book(tokenId, refreshPhase ? lockedStage.refreshAsks : lockedStage.decisionAsks);
  }
  if (tokenId === fixture.tailTeamUnderToken) {
    return book(tokenId, refreshPhase
      ? [{ price: 0.956, size: 3 }]
      : [{ price: 0.955, size: 3 }]);
  }
  if (tokenId === fixture.tailTotalUnderToken) {
    return book(tokenId, refreshPhase
      ? [{ price: 0.966, size: 2 }, { price: 0.983, size: 10 }]
      : [{ price: 0.965, size: 2 }, { price: 0.982, size: 10 }]);
  }
  return book(tokenId, []);
}

function stage(decisionAsks: PriceLevel[], refreshAsks: PriceLevel[]): LockedStage {
  return { decisionAsks, refreshAsks };
}

function stopStage(): LockedStage {
  return stage([{ price: 0.996, size: 100 }], [{ price: 0.996, size: 100 }]);
}

function book(tokenId: string, asks: PriceLevel[]): OrderbookSnapshot {
  return { tokenId, bids: [], asks };
}

function eventRole(eventSlug: unknown, fixture: StressFixture): string {
  if (eventSlug === fixture.lockedSlug) return "LOCKED";
  if (eventSlug === fixture.tailSlug) return "TAIL";
  return String(eventSlug);
}

function filledResult(order: LiveOrderRequest, orderId: string): TradeResult {
  return {
    mode: "live",
    status: "filled",
    orderId,
    tokenId: order.tokenId,
    price: order.price,
    shares: order.size,
    notional: order.notional,
    fee: order.estimatedFee,
    estimatedPayout: order.size,
    estimatedProfit: order.size - order.notional - order.estimatedFee
  };
}

function postedResult(order: LiveOrderRequest, orderId: string): TradeResult {
  return {
    mode: "live",
    status: "posted",
    orderId,
    tokenId: order.tokenId,
    price: order.price,
    shares: 0,
    notional: 0,
    fee: 0,
    estimatedPayout: 0,
    estimatedProfit: 0
  };
}

function liveEnv(): Record<string, string> {
  return {
    POLY_PRIVATE_KEY: "0xabc",
    POLY_API_KEY: "key",
    POLY_API_SECRET: "secret",
    POLY_PASSPHRASE: "passphrase",
    POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(1);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}
