import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { selectLossRequiresCandidates } from "./domain/loss-requires-strategy.js";
import type { TailWindowMode } from "./domain/time-window.js";
import type { DecisionThresholds, MatchState, NoTradeDecision, OrderbookSnapshot, StrategyMarket, TradeDecision, TradeResult } from "./domain/types.js";
import { capStakeToAvailableBalance, readPusdBalance } from "./execution/balance.js";
import { LiveExecutionError, liveConfigFromEnv, type LiveOrderType } from "./execution/live-executor.js";
import type { LiveExecutorConfig } from "./execution/live-executor.js";
import { PaperExecutor } from "./execution/paper-executor.js";
import { LiveLedger } from "./persistence/ledger.js";
import { fetchOrderbook } from "./polymarket/clob.js";
import { fetchEventMatchState, fetchEventStrategyMarkets } from "./polymarket/event-page.js";
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
  liveAuditFile?: string;
  orderType: LiveOrderType;
  tailTimeMode?: TailWindowMode;
}

export interface CliDependencies {
  fetchMatchState?: (eventSlug: string) => Promise<MatchState>;
  readPusdBalance?: (walletAddress: string, rpcUrl?: string) => Promise<number>;
  fetchWorldCupEventSlugs?: () => Promise<string[]>;
  fetchWorldCupEventRefs?: () => Promise<WorldCupEventRef[]>;
  watchSportsUpdates?: (events: readonly WorldCupEventRef[], options: { auditFile?: string; proxyUrl?: string }) => Promise<AsyncIterable<MatchState>>;
  executeLive?: (decision: Extract<TradeDecision, { action: "BUY" }>, options: { orderType: LiveOrderType }) => Promise<TradeResult>;
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
  deps: CliDependencies
): Promise<CliResult> {
    const match = args.matchFile
      ? await readJsonFile<MatchState>(args.matchFile)
      : await (deps.fetchMatchState ?? fetchEventMatchState)(required(args.eventSlug, "--event-slug"));
    const liveConfig = args.mode === "live" ? liveConfigFromEnv(env) : undefined;
    const liveStake = await resolveStake(args, match, env, liveConfig, deps);
    if (liveStake.action === "NO_TRADE") return ok(summary(args.mode, liveStake.decision));

    const markets = args.marketsFile ? await readJsonFile<StrategyMarket[]>(args.marketsFile) : await fetchEventStrategyMarkets(match.eventSlug);
    const thresholds = buildThresholds(liveStake.stake, thresholdOverridesFromArgs(args));
    const tailWindowMode = args.tailTimeMode ?? tailWindowModeFromEnv(env);
    const orderbooks = args.orderbookFile
      ? [await readJsonFile<OrderbookSnapshot>(args.orderbookFile)]
      : await fetchCandidateOrderbooks(match, markets, thresholds.entryWindowMinutes, tailWindowMode);
    const ledgerFile = resolveLedgerFile(args, env);
    const ledger = ledgerFile ? new LiveLedger(ledgerFile) : undefined;

    const flowInput = {
      match,
      markets,
      orderbooks,
      stake: liveStake.stake,
      thresholds: thresholdOverridesFromArgs(args),
      ...(tailWindowMode ? { tailWindowMode } : {})
    };
    const decision = runDecisionFlow(flowInput);
    if (decision.action !== "BUY") {
      return ok(summary(args.mode, decision));
    }
    if (ledger && await ledger.hasActiveTrade(decision.eventSlug, decision.tokenId)) {
      return ok(summary(args.mode, {
        action: "NO_TRADE",
        reason: "DUPLICATE_TRADE",
        eventSlug: decision.eventSlug,
        details: "Ledger already has an active trade for this event/token"
      }));
    }

    const trade = args.mode === "paper"
      ? await new PaperExecutor().execute(decision)
      : await (deps.executeLive
        ? deps.executeLive(decision, { orderType: args.orderType })
        : new LiveExecutor(liveConfig).execute(decision, { orderType: args.orderType }));
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

  const events = await fetchWorldCupEventRefs(deps);
  const updateOptions = sportsUpdateOptions(args, env);
  const updates = await (deps.watchSportsUpdates ?? defaultSportsUpdates)(events, updateOptions);

  for await (const match of updates) {
    iterations += 1;
    const result = await runSinglePass({ ...args, eventSlug: match.eventSlug }, env, {
      ...deps,
      fetchMatchState: async () => match
    });
    if (result.exitCode !== 0) return result;

    last = JSON.parse(result.stdout) as Record<string, unknown>;
    if (last.status !== "no_trade") return result;
    if (iterations >= maxIterations) break;
  }

  return ok({
    mode: args.mode,
    status: "watch_complete",
    iterations,
    last
  });
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

async function defaultSportsUpdates(
  events: readonly WorldCupEventRef[],
  options: { auditFile?: string; proxyUrl?: string }
): Promise<AsyncIterable<MatchState>> {
  const queue: MatchState[] = [];
  let closed = false;
  let pending: (() => void) | undefined;

  const wake = (): void => {
    pending?.();
    pending = undefined;
  };

  const providerOptions = {
    events,
    ...(options.auditFile !== undefined ? { auditFile: options.auditFile } : {}),
    ...(options.proxyUrl !== undefined ? { proxyUrl: options.proxyUrl } : {})
  };
  const socket = new SportsLiveProvider(providerOptions).connect((update) => {
    queue.push(update);
    wake();
  });

  socket.addEventListener("close", () => {
    closed = true;
    wake();
  });
  socket.addEventListener("error", () => {
    closed = true;
    wake();
  });

  async function* stream(): AsyncIterable<MatchState> {
    try {
      while (true) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          pending = resolve;
        });
      }
    } finally {
      try {
        socket.close();
      } catch {
        // The socket may already be closed by the remote endpoint.
      }
    }
  }

  return stream();
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
      active: entries.filter((entry) => entry.status === "filled" || entry.status === "posted").length
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
  tailWindowModeOrFetcher?: TailWindowMode | ((tokenId: string) => Promise<OrderbookSnapshot>),
  fetcher: (tokenId: string) => Promise<OrderbookSnapshot> = fetchOrderbook
): Promise<OrderbookSnapshot[]> {
  const tailWindowMode = typeof tailWindowModeOrFetcher === "string" ? tailWindowModeOrFetcher : undefined;
  const orderbookFetcher = typeof tailWindowModeOrFetcher === "function" ? tailWindowModeOrFetcher : fetcher;
  const candidates = selectLossRequiresCandidates(match, markets, {
    entryWindowMinutes,
    ...(tailWindowMode ? { tailWindowMode } : {})
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

function summary(mode: Mode, decision: TradeDecision, trade?: TradeResult): Record<string, unknown> {
  if (decision.action !== "BUY") {
    return {
      mode,
      status: "no_trade",
      action: decision.action,
      reason: decision.reason,
      eventSlug: decision.eventSlug,
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
  const orderType = parseOrderType(raw.orderType ?? "FOK");

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
  if (raw.liveAuditFile) parsed.liveAuditFile = raw.liveAuditFile;
  if (raw.maxEntryPrice) parsed.maxEntryPrice = numberArg(raw.maxEntryPrice, "--max-entry-price");
  if (raw.minimumNetReturn) parsed.minimumNetReturn = numberArg(raw.minimumNetReturn, "--minimum-net-return");
  if (raw.minimumNotional) parsed.minimumNotional = numberArg(raw.minimumNotional, "--minimum-notional");
  if (raw.entryWindowMinutes) parsed.entryWindowMinutes = numberArg(raw.entryWindowMinutes, "--entry-window-minutes");
  if (raw.tailTimeMode) parsed.tailTimeMode = parseTailWindowMode(raw.tailTimeMode);
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

function tailWindowModeFromEnv(env: Record<string, string | undefined>): TailWindowMode | undefined {
  return env.POLY_TAIL_TIME_MODE ? parseTailWindowMode(env.POLY_TAIL_TIME_MODE) : undefined;
}

function parseTailWindowMode(value: string): TailWindowMode {
  if (value === "remaining" || value === "conservative90") return value;
  throw new Error("--tail-time-mode/POLY_TAIL_TIME_MODE must be remaining or conservative90");
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
