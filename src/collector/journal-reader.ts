import { join } from "node:path";
import { listJournalSegments } from "./journal.js";
import { readJournalSegment } from "./journal-segments.js";
import { objectValue } from "./replay-values.js";
import type { JournalRecord } from "./types.js";
import type { ReplayOptions, ReplayQuality } from "./replay-types.js";

export function assertJournalRecord(value: unknown): asserts value is JournalRecord {
  const record = objectValue(value);
  if (!record || record.schemaVersion !== 1 || typeof record.runId !== "string" || !record.runId
    || !Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1
    || typeof record.receivedAtMs !== "number" || !Number.isFinite(record.receivedAtMs)
    || typeof record.receivedAt !== "string" || Date.parse(record.receivedAt) !== record.receivedAtMs
    || typeof record.monotonicNs !== "string" || !/^\d+$/.test(record.monotonicNs)
    || typeof record.source !== "string" || !["collector", "gamma", "clob", "sports"].includes(record.source)
    || typeof record.kind !== "string" || !record.kind || !("data" in record)
    || (record.connectionId !== undefined && (typeof record.connectionId !== "string" || !record.connectionId))) {
    throw new Error("REPLAY_RECORD_INVALID: invalid journal envelope");
  }
}

/** Only newline-terminated records are committed. At most one bounded line is buffered. */
export async function scanJournal(
  runDirectory: string,
  onRecord: (record: JournalRecord) => void | Promise<void>,
  quality: ReplayQuality,
  onDamage: () => void,
  options: ReplayOptions = {}
): Promise<string[]> {
  const segments = await listJournalSegments(runDirectory);
  if (segments.length === 0) throw new Error("REPLAY_NO_SEGMENTS: no journal segments found");
  const maxLineBytes = options.maxLineBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new Error("REPLAY_OPTIONS_INVALID: maxLineBytes");
  for (const segment of segments) {
    const stream = readJournalSegment(join(runDirectory, segment));
    let parts: Buffer[] = [], pendingBytes = 0;
    const takeLine = (): string => {
      const bytes = parts.length === 1 ? parts[0]! : Buffer.concat(parts, pendingBytes);
      const line = bytes.toString("utf8");
      parts = []; pendingBytes = 0;
      // Invalid UTF-8 becomes replacement characters, whose encoded size can
      // exceed the raw byte count. Keep the decoded bound as well.
      if (Buffer.byteLength(line) > maxLineBytes) throw new Error("REPLAY_LINE_TOO_LARGE");
      return line;
    };
    try {
      for await (const chunk of stream) {
        let start = 0;
        while (start < chunk.length) {
          // Search each incoming byte at most once; never rescan or copy the
          // accumulated prefix of multi-megabyte discovery responses.
          const newline = chunk.indexOf(0x0a, start);
          const end = newline === -1 ? chunk.length : newline;
          pendingBytes += end - start;
          if (pendingBytes > maxLineBytes) throw new Error("REPLAY_LINE_TOO_LARGE");
          if (end > start) parts.push(chunk.subarray(start, end));
          if (newline === -1) break;
          start = newline + 1;
          const line = takeLine();
          let value: unknown;
          try {
            value = JSON.parse(line) as unknown;
            assertJournalRecord(value);
          } catch { quality.malformedLines += 1; onDamage(); continue; }
          await onRecord(value);
        }
      }
      if (pendingBytes > 0) {
        takeLine();
        quality.incompleteFinalLines += 1;
        onDamage();
      }
    } finally {
      await stream.return(undefined);
    }
  }
  return segments;
}
