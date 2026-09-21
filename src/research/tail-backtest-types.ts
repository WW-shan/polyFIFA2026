import type { TailBookChange, TailBookStatus, TailSecond, TailSummary, TailTokenQuality, TailWindow } from "../collector/tail-types.js";

export interface TailBacktestInput {
  sourceId: string;
  sport: string;
  summary: TailSummary;
  seconds: readonly TailSecond[];
  changes: readonly TailBookChange[];
  settlements?: readonly TailSettlement[];
}

export interface TailSettlement {
  marketId: string;
  conditionId: string;
  tokenId: string;
  payout: number;
  source: "gamma-resolved-prices" | "clob-winner-flags";
  observedAtMs: number;
  /** Nonempty provenance URI, including file: archives or URNs; retained verbatim and never fetched here. */
  sourceUrl: string;
}

export type TailFillModel = "quote-touch-assumed" | "sell-through-volume";
export interface TailBacktestOptions {
  prices?: string[];
  windowsSeconds?: number[];
  entryMinBid?: string;
  shares?: number;
  queueAheadShares?: number;
  makerFeeBps?: number;
  fillModel?: TailFillModel;
  requireFreshContext?: boolean;
  /**
   * Price trials whose window end is the collector's own book anchor
   * (`book-quiet` / `book-tail`) instead of a published match clock.
   *
   * Off by default. Tennis and table-tennis events on this feed almost never
   * publish `finishedTimestamp`, so the collector anchors those windows on the
   * last order-book frame, which is inside the match by construction but can be
   * earlier than the true finish. Turning this on trades that precision for
   * coverage, and the anchor source stays recorded on every trial.
   */
  allowBookAnchorFinish?: boolean;
  /**
   * Allow archive-wide token coverage to be incomplete outside the selected
   * holding window. Every priced trial still requires its own holding window to
   * be complete and every aggregate token counter to agree with the rows.
   *
   * Off by default. Compact tail windows often begin before an outcome's order
   * book exists, so the archive can legitimately contain missing front seconds
   * even when the final minutes used by a trial are complete.
   */
  allowPartialArchiveWindow?: boolean;
}
export type EffectiveTailBacktestOptions = Required<TailBacktestOptions>;
export type TailBacktestFinishEvidence = NonNullable<TailWindow["finishEvidence"]>[number];

export type TailBacktestExclusion =
  | "missing-actual-finish" | "conflicting-finish-labels"
  | "missing-entry-reference" | "missing-entry-bid" | "missing-entry-ask" | "entry-book-closed"
  | "entry-below-threshold" | "limit-not-below-entry-ask"
  | "token-window-incomplete" | "snapshot-audit-not-passed" | "no-active-book-seconds"
  | "holding-window-not-covered" | "holding-data-incomplete" | "clock-affected-data"
  | "context-not-fresh" | "archive-count-mismatch" | "change-count-mismatch"
  | "inconsistent-book-evidence" | "journal-data-incomplete";

export interface TailEntryReference {
  tokenId: string;
  outcome: string;
  secondIndex: number | null;
  startAtMs: number | null;
  /** The reference becomes available at the END of this complete second. */
  endAtMs: number | null;
  bookObservedAtMs: number | null;
  bookSourceAtMs: number | null;
  bestBid: string | null;
  bestAsk: string | null;
  status: TailBookStatus | null;
  /** Recorded state in the second immediately before entry, even if no valid reference exists. */
  entryStatus: TailBookStatus | null;
  clockAffected: boolean;
  quality: Pick<TailTokenQuality, "observedWindowComplete" | "snapshotAuditPassed" | "validSeconds"> | null;
  priceValid: boolean;
  contextStatus: TailSecond["contextStatus"] | null;
  contextFresh: boolean;
}

/** Selected token's half-open [entry, match finish) interval, in one-second bins. */
export interface TailPriceCoverage {
  expectedSeconds: number;
  recordedSeconds: number;
  validSeconds: number;
  observedSeconds: number;
  carriedSeconds: number;
  closedSeconds: number;
  partialSeconds: number;
  missingSeconds: number;
  invalidSeconds: number;
  staleSeconds: number;
  outsideRunSeconds: number;
  notYetKnownSeconds: number;
  /** An absent row is distinct from a recorded row with status "missing". */
  absentSeconds: number;
  clockAffectedSeconds: number;
  invalidationSeconds: number;
  changeCountsMatch: boolean;
  bookEvidenceCoherent: boolean;
  complete: boolean;
}
export interface TailContextCoverage {
  expectedSeconds: number;
  presentSeconds: number;
  missingSeconds: number;
  staleSeconds: number;
  disconnectedSeconds: number;
  absentSeconds: number;
  /** All outcome entry references must also have present context for the optional gate. */
  entryReferencesFresh: boolean;
  complete: boolean;
}

