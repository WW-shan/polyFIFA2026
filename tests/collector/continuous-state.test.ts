import { describe, expect, test, vi } from "vitest";
import { ContinuousState } from "../../src/collector/continuous-state.js";
import { book, eventMetadata, fixtureRecords, journalRecord } from "./tail-fixture.js";

describe("persistent continuous capture observations", () => {
  test("tracks actual books, connections and games without claiming completed coverage", () => {
    const state = new ContinuousState("/capture", 8765);
    state.setRun("tail-test", "/capture/runs/tail-test");
    for (const record of fixtureRecords().slice(0, 11)) state.observe(record);
    const status = state.snapshot();
    expect(status.receivedRecords).toBe(11);
    expect(status.games[0]).toMatchObject({ key: "game:123", firstSeenAtMs: 100, firstBookAtMs: 9000, tokenIds: ["A", "B"], phase: "watching" });
    expect(status.games[0]?.bookUpdates).toBeGreaterThan(0);
    expect(status.games[0]?.archive).toBeUndefined();
    expect(status.games[0]?.sourceFirstSequences).toEqual({ "tail-test": 2 });
    expect(state.readyToArchive("tail-test")).toEqual([]);
  });

  test("only observed, retired games with actual finish evidence enter the export queue", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    for (const record of fixtureRecords().slice(0, 13)) state.observe(record);
    state.observe(journalRecord(14, 310_100, "collector", "event_retired", { eventId: "event", eventSlug: "game", gameId: "123", finishedAtMs: 310_000 }));
    expect(state.readyToArchive("tail-test").map(game => game.key)).toEqual(["game:123"]);
    state.markArchive("game:123", { status: "running", runId: "tail-test", attempt: 1 });
    expect(state.readyToArchive("tail-test")).toEqual([]);
    state.markArchive("game:123", { status: "complete", runId: "tail-test", attempt: 1, outputDirectory: "/capture/exports/game", priceReadyTokens: 2, strictReadyTokens: 0 });
    expect(state.snapshot().games[0]).toMatchObject({ phase: "archived", archive: { priceReadyTokens: 2, strictReadyTokens: 0 } });
  });

  test("a short /books batch only credits the tokens its response actually carried", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    const metadata = (id: string, yes: string) => ({ event: { id, slug: `${id}-slug`, title: `${id} match`, gameId: null,
      sport: "tennis", tags: [{ slug: "tennis" }], startTime: new Date(0).toISOString(),
      markets: [{ id: `${id}-m`, slug: `${id}-m`, conditionId: `${id}-condition`, question: "Winner?", outcomes: ["A", "B"],
        clobTokenIds: [yes, `${yes}-no`], sportsMarketType: "moneyline", closed: false, acceptingOrders: true }] } });
    state.observe(journalRecord(1, 100, "gamma", "event_metadata", metadata("first", "TOKEN-A")));
    state.observe(journalRecord(2, 200, "gamma", "event_metadata", metadata("second", "TOKEN-B")));
    state.observe(journalRecord(3, 1_000, "clob", "ws_message", book("TOKEN-A", "0.5", "0.6", 1_000, "hA"), "clob"));
    state.observe(journalRecord(4, 2_000, "clob", "ws_message", book("TOKEN-B", "0.5", "0.6", 2_000, "hB"), "clob"));
    const games = () => Object.fromEntries(state.snapshot().games.map(game => [game.key, game]));
    expect(games()["event:first"]?.lastBookAtMs).toBe(1_000);
    expect(games()["event:second"]?.lastBookAtMs).toBe(2_000);

    // The request covered both tokens and upstream answered for the first one
    // only. The second token's book clock must stay on its last real frame, or
    // the quiet-finish anchor lands past every stored frame and the match is
    // archived empty.
    state.observe(journalRecord(5, 900_000, "clob", "book_snapshot_batch", { tokenIds: ["TOKEN-A", "TOKEN-B"],
      response: [{ asset_id: "TOKEN-A", hash: "hA2", bids: [], asks: [] }] }, "clob"));
    expect(games()["event:first"]?.lastBookAtMs).toBe(900_000);
    expect(games()["event:second"]?.lastBookAtMs).toBe(2_000);
  });

  test("anchors a retired match on its own last frame only when no clock was published", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    // The fixture's Gamma metadata carries a finish clock; this match has none,
    // which is how most closed tennis and table-tennis events arrive.
    const records = fixtureRecords();
    records[1] = journalRecord(2, 100, "gamma", "event_metadata", eventMetadata(0));
    for (const record of records.slice(0, 11)) state.observe(record);
    const lastBookAtMs = state.snapshot().games[0]!.lastBookAtMs!;

    // Still live: nothing to anchor yet.
    expect(state.anchorQuietFinishes(lastBookAtMs + 600_000, 300_000, 900_000)).toEqual([]);

    state.observe(journalRecord(12, lastBookAtMs + 1_000, "collector", "event_retired",
      { eventId: "event", eventSlug: "game", gameId: "123", finishedAtMs: null }));
    // The published sources still have their grace period.
    expect(state.anchorQuietFinishes(lastBookAtMs + 299_999, 300_000, 900_000)).toEqual([]);
    expect(state.anchorQuietFinishes(lastBookAtMs + 300_000, 300_000, 900_000).map(game => game.key)).toEqual(["game:123"]);
    expect(state.snapshot().games[0]).toMatchObject({ finishedAtMs: lastBookAtMs, finishAnchor: "book-quiet" });
    expect(state.readyToArchive("tail-test").map(game => game.key)).toEqual(["game:123"]);
    // Anchoring is idempotent, not a second finish observation.
    expect(state.anchorQuietFinishes(lastBookAtMs + 400_000, 300_000, 900_000)).toEqual([]);
    expect(state.snapshot().games[0]?.finishConflict).toBe(false);
  });

  test("leaves a match unanchored once its window is past saving", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    const records = fixtureRecords();
    records[1] = journalRecord(2, 100, "gamma", "event_metadata", eventMetadata(0));
    for (const record of records.slice(0, 11)) state.observe(record);
    const lastBookAtMs = state.snapshot().games[0]!.lastBookAtMs!;
    state.observe(journalRecord(12, lastBookAtMs + 1_000, "collector", "event_retired",
      { eventId: "event", eventSlug: "game", gameId: "123", finishedAtMs: null }));
    // Marking it finished here would publish a window with nothing in it.
    expect(state.anchorQuietFinishes(lastBookAtMs + 900_001, 300_000, 900_000)).toEqual([]);
    expect(state.snapshot().games[0]).toMatchObject({ finishedAtMs: null });
    expect(state.snapshot().games[0]?.finishAnchor ?? null).toBeNull();
    expect(state.readyToArchive("tail-test")).toEqual([]);
  });

  test("a published clock beats the fallback, and a late clock is retained as conflicting evidence", () => {
    const labelled = new ContinuousState("/capture", 8765); labelled.setRun("tail-test", "/capture/runs/tail-test");
    for (const record of fixtureRecords().slice(0, 13)) labelled.observe(record);
    expect(labelled.snapshot().games[0]?.finishedAtMs).toBe(310_000);
    expect(labelled.anchorQuietFinishes(9_999_999, 300_000, 900_000)).toEqual([]);

    const quiet = new ContinuousState("/capture", 8765); quiet.setRun("tail-test", "/capture/runs/tail-test");
    const records = fixtureRecords();
    records[1] = journalRecord(2, 100, "gamma", "event_metadata", eventMetadata(0));
    for (const record of records.slice(0, 11)) quiet.observe(record);
    const lastBookAtMs = quiet.snapshot().games[0]!.lastBookAtMs!;
    quiet.observe(journalRecord(12, lastBookAtMs + 1_000, "collector", "event_retired",
      { eventId: "event", eventSlug: "game", gameId: "123", finishedAtMs: null }));
    expect(quiet.anchorQuietFinishes(lastBookAtMs + 300_000, 300_000, 900_000).map(game => game.key)).toEqual(["game:123"]);
    // A clock that only shows up minutes later must not shift a window that is
    // already published from data the user may already be reading, but its
    // witness cannot be silently discarded.
    quiet.observe(journalRecord(13, lastBookAtMs + 900_000, "gamma", "event_metadata", eventMetadata(lastBookAtMs + 5_000)));
    expect(quiet.snapshot().games[0]).toMatchObject({ finishedAtMs: lastBookAtMs + 5_000,
      finishAnchor: "gamma.finishedTimestamp", finishConflict: true });
    expect(quiet.snapshot().games[0]?.finishFacts).toContainEqual(expect.objectContaining({
      source: "gamma.finishedTimestamp", atMs: lastBookAtMs + 5_000 }));
  });

  test("restart preserves source references, marks observations interrupted and retries unfinished exports", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    for (const record of fixtureRecords().slice(0, 10)) state.observe(record);
    state.markArchive("game:123", { status: "running", runId: "tail-test", attempt: 1, snapshotDirectory: "/capture/checkpoints/one" });
    const restored = new ContinuousState("/capture", 8765); restored.restore(state.snapshot());
    expect(restored.snapshot().connections).toEqual([]);
    expect(restored.snapshot().games[0]).toMatchObject({ phase: "interrupted", archive: { status: "failed" } });
    expect(restored.snapshot().games[0]?.sources).toEqual([{ runId: "tail-test", runDirectory: "/capture/runs/tail-test" }]);
  });

  test("a persisted sealed export can retry after the collector has moved to a new run", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    for (const record of fixtureRecords().slice(0, 10)) state.observe(record);
    state.observe(journalRecord(14, 310_100, "collector", "event_retired", { eventId: "event", finishedAtMs: 310_000 }));
    state.markArchive("game:123", { status: "running", runId: "tail-test", attempt: 1, snapshotDirectory: "/capture/checkpoints/one" });
    const restored = new ContinuousState("/capture", 8765); restored.restore(state.snapshot()); restored.setRun("next", "/capture/runs/next");
    expect(restored.readyToArchive("next").map(game => game.key)).toEqual(["game:123"]);
  });

  test("an unsealed retired game remains queued through restart via its original raw source", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    for (const record of fixtureRecords().slice(0, 10)) state.observe(record);
    state.observe(journalRecord(14, 310_100, "collector", "event_retired", { eventId: "event", finishedAtMs: 310_000 }));
    const restored = new ContinuousState("/capture", 8765); restored.restore(state.snapshot()); restored.setRun("next", "/capture/runs/next");
    expect(restored.readyToArchive("next").map(game => game.key)).toEqual(["game:123"]);
  });

  test("a new process retries a previously failed archive without inheriting an obsolete long delay", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    fixtureRecords().forEach(record => state.observe(record));
    state.observe(journalRecord(99, 320_000, "collector", "event_retired", { eventId: "event", finishedAtMs: 310_000 }));
    state.markArchive("game:123", { status: "failed", runId: "tail-test", attempt: 7, retryAtMs: Number.MAX_SAFE_INTEGER });
    const restored = new ContinuousState("/capture", 8765); restored.restore(state.snapshot()); restored.setRun("next", "/capture/runs/next");
    expect(restored.readyToArchive("next")).toHaveLength(1);
  });

  test("a new agreeing witness invalidates a completed archive so provenance is not lost", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    for (const record of fixtureRecords().slice(0, 10)) state.observe(record);
    state.markArchive("game:123", { status: "complete", runId: "tail-test", attempt: 1, outputDirectory: "/capture/exports/old" });
    state.observe(journalRecord(11, 11_900, "sports", "ws_message", JSON.stringify({
      gameId: 123, slug: "game", sport: "soccer", ended: true, finishedAt: new Date(310_000).toISOString()
    }), "sports"));
    expect(state.snapshot().games[0]?.finishFacts?.map(fact => fact.source)).toEqual([
      "gamma.finishedTimestamp", "sports.finishedAt"]);
    expect(state.snapshot().games[0]?.archive).toMatchObject({ status: "failed", refreshSnapshot: true, retryAtMs: 0 });
  });

  test("changed finish evidence invalidates the old snapshot and prevents any complete-quality claim", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    for (const record of fixtureRecords().slice(0, 10)) state.observe(record);
    state.observe(journalRecord(14, 310_100, "collector", "event_retired", { eventId: "event", finishedAtMs: 310_000 }));
    state.markArchive("game:123", { status: "complete", runId: "tail-test", attempt: 1, snapshotDirectory: "/capture/checkpoints/old", outputDirectory: "/capture/exports/old", priceReadyTokens: 2, strictReadyTokens: 2 });
    state.observe(journalRecord(15, 320_000, "gamma", "event_metadata", eventMetadata(310_001)));
    expect(state.snapshot().games[0]?.finishFacts?.map(fact => fact.atMs)).toEqual([310_000, 310_001]);
    expect(state.snapshot().games[0]?.finishFacts?.[1]).toMatchObject({ sourceRunId: "tail-test", sequence: 15, source: "gamma.finishedTimestamp" });
    expect(state.snapshot().games[0]?.archive).toMatchObject({ status: "failed", refreshSnapshot: true });
    expect(state.snapshot().games[0]?.archive?.snapshotDirectory).toBeUndefined();
    state.markArchive("game:123", { status: "complete", runId: "tail-test", attempt: 2, outputDirectory: "/capture/exports/new", priceReadyTokens: 2, strictReadyTokens: 2 });
    expect(state.snapshot().games[0]?.archive).toMatchObject({ priceReadyTokens: 0, strictReadyTokens: 0 });
  });

  test("attributes connection invalidation to every game carried by that connection", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    state.observe(journalRecord(1, 100, "gamma", "event_metadata", eventMetadata(0)));
    state.observe(journalRecord(2, 200, "clob", "ws_message", book("A"), "clob-0-e1"));
    expect(state.gameKeysForRecord(journalRecord(3, 300, "collector", "connection_gap", { reason: "inbound_timeout" }, "clob-0-e1")))
      .toEqual(["game:123"]);
    state.observe(journalRecord(3, 300, "collector", "connection_gap", { reason: "inbound_timeout" }, "clob-0-e1"));
    expect(state.snapshot().connections.find(connection => connection.id === "clob-0-e1")?.gameKeys).toEqual(["game:123"]);
  });

  test("resolves market, sports, and retired records to their game identity", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    state.observe(journalRecord(1, 100, "gamma", "event_metadata", eventMetadata(0)));
    expect(state.gameKeysForRecord(journalRecord(2, 200, "clob", "ws_message", book("A"), "clob"))).toEqual(["game:123"]);
    expect(state.gameKeysForRecord(journalRecord(3, 300, "sports", "ws_message",
      JSON.stringify({ gameId: 123, slug: "game", sport: "soccer", score: "0-0" }), "sports"))).toEqual(["game:123"]);
    expect(state.gameKeysForRecord(journalRecord(4, 400, "collector", "event_retired", { eventId: "event" }))).toEqual(["game:123"]);
  });

  test("returns newly finished games once for compact finalization", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    state.observe(journalRecord(1, 100, "gamma", "event_metadata", eventMetadata(0)));
    expect(state.consumeNewlyFinishedGames()).toEqual([]);
    state.observe(journalRecord(2, 200, "sports", "ws_message", JSON.stringify({
      gameId: 123, slug: "game", sport: "soccer", ended: true, finishedAt: new Date(180).toISOString()
    }), "sports"));
    expect(state.consumeNewlyFinishedGames().map(game => [game.key, game.finishedAtMs])).toEqual([["game:123", 180]]);
    expect(state.consumeNewlyFinishedGames()).toEqual([]);
  });

  test("splits a batched market message per owning game instead of copying foreign frames", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    state.observe(journalRecord(1, 100, "gamma", "event_metadata", eventMetadata(0)));
    const second = eventMetadata(0, { id: "event-2", slug: "game-2", gameId: "456",
      markets: [{ id: "winner-2", slug: "winner-2", conditionId: "condition-2", question: "Winner?",
        outcomes: ["C", "D"], clobTokenIds: ["C", "D"], sportsMarketType: "moneyline", closed: false, acceptingOrders: true }] });
    state.observe(journalRecord(2, 110, "gamma", "event_metadata", second));

    // One CLOB message carrying frames for both games' tokens.
    const batch = JSON.stringify([
      { event_type: "book", asset_id: "A", asks: [], bids: [] },
      { event_type: "price_change", price_changes: [{ asset_id: "C", side: "SELL", price: "0.5", size: "1" }] }
    ]);
    expect(state.clobFramesForRecord(journalRecord(3, 200, "clob", "ws_message", batch, "clob")))
      .toEqual([
        { gameKey: "game:123", frame: { event_type: "book", asset_id: "A", asks: [], bids: [] }, frameIndex: 0 },
        { gameKey: "game:456", frame: { event_type: "price_change", price_changes: [{ asset_id: "C", side: "SELL", price: "0.5", size: "1" }] }, frameIndex: 1 }
      ]);
  });

  test("drops frames whose tokens belong to no game and frames that span two games", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    state.observe(journalRecord(1, 100, "gamma", "event_metadata", eventMetadata(0)));
    state.observe(journalRecord(2, 110, "gamma", "event_metadata", eventMetadata(0, { id: "event-2", slug: "game-2", gameId: "456",
      markets: [{ id: "winner-2", slug: "winner-2", conditionId: "condition-2", question: "Winner?",
        outcomes: ["C", "D"], clobTokenIds: ["C", "D"], sportsMarketType: "moneyline", closed: false, acceptingOrders: true }] })));

    const unknown = JSON.stringify({ event_type: "book", asset_id: "not-subscribed", asks: [], bids: [] });
    expect(state.clobFramesForRecord(journalRecord(3, 200, "clob", "ws_message", unknown, "clob"))).toEqual([]);

    // A single frame naming tokens from two different games has no safe owner.
    const spanning = JSON.stringify({ event_type: "price_change",
      price_changes: [{ asset_id: "A", side: "SELL", price: "0.5", size: "1" },
        { asset_id: "C", side: "BUY", price: "0.5", size: "1" }] });
    expect(state.clobFramesForRecord(journalRecord(4, 210, "clob", "ws_message", spanning, "clob"))).toEqual([]);
  });

  test("a /books reply that only omits resolved sub-markets is not a status issue", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    state.observe(journalRecord(1, 1_000, "clob", "book_snapshot_batch_error", {
      code: "CLOB_BOOK_BATCH_IDENTITY_MISMATCH", missingTokenIds: ["resolved-set-winner"],
      duplicateTokenIds: [], unrequestedTokenIds: [], invalidResponseIndices: []
    }));
    expect(state.snapshot().errors).toEqual([]);

    // Real identity failures stay visible.
    state.observe(journalRecord(2, 2_000, "clob", "book_snapshot_batch_error", {
      code: "CLOB_BOOK_BATCH_IDENTITY_MISMATCH", missingTokenIds: [], duplicateTokenIds: ["twice"],
      unrequestedTokenIds: ["extra"], invalidResponseIndices: []
    }));
    state.observe(journalRecord(3, 3_000, "clob", "book_snapshot_batch_error", {
      code: "CLOB_BOOK_BATCH_INVALID_RESPONSE", missingTokenIds: ["a"], duplicateTokenIds: [],
      unrequestedTokenIds: [], invalidResponseIndices: []
    }));
    expect(state.snapshot().errors.map(issue => issue.scope))
      .toEqual(["book_snapshot_batch_error", "book_snapshot_batch_error"]);
  });

  test("unknown and malformed frames are recorded as diagnostics, not invented match observations", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    state.observe(journalRecord(1, 1000, "clob", "ws_message", "not-json", "c"));
    expect(state.snapshot().games).toEqual([]);
    expect(state.snapshot().receivedRecords).toBe(1);
    expect(state.snapshot().errors).toHaveLength(1);
  });
});


