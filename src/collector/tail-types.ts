import type { ReplayLevel } from "./replay-types.js";
import type { JournalRecord } from "./types.js";

export type TailClockPolicy = "strict" | "flag-backsteps";
export type TailClockReceipt = Pick<JournalRecord, "sequence" | "receivedAt" | "receivedAtMs" | "monotonicNs" | "source" | "kind"> & {
  connectionId: string | null;
};
export interface TailClockIssue {
  kind: "receipt-wall-clock-backstep";
  // Inclusive wall bounds from the original receipts, never adjusted timestamps.
  startAtMs: number; endAtMs: number;
  previous: TailClockReceipt; current: TailClockReceipt;
}

/**
 * Every way a tail window boundary can be established.
 *
 * The two published clocks are the primary evidence; the two book anchors are
 * the collector's own fallback when neither source ever publishes a finish.
 * They are separate labels so a reader can tell a real clock from a market
 * tail, and they are declared once so the catalog writer and the research
 * reader can never drift apart on what is an acceptable source.
 */
export const TAIL_FINISH_FACT_SOURCES = ["gamma.finishedTimestamp", "sports.finishedAt", "book-quiet", "book-tail"] as const;
export type TailFinishSource = (typeof TAIL_FINISH_FACT_SOURCES)[number];
/** True only for the two sources that publish an actual match clock. */
export function isPublishedFinishSource(value: unknown): value is "gamma.finishedTimestamp" | "sports.finishedAt" {
  return value === "gamma.finishedTimestamp" || value === "sports.finishedAt";
}
/** True for the collector's own book fallback, never an independent match clock. */
export function isFallbackFinishSource(value: unknown): value is "book-quiet" | "book-tail" {
  return value === "book-quiet" || value === "book-tail";
}
export function isTailFinishSource(value: unknown): value is TailFinishSource {
  return typeof value === "string" && (TAIL_FINISH_FACT_SOURCES as readonly string[]).includes(value);
}

/** A finish observed in an original journal; its raw body remains at that run/sequence/frame. */
export interface TailFinishFact {
  eventId: string | null; eventSlug: string | null; gameId: string | null;
  atMs: number; observedAtMs: number;
  source: TailFinishSource;
  sourceRunId: string; sourceRunDirectory: string | null;
  sequence: number; frameIndex: number;
}

/**
 * Newest witness per source.
 *
 * A source that re-publishes a corrected end time supersedes its own earlier
 * value: Sports repeatedly refined the same match by seconds, and treating each
 * refinement as an independent contradiction marked three quarters of the
 * collected matches as disputed even though nothing disagreed. Only the newest
 * value of each source takes part in the conflict decision.
 */
/** The fields every finish witness carries, whatever provenance it also keeps. */
export interface FinishWitness { source: string; atMs: number; observedAtMs: number; sequence?: number; frameIndex?: number }

export function newestFinishFacts<Witness extends FinishWitness>(facts: readonly Witness[]): Witness[] {
  const newest = new Map<string, Witness>();
  for (const fact of facts) {
    const current = newest.get(fact.source);
    // Ordering is by when the witness was observed, not by the clock it names:
    // a corrected end time can move the boundary backwards.
    const sequence = fact.sequence ?? 0, currentSequence = current?.sequence ?? 0;
    if (current === undefined || fact.observedAtMs > current.observedAtMs
      || (fact.observedAtMs === current.observedAtMs
        && (sequence > currentSequence
          || (sequence === currentSequence && (fact.frameIndex ?? 0) >= (current.frameIndex ?? 0))))) {
      newest.set(fact.source, fact);
    }
  }
  return [...newest.values()];
}

/** Newest value of every source that publishes a real match clock. */
export function publishedFinishValues(facts: readonly FinishWitness[]): number[] {
  return newestFinishFacts(facts).filter(fact => isPublishedFinishSource(fact.source)).map(fact => fact.atMs);
}

/**
 * True when two independent clocks still disagree.
 *
 * `book-quiet` / `book-tail` are the collector's own fallbacks, not witnesses,
 * so they never create a conflict here; a published artifact that keeps a
 * fallback boundary while a clock exists is handled by the callers.
 */
export function finishEvidenceConflict(facts: readonly FinishWitness[]): boolean {
  return new Set(publishedFinishValues(facts)).size > 1;
}

/**
 * True when a window's end boundary is still disputed by its own evidence.
 *
 * Disputed means two independent clocks disagree, or the boundary is not a
 * value any published clock named while such a clock exists (a published
 * artifact that kept the collector's own `book-quiet` / `book-tail` fallback).
 * Superseded values from the same source are not disputes.
 */
export function finishBoundaryDisputed(facts: readonly FinishWitness[], endAtMs: number | null): boolean {
  // Any published witness counts as naming the boundary, including one this
  // same source later corrected: a superseded clock value is still a clock,
  // not the collector's own book fallback.
  const named = facts.filter(fact => isPublishedFinishSource(fact.source));
  if (named.length === 0) return false;
  if (finishEvidenceConflict(facts)) return true;
  return endAtMs === null || !named.some(fact => fact.atMs === endAtMs);
}

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
  clockIssues?: TailClockIssue[];
  finishEvidence?: Array<{atMs:number;observedAtMs:number;source:string;eventSlug:string|null;sourceFile?:string;
    eventId?:string|null;gameId?:string|null;sourceRunId?:string;sourceRunDirectory?:string|null;sequence?:number;frameIndex?:number}>;
}
/** A reserved identity may represent a quarantined component, never an exportable window. */
export interface TailWindowIdentity {
  key: string; eventSlugs: string[]; gameId: string | null;
  gameIdAliases?: string[];
}
export interface TailEventIdentity {
  eventSlugs: string[]; gameIds: string[];
  quarantineKey?: string; ambiguousGameIds?: boolean;
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
  // References to TailClockIssue.current.sequence in the window/summary diagnostics.
  clockIssueSequences?: number[];
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
  clockAffectedSeconds?: number;
  reasons: string[];
}
export interface TailOptions {
  runDirectory: string; outputDirectory?: string; eventSlugs?: string[]; windowSeconds?: number;
  maxFeedSilenceMs?: number; sportsStaleAfterMs?: number; maxClockDriftMs?: number; shockThreshold?: number;
  clockPolicy?: TailClockPolicy;
  maxLineBytes?: number;
  finishLabelsFile?: string;
  finishFactsFile?: string;
  /** Durable source identity to record when the replay journal is synthesized. */
  sourceRunDirectory?: string;
  /** Copy the finish-facts sidecar into the archive instead of referencing a temporary file. */
  archiveFinishFacts?: boolean;
  /** Losslessly compact the generated raw-evidence copy after its writer is sealed. */
  compressRawEvents?: boolean;
}
export interface TailSummary {
  schemaVersion: 1; basis: "received-order-book-tail";
  runId: string; firstReceivedAtMs: number; lastReceivedAtMs: number;
  windowSeconds: number; records: number; seconds: number; changes: number; stateChanges: number; audits: number;
  windows: TailWindow[]; tokens: TailTokenQuality[]; warnings: string[];
  journalQuality: import("./replay-types.js").ReplayQuality;
  clockPolicy?: TailClockPolicy;
  clockIssues?: TailClockIssue[];
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
