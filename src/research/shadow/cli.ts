import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchJson } from "../../polymarket/http.js";
import { parseScoreboard, parseSummary } from "./espn.js";
import { discoverLeagueMarkets, fetchMarketBook, SHADOW_LEAGUES } from "./market.js";
import { parseLateScoreModel } from "./model.js";
import { DEFAULT_SHADOW_OPTIONS, runLateGameShadow, type ShadowMonitorDeps, type ShadowMonitorOptions, type ShadowRunSummary } from "./monitor.js";

export const DEFAULT_SHADOW_PROXY = "http://127.0.0.1:10808";

export type ParsedShadowArgs =
  | { command: "help" }
  | {
      command: "run";
      league: string;
      modelPath: string;
      outPath: string;
      proxyUrl: string | undefined;
      intervalMs: number;
      idleIntervalMs: number;
      discoveryIntervalMs: number;
      recordWindowSeconds: number;
      windowSeconds: number;
      minProbability: number;
      minEdge: number;
      shares: number;
      delaySeconds: number;
      lookbackHours: number;
      aheadHours: number;
      once: boolean;
      durationMs: number | undefined;
      quiet: boolean;
    };

export interface ShadowCliDependencies {
  readFile?: (path: string) => Promise<string>;
  appendRecord?: (path: string, record: Record<string, unknown>) => Promise<void>;
  run?: (options: ShadowMonitorOptions, deps: ShadowMonitorDeps) => Promise<ShadowRunSummary>;
  write?: (text: string) => void;
  mkdir?: (path: string) => Promise<void>;
  now?: () => number;
}

const LOG_KINDS = new Set(["run-start", "run-end", "signal", "fill-check", "settlement", "error"]);

export function shadowHelp(): string {
  return `Usage: npm run shadow:late-game -- --league nfl|nba [options]

Shadow only: this process reads ESPN scores and Polymarket books, records what
the validated late-game model would have done, and never submits an order or
touches the live ledger.

  --league nfl|nba             League to shadow (required)
  --model PATH                 Exported model artifact (default data/research/models/late-score-<league>.json)
  --out PATH                   NDJSON audit file (default data/research/shadow/<league>-<UTC>.ndjson)
  --proxy-url URL              HTTP(S) proxy; empty string for direct (default ${DEFAULT_SHADOW_PROXY})
  --interval-ms N              Poll interval inside the final window (default ${DEFAULT_SHADOW_OPTIONS.pollIntervalMs})
  --idle-interval-ms N         Poll interval outside the final window (default ${DEFAULT_SHADOW_OPTIONS.idlePollIntervalMs})
  --discovery-interval-ms N    Gamma rediscovery interval (default ${DEFAULT_SHADOW_OPTIONS.discoveryIntervalMs})
  --record-window-seconds N    Seconds before the end to record books (default ${DEFAULT_SHADOW_OPTIONS.recordWindowSeconds})
  --window-seconds N           Signal window (default ${DEFAULT_SHADOW_OPTIONS.windowSeconds})
  --min-probability N          Model probability floor (default ${DEFAULT_SHADOW_OPTIONS.minProbability})
  --min-edge N                 Model minus executable price floor (default ${DEFAULT_SHADOW_OPTIONS.minEdge})
  --shares N                   Hypothetical fill size (default ${DEFAULT_SHADOW_OPTIONS.shares})
  --delay-seconds N            Delay before fill checks (default ${DEFAULT_SHADOW_OPTIONS.delaySeconds})
  --lookback-hours N           Gamma discovery lookback (default ${DEFAULT_SHADOW_OPTIONS.lookbackHours})
  --ahead-hours N              Gamma discovery lookahead (default ${DEFAULT_SHADOW_OPTIONS.aheadHours})
  --once                       Run a single tick and exit
  --duration-minutes N         Stop after N minutes
  --quiet                      Do not echo record summaries to stdout
  --help                       Show this help`;
}

function invalid(detail: string): never {
  throw new Error(`SHADOW_CLI_INVALID: ${detail}`);
}

function value(args: readonly string[], index: number): string {
  const next = args[index + 1];
  if (next === undefined || next.startsWith("--")) invalid(`${args[index]} requires a value`);
  return next;
}

function positiveInteger(text: string, flag: string): number {
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) invalid(`${flag} requires a positive integer`);
  return parsed;
}

function nonnegativeNumber(text: string, flag: string): number {
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) invalid(`${flag} requires a nonnegative number`);
  return parsed;
}

function stamp(nowMs: number, withTime: boolean): string {
  const iso = new Date(nowMs).toISOString();
  const date = iso.slice(0, 10).replace(/-/g, "");
  return withTime ? `${date}T${iso.slice(11, 19).replace(/:/g, "")}Z` : date;
}

