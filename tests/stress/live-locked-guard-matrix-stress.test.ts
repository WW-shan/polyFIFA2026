import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import { netReturnRate } from "../../src/domain/fees.js";
import type { MatchState, OrderbookSnapshot, PriceLevel, StrategyMarket, TradeResult } from "../../src/domain/types.js";
import type { Scores365GoalSignal } from "../../src/polymarket/scores365-clock.js";
import { LiveExecutor, liveConfigFromEnv, type LiveOrderRequest } from "../../src/execution/live-executor.js";

const MIN_RETURN = 0.005;
const EPSILON = 1e-8;

describe("live locked guard matrix stress coverage", () => {
  test("exercises locked goal guard outcomes through live watch and LiveExecutor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-live-locked-guard-matrix-"));

    for (const [index, spec] of guardCases().entries()) {
      const eventSlug = `fifwc-guard-matrix-${index}-2026-07-05`;
      const overToken = `${eventSlug}-total-over`;
      const teamOverToken = `${eventSlug}-team-over`;
      const marketsFile = join(dir, `${index}-markets.json`);
      const ledgerFile = join(dir, `${index}-ledger.json`);
      const postedOrders: LiveOrderRequest[] = [];
      const calls = new Map<string, number>();
      const executor = liveExecutor(postedOrders);

      await writeFile(marketsFile, JSON.stringify(marketsFor(eventSlug, overToken, teamOverToken, spec.includeRelatedMarket === true)));

      const result = await runCli([
        "--mode", "live",
        "--watch", "true",
        "--worldcup", "true",
        "--markets-file", marketsFile,
        "--ledger-file", ledgerFile,
        "--order-type", "FAK",
        "--balance-buffer", "5",
        "--interval-ms", "0",
        "--max-iterations", spec.preUpdate === false ? "1" : "2"
      ], liveEnv(), {
        fetchWorldCupEventRefs: async () => [{ eventSlug, homeTeam: "Matrix", awayTeam: "Opponent" }],
        watchSportsUpdates: async () => scoreUpdates(eventSlug, spec.preUpdate !== false),
        fetchVerifiedClock: fetchVerifiedClockFor(spec),
        ...(spec.signalMode !== "score-only" && spec.signalMode !== "none"
          ? { fetchLockedGoalSignal: async (match: MatchState): Promise<Scores365GoalSignal | null> => signalFor(spec, match) }
          : {}),
        readPusdBalance: async () => 100,
        fetchOrderbook: async (tokenId) => orderbookFor(tokenId, {
          spec,
          overToken,
          teamOverToken,
          calls
        }),
        executeLive: async (decision, options) => executor.execute(decision, options)
      });

      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(result.exitCode, `${spec.name}: ${result.stderr}\n${result.stdout}`).toBe(0);
      expect(postedOrders.length, `${spec.name} posted order count`).toBe(spec.expectedPostedOrders);
      expect(lastStatus(parsed), spec.name).toBe(spec.expectedLastStatus);
      if (spec.expectedDetails) {
        expect(lastDetails(parsed), spec.name).toContain(spec.expectedDetails);
      }
      for (const order of postedOrders) {
        expect(order.price, `${spec.name} order floor`).toBeGreaterThanOrEqual(0.85);
        expect(netReturnRate(order.price), `${spec.name} return floor`).toBeGreaterThanOrEqual(MIN_RETURN - EPSILON);
      }
      if (spec.expectedOrderPrice !== undefined) {
        expect(postedOrders[0]?.price, spec.name).toBeCloseTo(spec.expectedOrderPrice, 8);
      }
      if (spec.expectedMaxNotional !== undefined) {
        const notional = postedOrders.reduce((total, order) => total + order.notional, 0);
        expect(notional, spec.name).toBeLessThanOrEqual(spec.expectedMaxNotional + EPSILON);
      }
    }
  }, 30_000);

  test("keeps simultaneous locked incidents isolated by event and token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "poly-live-locked-guard-two-match-"));
    const goodSlug = "fifwc-guard-good-2026-07-05";
    const blockedSlug = "fifwc-guard-blocked-2026-07-05";
    const goodToken = `${goodSlug}-total-over`;
    const blockedToken = `${blockedSlug}-total-over`;
    const marketsFile = join(dir, "markets.json");
    const ledgerFile = join(dir, "ledger.json");
    const postedOrders: LiveOrderRequest[] = [];
    const calls = new Map<string, number>();
    const executor = liveExecutor(postedOrders);

    await writeFile(marketsFile, JSON.stringify([
      ...marketsFor(goodSlug, goodToken, `${goodSlug}-team-over`, false),
      ...marketsFor(blockedSlug, blockedToken, `${blockedSlug}-team-over`, false)
    ]));

    const result = await runCli([
      "--mode", "live",
      "--watch", "true",
      "--worldcup", "true",
      "--markets-file", marketsFile,
      "--ledger-file", ledgerFile,
      "--order-type", "FAK",
      "--balance-buffer", "5",
      "--interval-ms", "0",
      "--max-iterations", "4"
    ], liveEnv(), {
      fetchWorldCupEventRefs: async () => [
        { eventSlug: goodSlug, homeTeam: "Matrix", awayTeam: "Opponent" },
        { eventSlug: blockedSlug, homeTeam: "Matrix", awayTeam: "Opponent" }
      ],
      watchSportsUpdates: async () => twoMatchUpdates(goodSlug, blockedSlug),
      fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
      fetchLockedGoalSignal: async (match) => {
        if (match.eventSlug === blockedSlug) {
          return signalFor({ name: "blocked", signalMode: "no-goal" }, match);
        }
        return signalFor({ name: "good", signalMode: "confirmed" }, match);
      },
      readPusdBalance: async () => 100,
      fetchOrderbook: async (tokenId) => {
        const call = calls.get(tokenId) ?? 0;
        calls.set(tokenId, call + 1);
        return book(tokenId, [{ price: 0.95, size: 100 }]);
      },
      executeLive: async (decision, options) => executor.execute(decision, options)
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(postedOrders.map((order) => order.tokenId)).toEqual([goodToken]);
    expect(postedOrders).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ tokenId: blockedToken })
    ]));
  }, 10_000);
});

