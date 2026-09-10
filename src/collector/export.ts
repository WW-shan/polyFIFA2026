import { access, mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readJournalRecords, type ReplayMarketMapping, type ReplayQuoteRow, type ReplayTradeRow, type ReplaySportsRow } from "./replay.js";

export interface ExportOptions {
  runDirectory: string;
  outputDirectory?: string;
  overwrite?: boolean;
}

export interface ExportResult {
  outputDirectory: string;
  files: string[];
  quality: Awaited<ReturnType<typeof readJournalRecords>>["quality"];
}

const QUOTE_COLUMNS = [
  "sequence", "received_at", "received_at_ms", "connection_id", "token_id", "event_id", "event_slug", "game_id", "market_id", "market_slug", "outcome", "bids", "asks", "sports_sequence", "sports_received_at", "sports_age_ms"
];
const TRADE_COLUMNS = ["sequence", "received_at", "received_at_ms", "connection_id", "token_id", "price", "size", "side", "data"];
const SPORTS_COLUMNS = ["sequence", "received_at", "received_at_ms", "keys", "data"];
const MARKET_COLUMNS = ["token_id", "event_id", "event_slug", "game_id", "market_id", "market_slug", "condition_id", "outcome", "question"];

function csvValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "";
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function csvLine(values: readonly unknown[]): string {
  return `${values.map(csvValue).join(",")}\n`;
}

function quoteValues(row: ReplayQuoteRow): unknown[] {
  return [row.sequence, row.receivedAt, row.receivedAtMs, row.connectionId, row.tokenId, row.eventId, row.eventSlug, row.gameId, row.marketId, row.marketSlug, row.outcome, row.bids, row.asks, row.sportsSequence, row.sportsReceivedAt, row.sportsAgeMs];
}

function tradeValues(row: ReplayTradeRow): unknown[] {
  return [row.sequence, row.receivedAt, row.receivedAtMs, row.connectionId, row.tokenId, row.price, row.size, row.side, row.data];
}

function sportsValues(row: ReplaySportsRow): unknown[] {
  return [row.sequence, row.receivedAt, row.receivedAtMs, row.keys, row.data];
}

function marketValues(row: ReplayMarketMapping): unknown[] {
  return [row.tokenId, row.eventId, row.eventSlug, row.gameId, row.marketId, row.marketSlug, row.conditionId, row.outcome, row.question];
}

async function writeCsv(path: string, columns: readonly string[], rows: Iterable<readonly unknown[]>): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.write(csvLine(columns), undefined, "utf8");
    for (const row of rows) await file.write(csvLine(row), undefined, "utf8");
  } finally {
    await file.close();
  }
}

async function ensureAbsent(path: string, overwrite: boolean): Promise<void> {
  try {
    await access(path);
    if (!overwrite) throw new Error(`EXPORT_EXISTS: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function exportRun(options: ExportOptions): Promise<ExportResult> {
  const outputDirectory = options.outputDirectory ?? join(options.runDirectory, "export");
  const overwrite = options.overwrite === true;
  const names = ["quotes.csv", "trades.csv", "sports.csv", "markets.csv", "quality.json"];
  const replay = await readJournalRecords(options.runDirectory);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  for (const name of names) await ensureAbsent(join(outputDirectory, name), overwrite);
  const files: string[] = [];
  const writers: Array<Promise<void>> = [];
  const writeTarget = (name: string, columns: readonly string[], rows: Iterable<readonly unknown[]>): void => {
    const path = join(outputDirectory, name);
    if (overwrite) {
      writers.push(writeCsvOverwrite(path, columns, rows));
    } else {
      writers.push(writeCsv(path, columns, rows));
    }
    files.push(name);
  };
  writeTarget("quotes.csv", QUOTE_COLUMNS, replay.quotes.map(quoteValues));
  writeTarget("trades.csv", TRADE_COLUMNS, replay.trades.map(tradeValues));
  writeTarget("sports.csv", SPORTS_COLUMNS, replay.sports.map(sportsValues));
  writeTarget("markets.csv", MARKET_COLUMNS, replay.markets.map(marketValues));

  const qualityPath = join(outputDirectory, "quality.json");
  if (overwrite) {
    writers.push(writeFile(qualityPath, `${JSON.stringify({ runDirectory: options.runDirectory, segments: replay.segments, ...replay.quality }, null, 2)}\n`, { mode: 0o600 }));
  } else {
    writers.push(writeFile(qualityPath, `${JSON.stringify({ runDirectory: options.runDirectory, segments: replay.segments, ...replay.quality }, null, 2)}\n`, { flag: "wx", mode: 0o600 }));
  }
  files.push("quality.json");
  await Promise.all(writers);
  return { outputDirectory, files, quality: replay.quality };
}

async function writeCsvOverwrite(path: string, columns: readonly string[], rows: Iterable<readonly unknown[]>): Promise<void> {
  const file = await open(path, "w", 0o600);
  try {
    await file.write(csvLine(columns), undefined, "utf8");
    for (const row of rows) await file.write(csvLine(row), undefined, "utf8");
  } finally {
    await file.close();
  }
}

export { csvLine, csvValue };
