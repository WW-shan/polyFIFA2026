import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { netReturnRate } from "./domain/fees.js";
import { lockedConditionMatchesScore } from "./domain/decision.js";
import { selectLossRequiresCandidates } from "./domain/loss-requires-strategy.js";
import { classifyTailWindow } from "./domain/time-window.js";
import type { DecisionThresholds, MatchState, NoTradeDecision, OrderbookSnapshot, SelectedStrategyMarket, StrategyMarket, TradeDecision, TradeResult } from "./domain/types.js";
import { capStakeToAvailableBalance, DEFAULT_POLYGON_RPC_URL, readPusdBalance } from "./execution/balance.js";
import { LiveExecutionError, liveConfigFromEnv, type LiveOrderType } from "./execution/live-executor.js";
import type { LiveExecuteOptions, LiveExecutorConfig } from "./execution/live-executor.js";
import { PaperExecutor } from "./execution/paper-executor.js";
import { AutoSettlementMonitor, DEFAULT_POLYMARKET_RELAYER_URL, type MarketSettlementStatus, type RedeemablePosition, type SettlementConfig, type SettlementResult, type SubmitDepositWalletBatchInput } from "./execution/settlement.js";
import { LiveLedger, isActiveLedgerStatus, isLockedStrategy } from "./persistence/ledger.js";
import { fetchOrderbook } from "./polymarket/clob.js";
import { fetchEventMatchState, fetchEventStrategyMarkets, hasLockedGoalStrategyMarkets } from "./polymarket/event-page.js";
import { Scores365ClockProvider, type Scores365GoalSignal } from "./polymarket/scores365-clock.js";
import { SportsLiveProvider } from "./polymarket/sports-live.js";
import { fetchOpenWorldCupEventRefs, type WorldCupEventRef } from "./polymarket/worldcup-events.js";
import { buildThresholds, DEFAULT_THRESHOLDS, runDecisionFlow } from "./runner.js";
import { LiveExecutor } from "./execution/live-executor.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type Mode = "paper" | "live" | "status";

interface ParsedArgs {
  mode: Mode;
  matchFile?: string;
  eventSlug?: string;
  marketsFile?: string;
  orderbookFile?: string;
  stake?: number;
  maxEntryPrice?: number;
  minimumNetReturn?: number;
  minimumNotional?: number;
  entryWindowMinutes?: number;
  ledgerFile?: string;
  useLiveBalance?: boolean;
  balanceBuffer?: number;
  watch?: boolean;
  worldcup?: boolean;
  intervalMs?: number;
  maxIterations?: number;
  instantBuyNetReturn?: number;
  candidateCompareWaitMs?: number;
  liveAuditFile?: string;
  depthAuditFile?: string;
  orderType: LiveOrderType;
}

interface SinglePassOptions {
  executeTrade?: boolean;
  allowActiveEventRefill?: boolean;
  lockedIncidentPreviousMatch?: MatchState;
  lockedIncidentStakeLimit?: (fraction?: number) => Promise<number>;
  assessLockedScoreRisk?: (match: MatchState, decision: Extract<TradeDecision, { action: "BUY" }>, context: LockedScoreRiskContext) => Promise<LockedScoreRiskResult>;
}

interface PendingBuy {
  eventSlug: string;
  match: MatchState;
  firstSeenAt: number;
  updatedAt: number;
  decision: Extract<TradeDecision, { action: "BUY" }>;
  lockedIncidentKey?: string;
  lockedIncidentPreviousMatch?: MatchState;
}

interface LockedScoreIncident {
  key: string;
  previousMatch: MatchState;
}

interface LockedIncidentBudget {
  bankroll: number;
  spent: number;
}

interface LockedScoreRiskAssessment {
  capFraction: number;
  minimumNetReturn: number;
  details: string;
  stakeLimit?: number;
}

interface LockedScoreRiskContext {
  previousMatch?: MatchState;
  markets: readonly StrategyMarket[];
  orderbooks: readonly OrderbookSnapshot[];
  thresholds: DecisionThresholds;
  fetchOrderbook: (tokenId: string) => Promise<OrderbookSnapshot>;
}

interface CachedOrderbook {
  observedAt: number;
  orderbook: OrderbookSnapshot;
}

type LockedScoreRiskResult =
  | { action: "USE"; assessment: LockedScoreRiskAssessment }
  | { action: "SKIP"; decision: NoTradeDecision };

interface CurrentScoreIncidentState extends LockedScoreIncident {
  homeGoals: number;
  awayGoals: number;
}

type ScoreIncidentContext =
  | { action: "locked_incident"; incident: LockedScoreIncident }
  | { action: "blocked"; details: string }
  | { action: "none" };

const MAX_VERIFIED_CLOCK_POLL_INTERVAL_MS = 1000;
const SPORTS_WATCH_RECONNECT_INTERVAL_MS = 1000;
const LOCKED_SCORE_CONFIRM_TIMEOUT_MS = 750;
const LOCKED_INCIDENT_BANKROLL_FRACTION = 0.2;
const LOCKED_ORDERBOOK_DELTA_DELAY_MS = 750;
const LOCKED_ORDERBOOK_CHEAP_GROWTH_TOLERANCE_NOTIONAL = 0.5;
const LOCKED_ORDERBOOK_RETRACE_PRICE_TOLERANCE = 0.01;
const LOCKED_ORDERBOOK_CACHE_TTL_MS = 5 * 60_000;

export interface CliDependencies {
  fetchMatchState?: (eventSlug: string) => Promise<MatchState>;
  readPusdBalance?: (walletAddress: string, rpcUrl?: string) => Promise<number>;
  fetchWorldCupEventSlugs?: () => Promise<string[]>;
  fetchWorldCupEventRefs?: () => Promise<WorldCupEventRef[]>;
  watchSportsUpdates?: (events: readonly WorldCupEventRef[], options: { auditFile?: string; proxyUrl?: string }) => Promise<AsyncIterable<MatchState>>;
  fetchVerifiedClock?: (match: MatchState, events: readonly WorldCupEventRef[], options: { proxyUrl?: string; timezoneName?: string }) => Promise<Partial<MatchState> | null>;
  fetchLockedGoalSignal?: (match: MatchState, previousMatch: MatchState | undefined, events: readonly WorldCupEventRef[], options: { proxyUrl?: string; timezoneName?: string }) => Promise<Scores365GoalSignal | null>;
  fetchEventStrategyMarkets?: (eventSlug: string) => Promise<StrategyMarket[]>;
  fetchOrderbook?: (tokenId: string) => Promise<OrderbookSnapshot>;
  executeLive?: (decision: Extract<TradeDecision, { action: "BUY" }>, options: LiveExecuteOptions) => Promise<TradeResult>;
  fetchRedeemablePositions?: (walletAddress: string, config: SettlementConfig) => Promise<RedeemablePosition[]>;
  submitDepositWalletBatch?: (input: SubmitDepositWalletBatchInput) => Promise<unknown>;
  settleRedeemablePositions?: (config: SettlementConfig) => Promise<SettlementResult>;
  fetchMarketSettlementStatus?: (marketSlug: string, config: SettlementConfig) => Promise<MarketSettlementStatus | null>;
  readConditionalTokenBalance?: (walletAddress: string, tokenId: string, config: SettlementConfig) => Promise<bigint>;
  onSettlementError?: (error: unknown) => void;
}

