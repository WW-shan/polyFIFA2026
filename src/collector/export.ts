import { lstat, mkdir, mkdtemp, open, link, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { scanJournal } from "./journal-reader.js";
import { JournalReplay, type ReplayMarketMapping, type ReplayOptions, type ReplayQuality, type ReplayQuoteRow, type ReplaySportsRow, type ReplayTradeRow } from "./replay.js";

export interface ExportOptions extends ReplayOptions {
  runDirectory: string;
  outputDirectory?: string;
  overwrite?: boolean;
}
export interface ExportCounts { records: number; quotes: number; trades: number; sports: number; markets: number }
export interface ExportResult {
  outputDirectory: string;
  files: string[];
  quality: ReplayQuality;
  counts: ExportCounts;
}
const FILES = ["quotes.csv", "trades.csv", "sports.csv", "markets.csv", "quality.json"];
const QUOTE_COLUMNS = ["sequence", "received_at", "received_at_ms", "connection_id", "token_id", "event_id", "event_slug", "game_id", "market_id", "market_slug", "outcome", "bids", "asks", "sports_sequence", "sports_received_at", "sports_age_ms", "frame_index", "server_timestamp", "sports_frame_index", "sports_status", "sports_score", "sports_period", "sports_clock", "sports_clock_status"];
const TRADE_COLUMNS = ["sequence", "received_at", "received_at_ms", "connection_id", "token_id", "price", "size", "side", "data", "frame_index"];
const SPORTS_COLUMNS = ["sequence", "received_at", "received_at_ms", "keys", "data", "connection_id", "frame_index"];
const MARKET_COLUMNS = ["token_id", "event_id", "event_slug", "game_id", "market_id", "market_slug", "condition_id", "outcome", "question", "raw_market"];

export function csvValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? "" : /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
export function csvLine(values: readonly unknown[]): string { return values.map(csvValue).join(",") + "\n"; }
function quoteValues(row: ReplayQuoteRow): unknown[] {
  return [row.sequence, row.receivedAt, row.receivedAtMs, row.connectionId, row.tokenId, row.eventId, row.eventSlug, row.gameId, row.marketId, row.marketSlug, row.outcome, row.bids, row.asks, row.sportsSequence, row.sportsReceivedAt, row.sportsAgeMs, row.frameIndex, row.serverTimestamp, row.sportsFrameIndex, row.sportsStatus, row.sportsScore, row.sportsPeriod, row.sportsClock, row.sportsClockStatus];
}
function tradeValues(row: ReplayTradeRow): unknown[] {
  return [row.sequence, row.receivedAt, row.receivedAtMs, row.connectionId, row.tokenId, row.price, row.size, row.side, row.data, row.frameIndex];
}
function sportsValues(row: ReplaySportsRow): unknown[] {
  return [row.sequence, row.receivedAt, row.receivedAtMs, row.keys, row.data, row.connectionId, row.frameIndex];
}
function marketValues(row: ReplayMarketMapping): unknown[] {
  return [row.tokenId, row.eventId, row.eventSlug, row.gameId, row.marketId, row.marketSlug, row.conditionId, row.outcome, row.question, row.data];
}

async function writeAll(file: FileHandle, text: string): Promise<void> {
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await file.write(buffer, offset, buffer.length - offset);
    if (result.bytesWritten <= 0) throw new Error("EXPORT_WRITE_FAILED: no write progress");
    offset += result.bytesWritten;
  }
}

