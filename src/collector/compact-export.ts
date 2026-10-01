import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { exportTail } from "./tail-export.js";
import type { TailExportResult } from "./tail-export.js";
import { decimal, frameType, objectValue, timestamp } from "./replay-values.js";
import type { CompactStoredRecord, CompactTailStore } from "./continuous-tail-store.js";
import { isFallbackFinishSource, isTailFinishSource } from "./tail-types.js";
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
  // Only Gamma may claim `finishedTimestamp`. A Sports boundary is carried by
  // the finish-facts sidecar; copying it here under Gamma's field would invent
  // an independent witness and turn every later Sports refinement into a
  // cross-source conflict.
  if (finishAnchor !== "gamma.finishedTimestamp") return { ...metadata };
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
 *
 * The REST `timestamp` is returned separately rather than copied into the
 * frame: it is the time of the book's last change, in the same clock domain as
 * the WebSocket event times, but a snapshot can still be older than deltas the
 * stream already delivered, or newer than deltas still in flight. Whether it
 * may be applied, and with which source time, depends on the stream around it.
 */
function anchorBookFrame(record: CompactStoredRecord): { frame: Record<string, unknown>; sourceTime: bigint | undefined } | undefined {
  const data = objectValue(record.data);
  const response = objectValue(data?.response);
  if (!data || !response) return undefined;
  const assetId = typeof response.asset_id === "string" ? response.asset_id
    : typeof data.tokenId === "string" ? data.tokenId : undefined;
  if (!assetId || !Array.isArray(response.bids) || !Array.isArray(response.asks)) return undefined;
  const frame: Record<string, unknown> = { event_type: "book", asset_id: assetId, bids: response.bids, asks: response.asks };
  // `market` and `hash` identify the depth this snapshot carries.
  for (const from of ["market", "hash"] as const) {
    if (response[from] !== undefined) frame[from] = response[from];
  }
  return { frame, sourceTime: timestamp(response.timestamp) };
}

/** Every object frame of a stored CLOB message, which may batch several. */
function clobFrames(data: unknown): Record<string, unknown>[] {
  return (Array.isArray(data) ? data : [data]).map(objectValue)
    .filter((frame): frame is Record<string, unknown> => frame !== undefined);
}

function clobFrameTokens(data: unknown): string[] {
  const tokens = new Set<string>();
  for (const frame of clobFrames(data)) {
    if (typeof frame.asset_id === "string") tokens.add(frame.asset_id);
    if (Array.isArray(frame.price_changes)) for (const change of frame.price_changes) {
      const tokenId = objectValue(change)?.asset_id;
      if (typeof tokenId === "string") tokens.add(tokenId);
    }
  }
  return [...tokens];
}

interface DepthChange { sourceTime: bigint; side: "bids" | "asks"; price: string; size: string }
interface DepthAssertion { tokenId: string; sourceTime: bigint | undefined; book: boolean; change?: DepthChange }

/**
 * The per-token source times a stored CLOB message asserts for the order book,
 * mirroring which fields `replay.ts` orders books and deltas by.
 */
function depthAssertions(data: unknown): DepthAssertion[] {
  const assertions: DepthAssertion[] = [];
  for (const frame of clobFrames(data)) {
    const type = frameType(frame);
    if ((type === "book" || (!type && frame.bids !== undefined && frame.asks !== undefined)) && typeof frame.asset_id === "string") {
      assertions.push({ tokenId: frame.asset_id, sourceTime: timestamp(frame.timestamp), book: true });
    } else if (type === "price_change" && Array.isArray(frame.price_changes)) {
      for (const item of frame.price_changes) {
        const change = objectValue(item);
        if (typeof change?.asset_id !== "string") continue;
        const sourceTime = timestamp(change.timestamp ?? frame.timestamp);
        const side = String(change.side ?? "").toUpperCase();
        const assertion: DepthAssertion = { tokenId: change.asset_id, sourceTime, book: false };
        if (sourceTime !== undefined && ["BUY", "SELL", "BID", "ASK"].includes(side)
          && typeof change.price === "string" && typeof change.size === "string") {
          assertion.change = { sourceTime, side: side === "BUY" || side === "BID" ? "bids" : "asks", price: change.price, size: change.size };
        }
        assertions.push(assertion);
      }
    }
  }
  return assertions;
}

/** Recent deltas kept per book, bounded so a silent anchor pass cannot grow them without limit. */
const MAX_PENDING_CHANGES = 4_096;
const PENDING_CHANGE_SPAN = 300_000n;

/**
 * What the replay will know about one connection's book for one token when an
 * anchor arrives.
 *
 * `watermark` is the newest source time the stream asserted. Recent deltas
 * are kept too, so a snapshot that is older than the stream can be brought
 * forward to it instead of reverting it; `forgottenThrough` is the newest
 * source time among the deltas no longer kept.
 */
