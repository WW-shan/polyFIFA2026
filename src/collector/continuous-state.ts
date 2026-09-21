import { randomUUID } from "node:crypto";
import { metadataFromRecord, observationsFromRecord, windowKeyForIdentity } from "./tail-context.js";
import { objectValue } from "./replay-values.js";
import { activeSnapshotTokens, isTerminalClearFrame } from "./book-evidence.js";
import type { JournalRecord } from "./types.js";
import type { TailFinishFact, TailMetadata } from "./tail-types.js";
import type { CompactTailStoreStatus } from "./continuous-tail-store.js";

export interface ArchiveState {
  status: "running" | "complete" | "failed"; runId: string; attempt: number;
  snapshotDirectory?: string; outputDirectory?: string; error?: string; retryAtMs?: number;
  priceReadyTokens?: number; strictReadyTokens?: number;
  refreshSnapshot?: boolean;
  finishFactsFile?: string;
  finishRevision?: number;
}
/**
 * How the end of a match window was established.
 * - the two source clocks are published finish timestamps;
 * - `book-quiet` is the last order-book second with active depth for a match
 *   whose source never published a clock at all, which is the common case for
 *   closed events; terminal clearing frames remain stored but do not move it;
 * - `book-tail` is the last frame the store still held when the published
 *   clock and the stored frames did not overlap, so the window had to move to
 *   the real market tail instead of being published empty.
 */
export type FinishAnchor = "gamma.finishedTimestamp" | "sports.finishedAt" | "book-quiet" | "book-tail";
/**
 * One frame of a CLOB record, already attributed to the single game that owns
 * its token. `kind` is overridden when a container record is split into frames
 * whose own shape is narrower than the record, such as a book-snapshot batch.
 */
export interface ClobAttributedFrame { gameKey: string; frame: unknown; frameIndex: number; kind?: string }
export interface CapturedGame {
  key: string; title: string; sport: string | null; gameId: string | null;
  eventIds: string[]; eventSlugs: string[]; tokenIds: string[]; marketIds: string[];
  firstSeenAtMs: number; lastSeenAtMs: number; firstBookAtMs: number | null; lastBookAtMs: number | null;
  lastActiveBookAtMs: number | null; lastBookRunId: string | null; lastActiveBookRunId: string | null;
  bookUpdates: number; trades: number; stateObservations: number;
  finishedAtMs: number | null; finishAnchor?: FinishAnchor | null; finishConflict: boolean; retiredEventIds: string[];
  /**
   * Trimmed copy of the last Gamma event document seen for this game.
   *
   * Compact storage keeps only order-book frames, so the market identity
   * (conditionId, outcome names, market type) would otherwise be lost with the
   * raw run. Keeping a small, field-limited copy lets a finalized tail be
   * turned back into a replayable window without the raw journal.
   */
  eventMetadata?: Record<string, unknown>;
  phase: "watching" | "postmatch" | "needs_finish" | "missed" | "archiving" | "archived" | "interrupted" | "archive_failed";
  sources: Array<{ runId: string; runDirectory: string }>;
  sourceFirstSequences?: Record<string, number>;
  finishRunId?: string;
  finishRevision?: number;
  finishFacts?: TailFinishFact[];
  archive?: ArchiveState;
}
/**
 * Reduce a Gamma event document to the fields a replay needs.
 *
 * The full upstream document averages ~50 KiB per event and is retained in the
 * raw run for 24 hours. Persisting that verbatim next to 90 days of order books
 * would dwarf the tails it describes, so only identity and market shape survive:
 * everything `normalizeCollectorEvent`/`metadataFromRecord` read, nothing else.
 */
export function compactEventMetadata(meta: TailMetadata): Record<string, unknown> {
  const markets: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const market of meta.markets) {
    if (seen.has(market.marketId)) continue;
    seen.add(market.marketId);
    const raw = market.raw;
    // `closed` decides whether a second is classed as a live carried book or as
    // a resolved market whose depth is dropped, so it must stay the value seen
    // while the window was being captured rather than a later terminal one.
    const shape: Record<string, unknown> = {
      id: market.marketId, conditionId: market.conditionId, slug: market.marketSlug,
      question: market.question, sportsMarketType: market.marketType,
      closed: market.closed
    };
    for (const field of ["outcomes", "clobTokenIds", "archived", "enableOrderBook", "acceptingOrders"] as const) {
      if (raw[field] !== undefined) shape[field] = raw[field];
    }
    markets.push(shape);
  }
  const event: Record<string, unknown> = { id: meta.eventId, slug: meta.eventSlug, title: meta.title, markets };
  if (meta.gameId !== null) event.gameId = meta.gameId;
  if (meta.parentEventId !== null) event.parentEventId = meta.parentEventId;
  const sport = meta.raw.sport;
  if (sport !== undefined) event.sport = sport;
  const eventState = objectValue(meta.raw.eventState);
  if (eventState !== undefined) event.eventState = eventState;
  if (meta.tags.length) event.tags = meta.tags.map(slug => ({ slug }));
  return event;
}

