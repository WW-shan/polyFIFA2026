import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readJournalRecords, replayRecords, type ReplayJournalRecord } from "../../src/collector/replay.js";
import { createJournal } from "../../src/collector/journal.js";

function rec(sequence: number, source: ReplayJournalRecord["source"], kind: string, data: unknown, connectionId?: string): ReplayJournalRecord {
  return {
    schemaVersion: 1, runId: "audit", sequence, receivedAt: new Date(sequence * 1000).toISOString(),
    receivedAtMs: sequence * 1000, monotonicNs: String(BigInt(sequence) * 1_000_000_000n),
    source, kind, data, ...(connectionId ? { connectionId } : {})
  };
}
const ws = (sequence: number, data: unknown, connectionId = "clob-0-e1") => rec(sequence, "clob", "ws_message", typeof data === "string" ? data : JSON.stringify(data), connectionId);
const book = (price = "0.70", size = "4", timestamp = "1000") => ({ event_type: "book", asset_id: "t", timestamp, bids: [], asks: [{ price, size }] });
const change = (price: string, size: string, timestamp = "2000") => ({ event_type: "price_change", timestamp, price_changes: [{ asset_id: "t", side: "SELL", price, size }] });
const metadata = () => rec(1, "gamma", "event_metadata", { normalized: {
  eventId: "a", eventSlug: "game-a", gameId: "10",
  markets: [{ marketId: "m", conditionId: "c", tokenIds: ["t"], outcomes: ["Yes"] }]
} });

