import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { selectLossRequiresCandidates } from "./domain/loss-requires-strategy.js";
import { classifyTailWindow } from "./domain/time-window.js";
import type { DecisionThresholds, MatchState, NoTradeDecision, OrderbookSnapshot, StrategyMarket, TradeDecision, TradeResult } from "./domain/types.js";
import { capStakeToAvailableBalance, DEFAULT_POLYGON_RPC_URL, readPusdBalance } from "./execution/balance.js";
import { LiveExecutionError, liveConfigFromEnv, type LiveOrderType } from "./execution/live-executor.js";
import type { LiveExecuteOptions, LiveExecutorConfig } from "./execution/live-executor.js";
import { PaperExecutor } from "./execution/paper-executor.js";
import { AutoSettlementMonitor, DEFAULT_POLYMARKET_RELAYER_URL, type RedeemablePosition, type SettlementConfig, type SettlementResult, type SubmitDepositWalletBatchInput } from "./execution/settlement.js";
import { LiveLedger, isActiveLedgerStatus } from "./persistence/ledger.js";
import { fetchOrderbook } from "./polymarket/clob.js";
import { fetchEventMatchState, fetchEventStrategyMarkets } from "./polymarket/event-page.js";
import { Scores365ClockProvider } from "./polymarket/scores365-clock.js";
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
  orderType: LiveOrderType;
}

interface SinglePassOptions {
  executeTrade?: boolean;
}

interface PendingBuy {
  eventSlug: string;
  match: MatchState;
  firstSeenAt: number;
  updatedAt: number;
  decision: Extract<TradeDecision, { action: "BUY" }>;
}

const MAX_VERIFIED_CLOCK_POLL_INTERVAL_MS = 1000;
const SPORTS_WATCH_RECONNECT_INTERVAL_MS = 1000;

export interface CliDependencies {
  fetchMatchState?: (eventSlug: string) => Promise<MatchState>;
  readPusdBalance?: (walletAddress: string, rpcUrl?: string) => Promise<number>;
  fetchWorldCupEventSlugs?: () => Promise<string[]>;
  fetchWorldCupEventRefs?: () => Promise<WorldCupEventRef[]>;
  watchSportsUpdates?: (events: readonly WorldCupEventRef[], options: { auditFile?: string; proxyUrl?: string }) => Promise<AsyncIterable<MatchState>>;
  fetchVerifiedClock?: (match: MatchState, events: readonly WorldCupEventRef[], options: { proxyUrl?: string; timezoneName?: string }) => Promise<Partial<MatchState> | null>;
  fetchOrderbook?: (tokenId: string) => Promise<OrderbookSnapshot>;
  executeLive?: (decision: Extract<TradeDecision, { action: "BUY" }>, options: LiveExecuteOptions) => Promise<TradeResult>;
  fetchRedeemablePositions?: (walletAddress: string, config: SettlementConfig) => Promise<RedeemablePosition[]>;
  submitDepositWalletBatch?: (input: SubmitDepositWalletBatchInput) => Promise<unknown>;
  settleRedeemablePositions?: (config: SettlementConfig) => Promise<SettlementResult>;
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
    let match = args.matchFile
      ? await readJsonFile<MatchState>(args.matchFile)
      : await (deps.fetchMatchState ?? fetchEventMatchState)(required(args.eventSlug, "--event-slug"));
    match = await overlayVerifiedClockForSinglePass(match, args, env, deps);
    const tailWindow = classifyTailWindow(match, {
      entryWindowMinutes: args.entryWindowMinutes ?? DEFAULT_THRESHOLDS.entryWindowMinutes
    });
    if (!tailWindow.eligible) {
      return ok(summary(args.mode, {
        action: "NO_TRADE",
        reason: "MATCH_NOT_LATE_ENOUGH",
        eventSlug: match.eventSlug,
        details: `${tailWindow.source}: ${tailWindow.details}`
      }));
    }

    const liveConfig = args.mode === "live" ? liveConfigFromEnv(env) : undefined;
    const liveStake = await resolveStake(args, match, env, liveConfig, deps);
    if (liveStake.action === "NO_TRADE") return ok(summary(args.mode, liveStake.decision));

