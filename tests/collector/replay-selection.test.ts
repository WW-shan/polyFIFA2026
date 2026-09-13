import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JournalReplay, marketMappingFromEvent, readJournalRecords, replayRecords, type ReplayInvalidation, type ReplayOptions } from "../../src/collector/replay.js";
import * as values from "../../src/collector/replay-values.js";
import { replayTail } from "../../src/collector/tail-replay.js";
import type { TailBookChange, TailOptions, TailSecond, TailSnapshotAudit, TailStateChange } from "../../src/collector/tail-types.js";
import type { JournalRecord } from "../../src/collector/types.js";
import { book, eventMetadata, fixtureRecords, journalRecord, writeFixture } from "./tail-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function ws(sequence: number, data: unknown, connectionId = "clob"): JournalRecord {
  return journalRecord(sequence, sequence * 1000, "clob", "ws_message", typeof data === "string" ? data : JSON.stringify(data), connectionId);
}
function snapshot(token: unknown = "A", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { event_type: "book", asset_id: token, timestamp: "1000", hash: "seed",
    bids: [{ price: "0.30", size: "3" }, { price: "0.40", size: "5" }],
    asks: [{ price: "0.80", size: "2" }, { price: "0.70", size: "4" }], ...extra };
}
function mutation(token: unknown = "A", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { asset_id: token, side: "BUY", price: "0.50", size: "6", hash: "delta", ...extra };
}
function delta(changes: unknown[] = [mutation()], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { event_type: "price_change", timestamp: "2000", price_changes: changes, ...extra };
}
function trade(token: unknown): Record<string, unknown> {
  return { event_type: "last_trade_price", asset_id: token, price: "0.50", size: "2", side: "BUY" };
}
function mixedRecords(): JournalRecord[] {
  return [
    journalRecord(1, 1000, "gamma", "event_metadata", eventMetadata()),
    journalRecord(2, 2000, "sports", "ws_message", JSON.stringify({ gameId: 123, score: "0-0", elapsed: "80:00" }), "sports"),
    ws(3, [snapshot("B"), snapshot("A")]),
    ws(4, [delta([mutation("B"), mutation("A", { hash: "intermediate" }), mutation("A", { size: "7", hash: "A-final" })]), trade("B"), trade("A")])
  ];
}
function selectedReplay(tokenIds: readonly string[] = ["A"]) {
  const invalidations: ReplayInvalidation[] = [];
  const replay = new JournalReplay({ tokenIds, onInvalidation: event => invalidations.push(event) });
  return { replay, invalidations };
}