describe("replay integrity regressions", () => {
  test("never attaches another game's score or a heartbeat to a quote", () => {
    for (const sports of [{ eventSlug: "game-b", gameId: 20, score: "4-0" }, "ping"]) {
      const result = replayRecords([metadata(), rec(2, "sports", "ws_message", JSON.stringify(sports)), ws(3, book())]);
      expect(result.quotes[0]?.sportsSequence).toBeUndefined();
    }
  });

  test("normalizes slug and game_id aliases and keeps the last matching correction", () => {
    const result = replayRecords([
      metadata(),
      rec(2, "sports", "ws_message", JSON.stringify({ slug: "game-a", game_id: "10", score: "2-0", elapsed: "89:10" })),
      ws(3, book()),
      rec(4, "sports", "ws_message", JSON.stringify({ slug: "game-a", game_id: "10", score: "1-0", elapsed: "89:15" })),
      rec(5, "sports", "ws_message", JSON.stringify({ slug: "game-b", score: "4-0" })),
      ws(6, change("0.60", "1"))
    ]);
    expect(result.quotes.map(quote => quote.sportsSequence)).toEqual([2, 4]);
    expect(result.quotes.map(quote => quote.sportsAgeMs)).toEqual([1000, 2000]);
  });

  test("sports age uses monotonic time across wall-clock rollback and exposes missing/stale clocks", () => {
    const score = rec(2, "sports", "ws_message", JSON.stringify({ game_id: "10", score: "2-0" }), "sports-0-e1");
    const quote = { ...ws(3, book()), receivedAtMs: 1500, receivedAt: new Date(1500).toISOString() };
    const result = replayRecords([metadata(), score, quote], { sportsStaleAfterMs: 500 });
    expect(result.quotes[0]).toMatchObject({ sportsSequence: 2, sportsAgeMs: 1000, sportsStatus: "stale", sportsClockStatus: "missing", sportsScore: "2-0" });
  });

  test("does not replace earlier quote context with future scores and marks disconnected score sources", () => {
    const result = replayRecords([
      metadata(), ws(2, book()),
      rec(3, "sports", "ws_message", JSON.stringify({ gameId: 10, score: "1-0", elapsed: "90:00" }), "sports-0-e1"),
      ws(4, change("0.6", "1")),
      rec(5, "collector", "connection_close", {}, "sports-0-e1"),
      ws(6, change("0.5", "1"))
    ]);
    expect(result.quotes.map(quote => quote.sportsStatus)).toEqual(["missing", "matched", "disconnected"]);
    expect(result.quotes[0]?.sportsScore).toBeUndefined();
    expect(result.quotes[1]?.sportsClock).toBe("90:00");
  });

  test("canonicalizes equivalent numeric price strings for replacement and zero deletion", () => {
    const result = replayRecords([ws(1, book()), ws(2, change("0.7", "7")), ws(3, change("0.7000", "0"))]);
    expect(result.quotes[1]?.asks).toHaveLength(1);
    expect(result.quotes[1]?.asks[0]?.size).toBe("7");
    expect(result.quotes[2]?.asks).toEqual([]);
  });

  test.each([
    { event_type: "book", asset_id: "t" },
    { event_type: "book", asset_id: "t", asks: [] },
    { event_type: "book", asset_id: "t", bids: [], asks: [{ price: "NaN", size: "4" }] },
    { event_type: "book", asset_id: "t", bids: [], asks: [{ price: "0.7", size: "-1" }] },
    { event_type: "book", asset_id: "t", bids: [], asks: [{ price: "1.1", size: "4" }] }
  ])("does not initialize a usable book from invalid snapshot %j", frame => {
    const result = replayRecords([ws(1, frame), ws(2, change("0.6", "1"))]);
    expect(result.quotes).toHaveLength(0);
    expect(result.quality.invalidBookUpdates).toBeGreaterThan(0);
  });

  test.each(['{"event_type":', { event_type: "future_book_mutation", asset_id: "t" }])(
    "invalidates depth after an unparseable or unknown mutation %j", badFrame => {
      const result = replayRecords([ws(1, book()), ws(2, badFrame), ws(3, change("0.6", "3")), ws(4, book("0.5", "2", "4000"))]);
      expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 4]);
    }
  );

  test("PONG and known non-depth messages do not invalidate a valid book", () => {
    const result = replayRecords([ws(1, book()), ws(2, "PONG"), ws(3, { event_type: "tick_size_change", asset_id: "t", new_tick_size: "0.01" }), ws(4, change("0.6", "3"))]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 4]);
  });

  test("never publishes a partially applied delta frame when another level is malformed", () => {
    const result = replayRecords([ws(1, book()), ws(2, { event_type: "price_change", price_changes: [
      { asset_id: "t", side: "SELL", price: "0.6", size: "2" },
      { asset_id: "t", side: "SELL", price: "0.7", size: "invalid" }
    ] }), ws(3, change("0.5", "1"))]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1]);
  });

  test("rejects an older server snapshot and requires a current full snapshot for recovery", () => {
    const result = replayRecords([ws(1, book("0.7", "4", "3000")), ws(2, book("0.99", "10", "2000")), ws(3, change("0.6", "2", "3100")), ws(4, book("0.5", "1", "4000"))]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 4]);
    expect(result.quality.outOfOrderMessages).toBe(1);
  });

  test("untimed snapshots never reset the source timestamp watermark", () => {
    const untimed: Record<string, unknown> = book();
    delete untimed.timestamp;
    const result = replayRecords([ws(1, book("0.7", "4", "3000")), ws(2, untimed), ws(3, book("0.6", "2", "2000"))]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 2]);
    expect(result.quotes[1]?.serverTimestamp).toBeUndefined();
    expect(result.quality.outOfOrderMessages).toBe(1);
  });

  test("validates source ordering within a single price change array before applying it", () => {
    const result = replayRecords([ws(1, book()), ws(2, { event_type: "price_change", price_changes: [
      { asset_id: "t", side: "SELL", price: "0.6", size: "1", timestamp: "3000" },
      { asset_id: "t", side: "SELL", price: "0.5", size: "2", timestamp: "2000" }
    ] })]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1]);
    expect(result.quality.outOfOrderMessages).toBe(1);
  });

  test("requires fresh full depth after unsubscribe and resubscribe on the same connection", () => {
    const result = replayRecords([
      ws(1, book()),
      rec(2, "collector", "subscription", { assets_ids: ["t"], operation: "unsubscribe" }, "clob-0-e1"),
      rec(3, "collector", "subscription", { assets_ids: ["t"], operation: "subscribe" }, "clob-0-e1"),
      ws(4, change("0.6", "2")), ws(5, book("0.5", "1", "4000"))
    ]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 5]);
  });

  test("subscribing a new token keeps untouched token depth valid", () => {
    const result = replayRecords([
      rec(1, "collector", "subscription", { assets_ids: ["t"], type: "market" }, "clob-0-e1"),
      ws(2, book()),
      rec(3, "collector", "subscription", { assets_ids: ["other"], operation: "subscribe" }, "clob-0-e1"),
      ws(4, change("0.6", "2"))
    ]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([2, 4]);
  });

  test.each(["book", "delta"])("a retired token's in-flight %s does not invalidate another active token", kind => {
    const result = replayRecords([
      rec(1, "collector", "subscription", { assets_ids: ["t", "retired"], type: "market" }, "clob-0-e1"),
      ws(2, [book(), { ...book(), asset_id: "retired" }]),
      rec(3, "collector", "subscription", { assets_ids: ["retired"], operation: "unsubscribe" }, "clob-0-e1"),
      ws(4, kind === "book" ? { ...book(), asset_id: "retired" } : {
        event_type: "price_change", price_changes: [
          { asset_id: "t", side: "SELL", price: "0.6", size: "2" },
          { asset_id: "retired", side: "SELL", price: "0.6", size: "2" }
        ]
      }),
      ws(5, change("0.5", "1"))
    ]);
    expect(result.quotes.filter(quote => quote.tokenId === "t").map(quote => quote.sequence)).toEqual(kind === "book" ? [2, 5] : [2, 4, 5]);
  });

  test("one token awaiting a snapshot does not suppress a valid sibling's delta", () => {
    const result = replayRecords([
      ws(1, book()),
      ws(2, { event_type: "price_change", price_changes: [
        { asset_id: "t", side: "SELL", price: "0.6", size: "2" },
        { asset_id: "new", side: "SELL", price: "0.6", size: "2" }
      ] })
    ]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 2]);
  });

  test("round trips journal segments across a UTC date rollback without reordering", async () => {
    const root = await mkdtemp(join(tmpdir(), "poly-date-replay-"));
    const dates = ["2026-09-10T23:59:59.900Z", "2026-09-11T00:00:00.100Z", "2026-09-10T23:59:59.950Z"];
    let index = 0;
    const journal = await createJournal({ rootDir: root, runId: "rollback", now: () => new Date(dates[index++]!), monotonicNs: () => BigInt(index) * 1_000_000_000n });
    try {
      journal.record({ source: "collector", kind: "session_start", data: {} });
      journal.record({ source: "clob", kind: "ws_message", connectionId: "clob-0-e1", data: JSON.stringify(book()) });
      journal.record({ source: "clob", kind: "ws_message", connectionId: "clob-0-e1", data: JSON.stringify(change("0.6", "2")) });
      await journal.close();
      const result = await readJournalRecords(journal.runDirectory);
      expect(result.records.map(record => record.sequence)).toEqual([1, 2, 3]);
      expect(result.quotes).toHaveLength(2);
    } finally {
      await journal.close().catch(() => {});
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true });
    }
  });

  test("a late book from a closed connection cannot reactivate it", () => {
    const result = replayRecords([ws(1, book()), rec(2, "collector", "connection_close", {}, "clob-0-e1"), ws(3, book()), ws(4, book(), "clob-0-e2")]);
    expect(result.quotes.map(quote => quote.sequence)).toEqual([1, 4]);
  });

  test("rejects mixed run IDs and invalid journal envelope numbers", () => {
    expect(() => replayRecords([ws(1, book()), { ...ws(2, change("0.6", "1")), runId: "different" }])).toThrow(/RUN/);
    expect(() => replayRecords([{ ...ws(1, book()), sequence: 1.5 }])).toThrow(/RECORD/);
    expect(() => replayRecords([{ ...ws(1, book()), schemaVersion: 2 } as unknown as ReplayJournalRecord])).toThrow(/RECORD/);
    expect(() => replayRecords([{ ...ws(1, book()), source: ["clob"] } as unknown as ReplayJournalRecord])).toThrow(/RECORD/);
  });

  test("excludes an unterminated tail from usable history, and invalidates after malformed complete lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "poly-replay-integrity-"));
    // Files are disposable synthetic fixtures; no user journal is modified.
    try {
      await writeFile(join(root, "2026-09-10-000000.ndjson"), [JSON.stringify(ws(1, book())), "{broken", JSON.stringify(ws(3, change("0.6", "3")))].join("\n") + "\n" + JSON.stringify(ws(4, book("0.5", "1", "4000"))));
      const result = await readJournalRecords(root);
      expect(result.quotes.map(quote => quote.sequence)).toEqual([1]);
      expect(result.quality.malformedLines).toBe(1);
      expect(result.quality.incompleteFinalLines).toBe(1);
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true });
    }
  });
});
