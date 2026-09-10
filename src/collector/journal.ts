import { randomUUID } from "node:crypto";
import { mkdir, open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { JournalRecord, RecordInput, RecordSink } from "./types.js";

const DEFAULT_ROOT_DIR = "data/collector";
const DEFAULT_MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export interface JournalOptions {
  rootDir?: string;
  runId?: string;
  maxSegmentBytes?: number;
  maxBufferBytes?: number;
  now?: () => Date | number;
  monotonicNs?: () => bigint | number;
  onError?: (error: unknown) => void;
}

interface PendingRecord {
  record: JournalRecord;
  line: string;
  bytes: number;
  date: string;
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
  private readonly ready: Promise<void>;
  private drainPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private file: FileHandle | undefined;
  private segmentDate: string | undefined;
  private segmentIndex = 0;
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
    await journal.ready;
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
    if (this.closed || this.closing) throw new Error("JOURNAL_CLOSED");
    if (this.fatalError) throw new Error("JOURNAL_STORAGE_ERROR", { cause: this.fatalError });

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
    this.queue.push({ record, line, bytes, date: utcDate(received) });
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
    if (this.queue.length > 0 && !this.fatalError) {
      this.scheduleDrain();
      return this.flush();
    }
    if (this.fatalError) throw new Error("JOURNAL_STORAGE_ERROR", { cause: this.fatalError });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      try {
        await this.flush();
      } finally {
        await this.closeFile();
        this.closed = true;
      }
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
    if (this.drainPromise || this.fatalError) return;
    this.drainPromise = this.drainLoop().catch((error: unknown) => {
      this.fail(error);
    }).finally(() => {
      this.drainPromise = undefined;
      if (this.queue.length > 0 && !this.fatalError && !this.closed) this.scheduleDrain();
    });
  }

  private async drainLoop(): Promise<void> {
    await this.ready;
    while (this.queue.length > 0) {
      if (this.fatalError) return;
      const pending = this.queue.shift();
      if (!pending) return;
      this.queuedBytes -= pending.bytes;
      await this.writeRecord(pending);
    }
  }

  private async writeRecord(pending: PendingRecord): Promise<void> {
    if (this.segmentDate !== pending.date) {
      await this.closeFile();
      this.segmentDate = pending.date;
      this.segmentIndex = 0;
      this.segmentBytes = 0;
    }
    if (this.file && this.segmentBytes > 0 && this.segmentBytes + pending.bytes > this.maxSegmentBytes) {
      await this.closeFile();
      this.segmentIndex += 1;
      this.segmentBytes = 0;
    }
    if (!this.file) {
      const filePath = join(this.runDirectory, segmentName(pending.date, this.segmentIndex));
      this.file = await open(filePath, "wx", 0o600);
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
    if (file) await file.close();
  }

  private fail(error: unknown): void {
    if (!this.fatalError) this.fatalError = error;
    this.queue.length = 0;
    this.queuedBytes = 0;
    if (this.errorReported) return;
    this.errorReported = true;
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
  return (await readdir(runDirectory)).filter((name) => /^\d{4}-\d{2}-\d{2}-\d{6}\.ndjson$/.test(name)).sort();
}
