# Continuous sports collector implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. Steps use checkbox tracking. Keep delegated file ownership disjoint; main owns integration and deployment.

**Goal:** Leave a public-only collector running across successive matches, with immutable per-finish exports, observable health and truthful quality labels.

**Architecture:** Extend the existing journal with an ordered sealing barrier rather than disconnecting streams to export. Add lifecycle retention and a supervisor that records actual journal observations, queues child-process exports, persists status and serves a loopback dashboard. Preserve legacy finite collection and strict replay quality.

**Tech Stack:** TypeScript, Node, Vitest, current public Gamma/CLOB/Sports clients, macOS user LaunchAgent.

## 1. Immutable journal checkpoints (independent worker)

Files: modify `src/collector/journal.ts`, `src/collector/tail-catalog.ts`; add `src/collector/sealed-journal.ts`, `tests/collector/journal-checkpoint.test.ts`.

Public contract:

```ts
interface JournalCheckpoint {
  runId: string;
  sourceRunDirectory: string;
  sequence: number;
  receivedAtMs: number;
  segments: string[];
}
// CollectorJournal.checkpoint(): Promise<JournalCheckpoint>
// sealJournalSnapshot(journal, newDirectory): Promise<{runDirectory: string; checkpoint: JournalCheckpoint}>
```

- [x] RED: record A, request checkpoint, immediately record B; assert sealed input ends at the checkpoint and never contains B while source contains both. Cover concurrent checkpoints, failed write/fsync, closed journal and existing output directory.
- [x] Run `npm test -- tests/collector/journal-checkpoint.test.ts`; confirm missing behavior.
- [x] Queue a `collector/checkpoint_end` marker with `data.sealed=true`; the writer must flush and close that segment before resolving. New records go to another segment. The snapshot links only sealed files and records provenance in `checkpoint.json`; never fabricate `session_end` or copy current live tails.
- [x] Permit the explicit sealed marker as a tail-catalog cutoff with a warning distinguishing it from a stopped collector; preserve all existing active-run rejection tests.
- [x] Verify journal/checkpoint/tail/export tests and typecheck. Do not commit other workers' files.

## 2. Truthful replay labels (independent worker)

Files: modify `src/collector/tail-view.ts`, `tests/collector/tail-view.test.ts` only.

- [x] RED: 300 valid book seconds plus 273 fresh context seconds must say prices can be viewed and scores are stale, not blanket “不可回放”. Closed markets must not say missing; outside-run and missing-finish must remain explicit.
- [x] Keep `readyForReplay` unchanged; derive display-only book usability from `observedWindowComplete && snapshotAuditPassed && validSeconds > 0`. Prefer an initially usable game/market when present without removing other choices.
- [x] Test zero-data/closed-only cases, missing finish, malicious metadata and unchanged offline depth indexing. Run `npm test -- tests/collector/tail-view.test.ts`.

## 3. Event retention and resilient discovery (main)

Files: add `src/collector/lifecycle.ts`, `src/collector/continuous-discovery.ts`; modify `src/collector/collector.ts`; add `tests/collector/lifecycle.test.ts`, `tests/collector/continuous-discovery.test.ts` and runtime regressions.

- [x] RED: terminal metadata retains previously observed subscriptions through grace, but closed tokens leave the HTTP snapshot list. A repeat terminal response cannot reset its grace clock. A later new event is admitted while old events retire.
- [x] Use a disabled-by-default lifecycle option for backward compatibility; continuous mode sets ten-minute grace. Do not use `endDate` for retirement. Requests that fail retain subscriptions without recording stale metadata as fresh.
- [x] Query configured tags independently (default tennis 864 and table-tennis 103767); one failing scope or related-game expansion reports its error while successful discovery proceeds. Existing missing-event reconciliation remains conservative and gains bounded concurrency for continuous mode.
- [x] Run targeted runtime/lifecycle/discovery tests and existing collector tests before integration.

## 4. Persistent status and nonblocking completed-game exports (main)