export function parseShadowArgs(args: readonly string[], nowMs = Date.now()): ParsedShadowArgs {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { command: "help" };
  let league: string | undefined;
  let modelPath: string | undefined;
  let outPath: string | undefined;
  let proxyUrl: string | undefined = process.env.POLY_RESEARCH_PROXY ?? DEFAULT_SHADOW_PROXY;
  const numbers: Record<string, number> = {};
  let once = false;
  let quiet = false;
  let durationMs: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    switch (flag) {
      case "--league": league = value(args, index++); break;
      case "--model": modelPath = value(args, index++); break;
      case "--out": outPath = value(args, index++); break;
      case "--proxy-url": proxyUrl = value(args, index++); break;
      case "--interval-ms": numbers[flag] = positiveInteger(value(args, index++), flag); break;
      case "--idle-interval-ms": numbers[flag] = positiveInteger(value(args, index++), flag); break;
      case "--discovery-interval-ms": numbers[flag] = positiveInteger(value(args, index++), flag); break;
      case "--record-window-seconds": numbers[flag] = positiveInteger(value(args, index++), flag); break;
      case "--window-seconds": numbers[flag] = positiveInteger(value(args, index++), flag); break;
      case "--min-probability": numbers[flag] = nonnegativeNumber(value(args, index++), flag); break;
      case "--min-edge": numbers[flag] = nonnegativeNumber(value(args, index++), flag); break;
      case "--shares": numbers[flag] = positiveInteger(value(args, index++), flag); break;
      case "--delay-seconds": numbers[flag] = positiveInteger(value(args, index++), flag); break;
      case "--lookback-hours": numbers[flag] = positiveInteger(value(args, index++), flag); break;
      case "--ahead-hours": numbers[flag] = positiveInteger(value(args, index++), flag); break;
      case "--duration-minutes": durationMs = positiveInteger(value(args, index++), flag) * 60_000; break;
      case "--once": once = true; break;
      case "--quiet": quiet = true; break;
      default: invalid(`unknown argument ${flag}`);
    }
  }
  if (league === undefined) invalid("--league is required");
  if (!(league in SHADOW_LEAGUES)) invalid(`--league must be one of ${Object.keys(SHADOW_LEAGUES).join(", ")}`);
  return {
    command: "run",
    league,
    modelPath: modelPath ?? `data/research/models/late-score-${league}.json`,
    outPath: outPath ?? `data/research/shadow/${league}-${stamp(nowMs, true)}.ndjson`,
    proxyUrl: proxyUrl === "" ? undefined : proxyUrl,
    intervalMs: numbers["--interval-ms"] ?? DEFAULT_SHADOW_OPTIONS.pollIntervalMs,
    idleIntervalMs: numbers["--idle-interval-ms"] ?? DEFAULT_SHADOW_OPTIONS.idlePollIntervalMs,
    discoveryIntervalMs: numbers["--discovery-interval-ms"] ?? DEFAULT_SHADOW_OPTIONS.discoveryIntervalMs,
    recordWindowSeconds: numbers["--record-window-seconds"] ?? DEFAULT_SHADOW_OPTIONS.recordWindowSeconds,
    windowSeconds: numbers["--window-seconds"] ?? DEFAULT_SHADOW_OPTIONS.windowSeconds,
    minProbability: numbers["--min-probability"] ?? DEFAULT_SHADOW_OPTIONS.minProbability,
    minEdge: numbers["--min-edge"] ?? DEFAULT_SHADOW_OPTIONS.minEdge,
    shares: numbers["--shares"] ?? DEFAULT_SHADOW_OPTIONS.shares,
    delaySeconds: numbers["--delay-seconds"] ?? DEFAULT_SHADOW_OPTIONS.delaySeconds,
    lookbackHours: numbers["--lookback-hours"] ?? DEFAULT_SHADOW_OPTIONS.lookbackHours,
    aheadHours: numbers["--ahead-hours"] ?? DEFAULT_SHADOW_OPTIONS.aheadHours,
    once,
    durationMs,
    quiet
  };
}

function scoreboardUrl(espnSport: string, date: string): string {
  return `https://site.api.espn.com/apis/site/v2/sports/${espnSport}/scoreboard?dates=${date}`;
}

function summaryUrl(espnSport: string, espnId: string): string {
  return `https://site.api.espn.com/apis/site/v2/sports/${espnSport}/summary?event=${encodeURIComponent(espnId)}`;
}

