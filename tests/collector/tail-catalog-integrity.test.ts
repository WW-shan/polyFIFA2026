import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { scanTailCatalog, tailOptions } from "../../src/collector/tail-catalog.js";
import { windowKeyForIdentity } from "../../src/collector/tail-context.js";
import { eventMetadata, journalRecord, writeFixture } from "./tail-fixture.js";
import type { JournalRecord } from "../../src/collector/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const finishAtMs = 310_000;
const finishedAt = new Date(finishAtMs).toISOString();

function metadata(sequence: number, slug: string, gameId: string | null): JournalRecord {
  return journalRecord(sequence, sequence * 100, "gamma", "event_metadata",
    eventMetadata(0, { id: `event-${slug}`, slug, gameId, markets: [] }));
}

async function writeRun(records: JournalRecord[]): Promise<string> {
  const root = await writeFixture(records);
  roots.push(root);
  return join(root, "run");
}

function twoGames(frame: Record<string, unknown>, finishBeforeMetadata = false): JournalRecord[] {
  const sports = journalRecord(4, 400, "sports", "ws_message", JSON.stringify(frame), "sports");
  const rows = finishBeforeMetadata
    ? [sports, metadata(2, "A", "g-a"), metadata(3, "B", "g-b")]
    : [metadata(2, "A", "g-a"), metadata(3, "B", "g-b"), sports];
  return [
    journalRecord(1, 0, "collector", "session_start", {}),
    ...rows.map((row, index) => journalRecord(index + 2, (index + 2) * 100,
      row.source, row.kind, row.data, row.connectionId)),
    journalRecord(5, 400_000, "collector", "session_end", {})
  ];
}

describe("tail catalog identity integrity", () => {
  test.each([false, true])("rejects a known slug for another game (finish before metadata: %s)", async before => {
    const runDirectory = await writeRun(twoGames({ slug: "B", gameId: "g-a", finishedAt }, before));
    await expect(scanTailCatalog(tailOptions({ runDirectory }))).rejects.toThrow("TAIL_IDENTITY_CONFLICT");
  });

  test("an event filter cannot hide a contradictory captured slug", async () => {
    const runDirectory = await writeRun(twoGames({ slug: "B", gameId: "g-a", finishedAt }));
    await expect(scanTailCatalog(tailOptions({ runDirectory, eventSlugs: ["A"] })))
      .rejects.toThrow("TAIL_IDENTITY_CONFLICT");
  });

  test("keeps compact identities for every captured window when filtering replay windows", async () => {
    const runDirectory = await writeRun(twoGames({ slug: "A", gameId: "g-a", finishedAt }));
    const catalog = await scanTailCatalog(tailOptions({ runDirectory, eventSlugs: ["A"] }));
    expect(catalog.windows.map(window => window.key)).toEqual(["game:g-a"]);
    expect(catalog.windowIdentities).toEqual([
      { key: "game:g-a", gameId: "g-a", eventSlugs: ["A"] },
      { key: "game:g-b", gameId: "g-b", eventSlugs: ["B"] }
    ]);
    expect(() => windowKeyForIdentity({ eventSlug: "B", gameId: "g-a" }, catalog.windowIdentities))
      .toThrow("TAIL_IDENTITY_CONFLICT");
  });

  test("a captured slug cannot acquire an uncaptured contradictory game ID", async () => {
    const runDirectory = await writeRun(twoGames({ slug: "A", gameId: "other-game", finishedAt }));
    await expect(scanTailCatalog(tailOptions({ runDirectory }))).rejects.toThrow("TAIL_IDENTITY_CONFLICT");
  });

  test.each([
    { slug: "A", gameId: "g-a" },
    { slug: "A-companion", gameId: "g-a" },
    { gameId: "g-a" },
    { slug: "A" }
  ])("accepts compatible companion or optional identities %j", async identity => {
    const runDirectory = await writeRun(twoGames({ ...identity, finishedAt }));
    const catalog = await scanTailCatalog(tailOptions({ runDirectory }));
    expect(catalog.windows.find(window => window.key === "game:g-a"))
      .toMatchObject({ startAtMs: 10_000, endAtMs: finishAtMs, finishConflict: false });
    expect(catalog.windows.find(window => window.key === "game:g-b")?.endAtMs).toBeNull();
  });

  test("captured companion events sharing a game ID use one finish window", async () => {
    const runDirectory = await writeRun([
      journalRecord(1, 0, "collector", "session_start", {}),
      metadata(2, "A", "g-a"), metadata(3, "A-companion", "g-a"), metadata(4, "B", "g-b"),
      journalRecord(5, 500, "sports", "ws_message", JSON.stringify({ slug: "A-companion", gameId: "g-a", finishedAt })),
      journalRecord(6, 400_000, "collector", "session_end", {})
    ]);
    const catalog = await scanTailCatalog(tailOptions({ runDirectory }));
    expect(catalog.windows).toHaveLength(2);
    expect(catalog.windows.find(window => window.key === "game:g-a"))
      .toMatchObject({ eventSlugs: ["A", "A-companion"], endAtMs: finishAtMs });
  });

  test("rejects conflicting game ID fields in a saved label and preserves the sidecar", async () => {
    const runDirectory = await writeRun(twoGames({}));
    const body = JSON.stringify((eventMetadata(finishAtMs, {
      id: "event-A", slug: "A", gameId: undefined,
      eventMetadata: { gameId: "g-a" }, game_id: "g-b", score: "9-9"
    }) as { event: unknown }).event);
    const labelText = JSON.stringify({ schemaVersion: 1, kind: "tail-finish-labels", runId: "tail-test", events: [{
      eventId: "event-A", eventSlug: "A", gameId: "g-a", receivedAtMs: 500_000,
      response: { status: 200, body }
    }] });
    const finishLabelsFile = join(runDirectory, "..", "finish-labels.json");
    await writeFile(finishLabelsFile, labelText);

    await expect(scanTailCatalog(tailOptions({ runDirectory, finishLabelsFile })))
      .rejects.toThrow("TAIL_IDENTITY_CONFLICT");
    expect(await readFile(finishLabelsFile, "utf8")).toBe(labelText);
  });
});

