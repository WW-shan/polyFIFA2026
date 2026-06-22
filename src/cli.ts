import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { selectLossRequiresCandidates } from "./domain/loss-requires-strategy.js";
import type { DecisionThresholds, MatchState, OrderbookSnapshot, StrategyMarket, TradeDecision, TradeResult } from "./domain/types.js";
import { LiveExecutionError, liveConfigFromEnv, type LiveOrderType } from "./execution/live-executor.js";
import { PaperExecutor } from "./execution/paper-executor.js";
import { fetchOrderbook } from "./polymarket/clob.js";
import { fetchEventMatchState, fetchEventStrategyMarkets } from "./polymarket/event-page.js";
import { buildThresholds, runDecisionFlow } from "./runner.js";
import { LiveExecutor } from "./execution/live-executor.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type Mode = "paper" | "live";

interface ParsedArgs {
  mode: Mode;
  matchFile?: string;
  eventSlug?: string;
  marketsFile?: string;
  orderbookFile?: string;
  stake: number;
  maxEntryPrice?: number;
  minimumNetReturn?: number;
  minimumNotional?: number;
  watchStartMinute?: number;
  orderType: LiveOrderType;
}

export interface CliDependencies {
  fetchMatchState?: (eventSlug: string) => Promise<MatchState>;
}

export async function runCli(
  argv = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  deps: CliDependencies = {}
): Promise<CliResult> {
  try {
    const args = parseArgs(argv);
    const match = args.matchFile
      ? await readJsonFile<MatchState>(args.matchFile)
      : await (deps.fetchMatchState ?? fetchEventMatchState)(required(args.eventSlug, "--event-slug"));
    const markets = args.marketsFile ? await readJsonFile<StrategyMarket[]>(args.marketsFile) : await fetchEventStrategyMarkets(match.eventSlug);
    const thresholds = buildThresholds(args.stake, thresholdOverridesFromArgs(args));
    const orderbooks = args.orderbookFile
      ? [await readJsonFile<OrderbookSnapshot>(args.orderbookFile)]
      : await fetchCandidateOrderbooks(match, markets, thresholds.watchStartMinute);

    const decision = runDecisionFlow({
      match,
      markets,
      orderbooks,
      stake: args.stake,
      thresholds: thresholdOverridesFromArgs(args)
    });
    if (decision.action !== "BUY") {
      return ok(summary(args.mode, decision));
    }

    const trade = args.mode === "paper"
      ? await new PaperExecutor().execute(decision)
      : await new LiveExecutor(liveConfigFromEnv(env)).execute(decision, { orderType: args.orderType });

    return ok(summary(args.mode, decision, trade));
  } catch (error) {
    if (error instanceof LiveExecutionError) {
      return { exitCode: 1, stdout: "", stderr: `${error.code}: ${error.message}` };
    }
    return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

function ok(value: unknown): CliResult {
  return { exitCode: 0, stdout: `${JSON.stringify(value, null, 2)}\n`, stderr: "" };
}

export async function fetchCandidateOrderbooks(
  match: MatchState,
  markets: readonly StrategyMarket[],
  watchStartMinute: number,
  fetcher: (tokenId: string) => Promise<OrderbookSnapshot> = fetchOrderbook
): Promise<OrderbookSnapshot[]> {
  const candidates = selectLossRequiresCandidates(match, markets, { watchStartMinute });
  const tokenIds = [...new Set(candidates.map((candidate) => candidate.tokenId))];
  const results = await Promise.allSettled(tokenIds.map((tokenId) => fetcher(tokenId)));
  return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
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
    decision,
    trade
  };
}

function thresholdOverridesFromArgs(args: ParsedArgs): Partial<Omit<DecisionThresholds, "maxNotional">> {
  const overrides: Partial<Omit<DecisionThresholds, "maxNotional">> = {};
  if (args.maxEntryPrice !== undefined) overrides.maxEntryPrice = args.maxEntryPrice;
  if (args.minimumNetReturn !== undefined) overrides.minimumNetReturn = args.minimumNetReturn;
  if (args.minimumNotional !== undefined) overrides.minimumNotional = args.minimumNotional;
  if (args.watchStartMinute !== undefined) overrides.watchStartMinute = args.watchStartMinute;
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
  if (!raw.matchFile && !raw.eventSlug) {
    throw new Error("--match-file or --event-slug is required");
  }
  if (raw.matchFile && raw.eventSlug) {
    throw new Error("Use only one of --match-file or --event-slug");
  }
  const orderType = parseOrderType(raw.orderType ?? "FOK");

  const parsed: ParsedArgs = {
    mode,
    stake: numberArg(raw.stake ?? "97", "--stake"),
    orderType
  };
  if (raw.matchFile) parsed.matchFile = raw.matchFile;
  if (raw.eventSlug) parsed.eventSlug = raw.eventSlug;
  if (raw.marketsFile) parsed.marketsFile = raw.marketsFile;
  if (raw.orderbookFile) parsed.orderbookFile = raw.orderbookFile;
  if (raw.maxEntryPrice) parsed.maxEntryPrice = numberArg(raw.maxEntryPrice, "--max-entry-price");
  if (raw.minimumNetReturn) parsed.minimumNetReturn = numberArg(raw.minimumNetReturn, "--minimum-net-return");
  if (raw.minimumNotional) parsed.minimumNotional = numberArg(raw.minimumNotional, "--minimum-notional");
  if (raw.watchStartMinute) parsed.watchStartMinute = numberArg(raw.watchStartMinute, "--watch-start-minute");
  return parsed;
}

function parseMode(value: string): Mode {
  if (value === "paper" || value === "live") return value;
  throw new Error("--mode must be paper or live");
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
