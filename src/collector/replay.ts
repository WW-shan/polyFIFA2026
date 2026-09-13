import { assertJournalRecord, scanJournal } from "./journal-reader.js";
import { arrayValue, assetId, decimal, frameType, heartbeat, identifier, level, levelMap, objectValue, parsedJson, sortedLevels, textValue, timestamp } from "./replay-values.js";
import { emptyReplayQuality, type JournalReadResult, type ReplayBatch, type ReplayJournalRecord, type ReplayLevel, type ReplayMarketMapping, type ReplayOptions, type ReplayQuoteRow, type ReplayResult, type ReplaySportsRow, type ReplayTradeRow } from "./replay-types.js";
export type * from "./replay-types.js";

interface PendingBookConsistency {
  hash: string | undefined;
  timestamp: bigint | undefined;
  advertised: Record<string, unknown>[];
  reason: string;
  recoverable: boolean;
}
interface BookState {
  connectionId: string;
  tokenId: string;
  bids: Map<string, ReplayLevel>;
  asks: Map<string, ReplayLevel>;
  valid: boolean;
  timestamp?: bigint;
  bookHash?: string;
  pending?: PendingBookConsistency;
}
interface SportsState {
  row: ReplaySportsRow;
  monotonicNs: bigint;
  identities: Map<string, string>;
}
// Standalone best prices can precede their depth delta and do not identify the same book state.
const knownNonDepthEvents = new Set(["tick_size_change", "best_bid_ask", "new_market"]);

function bestPrice(levels: Map<string, ReplayLevel>, descending: boolean): string | undefined {
  let best: string | undefined;
  // Canonical decimal keys in [0, 1] sort lexically without losing price precision.
  for (const price of levels.keys()) {
    if (best === undefined || (descending ? price > best : price < best)) best = price;
  }
  return best;
}
function bookIssue(bids: Map<string, ReplayLevel>, asks: Map<string, ReplayLevel>, advertised: readonly Record<string, unknown>[]): string | undefined {
  const bid = bestPrice(bids, true);
  const ask = bestPrice(asks, false);
  if (bid !== undefined && ask !== undefined && bid >= ask) return "crossed_book";
  for (const frame of advertised) {
    for (const [field, actual] of [["best_bid", bid], ["best_ask", ask]] as const) {
      if (frame[field] === undefined) continue;
      const expected = decimal(frame[field], true);
      if (!expected) return `malformed_${field}`;
      // The WS docs show best_ask=1 but do not define empty-side sentinels.
      // Preserve confirmed empty depth without interpreting its advertised boundary price.
      if (actual === undefined) continue;
      if (expected.key !== actual) return `${field}_mismatch`;
    }
  }
  return undefined;
}

