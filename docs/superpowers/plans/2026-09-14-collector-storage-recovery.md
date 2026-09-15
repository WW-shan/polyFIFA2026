# Collector Storage Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Track with checkboxes. Main owns integration, compressed storage and real deployment; a worker owns discovery deduplication/scope only.

**Goal:** Restore truthful continuous sports collection using compact discovery records and byte-verified lossless journal storage, then progress through data-quality and backtest acceptance.

**Architecture:** Keep logical segment names stable while accepting plain/gzip physical files. Publish all verified compressed hardlink aliases before replacing originals. Preserve the real-time NDJSON writer and move maintenance out of stream callbacks. Preserve raw HTTP responses once and replace duplicate page bodies with provenance references.

**Tech Stack:** TypeScript, Node fs/zlib/crypto/streams, Vitest, current public collector and user LaunchAgent.

---

## Task 1 — New-record deduplication and single-match scope (worker)

Files: `src/collector/collector.ts`, `src/collector/catalog.ts`, `src/collector/continuous-discovery.ts`, new `src/collector/match-scope.ts`; targeted collector/discovery tests. Main enables options in `continuous.ts` after review.

- [x] RED: a real temporary journal records one large HTTP response body in compact mode; its page observation has an earlier same-run reference and matching SHA-256, no second body. Legacy mode remains unchanged; untracked custom callback responses remain recorded.

```ts
// CollectorOptions addition, default false outside continuous mode:
compactDiscoveryPages?: boolean;
// CatalogOptions addition, default false for existing callers:
singleMatchOnly?: boolean;
// A compact observation is not a reconstructed HTTP response:
// {source:"gamma",kind:"discovery_page_ref",data:{url,requestStartedAt,
// requestEndedAt,responseRef:{runId,sequence,sha256,bytes}}}
```

- [x] Run `npm test -- tests/collector/collector-discovery-storage.test.ts tests/collector/match-scope.test.ts`; confirm intended failures before changing production code.
- [x] Retain original successful/failed HTTP recording, correlate object responses with bounded/weak ownership, and write compact page observations only after the source record is committed. Preserve per-event observation times and HTTP audit behavior.
- [x] Single-match tests cover gameId matches, no-gameId ITF/Setka titles, related side markets, doubles, tournament winners, year rankings and coupon questions. Keep zero-volume outcomes; do not use endDate as an actual match endpoint.
- [x] Run collector, discovery, lifecycle and metadata replay regressions; spec review then correctness review before integration.

## Task 2 — Mixed plain/gzip reads (main)

Files: new `src/collector/journal-segments.ts`; modify `journal.ts`, `journal-reader.ts`, `sealed-journal.ts`, `tail-catalog.ts`, `continuous-storage.ts`; new `tests/collector/journal-compression.test.ts`.

- [x] RED: write a closed test journal, gzip its exact bytes, remove only that test's plain file, then require identical records and logical names; mixed physical formats yield each logical segment once. Corrupt gzip rejects.

```ts
export interface ResolvedJournalSegment {
  path: string;
  compressed: boolean;
  stamp: import("node:fs").Stats;
}
export function resolveJournalSegment(logicalPath: string): Promise<ResolvedJournalSegment>;
export function readJournalSegment(logicalPath: string): AsyncGenerator<Buffer>;
export function readJournalSegmentPrefix(logicalPath: string, bytes: number): Promise<Buffer>;
export function readJournalSegmentSuffix(logicalPath: string, bytes: number): Promise<Buffer>;
```

- [x] Run the targeted tests red, then implement safe no-follow resolution and streaming gzip reads. Plain wins during migration. Reject directories/symlinks and propagate decompression errors. Destroy streams and close handles on error and early return.
- [x] Enumerate logical names, resolve physical files for replay fingerprints, and link the matching physical representation when sealing. Keep cutoff/header provenance checks and explicit original logical names in checkpoint manifests.
- [x] Verify old plain replay, compressed replay, suffix checkpoint export, UTF-8 split boundaries, truncation and corruption tests.

## Task 3 — Verified hardlink-aware migration (main)

Files: new `src/collector/journal-compression.ts`, `src/collector/storage-cli.ts`; compression tests; package scripts.

