import { appendFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CollectorJournal, createJournal, listJournalSegments, type JournalOptions } from "../../src/collector/journal.js";
import { sealJournalSnapshot } from "../../src/collector/sealed-journal.js";
import { replayTail } from "../../src/collector/tail-replay.js";
import type { JournalRecord } from "../../src/collector/types.js";
import { fixtureRecords } from "./tail-fixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), link: vi.fn(actual.link) };
});

const roots: string[] = [];
const journals: CollectorJournal[] = [];
beforeEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockReset().mockImplementation(actual.open);
  vi.mocked(link).mockReset().mockImplementation(actual.link);
});
afterEach(async () => {
  await Promise.allSettled(journals.splice(0).map(journal => journal.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "poly-journal-checkpoint-"));
  roots.push(root);
  return root;
}
async function openJournal(options: JournalOptions = {}): Promise<CollectorJournal> {
  const journal = await createJournal({ runId: "checkpoint", now: () => 1000, monotonicNs: () => 1_000_000_000n,
    ...options, rootDir: options.rootDir ?? await temporaryRoot() });
  journals.push(journal);
  return journal;
}
async function contents(directory: string, segments?: string[]): Promise<string> {
  const names = segments ?? await listJournalSegments(directory);
  return (await Promise.all(names.map(name => readFile(join(directory, name), "utf8")))).join("");
}
async function records(directory: string, segments?: string[]): Promise<JournalRecord[]> {
  return (await contents(directory, segments)).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as JournalRecord);
}
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function interceptNextFile(intercept: (file: FileHandle) => void): Promise<void> {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const file = await actual.open(...args);
    intercept(file);
    return file;
  });
}

async function rotatedSource(): Promise<{ root: string; journal: CollectorJournal; original: JournalRecord[]; names: string[] }> {
  const root = await temporaryRoot();
  let now = Date.UTC(2026, 8, 10);
  const journal = await openJournal({ rootDir: root, now: () => now, monotonicNs: () => BigInt(now) * 1_000_000n });
  const original: JournalRecord[] = [];
  for (let day = 0; day < 4; day++) {
    now = Date.UTC(2026, 8, 10 + day);
    for (let index = 0; index < 2; index++) {
      original.push(journal.record({ source: "clob", kind: "ws_message", connectionId: "clob-1",
        data: JSON.stringify({ timestamp: String(now - 100), raw: `day-${day}-frame-${index}` }) }));
      now++;
    }
  }
  await journal.flush();
  return { root, journal, original, names: await listJournalSegments(journal.runDirectory) };
}