describe("selected-token replay", () => {
  test("retains only A's depth, trades and mappings from mixed frames with original positions and context", () => {
    const records = mixedRecords(), before = JSON.stringify(records);
    const all = replayRecords(records);
    const selected = replayRecords(records, { tokenIds: ["A"] as const });
    expect(selected.quotes).toEqual(all.quotes.filter(row => row.tokenId === "A"));
    expect(selected.trades).toEqual(all.trades.filter(row => row.tokenId === "A"));
    expect(selected.markets).toEqual(all.markets.filter(row => row.tokenId === "A"));
    expect(selected.sports).toEqual(all.sports);
    expect(selected.quotes.map(row => [row.sequence, row.frameIndex, row.bookHash])).toEqual([[3, 1, "seed"], [4, 0, "A-final"]]);
    expect(selected.trades[0]?.frameIndex).toBe(2);
    expect(JSON.stringify(records)).toBe(before);
  });

  test("skips unselected depth parsing and sorting, rather than discarding constructed books", () => {
    const parseDepth = vi.spyOn(values, "levelMap"), sortDepth = vi.spyOn(values, "sortedLevels");
    const { replay } = selectedReplay();
    for (const record of mixedRecords()) replay.accept(record);
    expect(parseDepth).toHaveBeenCalledTimes(2);
    expect(sortDepth).toHaveBeenCalledTimes(4);
    expect(replay.getBookStatus("clob", "A")).toBe("valid");
    expect(replay.getBookStatus("clob", "B")).toBe("missing");
  });

  test("an empty selection emits no token data and reconstructs no books", () => {
    const parseDepth = vi.spyOn(values, "levelMap"), sortDepth = vi.spyOn(values, "sortedLevels");
    const result = replayRecords(mixedRecords(), { tokenIds: [] });
    expect(result.quotes).toEqual([]);
    expect(result.trades).toEqual([]);
    expect(result.markets).toEqual([]);
    expect(parseDepth).not.toHaveBeenCalled();
    expect(sortDepth).not.toHaveBeenCalled();
  });

  test("an empty selection still validates unscoped frames and the complete record sequence", () => {
    const { replay, invalidations } = selectedReplay([]);
    replay.accept(ws(1, snapshot("B")));
    replay.accept(ws(2, delta([mutation("B"), null], { asset_id: "B" })));
    replay.accept(ws(4, snapshot("B")));
    expect(invalidations).toEqual([{ connectionId: "clob", reason: "malformed_delta" }, { reason: "sequence_gap" }]);
    expect(replay.quality.sequenceGaps).toEqual([{ expected: 3, actual: 4 }]);
    expect(replay.quality.invalidBookUpdates).toBe(1);
  });

  test("omitting tokenIds retains legacy all-token output and numeric wire IDs", () => {
    const records = mixedRecords();
    expect(replayRecords(records)).toEqual(replayRecords(records, {}));
    const result = replayRecords(records);
    expect(result.quotes.map(row => row.tokenId)).toEqual(["B", "A", "B", "A"]);
    expect(result.trades.map(row => row.tokenId)).toEqual(["B", "A"]);
    expect(result.markets.map(row => row.tokenId)).toEqual(["A", "B"]);
    expect(replayRecords([ws(1, snapshot(1)), ws(2, trade(1))])).toMatchObject({ quotes: [{ tokenId: "1" }], trades: [{ tokenId: "1" }] });
  });

  test.each([
    ["snapshot", snapshot("B", { bids: "broken", timestamp: "bad" })],
    ["mixed delta", delta([mutation("B", { price: "bad", side: "bad", timestamp: "bad" }), mutation("A")])],
    ["delta envelope", { event_type: "price_change", asset_id: "B", price_changes: "broken" }],
    ["unknown mutation", { event_type: "future_depth_change", asset_id: "B" }],
    ["trade", { ...trade("B"), price: "bad", size: "bad" }]
  ])("a known unselected bad %s neither invalidates A nor contributes token diagnostics", (_name, frame) => {
    const { replay, invalidations } = selectedReplay();
    replay.accept(ws(1, snapshot()));
    replay.accept(ws(2, frame));
    expect(replay.getBookStatus("clob", "A")).toBe("valid");
    expect(replay.quality).toMatchObject({ invalidBookUpdates: 0, unknownFrames: 0, connectionInvalidations: 0, outOfOrderMessages: 0 });
    expect(invalidations).toEqual([]);
  });

  test.each([
    ["unparseable", '{"asset_id":"B",', "malformed_frame"],
    ["non-object", null, "malformed_frame"],
    ["snapshot without an asset", snapshot(undefined, { asset_id: undefined }), "malformed_snapshot"],
    ["unknown global mutation", { event_type: "future_depth_change" }, "unknown_frame"],
    ["unscoped delta envelope", { event_type: "price_change", price_changes: "broken" }, "malformed_delta"],
    ["missing child asset under unselected parent", delta([mutation("A"), { side: "BUY", price: "0.5", size: "1" }], { asset_id: "B" }), "malformed_delta"],
    ["non-object child under unselected parent", delta([mutation("A"), null], { asset_id: "B" }), "malformed_delta"]
  ])("an unattributable %s invalidates selected depth before any partial mutation can escape", (_name, frame, reason) => {
    const { replay, invalidations } = selectedReplay();
    replay.accept(ws(1, snapshot()));
    expect(replay.accept(ws(2, frame)).quotes).toEqual([]);
    expect(replay.getBookStatus("clob", "A")).toBe("invalid");
    expect(invalidations).toEqual([{ connectionId: "clob", reason }]);
    expect(replay.accept(ws(3, delta())).quotes).toEqual([]);
    expect(replay.accept(ws(4, snapshot("A", { timestamp: "4000" }))).quotes).toHaveLength(1);
  });

  test.each([
    ["snapshot", snapshot("A", { asks: "broken", timestamp: "4000" })],
    ["delta", delta([mutation("B"), mutation("A"), mutation("A", { size: "broken" })], { timestamp: "4000", asset_id: "B" })],
    ["inherited source clock", delta([mutation("B"), mutation("A")], { timestamp: "broken", asset_id: "B" })]
  ])("a malformed selected %s is still rejected and cannot be repaired by an ordinary delta", (_name, frame) => {
    const { replay } = selectedReplay();
    replay.accept(ws(1, snapshot()));
    expect(replay.accept(ws(2, frame)).quotes).toEqual([]);
    expect(replay.accept(ws(3, delta([mutation()], { timestamp: "5000" }))).quotes).toEqual([]);
    expect(replay.getBookStatus("clob", "A")).toBe("invalid");
    expect(replay.quality.invalidBookUpdates).toBeGreaterThan(0);
  });

  test("an unselected parent never hides a selected delta that still needs its snapshot", () => {
    const { replay, invalidations } = selectedReplay();
    expect(replay.accept(ws(1, delta([mutation("B"), mutation("A")], { asset_id: "B" }))).quotes).toEqual([]);
    expect(invalidations).toEqual([{ connectionId: "clob", tokenId: "A", reason: "snapshot_required" }]);
    expect(replay.getBookStatus("clob", "A")).toBe("missing");
  });

  test("rejected selected mutations retain their source watermark without borrowing an unselected clock", () => {
    const { replay } = selectedReplay();
    replay.accept(ws(1, snapshot()));
    replay.accept(ws(2, delta([mutation("B", { timestamp: "9000" }), mutation("A", { size: "bad", timestamp: "4000" })])));
    expect(replay.accept(ws(3, snapshot("A", { timestamp: "3000" }))).quotes).toEqual([]);
    expect(replay.quality.outOfOrderMessages).toBe(1);
    expect(replay.accept(ws(4, snapshot("A", { timestamp: "5000" }))).quotes).toHaveLength(1);
  });

  test.each([undefined, "A", "B"])("keeps original mixed-frame best-price attribution (parent: %s)", parent => {
    const records = [ws(1, [snapshot(), snapshot("B")]), ws(2, delta([mutation("B"), mutation("A")], { asset_id: parent, best_bid: "0.55" }))];
    const all = replayRecords(records), selected = replayRecords(records, { tokenIds: ["A"] });
    expect(selected.quotes).toEqual(all.quotes.filter(row => row.tokenId === "A"));
    expect(selected.quotes.map(row => row.sequence)).toEqual(parent === "A" ? [1] : [1, 2]);
  });

  test("retains frame-level assertions for a genuinely single-token delta", () => {
    const result = replayRecords([ws(1, snapshot()), ws(2, delta([mutation()], { best_bid: "0.55" }))], { tokenIds: ["A"] });
    expect(result.quotes.map(row => row.sequence)).toEqual([1]);
    expect(result.quality.invalidBookUpdates).toBe(1);
  });

  test("a numeric mixed-frame parent cannot hide a selected book's best-price contradiction", () => {
    const { replay, invalidations } = selectedReplay(["1"]);
    replay.accept(ws(1, snapshot("1")));
    const frame = delta([mutation("B"), mutation("1")], { asset_id: 1, best_bid: "0.55" });
    expect(replay.accept(ws(2, frame)).quotes).toEqual([]);
    expect(invalidations).toEqual([{ connectionId: "clob", reason: "malformed_delta" }]);
    expect(replay.getBookStatus("clob", "1")).toBe("invalid");
    expect(replay.accept(ws(3, delta([mutation("1")]))).quotes).toEqual([]);
  });

  test("token strings match exactly, including large IDs, whitespace and leading zeros", () => {
    const ids = ["1", "01", "10", "x1", "1x", " 1 ", "9007199254740992", "9007199254740993"];
    const selected = ["1", "9007199254740993"] as const;
    const result = replayRecords([ws(1, ids.map(id => snapshot(id))), ws(2, ids.map(trade))], { tokenIds: selected });
    expect(result.quotes.map(row => row.tokenId)).toEqual(selected);
    expect(result.trades.map(row => row.tokenId)).toEqual(selected);
  });

  test.each([snapshot(1), delta([mutation(1)])])("numeric depth attribution never matches a string token and fails closed: %j", frame => {
    const { replay, invalidations } = selectedReplay(["1"]);
    replay.accept(ws(1, snapshot("1")));
    expect(replay.accept(ws(2, frame)).quotes).toEqual([]);
    expect(replay.getBookStatus("clob", "1")).toBe("invalid");
    expect(invalidations[0]?.tokenId).toBeUndefined();
    expect(replay.accept(ws(3, trade(1))).trades).toEqual([]);
  });

  test("selected metadata uses literal IDs without changing the public all-market mapper", () => {
    const data = { normalized: { markets: [{ tokenIds: ["1", 1, "B"], outcomes: ["literal", "numeric", "other"] }] } };
    const result = replayRecords([journalRecord(1, 1000, "gamma", "event_metadata", data)], { tokenIds: ["1"] });
    expect(result.markets).toMatchObject([{ tokenId: "1", outcome: "literal" }]);
    expect(marketMappingFromEvent(data).map(row => row.outcome)).toEqual(["literal", "numeric", "other"]);
  });

  test.each(["sequence", "monotonic", "run", "envelope"])("ordering validation remains global on an unselected record: %s", damage => {
    for (const tokenIds of [["A"], []]) {
      const { replay, invalidations } = selectedReplay(tokenIds);
      replay.accept(ws(1, snapshot()));
      const record = ws(2, snapshot("B"));
      if (damage === "sequence") record.sequence = 1;
      if (damage === "monotonic") record.monotonicNs = "0";
      if (damage === "run") record.runId = "other-run";
      if (damage === "envelope") record.sequence = 1.5;
      expect(() => replay.accept(record)).toThrow(/REPLAY_/);
      expect(invalidations).toEqual([{ reason: `journal_${damage}_invalid` }]);
      if (tokenIds.length) expect(replay.getBookStatus("clob", "A")).toBe("invalid");
    }
  });

  test("an unselected record revealing a sequence gap invalidates every selected connection", () => {
    const { replay, invalidations } = selectedReplay();
    replay.accept(ws(1, snapshot()));
    replay.accept(ws(2, snapshot(), "other-connection"));
    expect(replay.accept(ws(4, snapshot("B"))).quotes).toEqual([]);
    expect(replay.quality.sequenceGaps).toEqual([{ expected: 3, actual: 4 }]);
    expect(invalidations).toEqual([{ reason: "sequence_gap" }]);
    expect(replay.getBookStatus("clob", "A")).toBe("invalid");
    expect(replay.getBookStatus("other-connection", "A")).toBe("invalid");
    expect(replay.accept(ws(5, delta())).quotes).toEqual([]);
  });

  test("an unselected frame without a connection still invalidates globally", () => {
    const { replay, invalidations } = selectedReplay();
    replay.accept(ws(1, snapshot()));
    const record = ws(2, snapshot("B")); delete record.connectionId;
    replay.accept(record);
    expect(invalidations).toEqual([{ reason: "missing_connection" }]);
    expect(replay.getBookStatus("clob", "A")).toBe("invalid");
  });

  test.each(["connection_close", "connection_gap", "connection_timeout", "heartbeat_timeout", "connection_open"])("preserves connection lifecycle invalidation: %s", kind => {
    const { replay, invalidations } = selectedReplay();
    replay.accept(ws(1, snapshot()));
    replay.accept(journalRecord(2, 2000, "collector", kind, { assets_ids: ["B"] }, "clob"));
    expect(replay.accept(ws(3, delta())).quotes).toEqual([]);
    expect(invalidations[0]).toEqual({ connectionId: "clob", reason: kind });
  });

  test("a global subscription reset containing only unselected tokens still removes A", () => {
    const { replay, invalidations } = selectedReplay();
    replay.accept(ws(1, snapshot()));
    replay.accept(journalRecord(2, 2000, "collector", "subscription", { type: "market", assets_ids: ["B"] }, "clob"));
    expect(invalidations).toEqual([{ connectionId: "clob", reason: "subscription_reset" }]);
    expect(replay.accept(ws(3, snapshot())).quotes).toEqual([]);
    expect(replay.getBookStatus("clob", "A")).toBe("invalid");
  });

  test("numeric subscription IDs cannot authorize a selected string token", () => {
    const { replay } = selectedReplay(["1"]);
    replay.accept(journalRecord(1, 1000, "collector", "subscription", { type: "market", assets_ids: [1] }, "clob"));
    expect(replay.accept(ws(2, snapshot("1"))).quotes).toEqual([]);
    expect(replay.getBookStatus("clob", "1")).toBe("invalid");
  });

  test.each(["subscribe", "unsubscribe"])("ambiguous numeric %s invalidates conservatively without identifying a string token", operation => {
    const { replay, invalidations } = selectedReplay(["1", "A"]);
    replay.accept(ws(1, [snapshot("1"), snapshot("A")]));
    replay.accept(journalRecord(2, 2000, "collector", "subscription", { operation, assets_ids: [1] }, "clob"));
    expect(invalidations).toEqual([{ connectionId: "clob", reason: "malformed_subscription" }]);
    expect(replay.getBookStatus("clob", "A")).toBe("invalid");
    expect(replay.accept(ws(3, delta([mutation("1"), mutation("A")]))).quotes).toEqual([]);
  });

  test("unsubscribe/resubscribe still requires a fresh selected snapshot", () => {
    const { replay } = selectedReplay();
    replay.accept(ws(1, snapshot()));
    for (const [index, operation] of ["unsubscribe", "subscribe"].entries()) {
      replay.accept(journalRecord(index + 2, (index + 2) * 1000, "collector", "subscription", { operation, assets_ids: ["A", "B"] }, "clob"));
    }
    expect(replay.accept(ws(4, delta())).quotes).toEqual([]);
    expect(replay.accept(ws(5, snapshot("A", { timestamp: "5000" }))).quotes).toHaveLength(1);
  });

  test("condition resolution still reaches selected outcomes when the explicit asset is unselected", () => {
    const { replay, invalidations } = selectedReplay();
    replay.accept(journalRecord(1, 1000, "gamma", "event_metadata", eventMetadata()));
    replay.accept(ws(2, [snapshot(), snapshot("B")]));
    replay.accept(ws(3, { event_type: "market_resolved", asset_id: "B", assets_ids: ["B"], market: "condition" }));
    expect(invalidations).toEqual([{ connectionId: "clob", tokenId: "A", reason: "market_resolved" }]);
    expect(replay.accept(ws(4, delta())).quotes).toEqual([]);
  });

  test.each([{ assets_ids: [1] }, { asset_id: 1 }, { assets_ids: ["B", 1] }])("numeric resolution IDs invalidate uncertainty without falsely closing string tokens: %j", identity => {
    const { replay, invalidations } = selectedReplay(["1", "A"]);
    replay.accept(ws(1, [snapshot("1"), snapshot("A")]));
    replay.accept(ws(2, { event_type: "market_resolved", ...identity }));
    expect(invalidations).toEqual([{ connectionId: "clob", reason: "malformed_market_resolved" }]);
    expect(replay.getBookStatus("clob", "1")).toBe("invalid");
    expect(replay.getBookStatus("clob", "A")).toBe("invalid");
    expect(replay.accept(ws(3, delta([mutation("1"), mutation("A")]))).quotes).toEqual([]);
  });
});