function identities(value: Record<string, unknown>): Map<string, string> {
  const keys = new Map<string, string>();
  for (const [key, aliases] of [
    ["event", ["eventSlug", "slug"]],
    ["game", ["gameId", "game_id"]],
    ["sportradar", ["sportradarGameId", "sportradar_game_id"]]
  ] as const) {
    for (const alias of aliases) {
      const id = identifier(value[alias]);
      if (id !== undefined) { keys.set(key, id); break; }
    }
  }
  return keys;
}
function mappingIdentities(mapping: ReplayMarketMapping): Map<string, string> {
  return identities({ eventSlug: mapping.eventSlug, gameId: mapping.gameId, sportradarGameId: mapping.sportradarGameId });
}
function copyField(target: Record<string, unknown>, key: string, value: unknown): void {
  const id = identifier(value);
  if (id !== undefined) target[key] = id;
}
function metadataMappings(data: unknown): ReplayMarketMapping[] {
  const wrapper = objectValue(data);
  const event = objectValue(wrapper?.normalized) ?? objectValue(wrapper?.event) ?? wrapper;
  if (!event) return [];
  const rawEvent = objectValue(event.raw) ?? event;
  const results: ReplayMarketMapping[] = [];
  for (const item of arrayValue(event.markets)) {
    const market = objectValue(item);
    if (!market) continue;
    const raw = objectValue(market.raw) ?? market;
    const tokens = arrayValue(market.tokenIds ?? market.clobTokenIds).map(identifier);
    const outcomes = arrayValue(market.outcomes).map(textValue);
    if (tokens.length === 0 || tokens.length !== outcomes.length || tokens.some(token => token === undefined)) continue;
    for (let index = 0; index < tokens.length; index += 1) {
      const mapping: Record<string, unknown> = { tokenId: tokens[index]!, data: raw };
      copyField(mapping, "eventId", event.eventId ?? event.id);
      copyField(mapping, "eventSlug", event.eventSlug ?? event.slug);
      copyField(mapping, "gameId", raw.gameId ?? event.gameId ?? rawEvent.gameId ?? objectValue(rawEvent.eventMetadata)?.gameId);
      copyField(mapping, "sportradarGameId", rawEvent.sportradarGameId ?? objectValue(rawEvent.eventMetadata)?.sportradarGameId);
      copyField(mapping, "marketId", market.marketId ?? market.id);
      copyField(mapping, "marketSlug", market.marketSlug ?? market.slug);
      copyField(mapping, "conditionId", market.conditionId);
      copyField(mapping, "question", market.question);
      copyField(mapping, "outcome", outcomes[index]);
      results.push(mapping as unknown as ReplayMarketMapping);
    }
  }
  return results;
}

/** Mutable current state only; each batch belongs to one received frame and can be written immediately. */
export class JournalReplay {
  readonly quality = emptyReplayQuality();
  private readonly consistency = this.quality.bookConsistency!;
  private readonly books = new Map<string, Map<string, BookState>>();
  private readonly connections = new Map<string, boolean>();
  private readonly subscriptions = new Map<string, Set<string>>();
  private readonly mappings = new Map<string, ReplayMarketMapping>();
  private readonly sportsByKey = new Map<string, SportsState>();
  private previousSequence = 0;
  private previousMonotonic = 0n;
  private runId: string | undefined;
  private readonly staleAfterMs: number;
  private readonly onInvalidation: ReplayOptions["onInvalidation"];

  constructor(options: ReplayOptions = {}) {
    this.staleAfterMs = options.sportsStaleAfterMs ?? 60_000;
    this.onInvalidation = options.onInvalidation;
    if (!Number.isFinite(this.staleAfterMs) || this.staleAfterMs < 0) throw new Error("REPLAY_OPTIONS_INVALID: sportsStaleAfterMs");
  }
  get markets(): ReplayMarketMapping[] { return [...this.mappings.values()]; }

  /** Read-only status: absent depth is missing; disallowed or invalidated depth is invalid. */
  getBookStatus(connectionId: string, tokenId: string): "valid" | "invalid" | "missing" {
    if (!this.allowed(connectionId, tokenId)) return "invalid";
    const state = this.books.get(connectionId)?.get(tokenId);
    return state ? state.valid ? "valid" : "invalid" : "missing";
  }

  invalidate(connectionId?: string, reason = connectionId === undefined ? "journal_damage" : "connection_reset"): void {
    let changed = false;
    for (const [connection, states] of this.books) {
      if (connectionId !== undefined && connectionId !== connection) continue;
      for (const state of states.values()) {
        if (state.valid) changed = true;
        state.valid = false;
        delete state.pending;
      }
    }
    if (changed) this.quality.connectionInvalidations += 1;
    if (connectionId === undefined) this.sportsByKey.clear();
    this.onInvalidation?.({ ...(connectionId !== undefined ? { connectionId } : {}), reason });
  }

