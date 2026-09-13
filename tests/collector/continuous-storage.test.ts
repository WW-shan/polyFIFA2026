import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, statfs, symlink, unlink, writeFile,
  type FileHandle
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ContinuousStatus } from "../../src/collector/continuous-state.js";
import {
  acquireCaptureLock, availableDiskBytes, rawRunBytes, readCaptureState, writeCaptureState
} from "../../src/collector/continuous-storage.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename), statfs: vi.fn(actual.statfs) };
});

const temporaryDirectories: string[] = [];
const MAX_STATE_BYTES = 16 * 1024 * 1024;

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockReset().mockImplementation(actual.open);
  vi.mocked(rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(statfs).mockReset().mockImplementation(actual.statfs);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "poly-fifa-continuous-storage-"));
  temporaryDirectories.push(directory);
  return directory;
}

function status(dataRoot: string, overrides: Partial<ContinuousStatus> = {}): ContinuousStatus {
  return {
    schemaVersion: 1, instanceId: "capture-instance", pid: process.pid, startedAtMs: 100, updatedAtMs: 200,
    dataRoot, port: 8765, mode: "collecting", runId: "run-1", runDirectory: join(dataRoot, "runs", "run-1"),
    receivedRecords: 3, lastRecordAtMs: 190, freeBytes: 1024, rawBytes: 256, queuedBytes: 0, desiredTokens: 2,
    games: [], connections: [{ id: "c1", source: "clob", open: true, lastMessageAtMs: 190 }], errors: [],
    ...overrides
  };
}

async function interceptNextFile(intercept: (file: FileHandle) => void): Promise<void> {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const file = await actual.open(...args);
    intercept(file);
    return file;
  });
}

async function ownLockRecord(root: string): Promise<Record<string, unknown>> {
  const lock = await acquireCaptureLock(root);
  const record = JSON.parse(await readFile(join(root, "collector.lock"), "utf8")) as Record<string, unknown>;
  await lock.release();
  return record;
}

async function absentPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  const pid = child.pid!;
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  return pid;
}

