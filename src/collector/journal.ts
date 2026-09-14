import { randomUUID } from "node:crypto";
import { mkdir, open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { JournalRecord, RecordInput, RecordSink } from "./types.js";
import { JOURNAL_SEGMENT_PATTERN, readJournalSegmentPrefix } from "./journal-segments.js";

const DEFAULT_ROOT_DIR = "data/collector";
const DEFAULT_MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const SEGMENT_HEADER_BYTES = 64 * 1024;

export interface JournalOptions {
  rootDir?: string;
  runId?: string;
  maxSegmentBytes?: number;
  maxBufferBytes?: number;
  now?: () => Date | number;
  monotonicNs?: () => bigint | number;
  onError?: (error: unknown) => void;
}

export interface JournalCheckpoint {
  runId: string;
  sourceRunDirectory: string;
  sequence: number;
  receivedAtMs: number;
  segments: string[];
}

interface CheckpointWaiter {
  resolve: (checkpoint: JournalCheckpoint) => void;
  reject: (error: unknown) => void;
}

interface PendingRecord {
  line: string;
  bytes: number;
  date: string;
  checkpoint?: CheckpointWaiter & { sequence: number; receivedAtMs: number };
}

function asDate(value: Date | number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("JOURNAL_CLOCK_INVALID: now returned an invalid date");
  return date;
}

function safeRunId(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+|\.+$/g, "");
  return normalized.slice(0, 128) || `run-${randomUUID()}`;
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function segmentName(date: string, index: number): string {
  return `${date}-${String(index).padStart(6, "0")}.ndjson`;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

export class CollectorJournal implements RecordSink {
  private readonly rootDir: string;
  private readonly requestedRunId: string;
  private readonly maxSegmentBytes: number;
  private readonly maxBufferBytes: number;
  private readonly now: () => Date | number;
  private readonly monotonicNs: () => bigint | number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly queue: PendingRecord[] = [];
  private readonly checkpointWaiters = new Set<CheckpointWaiter>();
  private readonly ready: Promise<void>;
  private drainPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private file: FileHandle | undefined;
  private segmentDate: string | undefined;
  private nextSegmentIndex = 0;
  private segmentBytes = 0;
  private queuedBytes = 0;
  private sequence = 0;
  private fatalError: unknown;
  private errorReported = false;
  private closing = false;
  private closed = false;
  private _runId: string | undefined;
  private _runDirectory: string | undefined;

  private constructor(options: Required<Pick<JournalOptions, "rootDir" | "runId" | "maxSegmentBytes" | "maxBufferBytes" | "now" | "monotonicNs">> & { onError: JournalOptions["onError"] }) {
    this.rootDir = options.rootDir;
    this.requestedRunId = safeRunId(options.runId);
    this.maxSegmentBytes = options.maxSegmentBytes;
    this.maxBufferBytes = options.maxBufferBytes;
    this.now = options.now;
    this.monotonicNs = options.monotonicNs;
    this.onError = options.onError;
    this.ready = this.initialize();
  }

  static async open(options: JournalOptions = {}): Promise<CollectorJournal> {
    const journal = new CollectorJournal({
      rootDir: options.rootDir ?? DEFAULT_ROOT_DIR,
      runId: options.runId ?? `run-${randomUUID()}`,
      maxSegmentBytes: positiveInteger(options.maxSegmentBytes, DEFAULT_MAX_SEGMENT_BYTES, "maxSegmentBytes"),
      maxBufferBytes: positiveInteger(options.maxBufferBytes, DEFAULT_MAX_BUFFER_BYTES, "maxBufferBytes"),
      now: options.now ?? (() => new Date()),
      monotonicNs: options.monotonicNs ?? (() => process.hrtime.bigint()),
      onError: options.onError
    });
    try {
      await journal.ready;
    } catch (error) {
      journal.fail(error);
      throw new Error("JOURNAL_STORAGE_ERROR", { cause: error });
    }
    return journal;
  }

  get runId(): string {
    if (!this._runId) throw new Error("JOURNAL_NOT_READY");
    return this._runId;
  }

  get runDirectory(): string {
    if (!this._runDirectory) throw new Error("JOURNAL_NOT_READY");
    return this._runDirectory;
  }

  get pendingBytes(): number {
    return this.queuedBytes;
  }

  get error(): unknown {
    return this.fatalError;
  }

  record(input: RecordInput): JournalRecord {
    return this.enqueue(input);
  }

  checkpoint(): Promise<JournalCheckpoint> {
    // The executor enqueues synchronously: frames received after this call can
    // never move ahead of the cutoff while its file is being synced or closed.
    return new Promise((resolve, reject) => {
      this.enqueue({ source: "collector", kind: "checkpoint_end", data: { sealed: true } }, { resolve, reject });
    });
  }

  private enqueue(input: RecordInput, waiter?: CheckpointWaiter): JournalRecord {
    if (this.closed || this.closing) throw new Error("JOURNAL_CLOSED");
    if (this.errorReported) throw new Error("JOURNAL_STORAGE_ERROR", { cause: this.fatalError });

    const received = asDate(this.now());
    const sequence = this.sequence + 1;
    const record: JournalRecord = {
      schemaVersion: 1,
      runId: this.runId,
      sequence,
      receivedAt: received.toISOString(),
      receivedAtMs: received.getTime(),
      monotonicNs: String(this.monotonicNs()),
      source: input.source,
      kind: input.kind,
      data: input.data
    };
    if (input.connectionId !== undefined) record.connectionId = input.connectionId;

    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > this.maxBufferBytes || this.queuedBytes + bytes > this.maxBufferBytes) {
      throw new Error("JOURNAL_BUFFER_OVERFLOW");
    }

    this.sequence = sequence;
    const pending: PendingRecord = { line, bytes, date: utcDate(received) };
    if (waiter) {
      pending.checkpoint = { ...waiter, sequence, receivedAtMs: record.receivedAtMs };
      this.checkpointWaiters.add(pending.checkpoint);
    }
    this.queue.push(pending);
    this.queuedBytes += bytes;
    this.scheduleDrain();
    return record;
  }

  async flush(): Promise<void> {
    await this.ready;
    while (this.drainPromise) {
      const current = this.drainPromise;
      await current;
    }
    if (this.queue.length > 0 && !this.errorReported) {
      this.scheduleDrain();
      return this.flush();
    }
    if (this.errorReported) throw new Error("JOURNAL_STORAGE_ERROR", { cause: this.fatalError });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      try {
        await this.flush();
      } catch (error) {
        this.fail(error);
      } finally {
        try {
          await this.closeFile();
        } catch (error) {
          this.fail(error);
        } finally {
          this.closed = true;
        }
      }
      if (this.errorReported) throw new Error("JOURNAL_STORAGE_ERROR", { cause: this.fatalError });
    })();
    return this.closePromise;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    let candidate = this.requestedRunId;
    let suffix = 0;
    while (true) {
      const directory = join(this.rootDir, candidate);
      try {
        await mkdir(directory, { mode: 0o700 });
        this._runId = candidate;
        this._runDirectory = directory;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        suffix += 1;
        candidate = `${this.requestedRunId}-${suffix}`;
      }
    }
  }

  private scheduleDrain(): void {
    if (this.drainPromise || this.errorReported) return;
    this.drainPromise = this.drainLoop().catch((error: unknown) => {
      this.fail(error);
    }).finally(() => {
      this.drainPromise = undefined;
      if (this.queue.length > 0 && !this.errorReported && !this.closed) this.scheduleDrain();
    });
  }

  private async drainLoop(): Promise<void> {
    await this.ready;
    while (this.queue.length > 0) {
      if (this.errorReported) return;
      const pending = this.queue.shift();
      if (!pending) return;
      await this.writeRecord(pending);
      if (pending.checkpoint) {
        await this.closeFile();
        // The single writer stays behind this barrier until the sealed list is
        // captured. No later segment can enter this checkpoint's prefix.
        const segments = await listJournalSegments(this.runDirectory);
        this.queuedBytes -= pending.bytes;
        this.checkpointWaiters.delete(pending.checkpoint);
        pending.checkpoint.resolve({ runId: this.runId, sourceRunDirectory: this.runDirectory,
          sequence: pending.checkpoint.sequence, receivedAtMs: pending.checkpoint.receivedAtMs, segments });
      } else {
        this.queuedBytes -= pending.bytes;
      }
    }
  }

  private async writeRecord(pending: PendingRecord): Promise<void> {
    if (this.file && (this.segmentDate !== pending.date || (this.segmentBytes > 0 && this.segmentBytes + pending.bytes > this.maxSegmentBytes))) {
      await this.closeFile();
    }
    if (!this.file) {
      if (!Number.isSafeInteger(this.nextSegmentIndex)) throw new Error("JOURNAL_SEGMENT_LIMIT");
      const filePath = join(this.runDirectory, segmentName(pending.date, this.nextSegmentIndex++));
      this.file = await open(filePath, "wx", 0o600);
      this.segmentDate = pending.date;
      this.segmentBytes = 0;
    }
    const data = Buffer.from(pending.line, "utf8");
    let offset = 0;
    while (offset < data.byteLength) {
      const result = await this.file.write(data, offset, data.byteLength - offset);
      if (result.bytesWritten <= 0) throw new Error("JOURNAL_WRITE_FAILED: write made no progress");
      offset += result.bytesWritten;
    }
    this.segmentBytes += data.byteLength;
  }

  private async closeFile(): Promise<void> {
    const file = this.file;
    this.file = undefined;
    if (!file) return;
    try {
      await file.sync();
    } catch (error) {
      this.fail(error);
    } finally {
      try {
        await file.close();
      } catch (error) {
        this.fail(error);
      }
    }
    if (this.errorReported) throw new Error("JOURNAL_STORAGE_ERROR", { cause: this.fatalError });
  }

  private fail(error: unknown): void {
    if (!this.errorReported) this.fatalError = error;
    this.queue.length = 0;
    this.queuedBytes = 0;
    if (this.errorReported) return;
    this.errorReported = true;
    const failure = new Error("JOURNAL_STORAGE_ERROR", { cause: this.fatalError });
    for (const waiter of this.checkpointWaiters) waiter.reject(failure);
    this.checkpointWaiters.clear();
    try {
      this.onError?.(error);
    } catch {
      // Storage failures must remain observable through flush/close even if reporting fails.
    }
  }
}

