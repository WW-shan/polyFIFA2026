import { constants } from "node:fs";
import { lstat, open, opendir, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TailSummary } from "./tail-types.js";

export const artifactTypes = {
  "viewer.html": "text/html; charset=utf-8",
  "seconds.ndjson": "application/x-ndjson",
  "seconds.csv": "text/csv; charset=utf-8",
  "quality.json": "application/json",
  "manifest.json": "application/json",
  "changes.ndjson": "application/x-ndjson",
  "state-changes.ndjson": "application/x-ndjson",
  "audit.ndjson": "application/x-ndjson",
  "raw-events.ndjson": "application/x-ndjson",
  "raw-events.ndjson.gz": "application/gzip"
} as const;
export type ArtifactName = keyof typeof artifactTypes;

export function safeArchiveId(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== "." && value !== ".." && !/[\\/%\u0000-\u001f\u007f]/.test(value);
}

function strictlyInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child);
}

// Shared by metadata reads and HTTP downloads. Keep streaming the checked inode,
// including for the existing nested hot-state output directories.
export async function openArtifact(exportsRoot: string, outputDirectory: string, filename: ArtifactName): Promise<{ handle: FileHandle; size: number } | null> {
  const directory = resolve(outputDirectory);
  if (!strictlyInside(exportsRoot, directory) || !Object.hasOwn(artifactTypes, filename)) return null;
  let handle: FileHandle | undefined;
  try {
    // Reject symlinks at every level, including the exports root itself. The
    // caller-supplied data root can have canonical parent aliases (e.g. /tmp).
    if (!(await lstat(exportsRoot)).isDirectory()) return null;
    let current = exportsRoot;
    const child = relative(exportsRoot, directory);
    for (const part of child.split(sep)) {
      current = join(current, part);
      if (!(await lstat(current)).isDirectory()) return null;
    }
    const realRoot = await realpath(exportsRoot);
    const realDirectory = await realpath(directory);
    if (!strictlyInside(realRoot, realDirectory) || realDirectory !== join(realRoot, child)) return null;
    const path = join(realDirectory, filename);
    const checked = await lstat(path);
    if (!checked.isFile()) return null;
    // NOFOLLOW guards a replaced final symlink; NONBLOCK prevents a substituted
    // FIFO from hanging the listener. Stream only the checked, opened inode.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== checked.dev || actual.ino !== checked.ino || !Number.isSafeInteger(actual.size)
      || await realpath(path) !== path || !(await lstat(exportsRoot)).isDirectory()) {
      await handle.close();
      return null;
    }
    return { handle, size: actual.size };
  } catch {
    await handle?.close().catch(() => {});
    return null;
  }
}

export interface HistoricalArchive {
  id: string;
  createdAt: string;
  sourceRunId: string;
  windowSeconds: number;
  seconds: number;
  depthFileBytes: number;
  rawEventsFile: "raw-events.ndjson" | "raw-events.ndjson.gz";
  games: Array<{
    key: string; title: string; finishedAtMs: number | null; finishConflict: boolean;
    tokenCount: number; priceReadyTokens: number; strictReadyTokens: number;
  }>;
}
export interface ArchiveDiagnostics {
  incomplete: number; invalid: number; unsafe: number; oversized: number; unreadable: number;
}
interface CatalogSnapshot {
  entries: HistoricalArchive[]; byId: Map<string, HistoricalArchive>; scannedAtMs: number; diagnostics: ArchiveDiagnostics;
}
export const archivePageLimit = 100;
const cacheMs = 30_000;
const metadataLimits = { "manifest.json": 64 * 1024, "quality.json": 2 * 1024 * 1024 } as const;

