import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextImmediate } from "node:timers/promises";
import { ClobClient } from "@polymarket/clob-client-v2";
import axios from "axios";
import { runCli, type CliDependencies } from "../../src/cli.js";
import type { MatchState, OrderbookSnapshot, StrategyMarket, TradeDecision, TradeResult } from "../../src/domain/types.js";
import { LiveExecutor, type LiveOrderRequest } from "../../src/execution/live-executor.js";
import { PaperExecutor } from "../../src/execution/paper-executor.js";
import { LiveLedger } from "../../src/persistence/ledger.js";
import type { Scores365GoalSignal } from "../../src/polymarket/scores365-clock.js";

const eventSlug = "fifwc-esp-ksa-2026-06-21";
const market: StrategyMarket = {
  eventSlug,
  marketSlug: `${eventSlug}-total-0pt5`,
  question: "Spain vs. Saudi Arabia: O/U 0.5",
  conditionId: "review-condition",
  clobTokenIds: ["review-over", "review-under"],
  outcomes: ["Over", "Under"],
  marketType: "total",
  line: 0.5
};

const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected network, live execution or account operation");
};
const originalLiveExecute = LiveExecutor.prototype.execute;
const originalAxiosAdapter = axios.defaults.adapter;
let offlineLiveExecution = false;

beforeEach(() => {
  offlineLiveExecution = false;
  vi.stubGlobal("fetch", vi.fn(unexpected));
  axios.defaults.adapter = vi.fn(unexpected);
  vi.spyOn(LiveExecutor.prototype, "execute").mockImplementation(unexpected);
});

afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(axios.defaults.adapter).not.toHaveBeenCalled();
    if (!offlineLiveExecution) expect(LiveExecutor.prototype.execute).not.toHaveBeenCalled();
  } finally {
    if (originalAxiosAdapter === undefined) delete axios.defaults.adapter;
    else axios.defaults.adapter = originalAxiosAdapter;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

type Buy = Extract<TradeDecision, { action: "BUY" }>;
type Score = readonly [number, number];
interface Scenario {
  scores?: readonly Score[];
  signal?: (match: MatchState, stage: number, previous?: MatchState) => Promise<Scores365GoalSignal | null>;
  score?: (match: MatchState, stage: number) => Promise<Partial<MatchState> | null>;
  book?: (tokenId: string, call: number, stage: number) => Promise<OrderbookSnapshot>;
  timeoutMs?: number;
  deltaDelayMs?: number;
  compareWaitMs?: number;
  markets?: StrategyMarket[];
  executeLive?: NonNullable<CliDependencies["executeLive"]>;
  finalLedgerDelayMs?: number;
}

// Port of the audit's rollback-guard and late-negative paper fixtures. Imports
// resolve to this worktree; all market/score inputs and execution are local.
async function watchScenario(scenario: Scenario = {}) {
  const scores = scenario.scores ?? [[0, 0], [1, 0]];
  const executed: Array<{ stage: number; decision: Buy }> = [];
  const guardStages: number[] = [];
  let stage = 0;
  let bookCall = 0;
  const execute = PaperExecutor.prototype.execute;
  vi.spyOn(PaperExecutor.prototype, "execute").mockImplementation(function (this: PaperExecutor, decision) {
    if (decision.action === "BUY") executed.push({ stage, decision });
    return execute.call(this, decision);
  });
  if (scenario.executeLive || scenario.finalLedgerDelayMs !== undefined) {
    let duplicateReads = 0;
    vi.spyOn(LiveLedger.prototype, "readActiveEntries").mockImplementation(async () => {
      duplicateReads += 1;
      if (duplicateReads === 2) await delay(scenario.finalLedgerDelayMs ?? 0);
      return [];
    });
    vi.spyOn(LiveLedger.prototype, "recordResult").mockResolvedValue(undefined);
  }
  const deps: CliDependencies = {
    fetchWorldCupEventRefs: async () => [{ eventSlug }],
    watchSportsUpdates: async () => (async function* () {
      for (const [homeGoals, awayGoals] of scores) {
        stage += 1;
        yield {
          eventSlug,
          homeTeam: "Spain",
          awayTeam: "Saudi Arabia",
          homeGoals,
          awayGoals,
          minute: 30,
          period: "1H" as const,
          isLive: true
        };
      }
    })(),
    fetchMatchState: unexpected,
    fetchEventStrategyMarkets: async () => scenario.markets ?? [market],
    fetchOrderbook: async (tokenId) => {
      bookCall += 1;
      return scenario.book?.(tokenId, bookCall, stage) ?? book(tokenId);
    },
    fetchVerifiedClock: (match) => scenario.score?.(match, stage) ?? Promise.resolve(null),
    fetchLockedGoalSignal: (match, previous) => {
      guardStages.push(stage);
      return scenario.signal?.(match, stage, previous) ?? Promise.resolve(null);
    },
    executeLive: scenario.executeLive ?? unexpected,
    readPusdBalance: unexpected,
    fetchRedeemablePositions: unexpected,
    submitDepositWalletBatch: unexpected,
    settleRedeemablePositions: unexpected
  };
  const result = await runCli([
    "--mode", scenario.executeLive ? "live" : "paper",
    "--watch", "true",
    "--worldcup", "true",
    "--stake", "100",
    "--max-iterations", String(scores.length),
    ...(scenario.finalLedgerDelayMs === undefined ? [] : ["--ledger-file", "unused-test-ledger.json"]),
    ...(scenario.compareWaitMs === undefined ? [] : [
      "--candidate-compare-wait-ms", String(scenario.compareWaitMs),
      "--instant-buy-net-return", "1"
    ])
  ], {
    NODE_ENV: "review",
    POLY_DEPTH_AUDIT_ENABLED: "false",
    POLY_LOCKED_ORDERBOOK_DELTA_DELAY_MS: String(scenario.deltaDelayMs ?? 0),
    ...(scenario.timeoutMs === undefined ? {} : { POLY_LOCKED_SCORE_CONFIRM_TIMEOUT_MS: String(scenario.timeoutMs) })
  }, deps);
  expect(result.exitCode, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.status).toBe("watch_complete");
  return { last: output.last, executed, guardStages };
}

function book(tokenId: string, price = 0.95): OrderbookSnapshot {
  return { tokenId, bids: [], asks: [{ price, size: 1000 }] };
}

function signal(match: MatchState, patch: Partial<Scores365GoalSignal> = {}): Scores365GoalSignal {
  return {
    homeGoals: match.homeGoals,
    awayGoals: match.awayGoals,
    scores365GameId: 123,
    scoreMatchesSports: true,
    hasMatchingGoal: true,
    hasNoGoalSignal: false,
    hasVarReviewSignal: false,
    details: ["365 confirmed goal"],
    ...patch
  };
}

function noGoal(match: MatchState): Scores365GoalSignal {
  return signal(match, { hasMatchingGoal: false, hasNoGoalSignal: true, details: ["VAR Decision: No Goal"] });
}

async function delay(ms: number): Promise<void> {
  if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe("locked score recovery audit regressions", () => {
  test("T4 retains the rollback guard on repeated 2-0 -> 1-0 updates", async () => {
    const result = await watchScenario({
      scores: [[2, 0], [1, 0], [1, 0], [1, 0]],
      signal: async (match) => noGoal(match)
    });

    expect(result.executed).toEqual([]);
    expect(result.guardStages).toEqual([1, 3, 4]);
    expect(result.last).toMatchObject({ status: "no_trade", details: expect.stringContaining("No Goal") });
  });

  test.each([undefined, 0])("T4 requires independent confirmation after rollback (compare wait %s)", async (compareWaitMs) => {
    const result = await watchScenario({
      scores: [[0, 0], [2, 0], [1, 0], [1, 0], [1, 0]],
      signal: async (match, stage) => stage === 2 ? noGoal(match) : null,
      book: async (tokenId) => book(tokenId, 0.99),
      ...(compareWaitMs === undefined ? {} : { compareWaitMs })
    });

    expect(result.executed).toEqual([]);
    expect(result.last).toMatchObject({ status: "no_trade", details: expect.stringContaining("confirmation") });
  });

  test("T4 revalidates a surviving locked goal and keeps its 20 percent recovery cap", async () => {
    const result = await watchScenario({
      scores: [[0, 0], [2, 0], [1, 0], [1, 0], [1, 0], [1, 0]],
      signal: async (match, stage) => stage < 5 ? noGoal(match) : signal(match)
    });

    expect(result.executed).toEqual([
      { stage: 5, decision: expect.objectContaining({ locked: true, notional: 20 }) }
    ]);
    expect(result.guardStages).toEqual([2, 4, 5]);
    expect(result.last).toMatchObject({ status: "no_trade", reason: "INSUFFICIENT_BALANCE" });
  });

  test("T4 retains already spent budget when a lower score is independently confirmed", async () => {
    const result = await watchScenario({
      scores: [[0, 0], [2, 0], [1, 0], [1, 0], [1, 0]],
      signal: async (match) => signal(match),
      book: async (tokenId, _call, stage) => ({
        ...book(tokenId),
        asks: [{ price: 0.95, size: stage === 2 ? 10 / 0.95 : 1000 }]
      })
    });

    expect(result.executed.map(({ stage, decision }) => ({ stage, notional: decision.notional }))).toEqual([
      { stage: 2, notional: 10 },
      { stage: 4, notional: 10 }
    ]);
    expect(result.last).toMatchObject({ status: "no_trade", reason: "INSUFFICIENT_BALANCE" });
  });
});

describe("locked signal race audit regressions", () => {
  test.each([
    { name: "No Goal within the signal budget", timeoutMs: 900, bookDelayMs: 50, patch: { hasNoGoalSignal: true, details: ["VAR Decision: No Goal"] } },
    { name: "No Goal after the signal timeout", timeoutMs: 5, bookDelayMs: 50, patch: { hasNoGoalSignal: true, details: ["VAR Decision: No Goal"] } },
    { name: "VAR review after the signal timeout", timeoutMs: 5, bookDelayMs: 50, patch: { hasVarReviewSignal: true, details: ["VAR review pending"] } },
    { name: "post-regulation goal after the signal timeout", timeoutMs: 5, bookDelayMs: 50, patch: { hasPostRegulationGoalSignal: true, details: ["post-regulation goal"] } },
    { name: "conflicting score after the signal timeout", timeoutMs: 5, bookDelayMs: 50, patch: { homeGoals: 0, scoreMatchesSports: false, details: ["score correction"] } },
    { name: "No Goal while fast books leave signal budget", timeoutMs: 40, bookDelayMs: 0, patch: { hasNoGoalSignal: true, details: ["VAR Decision: No Goal"] } }
  ])("T5 merges $name after a fast matching score", async ({ timeoutMs, bookDelayMs, patch }) => {
    vi.useFakeTimers();
    const resultPromise = watchScenario({
      timeoutMs,
      score: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
      signal: async (match) => {
        await delay(10);
        return signal(match, patch);
      },
      book: async (tokenId, call) => {
        if (call === 3) await delay(bookDelayMs);
        return book(tokenId);
      }
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.executed).toEqual([]);
    expect(result.last).toMatchObject({ status: "no_trade", reason: "NO_ELIGIBLE_STRATEGY" });
    expect(result.last.details).toContain(patch.scoreMatchesSports === false ? "disagrees" : patch.details[0]);
  });

  test("T5 retains a negative received after both initial checks timed out during final book validation", async () => {
    vi.useFakeTimers();
    const resultPromise = watchScenario({
      timeoutMs: 5,
      signal: async (match) => {
        await delay(10);
        return noGoal(match);
      },
      book: async (tokenId, call) => {
        if (call === 3) await delay(50);
        return book(tokenId, 0.99);
      }
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.executed).toEqual([]);
    expect(result.last).toMatchObject({ status: "no_trade", details: expect.stringContaining("No Goal") });
  });

  test("T5 blocks a slower conflicting score even after detailed goal confirmation", async () => {
    vi.useFakeTimers();
    const resultPromise = watchScenario({
      timeoutMs: 5,
      signal: async (match) => signal(match),
      score: async () => {
        await delay(10);
        return { homeGoals: 0, awayGoals: 0 };
      },
      deltaDelayMs: 50
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.executed).toEqual([]);
    expect(result.last).toMatchObject({ status: "no_trade", details: expect.stringContaining("disagrees") });
  });

  test("T5 rechecks negative evidence arriving during the final ledger check", async () => {
    vi.useFakeTimers();
    const resultPromise = watchScenario({
      timeoutMs: 5,
      finalLedgerDelayMs: 50,
      score: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
      signal: async (match) => {
        await delay(10);
        return noGoal(match);
      }
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.executed).toEqual([]);
    expect(result.last).toMatchObject({ status: "no_trade", details: expect.stringContaining("No Goal") });
  });

  test.each([
    { legs: 1, negative: true },
    { legs: 2, negative: true },
    { legs: 2, negative: false }
  ])("T5 rechecks evidence during executor refresh ($legs legs, negative=$negative)", async ({ legs, negative }) => {
    vi.useFakeTimers();
    const markets = [market, {
      ...market,
      marketSlug: `${eventSlug}-team-total-0pt5`,
      conditionId: "review-team-condition",
      clobTokenIds: ["review-team-over", "review-team-under"],
      marketType: "team_total" as const,
      team: "Spain"
    }].slice(0, legs);
    const calls = new Map<string, number>();
    const resultPromise = watchScenario({
      markets,
      timeoutMs: 5,
      score: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
      signal: async (match) => {
        await delay(10);
        return negative ? noGoal(match) : signal(match);
      },
      book: async (tokenId) => {
        const call = (calls.get(tokenId) ?? 0) + 1;
        calls.set(tokenId, call);
        // One leg has already refreshed when the other leg reveals the gap.
        if (call === 4 && tokenId === (legs === 1 ? "review-over" : "review-team-over")) await delay(50);
        return { ...book(tokenId), asks: [{ price: 0.95, size: legs === 2 ? 10 / 0.95 : 1000 }] };
      },
      executeLive: async (decision, options): Promise<TradeResult> => {
        expect(decision.legs).toHaveLength(legs);
        const books = await Promise.all((decision.legs ?? [decision]).map((leg) =>
          options.refreshOrderbook!(leg.tokenId).catch(() => null)
        ));
        if (books.some((snapshot) => snapshot?.asks.length)) return new PaperExecutor().execute(decision);
        return {
          mode: "live", status: "rejected", orderId: "blocked-refresh", tokenId: decision.tokenId,
          price: decision.bestAsk, shares: 0, notional: 0, fee: 0, estimatedPayout: 0, estimatedProfit: 0
        };
      }
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.executed).toHaveLength(negative ? 0 : 1);
    if (!negative) expect(result.executed[0]?.decision.notional).toBe(20);
  });

  test("T5 stops immediately on explicit No Goal when the score source never settles", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let finishedAt = Number.POSITIVE_INFINITY;
    const resultPromise = watchScenario({
      score: async () => new Promise(() => {}),
      signal: async (match) => noGoal(match)
    }).then((result) => {
      finishedAt = Date.now();
      return result;
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.executed).toEqual([]);
    expect(finishedAt - startedAt).toBeLessThan(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("T5 keeps a sub-300ms score fallback when detailed goal events never settle", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    let finishedAt = Number.POSITIVE_INFINITY;
    const resultPromise = watchScenario({
      score: async (match) => {
        await delay(10);
        return { homeGoals: match.homeGoals, awayGoals: match.awayGoals };
      },
      signal: async () => new Promise(() => {})
    }).then((result) => {
      finishedAt = Date.now();
      return result;
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.executed).toHaveLength(1);
    expect(result.executed[0]?.decision.notional).toBe(20);
    expect(finishedAt - startedAt).toBeLessThan(300);
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(["reject", "timeout", "null"] as const)("T5 preserves bounded high-price fallback when sources %s", async (mode) => {
    vi.useFakeTimers();
    const unavailable = async (): Promise<null> => {
      if (mode === "reject") throw new Error("score service unavailable");
      if (mode === "timeout") return new Promise(() => {});
      return null;
    };
    const startedAt = Date.now();
    let finishedAt = Number.POSITIVE_INFINITY;
    const resultPromise = watchScenario({
      timeoutMs: 20,
      score: unavailable,
      signal: unavailable,
      book: async (tokenId) => book(tokenId, 0.99)
    }).then((result) => {
      finishedAt = Date.now();
      return result;
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.executed).toHaveLength(1);
    expect(result.executed[0]?.decision.notional).toBe(20);
    expect(finishedAt - startedAt).toBeLessThanOrEqual(20);
    expect(vi.getTimerCount()).toBe(0);
  });
});

const offlineConfig = {
  host: "https://unused.invalid", chainId: 137, signatureType: 1,
  privateKey: `0x${"a".repeat(64)}`, apiKey: "offline-key", apiSecret: "offline-secret", passphrase: "offline-passphrase"
};
const integrationMarkets: StrategyMarket[] = [market, {
  ...market,
  marketSlug: `${eventSlug}-team-total-0pt5`,
  conditionId: "review-team-condition",
  clobTokenIds: ["review-team-over", "review-team-under"],
  marketType: "team_total",
  team: "Spain"
}];

function allowOfflineLiveExecutor(): void {
  offlineLiveExecution = true;
  vi.mocked(LiveExecutor.prototype.execute).mockImplementation(originalLiveExecute);
}

function confirmedFill(order: LiveOrderRequest): TradeResult {
  return {
    mode: "live", status: "filled", orderId: `offline-${order.tokenId}`,
    tokenId: order.tokenId, price: order.price, shares: order.size, notional: order.notional,
    fee: order.estimatedFee, estimatedPayout: order.size,
    estimatedProfit: order.size - order.notional - order.estimatedFee
  };
}

interface OfflineExecutionWatch {
  mode?: "live" | "paper";
  ledgerFile?: string;
  scores?: readonly Score[];
  markets?: StrategyMarket[];
  bookNotional?: number;
  goalSignal?: (match: MatchState) => Promise<Scores365GoalSignal | null>;
  executeLive?: NonNullable<CliDependencies["executeLive"]>;
}

// Uses the real execution aggregator and on-disk ledger. Custom clients or SDK
// methods replace every external boundary; neither fetch nor Axios may run.
async function offlineExecutionWatch(options: OfflineExecutionWatch = {}) {
  const mode = options.mode ?? "live";
  const ledgerFile = mode === "live"
    ? options.ledgerFile ?? join(await mkdtemp(join(tmpdir(), "poly-watch-execution-recovery-")), "ledger.json")
    : undefined;
  const scores = options.scores ?? [[0, 0], [1, 0], [1, 0], [1, 0]];
  const result = await runCli([
    "--mode", mode, "--watch", "true", "--worldcup", "true",
    "--stake", "100", "--use-live-balance", "false",
    "--max-iterations", String(scores.length),
    ...(ledgerFile ? ["--ledger-file", ledgerFile] : [])
  ], {
    NODE_ENV: "test", POLY_AUTO_REDEEM: "false", POLY_DEPTH_AUDIT_ENABLED: "false",
    POLY_LOCKED_SCORE_CONFIRM_TIMEOUT_MS: "5", POLY_CLOB_HOST: offlineConfig.host,
    POLY_PRIVATE_KEY: offlineConfig.privateKey, POLY_API_KEY: offlineConfig.apiKey,
    POLY_API_SECRET: offlineConfig.apiSecret, POLY_PASSPHRASE: offlineConfig.passphrase
  }, {
    fetchWorldCupEventRefs: async () => [{ eventSlug }],
    watchSportsUpdates: async () => (async function* () {
      for (const [homeGoals, awayGoals] of scores) {
        yield {
          eventSlug, homeTeam: "Spain", awayTeam: "Saudi Arabia",
          homeGoals, awayGoals, minute: 30, period: "1H" as const, isLive: true
        };
      }
    })(),
    fetchEventStrategyMarkets: async () => options.markets ?? integrationMarkets,
    fetchMatchState: unexpected,
    fetchOrderbook: async (tokenId) => ({
      tokenId, bids: [], asks: [{ price: 0.95, size: (options.bookNotional ?? 10) / 0.95 }]
    }),
    fetchVerifiedClock: async (match) => ({ homeGoals: match.homeGoals, awayGoals: match.awayGoals }),
    fetchLockedGoalSignal: options.goalSignal ?? (async (match) => signal(match)),
    readPusdBalance: unexpected,
    fetchRedeemablePositions: unexpected,
    submitDepositWalletBatch: unexpected,
    settleRedeemablePositions: unexpected,
    ...(options.executeLive ? { executeLive: options.executeLive } : {})
  });
  expect(result.exitCode, result.stderr).toBe(0);
  return { output: JSON.parse(result.stdout), ledgerFile, ledger: ledgerFile ? new LiveLedger(ledgerFile) : undefined };
}

describe("watch execution boundary integration regressions", () => {
  test.each(["review-over", "review-team-over"])("T1 prevents refilling or reallocating a basket with uncertain %s", async (uncertainToken) => {
    allowOfflineLiveExecutor();
    const posts: LiveOrderRequest[] = [];
    const executor = new LiveExecutor(offlineConfig, async () => ({
      async placeLimitBuy(order) {
        posts.push(order);
        if (order.tokenId === uncertainToken) throw new Error("connection reset after accepted POST");
        return confirmedFill(order);
      }
    }));
    const result = await offlineExecutionWatch({ executeLive: executor.execute.bind(executor) });

    expect(posts).toHaveLength(2);
    expect(posts.filter((order) => order.tokenId === uncertainToken)).toHaveLength(1);
    expect(posts.reduce((total, order) => total + order.notional, 0)).toBe(20);
    expect(await result.ledger!.readActiveEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ tokenId: uncertainToken, status: "posted", notional: 0, shares: 0 }),
      expect.objectContaining({ status: "filled", notional: 10 })
    ]));
    expect(result.output.last.trade).toMatchObject({ status: "partial", notional: 10 });
  });

  test("T1 blocks a new watch when an existing basket contains a posted ledger leg", async () => {
    allowOfflineLiveExecutor();
    const posts: LiveOrderRequest[] = [];
    const executor = new LiveExecutor(offlineConfig, async () => ({
      async placeLimitBuy(order) {
        posts.push(order);
        if (order.tokenId === "review-team-over") throw new Error("submission outcome unknown");
        return confirmedFill(order);
      }
    }));
    const first = await offlineExecutionWatch({
      scores: [[0, 0], [1, 0]], executeLive: executor.execute.bind(executor)
    });
    expect(posts).toHaveLength(2);
    const retry = await offlineExecutionWatch({
      ledgerFile: first.ledgerFile!, scores: [[0, 0], [1, 0]], executeLive: executor.execute.bind(executor)
    });

    expect(posts).toHaveLength(2);
    expect(retry.output.last).toMatchObject({ status: "no_trade", reason: "DUPLICATE_TRADE" });
  });

  test("T1 retains pending event state without a ledger even across another score increase", async () => {
    allowOfflineLiveExecutor();
    const posts: LiveOrderRequest[] = [];
    const executor = new LiveExecutor(offlineConfig, async () => ({
      async placeLimitBuy(order) {
        posts.push(order);
        if (order.tokenId === "review-team-over") throw new Error("submission outcome unknown");
        return confirmedFill(order);
      }
    }));
    vi.spyOn(PaperExecutor.prototype, "execute").mockImplementation((decision) => executor.execute(decision));
    const result = await offlineExecutionWatch({
      mode: "paper", scores: [[0, 0], [1, 0], [1, 0], [2, 0], [2, 0]],
      markets: [...integrationMarkets, {
        ...market, line: 1.5, marketSlug: `${eventSlug}-total-1pt5`, conditionId: "review-next-condition",
        clobTokenIds: ["review-next-over", "review-next-under"]
      }]
    });

    expect(result.ledger).toBeUndefined();
    expect(posts).toHaveLength(2);
    expect(posts.reduce((total, order) => total + order.notional, 0)).toBe(20);
  });

  test("T1 keeps refilling confirmed partial fills using only their actual notional", async () => {
    allowOfflineLiveExecutor();
    const posts: LiveOrderRequest[] = [];
    const executor = new LiveExecutor(offlineConfig, async () => ({
      async placeLimitBuy(order) {
        posts.push(order);
        const filled = confirmedFill({
          ...order, size: order.size / 2, notional: order.notional / 2, estimatedFee: order.estimatedFee / 2
        });
        return { ...filled, status: "partial" };
      }
    }));
    const result = await offlineExecutionWatch({
      markets: [market], executeLive: executor.execute.bind(executor)
    });

    expect(posts).toHaveLength(3);
    const active = await result.ledger!.readActiveEntries();
    expect(active.map((position) => position.status)).toEqual(["partial", "partial", "partial"]);
    expect(active.reduce((total, position) => total + position.notional, 0)).toBe(15);
  });

  test.each([true, false])("T5 checks evidence after default SDK signing (No Goal=%s)", async (negative) => {
    allowOfflineLiveExecutor();
    let deliverSignal: (() => void) | undefined;
    const timeline: string[] = [];
    vi.spyOn(ClobClient.prototype as unknown as { resolveVersion(): Promise<number> }, "resolveVersion").mockResolvedValue(2);
    vi.spyOn(ClobClient.prototype, "createMarketOrder").mockImplementation(async (request) => {
      timeline.push("signing");
      expect(deliverSignal).toBeTypeOf("function");
      deliverSignal!();
      await nextImmediate();
      return { tokenId: request.tokenID, price: request.price, amount: request.amount } as never;
    });
    const post = vi.spyOn(ClobClient.prototype, "postOrder").mockImplementation(async () => {
      timeline.push("post");
      return { success: true, orderID: "offline-order", status: "matched" };
    });
    vi.spyOn(ClobClient.prototype, "getOrder").mockResolvedValue({
      id: "offline-order", asset_id: "review-over", status: "MATCHED", price: "0.95",
      original_size: String(20 / 0.95), size_matched: String(20 / 0.95)
    } as never);
    vi.spyOn(ClobClient.prototype, "getTrades").mockResolvedValue([]);
    vi.spyOn(ClobClient.prototype, "getOpenOrders").mockResolvedValue([]);
    const result = await offlineExecutionWatch({
      markets: [market], scores: [[0, 0], [1, 0]], bookNotional: 100,
      goalSignal: async (match) => new Promise((resolve) => {
        deliverSignal = () => {
          timeline.push(negative ? "No Goal" : "confirmed");
          resolve(negative ? noGoal(match) : signal(match));
        };
      })
    });

    expect(timeline).toEqual(negative ? ["signing", "No Goal"] : ["signing", "confirmed", "post"]);
    expect(post).toHaveBeenCalledTimes(negative ? 0 : 1);
    expect(result.output.last.trade).toMatchObject({
      status: negative ? "rejected" : "filled", notional: negative ? 0 : 20
    });
    expect(await result.ledger!.hasActiveEventTrade(eventSlug)).toBe(!negative);
  });
});
