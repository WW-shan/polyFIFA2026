import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { backtestTailArchives } from "./tail-backtest.js";
import { collectTailSettlements, loadTailArchive } from "./tail-backtest-io.js";
import type { LoadedTailArchive, SettlementCollection, SettlementCollectionOptions } from "./tail-backtest-io.js";
import { writeTailBacktestReport } from "./tail-backtest-report.js";
import type { TailBacktestInput, TailBacktestOptions } from "./tail-backtest-types.js";

export interface TailBacktestCliDependencies {
  request?: SettlementCollectionOptions["request"];
  now?: () => number;
  signal?: AbortSignal;
  report?: typeof writeTailBacktestReport;
}
export interface TailBacktestCliResult { exitCode: number; stdout: string; stderr: string }
interface ParsedArgs {
  help: boolean;
  archiveDirectories: string[];
  outputDirectory: string;
  sport: string;
  options: TailBacktestOptions;
  fetchSettlements: boolean;
  proxyUrl?: string;
}

const HELP = `Collected-orderbook research: hypothetical resting-limit scenarios, not executed trades or guaranteed profit.
Usage: tsx src/research/tail-backtest-cli.ts --archive-dir PATH [--archive-dir PATH ...] --output-dir NEW_PATH
  --sport LABEL                        Applies to all inputs (default: unknown)
  --prices DECIMAL,DECIMAL              Default: 0.50,0.60,0.70,0.80,0.90,0.95,0.97,0.99
  --windows-seconds INTEGER,INTEGER     Default: 60,180,300
  --entry-min-bid DECIMAL               Default: 0.90
  --shares NUMBER                      Default: 1
  --queue-ahead-shares NUMBER           Default: 0 (sell-through-volume only)
  --maker-fee-bps NUMBER                Default: 0
  --fill-model quote-touch-assumed|sell-through-volume
  --require-fresh-context              Gate on recorded context freshness
  --fetch-settlements                   Opt in to public Gamma/CLOB settlement requests
  --proxy-url URL                       Optional HTTP(S) proxy for those requests
  --help, -h                           Read-only help
No network by default. Existing output paths are refused. No signing or live execution.
Outputs: report.json, summary.csv, trials.csv, report.html, inputs.json, optional settlements.json, manifest.json.
Unresolved PnL stays null; overlapping parameter windows and markets are not portfolio results.
`;

function invalid(message: string): never { throw new Error("TAIL_BACKTEST_OPTIONS_INVALID: " + message); }
function value(args: readonly string[], index: number): string {
  const next = args[index + 1];
  if (!next?.trim() || next.startsWith("--") || next === "-h" || next.includes("\0")) invalid(`${args[index]} requires a value`);
  return next;
}
function list(text: string): string[] {
  const items = text.split(",").map(item => item.trim());
  if (items.some(item => !item)) invalid("lists must not contain empty items");
  return items;
}
function number(text: string, flag: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(Number(text))) invalid(`${flag} requires a finite number`);
  return Number(text);
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false, archiveDirectories: [], outputDirectory: "", sport: "unknown", options: {}, fetchSettlements: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag !== "--archive-dir" && seen.has(flag)) invalid("repeated flag " + flag);
    seen.add(flag);
    switch (flag) {
      case "--help": case "-h": parsed.help = true; break;
      case "--archive-dir": parsed.archiveDirectories.push(value(args, index++)); break;
      case "--output-dir": parsed.outputDirectory = value(args, index++); break;
      case "--sport": parsed.sport = value(args, index++).trim(); break;
      case "--prices": parsed.options.prices = list(value(args, index++)); break;
      case "--windows-seconds": parsed.options.windowsSeconds = list(value(args, index++)).map(item => {
        if (!/^\d+$/.test(item) || !Number.isSafeInteger(Number(item))) invalid("--windows-seconds requires integer seconds");
        return Number(item);
      }); break;
      case "--entry-min-bid": parsed.options.entryMinBid = value(args, index++); break;
      case "--shares": parsed.options.shares = number(value(args, index++), flag); break;
      case "--queue-ahead-shares": parsed.options.queueAheadShares = number(value(args, index++), flag); break;
      case "--maker-fee-bps": parsed.options.makerFeeBps = number(value(args, index++), flag); break;
      case "--fill-model": {
        const model = value(args, index++);
        if (model !== "quote-touch-assumed" && model !== "sell-through-volume") invalid("unknown fill model");
        parsed.options.fillModel = model; break;
      }
      case "--require-fresh-context": parsed.options.requireFreshContext = true; break;
      case "--fetch-settlements": parsed.fetchSettlements = true; break;
      case "--proxy-url": {
        const proxy = value(args, index++);
        let url: URL;
        try { url = new URL(proxy); } catch { invalid("--proxy-url requires an HTTP(S) URL"); }
        if (url.protocol !== "http:" && url.protocol !== "https:") invalid("--proxy-url requires an HTTP(S) URL");
        parsed.proxyUrl = proxy; break;
      }
      default: invalid("unknown argument " + flag);
    }
  }
  if (parsed.sport.length > 4_096) invalid("--sport is too long");
  // The engine owns option semantics; an empty pure run validates before any filesystem or network IO.
  backtestTailArchives([], parsed.options);
  if (!parsed.help && (!parsed.archiveDirectories.length || !parsed.outputDirectory)) invalid("--archive-dir and --output-dir are required");
  return parsed;
}

