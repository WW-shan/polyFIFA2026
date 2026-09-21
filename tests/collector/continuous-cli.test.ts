import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runContinuousCli, type ContinuousCliDependencies, type ContinuousCliManager } from "../../src/collector/continuous-cli.js";
import type { ContinuousConfig } from "../../src/collector/continuous-config.js";
import type { CollectorServiceOptions, CollectorServiceStatus } from "../../src/collector/continuous-service.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function manager() {
  const completion = deferred();
  const runtime = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => { completion.resolve(); }),
    done: completion.promise,
    state: { snapshot: vi.fn(() => ({ pid: 4321, port: 8765, mode: "collecting" })) }
  } satisfies ContinuousCliManager;
  return { runtime, completion };
}

function dependencies(runtime = manager().runtime) {
  const output: string[] = [], errors: string[] = [];
  const started = { status: "started" as const, label: "com.polyfifa.public-collector", plistPath: "/fixture/service.plist", configPath: "/fixture/config.json", dataRoot: "/fixture/data", url: "http://127.0.0.1:8765", pid: 4321 };
  const status: CollectorServiceStatus = {
    label: started.label, plistPath: started.plistPath, installed: true, loaded: true, running: true,
    pid: 4321, statePid: 4321, dataRoot: started.dataRoot, url: started.url, updatedAtMs: 1000,
    stateAgeMs: 0, lastRecordAtMs: 900, dataAgeMs: 100, stale: false, errors: []
  };
  const createCollector = vi.fn((_config: ContinuousConfig) => runtime);
  const start = vi.fn(async (_options?: CollectorServiceOptions) => started);
  const stop = vi.fn(async (_options?: CollectorServiceOptions) => ({ status: "stopped" as const, label: started.label, plistPath: started.plistPath }));
  const inspect = vi.fn(async (_options?: CollectorServiceOptions) => status);
  const deps: ContinuousCliDependencies = {
    createCollector, startCollectorService: start, stopCollectorService: stop, collectorServiceStatus: inspect,
    write: text => output.push(text), error: text => errors.push(text)
  };
  return { deps, output, errors, createCollector, start, stop, inspect, status };
}

async function configFile(overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "poly-fifa-cli-"));
  temporaryDirectories.push(directory);
  const project = join(directory, "project with spaces"), dataRoot = join(directory, "data");
  await mkdir(join(project, "settings"), { recursive: true });
  const path = join(project, "settings", "continuous.json");
  await writeFile(path, JSON.stringify({ dataRoot, ...overrides }));
  return { project, dataRoot, path, args: ["--config", "settings/continuous.json", "--project-dir", project] };
}

