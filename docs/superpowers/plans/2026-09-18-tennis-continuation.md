# Tennis Collector Continuation and Freshness Repair

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Finish the interrupted gzip/checkpoint repair, make stalled collection visibly stale, and verify the saved tennis research with reproducible counts before safely recovering the collector.

**Architecture:** Continue the approved continuous-collector/storage-recovery design; do not add sports, change trading, weaken integrity checks, or lower the 20-GiB reserve. A status read must not manufacture a new progress timestamp. State publication advances that timestamp, while the dashboard and service status separately check data receipt freshness.

**Tech Stack:** TypeScript, Node streams, Vitest, existing read-only HTTP dashboard and macOS LaunchAgent.

**Workspace:** `.worktrees/tennis-resume-20260918`, branch `codex/tennis-resume-20260918`, base `7eb7273`. Preserve the two existing modified files and three user notes. Integrate verified changes back into the original working tree without committing unrelated work.

## Task 1 — Verify and cover the real checkpoint barrier

Files: existing `src/collector/journal-segments.ts`; `tests/collector/journal-compression.test.ts` or a dedicated `tests/collector/journal-checkpoint-gzip-lifecycle.test.ts`.

- [x] Review the existing cancellation/integrity patch against HEAD. Independent review: 117 focused tests and seven extra synthetic cases pass, no leaked handles observed.
- [x] Add a regression using an actual journal, sealed and gzip-compressed incompressible history larger than the 64-KiB stream buffer, followed by a second real checkpoint and a queued later record.
- [x] Require checkpoint/flush completion, byte-exact persistence of the later record, and cleanup of reader/writer handles. Verify RED against the old reader in an isolated scratch copy; do not replace shared source during concurrent tests.
- [x] Run `npm test -- tests/collector/journal-compression.test.ts tests/collector/journal-checkpoint-gzip-lifecycle.test.ts --maxWorkers=2` (only existing paths).

## Task 2 — Test truthful freshness before implementation

Files: `tests/collector/continuous-state.test.ts`, `tests/collector/continuous.test.ts`, `tests/collector/continuous-server.test.ts`, `tests/collector/continuous-service.test.ts`.

- [x] RED: a read-only state snapshot must keep the last explicitly published timestamp despite clock advancement. Use a spied `Date.now` and restore it in `finally`:

```ts
const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
try {
  const state = new ContinuousState("/capture", 8765);
  clock.mockReturnValue(90_000);
  expect(state.snapshot().updatedAtMs).toBe(1000);
  state.markUpdated(80_000);
  expect(state.snapshot().updatedAtMs).toBe(80_000);
} finally { clock.mockRestore(); }
```

- [x] RED: run a paused-disk supervisor with injected time. After start, advance time and read status without calling pulse: timestamp is unchanged. After `await manager.pulse()`, live and persisted timestamps advance to injected time. Assert the configured freshness deadline is `pulseIntervalMs * 3`.
- [x] RED: dashboard tests use an injectable browser clock. A stale supervisor timestamp warns even with recent records; a fresh timestamp plus >60-second-old or missing receipts warns of stalled collection. Old open connections are labeled historical/stale, not asserted live. Fresh paused-disk status stays visibly paused rather than being called a stalled capture.
- [x] RED: a live matching service PID with a freshly persisted state but stale/missing collection receipts yields `stateIdentity: "job", stale: true` and a `CONTINUOUS_SERVICE_DATA_STALE` diagnostic. Paused-disk/no-records is not a capture-stall error.

## Task 3 — Minimal freshness repair

Files: `src/collector/continuous-state.ts`, `src/collector/continuous.ts`, `src/collector/continuous-server.ts`, `src/collector/continuous-service.ts`.

- [x] Keep a stored state-publication timestamp and optional backwards-compatible `stateStaleAfterMs` in the status schema:

```ts
private updatedAtMs = this.startedAtMs;
constructor(readonly dataRoot: string, readonly port: number, readonly stateStaleAfterMs = 15_000) {}
markUpdated(atMs = Date.now()): void { this.updatedAtMs = atMs; }
```

  `snapshot()` returns these stored values; it never calls the clock to refresh status. The manager supplies `config.pulseIntervalMs * 3` to the constructor. In the serialized persistence operation, call `this.state.markUpdated(this.now())` immediately before capturing/writing the actual state.
- [x] Compute dashboard freshness using recorded `updatedAtMs` and `lastRecordAtMs`, not successful HTTP fetches. Honor `stateStaleAfterMs` with a 15-second legacy default; use 60 seconds for receipt/connection age. Retain `textContent`, CSP and the existing failed-fetch warning.
- [x] In service status, preserve process-identity verification but set `stale` when collecting without a receipt within 60 seconds. Do not classify an intentional disk pause as failed collection.
- [x] Run all four affected test files plus the journal regression; run typecheck. No timeout increases.

## Task 4 — Research and operational evidence

Files: `docs/collector-source-audit-2026-09-16.md`, a concise dated tennis verification note, small evidence JSON under ignored `data/research/source-evidence/`.

- [x] Verify report manifests, source provenance and scenario counts. Record 30 sources / 12,240 scenarios / 1,044 eligible / 23 games / 44 game-window pairs / 83 markets. Distinguish seven eligible touch scenarios across five games from a per-parameter-group maximum of two; strict-volume model has no modeled fills. Check counts from actual files rather than trusting this expected baseline.
- [x] Preserve a compact pre-restart observation: old PID, receipt time, persisted last sequence/kind, disk capacity, and hash/size evidence. Record the actual gap without inventing missing data.
- [x] Deploy only verified changes, stop only the owned service and restart using its existing public-data configuration. Honor the existing reserve; allow verified lossless compression of sealed history to recover capacity. Do not delete raw data.
- [x] Verify advancing disk writes and real tennis book/trade records, not merely an open socket. If capacity/source availability prevents resumption, report the actual paused state and remaining prerequisite.
- [x] Run `npm run typecheck`, `npm test -- --maxWorkers=2`, and `git diff --check` in the final working tree. Report exact fresh results and remaining coverage/settlement limitations.

## Baseline

The initial unconstrained full suite hit the existing 5-second locked-refill stress-test timeout under concurrent load (2,515 passed). The isolated stress test and a complete two-worker run passed: 89 files, 2,516 tests, no timeout changes. This is a resource-concurrency issue observed before new implementation, not hidden as a clean first run.


## Completion evidence

- Real checkpoint regression: old reader failed at the bounded checkpoint-list phase (2,591 ms); patched reader passed (109 ms). Focused journal tests: 118/118; final full suite: 90 files, 2,527/2,527.
- Freshness RED: eight intended failures, then all 147 affected tests passed. Independent review found a contradictory connection headline; three additional failing assertions proved it, the shared current-connection predicate fixed it, and the reviewer approved the delta.
- Both 30-source backtests reproduced all 12,240 trials and 264 summaries exactly; report/source hashes were verified without new network requests or duplicate large output.
- Restarted only the owned service. It honored low-disk pause, losslessly compressed sealed data and resumed with verified newly persisted tennis books and public-trade events. The historical gap and missing upstream snapshot/finish/settlement evidence remain explicitly documented, not reclassified as complete data.
- See `docs/tennis-continuation-verification-2026-09-18.md` for dates, paths, current observations and remaining limitations. No git commit/push performed.