describe("selected replay source batches", () => {
  function seed(): Record<string, unknown> {
    return snapshot("A", { bids: [{ price: "0.60", size: "5" }, { price: "0.50", size: "5" }, { price: "0.40", size: "5" }] });
  }
  function fragment(price: string, hash = "batch", timestamp = "2000"): Record<string, unknown> {
    return delta([mutation("B", { hash: "B-batch" }), mutation("A", { price, size: "0", hash, best_bid: "0.40", best_ask: "0.70" })], { timestamp });
  }

  test("keeps provisional invalidations, same-batch recovery and hash clearing identical to all-token replay", () => {
    const records = [ws(1, [seed(), snapshot("B")]), ws(2, fragment("0.60")), ws(3, fragment("0.50")),
      ws(4, delta([mutation("B"), mutation("A", { price: "0.40", hash: undefined })], { timestamp: "3000" }))];
    const allEvents: ReplayInvalidation[] = [], selectedEvents: ReplayInvalidation[] = [];
    const all = replayRecords(records, { onInvalidation: event => allEvents.push(event) });
    const selected = replayRecords(records, { tokenIds: ["A"], onInvalidation: event => selectedEvents.push(event) });
    expect(selected.quotes).toEqual(all.quotes.filter(row => row.tokenId === "A"));
    expect(selectedEvents).toEqual(allEvents.filter(event => event.tokenId === undefined || event.tokenId === "A"));
    expect(selectedEvents).toEqual([{ connectionId: "clob", tokenId: "A", reason: "best_bid_mismatch", provisional: true }]);
    expect(selected.quality.bookConsistency).toMatchObject({ provisionalInvalidations: 1, recoveredByDelta: 1, persistentInvalidations: 0 });
    expect(selected.quotes.map(row => [row.sequence, row.bookHash])).toEqual([[1, "seed"], [3, "batch"], [4, undefined]]);
  });

  test.each(["omitted selected fragment", "global malformed frame", "sequence gap"])("%s cannot be hidden by unselected traffic during a provisional batch", damage => {
    const { replay } = selectedReplay();
    replay.accept(ws(1, seed()));
    expect(replay.accept(ws(2, fragment("0.60"))).quotes).toEqual([]);
    if (damage === "omitted selected fragment") {
      // The source changes batch after a missing cancellation, even with contiguous journal sequence.
      replay.accept(ws(3, delta([mutation("B")])));
      expect(replay.accept(ws(4, fragment("0.50", "next-batch", "3000"))).quotes).toEqual([]);
      expect(replay.quality.bookConsistency?.persistentInvalidations).toBe(1);
    } else {
      const sequence = damage === "sequence gap" ? 4 : 3;
      replay.accept(ws(sequence, damage === "sequence gap" ? snapshot("B") : delta([mutation("B"), null], { asset_id: "B" })));
      expect(replay.accept(ws(sequence + 1, fragment("0.50"))).quotes).toEqual([]);
    }
    expect(replay.getBookStatus("clob", "A")).toBe("invalid");
    expect(replay.quality.bookConsistency?.recoveredByDelta).toBe(0);
    expect(replay.accept(ws(damage === "sequence gap" ? 6 : 5, snapshot("A", { timestamp: "4000" }))).quotes).toHaveLength(1);
  });
});