class CatalogIssue extends Error {
  constructor(readonly kind: keyof ArchiveDiagnostics) { super(kind); }
}
function check(condition: unknown): asserts condition {
  if (!condition) throw new CatalogIssue("invalid");
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const label = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;

async function artifactSize(directory: string, filename: ArtifactName): Promise<number> {
  try {
    const stat = await lstat(join(directory, filename));
    if (!stat.isFile()) throw new CatalogIssue("unsafe");
    return stat.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CatalogIssue("incomplete");
    throw error;
  }
}

async function metadata(exportsRoot: string, directory: string, filename: keyof typeof metadataLimits): Promise<unknown> {
  await artifactSize(directory, filename);
  const file = await openArtifact(exportsRoot, directory, filename);
  if (!file) throw new CatalogIssue("unsafe");
  try {
    if (file.size > metadataLimits[filename]) throw new CatalogIssue("oversized");
    // readFile would follow a growing file to EOF. Read only its checked size.
    const buffer = Buffer.alloc(file.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new CatalogIssue("invalid");
      offset += bytesRead;
    }
    if ((await file.handle.stat()).size !== file.size) throw new CatalogIssue("invalid");
    try { return JSON.parse(buffer.toString("utf8")); }
    catch { throw new CatalogIssue("invalid"); }
  } finally { await file.handle.close(); }
}

async function readArchive(exportsRoot: string, id: string): Promise<HistoricalArchive> {
  const directory = join(exportsRoot, id);
  const manifest = await metadata(exportsRoot, directory, "manifest.json");
  check(object(manifest));
  if (manifest.status !== "complete") throw new CatalogIssue("incomplete");
  const rawEventsFile = manifest.rawEventsFile === undefined ? "raw-events.ndjson" : manifest.rawEventsFile;
  check(rawEventsFile === "raw-events.ndjson" || rawEventsFile === "raw-events.ndjson.gz");
  const quality = await metadata(exportsRoot, directory, "quality.json");
  // These fixed-file stats never read depth, raw events or viewer contents.
  const sizes = new Map<ArtifactName, number>();
  for (const filename of Object.keys(artifactTypes) as ArtifactName[]) {
    if ((filename === "raw-events.ndjson" || filename === "raw-events.ndjson.gz") && filename !== rawEventsFile) continue;
    sizes.set(filename, await artifactSize(directory, filename));
  }
  check(object(quality) && quality.schemaVersion === 1 && quality.basis === "received-order-book-tail");
  check(label(manifest.sourceRunId) && manifest.sourceRunId === quality.runId);
  check(label(manifest.sourceRunDirectory) && isAbsolute(manifest.sourceRunDirectory));
  check(label(manifest.createdAt) && Number.isFinite(Date.parse(manifest.createdAt)));
  check(manifest.depthFile === "seconds.ndjson" && count(manifest.depthFileBytes) && manifest.depthFileBytes === sizes.get("seconds.ndjson"));
  check(count(quality.windowSeconds) && quality.windowSeconds > 0);
  for (const field of ["seconds", "changes", "stateChanges", "audits"] as const) check(count(quality[field]) && manifest[field] === quality[field]);
  if (quality.rawRecords !== undefined || manifest.rawRecords !== undefined) check(count(quality.rawRecords) && manifest.rawRecords === quality.rawRecords);
  check(Array.isArray(quality.windows) && quality.windows.length > 0 && Array.isArray(quality.tokens));
  check(manifest.tokenCount === quality.tokens.length);
  const windows = new Map<string, { endAtMs: number | null; finishConflict: boolean }>();
  for (const window of quality.windows) {
    check(object(window) && label(window.key) && label(window.title) && typeof window.finishConflict === "boolean");
    check(window.endAtMs === null || (typeof window.endAtMs === "number" && Number.isFinite(window.endAtMs)));
    check(!windows.has(window.key));
    windows.set(window.key, { endAtMs: window.endAtMs, finishConflict: window.finishConflict });
  }
  const tokens = new Set<string>();
  let expectedRows = 0;
  for (const token of quality.tokens) {
    check(object(token) && label(token.windowKey) && windows.has(token.windowKey) && label(token.tokenId));
    const window = windows.get(token.windowKey)!;
    const identity = JSON.stringify([token.windowKey, token.tokenId]);
    check(!tokens.has(identity)); tokens.add(identity);
    for (const field of ["expectedSeconds", "validSeconds", "closedSeconds", "partialSeconds", "missingSeconds", "staleSeconds", "contextSeconds"] as const) check(count(token[field]));
    check(token.expectedSeconds === quality.windowSeconds);
    check((token.validSeconds as number) + (token.closedSeconds as number) + (token.partialSeconds as number)
      + (token.missingSeconds as number) + (token.staleSeconds as number) === token.expectedSeconds);
    check((token.contextSeconds as number) <= (token.expectedSeconds as number));
    check(typeof token.observedWindowComplete === "boolean" && typeof token.snapshotAuditPassed === "boolean" && typeof token.readyForReplay === "boolean");
    if (window.endAtMs !== null) expectedRows += token.expectedSeconds as number;
    if (token.observedWindowComplete) check(window.endAtMs !== null && !window.finishConflict
      && (token.validSeconds as number) + (token.closedSeconds as number) === token.expectedSeconds);
    if (token.readyForReplay) check(token.observedWindowComplete && token.snapshotAuditPassed
      && (token.validSeconds as number) > 0 && token.contextSeconds === token.expectedSeconds);
  }
  const summary = quality as unknown as TailSummary;
  check(count(expectedRows) && summary.seconds === expectedRows);
  check(manifest.readyTokens === summary.tokens.filter(token => token.readyForReplay).length);
  check((summary.seconds === 0) === (manifest.depthFileBytes === 0));
  return {
    id, createdAt: manifest.createdAt, sourceRunId: manifest.sourceRunId, windowSeconds: summary.windowSeconds,
    seconds: summary.seconds, depthFileBytes: manifest.depthFileBytes, rawEventsFile,
    games: summary.windows.map(window => {
      const tokens = summary.tokens.filter(token => token.windowKey === window.key);
      return { key: window.key, title: window.title, finishedAtMs: window.endAtMs, finishConflict: window.finishConflict,
        tokenCount: tokens.length,
        priceReadyTokens: tokens.filter(token => token.observedWindowComplete && token.snapshotAuditPassed && token.validSeconds > 0).length,
        strictReadyTokens: tokens.filter(token => token.readyForReplay).length };
    })
  };
}

/** Reconstructed lazily from immutable, direct-child export directories; no disk writes or timers. */
export class ContinuousArchiveCatalog {
  private cached: CatalogSnapshot | undefined;
  private pending: Promise<CatalogSnapshot> | undefined;
  constructor(private readonly exportsRoot: string) {}

  private snapshot(): Promise<CatalogSnapshot> {
    if (this.cached && Date.now() - this.cached.scannedAtMs < cacheMs) return Promise.resolve(this.cached);
    this.pending ??= this.scan().then(snapshot => { this.cached = snapshot; return snapshot; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async page(offset = 0, limit = 20) {
    if (!count(offset) || !count(limit) || limit < 1 || limit > archivePageLimit) throw new RangeError("Invalid archive page");
    const snapshot = await this.snapshot();
    return { offset, limit, total: snapshot.entries.length,
      nextOffset: offset + limit < snapshot.entries.length ? offset + limit : null,
      scannedAtMs: snapshot.scannedAtMs, diagnostics: snapshot.diagnostics, entries: snapshot.entries.slice(offset, offset + limit) };
  }

  async find(id: string): Promise<HistoricalArchive | undefined> {
    if (!safeArchiveId(id)) return undefined;
    return (await this.snapshot()).byId.get(id);
  }

  // Status polls can use already validated filenames without starting or waiting
  // for any IO. No readiness or live archive status is inferred from the cache.
  cachedRawEventsFile(outputDirectory: string): HistoricalArchive["rawEventsFile"] | undefined {
    const id = relative(this.exportsRoot, resolve(outputDirectory));
    return safeArchiveId(id) ? this.cached?.byId.get(id)?.rawEventsFile : undefined;
  }

  async latest(gameKey: string): Promise<HistoricalArchive | undefined> {
    return (await this.snapshot()).entries.find(entry => entry.games.some(game => game.key === gameKey));
  }

  private async scan(): Promise<CatalogSnapshot> {
    const entries: HistoricalArchive[] = [];
    const diagnostics: ArchiveDiagnostics = { incomplete: 0, invalid: 0, unsafe: 0, oversized: 0, unreadable: 0 };
    try {
      if (!(await lstat(this.exportsRoot)).isDirectory()) throw new CatalogIssue("unsafe");
      // Async directory iteration and serial bounded metadata reads leave receipt
      // processing free to run; status polling never calls the catalog at all.
      for await (const directory of await opendir(this.exportsRoot)) {
        if (directory.isSymbolicLink()) { diagnostics.unsafe++; continue; }
        if (!directory.isDirectory()) continue;
        if (!safeArchiveId(directory.name)) { diagnostics.unsafe++; continue; }
        try { entries.push(await readArchive(this.exportsRoot, directory.name)); }
        catch (error) { diagnostics[error instanceof CatalogIssue ? error.kind : "unreadable"]++; }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics[error instanceof CatalogIssue ? error.kind : "unreadable"]++;
    }
    entries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
    return { entries, byId: new Map(entries.map(entry => [entry.id, entry])), diagnostics, scannedAtMs: Date.now() };
  }
}
