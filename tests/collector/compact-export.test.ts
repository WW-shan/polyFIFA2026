import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { openCompactTailStore } from "../../src/collector/continuous-tail-store.js";
import { exportCompactMatch } from "../../src/collector/compact-export.js";
import { compactEventMetadata } from "../../src/collector/continuous-state.js";
import type { CapturedGame } from "../../src/collector/continuous-state.js";
import type { JournalRecord } from "../../src/collector/types.js";
import type { TailMetadata } from "../../src/collector/tail-types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "poly-fifa-compact-export-")); roots.push(path); return path; }

const CONDITION = "0x1111111111111111111111111111111111111111111111111111111111111111";
const FINISH = 400_000;

function metadata(): TailMetadata {
  const rawMarket = { id: "market-1", conditionId: CONDITION, slug: "market-1", question: "Will A win?",
    outcomes: ["Yes", "No"], clobTokenIds: ["yes", "no"], sportsMarketType: "moneyline", closed: false };
  return { eventId: "evt-1", eventSlug: "a-vs-b", title: "A vs B", gameId: "42", parentEventId: null,
    sport: "tennis", tags: ["tennis"], finishAtMs: null, finishSource: null, observedAtMs: 0, sequence: 1,
    raw: { id: "evt-1", slug: "a-vs-b", title: "A vs B", gameId: "42", sport: "tennis", markets: [rawMarket] },
    markets: [{ eventId: "evt-1", eventSlug: "a-vs-b", gameId: "42", marketId: "market-1", marketSlug: "market-1",
      conditionId: CONDITION, tokenId: "yes", outcome: "Yes", question: "Will A win?", marketType: "moneyline",
      closed: false, acceptingOrders: true, raw: rawMarket },
    { eventId: "evt-1", eventSlug: "a-vs-b", gameId: "42", marketId: "market-1", marketSlug: "market-1",
      conditionId: CONDITION, tokenId: "no", outcome: "No", question: "Will A win?", marketType: "moneyline",
      closed: true, acceptingOrders: false, raw: rawMarket }] };
}

function clob(sequence: number, receivedAtMs: number, data: unknown, connectionId = "clob-0-e1"): JournalRecord {
  return { schemaVersion: 1, runId: "run-1", sequence, receivedAt: new Date(receivedAtMs).toISOString(), receivedAtMs,
    monotonicNs: String(sequence), source: "clob", kind: "ws_message", connectionId, data: JSON.stringify(data) };
}
function anchor(sequence: number, receivedAtMs: number, tokenId: string, bids: unknown[], asks: unknown[], timestamp: string, hash: string): JournalRecord {
  return { schemaVersion: 1, runId: "run-1", sequence, receivedAt: new Date(receivedAtMs).toISOString(), receivedAtMs,
    monotonicNs: String(sequence), source: "clob", kind: "book_snapshot",
    data: { tokenId, response: { market: CONDITION, asset_id: tokenId, timestamp, hash, bids, asks } } };
}
function lifecycle(sequence: number, receivedAtMs: number, kind: string, connectionId: string, data: unknown = {}): JournalRecord {
  return { schemaVersion: 1, runId: "run-1", sequence, receivedAt: new Date(receivedAtMs).toISOString(), receivedAtMs,
    monotonicNs: String(sequence), source: "collector", kind, connectionId, data };
}
function game(): CapturedGame {
  return { key: "game:42", title: "A vs B", sport: "tennis", gameId: "42", eventIds: ["evt-1"], eventSlugs: ["a-vs-b"],
    tokenIds: ["yes", "no"], marketIds: ["market-1"], firstSeenAtMs: 0, lastSeenAtMs: FINISH,
    firstBookAtMs: 0, lastBookAtMs: FINISH, lastBookRunId: "run-1", bookUpdates: 9, trades: 0, stateObservations: 1,
    finishedAtMs: FINISH, finishAnchor: "book-quiet", finishConflict: false, retiredEventIds: ["evt-1"],
    phase: "postmatch", sources: [], eventMetadata: compactEventMetadata(metadata()) };
}