/**
 * True when every market in a stored event document is already resolved.
 *
 * A replay seeded with an all-closed document classifies each captured second
 * as a resolved market and drops the entire depth ladder, so such a shape can
 * never be allowed to stand in for the market that was trading.
 */
export function allMarketsClosed(metadata: Record<string, unknown>): boolean {
  const markets = Array.isArray(metadata.markets) ? metadata.markets : [];
  return markets.length > 0 && markets.every(market => {
    const value = market !== null && typeof market === "object" && !Array.isArray(market)
      ? (market as Record<string, unknown>).closed : undefined;
    return value === true;
  });
}

export interface CaptureConnection { id: string; source: string; open: boolean; lastMessageAtMs: number | null;
  /** Games whose order-book evidence has been observed on this connection. */
  gameKeys?: string[] }
export interface CompressionState {
  enabled: boolean; running: boolean; lastCompletedAtMs: number | null;
  compressedSegments: number; logicalBytesSaved: number; lastError: string | null;
}
export interface ContinuousStatus {
  schemaVersion: 1; instanceId: string; pid: number; startedAtMs: number; updatedAtMs: number;
  stateStaleAfterMs?: number;
  dataRoot: string; port: number; mode: "starting" | "collecting" | "restarting" | "paused_disk" | "stopping" | "stopped";
  runId: string | null; runDirectory: string | null; receivedRecords: number; lastRecordAtMs: number | null;
  freeBytes: number | null; rawBytes: number; queuedBytes: number; desiredTokens: number;
  games: CapturedGame[]; connections: CaptureConnection[];
  errors: Array<{ atMs: number; scope: string; message: string }>;
  compactStorage?: CompactTailStoreStatus;
  compression?: CompressionState;
}

/**
 * Tokens a `/books` batch response actually carried.
 *
 * The collector records one `book_snapshot_batch` per request holding both the
 * requested `tokenIds` and the upstream `response`, and it emits a separate
 * `book_snapshot` (and a `book_snapshot_batch_error`) whenever the response is
 * short. Only the entries the response carried are a book for that token, so
 * only those may move a game's last-book clock.
 */
function batchBookTokens(data: Record<string, unknown> | undefined): string[] {
  const requested = Array.isArray(data?.tokenIds) ? data.tokenIds : [];
  const response = data?.response;
  if (!Array.isArray(response)) return [];
  const tokens: string[] = [];
  for (const [index, value] of response.entries()) {
    const entry = objectValue(value);
    const token = typeof entry?.asset_id === "string" && entry.asset_id.length > 0 ? entry.asset_id
      : typeof requested[index] === "string" ? requested[index] as string : undefined;
    if (token !== undefined) tokens.push(token);
  }
  return tokens;
}

/**
 * A `/books` reply that only omits tokens is an absence, not a broken reply.
 *
 * Resolved sub-markets (set winners, totals, handicaps) lose their orderbook
 * before Gamma flips `closed`, and the single-token endpoint answers those with
 * 404 "No orderbook exists". The collector still records the omission once per
 * absence episode for audit, but only duplicates, unrequested IDs or a
 * malformed body are identity failures worth raising as a status issue.
 */
function benignBookAbsence(record: JournalRecord): boolean {
  if (record.kind !== "book_snapshot_batch_error") return false;
  const data = objectValue(record.data);
  if (data?.code !== "CLOB_BOOK_BATCH_IDENTITY_MISMATCH") return false;
  const empty = (value: unknown): boolean => !Array.isArray(value) || value.length === 0;
  return empty(data.duplicateTokenIds) && empty(data.unrequestedTokenIds) && empty(data.invalidResponseIndices);
}

