import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportTail } from "./tail-export.js";
import type { TailExportResult } from "./tail-export.js";
import { objectValue } from "./replay-values.js";
import type { CompactStoredRecord, CompactTailStore } from "./continuous-tail-store.js";
import { isPublishedFinishSource, isTailFinishSource } from "./tail-types.js";
import type { JournalRecord } from "./types.js";

export interface CompactExportOptions {
  outputDirectory: string;
  /** Holding window in seconds; the exported archive adds one reference second before it. */
  windowSeconds?: number;
  /**
   * How long a carried book may go unrefreshed before it is reported stale.
   *
   * The compact store's only periodic full-depth evidence is the HTTP anchor
   * pass, which runs once a minute, so the tail exporter's 30s WebSocket
   * default would flag half of a quiet window as stale even though the next
   * anchor proves the book never moved. Allow two anchor intervals by default.
   */
  maxFeedSilenceMs?: number;
  /**
   * Market identity to use when the store has none.
   *
   * Matches finalized before the identity column existed kept their market
   * shape only in the raw run. Supplying it here lets those tails be exported
   * too, instead of being permanently unreplayable.
   */
  metadataOverride?: Record<string, unknown>;
  /** Scratch directory for the reconstructed journal; a temp dir is used by default. */
  workDirectory?: string;
}

export interface CompactExportResult {
  gameKey: string;
  journalDirectory: string;
  records: number;
  anchorFrames: number;
  windowComplete: boolean;
  missingFrontMs: number;
  largestGapMs: number;
  finishAnchor: string | null;
  archive: TailExportResult;
}

const DEFAULT_WINDOW_SECONDS = 180;
/** A backtest entry at the holding-window boundary must read the prior second, never its future. */
const ENTRY_REFERENCE_SECONDS = 1;
const DEFAULT_MAX_FEED_SILENCE_MS = 90_000;
const SYNTHETIC_CONNECTION = "compact-anchor";

function safeRunId(gameKey: string): string {
  return `compact-${gameKey.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 96)}`;
}

/**
 * The Gamma event document a replay needs, rebuilt from the trimmed copy the
 * store keeps with each finalized match.
 *
 * A published match clock is carried through so the window boundary has the
 * provenance it really had. A book anchor must not be written as
 * `finishedTimestamp`: that field means "Gamma published this finish", and
 * inventing it would let a market-tail fallback masquerade as a real clock.
 * The generated finish-facts sidecar still supplies the boundary, labelled
 * `book-quiet` / `book-tail`.
 */
function eventDocument(metadata: Record<string, unknown>, finishedAtMs: number,
  finishAnchor: string | null): Record<string, unknown> {
  if (!isPublishedFinishSource(finishAnchor)) return { ...metadata };
  return { ...metadata, finishedTimestamp: new Date(finishedAtMs).toISOString() };
}

/**
 * Turn a stored HTTP anchor into the full-depth book frame the replay engine
 * understands.
 *
 * `replay.ts` seeds order books from WebSocket `book` frames only; it treats
 * `book_snapshot` records as audit evidence. A compact tail keeps just the last
 * few minutes, by which time the subscription's original `book` push is long
 * pruned, so without this conversion a finalized match replays to zero valid
 * seconds no matter how complete its anchors are.
 */
function anchorBookFrame(record: CompactStoredRecord): Record<string, unknown> | undefined {
  const data = objectValue(record.data);
  const response = objectValue(data?.response);
  if (!data || !response) return undefined;
  const assetId = typeof response.asset_id === "string" ? response.asset_id
    : typeof data.tokenId === "string" ? data.tokenId : undefined;
  if (!assetId || !Array.isArray(response.bids) || !Array.isArray(response.asks)) return undefined;
  const frame: Record<string, unknown> = { event_type: "book", asset_id: assetId, bids: response.bids, asks: response.asks };
  for (const [from, to] of [["market", "market"], ["timestamp", "timestamp"], ["hash", "hash"]] as const) {
    if (response[from] !== undefined) frame[to] = response[from];
  }
  return frame;
}

