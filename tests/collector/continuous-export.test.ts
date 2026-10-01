import { afterEach, expect, test } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runTailExport } from "../../src/collector/continuous-export.js";
import { fixtureRecords, journalRecord, writeFixture } from "./tail-fixture.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("exports a completed game in a real child process and reads its actual quality", async () => {
  const root = await writeFixture(fixtureRecords()); roots.push(root);
  const outputDirectory = join(root, "export");
  const result = await runTailExport({ snapshotDirectory: join(root, "run"), outputDirectory, eventSlugs: ["game"], gameKey: "game:123", timeoutMs: 10_000 });
  expect(result).toMatchObject({ outputDirectory, strictReadyTokens: 0 });
  const quality = JSON.parse(await readFile(join(outputDirectory, "quality.json"), "utf8"));
  expect(quality.windowSeconds).toBe(301);
  expect(quality.seconds).toBe(602);
  expect(JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8")).rawEventsFile).toBe("raw-events.ndjson.gz");
  expect(result.priceReadyTokens).toBe(quality.tokens.filter((q: { observedWindowComplete: boolean; snapshotAuditPassed: boolean; validSeconds: number }) => q.observedWindowComplete && q.snapshotAuditPassed && q.validSeconds > 0).length);
}, 15_000);

test("cancellation before starting never launches an export", async () => {
  const abort = new AbortController(); abort.abort(new Error("stopped"));
  await expect(runTailExport({ snapshotDirectory: "/missing", outputDirectory: "/not-created", eventSlugs: ["game"], gameKey: "game:123", timeoutMs: 1000 }, abort.signal)).rejects.toThrow("stopped");
});

test("child failure cannot be reported as a completed archive", async () => {
  const root = await writeFixture(fixtureRecords().slice(0, -1)); roots.push(root);
  await expect(runTailExport({ snapshotDirectory: join(root, "run"), outputDirectory: join(root, "failed"), eventSlugs: ["game"], gameKey: "game:123", timeoutMs: 10_000 })).rejects.toThrow("TAIL_EXPORT_CHILD_FAILED");
}, 15_000);

test("continuous exports flag bounded wall-clock backsteps without discarding an entire input", async () => {
  const records = fixtureRecords(); records[9]!.receivedAtMs = 11_099; records[9]!.receivedAt = new Date(11_099).toISOString();
  const root = await writeFixture(records); roots.push(root); const outputDirectory = join(root, "clock");
  await runTailExport({ snapshotDirectory: join(root, "run"), outputDirectory, eventSlugs: ["game"], gameKey: "game:123", timeoutMs: 10_000 });
  const quality = JSON.parse(await readFile(join(outputDirectory, "quality.json"), "utf8"));
  expect(quality.clockPolicy).toBe("flag-backsteps"); expect(quality.clockIssues).toHaveLength(1);
  expect(quality.tokens.every((token: { readyForReplay: boolean }) => !token.readyForReplay)).toBe(true);
}, 15_000);

test("exports per-second point context from scores365 frames", async () => {
  const records = fixtureRecords();
  const point = {
    ...journalRecord(16, 200_000, "scores365", "point_frame", {
      eventSlug: "game",
      frame: {
        observedAtMs: 200_000, scores365GameId: 4867638, startTime: null, statusText: "Set 2", statusGroup: 3,
        competition: "Challenger", homeName: "A", awayName: "B", setsWon: { home: 1, away: 0 }, setsToWin: 2,
        sets: [
          { name: "Set 1", shortName: "S1", home: 6, away: 2, ended: true, live: false },
          { name: "Set 2", shortName: "S2", home: 5, away: 4, ended: false, live: true }
        ],
        game: { serving: "home", home: "15", away: "30", tiebreak: false, breakPoint: false, setPoint: false, matchPoint: false,
          points: [{ winner: "away", home: 15, away: 15, important: 0 }] }
      },
      signal: { favored: "home", candidate: true }
    })
  };
  records.splice(13, 0, point);
  // The journal is ordered by sequence; keep that invariant after inserting.
  for (const [index, value] of records.entries()) value.sequence = index + 1;
  const root = await writeFixture(records); roots.push(root);
  const outputDirectory = join(root, "points");
  await runTailExport({ snapshotDirectory: join(root, "run"), outputDirectory, eventSlugs: ["game"], gameKey: "game:123", timeoutMs: 10_000 });
  const rows = (await readFile(join(outputDirectory, "seconds.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const inside = rows.filter((row: { startAtMs: number }) => row.startAtMs >= 200_000);
  expect(inside.length).toBeGreaterThan(0);
  for (const row of inside.slice(0, 5)) {
    expect(row.pointStatus).toBe("present");
    expect(row.pointObservedAtMs).toBe(200_000);
    expect(row.pointAgeMs).toBe(row.endAtMs - 200_000);
    expect(row.point.frame.scores365GameId).toBe(4867638);
    expect(row.point.signal.candidate).toBe(true);
  }
  const before = rows.find((row: { startAtMs: number }) => row.startAtMs < 200_000);
  expect(before.pointStatus).toBe("missing");
  expect(before.point).toBeNull();
}, 15_000);
