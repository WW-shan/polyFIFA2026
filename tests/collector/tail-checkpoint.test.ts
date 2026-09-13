import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createJournal, listJournalSegments } from "../../src/collector/journal.js";
import { sealJournalSnapshot } from "../../src/collector/sealed-journal.js";
import { journalStamp, scanTailCatalog, tailOptions } from "../../src/collector/tail-catalog.js";
import { exportTail } from "../../src/collector/tail-export.js";
import { replayTail } from "../../src/collector/tail-replay.js";
import type { JournalRecord } from "../../src/collector/types.js";
import { eventMetadata, fixtureRecords, journalRecord, writeFixture } from "./tail-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function checkpointRecords(): JournalRecord[] {
  return [...fixtureRecords().slice(0, -1), journalRecord(15, 310_100, "collector", "checkpoint_end", { sealed: true })];
}
async function writeRun(records = checkpointRecords()): Promise<string> {
  const root = await writeFixture(records);
  roots.push(root);
  return join(root, "run");
}
const replayOptions = { maxFeedSilenceMs: 600_000, sportsStaleAfterMs: 600_000 };

describe("tail replay checkpoint cutoffs", () => {
  test("accepts an explicit final sealed checkpoint and explains that collection continued", async () => {
    const runDirectory = await writeRun();
    const catalog = await scanTailCatalog(tailOptions({ runDirectory }));
    expect(catalog).toMatchObject({ runId: "tail-test", records: 15, lastMs: 310_100 });
    expect(catalog.warnings).toContain("sealed-checkpoint: immutable cutoff; collection continued in the source run");
    expect(catalog.windows[0]).toMatchObject({ endAtMs: 310_000, finishSources: ["gamma.finishedTimestamp"] });
  });

  test("a checkpoint supplies no actual game finish", async () => {
    const rows = checkpointRecords();
    rows[1]!.data = eventMetadata(0);
    const runDirectory = await writeRun(rows);
    const catalog = await scanTailCatalog(tailOptions({ runDirectory }));
    expect(catalog.windows[0]).toMatchObject({ endAtMs: null, startAtMs: null, finishSources: [] });
    expect(catalog.warnings).toContain("missing-actual-finish:game:123");
    const result = await exportTail({ runDirectory, outputDirectory: join(runDirectory, "..", "tail") });
    expect(result.summary.seconds).toBe(0);
    expect(result.summary.tokens.every(token => !token.readyForReplay)).toBe(true);
  });

  test.each([{}, { sealed: false }, { sealed: "true" }, { sealed: 1 }, null])("rejects checkpoint data without sealed === true: %j", async data => {
    const rows = checkpointRecords();
    rows.at(-1)!.data = data;
    const runDirectory = await writeRun(rows);
    await expect(scanTailCatalog(tailOptions({ runDirectory }))).rejects.toThrow("TAIL_RUN_NOT_CLOSED");
  });

  test.each(["ordinary-active", "wrong-source", "later-record"])("still rejects an unclosed journal: %s", async scenario => {
    const rows = checkpointRecords();
    if (scenario === "ordinary-active") rows.pop();
    if (scenario === "wrong-source") rows.at(-1)!.source = "sports";
    if (scenario === "later-record") rows.push(journalRecord(16, 310_101, "clob", "ws_message", "PONG", "clob"));
    const runDirectory = await writeRun(rows);
    const outputDirectory = join(runDirectory, "..", "tail");
    await expect(exportTail({ runDirectory, outputDirectory })).rejects.toThrow("TAIL_RUN_NOT_CLOSED");
    await expect(readFile(join(outputDirectory, "manifest.json"))).rejects.toThrow();
  });

  test("the owner's later session_end retains ordinary failed-session semantics", async () => {
    const runDirectory = await writeRun([...checkpointRecords(), journalRecord(16, 310_101, "collector", "session_end", { status: "failed" })]);
    const catalog = await scanTailCatalog(tailOptions({ runDirectory }));
    expect(catalog.warnings).toContain("collector-session-failed");
    expect(catalog.warnings.some(warning => warning.startsWith("sealed-checkpoint:"))).toBe(false);
  });

  test.each([
    ["run identity", "TAIL_RUN_MISMATCH", (rows: JournalRecord[]) => { rows[6]!.runId = "other"; }],
    ["sequence order", "TAIL_SEQUENCE_ORDER", (rows: JournalRecord[]) => { rows[6]!.sequence = 6; }],
    ["receipt clock order", "TAIL_CLOCK_ORDER", (rows: JournalRecord[]) => {
      rows[6]!.receivedAtMs = 8999; rows[6]!.receivedAt = new Date(8999).toISOString();
    }],
    ["monotonic clock order", "TAIL_CLOCK_ORDER", (rows: JournalRecord[]) => { rows[6]!.monotonicNs = "0"; }],
    ["clock drift", "TAIL_CLOCK_DISCONTINUITY", (rows: JournalRecord[]) => { rows[13]!.monotonicNs = "20000000000"; }],
    ["metadata identity", "TAIL_METADATA_IDENTITY_CONFLICT", (rows: JournalRecord[]) => {
      rows[13] = journalRecord(14, 309_999, "gamma", "event_metadata", eventMetadata(310_000, { gameId: 999 }));
    }]
  ] as const)("preserves %s checks on sealed prefixes", async (_name, error, mutate) => {
    const rows = checkpointRecords();
    mutate(rows);
    const runDirectory = await writeRun(rows);
    await expect(scanTailCatalog(tailOptions({ runDirectory }))).rejects.toThrow(error);
  });

  test("damage within a sealed prefix remains visible and invalidates replay quality", async () => {
    const runDirectory = await writeRun();
    const segment = join(runDirectory, "1970-01-01-000000.ndjson");
    const lines = (await readFile(segment, "utf8")).split("\n");
    lines[7] = "{damaged sports frame}";
    await writeFile(segment, lines.join("\n"));
    const result = await exportTail({ runDirectory, outputDirectory: join(runDirectory, "..", "tail"), ...replayOptions });
    expect(result.summary.warnings).toContain("damaged-journal-lines");
    expect(result.summary.journalQuality.malformedLines).toBe(1);
    expect(result.summary.tokens.every(token => !token.readyForReplay)).toBe(true);
  });

  test.each(['{"later":"incomplete', "{malformed later record}\n"])("rejects damaged bytes after the checkpoint marker: %j", async tail => {
    const runDirectory = await writeRun();
    await appendFile(join(runDirectory, "1970-01-01-000000.ndjson"), tail);
    await expect(scanTailCatalog(tailOptions({ runDirectory }))).rejects.toThrow("TAIL_RUN_NOT_CLOSED");
  });

  test("still detects input changes between catalog and replay", async () => {
    const runDirectory = await writeRun();
    let changed = false;
    await expect(replayTail({ runDirectory, ...replayOptions }, {
      second: async () => {
        if (changed) return;
        changed = true;
        await appendFile(join(runDirectory, "1970-01-01-000000.ndjson"),
          JSON.stringify(journalRecord(16, 310_101, "collector", "checkpoint_end", { sealed: true })) + "\n");
      }, change: () => {}, stateChange: () => {}, audit: () => {}
    })).rejects.toThrow("TAIL_INPUT_CHANGED");
    expect(changed).toBe(true);
  });

  test("exports audited seconds and raw events from a sealed prefix", async () => {
    const runDirectory = await writeRun();
    const outputDirectory = join(runDirectory, "..", "tail");
    const result = await exportTail({ runDirectory, outputDirectory, ...replayOptions });
    expect(result.summary.seconds).toBe(600);
    expect(result.summary.tokens.every(token => token.readyForReplay)).toBe(true);
    const rows = (await readFile(join(outputDirectory, "seconds.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(rows.find(row => row.tokenId === "A" && row.startAtMs === 11_000)).toMatchObject({ bestBid: "0.94", minBestBid: 0.6, bookUpdates: 2 });
    expect(JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8"))).toMatchObject({ status: "complete", sourceRunId: "tail-test" });
    const raw = (await readFile(join(outputDirectory, "raw-events.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(raw.find(row => row.sequence === 9)).toMatchObject(fixtureRecords()[8]!);
  });

  test("exports successive hardlinked checkpoints while the real source journal continues", async () => {
    const root = await mkdtemp(join(tmpdir(), "poly-tail-checkpoint-"));
    roots.push(root);
    let now = 0, monotonic = 0n;
    const journal = await createJournal({ rootDir: join(root, "source"), runId: "tail-test",
      now: () => now, monotonicNs: () => monotonic });
    try {
      for (const row of fixtureRecords().slice(0, -1)) {
        now = row.receivedAtMs; monotonic = BigInt(row.monotonicNs);
        expect(journal.record(row)).toEqual(row);
      }
      now = 310_100; monotonic = 310_100_000_015n;
      const firstPending = sealJournalSnapshot(journal, join(root, "first-prefix"));
      now = 311_000; monotonic = 311_000_000_016n;
      const b = journal.record({ source: "clob", kind: "ws_message", data: "PONG", connectionId: "clob" });
      const first = await firstPending;
      const firstStamp = await journalStamp(first.runDirectory);
      now = 312_000; monotonic = 312_000_000_017n;
      const secondPending = sealJournalSnapshot(journal, join(root, "second-prefix"));
      now = 313_000; monotonic = 313_000_000_018n;
      const c = journal.record({ source: "sports", kind: "ws_message", data: "still connected", connectionId: "sports" });
      const second = await secondPending;
      const [firstExport, secondExport] = await Promise.all([
        exportTail({ runDirectory: first.runDirectory, outputDirectory: join(root, "first-export"), ...replayOptions }),
        exportTail({ runDirectory: second.runDirectory, outputDirectory: join(root, "second-export"), ...replayOptions })
      ]);
      expect([first.checkpoint.sequence, second.checkpoint.sequence]).toEqual([15, 17]);
      expect(firstExport.summary).toMatchObject({ records: 15, seconds: 600, lastReceivedAtMs: 310_100 });
      expect(secondExport.summary).toMatchObject({ records: 17, seconds: 600, lastReceivedAtMs: 312_000 });
      expect(firstExport.summary.tokens.every(token => token.readyForReplay)).toBe(true);
      expect(secondExport.summary.tokens.every(token => token.readyForReplay)).toBe(true);
      expect(await readFile(join(firstExport.outputDirectory, "seconds.ndjson"), "utf8"))
        .toBe(await readFile(join(secondExport.outputDirectory, "seconds.ndjson"), "utf8"));
      const readRows = async (directory: string): Promise<JournalRecord[]> => {
        const files = await listJournalSegments(directory);
        const text = (await Promise.all(files.map(file => readFile(join(directory, file), "utf8")))).join("");
        return text.trim().split("\n").map(line => JSON.parse(line) as JournalRecord);
      };
      expect(await readRows(first.runDirectory)).toHaveLength(15);
      expect(await readRows(second.runDirectory)).toContainEqual(b);
      expect(await readRows(second.runDirectory)).not.toContainEqual(c);
      await journal.flush();
      expect((await readRows(journal.runDirectory)).at(-1)).toEqual(c);
      await expect(scanTailCatalog(tailOptions({ runDirectory: journal.runDirectory }))).rejects.toThrow("TAIL_RUN_NOT_CLOSED");
      now = 314_000; monotonic = 314_000_000_019n;
      journal.record({ source: "collector", kind: "session_end", data: { status: "stopped" } });
      await journal.close();
      expect(await journalStamp(first.runDirectory)).toBe(firstStamp);
    } finally { await journal.close(); }
  });
});
