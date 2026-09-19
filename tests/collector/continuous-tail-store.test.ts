import { mkdtemp, rm } from "node:fs/promises";
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
    store.finalize(game("game:1", 400), 400);

    const rows = store.readFinalized("game:1");
    expect(rows.map(row => row.receivedAtMs)).toEqual([300, 400]);
    expect(rows.every(row => row.data !== undefined)).toBe(true);
    expect(store.snapshot()).toMatchObject({ finalizedMatches: 1, finalizedRecords: 2, stagingRecords: 0 });
    store.close();
  });

  test("maintenance drops expired staging data but keeps the active buffer", async () => {
    const path = await root();
    let now = 1_000;
    const store = await open(path, () => now);
    store.ingest(record(1, 700, { value: "old" }), ["game:1"]);
    store.ingest(record(2, 950, { value: "new" }), ["game:1"]);
    store.flush();
    store.maintain(now);

    expect(store.snapshot().stagingRecords).toBe(1);
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