function recordSummary(record: Record<string, unknown>): string {
  switch (record.kind) {
    case "signal": return `${String(record.key)} ${String(record.side)} ask=${String(record.ask)} limit=${String(record.limitPrice)} edge=${String(record.edge)}`;
    case "fill-check": return `${String(record.signalId)} elapsed=${String(record.elapsedMs)}ms filled=${String((record.fill as Record<string, unknown> | undefined)?.filledShares)}`;
    case "settlement": return `${String(record.key)} winner=${String((record.final as Record<string, unknown> | undefined)?.winner)} signals=${String(record.signalCount)}`;
    case "error": return `${String(record.scope)} ${String(record.message)}`;
    case "run-start": return `league=${String(record.league)} model=${String((record.model as Record<string, unknown> | undefined)?.datasetSha256).slice(0, 12)}`;
    case "run-end": return `iterations=${String(record.iterations)} tracked=${String(record.tracked)} signals=${String(record.signals)}`;
    default: return "";
  }
}

export async function runShadowCli(args: readonly string[], deps: ShadowCliDependencies = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => { process.stdout.write(text); });
  let parsed: ParsedShadowArgs;
  try {
    parsed = parseShadowArgs(args, (deps.now ?? Date.now)());
  } catch (error) {
    write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (parsed.command === "help") {
    write(`${shadowHelp()}\n`);
    return 0;
  }
  try {
    const league = SHADOW_LEAGUES[parsed.league]!;
    const model = parseLateScoreModel(JSON.parse(await (deps.readFile ?? (path => readFile(path, "utf8")))(parsed.modelPath)) as unknown);
    if (model.league !== league.name) {
      invalid(`model league ${model.league} does not match --league ${league.name}`);
    }
    const outPath = resolve(parsed.outPath);
    await (deps.mkdir ?? (path => mkdir(path, { recursive: true }).then(() => undefined)))(dirname(outPath));
    const now = deps.now ?? Date.now;
    const request = (url: string) => fetchJson<unknown>(url, {
      timeoutMs: 30_000,
      ...(parsed.proxyUrl === undefined ? {} : { proxyUrl: parsed.proxyUrl })
    });
    const appendRecord = deps.appendRecord ?? (async (path: string, record: Record<string, unknown>) => {
      await appendFile(path, `${JSON.stringify(record)}\n`);
    });
    const options: ShadowMonitorOptions = {
      league, model, shadowOnly: true,
      pollIntervalMs: parsed.intervalMs, idlePollIntervalMs: parsed.idleIntervalMs,
      discoveryIntervalMs: parsed.discoveryIntervalMs, recordWindowSeconds: parsed.recordWindowSeconds,
      windowSeconds: parsed.windowSeconds, minProbability: parsed.minProbability, minEdge: parsed.minEdge,
      limitOffset: DEFAULT_SHADOW_OPTIONS.limitOffset, maxPrice: DEFAULT_SHADOW_OPTIONS.maxPrice,
      shares: parsed.shares, delaySeconds: parsed.delaySeconds,
      followupWindowSeconds: DEFAULT_SHADOW_OPTIONS.followupWindowSeconds,
      followupStepSeconds: DEFAULT_SHADOW_OPTIONS.followupStepSeconds,
      heartbeatIntervalMs: DEFAULT_SHADOW_OPTIONS.heartbeatIntervalMs,
      lookbackHours: parsed.lookbackHours, aheadHours: parsed.aheadHours,
      ...(parsed.once ? { maxIterations: 1 } : {}),
      ...(parsed.durationMs === undefined ? {} : { durationMs: parsed.durationMs })
    };
    const runDeps: ShadowMonitorDeps = {
      now,
      discoverMarkets: (target, window) => discoverLeagueMarkets(target, { request, now, ...window }),
      fetchScoreboard: async (target, date) => parseScoreboard(await request(scoreboardUrl(target.espnSport, date))),
      fetchSummary: async (target, espnId) => parseSummary(await request(summaryUrl(target.espnSport, espnId))),
      fetchBook: tokenId => fetchMarketBook(tokenId, { request, now }),
      sink: async record => {
        await appendRecord(outPath, record);
        if (!parsed.quiet) {
          const kind = String(record.kind);
          if (LOG_KINDS.has(kind)) {
            write(`${String(record.at)} ${kind} ${recordSummary(record)}\n`);
          }
        }
      }
    };
    const run = deps.run ?? runLateGameShadow;
    const summary = await run(options, runDeps);
    if (!parsed.quiet) {
      write(`shadow run finished: iterations=${summary.iterations} tracked=${summary.trackedGames} signals=${summary.signals} out=${outPath}\n`);
    }
    return 0;
  } catch (error) {
    write(`shadow failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runShadowCli(process.argv.slice(2));
}
