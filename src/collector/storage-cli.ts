import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compactJournalStorage } from "./journal-compression.js";
import { openCompactTailStore } from "./continuous-tail-store.js";
import { exportCompactMatch } from "./compact-export.js";
import { loadRawEventIndex } from "./raw-event-index.js";

export interface StorageCliResult { exitCode: number; stdout: string; stderr: string }
const help = `Verified public journal compression
  compact --root PATH [--root OTHER_PATH] --replace-verified
          [--active-run PATH] [--max-segments N] [--quiet]

Only proven sealed segments are replaced. Every raw/checkpoint hardlink must
be included in the roots. Existing unequal files, symlinks and active tails
are never overwritten. Exact original bytes can be restored from gzip.
--active-run is for the owning supervisor; it excludes that run's last segment.

Compact tail export
  export-tail --data-root PATH --output-dir NEW_PATH [--game-key KEY ...]
          [--window-seconds N] [--limit N] [--json]

--window-seconds is the holding window; the archive also includes the preceding
one-second entry reference. Turns finalized compact tails back into replayable archives (manifest.json,
quality.json, seconds.ndjson, changes.ndjson) that 'npm run research:books'
accepts as --archive-dir. Compact storage keeps order books in SQLite instead of
the raw journal, so without this step a collected match cannot be backtested.

Compact tail repair
  repair-tail --data-root PATH [--apply] [--json]

Rewrites tails written before per-frame attribution: keeps only the frames a
match actually owns, drops records holding nothing of its own, re-anchors old
book-quiet boundaries on the last active book, and records the true window
coverage. Without --apply it reports what would change and writes
nothing. The collector must be stopped first; an exclusive lock is enforced by
the collector, not by this command.
`;