  private invalidateToken(connection: string, token: string | undefined, reason: string, pending?: PendingBookConsistency): void {
    if (!token) { this.invalidate(connection, reason); return; }
    const state = this.books.get(connection)?.get(token);
    if (state?.valid) this.quality.connectionInvalidations += 1;
    if (state) {
      state.valid = false;
      if (pending) state.pending = pending;
      else delete state.pending;
    }
    this.onInvalidation?.({ connectionId: connection, tokenId: token, reason, ...(pending?.recoverable ? { provisional: true } : {}) });
  }

  accept(record: ReplayJournalRecord): ReplayBatch {
    const combined: ReplayBatch = { quotes: [], trades: [], sports: [] };
    for (const batch of this.replay(record)) {
      combined.quotes.push(...batch.quotes);
      combined.trades.push(...batch.trades);
      combined.sports.push(...batch.sports);
    }
    return combined;
  }

  /** Consume each array element before reconstructing the next full-depth output. */
  *replay(record: ReplayJournalRecord): Generator<ReplayBatch> {
    try { assertJournalRecord(record); }
    catch (error) { this.invalidate(undefined, "journal_envelope_invalid"); throw error; }
    if (this.runId !== undefined && this.runId !== record.runId) {
      this.invalidate(undefined, "journal_run_invalid");
      throw new Error("REPLAY_RUN_MISMATCH");
    }
    this.runId = record.runId;
    if (record.sequence <= this.previousSequence) {
      this.invalidate(undefined, "journal_sequence_invalid");
      throw new Error("REPLAY_SEQUENCE_ORDER");
    }
    const monotonic = BigInt(record.monotonicNs);
    if (monotonic < this.previousMonotonic) {
      this.invalidate(undefined, "journal_monotonic_invalid");
      throw new Error("REPLAY_MONOTONIC_ORDER");
    }
    if (record.sequence !== this.previousSequence + 1) {
      this.quality.sequenceGaps.push({ expected: this.previousSequence + 1, actual: record.sequence });
      this.invalidate(undefined, "sequence_gap");
    }
    this.previousSequence = record.sequence;
    this.previousMonotonic = monotonic;
    if (record.source === "gamma" && record.kind === "event_metadata") {
      for (const mapping of metadataMappings(record.data)) this.mappings.set(mapping.tokenId, mapping);
    } else if (record.source === "collector") {
      this.collectorRecord(record);
    } else if (record.kind === "ws_message" && record.source === "sports") {
      yield* this.sportsRecord(record);
    } else if (record.kind === "ws_message" && record.source === "clob") {
      yield* this.clobRecord(record);
    }
  }

  private collectorRecord(record: ReplayJournalRecord): void {
    const connection = record.connectionId;
    if (!connection) return;
    if (record.kind === "connection_open") {
      this.connections.set(connection, true);
      this.invalidate(connection, record.kind);
      this.books.delete(connection);
    } else if (["connection_close", "connection_timeout", "heartbeat_timeout", "connection_gap"].includes(record.kind)) {
      this.connections.set(connection, false);
      this.invalidate(connection, record.kind);
      this.books.delete(connection);
      this.subscriptions.delete(connection);
    } else if (record.kind === "subscription") {
      const data = objectValue(record.data);
      const ids = arrayValue(data?.assets_ids).map(identifier).filter((value): value is string => value !== undefined);
      const tokens = this.subscriptions.get(connection) ?? new Set<string>();
      this.subscriptions.set(connection, tokens);
      if (data?.type === "market") {
        this.invalidate(connection, "subscription_reset");
        tokens.clear();
      }
      for (const id of ids) {
        if (data?.operation === "unsubscribe") tokens.delete(id);
        else tokens.add(id);
        if (data?.type !== "market") this.invalidateToken(connection, id, data?.operation === "unsubscribe" ? "unsubscribe" : "subscription_reset");
        this.books.get(connection)?.delete(id);
      }
    }
  }

