import type { ReplayLevel } from "./replay-types.js";

export interface TailMarket {
  eventId: string; eventSlug: string; gameId: string | null;
  marketId: string; marketSlug: string; conditionId: string;
  tokenId: string; outcome: string; question: string; marketType: string;
  closed: boolean; acceptingOrders: boolean | null;
  raw: Record<string, unknown>;
}
export interface TailMetadata {
  eventId: string; eventSlug: string; title: string; gameId: string | null; parentEventId: string | null;
  sport: string | null; tags: string[]; markets: TailMarket[];
  finishAtMs: number | null; finishSource: "gamma.finishedTimestamp" | null;
  observedAtMs: number; sequence: number; raw: Record<string, unknown>;
}
export interface TailObservation {
  eventSlug: string | null; gameId: string | null; sport: string | null;
  source: "sports-ws" | "gamma"; sourceAtMs: number | null; observedAtMs: number;
  sequence: number; frameIndex: number; connectionId: string | null;
  score: unknown; period: unknown; clock: unknown; live: boolean | null; ended: boolean | null;
  finishAtMs: number | null; finishSource: "gamma.finishedTimestamp" | "sports.finishedAt" | null;
  raw: Record<string, unknown>;
}
export interface TailStateChange {
  source: TailObservation["source"]; eventSlug: string | null; gameId: string | null;
  kind: "score_change" | "score_increase" | "score_decrease" | "period_change" | "ended_change";
  observedAtMs: number; sourceAtMs: number | null; sequence: number; frameIndex: number;
  before: unknown; after: unknown; actualEventTimeKnown: boolean;
}

export interface TailWindow {
  key: string; eventIds: string[]; eventSlugs: string[]; title: string; gameId: string | null;
  startAtMs: number | null; endAtMs: number | null; finishSources: string[]; finishConflict: boolean;
  markets: TailMarket[];
  finishEvidence?: Array<{atMs:number;observedAtMs:number;source:string;eventSlug:string|null;sourceFile?:string}>;
}
export type TailBookStatus = "observed" | "carried" | "partial" | "missing" | "invalid" | "feed_stale" | "outside_run" | "not_yet_known" | "closed";
export interface TailSecond {
  windowKey: string; eventSlug: string; gameId: string | null; marketId: string; conditionId: string;
  question: string; marketType: string; tokenId: string; outcome: string;
  secondIndex: number; startAtMs: number; endAtMs: number; secondsBeforeFinish: number;
  status: TailBookStatus; wholeSecondValid: boolean; connectionId: string | null;
  bids: ReplayLevel[] | null; asks: ReplayLevel[] | null;
  bookObservedAtMs: number | null; bookSourceAtMs: number | null; bookAgeMs: number | null;
  feedAgeMs: number | null; bookHash: string | null;
  bestBid: string | null; bestAsk: string | null;
  minBestBid: number | null; maxBestBid: number | null; minBestAsk: number | null; maxBestAsk: number | null;
  bookUpdates: number; tradeCount: number; tradeShares: number;
  contextSource: TailObservation["source"] | null; contextObservedAtMs: number | null; contextSourceAtMs: number | null;
  contextAgeMs: number | null; contextStatus: "present" | "missing" | "stale" | "disconnected";
  score: unknown; period: unknown; clock: unknown; stateChangeCount: number;
  reasons: string[];
}
export interface TailBookChange {
  windowKey: string; tokenId: string; sequence: number; frameIndex: number;
  observedAtMs: number; sourceAtMs: number | null; kind: "book" | "trade" | "invalidation";
  bestBid?: string | null; bestAsk?: string | null; bidMove?: number | null; askMove?: number | null;
  rapidMove?: boolean; price?: string; size?: string; side?: string;
  data?: unknown;
}
export interface TailSnapshotAudit {
  windowKey: string; tokenId: string; sequence: number; observedAtMs: number;
  scope?: "seed" | "window";
  checkedAtMs?: number;
  snapshotAtMs: number | null; websocketAtMs: number | null;
  websocketSequence?: number;
  websocketFrameIndex?: number;
  status: "match" | "mismatch" | "not_comparable" | "invalid_snapshot";
  basis: "hash" | "source_timestamp" | "none"; reason: string;
}
export interface TailAuditBook {
  tokenId: string; sequence: number; frameIndex: number; observedAtMs: number; sourceAtMs: number | null;
  hash: string | null; fingerprint: string;
}
export interface TailTokenQuality {
  windowKey: string; tokenId: string; marketId: string; outcome: string; marketType: string;
  expectedSeconds: number; validSeconds: number; closedSeconds: number; partialSeconds: number;
  missingSeconds: number; staleSeconds: number; contextSeconds: number;
  snapshotMatches: number; snapshotMismatches: number; snapshotNotComparable: number;
  seedSnapshotMatches: number; seedSnapshotMismatches: number; seedSnapshotNotComparable: number;
  observedWindowComplete: boolean; snapshotAuditPassed: boolean; readyForReplay: boolean;
  reasons: string[];
}
export interface TailOptions {
  runDirectory: string; outputDirectory?: string; eventSlugs?: string[]; windowSeconds?: number;
  maxFeedSilenceMs?: number; sportsStaleAfterMs?: number; maxClockDriftMs?: number; shockThreshold?: number;
  maxLineBytes?: number;
  finishLabelsFile?: string;
}
export interface TailSummary {
  schemaVersion: 1; basis: "received-order-book-tail";
  runId: string; firstReceivedAtMs: number; lastReceivedAtMs: number;
  windowSeconds: number; records: number; seconds: number; changes: number; stateChanges: number; audits: number;
  windows: TailWindow[]; tokens: TailTokenQuality[]; warnings: string[];
  journalQuality: import("./replay-types.js").ReplayQuality;
  rawRecords?: number;
}
export interface TailSink {
  second(row: TailSecond): void | Promise<void>;
  change(row: TailBookChange): void | Promise<void>;
  stateChange(row: TailStateChange & { windowKey: string }): void | Promise<void>;
  audit(row: TailSnapshotAudit): void | Promise<void>;
  rawRecord?(record: import("./types.js").JournalRecord, windowKeys: string[]): void | Promise<void>;
}
export type TailPreviewRow = Omit<TailSecond, "bids" | "asks"> & { depthOffset: number; depthBytes: number };
export interface TailViewerInput {
  summary: TailSummary; rows: TailPreviewRow[];
  stateChanges: Array<TailStateChange & { windowKey: string }>;
  depthFile: string; depthFileBytes: number;
}