export async function runCli(
  argv = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  deps: CliDependencies = {}
): Promise<CliResult> {
  try {
    const args = parseArgs(argv);
    if (args.mode === "status") return await runStatus(args, env, deps);
    if (args.watch) return args.worldcup ? await runSportsWatch(args, env, deps) : await runWatch(args, env, deps);
    return await runSinglePass(args, env, deps);
  } catch (error) {
    if (error instanceof LiveExecutionError) {
      return { exitCode: 1, stdout: "", stderr: `${error.code}: ${error.message}` };
    }
    return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

async function runSinglePass(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
  deps: CliDependencies,
  options: SinglePassOptions = {}
): Promise<CliResult> {
    const loadStrategyMarkets = deps.fetchEventStrategyMarkets ?? fetchEventStrategyMarkets;
    let match = args.matchFile
      ? await readJsonFile<MatchState>(args.matchFile)
      : await (deps.fetchMatchState ?? fetchEventMatchState)(required(args.eventSlug, "--event-slug"));
    match = await overlayVerifiedClockForSinglePass(match, args, env, deps);
    const tailWindow = classifyTailWindow(match, {
      entryWindowMinutes: args.entryWindowMinutes ?? DEFAULT_THRESHOLDS.entryWindowMinutes
    });

    let markets = args.marketsFile ? await readJsonFile<StrategyMarket[]>(args.marketsFile) : undefined;
    if (!tailWindow.eligible) {
      markets ??= await loadStrategyMarkets(match.eventSlug);
      const lockedCandidates = selectLossRequiresCandidates(match, markets, {
        entryWindowMinutes: args.entryWindowMinutes ?? DEFAULT_THRESHOLDS.entryWindowMinutes,
        allowLockedOutsideEntryWindow: true
      }).filter((candidate) => candidate.locked === true);
      if (lockedCandidates.length === 0) {
        const decision: NoTradeDecision = {
          action: "NO_TRADE",
          reason: "MATCH_NOT_LATE_ENOUGH",
          eventSlug: match.eventSlug,
          details: `${tailWindow.source}: ${tailWindow.details}`
        };
        if (match.homeGoals + match.awayGoals > 0) {
          await writeDepthAudit(args, env, {
            match,
            markets,
            orderbooks: [],
            thresholds: unresolvedStakeAuditThresholds(args),
            decision
          });
        }
        return ok(summary(args.mode, decision));
      }
    }

    if (options.lockedIncidentPreviousMatch) markets ??= await loadStrategyMarkets(match.eventSlug);
    const lockedIncidentHasNewCandidate = options.lockedIncidentPreviousMatch && markets
      ? hasNewLockedIncidentCandidate(match, markets, args.entryWindowMinutes ?? DEFAULT_THRESHOLDS.entryWindowMinutes, options.lockedIncidentPreviousMatch)
      : false;
    const lockedIncidentStakeLimit = lockedIncidentHasNewCandidate && options.lockedIncidentStakeLimit
      ? await options.lockedIncidentStakeLimit()
      : undefined;
    const minimumNotional = args.minimumNotional ?? DEFAULT_THRESHOLDS.minimumNotional;
    const lockedIncidentBudgetExhausted = lockedIncidentStakeLimit !== undefined && lockedIncidentStakeLimit < minimumNotional;
    if (lockedIncidentBudgetExhausted && !tailWindow.eligible) {
      return ok(summary(args.mode, {
        action: "NO_TRADE",
        reason: "INSUFFICIENT_BALANCE",
        eventSlug: match.eventSlug,
        details: `Locked score incident budget remaining ${lockedIncidentStakeLimit} is below minimum ${minimumNotional}`
      }));
    }
    const stakeArgs = lockedIncidentStakeLimit !== undefined && !lockedIncidentBudgetExhausted
      ? stakeLimitedArgs(args, lockedIncidentStakeLimit)
      : args;

    const liveConfig = args.mode === "live" ? liveConfigFromEnv(env) : undefined;
    const liveStake = await resolveStake(stakeArgs, match, env, liveConfig, deps);
    if (liveStake.action === "NO_TRADE") return ok(summary(args.mode, liveStake.decision));

    markets ??= await loadStrategyMarkets(match.eventSlug);
    let thresholdOverrides = thresholdOverridesFromArgs(args);
    let decisionStake = liveStake.stake;
    let thresholds = buildThresholds(decisionStake, thresholdOverrides);
    const orderbooks = args.orderbookFile
      ? [await readJsonFile<OrderbookSnapshot>(args.orderbookFile)]
      : await fetchCandidateOrderbooks(match, markets, thresholds.entryWindowMinutes, undefined, deps.fetchOrderbook ?? fetchOrderbook);
    const ledgerFile = resolveLedgerFile(args, env);
    const ledger = ledgerFile ? new LiveLedger(ledgerFile) : undefined;
    const duplicateDecisionFor = async (buyDecision: Extract<TradeDecision, { action: "BUY" }>): Promise<NoTradeDecision | undefined> => {
      if (!ledger || !(await ledger.hasActiveEventTrade(buyDecision.eventSlug))) return undefined;
      const hasActiveLockedEventTrade = await ledger.hasActiveLockedEventTrade(buyDecision.eventSlug);
      const allowLockedRefill = options.allowActiveEventRefill
        && buyDecision.locked === true
        && hasActiveLockedEventTrade;
      const allowNonLockedAfterLocked = options.allowActiveEventRefill
        && buyDecision.locked !== true
        && hasActiveLockedEventTrade
        && !(await ledger.hasActiveTrade(buyDecision.eventSlug, buyDecision.tokenId));
      if (allowLockedRefill === true || allowNonLockedAfterLocked === true) return undefined;
      return {
        action: "NO_TRADE",
        reason: "DUPLICATE_TRADE",
        eventSlug: buyDecision.eventSlug,
        details: "Ledger already has an active trade for this event"
      };
    };

    const runDecision = (
      stake: number,
      overrides: Partial<Omit<DecisionThresholds, "maxNotional">>,
      suppressLockedIncidentCandidates: boolean
    ): TradeDecision => {
      const flowInput: Parameters<typeof runDecisionFlow>[0] = {
        match,
        markets,
        orderbooks,
        stake,
        thresholds: overrides
      };
      if (options.lockedIncidentPreviousMatch) flowInput.lockedIncidentPreviousMatch = options.lockedIncidentPreviousMatch;
      if (suppressLockedIncidentCandidates) flowInput.suppressLockedIncidentCandidates = true;
      return runDecisionFlow(flowInput);
    };

    let decision = runDecision(decisionStake, thresholdOverrides, lockedIncidentBudgetExhausted);
    if (decision.action !== "BUY") {
      await writeDepthAudit(args, env, {
        match,
        markets,
        orderbooks,
        thresholds,
        decision
      });
      return ok(summary(args.mode, decision));
    }
    const duplicateDecision = await duplicateDecisionFor(decision);
    if (duplicateDecision) {
      await writeDepthAudit(args, env, {
        match,
        markets,
        orderbooks,
        thresholds,
        decision: duplicateDecision
      });
      return ok(summary(args.mode, duplicateDecision));
    }
    if (options.executeTrade === false) {
      await writeDepthAudit(args, env, {
        match,
        markets,
        orderbooks,
        thresholds,
        decision
      });
      return ok(summary(args.mode, decision));
    }
    if (decision.locked === true && options.assessLockedScoreRisk) {
      const risk = await options.assessLockedScoreRisk(match, decision, {
        ...(options.lockedIncidentPreviousMatch ? { previousMatch: options.lockedIncidentPreviousMatch } : {}),
        markets,
        orderbooks,
        thresholds,
        fetchOrderbook: deps.fetchOrderbook ?? fetchOrderbook
      });
      if (risk.action === "SKIP") {
        const suppressedDecision = tailWindow.eligible
          ? runDecision(decisionStake, thresholdOverrides, true)
          : risk.decision;
        if (suppressedDecision.action !== "BUY") {
          await writeDepthAudit(args, env, {
            match,
            markets,
            orderbooks,
            thresholds,
            decision: risk.decision
          });
          return ok(summary(args.mode, risk.decision));
        }
        decision = suppressedDecision;
      } else {
        const incidentRiskStakeLimit = lockedIncidentHasNewCandidate && options.lockedIncidentStakeLimit
          ? await options.lockedIncidentStakeLimit(risk.assessment.capFraction)
          : undefined;
        const riskStakeLimit = minDefined(incidentRiskStakeLimit, risk.assessment.stakeLimit);
        const riskBudgetExhausted = riskStakeLimit !== undefined && riskStakeLimit < minimumNotional;
        if (riskBudgetExhausted && !tailWindow.eligible) {
          const exhaustedDecision: NoTradeDecision = {
            action: "NO_TRADE",
            reason: "INSUFFICIENT_BALANCE",
            eventSlug: match.eventSlug,
            details: `Locked score incident ${risk.assessment.details} budget remaining ${riskStakeLimit} is below minimum ${minimumNotional}`
          };
          await writeDepthAudit(args, env, {
            match,
            markets,
            orderbooks,
            thresholds,
            decision: exhaustedDecision
          });
          return ok(summary(args.mode, exhaustedDecision));
        }

        if (riskBudgetExhausted) {
          decision = runDecision(decisionStake, thresholdOverrides, true);
          if (decision.action !== "BUY") {
            await writeDepthAudit(args, env, {
              match,
              markets,
              orderbooks,
              thresholds,
              decision
            });
            return ok(summary(args.mode, decision));
          }
        } else {
          if (riskStakeLimit !== undefined) decisionStake = Math.min(liveStake.stake, riskStakeLimit);
          thresholdOverrides = thresholdOverridesWithMinimumNetReturn(thresholdOverrides, risk.assessment.minimumNetReturn);
          thresholds = buildThresholds(decisionStake, thresholdOverrides);
          decision = runDecision(decisionStake, thresholdOverrides, false);
          if (decision.action !== "BUY") {
            await writeDepthAudit(args, env, {
              match,
              markets,
              orderbooks,
              thresholds,
              decision
            });
            return ok(summary(args.mode, decision));
          }
        }
      }
    }

    const postRiskDuplicateDecision = await duplicateDecisionFor(decision);
    if (postRiskDuplicateDecision) {
      await writeDepthAudit(args, env, {
        match,
        markets,
        orderbooks,
        thresholds,
        decision: postRiskDuplicateDecision
      });
      return ok(summary(args.mode, postRiskDuplicateDecision));
    }

    await writeDepthAudit(args, env, {
      match,
      markets,
      orderbooks,
      thresholds,
      decision
    });
    const trade = args.mode === "paper"
      ? await new PaperExecutor().execute(decision)
      : await (deps.executeLive
        ? deps.executeLive(decision, liveExecuteOptions(args, thresholds, deps))
        : new LiveExecutor(liveConfig).execute(decision, liveExecuteOptions(args, thresholds, deps)));
    if (ledger) await ledger.recordResult(decision, trade);

    return ok(summary(args.mode, decision, trade));
}

async function runWatch(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
  deps: CliDependencies
): Promise<CliResult> {
  if (!args.worldcup && !args.eventSlug) throw new Error("--watch requires --event-slug or --worldcup true so match state can be refreshed");
  if (args.matchFile) throw new Error("--watch cannot be used with a static --match-file");

  let last: Record<string, unknown> | undefined;
  const maxIterations = args.maxIterations ?? Number.POSITIVE_INFINITY;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const eventSlugs = [required(args.eventSlug, "--event-slug")];
    for (const eventSlug of eventSlugs) {
      const result = await runSinglePass({ ...args, eventSlug }, env, deps);
      if (result.exitCode !== 0) return result;

      last = JSON.parse(result.stdout) as Record<string, unknown>;
      if (last.status !== "no_trade") return result;
    }
    if (iteration < maxIterations) await sleep(args.intervalMs ?? 1000);
  }

  return ok({
    mode: args.mode,
    status: "watch_complete",
    iterations: Number.isFinite(maxIterations) ? maxIterations : undefined,
    last
  });
}

async function runSportsWatch(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
  deps: CliDependencies
): Promise<CliResult> {
  if (args.matchFile) throw new Error("--watch cannot be used with a static --match-file");

  let last: Record<string, unknown> | undefined;
  let iterations = 0;
  const maxIterations = args.maxIterations ?? Number.POSITIVE_INFINITY;
  if (maxIterations <= 0) {
    return ok({
      mode: args.mode,
      status: "watch_complete",
      iterations,
      last
    });
  }

  const settlementMonitor = autoSettlementMonitor(args, env, deps);
  while (iterations < maxIterations) {
    settlementMonitor?.kick();
    let events: WorldCupEventRef[];
    try {
      events = await fetchWorldCupEventRefs(deps);
    } catch (error) {
      if (Number.isFinite(maxIterations) || !isTransientFetchError(error)) throw error;
      last = {
        status: "watch_reconnect",
        reason: "EVENT_DISCOVERY_ERROR",
        details: error instanceof Error ? error.message : String(error)
      };
      await sleep(args.intervalMs ?? SPORTS_WATCH_RECONNECT_INTERVAL_MS);
      continue;
    }
    if (events.length === 0) {
      last = {
        status: "no_events",
        reason: "NO_WORLD_CUP_EVENTS",
        details: "No World Cup events were discovered for live sports watch"
      };
      if (Number.isFinite(maxIterations)) break;
      await sleep(args.intervalMs ?? 60_000);
      continue;
    }

    let fatal: CliResult | undefined;
    try {
      fatal = await runSportsWatchEventStream(events);
    } catch (error) {
      if (Number.isFinite(maxIterations)) throw error;
      last = {
        status: "watch_reconnect",
        reason: "SPORTS_STREAM_ERROR",
        details: error instanceof Error ? error.message : String(error)
      };
      await sleep(args.intervalMs ?? SPORTS_WATCH_RECONNECT_INTERVAL_MS);
      continue;
    }
    if (fatal) return fatal;
    if (Number.isFinite(maxIterations)) break;
    await sleep(args.intervalMs ?? SPORTS_WATCH_RECONNECT_INTERVAL_MS);
  }

  return ok({
    mode: args.mode,
    status: "watch_complete",
    iterations,
    last
  });

  async function runSportsWatchEventStream(events: readonly WorldCupEventRef[]): Promise<CliResult | undefined> {
    const updateOptions = sportsUpdateOptions(args, env);
    const clockOptions = verifiedClockOptions(env);
    const updates = await (deps.watchSportsUpdates ?? defaultSportsUpdates)(events, updateOptions);
    const scores365Provider = deps.fetchVerifiedClock && deps.fetchLockedGoalSignal ? undefined : new Scores365ClockProvider(clockOptions);
    const fetchVerifiedClock: NonNullable<CliDependencies["fetchVerifiedClock"]> = deps.fetchVerifiedClock
      ?? (async (match: MatchState): Promise<Partial<MatchState> | null> => scores365Provider!.fetchClock(match));
    const fetchExternalScore: NonNullable<CliDependencies["fetchVerifiedClock"]> = deps.fetchVerifiedClock
      ?? (async (match: MatchState): Promise<Partial<MatchState> | null> => scores365Provider!.fetchScore(match));
    const fetchLockedGoalSignal: NonNullable<CliDependencies["fetchLockedGoalSignal"]> = deps.fetchLockedGoalSignal
      ?? (deps.fetchVerifiedClock
        ? async (match: MatchState): Promise<Scores365GoalSignal | null> => scorePatchToGoalSignal(await fetchExternalScore(match, events, clockOptions), match)
        : async (match: MatchState, previousMatch: MatchState | undefined): Promise<Scores365GoalSignal | null> => scores365Provider!.fetchGoalSignal(match, previousMatch));
    const requireOrderbookDelta = deps.fetchLockedGoalSignal !== undefined || deps.fetchVerifiedClock === undefined;
    const streamDeps: CliDependencies = {
      ...deps,
      fetchEventStrategyMarkets: cachedStrategyMarketFetcher(deps.fetchEventStrategyMarkets ?? fetchEventStrategyMarkets)
    };
    if (!args.marketsFile) {
      for (const event of events) {
        void streamDeps.fetchEventStrategyMarkets?.(event.eventSlug).catch(() => undefined);
      }
    }
    const candidateCompareWaitMs = args.candidateCompareWaitMs;
    const instantBuyNetReturn = candidateCompareWaitMs === undefined
      ? 0.005
      : args.instantBuyNetReturn ?? numberEnv(env.POLY_INSTANT_BUY_NET_RETURN) ?? 0.005;

    const activeMatches = new Map<string, MatchState>();
    const pendingBuys = new Map<string, PendingBuy>();
    const completedEventSlugs = new Set<string>();
    const refillEventSlugs = new Set<string>();
    const observedScores = new Map<string, MatchState>();
    const currentLockedIncidents = new Map<string, CurrentScoreIncidentState>();
    const incidentSequences = new Map<string, number>();
    const lockedIncidentBudgets = new Map<string, LockedIncidentBudget>();
    const lockedOrderbookCache = new Map<string, CachedOrderbook>();
    let marketsFileCache: StrategyMarket[] | undefined;
    await seedLateActiveMatches(activeMatches, events, deps);
    const iterator = updates[Symbol.asyncIterator]();
    let updatePromise: Promise<IteratorResult<MatchState>> | undefined = iterator.next();

    try {
      while (iterations < maxIterations) {
        settlementMonitor?.kick();
        const input = await nextSportsWatchInput(updatePromise, activeMatches.size > 0, verifiedClockPollIntervalMs(args));
        if (input.type === "update") {
          updatePromise = undefined;
          if (input.result.done) {
            const deferred = await maybeExecuteDeferredBuy(Date.now());
            if (deferred) return deferred;
            if (activeMatches.size === 0 || pendingBuys.size === 0) break;
            continue;
          }
          if (completedEventSlugs.has(input.result.value.eventSlug)) {
            activeMatches.delete(input.result.value.eventSlug);
            pendingBuys.delete(input.result.value.eventSlug);
            refillEventSlugs.delete(input.result.value.eventSlug);
            if (iterations < maxIterations) updatePromise = iterator.next();
            continue;
          }
          rememberClockPollMatch(activeMatches, input.result.value);
          const incidentContext = rememberScoreIncident(input.result.value);
          const processed = await processSportsWatchMatch(input.result.value, incidentContext);
          iterations += 1;
          const fatal = await handleSportsWatchDecision(processed);
          if (fatal) return fatal;
          await rememberNextLockedOrderbooks(processed.match);
          const deferred = await maybeExecuteDeferredBuy(Date.now());
          if (deferred) return deferred;
          if (iterations < maxIterations) updatePromise = iterator.next();
          continue;
        }

        const pollMatches = [...activeMatches.values()]
          .filter((match) => !completedEventSlugs.has(match.eventSlug))
          .slice(0, Math.max(0, maxIterations - iterations));
        const polledMatches = await Promise.all(pollMatches.map(async (match) => {
          const [freshMatch, clockPatch] = await Promise.all([
            fetchActiveMatchSnapshot(match),
            shouldPollVerifiedClock(match)
              ? maybeFetchVerifiedClock(fetchVerifiedClock, match, events, clockOptions)
              : Promise.resolve(null)
          ]);
          const baseMatch = freshMatch ?? match;
          if (clockPatch && shouldPollVerifiedClock(baseMatch)) return { ...baseMatch, ...clockPatch };
          if (freshMatch || refillEventSlugs.has(match.eventSlug)) return baseMatch;
          return null;
        }));
        for (const timedMatch of polledMatches) {
          if (!timedMatch || iterations >= maxIterations) continue;
          rememberClockPollMatch(activeMatches, timedMatch);
          const incidentContext = rememberScoreIncident(timedMatch);
          const processed = await processSportsWatchMatch(timedMatch, incidentContext);
          iterations += 1;
          const fatal = await handleSportsWatchDecision(processed);
          if (fatal) return fatal;
          await rememberNextLockedOrderbooks(processed.match);
        }
        const deferred = await maybeExecuteDeferredBuy(Date.now());
        if (deferred) return deferred;
      }
    } finally {
      if (updatePromise) {
        void iterator.return?.();
      } else {
        await iterator.return?.();
      }
    }

    return undefined;

    function singlePassOptionsForLockedIncident(lockedIncident: LockedScoreIncident | undefined): SinglePassOptions {
      const options: SinglePassOptions = { allowActiveEventRefill: true };
      if (!lockedIncident) return options;
      options.lockedIncidentPreviousMatch = lockedIncident.previousMatch;
      options.lockedIncidentStakeLimit = (fraction) => lockedIncidentBudgetRemaining(lockedIncident.key, fraction);
      options.assessLockedScoreRisk = assessLockedScoreRisk;
      return options;
    }

    async function lockedIncidentBudgetRemaining(incidentKey: string, fraction = LOCKED_INCIDENT_BANKROLL_FRACTION): Promise<number> {
      let budget = lockedIncidentBudgets.get(incidentKey);
      if (!budget) {
        const bankroll = Math.max(0, await estimateTotalBankroll());
        budget = { bankroll, spent: 0 };
        lockedIncidentBudgets.set(incidentKey, budget);
      }
      return Math.max(0, budget.bankroll * fraction - budget.spent);
    }

    async function estimateTotalBankroll(): Promise<number> {
      if (args.mode !== "live") return args.stake ?? 97;
      const liveConfig = liveConfigFromEnv(env);
      const walletAddress = liveConfig.depositWalletAddress ?? liveConfig.funderAddress;
      const cash = walletAddress
        ? await (deps.readPusdBalance ?? readPusdBalance)(walletAddress, liveConfig.rpcUrl)
        : args.stake ?? 0;
      return cash + await activeLedgerExposureNotional();
    }

    async function activeLedgerExposureNotional(): Promise<number> {
      const ledgerFile = resolveLedgerFile(args, env);
      if (!ledgerFile) return 0;
      const entries = await new LiveLedger(ledgerFile).readActiveEntries();
      return entries.reduce((total, entry) => total + (Number.isFinite(entry.notional) ? entry.notional : 0), 0);
    }

    async function assessLockedScoreRisk(match: MatchState, decision: Extract<TradeDecision, { action: "BUY" }>, context: LockedScoreRiskContext): Promise<LockedScoreRiskResult> {
      if (decision.locked !== true || !isLockedStrategy(decision.strategy)) {
        return {
          action: "USE",
          assessment: {
            capFraction: LOCKED_INCIDENT_BANKROLL_FRACTION,
            minimumNetReturn: DEFAULT_THRESHOLDS.minimumNetReturn,
            details: "non-locked decision"
          }
        };
      }

      const signal = await fetchLockedGoalSignalCheck(match, context.previousMatch);
      if (!signal) {
        return {
          action: "SKIP",
          decision: {
            action: "NO_TRADE",
            reason: "NO_ELIGIBLE_STRATEGY",
            eventSlug: match.eventSlug,
            details: "locked score guard rejected because 365 goal signal was unavailable"
          }
        };
      }

      if (signal.hasNoGoalSignal || signal.hasVarReviewSignal || signal.hasPostRegulationGoalSignal) {
        const details = signal.details.join("; ");
        return {
          action: "SKIP",
          decision: {
            action: "NO_TRADE",
            reason: "NO_ELIGIBLE_STRATEGY",
            eventSlug: match.eventSlug,
            details: `locked score guard hard-blocked by 365 event signal: ${details}`
          }
        };
      }

      if (!signal.scoreMatchesSports) {
        return {
          action: "SKIP",
          decision: {
            action: "NO_TRADE",
            reason: "NO_ELIGIBLE_STRATEGY",
            eventSlug: match.eventSlug,
            details: `locked score guard rejected because 365 score ${signal.homeGoals}-${signal.awayGoals} disagrees with sports score ${match.homeGoals}-${match.awayGoals}`
          }
        };
      }

      const marketGuard = await assessLockedOrderbookDelta(match, decision, context, signal);
      if (marketGuard.action === "SKIP") return marketGuard;

      if (signal.scoreMatchesSports || signal.hasMatchingGoal) {
        return {
          action: "USE",
          assessment: {
            capFraction: LOCKED_INCIDENT_BANKROLL_FRACTION,
            minimumNetReturn: DEFAULT_THRESHOLDS.minimumNetReturn,
            ...(marketGuard.stakeLimit !== undefined ? { stakeLimit: marketGuard.stakeLimit } : {}),
            details: `locked score guard passed ${match.homeGoals}-${match.awayGoals}; ${signal.details.join("; ")}; ${marketGuard.details}`
          }
        };
      }

      return {
        action: "SKIP",
        decision: {
          action: "NO_TRADE",
          reason: "NO_ELIGIBLE_STRATEGY",
          eventSlug: match.eventSlug,
          details: "locked score guard rejected because no confirmed score signal passed"
        }
      };
    }

    async function fetchLockedGoalSignalCheck(match: MatchState, previousMatch: MatchState | undefined): Promise<Scores365GoalSignal | null> {
      const deadline = Date.now() + LOCKED_SCORE_CONFIRM_TIMEOUT_MS;
      const scoreFallback = fetchExternalScore(match, events, clockOptions)
        .then((patch) => scorePatchToGoalSignal(patch, match))
        .catch(() => null);
      try {
        const signal = await Promise.race([
          fetchLockedGoalSignal(match, previousMatch, events, clockOptions).catch(() => null),
          sleep(LOCKED_SCORE_CONFIRM_TIMEOUT_MS).then(() => null)
        ]);
        if (signal) return signal;
      } catch {
        // Fall through to the faster score-only source below.
      }
      const remainingMs = Math.max(0, deadline - Date.now());
      return Promise.race([
        scoreFallback,
        sleep(remainingMs).then(() => null)
      ]);
    }

    async function assessLockedOrderbookDelta(
      match: MatchState,
      decision: Extract<TradeDecision, { action: "BUY" }>,
      context: LockedScoreRiskContext,
      signal: Scores365GoalSignal
    ): Promise<{ action: "USE"; details: string; stakeLimit?: number } | { action: "SKIP"; decision: NoTradeDecision }> {
      const candidates = newLockedCandidates(match, context.markets, context.thresholds.entryWindowMinutes, context.previousMatch);
      const relatedTokens = new Set(candidates.map((candidate) => candidate.tokenId));
      const decisionTokens = lockedDecisionTokenIds(decision);
      if (decisionTokens.length === 0) {
        return { action: "USE", details: "no locked decision token to delta-check" };
      }

      const relatedSeenInS1 = candidates.filter((candidate) => context.orderbooks.some((book) => book.tokenId === candidate.tokenId));
      if (candidates.length >= 2 && relatedSeenInS1.length < 2) {
        return lockedGuardSkip(match, `locked score guard rejected because related markets did not move together (${relatedSeenInS1.length}/${candidates.length} present)`);
      }

      const missingS0 = decisionTokens.filter((tokenId) => !freshCachedOrderbook(lockedOrderbookCache, tokenId));
      if (missingS0.length > 0) {
        if (requireOrderbookDelta || !signal.scoreMatchesSports) {
          return lockedGuardSkip(match, `locked score guard rejected because no pre-goal orderbook cache existed for ${missingS0.join(",")}`);
        }
        return { action: "USE", details: `score-confirmed fallback without S0 delta cache for ${missingS0.join(",")}` };
      }

      await sleep(lockedOrderbookDeltaDelayMs(env));
      const s2Results = await Promise.allSettled(decisionTokens.map((tokenId) => context.fetchOrderbook(tokenId)));
      const s2ByToken = new Map<string, OrderbookSnapshot>();
      for (let index = 0; index < decisionTokens.length; index += 1) {
        const tokenId = decisionTokens[index]!;
        const result = s2Results[index];
        if (result?.status === "fulfilled") s2ByToken.set(tokenId, result.value);
      }

      let staleNotional = 0;
      let stablePostGoalNotional = 0;
      const details: string[] = [];
      for (const tokenId of decisionTokens) {
        const s0 = freshCachedOrderbook(lockedOrderbookCache, tokenId)?.orderbook;
        const s1 = context.orderbooks.find((book) => book.tokenId === tokenId);
        const s2 = s2ByToken.get(tokenId);
        if (!s0 || !s1 || !s2) {
          return lockedGuardSkip(match, `locked score guard rejected because orderbook delta snapshots were incomplete for ${tokenId}`);
        }

        const m0 = lockedOrderbookMetrics(s0, context.thresholds.minimumNetReturn);
        const m1 = lockedOrderbookMetrics(s1, context.thresholds.minimumNetReturn);
        const m2 = lockedOrderbookMetrics(s2, context.thresholds.minimumNetReturn);
        if (m1.bestAsk !== undefined && m2.bestAsk !== undefined && m2.bestAsk < m1.bestAsk - LOCKED_ORDERBOOK_RETRACE_PRICE_TOLERANCE) {
          return lockedGuardSkip(match, `locked score guard rejected because best ask retraced for ${tokenId} from ${m1.bestAsk} to ${m2.bestAsk}`);
        }

        const tokenStablePostGoal = Math.min(m1.cheapNotional, m2.cheapNotional);
        const tokenStale = Math.min(m0.cheapNotional, tokenStablePostGoal);
        staleNotional += tokenStale;
        stablePostGoalNotional += tokenStablePostGoal;
        const grewFromS0 = m1.cheapNotional > m0.cheapNotional + LOCKED_ORDERBOOK_CHEAP_GROWTH_TOLERANCE_NOTIONAL
          || m2.cheapNotional > m0.cheapNotional + LOCKED_ORDERBOOK_CHEAP_GROWTH_TOLERANCE_NOTIONAL;
        details.push(`${tokenId} stablePostGoal=${roundForDetails(tokenStablePostGoal)} stale=${roundForDetails(tokenStale)} S0=${roundForDetails(m0.cheapNotional)} S1=${roundForDetails(m1.cheapNotional)} S2=${roundForDetails(m2.cheapNotional)}${grewFromS0 ? " grewFromS0" : ""}`);
      }

      if (requireOrderbookDelta && stablePostGoalNotional < context.thresholds.minimumNotional) {
        return lockedGuardSkip(match, `locked score guard rejected because stable post-goal liquidity ${stablePostGoalNotional} is below minimum ${context.thresholds.minimumNotional}`);
      }

      const result: { action: "USE"; details: string; stakeLimit?: number } = {
        action: "USE",
        details: `orderbook delta passed (${details.join("; ")})`
      };
      if (stablePostGoalNotional > 0) result.stakeLimit = stablePostGoalNotional;
      return result;
    }

    function lockedGuardSkip(match: MatchState, details: string): { action: "SKIP"; decision: NoTradeDecision } {
      return {
        action: "SKIP",
        decision: {
          action: "NO_TRADE",
          reason: "NO_ELIGIBLE_STRATEGY",
          eventSlug: match.eventSlug,
          details
        }
      };
    }

    async function rememberNextLockedOrderbooks(match: MatchState): Promise<void> {
      if (!isLiveLockedScoreMatch(match)) return;
      let markets: StrategyMarket[];
      try {
        markets = await sportsWatchMarkets(match.eventSlug);
      } catch {
        return;
      }
      const entryWindowMinutes = args.entryWindowMinutes ?? DEFAULT_THRESHOLDS.entryWindowMinutes;
      const nextMatches = [
        { ...match, homeGoals: match.homeGoals + 1 },
        { ...match, awayGoals: match.awayGoals + 1 }
      ];
      const tokenIds = [...new Set(nextMatches.flatMap((nextMatch) =>
        newLockedCandidates(nextMatch, markets, entryWindowMinutes, match).map((candidate) => candidate.tokenId)
      ))];
      if (tokenIds.length === 0) return;
      const fetcher = deps.fetchOrderbook ?? fetchOrderbook;
      const results = await Promise.allSettled(tokenIds.map((tokenId) => fetcher(tokenId)));
      const now = Date.now();
      for (let index = 0; index < tokenIds.length; index += 1) {
        const result = results[index];
        if (result?.status !== "fulfilled") continue;
        lockedOrderbookCache.set(tokenIds[index]!, {
          observedAt: now,
          orderbook: result.value
        });
      }
      pruneLockedOrderbookCache(lockedOrderbookCache, now);
    }

    async function sportsWatchMarkets(eventSlug: string): Promise<StrategyMarket[]> {
      if (args.marketsFile) {
        marketsFileCache ??= await readJsonFile<StrategyMarket[]>(args.marketsFile);
        return marketsFileCache.filter((market) => market.eventSlug === eventSlug);
      }
      return streamDeps.fetchEventStrategyMarkets!(eventSlug);
    }

    function rememberLockedIncidentSpend(value: Record<string, unknown>, lockedIncident: LockedScoreIncident | undefined): void {
      if (!lockedIncident || !isCompletedTradeSummary(value)) return;
      const decision = buyDecisionFromSummary(value);
      if (!decision || decision.locked !== true || !isLockedStrategy(decision.strategy)) return;
      const notional = executedNotional(value);
      if (!isPositiveNumber(notional)) return;
      const budget = lockedIncidentBudgets.get(lockedIncident.key);
      if (!budget) {
        lockedIncidentBudgets.set(lockedIncident.key, {
          bankroll: notional / LOCKED_INCIDENT_BANKROLL_FRACTION,
          spent: notional
        });
        return;
      }
      budget.spent += notional;
    }

    function executedNotional(value: Record<string, unknown>): number | undefined {
      const trade = value.trade;
      if (isRecord(trade) && isPositiveNumber(trade.notional)) return trade.notional;
      return isPositiveNumber(value.notional) ? value.notional : undefined;
    }

    function rememberScoreIncident(match: MatchState): ScoreIncidentContext {
      if (!isLiveLockedScoreMatch(match)) return { action: "none" };
      const previous = observedScores.get(match.eventSlug);
      const score = scorePair(match);

      if (!previous) {
        observedScores.set(match.eventSlug, match);
        if (goalsTotal(match) <= 0) return { action: "none" };
        return createLockedScoreIncident(match, zeroScoreMatch(match));
      }

      if (sameScore(previous, match)) {
        observedScores.set(match.eventSlug, match);
        const current = currentLockedIncidents.get(match.eventSlug);
        if (current && current.homeGoals === match.homeGoals && current.awayGoals === match.awayGoals) {
          return { action: "locked_incident", incident: current };
        }
        return { action: "none" };
      }

      observedScores.set(match.eventSlug, match);
      if (scoreIncreased(previous, match)) {
        return createLockedScoreIncident(match, previous);
      }

      currentLockedIncidents.delete(match.eventSlug);
      return {
        action: "blocked",
        details: `Locked score suppressed because sports score moved from ${scorePair(previous)} to ${score}`
      };
    }

    function createLockedScoreIncident(match: MatchState, previousMatch: MatchState): ScoreIncidentContext {
      const sequence = (incidentSequences.get(match.eventSlug) ?? 0) + 1;
      incidentSequences.set(match.eventSlug, sequence);
      const incident: CurrentScoreIncidentState = {
        key: `${match.eventSlug}:${sequence}:${scorePair(match)}`,
        previousMatch,
        homeGoals: match.homeGoals,
        awayGoals: match.awayGoals
      };
      currentLockedIncidents.set(match.eventSlug, incident);
      return { action: "locked_incident", incident };
    }

    function scoreIncreased(previous: MatchState, current: MatchState): boolean {
      return current.homeGoals >= previous.homeGoals
        && current.awayGoals >= previous.awayGoals
        && goalsTotal(current) > goalsTotal(previous);
    }

    function sameScore(left: MatchState, right: MatchState): boolean {
      return left.homeGoals === right.homeGoals && left.awayGoals === right.awayGoals;
    }

    function scorePair(match: Pick<MatchState, "homeGoals" | "awayGoals">): string {
      return `${match.homeGoals}-${match.awayGoals}`;
    }

    function goalsTotal(match: Pick<MatchState, "homeGoals" | "awayGoals">): number {
      return match.homeGoals + match.awayGoals;
    }

    function zeroScoreMatch(match: MatchState): MatchState {
      return { ...match, homeGoals: 0, awayGoals: 0 };
    }

    async function processSportsWatchMatch(
      match: MatchState,
      incidentContext: ScoreIncidentContext
    ): Promise<{ result: CliResult; last: Record<string, unknown>; match: MatchState; executed: boolean; lockedIncident?: LockedScoreIncident }> {
      const clockPatch = match.remainingSecondsSource === "365scores_added_time_precise_game_time" || !shouldPollVerifiedClock(match)
        ? null
        : await maybeFetchVerifiedClock(fetchVerifiedClock, match, events, clockOptions);
      const timedMatch = clockPatch ? { ...match, ...clockPatch } : match;
      if (incidentContext.action === "blocked") {
        const result = ok(summary(args.mode, {
          action: "NO_TRADE",
          reason: "NO_ELIGIBLE_STRATEGY",
          eventSlug: timedMatch.eventSlug,
          details: incidentContext.details
        }));
        return {
          result,
          last: JSON.parse(result.stdout) as Record<string, unknown>,
          match: timedMatch,
          executed: false
        };
      }
      const executeNow = candidateCompareWaitMs === undefined;
      const lockedIncident = incidentContext.action === "locked_incident" ? incidentContext.incident : undefined;
      const singlePassOptions = singlePassOptionsForLockedIncident(lockedIncident);
      if (!executeNow) singlePassOptions.executeTrade = false;
      let result: CliResult;
      try {
        result = await runSinglePass({ ...args, eventSlug: timedMatch.eventSlug }, env, {
          ...streamDeps,
          fetchMatchState: async () => timedMatch
        }, singlePassOptions);
      } catch (error) {
        if (!executeNow) throw error;
        rememberSportsWatchExecutionError(timedMatch, error);
        result = ok(last ?? sportsWatchExecutionErrorSummary(timedMatch, error));
      }
      const processed = {
        result,
        last: JSON.parse(result.stdout) as Record<string, unknown>,
        match: timedMatch,
        executed: executeNow
      };
      if (lockedIncident) return { ...processed, lockedIncident };
      return processed;
    }

    async function handleSportsWatchDecision(processed: { result: CliResult; last: Record<string, unknown>; match: MatchState; executed: boolean; lockedIncident?: LockedScoreIncident }): Promise<CliResult | undefined> {
      last = processed.last;
      if (processed.result.exitCode !== 0) return processed.result;

      if (processed.executed) {
        pendingBuys.delete(processed.match.eventSlug);
        rememberLockedIncidentSpend(processed.last, processed.lockedIncident);
        rememberSportsWatchTradeOutcome(processed.last, processed.match);
        return undefined;
      }

      const decision = buyDecisionFromSummary(processed.last);
      if (!decision) {
        pendingBuys.delete(processed.match.eventSlug);
        return undefined;
      }

      if (candidateCompareWaitMs === undefined) {
        pendingBuys.delete(processed.match.eventSlug);
        return executeAndRememberSportsWatchMatch(processed.match, processed.lockedIncident);
      }

      if (decision.estimatedNetReturn >= instantBuyNetReturn) {
        pendingBuys.delete(processed.match.eventSlug);
        return executeAndRememberSportsWatchMatch(processed.match, processed.lockedIncident);
      }

      rememberPendingBuy(processed.match, decision, Date.now(), processed.lockedIncident);
      return undefined;
    }

    function rememberPendingBuy(
      match: MatchState,
      decision: Extract<TradeDecision, { action: "BUY" }>,
      now: number,
      lockedIncident: LockedScoreIncident | undefined
    ): void {
      const existing = pendingBuys.get(match.eventSlug);
      const pending: PendingBuy = {
        eventSlug: match.eventSlug,
        match,
        firstSeenAt: existing?.firstSeenAt ?? now,
        updatedAt: now,
        decision
      };
      if (lockedIncident) {
        pending.lockedIncidentKey = lockedIncident.key;
        pending.lockedIncidentPreviousMatch = lockedIncident.previousMatch;
      }
      pendingBuys.set(match.eventSlug, pending);
    }

    async function maybeExecuteDeferredBuy(now: number): Promise<CliResult | undefined> {
      if (pendingBuys.size === 0) return undefined;
      if (candidateCompareWaitMs === undefined) return undefined;
      const oldestFirstSeenAt = Math.min(...[...pendingBuys.values()].map((pending) => pending.firstSeenAt));
      if (now - oldestFirstSeenAt < candidateCompareWaitMs) return undefined;

      const ranked = [...pendingBuys.values()].sort((a, b) => {
        const returnDelta = b.decision.estimatedNetReturn - a.decision.estimatedNetReturn;
        if (returnDelta !== 0) return returnDelta;
        return (b.decision.lossRequiresGoals ?? 0) - (a.decision.lossRequiresGoals ?? 0);
      });

      for (const pending of ranked) {
        pendingBuys.delete(pending.eventSlug);
        const lockedIncident = pending.lockedIncidentKey && pending.lockedIncidentPreviousMatch
          ? { key: pending.lockedIncidentKey, previousMatch: pending.lockedIncidentPreviousMatch }
          : undefined;
        const fatal = await executeAndRememberSportsWatchMatch(pending.match, lockedIncident);
        if (fatal) return fatal;
        if (last?.status !== "no_trade") return undefined;
      }

      return undefined;
    }

    async function executeAndRememberSportsWatchMatch(match: MatchState, lockedIncident?: LockedScoreIncident): Promise<CliResult | undefined> {
      let result: CliResult;
      try {
        result = await executeSportsWatchMatch(match, lockedIncident);
      } catch (error) {
        rememberSportsWatchExecutionError(match, error);
        return undefined;
      }
      if (result.exitCode !== 0) {
        rememberSportsWatchExecutionError(match, result.stderr);
        return undefined;
      }
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      last = parsed;
      rememberLockedIncidentSpend(parsed, lockedIncident);
      rememberSportsWatchTradeOutcome(parsed, match);
      return undefined;
    }

    async function executeSportsWatchMatch(match: MatchState, lockedIncident?: LockedScoreIncident): Promise<CliResult> {
      return runSinglePass({ ...args, eventSlug: match.eventSlug }, env, {
        ...streamDeps,
        fetchMatchState: async () => match
      }, singlePassOptionsForLockedIncident(lockedIncident));
    }

    function rememberSportsWatchTradeOutcome(value: Record<string, unknown>, match: MatchState): void {
      if (!isCompletedTradeSummary(value)) return;
      if (shouldKeepRefillingLockedEvent(value, match)) {
        refillEventSlugs.add(match.eventSlug);
        activeMatches.set(match.eventSlug, match);
        pendingBuys.delete(match.eventSlug);
        return;
      }
      completedEventSlugs.add(match.eventSlug);
      activeMatches.delete(match.eventSlug);
      pendingBuys.delete(match.eventSlug);
      refillEventSlugs.delete(match.eventSlug);
    }

    function rememberSportsWatchExecutionError(match: MatchState, error: unknown): void {
      const details = error instanceof Error ? error.message : String(error);
      console.error(`SPORTS_WATCH_EXECUTION_FAILED event=${match.eventSlug} details=${details}`);
      last = sportsWatchExecutionErrorSummary(match, error);
      activeMatches.delete(match.eventSlug);
      pendingBuys.delete(match.eventSlug);
      refillEventSlugs.delete(match.eventSlug);
    }

    function sportsWatchExecutionErrorSummary(match: MatchState, error: unknown): Record<string, unknown> {
      const details = error instanceof Error ? error.message : String(error);
      return {
        mode: args.mode,
        status: "execution_error",
        action: "NO_TRADE",
        reason: "EXECUTION_FAILED",
        eventSlug: match.eventSlug,
        details
      };
    }

    async function fetchActiveMatchSnapshot(match: MatchState): Promise<MatchState | null> {
      try {
        return await (deps.fetchMatchState ?? fetchEventMatchState)(match.eventSlug);
      } catch {
        return null;
      }
    }
  }
}

type SportsWatchInput =
  | { type: "update"; result: IteratorResult<MatchState> }
  | { type: "clock_poll" };

async function nextSportsWatchInput(
  updatePromise: Promise<IteratorResult<MatchState>> | undefined,
  shouldPollClock: boolean,
  intervalMs: number
): Promise<SportsWatchInput> {
  const waits: Promise<SportsWatchInput>[] = [];
  if (updatePromise) waits.push(updatePromise.then((result) => ({ type: "update", result })));
  if (shouldPollClock) waits.push(sleep(intervalMs).then(() => ({ type: "clock_poll" })));
  if (waits.length === 0) return { type: "update", result: { done: true, value: undefined } };
  return Promise.race(waits);
}

function rememberClockPollMatch(activeMatches: Map<string, MatchState>, match: MatchState): void {
  if (!isLiveLockedScoreMatch(match)) {
    activeMatches.delete(match.eventSlug);
    return;
  }
  activeMatches.set(match.eventSlug, match);
}

function shouldPollVerifiedClock(match: MatchState): boolean {
  if (match.remainingSeconds !== undefined) return true;
  if (match.elapsedSeconds !== undefined) return match.elapsedSeconds >= 85 * 60;
  return match.minute >= 85;
}

function verifiedClockPollIntervalMs(args: ParsedArgs): number {
  return Math.max(1, Math.min(args.intervalMs ?? MAX_VERIFIED_CLOCK_POLL_INTERVAL_MS, MAX_VERIFIED_CLOCK_POLL_INTERVAL_MS));
}

async function seedLateActiveMatches(
  activeMatches: Map<string, MatchState>,
  events: readonly WorldCupEventRef[],
  deps: CliDependencies,
  nowMs = Date.now()
): Promise<void> {
  const lateEvents = events.filter((event) => shouldSeedLateActiveMatch(event, nowMs));
  if (lateEvents.length === 0) return;

  const fetchMatchState = deps.fetchMatchState ?? fetchEventMatchState;
  const snapshots = await Promise.allSettled(lateEvents.map((event) => fetchMatchState(event.eventSlug)));
  for (const snapshot of snapshots) {
    if (snapshot.status !== "fulfilled") continue;
    rememberClockPollMatch(activeMatches, snapshot.value);
  }
}

function shouldSeedLateActiveMatch(event: WorldCupEventRef, nowMs: number): boolean {
  if (!event.startTime) return false;
  const startMs = Date.parse(event.startTime);
  if (!Number.isFinite(startMs)) return false;
  const elapsedMs = nowMs - startMs;
  return elapsedMs >= 80 * 60_000 && elapsedMs <= 180 * 60_000;
}

function buyDecisionFromSummary(value: Record<string, unknown>): Extract<TradeDecision, { action: "BUY" }> | undefined {
  const decision = value.decision;
  if (!isRecord(decision) || decision.action !== "BUY") return undefined;
  return decision as unknown as Extract<TradeDecision, { action: "BUY" }>;
}

function isCompletedTradeSummary(value: Record<string, unknown>): boolean {
  return value.status === "filled" || value.status === "partial" || value.status === "posted";
}

function shouldKeepRefillingLockedEvent(value: Record<string, unknown>, match: MatchState): boolean {
  if (value.status !== "filled" && value.status !== "partial") return false;
  if (!isPositiveNumber(value.notional) && !isPositiveNumber(value.shares)) return false;
  const decision = buyDecisionFromSummary(value);
  if (!decision || decision.locked !== true || !isLockedStrategy(decision.strategy)) return false;
  return isLiveLockedScoreMatch(match);
}

function scorePatchToGoalSignal(patch: Partial<MatchState> | null, match: MatchState): Scores365GoalSignal | null {
  if (!patch || !isFiniteNumber(patch.homeGoals) || !isFiniteNumber(patch.awayGoals)) return null;
  return {
    homeGoals: patch.homeGoals,
    awayGoals: patch.awayGoals,
    scores365GameId: isFiniteNumber(patch.scores365GameId) ? patch.scores365GameId : match.scores365GameId ?? 0,
    scoreMatchesSports: patch.homeGoals === match.homeGoals && patch.awayGoals === match.awayGoals,
    hasMatchingGoal: false,
    hasNoGoalSignal: false,
    hasVarReviewSignal: false,
    details: ["365 score-only signal"]
  };
}

function newLockedCandidates(
  match: MatchState,
  markets: readonly StrategyMarket[],
  entryWindowMinutes: number,
  previousMatch?: MatchState
): SelectedStrategyMarket[] {
  return selectLossRequiresCandidates(match, markets, {
    entryWindowMinutes,
    allowLockedOutsideEntryWindow: true
  }).filter((candidate) =>
    candidate.locked === true && (!previousMatch || !lockedConditionMatchesScore(previousMatch, candidate))
  );
}

function lockedDecisionTokenIds(decision: Extract<TradeDecision, { action: "BUY" }>): string[] {
  const legs = decision.legs?.length ? decision.legs : [decision];
  return [...new Set(legs
    .filter((leg) => leg.locked === true)
    .map((leg) => leg.tokenId))];
}

function freshCachedOrderbook(cache: Map<string, CachedOrderbook>, tokenId: string, now = Date.now()): CachedOrderbook | undefined {
  const cached = cache.get(tokenId);
  if (!cached) return undefined;
  if (now - cached.observedAt > LOCKED_ORDERBOOK_CACHE_TTL_MS) {
    cache.delete(tokenId);
    return undefined;
  }
  return cached;
}

function pruneLockedOrderbookCache(cache: Map<string, CachedOrderbook>, now = Date.now()): void {
  for (const [tokenId, cached] of cache) {
    if (now - cached.observedAt > LOCKED_ORDERBOOK_CACHE_TTL_MS) cache.delete(tokenId);
  }
}

function lockedOrderbookMetrics(orderbook: OrderbookSnapshot, minimumNetReturn: number): { bestAsk?: number; cheapNotional: number } {
  const validAsks = orderbook.asks
    .filter((ask) => Number.isFinite(ask.price)
      && Number.isFinite(ask.size)
      && ask.price > 0
      && ask.price < 1
      && ask.size > 0)
    .sort((a, b) => a.price - b.price);
  const bestAsk = validAsks[0]?.price;
  const cheapNotional = validAsks
    .filter((ask) => ask.price >= 0.8 && safeNetReturnRate(ask.price) >= minimumNetReturn)
    .reduce((total, ask) => total + ask.price * ask.size, 0);
  return bestAsk === undefined ? { cheapNotional } : { bestAsk, cheapNotional };
}

function safeNetReturnRate(price: number): number {
  try {
    return netReturnRate(price);
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

function lockedOrderbookDeltaDelayMs(env: Record<string, string | undefined>): number {
  if ((env.NODE_ENV ?? process.env.NODE_ENV) === "test") return 0;
  return numberEnv(env.POLY_LOCKED_ORDERBOOK_DELTA_DELAY_MS) ?? LOCKED_ORDERBOOK_DELTA_DELAY_MS;
}

function roundForDetails(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function minDefined(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length === 0 ? undefined : Math.min(...defined);
}

function isLiveLockedScoreMatch(match: MatchState): boolean {
  return match.isLive
    && match.ended !== true
    && (match.period === "1H" || match.period === "HT" || match.period === "2H" || match.period === "ET");
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

async function fetchWorldCupEventRefs(deps: CliDependencies): Promise<WorldCupEventRef[]> {
  if (deps.fetchWorldCupEventRefs) return deps.fetchWorldCupEventRefs();
  if (deps.fetchWorldCupEventSlugs) {
    return (await deps.fetchWorldCupEventSlugs()).map((eventSlug) => ({ eventSlug }));
  }
  return fetchOpenWorldCupEventRefs();
}

function cachedStrategyMarketFetcher(
  fetcher: (eventSlug: string) => Promise<StrategyMarket[]>
): (eventSlug: string) => Promise<StrategyMarket[]> {
  const cache = new Map<string, Promise<StrategyMarket[]>>();
  return (eventSlug: string) => {
    let promise = cache.get(eventSlug);
    if (!promise) {
      promise = fetcher(eventSlug)
        .then((markets) => {
          if (!hasLockedGoalStrategyMarkets(markets)) cache.delete(eventSlug);
          return markets;
        })
        .catch((error) => {
          cache.delete(eventSlug);
          throw error;
        });
      cache.set(eventSlug, promise);
    }
    return promise;
  };
}

function sportsUpdateOptions(args: ParsedArgs, env: Record<string, string | undefined>): { auditFile?: string; proxyUrl?: string } {
  const options: { auditFile?: string; proxyUrl?: string } = {};
  const auditFile = args.liveAuditFile ?? env.POLY_LIVE_AUDIT_FILE;
  const proxyUrl = proxyFromEnv(env);
  if (auditFile) options.auditFile = auditFile;
  if (proxyUrl) options.proxyUrl = proxyUrl;
  return options;
}

function verifiedClockOptions(env: Record<string, string | undefined>): { proxyUrl?: string; timezoneName?: string } {
  const options: { proxyUrl?: string; timezoneName?: string } = {};
  const proxyUrl = proxyFromEnv(env);
  if (proxyUrl) options.proxyUrl = proxyUrl;
  const timezoneName = env.POLY_365SCORES_TIMEZONE;
  if (timezoneName) options.timezoneName = timezoneName;
  return options;
}

function autoSettlementMonitor(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
  deps: CliDependencies
): AutoSettlementMonitor | undefined {
  if (args.mode !== "live") return undefined;
  if (booleanEnv(env.POLY_AUTO_REDEEM) === false) return undefined;

  const liveConfig = liveConfigFromEnv(env);
  const walletAddress = liveConfig.depositWalletAddress ?? liveConfig.funderAddress;
  if (!walletAddress || !liveConfig.privateKey) return undefined;

  const config: SettlementConfig = {
    enabled: true,
    walletAddress,
    privateKey: liveConfig.privateKey,
    relayerUrl: env.POLY_RELAYER_URL ?? DEFAULT_POLYMARKET_RELAYER_URL,
    chainId: liveConfig.chainId,
    rpcUrl: liveConfig.rpcUrl ?? DEFAULT_POLYGON_RPC_URL,
    intervalMs: numberEnv(env.POLY_AUTO_REDEEM_INTERVAL_MS) ?? 60_000,
    deadlineSeconds: numberEnv(env.POLY_AUTO_REDEEM_DEADLINE_SECONDS) ?? 600,
    sizeThreshold: numberEnv(env.POLY_AUTO_REDEEM_SIZE_THRESHOLD) ?? 0.000001
  };
  const ownerAddress = env.POLY_RELAYER_API_KEY_ADDRESS ?? env.RELAYER_API_KEY_ADDRESS;
  if (ownerAddress) config.ownerAddress = ownerAddress;
  const relayerApiKey = env.POLY_RELAYER_API_KEY ?? env.RELAYER_API_KEY;
  if (relayerApiKey) config.relayerApiKey = relayerApiKey;
  if (ownerAddress) config.relayerApiKeyAddress = ownerAddress;
  const builderApiKey = env.POLY_BUILDER_API_KEY;
  const builderApiSecret = env.POLY_BUILDER_API_SECRET;
  const builderPassphrase = env.POLY_BUILDER_PASSPHRASE;
  if (builderApiKey) config.builderApiKey = builderApiKey;
  if (builderApiSecret) config.builderApiSecret = builderApiSecret;
  if (builderPassphrase) config.builderPassphrase = builderPassphrase;
  const proxyUrl = proxyFromEnv(env);
  if (proxyUrl) config.proxyUrl = proxyUrl;

  const monitorDeps: ConstructorParameters<typeof AutoSettlementMonitor>[1] = {};
  if (deps.fetchRedeemablePositions) monitorDeps.fetchRedeemablePositions = deps.fetchRedeemablePositions;
  if (deps.submitDepositWalletBatch) monitorDeps.submitDepositWalletBatch = deps.submitDepositWalletBatch;
  if (deps.settleRedeemablePositions) monitorDeps.settle = (settlementConfig) => deps.settleRedeemablePositions!(settlementConfig);
  if (deps.fetchMarketSettlementStatus) monitorDeps.fetchMarketSettlementStatus = deps.fetchMarketSettlementStatus;
  if (deps.readConditionalTokenBalance) monitorDeps.readConditionalTokenBalance = deps.readConditionalTokenBalance;
  const ledgerFile = resolveLedgerFile(args, env);
  if (ledgerFile) {
    const ledger = new LiveLedger(ledgerFile);
    monitorDeps.readActiveLedgerEntries = () => ledger.readActiveEntries();
    monitorDeps.markRedeemedConditionIds = (conditionIds) => ledger.markRedeemedByConditionIds(conditionIds);
  }
  monitorDeps.onError = deps.onSettlementError ?? ((error) => {
    console.error(`AUTO_REDEEM_FAILED: ${error instanceof Error ? error.message : String(error)}`);
  });
  return new AutoSettlementMonitor(config, monitorDeps);
}

function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === "fetch failed" || error.name === "AbortError" || error.name === "TimeoutError";
}

function defaultVerifiedClockFetcher(options: { proxyUrl?: string; timezoneName?: string }) {
  const provider = new Scores365ClockProvider(options);
  return async (match: MatchState): Promise<Partial<MatchState> | null> => provider.fetchClock(match);
}

async function overlayVerifiedClockForSinglePass(
  match: MatchState,
  args: ParsedArgs,
  env: Record<string, string | undefined>,
  deps: CliDependencies
): Promise<MatchState> {
  if (args.matchFile || match.remainingSecondsSource === "365scores_added_time_precise_game_time") return match;
  if (!shouldPollVerifiedClock(match)) return match;

  const clockOptions = verifiedClockOptions(env);
  const fetchVerifiedClock = deps.fetchVerifiedClock ?? (deps.fetchMatchState ? undefined : defaultVerifiedClockFetcher(clockOptions));
  if (!fetchVerifiedClock) return match;

  const clockPatch = await maybeFetchVerifiedClock(fetchVerifiedClock, match, [eventRefFromMatch(match)], clockOptions);
  return clockPatch ? { ...match, ...clockPatch } : match;
}

function eventRefFromMatch(match: MatchState): WorldCupEventRef {
  const ref: WorldCupEventRef = {
    eventSlug: match.eventSlug,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam
  };
  if (match.gameId !== undefined) ref.gameId = match.gameId;
  if (match.sportradarGameId) ref.sportradarGameId = match.sportradarGameId;
  if (match.startTime) ref.startTime = match.startTime;
  return ref;
}

async function maybeFetchVerifiedClock(
  fetchVerifiedClock: (match: MatchState, events: readonly WorldCupEventRef[], options: { proxyUrl?: string; timezoneName?: string }) => Promise<Partial<MatchState> | null>,
  match: MatchState,
  events: readonly WorldCupEventRef[],
  options: { proxyUrl?: string; timezoneName?: string }
): Promise<Partial<MatchState> | null> {
  if (match.period !== "2H" || !match.isLive || match.ended === true) return null;
  try {
    return sanitizeVerifiedClockPatch(await fetchVerifiedClock(match, events, options));
  } catch {
    return null;
  }
}

function sanitizeVerifiedClockPatch(patch: Partial<MatchState> | null): Partial<MatchState> | null {
  if (!patch) return null;
  const safe: Partial<MatchState> = {};
  if (isFiniteNumber(patch.remainingSeconds)) safe.remainingSeconds = patch.remainingSeconds;
  if (patch.remainingSecondsSource === "365scores_added_time_precise_game_time") {
    safe.remainingSecondsSource = patch.remainingSecondsSource;
  }
  if (isFiniteNumber(patch.elapsedSeconds)) safe.elapsedSeconds = patch.elapsedSeconds;
  if (isFiniteNumber(patch.minute)) safe.minute = patch.minute;
  if (isFiniteNumber(patch.scores365GameId) && patch.scores365GameId > 0) {
    safe.scores365GameId = patch.scores365GameId;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

async function defaultSportsUpdates(
  events: readonly WorldCupEventRef[],
  options: { auditFile?: string; proxyUrl?: string }
): Promise<AsyncIterable<MatchState>> {
  const queue: MatchState[] = [];
  let failure: Error | undefined;
  let closed = false;
  let socketClosed = false;
  let localCloseRequested = false;
  let pending: (() => void) | undefined;
  let socket: ReturnType<SportsLiveProvider["connect"]> | undefined;

  const wake = (): void => {
    pending?.();
    pending = undefined;
  };
  const closeSocket = (): void => {
    if (socketClosed) return;
    localCloseRequested = true;
    socketClosed = true;
    try {
      socket?.close();
    } catch {
      // The socket may already be closed by the remote endpoint.
    }
  };
  const fail = (error: unknown): void => {
    failure ??= toError(error, "Sports live provider failed");
    closed = true;
    closeSocket();
    wake();
  };

  const providerOptions = {
    events,
    onError: fail,
    ...(options.auditFile !== undefined ? { auditFile: options.auditFile } : {}),
    ...(options.proxyUrl !== undefined ? { proxyUrl: options.proxyUrl } : {})
  };
  socket = new SportsLiveProvider(providerOptions).connect((update) => {
    queue.push(update);
    wake();
  });

  socket.addEventListener("close", (event) => {
    if (!localCloseRequested) failure ??= remoteCloseError(event);
    closed = true;
    closeSocket();
    wake();
  });
  socket.addEventListener("error", fail);

  async function* stream(): AsyncIterable<MatchState> {
    try {
      while (true) {
        if (failure) throw failure;
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (failure) throw failure;
        if (closed) return;
        await new Promise<void>((resolve) => {
          pending = resolve;
        });
      }
    } finally {
      closeSocket();
    }
  }

  return stream();
}

function toError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  if (isRecord(error) && error.error instanceof Error) return error.error;
  const message = isRecord(error) && typeof error.error === "string"
    ? error.error
    : typeof error === "string"
      ? error
      : fallback;
  return new Error(message);
}

function remoteCloseError(event: unknown): Error {
  if (!isRecord(event)) return new Error("Sports live WebSocket closed unexpectedly");
  const code = typeof event.code === "number" ? event.code : undefined;
  const reason = typeof event.reason === "string" ? event.reason : "";
  const details = [
    code !== undefined ? `code=${code}` : undefined,
    reason ? `reason=${reason}` : undefined
  ].filter((part): part is string => part !== undefined);
  return new Error(`Sports live WebSocket closed unexpectedly${details.length ? ` (${details.join(" ")})` : ""}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function proxyFromEnv(env: Record<string, string | undefined>): string | undefined {
  for (const value of [env.HTTPS_PROXY, env.HTTP_PROXY, env.https_proxy, env.http_proxy]) {
    if (value) return value;
  }
  return undefined;
}

async function runStatus(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
  deps: CliDependencies
): Promise<CliResult> {
  const liveConfig = liveConfigFromEnv(env);
  const walletAddress = liveConfig.depositWalletAddress ?? liveConfig.funderAddress;
  const ledgerFile = resolveLedgerFile(args, env) ?? "data/live-ledger.json";
  const entries = await new LiveLedger(ledgerFile).readEntries();
  const status: Record<string, unknown> = {
    mode: "status",
    status: "ok",
    ledger: {
      file: ledgerFile,
      entries: entries.length,
      active: entries.filter((entry) => isActiveLedgerStatus(entry.status)).length
    }
  };

  if (walletAddress) {
    status.depositWalletAddress = walletAddress;
    status.pusdBalance = await (deps.readPusdBalance ?? readPusdBalance)(walletAddress, liveConfig.rpcUrl);
  }

  return ok(status);
}

function ok(value: unknown): CliResult {
  return { exitCode: 0, stdout: `${JSON.stringify(value, null, 2)}\n`, stderr: "" };
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchCandidateOrderbooks(
  match: MatchState,
  markets: readonly StrategyMarket[],
  entryWindowMinutes: number,
  orderbookFetcherOverride?: ((tokenId: string) => Promise<OrderbookSnapshot>),
  fetcher: (tokenId: string) => Promise<OrderbookSnapshot> = fetchOrderbook
): Promise<OrderbookSnapshot[]> {
  const orderbookFetcher = typeof orderbookFetcherOverride === "function" ? orderbookFetcherOverride : fetcher;
  const candidates = selectLossRequiresCandidates(match, markets, {
    entryWindowMinutes,
    allowLockedOutsideEntryWindow: true
  });
  const tokenIds = [...new Set(candidates.map((candidate) => candidate.tokenId))];
  const results = await Promise.allSettled(tokenIds.map((tokenId) => orderbookFetcher(tokenId)));
  return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
}

function hasNewLockedIncidentCandidate(
  match: MatchState,
  markets: readonly StrategyMarket[],
  entryWindowMinutes: number,
  previousMatch: MatchState
): boolean {
  return selectLossRequiresCandidates(match, markets, {
    entryWindowMinutes,
    allowLockedOutsideEntryWindow: true
  }).some((candidate) =>
    candidate.locked === true && !lockedConditionMatchesScore(previousMatch, candidate)
  );
}

function stakeLimitedArgs(args: ParsedArgs, stakeLimit: number): ParsedArgs {
  const stake = args.stake !== undefined ? Math.min(args.stake, stakeLimit) : stakeLimit;
  return { ...args, stake };
}

interface DepthAuditInput {
  match: MatchState;
  markets: readonly StrategyMarket[];
  orderbooks: readonly OrderbookSnapshot[];
  thresholds: DecisionThresholds;
  decision: TradeDecision;
}

async function writeDepthAudit(
  args: ParsedArgs,
  env: Record<string, string | undefined>,
  input: DepthAuditInput
): Promise<void> {
  const file = resolveDepthAuditFile(args, env);
  if (!file) return;

  const record = {
    timestamp: new Date().toISOString(),
    mode: args.mode,
    eventSlug: input.match.eventSlug,
    match: input.match,
    thresholds: input.thresholds,
    candidates: depthAuditCandidates(input.match, input.markets, input.thresholds),
    orderbooks: input.orderbooks,
    decision: input.decision
  };

  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.error(`DEPTH_AUDIT_FAILED file=${file} details=${error instanceof Error ? error.message : String(error)}`);
  }
}

function depthAuditCandidates(
  match: MatchState,
  markets: readonly StrategyMarket[],
  thresholds: DecisionThresholds
): SelectedStrategyMarket[] {
  return selectLossRequiresCandidates(match, markets, {
    entryWindowMinutes: thresholds.entryWindowMinutes,
    allowLockedOutsideEntryWindow: true
  });
}

async function resolveStake(
  args: ParsedArgs,
  match: MatchState,
  env: Record<string, string | undefined>,
  liveConfig: LiveExecutorConfig | undefined,
  deps: CliDependencies
): Promise<{ action: "USE_STAKE"; stake: number } | { action: "NO_TRADE"; decision: NoTradeDecision }> {
  if (args.mode !== "live" || !liveConfig || !shouldUseLiveBalance(args, env, liveConfig)) {
    if (args.stake !== undefined) return { action: "USE_STAKE", stake: args.stake };
    throw new Error("--stake is required unless live balance sizing is enabled");
  }

  const walletAddress = liveConfig.depositWalletAddress ?? liveConfig.funderAddress;
  if (!walletAddress) {
    if (args.stake !== undefined) return { action: "USE_STAKE", stake: args.stake };
    throw new Error("--stake is required unless POLY_DEPOSIT_WALLET_ADDRESS or POLY_FUNDER_ADDRESS is configured");
  }

  const balance = await (deps.readPusdBalance ?? readPusdBalance)(walletAddress, liveConfig.rpcUrl);
  const stakeDecision = capStakeToAvailableBalance(args.stake, balance, {
    minimumNotional: args.minimumNotional ?? DEFAULT_THRESHOLDS.minimumNotional,
    buffer: args.balanceBuffer ?? numberEnv(env.POLY_BALANCE_BUFFER) ?? 0.02
  });
  if (stakeDecision.action === "USE_STAKE") return stakeDecision;

  return {
    action: "NO_TRADE",
    decision: {
      action: "NO_TRADE",
      reason: stakeDecision.reason,
      eventSlug: match.eventSlug,
      details: stakeDecision.details
    }
  };
}

function shouldUseLiveBalance(args: ParsedArgs, env: Record<string, string | undefined>, liveConfig: LiveExecutorConfig): boolean {
  if (args.useLiveBalance !== undefined) return args.useLiveBalance;
  const envChoice = booleanEnv(env.POLY_USE_LIVE_BALANCE);
  if (envChoice !== undefined) return envChoice;
  return Boolean(liveConfig.depositWalletAddress ?? liveConfig.funderAddress);
}

function resolveLedgerFile(args: ParsedArgs, env: Record<string, string | undefined>): string | undefined {
  if (args.ledgerFile) return args.ledgerFile;
  if (args.mode === "live" || args.mode === "status") return env.POLY_LEDGER_FILE ?? "data/live-ledger.json";
  return undefined;
}

function resolveDepthAuditFile(args: ParsedArgs, env: Record<string, string | undefined>): string | undefined {
  if (args.depthAuditFile) return args.depthAuditFile;
  if (env.POLY_DEPTH_AUDIT_FILE) return env.POLY_DEPTH_AUDIT_FILE;
  if ((env.NODE_ENV ?? process.env.NODE_ENV) === "test") return undefined;
  if (args.mode === "live" && booleanEnv(env.POLY_DEPTH_AUDIT_ENABLED) !== false) return "data/live-depth-audit.ndjson";
  return undefined;
}

function liveExecuteOptions(args: ParsedArgs, thresholds: DecisionThresholds, deps: CliDependencies): LiveExecuteOptions {
  return {
    orderType: args.orderType,
    refreshOrderbook: deps.fetchOrderbook ?? fetchOrderbook,
    minimumNotional: thresholds.minimumNotional,
    minimumNetReturn: thresholds.minimumNetReturn,
    maxEntryPrice: thresholds.maxEntryPrice
  };
}

function summary(mode: Mode, decision: TradeDecision, trade?: TradeResult): Record<string, unknown> {
  if (decision.action !== "BUY") {
    return {
      mode,
      status: "no_trade",
      action: decision.action,
      reason: decision.reason,
      eventSlug: decision.eventSlug,
      details: decision.details,
      decision
    };
  }

  return {
    mode,
    status: trade?.status ?? "decision_only",
    action: decision.action,
    eventSlug: decision.eventSlug,
    marketSlug: decision.marketSlug,
    tokenId: decision.tokenId,
    conditionId: decision.conditionId,
    outcome: decision.outcome,
    line: decision.line,
    strategy: decision.strategy,
    lossRequiresGoals: decision.lossRequiresGoals,
    locked: decision.locked,
    bestAsk: decision.bestAsk,
    availableSize: decision.availableSize,
    shares: decision.shares,
    notional: decision.notional,
    estimatedNetReturn: decision.estimatedNetReturn,
    tailWindowSource: decision.tailWindowSource,
    tailWindowDetails: decision.tailWindowDetails,
    legs: decision.legs,
    decision,
    trade
  };
}

function thresholdOverridesFromArgs(args: ParsedArgs): Partial<Omit<DecisionThresholds, "maxNotional">> {
  const overrides: Partial<Omit<DecisionThresholds, "maxNotional">> = {};
  if (args.maxEntryPrice !== undefined) overrides.maxEntryPrice = args.maxEntryPrice;
  if (args.minimumNetReturn !== undefined) overrides.minimumNetReturn = args.minimumNetReturn;
  if (args.minimumNotional !== undefined) overrides.minimumNotional = args.minimumNotional;
  if (args.entryWindowMinutes !== undefined) overrides.entryWindowMinutes = args.entryWindowMinutes;
  return overrides;
}

function unresolvedStakeAuditThresholds(args: ParsedArgs): DecisionThresholds {
  return {
    entryWindowMinutes: args.entryWindowMinutes ?? DEFAULT_THRESHOLDS.entryWindowMinutes,
    maxEntryPrice: args.maxEntryPrice ?? DEFAULT_THRESHOLDS.maxEntryPrice,
    minimumNetReturn: args.minimumNetReturn ?? DEFAULT_THRESHOLDS.minimumNetReturn,
    minimumNotional: args.minimumNotional ?? DEFAULT_THRESHOLDS.minimumNotional,
    maxNotional: args.stake ?? 0
  };
}

function thresholdOverridesWithMinimumNetReturn(
  overrides: Partial<Omit<DecisionThresholds, "maxNotional">>,
  minimumNetReturn: number
): Partial<Omit<DecisionThresholds, "maxNotional">> {
  return {
    ...overrides,
    minimumNetReturn: Math.max(overrides.minimumNetReturn ?? DEFAULT_THRESHOLDS.minimumNetReturn, minimumNetReturn)
  };
}

async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

function parseArgs(argv: string[]): ParsedArgs {
  const raw: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    raw[toCamel(key.slice(2))] = value;
    index += 1;
  }

  const mode = parseMode(raw.mode ?? "paper");
  const wantsWorldcupWatch = booleanEnv(raw.watch) === true && booleanEnv(raw.worldcup) === true;
  if (mode !== "status" && !wantsWorldcupWatch && !raw.matchFile && !raw.eventSlug) {
    throw new Error("--match-file or --event-slug is required");
  }
  if (raw.matchFile && raw.eventSlug) {
    throw new Error("Use only one of --match-file or --event-slug");
  }
  const orderType = parseOrderType(raw.orderType ?? "FAK");

  const parsed: ParsedArgs = {
    mode,
    orderType
  };
  if (raw.stake) {
    parsed.stake = numberArg(raw.stake, "--stake");
  } else if (mode === "paper") {
    parsed.stake = 97;
  }
  if (raw.matchFile) parsed.matchFile = raw.matchFile;
  if (raw.eventSlug) parsed.eventSlug = raw.eventSlug;
  if (raw.marketsFile) parsed.marketsFile = raw.marketsFile;
  if (raw.orderbookFile) parsed.orderbookFile = raw.orderbookFile;
  if (raw.ledgerFile) parsed.ledgerFile = raw.ledgerFile;
  if (raw.useLiveBalance) parsed.useLiveBalance = booleanArg(raw.useLiveBalance, "--use-live-balance");
  if (raw.balanceBuffer) parsed.balanceBuffer = numberArg(raw.balanceBuffer, "--balance-buffer");
  if (raw.watch) parsed.watch = booleanArg(raw.watch, "--watch");
  if (raw.worldcup) parsed.worldcup = booleanArg(raw.worldcup, "--worldcup");
  if (raw.intervalMs) parsed.intervalMs = numberArg(raw.intervalMs, "--interval-ms");
  if (raw.maxIterations) parsed.maxIterations = numberArg(raw.maxIterations, "--max-iterations");
  if (raw.instantBuyNetReturn) parsed.instantBuyNetReturn = numberArg(raw.instantBuyNetReturn, "--instant-buy-net-return");
  if (raw.candidateCompareWaitMs) parsed.candidateCompareWaitMs = numberArg(raw.candidateCompareWaitMs, "--candidate-compare-wait-ms");
  if (raw.liveAuditFile) parsed.liveAuditFile = raw.liveAuditFile;
  if (raw.depthAuditFile) parsed.depthAuditFile = raw.depthAuditFile;
  if (raw.maxEntryPrice) parsed.maxEntryPrice = numberArg(raw.maxEntryPrice, "--max-entry-price");
  if (raw.minimumNetReturn) parsed.minimumNetReturn = numberArg(raw.minimumNetReturn, "--minimum-net-return");
  if (raw.minimumNotional) parsed.minimumNotional = numberArg(raw.minimumNotional, "--minimum-notional");
  if (raw.entryWindowMinutes) parsed.entryWindowMinutes = numberArg(raw.entryWindowMinutes, "--entry-window-minutes");
  if (raw.tailTimeMode) throw new Error("--tail-time-mode was removed; live entry always requires verified 365Scores remainingSeconds");
  return parsed;
}

function parseMode(value: string): Mode {
  if (value === "paper" || value === "live" || value === "status") return value;
  throw new Error("--mode must be paper, live, or status");
}

function parseOrderType(value: string): LiveOrderType {
  if (value === "FOK" || value === "FAK") return value;
  throw new Error("--order-type must be FOK or FAK");
}

function numberArg(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a number`);
  return parsed;
}

function numberEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanArg(value: string, flag: string): boolean {
  const parsed = booleanEnv(value);
  if (parsed === undefined) throw new Error(`${flag} must be true or false`);
  return parsed;
}

function booleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return undefined;
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function toCamel(value: string): string {
  return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runCli();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}