function clobFrameTokens(data: unknown): string[] {
  const parsed = objectValue(data);
  const frames = Array.isArray(parsed) ? parsed : [parsed];
  const tokens = new Set<string>();
  for (const value of frames) {
    const frame = objectValue(value);
    if (!frame) continue;
    if (typeof frame.asset_id === "string") tokens.add(frame.asset_id);
    if (Array.isArray(frame.price_changes)) for (const change of frame.price_changes) {
      const tokenId = objectValue(change)?.asset_id;
      if (typeof tokenId === "string") tokens.add(tokenId);
    }
  }
  return [...tokens];
}

/**
 * Rebuild a replayable journal for one finalized compact match.
 *
 * Everything the export pipeline needs is derived from the store: the market
 * identity from the trimmed event document, the frames from `tail_records`, and
 * the window boundary from the recorded finish anchor. The generated journal
 * therefore carries the same provenance as the source run without keeping the
 * raw run itself.
 */
export async function exportCompactMatch(store: CompactTailStore, gameKey: string, options: CompactExportOptions): Promise<CompactExportResult> {
  const holdingWindowSeconds = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const maxFeedSilenceMs = options.maxFeedSilenceMs ?? DEFAULT_MAX_FEED_SILENCE_MS;
  if (!Number.isSafeInteger(holdingWindowSeconds) || holdingWindowSeconds < 1 || holdingWindowSeconds > 3599) {
    throw new Error("COMPACT_EXPORT_OPTIONS_INVALID: windowSeconds");
  }
  const windowSeconds = holdingWindowSeconds + ENTRY_REFERENCE_SECONDS;
  if (!Number.isFinite(maxFeedSilenceMs) || maxFeedSilenceMs <= 0) throw new Error("COMPACT_EXPORT_OPTIONS_INVALID: maxFeedSilenceMs");
  const coverage = store.readMatchCoverage(gameKey);
  if (!coverage) throw new Error("COMPACT_EXPORT_UNKNOWN_MATCH: " + gameKey);
  const metadata = store.readMatchMetadata(gameKey) ?? options.metadataOverride ?? null;
  if (!metadata) throw new Error("COMPACT_EXPORT_NO_METADATA: " + gameKey);
  const records = store.readFinalized(gameKey);
  if (records.length === 0) throw new Error("COMPACT_EXPORT_EMPTY: " + gameKey);

  const runId = safeRunId(gameKey);
  const firstMs = records[0]!.receivedAtMs;
  let sequence = 0;
  const lines: string[] = [];
  const emit = (source: JournalRecord["source"], kind: string, receivedAtMs: number, data: unknown, connectionId?: string): void => {
    sequence += 1;
    const envelope: Record<string, unknown> = { schemaVersion: 1, runId, sequence,
      receivedAt: new Date(receivedAtMs).toISOString(), receivedAtMs,
      monotonicNs: String((receivedAtMs - firstMs) * 1_000_000 + sequence), source, kind, data };
    if (connectionId !== undefined) envelope.connectionId = connectionId;
    lines.push(JSON.stringify(envelope));
  };

  const observedConnection = records.map(record => record.kind === "ws_message" ? record.connectionId : undefined)
    .find((value): value is string => value !== undefined);
  const fallbackConnection = observedConnection ?? SYNTHETIC_CONNECTION;
  const activeConnections = new Set<string>();
  const lastConnectionByToken = new Map<string, string>();
  let lastClobConnection: string | undefined;
  let sawLifecycle = false;

  emit("collector", "session_start", firstMs, { config: { runId }, status: "starting", startedAt: new Date(firstMs).toISOString() });
  emit("gamma", "event_metadata", firstMs, { event: eventDocument(metadata, coverage.finishedAtMs, coverage.finishAnchor) });

  let anchorFrames = 0;
  for (const record of records) {
    if (record.source === "collector" && record.connectionId) {
      sawLifecycle = true;
      if (record.kind === "connection_open") activeConnections.add(record.connectionId);
      else if (["connection_close", "connection_gap", "connection_timeout", "heartbeat_timeout"].includes(record.kind)) activeConnections.delete(record.connectionId);
    }
    if (record.source === "clob" && record.kind === "ws_message" && record.connectionId) {
      activeConnections.add(record.connectionId);
      lastClobConnection = record.connectionId;
      for (const tokenId of clobFrameTokens(record.data)) lastConnectionByToken.set(tokenId, record.connectionId);
    }
    if (record.kind === "book_snapshot") {
      const frame = anchorBookFrame(record);
      if (frame === undefined) continue;
      const tokenId = typeof frame.asset_id === "string" ? frame.asset_id : undefined;
      const preferred = tokenId === undefined ? undefined : lastConnectionByToken.get(tokenId);
      const activeLast = [...activeConnections].at(-1);
      const anchorConnection = preferred !== undefined && (!sawLifecycle || activeConnections.has(preferred)) ? preferred
        : lastClobConnection !== undefined && (!sawLifecycle || activeConnections.has(lastClobConnection)) ? lastClobConnection
        : sawLifecycle ? activeLast ?? SYNTHETIC_CONNECTION : fallbackConnection;
      // Keep the anchor as audit evidence, then seed the active connection's book.
      emit("clob", "book_snapshot", record.receivedAtMs, record.data);
      emit("clob", "ws_message", record.receivedAtMs, frame, anchorConnection);
      anchorFrames += 1;
      continue;
    }
    emit(record.source, record.kind, record.receivedAtMs, record.data, record.connectionId);
  }
  // A repaired `book-quiet` boundary can precede the terminal clearing frame
  // that is still retained as evidence. The journal must remain monotonic, so
  // close the run after every emitted record while the finish fact continues
  // to define the replay window end.
  const sessionEndAtMs = Math.max(coverage.finishedAtMs, records.at(-1)?.receivedAtMs ?? coverage.finishedAtMs);
  emit("collector", "session_end", sessionEndAtMs, { status: "stopped", endedAt: new Date(sessionEndAtMs).toISOString() });

  const workRoot = options.workDirectory === undefined
    ? await mkdtemp(join(tmpdir(), "compact-export-"))
    : await (async () => { const directory = resolve(options.workDirectory!); await mkdir(directory, { recursive: true }); return directory; })();
  const journalDirectory = join(workRoot, "journal");
  try {
    await mkdir(journalDirectory, { recursive: true });
    const day = new Date(firstMs).toISOString().slice(0, 10);
    await writeFile(join(journalDirectory, `${day}-000000.ndjson`), lines.join("\n") + "\n");
    const factsFile = join(workRoot, "finish-facts.json");
    await writeFile(factsFile, JSON.stringify({ schemaVersion: 1, kind: "tail-finish-facts", runId,
      facts: finishFacts(metadata, coverage, runId, records[0]!.sequence) }) + "\n");
    const archive = await exportTail({ runDirectory: journalDirectory, outputDirectory: resolve(options.outputDirectory),
      windowSeconds, maxFeedSilenceMs, clockPolicy: "flag-backsteps", compressRawEvents: true, finishFactsFile: factsFile });
    return { gameKey, journalDirectory, records: records.length, anchorFrames,
      windowComplete: coverage.windowComplete, missingFrontMs: coverage.missingFrontMs,
      largestGapMs: coverage.largestGapMs, finishAnchor: coverage.finishAnchor, archive };
  } finally {
    if (options.workDirectory === undefined) await rm(workRoot, { recursive: true, force: true });
  }
}

function finishFacts(metadata: Record<string, unknown>, coverage: { finishedAtMs: number; finishAnchor: string | null;
  finishFacts: readonly unknown[] }, runId: string, sequence: number): unknown[] {
  // Preserve every witness recorded before finalization. Only synthesize a
  // fallback fact for legacy matches whose schema predates finish evidence.
  if (coverage.finishFacts.length > 0) return coverage.finishFacts.map(fact => ({ ...(fact as Record<string, unknown>) }));
  // Keep the recorded anchor verbatim. Collapsing `book-tail` into
  // `book-quiet` would misreport how the boundary was actually chosen.
  const anchor = isTailFinishSource(coverage.finishAnchor) ? coverage.finishAnchor : "book-quiet";
  return [{ eventId: typeof metadata.id === "string" ? metadata.id : null,
    eventSlug: typeof metadata.slug === "string" ? metadata.slug : null,
    gameId: typeof metadata.gameId === "string" ? metadata.gameId : null,
    atMs: coverage.finishedAtMs, observedAtMs: coverage.finishedAtMs, source: anchor,
    sourceRunId: runId, sourceRunDirectory: null, sequence, frameIndex: 0 }];
}