export async function runStorageCli(args: readonly string[], options: { signal?: AbortSignal; progress?: (line: string) => void } = {}): Promise<StorageCliResult> {
  if (!args.length || args.includes("--help") || args[0] === "help") return { exitCode: 0, stdout: help, stderr: "" };
  try {
    if (args[0] === "repair-tail") {
      let dataRoot: string | undefined, apply = false;
      const seen = new Set<string>();
      for (let index = 1; index < args.length; index++) {
        const flag = args[index]!;
        if (seen.has(flag)) throw new Error("STORAGE_CLI_INVALID: duplicate " + flag);
        seen.add(flag);
        if (flag === "--apply") { apply = true; continue; }
        if (flag === "--json") continue;
        if (flag !== "--data-root") throw new Error("STORAGE_CLI_INVALID: unknown " + flag);
        const value = args[++index];
        if (!value || value.startsWith("--") || value.includes("\0")) throw new Error("STORAGE_CLI_INVALID: missing/invalid value for " + flag);
        dataRoot = resolve(value);
      }
      if (!dataRoot) throw new Error("STORAGE_CLI_INVALID: --data-root is required");
      options.signal?.throwIfAborted();
      const store = await openCompactTailStore({ dataRoot, tailWindowMs: 181_000, bufferMs: 30_000,
        retentionMs: 30 * 24 * 3600_000, maxBytes: 8 * 1024 ** 3 });
      try {
        const report = store.repairAttribution({ apply });
        return { exitCode: 0, stdout: JSON.stringify({ type: "tail-repair", applied: apply, ...report }) + "\n", stderr: "" };
      } finally { store.close(); }
    }
    if (args[0] === "export-tail") {
      const values = new Map<string, string[]>();
      for (let index = 1; index < args.length; index++) {
        const flag = args[index]!;
        if (flag === "--json") { values.set("--json", []); continue; }
        if (!["--data-root", "--output-dir", "--game-key", "--window-seconds", "--limit"].includes(flag)) {
          throw new Error("STORAGE_CLI_INVALID: unknown " + flag);
        }
        const value = args[++index];
        if (!value || value.startsWith("--") || value.includes("\0")) throw new Error("STORAGE_CLI_INVALID: missing/invalid value for " + flag);
        values.set(flag, [...(values.get(flag) ?? []), value]);
      }
      const dataRoot = values.get("--data-root")?.at(-1);
      const outputDirectory = values.get("--output-dir")?.at(-1);
      if (!dataRoot) throw new Error("STORAGE_CLI_INVALID: --data-root is required");
      if (!outputDirectory) throw new Error("STORAGE_CLI_INVALID: --output-dir is required");
      const windowSeconds = values.get("--window-seconds")?.at(-1);
      const limitText = values.get("--limit")?.at(-1);
      const limit = limitText === undefined ? undefined : Number(limitText);
      if (limit !== undefined && (!/^[1-9]\d*$/.test(limitText!) || !Number.isSafeInteger(limit))) throw new Error("STORAGE_CLI_INVALID: --limit must be a positive integer");
      options.signal?.throwIfAborted();
      const store = await openCompactTailStore({ dataRoot, tailWindowMs: 181_000, bufferMs: 30_000,
        retentionMs: 30 * 24 * 3600_000, maxBytes: 8 * 1024 ** 3 });
      try {
        const requested = values.get("--game-key");
        const targets = requested ?? store.listFinalizedMatches().map(match => match.gameKey).slice(0, limit ?? undefined);
        // Identity for matches finalized before it was stored with the tail is
        // recovered from whatever raw runs survive, so older data stays usable.
        let rawIndex: Map<string, Record<string, unknown>> | undefined;
        const results: Array<Record<string, unknown>> = [];
        for (const gameKey of targets) {
          options.signal?.throwIfAborted();
          const directory = join(resolve(outputDirectory), gameKey.replace(/[^A-Za-z0-9._-]+/g, "_"));
          try {
            const fallback = store.readMatchMetadata(gameKey) === null
              ? (rawIndex ??= await loadRawEventIndex(join(dataRoot, "runs"))).get(gameKey)
              : undefined;
            const result = await exportCompactMatch(store, gameKey, {
              outputDirectory: directory, ...(windowSeconds === undefined ? {} : { windowSeconds: Number(windowSeconds) }),
              ...(fallback === undefined ? {} : { metadataOverride: fallback })
            });
            results.push({ gameKey, outputDirectory: result.archive.outputDirectory, records: result.records,
              anchorFrames: result.anchorFrames, windowComplete: result.windowComplete,
              missingFrontMs: result.missingFrontMs, largestGapMs: result.largestGapMs,
              finishAnchor: result.finishAnchor,
              tokens: result.archive.summary.tokens.length, readyTokens: result.archive.summary.tokens.filter(token => token.readyForReplay).length });
          } catch (error) {
            results.push({ gameKey, error: error instanceof Error ? error.message : String(error) });
          }
        }
        const exported = results.filter(row => row.error === undefined).length;
        return { exitCode: results.length === exported ? 0 : 1,
          stdout: JSON.stringify({ type: "tail-export", exported, failed: results.length - exported, results }) + "\n", stderr: "" };
      } finally { store.close(); }
    }
    if (args[0] !== "compact") throw new Error("STORAGE_CLI_INVALID: expected compact, repair-tail, export-tail or --help");
    const roots: string[] = [];
    let replacement = false, quiet = false, activeRunDirectory: string | undefined, maxSegments: number | undefined;
    const seen = new Set<string>();
    for (let index = 1; index < args.length; index++) {
      const flag = args[index]!;
      if (flag !== "--root" && seen.has(flag)) throw new Error("STORAGE_CLI_INVALID: duplicate " + flag);
      seen.add(flag);
      if (flag === "--replace-verified") { replacement = true; continue; }
      if (flag === "--quiet") { quiet = true; continue; }
      if (!["--root", "--active-run", "--max-segments"].includes(flag)) throw new Error("STORAGE_CLI_INVALID: unknown " + flag);
      const value = args[++index];
      if (!value || value.startsWith("--") || value.includes("\0")) throw new Error("STORAGE_CLI_INVALID: missing/invalid value for " + flag);
      if (flag === "--root") roots.push(resolve(value));
      else if (flag === "--active-run") activeRunDirectory = resolve(value);
      else {
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("STORAGE_CLI_INVALID: --max-segments must be positive");
        maxSegments = Number(value);
      }
    }
    if (!roots.length || !replacement) throw new Error("STORAGE_CLI_INVALID: explicit --root and --replace-verified are required");
    options.signal?.throwIfAborted();
    const report = await compactJournalStorage({ roots, ...(activeRunDirectory ? { activeRunDirectory } : {}),
      ...(maxSegments === undefined ? {} : { maxSegments }), ...(options.signal ? { signal: options.signal } : {}),
      onProgress: event => { if (!quiet && event.phase === "complete") options.progress?.(JSON.stringify({ type: "compressed-segment", ...event }) + "\n"); }
    });
    return { exitCode: 0, stdout: JSON.stringify({ type: "compression-summary", ...report }) + "\n", stderr: "" };
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: (error instanceof Error ? error.message : String(error)) + "\n" };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = (): void => controller.abort(new Error("STORAGE_COMPRESSION_STOPPED"));
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  void runStorageCli(process.argv.slice(2), { signal: controller.signal, progress: line => { process.stdout.write(line); } })
    .then(result => { process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.exitCode; })
    .finally(() => { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); });
}