function ordered(records: JournalRecord[]): JournalRecord[] {
  return records.sort((a, b) => a.receivedAtMs - b.receivedAtMs).map((record, index) => ({
    ...record, sequence: index + 1, monotonicNs: String(BigInt(record.receivedAtMs) * 1_000_000n + BigInt(index))
  }));
}
function twoMatchRecords(): JournalRecord[] {
  const records = fixtureRecords();
  const initial = JSON.parse(records[5]!.data as string) as { bids: unknown[] };
  initial.bids.push({ price: "0.85", size: "10" }, { price: "0.60", size: "10" });
  records[5]!.data = JSON.stringify(initial);
  for (const [index, price] of [[8, "0.95"], [9, "0.85"]] as const) {
    records[index]!.data = JSON.stringify(delta([
      mutation("C", { price: "0.20", size: "8", hash: "C-batch" }),
      mutation("A", { price, size: "0", hash: "A-batch", best_bid: "0.60", best_ask: "0.97" })
    ], { timestamp: "11090", asset_id: "C" }));
  }
  records[11]!.data = { tokenId: "A", response: { asset_id: "A", hash: "A-batch", timestamp: "11090",
    bids: [{ price: "0.60", size: "10" }], asks: [{ price: "0.97", size: "12" }] } };
  return ordered([...records,
    journalRecord(1, 500, "gamma", "event_metadata", eventMetadata(310_000, { id: "other-event", slug: "other-game", gameId: 456,
      markets: [{ id: "other-winner", slug: "other-winner", conditionId: "other-condition", question: "Other winner?",
        outcomes: ["C", "D"], clobTokenIds: ["C", "D"], sportsMarketType: "moneyline", closed: false, acceptingOrders: true }] })),
    journalRecord(1, 600, "collector", "subscription", { operation: "subscribe", assets_ids: ["C", "D"] }, "clob"),
    journalRecord(1, 9003, "clob", "ws_message", book("C", "0.20", "0.30", 9003, "C-seed"), "clob"),
    journalRecord(1, 9004, "clob", "ws_message", book("D", "0.70", "0.80", 9004, "D-seed"), "clob"),
    journalRecord(1, 9005, "sports", "ws_message", JSON.stringify({ gameId: 456, slug: "other-game", score: "2-2", period: "2H" }), "sports"),
    journalRecord(1, 11200, "clob", "ws_message", JSON.stringify([trade("C"), trade("A"), trade("D")]), "clob"),
    journalRecord(1, 11300, "clob", "ws_message", book("D", "0.70", "0.80", 11300, "D-new"), "clob"),
    journalRecord(1, 11400, "clob", "ws_message", "PONG", "clob")
  ]);
}
async function fixtureRun(records: JournalRecord[]): Promise<string> {
  const root = await writeFixture(records); roots.push(root);
  return join(root, "run");
}
async function tail(runDirectory: string, options: Partial<TailOptions> = {}) {
  const seconds: TailSecond[] = [], changes: TailBookChange[] = [], audits: TailSnapshotAudit[] = [];
  const states: Array<TailStateChange & { windowKey: string }> = [];
  const raw: Array<{ record: JournalRecord; windowKeys: string[] }> = [];
  const summary = await replayTail({ runDirectory, maxFeedSilenceMs: 600_000, sportsStaleAfterMs: 600_000, ...options }, {
    second: row => { seconds.push(row); }, change: row => { changes.push(row); }, audit: row => { audits.push(row); },
    stateChange: row => { states.push(row); }, rawRecord: (record, windowKeys) => { raw.push({ record, windowKeys }); }
  });
  return { summary, seconds, changes, audits, states, raw };
}