type SignalMode = "confirmed" | "score-only" | "none" | "conflict" | "no-goal" | "var" | "post-regulation";
type ExpectedLastStatus = "filled" | "no_trade" | "rejected";
type StageName = "pre" | "post" | "verify" | "refresh";

interface GuardCase {
  name: string;
  signalMode: SignalMode;
  plan: StagePlan;
  expectedLastStatus: ExpectedLastStatus;
  expectedPostedOrders: number;
  expectedDetails?: string;
  expectedOrderPrice?: number;
  expectedMaxNotional?: number;
  preUpdate?: boolean;
  includeRelatedMarket?: boolean;
  relatedPlan?: StagePlan;
}

interface StagePlan {
  pre: PriceLevel[];
  post: PriceLevel[];
  verify: PriceLevel[];
  refresh: PriceLevel[];
  throwOn?: StageName[];
}

function guardCases(): GuardCase[] {
  return [
    {
      name: "confirmed 365 goal buys stable 0.90 stale liquidity",
      signalMode: "confirmed",
      plan: stablePlan(0.9),
      expectedLastStatus: "filled",
      expectedPostedOrders: 1,
      expectedOrderPrice: 0.9,
      expectedMaxNotional: 20
    },
    {
      name: "score-only 365 fallback buys stable 0.95 liquidity",
      signalMode: "score-only",
      plan: stablePlan(0.95),
      expectedLastStatus: "filled",
      expectedPostedOrders: 1,
      expectedOrderPrice: 0.95,
      expectedMaxNotional: 20
    },
    {
      name: "no 365 signal buys only high-price stable 0.99 market fallback",
      signalMode: "none",
      plan: stablePlan(0.99),
      expectedLastStatus: "filled",
      expectedPostedOrders: 1,
      expectedOrderPrice: 0.99,
      expectedMaxNotional: 20
    },
    {
      name: "no 365 signal buys high-price new stable post-goal liquidity",
      signalMode: "none",
      plan: {
        pre: [],
        post: [{ price: 0.99, size: 20 / 0.99 }],
        verify: [{ price: 0.99, size: 20 / 0.99 }],
        refresh: [{ price: 0.99, size: 20 / 0.99 }]
      },
      expectedLastStatus: "filled",
      expectedPostedOrders: 1,
      expectedOrderPrice: 0.99,
      expectedMaxNotional: 20
    },
    {
      name: "no 365 signal buys stable 0.97 liquidity above locked floor",
      signalMode: "none",
      plan: stablePlan(0.97),
      expectedLastStatus: "filled",
      expectedPostedOrders: 1,
      expectedOrderPrice: 0.97,
      expectedMaxNotional: 20
    },
    {
      name: "no 365 signal skips without pre-goal S0 cache",
      signalMode: "none",
      plan: stablePlan(0.99),
      preUpdate: false,
      expectedLastStatus: "no_trade",
      expectedPostedOrders: 0,
      expectedDetails: "no pre-goal orderbook cache"
    },
    {
      name: "365 score conflict hard-blocks",
      signalMode: "conflict",
      plan: stablePlan(0.95),
      expectedLastStatus: "no_trade",
      expectedPostedOrders: 0,
      expectedDetails: "disagrees"
    },
    {
      name: "365 no-goal hard-blocks",
      signalMode: "no-goal",
      plan: stablePlan(0.95),
      expectedLastStatus: "no_trade",
      expectedPostedOrders: 0,
      expectedDetails: "No Goal"
    },
    {
      name: "365 VAR review hard-blocks",
      signalMode: "var",
      plan: stablePlan(0.95),
      expectedLastStatus: "no_trade",
      expectedPostedOrders: 0,
      expectedDetails: "VAR"
    },
    {
      name: "365 post-regulation goal hard-blocks",
      signalMode: "post-regulation",
      plan: stablePlan(0.95),
      expectedLastStatus: "no_trade",
      expectedPostedOrders: 0,
      expectedDetails: "post-regulation"
    },
    {
      name: "sub-floor ask in S1 blocks before execution",
      signalMode: "confirmed",
      plan: {
        pre: [{ price: 0.99, size: 100 }],
        post: [{ price: 0.84, size: 10 }, { price: 0.99, size: 100 }],
        verify: [{ price: 0.99, size: 100 }],
        refresh: [{ price: 0.99, size: 100 }]
      },
      expectedLastStatus: "no_trade",
      expectedPostedOrders: 0,
      expectedDetails: "below locked floor"
    },
    {
      name: "sub-floor ask in S2 blocks before execution",
      signalMode: "confirmed",
      plan: {
        pre: [{ price: 0.99, size: 100 }],
        post: [{ price: 0.99, size: 100 }],
        verify: [{ price: 0.84, size: 10 }, { price: 0.99, size: 100 }],
        refresh: [{ price: 0.99, size: 100 }]
      },
      expectedLastStatus: "no_trade",
      expectedPostedOrders: 0,
      expectedDetails: "below locked floor"
    },
    {
      name: "best ask retrace blocks before execution",
      signalMode: "confirmed",
      plan: {
        pre: [{ price: 0.99, size: 100 }],
        post: [{ price: 0.99, size: 100 }],
        verify: [{ price: 0.95, size: 100 }],
        refresh: [{ price: 0.95, size: 100 }]
      },
      expectedLastStatus: "no_trade",
      expectedPostedOrders: 0,
      expectedDetails: "best ask retraced"
    },
    {
      name: "confirmed high-price new cheap liquidity in S1 and S2 can buy",
      signalMode: "confirmed",
      plan: {
        pre: [{ price: 0.99, size: 2 / 0.99 }],
        post: [{ price: 0.99, size: 20 / 0.99 }],
        verify: [{ price: 0.99, size: 20 / 0.99 }],
        refresh: [{ price: 0.99, size: 20 / 0.99 }]
      },
      expectedLastStatus: "filled",
      expectedPostedOrders: 1,
      expectedOrderPrice: 0.99,
      expectedMaxNotional: 20
    },
    {
      name: "tiny stable liquidity below minimum notional blocks",
      signalMode: "confirmed",
      plan: {
        pre: [{ price: 0.99, size: 0.4 / 0.99 }],
        post: [{ price: 0.99, size: 0.4 / 0.99 }],
        verify: [{ price: 0.99, size: 0.4 / 0.99 }],
        refresh: [{ price: 0.99, size: 0.4 / 0.99 }]
      },
      expectedLastStatus: "no_trade",
      expectedPostedOrders: 0,
      expectedDetails: "Available notional"
    },
    {
      name: "execution refresh sub-floor rejects stale plan without posting",
      signalMode: "confirmed",
      plan: {
        pre: [{ price: 0.99, size: 100 }],
        post: [{ price: 0.99, size: 100 }],
        verify: [{ price: 0.99, size: 100 }],
        refresh: [{ price: 0.84, size: 10 }, { price: 0.99, size: 100 }]
      },
      expectedLastStatus: "rejected",
      expectedPostedOrders: 0,
      expectedDetails: "live-stale-plan"
    },
    {
      name: "related locked market missing in S1 blocks isolated movement",
      signalMode: "confirmed",
      plan: stablePlan(0.95),
      includeRelatedMarket: true,
      relatedPlan: { ...stablePlan(0.95), throwOn: ["post"] },
      expectedLastStatus: "no_trade",
      expectedPostedOrders: 0,
      expectedDetails: "related markets did not move together"
    }
  ];
}

