import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { JsonRequester } from "../collector/types.js";
import { fetchHttpResponseText, type HttpResponseText } from "../polymarket/http.js";
import { isResearchMatch, normalizeResearchEvent, normalizeResearchTrade, objectValue } from "./history.js";
import type { ResearchDataset, ResearchEvent, ResearchMarket, ResearchSelection, ResearchTrade, TradeCoverage } from "./types.js";

export interface ResearchRequestRecord { url: string; startedAt: string; endedAt: string; response?: unknown; httpResponse?: HttpResponseText; error?: string }
export interface ResearchDownloadDependencies {
  request?: JsonRequester;
  requestRaw?: (url: string) => Promise<HttpResponseText>;
  now?: () => number;
  onRequest?: (record: ResearchRequestRecord) => void | Promise<void>;
  onProgress?: (message: string) => void;
}
export interface TradeDownloadOptions { pageSize?: number; maxPages?: number; baseUrl?: string }
export interface ResearchDownloadOptions {
  outputDirectory: string; sport: string; tagId?: string; maxEvents?: number; maxCatalogPages?: number;
  requireFinish?: boolean; eventSlugs?: string[]; marketTypes?: string[]; concurrency?: number;
  tradePageSize?: number; maxTradePages?: number; proxyUrl?: string; timeoutMs?: number;
  gammaBaseUrl?: string; dataBaseUrl?: string;
}
export interface ResearchDownloadResult { datasetPath: string; eventCount: number; marketCount: number; tradeCount: number; incompleteMarkets: number }
const SPORT_TAGS: Record<string, string> = { tennis: "864", "table-tennis": "103767", cs2: "100780", dota2: "102366", valorant: "101672" };
function invalid(message: string): Error { return new Error(`RESEARCH_OPTIONS_INVALID: ${message}`); }
class RecordingError extends Error {
  constructor(cause: unknown) { super(`RESEARCH_RECORDING_FAILED: ${String(cause)}`, { cause }); }
}
function positive(value: number | undefined, fallback: number, name: string, max = 100_000): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw invalid(`${name} must be an integer in 1..${max}`);
  return result;
}

async function requestRecorded(url: string, deps: ResearchDownloadDependencies): Promise<unknown> {
  const now = deps.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  let response: unknown;
  let httpResponse: HttpResponseText | undefined;
  let failure: unknown;
  let failed = false;
  try {
    if (deps.requestRaw || !deps.request) {
      httpResponse = await (deps.requestRaw ?? fetchHttpResponseText)(url);
      if (httpResponse.status < 200 || httpResponse.status >= 300) throw new Error(`HTTP ${httpResponse.status} ${httpResponse.statusText} for ${url}`);
      response = JSON.parse(httpResponse.body) as unknown;
    } else response = await deps.request(url);
  } catch (error) {
    failure = error; failed = true;
  }
  const record: ResearchRequestRecord = { url, startedAt, endedAt: new Date(now()).toISOString(),
    ...(httpResponse ? { httpResponse } : {}), ...(failed ? { error: String(failure) } : { response }) };
  try { await deps.onRequest?.(record); }
  catch (error) { throw new RecordingError(error); }
  if (failed) throw failure;
  return response;
}

export async function fetchMarketTrades(market: ResearchMarket, fromMs: number, toMs: number, deps: ResearchDownloadDependencies, options: TradeDownloadOptions = {}): Promise<{ trades: ResearchTrade[]; coverage: TradeCoverage }> {
  const pageSize = positive(options.pageSize, 1000, "pageSize", 10_000);
  const maxPages = positive(options.maxPages, 11, "maxPages");
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs < 0 || toMs < fromMs) throw invalid("invalid trade time window");
  const coverage: TradeCoverage = {
    status: "incomplete", reason: "page-limit", fromMs: Math.floor(fromMs / 1000) * 1000, toMs: Math.ceil(toMs / 1000) * 1000,
    pages: 0, rawRows: 0, invalidRows: 0, duplicateRows: 0, oldestMs: null, newestMs: null
  };
  const trades: ResearchTrade[] = [];
  const tokenIds = market.outcomes.map(o => o.tokenId);
  const seenRows = new Set<string>();
  const seenPages = new Set<string>();
  let previousTimestamp = Infinity;
  let badOrdering = false;
  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    if (offset > 10_000) { coverage.reason = "api-offset-limit"; break; }
    const url = new URL(`${(options.baseUrl ?? "https://data-api.polymarket.com").replace(/\/+$/, "")}/trades`);
    url.search = new URLSearchParams({ market: market.conditionId, takerOnly: "true", limit: String(pageSize), offset: String(offset),
      start: String(coverage.fromMs / 1000), end: String(coverage.toMs / 1000) }).toString();
    let response: unknown;
    try { response = await requestRecorded(url.href, deps); }
    catch (error) {
      if (error instanceof RecordingError) throw error;
      coverage.status = "error"; coverage.reason = String(error); break;
    }
    coverage.pages++;
    if (!Array.isArray(response)) { coverage.reason = "invalid-trades-response"; break; }
    coverage.rawRows += response.length;
    const signature = createHash("sha256").update(JSON.stringify(response)).digest("hex");
    if (response.length > 0 && seenPages.has(signature)) { coverage.reason = "pagination-stalled"; break; }
    seenPages.add(signature);
    for (const raw of response) {
      const trade = normalizeResearchTrade(raw, market.conditionId, tokenIds);
      if (!trade || trade.timestampMs < coverage.fromMs || trade.timestampMs > coverage.toMs) { coverage.invalidRows++; continue; }
      if (trade.timestampMs > previousTimestamp) badOrdering = true;
      previousTimestamp = trade.timestampMs;
      if (seenRows.has(trade.id)) { coverage.duplicateRows++; continue; }
      seenRows.add(trade.id);
      trades.push(trade);
    }
    if (response.length < pageSize) {
      coverage.status = coverage.invalidRows || badOrdering ? "incomplete" : "complete";
      coverage.reason = coverage.invalidRows ? "invalid-trade-rows" : badOrdering ? "nonmonotonic-pages" : "api-window-exhausted";
      break;
    }
  }
  trades.sort((a, b) => a.timestampMs - b.timestampMs);
  coverage.oldestMs = trades[0]?.timestampMs ?? null;
  coverage.newestMs = trades.at(-1)?.timestampMs ?? null;
  return { trades, coverage };
}