export interface TailTouchEvidence {
  kind: "book-ask" | "sell-print";
  evidenceSource: "change" | "second-close";
  observedAtMs: number;
  sourceAtMs: number | null;
  sequence: number | null;
  frameIndex: number | null;
  secondIndex: number;
  price: string;
  size: string | null;
}

export interface TailBacktestTrial {
  sourceId: string;
  sourceRunId: string;
  windowKey: string;
  gameId: string | null;
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  sport: string;
  marketId: string;
  marketSlug: string;
  conditionId: string;
  marketType: string;
  question: string;
  tokenId: string | null;
  outcome: string | null;
  windowBasis: "match-finish";
  fillModel: TailFillModel;
  bidPrice: string;
  windowSeconds: number;
  orderShares: number;
  queueAheadShares: number;
  makerFeeBps: number;
  finishAtMs: number | null;
  finishConflict: boolean;
  finishSources: string[];
  finishEvidence: TailBacktestFinishEvidence[];
  entryAtMs: number | null;
  expiryAtMs: number | null;
  referenceStartAtMs: number | null;
  referenceAtMs: number | null;
  referenceBookObservedAtMs: number | null;
  referenceBid: string | null;
  /** Null with a valid entry reference denotes observed empty ask depth. */
  referenceAsk: string | null;
  entryReferences: TailEntryReference[];
  tokenQuality: TailTokenQuality | null;
  priceCoverage: TailPriceCoverage;
  contextCoverage: TailContextCoverage;
  exclusions: TailBacktestExclusion[];
  /** Data/entry eligibility; an eligible modeled fill can still have unresolved PnL. */
  eligible: boolean;
  pnlEligible: boolean;
  touched: boolean;
  touchBookChangeCount: number;
  /** Closing snapshots at/below the limit, counted separately from change messages. */
  touchSecondCount: number;
  /** Direct SELL prints at or below the limit; BUY prints never count as touches. */
  touchTradeCount: number;
  touchSellShares: number;
  equalSellTradeCount: number;
  equalSellShares: number;
  sellThroughTradeCount: number;
  sellThroughShares: number;
  firstTouch: TailTouchEvidence | null;
  firstTouchAtMs: number | null;
  firstModeledFillAtMs: number | null;
  /** Null means excluded/unknown, not an observed no-fill. */
  modeledFilledShares: number | null;
  modeledCost: number | null;
  modeledFee: number | null;
  modeledPayout: number | null;
  /** Netted using exact decimal arithmetic before conversion to numeric output. */
  modeledPnl: number | null;
  payoutPerShare: number | null;
  settlement: TailSettlement | null;
  settlementVector: TailSettlement[];
}

export interface TailBacktestSummary {
  sport: string;
  marketType: string;
  bidPrice: string;
  windowSeconds: number;
  windowBasis: "match-finish";
  fillModel: TailFillModel;
  orderShares: number;
  queueAheadShares: number;
  makerFeeBps: number;
  trials: number;
  games: number;
  sources: number;
  eligibleTrials: number;
  excludedTrials: number;
  /** Eligible, positively filled trials without settlement, not unresolved zero-fills. */
  unresolvedTrials: number;
  pnlEligibleTrials: number;
  priceCompleteTrials: number;
  contextCompleteTrials: number;
  touchedTrials: number;
  modeledFilledTrials: number;
  settledFilledTrials: number;
  zeroFillTrials: number;
  /** Classified from exact net PnL before numeric output rounding. */
  winningFills: number;
  losingFills: number;
  breakEvenFills: number;
  splitPayoutFills: number;
  modeledFilledShares: number;
  /** All eligible modeled fills, including unresolved capital. */
  modeledCost: number;
  modeledFees: number;
  unresolvedFilledCost: number;
  unresolvedFilledFees: number;
  /** Payout/PnL totals include only pnlEligible trials; null if there are none. */
  modeledPayout: number | null;
  modeledPnl: number | null;
  /** Positive net PnL and absolute negative net PnL, respectively. */
  winnings: number;
  losses: number;
  pnlTrialDenominator: number;
  /** Cost + fees of resolved modeled fills only. */
  filledCapitalDenominator: number;
  pnlPerTrial: number | null;
  returnOnFilledCapital: number | null;
  exclusions: Partial<Record<TailBacktestExclusion, number>>;
}

export interface TailBacktestSource {
  sourceId: string;
  sourceRunId: string;
  sport: string;
  archiveWindowSeconds: number;
  firstReceivedAtMs: number;
  lastReceivedAtMs: number;
  windowKeys: string[];
  warnings: string[];
}
export interface TailBacktestResult {
  schemaVersion: 1;
  basis: "received-order-book-tail";
  execution: "hypothetical";
  options: EffectiveTailBacktestOptions;
  warnings: string[];
  sources: TailBacktestSource[];
  trials: TailBacktestTrial[];
  summaries: TailBacktestSummary[];
}
