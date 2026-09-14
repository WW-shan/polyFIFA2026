import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compactJournalStorage } from "./journal-compression.js";

export interface StorageCliResult { exitCode: number; stdout: string; stderr: string }
const help = `Verified public journal compression
  compact --root PATH [--root OTHER_PATH] --replace-verified
          [--active-run PATH] [--max-segments N] [--quiet]

Only proven sealed segments are replaced. Every raw/checkpoint hardlink must
be included in the roots. Existing unequal files, symlinks and active tails
are never overwritten. Exact original bytes can be restored from gzip.
--active-run is for the owning supervisor; it excludes that run's last segment.
`;

export async function runStorageCli(args: readonly string[], options: { signal?: AbortSignal; progress?: (line: string) => void } = {}): Promise<StorageCliResult> {
  if (!args.length || args.includes("--help") || args[0] === "help") return { exitCode: 0, stdout: help, stderr: "" };
  try {
    if (args[0] !== "compact") throw new Error("STORAGE_CLI_INVALID: expected compact or --help");
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
