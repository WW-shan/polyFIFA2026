import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CollectorJournal, JournalCheckpoint } from "./journal.js";
import { assertJournalRecord } from "./journal-reader.js";

const MAX_CHECKPOINT_LINE_BYTES = 64 * 1024;
const MAX_SEGMENT_HEADER_BYTES = 64 * 1024;

interface SnapshotSegment {
  source: string;
  target: string;
  stamp: Stats;
}

function validateCheckpoint(journal: CollectorJournal, checkpoint: JournalCheckpoint): void {
  if (!checkpoint || checkpoint.runId !== journal.runId
    || typeof checkpoint.sourceRunDirectory !== "string"
    || resolve(checkpoint.sourceRunDirectory) !== resolve(journal.runDirectory)
    || !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 1
    || !Number.isSafeInteger(checkpoint.receivedAtMs)
    || !Array.isArray(checkpoint.segments) || checkpoint.segments.length === 0) {
    throw new Error("JOURNAL_SNAPSHOT_INVALID: invalid checkpoint provenance");
  }
  for (const [index, name] of checkpoint.segments.entries()) {
    const match = typeof name === "string" ? /^(\d{4}-\d{2}-\d{2})-(\d{6,})\.ndjson$/.exec(name) : null;
    // This writer allocates one increasing index across UTC dates. Require the
    // whole prefix, and reject path separators, duplicate names and suffixes.
    if (!match || match[0] !== name || Number(match[2]) !== index) {
      throw new Error("JOURNAL_SNAPSHOT_INVALID: unsafe or incomplete segment list");
    }
  }
}

function assertUnchanged(expected: Stats, actual: Stats): void {
  // Hardlink creation changes ctime/nlink, but must preserve identity and bytes.
  if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino
    || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) {
    throw new Error("JOURNAL_SNAPSHOT_CHANGED: sealed segment changed");
  }
}

async function validateCutoff(path: string, stamp: Stats, checkpoint: JournalCheckpoint): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertUnchanged(stamp, await file.stat());
    // The collector marker is small even when the preceding raw frame is huge.
    // Read only this bounded suffix, never copy or buffer the journal itself.
    const length = Math.min(stamp.size, MAX_CHECKPOINT_LINE_BYTES);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await file.read(buffer, offset, length - offset, stamp.size - length + offset);
      if (bytesRead === 0) throw new Error("JOURNAL_SNAPSHOT_CHANGED: incomplete cutoff read");
      offset += bytesRead;
    }
    const start = buffer.lastIndexOf(10, length - 2) + 1;
    if (buffer[length - 1] !== 10 || (start === 0 && stamp.size > length)) {
      throw new Error("JOURNAL_SNAPSHOT_INVALID: incomplete checkpoint marker");
    }
    let record: unknown;
    try {
      record = JSON.parse(buffer.toString("utf8", start, length - 1)) as unknown;
      assertJournalRecord(record);
    } catch (error) {
      throw new Error("JOURNAL_SNAPSHOT_INVALID: invalid checkpoint marker", { cause: error });
    }
    if (record.runId !== checkpoint.runId || record.sequence !== checkpoint.sequence
      || record.receivedAtMs !== checkpoint.receivedAtMs || record.source !== "collector"
      || record.kind !== "checkpoint_end" || (record.data as { sealed?: unknown })?.sealed !== true) {
      throw new Error("JOURNAL_SNAPSHOT_INVALID: cutoff does not match checkpoint");
    }
    assertUnchanged(stamp, await file.stat());
  } finally {
    await file.close();
  }
}

async function firstSequence(segment: SnapshotSegment, checkpoint: JournalCheckpoint): Promise<number> {
  const file = await open(segment.source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assertUnchanged(segment.stamp, await file.stat());
    const length = Math.min(segment.stamp.size, MAX_SEGMENT_HEADER_BYTES), buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await file.read(buffer, offset, length - offset, offset);
      if (bytesRead === 0) throw new Error("JOURNAL_SNAPSHOT_CHANGED: incomplete header read");
      offset += bytesRead;
    }
    const newline = buffer.indexOf(10);
    let record: unknown;
    try {
      if (newline >= 0) {
        record = JSON.parse(buffer.toString("utf8", 0, newline)) as unknown;
      } else {
        // Journal serialization puts all required envelope fields before data.
        // Validate that original metadata without reading a large raw payload.
        const prefix = buffer.toString("utf8"), dataOffset = prefix.indexOf(',"data":');
        if (segment.stamp.size <= length || dataOffset < 0) throw new Error("missing bounded journal header");
        record = JSON.parse(prefix.slice(0, dataOffset) + ',"data":null}') as unknown;
      }
      assertJournalRecord(record);
      if (record.runId !== checkpoint.runId || record.sequence > checkpoint.sequence) throw new Error("header provenance mismatch");
    } catch (error) {
      throw new Error("JOURNAL_SNAPSHOT_INVALID: invalid segment header", { cause: error });
    }
    assertUnchanged(segment.stamp, await file.stat());
    return record.sequence;
  } finally {
    await file.close();
  }
}