describe("continuous capture state storage", () => {
  test("returns undefined for missing state without creating its directory", async () => {
    const root = join(await temporaryRoot(), "not-created");
    expect(await readCaptureState(root)).toBeUndefined();
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("round trips and replaces state using private files and directories", async () => {
    const parent = await temporaryRoot(), root = join(parent, "nested", "capture");
    const initial = status(root), updated = status(root, { updatedAtMs: 300, receivedRecords: 9 });
    await writeCaptureState(root, initial);
    expect(await readCaptureState(root)).toEqual(initial);
    const previous = await lstat(join(root, "state.json"));
    await writeCaptureState(root, updated);
    expect(await readCaptureState(root)).toEqual(updated);
    const current = await lstat(join(root, "state.json"));
    expect(current.ino).not.toBe(previous.ino);
    expect(current.mode & 0o777).toBe(0o600);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(parent, "nested"))).mode & 0o777).toBe(0o700);
    expect(await readdir(root)).toEqual(["state.json"]);
  });

  test("keeps the old snapshot readable until the temporary file is synced", async () => {
    const root = await temporaryRoot(), initial = status(root), updated = status(root, { receivedRecords: 100 });
    await writeCaptureState(root, initial);
    let enterSync!: () => void, finishSync!: () => void;
    const entered = new Promise<void>(resolve => { enterSync = resolve; });
    const finish = new Promise<void>(resolve => { finishSync = resolve; });
    await interceptNextFile(file => {
      const sync = file.sync.bind(file);
      vi.spyOn(file, "sync").mockImplementationOnce(async () => {
        enterSync();
        await finish;
        await sync();
      });
    });
    const pending = writeCaptureState(root, updated);
    try {
      await entered;
      expect(await readCaptureState(root)).toEqual(initial);
      const temporary = (await readdir(root)).filter(name => name !== "state.json");
      expect(temporary).toHaveLength(1);
      expect((await lstat(join(root, temporary[0]!))).mode & 0o777).toBe(0o600);
    } finally {
      finishSync();
      await pending;
    }
    expect(await readCaptureState(root)).toEqual(updated);
    expect(await readdir(root)).toEqual(["state.json"]);
  });

  test.each(["writeFile", "sync", "close", "rename"] as const)("preserves the previous state and cleans its temporary file on %s failure", async operation => {
    const root = await temporaryRoot(), initial = status(root);
    await writeCaptureState(root, initial);
    const original = await readFile(join(root, "state.json"), "utf8"), stamp = await lstat(join(root, "state.json"));
    const failure = new Error(`injected ${operation} failure`);
    if (operation === "rename") vi.mocked(rename).mockRejectedValueOnce(failure);
    else await interceptNextFile(file => {
      if (operation === "close") {
        const close = file.close.bind(file);
        vi.spyOn(file, "close").mockImplementationOnce(async () => { await close(); throw failure; });
      } else if (operation === "writeFile") {
        const write = file.writeFile.bind(file);
        vi.spyOn(file, "writeFile").mockImplementationOnce(async () => { await write('{"partial":'); throw failure; });
      } else vi.spyOn(file, operation).mockRejectedValueOnce(failure);
    });
    await expect(writeCaptureState(root, status(root, { receivedRecords: 99 }))).rejects.toBe(failure);
    expect(await readFile(join(root, "state.json"), "utf8")).toBe(original);
    expect((await lstat(join(root, "state.json"))).ino).toBe(stamp.ino);
    expect(await readdir(root)).toEqual(["state.json"]);
  });

  test("preserves the previous state when serialization fails", async () => {
    const root = await temporaryRoot(), initial = status(root);
    await writeCaptureState(root, initial);
    const cyclic = status(root) as ContinuousStatus & { cycle?: unknown };
    cyclic.cycle = cyclic;
    await expect(writeCaptureState(root, cyclic)).rejects.toThrow();
    expect(await readCaptureState(root)).toEqual(initial);
    expect(await readdir(root)).toEqual(["state.json"]);
  });

  test("throws on malformed JSON and leaves the original bytes intact", async () => {
    const root = await temporaryRoot(), broken = '{"schemaVersion":1,"games":[';
    await writeFile(join(root, "state.json"), broken, { mode: 0o600 });
    await expect(readCaptureState(root)).rejects.toThrow(SyntaxError);
    expect(await readFile(join(root, "state.json"), "utf8")).toBe(broken);
  });

  test.each(["null", "[]", '{"schemaVersion":2}', '{"unrelated":true}'])("rejects invalid state shape without modifying it: %s", async content => {
    const root = await temporaryRoot();
    await writeFile(join(root, "state.json"), content, { mode: 0o600 });
    await expect(readCaptureState(root)).rejects.toThrow("CAPTURE_STATE_INVALID");
    expect(await readFile(join(root, "state.json"), "utf8")).toBe(content);
  });

  test("rejects state larger than 16 MiB before reading or parsing its payload", async () => {
    const root = await temporaryRoot(), path = join(root, "state.json");
    const file = await open(path, "wx", 0o600);
    try { await file.truncate(MAX_STATE_BYTES + 1); } finally { await file.close(); }
    const reads = vi.fn();
    await interceptNextFile(handle => {
      vi.spyOn(handle, "read").mockImplementation(reads);
      vi.spyOn(handle, "readFile").mockImplementation(reads);
    });
    await expect(readCaptureState(root)).rejects.toThrow("CAPTURE_STATE_TOO_LARGE");
    expect(reads).not.toHaveBeenCalled();
    expect((await lstat(path)).size).toBe(MAX_STATE_BYTES + 1);
  });

  test("does not publish state that exceeds its own read limit", async () => {
    const root = await temporaryRoot(), initial = status(root);
    await writeCaptureState(root, initial);
    const huge = status(root, { errors: [{ atMs: 1, scope: "capture", message: "x".repeat(MAX_STATE_BYTES) }] });
    await expect(writeCaptureState(root, huge)).rejects.toThrow("CAPTURE_STATE_TOO_LARGE");
    expect(await readCaptureState(root)).toEqual(initial);
    expect(await readdir(root)).toEqual(["state.json"]);
  });

  test("propagates a non-missing filesystem error", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "state.json"));
    await expect(readCaptureState(root)).rejects.toThrow("CAPTURE_STATE_INVALID");
    expect((await lstat(join(root, "state.json"))).isDirectory()).toBe(true);
  });
});