  private *sportsRecord(record: ReplayJournalRecord): Generator<ReplayBatch> {
    const parsed = parsedJson(record.data);
    const frames = Array.isArray(parsed) ? parsed : [parsed ?? record.data];
    for (const [index, data] of frames.entries()) {
      const raw = objectValue(data);
      const keys = raw ? identities(raw) : new Map<string, string>();
      const row: ReplaySportsRow = {
        sequence: record.sequence, receivedAt: record.receivedAt, receivedAtMs: record.receivedAtMs,
        frameIndex: index, data, keys: [...keys].map(([key, id]) => key + ":" + id),
        ...(record.connectionId ? { connectionId: record.connectionId } : {})
      };
      yield { quotes: [], trades: [], sports: [row] };
      const hasScoreOrClock = raw && ["score", "homeScore", "awayScore", "elapsed", "clock", "gameTimeDisplay", "period"].some(key => raw[key] !== undefined);
      if (heartbeat(data) || !hasScoreOrClock || this.connections.get(record.connectionId ?? "") === false) continue;
      const state: SportsState = { row, monotonicNs: BigInt(record.monotonicNs), identities: keys };
      for (const [key, id] of keys) this.sportsByKey.set(key + ":" + id, state);
    }
  }

  private matchingSports(mapping: ReplayMarketMapping | undefined): SportsState | undefined {
    if (!mapping) return undefined;
    const expected = mappingIdentities(mapping);
    let latest: SportsState | undefined;
    for (const [key, id] of expected) {
      const state = this.sportsByKey.get(key + ":" + id);
      if (!state) continue;
      // A shared authoritative ID can join companion slugs, but every shared strong ID must agree.
      if (["game", "sportradar"].some(field => expected.has(field) && state.identities.has(field) && state.identities.get(field) !== expected.get(field))) continue;
      if (!latest || state.row.sequence > latest.row.sequence || (state.row.sequence === latest.row.sequence && (state.row.frameIndex ?? 0) > (latest.row.frameIndex ?? 0))) latest = state;
    }
    return latest;
  }

  private quote(record: ReplayJournalRecord, state: BookState, frameIndex: number, updateKind: "snapshot" | "delta", observedTimestamp?: bigint): ReplayQuoteRow {
    const mapping = this.mappings.get(state.tokenId);
    const sports = this.matchingSports(mapping);
    const row: ReplayQuoteRow = {
      sequence: record.sequence, receivedAt: record.receivedAt, receivedAtMs: record.receivedAtMs,
      connectionId: state.connectionId, frameIndex, tokenId: state.tokenId,
      bids: sortedLevels(state.bids, true), asks: sortedLevels(state.asks, false),
      updateKind,
      sportsStatus: "missing", sportsClockStatus: "missing"
    };
    if (state.bookHash !== undefined) row.bookHash = state.bookHash;
    if (mapping) for (const key of ["eventId", "eventSlug", "gameId", "marketId", "marketSlug", "outcome"] as const) {
      if (mapping[key] !== undefined) row[key] = mapping[key];
    }
    if (observedTimestamp !== undefined) row.serverTimestamp = String(observedTimestamp);
    if (sports) {
      row.sportsSequence = sports.row.sequence;
      row.sportsFrameIndex = sports.row.frameIndex ?? 0;
      row.sportsReceivedAt = sports.row.receivedAt;
      row.sportsAgeMs = Number(BigInt(record.monotonicNs) - sports.monotonicNs) / 1_000_000;
      row.sportsStatus = this.connections.get(sports.row.connectionId ?? "") === false ? "disconnected"
        : row.sportsAgeMs > this.staleAfterMs ? "stale" : "matched";
      const data = objectValue(sports.row.data);
      if (data?.score !== undefined) row.sportsScore = data.score;
      if (data?.period !== undefined) row.sportsPeriod = data.period;
      const clock = data?.elapsed ?? data?.clock ?? data?.gameTimeDisplay;
      if (clock !== undefined && clock !== null && clock !== "") { row.sportsClock = clock; row.sportsClockStatus = "present"; }
    }
    return row;
  }

