import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, opendir, readdir, rename, rm, statfs, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join, relative, resolve } from "node:path";
import type { ContinuousStatus } from "./continuous-state.js";

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_LOCK_BYTES = 4096;
const MAX_SAFE_BYTES = BigInt(Number.MAX_SAFE_INTEGER);
const LOCK_KIND = "poly-fifa-continuous-collector";
const LOCAL_HOSTNAME = hostname();

interface LockRecord {
  schemaVersion: 1;
  kind: typeof LOCK_KIND;
  hostname: string;
  pid: number;
  nonce: string;
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function sameFile(left: Stats, right: Stats): boolean {
  return right.isFile() && left.dev === right.dev && left.ino === right.ino;
}

async function unlinkSameFile(path: string, stamp: Stats): Promise<void> {
  try {
    if (sameFile(stamp, await lstat(path))) await unlink(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

async function writeExclusiveFile(path: string, content: string): Promise<Stats> {
  // An unsuccessful exclusive open never grants ownership of the existing path.
  const file = await open(path, "wx", 0o600);
  let stamp: Stats | undefined;
  try {
    stamp = await file.stat();
    await file.writeFile(content, "utf8");
    await file.sync();
    await file.close();
    return stamp;
  } catch (error) {
    await file.close().catch(() => undefined);
    if (stamp) await unlinkSameFile(path, stamp).catch(() => undefined);
    throw error;
  }
}

async function readBoundedFile(path: string, maximum: number, scope: string): Promise<{ text: string; stamp: Stats } | undefined> {
  let file;
  try {
    // Do not follow symlinks or block on a foreign FIFO masquerading as JSON.
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    if (hasCode(error, "ELOOP")) throw new Error(`${scope}_INVALID: symlink`, { cause: error });
    throw error;
  }
  try {
    const stamp = await file.stat();
    if (!stamp.isFile()) throw new Error(`${scope}_INVALID: expected a regular file`);
    if (!Number.isSafeInteger(stamp.size) || stamp.size > maximum) throw new Error(`${scope}_TOO_LARGE`);
    // The extra byte detects growth without an unbounded readFile allocation.
    const buffer = Buffer.alloc(stamp.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error(`${scope}_TOO_LARGE`);
    if (length !== stamp.size) throw new Error(`${scope}_INVALID: file changed during read`);
    return { text: buffer.toString("utf8", 0, length), stamp };
  } finally {
    await file.close();
  }
}

export async function writeCaptureState(dataRoot: string, status: ContinuousStatus): Promise<void> {
  const content = JSON.stringify(status) + "\n";
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("CAPTURE_STATE_TOO_LARGE");
  const directory = resolve(dataRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pending = join(directory, `.state.json.${randomUUID()}.tmp`);
  const stamp = await writeExclusiveFile(pending, content);
  try {
    // Rename is the commit point. Nothing fallible follows a successful rename.
    await rename(pending, join(directory, "state.json"));
  } catch (error) {
    await unlinkSameFile(pending, stamp).catch(() => undefined);
    throw error;
  }
}

export async function readCaptureState(dataRoot: string): Promise<ContinuousStatus | undefined> {
  const saved = await readBoundedFile(join(dataRoot, "state.json"), MAX_STATE_BYTES, "CAPTURE_STATE");
  if (!saved) return undefined;
  // JSON syntax errors deliberately propagate; corrupt state is never removed.
  const state: unknown = JSON.parse(saved.text);
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("CAPTURE_STATE_INVALID");
  const value = state as Partial<ContinuousStatus>;
  if (value.schemaVersion !== 1 || typeof value.instanceId !== "string" || typeof value.dataRoot !== "string"
    || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0
    || !Array.isArray(value.games) || !Array.isArray(value.connections) || !Array.isArray(value.errors)) {
    throw new Error("CAPTURE_STATE_INVALID");
  }
  // Game restoration/validation belongs to ContinuousState, not the file layer.
  return value as ContinuousStatus;
}

async function readLock(path: string): Promise<{ record: LockRecord; stamp: Stats; text: string } | undefined> {
  const saved = await readBoundedFile(path, MAX_LOCK_BYTES, "CAPTURE_LOCK");
  if (!saved) return undefined;
  let value: Partial<LockRecord> | null;
  try { value = JSON.parse(saved.text) as Partial<LockRecord> | null; }
  catch (error) { throw new Error("CAPTURE_LOCK_INVALID: malformed JSON", { cause: error }); }
  if (!value || value.schemaVersion !== 1 || value.kind !== LOCK_KIND || value.hostname !== LOCAL_HOSTNAME
    || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0 || (value.pid ?? 0) > 0x7fff_ffff
    || typeof value.nonce !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.nonce)) {
    throw new Error("CAPTURE_LOCK_INVALID: unrecognized ownership");
  }
  return { ...saved, record: value as LockRecord };
}

function requireAbsentPid(pid: number): void {
  try { process.kill(pid, 0); }
  catch (error) {
    if (hasCode(error, "ESRCH")) return;
    if (!hasCode(error, "EPERM")) throw error;
  }
  throw new Error("CAPTURE_ALREADY_RUNNING");
}

async function releaseLock(path: string, owner: LockRecord, stamp: Stats): Promise<void> {
  let current;
  try { current = await readLock(path); }
  catch (error) {
    // A malformed/foreign replacement is not ours to clean up.
    if (error instanceof Error && /^CAPTURE_LOCK_(INVALID|TOO_LARGE)/.test(error.message)) return;
    throw error;
  }
  if (current && current.record.nonce === owner.nonce && current.record.pid === owner.pid
    && sameFile(stamp, current.stamp)) await unlinkSameFile(path, current.stamp);
}

async function publishLock(directory: string, path: string, owner: LockRecord): Promise<{ release(): Promise<void> }> {
  const pending = join(directory, `.collector.lock.${owner.nonce}.tmp`);
  const stamp = await writeExclusiveFile(pending, JSON.stringify(owner) + "\n");
  try {
    // link is an atomic, no-replace publication of already-complete JSON.
    await link(pending, path);
  } finally {
    await unlinkSameFile(pending, stamp).catch(() => undefined);
  }
  let releasing: Promise<void> | undefined;
  return {
    release() {
      releasing ??= releaseLock(path, owner, stamp).catch(error => { releasing = undefined; throw error; });
      return releasing;
    }
  };
}

async function recoverStaleLock(path: string, owner: LockRecord, stale: NonNullable<Awaited<ReturnType<typeof readLock>>>): Promise<void> {
  const admission = `${path}.recovery`;
  let stamp: Stats;
  try { stamp = await writeExclusiveFile(admission, JSON.stringify(owner) + "\n"); }
  catch (error) {
    if (hasCode(error, "EEXIST")) throw new Error("CAPTURE_ALREADY_RUNNING: stale recovery admission is occupied");
    throw error;
  }
  try {
    // Every stale remover must hold this guard and re-read after admission.
    // A crashed guard is intentionally left for inspection, never stolen.
    const current = await readLock(path);
    if (!current) return;
    if (!sameFile(stale.stamp, current.stamp) || current.text !== stale.text) throw new Error("CAPTURE_ALREADY_RUNNING");
    requireAbsentPid(current.record.pid);
    await unlinkSameFile(path, current.stamp);
  } finally {
    await unlinkSameFile(admission, stamp);
  }
}

export async function acquireCaptureLock(dataRoot: string): Promise<{ release(): Promise<void> }> {
  const directory = resolve(dataRoot), path = join(directory, "collector.lock");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const owner: LockRecord = { schemaVersion: 1, kind: LOCK_KIND, hostname: LOCAL_HOSTNAME, pid: process.pid, nonce: randomUUID() };
  // A competing fresh publication can win between read and link. Re-read once
  // to diagnose its owner; no unbounded polling or recursive stale recovery.
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await readLock(path);
    if (current) {
      requireAbsentPid(current.record.pid);
      await recoverStaleLock(path, owner, current);
    }
    try { return await publishLock(directory, path, owner); }
    catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }
  throw new Error("CAPTURE_ALREADY_RUNNING");
}

function safeByteCount(bytes: bigint): number {
  return Number(bytes < 0n ? 0n : bytes > MAX_SAFE_BYTES ? MAX_SAFE_BYTES : bytes);
}

export async function availableDiskBytes(dataRoot: string): Promise<number> {
  const filesystem = await statfs(dataRoot, { bigint: true });
  if (filesystem.bsize <= 0n) throw new Error("CAPTURE_DISK_INVALID: nonpositive block size");
  return safeByteCount(filesystem.bavail * filesystem.bsize);
}

export async function rawRunBytes(runDirectory: string): Promise<number> {
  let directory;
  try {
    if ((await lstat(runDirectory)).isSymbolicLink()) throw new Error("CAPTURE_RUN_INVALID: symlinked directory");
    directory = await opendir(runDirectory);
  }
  catch (error) {
    if (hasCode(error, "ENOENT")) return 0;
    throw error;
  }
  let bytes = 0n;
  // Stream directory entries and stat one file at a time; never read raw data.
  for await (const entry of directory) {
    const match = /^\d{4}-\d{2}-\d{2}-\d{6,}\.ndjson(?:\.gz)?$/.exec(entry.name);
    if (!entry.isFile() || match?.[0] !== entry.name) continue;
    try {
      const stamp = await lstat(join(runDirectory, entry.name), { bigint: true });
      if (stamp.isFile()) bytes += stamp.size;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  return safeByteCount(bytes);
}


export async function pruneRawRunDirectories(dataRoot: string, activeRunId: string | null, retentionMs: number, nowMs = Date.now()): Promise<number> {
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new RangeError("retentionMs must be a nonnegative safe integer");
  const runsRoot = resolve(dataRoot, "runs");
  let rootStamp: Stats;
  try { rootStamp = await lstat(runsRoot); }
  catch (error) { if (hasCode(error, "ENOENT")) return 0; throw error; }
  if (!rootStamp.isDirectory() || rootStamp.isSymbolicLink()) throw new Error("CAPTURE_RUNS_INVALID: symlinked directory");
  const cutoff = nowMs - retentionMs;
  let removed = 0;
  for (const entry of await readdir(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === activeRunId) continue;
    const target = resolve(runsRoot, entry.name);
    const suffix = relative(runsRoot, target);
    if (!suffix || suffix.startsWith("..") || resolve(runsRoot, suffix) !== target) throw new Error("CAPTURE_RUN_INVALID: path escaped runs root");
    let stamp: Stats;
    try { stamp = await lstat(target); }
    catch (error) { if (hasCode(error, "ENOENT")) continue; throw error; }
    if (!stamp.isDirectory() || stamp.isSymbolicLink() || stamp.mtimeMs >= cutoff) continue;
    await rm(target, { recursive: true, force: false });
    removed++;
  }
  return removed;
}
