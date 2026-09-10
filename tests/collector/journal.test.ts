import { mkdtemp, open, readdir, readFile, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createJournal, listJournalSegments } from "../../src/collector/journal.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const temporaryDirectories: string[] = [];

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockReset().mockImplementation(actual.open);
});

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

async function interceptNextFile(intercept: (file: FileHandle) => void): Promise<void> {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const file = await actual.open(...args);
    intercept(file);
    return file;
  });
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

  test("allocates increasing segments when the receipt clock revisits an earlier UTC date", async () => {
    const root = await temporaryRoot();
    const times = ["2026-09-10T23:59:59Z", "2026-09-11T00:00:01Z", "2026-09-10T23:59:58Z"];
    const journal = await createJournal({ rootDir: root, runId: "rollback", now: () => new Date(times.shift()!), maxSegmentBytes: 1 });
    for (const value of ["first", "second", "third"]) journal.record({ source: "clob", kind: "ws_message", data: value });

    await expect(journal.close()).resolves.toBeUndefined();
    const segments = await listJournalSegments(journal.runDirectory);
    expect(segments).toEqual(["2026-09-10-000000.ndjson", "2026-09-11-000001.ndjson", "2026-09-10-000002.ndjson"]);
    const records = await Promise.all(segments.map(async (name) => JSON.parse(await readFile(join(journal.runDirectory, name), "utf8"))));
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3]);
    expect(records.map((record) => record.data)).toEqual(["first", "second", "third"]);
  });

  test("lists legacy per-date segments by record sequence, retaining incomplete and empty tails", async () => {
    const root = await temporaryRoot();
    const ordered = ["2026-09-11-000000.ndjson", "2026-09-10-000000.ndjson", "2026-09-11-000001.ndjson", "2026-09-09-000000.ndjson"];
    await writeFile(join(root, ordered[0]!), `${JSON.stringify({ sequence: 1, data: "first" })}\n`);
    await writeFile(join(root, ordered[1]!), `${JSON.stringify({ sequence: 3, data: "second" })}\n`);
    await writeFile(join(root, ordered[2]!), '{"sequence":5,"data":"interrupted');
    await writeFile(join(root, ordered[3]!), "");
    await writeFile(join(root, "notes.txt"), "not a journal");

    expect(await listJournalSegments(root)).toEqual(ordered);
  });

  test("orders large first records using bounded header reads and accepts indices beyond six digits", async () => {
    const root = await temporaryRoot();
    const first = "2026-09-11-999999.ndjson";
    const second = "2026-09-10-1000000.ndjson";
    const line = (sequence: number) => `${JSON.stringify({ schemaVersion: 1, runId: "large", sequence, data: "x".repeat(200_000) })}\n`;
    await writeFile(join(root, first), line(1));
    await writeFile(join(root, second), line(2));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const reads: number[] = [];
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await actual.open(...args);
      const read = file.read.bind(file);
      vi.spyOn(file, "read").mockImplementation((async (...readArgs: unknown[]) => {
        const result = await Reflect.apply(read, file, readArgs);
        reads.push(result.bytesRead);
        return result;
      }) as FileHandle["read"]);
      return file;
    });

    expect(await listJournalSegments(root)).toEqual([first, second]);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(2 * 64 * 1024);
  });

  test("counts an in-flight write against the pending-byte admission limit", async () => {
    const root = await temporaryRoot();
    let releaseWrite!: () => void;
    let enteredWrite!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const entered = new Promise<void>((resolve) => { enteredWrite = resolve; });
    await interceptNextFile((file) => {
      const write = file.write.bind(file);
      vi.spyOn(file, "write").mockImplementationOnce((async (...args: unknown[]) => {
        enteredWrite();
        await gate;
        return Reflect.apply(write, file, args);
      }) as FileHandle["write"]);
    });
    const journal = await createJournal({ rootDir: root, runId: "in-flight", maxBufferBytes: 400 });
    const input = { source: "clob" as const, kind: "ws_message", data: "x".repeat(50) };
    const first = journal.record(input);
    await entered;
    try {
      expect(journal.pendingBytes).toBe(Buffer.byteLength(`${JSON.stringify(first)}\n`));
      expect(() => journal.record(input)).toThrow("JOURNAL_BUFFER_OVERFLOW");
    } finally {
      releaseWrite();
      await journal.close();
    }
    expect(journal.pendingBytes).toBe(0);
    expect(await journalLines(root, journal.runId)).toHaveLength(1);
  });

  test("reports initialization storage failure once even before a journal can be returned", async () => {
    const root = await temporaryRoot();
    const occupied = join(root, "file");
    await writeFile(occupied, "occupied");
    const onError = vi.fn();
    await expect(createJournal({ rootDir: occupied, onError })).rejects.toBeDefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test.each(["sync", "close"] as const)("reports final %s failure once and makes close idempotent", async (operation) => {
    const root = await temporaryRoot();
    const storageError = new Error(`failed ${operation}`);
    const onError = vi.fn();
    let closeCalls!: ReturnType<typeof vi.spyOn>;
    await interceptNextFile((file) => {
      const close = file.close.bind(file);
      closeCalls = vi.spyOn(file, "close").mockImplementation(async () => {
        await close();
        if (operation === "close") throw storageError;
      });
      if (operation === "sync") vi.spyOn(file, "sync").mockRejectedValue(storageError);
    });
    const journal = await createJournal({ rootDir: root, onError });
    journal.record({ source: "collector", kind: "session_end", data: {} });
    await journal.flush();
    await expect(journal.close()).rejects.toThrow("JOURNAL_STORAGE_ERROR");
    await expect(journal.close()).rejects.toThrow("JOURNAL_STORAGE_ERROR");
    expect(onError).toHaveBeenCalledExactlyOnceWith(storageError);
    expect(closeCalls).toHaveBeenCalledTimes(1);
    expect(journal.error).toBe(storageError);
    expect(() => journal.record({ source: "collector", kind: "late", data: {} })).toThrow("JOURNAL_CLOSED");
  });

  test("syncs each rotated segment and the final segment before closing their file handles", async () => {
    const root = await temporaryRoot();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const operations: string[] = [];
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await actual.open(...args);
      const sync = file.sync.bind(file);
      const close = file.close.bind(file);
      vi.spyOn(file, "sync").mockImplementation(async () => { operations.push("sync"); await sync(); });
      vi.spyOn(file, "close").mockImplementation(async () => { operations.push("close"); await close(); });
      return file;
    });
    const journal = await createJournal({ rootDir: root, maxSegmentBytes: 1 });
    journal.record({ source: "collector", kind: "session_start", data: {} });
    journal.record({ source: "collector", kind: "session_end", data: {} });
    await journal.close();
    expect(operations).toEqual(["sync", "close", "sync", "close"]);
  });

  test("treats even an empty storage rejection as fatal and reports it only once", async () => {
    const root = await temporaryRoot();
    const onError = vi.fn();
    await interceptNextFile((file) => { vi.spyOn(file, "write").mockRejectedValue(undefined); });
    const journal = await createJournal({ rootDir: root, onError });
    journal.record({ source: "clob", kind: "ws_message", data: "not written" });
    try {
      await expect(journal.flush()).rejects.toThrow("JOURNAL_STORAGE_ERROR");
      expect(() => journal.record({ source: "clob", kind: "ws_message", data: "late" })).toThrow("JOURNAL_STORAGE_ERROR");
    } finally {
      await expect(journal.close()).rejects.toThrow("JOURNAL_STORAGE_ERROR");
    }
    expect(journal.pendingBytes).toBe(0);
    expect(onError).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});