describe("compact tail export", () => {
  test("rebuilds a replayable archive from a compact tail whose only full book is an HTTP anchor", async () => {
    const path = await root();
    const store = await openCompactTailStore({ dataRoot: path, tailWindowMs: 180_000, bufferMs: 30_000,
      retentionMs: 3_600_000, maxBytes: 8 * 1024 ** 3, now: () => FINISH });
    const START = FINISH - 180_000;
    // The subscription's original `book` push happened hours earlier and is long
    // pruned; only HTTP anchors and price changes survive in compact storage.
    store.ingest(anchor(1, START, "yes", [{ price: "0.5", size: "10" }], [{ price: "0.6", size: "20" }], "1000", "h1"), ["game:42"]);
    store.ingest(anchor(2, START, "no", [{ price: "0.4", size: "30" }], [{ price: "0.5", size: "40" }], "1000", "h2"), ["game:42"]);
    store.ingest(clob(3, START + 60_000, { market: CONDITION, event_type: "price_change", timestamp: "2000",
      price_changes: [{ asset_id: "yes", price: "0.6", size: "5", side: "SELL", hash: "h3", best_bid: "0.5", best_ask: "0.6" }] }), ["game:42"]);
    store.ingest(clob(4, START + 120_000, { market: CONDITION, event_type: "price_change", timestamp: "3000",
      price_changes: [{ asset_id: "no", price: "0.45", size: "5", side: "BUY", hash: "h4", best_bid: "0.45", best_ask: "0.5" }] }), ["game:42"]);
    // The closing anchor must equal anchor + deltas; that is what the audit checks.
    store.ingest(anchor(5, FINISH - 1_000, "yes", [{ price: "0.5", size: "10" }], [{ price: "0.6", size: "5" }], "2000", "h3"), ["game:42"]);
    store.ingest(anchor(6, FINISH - 1_000, "no", [{ price: "0.4", size: "30" }, { price: "0.45", size: "5" }], [{ price: "0.5", size: "40" }], "3000", "h4"), ["game:42"]);
    store.flush();
    store.finalize(game(), FINISH);

    const result = await exportCompactMatch(store, "game:42", { outputDirectory: join(path, "archive") });
    expect(result.anchorFrames).toBe(4);
    const summary = JSON.parse(await readFile(join(result.archive.outputDirectory, "quality.json"), "utf8"));
    expect(summary.windows).toHaveLength(1);
    expect(summary.tokens).toHaveLength(2);
    const yes = summary.tokens.find((token: { tokenId: string }) => token.tokenId === "yes");
    // Without the anchor conversion this is 0: the engine only seeds from
    // WebSocket `book` frames, which compact storage no longer holds.
    expect(yes.validSeconds).toBeGreaterThan(170);
    expect(yes.snapshotMismatches).toBe(0);
    expect(yes.snapshotMatches).toBeGreaterThan(0);
    const seconds = (await readFile(join(result.archive.outputDirectory, "seconds.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const last = seconds.filter((row: { tokenId: string; secondIndex: number }) => row.tokenId === "yes" && row.secondIndex === 179)[0];
    expect(last.asks).toEqual([{ price: "0.6", size: "5" }]);
    store.close();
  });

  test("keeps a connection gap in the compact archive and invalidates later book seconds", async () => {
    const path = await root();
    const store = await openCompactTailStore({ dataRoot: path, tailWindowMs: 180_000, bufferMs: 30_000,
      retentionMs: 3_600_000, maxBytes: 8 * 1024 ** 3, now: () => FINISH });
    const START = FINISH - 180_000;
    store.ingest(anchor(1, START, "yes", [{ price: "0.5", size: "10" }], [{ price: "0.6", size: "20" }], "1000", "h1"), ["game:42"]);
    store.ingest(anchor(2, START, "no", [{ price: "0.4", size: "30" }], [{ price: "0.5", size: "40" }], "1000", "h2"), ["game:42"]);
    store.ingest(clob(3, START + 60_000, { market: CONDITION, event_type: "price_change", timestamp: "2000",
      price_changes: [{ asset_id: "yes", price: "0.6", size: "5", side: "SELL", hash: "h3", best_bid: "0.5", best_ask: "0.6" }] }), ["game:42"]);
    store.ingest({ schemaVersion: 1, runId: "run-1", sequence: 4, receivedAt: new Date(START + 120_000).toISOString(),
      receivedAtMs: START + 120_000, monotonicNs: "4", source: "collector", kind: "connection_gap",
      connectionId: "clob-0-e1", data: { reason: "inbound_timeout" } }, ["game:42"]);
    store.flush();
    store.finalize(game(), FINISH);
    const result = await exportCompactMatch(store, "game:42", { outputDirectory: join(path, "archive") });
    const summary = JSON.parse(await readFile(join(result.archive.outputDirectory, "quality.json"), "utf8"));
    expect(summary.journalQuality.connectionInvalidations).toBeGreaterThan(0);
    const seconds = (await readFile(join(result.archive.outputDirectory, "seconds.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(seconds.filter((row: { tokenId: string; secondIndex: number }) => row.tokenId === "yes" && row.secondIndex === 150)[0].status)
      .toBe("invalid");
    store.close();
  });

  test("labels a book-anchored window with the real anchor instead of inventing a clock", async () => {
    const path = await root();
    const store = await openCompactTailStore({ dataRoot: path, tailWindowMs: 180_000, bufferMs: 30_000,
      retentionMs: 3_600_000, maxBytes: 8 * 1024 ** 3, now: () => FINISH });
    const START = FINISH - 180_000;
    store.ingest(anchor(1, START, "yes", [{ price: "0.5", size: "10" }], [{ price: "0.6", size: "20" }], "1000", "h1"), ["game:42"]);
    store.ingest(anchor(2, START, "no", [{ price: "0.4", size: "30" }], [{ price: "0.5", size: "40" }], "1000", "h2"), ["game:42"]);
    store.flush();
    store.finalize(game(), FINISH);

    const result = await exportCompactMatch(store, "game:42", { outputDirectory: join(path, "archive") });
    const summary = JSON.parse(await readFile(join(result.archive.outputDirectory, "quality.json"), "utf8"));
    // The window ends on the collector's last order-book frame. Writing that as
    // `finishedTimestamp` would claim Gamma published a clock that never existed.
    expect(summary.windows[0].finishSources).toEqual(["book-quiet"]);
    store.close();
  });

  test("assigns an HTTP anchor to the connection that is active after a reconnect", async () => {
    const path = await root();
    const store = await openCompactTailStore({ dataRoot: path, tailWindowMs: 180_000, bufferMs: 30_000,
      retentionMs: 3_600_000, maxBytes: 8 * 1024 ** 3, now: () => FINISH });
    const START = FINISH - 180_000;
    store.ingest(anchor(1, START, "yes", [{ price: "0.5", size: "10" }], [{ price: "0.6", size: "20" }], "1000", "h1"), ["game:42"]);
    store.ingest(anchor(2, START, "no", [{ price: "0.4", size: "30" }], [{ price: "0.5", size: "40" }], "1000", "h2"), ["game:42"]);
    store.ingest(lifecycle(3, START + 1_000, "connection_open", "clob-0-e1", { source: "clob" }), ["game:42"]);
    store.ingest(clob(4, START + 2_000, { market: CONDITION, event_type: "book", asset_id: "yes",
      bids: [{ price: "0.5", size: "10" }], asks: [{ price: "0.6", size: "20" }], timestamp: "2000", hash: "h3" }, "clob-0-e1"), ["game:42"]);
    store.ingest(lifecycle(5, START + 3_000, "connection_gap", "clob-0-e1", { reason: "inbound_timeout" }), ["game:42"]);
    store.ingest(lifecycle(6, START + 4_000, "connection_open", "clob-0-e2", { source: "clob" }), ["game:42"]);
    store.ingest(anchor(7, START + 5_000, "yes", [{ price: "0.5", size: "10" }], [{ price: "0.6", size: "20" }], "2000", "h3"), ["game:42"]);
    store.ingest(anchor(8, START + 5_000, "no", [{ price: "0.4", size: "30" }], [{ price: "0.5", size: "40" }], "1000", "h2"), ["game:42"]);
    store.flush();
    store.finalize(game(), FINISH);
    const result = await exportCompactMatch(store, "game:42", { outputDirectory: join(path, "archive") });
    const summary = JSON.parse(await readFile(join(result.archive.outputDirectory, "quality.json"), "utf8"));
    const yes = summary.tokens.find((token: { tokenId: string }) => token.tokenId === "yes");
    expect(yes.validSeconds).toBeGreaterThan(0);
    const seconds = (await readFile(join(result.archive.outputDirectory, "seconds.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(seconds.filter((row: { tokenId: string; secondIndex: number }) => row.tokenId === "yes" && row.secondIndex === 5)[0].connectionId)
      .toBe("clob-0-e2");
    store.close();
  });

  test("preserves every finish witness and the conflict flag in the exported archive", async () => {
    const path = await root();
    const store = await openCompactTailStore({ dataRoot: path, tailWindowMs: 180_000, bufferMs: 30_000,
      retentionMs: 3_600_000, maxBytes: 8 * 1024 ** 3, now: () => FINISH });
    const START = FINISH - 180_000;
    store.ingest(anchor(1, START, "yes", [{ price: "0.5", size: "10" }], [{ price: "0.6", size: "20" }], "1000", "h1"), ["game:42"]);
    store.ingest(anchor(2, START, "no", [{ price: "0.4", size: "30" }], [{ price: "0.5", size: "40" }], "1000", "h2"), ["game:42"]);
    const facts = [
      { source: "gamma.finishedTimestamp" as const, atMs: FINISH, observedAtMs: FINISH, eventId: "evt-1", eventSlug: "a-vs-b", gameId: "42",
        sourceRunId: "run-1", sourceRunDirectory: null, sequence: 7, frameIndex: 0 },
      { source: "sports.finishedAt" as const, atMs: FINISH - 5_000, observedAtMs: FINISH - 5_000, eventId: null, eventSlug: "a-vs-b", gameId: "42",
        sourceRunId: "run-1", sourceRunDirectory: null, sequence: 6, frameIndex: 0 }
    ];
    store.finalize({ ...game(), finishConflict: true, finishFacts: facts }, FINISH);
    const result = await exportCompactMatch(store, "game:42", { outputDirectory: join(path, "archive") });
    const summary = JSON.parse(await readFile(join(result.archive.outputDirectory, "quality.json"), "utf8"));
    expect(summary.windows[0]).toMatchObject({ finishConflict: true });
    expect(summary.windows[0].finishSources).toEqual(["gamma.finishedTimestamp", "sports.finishedAt"]);
    expect(summary.windows[0].finishEvidence.map((fact: { source: string; atMs: number }) => [fact.source, fact.atMs]))
      .toEqual([["gamma.finishedTimestamp", FINISH], ["sports.finishedAt", FINISH - 5_000]]);
    store.close();
  });

  test("refuses a match that has no stored market identity", async () => {
    const path = await root();
    const store = await openCompactTailStore({ dataRoot: path, tailWindowMs: 180_000, bufferMs: 30_000,
      retentionMs: 3_600_000, maxBytes: 8 * 1024 ** 3, now: () => FINISH });
    store.ingest(clob(1, FINISH - 1_000, { market: CONDITION, event_type: "price_change", timestamp: "2000", price_changes: [] }), ["game:42"]);
    store.flush();
    const { eventMetadata: _omitted, ...withoutMetadata } = game();
    store.finalize(withoutMetadata, FINISH);
    await expect(exportCompactMatch(store, "game:42", { outputDirectory: join(path, "archive") }))
      .rejects.toThrow(/COMPACT_EXPORT_NO_METADATA/);
    store.close();
  });
});