function stablePlan(price: number): StagePlan {
  const asks = [{ price, size: 100 }];
  return {
    pre: asks,
    post: asks,
    verify: asks,
    refresh: asks
  };
}

function liveExecutor(postedOrders: LiveOrderRequest[]): LiveExecutor {
  return new LiveExecutor(liveConfigFromEnv(liveEnv()), async () => ({
    placeLimitBuy: async (order) => {
      postedOrders.push(order);
      return filledResult(order, `matrix-${postedOrders.length}`);
    }
  }));
}

function fetchVerifiedClockFor(spec: GuardCase): ((match: MatchState) => Promise<Partial<MatchState> | null>) {
  if (spec.signalMode === "none") return async () => null;
  return async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals });
}

function signalFor(spec: Pick<GuardCase, "name" | "signalMode">, match: MatchState): Scores365GoalSignal {
  const conflict = spec.signalMode === "conflict";
  return {
    homeGoals: conflict ? Math.max(0, match.homeGoals - 1) : match.homeGoals,
    awayGoals: match.awayGoals,
    scores365GameId: 123,
    scoreMatchesSports: !conflict,
    hasMatchingGoal: spec.signalMode === "confirmed" || spec.signalMode === "post-regulation",
    hasNoGoalSignal: spec.signalMode === "no-goal",
    hasVarReviewSignal: spec.signalMode === "var",
    hasPostRegulationGoalSignal: spec.signalMode === "post-regulation",
    details: detailsForSignal(spec.signalMode)
  };
}