describe("journal checkpoint barriers", () => {
  test("seals the call-time prefix and preserves raw frames and clocks while subsequent records continue", async () => {
    let now = 1000;
    const journal = await openJournal({ now: () => now, monotonicNs: () => BigInt(now) * 1_000_000n });
    const a = journal.record({ source: "clob", kind: "ws_message", connectionId: "clob-1",
      data: '{"timestamp":"900","raw":"\\n原始"}' });
    now = 1100;
    const pending = journal.checkpoint();
    now = 1200;
    const b = journal.record({ source: "sports", kind: "ws_message", connectionId: "sports-1", data: "B" });
    const checkpoint = await pending;
    await journal.flush();

    expect(checkpoint).toEqual({ runId: journal.runId, sourceRunDirectory: journal.runDirectory,
      sequence: 2, receivedAtMs: 1100, segments: ["1970-01-01-000000.ndjson"] });
    const prefix = await records(journal.runDirectory, checkpoint.segments);
    expect(prefix).toEqual([a, { schemaVersion: 1, runId: journal.runId, sequence: 2,
      receivedAt: new Date(1100).toISOString(), receivedAtMs: 1100, monotonicNs: "1100000000",
      source: "collector", kind: "checkpoint_end", data: { sealed: true } }]);
    expect(await records(journal.runDirectory)).toEqual([...prefix, b]);
    expect(await listJournalSegments(journal.runDirectory)).toHaveLength(2);
    const before = await contents(journal.runDirectory, checkpoint.segments);
    journal.record({ source: "clob", kind: "ws_message", data: "C" });
    await journal.flush();
    expect(await contents(journal.runDirectory, checkpoint.segments)).toBe(before);
    expect((await records(journal.runDirectory)).some(row => row.kind === "session_end")).toBe(false);
  });

  test("concurrent checkpoints each seal their own ordered prefix", async () => {
    const journal = await openJournal();
    journal.record({ source: "clob", kind: "ws_message", data: "A" });
    const first = journal.checkpoint();
    journal.record({ source: "clob", kind: "ws_message", data: "B" });
    const second = journal.checkpoint();
    const third = journal.checkpoint();
    journal.record({ source: "sports", kind: "ws_message", data: "C" });
    const checkpoints = await Promise.all([first, second, third]);
    await journal.flush();
    expect(checkpoints.map(value => value.sequence)).toEqual([2, 4, 5]);
    expect(checkpoints.map(value => value.segments.length)).toEqual([1, 2, 3]);
    for (const checkpoint of checkpoints) {
      const prefix = await records(journal.runDirectory, checkpoint.segments);
      expect(prefix.map(row => row.sequence)).toEqual(Array.from({ length: checkpoint.sequence }, (_, i) => i + 1));
      expect(prefix.at(-1)).toMatchObject({ source: "collector", kind: "checkpoint_end", data: { sealed: true } });
    }
    checkpoints[0]!.segments.pop();
    expect(checkpoints[1]!.segments).toHaveLength(2);
    expect((await records(journal.runDirectory)).at(-1)).toMatchObject({ sequence: 6, data: "C" });
  });

  test("resolves only after the checkpoint file has been synced and closed", async () => {
    const syncEntered = gate(), syncRelease = gate(), closeEntered = gate(), closeRelease = gate();
    await interceptNextFile(file => {
      const sync = file.sync.bind(file), close = file.close.bind(file);
      vi.spyOn(file, "sync").mockImplementationOnce(async () => {
        syncEntered.release(); await syncRelease.promise; await sync();
      });
      vi.spyOn(file, "close").mockImplementationOnce(async () => {
        closeEntered.release(); await closeRelease.promise; await close();
      });
    });
    const journal = await openJournal();
    const pending = journal.checkpoint();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    journal.record({ source: "clob", kind: "ws_message", data: "after request" });
    try {
      await syncEntered.promise;
      expect(settled).toBe(false);
      expect(await listJournalSegments(journal.runDirectory)).toHaveLength(1);
      expect(journal.pendingBytes).toBeGreaterThan(0);
      syncRelease.release();
      await closeEntered.promise;
      expect(settled).toBe(false);
      closeRelease.release();
      await pending;
      await journal.flush();
      expect(await listJournalSegments(journal.runDirectory)).toHaveLength(2);
    } finally {
      syncRelease.release(); closeRelease.release();
    }
  });

  test("checkpoint markers count against the buffer limit even during an in-flight sync", async () => {
    const entered = gate(), release = gate();
    await interceptNextFile(file => {
      const sync = file.sync.bind(file);
      vi.spyOn(file, "sync").mockImplementationOnce(async () => {
        entered.release(); await release.promise; await sync();
      });
    });
    const journal = await openJournal({ maxBufferBytes: 300 });
    const first = journal.checkpoint();
    try {
      await entered.promise;
      const bytes = journal.pendingBytes;
      expect(bytes).toBeGreaterThan(150);
      expect(bytes).toBeLessThanOrEqual(300);
      await expect(journal.checkpoint()).rejects.toThrow("JOURNAL_BUFFER_OVERFLOW");
      expect(journal.pendingBytes).toBe(bytes);
    } finally { release.release(); }
    await first;
    expect(journal.pendingBytes).toBe(0);
    const next = journal.record({ source: "sports", kind: "ws_message", data: "B" });
    expect(next.sequence).toBe(2);
    await journal.flush();
    expect((await journal.checkpoint()).sequence).toBe(3);
  });

  test("retains size/date rotation and sequence ordering when the UTC receipt date rolls back", async () => {
    const times = ["2026-09-10T23:59:59Z", "2026-09-10T23:59:59Z", "2026-09-11T00:00:01Z", "2026-09-10T23:59:58Z"];
    const journal = await openJournal({ maxSegmentBytes: 1, now: () => new Date(times.shift()!) });
    journal.record({ source: "clob", kind: "ws_message", data: "A" });
    const first = journal.checkpoint();
    journal.record({ source: "clob", kind: "ws_message", data: "B" });
    const second = journal.checkpoint();
    expect((await first).segments).toEqual(["2026-09-10-000000.ndjson", "2026-09-10-000001.ndjson"]);
    const checkpoint = await second;
    expect(checkpoint.segments).toEqual(["2026-09-10-000000.ndjson", "2026-09-10-000001.ndjson",
      "2026-09-11-000002.ndjson", "2026-09-10-000003.ndjson"]);
    expect((await records(journal.runDirectory, checkpoint.segments)).map(row => row.sequence)).toEqual([1, 2, 3, 4]);
  });

  test.each(["write", "sync", "close"] as const)("rejects all checkpoint waiters after a %s failure", async operation => {
    const storageError = new Error(`checkpoint ${operation} failed`), onError = vi.fn();
    await interceptNextFile(file => {
      if (operation === "write") {
        const write = file.write.bind(file);
        vi.spyOn(file, "write").mockImplementationOnce(write).mockRejectedValueOnce(storageError);
      }
      if (operation === "sync") vi.spyOn(file, "sync").mockRejectedValueOnce(storageError);
      if (operation === "close") {
        const close = file.close.bind(file);
        vi.spyOn(file, "close").mockImplementationOnce(async () => { await close(); throw storageError; });
      }
    });
    const journal = await openJournal({ onError });
    journal.record({ source: "clob", kind: "ws_message", data: "A" });
    const results = await Promise.allSettled([journal.checkpoint(), journal.checkpoint(), journal.flush()]);
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toMatchObject({ message: "JOURNAL_STORAGE_ERROR" });
    }
    expect(journal.pendingBytes).toBe(0);
    expect(journal.error).toBe(storageError);
    expect(onError).toHaveBeenCalledExactlyOnceWith(storageError);
    await expect(journal.checkpoint()).rejects.toThrow("JOURNAL_STORAGE_ERROR");
    await expect(journal.close()).rejects.toThrow("JOURNAL_STORAGE_ERROR");
  });

  test("a checkpoint admitted before stop completes, while closing and closed journals reject new callers", async () => {
    const journal = await openJournal();
    const pending = journal.checkpoint();
    const closing = journal.close();
    await expect(journal.checkpoint()).rejects.toThrow("JOURNAL_CLOSED");
    expect((await pending).sequence).toBe(1);
    await closing;
    await expect(journal.checkpoint()).rejects.toThrow("JOURNAL_CLOSED");
    expect((await records(journal.runDirectory)).map(row => row.kind)).toEqual(["checkpoint_end"]);
  });
});

