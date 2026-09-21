import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { CapturedGame } from "./continuous-state.js";
import type { TailFinishFact } from "./tail-types.js";
import { objectValue } from "./replay-values.js";
import { recordMarksActiveBook } from "./book-evidence.js";
import type { JournalRecord } from "./types.js";

const DATABASE_NAME = "tail.sqlite";
const SCHEMA_VERSION = 6;
/** Default lifetime of an unresolved game's protected tail. */
const DEFAULT_PENDING_FINISH_MS = 900_000;
/**
 * How long an unchanged payload may be collapsed before it is written again.
 *
 * Consecutive identical payloads are redundant and would otherwise dominate
 * staging. Collapsing them for the whole rolling window is worse though: a
 * match whose book never moves then holds no row inside its own final window,
 * and `finalize` finds nothing to publish at all. One copy per minute keeps the
 * final window anchored without restoring the redundancy.
 */
const DEFAULT_REDUNDANT_KEEP_ALIVE_MS = 60_000;

export interface CompactTailStoreOptions {
  dataRoot: string;
  tailWindowMs: number;
  bufferMs: number;
  retentionMs: number;
  maxBytes: number;
  /**
   * How long the rolling tail of a game whose finish label has not arrived yet
   * survives wall-clock pruning. Past this age the evidence cannot produce a
   * window any more, so it is released instead of protected forever.
   */
  pendingFinishMs?: number;
  /** Override for the unchanged-payload keep-alive; must stay below `tailWindowMs`. */
  redundantKeepAliveMs?: number;
  now?: () => number;
}

export interface FinalizeResult {
  /** Rows copied into `tail_records` for this game. */
  records: number;
  /** Oldest retained receipt time, or null when nothing was retained. */
  windowStartMs: number | null;
  /** True when the retained window reaches the requested floor. */
  windowComplete: boolean;
  /** Milliseconds of the requested window that are missing from the front. */
  missingFrontMs: number;
}

export interface RepairReport {
  matches: number;
  recordsRewritten: number;
  recordsDropped: number;
  foreignFramesDropped: number;
  anchorsRepaired: number;
  windowComplete: number;
  windowIncomplete: number;
  details: Array<{ gameKey: string; recordsRewritten: number; recordsDropped: number;
    foreignFramesDropped: number; anchorRepaired: boolean; previousFinishedAtMs: number;
    finishedAtMs: number; windowComplete: boolean; missingFrontMs: number }>;
}

export interface CompactStoredRecord {
  gameKey: string;
  runId: string;
  sequence: number;
  /** Position of this frame within its source record; 0 for single-frame records. */
  frameIndex: number;
  receivedAtMs: number;
  source: JournalRecord["source"];
  kind: string;
  data: unknown;
  /** Origin connection for frames that arrived over a WebSocket. */
  connectionId?: string;
}

export interface CompactTailStoreStatus {
  databasePath: string;
  databaseBytes: number;
  stagingRecords: number;
  finalizedMatches: number;
  finalizedRecords: number;
  pendingRecords: number;
  lastMaintenanceAtMs: number | null;
  lastMaintenanceDeletedMatches: number;
  lastMaintenanceDeletedRecords: number;
  /** Games whose tail was protected from wall-clock pruning by the last pass. */
  stagingProtectedGames: number;
  /**
   * Retention actually in force, so the backtest store's lifetime is visible in
   * the status API instead of only in the config file.
   */
  retentionMs: number;
  maxBytes: number;
  pendingFinishMs: number;
}

interface PendingRecord {
  gameKey: string;
  record: JournalRecord;
  frameIndex: number;
  hash: string;
  payload: Buffer;
  /** Kind of the stored frame, which can be narrower than the source record. */
  kind: string;
}

interface SqlRow {
  game_key: string;
  run_id: string;
  sequence: number;
  frame_index: number;
  received_at_ms: number;
  source: JournalRecord["source"];
  kind: string;
  payload: Uint8Array;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
  return value;
}

function serializedPayload(record: JournalRecord): string {
  return JSON.stringify({ source: record.source, kind: record.kind, connectionId: record.connectionId ?? null, data: record.data });
}

function payloadHash(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

function payloadBlob(payload: string): Buffer {
  return deflateRawSync(Buffer.from(payload, "utf8"), { level: 6 });
}



function sourceFrom(value: unknown): JournalRecord["source"] {
  if (value === "collector" || value === "gamma" || value === "clob" || value === "sports") return value;
  throw new Error("COMPACT_TAIL_PAYLOAD_INVALID: source");
}

function decodePayload(payload: Uint8Array): { source: JournalRecord["source"]; kind: string; connectionId?: string; data: unknown } {
  const value: unknown = JSON.parse(inflateRawSync(Buffer.from(payload)).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("COMPACT_TAIL_PAYLOAD_INVALID");
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string") throw new Error("COMPACT_TAIL_PAYLOAD_INVALID: kind");
  // Stored frames may be raw WebSocket text or an already-decoded value.
  // Normalize here so every reader sees the same shape: text that parses to a
  // JSON object/array becomes that value, while non-JSON text (for example a
  // "PONG" heartbeat) stays a string.
  let data = record.data;
  if (typeof data === "string") {
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed === "object" && parsed !== null) data = parsed;
    } catch { /* keep the original text */ }
  }
  return {
    source: sourceFrom(record.source), kind: record.kind,
    ...(typeof record.connectionId === "string" ? { connectionId: record.connectionId } : {}), data
  };
}

function tableCount(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number } | undefined;
  return typeof row?.count === "number" ? row.count : 0;
}

export class CompactTailStore {
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private readonly tailWindowMs: number;
  private readonly bufferMs: number;
  private readonly retentionMs: number;
  private readonly maxBytes: number;
  private readonly pendingFinishMs: number;
  private readonly redundantKeepAliveMs: number;
  private readonly now: () => number;
  private readonly pending: PendingRecord[] = [];
  private readonly lastHashByGame = new Map<string, { hash: string; atMs: number }>();
  /**
   * Range over which collapsed frames prove the order book never moved.
   *
   * `redundantFor` only drops a frame that is byte-identical to the one stored
   * immediately before it, so a dropped frame at `T` proves the game's payload
   * held its value on `[P, T]` where `P` is that earlier stored receipt. The
   * chains are contiguous - each stored frame that ends a chain starts the next
   * - so the union of every chain for a game is the single interval
   * `[dedupCoveredFromMs, dedupCoveredThroughMs]`. That is what lets
   * `windowCoverage` tell a genuine hole in the final window apart from a front
   * the keep-alive simply did not re-write.
   */
  private readonly dedupCoveredFromMs = new Map<string, number>();
  private readonly dedupCoveredThroughMs = new Map<string, number>();
  private lastMaintenanceAtMs: number | null = null;
  private lastMaintenanceDeletedMatches = 0;
  private lastMaintenanceDeletedRecords = 0;
  private lastProtectedGames = 0;
  private lastVacuumAtMs = 0;
  private lastCheckpointAtMs = 0;
  private closed = false;
  /**
   * Games whose finish is known but whose tail has not been copied to
   * `tail_records` yet. Their staging rows must survive wall-clock pruning:
   * the final window is anchored on `finishAtMs`, so a maintenance pass that
   * runs between finish and finalize would otherwise delete its oldest
   * seconds. Keyed by game, valued by the window floor to retain.
   */
  private readonly pendingFinalize = new Map<string, { floor: number; finishAtMs: number }>();

