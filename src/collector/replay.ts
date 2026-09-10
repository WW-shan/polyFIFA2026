import { assertJournalRecord, scanJournal } from "./journal-reader.js";
import { arrayValue, assetId, decimal, frameType, heartbeat, identifier, level, levelMap, objectValue, parsedJson, sortedLevels, textValue, timestamp } from "./replay-values.js";
import { emptyReplayQuality, type JournalReadResult, type ReplayBatch, type ReplayJournalRecord, type ReplayLevel, type ReplayMarketMapping, type ReplayOptions, type ReplayQuoteRow, type ReplayResult, type ReplaySportsRow, type ReplayTradeRow } from "./replay-types.js";
export type * from "./replay-types.js";

interface BookState {
  connectionId: string;
  tokenId: string;
  bids: Map<string, ReplayLevel>;
  asks: Map<string, ReplayLevel>;
  valid: boolean;
  timestamp?: bigint;
}
interface SportsState {
  row: ReplaySportsRow;
  monotonicNs: bigint;
  identities: Map<string, string>;
}
const knownNonDepthEvents = new Set(["tick_size_change", "best_bid_ask", "new_market"]);

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
  private readonly books = new Map<string, Map<string, BookState>>();
  private readonly connections = new Map<string, boolean>();
  private readonly subscriptions = new Map<string, Set<string>>();
  private readonly mappings = new Map<string, ReplayMarketMapping>();
  private readonly sportsByKey = new Map<string, SportsState>();
  private previousSequence = 0;
  private previousMonotonic = 0n;
  private runId: string | undefined;
  private readonly staleAfterMs: number;

  constructor(options: ReplayOptions = {}) {
    this.staleAfterMs = options.sportsStaleAfterMs ?? 60_000;
    if (!Number.isFinite(this.staleAfterMs) || this.staleAfterMs < 0) throw new Error("REPLAY_OPTIONS_INVALID: sportsStaleAfterMs");
  }
  get markets(): ReplayMarketMapping[] { return [...this.mappings.values()]; }

  invalidate(connectionId?: string): void {
    let changed = false;
    for (const [connection, states] of this.books) {
      if (connectionId !== undefined && connectionId !== connection) continue;
      for (const state of states.values()) {
        if (state.valid) changed = true;
        state.valid = false;
      }
    }
    if (changed) this.quality.connectionInvalidations += 1;
    if (connectionId === undefined) this.sportsByKey.clear();
  }

  private invalidateToken(connection: string, token?: string): void {
    if (!token) { this.invalidate(connection); return; }
    const state = this.books.get(connection)?.get(token);
    if (state?.valid) this.quality.connectionInvalidations += 1;
    if (state) state.valid = false;
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
    assertJournalRecord(record);
    if (this.runId !== undefined && this.runId !== record.runId) throw new Error("REPLAY_RUN_MISMATCH");
    this.runId = record.runId;
    if (record.sequence <= this.previousSequence) throw new Error("REPLAY_SEQUENCE_ORDER");
    const monotonic = BigInt(record.monotonicNs);
    if (monotonic < this.previousMonotonic) throw new Error("REPLAY_MONOTONIC_ORDER");
    if (record.sequence !== this.previousSequence + 1) {
      this.quality.sequenceGaps.push({ expected: this.previousSequence + 1, actual: record.sequence });
      this.invalidate();
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
      this.invalidate(connection);
      this.books.delete(connection);
      this.connections.set(connection, true);
    } else if (["connection_close", "connection_timeout", "heartbeat_timeout", "connection_gap"].includes(record.kind)) {
      this.invalidate(connection);
      this.connections.set(connection, false);
      this.books.delete(connection);
      this.subscriptions.delete(connection);
    } else if (record.kind === "subscription") {
      const data = objectValue(record.data);
      const ids = arrayValue(data?.assets_ids).map(identifier).filter((value): value is string => value !== undefined);
      const tokens = this.subscriptions.get(connection) ?? new Set<string>();
      if (data?.type === "market") {
        this.invalidate(connection);
        tokens.clear();
      }
      for (const id of ids) {
        this.books.get(connection)?.delete(id);
        if (data?.operation === "unsubscribe") tokens.delete(id);
        else tokens.add(id);
      }
      this.subscriptions.set(connection, tokens);
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
      if ([...expected].some(([field, value]) => state.identities.has(field) && state.identities.get(field) !== value)) continue;
      if (!latest || state.row.sequence > latest.row.sequence || (state.row.sequence === latest.row.sequence && (state.row.frameIndex ?? 0) > (latest.row.frameIndex ?? 0))) latest = state;
    }
    return latest;
  }

  private quote(record: ReplayJournalRecord, state: BookState, frameIndex: number, observedTimestamp?: bigint): ReplayQuoteRow {
    const mapping = this.mappings.get(state.tokenId);
    const sports = this.matchingSports(mapping);
    const row: ReplayQuoteRow = {
      sequence: record.sequence, receivedAt: record.receivedAt, receivedAtMs: record.receivedAtMs,
      connectionId: state.connectionId, frameIndex, tokenId: state.tokenId,
      bids: sortedLevels(state.bids, true), asks: sortedLevels(state.asks, false),
      sportsStatus: "missing", sportsClockStatus: "missing"
    };
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
    if (!connection) { this.quality.invalidBookUpdates += 1; this.invalidate(); return; }
    if (heartbeat(record.data)) return;
    const parsed = parsedJson(record.data);
    if (heartbeat(parsed)) return;
    const rawFrames = Array.isArray(parsed) ? parsed : [parsed];
    if (rawFrames.some(frame => !objectValue(frame))) {
      this.quality.unknownFrames += 1;
      this.invalidate(connection);
      return;
    }
    for (const [index, item] of rawFrames.entries()) {
      const batch: ReplayBatch = { quotes: [], trades: [], sports: [] };
      const frame = objectValue(item)!;
      const type = frameType(frame);
      if (heartbeat(frame) || knownNonDepthEvents.has(type)) continue;
      if (type === "book" || (!type && frame.bids !== undefined && frame.asks !== undefined)) {
        this.bookFrame(record, frame, batch, index);
      } else if (type === "price_change") {
        this.changeFrame(record, frame, batch, index);
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
        this.invalidateToken(connection, assetId(frame));
      }
      if (batch.quotes.length || batch.trades.length) yield batch;
    }
  }

  private allowed(connection: string, token: string): boolean {
    return this.connections.get(connection) !== false && (!this.subscriptions.has(connection) || this.subscriptions.get(connection)!.has(token));
  }

  private bookFrame(record: ReplayJournalRecord, frame: Record<string, unknown>, batch: ReplayBatch, index: number): void {
    const connection = record.connectionId!;
    const token = assetId(frame);
    const bids = levelMap(frame.bids);
    const asks = levelMap(frame.asks);
    const sourceTime = timestamp(frame.timestamp);
    if (!token || !bids || !asks || !this.allowed(connection, token) || (frame.timestamp !== undefined && sourceTime === undefined)) {
      this.quality.invalidBookUpdates += 1; this.invalidateToken(connection, token); return;
    }
    const states = this.books.get(connection) ?? new Map<string, BookState>();
    const previous = states.get(token);
    if (previous?.timestamp !== undefined && sourceTime !== undefined && sourceTime < previous.timestamp) {
      this.quality.outOfOrderMessages += 1; this.invalidateToken(connection, token); return;
    }
    const state: BookState = { connectionId: connection, tokenId: token, bids, asks, valid: true };
    const watermark = sourceTime ?? previous?.timestamp;
    if (watermark !== undefined) state.timestamp = watermark;
    states.set(token, state);
    this.books.set(connection, states);
    batch.quotes.push(this.quote(record, state, index, sourceTime));
  }

  private changeFrame(record: ReplayJournalRecord, frame: Record<string, unknown>, batch: ReplayBatch, index: number): void {
    const connection = record.connectionId!;
    const changes = frame.price_changes ?? frame.priceChanges;
    if (!Array.isArray(changes)) { this.quality.invalidBookUpdates += 1; this.invalidate(connection); return; }
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const item of changes) {
      const change = objectValue(item);
      const token = change ? assetId(change) : undefined;
      if (!change || !token) { this.quality.invalidBookUpdates += 1; this.invalidate(connection); return; }
      const group = groups.get(token) ?? [];
      group.push(change);
      groups.set(token, group);
    }
    for (const [token, group] of groups) {
      this.tokenChanges(record, frame, token, group, batch, index);
    }
  }

  private tokenChanges(record: ReplayJournalRecord, frame: Record<string, unknown>, token: string, changes: Record<string, unknown>[], batch: ReplayBatch, index: number): void {
    const connection = record.connectionId!;
    const state = this.books.get(connection)?.get(token);
    if (!state?.valid || !this.allowed(connection, token)) {
      this.quality.invalidBookUpdates += 1;
      this.invalidateToken(connection, token);
      return;
    }
    const updates: Array<{ side: "bids" | "asks"; key: string; value: ReplayLevel }> = [];
    let watermark = state.timestamp;
    let observedTime: bigint | undefined;
    for (const change of changes) {
      const parsed = level(change);
      const side = String(change?.side ?? "").toUpperCase();
      const timeValue = change?.timestamp ?? frame.timestamp;
      const sourceTime = timestamp(timeValue);
      if (!parsed || !["BUY", "SELL", "BID", "ASK"].includes(side)
        || (timeValue !== undefined && sourceTime === undefined)) {
        this.quality.invalidBookUpdates += 1; this.invalidateToken(connection, token); return;
      }
      if (watermark !== undefined && sourceTime !== undefined && sourceTime < watermark) {
        this.quality.outOfOrderMessages += 1; this.invalidateToken(connection, token); return;
      }
      if (sourceTime !== undefined) { watermark = sourceTime; observedTime = sourceTime; }
      updates.push({ side: side === "BUY" || side === "BID" ? "bids" : "asks", ...parsed });
    }
    for (const update of updates) {
      if (decimal(update.value.size)?.key === "0") state[update.side].delete(update.key);
      else state[update.side].set(update.key, update.value);
    }
    if (watermark !== undefined) state.timestamp = watermark;
    batch.quotes.push(this.quote(record, state, index, observedTime));
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