export async function createJournal(options: JournalOptions = {}): Promise<CollectorJournal> {
  return CollectorJournal.open(options);
}

export async function listJournalSegments(runDirectory: string): Promise<string[]> {
  const names = [...new Set((await readdir(runDirectory)).map(name => name.endsWith(".gz") ? name.slice(0, -3) : name)
    .filter(name => JOURNAL_SEGMENT_PATTERN.test(name)))];
  const segments: Array<{ name: string; sequence: number | undefined }> = [];
  // Older archives restarted the index on each UTC date. Only the record
  // sequence, not the filename's date or index, identifies their actual order.
  for (const name of names) {
    segments.push({ name, sequence: await firstSegmentSequence(join(runDirectory, name)) });
  }
  return segments.sort((left, right) => {
    if (left.sequence !== right.sequence) {
      if (left.sequence === undefined) return 1;
      if (right.sequence === undefined) return -1;
      return left.sequence - right.sequence;
    }
    return left.name.localeCompare(right.name);
  }).map(({ name }) => name);
}

async function firstSegmentSequence(path: string): Promise<number | undefined> {
    const header = await readJournalSegmentPrefix(path, SEGMENT_HEADER_BYTES);
    const newline = header.indexOf(10);
    const firstLine = header.toString("utf8", 0, newline < 0 ? header.length : newline);
    let sequence: unknown;
    try {
      sequence = (JSON.parse(firstLine) as { sequence?: unknown } | null)?.sequence;
    } catch {
      // Journal metadata precedes the potentially large raw frame. A bounded
      // prefix also orders a truncated final record without treating it as a
      // complete record; replay still owns line/envelope validation.
      const prefix = firstLine.match(/^\s*\{\s*(?:"schemaVersion"\s*:\s*\d+\s*,\s*)?(?:"runId"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*)?"sequence"\s*:\s*(\d+)\s*[,}]/);
      if (prefix) sequence = Number(prefix[1]);
    }
    // Keep empty or unreadable tails in the result so replay can account for
    // them. Never invent a sequence based on a date that may have rolled back.
    return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0 ? sequence : undefined;
}