describe("continuous capture process lock", () => {
  test("creates a private lock, probes an active PID with signal zero, and permits reacquisition after release", async () => {
    const root = join(await temporaryRoot(), "capture"), path = join(root, "collector.lock");
    const lock = await acquireCaptureLock(root), original = await readFile(path, "utf8");
    expect(JSON.parse(original)).toMatchObject({ pid: process.pid, nonce: expect.any(String) });
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const kill = vi.spyOn(process, "kill");
    await expect(acquireCaptureLock(root)).rejects.toThrow("CAPTURE_ALREADY_RUNNING");
    expect(kill).toHaveBeenCalledWith(process.pid, 0);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(await readFile(path, "utf8")).toBe(original);
    await lock.release();
    expect(await readdir(root)).toEqual([]);
    const next = await acquireCaptureLock(root);
    expect(await readFile(path, "utf8")).not.toBe(original);
    await next.release();
  });

  test("admits exactly one concurrent acquirer", async () => {
    const root = await temporaryRoot();
    const attempts = await Promise.allSettled(Array.from({ length: 16 }, () => acquireCaptureLock(root)));
    const winners = attempts.filter(attempt => attempt.status === "fulfilled");
    try {
      expect(winners).toHaveLength(1);
      for (const attempt of attempts) if (attempt.status === "rejected") expect(String(attempt.reason)).toContain("CAPTURE_ALREADY_RUNNING");
      expect(await readdir(root)).toEqual(["collector.lock"]);
    } finally {
      await Promise.all(winners.map(winner => winner.value.release()));
    }
    expect(await readdir(root)).toEqual([]);
  });

  test("coalesces concurrent release calls and does not remove a subsequent lock", async () => {
    const root = await temporaryRoot(), first = await acquireCaptureLock(root);
    await Promise.all([first.release(), first.release(), first.release()]);
    const second = await acquireCaptureLock(root), saved = await readFile(join(root, "collector.lock"), "utf8");
    await first.release();
    expect(await readFile(join(root, "collector.lock"), "utf8")).toBe(saved);
    await second.release();
  });

  test("release leaves a replacement lock with the same PID and a different nonce intact", async () => {
    const root = await temporaryRoot(), path = join(root, "collector.lock"), first = await acquireCaptureLock(root);
    await unlink(path);
    const replacement = await acquireCaptureLock(root), saved = await readFile(path, "utf8");
    await first.release();
    expect(await readFile(path, "utf8")).toBe(saved);
    await replacement.release();
  });

  test("release verifies the nonce even when the file inode has not changed", async () => {
    const root = await temporaryRoot(), path = join(root, "collector.lock"), lock = await acquireCaptureLock(root);
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const replacement = JSON.stringify({ ...record, nonce: randomUUID() });
    await writeFile(path, replacement);
    await lock.release();
    expect(await readFile(path, "utf8")).toBe(replacement);
  });

  test("release verifies file identity even when a replacement copies the nonce", async () => {
    const root = await temporaryRoot(), path = join(root, "collector.lock"), lock = await acquireCaptureLock(root);
    const original = await readFile(path, "utf8");
    await rename(path, join(root, "old-lock"));
    await writeFile(path, original, { mode: 0o600 });
    await lock.release();
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test.each(["{", "", "null", "[]", '{"pid":123,"nonce":"foreign"}', '{"kind":"other-app","pid":123}'])("refuses malformed or foreign lock bytes without deleting them: %j", async content => {
    const root = await temporaryRoot(), path = join(root, "collector.lock");
    await writeFile(path, content, { mode: 0o600 });
    const kill = vi.spyOn(process, "kill");
    await expect(acquireCaptureLock(root)).rejects.toThrow("CAPTURE_LOCK_INVALID");
    expect(await readFile(path, "utf8")).toBe(content);
    expect(kill).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["collector.lock"]);
  });

  test.each([0, -1, 1.5, "123", 2 ** 32])("does not probe or recover an invalid PID: %j", async pid => {
    const root = await temporaryRoot(), path = join(root, "collector.lock"), record = await ownLockRecord(root);
    const content = JSON.stringify({ ...record, pid });
    await writeFile(path, content, { mode: 0o600 });
    const kill = vi.spyOn(process, "kill");
    await expect(acquireCaptureLock(root)).rejects.toThrow("CAPTURE_LOCK_INVALID");
    expect(kill).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe(content);
  });

  test("does not treat a lock from another host as a local stale lock", async () => {
    const root = await temporaryRoot(), path = join(root, "collector.lock"), record = await ownLockRecord(root);
    const content = JSON.stringify({ ...record, hostname: "another-capture-host", pid: await absentPid() });
    await writeFile(path, content, { mode: 0o600 });
    const kill = vi.spyOn(process, "kill");
    await expect(acquireCaptureLock(root)).rejects.toThrow("CAPTURE_LOCK_INVALID");
    expect(kill).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe(content);
  });

  test("recovers an owned stale lock only after a real absent-PID probe", async () => {
    const root = await temporaryRoot(), path = join(root, "collector.lock"), record = await ownLockRecord(root);
    const pid = await absentPid();
    await writeFile(path, JSON.stringify({ ...record, pid }), { mode: 0o600 });
    const kill = vi.spyOn(process, "kill"), recovered = await acquireCaptureLock(root);
    expect(kill).toHaveBeenCalledWith(pid, 0);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: process.pid });
    expect(JSON.parse(await readFile(path, "utf8")).nonce).not.toBe(record.nonce);
    await recovered.release();
    expect(await readdir(root)).toEqual([]);
  });

  test("serializes concurrent stale recovery so later contenders cannot unlink the winner", async () => {
    const root = await temporaryRoot(), path = join(root, "collector.lock"), record = await ownLockRecord(root);
    await writeFile(path, JSON.stringify({ ...record, pid: await absentPid() }), { mode: 0o600 });
    const attempts = await Promise.allSettled(Array.from({ length: 24 }, () => acquireCaptureLock(root)));
    const winners = attempts.filter(attempt => attempt.status === "fulfilled");
    try {
      expect(winners).toHaveLength(1);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: process.pid });
      await expect(acquireCaptureLock(root)).rejects.toThrow("CAPTURE_ALREADY_RUNNING");
      expect(await readdir(root)).toEqual(["collector.lock"]);
    } finally {
      await Promise.all(winners.map(winner => winner.value.release()));
    }
    expect(await readdir(root)).toEqual([]);
  });

  test("admits one stale-lock recovery across separate Node processes", async () => {
    const root = await temporaryRoot(), path = join(root, "collector.lock"), record = await ownLockRecord(root);
    await writeFile(path, JSON.stringify({ ...record, pid: await absentPid() }), { mode: 0o600 });
    const moduleUrl = new URL("../../src/collector/continuous-storage.ts", import.meta.url).href;
    const source = `
      import { once } from "node:events";
      import { acquireCaptureLock } from ${JSON.stringify(moduleUrl)};
      try {
        const lock = await acquireCaptureLock(process.argv[1]);
        process.stdout.write("acquired\\n");
        const finished = once(process.stdin, "end");
        process.stdin.resume();
        await finished;
        await lock.release();
      } catch (error) {
        process.stdout.write(String(error).includes("CAPTURE_ALREADY_RUNNING") ? "busy\\n" : "error: " + String(error) + "\\n");
      }
    `;
    const children = Array.from({ length: 6 }, () => spawn(process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", source, root], { stdio: ["pipe", "pipe", "pipe"] }));
    const exits = Promise.all(children.map(child => once(child, "exit")));
    try {
      const messages = await Promise.all(children.map(async child => {
        child.stderr.resume();
        let text = "";
        for await (const chunk of child.stdout) {
          text += String(chunk);
          if (text.includes("\n")) return text.trim();
        }
        return text;
      }));
      expect(messages.filter(message => message === "acquired")).toHaveLength(1);
      expect(messages.filter(message => message === "busy")).toHaveLength(5);
      expect(await readdir(root)).toEqual(["collector.lock"]);
    } finally {
      for (const child of children) child.stdin.end();
      for (const [code] of await exits) expect(code).toBe(0);
    }
    expect(await readdir(root)).toEqual([]);
  });

  test("preserves an occupied recovery guard and its stale lock for inspection", async () => {
    const root = await temporaryRoot(), path = join(root, "collector.lock"), record = await ownLockRecord(root);
    const stale = JSON.stringify({ ...record, pid: await absentPid() });
    await writeFile(path, stale, { mode: 0o600 });
    await writeFile(`${path}.recovery`, "foreign or interrupted recovery", { mode: 0o600 });
    await expect(acquireCaptureLock(root)).rejects.toThrow("CAPTURE_ALREADY_RUNNING");
    expect(await readFile(path, "utf8")).toBe(stale);
    expect(await readFile(`${path}.recovery`, "utf8")).toBe("foreign or interrupted recovery");
  });

  test("bounds lock reads before parsing oversized foreign contents", async () => {
    const root = await temporaryRoot(), path = join(root, "collector.lock");
    const file = await open(path, "wx", 0o600);
    try { await file.truncate(4097); } finally { await file.close(); }
    const reads = vi.fn(), kill = vi.spyOn(process, "kill");
    await interceptNextFile(handle => {
      vi.spyOn(handle, "read").mockImplementation(reads);
      vi.spyOn(handle, "readFile").mockImplementation(reads);
    });
    await expect(acquireCaptureLock(root)).rejects.toThrow("CAPTURE_LOCK_TOO_LARGE");
    expect(reads).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect((await lstat(path)).size).toBe(4097);
  });

  test("release leaves malformed replacement bytes untouched", async () => {
    const root = await temporaryRoot(), path = join(root, "collector.lock"), lock = await acquireCaptureLock(root);
    await writeFile(path, "foreign replacement");
    await lock.release();
    expect(await readFile(path, "utf8")).toBe("foreign replacement");
  });

  test("treats EPERM as possibly active and preserves the lock", async () => {
    const root = await temporaryRoot(), path = join(root, "collector.lock"), record = await ownLockRecord(root);
    const content = JSON.stringify(record);
    await writeFile(path, content, { mode: 0o600 });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    await expect(acquireCaptureLock(root)).rejects.toThrow("CAPTURE_ALREADY_RUNNING");
    expect(kill).toHaveBeenCalledWith(process.pid, 0);
    expect(await readFile(path, "utf8")).toBe(content);
  });

  test("does not follow or remove a symlinked lock", async () => {
    const root = await temporaryRoot(), path = join(root, "collector.lock"), target = join(root, "foreign");
    await writeFile(target, "foreign bytes");
    await symlink(target, path);
    await expect(acquireCaptureLock(root)).rejects.toThrow("CAPTURE_LOCK_INVALID");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("foreign bytes");
  });
});

