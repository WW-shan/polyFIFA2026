import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BacktestOptions, BacktestResult } from "./backtest-types.js";
import { downloadResearchDataset, type ResearchDownloadOptions, type ResearchDownloadResult } from "./download.js";
import { writeBacktestReport, type ReportFiles, type ReportOptions } from "./report.js";
import { backtestDataset, effectiveBacktestOptions } from "./backtest.js";
import type { ResearchDataset } from "./types.js";
export type ParsedResearchArgs = { command: "download"; options: ResearchDownloadOptions } | { command: "backtest"; inputPath: string; outputDirectory: string; options: BacktestOptions } | { command: "help" };
export interface ResearchCliDependencies {
  download?: (options: ResearchDownloadOptions) => Promise<ResearchDownloadResult>;
  readInput?: (path: string) => Promise<string>;
  report?: (result: BacktestResult, options: ReportOptions) => Promise<ReportFiles>;
  write?: (text: string) => void;
  progress?: (text: string) => void;
}
function invalid(message: string): never { throw new Error(`RESEARCH_OPTIONS_INVALID: ${message}`); }
function value(args: readonly string[], index: number): string {
  const next = args[index + 1];
  if (!next?.trim() || next.startsWith("--")) invalid(`${args[index]} requires a value`);
  return next;
}
function list(text: string): string[] {
  const result = text.split(",").map(item => item.trim());
  if (result.some(item => !item)) invalid("lists must not contain empty values");
  return result;
}
function number(text: string, flag: string, integer = false): number {
  const result = Number(text);
  if (!Number.isFinite(result) || (integer && (!Number.isSafeInteger(result) || result <= 0))) invalid(`${flag} requires ${integer ? "a positive integer" : "a finite number"}`);
  return result;
}

function parseDownload(args: readonly string[]): ParsedResearchArgs {
  const options: ResearchDownloadOptions = { sport: "tennis", outputDirectory: "" };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    switch (flag) {
      case "--output-dir": options.outputDirectory = value(args, index++); break;
      case "--sport": options.sport = value(args, index++); break;
      case "--tag-id": options.tagId = value(args, index++); break;
      case "--event-slugs": options.eventSlugs = list(value(args, index++)); break;
      case "--market-types": options.marketTypes = list(value(args, index++)); break;
      case "--max-events": options.maxEvents = number(value(args, index++), flag, true); break;
      case "--max-catalog-pages": options.maxCatalogPages = number(value(args, index++), flag, true); break;
      case "--trade-page-size": options.tradePageSize = number(value(args, index++), flag, true); break;
      case "--max-trade-pages": options.maxTradePages = number(value(args, index++), flag, true); break;
      case "--concurrency": options.concurrency = number(value(args, index++), flag, true); break;
      case "--timeout-ms": options.timeoutMs = number(value(args, index++), flag, true); break;
      case "--proxy-url": options.proxyUrl = value(args, index++); break;
      case "--gamma-base-url": options.gammaBaseUrl = value(args, index++); break;
      case "--data-base-url": options.dataBaseUrl = value(args, index++); break;
      case "--require-finish": options.requireFinish = true; break;
      default: invalid(`unknown download argument ${flag}`);
    }
  }
  if (!options.outputDirectory) invalid("download requires --output-dir");
  return { command: "download", options };
}

function parseBacktest(args: readonly string[]): ParsedResearchArgs {
  let inputPath = "", outputDirectory = "";
  const options: BacktestOptions = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    switch (flag) {
      case "--input": inputPath = value(args, index++); break;
      case "--output-dir": outputDirectory = value(args, index++); break;
      case "--prices": options.prices = list(value(args, index++)).map(text => number(text, flag)); break;
      case "--windows": options.windowsSeconds = list(value(args, index++)).map(text => number(text, flag, true)); break;
      case "--shares": options.shares = number(value(args, index++), flag); break;
      case "--entry-min-price": options.entryMinPrice = number(value(args, index++), flag); break;
      case "--max-entry-age-seconds": options.maxEntryAgeSeconds = number(value(args, index++), flag); break;
      case "--queue-ahead-shares": options.queueAheadShares = number(value(args, index++), flag); break;
      case "--maker-fee-bps": options.makerFeeBps = number(value(args, index++), flag); break;
      case "--market-types": options.marketTypes = list(value(args, index++)); break;
      case "--entry-mode": {
        const mode = value(args, index++);
        if (mode !== "finish-relative" && mode !== "price-trigger") invalid("entry-mode must be finish-relative or price-trigger");
        options.entryMode = mode; break;
      }
      case "--fill-model": {
        const model = value(args, index++);
        if (model !== "sell-through" && model !== "sell-at-or-below") invalid("fill-model must be sell-through or sell-at-or-below");
        options.fillModel = model; break;
      }
      default: invalid(`unknown backtest argument ${flag}`);
    }
  }
  if (!inputPath || !outputDirectory) invalid("backtest requires --input and --output-dir");
  effectiveBacktestOptions(options); // Validate before opening files.
  return { command: "backtest", inputPath, outputDirectory, options };
}

export function parseResearchCliArgs(argv: readonly string[]): ParsedResearchArgs {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "help")) return { command: "help" };
  if (argv[0] === "download") return parseDownload(argv.slice(1));
  if (argv[0] === "backtest") return parseBacktest(argv.slice(1));
  return invalid("expected download, backtest or --help");
}

const HELP = `Public-data research only; no keys, live orders or execution imports.
download --output-dir PATH [--sport tennis|table-tennis|cs2|dota2|valorant] [--tag-id ID]
  [--max-events 30] [--max-catalog-pages 5] [--require-finish] [--market-types CSV]
  [--event-slugs CSV] [--trade-page-size 1000] [--max-trade-pages 11]
  [--concurrency 4] [--timeout-ms 15000] [--proxy-url URL]
backtest --input dataset.json --output-dir PATH
  [--prices 0.5,0.6,0.7,0.8,0.9,0.95,0.97,0.99] [--windows 60,180,300,480]
  [--shares 10] [--entry-min-price 0.9] [--max-entry-age-seconds 120]
  [--entry-mode finish-relative|price-trigger] [--fill-model sell-through|sell-at-or-below]
  [--queue-ahead-shares 0] [--maker-fee-bps 0] [--market-types CSV]
Output directories must be new. Complete API windows are not historical L2 books or confirmed own fills.`;

export async function runResearchCli(argv: readonly string[], deps: ResearchCliDependencies = {}): Promise<unknown> {
  const parsed = parseResearchCliArgs(argv);
  const write = deps.write ?? (text => process.stdout.write(`${text}\n`));
  if (parsed.command === "help") { write(HELP); return { command: "help" }; }
  if (parsed.command === "download") {
    const result = await (deps.download ?? (options => downloadResearchDataset(options, {
      onProgress: deps.progress ?? (text => process.stderr.write(`${text}\n`))
    })))(parsed.options);
    write(JSON.stringify(result)); return result;
  }
  const inputPath = resolve(parsed.inputPath);
  const text = await (deps.readInput ?? (path => readFile(path, "utf8")))(inputPath);
  const inputSha256 = createHash("sha256").update(text).digest("hex");
  const result = backtestDataset(JSON.parse(text) as ResearchDataset, parsed.options);
  const files = await (deps.report ?? writeBacktestReport)(result, { outputDirectory: parsed.outputDirectory, inputPath, inputSha256 });
  const output = { ...files, basis: result.basis, scenarioTrials: result.trials.length, parameterGroups: result.summaries.length };
  write(JSON.stringify(output)); return output;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void runResearchCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${String(error)}\n`); process.exitCode = 1;
  });
}
