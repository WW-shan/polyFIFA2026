import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { promisify } from "node:util";
import { continuousConfig, loadContinuousConfig, type ContinuousConfig } from "./continuous-config.js";
import { readCaptureState } from "./continuous-storage.js";

export interface CollectorServiceOptions {
  configPath?: string;
  projectDirectory?: string;
  keepAwake?: boolean;
}

export interface CollectorServiceDependencies {
  homeDir?: string;
  platform?: NodeJS.Platform;
  uid?: number;
  nodePath?: string;
  execFile?: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
  now?: () => number;
}

export interface CollectorServiceStartResult {
  status: "started" | "already_running";
  label: string;
  plistPath: string;
  configPath: string;
  dataRoot: string;
  url: string;
  pid: number | null;
}

export interface CollectorServiceStopResult {
  status: "stopped" | "not_running";
  label: string;
  plistPath: string;
}

export interface CollectorServiceStatus {
  label: string;
  plistPath: string;
  installed: boolean;
  loaded: boolean | null;
  /** Presence of the launchctl job PID; saved collector state is checked separately. */
  running: boolean | null;
  pid: number | null;
  statePid: number | null;
  mode?: string | null;
  stateIdentity?: "job" | "descendant" | "unverified";
  dataRoot: string;
  url: string;
  updatedAtMs: number | null;
  stateAgeMs: number | null;
  lastRecordAtMs: number | null;
  dataAgeMs: number | null;
  stale: boolean;
  errors: string[];
}

const LABEL = "com.polyfifa.public-collector";
/**
 * Marker that records an *intentional* stop.
 *
 * The health watchdog restarts a publisher that stopped on its own, but an
 * operator who runs `collect:stop` - and the documented `repair-tail` workflow
 * that requires a stopped collector - must stay stopped. The marker is what
 * separates "died" from "asked to stop"; `start` clears it again.
 */
export const STOP_MARKER_NAME = ".collector-stopped";
const OWNER_KEY = "PolyFifaPublicCollector";
const execFileAsync = promisify(nodeExecFile);
const CURRENT_MODES = new Set(["starting", "collecting", "restarting", "paused_disk"]);
const MAX_PROCESS_ANCESTORS = 16;

interface Definition {
  version: 1;
  projectDirectory: string;
  configPath: string;
  dataRoot: string;
  port: number;
  nodePath: string;
  keepAwake: boolean;
}

function fail(code: string, message: string): never {
  const error = new Error(`${code}: ${message}`);
  error.name = code;
  throw error;
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function safeText(text: string): string {
  return text.replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/]*@/gi, "$1[redacted]@");
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 0x7fff_ffff;
}