    const markets = args.marketsFile ? await readJsonFile<StrategyMarket[]>(args.marketsFile) : await fetchEventStrategyMarkets(match.eventSlug);
    const thresholds = buildThresholds(liveStake.stake, thresholdOverridesFromArgs(args));
    const orderbooks = args.orderbookFile
      ? [await readJsonFile<OrderbookSnapshot>(args.orderbookFile)]
      : await fetchCandidateOrderbooks(match, markets, thresholds.entryWindowMinutes, undefined, deps.fetchOrderbook ?? fetchOrderbook);
    const ledgerFile = resolveLedgerFile(args, env);
    const ledger = ledgerFile ? new LiveLedger(ledgerFile) : undefined;

    const flowInput = {
      match,
      markets,
      orderbooks,
      stake: liveStake.stake,
      thresholds: thresholdOverridesFromArgs(args)
    };
    const decision = runDecisionFlow(flowInput);
    if (decision.action !== "BUY") {
      return ok(summary(args.mode, decision));
    }
    if (ledger && await ledger.hasActiveEventTrade(decision.eventSlug)) {
      return ok(summary(args.mode, {
        action: "NO_TRADE",
        reason: "DUPLICATE_TRADE",
        eventSlug: decision.eventSlug,
        details: "Ledger already has an active trade for this event"
      }));
    }
    if (options.executeTrade === false) return ok(summary(args.mode, decision));

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
    const fetchVerifiedClock = deps.fetchVerifiedClock ?? defaultVerifiedClockFetcher(clockOptions);
    const candidateCompareWaitMs = args.candidateCompareWaitMs;
    const instantBuyNetReturn = candidateCompareWaitMs === undefined
      ? 0.005
      : args.instantBuyNetReturn ?? numberEnv(env.POLY_INSTANT_BUY_NET_RETURN) ?? 0.005;

