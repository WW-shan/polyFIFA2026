import { mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { readJournalSegmentPrefix } from "../../src/collector/journal-segments.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createJournal, listJournalSegments } from "../../src/collector/journal.js";
import { scanJournal } from "../../src/collector/journal-reader.js";
import { emptyReplayQuality } from "../../src/collector/replay-types.js";
import { sealJournalSnapshot } from "../../src/collector/sealed-journal.js";
import { journalStamp } from "../../src/collector/tail-catalog.js";
import { rawRunBytes } from "../../src/collector/continuous-storage.js";
import type { JournalRecord } from "../../src/collector/types.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "poly-journal-compression-"));
  temporary.push(path);
  return path;
}
async function records(path: string): Promise<JournalRecord[]> {
  const result: JournalRecord[] = [], quality = emptyReplayQuality();
  await scanJournal(path, record => { result.push(record); }, quality, () => {});
  expect(quality.malformedLines).toBe(0);
  expect(quality.incompleteFinalLines).toBe(0);
  return result;
}
async function closedRun(data: unknown = { label: "网球🙂", price: "0.12345678901234567890" }, maxSegmentBytes = 1_000_000) {
  const root = await directory();
  const journal = await createJournal({ rootDir: root, runId: "run", maxSegmentBytes,
    now: () => 1_700_000_000_000, monotonicNs: () => 100n });
  journal.record({ source: "collector", kind: "session_start", data: {} });
  journal.record({ source: "clob", kind: "ws_message", connectionId: "clob-0-e1", data });
  journal.record({ source: "collector", kind: "session_end", data: { status: "stopped" } });
  await journal.close();
  return { root, path: journal.runDirectory, names: await listJournalSegments(journal.runDirectory) };
}
async function compressTestFile(path: string, removePlain = true): Promise<void> {
  await writeFile(path + ".gz", gzipSync(await readFile(path)), { flag: "wx" });
  if (removePlain) await unlink(path);
}