function xml(value: string): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
  return value.replace(/[&<>"']/g, character => entities[character]!);
}

function programArguments(definition: Definition): string[] {
  return [
    ...(definition.keepAwake ? ["/usr/bin/caffeinate", "-i"] : []),
    definition.nodePath, "--import", "tsx", join(definition.projectDirectory, "src/collector/continuous-cli.ts"),
    "run", "--config", definition.configPath, "--project-dir", definition.projectDirectory
  ];
}

function renderPlist(definition: Definition): string {
  const entry = (key: string, value: string) => `  <key>${key}</key><string>${xml(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    entry("Label", LABEL), entry(OWNER_KEY, JSON.stringify(definition)),
    "  <key>ProgramArguments</key><array>",
    ...programArguments(definition).map(argument => `    <string>${xml(argument)}</string>`),
    "  </array>", entry("WorkingDirectory", definition.projectDirectory),
    "  <key>RunAtLoad</key><true/>", "  <key>KeepAlive</key><true/>",
    "  <key>ThrottleInterval</key><integer>30</integer>", "  <key>Umask</key><integer>63</integer>",
    entry("StandardOutPath", join(definition.dataRoot, "logs/stdout.log")),
    entry("StandardErrorPath", join(definition.dataRoot, "logs/stderr.log")),
    "</dict></plist>", ""
  ].join("\n");
}

async function readServiceFile(path: string): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    fail("CONTINUOUS_SERVICE_FOREIGN", "cannot safely read the service file");
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) fail("CONTINUOUS_SERVICE_FOREIGN", "unrecognized service file");
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== stat.size) fail("CONTINUOUS_SERVICE_FOREIGN", "service file changed while reading");
    return buffer.toString("utf8", 0, length);
  } finally { await file.close(); }
}

async function ownedPlist(path: string): Promise<{ text: string; definition: Definition } | undefined> {
  const text = await readServiceFile(path);
  if (text === undefined) return undefined;
  try {
    const encoded = new RegExp(`<key>${OWNER_KEY}</key><string>([^<]*)</string>`).exec(text)?.[1];
    if (encoded === undefined) throw new Error();
    const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    const value: unknown = JSON.parse(encoded.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => entities[entity]!));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const definition = value as Definition;
    if (Object.keys(value).length !== 7 || definition.version !== 1 || typeof definition.keepAwake !== "boolean"
      || !Number.isSafeInteger(definition.port) || definition.port < 1 || definition.port > 65535
      || ![definition.projectDirectory, definition.configPath, definition.dataRoot, definition.nodePath].every(validPath)
      || renderPlist(definition) !== text) throw new Error();
    return { text, definition };
  } catch { fail("CONTINUOUS_SERVICE_FOREIGN", "the existing plist is not a recognized collector LaunchAgent"); }
}

async function context(options: CollectorServiceOptions, deps: CollectorServiceDependencies) {
  if ((deps.platform ?? process.platform) !== "darwin") fail("CONTINUOUS_SERVICE_PLATFORM_UNSUPPORTED", "user LaunchAgents require macOS");
  const uid = deps.uid ?? process.getuid?.();
  const homeDir = deps.homeDir ?? homedir(), nodePath = deps.nodePath ?? process.execPath;
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 1 || uid > 0x7fff_ffff
    || !validPath(homeDir) || homeDir === parse(homeDir).root || !validPath(nodePath)
    || (options.projectDirectory !== undefined && (typeof options.projectDirectory !== "string" || !options.projectDirectory.trim()))
    || (options.keepAwake !== undefined && typeof options.keepAwake !== "boolean")) {
    fail("CONTINUOUS_SERVICE_ENVIRONMENT_INVALID", "expected a user UID, absolute home/node paths, and valid service options");
  }
  const projectDirectory = resolve(options.projectDirectory ?? process.cwd());
  if (!validPath(projectDirectory)) {
    fail("CONTINUOUS_SERVICE_ENVIRONMENT_INVALID", "service paths must not contain control characters");
  }
  const execFile: NonNullable<CollectorServiceDependencies["execFile"]> = deps.execFile ?? (async (file, args) => {
    const result = await execFileAsync(file, [...args], {
      encoding: "utf8", timeout: file === "/bin/ps" ? 1000 : 10_000,
      maxBuffer: file === "/bin/ps" ? 1024 : 1024 * 1024
    });
    return { stdout: result.stdout, stderr: result.stderr };
  });
  return { projectDirectory, nodePath, execFile, domain: `gui/${uid}`, target: `gui/${uid}/${LABEL}`,
    plistPath: join(homeDir, "Library/LaunchAgents", `${LABEL}.plist`), now: deps.now ?? Date.now };
}

type Context = Awaited<ReturnType<typeof context>>;

function serviceDefinition(ctx: Context, options: CollectorServiceOptions, config: ContinuousConfig): Definition {
  const definition: Definition = {
    version: 1, projectDirectory: ctx.projectDirectory,
    configPath: options.configPath === undefined ? join(config.dataRoot, "service-config.json") : resolve(ctx.projectDirectory, options.configPath),
    dataRoot: config.dataRoot, port: config.port, nodePath: ctx.nodePath, keepAwake: options.keepAwake ?? false
  };
  if (![definition.configPath, definition.dataRoot].every(validPath)) {
    fail("CONTINUOUS_SERVICE_ENVIRONMENT_INVALID", "service paths must not contain control characters");
  }
  return definition;
}

async function startContext(options: CollectorServiceOptions, deps: CollectorServiceDependencies) {
  const ctx = await context(options, deps);
  const config = await loadContinuousConfig(options.configPath, ctx.projectDirectory);
  return { ...ctx, config, definition: serviceDefinition(ctx, options, config) };
}

interface Job { path: string | null; pid: number | null }

function absentJob(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === "string" && stderr.includes("Could not find service") && stderr.includes(`"${LABEL}"`);
}

function commandFailed(command: string): never {
  // execFile errors may echo arguments, environment information, or credentials.
  fail("CONTINUOUS_SERVICE_COMMAND_FAILED", `launchctl ${command} failed`);
}

async function inspectJob(ctx: Context): Promise<Job | undefined> {
  let stdout: string;
  try { ({ stdout } = await ctx.execFile("/bin/launchctl", ["print", ctx.target])); }
  catch (error) { if (absentJob(error)) return undefined; commandFailed("print"); }
  const path = /^\s*path = (.+)$/m.exec(stdout)?.[1]?.trim().replace(/^"(.*)"$/, "$1") ?? null;
  const value = /^\s*pid = (\d+)\s*$/m.exec(stdout)?.[1];
  const pid = value === undefined ? null : Number(value);
  return { path, pid: validPid(pid) ? pid : null };
}

async function isDescendant(ctx: Context, childPid: number, jobPid: number): Promise<boolean> {
  if (!validPid(childPid) || !validPid(jobPid)) return false;
  const seen = new Set<number>();
  let pid = childPid;
  for (let depth = 0; depth < MAX_PROCESS_ANCESTORS; depth += 1) {
    if (pid === 1 || seen.has(pid)) return false;
    seen.add(pid);
    let stdout: string;
    try { ({ stdout } = await ctx.execFile("/bin/ps", ["-p", String(pid), "-o", "ppid="])); }
    catch { return false; }
    const value = stdout.trim();
    if (!/^\d+$/.test(value)) return false;
    const parent = Number(value);
    if (!validPid(parent)) return false;
    if (parent === jobPid) return true;
    pid = parent;
  }
  return false;
}

function requireOwnedJob(ctx: Context, job: Job | undefined, owned: Awaited<ReturnType<typeof ownedPlist>>): void {
  if (job && (!owned || job.path !== ctx.plistPath)) fail("CONTINUOUS_SERVICE_FOREIGN", "the loaded label is not the recognized user LaunchAgent");
}

async function installPlist(ctx: Awaited<ReturnType<typeof startContext>>, previous: Awaited<ReturnType<typeof ownedPlist>>): Promise<void> {
  const text = renderPlist(ctx.definition);
  if (previous?.text === text) return;
  if (!previous) {
    try { await writeFile(ctx.plistPath, text, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (hasCode(error, "EEXIST")) fail("CONTINUOUS_SERVICE_FOREIGN", "a plist appeared during installation"); throw error; }
    return;
  }
  const temporary = join(dirname(ctx.plistPath), `.${LABEL}.${randomUUID()}.tmp`);
  await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
  try {
    if ((await ownedPlist(ctx.plistPath))?.text !== previous.text) fail("CONTINUOUS_SERVICE_FOREIGN", "the plist changed during installation");
    await rename(temporary, ctx.plistPath);
  } finally {
    await unlink(temporary).catch(error => { if (!hasCode(error, "ENOENT")) throw error; });
  }
}

function startResult(ctx: Context, definition: Definition, status: CollectorServiceStartResult["status"], pid: number | null): CollectorServiceStartResult {
  return { status, label: LABEL, plistPath: ctx.plistPath, configPath: definition.configPath,
    dataRoot: definition.dataRoot, url: `http://127.0.0.1:${definition.port}`, pid };
}

export async function startCollectorService(
  options: CollectorServiceOptions = {},
  deps: CollectorServiceDependencies = {}
): Promise<CollectorServiceStartResult> {
  const ctx = await startContext(options, deps), owned = await ownedPlist(ctx.plistPath), job = await inspectJob(ctx);
  requireOwnedJob(ctx, job, owned);
  if (job) return startResult(ctx, owned!.definition, "already_running", job.pid);

  await mkdir(join(ctx.definition.dataRoot, "logs"), { recursive: true, mode: 0o700 });
  // An explicit start is the operator taking the collector back off the shelf.
  await clearStopMarker(ctx.definition.dataRoot);
  if (options.configPath === undefined) {
    const content = JSON.stringify(ctx.config, null, 2) + "\n";
    try { await writeFile(ctx.definition.configPath, content, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (await readServiceFile(ctx.definition.configPath) !== content) fail("CONTINUOUS_SERVICE_CONFIG_CONFLICT", "the generated config path already contains different data; use --config");
    }
  }
  await mkdir(dirname(ctx.plistPath), { recursive: true, mode: 0o700 });
  await installPlist(ctx, owned);
  try { await ctx.execFile("/bin/launchctl", ["bootstrap", ctx.domain, ctx.plistPath]); }
  catch { commandFailed("bootstrap"); }
  const started = await inspectJob(ctx);
  requireOwnedJob(ctx, started, { text: renderPlist(ctx.definition), definition: ctx.definition });
  if (!started) fail("CONTINUOUS_SERVICE_START_FAILED", "the collector label was not loaded after bootstrap");
  return startResult(ctx, ctx.definition, "started", started.pid);
}

export async function stopCollectorService(
  options: CollectorServiceOptions = {},
  deps: CollectorServiceDependencies = {}
): Promise<CollectorServiceStopResult> {
  const ctx = await context(options, deps), owned = await ownedPlist(ctx.plistPath), job = await inspectJob(ctx);
  requireOwnedJob(ctx, job, owned);
  // Record the intent before the job disappears, so a watchdog cycle that runs
  // between the bootout and the next poll cannot mistake it for a crash.
  const dataRoot = owned?.definition.dataRoot
    ?? (await loadContinuousConfig(options.configPath, ctx.projectDirectory)).dataRoot;
  await writeStopMarker(dataRoot, deps.now ?? Date.now);
  if (!job) return { status: "not_running", label: LABEL, plistPath: ctx.plistPath };
  try { await ctx.execFile("/bin/launchctl", ["bootout", ctx.target]); }
  catch (error) { if (!absentJob(error)) commandFailed("bootout"); }
  return { status: "stopped", label: LABEL, plistPath: ctx.plistPath };
}

async function writeStopMarker(dataRoot: string, now: () => number): Promise<void> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(dataRoot, STOP_MARKER_NAME), JSON.stringify({ stoppedAtMs: now(), pid: process.pid }) + "\n", { mode: 0o600 });
}