test("an upstream gameId correction keeps one observation identity and its finish evidence", () => {
  const state = new ContinuousState("/capture", 8765);
  state.setRun("tail-test", "/capture/runs/tail-test");
  state.observe(journalRecord(1, 100, "gamma", "event_metadata", eventMetadata(0)));
  state.observe(journalRecord(2, 200, "clob", "ws_message", book("A"), "clob"));
  const corrected = eventMetadata(310_000, { gameId: 456 });
  state.observe(journalRecord(3, 300, "gamma", "event_metadata", corrected));
  state.observe(journalRecord(4, 310_100, "collector", "event_retired", { eventId: "event", finishedAtMs: 310_000 }));
  const games = state.snapshot().games;
  expect(games).toHaveLength(1);
  expect(games[0]).toMatchObject({ key: "game:123", gameId: "123", finishedAtMs: 310_000, retiredEventIds: ["event"] });
  expect(state.gameKeysForRecord(journalRecord(5, 320_000, "clob", "ws_message", book("A"), "clob"))).toEqual(["game:123"]);
});

test("status reads cannot refresh the last published progress timestamp", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    const state = new ContinuousState("/capture", 8765);
    clock.mockReturnValue(90_000);
    expect(state.snapshot().updatedAtMs).toBe(1000);
    state.markUpdated(80_000);
    expect(state.snapshot().updatedAtMs).toBe(80_000);
    clock.mockReturnValue(100_000);
    expect(state.snapshot().updatedAtMs).toBe(80_000);
  } finally { clock.mockRestore(); }
});