function signals() {
  return { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
}

describe("continuous CLI", () => {
  test("supports help after a script's run prefix without starting a manager", async () => {
    const output: string[] = [];
    const result = await runContinuousCli(["run", "--help"], {
      createCollector() { throw new Error("help must not create a manager"); },
      write: text => output.push(text), error() {}
    });
    expect(result).toBe(0);
    expect(output.join("\n")).toContain("run");
    expect(output.join("\n")).toContain("start");
    expect(output.join("\n")).toContain("--config");
  });

  test.each([
    [], ["help"], ["--help"], ["start", "--help"], ["stop", "--help"], ["status", "--help"],
    ["start", "--config", "/missing/config.json", "--help"]
  ].map(argv => ({ argv })))("shows help without loading config or invoking services: $argv", async ({ argv }) => {
    const input = dependencies(), before = signals();
    expect(await runContinuousCli(argv, input.deps)).toBe(0);
    expect(input.output.join("\n")).toContain("--project-dir");
    expect(input.errors).toEqual([]);
    expect(input.createCollector).not.toHaveBeenCalled();
    expect(input.start).not.toHaveBeenCalled();
    expect(input.stop).not.toHaveBeenCalled();
    expect(input.inspect).not.toHaveBeenCalled();
    expect(signals()).toEqual(before);
  });

  test.each(["start", "stop", "status"])("dispatches %s with config paths resolved after the project argument", async command => {
    const config = await configFile(), input = dependencies();
    expect(await runContinuousCli([command, ...config.args], input.deps)).toBe(0);
    const selected = command === "start" ? input.start : command === "stop" ? input.stop : input.inspect;
    expect(selected).toHaveBeenCalledExactlyOnceWith({ configPath: config.path, projectDirectory: config.project });
    expect(input.createCollector).not.toHaveBeenCalled();
    expect([input.start, input.stop, input.inspect].filter(operation => operation.mock.calls.length)).toHaveLength(1);
    expect(JSON.parse(input.output[0]!)).toMatchObject({ label: "com.polyfifa.public-collector" });
  });

  test("passes --keep-awake only to service start", async () => {
    const config = await configFile(), input = dependencies();
    expect(await runContinuousCli(["start", ...config.args, "--keep-awake"], input.deps)).toBe(0);
    expect(input.start).toHaveBeenCalledExactlyOnceWith({ configPath: config.path, projectDirectory: config.project, keepAwake: true });
  });

  test.each([
    ["unknown"], ["start", "--unknown"], ["run", "--config"], ["run", "--config", "--project-dir", "project"],
    ["status", "--project-dir"], ["start", "--project-dir", " "], ["start", "--config", " "],
    ["run", "--keep-awake"], ["start", "unexpected"], ["start", "--config", "a", "--config", "b"]
  ].map(argv => ({ argv })))("rejects invalid arguments before dispatch: $argv", async ({ argv }) => {
    const input = dependencies();
    expect(await runContinuousCli(argv, input.deps)).toBe(1);
    expect(input.errors.join("\n")).toContain("CONTINUOUS_CLI_ARGUMENTS_INVALID");
    expect(input.start).not.toHaveBeenCalled();
    expect(input.stop).not.toHaveBeenCalled();
    expect(input.inspect).not.toHaveBeenCalled();
    expect(input.createCollector).not.toHaveBeenCalled();
  });

  test.each(["run", "start"])("validates the real config before the %s branch", async command => {
    const config = await configFile({ proxyUrl: "socks5://proxy-user:proxy-secret@localhost:1080" });
    const input = dependencies();
    expect(await runContinuousCli([command, ...config.args], input.deps)).toBe(1);
    expect(input.errors.join("\n")).toContain("CONTINUOUS_CONFIG_INVALID");
    expect(input.errors.join("\n")).not.toContain("proxy-secret");
    expect(input.errors.join("\n")).not.toContain("proxy-user");
    expect(input.createCollector).not.toHaveBeenCalled();
    expect(input.start).not.toHaveBeenCalled();
    expect(input.stop).not.toHaveBeenCalled();
    expect(input.inspect).not.toHaveBeenCalled();
  });

  test.each(["stop", "status"].flatMap(command => ["malformed", "missing"].map(kind => ({ command, kind }))))(
    "dispatches $command with a $kind config so the service can inspect ownership", async ({ command, kind }) => {
      const config = await configFile(), input = dependencies();
      if (kind === "missing") await unlink(config.path);
      else await writeFile(config.path, '{"proxyUrl":"proxy-secret",broken');
      if (command === "status") {
        input.status.stale = true;
        input.status.errors.push("CONTINUOUS_SERVICE_CONFIG_INVALID");
      }
      expect(await runContinuousCli([command, ...config.args], input.deps)).toBe(0);
      const selected = command === "stop" ? input.stop : input.inspect;
      expect(selected).toHaveBeenCalledExactlyOnceWith({ configPath: config.path, projectDirectory: config.project });
      expect(input.createCollector).not.toHaveBeenCalled();
      expect(input.errors).toEqual([]);
      if (command === "status") expect(JSON.parse(input.output[0]!)).toMatchObject({ pid: 4321, stale: true });
    }
  );

  test("reports external service failure with a nonzero result and redacted credentials", async () => {
    const config = await configFile(), input = dependencies();
    input.start.mockRejectedValueOnce(new Error("failed through http://proxy-user:proxy-secret@localhost"));
    expect(await runContinuousCli(["start", ...config.args], input.deps)).toBe(1);
    expect(input.output).toEqual([]);
    expect(input.errors.join("\n")).toContain("failed through");
    expect(input.errors.join("\n")).not.toContain("proxy-secret");
    expect(input.errors.join("\n")).not.toContain("proxy-user");
  });

  test("awaits startup and done, publishes state, and always stops and removes its handlers", async () => {
    const config = await configFile({ port: 9000 }), controlled = manager(), input = dependencies(controlled.runtime), before = signals();
    const running = runContinuousCli(["run", ...config.args], input.deps);
    await vi.waitFor(() => expect(controlled.runtime.start).toHaveBeenCalledOnce());
    expect(input.createCollector.mock.calls[0]?.[0]).toMatchObject({ dataRoot: config.dataRoot, port: 9000 });
    expect(controlled.runtime.stop).not.toHaveBeenCalled();
    expect(process.listenerCount("SIGINT")).toBe(before.SIGINT.length + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM.length + 1);
    controlled.completion.resolve();
    expect(await running).toBe(0);
    expect(controlled.runtime.stop).toHaveBeenCalledOnce();
    expect(controlled.runtime.state.snapshot).toHaveBeenCalled();
    // The startup line is a summary: the full snapshot is megabytes of game,
    // token and market ids, and the LaunchAgent appends stdout to a log file.
    const startup = JSON.parse(input.output[0]!);
    expect(startup).toMatchObject({ pid: 4321, games: expect.any(Number) });
    expect(startup.games).not.toBeInstanceOf(Array);
    expect(input.output[0]!.length).toBeLessThan(2000);
    expect(signals()).toEqual(before);
  });

  test("uses default config without reading a trading environment file", async () => {
    const config = await configFile(), controlled = manager(), input = dependencies(controlled.runtime);
    vi.stubEnv("CONTINUOUS_CLI_ENV_MARKER", undefined);
    await writeFile(join(config.project, ".env"), "CONTINUOUS_CLI_ENV_MARKER=must-not-load\n");
    controlled.completion.resolve();
    expect(await runContinuousCli(["run", "--project-dir", config.project], input.deps)).toBe(0);
    expect(input.createCollector.mock.calls[0]?.[0]).toMatchObject({ dataRoot: join(config.project, "data/collector/continuous"), port: 8765 });
    expect(process.env.CONTINUOUS_CLI_ENV_MARKER).toBeUndefined();
  });

  test.each(["SIGINT", "SIGTERM"] as const)("handles repeated %s by stopping once and retaining other handlers", async signal => {
    const config = await configFile(), controlled = manager(), input = dependencies(controlled.runtime), before = signals();
    const running = runContinuousCli(["run", ...config.args], input.deps);
    await vi.waitFor(() => expect(controlled.runtime.start).toHaveBeenCalledOnce());
    const handler = process.listeners(signal).find(listener => !before[signal].includes(listener));
    expect(handler).toBeDefined();
    handler!(signal);
    handler!(signal);
    expect(await running).toBe(0);
    expect(controlled.runtime.stop).toHaveBeenCalledOnce();
    expect(signals()).toEqual(before);
  });

  test("handles a signal during startup and still performs final cleanup", async () => {
    const config = await configFile(), controlled = manager(), input = dependencies(controlled.runtime), before = signals();
    const startup = deferred();
    controlled.runtime.start.mockImplementation(() => startup.promise);
    controlled.runtime.stop.mockImplementation(async () => { startup.resolve(); controlled.completion.resolve(); });
    const running = runContinuousCli(["run", ...config.args], input.deps);
    await vi.waitFor(() => expect(controlled.runtime.start).toHaveBeenCalledOnce());
    const handler = process.listeners("SIGTERM").find(listener => !before.SIGTERM.includes(listener));
    expect(handler).toBeDefined();
    handler!("SIGTERM");
    expect(await running).toBe(0);
    expect(controlled.runtime.stop).toHaveBeenCalledOnce();
    expect(signals()).toEqual(before);
  });

  test("handles simultaneous startup and done rejection without an unhandled rejection", async () => {
    const config = await configFile(), controlled = manager(), input = dependencies(controlled.runtime), before = signals();
    controlled.runtime.start.mockImplementation(async () => {
      controlled.completion.reject(new Error("done also rejected"));
      throw new Error("startup failed");
    });
    expect(await runContinuousCli(["run", ...config.args], input.deps)).toBe(1);
    expect(input.errors.join("\n")).toContain("startup failed");
    expect(controlled.runtime.stop).toHaveBeenCalledOnce();
    expect(signals()).toEqual(before);
  });

  test("cleans up and exits nonzero when done rejects", async () => {
    const config = await configFile(), controlled = manager(), input = dependencies(controlled.runtime), before = signals();
    const running = runContinuousCli(["run", ...config.args], input.deps);
    await vi.waitFor(() => expect(controlled.runtime.start).toHaveBeenCalledOnce());
    controlled.completion.reject(new Error("collector failed"));
    expect(await running).toBe(1);
    expect(input.errors.join("\n")).toContain("collector failed");
    expect(controlled.runtime.stop).toHaveBeenCalledOnce();
    expect(signals()).toEqual(before);
  });

  test("exits nonzero when a signal's stop fails even while done remains pending", async () => {
    const config = await configFile(), controlled = manager(), input = dependencies(controlled.runtime), before = signals();
    controlled.runtime.stop.mockRejectedValue(new Error("stop failed via http://proxy-user:proxy-secret@localhost"));
    const running = runContinuousCli(["run", ...config.args], input.deps);
    await vi.waitFor(() => expect(controlled.runtime.start).toHaveBeenCalledOnce());
    const handler = process.listeners("SIGINT").find(listener => !before.SIGINT.includes(listener));
    expect(handler).toBeDefined();
    handler!("SIGINT");
    expect(await running).toBe(1);
    expect(input.errors.join("\n")).toContain("stop failed");
    expect(input.errors.join("\n")).not.toContain("proxy-secret");
    expect(controlled.runtime.stop).toHaveBeenCalledOnce();
    expect(signals()).toEqual(before);
  });

  test("does not expose credentials embedded in status output", async () => {
    const config = await configFile(), input = dependencies();
    input.status.errors.push("request failed http://proxy-user:proxy-secret@localhost");
    expect(await runContinuousCli(["status", ...config.args], input.deps)).toBe(0);
    expect(input.output.join("\n")).not.toContain("proxy-secret");
    expect(input.output.join("\n")).not.toContain("proxy-user");
  });

  test("can be imported without running a CLI command or loading the manager", async () => {
    const cli = fileURLToPath(new URL("../../src/collector/continuous-cli.ts", import.meta.url));
    const result = await promisify(execFile)(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(cli).href)});`
    ], { timeout: 5000 });
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