    const activeMatches = new Map<string, MatchState>();
    const pendingBuys = new Map<string, PendingBuy>();
    const completedEventSlugs = new Set<string>();
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
            if (iterations < maxIterations) updatePromise = iterator.next();
            continue;
          }
          rememberClockPollMatch(activeMatches, input.result.value);
          const processed = await processSportsWatchMatch(input.result.value);
          iterations += 1;
          const fatal = await handleSportsWatchDecision(processed);
          if (fatal) return fatal;
          const deferred = await maybeExecuteDeferredBuy(Date.now());
          if (deferred) return deferred;
          if (iterations < maxIterations) updatePromise = iterator.next();
          continue;
        }

        const pollMatches = [...activeMatches.values()]
          .filter((match) => !completedEventSlugs.has(match.eventSlug))
          .slice(0, Math.max(0, maxIterations - iterations));
        const polledMatches = await Promise.all(pollMatches.map(async (match) => {
          const clockPatch = await maybeFetchVerifiedClock(fetchVerifiedClock, match, events, clockOptions);
          return clockPatch ? { ...match, ...clockPatch } : null;
        }));
        for (const timedMatch of polledMatches) {
          if (!timedMatch || iterations >= maxIterations) continue;
          rememberClockPollMatch(activeMatches, timedMatch);
          const processed = await processSportsWatchMatch(timedMatch);
          iterations += 1;
          const fatal = await handleSportsWatchDecision(processed);
          if (fatal) return fatal;
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

    async function processSportsWatchMatch(match: MatchState): Promise<{ result: CliResult; last: Record<string, unknown>; match: MatchState }> {
      const clockPatch = match.remainingSecondsSource === "365scores_added_time_precise_game_time"
        ? null
        : await maybeFetchVerifiedClock(fetchVerifiedClock, match, events, clockOptions);
      const timedMatch = clockPatch ? { ...match, ...clockPatch } : match;
      const result = await runSinglePass({ ...args, eventSlug: timedMatch.eventSlug }, env, {
        ...deps,
        fetchMatchState: async () => timedMatch
      }, { executeTrade: false });
      return {
        result,
        last: JSON.parse(result.stdout) as Record<string, unknown>,
        match: timedMatch
      };
    }

    async function handleSportsWatchDecision(processed: { result: CliResult; last: Record<string, unknown>; match: MatchState }): Promise<CliResult | undefined> {
      last = processed.last;
      if (processed.result.exitCode !== 0) return processed.result;

      const decision = buyDecisionFromSummary(processed.last);
      if (!decision) {
        pendingBuys.delete(processed.match.eventSlug);
        return undefined;
      }

      if (candidateCompareWaitMs === undefined) {
        pendingBuys.delete(processed.match.eventSlug);
        return executeAndRememberSportsWatchMatch(processed.match);
      }

      if (decision.estimatedNetReturn >= instantBuyNetReturn) {
        pendingBuys.delete(processed.match.eventSlug);
        return executeAndRememberSportsWatchMatch(processed.match);
      }

      rememberPendingBuy(processed.match, decision, Date.now());
      return undefined;
    }

    function rememberPendingBuy(match: MatchState, decision: Extract<TradeDecision, { action: "BUY" }>, now: number): void {
      const existing = pendingBuys.get(match.eventSlug);
      pendingBuys.set(match.eventSlug, {
        eventSlug: match.eventSlug,
        match,
        firstSeenAt: existing?.firstSeenAt ?? now,
        updatedAt: now,
        decision
      });
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
        const fatal = await executeAndRememberSportsWatchMatch(pending.match);
        if (fatal) return fatal;
        if (last?.status !== "no_trade") return undefined;
      }

      return undefined;
    }

    async function executeAndRememberSportsWatchMatch(match: MatchState): Promise<CliResult | undefined> {
      let result: CliResult;
      try {
        result = await executeSportsWatchMatch(match);
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
      if (isCompletedTradeSummary(parsed)) {
        completedEventSlugs.add(match.eventSlug);
        activeMatches.delete(match.eventSlug);
        pendingBuys.delete(match.eventSlug);
      }
      return undefined;
    }

    async function executeSportsWatchMatch(match: MatchState): Promise<CliResult> {
      return runSinglePass({ ...args, eventSlug: match.eventSlug }, env, {
        ...deps,
        fetchMatchState: async () => match
      });
    }

    function rememberSportsWatchExecutionError(match: MatchState, error: unknown): void {
      const details = error instanceof Error ? error.message : String(error);
      console.error(`SPORTS_WATCH_EXECUTION_FAILED event=${match.eventSlug} details=${details}`);
      last = {
        mode: args.mode,
        status: "execution_error",
        action: "NO_TRADE",
        reason: "EXECUTION_FAILED",
        eventSlug: match.eventSlug,
        details
      };
      activeMatches.delete(match.eventSlug);
      pendingBuys.delete(match.eventSlug);
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
  if (match.period !== "2H" || !match.isLive || match.ended === true) {
    activeMatches.delete(match.eventSlug);
    return;
  }
  if (!shouldPollVerifiedClock(match)) return;
  activeMatches.set(match.eventSlug, match);
}

function shouldPollVerifiedClock(match: MatchState): boolean {
  if (match.remainingSeconds !== undefined) return true;
  if (match.elapsedSeconds !== undefined) return match.elapsedSeconds >= 85 * 60;
  return match.minute >= 85;
}

function verifiedClockPollIntervalMs(args: ParsedArgs): number {
  return Math.min(args.intervalMs ?? MAX_VERIFIED_CLOCK_POLL_INTERVAL_MS, MAX_VERIFIED_CLOCK_POLL_INTERVAL_MS);
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

async function fetchWorldCupEventRefs(deps: CliDependencies): Promise<WorldCupEventRef[]> {
  if (deps.fetchWorldCupEventRefs) return deps.fetchWorldCupEventRefs();
  if (deps.fetchWorldCupEventSlugs) {
    return (await deps.fetchWorldCupEventSlugs()).map((eventSlug) => ({ eventSlug }));
  }
  return fetchOpenWorldCupEventRefs();
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
  const ledgerFile = resolveLedgerFile(args, env);
  if (ledgerFile) {
    const ledger = new LiveLedger(ledgerFile);
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
    entryWindowMinutes
  });
  const tokenIds = [...new Set(candidates.map((candidate) => candidate.tokenId))];
  const results = await Promise.allSettled(tokenIds.map((tokenId) => orderbookFetcher(tokenId)));
  return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
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
