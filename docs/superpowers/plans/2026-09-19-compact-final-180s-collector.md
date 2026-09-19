# Compact Final-180s Collector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change continuous collection so it retains only bounded, deduplicated final-180-second match evidence in SQLite instead of writing an unbounded full raw stream to NDJSON.

**Architecture:** Keep the existing discovery, Sports lifecycle, identity validation, and tail export concepts. Add a synchronous `node:sqlite` compact store with a 210-second staging horizon and a 180-second finalized match table. Make the journal persistence policy configurable: compact mode still constructs every record for state/lifecycle processing, but does not persist raw WebSocket frames or redundant HTTP/book snapshots. On match retirement, commit the bounded records to SQLite and prune staging/database/raw artifacts by age and byte caps.

**Tech Stack:** TypeScript/NodeNext, Node 26 `node:sqlite`, existing Vitest tests, existing `CollectorJournal` and `ContinuousCollector`.

---

### Task 1: Add journal admission filtering without changing record sequencing

**Files:**
- Modify: `src/collector/journal.ts:13-19,68-114,142-189`
- Test: `tests/collector/journal.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests proving that a `persistRecord` predicate can reject a record while `record()` still returns a normal `JournalRecord`, increments sequence, and allows the next accepted record to be written. Add a checkpoint test proving checkpoint sequence remains monotonic when filtered records occur.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
npm test -- tests/collector/journal.test.ts
```

Expected: TypeScript/test failure because `persistRecord` is not yet part of `JournalOptions`.

- [ ] **Step 3: Implement the minimal admission hook**

Add `persistRecord?: (record: JournalRecord) => boolean` to `JournalOptions` and store it in `CollectorJournal`. Build the record and sequence exactly as today. Invoke the predicate after JSON serialization but before queue-size admission; when it returns `false`, increment the sequence and return the record without queueing it. Always persist checkpoint records passed with a waiter.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm test -- tests/collector/journal.test.ts
```

Expected: all journal tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/collector/journal.ts tests/collector/journal.test.ts
git commit -m "feat: allow bounded journal record admission"
```

### Task 2: Create the SQLite compact tail store

**Files:**
- Create: `src/collector/continuous-tail-store.ts`
- Test: `tests/collector/continuous-tail-store.test.ts`

- [ ] **Step 1: Write failing store tests**

Cover these behaviors with a temporary database directory:

```ts
const store = openCompactTailStore({
  dataRoot: root,
  tailWindowMs: 180_000,
  bufferMs: 30_000,
  retentionMs: 30 * 24 * 3600_000,
  maxBytes: 8 * 1024 ** 3,
  now: () => now
});
```

Tests must prove:

1. identical consecutive payloads for one game are stored once;
2. records older than `tailWindowMs + bufferMs` are removed from staging;
3. finalization copies only `[finish-180s, finish]` records into the finalized table;
4. a second finalization is idempotent;
5. payload blobs are compressed and shared by hash;
6. retention deletes oldest completed matches and their orphan payloads;
7. reopening the database preserves finalized rows.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
npm test -- tests/collector/continuous-tail-store.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the schema and store API**

Implement `openCompactTailStore()` and `CompactTailStore` with:

```ts
export interface CompactTailStoreOptions {
  dataRoot: string;
  tailWindowMs: number;
  bufferMs: number;
  retentionMs: number;
  maxBytes: number;
  now?: () => number;
}

export interface CompactTailStoreStatus {
  databasePath: string;
  databaseBytes: number;
  stagingRecords: number;
  finalizedMatches: number;
  finalizedRecords: number;
  pendingRecords: number;
  lastMaintenanceAtMs: number | null;
  lastMaintenanceDeletedMatches: number;
  lastMaintenanceDeletedRecords: number;
}

class CompactTailStore {
  ingest(record: JournalRecord, gameKeys: readonly string[]): void;
  flush(): void;
  finalize(game: CapturedGame, finishAtMs: number): void;
  maintain(nowMs?: number): void;
  snapshot(): CompactTailStoreStatus;
  close(): void;
}
```

Use `DatabaseSync` and create `matches`, `payloads`, `staging_records`, and `tail_records` with `WITHOUT ROWID` composite primary keys. Store the stable `{source, kind, connectionId, data}` payload compressed with `deflateRawSync`; keep sequence/timestamp/game identity in relational columns. Use one transaction per flush/finalize/maintenance operation. Use `INSERT OR IGNORE` for payloads and primary-key rows.