function detailsForSignal(signalMode: SignalMode): string[] {
  if (signalMode === "no-goal") return ["VAR Decision: No Goal"];
  if (signalMode === "var") return ["365 event VAR signal: possible goal review"];
  if (signalMode === "post-regulation") return ["365 event post-regulation goal at 120+1"];
  if (signalMode === "conflict") return ["365 score conflict"];
  return ["365 normal goal"];
}

async function* scoreUpdates(eventSlug: string, includePreUpdate: boolean): AsyncIterable<MatchState> {
  if (includePreUpdate) yield match(eventSlug, 0, 0);
  yield match(eventSlug, 1, 0);
}

async function* twoMatchUpdates(goodSlug: string, blockedSlug: string): AsyncIterable<MatchState> {
  yield match(goodSlug, 0, 0);
  yield match(blockedSlug, 0, 0);
  yield match(goodSlug, 1, 0);
  yield match(blockedSlug, 1, 0);
}

function match(eventSlug: string, homeGoals: number, awayGoals: number): MatchState {
  return {
    eventSlug,
    homeTeam: "Matrix",
    awayTeam: "Opponent",
    homeGoals,
    awayGoals,
    minute: 90,
    period: "2H",
    isLive: true,
    remainingSeconds: 120,
    remainingSecondsSource: "365scores_added_time_precise_game_time"
  };
}

