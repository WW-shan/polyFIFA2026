import { randomUUID } from "node:crypto";
import { metadataFromRecord, observationsFromRecord, windowKeyForIdentity } from "./tail-context.js";
import { objectValue } from "./replay-values.js";
import type { JournalRecord } from "./types.js";
import type { TailFinishFact } from "./tail-types.js";

export interface ArchiveState {
  status: "running" | "complete" | "failed"; runId: string; attempt: number;
  snapshotDirectory?: string; outputDirectory?: string; error?: string; retryAtMs?: number;
  priceReadyTokens?: number; strictReadyTokens?: number;
  refreshSnapshot?: boolean;
  finishFactsFile?: string;
  finishRevision?: number;
}
export interface CapturedGame {
  key: string; title: string; sport: string | null; gameId: string | null;
  eventIds: string[]; eventSlugs: string[]; tokenIds: string[]; marketIds: string[];
  firstSeenAtMs: number; lastSeenAtMs: number; firstBookAtMs: number | null; lastBookAtMs: number | null;
  lastBookRunId: string | null; bookUpdates: number; trades: number; stateObservations: number;
  finishedAtMs: number | null; finishConflict: boolean; retiredEventIds: string[];
  phase: "watching" | "postmatch" | "needs_finish" | "missed" | "archiving" | "archived" | "interrupted" | "archive_failed";
  sources: Array<{ runId: string; runDirectory: string }>;
  sourceFirstSequences?: Record<string, number>;
  finishRunId?: string;
  finishRevision?: number;
  finishFacts?: TailFinishFact[];
  archive?: ArchiveState;
}
export interface CaptureConnection { id: string; source: string; open: boolean; lastMessageAtMs: number | null }
export interface ContinuousStatus {
  schemaVersion: 1; instanceId: string; pid: number; startedAtMs: number; updatedAtMs: number;
  dataRoot: string; port: number; mode: "starting" | "collecting" | "restarting" | "paused_disk" | "stopping" | "stopped";
  runId: string | null; runDirectory: string | null; receivedRecords: number; lastRecordAtMs: number | null;
  freeBytes: number | null; rawBytes: number; queuedBytes: number; desiredTokens: number;
  games: CapturedGame[]; connections: CaptureConnection[];
  errors: Array<{ atMs: number; scope: string; message: string }>;
}

export class ContinuousState {
  private readonly games = new Map<string, CapturedGame>();
  private readonly tokens = new Map<string, string>();
  private readonly events = new Map<string, string>();
  private readonly connections = new Map<string, CaptureConnection>();
  private readonly errors: ContinuousStatus["errors"] = [];
  private readonly instanceId = randomUUID();
  private readonly startedAtMs = Date.now();
  private receivedRecords = 0;
  private lastRecordAtMs: number | null = null;
  private runId: string | null = null;
  private runDirectory: string | null = null;
  mode: ContinuousStatus["mode"] = "starting";
  freeBytes: number | null = null;
  rawBytes = 0;
  queuedBytes = 0;
  desiredTokens = 0;

