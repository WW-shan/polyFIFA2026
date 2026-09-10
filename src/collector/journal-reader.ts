import { createReadStream } from "node:fs";
import { join } from "node:path";
import { listJournalSegments } from "./journal.js";
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
    const stream = createReadStream(join(runDirectory, segment), { encoding: "utf8", highWaterMark: 64 * 1024 });
    let pending = "";
    try {
      for await (const chunk of stream) {
        pending += String(chunk);
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (Buffer.byteLength(line) > maxLineBytes) throw new Error("REPLAY_LINE_TOO_LARGE");
          let value: unknown;
          try { value = JSON.parse(line) as unknown; }
          catch { quality.malformedLines += 1; onDamage(); continue; }
          assertJournalRecord(value);
          await onRecord(value);
        }
        if (Buffer.byteLength(pending) > maxLineBytes) throw new Error("REPLAY_LINE_TOO_LARGE");
      }
      if (pending.length > 0) {
        quality.incompleteFinalLines += 1;
        onDamage();
      }
    } finally {
      stream.destroy();
    }
  }
  return segments;
}
