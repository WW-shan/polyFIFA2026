import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { openCompactTailStore, type CompactStoredRecord } from "../../src/collector/continuous-tail-store.js";
import type { CapturedGame } from "../../src/collector/continuous-state.js";
import type { JournalRecord } from "../../src/collector/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "poly-fifa-compact-tail-"));
  roots.push(path);
  return path;
}

function record(sequence: number, receivedAtMs: number, data: unknown, source: JournalRecord["source"] = "clob"): JournalRecord {
  return {
    schemaVersion: 1, runId: "run-1", sequence, receivedAt: new Date(receivedAtMs).toISOString(), receivedAtMs,
    monotonicNs: String(sequence), source, kind: "ws_message", connectionId: "clob-0-e1", data
  };
}

function game(key: string, finishedAtMs: number): CapturedGame {
  return {
    key, title: key, sport: "tennis", gameId: key.replace("game:", ""), eventIds: [key], eventSlugs: [key],
    tokenIds: ["yes", "no"], marketIds: ["market-1"], firstSeenAtMs: 0, lastSeenAtMs: finishedAtMs,
    firstBookAtMs: 0, lastBookAtMs: finishedAtMs, lastBookRunId: "run-1", bookUpdates: 4, trades: 0,
    stateObservations: 1, finishedAtMs, finishConflict: false, retiredEventIds: [key], phase: "postmatch", sources: []
  };
}

async function open(rootPath: string, now: () => number, overrides: Partial<Parameters<typeof openCompactTailStore>[0]> = {}) {
  return openCompactTailStore({
    dataRoot: rootPath, tailWindowMs: 180, bufferMs: 30, retentionMs: 10_000, maxBytes: 8 * 1024 ** 3, now, ...overrides
  });
}

