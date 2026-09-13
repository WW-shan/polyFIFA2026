import { describe, expect, test } from "vitest";
import { ContinuousState } from "../../src/collector/continuous-state.js";
import { eventMetadata, fixtureRecords, journalRecord } from "./tail-fixture.js";

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

  test("unknown and malformed frames are recorded as diagnostics, not invented match observations", () => {
    const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
    state.observe(journalRecord(1, 1000, "clob", "ws_message", "not-json", "c"));
    expect(state.snapshot().games).toEqual([]);
    expect(state.snapshot().receivedRecords).toBe(1);
    expect(state.snapshot().errors).toHaveLength(1);
  });
});
