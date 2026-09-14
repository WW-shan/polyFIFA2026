import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, unlinkSync, type Stats } from "node:fs";
import { link, lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import type { CompressionResult, JournalCompressionOptions } from "./journal-compression.js";

export interface CompressionAlias { path: string; root: string; rootStamp: Stats; stamp: Stats }
interface Integrity {
  schemaVersion: 1;
  kind: "collector-gzip-integrity";
  uncompressedBytes: number;
  uncompressedSha256: string;
  compressedBytes: number;
  compressedSha256: string;
}
function code(error: unknown, value: string): boolean { return (error as NodeJS.ErrnoException)?.code === value; }
function same(left: Stats, right: Stats): boolean {
  return right.isFile() && left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
function sameVersion(left: Stats, right: Stats): boolean { return same(left, right) && left.ctimeMs === right.ctimeMs; }
function assertParentForCommit(alias: CompressionAlias): void {
  const root = lstatSync(alias.root), suffix = relative(alias.root, dirname(alias.path));
  if (!root.isDirectory() || root.dev !== alias.rootStamp.dev || root.ino !== alias.rootStamp.ino
    || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(".." + sep)) throw new Error("COMPRESSION_PATH_INVALID: storage root changed before commit");
  let current = alias.root;
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (!lstatSync(current).isDirectory()) throw new Error("COMPRESSION_PATH_INVALID: parent changed before commit");
  }
}
export async function assertCompressionParent(alias: CompressionAlias): Promise<void> {
  const root = await lstat(alias.root), suffix = relative(alias.root, dirname(alias.path));
  if (!root.isDirectory() || root.dev !== alias.rootStamp.dev || root.ino !== alias.rootStamp.ino
    || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(".." + sep)) throw new Error("COMPRESSION_PATH_INVALID: storage root changed");
  let current = alias.root;
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (!(await lstat(current)).isDirectory()) throw new Error("COMPRESSION_PATH_INVALID: symlinked/non-directory parent");
  }
}
async function assertSource(alias: CompressionAlias, expectedLinks: number): Promise<void> {
  await assertCompressionParent(alias);
  const current = await lstat(alias.path);
  if (!same(alias.stamp, current) || current.nlink !== expectedLinks) throw new Error("COMPRESSION_SOURCE_CHANGED: bytes, identity or hardlinks changed");
}
async function openRegular(path: string): Promise<FileHandle> {
  const stamp = await lstat(path);
  if (!stamp.isFile()) throw new Error("COMPRESSION_PATH_INVALID: symlink/non-file target");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(stamp, await file.stat())) throw new Error("COMPRESSION_SOURCE_CHANGED: opened file differs");
    return file;
  } catch (error) { await file.close(); throw error; }
}
async function syncDirectories(aliases: readonly CompressionAlias[]): Promise<void> {
  for (const alias of aliases) await assertCompressionParent(alias);
  for (const path of new Set(aliases.map(alias => dirname(alias.path)))) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isDirectory()) throw new Error("COMPRESSION_PATH_INVALID: directory changed");
      await file.sync();
    } finally { await file.close(); }
  }
}
async function removeTemporary(path: string, original: Stats | undefined): Promise<void> {
  if (!original) return;
  try {
    const current = await lstat(path);
    if (current.isFile() && current.dev === original.dev && current.ino === original.ino) await unlink(path);
  } catch (error) { if (!code(error, "ENOENT")) throw error; }
}

async function verifyGzip(path: string, expected: { bytes: number; sha256: string }, signal?: AbortSignal): Promise<Integrity> {
  const file = await openRegular(path);
  let input: ReturnType<FileHandle["createReadStream"]> | undefined;
  try {
    const stamp = await file.stat();
    input = file.createReadStream({ autoClose: false });
    const compressedHash = createHash("sha256"), originalHash = createHash("sha256");
    let compressedBytes = 0, originalBytes = 0;
    await pipeline(input, new Transform({ transform(chunk: Buffer, _encoding, callback) {
      compressedBytes += chunk.length; compressedHash.update(chunk); callback(null, chunk);
    } }), createGunzip({ chunkSize: 64 * 1024 }), new Writable({ write(chunk: Buffer, _encoding, callback) {
      originalBytes += chunk.length;
      if (originalBytes > expected.bytes) { callback(new Error("COMPRESSION_GZIP_CONFLICT: inflated size exceeds original")); return; }
      originalHash.update(chunk); callback();
    } }), { signal });
    if (originalBytes !== expected.bytes || originalHash.digest("hex") !== expected.sha256 || !same(stamp, await file.stat())) {
      throw new Error("COMPRESSION_GZIP_CONFLICT: decompressed bytes differ from original");
    }
    await file.sync();
    return { schemaVersion: 1, kind: "collector-gzip-integrity", uncompressedBytes: originalBytes,
      uncompressedSha256: expected.sha256, compressedBytes, compressedSha256: compressedHash.digest("hex") };
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error("COMPRESSION_GZIP_CONFLICT: compressed file failed full verification", { cause: error });
  } finally { input?.destroy(); await file.close(); }
}