describe("compact sqlite tail store", () => {
  test("deduplicates consecutive payloads and finalizes only the last window", async () => {
    const path = await root();
    let now = 400;
    const store = await open(path, () => now);
    store.ingest(record(1, 0, { asset_id: "yes", value: 1 }), ["game:1"]);
    store.ingest(record(2, 100, { asset_id: "yes", value: 1 }), ["game:1"]);
    store.ingest(record(3, 200, { asset_id: "yes", value: 2 }), ["game:1"]);
    store.ingest(record(4, 300, { asset_id: "yes", value: 3 }), ["game:1"]);
    store.ingest(record(5, 400, { asset_id: "yes", value: 4 }), ["game:1"]);
    store.flush();
    const result = store.finalize(game("game:1", 400), 400);
    // The fixture's oldest in-window frame is 80ms after the 180ms floor, so
    // the window is honestly reported as short rather than silently accepted.
    expect(result).toMatchObject({ records: 2, windowComplete: false, missingFrontMs: 80 });

    const rows = store.readFinalized("game:1");
    expect(rows.map(row => row.receivedAtMs)).toEqual([300, 400]);
    expect(rows.every(row => row.data !== undefined)).toBe(true);
    expect(store.snapshot()).toMatchObject({ finalizedMatches: 1, finalizedRecords: 2, stagingRecords: 0 });
    store.close();
  });

  test("keeps one copy of an unchanged book so a window always has an anchor", async () => {
    const path = await root();
    let now = 0;
    const store = await open(path, () => now, { tailWindowMs: 180_000, bufferMs: 30_000, redundantKeepAliveMs: 60_000 });
    // The anchor pass reposts the same resting book while nothing moves. If the
    // first copy were the only one kept, a window ending on the last anchor
    // would hold no row at all and the match could never be published.
    for (const [sequence, atMs] of [[1, 0], [2, 200_000], [3, 400_000]] as const) {
      now = atMs;
      store.ingest(record(sequence, atMs, { asset_id: "yes", value: 1 }), ["game:1"]);
    }
    store.flush();
    const result = store.finalize(game("game:1", 400_000), 400_000);
    expect(result).toMatchObject({ records: 1, windowStartMs: 400_000 });
    expect(store.readFinalized("game:1")).toMatchObject([
      { receivedAtMs: 400_000, data: { asset_id: "yes", value: 1 } }
    ]);
    store.close();
  });

  test("stores connection invalidation and does not deduplicate identical books across a gap", async () => {
    const path = await root();
    const store = await open(path, () => 300);
    store.ingest(record(1, 150, { asset_id: "yes", bids: [], asks: [{ price: "0.6", size: "1" }] }), ["game:1"]);
    store.ingest({ schemaVersion: 1, runId: "run-1", sequence: 2, receivedAt: new Date(180).toISOString(), receivedAtMs: 180,
      monotonicNs: "2", source: "collector", kind: "connection_gap", connectionId: "clob-0-e1", data: { reason: "inbound_timeout" } }, ["game:1"]);
    store.ingest(record(3, 250, { asset_id: "yes", bids: [], asks: [{ price: "0.6", size: "1" }] }), ["game:1"]);
    store.flush();
    const result = store.finalize(game("game:1", 300), 300);
    const rows = store.readFinalized("game:1");
    expect(rows.map(row => [row.receivedAtMs, row.kind])).toEqual([[150, "ws_message"], [180, "connection_gap"], [250, "ws_message"]]);
    expect(result.windowComplete).toBe(false);
    store.close();
  });

  test("refreshes finish evidence on an existing match when no depth rows remain", async () => {
    const path = await root();
    const store = await open(path, () => 400);
    store.ingest(record(1, 300, { asset_id: "yes", bids: [], asks: [{ price: "0.6", size: "1" }] }), ["game:1"]);
    store.finalize(game("game:1", 400), 400);
    const facts = [{ source: "gamma.finishedTimestamp" as const, atMs: 399, observedAtMs: 399, eventId: "event",
      eventSlug: "game", gameId: "1", sourceRunId: "run-1", sourceRunDirectory: null, sequence: 9, frameIndex: 0 }];
    store.finalize({ ...game("game:1", 400), finishConflict: true, finishFacts: facts }, 400);
    expect(store.readMatchCoverage("game:1")).toMatchObject({ finishConflict: true, finishFacts: facts });
    store.close();
  });

  test("does not treat sports or lifecycle rows as order-book window coverage", async () => {
    const path = await root();
    const store = await open(path, () => 400);
    const sports = { ...record(1, 220, "score", "sports"), source: "sports" as const };
    store.ingest(sports, ["game:1"]);
    store.ingest({ schemaVersion: 1, runId: "run-1", sequence: 2, receivedAt: new Date(230).toISOString(), receivedAtMs: 230,
      monotonicNs: "2", source: "collector", kind: "connection_gap", connectionId: "clob-0-e1", data: {} }, ["game:1"]);
    store.flush();
    const result = store.finalize(game("game:1", 400), 400);
    expect(result.windowComplete).toBe(false);
    expect(store.hasStagedInWindow("game:1", 220, 400)).toBe(false);
    expect(store.stagedTailAt("game:1")).toBeNull();
    expect(store.readMatchCoverage("game:1")).toBeUndefined();
    store.close();
  });

  test("maintenance drops expired staging data but keeps the active buffer and one seed window", async () => {
    const path = await root();
    let now = 1_000;
    const store = await open(path, () => now);
    store.ingest(record(1, 300, { value: "seed-window" }), ["game:1"]);
    store.ingest(record(2, 700, { value: "old" }), ["game:1"]);
    store.ingest(record(3, 950, { value: "new" }), ["game:1"]);
    store.flush();
    store.maintain(now);

    // The tail window plus buffer keeps 950; the extra window is what lets a
    // later finish anchor its window on a full-depth frame instead of an empty
    // floor, so the seed is retained too. Anything older is released.
    expect(store.snapshot().stagingRecords).toBe(2);
    store.close();
  });

  test("keeps the full-depth anchor before the window floor so the window can be rebuilt", async () => {
    const path = await root();
    let now = 0;
    const store = await open(path, () => now, { tailWindowMs: 180_000, bufferMs: 30_000 });
    // Anchor at T, deltas after it, window floor at T+30s: without the anchor
    // the ladder cannot be reconstructed from the floor at all.
    const anchor: JournalRecord = { ...record(1, 0, { tokenId: "yes", response: { asset_id: "yes", bids: [], asks: [] } }),
      kind: "book_snapshot" };
    store.ingest(anchor, ["game:1"]);
    store.ingest(record(2, 60_000, { asset_id: "yes", value: 2 }), ["game:1"]);
    store.ingest(record(3, 210_000, { asset_id: "yes", value: 3 }), ["game:1"]);
    store.flush();
    const result = store.finalize(game("game:1", 210_000), 210_000);

    // Floor is 30_000; the anchor at 0 proves the book there.
    expect(result).toMatchObject({ windowComplete: true, missingFrontMs: 0, windowStartMs: 60_000 });
    expect(store.readFinalized("game:1").map(row => row.receivedAtMs)).toEqual([0, 60_000, 210_000]);
    store.close();
  });

  test("finalization is idempotent and retention removes oldest completed matches", async () => {
    const path = await root();
    let now = 1_000;
    const store = await open(path, () => now, { retentionMs: 100 });
    for (const [key, finish] of [["game:old", 100], ["game:new", 950]] as const) {
      store.ingest(record(finish, finish, { key }), [key]);
      store.flush();
      store.finalize(game(key, finish), finish);
    }
    store.finalize(game("game:new", 950), 950);
    now = 1_000;
    store.maintain(now);

    expect(store.readFinalized("game:old")).toEqual([]);
    expect(store.readFinalized("game:new")).toHaveLength(1);
    store.close();
  });

  test("maintenance does not vacuum on every pulse", async () => {
    const path = await root();
    let now = 1_000;
    const store = await open(path, () => now);
    store.ingest(record(1, now, { value: "one" }), ["game:1"]);
    store.flush();
    expect((store as unknown as { lastVacuumAtMs: number }).lastVacuumAtMs).toBe(0);
    store.maintain(now);
    expect((store as unknown as { lastVacuumAtMs: number }).lastVacuumAtMs).toBe(0);
    now += 6 * 3600_000;
    store.maintain(now);
    expect((store as unknown as { lastVacuumAtMs: number }).lastVacuumAtMs).toBe(now);
    store.close();
  });

  test("keeps a finished game's whole window when maintenance runs before finalization", async () => {
    const path = await root();
    const finish = 200_000;
    let now = finish;
    const store = await open(path, () => now, { tailWindowMs: 180_000, bufferMs: 30_000 });
    // One distinct frame per second across the whole target window.
    for (let second = 180; second >= 0; second--) {
      store.ingest(record(1000 + (180 - second), finish - second * 1000, { second }), ["game:1"]);
    }
    store.flush();
    // The finish is known, but the archive turn has not run yet.
    store.markPendingFinalize("game:1", finish);
    // Maintenance keeps running on wall-clock time while the game waits.
    for (const delayMs of [30_000, 60_000, 120_000, 300_000]) {
      now = finish + delayMs;
      store.maintain(now);
    }
    const result = store.finalize(game("game:1", finish), finish);
    expect(result).toMatchObject({ records: 181, windowComplete: true, missingFrontMs: 0 });
    const oldest = store.readFinalized("game:1")[0]!.receivedAtMs;
    expect(oldest).toBe(finish - 180_000);
    store.close();
  });

  test("stores the frame kind when a container record is split into narrower frames", async () => {
    const path = await root();
    const now = 1_000;
    const store = await open(path, () => now);
    // A book-snapshot batch is written as the single-token snapshot it became,
    // so the stored kind must match the stored payload, not the container.
    store.ingestFrame(record(1, 900, "ignored"), "game:1", { tokenId: "A", response: { asset_id: "A" } }, 3, "book_snapshot");
    store.flush();
    store.finalize(game("game:1", 1_000), 1_000);
    expect(store.readFinalized("game:1")).toMatchObject([
      { gameKey: "game:1", kind: "book_snapshot", frameIndex: 3, data: { tokenId: "A", response: { asset_id: "A" } } }
    ]);
    store.close();
  });

  test("protects the rolling tail of an unresolved game until its label can still arrive", async () => {
    const path = await root();
    const finish = 200_000;
    let now = finish;
    const store = await open(path, () => now, { tailWindowMs: 180_000, bufferMs: 30_000, pendingFinishMs: 900_000 });
    for (let second = 180; second >= 0; second--) {
      store.ingest(record(1000 + (180 - second), finish - second * 1000, { second }), ["game:1"]);
    }
    store.flush();
    // The finish label has not arrived, so the game has no `matches` row and
    // nothing pins its window. Wall-clock pruning alone would erase it.
    now = finish + 600_000;
    store.maintain(now);
    expect(store.snapshot()).toMatchObject({ stagingRecords: 181, stagingProtectedGames: 1, finalizedMatches: 0 });
    store.close();
  });

  test("releases an unresolved game once its evidence can no longer produce a window", async () => {
    const path = await root();
    const finish = 200_000;
    let now = finish;
    const store = await open(path, () => now, { tailWindowMs: 180_000, bufferMs: 30_000, pendingFinishMs: 900_000 });
    for (let second = 180; second >= 0; second--) {
      store.ingest(record(1000 + (180 - second), finish - second * 1000, { second }), ["game:1"]);
    }
    store.flush();
    now = finish + 1_000_000;
    store.maintain(now);
    // Past the protection window the label could only ever produce an empty
    // archive, so the rows are reclaimed instead of held forever.
    expect(store.snapshot()).toMatchObject({ stagingRecords: 0, stagingProtectedGames: 0 });
    store.close();
  });

  test("a finalized game stops being protected so its staging is reclaimed", async () => {
    const path = await root();
    const finish = 200_000;
    let now = finish;
    const store = await open(path, () => now, { tailWindowMs: 180_000, bufferMs: 30_000, pendingFinishMs: 900_000,
      retentionMs: 30 * 24 * 3600_000 });
    store.ingest(record(1, finish - 1_000, { value: "in-window" }), ["game:1"]);
    store.ingest(record(2, finish, { value: "tail" }), ["game:1"]);
    store.flush();
    store.finalize(game("game:1", finish), finish);
    // Frames that arrive after finalization are new evidence for a match that
    // already has its window, so this game is no longer protected.
    store.ingest(record(3, finish + 1_000, { value: "late" }), ["game:1"]);
    store.flush();
    expect(store.snapshot().stagingProtectedGames).toBe(0);
    now = finish + 600_000;
    store.maintain(now);
    expect(store.snapshot()).toMatchObject({ stagingRecords: 0, finalizedMatches: 1 });
    store.close();
  });

  test("a front covered by an unchanged book counts as a complete window", async () => {
    const path = await root();
    const now = 20_000;
    const store = await open(path, () => now, { tailWindowMs: 10_000, bufferMs: 1_000, redundantKeepAliveMs: 5_000 });
    // The book never moves, so the keep-alive stores one copy every 5s: the
    // first row inside the window lands at 5000 while the floor is 3000.
    let sequence = 0;
    for (let at = 0; at <= 13_000; at += 1_000) {
      store.ingest(record(++sequence, at, { asset_id: "yes", value: 1 }), ["game:1"]);
    }
    store.flush();
    const result = store.finalize(game("game:1", 13_000), 13_000);
    expect(result).toMatchObject({ windowComplete: true, missingFrontMs: 0 });
    // The oldest stored receipt is still reported as the stored receipt.
    expect(result.windowStartMs).toBe(5_000);
  });

  test("a front the store never saw stays an incomplete window", async () => {
    const path = await root();
    const now = 20_000;
    const store = await open(path, () => now, { tailWindowMs: 10_000, bufferMs: 1_000, redundantKeepAliveMs: 5_000 });
    // Collection only starts 2s before the finish, well after the floor.
    let sequence = 0;
    for (let at = 11_000; at <= 13_000; at += 1_000) {
      store.ingest(record(++sequence, at, { asset_id: "yes", value: 1 }), ["game:1"]);
    }
    store.flush();
    const result = store.finalize(game("game:1", 13_000), 13_000);
    expect(result).toMatchObject({ windowComplete: false, missingFrontMs: 8_000 });
  });

  test("trims the oldest matches to the byte cap instead of deleting the whole store", async () => {
    const path = await root();
    const now = 10_000_000;
    const store = await open(path, () => now, { tailWindowMs: 1_000, bufferMs: 100, retentionMs: 10 ** 12, maxBytes: 10 ** 12 });
    const games = 30;
    for (let index = 0; index < games; index++) {
      const key = `game:${index}`;
      const finished = now - 60_000 - index * 1_000;
      let sequence = 0;
      for (let at = finished - 1_000; at <= finished; at += 50) {
        const frame = { asset_id: "yes", value: at + index };
        store.ingestFrame(record(index * 100 + ++sequence, at, frame), key, frame, 0);
      }
      store.finalize(game(key, finished), finished);
    }
    store.close();
    const before = (await open(path, () => now, { tailWindowMs: 1_000, bufferMs: 100, retentionMs: 10 ** 12, maxBytes: 10 ** 12 })).snapshot();
    const cap = Math.floor(before.databaseBytes * 0.7);
    const capped = await open(path, () => now, { tailWindowMs: 1_000, bufferMs: 100, retentionMs: 10 ** 12, maxBytes: cap });
    capped.maintain(now);
    const after = capped.snapshot();
    expect(before.finalizedMatches).toBe(games);
    // The bug measured the file size inside the delete loop; incremental
    // auto_vacuum does not shrink the file until pages are reclaimed, so that
    // loop deleted every match. Trimming must keep the newest ones.
    expect(after.finalizedMatches).toBeGreaterThan(0);
    expect(after.finalizedMatches).toBeLessThan(before.finalizedMatches);
    expect(after.databaseBytes).toBeLessThanOrEqual(cap);
    // The oldest finishes go first and the newest stay readable.
    expect(capped.readFinalized(`game:${games - 1}`)).toEqual([]);
    expect(capped.readFinalized("game:0").length).toBeGreaterThan(0);
    capped.close();
  });

  test("reports an incomplete window instead of a silent success", async () => {
    const path = await root();
    const finish = 200_000;
    let now = finish;
    const store = await open(path, () => now, { tailWindowMs: 180_000, bufferMs: 30_000 });
    // Only the last 60 seconds were ever observed.
    for (let second = 60; second >= 0; second--) {
      store.ingest(record(1000 + (60 - second), finish - second * 1000, { second }), ["game:1"]);
    }
    store.flush();
    const result = store.finalize(game("game:1", finish), finish);
    expect(result.records).toBe(61);
    expect(result.windowComplete).toBe(false);
    expect(result.missingFrontMs).toBe(120_000);
    store.close();
  });

  test("ingestFrame stores one attributed frame without widening it to the batch", async () => {
    const path = await root();
    const store = await open(path, () => 400);
    const outer = record(1, 300, "ignored");
    store.ingestFrame(outer, "game:1", { event_type: "book", asset_id: "A", asks: [{ price: "0.5", size: "1" }], bids: [] }, 7);
    store.flush();
    store.finalize(game("game:1", 400), 400);

    const rows = store.readFinalized("game:1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gameKey: "game:1", sequence: 1, receivedAtMs: 300,
      data: { event_type: "book", asset_id: "A", asks: [{ price: "0.5", size: "1" }], bids: [] } });
    store.close();
  });

  test("keeps every frame when one record carries several frames for the same game", async () => {
    const path = await root();
    const store = await open(path, () => 400);
    // One batched message yields several frames for the same game and sequence.
    const outer = record(1, 300, "batched");
    store.ingestFrame(outer, "game:1", { event_type: "book", asset_id: "A", asks: [{ price: "0.5", size: "1" }], bids: [] }, 0);
    store.ingestFrame(outer, "game:1", { event_type: "price_change", price_changes: [{ asset_id: "A", side: "SELL", price: "0.6", size: "2" }] }, 1);
    store.ingestFrame(outer, "game:1", { event_type: "price_change", price_changes: [{ asset_id: "A", side: "BUY", price: "0.4", size: "3" }] }, 2);
    store.flush();
    store.finalize(game("game:1", 400), 400);

    const rows = store.readFinalized("game:1");
    expect(rows.map(row => row.frameIndex)).toEqual([0, 1, 2]);
    expect(rows.map(row => (row.data as { event_type: string }).event_type)).toEqual(["book", "price_change", "price_change"]);
    expect(store.snapshot().finalizedRecords).toBe(3);
    store.close();
  });

  test("migrates a version 1 database without losing finalized or staging rows", async () => {
    const path = await root();
    // Build a v1-shaped database by hand, exactly as the old code created it.
    const first = await open(path, () => 200);
    first.ingest(record(1, 200, { value: "kept" }), ["game:1"]);
    first.flush();
    first.finalize(game("game:1", 200), 200);
    first.close();

    const legacy = new DatabaseSync(join(path, "tail.sqlite"));
    for (const table of ["staging_records", "tail_records"] as const) {
      legacy.exec(`CREATE TABLE ${table}_v1 (
        game_key TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        received_at_ms INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, payload_hash TEXT NOT NULL,
        PRIMARY KEY(game_key, run_id, sequence)) WITHOUT ROWID`);
      legacy.exec(`INSERT INTO ${table}_v1 SELECT game_key, run_id, sequence, received_at_ms, source, kind, payload_hash FROM ${table}`);
      legacy.exec(`DROP TABLE ${table}`);
      legacy.exec(`ALTER TABLE ${table}_v1 RENAME TO ${table}`);
    }
    legacy.prepare("UPDATE compact_meta SET value = '1' WHERE key = 'schema_version'").run();
    legacy.close();

    const reopened = await open(path, () => 300);
    expect(reopened.readFinalized("game:1")).toEqual([
      expect.objectContaining({ gameKey: "game:1", sequence: 1, frameIndex: 0, data: { value: "kept" } })
    ]);
    // The upgraded schema now accepts a second frame for the same sequence.
    reopened.ingestFrame(record(1, 250, "second"), "game:1", { value: "second-frame" }, 1);
    reopened.flush();
    expect(reopened.snapshot().stagingRecords).toBe(1);
    reopened.close();
  });

  test("repair strips foreign frames from legacy tails and records real window coverage", async () => {
    const path = await root();
    const finish = 200_000;
    let now = finish;
    const store = await open(path, () => now, { tailWindowMs: 180_000, bufferMs: 30_000 });
    // Simulate the legacy bug: one batched record holding frames for two games
    // was attributed wholesale to this game, and stored as a raw WS string.
    const legacy = record(1, finish - 60_000, JSON.stringify([
      { event_type: "book", asset_id: "yes", asks: [{ price: "0.6", size: "5" }], bids: [] },
      { event_type: "book", asset_id: "foreign-token", asks: [{ price: "0.2", size: "9" }], bids: [] }
    ]));
    store.ingest(legacy, ["game:1"]);
    store.flush();
    store.finalize(game("game:1", finish), finish);
    expect(store.readFinalized("game:1")).toHaveLength(1);

    const dry = store.repairAttribution({ apply: false });
    expect(dry).toMatchObject({ recordsRewritten: 1, foreignFramesDropped: 1, windowComplete: 0, windowIncomplete: 1 });
    // A dry run must not modify anything.
    expect(store.readFinalized("game:1")).toHaveLength(1);
    expect((store.readFinalized("game:1")[0]!.data as unknown[])).toHaveLength(2);

    const applied = store.repairAttribution({ apply: true });
    expect(applied).toMatchObject({ recordsRewritten: 1, recordsDropped: 0, foreignFramesDropped: 1, windowComplete: 0, windowIncomplete: 1 });
    const repaired = store.readFinalized("game:1");
    expect(repaired).toHaveLength(1);
    // A single surviving frame is stored as one frame, matching the shape
    // `ingestFrame` writes, rather than a one-element array.
    const frame = repaired[0]!.data as { asset_id?: string };
    expect(frame.asset_id).toBe("yes");
    store.close();

    // Coverage is now persisted, so a short window cannot read as complete.
    const reopened = await open(path, () => now);
    const row = reopened.readMatchCoverage("game:1");
    expect(row).toMatchObject({ windowComplete: false });
    expect(row?.missingFrontMs).toBeGreaterThan(0);
    reopened.close();
  });

  test("repair drops a legacy record that holds only foreign frames", async () => {
    const path = await root();
    const finish = 200_000;
    const store = await open(path, () => finish, { tailWindowMs: 180_000, bufferMs: 30_000 });
    store.ingest(record(1, finish - 60_000, JSON.stringify([
      { event_type: "book", asset_id: "foreign-only", asks: [{ price: "0.2", size: "1" }], bids: [] }
    ])), ["game:1"]);
    store.ingest(record(2, finish - 59_000, JSON.stringify([
      { event_type: "book", asset_id: "yes", asks: [{ price: "0.6", size: "5" }], bids: [] }
    ])), ["game:1"]);
    store.flush();
    store.finalize(game("game:1", finish), finish);
    const report = store.repairAttribution({ apply: true });
    expect(report).toMatchObject({ recordsRewritten: 0, recordsDropped: 1, foreignFramesDropped: 1 });
    const rows = store.readFinalized("game:1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sequence).toBe(2);
    store.close();
  });

  test("reopens with finalized data intact", async () => {
    const path = await root();
    const first = await open(path, () => 200);
    first.ingest(record(1, 200, { value: "persisted" }), ["game:1"]);
    first.flush();
    first.finalize(game("game:1", 200), 200);
    first.close();

    const second = await open(path, () => 300);
    expect(second.readFinalized("game:1")).toEqual<CompactStoredRecord[]>([
      expect.objectContaining({ gameKey: "game:1", sequence: 1, receivedAtMs: 200, data: { value: "persisted" } })
    ]);
    second.close();
  });
});