class CsvWriter {
  private buffer = "";
  private bytes = 0;
  constructor(private readonly file: FileHandle) {}
  async row(values: readonly unknown[]): Promise<void> {
    const line = csvLine(values);
    this.buffer += line;
    this.bytes += Buffer.byteLength(line);
    if (this.bytes >= 64 * 1024) await this.flush();
  }
  async flush(): Promise<void> {
    if (this.bytes === 0) return;
    await writeAll(this.file, this.buffer);
    this.buffer = "";
    this.bytes = 0;
  }
  async close(): Promise<void> {
    try { await this.flush(); await this.file.sync(); }
    finally { await this.file.close(); }
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Stage complete results before replacing anything, and publish quality.json last as completion marker. */
async function publish(stage: string, output: string, overwrite: boolean): Promise<void> {
  const published: string[] = [];
  const backups: string[] = [];
  try {
    for (const name of FILES) {
      const target = join(output, name);
      if (overwrite && await exists(target)) {
        const info = await lstat(target);
        if (!info.isFile()) throw new Error("EXPORT_TARGET_INVALID: " + target);
        await rename(target, join(stage, "previous-" + name));
        backups.push(name);
      }
      // Hard-link creation is exclusive, so concurrent writers cannot silently overwrite.
      await link(join(stage, name), target);
      published.push(name);
    }
  } catch (error) {
    for (const name of published.reverse()) await rm(join(output, name));
    for (const name of backups.reverse()) await rename(join(stage, "previous-" + name), join(output, name));
    throw error;
  }
}

export async function exportRun(options: ExportOptions): Promise<ExportResult> {
  const outputDirectory = resolve(options.outputDirectory ?? join(options.runDirectory, "export"));
  const overwrite = options.overwrite === true;
  for (const name of FILES) {
    if (!overwrite && await exists(join(outputDirectory, name))) throw new Error("EXPORT_EXISTS: " + join(outputDirectory, name));
  }
  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(dirname(outputDirectory), "." + basename(outputDirectory) + "-staging-"));
  const handles: FileHandle[] = [];
  const writers = new Map<string, CsvWriter>();
  let lock: FileHandle | undefined;
  const lockPath = join(outputDirectory, ".collector-export.lock");
  let stageRecoverable = false;
  try {
    for (const [name, columns] of [
      ["quotes.csv", QUOTE_COLUMNS], ["trades.csv", TRADE_COLUMNS],
      ["sports.csv", SPORTS_COLUMNS], ["markets.csv", MARKET_COLUMNS]
    ] as const) {
      const file = await open(join(stage, name), "wx", 0o600);
      handles.push(file);
      const writer = new CsvWriter(file);
      writers.set(name, writer);
      await writer.row(columns);
    }
    const counts: ExportCounts = { records: 0, quotes: 0, trades: 0, sports: 0, markets: 0 };
    const replay = new JournalReplay(options);
    const segments = await scanJournal(options.runDirectory, async record => {
      counts.records += 1;
      for (const batch of replay.replay(record)) {
        for (const quote of batch.quotes) { await writers.get("quotes.csv")!.row(quoteValues(quote)); counts.quotes += 1; }
        for (const trade of batch.trades) { await writers.get("trades.csv")!.row(tradeValues(trade)); counts.trades += 1; }
        for (const sports of batch.sports) { await writers.get("sports.csv")!.row(sportsValues(sports)); counts.sports += 1; }
      }
    }, replay.quality, () => replay.invalidate(), options);
    for (const market of replay.markets) { await writers.get("markets.csv")!.row(marketValues(market)); counts.markets += 1; }
    for (const writer of writers.values()) await writer.close();
    writers.clear();
    const qualityFile = await open(join(stage, "quality.json"), "wx", 0o600);
    try { await writeAll(qualityFile, JSON.stringify({ runDirectory: resolve(options.runDirectory), segments, counts, ...replay.quality }, null, 2) + "\n"); await qualityFile.sync(); }
    finally { await qualityFile.close(); }
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("EXPORT_BUSY: another exporter owns " + outputDirectory);
      throw error;
    }
    if (!overwrite) for (const name of FILES) if (await exists(join(outputDirectory, name))) throw new Error("EXPORT_EXISTS: " + join(outputDirectory, name));
    try { await publish(stage, outputDirectory, overwrite); }
    catch (error) {
      // Preserve any backup if an exceptional filesystem failure also prevented rollback.
      stageRecoverable = (await Promise.all(FILES.map(name => exists(join(stage, "previous-" + name))))).some(Boolean);
      throw error;
    }
    return { outputDirectory, files: [...FILES], quality: replay.quality, counts };
  } finally {
    await Promise.allSettled(handles.map(handle => handle.close()));
    if (lock) { await lock.close(); await rm(lockPath); }
    if (!stageRecoverable) await rm(stage, { recursive: true });
  }
}