interface DepthState { seeded: boolean; watermark?: bigint; pending: DepthChange[]; forgottenThrough?: bigint }

/**
 * A snapshot's depth advanced by every retained delta at or after its source
 * time, or undefined when a level cannot be read.
 *
 * Deltas carry absolute level sizes, so re-applying those with the snapshot's
 * own timestamp is harmless even if the snapshot already contained them.
 */
function advancedBook(frame: Record<string, unknown>, changes: readonly DepthChange[], from: bigint): { bids: unknown[]; asks: unknown[] } | undefined {
  const sides = { bids: new Map<string, unknown>(), asks: new Map<string, unknown>() };
  for (const side of ["bids", "asks"] as const) {
    for (const item of frame[side] as unknown[]) {
      const price = decimal(objectValue(item)?.price, true);
      if (!price) return undefined;
      sides[side].set(price.key, item);
    }
  }
  for (const change of changes) {
    if (change.sourceTime < from) continue;
    const price = decimal(change.price, true), size = decimal(change.size);
    if (!price || !size) return undefined;
    if (size.key === "0") sides[change.side].delete(price.key);
    else sides[change.side].set(price.key, { price: change.price, size: change.size });
  }
  return { bids: [...sides.bids.values()], asks: [...sides.asks.values()] };
}

/**
 * Connection ids are per-process counters (`clob-7-e1`) that every collector
 * run starts again, so a tail spanning a restart holds two unrelated
 * connections under one id. Without the run prefix the old run's
 * `connection_close` permanently closes the id and the replay rejects every
 * book the new run delivers on it.
 */
function runConnection(record: CompactStoredRecord): string | undefined {
  return record.connectionId === undefined ? undefined : `${record.runId}/${record.connectionId}`;
}

