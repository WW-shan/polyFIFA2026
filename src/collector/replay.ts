import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listJournalSegments } from "./journal.js";
import type { CollectorMarket, JournalRecord } from "./types.js";

export type ReplayJournalRecord = JournalRecord;

export interface ReplaySequenceGap {
  expected: number;
  actual: number;
}

export interface ReplayQuality {
  sequenceGaps: ReplaySequenceGap[];
  incompleteFinalLines: number;
  malformedLines: number;
  invalidBookUpdates: number;
  connectionInvalidations: number;
  unknownFrames: number;
  outOfOrderMessages: number;
}

export interface ReplayLevel {
  price: string;
  size: string;
}

export interface ReplayMarketMapping {
  tokenId: string;
  eventId?: string;
  eventSlug?: string;
  gameId?: string;
  marketId?: string;
  marketSlug?: string;
  conditionId?: string;
  outcome?: string;
  question?: string;
}

export interface ReplaySportsRow {
  sequence: number;
  receivedAt: string;
  receivedAtMs: number;
  data: unknown;
  keys: string[];
}

export interface ReplayTradeRow {
  sequence: number;
  receivedAt: string;
  receivedAtMs: number;
  connectionId?: string;
  tokenId?: string;
  price?: string;
  size?: string;
  side?: string;
  data: Record<string, unknown>;
}

export interface ReplayQuoteRow {
  sequence: number;
  receivedAt: string;
  receivedAtMs: number;
  connectionId: string;
  tokenId: string;
  bids: ReplayLevel[];
  asks: ReplayLevel[];
  marketId?: string;
  marketSlug?: string;
  eventId?: string;
  eventSlug?: string;
  gameId?: string;
  outcome?: string;
  sportsSequence?: number;
  sportsReceivedAt?: string;
  sportsAgeMs?: number;
}

export interface ReplayResult {
  quotes: ReplayQuoteRow[];
  trades: ReplayTradeRow[];
  sports: ReplaySportsRow[];
  markets: ReplayMarketMapping[];
  quality: ReplayQuality;
}

export interface JournalReadResult extends ReplayResult {
  records: ReplayJournalRecord[];
  segments: string[];
}

interface BookState {
  connectionId: string;
  tokenId: string;
  bids: Map<string, string>;
  asks: Map<string, string>;
  valid: boolean;
}

interface SportsState extends ReplaySportsRow {
  keys: string[];
}