describe("lossless compressed journal reads", () => {
  test("repeated early gzip prefix reads settle even when the source is still reading", async () => {
    const root = await directory();
    const path = join(root, "2026-09-16-000000.ndjson");
    const bytes = Buffer.concat([randomBytes(110_000), Buffer.alloc(1_000_000, 65)]);
    await writeFile(path + ".gz", gzipSync(bytes));
    for (let index = 0; index < 100; index++) {
      expect((await readJournalSegmentPrefix(path, 65_536)).equals(bytes.subarray(0, 65_536))).toBe(true);
    }
  });

  test("reads a gzip-only segment using its original logical name and exact records", async () => {
    const run = await closedRun();
    const expected = await records(run.path);
    await compressTestFile(join(run.path, run.names[0]!));

    expect(await listJournalSegments(run.path)).toEqual(run.names);
    expect(await records(run.path)).toEqual(expected);
    expect(JSON.parse(await journalStamp(run.path))).toHaveLength(1);
    expect(await rawRunBytes(run.path)).toBe((await stat(join(run.path, run.names[0]! + ".gz"))).size);
  });

  test("mixed formats and a migration overlap emit each logical segment once", async () => {
    const run = await closedRun("quote", 1);
    const expected = await records(run.path);
    expect(run.names).toHaveLength(3);
    await compressTestFile(join(run.path, run.names[0]!), false);
    await compressTestFile(join(run.path, run.names[1]!));

    expect(await listJournalSegments(run.path)).toEqual(run.names);
    expect(await records(run.path)).toEqual(expected);
  });

  test("keeps UTF-8 and decimal strings exact across decompression chunks", async () => {
    const value = { text: "🙂汉字".repeat(40_000), size: "12345678901234567890.000000000000000001" };
    const run = await closedRun(value);
    await compressTestFile(join(run.path, run.names[0]!));

    expect((await records(run.path))[1]!.data).toEqual(value);
  });

  test("rejects truncated compressed bytes instead of treating them as an empty journal", async () => {
    const run = await closedRun();
    const path = join(run.path, run.names[0]!);
    const compressed = gzipSync(await readFile(path));
    await writeFile(path + ".gz", compressed.subarray(0, compressed.length - 4));
    await unlink(path);

    await expect(records(run.path)).rejects.toThrow(/gzip|compressed|unexpected end|incorrect|checksum/i);
  });

  test("rejects a checksum-corrupt gzip even when its record text can be inflated", async () => {
    const run = await closedRun();
    const path = join(run.path, run.names[0]!);
    const compressed = gzipSync(await readFile(path));
    compressed[compressed.length - 8] = compressed[compressed.length - 8]! ^ 1;
    await writeFile(path + ".gz", compressed);
    await unlink(path);

    await expect(records(run.path)).rejects.toThrow(/gzip|compressed|unexpected end|incorrect|checksum/i);
  });

  test("does not follow a compressed segment symlink", async () => {
    const run = await closedRun();
    const path = join(run.path, run.names[0]!);
    const external = join(run.root, "outside.gz");
    await writeFile(external, gzipSync(await readFile(path)));
    await unlink(path);
    await symlink(external, path + ".gz");

    await expect(records(run.path)).rejects.toThrow(/SEGMENT_INVALID|symlink/i);
  });

  test("seals a live journal with previously compressed segments and unchanged logical provenance", async () => {
    const root = await directory();
    const journal = await createJournal({ rootDir: root, runId: "live",
      now: () => 1_700_000_000_000, monotonicNs: () => 100n });
    journal.record({ source: "collector", kind: "session_start", data: {} });
    journal.record({ source: "clob", kind: "ws_message", data: { quote: "0.70" } });
    const first = await journal.checkpoint();
    await compressTestFile(join(journal.runDirectory, first.segments[0]!));
    journal.record({ source: "collector", kind: "heartbeat", data: "still recording" });
    const output = join(root, "snapshot");
    try {
      const sealed = await sealJournalSnapshot(journal, output, { fromSequence: 1 });
      journal.record({ source: "collector", kind: "after_snapshot", data: {} });
      const captured = await records(output);
      expect(captured.at(-1)!.sequence).toBe(sealed.checkpoint.sequence);
      expect(captured.some(record => record.kind === "after_snapshot")).toBe(false);
      expect(sealed.checkpoint.segments).toEqual(await listJournalSegments(output));
      expect((await readdir(output)).some(name => name.endsWith(".ndjson.gz"))).toBe(true);
      const source = await stat(join(journal.runDirectory, first.segments[0]! + ".gz"));
      const linked = await stat(join(output, first.segments[0]! + ".gz"));
      expect([linked.dev, linked.ino]).toEqual([source.dev, source.ino]);
      expect(JSON.parse(await readFile(join(output, "checkpoint.json"), "utf8")).segments).toEqual(sealed.checkpoint.segments);
    } finally { await journal.close(); }
  });

  test("accepts a valid compressed cutoff whose encoded bytes are larger than its original marker", async () => {
    const root = await directory();
    const journal = await createJournal({ rootDir: root, runId: "cutoff" });
    const checkpoint = await journal.checkpoint();
    await journal.close();
    const logical = join(journal.runDirectory, checkpoint.segments[0]!);
    const original = await readFile(logical), encoded = gzipSync(original, { level: 0 });
    expect(encoded.length).toBeGreaterThan(original.length);
    await writeFile(logical + ".gz", encoded); await unlink(logical);
    vi.spyOn(journal, "checkpoint").mockResolvedValue(checkpoint);

    await expect(sealJournalSnapshot(journal, join(root, "sealed"))).resolves.toMatchObject({ checkpoint });
  });

  test("rejects a compressed cutoff without a real preceding record boundary", async () => {
    const root = await directory();
    const journal = await createJournal({ rootDir: root, runId: "cutoff" });
    const checkpoint = await journal.checkpoint();
    await journal.close();
    const logical = join(journal.runDirectory, checkpoint.segments[0]!);
    const marker = JSON.parse(await readFile(logical, "utf8"));
    marker.data.padding = "";
    const bytes = 64 * 1024;
    marker.data.padding = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(marker)) - 1);
    const line = JSON.stringify(marker) + "\n";
    expect(Buffer.byteLength(line)).toBe(bytes);
    await writeFile(logical + ".gz", gzipSync(Buffer.from("BROKEN" + line))); await unlink(logical);
    vi.spyOn(journal, "checkpoint").mockResolvedValue(checkpoint);

    await expect(sealJournalSnapshot(journal, join(root, "invalid"))).rejects.toThrow("JOURNAL_SNAPSHOT_INVALID");
  });

  test("enforces the line byte limit after flushing an incomplete UTF-8 character", async () => {
    const root = await directory();
    await writeFile(join(root, "2023-11-14-000000.ndjson"), Buffer.from([0xe2, 0x82]));
    await expect(scanJournal(root, () => {}, emptyReplayQuality(), () => {}, { maxLineBytes: 1 })).rejects.toThrow("REPLAY_LINE_TOO_LARGE");
  });
});