export class ContinuousState {
  private readonly games = new Map<string, CapturedGame>();
  private readonly tokens = new Map<string, string>();
  private readonly events = new Map<string, string>();
  private readonly connections = new Map<string, CaptureConnection>();
  private readonly errors: ContinuousStatus["errors"] = [];
  private readonly newlyFinished = new Set<string>();
  private readonly instanceId = randomUUID();
  private readonly startedAtMs = Date.now();
  private updatedAtMs = this.startedAtMs;
  private receivedRecords = 0;
  private lastRecordAtMs: number | null = null;
  private runId: string | null = null;
  private runDirectory: string | null = null;
  mode: ContinuousStatus["mode"] = "starting";
  freeBytes: number | null = null;
  rawBytes = 0;
  queuedBytes = 0;
  desiredTokens = 0;
  compression: CompressionState = { enabled: false, running: false, lastCompletedAtMs: null,
    compressedSegments: 0, logicalBytesSaved: 0, lastError: null };
  compactStorage: CompactTailStoreStatus | undefined;

  constructor(readonly dataRoot: string, readonly port: number, readonly stateStaleAfterMs = 15_000, readonly restoreMaxAgeMs = Number.POSITIVE_INFINITY) {}
  // Reading the status endpoint is not evidence that the supervisor progressed.
  markUpdated(atMs = Date.now()): void { this.updatedAtMs = atMs; }
  setRun(runId: string, runDirectory: string): void {
    this.runId = runId; this.runDirectory = runDirectory; this.rawBytes = 0; this.connections.clear();
  }
  issue(scope: string, error: unknown, atMs = Date.now()): void {
    this.errors.push({ scope, atMs, message: (error instanceof Error ? error.message : String(error)).slice(0, 2000) });
    if (this.errors.length > 50) this.errors.shift();
  }
  setCompactStorage(status: CompactTailStoreStatus): void { this.compactStorage = structuredClone(status); }
  private source(game: CapturedGame, record: JournalRecord): void {
    if (this.runDirectory && this.runId === record.runId && !game.sources.some(source => source.runId === record.runId)) game.sources.push({ runId: record.runId, runDirectory: this.runDirectory });
    game.sourceFirstSequences ??= {};
    if (!Object.hasOwn(game.sourceFirstSequences, record.runId)) Object.defineProperty(game.sourceFirstSequences, record.runId, { value: record.sequence, enumerable: true, configurable: true, writable: true });
  }
  private finish(game: CapturedGame, value: number | null, record: JournalRecord,
    origin?: Pick<TailFinishFact, "source" | "eventId" | "eventSlug" | "gameId" | "frameIndex">): void {
    if (value === null) return;
    const previousFinishedAtMs = game.finishedAtMs;
    const wasBookQuiet = game.finishAnchor === "book-quiet";
    const archiveWasComplete = game.archive?.status === "complete";
    let newFact = false;
    if (origin) {
      const facts = game.finishFacts ??= [];
      if (!facts.some(fact => fact.source === origin.source && fact.atMs === value)) {
        const fact: TailFinishFact = { ...origin, atMs: value, observedAtMs: record.receivedAtMs, sourceRunId: record.runId,
          sourceRunDirectory: game.sources.find(source => source.runId === record.runId)?.runDirectory ?? null, sequence: record.sequence };
        const sameSource = facts.map((fact, index) => ({ fact, index })).filter(value => value.fact.source === origin.source);
        if (sameSource.length < 3) facts.push(fact); else facts[sameSource[2]!.index] = fact;
        newFact = true;
      }
    }
    if (game.finishedAtMs !== null && value !== game.finishedAtMs) {
      if (!game.finishConflict || newFact) {
        game.finishRevision = (game.finishRevision ?? 0) + 1;
        game.finishRunId = record.runId;
        if (game.archive) {
          const { snapshotDirectory: _oldSnapshot, finishFactsFile: _oldFacts, ...archive } = game.archive;
          game.archive = { ...archive, status: "failed", refreshSnapshot: true, retryAtMs: 0,
            priceReadyTokens: 0, strictReadyTokens: 0, error: "finish label changed; fresh source evidence must be evaluated" };
          game.phase = "archive_failed";
        }
      }
      game.finishConflict = true;
    }
    if (game.finishedAtMs === null) { game.finishRunId = record.runId; game.finishRevision = 1; }
    if (game.finishedAtMs === null && origin !== undefined) game.finishAnchor = origin.source;
    game.finishedAtMs ??= value;
    // A book-quiet fallback is not yet a published artifact when its archive is
    // still pending or failed. If a real clock arrives in that state, prefer
    // the clock for the eventual window; keep the old boundary only when a
    // complete artifact already exists and must not be rewritten silently.
    if (wasBookQuiet && !archiveWasComplete && origin !== undefined) {
      game.finishedAtMs = value;
      game.finishAnchor = origin.source;
    }
    // A new witness is itself a revision even when every source agrees on the
    // boundary. Without this, an archive completed before the witness arrived
    // kept only the old subset of finish provenance.
    if (newFact && game.archive?.status === "complete") {
      const { snapshotDirectory: _oldSnapshot, finishFactsFile: _oldFacts, ...archive } = game.archive;
      game.finishRevision = (game.finishRevision ?? 0) + 1;
      game.archive = { ...archive, status: "failed", refreshSnapshot: true, retryAtMs: 0,
        priceReadyTokens: 0, strictReadyTokens: 0, error: "finish evidence changed; fresh source evidence must be evaluated" };
      game.phase = "archive_failed";
    }
    if (game.finishedAtMs !== previousFinishedAtMs) this.newlyFinished.add(game.key);
  }
  observe(record: JournalRecord): void {
    this.receivedRecords++; this.lastRecordAtMs = record.receivedAtMs;
    try { this.observeUnsafe(record); } catch (error) { this.issue("observation", error, record.receivedAtMs); }
  }
  gameKeysForRecord(record: JournalRecord): string[] {
    const keys = new Set<string>();
    try {
      if (record.connectionId && ["connection_open", "connection_close", "connection_gap", "connection_timeout", "heartbeat_timeout"].includes(record.kind)) {
        for (const key of this.connections.get(record.connectionId)?.gameKeys ?? []) keys.add(key);
      }
      const metadata = metadataFromRecord(record);
      if (metadata) keys.add(metadata.gameId === null ? `event:${metadata.eventId}` : `game:${metadata.gameId}`);
      if (record.source === "sports" && record.kind === "ws_message") {
        for (const observation of observationsFromRecord(record)) {
          const key = windowKeyForIdentity(observation, [...this.games.values()]);
          if (key) keys.add(key);
        }
      }
      if (record.kind === "event_retired") {
        const eventId = objectValue(record.data)?.eventId;
        if (typeof eventId === "string") {
          const key = this.events.get(eventId);
          if (key) keys.add(key);
        }
      }
      if (record.source === "clob") {
        const tokens = new Set<string>();
        if (record.kind === "ws_message" && typeof record.data === "string") {
          const parsed: unknown = JSON.parse(record.data);
          for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
            const frame = objectValue(value); if (!frame) continue;
            if (typeof frame.asset_id === "string") tokens.add(frame.asset_id);
            if (Array.isArray(frame.price_changes)) for (const change of frame.price_changes) {
              const token = objectValue(change)?.asset_id;
              if (typeof token === "string") tokens.add(token);
            }
          }
        } else if (record.kind === "book_snapshot") {
          const token = objectValue(record.data)?.tokenId;
          if (typeof token === "string") tokens.add(token);
        } else if (record.kind === "book_snapshot_batch") {
          const tokenIds = objectValue(record.data)?.tokenIds;
          if (Array.isArray(tokenIds)) for (const token of tokenIds) if (typeof token === "string") tokens.add(token);
        }
        for (const token of tokens) {
          const key = this.tokens.get(token);
          if (key) keys.add(key);
        }
      }
    } catch {
      // State observation already records malformed frames; identity lookup must not crash capture.
    }
    return [...keys];
  }

  /**
   * Split a batched CLOB WebSocket message into (game, frame) pairs.
   *
   * A single message carries frames for many unrelated tokens, so attributing
   * the whole record to every game it mentions copies foreign books into each
   * game's tail. Each frame is assigned only to the game that owns its token.
   * Frames whose token is unknown are dropped: an unattributable frame cannot
   * be safely filed under any game.
   */
  clobFramesForRecord(record: JournalRecord): ClobAttributedFrame[] {
    if (record.source !== "clob") return [];
    if (record.kind === "book_snapshot") {
      const data = objectValue(record.data);
      const token = typeof data?.tokenId === "string" ? data.tokenId : undefined;
      const key = token === undefined ? undefined : this.tokens.get(token);
      return key === undefined ? [] : [{ gameKey: key, frame: record.data, frameIndex: 0 }];
    }
    if (record.kind === "book_snapshot_batch") {
      // The anchor pass posts one batch of up to 50 tokens that spans many
      // matches. Storing the batch under every match it mentions copies foreign
      // books into each tail, so each response is filed as the single-token
      // snapshot it describes.
      const data = objectValue(record.data), response = data?.response;
      const requested = Array.isArray(data?.tokenIds) ? data.tokenIds : [];
      if (!Array.isArray(response)) return [];
      const batchId = typeof data?.batchId === "string" ? data.batchId : undefined;
      const attributed: ClobAttributedFrame[] = [];
      for (const [frameIndex, value] of response.entries()) {
        const entry = objectValue(value);
        const token = typeof entry?.asset_id === "string" ? entry.asset_id
          : typeof requested[frameIndex] === "string" ? requested[frameIndex] as string : undefined;
        const key = token === undefined ? undefined : this.tokens.get(token);
        if (key === undefined) continue;
        attributed.push({ gameKey: key, kind: "book_snapshot", frameIndex,
          frame: { tokenId: token, response: value, ...(batchId === undefined ? {} : { batchId }) } });
      }
      return attributed;
    }
    if (record.kind !== "ws_message" || typeof record.data !== "string") return [];
    let parsed: unknown;
    try { parsed = JSON.parse(record.data); } catch { return []; }
    const frames = Array.isArray(parsed) ? parsed : [parsed];
    const attributed: ClobAttributedFrame[] = [];
    for (const [frameIndex, value] of frames.entries()) {
      const frame = objectValue(value);
      if (!frame) continue;
      // A frame belongs to exactly one game. Every asset it names must resolve
      // to that same game; a frame spanning games is not safely attributable.
      const tokens = new Set<string>();
      if (typeof frame.asset_id === "string") tokens.add(frame.asset_id);
      if (Array.isArray(frame.price_changes)) for (const change of frame.price_changes) {
        const token = objectValue(change)?.asset_id;
        if (typeof token === "string") tokens.add(token);
      }
      if (tokens.size === 0) continue;
      let key: string | undefined;
      let consistent = true;
      for (const token of tokens) {
        const owner = this.tokens.get(token);
        if (owner === undefined) continue;
        if (key === undefined) key = owner;
        else if (key !== owner) { consistent = false; break; }
      }
      if (key === undefined || !consistent) continue;
      attributed.push({ gameKey: key, frame: value, frameIndex });
    }
    return attributed;
  }

  /**
   * Live view of tracked games for internal scheduling decisions. Values are
   * the tracked objects themselves, so callers must treat them as read-only.
   */
  gamesView(): CapturedGame[] { return [...this.games.values()]; }

  /**
   * Anchor retired matches whose source never publishes a finish clock.
   *
   * Gamma closes most events with `closed: true` and no `finishedTimestamp`,
   * and the Sports feed does not carry every match either. Waiting for a clock
   * that never comes loses the match entirely, so once the published sources
   * have had their grace period the last order-book frame becomes the window
   * end. That frame is inside the match by construction, which makes the
   * window a documented subset of the real final minutes instead of a guess.
   *
   * Anchoring stops at `retentionMs`: past that age the tail store has already
   * released the rows, so the fallback could only produce an empty archive and
   * the match is left unanchored instead of being marked finished without data.
   */
  anchorQuietFinishes(nowMs: number, graceMs: number, retentionMs: number): CapturedGame[] {
    const anchored: CapturedGame[] = [];
    for (const game of this.games.values()) {
      const lastActiveBookAtMs = game.lastActiveBookAtMs ?? game.lastBookAtMs;
      if (game.finishedAtMs !== null || game.firstBookAtMs === null || lastActiveBookAtMs === null) continue;
      if (!game.eventIds.length || !game.eventIds.every(id => game.retiredEventIds.includes(id))) continue;
      const quietMs = nowMs - lastActiveBookAtMs;
      if (quietMs < graceMs || quietMs > retentionMs) continue;
      game.finishedAtMs = lastActiveBookAtMs;
      game.finishAnchor = "book-quiet";
      const finishRunId = game.lastActiveBookRunId ?? game.lastBookRunId;
      if (finishRunId !== null) game.finishRunId = finishRunId;
      game.finishRevision = 1;
      this.newlyFinished.add(game.key);
      anchored.push(game);
    }
    return anchored;
  }

  consumeNewlyFinishedGames(): CapturedGame[] {
    const finished = [...this.newlyFinished].map(key => this.games.get(key)).filter((game): game is CapturedGame => game !== undefined)
      .map(game => structuredClone(game));
    this.newlyFinished.clear();
    return finished;
  }

  private hasPendingArchive(game: Pick<CapturedGame, "firstBookAtMs" | "finishedAtMs" | "phase" | "finishConflict" | "archive">): boolean {
    return (typeof game.firstBookAtMs === "number" && typeof game.finishedAtMs === "number" &&
      game.phase !== "archived" && game.phase !== "missed") ||
      (game.finishConflict === true && game.archive !== undefined && game.phase !== "missed");
  }

  /**
   * Remove games that are outside the discovery horizon from the in-memory
   * dashboard and its identity indexes. Their durable source data is kept in
   * raw runs/SQLite; this only bounds hot state and restart cost. A finished
   * game with book evidence remains until its pending archive is resolved.
   */
  pruneStaleGames(cutoffMs: number): number {
    if (!Number.isFinite(cutoffMs)) return 0;
    const stale = [...this.games.values()].filter(game => game.lastSeenAtMs < cutoffMs &&
      game.archive?.status !== "running" && game.phase !== "archiving" && !this.hasPendingArchive(game));
    for (const game of stale) {
      this.games.delete(game.key);
      this.newlyFinished.delete(game.key);
      for (const token of game.tokenIds) if (this.tokens.get(token) === game.key) this.tokens.delete(token);
      for (const event of game.eventIds) if (this.events.get(event) === game.key) this.events.delete(event);
    }
    return stale.length;
  }

  /** Remember which games a live connection has actually carried. */
  private rememberConnectionGames(record: JournalRecord): void {
    if (!record.connectionId) return;
    const connection = this.connections.get(record.connectionId);
    if (!connection) return;
    const keys = this.gameKeysForRecord(record);
    if (keys.length === 0) return;
    const known = connection.gameKeys ??= [];
    for (const key of keys) if (!known.includes(key)) known.push(key);
  }

  private observeUnsafe(record: JournalRecord): void {
    if (record.connectionId) {
      const connection = this.connections.get(record.connectionId) ?? { id: record.connectionId, source: record.source, open: false, lastMessageAtMs: null };
      if (record.kind === "connection_open") { connection.open = true; connection.source = String(objectValue(record.data)?.source ?? record.source); }
      if (["connection_close", "connection_gap", "connection_timeout", "heartbeat_timeout"].includes(record.kind)) connection.open = false;
      if (record.kind === "ws_message") connection.lastMessageAtMs = record.receivedAtMs;
      this.connections.set(record.connectionId, connection);
      const closed = [...this.connections.values()].filter(value => !value.open);
      for (const value of closed.slice(0, Math.max(0, closed.length - 64))) this.connections.delete(value.id);
    }
    if (record.kind.endsWith("error") && !benignBookAbsence(record)) {
      this.issue(record.kind, JSON.stringify(record.data), record.receivedAtMs);
    }
    const meta = metadataFromRecord(record);
    if (meta) {
      const key = meta.gameId === null ? `event:${meta.eventId}` : `game:${meta.gameId}`;
      const previousKey = this.events.get(meta.eventId);
      // Upstream occasionally corrects a gameId for the same event. Keep the
      // original observation identity and add the corrected key as an alias
      // instead of discarding all later books and finish evidence.
      const resolvedKey = previousKey && previousKey !== key ? previousKey : key;
      const game: CapturedGame = this.games.get(resolvedKey) ?? { key: resolvedKey, title: meta.title, sport: meta.sport, gameId: meta.gameId,
        eventIds: [], eventSlugs: [], tokenIds: [], marketIds: [], firstSeenAtMs: record.receivedAtMs, lastSeenAtMs: record.receivedAtMs,
        firstBookAtMs: null, lastBookAtMs: null, lastActiveBookAtMs: null, lastBookRunId: null, lastActiveBookRunId: null,
        bookUpdates: 0, trades: 0, stateObservations: 0,
        finishedAtMs: null, finishConflict: false, retiredEventIds: [], phase: "watching", sources: [] };
      this.events.set(meta.eventId, resolvedKey);
      if (!game.eventIds.includes(meta.eventId)) game.eventIds.push(meta.eventId);
      if (!game.eventSlugs.includes(meta.eventSlug)) game.eventSlugs.push(meta.eventSlug);
      game.lastSeenAtMs = record.receivedAtMs;
      if (game.phase === "interrupted" && game.archive?.status !== "running") game.phase = "watching";
      this.source(game, record);
      this.finish(game, meta.finishAtMs, record, meta.finishSource ? { source: meta.finishSource, eventId: meta.eventId,
        eventSlug: meta.eventSlug, gameId: meta.gameId, frameIndex: 0 } : undefined);
      for (const market of meta.markets) {
        const existing = this.tokens.get(market.tokenId);
        if (existing && existing !== resolvedKey) throw new Error(`capture token identity changed for ${market.tokenId}`);
        this.tokens.set(market.tokenId, resolvedKey);
        if (!game.tokenIds.includes(market.tokenId)) game.tokenIds.push(market.tokenId);
        if (!game.marketIds.includes(market.marketId)) game.marketIds.push(market.marketId);
      }
      // Keep the first sighting: it is the shape the market had while trading.
      // A later terminal document would mark every captured second as resolved.
      // The one exception is a first sighting that is itself already resolved -
      // a game restored from a state written before this field existed can see
      // the reconciled closed document first. Replace that with the next live
      // shape so the finalized tail is not exported as wholly closed.
      const shape = compactEventMetadata(meta);
      if (game.eventMetadata === undefined
        || (allMarketsClosed(game.eventMetadata) && !allMarketsClosed(shape))) {
        game.eventMetadata = shape;
      }
      this.games.set(resolvedKey, game);
    }
    if (record.kind === "event_retired") {
      const data = objectValue(record.data), eventId = typeof data?.eventId === "string" ? data.eventId : "";
      const key = this.events.get(eventId), game = key ? this.games.get(key) : undefined;
      if (game) {
        if (!game.retiredEventIds.includes(eventId)) game.retiredEventIds.push(eventId);
        if (typeof data?.finishedAtMs === "number") this.finish(game, data.finishedAtMs, record);
        if (game.eventIds.every(id => game.retiredEventIds.includes(id)) && !game.archive) game.phase = game.firstBookAtMs === null ? "missed" : game.finishedAtMs === null ? "needs_finish" : "postmatch";
      }
    }
    if (record.source === "sports" && record.kind === "ws_message") {
      for (const observation of observationsFromRecord(record)) {
        const key = windowKeyForIdentity(observation, [...this.games.values()]);
        const game = key ? this.games.get(key) : undefined;
        if (!game) continue;
        this.source(game, record);
        game.stateObservations++; this.finish(game, observation.finishAtMs, record, observation.finishSource ? {
          source: observation.finishSource, eventId: null, eventSlug: observation.eventSlug, gameId: observation.gameId, frameIndex: observation.frameIndex
        } : undefined);
      }
    }
    if (record.source === "clob" && (record.kind === "book_snapshot" || record.kind === "book_snapshot_batch")) {
      // An HTTP anchor is a full book too. Without counting it here, a game
      // whose only complete book arrives from the anchor pass is marked
      // "missed" and its tail is never finalized, even though the data exists.
      //
      // A `/books` batch asks for up to 50 tokens and upstream answers with
      // fewer of them, so the request list is not evidence. Crediting it set
      // `lastBookAtMs` past the game's last real frame, the quiet-finish
      // anchor then landed on an empty window, and the match was archived
      // with no data at all.
      const data = objectValue(record.data);
      const tokenIds = record.kind === "book_snapshot"
        ? (typeof data?.tokenId === "string" ? [data.tokenId] : [])
        : batchBookTokens(data);
      const activeTokens = activeSnapshotTokens(data, tokenIds);
      for (const token of new Set(tokenIds)) {
        const key = this.tokens.get(token), game = key ? this.games.get(key) : undefined;
        if (!game) continue;
        this.source(game, record);
        game.bookUpdates++; game.lastBookAtMs = record.receivedAtMs; game.lastBookRunId = record.runId;
        if (activeTokens.has(token)) {
          game.lastActiveBookAtMs = record.receivedAtMs;
          game.lastActiveBookRunId = record.runId;
          game.firstBookAtMs ??= record.receivedAtMs;
        }
      }
      this.rememberConnectionGames(record);
      return;
    }
    if (record.source !== "clob" || record.kind !== "ws_message" || typeof record.data !== "string") {
      this.rememberConnectionGames(record);
      return;
    }
    if (["ping", "pong"].includes(record.data.trim().toLowerCase())) return;
    const parsed: unknown = JSON.parse(record.data);
    for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
      const frame = objectValue(value); if (!frame) continue;
      const tokenIds = new Set<string>();
      if (typeof frame.asset_id === "string") tokenIds.add(frame.asset_id);
      if (Array.isArray(frame.price_changes)) for (const change of frame.price_changes) {
        const token = objectValue(change)?.asset_id; if (typeof token === "string") tokenIds.add(token);
      }
      for (const token of tokenIds) {
        const key = this.tokens.get(token), game = key ? this.games.get(key) : undefined; if (!game) continue;
        this.source(game, record);
        if (frame.event_type === "book" || frame.event_type === "price_change") {
          game.bookUpdates++; game.lastBookAtMs = record.receivedAtMs; game.lastBookRunId = record.runId;
          if (!isTerminalClearFrame(frame)) {
            game.lastActiveBookAtMs = record.receivedAtMs;
            game.lastActiveBookRunId = record.runId;
            if (frame.event_type === "book") game.firstBookAtMs ??= record.receivedAtMs;
          }
        } else if (frame.event_type === "last_trade_price") game.trades++;
      }
    }
    this.rememberConnectionGames(record);
  }
  readyToArchive(runId: string, nowMs = Date.now()): CapturedGame[] {
    return [...this.games.values()].filter(game => {
      const activeRunId = game.lastActiveBookRunId ?? game.lastBookRunId;
      return game.firstBookAtMs !== null && game.finishedAtMs !== null &&
        (activeRunId === runId || !!game.archive?.snapshotDirectory || game.sources.some(source => source.runId === activeRunId)) &&
        game.eventIds.every(id => game.retiredEventIds.includes(id)) &&
        (!game.archive || (game.archive.status === "failed" && (game.archive.retryAtMs ?? 0) <= nowMs));
    });
  }
  markArchive(key: string, archive: ArchiveState): void {
    const game = this.games.get(key); if (!game) throw new Error("CAPTURE_GAME_UNKNOWN");
    game.archive = { ...archive, ...(game.finishConflict && archive.status === "complete" ? {
      priceReadyTokens: 0, strictReadyTokens: 0, error: "conflicting finish evidence; artifact is available but quality is not approved"
    } : {}) };
    game.phase = archive.status === "complete" ? "archived" : archive.status === "running" ? "archiving" : "archive_failed";
    // Finished outputs and raw history remain on disk; bound the hot dashboard.
    const finished = [...this.games.values()].filter(game => game.phase === "archived" || game.phase === "missed");
    for (const old of finished.slice(0, Math.max(0, this.games.size - 1000))) {
      this.games.delete(old.key);
      for (const token of old.tokenIds) this.tokens.delete(token);
      for (const id of old.eventIds) this.events.delete(id);
    }
  }
  snapshot(): ContinuousStatus & { compression: CompressionState } {
    return JSON.parse(JSON.stringify({ schemaVersion: 1, instanceId: this.instanceId, pid: process.pid, startedAtMs: this.startedAtMs,
      updatedAtMs: this.updatedAtMs, stateStaleAfterMs: this.stateStaleAfterMs, dataRoot: this.dataRoot, port: this.port, mode: this.mode, runId: this.runId, runDirectory: this.runDirectory,
      receivedRecords: this.receivedRecords, lastRecordAtMs: this.lastRecordAtMs, freeBytes: this.freeBytes, rawBytes: this.rawBytes,
      queuedBytes: this.queuedBytes, desiredTokens: this.desiredTokens, games: [...this.games.values()], connections: [...this.connections.values()], errors: this.errors,
      ...(this.compactStorage ? { compactStorage: this.compactStorage } : {}), compression: this.compression })) as ContinuousStatus & { compression: CompressionState };
  }
  restore(saved: ContinuousStatus): void {
    if (saved.schemaVersion !== 1 || !Array.isArray(saved.games)) throw new Error("CAPTURE_STATE_INVALID");
    const cutoff = Number.isFinite(this.restoreMaxAgeMs) ? Date.now() - this.restoreMaxAgeMs : -Infinity;
    for (const value of saved.games) {
      if (value.lastSeenAtMs < cutoff && !this.hasPendingArchive(value)) continue;
      const game = structuredClone(value);
      if (!game || typeof game.key !== "string" || !Array.isArray(game.tokenIds) || !Array.isArray(game.eventIds)) throw new Error("CAPTURE_STATE_INVALID");
      if (!Object.hasOwn(game, "lastActiveBookAtMs")) game.lastActiveBookAtMs = game.lastBookAtMs;
      if (!Object.hasOwn(game, "lastActiveBookRunId")) game.lastActiveBookRunId = game.lastBookRunId;
      if (game.archive?.status === "running") game.archive = { ...game.archive, status: "failed", error: "export interrupted by restart", retryAtMs: 0 };
      if (game.archive?.status === "failed") game.archive.retryAtMs = 0;
      if (game.finishConflict && game.archive) {
        const { snapshotDirectory: _staleSnapshot, finishFactsFile: _staleFacts, ...archive } = game.archive;
        game.archive = { ...archive, status: "failed", refreshSnapshot: true, retryAtMs: 0, priceReadyTokens: 0, strictReadyTokens: 0 };
      }
      if (game.phase !== "archived" && game.phase !== "missed") game.phase = "interrupted";
      this.games.set(game.key, game);
      for (const token of game.tokenIds) this.tokens.set(token, game.key);
      for (const event of game.eventIds) this.events.set(event, game.key);
    }
  }
}