describe("sealed journal snapshots", () => {
  test("hardlinks only the call-time sealed prefix and publishes its provenance last", async () => {
    const root = await temporaryRoot(), journal = await openJournal({ rootDir: root });
    const a = journal.record({ source: "clob", kind: "ws_message", connectionId: "clob-1", data: '{"timestamp":"900","value":"A"}' });
    const pending = sealJournalSnapshot(journal, join(root, "snapshots", "first"));
    const b = journal.record({ source: "sports", kind: "ws_message", connectionId: "sports-1", data: "B" });
    const snapshot = await pending;
    await journal.flush();
    const prefix = await contents(snapshot.runDirectory);
    expect(await records(snapshot.runDirectory)).toEqual([a, expect.objectContaining({ sequence: 2, kind: "checkpoint_end", data: { sealed: true } })]);
    expect((await records(journal.runDirectory)).at(-1)).toEqual(b);
    expect(await readdir(snapshot.runDirectory)).toEqual(expect.arrayContaining([...snapshot.checkpoint.segments, "checkpoint.json"]));
    expect((await readdir(snapshot.runDirectory)).length).toBe(snapshot.checkpoint.segments.length + 1);
    for (const name of snapshot.checkpoint.segments) {
      const source = await lstat(join(journal.runDirectory, name)), saved = await lstat(join(snapshot.runDirectory, name));
      expect([saved.dev, saved.ino, saved.size]).toEqual([source.dev, source.ino, source.size]);
      expect(source.nlink).toBeGreaterThanOrEqual(2);
    }
    expect(JSON.parse(await readFile(join(snapshot.runDirectory, "checkpoint.json"), "utf8")))
      .toMatchObject({ ...snapshot.checkpoint, schemaVersion: 1, status: "complete" });
    journal.record({ source: "clob", kind: "ws_message", data: "C" });
    await journal.flush();
    expect(await contents(snapshot.runDirectory)).toBe(prefix);
    expect((await records(journal.runDirectory)).some(row => row.kind === "session_end")).toBe(false);
  });

  test("concurrent snapshot callers receive distinct stable prefixes", async () => {
    const root = await temporaryRoot(), journal = await openJournal({ rootDir: root });
    journal.record({ source: "clob", kind: "ws_message", data: "A" });
    const first = sealJournalSnapshot(journal, join(root, "first"));
    journal.record({ source: "sports", kind: "ws_message", data: "B" });
    const second = sealJournalSnapshot(journal, join(root, "second"));
    journal.record({ source: "clob", kind: "ws_message", data: "C" });
    const snapshots = await Promise.all([first, second]);
    await journal.flush();
    expect(snapshots.map(snapshot => snapshot.checkpoint.sequence)).toEqual([2, 4]);
    expect((await records(snapshots[0]!.runDirectory)).map(row => row.sequence)).toEqual([1, 2]);
    expect((await records(snapshots[1]!.runDirectory)).map(row => row.sequence)).toEqual([1, 2, 3, 4]);
    expect((await records(journal.runDirectory)).at(-1)).toMatchObject({ sequence: 5, data: "C" });
  });

  test.each(["directory", "file", "symlink"])("rejects an existing output %s without replacing it", async kind => {
    const root = await temporaryRoot(), journal = await openJournal({ rootDir: root });
    const outputDirectory = join(root, "existing"), protectedFile = join(root, "keep");
    await writeFile(protectedFile, "original bytes");
    if (kind === "directory") { await mkdir(outputDirectory); await writeFile(join(outputDirectory, "keep"), "original bytes"); }
    if (kind === "file") await writeFile(outputDirectory, "original bytes");
    if (kind === "symlink") await symlink(protectedFile, outputDirectory);
    await expect(sealJournalSnapshot(journal, outputDirectory)).rejects.toThrow("JOURNAL_SNAPSHOT_EXISTS");
    expect(await readFile(kind === "directory" ? join(outputDirectory, "keep") : outputDirectory, "utf8")).toBe("original bytes");
    if (kind === "symlink") expect((await lstat(outputDirectory)).isSymbolicLink()).toBe(true);
    expect(() => journal.record({ source: "sports", kind: "ws_message", data: "still collecting" })).not.toThrow();
  });

  test("concurrent callers to the same output publish exactly one snapshot", async () => {
    const root = await temporaryRoot(), journal = await openJournal({ rootDir: root });
    const outputDirectory = join(root, "same");
    const results = await Promise.allSettled([sealJournalSnapshot(journal, outputDirectory), sealJournalSnapshot(journal, outputDirectory)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(String(failure.reason)).toContain("JOURNAL_SNAPSHOT_EXISTS");
    const winner = results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof sealJournalSnapshot>>>;
    expect(JSON.parse(await readFile(join(outputDirectory, "checkpoint.json"), "utf8"))).toMatchObject(winner.value.checkpoint);
  });

  test.each(["write", "sync", "close"] as const)("journal %s failures cannot publish a complete snapshot", async operation => {
    const root = await temporaryRoot(), onError = vi.fn(), failure = new Error(`source ${operation}`);
    await interceptNextFile(file => {
      if (operation === "write") vi.spyOn(file, "write").mockRejectedValueOnce(failure);
      if (operation === "sync") vi.spyOn(file, "sync").mockRejectedValueOnce(failure);
      if (operation === "close") {
        const close = file.close.bind(file);
        vi.spyOn(file, "close").mockImplementationOnce(async () => { await close(); throw failure; });
      }
    });
    const journal = await openJournal({ rootDir: root, onError }), outputDirectory = join(root, "failed");
    await expect(sealJournalSnapshot(journal, outputDirectory)).rejects.toThrow("JOURNAL_STORAGE_ERROR");
    await expect(readFile(join(outputDirectory, "checkpoint.json"))).rejects.toThrow();
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  test.each(["write", "sync", "close"] as const)("manifest %s failure rejects without a complete marker and leaves collection owned by the caller", async operation => {
    const root = await temporaryRoot(), journal = await openJournal({ rootDir: root });
    const outputDirectory = join(root, "failed"), failure = new Error(`manifest ${operation}`);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await actual.open(...args);
      if (String(args[0]).startsWith(outputDirectory + "/") && args[1] === "wx") {
        if (operation === "write") vi.spyOn(file, "write").mockRejectedValueOnce(failure);
        if (operation === "sync") vi.spyOn(file, "sync").mockRejectedValueOnce(failure);
        if (operation === "close") {
          const close = file.close.bind(file);
          vi.spyOn(file, "close").mockImplementationOnce(async () => { await close(); throw failure; });
        }
      }
      return file;
    });
    await expect(sealJournalSnapshot(journal, outputDirectory)).rejects.toThrow(failure.message);
    await expect(readFile(join(outputDirectory, "checkpoint.json"))).rejects.toThrow();
    expect(journal.error).toBeUndefined();
    journal.record({ source: "sports", kind: "ws_message", data: "after archive failure" });
    await journal.flush();
    expect((await records(journal.runDirectory)).at(-1)?.data).toBe("after archive failure");
  });

  test("never falls back to copying after a hardlink failure, and retry uses a fresh output", async () => {
    const root = await temporaryRoot(), journal = await openJournal({ rootDir: root });
    const failure = Object.assign(new Error("cross-device hardlink"), { code: "EXDEV" });
    journal.record({ source: "clob", kind: "ws_message", data: "A" });
    vi.mocked(link).mockRejectedValueOnce(failure);
    const failed = join(root, "failed");
    await expect(sealJournalSnapshot(journal, failed)).rejects.toThrow("cross-device hardlink");
    await expect(readFile(join(failed, "checkpoint.json"))).rejects.toThrow();
    expect((await readdir(failed)).filter(name => name.endsWith(".ndjson"))).toEqual([]);
    const sealed = (await listJournalSegments(journal.runDirectory))[0]!;
    const original = await readFile(join(journal.runDirectory, sealed), "utf8");
    journal.record({ source: "sports", kind: "ws_message", data: "B" });
    const recovered = await sealJournalSnapshot(journal, join(root, "retry"));
    expect((await records(recovered.runDirectory)).map(row => row.kind)).toEqual(["ws_message", "checkpoint_end", "ws_message", "checkpoint_end"]);
    expect(await readFile(join(journal.runDirectory, sealed), "utf8")).toBe(original);
    await expect(sealJournalSnapshot(journal, failed)).rejects.toThrow("JOURNAL_SNAPSHOT_EXISTS");
  });

  test.each(["../outside.ndjson", "/tmp/outside.ndjson", "nested/file.ndjson", "nested\\file.ndjson", "1970-01-01-000000.ndjson\n", "checkpoint.json"])("rejects unsafe segment names: %j", async name => {
    const root = await temporaryRoot(), journal = await openJournal({ rootDir: root });
    const checkpoint = await journal.checkpoint();
    vi.spyOn(journal, "checkpoint").mockResolvedValue({ ...checkpoint, segments: [name] });
    const outputDirectory = join(root, "invalid");
    await expect(sealJournalSnapshot(journal, outputDirectory)).rejects.toThrow("JOURNAL_SNAPSHOT_INVALID");
    await expect(readFile(join(outputDirectory, "checkpoint.json"))).rejects.toThrow();
  });

  test("rejects mutable later segments even if checkpoint metadata is substituted", async () => {
    const root = await temporaryRoot(), journal = await openJournal({ rootDir: root });
    const checkpoint = await journal.checkpoint();
    journal.record({ source: "sports", kind: "ws_message", data: "live tail" });
    await journal.flush();
    vi.spyOn(journal, "checkpoint").mockResolvedValue({ ...checkpoint, segments: await listJournalSegments(journal.runDirectory) });
    const outputDirectory = join(root, "invalid");
    await expect(sealJournalSnapshot(journal, outputDirectory)).rejects.toThrow("JOURNAL_SNAPSHOT_INVALID");
    await expect(readFile(join(outputDirectory, "checkpoint.json"))).rejects.toThrow();
  });

  test("rejects symlinked source segments", async () => {
    const root = await temporaryRoot(), journal = await openJournal({ rootDir: root });
    const checkpoint = await journal.checkpoint(), segment = join(journal.runDirectory, checkpoint.segments[0]!);
    await rename(segment, join(root, "original.ndjson"));
    await symlink(join(root, "original.ndjson"), segment);
    vi.spyOn(journal, "checkpoint").mockResolvedValue(checkpoint);
    await expect(sealJournalSnapshot(journal, join(root, "invalid"))).rejects.toThrow("JOURNAL_SNAPSHOT_INVALID");
    expect((await records(root, ["original.ndjson"])).at(-1)?.kind).toBe("checkpoint_end");
  });

  test("detects a source mutation during linking before publishing provenance", async () => {
    const root = await temporaryRoot(), journal = await openJournal({ rootDir: root });
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(link).mockImplementationOnce(async (source, target) => {
      await actual.link(source, target);
      await appendFile(source, "unexpected new bytes\n");
    });
    const outputDirectory = join(root, "changed");
    await expect(sealJournalSnapshot(journal, outputDirectory)).rejects.toThrow("JOURNAL_SNAPSHOT_CHANGED");
    await expect(readFile(join(outputDirectory, "checkpoint.json"))).rejects.toThrow();
  });

  test("keeps recovery runs and the owner's eventual stop distinct from archived cutoffs", async () => {
    const root = await temporaryRoot(), journal = await openJournal({ rootDir: root, runId: "same" });
    const archive = await sealJournalSnapshot(journal, join(root, "first"));
    const original = await contents(archive.runDirectory);
    journal.record({ source: "collector", kind: "session_end", data: { status: "stopped" } });
    await journal.close();
    await expect(sealJournalSnapshot(journal, join(root, "closed"))).rejects.toThrow("JOURNAL_CLOSED");
    const restarted = await openJournal({ rootDir: root, runId: "same" });
    const recovered = await sealJournalSnapshot(restarted, join(root, "recovered"));
    expect(recovered.checkpoint.runId).toBe("same-1");
    expect(recovered.checkpoint.sequence).toBe(1);
    expect(await contents(archive.runDirectory)).toBe(original);
    expect((await records(journal.runDirectory)).at(-1)?.kind).toBe("session_end");
  });
});

describe("sealed journal suffix snapshots", () => {
  test("includes the segment containing a middle hint and every later sealed segment, preserving original bytes", async () => {
    const { root, journal, original, names } = await rotatedSource();
    const earlier = await contents(journal.runDirectory, names.slice(0, 2));
    const pending = sealJournalSnapshot(journal, join(root, "suffix"), { fromSequence: 6 });
    const after = journal.record({ source: "sports", kind: "ws_message", data: "after cutoff" });
    const snapshot = await pending;
    await journal.flush();
    expect(snapshot.checkpoint.segments).toEqual(names);
    expect(await listJournalSegments(snapshot.runDirectory)).toEqual(names.slice(2));
    expect(await records(snapshot.runDirectory)).toEqual([...original.slice(4),
      expect.objectContaining({ sequence: 9, kind: "checkpoint_end", data: { sealed: true } })]);
    expect(await records(journal.runDirectory)).toEqual([...original,
      expect.objectContaining({ sequence: 9, kind: "checkpoint_end" }), after]);
    expect(await contents(journal.runDirectory, names.slice(0, 2))).toBe(earlier);
    for (const [index, name] of names.entries()) {
      const source = await lstat(join(journal.runDirectory, name));
      expect(source.nlink).toBe(index < 2 ? 1 : 2);
      if (index >= 2) {
        const saved = await lstat(join(snapshot.runDirectory, name));
        expect([saved.dev, saved.ino, saved.size]).toEqual([source.dev, source.ino, source.size]);
      }
    }
    expect(JSON.parse(await readFile(join(snapshot.runDirectory, "checkpoint.json"), "utf8"))).toEqual({
      schemaVersion: 1, kind: "collector-checkpoint", status: "complete", ...snapshot.checkpoint,
      segments: names.slice(2), sourceCheckpoint: snapshot.checkpoint, requestedFromSequence: 6, firstIncludedSequence: 5
    });
    const prefix = await contents(snapshot.runDirectory), sealedSource = await contents(journal.runDirectory, names);
    journal.record({ source: "clob", kind: "ws_message", data: "more live data" });
    await journal.flush();
    expect(await contents(snapshot.runDirectory)).toBe(prefix);
    expect(await contents(journal.runDirectory, names)).toBe(sealedSource);
  });

  test.each([[1, 0], [3, 1], [4, 1], [7, 3], [8, 3]])("selects the containing segment for boundary hint %i", async (fromSequence, startIndex) => {
    const { root, journal, names, original } = await rotatedSource();
    const snapshot = await sealJournalSnapshot(journal, join(root, "suffix"), { fromSequence });
    expect(await listJournalSegments(snapshot.runDirectory)).toEqual(names.slice(startIndex));
    expect((await records(snapshot.runDirectory))[0]).toEqual(original[startIndex * 2]);
    expect(JSON.parse(await readFile(join(snapshot.runDirectory, "checkpoint.json"), "utf8")))
      .toMatchObject({ requestedFromSequence: fromSequence, firstIncludedSequence: startIndex * 2 + 1 });
  });

  test("includes a separately rotated checkpoint marker after the requested last data record", async () => {
    const root = await temporaryRoot(), journal = await openJournal({ rootDir: root, maxSegmentBytes: 1 });
    const original = [1, 2, 3].map(value => journal.record({ source: "clob", kind: "ws_message", data: value }));
    const snapshot = await sealJournalSnapshot(journal, join(root, "suffix"), { fromSequence: 3 });
    expect(await listJournalSegments(snapshot.runDirectory)).toEqual(snapshot.checkpoint.segments.slice(2));
    expect(await records(snapshot.runDirectory)).toEqual([original[2], expect.objectContaining({ sequence: 4, kind: "checkpoint_end" })]);
  });

  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "3", null, 9, 10])("rejects invalid or future hints: %j", async hint => {
    const { root, journal } = await rotatedSource();
    const outputDirectory = join(root, "invalid");
    await expect(sealJournalSnapshot(journal, outputDirectory, { fromSequence: hint as number }))
      .rejects.toThrow("JOURNAL_SNAPSHOT_INVALID");
    await expect(readFile(join(outputDirectory, "checkpoint.json"))).rejects.toThrow();
  });

  test("keeps the two-argument manifest and full prefix unchanged", async () => {
    const { root, journal, names } = await rotatedSource();
    const snapshot = await sealJournalSnapshot(journal, join(root, "full"));
    expect(await listJournalSegments(snapshot.runDirectory)).toEqual(names);
    expect(JSON.parse(await readFile(join(snapshot.runDirectory, "checkpoint.json"), "utf8")))
      .toEqual({ schemaVersion: 1, kind: "collector-checkpoint", status: "complete", ...snapshot.checkpoint });
  });

  test.each(["unsafe-name", "missing-prefix", "symlink", "non-file", "bad-cutoff"])("validates the whole original checkpoint before selection: %s", async damage => {
    const { root, journal, names } = await rotatedSource();
    const checkpoint = await journal.checkpoint();
    if (damage === "unsafe-name") checkpoint.segments[0] = "../outside.ndjson";
    if (damage === "missing-prefix") checkpoint.segments.shift();
    if (damage === "symlink" || damage === "non-file") {
      const source = join(journal.runDirectory, names[0]!);
      const saved = join(root, "preserved-original.ndjson");
      await rename(source, saved);
      if (damage === "symlink") await symlink(saved, source);
      else await mkdir(source);
    }
    if (damage === "bad-cutoff") checkpoint.sequence--;
    vi.spyOn(journal, "checkpoint").mockResolvedValue(checkpoint);
    const outputDirectory = join(root, "invalid");
    await expect(sealJournalSnapshot(journal, outputDirectory, { fromSequence: 7 })).rejects.toThrow("JOURNAL_SNAPSHOT_INVALID");
    await expect(readFile(join(outputDirectory, "checkpoint.json"))).rejects.toThrow();
  });

  test.each(["runId", "sequence", "receivedAt"] as const)("rejects invalid original %s in a searched segment header", async field => {
    const { root, journal, names } = await rotatedSource();
    const checkpoint = await journal.checkpoint();
    const path = join(journal.runDirectory, names[2]!);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    first[field] = field === "sequence" ? 0 : "invalid";
    lines[0] = JSON.stringify(first);
    await writeFile(path, lines.join("\n") + "\n");
    vi.spyOn(journal, "checkpoint").mockResolvedValue(checkpoint);
    const outputDirectory = join(root, "invalid");
    await expect(sealJournalSnapshot(journal, outputDirectory, { fromSequence: 6 })).rejects.toThrow("JOURNAL_SNAPSHOT_INVALID");
    await expect(readFile(join(outputDirectory, "checkpoint.json"))).rejects.toThrow();
  });

  test("binary-searches bounded read-only headers even when first records have large raw payloads", async () => {
    const root = await temporaryRoot(), journal = await openJournal({ rootDir: root, maxSegmentBytes: 1 });
    for (let value = 1; value <= 32; value++) journal.record({ source: "clob", kind: "ws_message", data: `${value}:` + "x".repeat(200_000) });
    const checkpoint = await journal.checkpoint();
    vi.spyOn(journal, "checkpoint").mockResolvedValue(checkpoint);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const reads: Array<{ path: string; bytes: number }> = [];
    const sourceOpenFlags: Array<string | number | undefined> = [];
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await actual.open(...args), path = String(args[0]);
      if (path.startsWith(journal.runDirectory + "/") && path.endsWith(".ndjson")) {
        sourceOpenFlags.push(args[1]);
        const read = file.read.bind(file);
        vi.spyOn(file, "read").mockImplementation((async (...readArgs: unknown[]) => {
          const result = await Reflect.apply(read, file, readArgs);
          reads.push({ path, bytes: result.bytesRead });
          return result;
        }) as FileHandle["read"]);
      }
      return file;
    });
    const snapshot = await sealJournalSnapshot(journal, join(root, "suffix"), { fromSequence: 25 });
    const probeLimit = Math.ceil(Math.log2(checkpoint.segments.length)) + 3;
    expect(reads.length).toBeGreaterThan(1);
    expect(new Set(reads.map(read => read.path)).size).toBeLessThanOrEqual(probeLimit);
    expect(reads.reduce((sum, read) => sum + read.bytes, 0)).toBeLessThanOrEqual(probeLimit * 64 * 1024);
    expect(sourceOpenFlags.every(flag => typeof flag === "number" && (flag & (constants.O_WRONLY | constants.O_RDWR)) === 0 && (flag & constants.O_NOFOLLOW) !== 0)).toBe(true);
    expect(await listJournalSegments(snapshot.runDirectory)).toEqual(checkpoint.segments.slice(24));
    expect((await records(snapshot.runDirectory))[0]).toMatchObject({ sequence: 25, data: "25:" + "x".repeat(200_000) });
  });

  test("replays the original metadata, subscriptions and initial book after the normal initial sequence gap", async () => {
    const root = await temporaryRoot();
    let now = 0;
    const journal = await openJournal({ rootDir: root, runId: "tail-test", maxSegmentBytes: 1,
      now: () => now, monotonicNs: () => BigInt(now) * 1_000_000n });
    journal.record({ source: "collector", kind: "session_start", data: {} });
    now = 50;
    journal.record({ source: "collector", kind: "unrelated", data: "earlier game" });
    const retained: JournalRecord[] = [];
    for (const row of fixtureRecords().slice(1, -1)) {
      now = row.receivedAtMs;
      retained.push(journal.record(row));
    }
    now = 310_100;
    const snapshot = await sealJournalSnapshot(journal, join(root, "suffix"), { fromSequence: retained[0]!.sequence });
    const rows = await records(snapshot.runDirectory);
    expect(rows.slice(0, -1)).toEqual(retained);
    expect(rows.some(row => row.kind === "session_start" || row.kind === "session_end")).toBe(false);
    const result = await replayTail({ runDirectory: snapshot.runDirectory, maxFeedSilenceMs: 600_000, sportsStaleAfterMs: 600_000 }, {
      second: () => {}, change: () => {}, stateChange: () => {}, audit: () => {}
    });
    expect(result.journalQuality.sequenceGaps).toEqual([{ expected: 1, actual: 3 }]);
    expect(result.seconds).toBe(600);
    expect(result.tokens.every(token => token.readyForReplay)).toBe(true);
  });
});