async function clearStopMarker(dataRoot: string): Promise<void> {
  try { await unlink(join(dataRoot, STOP_MARKER_NAME)); }
  catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
}

export async function collectorServiceStatus(
  options: CollectorServiceOptions = {},
  deps: CollectorServiceDependencies = {}
): Promise<CollectorServiceStatus> {
  const ctx = await context(options, deps), errors: string[] = [];
  let owned: Awaited<ReturnType<typeof ownedPlist>>, job: Job | undefined;
  let loaded: boolean | null = null;
  try { owned = await ownedPlist(ctx.plistPath); }
  catch { errors.push("CONTINUOUS_SERVICE_FOREIGN: unrecognized service plist"); }
  try {
    job = await inspectJob(ctx);
    requireOwnedJob(ctx, job, owned);
    loaded = job !== undefined;
  } catch (error) { job = undefined; errors.push(safeText(error instanceof Error ? error.message : String(error))); }
  // Inspection and stop must remain available after an edited config breaks.
  let config: ContinuousConfig | undefined;
  try {
    if (owned) {
      if (options.configPath !== undefined) await loadContinuousConfig(options.configPath, ctx.projectDirectory);
      config = await loadContinuousConfig(owned.definition.configPath, owned.definition.projectDirectory);
    } else {
      config = await loadContinuousConfig(options.configPath, ctx.projectDirectory);
    }
  } catch {
    errors.push("CONTINUOUS_SERVICE_CONFIG_INVALID: unable to read the collector configuration");
  }
  const definition = owned?.definition ?? serviceDefinition(ctx, {}, config ?? continuousConfig({}, ctx.projectDirectory));
  const pulseIntervalMs = config?.pulseIntervalMs;
  const result: CollectorServiceStatus = {
    label: LABEL, plistPath: ctx.plistPath, installed: owned !== undefined, loaded,
    running: loaded === null ? null : job?.pid != null, pid: job?.pid ?? null, statePid: null,
    mode: null, stateIdentity: "unverified",
    dataRoot: definition.dataRoot, url: `http://127.0.0.1:${definition.port}`,
    updatedAtMs: null, stateAgeMs: null, lastRecordAtMs: null, dataAgeMs: null, stale: true, errors
  };
  try {
    const state = await readCaptureState(result.dataRoot);
    if (!state) { errors.push("CONTINUOUS_SERVICE_STATE_MISSING: no collector state has been written"); return result; }
    result.mode = typeof state.mode === "string" ? safeText(state.mode).slice(0, 64) : null;
    if (state.dataRoot !== result.dataRoot || !validPid(state.pid)
      || !Number.isSafeInteger(state.port) || state.port < 1 || state.port > 65535) throw new Error();
    const now = ctx.now();
    const validTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= now;
    if (!validTime(state.updatedAtMs) || (state.lastRecordAtMs !== null && !validTime(state.lastRecordAtMs))) throw new Error();
    result.statePid = state.pid;
    result.url = `http://127.0.0.1:${state.port}`;
    result.updatedAtMs = state.updatedAtMs;
    result.stateAgeMs = now - state.updatedAtMs;
    result.lastRecordAtMs = state.lastRecordAtMs;
    result.dataAgeMs = state.lastRecordAtMs === null ? null : now - state.lastRecordAtMs;
    const activeMode = CURRENT_MODES.has(state.mode);
    const fresh = pulseIntervalMs !== undefined && result.stateAgeMs <= pulseIntervalMs * 3;
    if (!activeMode) errors.push("CONTINUOUS_SERVICE_STATE_INACTIVE: saved collector mode is not active");
    if (pulseIntervalMs !== undefined && !fresh) errors.push("CONTINUOUS_SERVICE_STATE_STALE: saved collector state is too old");
    if (result.running === true && validPid(result.pid) && activeMode && fresh) {
      if (result.pid === state.pid) result.stateIdentity = "job";
      else if (definition.keepAwake && await isDescendant(ctx, state.pid, result.pid)) result.stateIdentity = "descendant";
      else errors.push("CONTINUOUS_SERVICE_STATE_IDENTITY_UNVERIFIED: saved collector PID is not verified under the current job");
    }
    // A verified process and current state file do not prove capture is advancing.
    const dataStale = state.mode === "collecting" && (result.dataAgeMs === null || result.dataAgeMs > 60_000);
    if (dataStale) errors.push("CONTINUOUS_SERVICE_DATA_STALE: collecting without a recent journal record");
    result.stale = result.stateIdentity === "unverified" || dataStale;
    for (const error of state.errors.slice(-50)) {
      if (typeof error?.scope !== "string" || typeof error.message !== "string") throw new Error();
      errors.push(safeText(`${error.scope}: ${error.message}`).slice(0, 2000));
    }
  } catch {
    result.stale = true;
    errors.push("CONTINUOUS_SERVICE_STATE_INVALID: unable to read a valid collector state");
  }
  return result;
}
