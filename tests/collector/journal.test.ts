import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createJournal } from "../../src/collector/journal.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "poly-fifa-collector-journal-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function journalLines(directory: string, runDirectory: string): Promise<Record<string, unknown>[]> {
  const files = (await readdir(join(directory, runDirectory))).sort();
  const lines: Record<string, unknown>[] = [];
  for (const file of files) {
    const content = await readFile(join(directory, runDirectory, file), "utf8");
    for (const line of content.split("\n")) {
      if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return lines;
}

describe("segmented collector journal", () => {
  test("creates unique run directories and preserves receipt order and clocks", async () => {
    const root = await temporaryRoot();
    const journal = await createJournal({
      rootDir: root,
      runId: "run",
      now: () => new Date("2026-09-10T12:00:00.000Z"),
      monotonicNs: () => 100n,
      maxSegmentBytes: 1_000_000
    });
    const first = journal.record({ source: "collector", kind: "session_start", data: { ok: true } });
    const second = journal.record({ source: "clob", kind: "ws_message", connectionId: "clob-0-e1", data: "frame" });
    await journal.close();

    const secondJournal = await createJournal({
      rootDir: root,
      runId: "run",
      now: () => new Date("2026-09-10T12:00:01.000Z"),
      monotonicNs: () => 200n
    });
    secondJournal.record({ source: "collector", kind: "session_start", data: { ok: true } });
    await secondJournal.close();

    const runDirectories = (await readdir(root)).sort();
    expect(runDirectories).toEqual(["run", "run-1"]);
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.receivedAt).toBe("2026-09-10T12:00:00.000Z");
    expect(first.monotonicNs).toBe("100");
    expect(second.connectionId).toBe("clob-0-e1");
    expect(await journalLines(root, "run")).toHaveLength(2);
  });

  test("rotates on UTC date and segment byte limits without reordering records", async () => {
    const root = await temporaryRoot();
    const times = [
      new Date("2026-09-10T23:59:59.000Z"),
      new Date("2026-09-11T00:00:00.000Z"),
      new Date("2026-09-11T00:00:01.000Z")
    ];
    const journal = await createJournal({
      rootDir: root,
      runId: "rotating",
      now: () => times.shift() ?? new Date("2026-09-11T00:00:02.000Z"),
      monotonicNs: (() => {
        let value = 0n;
        return () => ++value;
      })(),
      maxSegmentBytes: 170
    });
    journal.record({ source: "clob", kind: "ws_message", data: { value: "first" } });
    journal.record({ source: "clob", kind: "ws_message", data: { value: "second" } });
    journal.record({ source: "clob", kind: "ws_message", data: { value: "third" } });
    await journal.close();

    const files = (await readdir(join(root, "rotating"))).sort();
    expect(files.some((file) => file.startsWith("2026-09-10-"))).toBe(true);
    expect(files.some((file) => file.startsWith("2026-09-11-"))).toBe(true);
    expect(files.length).toBeGreaterThan(2);
    const records = await journalLines(root, "rotating");
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3]);
  });

  test("rejects records that exceed the bounded pending buffer and cannot write after close", async () => {
    const root = await temporaryRoot();
    const journal = await createJournal({ rootDir: root, runId: "bounded", maxBufferBytes: 1 });
    expect(() => journal.record({ source: "sports", kind: "ws_message", data: "too large" })).toThrow("JOURNAL_BUFFER_OVERFLOW");
    await journal.close();
    expect(() => journal.record({ source: "sports", kind: "ws_message", data: "after close" })).toThrow("JOURNAL_CLOSED");
  });

  test("surfaces asynchronous storage failures to the sink and flush caller", async () => {
    const root = await temporaryRoot();
    let reported: unknown;
    const journal = await createJournal({
      rootDir: root,
      runId: "failed-storage",
      onError: (error) => { reported = error; }
    });
    await rm(journal.runDirectory, { recursive: true, force: true });
    journal.record({ source: "clob", kind: "ws_message", data: "frame" });

    await expect(journal.flush()).rejects.toThrow("JOURNAL_STORAGE_ERROR");
    expect(reported).toBeDefined();
    await expect(journal.close()).rejects.toThrow("JOURNAL_STORAGE_ERROR");
  });
});
