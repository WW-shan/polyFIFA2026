import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchHttpResponseText, type HttpOptions, type HttpResponseText } from "../polymarket/http.js";
import { normalizeCollectorEvent } from "../collector/catalog.js";
import { arrayValue, identifier, objectValue } from "../collector/replay-values.js";
import type { TailBookChange, TailSecond, TailSummary } from "../collector/tail-types.js";
import { resolvePayouts } from "./history.js";
import type { TailBacktestInput, TailSettlement } from "./tail-backtest-types.js";
export interface ArchiveFingerprint { name: string; bytes: number; sha256: string }
export interface LoadedTailArchive { input: TailBacktestInput; provenance: { directory: string; files: ArchiveFingerprint[] } }
export interface SettlementObservation { provider: "gamma" | "clob"; sourceUrl: string; observedAtMs: number; response: HttpResponseText }
export interface SettlementCollection { settlements: TailSettlement[]; observations: SettlementObservation[]; errors: string[] }
export interface SettlementCollectionOptions {
  proxyUrl?: string; signal?: AbortSignal; now?: () => number;
  request?: (url: string, options?: HttpOptions) => Promise<HttpResponseText>;
}
const INPUTS = ["manifest.json", "quality.json", "seconds.ndjson", "changes.ndjson"] as const;
function invalid(message: string): never { throw new Error("TAIL_BACKTEST_INPUT_INVALID: " + message); }
function same(left: Stats, right: Stats): boolean {
  return right.isFile() && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
async function readInput(path: string, name: string, expected: Stats, maxBytes: number): Promise<{ value: unknown; fingerprint: ArchiveFingerprint }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let input: ReturnType<typeof file.createReadStream> | undefined;
  try {
    if (!same(expected, await file.stat())) invalid("file changed before read: " + name);
    input = file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
    const hash = createHash("sha256"), decoder = new TextDecoder("utf-8", { fatal: true });
    const ndjson = name.endsWith(".ndjson"), rows: unknown[] = [];
    let pending = "", bytes = 0;
    for await (const chunk of input) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error("TAIL_BACKTEST_INPUT_TOO_LARGE: " + name);
      hash.update(chunk); pending += decoder.decode(chunk, { stream: true });
      if (ndjson) {
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (!line || Buffer.byteLength(line) > 16 * 1024 * 1024) invalid("invalid/oversized NDJSON line: " + name);
          rows.push(JSON.parse(line));
          if (rows.length > 1_000_000) throw new Error("TAIL_BACKTEST_INPUT_TOO_LARGE: record limit");
        }
        if (Buffer.byteLength(pending) > 16 * 1024 * 1024) throw new Error("TAIL_BACKTEST_INPUT_TOO_LARGE: line limit");
      }
    }
    pending += decoder.decode();
    if (ndjson && pending.length) invalid("missing final newline: " + name);
    if (!same(expected, await file.stat()) || bytes !== expected.size) invalid("file changed while reading: " + name);
    return { value: ndjson ? rows : JSON.parse(pending), fingerprint: { name, bytes, sha256: hash.digest("hex") } };
  } finally { input?.destroy(); await file.close(); }
}

export async function loadTailArchive(directory: string, options: { sport?: string; maxFileBytes?: number } = {}): Promise<LoadedTailArchive> {
  const path = resolve(directory), maximum = options.maxFileBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 512 * 1024 * 1024) invalid("maxFileBytes");
  if (!(await lstat(path)).isDirectory()) invalid("archive directory must not be a symlink");
  const stamps = new Map<string, Stats>();
  for (const name of INPUTS) {
    const stamp = await lstat(join(path, name));
    if (!stamp.isFile()) invalid("input is not a regular file: " + name);
    if (stamp.size > maximum || (name.endsWith(".json") && stamp.size > 32 * 1024 * 1024)) throw new Error("TAIL_BACKTEST_INPUT_TOO_LARGE: " + name);
    stamps.set(name, stamp);
  }
  const values = new Map<string, unknown>(), files: ArchiveFingerprint[] = [];
  for (const name of INPUTS) {
    const result = await readInput(join(path, name), name, stamps.get(name)!, maximum);
    values.set(name, result.value); files.push(result.fingerprint);
  }
  for (const name of INPUTS) if (!same(stamps.get(name)!, await lstat(join(path, name)))) invalid("input changed across load: " + name);
  const manifest = objectValue(values.get("manifest.json")), summary = values.get("quality.json") as TailSummary;
  const seconds = values.get("seconds.ndjson") as TailSecond[], changes = values.get("changes.ndjson") as TailBookChange[];
  if (manifest?.status !== "complete" || manifest.depthFile !== "seconds.ndjson" || manifest.sourceRunId !== summary?.runId
    || summary?.schemaVersion !== 1 || summary.basis !== "received-order-book-tail" || !Array.isArray(summary.windows) || !Array.isArray(summary.tokens)
    || manifest.depthFileBytes !== stamps.get("seconds.ndjson")!.size || manifest.seconds !== seconds.length || summary.seconds !== seconds.length
    || manifest.changes !== changes.length || summary.changes !== changes.length) invalid("manifest, source or record counts do not match");
  const canonical = await realpath(path);
  const input: TailBacktestInput = { sourceId: canonical, sport: options.sport?.trim() || "unknown", summary, seconds, changes };
  const markets = expectedMarkets([input]), archived = archivedVectors(markets);
  input.settlements = [...archived.vectors].flatMap(([marketId, rows]) => {
    const market = markets.get(marketId)!;
    // This is the source archive's as-of evidence, not a new exchange request.
    return rows.map(row => ({ marketId, conditionId: market.conditionId, ...row,
      source: "gamma-resolved-prices" as const, observedAtMs: summary.lastReceivedAtMs,
      sourceUrl: pathToFileURL(join(canonical, "quality.json")).href }));
  });
  if (archived.conflicts.size) input.summary = { ...summary,
    warnings: [...summary.warnings, ...[...archived.conflicts].map(archivedConflict)] };
  return { input, provenance: { directory: canonical, files } };
}

