import type { JournalRecord } from "./types.js";

export type ReplayJournalRecord = JournalRecord;
export interface ReplaySequenceGap { expected: number; actual: number }
export interface ReplayBookConsistencyQuality {
  provisionalInvalidations: number;
  recoveredByDelta: number;
  persistentInvalidations: number;
  recoveredBySnapshot: number;
  withheldDeltaUpdates: number;
}
export interface ReplayQuality {
  sequenceGaps: ReplaySequenceGap[];
  incompleteFinalLines: number;
  malformedLines: number;
  invalidBookUpdates: number;
  connectionInvalidations: number;
  unknownFrames: number;
  outOfOrderMessages: number;
  /** Optional for older consumers; reconciliation is not a full-depth hash audit. */
  bookConsistency?: ReplayBookConsistencyQuality;
}
/** Missing connection/token IDs mean all connections/all tokens in the connection. */
export interface ReplayInvalidation {
  connectionId?: string;
  tokenId?: string;
  reason: string;
  /** The current source batch may reconcile this disagreement through further absolute deltas. */
  provisional?: boolean;
}
export interface ReplayOptions {
  sportsStaleAfterMs?: number;
  maxLineBytes?: number;
  /** Synchronous, including repeated invalidations; the caller owns the current record's time. */
  onInvalidation?: (event: ReplayInvalidation) => void;
}
export interface ReplayLevel { price: string; size: string }
export interface ReplayMarketMapping {
  tokenId: string;
  eventId?: string;
  eventSlug?: string;
  gameId?: string;
  sportradarGameId?: string;
  marketId?: string;
  marketSlug?: string;
  conditionId?: string;
  outcome?: string;
  question?: string;
  data?: unknown;
}
export interface ReplaySportsRow {
  sequence: number;
  receivedAt: string;
  receivedAtMs: number;
  connectionId?: string;
  frameIndex?: number;
  data: unknown;
  keys: string[];
}
export interface ReplayTradeRow {
  sequence: number;
  receivedAt: string;
  receivedAtMs: number;
  connectionId?: string;
  frameIndex?: number;
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
  frameIndex?: number;
  tokenId: string;
  bids: ReplayLevel[];
  asks: ReplayLevel[];
  marketId?: string;
  marketSlug?: string;
  eventId?: string;
  eventSlug?: string;
  gameId?: string;
  outcome?: string;
  serverTimestamp?: string;
  /** Only the hash received for this mutation, never a carried or computed hash. */
  bookHash?: string;
  updateKind?: "snapshot" | "delta";
  sportsSequence?: number;
  sportsReceivedAt?: string;
  sportsAgeMs?: number;
  sportsFrameIndex?: number;
  sportsStatus?: "matched" | "missing" | "stale" | "disconnected";
  sportsClockStatus?: "present" | "missing";
  sportsScore?: unknown;
  sportsPeriod?: unknown;
  sportsClock?: unknown;
}
export interface ReplayBatch {
  quotes: ReplayQuoteRow[];
  trades: ReplayTradeRow[];
  sports: ReplaySportsRow[];
}
export interface ReplayResult extends ReplayBatch {
  markets: ReplayMarketMapping[];
  quality: ReplayQuality;
}
export interface JournalReadResult extends ReplayResult {
  records: ReplayJournalRecord[];
  segments: string[];
}
export function emptyReplayQuality(): ReplayQuality {
  return {
    sequenceGaps: [], incompleteFinalLines: 0, malformedLines: 0, invalidBookUpdates: 0,
    connectionInvalidations: 0, unknownFrames: 0, outOfOrderMessages: 0,
    bookConsistency: { provisionalInvalidations: 0, recoveredByDelta: 0, persistentInvalidations: 0, recoveredBySnapshot: 0, withheldDeltaUpdates: 0 }
  };
}