const CLOSING_KINDS = ["connection_close", "connection_gap", "connection_timeout", "heartbeat_timeout"];

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
  // One read snapshot: the collector keeps committing while an export runs,
  // and coverage, identity and frames must describe the same finalized tail.
  const { coverage, storedMetadata, records } = store.readConsistent(() => ({
    coverage: store.readMatchCoverage(gameKey),
    storedMetadata: store.readMatchMetadata(gameKey),
    records: store.readFinalized(gameKey)
  }));
  if (!coverage) throw new Error("COMPACT_EXPORT_UNKNOWN_MATCH: " + gameKey);
  const metadata = storedMetadata ?? options.metadataOverride ?? null;
  if (!metadata) throw new Error("COMPACT_EXPORT_NO_METADATA: " + gameKey);
  if (records.length === 0) throw new Error("COMPACT_EXPORT_EMPTY: " + gameKey);

  const runId = safeRunId(gameKey);
  const firstMs = records[0]!.receivedAtMs;
  let sequence = 0;
  let monotonicNs = 0n;
  const lines: string[] = [];
  const emit = (source: JournalRecord["source"], kind: string, receivedAtMs: number, data: unknown, connectionId?: string): void => {
    sequence += 1;
    // Records keep their original receipt times, which a tolerated wall-clock
    // backstep can move backwards; the monotonic clock never does, so the
    // catalog can flag the backstep instead of the journal being unreadable.
    const candidate = BigInt(receivedAtMs - firstMs) * 1_000_000n + BigInt(sequence);
    monotonicNs = candidate > monotonicNs ? candidate : monotonicNs + 1n;
    const envelope: Record<string, unknown> = { schemaVersion: 1, runId, sequence,
      receivedAt: new Date(receivedAtMs).toISOString(), receivedAtMs,
      monotonicNs: String(monotonicNs), source, kind, data };
    if (connectionId !== undefined) envelope.connectionId = connectionId;
    lines.push(JSON.stringify(envelope));
  };

  // Where each record's run next delivers WebSocket depth, and the source time
  // of every later depth frame per connection and token. An anchor that
  // arrives before any live frame seeds the connection its deltas will land
  // on, and one whose REST time is ahead of deltas still in flight must not
  // stamp that time onto the book, or each of those deltas looks out of order.
  const nextRunConnection: Array<string | undefined> = new Array(records.length);
  const upcoming = new Map<string, Array<{ index: number; sourceTime: bigint }>>();
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]!;
    const later = records[index + 1];
    const connection = record.source === "clob" && record.kind === "ws_message" ? runConnection(record) : undefined;
    nextRunConnection[index] = connection ?? (later?.runId === record.runId ? nextRunConnection[index + 1] : undefined);
  }
  records.forEach((record, index) => {
    const connection = runConnection(record);
    if (record.source !== "clob" || record.kind !== "ws_message" || connection === undefined) return;
    for (const { tokenId, sourceTime } of depthAssertions(record.data)) {
      if (sourceTime === undefined) continue;
      const key = connection + "\n" + tokenId;
      const list = upcoming.get(key) ?? [];
      list.push({ index, sourceTime });
      upcoming.set(key, list);
    }
  });
  const cursors = new Map<string, number>();
  const nextDepthTime = (connection: string, tokenId: string, index: number): bigint | undefined => {
    const key = connection + "\n" + tokenId;
    const list = upcoming.get(key);
    if (list === undefined) return undefined;
    let cursor = cursors.get(key) ?? 0;
    while (cursor < list.length && list[cursor]!.index <= index) cursor++;
    cursors.set(key, cursor);
    return list[cursor]?.sourceTime;
  };

  const activeConnections = new Set<string>();
  const lastConnectionByToken = new Map<string, string>();
  const depth = new Map<string, Map<string, DepthState>>();
  const depthState = (connection: string, tokenId: string): DepthState => {
    const states = depth.get(connection) ?? new Map<string, DepthState>();
    depth.set(connection, states);
    const state = states.get(tokenId) ?? { seeded: false, pending: [] };
    states.set(tokenId, state);
    return state;
  };
  let lastClobConnection: string | undefined;
  let currentRun: string | undefined;

  emit("collector", "session_start", firstMs, { config: { runId }, status: "starting", startedAt: new Date(firstMs).toISOString() });
  emit("gamma", "event_metadata", firstMs, { event: eventDocument(metadata, coverage.finishedAtMs, coverage.finishAnchor) });

  let anchorFrames = 0;
  for (const [index, record] of records.entries()) {
    if (record.runId !== currentRun) {
      // The process that owned the previous run's sockets is gone; none of
      // them can carry a book for this run.
      currentRun = record.runId;
      activeConnections.clear();
      lastClobConnection = undefined;
      lastConnectionByToken.clear();
    }
    const connection = runConnection(record);
    if (record.source === "collector" && connection !== undefined) {
      if (record.kind === "connection_open") { activeConnections.add(connection); depth.delete(connection); }
      else if (CLOSING_KINDS.includes(record.kind)) { activeConnections.delete(connection); depth.delete(connection); }
    }
    if (record.source === "clob" && record.kind === "ws_message" && connection !== undefined) {
      activeConnections.add(connection);
      lastClobConnection = connection;
      for (const tokenId of clobFrameTokens(record.data)) lastConnectionByToken.set(tokenId, connection);
      for (const { tokenId, sourceTime, book, change } of depthAssertions(record.data)) {
        const state = depthState(connection, tokenId);
        if (book) state.seeded = true;
        if (sourceTime !== undefined && (state.watermark === undefined || sourceTime > state.watermark)) state.watermark = sourceTime;
        if (book) continue;
        // An unordered or unreadable delta cannot be re-applied later.
        if (change === undefined) { state.forgottenThrough = state.watermark ?? 0n; continue; }
        state.pending.push(change);
        while (state.pending.length > MAX_PENDING_CHANGES || state.pending[0]!.sourceTime < state.watermark! - PENDING_CHANGE_SPAN) {
          const forgotten = state.pending.shift()!.sourceTime;
          if (state.forgottenThrough === undefined || forgotten > state.forgottenThrough) state.forgottenThrough = forgotten;
        }
      }
    }
    if (record.kind === "book_snapshot") {
      const anchor = anchorBookFrame(record);
      if (anchor === undefined) continue;
      const tokenId = anchor.frame.asset_id as string;
      const preferred = lastConnectionByToken.get(tokenId);
      const anchorConnection = preferred !== undefined && activeConnections.has(preferred) ? preferred
        : lastClobConnection !== undefined && activeConnections.has(lastClobConnection) ? lastClobConnection
        : [...activeConnections].at(-1) ?? nextRunConnection[index] ?? SYNTHETIC_CONNECTION;
      const state = depthState(anchorConnection, tokenId);
      const { sourceTime } = anchor;
      // The anchor stays audit evidence whether or not it seeds a book. It is
      // emitted *after* the frame it produces: in a snapshot-only tail the
      // snapshot is the only depth evidence, so the audit can only compare the
      // reconstructed book with the very snapshot that carried it. Recording
      // the evidence first left every audit "not comparable" and excluded every
      // trial from the backtest.
      const evidence = (): void => { emit("clob", "book_snapshot", record.receivedAtMs, record.data); };
      // REST can answer ~seconds after the stream moved on. Replaying such a
      // snapshot as a full book reverts every delta newer than it, so a
      // snapshot older than the book's watermark is applied only once those
      // deltas are re-applied on top of it, stamped with the stream's own
      // time. That still repairs a live book the snapshot audit disproved, and
      // seeds one whose deltas the replay had to drop for want of a book.
      if (sourceTime !== undefined && state.watermark !== undefined && sourceTime < state.watermark) {
        if (state.forgottenThrough !== undefined && state.forgottenThrough >= sourceTime) { evidence(); continue; }
        const advanced = advancedBook(anchor.frame, state.pending, sourceTime);
        if (advanced === undefined) { evidence(); continue; }
        // The snapshot's hash names its own state, not the advanced one.
        const { hash: _stale, ...identity } = anchor.frame;
        emit("clob", "ws_message", record.receivedAtMs, { ...identity, ...advanced, timestamp: String(state.watermark) }, anchorConnection);
        state.seeded = true;
        anchorFrames += 1;
        evidence();
        continue;
      }
      const following = sourceTime === undefined ? undefined : nextDepthTime(anchorConnection, tokenId, index);
      const ordered = sourceTime !== undefined && (following === undefined || following >= sourceTime);
      // Without a source time that orders against the stream the snapshot
      // cannot prove it is newer than a live book, so it only seeds a book the
      // connection does not have yet.
      if (!ordered && state.seeded) { evidence(); continue; }
      const frame = ordered ? { ...anchor.frame, timestamp: String(sourceTime) } : anchor.frame;
      emit("clob", "ws_message", record.receivedAtMs, frame, anchorConnection);
      state.seeded = true;
      if (ordered && (state.watermark === undefined || sourceTime! > state.watermark)) state.watermark = sourceTime;
      anchorFrames += 1;
      evidence();
      continue;
    }
    emit(record.source, record.kind, record.receivedAtMs, record.data, connection);
  }
  // A repaired `book-quiet` boundary can precede the terminal clearing frame
  // that is still retained as evidence. The journal must remain monotonic, so
  // close the run after every emitted record while the finish fact continues
  // to define the replay window end.
  const sessionEndAtMs = records.reduce((latest, record) => Math.max(latest, record.receivedAtMs), coverage.finishedAtMs);
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
      sourceRunDirectory: dirname(store.databasePath), windowSeconds, maxFeedSilenceMs, clockPolicy: "flag-backsteps",
      compressRawEvents: true, finishFactsFile: factsFile, archiveFinishFacts: true });
    return { gameKey, journalDirectory, records: records.length, anchorFrames,
      windowComplete: coverage.windowComplete, missingFrontMs: coverage.missingFrontMs,
      largestGapMs: coverage.largestGapMs, finishAnchor: coverage.finishAnchor, archive };
  } finally {
    if (options.workDirectory === undefined) await rm(workRoot, { recursive: true, force: true });
  }
}