interface ExpectedMarket {
  marketId: string; conditionId: string; tokens: Set<string>;
  eventOwners: Set<string>; rawCopies: Record<string, unknown>[];
}
function expectedMarkets(inputs: readonly TailBacktestInput[]): Map<string, ExpectedMarket> {
  const result = new Map<string, ExpectedMarket>();
  for (const input of inputs) for (const window of input.summary.windows) for (const market of window.markets) {
    const before = result.get(market.marketId);
    if (before && before.conditionId !== market.conditionId) invalid("conflicting market condition");
    const current = before ?? { marketId: market.marketId, conditionId: market.conditionId, tokens: new Set<string>(),
      eventOwners: new Set<string>(), rawCopies: [] };
    current.eventOwners.add(JSON.stringify([market.eventId, market.eventSlug]));
    current.rawCopies.push(market.raw);
    current.tokens.add(market.tokenId); result.set(market.marketId, current);
  }
  return result;
}
function exactIds(ids: readonly unknown[], expected: Set<string>): ids is string[] {
  return ids.length === expected.size && ids.every((id): id is string => typeof id === "string" && expected.has(id)) && new Set(ids).size === ids.length;
}
function archivedConflict(marketId: string): string { return "conflicting archived settlement evidence: " + marketId; }
/** Every outcome row retains a raw copy. Never let first-copy order choose a winner. */
function archivedVectors(markets: Map<string, ExpectedMarket>): {
  vectors: Map<string, Array<{ tokenId: string; payout: number }>>; conflicts: Set<string>;
} {
  const vectors = new Map<string, Array<{ tokenId: string; payout: number }>>(), conflicts = new Set<string>();
  for (const market of markets.values()) for (const raw of market.rawCopies) {
    if (raw?.closed !== true || raw.umaResolutionStatus !== "resolved") continue;
    if (identifier(raw.id) !== market.marketId || raw.conditionId !== market.conditionId) invalid("archived settlement identity mismatch: " + market.marketId);
    const ids = arrayValue(raw.clobTokenIds), outcomes = arrayValue(raw.outcomes);
    if (!exactIds(ids, market.tokens) || outcomes.length !== ids.length || outcomes.length < 2
      || outcomes.some(outcome => typeof outcome !== "string" || !outcome.trim())) invalid("archived settlement cardinality/identity mismatch: " + market.marketId);
    const payouts = resolvePayouts(raw, ids.length); if (!payouts) continue;
    const rows = ids.map((tokenId, index) => ({ tokenId, payout: payouts[index]! })), previous = vectors.get(market.marketId);
    if (previous && previous.some(row => rows.find(next => next.tokenId === row.tokenId)?.payout !== row.payout)) {
      vectors.delete(market.marketId); conflicts.add(market.marketId);
    }
    if (!conflicts.has(market.marketId)) vectors.set(market.marketId, rows);
  }
  return { vectors, conflicts };
}