function emptyQuality(): ReplayQuality {
  return {
    sequenceGaps: [],
    incompleteFinalLines: 0,
    malformedLines: 0,
    invalidBookUpdates: 0,
    connectionInvalidations: 0,
    unknownFrames: 0,
    outOfOrderMessages: 0
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function level(value: unknown): ReplayLevel | null {
  const raw = objectValue(value);
  if (!raw) return null;
  const price = stringValue(raw.price);
  const size = stringValue(raw.size);
  if (price === undefined || size === undefined) return null;
  return { price, size };
}

function isZero(value: string): boolean {
  const number = Number(value);
  return Number.isFinite(number) && number === 0;
}

function sortedLevels(levels: Map<string, string>, direction: "asc" | "desc"): ReplayLevel[] {
  return [...levels.entries()]
    .map(([price, size]) => ({ price, size }))
    .sort((left, right) => {
      const delta = Number(left.price) - Number(right.price);
      return direction === "asc" ? delta : -delta;
    });
}

function tokenId(raw: Record<string, unknown>): string | undefined {
  return stringValue(raw.asset_id ?? raw.assetId ?? raw.token_id ?? raw.tokenId);
}

function connectionTokenKey(connectionId: string, assetId: string): string {
  return `${connectionId}\u0000${assetId}`;
}

function parseFrames(data: unknown): Record<string, unknown>[] {
  const parsed = typeof data === "string" ? (() => {
    try { return JSON.parse(data) as unknown; } catch { return null; }
  })() : data;
  if (Array.isArray(parsed)) return parsed.map(objectValue).filter((value): value is Record<string, unknown> => value !== null);
  const object = objectValue(parsed);
  return object ? [object] : [];
}

function eventType(frame: Record<string, unknown>): string {
  return String(frame.event_type ?? frame.eventType ?? frame.type ?? "").toLowerCase();
}

function applyMetadata(data: unknown, markets: Map<string, ReplayMarketMapping>): void {
  const raw = objectValue(data);
  const normalized = objectValue(raw?.normalized) ?? raw;
  if (!normalized) return;
  const eventId = stringValue(normalized.eventId ?? normalized.id);
  const eventSlug = stringValue(normalized.eventSlug ?? normalized.slug);
  const gameId = stringValue(normalized.gameId ?? objectValue(normalized.eventMetadata)?.gameId);
  for (const marketValue of arrayValue(normalized.markets)) {
    const market = objectValue(marketValue);
    if (!market) continue;
    const marketId = stringValue(market.marketId ?? market.id);
    const marketSlug = stringValue(market.marketSlug ?? market.slug);
    const conditionId = stringValue(market.conditionId);
    const question = stringValue(market.question);
    const outcomes = arrayValue(market.outcomes).map(stringValue);
    const tokenIds = arrayValue(market.tokenIds ?? market.clobTokenIds).map(stringValue);
    for (let index = 0; index < tokenIds.length; index += 1) {
      const token = tokenIds[index];
      if (!token) continue;
      const mapping: ReplayMarketMapping = { tokenId: token };
      if (eventId !== undefined) mapping.eventId = eventId;
      if (eventSlug !== undefined) mapping.eventSlug = eventSlug;
      if (gameId !== undefined) mapping.gameId = gameId;
      if (marketId !== undefined) mapping.marketId = marketId;
      if (marketSlug !== undefined) mapping.marketSlug = marketSlug;
      if (conditionId !== undefined) mapping.conditionId = conditionId;
      if (question !== undefined) mapping.question = question;
      const outcome = outcomes[index];
      if (outcome !== undefined) mapping.outcome = outcome;
      markets.set(token, mapping);
    }
  }
}

function dataKeys(data: unknown): string[] {
  const raw = objectValue(data);
  if (!raw) return [];
  const keys = new Set<string>();
  for (const field of ["eventSlug", "slug", "gameId", "game_id", "sportradarGameId", "sportradar_game_id"]) {
    const value = stringValue(raw[field]);
    if (value !== undefined) keys.add(`${field}:${value}`);
  }
  return [...keys];
}

function parseSports(record: ReplayJournalRecord): SportsState {
  const data = typeof record.data === "string" ? (() => {
    try { return JSON.parse(record.data) as unknown; } catch { return record.data; }
  })() : record.data;
  return {
    sequence: record.sequence,
    receivedAt: record.receivedAt,
    receivedAtMs: record.receivedAtMs,
    data,
    keys: dataKeys(data)
  };
}

function attachContext(quote: ReplayQuoteRow, mapping: ReplayMarketMapping | undefined, sports: SportsState | undefined): void {
  if (mapping) {
    if (mapping.marketId !== undefined) quote.marketId = mapping.marketId;
    if (mapping.marketSlug !== undefined) quote.marketSlug = mapping.marketSlug;
    if (mapping.eventId !== undefined) quote.eventId = mapping.eventId;
    if (mapping.eventSlug !== undefined) quote.eventSlug = mapping.eventSlug;
    if (mapping.gameId !== undefined) quote.gameId = mapping.gameId;
    if (mapping.outcome !== undefined) quote.outcome = mapping.outcome;
  }
  if (sports) {
    quote.sportsSequence = sports.sequence;
    quote.sportsReceivedAt = sports.receivedAt;
    quote.sportsAgeMs = Math.max(0, quote.receivedAtMs - sports.receivedAtMs);
  }
}

function relatedSports(mapping: ReplayMarketMapping | undefined, latest: SportsState | undefined, byKey: Map<string, SportsState>): SportsState | undefined {
  if (mapping) {
    for (const [field, value] of [["eventSlug", mapping.eventSlug], ["gameId", mapping.gameId]] as const) {
      if (value !== undefined) {
        const match = byKey.get(`${field}:${value}`);
        if (match) return match;
      }
    }
  }
  return latest;
}

function cloneStateQuote(record: ReplayJournalRecord, state: BookState, mapping: ReplayMarketMapping | undefined, sports: SportsState | undefined): ReplayQuoteRow {
  const quote: ReplayQuoteRow = {
    sequence: record.sequence,
    receivedAt: record.receivedAt,
    receivedAtMs: record.receivedAtMs,
    connectionId: state.connectionId,
    tokenId: state.tokenId,
    bids: sortedLevels(state.bids, "desc"),
    asks: sortedLevels(state.asks, "asc")
  };
  attachContext(quote, mapping, sports);
  return quote;
}

function invalidateAll(states: Map<string, BookState>, quality: ReplayQuality): void {
  for (const state of states.values()) state.valid = false;
  quality.connectionInvalidations += 1;
}

function invalidateConnection(states: Map<string, BookState>, connectionId: string, quality: ReplayQuality): void {
  let invalidated = false;
  for (const state of states.values()) {
    if (state.connectionId === connectionId) {
      state.valid = false;
      invalidated = true;
    }
  }
  if (invalidated) quality.connectionInvalidations += 1;
}

export function replayRecords(records: readonly ReplayJournalRecord[]): ReplayResult {
  const quality = emptyQuality();
  const quotes: ReplayQuoteRow[] = [];
  const trades: ReplayTradeRow[] = [];
  const sports: ReplaySportsRow[] = [];
  const marketMap = new Map<string, ReplayMarketMapping>();
  const states = new Map<string, BookState>();
  const activeConnections = new Map<string, boolean>();
  const latestSportsByKey = new Map<string, SportsState>();
  let latestSports: SportsState | undefined;
  let previousSequence = 0;

  for (const record of records) {
    if (record.sequence <= previousSequence) {
      quality.outOfOrderMessages += 1;
      throw new Error(`REPLAY_SEQUENCE_ORDER: ${record.sequence} after ${previousSequence}`);
    }
    if (record.sequence > previousSequence + 1) {
      quality.sequenceGaps.push({ expected: previousSequence + 1, actual: record.sequence });
      invalidateAll(states, quality);
    }
    previousSequence = record.sequence;

    if (record.source === "gamma" && record.kind === "event_metadata") {
      applyMetadata(record.data, marketMap);
      continue;
    }
    if (record.source === "sports" && record.kind === "ws_message") {
      const row = parseSports(record);
      sports.push(row);
      latestSports = row;
      for (const key of row.keys) latestSportsByKey.set(key, row);
      continue;
    }
    if (record.source === "collector" && record.kind === "connection_open" && record.connectionId) {
      activeConnections.set(record.connectionId, true);
      continue;
    }
    if (record.source === "collector" && record.kind === "connection_close" && record.connectionId) {
      activeConnections.set(record.connectionId, false);
      invalidateConnection(states, record.connectionId, quality);
      continue;
    }
    if (record.source !== "clob" || record.kind !== "ws_message" || !record.connectionId) continue;

    const frames = parseFrames(record.data);
    if (frames.length === 0) {
      quality.unknownFrames += 1;
      continue;
    }
    for (const frame of frames) {
      const type = eventType(frame);
      const asset = tokenId(frame);
      if (type === "book" || (asset !== undefined && (Array.isArray(frame.bids) || Array.isArray(frame.asks)))) {
        if (!asset) {
          quality.invalidBookUpdates += 1;
          continue;
        }
        const state: BookState = {
          connectionId: record.connectionId,
          tokenId: asset,
          bids: new Map(),
          asks: new Map(),
          valid: true
        };
        for (const item of arrayValue(frame.bids)) {
          const parsed = level(item);
          if (parsed && !isZero(parsed.size)) state.bids.set(parsed.price, parsed.size);
        }
        for (const item of arrayValue(frame.asks)) {
          const parsed = level(item);
          if (parsed && !isZero(parsed.size)) state.asks.set(parsed.price, parsed.size);
        }
        states.set(connectionTokenKey(record.connectionId, asset), state);
        activeConnections.set(record.connectionId, true);
        quotes.push(cloneStateQuote(record, state, marketMap.get(asset), relatedSports(marketMap.get(asset), latestSports, latestSportsByKey)));
        continue;
      }
      if (type === "price_change" || Array.isArray(frame.price_changes) || Array.isArray(frame.priceChanges)) {
        const changes = arrayValue(frame.price_changes ?? frame.priceChanges);
        const changedStates = new Set<BookState>();
        for (const changeValue of changes) {
          const change = objectValue(changeValue);
          const changedToken = change ? tokenId(change) : undefined;
          const price = change ? stringValue(change.price) : undefined;
          const size = change ? stringValue(change.size) : undefined;
          const side = change ? String(change.side ?? "").toUpperCase() : "";
          const state = changedToken ? states.get(connectionTokenKey(record.connectionId, changedToken)) : undefined;
          if (!state || !state.valid || activeConnections.get(record.connectionId) === false || !price || size === undefined || (side !== "BUY" && side !== "SELL" && side !== "BID" && side !== "ASK")) {
            quality.invalidBookUpdates += 1;
            continue;
          }
          const target = side === "BUY" || side === "BID" ? state.bids : state.asks;
          if (isZero(size)) target.delete(price);
          else target.set(price, size);
          changedStates.add(state);
        }
        for (const state of changedStates) {
          quotes.push(cloneStateQuote(record, state, marketMap.get(state.tokenId), relatedSports(marketMap.get(state.tokenId), latestSports, latestSportsByKey)));
        }
        continue;
      }
      if (type === "last_trade_price" || type === "trade" || type === "public_trade" || type === "trades") {
        const trade: ReplayTradeRow = {
          sequence: record.sequence,
          receivedAt: record.receivedAt,
          receivedAtMs: record.receivedAtMs,
          data: frame
        };
        const id = tokenId(frame);
        const price = stringValue(frame.price);
        const size = stringValue(frame.size ?? frame.amount);
        const side = stringValue(frame.side);
        if (id !== undefined) trade.tokenId = id;
        if (price !== undefined) trade.price = price;
        if (size !== undefined) trade.size = size;
        if (side !== undefined) trade.side = side;
        trade.connectionId = record.connectionId;
        trades.push(trade);
        continue;
      }
      quality.unknownFrames += 1;
    }
  }

  return { quotes, trades, sports, markets: [...marketMap.values()], quality };
}

export async function readJournalRecords(runDirectory: string): Promise<JournalReadResult> {
  const segments = await listJournalSegments(runDirectory);
  const records: ReplayJournalRecord[] = [];
  const quality = emptyQuality();
  for (const segment of segments) {
    const content = await readFile(join(runDirectory, segment), "utf8");
    const lines = content.split("\n");
    const hasFinalNewline = content.endsWith("\n");
    if (content.length > 0 && !hasFinalNewline) quality.incompleteFinalLines += 1;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line || (index === lines.length - 1 && hasFinalNewline)) continue;
      try {
        const parsed = JSON.parse(line) as ReplayJournalRecord;
        if (!parsed || typeof parsed.sequence !== "number") throw new Error("invalid journal record");
        records.push(parsed);
      } catch {
        quality.malformedLines += 1;
      }
    }
  }
  const replay = replayRecords(records);
  replay.quality.incompleteFinalLines += quality.incompleteFinalLines;
  replay.quality.malformedLines += quality.malformedLines;
  return { ...replay, records, segments };
}