describe("tail catalog finish evidence retention", () => {
  test("duplicate finishes retain the first receipt and compact provenance", async () => {
    const runDirectory = await writeRun([
      journalRecord(1, 0, "collector", "session_start", {}),
      ...[400_000, 400_100, 400_200].map((atMs, index) => journalRecord(index + 2, atMs, "gamma", "event_metadata",
        eventMetadata(finishAtMs, { description: "original metadata", score: { home: 3, away: 1 } }))),
      journalRecord(5, 500_000, "collector", "session_end", {})
    ]);
    const catalog = await scanTailCatalog(tailOptions({ runDirectory }));
    expect(catalog.windows[0]?.finishEvidence).toEqual([{
      atMs: finishAtMs, observedAtMs: 400_000, source: "gamma.finishedTimestamp", eventSlug: "game"
    }]);
    expect(catalog.windows[0]).toMatchObject({ endAtMs: finishAtMs, finishConflict: false });
  });

  test("ever-changing finish times keep the first boundary and one conflict witness per provenance", async () => {
    const count = 2000;
    const runDirectory = await writeRun([
      journalRecord(1, 0, "collector", "session_start", {}),
      ...Array.from({ length: count }, (_, index) => journalRecord(index + 2, 400_000 + index,
        "gamma", "event_metadata", eventMetadata(finishAtMs - index))),
      journalRecord(count + 2, 500_000, "collector", "session_end", {})
    ]);
    const catalog = await scanTailCatalog(tailOptions({ runDirectory }));
    const window = catalog.windows[0]!;
    expect(window.finishEvidence).toHaveLength(2);
    expect(window.finishEvidence).toEqual([
      { atMs: finishAtMs, observedAtMs: 400_000, source: "gamma.finishedTimestamp", eventSlug: "game" },
      { atMs: finishAtMs - 1, observedAtMs: 400_001, source: "gamma.finishedTimestamp", eventSlug: "game" }
    ]);
    expect(window).toMatchObject({ startAtMs: 10_000, endAtMs: finishAtMs, finishConflict: true });
    expect(catalog.warnings).toContain("conflicting-finish-labels:game:123");
  });

  test("deduplication preserves independent Gamma, Sports and sidecar provenance in receipt order", async () => {
    const runDirectory = await writeRun([
      journalRecord(1, 0, "collector", "session_start", {}),
      journalRecord(2, 400_000, "gamma", "event_metadata", eventMetadata(finishAtMs)),
      journalRecord(3, 400_001, "sports", "ws_message", JSON.stringify({ gameId: 123, slug: "game", finishedAt })),
      journalRecord(4, 400_002, "gamma", "event_metadata", eventMetadata(finishAtMs - 1)),
      journalRecord(5, 400_003, "gamma", "event_metadata", eventMetadata(finishAtMs)),
      journalRecord(6, 500_000, "collector", "session_end", {})
    ]);
    const finishLabelsFile = join(runDirectory, "..", "finish-labels.json");
    const body = JSON.stringify((eventMetadata(finishAtMs, { score: "9-9" }) as { event: unknown }).event);
    await writeFile(finishLabelsFile, JSON.stringify({
      schemaVersion: 1, kind: "tail-finish-labels", runId: "tail-test", events: [{
        eventId: "event", eventSlug: "game", gameId: "123", receivedAtMs: 600_000, response: { status: 200, body }
      }]
    }));
    const catalog = await scanTailCatalog(tailOptions({ runDirectory, finishLabelsFile }));
    expect(catalog.windows[0]?.finishEvidence).toEqual([
      { atMs: finishAtMs, observedAtMs: 400_000, source: "gamma.finishedTimestamp", eventSlug: "game" },
      { atMs: finishAtMs, observedAtMs: 400_001, source: "sports.finishedAt", eventSlug: "game" },
      { atMs: finishAtMs - 1, observedAtMs: 400_002, source: "gamma.finishedTimestamp", eventSlug: "game" },
      { atMs: finishAtMs, observedAtMs: 600_000, source: "gamma.finishedTimestamp", eventSlug: "game", sourceFile: finishLabelsFile }
    ]);
    expect(catalog.windows[0]?.finishSources).toEqual(["gamma.finishedTimestamp", "sports.finishedAt"]);
  });

  test("live heap stays bounded while repeated 32 KiB completed metadata is scanned", async () => {
    const count = 2000, description = "x".repeat(32 * 1024);
    const runDirectory = await writeRun([
      journalRecord(1, 0, "collector", "session_start", {}),
      ...Array.from({ length: count }, (_, index) => journalRecord(index + 2, 400_000 + index,
        "gamma", "event_metadata", eventMetadata(finishAtMs, { description }))),
      journalRecord(count + 2, 500_000, "collector", "session_end", {})
    ]);
    // Sample a real scan in an isolated process, after GC and before EOF can release its accumulator.
    // The parse hook observes only progress; it neither replaces input nor retains parsed records.
    const script = `
      import { scanTailCatalog, tailOptions } from ${JSON.stringify(new URL("../../src/collector/tail-catalog.ts", import.meta.url).href)};
      const parse = JSON.parse, samples = [];
      JSON.parse = function (text, reviver) {
        const value = parse(text, reviver);
        if (value?.source === "gamma" && value.kind === "event_metadata" && [201, 2001].includes(value.sequence)) {
          global.gc();
          samples.push(process.memoryUsage().heapUsed);
        }
        return value;
      };
      const catalog = await scanTailCatalog(tailOptions({ runDirectory: process.argv[1] }));
      JSON.parse = parse;
      process.stdout.write(JSON.stringify({ samples, evidenceCount: catalog.windows[0].finishEvidence.length }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--expose-gc", "--import", "tsx", "--input-type=module", "--eval", script, runDirectory],
      { cwd: fileURLToPath(new URL("../../", import.meta.url)) });
    const result = JSON.parse(stdout) as { samples: number[]; evidenceCount: number };
    expect(result.samples).toHaveLength(2);
    const growth = result.samples[1]! - result.samples[0]!;
    expect(growth, `live heap grew ${(growth / 1024 / 1024).toFixed(1)} MiB from 200 to 2000 observations`)
      .toBeLessThan(8 * 1024 * 1024);
    expect(result.evidenceCount).toBe(1);
  }, 15_000);
});