test("compact restore drops stale hot-state entries regardless of phase", () => {
  const source = new ContinuousState("/capture", 8765);
  source.setRun("old", "/capture/runs/old");
  source.observe(journalRecord(1, 100, "gamma", "event_metadata", eventMetadata(0)));
  const saved = source.snapshot();
  saved.games[0]!.lastSeenAtMs = Date.now() - 10_000;
  saved.games[0]!.finishedAtMs = null;
  saved.games[0]!.phase = "watching";
  const restored = new ContinuousState("/capture", 8765, 15_000, 1_000);
  restored.restore(saved);
  expect(restored.snapshot().games).toEqual([]);
});

test("pruning stale hot state removes token and event indexes but preserves an active archive", () => {
  const state = new ContinuousState("/capture", 8765);
  state.setRun("old", "/capture/runs/old");
  state.observe(journalRecord(1, 100, "gamma", "event_metadata", eventMetadata(0, {
    id: "old-event", slug: "old-game", gameId: 1,
    markets: [{ id: "old-market", slug: "old-market", conditionId: "old-condition", question: "Old?", outcomes: ["A", "B"], clobTokenIds: ["old-A", "old-B"] }]
  })));
  state.observe(journalRecord(2, 200, "gamma", "event_metadata", eventMetadata(0, {
    id: "active-event", slug: "active-game", gameId: 2,
    markets: [{ id: "active-market", slug: "active-market", conditionId: "active-condition", question: "Active?", outcomes: ["A", "B"], clobTokenIds: ["active-A", "active-B"] }]
  })));
  state.markArchive("game:2", { status: "running", runId: "old", attempt: 1 });

  expect(state.pruneStaleGames(1_000)).toBe(1);
  expect(state.snapshot().games.map(game => game.key)).toEqual(["game:2"]);
  expect(state.gameKeysForRecord(journalRecord(3, 300, "clob", "ws_message", JSON.stringify({ event_type: "book", asset_id: "old-A" }), "clob"))).toEqual([]);
  expect(state.gameKeysForRecord(journalRecord(4, 400, "collector", "event_retired", { eventId: "old-event" }))).toEqual([]);
});