describe("continuous capture byte accounting", () => {
  test("uses available blocks, not total free blocks, from the real target filesystem", async () => {
    const root = await temporaryRoot();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const filesystem = await actual.statfs(root, { bigint: true });
    vi.mocked(statfs).mockResolvedValueOnce(filesystem);
    expect(await availableDiskBytes(root)).toBe(Number(filesystem.bavail * filesystem.bsize));
    expect(statfs).toHaveBeenCalledWith(root, { bigint: true });
  });

  test("saturates oversized disk counts and clamps negative availability to zero", async () => {
    const root = await temporaryRoot();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const filesystem = await actual.statfs(root, { bigint: true });
    vi.mocked(statfs).mockResolvedValueOnce({ ...filesystem, bavail: BigInt(Number.MAX_SAFE_INTEGER), bsize: 4096n });
    expect(await availableDiskBytes(root)).toBe(Number.MAX_SAFE_INTEGER);
    vi.mocked(statfs).mockResolvedValueOnce({ ...filesystem, bavail: -1n, bsize: 4096n });
    expect(await availableDiskBytes(root)).toBe(0);
  });

  test.each([0n, -4096n])("rejects an invalid filesystem block size: %s", async bsize => {
    const root = await temporaryRoot();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const filesystem = await actual.statfs(root, { bigint: true });
    vi.mocked(statfs).mockResolvedValueOnce({ ...filesystem, bavail: -1n, bsize });
    await expect(availableDiskBytes(root)).rejects.toThrow("CAPTURE_DISK_INVALID");
  });

  test("propagates disk-stat errors without inventing available space", async () => {
    const root = await temporaryRoot(), failure = Object.assign(new Error("I/O failure"), { code: "EIO" });
    vi.mocked(statfs).mockRejectedValueOnce(failure);
    await expect(availableDiskBytes(root)).rejects.toBe(failure);
  });

  test("counts only direct regular files matching the writer's complete segment filename", async () => {
    const root = await temporaryRoot();
    const files: Record<string, string> = {
      "2026-09-13-000000.ndjson": "abc",
      "2026-09-14-1000000.ndjson": "déf",
      "2026-09-13-000001.ndjson.partial": "ignored",
      "2026-09-13-000002.ndjson\n": "ignored",
      "2026-09-13-1.ndjson": "ignored",
      "journal.ndjson": "ignored",
      "state.json": "ignored",
      "checkpoint.json": "ignored"
    };
    await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(root, name), content)));
    await mkdir(join(root, "rawdata"));
    await writeFile(join(root, "rawdata", "2026-09-13-000003.ndjson"), "ignored");
    await mkdir(join(root, "2026-09-13-000004.ndjson"));
    await writeFile(join(root, "2026-09-13-000004.ndjson", "2026-09-13-000005.ndjson"), "ignored");
    await symlink(join(root, "2026-09-13-000000.ndjson"), join(root, "2026-09-13-000006.ndjson"));
    await symlink(join(root, "rawdata"), join(root, "2026-09-13-000007.ndjson"));
    expect(await rawRunBytes(root)).toBe(Buffer.byteLength("abc") + Buffer.byteLength("déf"));
  });

  test("returns zero for a run directory that has not been created", async () => {
    const root = join(await temporaryRoot(), "runs", "not-started");
    expect(await rawRunBytes(root)).toBe(0);
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not follow a symlink supplied as the run directory", async () => {
    const root = await temporaryRoot(), outside = await temporaryRoot(), path = join(root, "linked-run");
    await writeFile(join(outside, "2026-09-13-000000.ndjson"), "outside bytes");
    await symlink(outside, path);
    await expect(rawRunBytes(path)).rejects.toThrow("CAPTURE_RUN_INVALID");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  test("does not hide non-missing run-directory errors", async () => {
    const path = join(await temporaryRoot(), "not-a-directory");
    await writeFile(path, "content");
    await expect(rawRunBytes(path)).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