Use a 210-second staging horizon and a `lastHashByGame` map so repeated consecutive book/status payloads do not create rows. `maintain()` deletes expired staging rows, old finalized matches, orphan payloads, then runs bounded incremental vacuum. If the database remains over `maxBytes`, delete oldest finalized matches until below 80% of the cap; never delete staging rows for the current buffer before the normal horizon.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/collector/continuous-tail-store.test.ts
npm run typecheck
```

Expected: focused tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/collector/continuous-tail-store.ts tests/collector/continuous-tail-store.test.ts
git commit -m "feat: add bounded sqlite tail store"
```

### Task 3: Expose record-to-game and newly-finished identities from continuous state

**Files:**
- Modify: `src/collector/continuous-state.ts`
- Test: `tests/collector/continuous-state.test.ts`

- [ ] **Step 1: Write failing tests**

Add fixtures proving that `gameKeysForRecord()` resolves:

- a Gamma metadata record to `game:<gameId>`;
- a CLOB frame containing `asset_id` or `price_changes[].asset_id` to the game bound by metadata;
- a Sports frame to the game bound by `gameId`/event slug;
- an `event_retired` record to its game.

Add a test proving `consumeNewlyFinishedGames()` returns a finished game once and then returns an empty list.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npm test -- tests/collector/continuous-state.test.ts
```

Expected: missing-method failure.

- [ ] **Step 3: Implement bounded identity helpers**

Add:

```ts
gameKeysForRecord(record: JournalRecord): string[];
consumeNewlyFinishedGames(): CapturedGame[];
```

Keep the existing private token/event indexes as the source of truth. Parse only identity fields from CLOB frames; use existing `metadataFromRecord`, `observationsFromRecord`, and `windowKeyForIdentity` for Gamma/Sports. Record a game key in a private set when `finish()` first observes or revises a finish timestamp. Do not enqueue restored games as newly finished.

- [ ] **Step 4: Run focused tests**

```bash
npm test -- tests/collector/continuous-state.test.ts
```

Expected: all state tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/collector/continuous-state.ts tests/collector/continuous-state.test.ts
git commit -m "feat: expose compact capture identities"
```

### Task 4: Add compact-mode configuration and remove redundant snapshot persistence

**Files:**
- Modify: `src/collector/continuous-config.ts`
- Modify: `src/collector/collector.ts`
- Modify: `collector.config.json`
- Test: `tests/collector/continuous-config.test.ts`
- Test: `tests/collector/collector-continuous-core.test.ts`

- [ ] **Step 1: Write failing configuration/runtime tests**

Add config assertions for:

```ts
compactStorageEnabled: false,
tailWindowSeconds: 180,
tailBufferSeconds: 30,
tailRetentionDays: 30,
maxTailStoreBytes: 8 * 1024 ** 3,
maintenanceIntervalMs: 60_000
```

Add runtime tests proving compact mode does not start the periodic CLOB book snapshot timer, while non-compact mode retains existing behavior. Add a test proving compact catalog HTTP receipts contain a hash/byte summary instead of the full response body.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npm test -- tests/collector/continuous-config.test.ts tests/collector/collector-continuous-core.test.ts
```

Expected: failures for missing config and compact mode behavior.

- [ ] **Step 3: Implement config and runtime changes**

Add the compact settings and validate positive/nonnegative bounds. Pass `compactStorageEnabled` from `ContinuousCollector` into `CollectorRuntime`. In compact mode:

- skip the periodic HTTP book snapshot timer;
- skip the initial HTTP snapshot pass;
- retain WebSocket market frames for the compact store, not the raw journal;
- record catalog response digest/byte summaries rather than full HTTP response bodies;
- leave discovery cadence and lifecycle identity checks unchanged.

Set `compactStorageEnabled: true`, `tailWindowSeconds: 180`, `tailBufferSeconds: 30`, `tailRetentionDays: 30`, `maxTailStoreBytes: 8GiB`, and `maintenanceIntervalMs: 60_000` in `collector.config.json`. Keep the existing profile list and market scope; this change is storage/quality optimization, not a sports-format filter.

- [ ] **Step 4: Run focused tests**

```bash
npm test -- tests/collector/continuous-config.test.ts tests/collector/collector-continuous-core.test.ts
npm run typecheck
```

Expected: all focused tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/collector/continuous-config.ts src/collector/collector.ts collector.config.json tests/collector/continuous-config.test.ts tests/collector/collector-continuous-core.test.ts
git commit -m "feat: disable redundant compact-mode snapshots"
```

### Task 5: Wire compact storage into ContinuousCollector and archive completion

**Files:**
- Modify: `src/collector/continuous.ts`
- Test: `tests/collector/continuous.test.ts`
- Test: `tests/collector/continuous-maintenance.test.ts`

- [ ] **Step 1: Write failing integration tests**

Add tests proving that in compact mode:

1. raw `ws_message` records are visible to `ContinuousState` and the compact store but absent from the run journal;
2. a finished/retired game is finalized to SQLite and marked archived without creating an NDJSON checkpoint/export snapshot;
3. staging maintenance runs and updates status;
4. a store failure moves the collector into a recorded error/paused state rather than silently losing the failure.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npm test -- tests/collector/continuous.test.ts tests/collector/continuous-maintenance.test.ts
```

Expected: failures because compact storage is not wired.

- [ ] **Step 3: Implement integration**

Open the store beneath `dataRoot` during initialization. Pass a `persistRecord` function to `createJournal` that rejects `ws_message`, `book_snapshot`, `book_snapshot_batch`, and heartbeat records in compact mode; deduplicate identical `event_metadata` bodies by event ID/hash. After `journal.record()` and `state.observe()`, send the returned `JournalRecord` plus `state.gameKeysForRecord()` to the store, then consume newly finished games. Run `flush()` and interval maintenance from `performPulse()`.

Branch `beginArchive()` in compact mode to `finalize(game, finishAtMs)` and mark the archive complete with the SQLite path as its output path. Keep the existing archive path untouched when compact mode is false. Close/flush the store during cleanup after archive/compression tasks finish.

- [ ] **Step 4: Run focused tests**

```bash
npm test -- tests/collector/continuous.test.ts tests/collector/continuous-maintenance.test.ts
npm run typecheck
```

Expected: focused tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/collector/continuous.ts tests/collector/continuous.test.ts tests/collector/continuous-maintenance.test.ts
 git commit -m "feat: wire compact tail storage into continuous capture"
```

### Task 6: Add status metrics and safe raw-run retention

**Files:**
- Modify: `src/collector/continuous-state.ts`
- Modify: `src/collector/continuous-server.ts`
- Modify: `src/collector/continuous-storage.ts`
- Modify: `src/collector/continuous.ts`
- Test: `tests/collector/continuous-server.test.ts`
- Test: `tests/collector/continuous-storage.test.ts`

- [ ] **Step 1: Write failing status/retention tests**

Test that status includes compact database path/bytes, staging record count, finalized match count, last maintenance time, and deleted counts. Test that raw run directories older than `tailRetentionDays` are deleted only when they are not the active run and only after compact finalization has succeeded.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npm test -- tests/collector/continuous-server.test.ts tests/collector/continuous-storage.test.ts
```

Expected: missing status fields/retention helper failures.

- [ ] **Step 3: Implement status and retention**

Add compact metrics to `ContinuousStatus` and dashboard rendering. Implement a path-confined raw-run pruning helper using `readdir`, `lstat`, and `rm({ recursive: true })`; reject symlinks, active run IDs, and paths outside the owned `runs` directory. Invoke it only after compact maintenance and only for runs older than configured retention. Preserve state, lock, logs, and SQLite files.

- [ ] **Step 4: Run focused tests**

```bash
npm test -- tests/collector/continuous-server.test.ts tests/collector/continuous-storage.test.ts
npm run typecheck
```

Expected: focused tests pass and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/collector/continuous-state.ts src/collector/continuous-server.ts src/collector/continuous-storage.ts src/collector/continuous.ts tests/collector/continuous-server.test.ts tests/collector/continuous-storage.test.ts
git commit -m "feat: expose compact metrics and prune old raw runs"
```

### Task 7: Verify the complete collector and document operations

**Files:**
- Modify: `docs/continuous-collector.md`
- Modify: `docs/superpowers/specs/2026-09-19-compact-final-180s-collector-design.md`
- Test: all existing collector tests

- [ ] **Step 1: Run focused regression suites**

```bash
npm test -- tests/collector/journal.test.ts tests/collector/continuous-tail-store.test.ts tests/collector/continuous-state.test.ts tests/collector/continuous-config.test.ts tests/collector/continuous.test.ts tests/collector/continuous-maintenance.test.ts
```

Expected: 0 failures.

- [ ] **Step 2: Run full verification**

```bash
npm run typecheck
npm test
```

Expected: typecheck exits 0 and all test files pass.

- [ ] **Step 3: Verify production config and dry-run status**

```bash
node --import tsx src/collector/continuous-cli.ts status --config collector.config.json
```

Expected: the configuration parses and status reports the collector stopped/paused state without starting a new process.

- [ ] **Step 4: Document the new storage contract**

Document `tail.sqlite`, the 180-second final window, 210-second staging horizon, database/raw limits, pruning order, compact status fields, and the fact that the old NDJSON mode remains available only when `compactStorageEnabled` is false. Remove format-specific wording from the design and operational docs.

- [ ] **Step 5: Commit**

```bash
git add docs/continuous-collector.md docs/superpowers/specs/2026-09-19-compact-final-180s-collector-design.md
git commit -m "docs: document compact collector operations"
```