async function assertNewOutput(directory: string): Promise<void> {
  try { await lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("TAIL_BACKTEST_OUTPUT_EXISTS: " + directory);
}

function withSettlements(input: TailBacktestInput, evidence: SettlementCollection): TailBacktestInput {
  const key = (value: { marketId: string; conditionId: string; tokenId: string }) => JSON.stringify([value.conditionId, value.marketId, value.tokenId]);
  const identities = new Set(input.summary.windows.flatMap(window => window.markets.map(key)));
  // The collector has already reconciled archived and new labels (including conflicts).
  // Replacing only settlements preserves all price/entry data and avoids reintroducing rejected labels.
  return { ...input, settlements: evidence.settlements.filter(settlement => identities.has(key(settlement))) };
}

/** Captures terminal output without changing process listeners or streams when imported. */
export async function runTailBacktestCli(args: readonly string[], deps: TailBacktestCliDependencies = {}): Promise<TailBacktestCliResult> {
  try {
    const parsed = parseArgs(args);
    if (parsed.help) return { exitCode: 0, stdout: HELP, stderr: "" };
    deps.signal?.throwIfAborted();
    const outputDirectory = resolve(parsed.outputDirectory);
    await assertNewOutput(outputDirectory);
    const loaded: LoadedTailArchive[] = [];
    for (const directory of parsed.archiveDirectories) {
      deps.signal?.throwIfAborted();
      try { loaded.push(await loadTailArchive(directory, { sport: parsed.sport })); }
      catch (error) { throw new Error(`TAIL_BACKTEST_ARCHIVE_FAILED: ${directory}: ${String(error)}`, { cause: error }); }
    }
    const inputs = loaded.map(archive => archive.input);
    // Full engine preflight detects duplicate identities and malformed data before any public request.
    let result = backtestTailArchives(inputs, parsed.options);
    let evidence: SettlementCollection | undefined;
    if (parsed.fetchSettlements) {
      deps.signal?.throwIfAborted();
      evidence = await collectTailSettlements(inputs, {
        ...(parsed.proxyUrl ? { proxyUrl: parsed.proxyUrl } : {}), ...(deps.request ? { request: deps.request } : {}),
        ...(deps.now ? { now: deps.now } : {}), ...(deps.signal ? { signal: deps.signal } : {})
      });
      result = backtestTailArchives(inputs.map(input => withSettlements(input, evidence!)), parsed.options);
    }
    deps.signal?.throwIfAborted();
    const provenance = loaded.map(({ input, provenance }) => ({ ...provenance, sourceId: input.sourceId, sourceRunId: input.summary.runId, sport: input.sport }));
    const files = await (deps.report ?? writeTailBacktestReport)(result, { outputDirectory, provenance, ...(evidence ? { evidence } : {}) });
    const eligibleTrials = result.trials.filter(trial => trial.eligible).length;
    const notices: string[] = [];
    if (!eligibleTrials) notices.push("No data-eligible scenarios; see report exclusions and source warnings.");
    if (evidence?.errors.length) notices.push(`Settlement collection recorded ${evidence.errors.length} error(s); see ${files.settlementsPath ?? "settlements.json"}.`);
    return { exitCode: 0, stdout: JSON.stringify({ ...files, basis: result.basis, execution: result.execution,
      sourceCount: result.sources.length, scenarioTrials: result.trials.length, parameterGroups: result.summaries.length, eligibleTrials }) + "\n",
    stderr: notices.length ? notices.join("\n") + "\n" : "" };
  } catch (error) {
    return { exitCode: deps.signal?.aborted ? 130 : 1, stdout: "", stderr: String(error) + "\n" };
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  const controller = new AbortController();
  let interrupted: "SIGINT" | "SIGTERM" | undefined;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => { interrupted ??= signal; controller.abort(new Error("TAIL_BACKTEST_ABORTED: " + signal)); };
  const onInt = () => interrupt("SIGINT"), onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  void runTailBacktestCli(process.argv.slice(2), { signal: controller.signal }).then(result => {
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    process.exitCode = interrupted === "SIGTERM" ? 143 : interrupted === "SIGINT" ? 130 : result.exitCode;
  }).finally(() => { process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm); });
}