test("replaces an all-closed first sighting with the next live market shape", () => {
  const state = new ContinuousState("/capture", 8765);
  state.setRun("tail-test", "/capture/runs/tail-test");
  // A game restored from a state file written before `eventMetadata` existed
  // can see the reconciled terminal document first. Keeping it would export the
  // whole tail as a resolved market with no usable depth.
  const terminal = eventMetadata(0, { markets: [{ id: "winner", slug: "winner", conditionId: "condition",
    question: "Winner?", outcomes: ["A", "B"], clobTokenIds: ["A", "B"], sportsMarketType: "moneyline",
    closed: true, acceptingOrders: false }] });
  state.observe(journalRecord(1, 100, "gamma", "event_metadata", terminal));
  expect((state.snapshot().games[0]?.eventMetadata?.markets as Array<{ closed?: boolean }>)[0]?.closed).toBe(true);

  state.observe(journalRecord(2, 200, "gamma", "event_metadata", eventMetadata(0)));
  const markets = state.snapshot().games[0]?.eventMetadata?.markets as Array<{ closed?: boolean }>;
  expect(markets.every(market => market.closed === false)).toBe(true);
});

test("keeps the first live shape once a non-terminal sighting exists", () => {
  const state = new ContinuousState("/capture", 8765);
  state.setRun("tail-test", "/capture/runs/tail-test");
  state.observe(journalRecord(1, 100, "gamma", "event_metadata", eventMetadata(0)));
  state.observe(journalRecord(2, 200, "gamma", "event_metadata", eventMetadata(0, { markets: [{ id: "winner",
    slug: "winner", conditionId: "condition", question: "Winner?", outcomes: ["A", "B"], clobTokenIds: ["A", "B"],
    sportsMarketType: "moneyline", closed: true, acceptingOrders: false }] })));
  const markets = state.snapshot().games[0]?.eventMetadata?.markets as Array<{ closed?: boolean }>;
  expect(markets.every(market => market.closed === false)).toBe(true);
});