async function validateIntegrity(path: string, expected: Integrity): Promise<void> {
  const file = await openRegular(path);
  try {
    const stamp = await file.stat();
    if (stamp.size > 4096) throw new Error("COMPRESSION_INTEGRITY_CONFLICT: oversized sidecar");
    let value: Record<string, unknown>;
    try { value = JSON.parse(await file.readFile("utf8")) as Record<string, unknown>; }
    catch (error) { throw new Error("COMPRESSION_INTEGRITY_CONFLICT: unreadable sidecar", { cause: error }); }
    if (!value || Object.entries(expected).some(([key, field]) => value[key] !== field) || !same(stamp, await file.stat())) {
      throw new Error("COMPRESSION_INTEGRITY_CONFLICT: sidecar does not prove these bytes");
    }
    await file.sync();
  } finally { await file.close(); }
}

async function verifyOriginal(alias: CompressionAlias, expected: { bytes: number; sha256: string }, signal?: AbortSignal): Promise<void> {
  const file = await openRegular(alias.path), input = file.createReadStream({ autoClose: false });
  const hash = createHash("sha256"); let bytes = 0;
  try {
    for await (const chunk of input) {
      signal?.throwIfAborted(); bytes += chunk.length;
      if (bytes > expected.bytes) throw new Error("COMPRESSION_SOURCE_CHANGED: original grew after verification");
      hash.update(chunk);
    }
    if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256 || !same(alias.stamp, await file.stat())) {
      throw new Error("COMPRESSION_SOURCE_CHANGED: original content changed before replacement");
    }
  } finally { input.destroy(); await file.close(); }
}