function fallbackFinishFact(metadata: Record<string, unknown>, coverage: { finishedAtMs: number; finishAnchor: string | null },
  runId: string, sequence: number): Record<string, unknown> {
  // Keep the recorded anchor verbatim. Collapsing `book-tail` into
  // `book-quiet` would misreport how the boundary was actually chosen.
  const anchor = isTailFinishSource(coverage.finishAnchor) ? coverage.finishAnchor : "book-quiet";
  return { eventId: typeof metadata.id === "string" ? metadata.id : null,
    eventSlug: typeof metadata.slug === "string" ? metadata.slug : null,
    gameId: typeof metadata.gameId === "string" ? metadata.gameId : null,
    atMs: coverage.finishedAtMs, observedAtMs: coverage.finishedAtMs, source: anchor,
    sourceRunId: runId, sourceRunDirectory: null, sequence, frameIndex: 0 };
}

function finishFacts(metadata: Record<string, unknown>, coverage: { finishedAtMs: number; finishAnchor: string | null;
  finishFacts: readonly unknown[] }, runId: string, sequence: number): unknown[] {
  const recorded = coverage.finishFacts.map(fact => ({ ...(fact as Record<string, unknown>) }));
  if (recorded.length === 0) return [fallbackFinishFact(metadata, coverage, runId, sequence)];

  // The boundary itself must remain the first fact. When a match was re-anchored
  // to `book-tail`, a later published clock may also exist; putting the fallback
  // first preserves the real market boundary and lets the catalog mark the
  // published-clock disagreement instead of silently moving the window to it.
  const boundaryIndex = recorded.findIndex(fact => fact.atMs === coverage.finishedAtMs);
  if (boundaryIndex >= 0) {
    const boundary = recorded[boundaryIndex]!;
    return [boundary, ...recorded.filter((_, index) => index !== boundaryIndex)];
  }
  if (isFallbackFinishSource(coverage.finishAnchor)) {
    const publishedOnly = recorded.filter(fact => !isFallbackFinishSource(fact.source));
    return [fallbackFinishFact(metadata, coverage, runId, sequence), ...publishedOnly];
  }
  return recorded;
}