describe("selected tail replay", () => {
  test("matches all-match prices, state, audits and raw records without reconstructing the other match", async () => {
    const records = twoMatchRecords(), run = await fixtureRun(records);
    const file = join(run, "1970-01-01-000000.ndjson"), before = await readFile(file, "utf8");
    const all = await tail(run), selected = await tail(run, { eventSlugs: ["game"] });
    const inWindow = (row: { windowKey: string }) => row.windowKey === "game:123";
    expect(selected.seconds).toEqual(all.seconds.filter(inWindow));
    expect(selected.changes).toEqual(all.changes.filter(inWindow));
    expect(selected.states).toEqual(all.states.filter(inWindow));
    expect(selected.audits).toEqual(all.audits.filter(inWindow));
    expect(selected.summary.tokens).toEqual(all.summary.tokens.filter(inWindow));
    expect(selected.summary.tokens.every(token => token.readyForReplay)).toBe(true);
    expect(selected.seconds.find(row => row.tokenId === "A" && row.startAtMs === 11000)).toMatchObject({
      bestBid: "0.60", minBestBid: 0.60, maxBestBid: 0.95, tradeCount: 1, wholeSecondValid: true, score: "1-0"
    });
    const originalWindow = records.filter(record => record.receivedAtMs >= 10000 && record.receivedAtMs < 310000);
    expect(selected.raw.map(row => row.record)).toEqual(originalWindow);
    expect(selected.raw.map(row => row.record)).toEqual(all.raw.map(row => row.record));
    expect(selected.raw.every(row => row.windowKeys.length === 1 && row.windowKeys[0] === "game:123")).toBe(true);
    expect(selected.summary.rawRecords).toBe(originalWindow.length);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(selected.summary.warnings.join(" ")).toMatch(/frame\/book\/trade diagnostics are selection-scoped.*journal ordering.*global/i);
  });

  test("tail diagnostics exclude unselected mutations while rawRecord retains them", async () => {
    const records = ordered([...twoMatchRecords(), journalRecord(1, 12500, "clob", "ws_message",
      JSON.stringify([snapshot("C", { asks: "broken" }), { event_type: "future_depth_change", asset_id: "D" }, { ...trade("C"), size: "bad" }]), "clob")]);
    const run = await fixtureRun(records), all = await tail(run), selected = await tail(run, { eventSlugs: ["game"] });
    expect(selected.summary.journalQuality.invalidBookUpdates).toBe(1); // Only A's provisional batch.
    expect(selected.summary.journalQuality.unknownFrames).toBe(0);
    expect(all.summary.journalQuality.invalidBookUpdates).toBeGreaterThan(selected.summary.journalQuality.invalidBookUpdates);
    expect(all.summary.journalQuality.unknownFrames).toBe(2);
    expect(selected.summary.tokens).toEqual(all.summary.tokens.filter(token => token.windowKey === "game:123"));
    expect(selected.raw.some(row => row.record.receivedAtMs === 12500)).toBe(true);
  });

  test.each(["missing snapshot", "missing delta", "unattributable frame", "sequence gap"])("selection never turns %s into complete selected history", async damage => {
    let records = twoMatchRecords();
    if (damage === "missing snapshot") records = records.filter(record => record.receivedAtMs !== 9000);
    if (damage === "missing delta") {
      records.find(record => record.receivedAtMs === 11800)!.data = JSON.stringify(delta([mutation("C", { price: "0.20" })], { timestamp: "11090", asset_id: "C" }));
    }
    if (damage === "unattributable frame") records.push(journalRecord(1, 11500, "clob", "ws_message", JSON.stringify(delta([mutation("C"), null], { asset_id: "C" })), "clob"));
    records = ordered(records);
    if (damage === "sequence gap") for (const record of records) if (record.receivedAtMs >= 11300) record.sequence++;
    const run = await fixtureRun(records), all = await tail(run), selected = await tail(run, { eventSlugs: ["game"] });
    expect(selected.seconds).toEqual(all.seconds.filter(row => row.windowKey === "game:123"));
    expect(selected.changes).toEqual(all.changes.filter(row => row.windowKey === "game:123"));
    expect(selected.summary.tokens).toEqual(all.summary.tokens.filter(row => row.windowKey === "game:123"));
    expect(selected.summary.tokens.find(token => token.tokenId === "A")).toMatchObject({ observedWindowComplete: false, readyForReplay: false });
    expect(selected.raw.map(row => row.record)).toEqual(records.filter(record => record.receivedAtMs >= 10000 && record.receivedAtMs < 310000));
  });

  test("readJournalRecords selection retains original records and leaves source bytes untouched", async () => {
    const records = mixedRecords(), run = await fixtureRun(records);
    const file = join(run, "1970-01-01-000000.ndjson"), before = await readFile(file, "utf8");
    const options: ReplayOptions = { tokenIds: ["A"] };
    const result = await readJournalRecords(run, options);
    expect(result.records).toEqual(records);
    expect(result.quotes).toEqual(replayRecords(records).quotes.filter(row => row.tokenId === "A"));
    expect(result.trades.map(row => row.tokenId)).toEqual(["A"]);
    expect(result.markets.map(row => row.tokenId)).toEqual(["A"]);
    expect(await readFile(file, "utf8")).toBe(before);
  });
});
