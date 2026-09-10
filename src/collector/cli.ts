import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createCollector, type CollectorOptions, type CollectorRuntime } from "./collector.js";
import { exportRun, type ExportOptions, type ExportResult } from "./export.js";

export type ParsedCollectorCliArgs =
  | { command: "collect"; options: CollectorOptions }
  | { command: "export"; options: ExportOptions };

export interface CollectorCliDependencies {
  createCollector?: (options: CollectorOptions) => CollectorRuntime;
  exportRun?: (options: ExportOptions) => Promise<ExportResult>;
  write?: (text: string) => void;
  error?: (text: string) => void;
}

function invalid(message: string): Error {
  return new Error(`CLI_ARGUMENTS_INVALID: ${message}`);
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw invalid(`${flag} requires a value`);
  return value;
}

function numberValue(value: string, flag: string, allowZero = true): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) throw invalid(`${flag} must be ${allowZero ? "nonnegative" : "positive"}`);
  return parsed;
}

function integerValue(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw invalid(`${flag} must be a positive integer`);
  return parsed;
}

function listValue(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function parseCollectorCliArgs(argv: readonly string[]): ParsedCollectorCliArgs {
  const command = argv[0];
  if (command !== "collect" && command !== "export") throw invalid("first argument must be collect or export");
  if (command === "export") return parseExportArgs(argv.slice(1));
  return parseCollectArgs(argv.slice(1));
}

function parseCollectArgs(argv: readonly string[]): { command: "collect"; options: CollectorOptions } {
  const options: CollectorOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--root-dir": options.rootDir = requireValue(argv, index++, flag); break;
      case "--run-id": options.runId = requireValue(argv, index++, flag); break;
      case "--gamma-base-url": options.gammaBaseUrl = requireValue(argv, index++, flag); break;
      case "--clob-base-url": options.clobBaseUrl = requireValue(argv, index++, flag); break;
      case "--clob-ws-url": options.clobWsUrl = requireValue(argv, index++, flag); break;
      case "--sports-ws-url": options.sportsWsUrl = requireValue(argv, index++, flag); break;
      case "--proxy-url": options.proxyUrl = requireValue(argv, index++, flag); break;
      case "--tag-id": options.tagId = requireValue(argv, index++, flag); break;
      case "--sports": options.sports = listValue(requireValue(argv, index++, flag)); break;
      case "--event-slugs": options.eventSlugs = listValue(requireValue(argv, index++, flag)); break;
      case "--lookback-hours": options.lookbackHours = numberValue(requireValue(argv, index++, flag), flag); break;
      case "--ahead-hours": options.aheadHours = numberValue(requireValue(argv, index++, flag), flag); break;
      case "--duration-seconds": options.durationSeconds = numberValue(requireValue(argv, index++, flag), flag); break;
      case "--discovery-interval-ms": options.discoveryIntervalMs = integerValue(requireValue(argv, index++, flag), flag); break;
      case "--snapshot-interval-ms": options.snapshotIntervalMs = integerValue(requireValue(argv, index++, flag), flag); break;
      case "--snapshot-concurrency": options.snapshotConcurrency = integerValue(requireValue(argv, index++, flag), flag); break;
      case "--http-timeout-ms": options.httpTimeoutMs = integerValue(requireValue(argv, index++, flag), flag); break;
      case "--page-size": options.pageSize = integerValue(requireValue(argv, index++, flag), flag); break;
      case "--max-pages": options.maxPages = integerValue(requireValue(argv, index++, flag), flag); break;
      case "--max-tokens-per-socket": options.maxTokensPerSocket = integerValue(requireValue(argv, index++, flag), flag); break;
      case "--max-segment-bytes": options.maxSegmentBytes = integerValue(requireValue(argv, index++, flag), flag); break;
      case "--max-buffer-bytes": options.maxBufferBytes = integerValue(requireValue(argv, index++, flag), flag); break;
      case "--all-open": options.allOpen = true; break;
      case "--help": throw invalid("help is not a collection run; see README.md");
      default: throw invalid(`unknown option ${String(flag)}`);
    }
  }
  return { command: "collect", options };
}

function parseExportArgs(argv: readonly string[]): { command: "export"; options: ExportOptions } {
  let runDirectory: string | undefined;
  let outputDirectory: string | undefined;
  let overwrite = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--run-dir":
      case "--run-directory": runDirectory = requireValue(argv, index++, flag); break;
      case "--output-dir": outputDirectory = requireValue(argv, index++, flag); break;
      case "--overwrite": overwrite = true; break;
      default: throw invalid(`unknown option ${String(flag)}`);
    }
  }
  if (!runDirectory) throw invalid("export requires --run-dir");
  const options: ExportOptions = { runDirectory };
  if (outputDirectory !== undefined) options.outputDirectory = outputDirectory;
  if (overwrite) options.overwrite = true;
  return { command: "export", options };
}

export async function runCollectorCli(argv = process.argv.slice(2), dependencies: CollectorCliDependencies = {}): Promise<unknown> {
  const write = dependencies.write ?? ((text: string) => process.stdout.write(`${text}\n`));
  const report = dependencies.error ?? ((text: string) => process.stderr.write(`${text}\n`));
  try {
    const parsed = parseCollectorCliArgs(argv);
    if (parsed.command === "export") {
      const result = await (dependencies.exportRun ?? exportRun)(parsed.options);
      write(JSON.stringify(result));
      return result;
    }

    const runtime = (dependencies.createCollector ?? createCollector)(parsed.options);
    const onSignal = (): void => {
      // run() observes the same completion and reports a cleanup failure once.
      void runtime.stop().catch(() => {});
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      const result = await runtime.run();
      write(JSON.stringify(result));
      return result;
    } finally {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  } catch (error) {
    process.exitCode = 1;
    report(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    throw error;
  }
}

export async function main(): Promise<void> {
  await runCollectorCli();
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