Files: add `src/collector/continuous-config.ts`, `src/collector/continuous-state.ts`, `src/collector/continuous.ts`, `src/collector/continuous-export.ts`; corresponding `tests/collector/continuous-*.test.ts`.

- [x] RED: journal observations classify first-seen/first-book, active connections, per-game counters, known finish and raw-run references without claiming reconstructed-book completeness. Persist owned JSON atomically and restore old active games as awaiting new observations.
- [x] Configuration supplies data root, sport tags, 30s discovery, 60s HTTP audit, 10-minute finish grace, 20 GiB reserve, loopback port and proxy. Validate before starting sockets or writing outside the chosen root.
- [x] RED: completed A creates an immutable snapshot and queues exactly one export while B keeps recording; missing actual finish stays pending. Launch tail export in a child process, one job at a time, bounded output capture and cancellation; store failed artifacts and retry into a new directory.
- [x] RED: fatal collector failure retries with backoff/new run; low disk gracefully closes collection without deleting data and resumes when space recovers. Stop cancels timers, requests and owned children. Active process lock prevents duplicate writers.
- [x] Verify with real temporary files and controlled transport/process boundaries, including interrupted job recovery.

## 5. Local service and dashboard (main)

Files: add `src/collector/continuous-server.ts`, `src/collector/continuous-service.ts`, `src/collector/continuous-cli.ts`; modify `package.json`; add CLI/server/service tests.

- [x] RED: start/stop/status/help dispatch without trading code; render actual health and per-game phases; loopback file serving only exposes registered export files and rejects traversal.
- [x] Provide `collect:continuous`, `collect:start`, `collect:stop`, `collect:status`; generated user LaunchAgent uses stable project paths, restart throttling and owned logs. Detect existing service/lock before changes. No privileged install or foreign-process kill.
- [x] Serve status on loopback only, with explicit disk/network warnings and links to completed artifacts. Data collection continues after the terminal/chat closes; notebook sleep/shutdown limits remain visible.
- [x] Run CLI/server/service integration tests using temporary configuration and injected process commands; do not install test services into the user's login domain.

## 6. Review, integration and actual operation

- [x] Independent spec and correctness reviews for checkpoint/storage, lifecycle/supervisor and viewer changes; reproduce and fix material findings using RED/GREEN tests.
- [x] Fresh `npm test`, `npm run typecheck`, `git diff --check`; update README and `docs/continuous-collector.md` with actual commands, storage limits and known data-source limits.
- [ ] Locally integrate while preserving the two untracked user notes and existing raw samples. Install/start only this user's public collector on the chosen machine; verify real raw files grow, discovery/subscriptions and both public streams are observable, and status page works.
- [ ] Verify actual startup/restart without fabricating completed-match coverage. Leave the authorized service running, provide the status URL and stop command, and report any unavailable sport/state fields explicitly.

## Verified implementation notes (2026-09-14)

- Full worktree verification: 72 files / 1,999 tests; typecheck and whitespace checks passed. Independent checkpoint/viewer, runtime/data-integrity, service-ownership and clock/facts reviews passed within scope.
- Actual large-catalog metadata overflow and slow per-token snapshot startup were reproduced and fixed with controlled-producer backpressure, nonblocking warmup and public batch-book reads.
- Bounded UTC backsteps retain original records and invalidate only overlapping bins; large clock drift requests a new collector run. Normalized cross-run finish facts import boundaries only. Original book runs remain the price source.
- Finish lookups now rotate oldest-attempt-first; a 15-game regression demonstrated and fixed starvation behind the first 12 retrying games.
- Two bootstrap collectors recorded several hours and were stopped gracefully only after the new supervisor had public WebSocket data. The current supervisor continues writing under the main data root during integration.
- Real Kichenok–Hibino re-export: 6 active directions each with 300 book seconds; 256 fresh-context seconds, 0 clock-affected seconds in its tail, 6 price-ready and 0 strict-ready. Source UTC backstep was outside its window; original times were not rewritten.
- Native LaunchAgent installation and post-merge live restart checks remain the final operational gate.