  private *clobRecord(record: ReplayJournalRecord): Generator<ReplayBatch> {
    const connection = record.connectionId;
    if (!connection) { this.quality.invalidBookUpdates += 1; this.invalidate(undefined, "missing_connection"); return; }
    if (heartbeat(record.data)) return;
    const parsed = parsedJson(record.data);
    if (heartbeat(parsed)) return;
    const rawFrames = Array.isArray(parsed) ? parsed : [parsed];
    for (const [index, item] of rawFrames.entries()) {
      if (heartbeat(item)) continue;
      const batch: ReplayBatch = { quotes: [], trades: [], sports: [] };
      const frame = objectValue(item);
      if (!frame) {
        this.quality.unknownFrames += 1;
        this.invalidate(connection, "malformed_frame");
        continue;
      }
      const type = frameType(frame);
      if (heartbeat(frame) || knownNonDepthEvents.has(type)) continue;
      if (type === "book" || (!type && frame.bids !== undefined && frame.asks !== undefined)) {
        this.bookFrame(record, frame, batch, index);
      } else if (type === "price_change") {
        this.changeFrame(record, frame, batch, index);
      } else if (type === "market_resolved") {
        this.marketResolved(connection, frame);
      } else if (["last_trade_price", "trade", "public_trade"].includes(type)) {
        const price = decimal(frame.price, true);
        const size = decimal(frame.size ?? frame.amount);
        const tokenId = assetId(frame);
        if (!tokenId || !price || !size) { this.quality.unknownFrames += 1; continue; }
        const trade: ReplayTradeRow = {
          sequence: record.sequence, receivedAt: record.receivedAt, receivedAtMs: record.receivedAtMs,
          connectionId: connection, frameIndex: index, tokenId, price: price.raw, size: size.raw, data: frame
        };
        if (textValue(frame.side)) trade.side = textValue(frame.side)!;
        batch.trades.push(trade);
      } else {
        this.quality.unknownFrames += 1;
        this.invalidateToken(connection, assetId(frame), "unknown_frame");
      }
      if (batch.quotes.length || batch.trades.length) yield batch;
    }
  }

  private allowed(connection: string, token: string): boolean {
    return this.connections.get(connection) !== false && (!this.subscriptions.has(connection) || this.subscriptions.get(connection)!.has(token));
  }

  private marketResolved(connection: string, frame: Record<string, unknown>): void {
    const tokens = new Set(arrayValue(frame.assets_ids).map(identifier).filter((token): token is string => token !== undefined));
    const token = assetId(frame);
    if (token !== undefined) tokens.add(token);
    const condition = identifier(frame.conditionId ?? frame.condition_id ?? frame.market);
    if (condition !== undefined) for (const mapping of this.mappings.values()) {
      if (mapping.conditionId === condition) tokens.add(mapping.tokenId);
    }
    // A missing identity cannot justify closing every market on this connection.
    if (tokens.size === 0) { this.quality.unknownFrames += 1; return; }
    for (const tokenId of tokens) this.invalidateToken(connection, tokenId, "market_resolved");
  }

