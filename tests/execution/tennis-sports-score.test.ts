import { describe, expect, test } from "vitest";
import {
  TennisSportsScoreBoard,
  parseTennisSportsScore
} from "../../src/execution/tennis-sports-score.js";

const frame = JSON.stringify({
  gameId: 6374886,
  leagueAbbreviation: "challenger",
  homeTeam: "Gustavo Heide",
  awayTeam: "Pedro Boscardin Dias",
  status: "inprogress",
  score: "6-2, 5-2",
  period: "S2",
  live: true,
  ended: false
});

describe("parseTennisSportsScore", () => {
  test("parses a raw sports frame", () => {
    expect(parseTennisSportsScore(frame, 1700)).toMatchObject({
      gameId: "6374886",
      score: "6-2, 5-2",
      homeName: "Gustavo Heide",
      awayName: "Pedro Boscardin Dias",
      league: "challenger",
      status: "inprogress",
      period: "S2",
      live: true,
      ended: false,
      observedAtMs: 1700
    });
  });

  test("parses a frame already decoded to an object", () => {
    expect(parseTennisSportsScore(JSON.parse(frame), 1700)?.score).toBe("6-2, 5-2");
  });

  test("parses the collector journal's nested data envelope", () => {
    const envelope = { source: "sports", kind: "ws_message", data: frame };
    expect(parseTennisSportsScore(envelope, 1700)?.gameId).toBe("6374886");
    expect(parseTennisSportsScore(JSON.stringify(envelope), 1700)?.score).toBe("6-2, 5-2");
  });

  test("marks finished frames as ended and not live", () => {
    const finished = JSON.stringify({ gameId: "90123186", homeTeam: "A", awayTeam: "B", status: "finished",
      score: "6-4, 6-3", live: false, ended: true });
    expect(parseTennisSportsScore(finished, 1)).toMatchObject({ live: false, ended: true });
  });

  test("ignores heartbeats and incomplete frames", () => {
    expect(parseTennisSportsScore('{"type":"ping"}', 1)).toBeNull();
    expect(parseTennisSportsScore("not json", 1)).toBeNull();
    expect(parseTennisSportsScore(JSON.stringify({ gameId: 1, score: "1-0", homeTeam: "A" }), 1)).toBeNull();
    expect(parseTennisSportsScore(JSON.stringify({ homeTeam: "A", awayTeam: "B", score: "1-0" }), 1)).toBeNull();
  });
});

describe("TennisSportsScoreBoard", () => {
  test("keeps the latest score per game and ignores repeats", () => {
    const board = new TennisSportsScoreBoard();
    expect(board.ingest(frame, 10)?.score).toBe("6-2, 5-2");
    board.ingest(frame, 20); // identical repeat: no new revision
    expect(board.version).toBe(1);
    expect(board.latestFor("6374886")).toMatchObject({ observedAtMs: 10, receivedAtMs: 20 });
    const changed = board.ingest(JSON.stringify({ ...JSON.parse(frame), score: "6-2, 6-5" }), 30);
    expect(board.version).toBe(2);
    expect(changed).toMatchObject({ observedAtMs: 30, receivedAtMs: 30 });
    expect(board.latestFor("6374886")).toMatchObject({ score: "6-2, 6-5", observedAtMs: 30 });
    expect(board.latestFor("nope")).toBeUndefined();
  });

  test("wakes waiters on a monitored score change", async () => {
    const board = new TennisSportsScoreBoard();
    board.selectMonitoredGameIds(["6374886"]);
    const version = board.version;
    const waiting = board.waitForVersionChange(version, 5_000);
    board.ingest(frame, 10);
    await expect(waiting).resolves.toBeUndefined();
  });

  test("does not wake the loop for unmonitored games", async () => {
    const board = new TennisSportsScoreBoard();
    board.selectMonitoredGameIds(["6374886"]);
    const version = board.version;
    board.ingest(JSON.stringify({ gameId: 111, homeTeam: "A", awayTeam: "B", score: "1-0", live: true }), 10);
    await expect(board.waitForVersionChange(version, 5)).resolves.toBeUndefined();
    // The stored frame is available, but the revision did not move.
    expect(board.version).toBe(0);
    expect(board.latestFor("111")?.score).toBe("1-0");
  });

  test("resolves on timeout when no score arrives", async () => {
    const board = new TennisSportsScoreBoard();
    board.selectMonitoredGameIds(["6374886"]);
    const started = Date.now();
    await board.waitForVersionChange(board.version, 10);
    expect(Date.now() - started).toBeGreaterThanOrEqual(5);
  });

  test("releases waiters when disposed", async () => {
    const board = new TennisSportsScoreBoard();
    board.selectMonitoredGameIds(["6374886"]);
    const waiting = board.waitForVersionChange(board.version, 60_000);
    board.dispose();
    await expect(waiting).resolves.toBeUndefined();
    expect(board.ingest(frame, 1)).toBeNull();
  });
});