export const loadJournal = readJournalRecords;

export function marketMappingFromEvent(event: CollectorEventLike): ReplayMarketMapping[] {
  const result: ReplayMarketMapping[] = [];
  for (const market of event.markets ?? []) {
    for (let index = 0; index < market.tokenIds.length; index += 1) {
      const mapping: ReplayMarketMapping = { tokenId: market.tokenIds[index]! };
      if (event.eventId !== undefined) mapping.eventId = event.eventId;
      if (event.eventSlug !== undefined) mapping.eventSlug = event.eventSlug;
      if (event.gameId !== undefined) mapping.gameId = event.gameId;
      if (market.marketId !== undefined) mapping.marketId = market.marketId;
      if (market.marketSlug !== undefined) mapping.marketSlug = market.marketSlug;
      if (market.conditionId !== undefined) mapping.conditionId = market.conditionId;
      const outcome = market.outcomes[index];
      if (outcome !== undefined) mapping.outcome = outcome;
      result.push(mapping);
    }
  }
  return result;
}

interface CollectorEventLike {
  eventId?: string;
  eventSlug?: string;
  gameId?: string;
  markets?: Array<Pick<CollectorMarket, "tokenIds" | "outcomes"> & Partial<Pick<CollectorMarket, "marketId" | "marketSlug" | "conditionId">>>;
}