  private bookFrame(record: ReplayJournalRecord, frame: Record<string, unknown>, batch: ReplayBatch, index: number): void {
    const connection = record.connectionId!;
    const token = assetId(frame);
    const bids = levelMap(frame.bids);
    const asks = levelMap(frame.asks);
    const sourceTime = timestamp(frame.timestamp);
    const previous = token ? this.books.get(connection)?.get(token) : undefined;
    // A rejected mutation still establishes source ordering for any later recovery.
    if (previous && sourceTime !== undefined && (previous.timestamp === undefined || sourceTime > previous.timestamp)) previous.timestamp = sourceTime;
    if (!token || !bids || !asks || (frame.timestamp !== undefined && sourceTime === undefined)) {
      this.quality.invalidBookUpdates += 1; this.invalidateToken(connection, token, "malformed_snapshot"); return;
    }
    if (!this.allowed(connection, token)) {
      this.quality.invalidBookUpdates += 1; this.invalidateToken(connection, token, "book_not_allowed"); return;
    }
    const states = this.books.get(connection) ?? new Map<string, BookState>();
    if (previous?.timestamp !== undefined && sourceTime !== undefined && sourceTime < previous.timestamp) {
      this.quality.outOfOrderMessages += 1; this.invalidateToken(connection, token, "out_of_order_snapshot"); return;
    }
    const issue = bookIssue(bids, asks, [frame]);
    if (issue) {
      this.quality.invalidBookUpdates += 1; this.invalidateToken(connection, token, issue); return;
    }
    if (previous?.pending) this.consistency.recoveredBySnapshot += 1;
    const state: BookState = { connectionId: connection, tokenId: token, bids, asks, valid: true };
    const watermark = sourceTime ?? previous?.timestamp;
    if (watermark !== undefined) state.timestamp = watermark;
    const hash = textValue(frame.hash);
    if (hash !== undefined) state.bookHash = hash;
    states.set(token, state);
    this.books.set(connection, states);
    batch.quotes.push(this.quote(record, state, index, "snapshot", sourceTime));
  }

  private changeFrame(record: ReplayJournalRecord, frame: Record<string, unknown>, batch: ReplayBatch, index: number): void {
    const connection = record.connectionId!;
    const changes = frame.price_changes ?? frame.priceChanges;
    if (!Array.isArray(changes)) { this.quality.invalidBookUpdates += 1; this.invalidateToken(connection, assetId(frame), "malformed_delta"); return; }
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const item of changes) {
      const change = objectValue(item);
      const token = change ? assetId(change) : undefined;
      if (!change || !token) { this.quality.invalidBookUpdates += 1; this.invalidate(connection, "malformed_delta"); return; }
      const group = groups.get(token) ?? [];
      group.push(change);
      groups.set(token, group);
    }
    for (const [token, group] of groups) {
      this.tokenChanges(record, frame, token, group, batch, index, groups.size === 1 || assetId(frame) === token);
    }
  }

  private tokenChanges(record: ReplayJournalRecord, frame: Record<string, unknown>, token: string, changes: Record<string, unknown>[], batch: ReplayBatch, index: number, includeFrameBestPrices: boolean): void {
    const connection = record.connectionId!;
    const state = this.books.get(connection)?.get(token);
    const allowed = this.allowed(connection, token);
    let watermark = state?.timestamp;
    if (state && allowed) for (const change of changes) {
      const sourceTime = timestamp(change.timestamp ?? frame.timestamp);
      if (sourceTime !== undefined && (state.timestamp === undefined || sourceTime > state.timestamp)) state.timestamp = sourceTime;
    }
    if (!state || (!state.valid && !state.pending) || !allowed) {
      this.quality.invalidBookUpdates += 1;
      this.invalidateToken(connection, token, allowed ? "snapshot_required" : "book_not_allowed");
      return;
    }
    const updates: Array<{ side: "bids" | "asks"; key: string; value: ReplayLevel }> = [];
    let observedTime: bigint | undefined;
    for (const change of changes) {
      const parsed = level(change);
      const side = String(change?.side ?? "").toUpperCase();
      const timeValue = change?.timestamp ?? frame.timestamp;
      const sourceTime = timestamp(timeValue);
      if (!parsed || !["BUY", "SELL", "BID", "ASK"].includes(side)
        || (timeValue !== undefined && sourceTime === undefined)) {
        this.quality.invalidBookUpdates += 1; this.invalidateToken(connection, token, "malformed_delta"); return;
      }
      if (watermark !== undefined && sourceTime !== undefined && sourceTime < watermark) {
        this.quality.outOfOrderMessages += 1; this.invalidateToken(connection, token, "out_of_order_delta"); return;
      }
      if (sourceTime !== undefined) { watermark = sourceTime; observedTime = sourceTime; }
      updates.push({ side: side === "BUY" || side === "BID" ? "bids" : "asks", ...parsed });
    }
    for (const update of updates) {
      if (decimal(update.value.size)?.key === "0") state[update.side].delete(update.key);
      else state[update.side].set(update.key, update.value);
    }
    if (watermark !== undefined) state.timestamp = watermark;
    // Earlier rows can advertise intermediate tops; only the last change describes the final book.
    const lastChange = changes.at(-1)!;
    const advertised = includeFrameBestPrices ? [frame, lastChange] : [lastChange];
    // Malformed assertions cannot establish a recoverable source batch, even during a cross.
    for (const top of advertised) for (const field of ["best_bid", "best_ask"]) {
      if (top[field] !== undefined && !decimal(top[field], true)) {
        this.quality.invalidBookUpdates += 1; this.invalidateToken(connection, token, `malformed_${field}`); return;
      }
    }
    const hash = textValue(lastChange.hash);
    if (hash === undefined) delete state.bookHash;
    else state.bookHash = hash;
    const pending = state.pending;
    if (pending?.recoverable && (hash !== pending.hash || observedTime !== pending.timestamp)) {
      // The source moved on before this batch reconciled. Keep applying known absolute
      // updates, but a later matching top alone cannot prove that omitted depth is restored.
      pending.recoverable = false;
      this.consistency.persistentInvalidations += 1;
      this.invalidateToken(connection, token, `persistent_${pending.reason}`, pending);
    }
    let issue = bookIssue(state.bids, state.asks, advertised);
    if (pending?.recoverable) issue ??= bookIssue(state.bids, state.asks, pending.advertised);
    if (issue) this.quality.invalidBookUpdates += 1;
    if (pending) {
      if (issue || !pending.recoverable) { this.consistency.withheldDeltaUpdates += 1; return; }
      // The captured exchange protocol reuses a hash/timestamp across several messages.
      // This restores consistency of received depth; the hash still needs an independent audit.
      delete state.pending;
      state.valid = true;
      this.consistency.recoveredByDelta += 1;
    } else if (issue) {
      const recoverable = hash !== undefined && observedTime !== undefined;
      if (recoverable) this.consistency.provisionalInvalidations += 1;
      else this.consistency.persistentInvalidations += 1;
      this.consistency.withheldDeltaUpdates += 1;
      this.invalidateToken(connection, token, issue, {
        hash, timestamp: observedTime, reason: issue, recoverable,
        advertised: advertised.map(top => ({ best_bid: top.best_bid, best_ask: top.best_ask }))
      });
      return;
    }
    batch.quotes.push(this.quote(record, state, index, "delta", observedTime));
  }
}

