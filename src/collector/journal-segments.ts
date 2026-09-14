import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

export const JOURNAL_SEGMENT_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{6,}\.ndjson$/;
export interface ResolvedJournalSegment { path: string; compressed: boolean; stamp: Stats }

/** Logical names never change when their physical storage becomes gzip. */
export async function resolveJournalSegment(logicalPath: string): Promise<ResolvedJournalSegment> {
  if (!JOURNAL_SEGMENT_PATTERN.test(basename(logicalPath)) || !(await lstat(dirname(logicalPath))).isDirectory()) {
    throw new Error("JOURNAL_SEGMENT_INVALID: expected a segment in a real directory");
  }
  for (const compressed of [false, true]) {
    const path = logicalPath + (compressed ? ".gz" : "");
    try {
      const stamp = await lstat(path);
      if (!stamp.isFile()) throw new Error("JOURNAL_SEGMENT_INVALID: segment is not a regular file (symlinks forbidden)");
      return { path, compressed, stamp };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || compressed) throw error;
    }
  }
  throw new Error("JOURNAL_SEGMENT_INVALID: no physical segment");
}

async function openSegment(segment: ResolvedJournalSegment): Promise<FileHandle> {
  const file = await open(segment.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await file.stat();
    if (!actual.isFile() || actual.dev !== segment.stamp.dev || actual.ino !== segment.stamp.ino) {
      throw new Error("JOURNAL_SEGMENT_CHANGED: physical file was replaced");
    }
    return file;
  } catch (error) { await file.close(); throw error; }
}

/** Bounded streaming; gzip CRC/truncation errors propagate to the caller. */
export async function* readJournalSegment(input: string | ResolvedJournalSegment): AsyncGenerator<Buffer> {
  const segment = typeof input === "string" ? await resolveJournalSegment(input) : input;
  const file = await openSegment(segment);
  const source = file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
  const gunzip = segment.compressed ? createGunzip({ chunkSize: 64 * 1024 }) : undefined;
  const output = gunzip ?? source;
  const completed = gunzip ? pipeline(source, gunzip) : undefined;
  // Own the rejection even when a bounded header reader deliberately returns early.
  void completed?.catch(() => {});
  try {
    for await (const chunk of output) yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    await completed;
  } catch (error) {
    if (segment.compressed) throw new Error("JOURNAL_GZIP_ERROR: invalid or incomplete compressed segment", { cause: error });
    throw error;
  } finally {
    output.destroy(); source.destroy();
    await completed?.catch(() => {});
    await file.close();
  }
}

function validLimit(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 16 * 1024 * 1024) throw new RangeError("JOURNAL_SEGMENT_INVALID: byte limit");
}

export async function readJournalSegmentPrefix(input: string | ResolvedJournalSegment, bytes: number): Promise<Buffer> {
  validLimit(bytes);
  const segment = typeof input === "string" ? await resolveJournalSegment(input) : input;
  if (!segment.compressed) {
    const file = await openSegment(segment), buffer = Buffer.alloc(Math.min(bytes, segment.stamp.size));
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const read = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      return buffer.subarray(0, offset);
    } finally { await file.close(); }
  }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of readJournalSegment(segment)) {
    const part = chunk.subarray(0, bytes - size);
    chunks.push(part); size += part.length;
    if (size === bytes) break;
  }
  return Buffer.concat(chunks, size);
}

export async function readJournalSegmentSuffix(input: string | ResolvedJournalSegment, bytes: number): Promise<Buffer> {
  validLimit(bytes);
  const segment = typeof input === "string" ? await resolveJournalSegment(input) : input;
  if (!segment.compressed) {
    const file = await openSegment(segment), buffer = Buffer.alloc(Math.min(bytes, segment.stamp.size));
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const read = await file.read(buffer, offset, buffer.length - offset, segment.stamp.size - buffer.length + offset);
        if (!read.bytesRead) throw new Error("JOURNAL_SEGMENT_CHANGED: incomplete suffix");
        offset += read.bytesRead;
      }
      return buffer;
    } finally { await file.close(); }
  }
  let suffix: Buffer = Buffer.alloc(0);
  for await (const chunk of readJournalSegment(segment)) {
    suffix = chunk.length >= bytes ? chunk.subarray(chunk.length - bytes)
      : Buffer.concat([suffix.subarray(Math.max(0, suffix.length + chunk.length - bytes)), chunk]);
  }
  return suffix;
}
