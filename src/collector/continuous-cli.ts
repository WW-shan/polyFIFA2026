import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadContinuousConfig, type ContinuousConfig } from "./continuous-config.js";
import {
  collectorServiceStatus, startCollectorService, stopCollectorService, type CollectorServiceOptions
} from "./continuous-service.js";

export interface ContinuousCliManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly done: Promise<void>;
  readonly state: { snapshot(): unknown };
}

export interface ContinuousCliDependencies {
  createCollector?: (config: ContinuousConfig) => ContinuousCliManager | Promise<ContinuousCliManager>;
  startCollectorService?: typeof startCollectorService;
  stopCollectorService?: typeof stopCollectorService;
  collectorServiceStatus?: typeof collectorServiceStatus;
  write?: (text: string) => void;
  error?: (text: string) => void;
}

const HELP = `Usage: continuous-cli.ts <run|start|stop|status|help> [options]

  run       Run the continuous public collector in the foreground
  start     Install and start this user's macOS LaunchAgent
  stop      Boot out this user's collector; retain its data and plist
  status    Show service PID, saved-state/data ages, URL, and errors
  help      Show this help (also: run --help, start --help)

  --config PATH       Collector JSON config; defaults when omitted
  --project-dir PATH  Project directory (default: current directory)
  --keep-awake        start only: wrap the collector with caffeinate -i

An omitted start config is saved privately under dataRoot for the LaunchAgent.`;

type Command = "run" | "start" | "stop" | "status" | "help";

function invalid(message: string): never {
  throw new Error(`CONTINUOUS_CLI_ARGUMENTS_INVALID: ${message}`);
}

function parseArgs(argv: readonly string[]): { command: Command; options: CollectorServiceOptions } {
  if (argv.length === 0 || argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) {
    return { command: "help", options: {} };
  }
  const command = argv[0];
  if (command !== "run" && command !== "start" && command !== "stop" && command !== "status") {
    invalid("expected run, start, stop, status, or help");
  }
  let projectDirectory = process.cwd(), configPath: string | undefined, keepAwake = false;
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (seen.has(flag)) invalid("options must not be repeated");
    seen.add(flag);
    if (flag === "--keep-awake") {
      if (command !== "start") invalid("--keep-awake is only valid for start");
      keepAwake = true;
      continue;
    }
    if (flag !== "--config" && flag !== "--project-dir") invalid("unknown option or unexpected argument");
    const value = argv[++index];
    if (value === undefined || !value.trim() || value.startsWith("--") || value.includes("\0")) invalid(`${flag} requires a path`);
    if (flag === "--config") configPath = value;
    else projectDirectory = value;
  }
  projectDirectory = resolve(projectDirectory);
  return { command, options: {
    projectDirectory,
    ...(configPath === undefined ? {} : { configPath: resolve(projectDirectory, configPath) }),
    ...(keepAwake ? { keepAwake: true } : {})
  } };
}

function safeText(text: string): string {
  return text.replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/]*@/gi, "$1[redacted]@");
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "string" ? safeText(item) : item) ?? "null";
}

async function createDefaultCollector(config: ContinuousConfig): Promise<ContinuousCliManager> {
  // Load only for run; service/help commands also work during supervisor integration.
  const modulePath = "./continuous.js";
  const { ContinuousCollector } = await import(modulePath) as {
    ContinuousCollector: new (config: ContinuousConfig) => ContinuousCliManager;
  };
  return new ContinuousCollector(config);
}

async function runManager(manager: ContinuousCliManager, write: (text: string) => void): Promise<void> {
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= Promise.resolve().then(() => manager.stop());
  let stopFailed!: (error: unknown) => void;
  const stopFailure = new Promise<never>((_resolve, reject) => { stopFailed = reject; });
  const completion = Promise.race([manager.done, stopFailure]);
  // done can reject while startup is still pending or failing.
  void completion.catch(() => {});
  const onSignal = (): void => { void stop().catch(stopFailed); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await Promise.race([Promise.resolve().then(() => manager.start()), stopFailure]);
    write(json(manager.state.snapshot()));
    await completion;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await stop();
  }
}

export async function runContinuousCli(
  argv: readonly string[] = process.argv.slice(2),
  deps: ContinuousCliDependencies = {}
): Promise<number> {
  const write = deps.write ?? ((text: string) => { process.stdout.write(`${text}\n`); });
  const report = deps.error ?? ((text: string) => { process.stderr.write(`${text}\n`); });
  try {
    const parsed = parseArgs(argv);
    if (parsed.command === "help") { write(HELP); return 0; }
    switch (parsed.command) {
      case "start": {
        await loadContinuousConfig(parsed.options.configPath, parsed.options.projectDirectory);
        write(json(await (deps.startCollectorService ?? startCollectorService)(parsed.options)));
        break;
      }
      case "stop": write(json(await (deps.stopCollectorService ?? stopCollectorService)(parsed.options))); break;
      case "status": write(json(await (deps.collectorServiceStatus ?? collectorServiceStatus)(parsed.options))); break;
      case "run": {
        const config = await loadContinuousConfig(parsed.options.configPath, parsed.options.projectDirectory);
        await runManager(await (deps.createCollector ?? createDefaultCollector)(config), write);
        break;
      }
    }
    return 0;
  } catch (error) {
    report(safeText(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void runContinuousCli().then(code => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
}
