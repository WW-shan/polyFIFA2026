import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readJournalRecords, replayRecords, type ReplayJournalRecord } from "../../src/collector/replay.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function record(sequence: number, source: ReplayJournalRecord["source"], kind: string, data: unknown, receivedAtMs = sequence * 1_000, connectionId?: string): ReplayJournalRecord {
  const value: ReplayJournalRecord = {
    schemaVersion: 1,
    runId: "run",
    sequence,
    receivedAt: new Date(receivedAtMs).toISOString(),
    receivedAtMs,
    monotonicNs: String(BigInt(sequence) * 1_000_000_000n),
    source,
    kind,
    data
  };
  if (connectionId !== undefined) value.connectionId = connectionId;
  return value;
}

describe("collector replay", () => {
  test("replaces books and applies absolute price quantities with token mappings", () => {
    const records: ReplayJournalRecord[] = [
      record(1, "gamma", "event_metadata", {
        normalized: {
          eventId: "event-1",
          eventSlug: "game-1",
          markets: [{ marketId: "market-1", marketSlug: "winner", conditionId: "condition-1", outcomes: ["Yes", "No"], tokenIds: ["token-1", "token-2"] }]
        }
      }),
      record(2, "sports", "ws_message", JSON.stringify({ eventSlug: "game-1", score: "1-0" }), 2_000),
      record(3, "clob", "ws_message", JSON.stringify({ event_type: "book", asset_id: "token-1", bids: [{ price: "0.40", size: "2" }, { price: "0.60", size: "1" }], asks: [{ price: "0.80", size: "5" }, { price: "0.70", size: "4" }] }), 3_000, "clob-0-e1"),
      record(4, "clob", "ws_message", JSON.stringify({ event_type: "price_change", price_changes: [
        { asset_id: "token-1", price: "0.60", side: "BUY", size: "7" },
        { asset_id: "token-1", price: "0.70", side: "SELL", size: "0" }
      ] }), 4_000, "clob-0-e1"),
      record(5, "clob", "ws_message", JSON.stringify({ event_type: "last_trade_price", asset_id: "token-1", price: "0.61", size: "2", side: "BUY" }), 5_000, "clob-0-e1")
    ];

    const replay = replayRecords(records);

    expect(replay.markets).toContainEqual(expect.objectContaining({ tokenId: "token-1", eventSlug: "game-1", outcome: "Yes" }));
    expect(replay.quotes).toHaveLength(2);
    expect(replay.quotes[0]).toMatchObject({ tokenId: "token-1", marketId: "market-1", outcome: "Yes", sportsSequence: 2, sportsAgeMs: 1_000 });
    expect(replay.quotes[0]?.bids).toEqual([{ price: "0.60", size: "1" }, { price: "0.40", size: "2" }]);
    expect(replay.quotes[0]?.asks).toEqual([{ price: "0.70", size: "4" }, { price: "0.80", size: "5" }]);
    expect(replay.quotes[1]?.bids).toEqual([{ price: "0.60", size: "7" }, { price: "0.40", size: "2" }]);
    expect(replay.quotes[1]?.asks).toEqual([{ price: "0.80", size: "5" }]);
    expect(replay.trades).toContainEqual(expect.objectContaining({ tokenId: "token-1", price: "0.61", size: "2" }));
  });

  test("replays multiple CLOB book objects carried in one JSON array frame", () => {
    const replay = replayRecords([
      record(1, "clob", "ws_message", JSON.stringify([
        { event_type: "book", asset_id: "token-a", bids: [{ price: "0.1", size: "2" }], asks: [] },
        { event_type: "book", asset_id: "token-b", bids: [], asks: [{ price: "0.9", size: "3" }] }
      ]), 1_000, "clob-0-e1")
    ]);

    expect(replay.quotes.map((quote) => quote.tokenId)).toEqual(["token-a", "token-b"]);
    expect(replay.quality.unknownFrames).toBe(0);
  });

  test("does not treat updates after a sequence gap or connection close as valid book history", () => {
    const replay = replayRecords([
      record(1, "clob", "ws_message", JSON.stringify({ event_type: "book", asset_id: "token", bids: [], asks: [] }), 1_000, "clob-0-e1"),
      record(3, "clob", "ws_message", JSON.stringify({ event_type: "price_change", price_changes: [{ asset_id: "token", price: "0.5", side: "BUY", size: "1" }] }), 3_000, "clob-0-e1"),
      record(4, "collector", "connection_close", {}, 4_000, "clob-0-e1"),
      record(5, "clob", "ws_message", JSON.stringify({ event_type: "price_change", price_changes: [{ asset_id: "token", price: "0.4", side: "BUY", size: "2" }] }), 5_000, "clob-0-e1"),
      record(6, "clob", "ws_message", JSON.stringify({ event_type: "book", asset_id: "token", bids: [{ price: "0.4", size: "2" }], asks: [] }), 6_000, "clob-0-e2"),
      record(7, "clob", "ws_message", JSON.stringify({ event_type: "price_change", price_changes: [{ asset_id: "token", price: "0.3", side: "BUY", size: "1" }] }), 7_000, "clob-0-e2")
    ]);

    expect(replay.quotes.map((quote) => quote.sequence)).toEqual([1, 6, 7]);
    expect(replay.quality.sequenceGaps).toEqual([{ expected: 2, actual: 3 }]);
    expect(replay.quality.invalidBookUpdates).toBeGreaterThanOrEqual(2);
    expect(replay.quality.connectionInvalidations).toBeGreaterThanOrEqual(1);
  });

  test("reports incomplete final lines and sequence gaps while retaining valid records", async () => {
    const root = await mkdtemp(join(tmpdir(), "poly-fifa-collector-replay-"));
    temporaryDirectories.push(root);
    const run = join(root, "run");
    await mkdir(run, { recursive: true });
    const first = JSON.stringify(record(1, "collector", "session_start", {}));
    const second = JSON.stringify(record(3, "collector", "session_end", {}));
    await writeFile(join(run, "2026-09-10-000000.ndjson"), `${first}\n${second}`);

    const result = await readJournalRecords(run);

    expect(result.records).toHaveLength(1);
    expect(result.quality.incompleteFinalLines).toBe(1);
    expect(result.quality.sequenceGaps).toEqual([]);
  });
});