function orderbookFor(
  tokenId: string,
  input: {
    spec: GuardCase;
    overToken: string;
    teamOverToken: string;
    calls: Map<string, number>;
  }
): OrderbookSnapshot {
  const call = input.calls.get(tokenId) ?? 0;
  input.calls.set(tokenId, call + 1);
  const plan = tokenId === input.teamOverToken
    ? input.spec.relatedPlan ?? input.spec.plan
    : input.spec.plan;
  const stage = stageForCall(call, input.spec.preUpdate !== false);
  if (plan.throwOn?.includes(stage)) throw new Error(`planned ${stage} orderbook failure for ${tokenId}`);
  return book(tokenId, plan[stage]);
}

function stageForCall(call: number, hasPreUpdate: boolean): StageName {
  const stages: StageName[] = hasPreUpdate
    ? ["pre", "post", "verify", "refresh"]
    : ["post", "verify", "refresh"];
  return stages[Math.min(call, stages.length - 1)]!;
}

function marketsFor(eventSlug: string, overToken: string, teamOverToken: string, includeTeam: boolean): StrategyMarket[] {
  const markets: StrategyMarket[] = [
    {
      eventSlug,
      marketSlug: `${eventSlug}-total-0pt5`,
      question: "Matrix vs. Opponent: O/U 0.5",
      conditionId: `cond-${eventSlug}-total-0pt5`,
      outcomes: ["Over", "Under"],
      clobTokenIds: [overToken, `${overToken}-under`],
      line: 0.5,
      marketType: "total"
    }
  ];
  if (includeTeam) {
    markets.push({
      eventSlug,
      marketSlug: `${eventSlug}-matrix-team-total-0pt5`,
      question: "Matrix vs. Opponent: Matrix O/U 0.5",
      conditionId: `cond-${eventSlug}-team-total-0pt5`,
      outcomes: ["Over", "Under"],
      clobTokenIds: [teamOverToken, `${teamOverToken}-under`],
      line: 0.5,
      marketType: "team_total",
      team: "Matrix"
    });
  }
  return markets;
}

function book(tokenId: string, asks: PriceLevel[]): OrderbookSnapshot {
  return { tokenId, bids: [], asks };
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

function liveEnv(): Record<string, string> {
  return {
    POLY_PRIVATE_KEY: "0xabc",
    POLY_API_KEY: "key",
    POLY_API_SECRET: "secret",
    POLY_PASSPHRASE: "passphrase",
    POLY_DEPOSIT_WALLET_ADDRESS: "0x0000000000000000000000000000000000000001"
  };
}

function lastStatus(parsed: Record<string, unknown>): string | undefined {
  const last = parsed.last;
  if (isRecord(last)) return typeof last.status === "string" ? last.status : undefined;
  return typeof parsed.status === "string" ? parsed.status : undefined;
}

function lastDetails(parsed: Record<string, unknown>): string {
  const last = parsed.last;
  if (isRecord(last) && typeof last.details === "string") return last.details;
  if (typeof parsed.details === "string") return parsed.details;
  if (isRecord(last) && typeof last.orderId === "string") return last.orderId;
  if (isRecord(last) && isRecord(last.trade) && typeof last.trade.orderId === "string") return last.trade.orderId;
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
