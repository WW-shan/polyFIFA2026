import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { statSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import type { CapturedGame } from "./continuous-state.js";
import type { JournalRecord } from "./types.js";

const DATABASE_NAME = "tail.sqlite";
const SCHEMA_VERSION = 1;

export interface CompactTailStoreOptions {
  dataRoot: string;
  tailWindowMs: number;
  bufferMs: number;
  retentionMs: number;
  maxBytes: number;
  now?: () => number;
}

export interface CompactStoredRecord {
  gameKey: string;
  runId: string;
  sequence: number;
  receivedAtMs: number;
  source: JournalRecord["source"];
  kind: string;
  data: unknown;
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
}

interface PendingRecord {
  gameKey: string;
  record: JournalRecord;
  hash: string;
  payload: Buffer;
}

interface SqlRow {
  game_key: string;
  run_id: string;
  sequence: number;
  received_at_ms: number;
  source: JournalRecord["source"];
  kind: string;
  payload: Uint8Array;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
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
  return {
    source: sourceFrom(record.source), kind: record.kind,
    ...(typeof record.connectionId === "string" ? { connectionId: record.connectionId } : {}), data: record.data
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
  private readonly now: () => number;
  private readonly pending: PendingRecord[] = [];
  private readonly lastHashByGame = new Map<string, string>();
  private lastMaintenanceAtMs: number | null = null;
  private lastMaintenanceDeletedMatches = 0;
  private lastMaintenanceDeletedRecords = 0;
  private closed = false;

  constructor(databasePath: string, options: Omit<CompactTailStoreOptions, "dataRoot">) {
    this.databasePath = resolve(databasePath);
    this.tailWindowMs = positiveInteger(options.tailWindowMs, "tailWindowMs");
    this.bufferMs = positiveInteger(options.bufferMs, "bufferMs");
    this.retentionMs = positiveInteger(options.retentionMs, "retentionMs");
    this.maxBytes = positiveInteger(options.maxBytes, "maxBytes");
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(this.databasePath, { timeout: 5_000, defensive: true });
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = NORMAL;
      PRAGMA auto_vacuum = INCREMENTAL;
      CREATE TABLE IF NOT EXISTS compact_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      INSERT OR IGNORE INTO compact_meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}');
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
        updated_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS staging_records (
        game_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        received_at_ms INTEGER NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        PRIMARY KEY(game_key, run_id, sequence)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS staging_time_idx ON staging_records(received_at_ms);
      CREATE TABLE IF NOT EXISTS tail_records (
        game_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        received_at_ms INTEGER NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        PRIMARY KEY(game_key, run_id, sequence)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS tail_time_idx ON tail_records(received_at_ms);
    `);
  }

  ingest(record: JournalRecord, gameKeys: readonly string[]): void {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    if (!this.isCaptureRecord(record)) return;
    const payload = serializedPayload(record);
    const hash = payloadHash(payload);
    const compressed = payloadBlob(payload);
    for (const gameKey of new Set(gameKeys)) {
      if (this.lastHashByGame.get(gameKey) === hash) continue;
      this.lastHashByGame.set(gameKey, hash);
      this.pending.push({ gameKey, record, hash, payload: compressed });
    }
    if (this.pending.length >= 256) this.flush();
  }

  private isCaptureRecord(record: JournalRecord): boolean {
    return (record.source === "sports" || record.source === "clob") &&
      (record.kind === "ws_message" || record.kind === "book_snapshot" || record.kind === "book_snapshot_batch");
  }

  flush(): void {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    if (this.pending.length === 0) return;
    const insertPayload = this.db.prepare("INSERT OR IGNORE INTO payloads(hash, payload) VALUES (?, ?)");
    const insertRecord = this.db.prepare(`INSERT OR IGNORE INTO staging_records
      (game_key, run_id, sequence, received_at_ms, source, kind, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of this.pending) {
        insertPayload.run(item.hash, item.payload);
        insertRecord.run(item.gameKey, item.record.runId, item.record.sequence, item.record.receivedAtMs,
          item.record.source, item.record.kind, item.hash);
      }
      this.db.exec("COMMIT");
      this.pending.length = 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finalize(game: CapturedGame, finishAtMs: number): void {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    if (!Number.isSafeInteger(finishAtMs) || finishAtMs < 0) throw new RangeError("finishAtMs must be a nonnegative safe integer");
    this.flush();
    const start = finishAtMs - this.tailWindowMs;
    const upsertMatch = this.db.prepare(`INSERT INTO matches
      (game_key, title, sport, game_id, event_ids_json, event_slugs_json, token_ids_json, market_ids_json, finished_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_key) DO UPDATE SET title=excluded.title, sport=excluded.sport, game_id=excluded.game_id,
        event_ids_json=excluded.event_ids_json, event_slugs_json=excluded.event_slugs_json, token_ids_json=excluded.token_ids_json,
        market_ids_json=excluded.market_ids_json, finished_at_ms=excluded.finished_at_ms, updated_at_ms=excluded.updated_at_ms`);
    const copy = this.db.prepare(`INSERT OR IGNORE INTO tail_records
      (game_key, run_id, sequence, received_at_ms, source, kind, payload_hash)
      SELECT game_key, run_id, sequence, received_at_ms, source, kind, payload_hash
      FROM staging_records WHERE game_key = ? AND received_at_ms >= ? AND received_at_ms <= ?`);
    const remove = this.db.prepare("DELETE FROM staging_records WHERE game_key = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      upsertMatch.run(game.key, game.title, game.sport, game.gameId, JSON.stringify(game.eventIds), JSON.stringify(game.eventSlugs),
        JSON.stringify(game.tokenIds), JSON.stringify(game.marketIds), finishAtMs, this.now());
      copy.run(game.key, start, finishAtMs);
      remove.run(game.key);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.lastHashByGame.delete(game.key);
    this.cleanupOrphanPayloads();
  }

  maintain(nowMs = this.now()): void {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    this.flush();
    const stagingCutoff = nowMs - this.tailWindowMs - this.bufferMs;
    const retentionCutoff = nowMs - this.retentionMs;
    let deletedMatches = 0;
    let deletedRecords = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM staging_records WHERE received_at_ms < ?").run(stagingCutoff);
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
    this.cleanupOrphanPayloads();
    this.db.exec("PRAGMA incremental_vacuum(2000)");
    this.lastMaintenanceAtMs = nowMs;
    this.lastMaintenanceDeletedMatches = deletedMatches;
    this.lastMaintenanceDeletedRecords = deletedRecords;
  }

  private pruneToCap(): void {
    const target = Math.floor(this.maxBytes * 0.8);
    const games = this.db.prepare("SELECT game_key FROM matches ORDER BY finished_at_ms ASC").all() as Array<{ game_key: string }>;
    const deleteRecords = this.db.prepare("DELETE FROM tail_records WHERE game_key = ?");
    const deleteMatch = this.db.prepare("DELETE FROM matches WHERE game_key = ?");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const game of games) {
        if (this.databaseBytes() <= target) break;
        deleteRecords.run(game.game_key);
        deleteMatch.run(game.game_key);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private cleanupOrphanPayloads(): void {
    this.db.exec(`DELETE FROM payloads WHERE NOT EXISTS (SELECT 1 FROM staging_records WHERE staging_records.payload_hash = payloads.hash)
      AND NOT EXISTS (SELECT 1 FROM tail_records WHERE tail_records.payload_hash = payloads.hash)`);
  }

  private databaseBytes(): number {
    try { return statSync(this.databasePath).size; } catch { return 0; }
  }

  readFinalized(gameKey: string): CompactStoredRecord[] {
    if (this.closed) throw new Error("COMPACT_TAIL_STORE_CLOSED");
    this.flush();
    const rows = this.db.prepare(`SELECT r.game_key, r.run_id, r.sequence, r.received_at_ms, r.source, r.kind, p.payload
      FROM tail_records r JOIN payloads p ON p.hash = r.payload_hash WHERE r.game_key = ?
      ORDER BY r.received_at_ms ASC, r.sequence ASC`).all(gameKey) as unknown as SqlRow[];
    return rows.map(row => {
      const payload = decodePayload(row.payload);
      return { gameKey: row.game_key, runId: row.run_id, sequence: row.sequence, receivedAtMs: row.received_at_ms,
        source: payload.source, kind: payload.kind, data: payload.data };
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
      lastMaintenanceDeletedRecords: this.lastMaintenanceDeletedRecords
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
    maxBytes: options.maxBytes, ...(options.now === undefined ? {} : { now: options.now })
  });
}