async function discover(options: ResearchDownloadOptions, selection: ResearchSelection, deps: ResearchDownloadDependencies): Promise<ResearchEvent[]> {
  const base = (options.gammaBaseUrl ?? "https://gamma-api.polymarket.com").replace(/\/+$/, "");
  const result: ResearchEvent[] = [];
  const seen = new Set<string>();
  const seenPages = new Set<string>();
  const add = (value: unknown): void => {
    const event = normalizeResearchEvent(value, options.sport);
    if (!event || !isResearchMatch(event) || event.raw.closed !== true) { selection.skippedNonMatches++; return; }
    if (seen.has(event.eventId) || seen.has(event.eventSlug)) return;
    seen.add(event.eventId); seen.add(event.eventSlug);
    if (options.requireFinish && event.finishMs === null) { selection.skippedMissingFinish++; return; }
    if (selection.marketTypes.length) event.markets = event.markets.filter(m => selection.marketTypes.includes(m.marketType));
    result.push(event);
  };
  if (selection.eventSlugs.length) {
    for (const slug of selection.eventSlugs) {
      const response = await requestRecorded(`${base}/events/slug/${encodeURIComponent(slug)}`, deps);
      selection.catalogPages++; selection.catalogRows++; add(response);
    }
    return result;
  }
  const maxPages = options.maxCatalogPages ?? 5;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${base}/events`);
    url.search = new URLSearchParams({ tag_id: selection.tagId, closed: "true", limit: "100", offset: String(page * 100), order: "endDate", ascending: "false" }).toString();
    const response = await requestRecorded(url.href, deps);
    const events = Array.isArray(response) ? response : objectValue(response)?.events;
    if (!Array.isArray(events)) throw new Error("RESEARCH_CATALOG_INVALID: expected events array");
    selection.catalogPages++; selection.catalogRows += events.length;
    const signature = JSON.stringify(events.map(value => objectValue(value)?.id ?? objectValue(value)?.slug).sort());
    if (events.length && seenPages.has(signature)) throw new Error("RESEARCH_CATALOG_STALLED");
    seenPages.add(signature);
    for (const value of events) {
      add(value);
      if (result.length >= selection.maxEvents) { selection.catalogTruncated = true; return result; }
    }
    if (events.length < 100) return result;
  }
  selection.catalogTruncated = true;
  return result;
}

export async function downloadResearchDataset(options: ResearchDownloadOptions, deps: ResearchDownloadDependencies = {}): Promise<ResearchDownloadResult> {
  const maxEvents = positive(options.maxEvents, 30, "maxEvents", 1000);
  positive(options.maxCatalogPages, 5, "maxCatalogPages", 200);
  const concurrency = positive(options.concurrency, 4, "concurrency", 16);
  const pageSize = positive(options.tradePageSize, 1000, "tradePageSize", 10_000);
  const maxPages = positive(options.maxTradePages, 11, "maxTradePages");
  const timeoutMs = positive(options.timeoutMs, 15_000, "timeoutMs", 300_000);
  if (!options.outputDirectory?.trim()) throw invalid("outputDirectory is required");
  const tagId = options.tagId ?? SPORT_TAGS[options.sport];
  if (!tagId?.trim()) throw invalid("unknown sport; supply tagId explicitly");
  for (const [name, list] of [["eventSlugs", options.eventSlugs], ["marketTypes", options.marketTypes]] as const) {
    if (list?.some(value => typeof value !== "string" || !value.trim())) throw invalid(`${name} must not contain empty values`);
  }
  if ((options.eventSlugs?.length ?? 0) > maxEvents) throw invalid("eventSlugs exceeds maxEvents");
  const outputDirectory = resolve(options.outputDirectory);
  await mkdir(dirname(outputDirectory), { recursive: true });
  await mkdir(outputDirectory); // EEXIST intentionally prevents overwriting evidence.
  await mkdir(join(outputDirectory, "raw"));
  const now = deps.now ?? Date.now;
  const createdAt = new Date(now()).toISOString();
  // Undefined delegates environment/NO_PROXY handling to the owned transport;
  // an explicit empty string is the supported direct-connection override.
  const proxyUrl = options.proxyUrl;
  let requestNumber = 0;
  const recorded: ResearchDownloadDependencies = {
    ...(deps.requestRaw ? { requestRaw: deps.requestRaw } : deps.request ? { request: deps.request } : {
      requestRaw: (url: string) => fetchHttpResponseText(url, { timeoutMs, ...(proxyUrl !== undefined ? { proxyUrl } : {}) })
    }), now,
    onRequest: async record => {
      const filename = `${String(++requestNumber).padStart(6, "0")}.json`;
      await writeFile(join(outputDirectory, "raw", filename), JSON.stringify(record) + "\n", { flag: "wx" });
      await deps.onRequest?.(record);
    }
  };
  const selection: ResearchSelection = { sport: options.sport, tagId, eventSlugs: [...new Set(options.eventSlugs ?? [])], marketTypes: [...new Set(options.marketTypes ?? [])],
    maxEvents, requireFinish: options.requireFinish ?? false, catalogPages: 0, catalogRows: 0, skippedNonMatches: 0, skippedMissingFinish: 0, catalogTruncated: false };
  try {
    const events = await discover(options, selection, recorded);
    const jobs = events.flatMap(event => event.markets.map(market => ({ event, market })));
    deps.onProgress?.(`Discovered ${events.length} matches, ${jobs.length} markets; downloading public trade windows`);
    let next = 0;
    let completed = 0;
    const downloadOne = async (): Promise<void> => {
      while (next < jobs.length) {
        const { event, market } = jobs[next++]!;
        const until = Math.min(now(), (event.finishMs ?? now()) + 15 * 60_000);
        const from = Math.max(0, (event.startMs ?? ((event.finishMs ?? now()) - 6 * 60 * 60_000)) - 5 * 60_000);
        if (from > until) {
          market.coverage = { status: "error", reason: "invalid-event-time-range", fromMs: from, toMs: until,
            pages: 0, rawRows: 0, invalidRows: 0, duplicateRows: 0, oldestMs: null, newestMs: null };
        } else {
          const result = await fetchMarketTrades(market, from, until, recorded, { pageSize, maxPages, ...(options.dataBaseUrl ? { baseUrl: options.dataBaseUrl } : {}) });
          market.trades = result.trades; market.coverage = result.coverage;
        }
        completed++;
        if (completed % 10 === 0 || completed === jobs.length) deps.onProgress?.(`Downloaded ${completed}/${jobs.length} markets`);
      }
    };
    // Await all workers even on a cache/callback failure; never leave background writes running.
    const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, jobs.length) }, downloadOne));
    const failure = workers.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    const dataset: ResearchDataset = { schemaVersion: 1, kind: "public-trade-history", createdAt, selection, events, warnings: [
      "A complete trade window means this public API was exhausted, not a complete historical order book or verified queue fills.",
      "Timestamp precision is seconds; same-second trade ordering and exact same-transaction duplicates are ambiguous.",
      "Closed-event discovery is a bounded retrospective sample, not the universe of all games or a forward profitability estimate."
    ] };
    const datasetPath = join(outputDirectory, "dataset.json");
    await writeFile(datasetPath, JSON.stringify(dataset) + "\n", { flag: "wx" });
    const result: ResearchDownloadResult = { datasetPath, eventCount: events.length, marketCount: jobs.length,
      tradeCount: jobs.reduce((sum, job) => sum + job.market.trades.length, 0),
      incompleteMarkets: jobs.filter(job => job.market.coverage?.status !== "complete").length };
    await writeFile(join(outputDirectory, "manifest.json"), JSON.stringify({ status: "complete", createdAt, finishedAt: new Date(now()).toISOString(), requests: requestNumber, ...result }) + "\n", { flag: "wx" });
    return result;
  } catch (error) {
    await writeFile(join(outputDirectory, "failure.json"), JSON.stringify({ status: "failed", error: String(error), requests: requestNumber }) + "\n", { flag: "wx" }).catch(() => {});
    throw error;
  }
}
