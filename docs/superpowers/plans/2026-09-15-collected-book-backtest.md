# Collected Orderbook Backtest Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the pure simulation slice, then separate spec and correctness review. Main owns archive loading, public settlement evidence, CLI/report files and actual execution. Track steps with checkboxes.

**Goal:** Run the user's resting-limit-price research against captured second-by-second books and intra-second changes, with explicit quality and fill assumptions.

**Architecture:** Keep the existing Data API trade-history backtest unchanged. Add an archive-based engine over `quality.json`, `seconds.ndjson` and `changes.ndjson`; resolve settlement only from matching, confirmed public metadata. Select the entry side from a book known before entry, never from the later winner. Write a new standalone report without modifying archives.

**Tech Stack:** TypeScript, existing TailSummary/TailSecond/TailBookChange types, decimal parsing helpers, existing CSV escaping, public Gamma/CLOB clients, Vitest.

## Contract and defaults

```ts
interface TailBacktestInput {
  sourceId: string;
  sport: string;
  summary: TailSummary;
  seconds: readonly TailSecond[];
  changes: readonly TailBookChange[];
  settlements?: readonly TailSettlement[];
}
interface TailSettlement {
  marketId: string; conditionId: string; tokenId: string;
  payout: number; source: "gamma-resolved-prices" | "clob-winner-flags";
  observedAtMs: number; sourceUrl: string;
}
interface TailBacktestOptions {
  prices?: string[]; windowsSeconds?: number[]; entryMinBid?: string;
  shares?: number; queueAheadShares?: number; makerFeeBps?: number;
  fillModel?: "quote-touch-assumed" | "sell-through-volume";
  requireFreshContext?: boolean;
}
// backtestTailArchives(inputs, options) -> options, warnings, trials, summaries.
```

Defaults: prices `0.50,0.60,0.70,0.80,0.90,0.95,0.97,0.99`; windows 60/180/300 seconds; entry minimum bid 0.90; one share; zero maker fee and queue-ahead; quote-touch assumption; price-only eligibility with score coverage shown separately. These are configurable starting research assumptions, not a claimed best strategy.

An entry reference must come from a whole valid second ending at or before entry. A normal 300-second archive cannot supply its own pre-entry quote at the 300-second boundary; use a 301-second export or label that trial as missing reference. The real gzip re-export already supplies one second of pre-roll and its overlapping 9,600 rows were identical to the earlier export.

## 1. Pure engine (worker)

Files: `src/research/tail-backtest-types.ts`, `src/research/tail-backtest.ts`, `tests/research/tail-backtest.test.ts`.

- [x] RED tests for observed favorite selection independent of settlement, exact prior reference boundary, intra-second ask dip and recovery, no marketable resting bid, invalid/missing/clock-affected data, optional score freshness, unresolved payout, duplicate source/game identity, shuffled settlement token order and mismatched conditions.
- [x] RED tests distinguish an assumed price touch (ask at/below limit or direct SELL print at/below) from SELL volume strictly below the bid, with size/queue caps. BUY/equal prints cannot create strict-through volume.
- [x] Preserve price strings and compare decimals exactly. Validate identities and actual finish clocks; do not use endDate. Do not hide excluded trials or count missing data as no fill.
- [x] Entry selection is highest observed bid among the market outcomes, with deterministic non-winner tie breaking. Require all outcome entry references; use at most the configured requested window. Apply existing price coverage and snapshot audit requirements; scores are separate unless requested. A validated, explicitly empty ask side is non-marketable, not missing depth.
- [x] Group results by sport, market type, price, window and model. Report eligible/excluded/unresolved, touches, modeled fills, cost/PnL and per-trial/filled-capital returns separately. Unresolved filled trials have null PnL and never become zero-loss observations. Do not combine overlapping scenarios as portfolio returns.
- [x] Run focused and existing research regressions, typecheck, self-review, commit only worker files; spec review followed by correctness review. Review fixes cover contradictory closed rows and exact decimal PnL signs, including true break-even and tiny genuine gains/losses.

## 2. Archive loader, evidence and report (main)

Files: `src/research/tail-backtest-cli.ts`, `src/research/tail-backtest-io.ts`, targeted tests, package script and operating docs.

- [x] Read bounded, registered/explicit archive files; validate complete manifests, row counts, identities and file fingerprints. Keep source paths/hashes in report provenance. Refuse an existing output directory. Pin the canonical output outside all input archives and recheck after network requests.
- [x] Read original Gamma resolution evidence with the existing `resolvePayouts`; optional new public observations are stored separately. Match event/market/condition/token IDs, never team-name guesses or array positions. Missing/conflicting/unresolved evidence stays explicit. Compare every archived raw copy, preserve conflicts, and verify fetched markets belong to that event.
- [x] Write JSON, escaped summary/trial CSV and a readable local report. Keep price touches and modeled fills visibly different from actual orders; no signing or trading imports.
- [x] Run on the verified 301-second tennis archive and the other available completed archives, report the small sample and all quality exclusions. Table-tennis without reliable finish/coverage cannot masquerade as a successful backtest.

## 3. Live data/phase follow-through (main)

- [x] Verify the restored collector records new matches, continues raw growth and scheduled compression, and produces new finished-match artifacts.
- [x] Inspect observed score/period transitions and actual per-phase endpoint fields. Export independent phase windows only when supported by explicit evidence; otherwise retain a diagnostic rather than relabel the match finish as a set/game finish. Current source limitations are recorded in the operating document; independent phase windows are not implemented.
- [x] Enable approved single-match scope, retain all captured history, and keep newly discovered/provisional quality visible. Other sports profiles require validated public tags and the same quality rules; no extra profile deployment is claimed.

## Execution evidence (2026-09-16)

`research:books` is the new command. Initial source selection takes the latest complete export for every distinct game at the selection cutoff, irrespective of price, winner, touch or profitability. The directory contains 32 complete artifacts but only 29 distinct games because verification exports duplicate a match. Incomplete attempts are reported separately rather than silently treated as no-fill samples.

`data/research/collected-books/20260916-tennis-touch/` contains the saved first run: 29 sources, 11,856 scenarios, 996 eligible scenarios from 22 games / 81 markets, 7 assumed-touch scenarios. No qualifying 0.50/0.60/0.70/0.80 touches occurred in this small sample. Input hashes, raw public settlement responses and excluded scenarios are preserved. These are hypothetical overlapping scenarios, not executed trades or a proven optimum.

The companion `20260916-tennis-sell-through/` report reuses the exact input files and all 988 confirmed settlement labels / 30 original HTTP observations. It has the same 7 price touches and zero strict-through modeled fills. No new network requests were used for this model comparison.

The source and field gap remains open: Setka and ITF books are being collected, but reliable matched scores/actual finish and independent set/game endpoints are still missing. See the unchecked coverage tasks in `2026-09-14-collector-storage-recovery.md`.