- [x] RED: two hardlinks to a sealed segment become two links to one verified gzip; decompressed SHA-256 equals the original, bytes/sequences unchanged. Active tails, outside aliases, existing unequal targets and symlinks are refused. Interruptions leave readable/retryable data.

```ts
export interface CompressionResult {
  originalBytes: number;
  compressedBytes: number;
  sha256: string;
  aliases: string[];
}
// Originals may be unlinked only after all aliases and verification metadata
// have been published and synced. Never mutate the original inode in place.
```

- [x] Run red tests; implement checked inventory, exclusive temporary output, source/hash checks, gzip round-trip, durable integrity sidecars and alias publication. Verify any existing target before reuse; never overwrite it speculatively.
- [x] Provide a public-data-only CLI to inventory/compact explicit owned storage roots and emit per-file results. A failed group preserves evidence and cannot be reported as reclaimed.
- [x] Run targeted failure/recovery tests, full tests, typecheck and independent spec/correctness review.

## Task 4 — Continuous maintenance and actual recovery (main)

Files: `continuous.ts`, `continuous-config.ts`, `continuous-state.ts`, `continuous-server.ts`, compression runner/CLI; continuous tests; operating docs.

- [x] RED: scheduled maintenance never selects the live tail or races active export; shutdown cancels owned maintenance; errors remain observable; subsequent archive and collection still proceed.
- [x] Enable compact discovery and single-match scope in continuous mode. Coordinate bounded background compression with exports; keep disk reserve/hysteresis unchanged and show actual stored bytes/maintenance errors.
- [x] Integrate locally, stop only this service when needed for the initial migration, migrate authorized closed captures and compare a known archive before/after. Do not touch the two user notes or any unrelated data.
- [x] Restart and verify actual new records, raw growth, sports/market connections, continued discovery and new completed-game quality. Leave the service operating unless a concrete external blocker remains.

## Task 5 — Quality and research continuation (after recovery)

- [x] Audit new matches separately for last-300-second price coverage, context freshness and finish-source conflicts. Keep every failed/unknown sample visible.
- [x] Inspect existing research/backtest entry points and source phase fields; derive phase windows only from supported terminal evidence, with uncertainty stated for observed transitions. No trustworthy independent set/game terminal evidence was found; diagnostics remain explicit.
- [x] Run an initial saved-data hanging-limit-price sweep, retain input provenance/quality eligibility and distinguish price touches from confirmed fills/settlement. Report tennis and table-tennis sample counts and limitations before extending other sport profiles.

## Verified follow-through on 2026-09-16

- [x] Fix quadratic long-line framing without weakening JSON/envelope or gzip checks; real identical-content benchmark 1,263 → 253 ms. Regression bounds both newline searches and copied bytes.
- [x] Raise deployed compression batch 4 → 64; retain the 20/21-GiB reserve/hysteresis and 120-second maintenance deadline. Record actual restart gaps.
- [x] Recover completed archive visibility independently of the evictable live-game cache. Read-only catalog, bounded paging, guarded legacy fallback, and gzip download paths passed spec and quality review.
- [x] Add optional verified compression of the sealed generated raw-evidence copy; source journals and depth byte indexes remain unchanged. The real 301-second sample kept identical seconds/changes/quality and reduced raw evidence 226,887,270 → 24,948,335 bytes.
- [x] Continuous exports include 1 second of pre-roll. Initial 29-game report includes all quality exclusions, not just qualifying markets.

## Still unfulfilled data coverage (not hidden by completed engineering tasks)

- [ ] Obtain trustworthy, exactly matched table-tennis/ITF live state and actual finish evidence; current captured books alone cannot supply these missing fields.
- [ ] Export independent per-set/per-game last-five-minute windows once their own terminal evidence exists; never substitute whole-match finish.
- [ ] Deploy additional sport profiles after verifying their tags, live-state mapping and capacity. Generic multi-profile support is not evidence that additional sports are already collecting.

## Baseline and approval

- User authorized verified lossless replacement and requested sequential completion of the listed work; no new hosting or trading authority is assumed.
- Existing worktree: `.worktrees/continuous-collector`, branch `codex/continuous-collector`, base `a886419`.
- Fresh baseline: 72 files / 1,999 tests passed before new changes.
- At the baseline the service was `paused_disk`. Recovery and subsequent real gaps, data receipt, archival and research evidence are recorded in `docs/continuous-collector.md`; a running PID is not continuity proof.
