import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listJournalSegments } from "./journal.js";
import { assertJournalRecord } from "./journal-reader.js";
import { JOURNAL_SEGMENT_PATTERN, readJournalSegmentSuffix } from "./journal-segments.js";
import { compressJournalAliases, type CompressionAlias } from "./journal-compression-file.js";

export interface CompressionResult {
  originalBytes: number;
  compressedBytes: number;
  sha256: string;
  aliases: string[];
}
export interface CompressionProgress extends CompressionResult {
  phase: "verified" | "published" | "complete";
}
export interface JournalCompressionOptions {
  roots: readonly string[];
  activeRunDirectory?: string;
  maxSegments?: number;
  signal?: AbortSignal;
  onProgress?: (event: CompressionProgress) => void | Promise<void>;
}
export interface JournalCompressionReport {
  compressedSegments: number;
  replacedAliases: number;
  originalBytes: number;
  compressedBytes: number;
  logicalBytesSaved: number;
  skipped: Array<{ path: string; reason: string }>;
}

export async function compactJournalStorage(options: JournalCompressionOptions): Promise<JournalCompressionReport> {
  const result: JournalCompressionReport = { compressedSegments: 0, replacedAliases: 0, originalBytes: 0, compressedBytes: 0, logicalBytesSaved: 0, skipped: [] };
  const maximum = options.maxSegments ?? Number.MAX_SAFE_INTEGER;
  if (!options.roots.length || !Number.isSafeInteger(maximum) || maximum < 1) throw new Error("COMPRESSION_OPTIONS_INVALID");
  const groups = new Map<string, CompressionAlias[]>(), directories = new Set<string>(), visited = new Set<string>();
  const roots = [...new Set(options.roots.map(root => resolve(root)))];
  const physicalRoots = new Set<string>();
  const forbidden = new Set([await realpath(homedir()), await realpath(process.cwd())]);
  const activeDirectory = options.activeRunDirectory ? await realpath(options.activeRunDirectory) : undefined;
  for (const root of roots) {
    if (root === dirname(root) || root === resolve(homedir()) || root === resolve(process.cwd())) throw new Error("COMPRESSION_PATH_INVALID: broad root forbidden");
    const rootStamp = await lstat(root);
    if (!rootStamp.isDirectory()) throw new Error("COMPRESSION_PATH_INVALID: symlink/non-directory root");
    const physicalRoot = await realpath(root);
    if (forbidden.has(physicalRoot)) throw new Error("COMPRESSION_PATH_INVALID: broad physical root forbidden");
    if (physicalRoots.has(physicalRoot)) continue;
    physicalRoots.add(physicalRoot);
    const walk = async (directory: string): Promise<void> => {
      options.signal?.throwIfAborted();
      const stamp = await lstat(directory);
      if (!stamp.isDirectory()) throw new Error("COMPRESSION_PATH_INVALID: directory changed");
      const identity = `${stamp.dev}:${stamp.ino}`;
      if (visited.has(identity)) return; visited.add(identity);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) { result.skipped.push({ path, reason: "symlink path is not owned raw storage" }); continue; }
        if (entry.isDirectory()) await walk(path);
        else if (JOURNAL_SEGMENT_PATTERN.test(entry.name)) {
          const stamp = await lstat(path);
          if (!stamp.isFile()) throw new Error("COMPRESSION_PATH_INVALID: raw segment is not regular");
          const key = `${stamp.dev}:${stamp.ino}`, aliases = groups.get(key) ?? [];
          aliases.push({ path, root, rootStamp, stamp }); groups.set(key, aliases); directories.add(directory);
        }
      }
    };
    await walk(root);
  }
  const sealed = new Set<string>();
  for (const directory of directories) {
    options.signal?.throwIfAborted();
    const names = await listJournalSegments(directory);
    if (!names.length) continue;
    if (activeDirectory && await realpath(directory) === activeDirectory) {
      for (const name of names.slice(0, -1)) sealed.add(join(directory, name));
      continue;
    }
    try {
      const suffix = await readJournalSegmentSuffix(join(directory, names.at(-1)!), 64 * 1024);
      if (suffix.at(-1) !== 10) continue;
      const start = suffix.lastIndexOf(10, suffix.length - 2) + 1;
      const record: unknown = JSON.parse(suffix.toString("utf8", start, suffix.length - 1));
      assertJournalRecord(record);
      if (record.source === "collector" && (record.kind === "session_end"
        || (record.kind === "checkpoint_end" && (record.data as { sealed?: unknown })?.sealed === true))) {
        for (const name of names) sealed.add(join(directory, name));
      }
    } catch (error) { result.skipped.push({ path: directory, reason: "cannot prove sealed journal: " + String(error) }); }
  }
  for (const aliases of groups.values()) {
    options.signal?.throwIfAborted();
    if (result.compressedSegments >= maximum) break;
    const first = aliases[0]!;
    if (aliases.some(alias => alias.stamp.nlink !== aliases.length)) {
      result.skipped.push({ path: first.path, reason: "unregistered hardlink aliases; original retained" }); continue;
    }
    if (aliases.some(alias => !sealed.has(alias.path))) {
      result.skipped.push({ path: first.path, reason: "not proven sealed (or active tail); original retained" }); continue;
    }
    const compressed = await compressJournalAliases(aliases, options);
    if (!compressed) { result.skipped.push({ path: first.path, reason: "gzip is not smaller; original retained" }); continue; }
    result.compressedSegments++; result.replacedAliases += aliases.length;
    result.originalBytes += compressed.originalBytes; result.compressedBytes += compressed.compressedBytes;
    result.logicalBytesSaved += compressed.originalBytes - compressed.compressedBytes;
  }
  return result;
}
