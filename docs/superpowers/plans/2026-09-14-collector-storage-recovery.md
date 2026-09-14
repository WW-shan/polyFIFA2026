# Collector Storage Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Track with checkboxes. Main owns integration, compressed storage and real deployment; a worker owns discovery deduplication/scope only.

**Goal:** Restore truthful continuous sports collection using compact discovery records and byte-verified lossless journal storage, then progress through data-quality and backtest acceptance.

**Architecture:** Keep logical segment names stable while accepting plain/gzip physical files. Publish all verified compressed hardlink aliases before replacing originals. Preserve the real-time NDJSON writer and move maintenance out of stream callbacks. Preserve raw HTTP responses once and replace duplicate page bodies with provenance references.

**Tech Stack:** TypeScript, Node fs/zlib/crypto/streams, Vitest, current public collector and user LaunchAgent.

---

## Task 1 — New-record deduplication and single-match scope (worker)

Files: `src/collector/collector.ts`, `src/collector/catalog.ts`, `src/collector/continuous-discovery.ts`, new `src/collector/match-scope.ts`; targeted collector/discovery tests. Main enables options in `continuous.ts` after review.

- [ ] RED: a real temporary journal records one large HTTP response body in compact mode; its page observation has an earlier same-run reference and matching SHA-256, no second body. Legacy mode remains unchanged; untracked custom callback responses remain recorded.

```ts
// CollectorOptions addition, default false outside continuous mode:
compactDiscoveryPages?: boolean;
// CatalogOptions addition, default false for existing callers:
singleMatchOnly?: boolean;
// A compact observation is not a reconstructed HTTP response:
// {source:"gamma",kind:"discovery_page_ref",data:{url,requestStartedAt,
// requestEndedAt,responseRef:{runId,sequence,sha256,bytes}}}
```

- [ ] Run `npm test -- tests/collector/collector-discovery-storage.test.ts tests/collector/match-scope.test.ts`; confirm intended failures before changing production code.
- [ ] Retain original successful/failed HTTP recording, correlate object responses with bounded/weak ownership, and write compact page observations only after the source record is committed. Preserve per-event observation times and HTTP audit behavior.
- [ ] Single-match tests cover gameId matches, no-gameId ITF/Setka titles, related side markets, doubles, tournament winners, year rankings and coupon questions. Keep zero-volume outcomes; do not use endDate as an actual match endpoint.
- [ ] Run collector, discovery, lifecycle and metadata replay regressions; spec review then correctness review before integration.

## Task 2 — Mixed plain/gzip reads (main)

Files: new `src/collector/journal-segments.ts`; modify `journal.ts`, `journal-reader.ts`, `sealed-journal.ts`, `tail-catalog.ts`, `continuous-storage.ts`; new `tests/collector/journal-compression.test.ts`.

- [ ] RED: write a closed test journal, gzip its exact bytes, remove only that test's plain file, then require identical records and logical names; mixed physical formats yield each logical segment once. Corrupt gzip rejects.

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

- [ ] Run the targeted tests red, then implement safe no-follow resolution and streaming gzip reads. Plain wins during migration. Reject directories/symlinks and propagate decompression errors. Destroy streams and close handles on error and early return.
- [ ] Enumerate logical names, resolve physical files for replay fingerprints, and link the matching physical representation when sealing. Keep cutoff/header provenance checks and explicit original logical names in checkpoint manifests.
- [ ] Verify old plain replay, compressed replay, suffix checkpoint export, UTF-8 split boundaries, truncation and corruption tests.

## Task 3 — Verified hardlink-aware migration (main)

Files: new `src/collector/journal-compression.ts`, `src/collector/storage-cli.ts`; compression tests; package scripts.

- [ ] RED: two hardlinks to a sealed segment become two links to one verified gzip; decompressed SHA-256 equals the original, bytes/sequences unchanged. Active tails, outside aliases, existing unequal targets and symlinks are refused. Interruptions leave readable/retryable data.

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

- [ ] Run red tests; implement checked inventory, exclusive temporary output, source/hash checks, gzip round-trip, durable integrity sidecars and alias publication. Verify any existing target before reuse; never overwrite it speculatively.
- [ ] Provide a public-data-only CLI to inventory/compact explicit owned storage roots and emit per-file results. A failed group preserves evidence and cannot be reported as reclaimed.
- [ ] Run targeted failure/recovery tests, full tests, typecheck and independent spec/correctness review.

## Task 4 — Continuous maintenance and actual recovery (main)

Files: `continuous.ts`, `continuous-config.ts`, `continuous-state.ts`, `continuous-server.ts`, compression runner/CLI; continuous tests; operating docs.

- [ ] RED: scheduled maintenance never selects the live tail or races active export; shutdown cancels owned maintenance; errors remain observable; subsequent archive and collection still proceed.
- [ ] Enable compact discovery and single-match scope in continuous mode. Coordinate bounded background compression with exports; keep disk reserve/hysteresis unchanged and show actual stored bytes/maintenance errors.
- [ ] Integrate locally, stop only this service when needed for the initial migration, migrate authorized closed captures and compare a known archive before/after. Do not touch the two user notes or any unrelated data.
- [ ] Restart and verify actual new records, raw growth, sports/market connections, continued discovery and new completed-game quality. Leave the service operating unless a concrete external blocker remains.

## Task 5 — Quality and research continuation (after recovery)

- [ ] Audit new matches separately for last-300-second price coverage, context freshness and finish-source conflicts. Keep every failed/unknown sample visible.
- [ ] Inspect existing research/backtest entry points and source phase fields; derive phase windows only from supported terminal evidence, with uncertainty stated for observed transitions.
- [ ] Run an initial saved-data hanging-limit-price sweep, retain input provenance/quality eligibility and distinguish price touches from confirmed fills/settlement. Report tennis and table-tennis sample counts and limitations before extending other sport profiles.

## Baseline and approval

- User authorized verified lossless replacement and requested sequential completion of the listed work; no new hosting or trading authority is assumed.
- Existing worktree: `.worktrees/continuous-collector`, branch `codex/continuous-collector`, base `a886419`.
- Fresh baseline: 72 files / 1,999 tests passed before new changes.
- Current service remains `paused_disk` until safe recovery is actually demonstrated.