  constructor(databasePath: string, options: Omit<CompactTailStoreOptions, "dataRoot">) {
    this.databasePath = resolve(databasePath);
    this.tailWindowMs = positiveInteger(options.tailWindowMs, "tailWindowMs");
    this.bufferMs = positiveInteger(options.bufferMs, "bufferMs");
    this.retentionMs = positiveInteger(options.retentionMs, "retentionMs");
    this.maxBytes = positiveInteger(options.maxBytes, "maxBytes");
    this.pendingFinishMs = nonnegativeInteger(options.pendingFinishMs ?? DEFAULT_PENDING_FINISH_MS, "pendingFinishMs");
    this.redundantKeepAliveMs = positiveInteger(options.redundantKeepAliveMs ?? DEFAULT_REDUNDANT_KEEP_ALIVE_MS, "redundantKeepAliveMs");
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(this.databasePath, { timeout: 5_000, defensive: true });
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      -- Write-ahead logging, not a rollback journal: the collector writes from
      -- the same event loop that serves its status API, and a rollback journal
      -- forces a writer to wait for every reader. One long analytical query
      -- (a full scan of the payloads table) then froze capture for 38 minutes with no
      -- error and no heartbeat. WAL lets readers run against a snapshot while
      -- the collector keeps committing.
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA auto_vacuum = INCREMENTAL;
      CREATE TABLE IF NOT EXISTS compact_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS payloads (
        hash TEXT PRIMARY KEY,
        payload BLOB NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS matches (
        game_key TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        sport TEXT,
        game_id TEXT,
        event_ids_json TEXT NOT NULL,
        event_slugs_json TEXT NOT NULL,
        token_ids_json TEXT NOT NULL,
        market_ids_json TEXT NOT NULL,
        finished_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        window_start_ms INTEGER,
        window_complete INTEGER NOT NULL DEFAULT 0,
        missing_front_ms INTEGER NOT NULL DEFAULT 0,
        finish_anchor TEXT,
        finish_conflict INTEGER NOT NULL DEFAULT 0,
        finish_facts_json TEXT,
        metadata_json TEXT
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS staging_records (
        game_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        frame_index INTEGER NOT NULL DEFAULT 0,
        received_at_ms INTEGER NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        PRIMARY KEY(game_key, run_id, sequence, frame_index)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS staging_time_idx ON staging_records(received_at_ms);
      CREATE INDEX IF NOT EXISTS staging_payload_idx ON staging_records(payload_hash);
      CREATE TABLE IF NOT EXISTS tail_records (
        game_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        frame_index INTEGER NOT NULL DEFAULT 0,
        received_at_ms INTEGER NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        PRIMARY KEY(game_key, run_id, sequence, frame_index)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS tail_time_idx ON tail_records(received_at_ms);
      CREATE INDEX IF NOT EXISTS tail_payload_idx ON tail_records(payload_hash);
    `);
    this.migrate();
  }

  /**
   * Bring an older database up to the current schema. Version 1 keyed records
   * on (game, run, sequence), which cannot hold the several frames a single
   * batched market message produces for one game; those rows were silently
   * dropped by `INSERT OR IGNORE`. Version 2 adds `frame_index` to the key so
   * every frame survives.
   */
  private migrate(): void {
    const row = this.db.prepare("SELECT value FROM compact_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    const version = Number(row?.value ?? "0");
    if (version < 2) {
      const legacy = (table: string): boolean => {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
        return columns.length > 0 && !columns.some(column => column.name === "frame_index");
      };
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const table of ["staging_records", "tail_records"] as const) {
          if (!legacy(table)) continue;
          // Rebuild in place; existing rows are preserved with frame_index 0.
          this.db.exec(`CREATE TABLE ${table}_migrated (
            game_key TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
            frame_index INTEGER NOT NULL DEFAULT 0, received_at_ms INTEGER NOT NULL,
            source TEXT NOT NULL, kind TEXT NOT NULL, payload_hash TEXT NOT NULL,
            PRIMARY KEY(game_key, run_id, sequence, frame_index)
          ) WITHOUT ROWID`);
          this.db.exec(`INSERT OR IGNORE INTO ${table}_migrated
            (game_key, run_id, sequence, frame_index, received_at_ms, source, kind, payload_hash)
            SELECT game_key, run_id, sequence, 0, received_at_ms, source, kind, payload_hash FROM ${table}`);
          this.db.exec(`DROP TABLE ${table}`);
          this.db.exec(`ALTER TABLE ${table}_migrated RENAME TO ${table}`);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS staging_time_idx ON staging_records(received_at_ms)");
      this.db.exec("CREATE INDEX IF NOT EXISTS staging_payload_idx ON staging_records(payload_hash)");
      this.db.exec("CREATE INDEX IF NOT EXISTS tail_time_idx ON tail_records(received_at_ms)");
      this.db.exec("CREATE INDEX IF NOT EXISTS tail_payload_idx ON tail_records(payload_hash)");
    }
    if (version < 3) {
      // Older rows predate coverage tracking. They keep the default (incomplete)
      // rather than being retroactively blessed as full windows; the backfill
      // below computes what can still be proven from the retained frames.
      const columns = this.db.prepare("PRAGMA table_info(matches)").all() as Array<{ name?: string }>;
      for (const [name, ddl] of [["window_start_ms", "INTEGER"],
        ["window_complete", "INTEGER NOT NULL DEFAULT 0"],
        ["missing_front_ms", "INTEGER NOT NULL DEFAULT 0"]] as const) {
        if (!columns.some(column => column.name === name)) this.db.exec(`ALTER TABLE matches ADD COLUMN ${name} ${ddl}`);
      }
    }
    if (version < 4) {
      // How the window end was established. Rows written before this column
      // existed keep NULL: their anchor is unknown, not assumed.
      const columns = this.db.prepare("PRAGMA table_info(matches)").all() as Array<{ name?: string }>;
      if (!columns.some(column => column.name === "finish_anchor")) {
        this.db.exec("ALTER TABLE matches ADD COLUMN finish_anchor TEXT");
      }
    }
    if (version < 5) {
      // Market identity (conditionId, outcome names, market type) lived only in
      // the raw run, which is pruned after 24 hours. Without it a finalized tail
      // cannot be turned back into a replayable window, so store a trimmed copy
      // with the match. Older rows keep NULL: their metadata is gone, not assumed.
      const columns = this.db.prepare("PRAGMA table_info(matches)").all() as Array<{ name?: string }>;
      if (!columns.some(column => column.name === "metadata_json")) {
        this.db.exec("ALTER TABLE matches ADD COLUMN metadata_json TEXT");
      }
    }
    if (version < 6) {
      // Keep every finish witness and whether the witnesses disagree. The
      // compact export must not collapse a conflicted boundary into a single
      // synthetic fact and silently make it look trustworthy.
      const columns = this.db.prepare("PRAGMA table_info(matches)").all() as Array<{ name?: string }>;
      if (!columns.some(column => column.name === "finish_conflict")) {
        this.db.exec("ALTER TABLE matches ADD COLUMN finish_conflict INTEGER NOT NULL DEFAULT 0");
      }
      if (!columns.some(column => column.name === "finish_facts_json")) {
        this.db.exec("ALTER TABLE matches ADD COLUMN finish_facts_json TEXT");
      }
    }
    this.db.prepare("INSERT INTO compact_meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(SCHEMA_VERSION));
  }

  /**
   * Pin the oldest second that must survive pruning for a finished game.
   * Called as soon as a finish is observed, before the archive turn runs.
   */
  /** True when the game still has at least one staged frame inside the window. */
  hasStagedInWindow(gameKey: string, startMs: number, endMs: number): boolean {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    this.flush();
    const row = this.db.prepare(`SELECT 1 AS present FROM staging_records
      WHERE game_key = ? AND received_at_ms >= ? AND received_at_ms <= ?
        AND source = 'clob' AND kind IN ('ws_message', 'book_snapshot') LIMIT 1`).get(gameKey, startMs, endMs) as { present?: number } | undefined;
    return row !== undefined;
  }

  /**
   * Receipt time of the newest staged frame for a game, or null when the game
   * has no staged rows left.
   *
   * Callers keep the finish anchor honest with it: a published clock, or a
   * `/books` batch that answered for other tokens, can post-date the last frame
   * the store really holds, and a window anchored past every stored frame is
   * empty no matter how much evidence the game produced.
   */
  stagedTailAt(gameKey: string): number | null {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    this.flush();
    const row = this.db.prepare(`SELECT MAX(received_at_ms) AS at FROM staging_records
      WHERE game_key = ? AND source = 'clob' AND kind IN ('ws_message', 'book_snapshot')`)
      .get(gameKey) as { at?: number | null } | undefined;
    return typeof row?.at === "number" ? row.at : null;
  }

  markPendingFinalize(gameKey: string, finishAtMs: number): void {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    if (!Number.isSafeInteger(finishAtMs) || finishAtMs < 0) throw new RangeError("finishAtMs must be a nonnegative safe integer");
    const floor = finishAtMs - this.tailWindowMs;
    const existing = this.pendingFinalize.get(gameKey);
    if (existing === undefined || floor < existing.floor) this.pendingFinalize.set(gameKey, { floor, finishAtMs });
  }

  /** Refresh finish provenance on an already-finalized match without touching its price window. */
  refreshFinishEvidence(game: Pick<CapturedGame, "key" | "finishAnchor" | "finishConflict" | "finishFacts" | "eventMetadata">): void {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    this.db.prepare(`UPDATE matches SET finish_anchor = COALESCE(?, finish_anchor),
      finish_conflict = MAX(finish_conflict, ?), finish_facts_json = COALESCE(?, finish_facts_json),
      metadata_json = COALESCE(?, metadata_json), updated_at_ms = ? WHERE game_key = ?`)
      .run(game.finishAnchor ?? null, game.finishConflict ? 1 : 0,
        game.finishFacts?.length ? JSON.stringify(game.finishFacts) : null,
        game.eventMetadata === undefined ? null : JSON.stringify(game.eventMetadata), this.now(), game.key);
  }

  /**
   * True when this payload repeats the game's last one soon enough that
   * writing it again would only add redundancy.
   */
  private redundantFor(gameKey: string, hash: string, atMs: number): boolean {
    const previous = this.lastHashByGame.get(gameKey);
    return previous !== undefined && previous.hash === hash && atMs - previous.atMs < this.redundantKeepAliveMs;
  }

  private rememberHash(gameKey: string, hash: string, atMs: number): void {
    this.lastHashByGame.set(gameKey, { hash, atMs });
  }

  /** Extend the interval a collapsed frame proves the book was unchanged over. */
  private rememberDedup(gameKey: string, atMs: number): void {
    const matchedAtMs = this.lastHashByGame.get(gameKey)?.atMs;
    if (matchedAtMs === undefined) return;
    const from = this.dedupCoveredFromMs.get(gameKey);
    if (from === undefined || matchedAtMs < from) this.dedupCoveredFromMs.set(gameKey, matchedAtMs);
    const through = this.dedupCoveredThroughMs.get(gameKey);
    if (through === undefined || atMs > through) this.dedupCoveredThroughMs.set(gameKey, atMs);
  }

  ingest(record: JournalRecord, gameKeys: readonly string[]): void {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    if (!this.isCaptureRecord(record)) return;
    const payload = serializedPayload(record);
    const hash = payloadHash(payload);
    const compressed = payloadBlob(payload);
    const lifecycle = record.source === "collector" && ["connection_open", "connection_close", "connection_gap", "connection_timeout", "heartbeat_timeout"].includes(record.kind);
    for (const gameKey of new Set(gameKeys)) {
      if (lifecycle) {
        // A reconnect/gap breaks the chain of identical payloads. Keeping the
        // old chain would let coverage claim continuity across missing data.
        this.lastHashByGame.delete(gameKey);
        this.dedupCoveredFromMs.delete(gameKey);
        this.dedupCoveredThroughMs.delete(gameKey);
      }
      if (this.redundantFor(gameKey, hash, record.receivedAtMs)) {
        this.rememberDedup(gameKey, record.receivedAtMs);
        continue;
      }
      this.rememberHash(gameKey, hash, record.receivedAtMs);
      this.pending.push({ gameKey, record, frameIndex: 0, hash, payload: compressed, kind: record.kind });
    }
    if (this.pending.length >= 256) this.flush();
  }

  /**
   * Store one already-attributed frame. A CLOB WebSocket message can batch
   * frames for many unrelated games, so the caller splits it by token and
   * hands each frame to exactly the game that owns the token. Without this the
   * whole batch would be copied into every game it merely mentions.
   */
  ingestFrame(record: JournalRecord, gameKey: string, frame: unknown, frameIndex: number, kind = record.kind): void {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    const payload = JSON.stringify({ source: record.source, kind, connectionId: record.connectionId ?? null,
      data: JSON.stringify(frame), frameIndex });
    const hash = payloadHash(payload);
    if (this.redundantFor(gameKey, hash, record.receivedAtMs)) {
      this.rememberDedup(gameKey, record.receivedAtMs);
      return;
    }
    this.rememberHash(gameKey, hash, record.receivedAtMs);
    this.pending.push({ gameKey, record, frameIndex, hash, payload: payloadBlob(payload), kind });
    if (this.pending.length >= 256) this.flush();
  }

  private isCaptureRecord(record: JournalRecord): boolean {
    return ((record.source === "sports" || record.source === "clob") &&
      (record.kind === "ws_message" || record.kind === "book_snapshot" || record.kind === "book_snapshot_batch")) ||
      (record.source === "collector" && ["connection_open", "connection_close", "connection_gap", "connection_timeout", "heartbeat_timeout"].includes(record.kind));
  }

  flush(): void {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    if (this.pending.length === 0) return;
    const insertPayload = this.db.prepare("INSERT OR IGNORE INTO payloads(hash, payload) VALUES (?, ?)");
    const insertRecord = this.db.prepare(`INSERT OR IGNORE INTO staging_records
      (game_key, run_id, sequence, frame_index, received_at_ms, source, kind, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of this.pending) {
        insertPayload.run(item.hash, item.payload);
        insertRecord.run(item.gameKey, item.record.runId, item.record.sequence, item.frameIndex, item.record.receivedAtMs,
          item.record.source, item.kind, item.hash);
      }
      this.db.exec("COMMIT");
      this.pending.length = 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finalize(game: CapturedGame, finishAtMs: number): FinalizeResult {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    if (!Number.isSafeInteger(finishAtMs) || finishAtMs < 0) throw new RangeError("finishAtMs must be a nonnegative safe integer");
    this.flush();
    const start = finishAtMs - this.tailWindowMs;
    // The window floor is a boundary, not a starting state. Reconstructing the
    // ask ladder from it needs the last full-depth anchor at or before it plus
    // every delta since; copying only `[start, finish]` left the exported
    // window with no seed, so the depth could not be rebuilt from the floor.
    const seed = this.seedStart(game.key, start, finishAtMs);
    const available = this.db.prepare(`SELECT COUNT(*) AS count FROM staging_records
      WHERE game_key = ? AND received_at_ms >= ? AND received_at_ms <= ?`).get(game.key, seed.copyStart, finishAtMs) as { count?: number } | undefined;
    const availableCount = available?.count ?? 0;
    const depth = this.db.prepare(`SELECT COUNT(*) AS count FROM staging_records
      WHERE game_key = ? AND received_at_ms >= ? AND received_at_ms <= ?
        AND source = 'clob' AND kind IN ('ws_message', 'book_snapshot')`).get(game.key, seed.copyStart, finishAtMs) as { count?: number } | undefined;
    const depthCount = depth?.count ?? 0;
    // Report how much of the target window actually survived. Coverage is about
    // the order book, not unrelated sports/lifecycle records, so a sports score
    // at the floor cannot make an empty CLOB window look complete.
    const coverage = this.windowCoverage(game.key, start, finishAtMs, depthCount, seed.anchorAtMs);
    if (depthCount === 0) {
      // A retry can arrive after the rolling rows were pruned. If the match
      // already exists, still refresh its finish provenance; otherwise the
      // database would keep an older conflict/fact set while the in-memory
      // state claimed the archive was current.
      this.refreshFinishEvidence(game);
      const hashes = this.db.prepare("SELECT DISTINCT payload_hash FROM staging_records WHERE game_key = ?").all(game.key) as Array<{ payload_hash: string }>;
      this.db.prepare("DELETE FROM staging_records WHERE game_key = ?").run(game.key);
      this.cleanupOrphanPayloads(hashes.map(row => row.payload_hash));
      this.pendingFinalize.delete(game.key);
      return { records: 0, ...coverage };
    }
    const upsertMatch = this.db.prepare(`INSERT INTO matches
      (game_key, title, sport, game_id, event_ids_json, event_slugs_json, token_ids_json, market_ids_json,
       finished_at_ms, updated_at_ms, window_start_ms, window_complete, missing_front_ms, finish_anchor,
       finish_conflict, finish_facts_json, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_key) DO UPDATE SET title=excluded.title, sport=excluded.sport, game_id=excluded.game_id,
        event_ids_json=excluded.event_ids_json, event_slugs_json=excluded.event_slugs_json, token_ids_json=excluded.token_ids_json,
        market_ids_json=excluded.market_ids_json, finished_at_ms=excluded.finished_at_ms, updated_at_ms=excluded.updated_at_ms,
        window_start_ms=excluded.window_start_ms, window_complete=excluded.window_complete, missing_front_ms=excluded.missing_front_ms,
        finish_anchor=excluded.finish_anchor, finish_conflict=excluded.finish_conflict,
        finish_facts_json=COALESCE(excluded.finish_facts_json, matches.finish_facts_json),
        metadata_json=COALESCE(excluded.metadata_json, matches.metadata_json)`);
    const copy = this.db.prepare(`INSERT OR IGNORE INTO tail_records
      (game_key, run_id, sequence, frame_index, received_at_ms, source, kind, payload_hash)
      SELECT game_key, run_id, sequence, frame_index, received_at_ms, source, kind, payload_hash
      FROM staging_records WHERE game_key = ? AND received_at_ms >= ? AND received_at_ms <= ?`);
    const remove = this.db.prepare("DELETE FROM staging_records WHERE game_key = ?");
    const removedHashes = this.db.prepare("SELECT DISTINCT payload_hash FROM staging_records WHERE game_key = ?").all(game.key) as Array<{ payload_hash: string }>;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      upsertMatch.run(game.key, game.title, game.sport, game.gameId, JSON.stringify(game.eventIds), JSON.stringify(game.eventSlugs),
        JSON.stringify(game.tokenIds), JSON.stringify(game.marketIds), finishAtMs, this.now(),
        coverage.windowStartMs, coverage.windowComplete ? 1 : 0, coverage.missingFrontMs, game.finishAnchor ?? null,
        game.finishConflict ? 1 : 0, game.finishFacts?.length ? JSON.stringify(game.finishFacts) : null,
        game.eventMetadata === undefined ? null : JSON.stringify(game.eventMetadata));
      copy.run(game.key, seed.copyStart, finishAtMs);
      remove.run(game.key);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.lastHashByGame.delete(game.key);
    this.dedupCoveredFromMs.delete(game.key);
    this.dedupCoveredThroughMs.delete(game.key);
    this.pendingFinalize.delete(game.key);
    this.cleanupOrphanPayloads(removedHashes.map(row => row.payload_hash));
    return { records: availableCount, ...coverage };
  }

  /**
   * Where the finalized copy has to start so the window can be reconstructed,
   * and the anchor that proves the book at the floor.
   *
   * `copyStart` is the newest full-depth anchor at or before the floor when one
   * survived, otherwise the oldest retained frame (never earlier than one extra
   * window back). `anchorAtMs` is only set when that anchor really precedes the
   * floor, so a window whose evidence genuinely starts late is still reported
   * as short.
   */
  private seedStart(gameKey: string, start: number, finishAtMs: number): { copyStart: number; anchorAtMs: number | null } {
    const anchor = this.db.prepare(`SELECT MAX(received_at_ms) AS at FROM staging_records
      WHERE game_key = ? AND kind = 'book_snapshot' AND received_at_ms <= ? AND received_at_ms >= ?`)
      .get(gameKey, start, start - this.tailWindowMs) as { at?: number | null } | undefined;
    const anchorAtMs = typeof anchor?.at === "number" ? anchor.at : null;
    // Without a preceding anchor there is nothing to seed from, so the copy
    // keeps the documented `[floor, finish]` shape instead of padding the store
    // with deltas that cannot be applied.
    return { copyStart: anchorAtMs ?? start, anchorAtMs };
  }

  /**
   * The oldest second retained for a finalized window, and whether the window
   * reaches all the way back to `finishAtMs - tailWindowMs`.
   *
   * `windowStartMs` stays the oldest *stored* receipt. `missingFrontMs` measures
   * the front that is not *evidenced*: when the keep-alive collapsed a frame
   * inside the window, the identical stored frame before it proves the book did
   * not move across the gap, so that front is covered even without a row.
   */
  private windowCoverage(gameKey: string, start: number, finishAtMs: number, count: number, anchorAtMs: number | null): Omit<FinalizeResult, "records"> {
    if (count === 0) return { windowStartMs: null, windowComplete: false, missingFrontMs: this.tailWindowMs };
    const oldest = this.db.prepare(`SELECT MIN(received_at_ms) AS at FROM staging_records
      WHERE game_key = ? AND received_at_ms >= ? AND received_at_ms <= ?
        AND source = 'clob' AND kind IN ('ws_message', 'book_snapshot')`).get(gameKey, start, finishAtMs) as { at?: number | null } | undefined;
    const windowStartMs = typeof oldest?.at === "number" ? oldest.at : null;
    // The book is known at the floor when a chain of identical payloads spans
    // it: the frame stored before the floor and the collapsed frame after it
    // carry the same bytes, so nothing moved in between.
    const dedupFrom = this.dedupCoveredFromMs.get(gameKey);
    const dedupThrough = this.dedupCoveredThroughMs.get(gameKey);
    const provenByDedup = dedupFrom !== undefined && dedupThrough !== undefined
      && dedupFrom <= start && dedupThrough >= start;
    // A full-depth anchor at or before the floor proves the book there just as
    // well: every later delta is retained, so the ladder is known from the
    // floor onward even though the anchor's own receipt predates it.
    const provenByAnchor = anchorAtMs !== null && anchorAtMs <= start;
    const coveredFromMs = provenByAnchor ? anchorAtMs : windowStartMs;
    const missingFrontMs = coveredFromMs === null ? (provenByDedup ? 0 : this.tailWindowMs)
      : provenByDedup ? 0 : Math.max(0, coveredFromMs - start);
    // Frames are not guaranteed to land exactly on the floor, so a window is
    // complete when nothing material is missing: tolerate at most the shorter
    // of one second and 1% of the window.
    const toleranceMs = Math.min(1_000, Math.floor(this.tailWindowMs / 100));
    return { windowStartMs, windowComplete: missingFrontMs <= toleranceMs, missingFrontMs };
  }

  /**
   * Windows that wall-clock pruning must not touch.
   *
   * Two sources feed this list:
   * - a finish is known but the archive turn has not copied the tail yet, so
   *   the floor is the exact `finishAtMs - tailWindowMs`;
   * - the game's events are retired but no finish label has arrived, so the
   *   eventual window is still unknown. Keeping each such game's own rolling
   *   tail means a label that lands minutes later still finds the evidence
   *   instead of an empty window.
   *
   * The second source is bounded by `pendingFinishMs`: past that age the label
   * cannot produce a window any more and the rows are released. A finalized
   * game leaves `matches`, which also ends its exemption, so this cannot grow
   * without limit.
   */
  private protectedWindows(nowMs: number): Array<readonly [string, number]> {
    const windows = new Map<string, number>();
    const protect = (gameKey: string, floor: number): void => {
      const existing = windows.get(gameKey);
      if (existing === undefined || floor < existing) windows.set(gameKey, floor);
    };
    // A pin normally lives only until `finalize` clears it. If a finished game
    // never becomes archivable, drop the stale pin so its staging can be
    // reclaimed instead of being protected forever.
    const pinMaxAgeMs = Math.max(this.retentionMs, 6 * 3600_000);
    for (const [gameKey, pin] of this.pendingFinalize) {
      if (pin.finishAtMs < nowMs - pinMaxAgeMs) this.pendingFinalize.delete(gameKey);
      // One extra window back: the finalized tail has to start at the last
      // full-depth anchor at or before the window floor, not at the floor.
      else protect(gameKey, pin.floor - this.tailWindowMs);
    }
    if (this.pendingFinishMs > 0) {
      const unresolved = this.db.prepare(`SELECT game_key AS game_key, MAX(received_at_ms) AS last_at FROM staging_records
        WHERE received_at_ms >= ? AND NOT EXISTS (SELECT 1 FROM matches WHERE matches.game_key = staging_records.game_key)
        GROUP BY game_key`).all(nowMs - this.pendingFinishMs) as Array<{ game_key: string; last_at: number }>;
      for (const row of unresolved) protect(row.game_key, row.last_at - 2 * this.tailWindowMs);
    }
    return [...windows.entries()];
  }

  /** Stage the current exemptions in a temp table so the delete stays a single scan. */
  private replaceProtectedWindows(windows: ReadonlyArray<readonly [string, number]>): void {
    this.db.exec(`CREATE TEMP TABLE IF NOT EXISTS protected_windows (
      game_key TEXT PRIMARY KEY, floor INTEGER NOT NULL) WITHOUT ROWID`);
    this.db.prepare("DELETE FROM protected_windows").run();
    const insert = this.db.prepare(`INSERT INTO protected_windows(game_key, floor) VALUES (?, ?)
      ON CONFLICT(game_key) DO UPDATE SET floor = MIN(floor, excluded.floor)`);
    for (const [gameKey, floor] of windows) insert.run(gameKey, floor);
    this.lastProtectedGames = windows.length;
  }

  maintain(nowMs = this.now()): void {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    this.flush();
    const stagingCutoff = nowMs - this.tailWindowMs - this.bufferMs;
    const retentionCutoff = nowMs - this.retentionMs;
    let deletedMatches = 0;
    let deletedRecords = 0;
    const protectedGames = this.protectedWindows(nowMs);
    this.replaceProtectedWindows(protectedGames);
    // A protected row is one a wall-clock rule must not touch: its game either
    // has a known finish the archive turn has not copied yet, or is still
    // waiting for its finish label, in which case the eventual window is
    // anchored on a clock we do not have yet.
    const protection = "AND NOT EXISTS (SELECT 1 FROM protected_windows p WHERE p.game_key = staging_records.game_key AND staging_records.received_at_ms >= p.floor)";
    const expiredPayloadHashes = this.db.prepare(
      `SELECT DISTINCT payload_hash FROM staging_records WHERE received_at_ms < ? ${protection}`)
      .all(stagingCutoff) as Array<{ payload_hash: string }>;
    // Everything the delete keeps is a retention candidate: rows at or after
    // the wall-clock cutoff, plus the protected rows the delete skipped.
    const keptRows = this.db.prepare(`SELECT DISTINCT payload_hash FROM staging_records
      WHERE received_at_ms >= ? OR EXISTS (SELECT 1 FROM protected_windows p WHERE p.game_key = staging_records.game_key AND staging_records.received_at_ms >= p.floor)`)
      .all(stagingCutoff) as Array<{ payload_hash: string }>;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`DELETE FROM staging_records WHERE received_at_ms < ? ${protection}`).run(stagingCutoff);
      this.db.exec("DELETE FROM matches WHERE NOT EXISTS (SELECT 1 FROM tail_records WHERE tail_records.game_key = matches.game_key)");
      const old = this.db.prepare("SELECT game_key FROM matches WHERE finished_at_ms < ? ORDER BY finished_at_ms ASC").all(retentionCutoff) as Array<{ game_key: string }>;
      const deleteRecords = this.db.prepare("DELETE FROM tail_records WHERE game_key = ?");
      const deleteMatch = this.db.prepare("DELETE FROM matches WHERE game_key = ?");
      for (const row of old) {
        const records = this.db.prepare("SELECT COUNT(*) AS count FROM tail_records WHERE game_key = ?").get(row.game_key) as { count?: number } | undefined;
        deletedRecords += records?.count ?? 0;
        deleteRecords.run(row.game_key);
        deleteMatch.run(row.game_key);
        deletedMatches++;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (this.databaseBytes() > this.maxBytes) {
      this.pruneToCap();
    }
    const expired = expiredPayloadHashes.map(row => row.payload_hash);
    const retained = new Set(keptRows.map(row => row.payload_hash));
    this.cleanupOrphanPayloads(expired.filter(hash => !retained.has(hash)));
    // Incremental vacuum can hold the synchronous SQLite handle for a long
    // time on a large database. Run it rarely and in small batches so the
    // collector heartbeat and websocket ingestion remain responsive.
    if (nowMs - this.lastVacuumAtMs >= 6 * 3600_000) {
      this.db.exec("PRAGMA incremental_vacuum(256)");
      this.lastVacuumAtMs = nowMs;
    }
    // Keep the write-ahead log bounded. PASSIVE never waits for readers, so it
    // is safe on every pass; TRUNCATE additionally returns the file to the OS,
    // which does need every reader to finish and therefore runs rarely.
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    if (nowMs - this.lastCheckpointAtMs >= 10 * 60_000) {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.lastCheckpointAtMs = nowMs;
    }
    this.lastMaintenanceAtMs = nowMs;
    this.lastMaintenanceDeletedMatches = deletedMatches;
    this.lastMaintenanceDeletedRecords = deletedRecords;
  }

  /**
   * Delete the oldest matches until the store is back under its byte cap.
   *
   * The deletion is sized from an amortized per-row cost, never from
   * `databaseBytes()` inside the loop. With `auto_vacuum = INCREMENTAL` a row
   * delete only moves pages to the freelist, so the file size does not change
   * until the pages are reclaimed; a loop that measured the file could never
   * reach the target and would delete every match in the store.
   */
  private pruneToCap(): void {
    const target = Math.floor(this.maxBytes * 0.8);
    for (let round = 0; round < 4; round++) {
      const currentBytes = this.databaseBytes();
      if (currentBytes <= target) return;
      const totalRecords = tableCount(this.db, "tail_records");
      if (totalRecords === 0) return;
      // Payload bytes alone understate what deleting a match returns: page and
      // index overhead is spread across the live rows, so charge each row its
      // share of the file.
      const bytesPerRecord = currentBytes / totalRecords;
      const needToFree = currentBytes - target;
      const games = this.db.prepare(`SELECT m.game_key AS game_key, COUNT(r.payload_hash) AS records
        FROM matches m LEFT JOIN tail_records r ON r.game_key = m.game_key
        GROUP BY m.game_key ORDER BY MIN(m.finished_at_ms) ASC`).all() as Array<{ game_key: string; records: number }>;
      const doomed: string[] = [];
      let freed = 0;
      for (const game of games) {
        if (freed >= needToFree) break;
        doomed.push(game.game_key);
        freed += game.records * bytesPerRecord;
      }
      if (doomed.length === 0) return;
      const deleteRecords = this.db.prepare("DELETE FROM tail_records WHERE game_key = ?");
      const deleteMatch = this.db.prepare("DELETE FROM matches WHERE game_key = ?");
      const hashes = this.db.prepare("SELECT DISTINCT payload_hash FROM tail_records WHERE game_key = ?");
      const candidates = new Set<string>();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const gameKey of doomed) {
          for (const row of hashes.all(gameKey) as Array<{ payload_hash: string }>) candidates.add(row.payload_hash);
          deleteRecords.run(gameKey);
          deleteMatch.run(gameKey);
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      this.cleanupOrphanPayloads([...candidates]);
      // Row deletes only free pages; returning them to the OS is what makes the
      // file shrink, so the next round measures the real size. The checkpoint
      // truncates the write-ahead log too, otherwise the cap would count pages
      // that are no longer reachable.
      this.db.exec("PRAGMA incremental_vacuum");
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
    // Under WAL the incremental reclaim can leave the file above the target even
    // with an empty freelist, because a checkpoint does not always truncate the
    // tail. Only when the cap is still exceeded - never on a routine pass - pay
    // for the full rewrite that is guaranteed to shrink it.
    if (this.databaseBytes() > target) {
      this.db.exec("VACUUM");
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
  }

  private cleanupOrphanPayloads(hashes: readonly string[]): void {
    if (hashes.length === 0) return;
    const unique = [...new Set(hashes)];
    const deletePayload = this.db.prepare(`DELETE FROM payloads WHERE hash = ?
      AND NOT EXISTS (SELECT 1 FROM staging_records WHERE staging_records.payload_hash = payloads.hash)
      AND NOT EXISTS (SELECT 1 FROM tail_records WHERE tail_records.payload_hash = payloads.hash)`);
    // Bound each synchronous statement so websocket ingestion and heartbeats
    // are not blocked by a large payload table scan.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < unique.length; index += 256) {
        for (const hash of unique.slice(index, index + 256)) deletePayload.run(hash);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Size of the main database file.
   *
   * The write-ahead log is bounded separately by `wal_autocheckpoint` and the
   * periodic TRUNCATE checkpoint in `maintain`, so counting it here would only
   * make the byte cap jitter with pages that are about to be reclaimed.
   */
  private databaseBytes(): number {
    try { return statSync(this.databasePath).size; } catch { return 0; }
  }

  /**
   * Repair tails written before per-frame attribution.
   *
   * Version 1 attributed a whole batched market message to every game it
   * mentioned, so those rows contain frames belonging to other games. This
   * rewrites each stored record to keep only the frames owned by the match,
   * drops records that hold nothing of its own, and records the real window
   * coverage so a short tail is never presented as a complete one.
   */
  repairAttribution(options: { apply: boolean }): RepairReport {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    const report: RepairReport = { matches: 0, recordsRewritten: 0, recordsDropped: 0, foreignFramesDropped: 0,
      anchorsRepaired: 0, windowComplete: 0, windowIncomplete: 0, details: [] };
    const matches = this.db.prepare(`SELECT game_key, token_ids_json, finished_at_ms, finish_anchor,
      finish_conflict, finish_facts_json FROM matches ORDER BY finished_at_ms`).all() as
      Array<{ game_key: string; token_ids_json: string; finished_at_ms: number; finish_anchor: string | null;
        finish_conflict: number; finish_facts_json: string | null }>;
    const updateRecord = this.db.prepare("UPDATE tail_records SET payload_hash = ? WHERE game_key = ? AND run_id = ? AND sequence = ? AND frame_index = ?");
    const deleteRecord = this.db.prepare("DELETE FROM tail_records WHERE game_key = ? AND run_id = ? AND sequence = ? AND frame_index = ?");
    const upsertPayload = this.db.prepare("INSERT OR IGNORE INTO payloads(hash, payload) VALUES (?, ?)");
    const updateMatch = this.db.prepare(`UPDATE matches SET finished_at_ms = ?, window_start_ms = ?,
      window_complete = ?, missing_front_ms = ?, finish_facts_json = COALESCE(?, finish_facts_json),
      updated_at_ms = ? WHERE game_key = ?`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const match of matches) {
        report.matches++;
        const own = new Set<string>(JSON.parse(match.token_ids_json) as string[]);
        const rows = this.db.prepare(`SELECT r.run_id, r.sequence, r.frame_index, r.source, r.kind, r.received_at_ms, r.payload_hash, p.payload
          FROM tail_records r JOIN payloads p ON p.hash = r.payload_hash WHERE r.game_key = ?
          ORDER BY r.received_at_ms, r.sequence, r.frame_index`).all(match.game_key) as Array<{
            run_id: string; sequence: number; frame_index: number; source: JournalRecord["source"];
            kind: string; received_at_ms: number; payload_hash: string; payload: Uint8Array }>;
        let rewritten = 0, dropped = 0, foreign = 0;
        let lastActive: { atMs: number; runId: string; sequence: number; frameIndex: number } | null = null;
        for (const row of rows) {
          const decoded = decodePayload(row.payload);
          // Legacy rows stored the raw WebSocket text; unwrap it so the frames
          // are inspected individually instead of being treated as one opaque
          // string that can never look foreign.
          let data = decoded.data;
          if (typeof data === "string") { try { data = JSON.parse(data) as unknown; } catch { /* keep as-is */ } }
          if (recordMarksActiveBook(data, own)) {
            lastActive = { atMs: row.received_at_ms, runId: row.run_id, sequence: row.sequence, frameIndex: row.frame_index };
          }
          const frames = Array.isArray(data) ? data : [data];
          const kept: unknown[] = [];
          let sawForeign = false;
          for (const frame of frames) {
            const value = objectValue(frame);
            if (!value) { kept.push(frame); continue; }
            const tokens = new Set<string>();
            if (typeof value.asset_id === "string") tokens.add(value.asset_id);
            if (Array.isArray(value.price_changes)) for (const change of value.price_changes) {
              const token = objectValue(change)?.asset_id;
              if (typeof token === "string") tokens.add(token);
            }
            if (tokens.size === 0) { kept.push(frame); continue; }
            const anyForeign = [...tokens].some(token => !own.has(token));
            if (anyForeign) { sawForeign = true; foreign++; continue; }
            kept.push(frame);
          }
          if (!sawForeign) continue;
          if (kept.length === 0) { deleteRecord.run(match.game_key, row.run_id, row.sequence, row.frame_index); dropped++; continue; }
          const canonical = JSON.stringify({ source: decoded.source, kind: decoded.kind,
            connectionId: decoded.connectionId ?? null,
            data: JSON.stringify(kept.length === 1 ? kept[0] : kept), frameIndex: row.frame_index });
          const hash = payloadHash(canonical);
          upsertPayload.run(hash, payloadBlob(canonical));
          updateRecord.run(hash, match.game_key, row.run_id, row.sequence, row.frame_index);
          rewritten++;
        }
        // Old `book-quiet` rows were anchored on the terminal clearing frame.
        // Re-anchor them on the newest retained frame that still proves depth.
        const anchorRepaired = match.finish_anchor === "book-quiet" && match.finish_conflict !== 1 &&
          lastActive !== null && lastActive.atMs !== match.finished_at_ms;
        const finishedAtMs = anchorRepaired ? lastActive!.atMs : match.finished_at_ms;
        const floor = finishedAtMs - this.tailWindowMs;
        const depth = this.db.prepare(`SELECT COUNT(*) AS count FROM tail_records
          WHERE game_key = ? AND received_at_ms >= ? AND received_at_ms <= ?
            AND source = 'clob' AND kind IN ('ws_message', 'book_snapshot')`)
          .get(match.game_key, floor, finishedAtMs) as { count?: number } | undefined;
        const depthCount = depth?.count ?? 0;
        // Bound the seed anchor exactly as `seedStart` does. An anchor older
        // than one extra window cannot prove the book at the floor, because the
        // deltas that moved it in between were not retained either.
        const seed = this.db.prepare(`SELECT MAX(received_at_ms) AS at FROM tail_records
          WHERE game_key = ? AND kind = 'book_snapshot' AND received_at_ms <= ? AND received_at_ms >= ?`)
          .get(match.game_key, floor, floor - this.tailWindowMs) as { at?: number | null } | undefined;
        const anchorAtMs = typeof seed?.at === "number" ? seed.at : null;
        const inWindow = this.db.prepare(`SELECT MIN(received_at_ms) AS oldest FROM tail_records
          WHERE game_key = ? AND received_at_ms >= ? AND received_at_ms <= ?
            AND source = 'clob' AND kind IN ('ws_message', 'book_snapshot')`)
          .get(match.game_key, floor, finishedAtMs) as { oldest?: number | null } | undefined;
        const windowStartMs = typeof inWindow?.oldest === "number" ? inWindow.oldest : null;
        const coveredFromMs = anchorAtMs ?? windowStartMs;
        const missingFrontMs = coveredFromMs === null ? this.tailWindowMs : Math.max(0, coveredFromMs - floor);
        const toleranceMs = Math.min(1_000, Math.floor(this.tailWindowMs / 100));
        const complete = depthCount > 0 && missingFrontMs <= toleranceMs;
        let finishFactsJson: string | null = null;
        if (anchorRepaired && match.finish_facts_json) {
          const facts: unknown = JSON.parse(match.finish_facts_json);
          if (Array.isArray(facts)) {
            finishFactsJson = JSON.stringify(facts.map(fact => {
              const value = objectValue(fact);
              if (value?.source !== "book-quiet") return fact;
              return { ...value, atMs: finishedAtMs, observedAtMs: finishedAtMs,
                sourceRunId: lastActive!.runId, sequence: lastActive!.sequence, frameIndex: lastActive!.frameIndex };
            }));
          }
        }
        if (options.apply) updateMatch.run(finishedAtMs, windowStartMs, complete ? 1 : 0, missingFrontMs,
          finishFactsJson, this.now(), match.game_key);
        if (anchorRepaired) report.anchorsRepaired++;
        if (complete) report.windowComplete++; else report.windowIncomplete++;
        report.recordsRewritten += rewritten; report.recordsDropped += dropped; report.foreignFramesDropped += foreign;
        report.details.push({ gameKey: match.game_key, recordsRewritten: rewritten, recordsDropped: dropped,
          foreignFramesDropped: foreign, anchorRepaired, previousFinishedAtMs: match.finished_at_ms,
          finishedAtMs, windowComplete: complete, missingFrontMs });
      }
      if (options.apply) this.db.exec("COMMIT");
      else this.db.exec("ROLLBACK");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (options.apply) {
      this.db.exec("DELETE FROM payloads WHERE NOT EXISTS(SELECT 1 FROM staging_records s WHERE s.payload_hash=payloads.hash) AND NOT EXISTS(SELECT 1 FROM tail_records t WHERE t.payload_hash=payloads.hash)");
      this.db.exec("VACUUM");
    }
    return report;
  }

  /** Persisted window coverage for a finalized match, or undefined if unknown. */
  readMatchCoverage(gameKey: string): { windowStartMs: number | null; windowComplete: boolean; missingFrontMs: number;
    finishAnchor: string | null; finishedAtMs: number; title: string; finishConflict: boolean; finishFacts: TailFinishFact[] } | undefined {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    const row = this.db.prepare(`SELECT window_start_ms, window_complete, missing_front_ms, finish_anchor,
      finished_at_ms, title, finish_conflict, finish_facts_json FROM matches WHERE game_key = ?`)
      .get(gameKey) as { window_start_ms?: number | null; window_complete?: number; missing_front_ms?: number;
        finish_anchor?: string | null; finished_at_ms?: number; title?: string; finish_conflict?: number; finish_facts_json?: string | null } | undefined;
    if (!row) return undefined;
    let finishFacts: TailFinishFact[] = [];
    if (row.finish_facts_json) {
      const value: unknown = JSON.parse(row.finish_facts_json);
      if (!Array.isArray(value)) throw new Error("COMPACT_TAIL_FINISH_FACTS_INVALID");
      finishFacts = value as TailFinishFact[];
    }
    return { windowStartMs: typeof row.window_start_ms === "number" ? row.window_start_ms : null,
      windowComplete: row.window_complete === 1, missingFrontMs: row.missing_front_ms ?? 0,
      finishAnchor: row.finish_anchor ?? null, finishedAtMs: row.finished_at_ms ?? 0, title: row.title ?? "",
      finishConflict: row.finish_conflict === 1, finishFacts };
  }

  /** Trimmed Gamma event document stored with a finalized match, if any. */
  readMatchMetadata(gameKey: string): Record<string, unknown> | null {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    const row = this.db.prepare("SELECT metadata_json FROM matches WHERE game_key = ?").get(gameKey) as { metadata_json?: string | null } | undefined;
    if (!row?.metadata_json) return null;
    const value: unknown = JSON.parse(row.metadata_json);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  }

  /** Finalized matches newest-first, for export tooling. */
  listFinalizedMatches(): Array<{ gameKey: string; title: string; finishedAtMs: number; windowComplete: boolean;
    missingFrontMs: number; finishAnchor: string | null }> {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    const rows = this.db.prepare(`SELECT game_key, title, finished_at_ms, window_complete, missing_front_ms, finish_anchor
      FROM matches ORDER BY finished_at_ms DESC`).all() as Array<{ game_key: string; title: string; finished_at_ms: number;
        window_complete?: number; missing_front_ms?: number; finish_anchor?: string | null }>;
    return rows.map(row => ({ gameKey: row.game_key, title: row.title, finishedAtMs: row.finished_at_ms,
      windowComplete: row.window_complete === 1, missingFrontMs: row.missing_front_ms ?? 0, finishAnchor: row.finish_anchor ?? null }));
  }

  readFinalized(gameKey: string): CompactStoredRecord[] {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    this.flush();
    const rows = this.db.prepare(`SELECT r.game_key, r.run_id, r.sequence, r.frame_index, r.received_at_ms, r.source, r.kind, p.payload
      FROM tail_records r JOIN payloads p ON p.hash = r.payload_hash WHERE r.game_key = ?
      ORDER BY r.received_at_ms ASC, r.run_id ASC, r.sequence ASC, r.frame_index ASC`).all(gameKey) as unknown as SqlRow[];
    return rows.map(row => {
      const payload = decodePayload(row.payload);
      return { gameKey: row.game_key, runId: row.run_id, sequence: row.sequence, frameIndex: row.frame_index,
        receivedAtMs: row.received_at_ms, source: payload.source, kind: payload.kind, data: payload.data,
        ...(payload.connectionId === undefined ? {} : { connectionId: payload.connectionId }) };
    });
  }

  snapshot(): CompactTailStoreStatus {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    return {
      databasePath: this.databasePath,
      databaseBytes: this.databaseBytes(),
      stagingRecords: tableCount(this.db, "staging_records"),
      finalizedMatches: tableCount(this.db, "matches"),
      finalizedRecords: tableCount(this.db, "tail_records"),
      pendingRecords: this.pending.length,
      lastMaintenanceAtMs: this.lastMaintenanceAtMs,
      lastMaintenanceDeletedMatches: this.lastMaintenanceDeletedMatches,
      lastMaintenanceDeletedRecords: this.lastMaintenanceDeletedRecords,
      stagingProtectedGames: this.lastProtectedGames,
      retentionMs: this.retentionMs,
      maxBytes: this.maxBytes,
      pendingFinishMs: this.pendingFinishMs
    };
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.db.close();
    this.closed = true;
  }
}

export async function openCompactTailStore(options: CompactTailStoreOptions): Promise<CompactTailStore> {
  const dataRoot = resolve(options.dataRoot);
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await stat(dataRoot);
  return new CompactTailStore(join(dataRoot, DATABASE_NAME), {
    tailWindowMs: options.tailWindowMs, bufferMs: options.bufferMs, retentionMs: options.retentionMs,
    maxBytes: options.maxBytes, ...(options.pendingFinishMs === undefined ? {} : { pendingFinishMs: options.pendingFinishMs }),
    ...(options.redundantKeepAliveMs === undefined ? {} : { redundantKeepAliveMs: options.redundantKeepAliveMs }),
    ...(options.now === undefined ? {} : { now: options.now })
  });
}