export async function collectTailSettlements(inputs: readonly TailBacktestInput[], options: SettlementCollectionOptions = {}): Promise<SettlementCollection> {
  const result: SettlementCollection = { settlements: [], observations: [], errors: [] };
  const markets = expectedMarkets(inputs), archived = archivedVectors(markets);
  const vectors = new Map<string, TailSettlement[]>(), conflicts = archived.conflicts;
  result.errors.push(...[...conflicts].map(archivedConflict));
  const accept = (rows: TailSettlement[]): void => {
    if (!rows.length || conflicts.has(rows[0]!.marketId)) return;
    const id = rows[0]!.marketId, previous = vectors.get(id);
    if (previous && previous.some(row => rows.find(next => next.tokenId === row.tokenId)?.payout !== row.payout)) {
      vectors.delete(id); conflicts.add(id); result.errors.push("conflicting settlement evidence: " + id); return;
    }
    vectors.set(id, rows);
  };
  for (const input of inputs) {
    const byMarket = new Map<string, TailSettlement[]>();
    for (const row of input.settlements ?? []) { const list = byMarket.get(row.marketId) ?? []; list.push(row); byMarket.set(row.marketId, list); }
    for (const rows of byMarket.values()) accept(rows);
  }
  const request = options.request ?? fetchHttpResponseText;
  const observe = async (provider: SettlementObservation["provider"], url: string) => {
    options.signal?.throwIfAborted();
    const response = await request(url, { timeoutMs: 10_000, ...(options.proxyUrl ? { proxyUrl: options.proxyUrl } : {}),
      ...(options.signal ? { signal: options.signal } : {}) });
    const observedAtMs = (options.now ?? Date.now)();
    result.observations.push({ provider, sourceUrl: url, observedAtMs, response });
    if (response.status < 200 || response.status >= 300) throw new Error("settlement HTTP " + response.status + ": " + url);
    return { raw: JSON.parse(response.body) as unknown, observedAtMs };
  };
  const slugs = new Map<string, { eventIds: Set<string>; gameIds: Set<string> }>();
  for (const input of inputs) for (const window of input.summary.windows) for (const slug of window.eventSlugs) {
    const value = slugs.get(slug) ?? { eventIds: new Set<string>(), gameIds: new Set<string>() };
    window.eventIds.forEach(id => value.eventIds.add(id)); if (window.gameId !== null) value.gameIds.add(window.gameId); slugs.set(slug, value);
  }
  for (const [slug, identity] of slugs) {
    const url = "https://gamma-api.polymarket.com/events/slug/" + encodeURIComponent(slug);
    try {
      const observed = await observe("gamma", url), event = normalizeCollectorEvent(observed.raw);
      if (!event || event.eventSlug !== slug || !identity.eventIds.has(event.eventId)
        || (identity.gameIds.size && (event.gameId === null || !identity.gameIds.has(event.gameId)))) throw new Error("settlement event identity mismatch: " + slug);
      for (const market of event.markets) {
        const expected = markets.get(market.marketId); if (!expected) continue;
        if (!expected.eventOwners.has(JSON.stringify([event.eventId, event.eventSlug]))) throw new Error("settlement event ownership mismatch: " + market.marketId);
        if (market.conditionId !== expected.conditionId || !exactIds(market.tokenIds, expected.tokens)) throw new Error("settlement market identity mismatch: " + market.marketId);
        const payouts = resolvePayouts(market.raw, market.tokenIds.length); if (!payouts) continue;
        accept(market.tokenIds.map((tokenId, index) => ({ marketId: market.marketId, conditionId: market.conditionId, tokenId,
          payout: payouts[index]!, source: "gamma-resolved-prices", observedAtMs: observed.observedAtMs, sourceUrl: url })));
      }
    } catch (error) { options.signal?.throwIfAborted(); result.errors.push(String(error)); }
  }
  for (const market of markets.values()) {
    if (vectors.has(market.marketId) || conflicts.has(market.marketId)) continue;
    const url = "https://clob.polymarket.com/markets/" + encodeURIComponent(market.conditionId);
    try {
      const observed = await observe("clob", url), raw = objectValue(observed.raw), tokens = raw?.tokens;
      if (raw?.condition_id !== market.conditionId || raw.closed !== true || !Array.isArray(tokens)) throw new Error("unresolved/mismatched CLOB market: " + market.marketId);
      const values = tokens.map(objectValue), ids = values.map(token => token?.token_id);
      if (!exactIds(ids, market.tokens) || values.some(token => typeof token?.winner !== "boolean")
        || values.filter(token => token?.winner === true).length !== 1) throw new Error("ambiguous CLOB winner flags: " + market.marketId);
      accept(ids.map((tokenId, index) => ({ marketId: market.marketId, conditionId: market.conditionId, tokenId,
        payout: values[index]!.winner === true ? 1 : 0, source: "clob-winner-flags", observedAtMs: observed.observedAtMs, sourceUrl: url })));
    } catch (error) { options.signal?.throwIfAborted(); result.errors.push(String(error)); }
  }
  result.settlements = [...vectors.values()].flat();
  return result;
}