  constructor(readonly dataRoot: string, readonly port: number) {}
  setRun(runId: string, runDirectory: string): void {
    this.runId = runId; this.runDirectory = runDirectory; this.rawBytes = 0; this.connections.clear();
  }
  issue(scope: string, error: unknown, atMs = Date.now()): void {
    this.errors.push({ scope, atMs, message: (error instanceof Error ? error.message : String(error)).slice(0, 2000) });
    if (this.errors.length > 50) this.errors.shift();
  }
  private source(game: CapturedGame, record: JournalRecord): void {
    if (this.runDirectory && this.runId === record.runId && !game.sources.some(source => source.runId === record.runId)) game.sources.push({ runId: record.runId, runDirectory: this.runDirectory });
    game.sourceFirstSequences ??= {};
    if (!Object.hasOwn(game.sourceFirstSequences, record.runId)) Object.defineProperty(game.sourceFirstSequences, record.runId, { value: record.sequence, enumerable: true, configurable: true, writable: true });
  }
  private finish(game: CapturedGame, value: number | null, record: JournalRecord,
    origin?: Pick<TailFinishFact, "source" | "eventId" | "eventSlug" | "gameId" | "frameIndex">): void {
    if (value === null) return;
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
    game.finishedAtMs ??= value;
  }
  observe(record: JournalRecord): void {
    this.receivedRecords++; this.lastRecordAtMs = record.receivedAtMs;
    try { this.observeUnsafe(record); } catch (error) { this.issue("observation", error, record.receivedAtMs); }
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
    if (record.kind.endsWith("error")) this.issue(record.kind, JSON.stringify(record.data), record.receivedAtMs);
    const meta = metadataFromRecord(record);
    if (meta) {
      const key = meta.gameId === null ? `event:${meta.eventId}` : `game:${meta.gameId}`;
      const previousKey = this.events.get(meta.eventId);
      if (previousKey && previousKey !== key) throw new Error(`capture identity changed for ${meta.eventId}`);
      const game: CapturedGame = this.games.get(key) ?? { key, title: meta.title, sport: meta.sport, gameId: meta.gameId,
        eventIds: [], eventSlugs: [], tokenIds: [], marketIds: [], firstSeenAtMs: record.receivedAtMs, lastSeenAtMs: record.receivedAtMs,
        firstBookAtMs: null, lastBookAtMs: null, lastBookRunId: null, bookUpdates: 0, trades: 0, stateObservations: 0,
        finishedAtMs: null, finishConflict: false, retiredEventIds: [], phase: "watching", sources: [] };
      this.events.set(meta.eventId, key);
      if (!game.eventIds.includes(meta.eventId)) game.eventIds.push(meta.eventId);
      if (!game.eventSlugs.includes(meta.eventSlug)) game.eventSlugs.push(meta.eventSlug);
      game.lastSeenAtMs = record.receivedAtMs;
      if (game.phase === "interrupted" && game.archive?.status !== "running") game.phase = "watching";
      this.source(game, record);
      this.finish(game, meta.finishAtMs, record, meta.finishSource ? { source: meta.finishSource, eventId: meta.eventId,
        eventSlug: meta.eventSlug, gameId: meta.gameId, frameIndex: 0 } : undefined);
      for (const market of meta.markets) {
        const existing = this.tokens.get(market.tokenId);
        if (existing && existing !== key) throw new Error(`capture token identity changed for ${market.tokenId}`);
        this.tokens.set(market.tokenId, key);
        if (!game.tokenIds.includes(market.tokenId)) game.tokenIds.push(market.tokenId);
        if (!game.marketIds.includes(market.marketId)) game.marketIds.push(market.marketId);
      }
      this.games.set(key, game);
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
    if (record.source !== "clob" || record.kind !== "ws_message" || typeof record.data !== "string") return;
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
          if (frame.event_type === "book") game.firstBookAtMs ??= record.receivedAtMs;
        } else if (frame.event_type === "last_trade_price") game.trades++;
      }
    }
  }
  readyToArchive(runId: string, nowMs = Date.now()): CapturedGame[] {
    return [...this.games.values()].filter(game => game.firstBookAtMs !== null && game.finishedAtMs !== null &&
      (game.lastBookRunId === runId || !!game.archive?.snapshotDirectory || game.sources.some(source => source.runId === game.lastBookRunId)) && game.eventIds.every(id => game.retiredEventIds.includes(id)) &&
      (!game.archive || (game.archive.status === "failed" && (game.archive.retryAtMs ?? 0) <= nowMs)));
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
  snapshot(): ContinuousStatus {
    return JSON.parse(JSON.stringify({ schemaVersion: 1, instanceId: this.instanceId, pid: process.pid, startedAtMs: this.startedAtMs,
      updatedAtMs: Date.now(), dataRoot: this.dataRoot, port: this.port, mode: this.mode, runId: this.runId, runDirectory: this.runDirectory,
      receivedRecords: this.receivedRecords, lastRecordAtMs: this.lastRecordAtMs, freeBytes: this.freeBytes, rawBytes: this.rawBytes,
      queuedBytes: this.queuedBytes, desiredTokens: this.desiredTokens, games: [...this.games.values()], connections: [...this.connections.values()], errors: this.errors })) as ContinuousStatus;
  }
  restore(saved: ContinuousStatus): void {
    if (saved.schemaVersion !== 1 || !Array.isArray(saved.games)) throw new Error("CAPTURE_STATE_INVALID");
    for (const value of saved.games) {
      const game = structuredClone(value);
      if (!game || typeof game.key !== "string" || !Array.isArray(game.tokenIds) || !Array.isArray(game.eventIds)) throw new Error("CAPTURE_STATE_INVALID");
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