export function replayRecords(records: readonly ReplayJournalRecord[], options: ReplayOptions = {}): ReplayResult {
  const replay = new JournalReplay(options);
  const result: ReplayResult = { quotes: [], trades: [], sports: [], markets: [], quality: replay.quality };
  for (const record of records) {
    const batch = replay.accept(record);
    result.quotes.push(...batch.quotes);
    result.trades.push(...batch.trades);
    result.sports.push(...batch.sports);
  }
  result.markets = replay.markets;
  return result;
}

export async function readJournalRecords(runDirectory: string, options: ReplayOptions = {}): Promise<JournalReadResult> {
  const replay = new JournalReplay(options);
  const result: JournalReadResult = { quotes: [], trades: [], sports: [], markets: [], quality: replay.quality, records: [], segments: [] };
  result.segments = await scanJournal(runDirectory, record => {
    const batch = replay.accept(record);
    result.records.push(record);
    result.quotes.push(...batch.quotes);
    result.trades.push(...batch.trades);
    result.sports.push(...batch.sports);
  }, replay.quality, () => replay.invalidate(), options);
  result.markets = replay.markets;
  return result;
}

export const loadJournal = readJournalRecords;
export function marketMappingFromEvent(event: unknown): ReplayMarketMapping[] { return metadataMappings(event); }