/** Called only with a complete, policy-checked set of aliases for a sealed inode. */
export async function compressJournalAliases(aliases: readonly CompressionAlias[], options: JournalCompressionOptions): Promise<CompressionResult | null> {
  const first = aliases[0]!;
  for (const alias of aliases) await assertSource(alias, aliases.length);
  options.signal?.throwIfAborted();
  const temporary = first.path + ".gz.pending-" + randomUUID();
  const metadataTemporary = temporary + ".integrity.json";
  let temporaryStamp: Stats | undefined, metadataStamp: Stats | undefined;
  try {
    const source = await openRegular(first.path);
    let output: FileHandle;
    try { output = await open(temporary, "wx", 0o600); }
    catch (error) { await source.close(); throw error; }
    const input = source.createReadStream({ autoClose: false });
    const writer = output.createWriteStream({ autoClose: false });
    const originalHash = createHash("sha256"); let originalBytes = 0;
    try {
      temporaryStamp = await output.stat();
      if (!same(first.stamp, await source.stat())) throw new Error("COMPRESSION_SOURCE_CHANGED: original changed before compression");
      await pipeline(input, new Transform({ transform(chunk: Buffer, _encoding, callback) {
        originalBytes += chunk.length; originalHash.update(chunk); callback(null, chunk);
      } }), createGzip({ level: 6 }), writer, { signal: options.signal });
      await output.sync();
      if (!same(first.stamp, await source.stat()) || originalBytes !== first.stamp.size) throw new Error("COMPRESSION_SOURCE_CHANGED: original changed during compression");
    } finally { input.destroy(); writer.destroy(); await Promise.all([source.close(), output.close()]); }
    const expected = { bytes: originalBytes, sha256: originalHash.digest("hex") };
    let integrity = await verifyGzip(temporary, expected, options.signal), compressedSource = temporary;
    // A previously published encoding is reused only after full verification.
    const existing: Array<{ path: string; integrity: Integrity }> = [];
    for (const alias of aliases) {
      await assertCompressionParent(alias);
      const path = alias.path + ".gz";
      try { await lstat(path); }
      catch (error) { if (code(error, "ENOENT")) continue; throw error; }
      existing.push({ path, integrity: await verifyGzip(path, expected, options.signal) });
    }
    if (existing.length) {
      compressedSource = existing[0]!.path; integrity = existing[0]!.integrity;
      if (existing.some(value => value.integrity.compressedSha256 !== integrity.compressedSha256)) {
        throw new Error("COMPRESSION_GZIP_CONFLICT: aliases have different compressed encodings");
      }
    }
    if (integrity.compressedBytes >= originalBytes) return null;
    const verifiedCompressedStamp = await lstat(compressedSource);
    const result: CompressionResult = { originalBytes, compressedBytes: integrity.compressedBytes, sha256: expected.sha256,
      aliases: aliases.map(alias => alias.path) };
    await options.onProgress?.({ phase: "verified", ...result });
    options.signal?.throwIfAborted();
    for (const alias of aliases) await assertSource(alias, aliases.length);

    const metadata = await open(metadataTemporary, "wx", 0o600);
    try {
      metadataStamp = await metadata.stat();
      await metadata.writeFile(JSON.stringify(integrity) + "\n"); await metadata.sync();
    } finally { await metadata.close(); }
    for (const alias of aliases) {
      options.signal?.throwIfAborted(); await assertCompressionParent(alias);
      const target = alias.path + ".gz";
      try { await link(compressedSource, target); }
      catch (error) {
        if (!code(error, "EEXIST")) throw error;
        const checked = await verifyGzip(target, expected, options.signal);
        if (checked.compressedSha256 !== integrity.compressedSha256) throw new Error("COMPRESSION_GZIP_CONFLICT: target changed during publication");
      }
      try { await link(metadataTemporary, target + ".integrity.json"); }
      catch (error) { if (!code(error, "EEXIST")) throw error; await validateIntegrity(target + ".integrity.json", integrity); }
    }
    await syncDirectories(aliases);
    const publishedVersions: Array<{ alias: CompressionAlias; gzip: Stats; integrity: Stats }> = [];
    for (const alias of aliases) publishedVersions.push({ alias, gzip: await lstat(alias.path + ".gz"),
      integrity: await lstat(alias.path + ".gz.integrity.json") });
    await options.onProgress?.({ phase: "published", ...result });
    options.signal?.throwIfAborted();
    // Every destination must still be the verified regular file before unlinking.
    const compressedStamp = await lstat(compressedSource);
    if (!same(verifiedCompressedStamp, compressedStamp)) throw new Error("COMPRESSION_COMPRESSED_CHANGED: verified gzip changed before replacement");
    // Content checks are required even if a same-size edit restored mtime.
    await verifyOriginal(first, expected, options.signal);
    const finalEncoding = await verifyGzip(compressedSource, expected, options.signal);
    if (finalEncoding.compressedSha256 !== integrity.compressedSha256) throw new Error("COMPRESSION_GZIP_CONFLICT: verified encoding changed before replacement");
    for (const alias of aliases) {
      await assertSource(alias, aliases.length);
      const target = alias.path + ".gz", stamp = await lstat(target);
      if (!stamp.isFile()) throw new Error("COMPRESSION_PATH_INVALID: published gzip is not regular");
      if (!same(compressedStamp, stamp)) {
        const checked = await verifyGzip(target, expected, options.signal);
        if (checked.compressedSha256 !== integrity.compressedSha256) throw new Error("COMPRESSION_GZIP_CONFLICT: published target changed");
      }
      await validateIntegrity(target + ".integrity.json", integrity);
    }
    options.signal?.throwIfAborted();
    // All expensive I/O is finished. Validate ctime as well as content identity
    // and perform the short alias commit without an awaited/user callback gap.
    // Our own unlinks change the source inode's ctime, so validate the entire
    // group before removing its checked directory entries.
    for (const version of publishedVersions) {
      assertParentForCommit(version.alias);
      const current = lstatSync(version.alias.path);
      if (!sameVersion(version.alias.stamp, current) || current.nlink !== aliases.length) {
        throw new Error("COMPRESSION_SOURCE_CHANGED: original version changed before commit");
      }
      if (!sameVersion(version.gzip, lstatSync(version.alias.path + ".gz"))
        || !sameVersion(version.integrity, lstatSync(version.alias.path + ".gz.integrity.json"))) {
        throw new Error("COMPRESSION_COMPRESSED_CHANGED: published version changed before commit");
      }
    }
    for (const alias of aliases) unlinkSync(alias.path);
    await syncDirectories(aliases);
    await options.onProgress?.({ phase: "complete", ...result });
    return result;
  } finally {
    await removeTemporary(metadataTemporary, metadataStamp);
    await removeTemporary(temporary, temporaryStamp);
  }
}