async function suffixStart(segments: SnapshotSegment[], checkpoint: JournalCheckpoint, fromSequence: number): Promise<{
  index: number; firstIncludedSequence: number;
}> {
  let low = 0, high = segments.length, lowerSequence = 0, upperSequence = checkpoint.sequence + 1;
  let selected: { index: number; firstIncludedSequence: number } | undefined;
  // Find the final segment whose original first sequence is <= the hint. The
  // validated full checkpoint retains the writer's increasing segment order.
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const sequence = await firstSequence(segments[middle]!, checkpoint);
    if (sequence <= lowerSequence || sequence >= upperSequence) throw new Error("JOURNAL_SNAPSHOT_INVALID: segment header order");
    if (sequence <= fromSequence) {
      selected = { index: middle, firstIncludedSequence: sequence };
      low = middle + 1; lowerSequence = sequence;
    } else {
      high = middle; upperSequence = sequence;
    }
  }
  if (!selected) throw new Error("JOURNAL_SNAPSHOT_INVALID: fromSequence precedes the source records");
  return selected;
}

export async function sealJournalSnapshot(journal: CollectorJournal, outputDirectory: string, options: { fromSequence?: number } = {}): Promise<{
  runDirectory: string; checkpoint: JournalCheckpoint;
}> {
  // Admission happens before the first await, so callers may immediately keep
  // recording. Snapshot I/O never closes or otherwise owns the source journal.
  const fromSequence = options.fromSequence;
  const checkpoint = await journal.checkpoint();
  validateCheckpoint(journal, checkpoint);
  if (fromSequence !== undefined && (!Number.isSafeInteger(fromSequence) || fromSequence < 1 || fromSequence >= checkpoint.sequence)) {
    throw new Error("JOURNAL_SNAPSHOT_INVALID: fromSequence must be a positive integer before the checkpoint");
  }
  const runDirectory = resolve(outputDirectory);
  await mkdir(dirname(runDirectory), { recursive: true, mode: 0o700 });
  try {
    await mkdir(runDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("JOURNAL_SNAPSHOT_EXISTS: " + runDirectory);
    throw error;
  }

  const segments: SnapshotSegment[] = [];
  for (const name of checkpoint.segments) {
    const source = join(checkpoint.sourceRunDirectory, name), target = join(runDirectory, name);
    const stamp = await lstat(source);
    if (!stamp.isFile() || stamp.size === 0) throw new Error("JOURNAL_SNAPSHOT_INVALID: segment is not a regular sealed file");
    segments.push({ source, target, stamp });
  }
  const last = segments[segments.length - 1]!;
  await validateCutoff(last.source, last.stamp, checkpoint);
  // Validate the entire original prefix above before selecting any suffix.
  const start = fromSequence === undefined ? undefined : await suffixStart(segments, checkpoint, fromSequence);
  const included = start ? segments.slice(start.index) : segments;
  for (const segment of included) {
    assertUnchanged(segment.stamp, await lstat(segment.source));
    await link(segment.source, segment.target);
    assertUnchanged(segment.stamp, await lstat(segment.target));
  }

  const pendingManifest = join(runDirectory, ".checkpoint.json.pending");
  const manifest = await open(pendingManifest, "wx", 0o600);
  try {
    const data = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "collector-checkpoint", status: "complete", ...checkpoint,
      ...(start ? { segments: checkpoint.segments.slice(start.index), sourceCheckpoint: checkpoint,
        requestedFromSequence: fromSequence, firstIncludedSequence: start.firstIncludedSequence } : {}) }) + "\n");
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await manifest.write(data, offset, data.length - offset);
      if (bytesWritten <= 0) throw new Error("JOURNAL_SNAPSHOT_WRITE_FAILED: write made no progress");
      offset += bytesWritten;
    }
    await manifest.sync();
  } finally {
    await manifest.close();
  }
  for (const segment of segments) {
    assertUnchanged(segment.stamp, await lstat(segment.source));
  }
  for (const segment of included) {
    assertUnchanged(segment.stamp, await lstat(segment.target));
  }
  const directory = await open(runDirectory, "r");
  try { await directory.sync(); } finally { await directory.close(); }
  // The exclusively owned output directory has no prior manifest. Publish only
  // after every write, sync, close and validation succeeds; leave failures for
  // the caller to inspect and retry in a new directory.
  await rename(pendingManifest, join(runDirectory, "checkpoint.json"));
  return { runDirectory, checkpoint };
}
