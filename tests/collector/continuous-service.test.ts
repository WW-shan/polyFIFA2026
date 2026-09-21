import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  collectorServiceStatus, startCollectorService, stopCollectorService,
  type CollectorServiceDependencies, type CollectorServiceOptions
} from "../../src/collector/continuous-service.js";
import type { ContinuousStatus } from "../../src/collector/continuous-state.js";

const label = "com.polyfifa.public-collector";
const target = `gui/501/${label}`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(input: Record<string, unknown> = {}, projectName = "project with spaces") {
  const directory = await mkdtemp(join(tmpdir(), "poly-fifa-service-"));
  temporaryDirectories.push(directory);
  const projectDirectory = join(directory, projectName);
  const homeDir = join(directory, "test home");
  const dataRoot = join(directory, "data");
  const configPath = join(projectDirectory, "settings", "continuous.json");
  const plistPath = join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
  await mkdir(join(projectDirectory, "settings"), { recursive: true });
  await writeFile(configPath, JSON.stringify({ dataRoot, ...input }));
  const calls: Array<{ file: string; args: string[] }> = [];
  const job: { path: string | null; pid: number | null } = { path: null, pid: 4321 };
  const failures = new Map<string, Error>();
  const parents = new Map<number, string | Error>();
  const deps: CollectorServiceDependencies = {
    homeDir, platform: "darwin", uid: 501, nodePath: "/node with spaces/bin/node", now: () => 50_000,
    execFile: async (file, args) => {
      calls.push({ file, args: [...args] });
      if (file === "/bin/ps") {
        expect(args).toEqual(["-p", expect.stringMatching(/^\d+$/), "-o", "ppid="]);
        const parent = parents.get(Number(args[1]));
        if (parent instanceof Error) throw parent;
        if (parent === undefined) throw Object.assign(new Error("process gone"), { code: 1 });
        return { stdout: parent, stderr: "" };
      }
      if (file !== "/bin/launchctl") throw new Error("Unexpected executable in fixture");
      const failure = failures.get(args[0]!);
      if (failure) throw failure;
      if (args[0] === "print") {
        if (job.path === null) throw Object.assign(new Error("unloaded"), {
          code: 113, stderr: `Could not find service "${label}" in domain for user gui:501`
        });
        return { stdout: `${target} = {\n path = ${job.path}\n state = ${job.pid === null ? "waiting" : "running"}\n${job.pid === null ? "" : ` pid = ${job.pid}\n`}}\n`, stderr: "" };
      }
      if (args[0] === "bootstrap") job.path = args[2]!;
      else if (args[0] === "bootout") job.path = null;
      else throw new Error("Unexpected launchctl command in fixture");
      return { stdout: "", stderr: "" };
    }
  };
  const options: CollectorServiceOptions = { projectDirectory, configPath };
  return { directory, projectDirectory, homeDir, dataRoot, configPath, plistPath, calls, job, failures, parents, deps, options };
}

function argumentsIn(plist: string): string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
  expect(array).toBeDefined();
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return [...array!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match =>
    match[1]!.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => entities[entity]!)
  );
}

async function saveState(input: Awaited<ReturnType<typeof fixture>>, overrides: Partial<ContinuousStatus> = {}) {
  const state: ContinuousStatus = {
    schemaVersion: 1, instanceId: "test-instance", pid: 4321, startedAtMs: 1000, updatedAtMs: 45_000,
    dataRoot: input.dataRoot, port: 8765, mode: "collecting", runId: "run-1", runDirectory: join(input.dataRoot, "runs/run-1"),
    receivedRecords: 10, lastRecordAtMs: 42_000, freeBytes: 30 * 1024 ** 3, rawBytes: 10_000, queuedBytes: 0,
    desiredTokens: 4, games: [], connections: [], errors: [], ...overrides
  };
  await mkdir(input.dataRoot, { recursive: true });
  await writeFile(join(input.dataRoot, "state.json"), JSON.stringify(state));
  return state;
}

describe("continuous user service", () => {
  test("installs and bootstraps the user's collector with explicit project and config arguments", async () => {
    const input = await fixture();

    const result = await startCollectorService(input.options, input.deps);

    expect(result).toMatchObject({ status: "started", label, plistPath: input.plistPath, configPath: input.configPath, dataRoot: input.dataRoot, pid: 4321 });
    const plist = await readFile(input.plistPath, "utf8");
    for (const value of [input.projectDirectory, input.configPath, join(input.projectDirectory, "src/collector/continuous-cli.ts"), "--import", "tsx", "--project-dir"])
      expect(plist).toContain(`<string>${value}</string>`);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>[1-9]\d*<\/integer>/);
    expect(input.calls.map(call => call.args)).toEqual([
      ["print", target], ["bootstrap", "gui/501", input.plistPath], ["print", target]
    ]);
    expect(argumentsIn(plist)).toEqual([
      input.deps.nodePath, "--import", "tsx", join(input.projectDirectory, "src/collector/continuous-cli.ts"),
      "run", "--config", input.configPath, "--project-dir", input.projectDirectory
    ]);
    expect(plist).toMatch(new RegExp(`<key>WorkingDirectory</key>\\s*<string>${input.projectDirectory}</string>`));
    expect(plist).toContain(`<string>${join(input.dataRoot, "logs", "stdout.log")}</string>`);
    expect(plist).toContain(`<string>${join(input.dataRoot, "logs", "stderr.log")}</string>`);
    expect((await lstat(input.plistPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(input.dataRoot, "logs"))).mode & 0o777).toBe(0o700);
    expect(plist).not.toContain("EnvironmentVariables");
  });

  test("escapes XML while keeping paths and shell metacharacters as literal arguments", async () => {
    const input = await fixture({}, 'project & <tag> "quoted" $(nothing)');
    await startCollectorService(input.options, input.deps);
    const plist = await readFile(input.plistPath, "utf8");
    expect(plist).toContain("&amp;");
    expect(plist).toContain("&lt;tag&gt;");
    expect(argumentsIn(plist)).toContain(input.projectDirectory);
    expect(argumentsIn(plist)).toContain(input.configPath);
    expect(input.calls.every(call => call.file === "/bin/launchctl" && Array.isArray(call.args))).toBe(true);
  });

  test("optionally wraps only this collector with caffeinate -i", async () => {
    const input = await fixture();
    await startCollectorService({ ...input.options, keepAwake: true }, input.deps);
    const args = argumentsIn(await readFile(input.plistPath, "utf8"));
    expect(args.slice(0, 4)).toEqual(["/usr/bin/caffeinate", "-i", input.deps.nodePath, "--import"]);
    expect(args).not.toContain("-s");
    expect(input.calls.every(call => call.file === "/bin/launchctl")).toBe(true);
  });

  test("persists private validated defaults when no explicit config was supplied", async () => {
    const input = await fixture();
    const result = await startCollectorService({ projectDirectory: input.projectDirectory }, input.deps);
    const root = join(input.projectDirectory, "data/collector/continuous");
    expect(result.dataRoot).toBe(root);
    expect(dirname(result.configPath)).toBe(root);
    expect(JSON.parse(await readFile(result.configPath, "utf8"))).toMatchObject({ dataRoot: root, port: 8765 });
    expect((await lstat(result.configPath)).mode & 0o777).toBe(0o600);
    expect(argumentsIn(await readFile(input.plistPath, "utf8"))).toContain(result.configPath);
  });

  test("resolves the configured data root against the config file directory", async () => {
    const input = await fixture({ dataRoot: "../captures" });
    const result = await startCollectorService(input.options, input.deps);
    expect(result.dataRoot).toBe(join(input.projectDirectory, "captures"));
    expect(await readdir(join(result.dataRoot, "logs"))).toEqual([]);
  });

  test("returns already_running without rewriting or restarting an owned active job", async () => {
    const input = await fixture();
    await startCollectorService(input.options, input.deps);
    const text = await readFile(input.plistPath, "utf8"), stamp = await lstat(input.plistPath);
    const anotherConfig = join(input.projectDirectory, "another.json"), anotherRoot = join(input.directory, "unused-data");
    await writeFile(anotherConfig, JSON.stringify({ dataRoot: anotherRoot, port: 9000 }));
    input.calls.length = 0;

    const result = await startCollectorService({ ...input.options, configPath: anotherConfig, keepAwake: true }, input.deps);

    expect(result).toMatchObject({ status: "already_running", pid: 4321, dataRoot: input.dataRoot, configPath: input.configPath });
    expect(input.calls.map(call => call.args)).toEqual([["print", target]]);
    expect(await readFile(input.plistPath, "utf8")).toBe(text);
    expect((await lstat(input.plistPath)).mtimeMs).toBe(stamp.mtimeMs);
    await expect(lstat(anotherRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("leaves a loaded job's restart throttling in effect even without a current PID", async () => {
    const input = await fixture();
    await startCollectorService(input.options, input.deps);
    input.job.pid = null;
    input.calls.length = 0;
    expect(await startCollectorService(input.options, input.deps)).toMatchObject({ status: "already_running", pid: null });
    expect(input.calls.map(call => call.args)).toEqual([["print", target]]);
  });

  test("updates a recognized inactive plist and boots it without touching other jobs", async () => {
    const input = await fixture();
    await startCollectorService(input.options, input.deps);
    await stopCollectorService(input.options, input.deps);
    input.calls.length = 0;
    expect(await startCollectorService({ ...input.options, keepAwake: true }, input.deps)).toMatchObject({ status: "started" });
    expect(argumentsIn(await readFile(input.plistPath, "utf8"))[0]).toBe("/usr/bin/caffeinate");
    expect(input.calls.map(call => call.args)).toEqual([["print", target], ["bootstrap", "gui/501", input.plistPath], ["print", target]]);
  });

  test.each([{ name: "start", operation: startCollectorService }, { name: "stop", operation: stopCollectorService }])(
    "$name rejects a foreign plist and preserves its bytes", async ({ operation }) => {
      const input = await fixture();
      await mkdir(dirname(input.plistPath), { recursive: true });
      const foreign = '<plist><dict><key>Label</key><string>another.service</string></dict></plist>';
      await writeFile(input.plistPath, foreign);
      await expect(operation(input.options, input.deps)).rejects.toThrow("CONTINUOUS_SERVICE_FOREIGN");
      expect(await readFile(input.plistPath, "utf8")).toBe(foreign);
      expect(input.calls).toEqual([]);
      await expect(lstat(input.dataRoot)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  test("rejects a modified owned marker when the actual program no longer matches", async () => {
    const input = await fixture();
    await startCollectorService(input.options, input.deps);
    const modified = (await readFile(input.plistPath, "utf8")).replace("<string>run</string>", "<string>foreign</string>");
    await writeFile(input.plistPath, modified);
    input.calls.length = 0;
    await expect(startCollectorService(input.options, input.deps)).rejects.toThrow("CONTINUOUS_SERVICE_FOREIGN");
    expect(await readFile(input.plistPath, "utf8")).toBe(modified);
    expect(input.calls).toEqual([]);
  });

  test("rejects a plist symlink without following or overwriting its target", async () => {
    const input = await fixture(), foreign = join(input.directory, "foreign.plist");
    await mkdir(dirname(input.plistPath), { recursive: true });
    await writeFile(foreign, "foreign bytes");
    await symlink(foreign, input.plistPath);
    await expect(startCollectorService(input.options, input.deps)).rejects.toThrow("CONTINUOUS_SERVICE_FOREIGN");
    expect(await readFile(foreign, "utf8")).toBe("foreign bytes");
    expect((await lstat(input.plistPath)).isSymbolicLink()).toBe(true);
    expect(input.calls).toEqual([]);
  });

  test("rejects an already-loaded label without a recognized owned plist", async () => {
    const input = await fixture();
    input.job.path = join(input.directory, "foreign.plist");
    await expect(startCollectorService(input.options, input.deps)).rejects.toThrow("CONTINUOUS_SERVICE_FOREIGN");
    expect(input.calls.map(call => call.args)).toEqual([["print", target]]);
    await expect(lstat(input.homeDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses to boot out a label loaded from a different plist", async () => {
    const input = await fixture();
    await startCollectorService(input.options, input.deps);
    input.job.path = join(input.directory, "foreign.plist");
    input.calls.length = 0;
    await expect(stopCollectorService(input.options, input.deps)).rejects.toThrow("CONTINUOUS_SERVICE_FOREIGN");
    expect(input.calls.map(call => call.args)).toEqual([["print", target]]);
  });

  test.each([{ port: 0 }, { dataRoot: "/" }, { profiles: [] }, { proxyUrl: "socks5://proxy-user:proxy-secret@localhost:1080" }])(
    "validates configuration before creating any service files: %j", async config => {
      const input = await fixture(config);
      const result = startCollectorService(input.options, input.deps);
      await expect(result).rejects.toThrow("CONTINUOUS_CONFIG_INVALID");
      await expect(result).rejects.not.toThrow("proxy-secret");
      expect(input.calls).toEqual([]);
      await expect(lstat(input.homeDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(input.dataRoot)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  test.each([
    { override: { platform: "linux" }, code: "CONTINUOUS_SERVICE_PLATFORM_UNSUPPORTED" },
    ...[{ uid: 0 }, { uid: -1 }, { uid: 1.5 }, { nodePath: "node" }].map(override => ({ override, code: "CONTINUOUS_SERVICE_ENVIRONMENT_INVALID" }))
  ])(
    "rejects an invalid user service environment before writing: $override", async ({ override, code }) => {
      const input = await fixture();
      await expect(startCollectorService(input.options, { ...input.deps, ...override } as CollectorServiceDependencies))
        .rejects.toThrow(code);
      expect(input.calls).toEqual([]);
      await expect(lstat(input.homeDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  test("does not mistake an inspection failure for an unloaded job", async () => {
    const input = await fixture();
    input.failures.set("print", Object.assign(new Error("http://proxy-user:proxy-secret@localhost refused"), { code: "EACCES" }));
    const result = startCollectorService(input.options, input.deps);
    await expect(result).rejects.toThrow("CONTINUOUS_SERVICE_COMMAND_FAILED");
    await expect(result).rejects.not.toThrow("proxy-secret");
    expect(input.calls.map(call => call.args)).toEqual([["print", target]]);
    await expect(lstat(input.homeDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports a bootstrap failure and allows retry of its recognized inactive plist", async () => {
    const input = await fixture();
    input.failures.set("bootstrap", new Error("bootstrap failed http://proxy-user:proxy-secret@localhost"));
    const result = startCollectorService(input.options, input.deps);
    await expect(result).rejects.toThrow("CONTINUOUS_SERVICE_COMMAND_FAILED");
    await expect(result).rejects.not.toThrow("proxy-secret");
    input.failures.delete("bootstrap");
    expect(await startCollectorService(input.options, input.deps)).toMatchObject({ status: "started" });
  });

  test("stops only the owned label and retains its plist, config, logs, and raw data", async () => {
    const input = await fixture();
    await startCollectorService(input.options, input.deps);
    const original = await readFile(input.plistPath, "utf8");
    await writeFile(join(input.dataRoot, "raw.ndjson"), "original raw data\n");
    input.calls.length = 0;
    expect(await stopCollectorService(input.options, input.deps)).toEqual({ status: "stopped", label, plistPath: input.plistPath });
    expect(input.calls.map(call => call.args)).toEqual([["print", target], ["bootout", target]]);
    expect(await readFile(input.plistPath, "utf8")).toBe(original);
    expect(await readFile(join(input.dataRoot, "raw.ndjson"), "utf8")).toBe("original raw data\n");
    expect((await lstat(input.configPath)).isFile()).toBe(true);
    expect((await lstat(join(input.dataRoot, "logs"))).isDirectory()).toBe(true);
    input.calls.length = 0;
    expect(await stopCollectorService(input.options, input.deps)).toMatchObject({ status: "not_running" });
    expect(input.calls.map(call => call.args)).toEqual([["print", target]]);
  });

  test("records an intentional stop and clears it on the next start", async () => {
    const input = await fixture();
    const marker = join(input.dataRoot, ".collector-stopped");
    await startCollectorService(input.options, input.deps);
    // A start clears any earlier marker so the watchdog resumes supervising.
    await expect(lstat(marker)).rejects.toThrow();
    expect(await stopCollectorService(input.options, input.deps)).toMatchObject({ status: "stopped" });
    const stopped = JSON.parse(await readFile(marker, "utf8")) as { stoppedAtMs: number };
    expect(stopped.stoppedAtMs).toBe(50_000);
    // Stopping again keeps the marker, and starting removes it.
    expect(await stopCollectorService(input.options, input.deps)).toMatchObject({ status: "not_running" });
    expect((await lstat(marker)).isFile()).toBe(true);
    await startCollectorService(input.options, input.deps);
    await expect(lstat(marker)).rejects.toThrow();
  });

  test.each(["malformed", "missing"])("stops an owned active job with a %s config", async kind => {
    const input = await fixture();
    await startCollectorService(input.options, input.deps);
    await saveState(input);
    const plist = await readFile(input.plistPath, "utf8");
    if (kind === "missing") await unlink(input.configPath);
    else await writeFile(input.configPath, '{"proxyUrl":"proxy-secret",broken');
    input.calls.length = 0;

    expect(await stopCollectorService(input.options, input.deps)).toMatchObject({ status: "stopped" });

    expect(input.calls.map(call => call.args)).toEqual([["print", target], ["bootout", target]]);
    expect(await readFile(input.plistPath, "utf8")).toBe(plist);
    expect((await lstat(join(input.dataRoot, "state.json"))).isFile()).toBe(true);
  });

  test("retains the foreign-job guard when stop's config is missing", async () => {
    const input = await fixture();
    await startCollectorService(input.options, input.deps);
    await unlink(input.configPath);
    input.job.path = join(input.directory, "foreign.plist");
    input.calls.length = 0;
    await expect(stopCollectorService(input.options, input.deps)).rejects.toThrow("CONTINUOUS_SERVICE_FOREIGN");
    expect(input.calls.map(call => call.args)).toEqual([["print", target]]);
  });
});

describe("read-only continuous service status", () => {
  test.each(["malformed", "missing"])("inspects an owned active job and its data root with a %s config", async kind => {
    const input = await fixture();
    await startCollectorService(input.options, input.deps);
    await saveState(input);
    if (kind === "missing") await unlink(input.configPath);
    else await writeFile(input.configPath, '{"proxyUrl":"proxy-secret",broken');
    input.calls.length = 0;

    const result = await collectorServiceStatus(input.options, input.deps);

    expect(result).toMatchObject({ loaded: true, pid: 4321, dataRoot: input.dataRoot, stateAgeMs: 5000, dataAgeMs: 8000, stale: true });
    expect(result.errors.join(" ")).toContain("CONFIG_INVALID");
    expect(result.errors.join(" ")).not.toContain("proxy-secret");
    expect(input.calls.map(call => call.args)).toEqual([["print", target]]);
  });

  test("does not trust a foreign job when status's config is malformed", async () => {
    const input = await fixture();
    await startCollectorService(input.options, input.deps);
    await saveState(input);
    await writeFile(input.configPath, "broken config");
    input.job.path = join(input.directory, "foreign.plist");
    input.calls.length = 0;
    const result = await collectorServiceStatus(input.options, input.deps);
    expect(result).toMatchObject({ loaded: null, running: null, pid: null, stale: true });
    expect(result.errors.join(" ")).toContain("FOREIGN");
    expect(input.calls.map(call => call.args)).toEqual([["print", target]]);
  });

  test("combines launchctl PID with state and data freshness without changing files", async () => {
    const input = await fixture();
    await startCollectorService(input.options, input.deps);
    await saveState(input, { errors: [{ atMs: 44_000, scope: "http", message: "failed via https://proxy-user:proxy-secret@localhost" }] });
    const before = await lstat(join(input.dataRoot, "state.json")), plist = await readFile(input.plistPath, "utf8");
    input.calls.length = 0;
    const result = await collectorServiceStatus(input.options, input.deps);
    expect(result).toMatchObject({
      installed: true, loaded: true, running: true, pid: 4321, statePid: 4321,
      dataRoot: input.dataRoot, url: "http://127.0.0.1:8765", updatedAtMs: 45_000, stateAgeMs: 5000,
      lastRecordAtMs: 42_000, dataAgeMs: 8000, stale: false
    });
    expect(result.errors.join(" ")).toContain("failed via");
    expect(JSON.stringify(result)).not.toContain("proxy-secret");
    expect(JSON.stringify(result)).not.toContain("proxy-user");
    expect(input.calls.map(call => call.args)).toEqual([["print", target]]);
    expect((await lstat(join(input.dataRoot, "state.json"))).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(input.plistPath, "utf8")).toBe(plist);
  });

  test("reports missing state and an absent job without creating directories", async () => {
    const input = await fixture();
    const result = await collectorServiceStatus(input.options, input.deps);
    expect(result).toMatchObject({ installed: false, loaded: false, running: false, pid: null, statePid: null, stateAgeMs: null, dataAgeMs: null, stale: true });
    expect(result.errors.join(" ")).toContain("STATE_MISSING");
    await expect(lstat(input.homeDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(input.dataRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not report a persisted PID as a currently running service", async () => {
    const input = await fixture();
    await saveState(input);
    const result = await collectorServiceStatus(input.options, input.deps);
    expect(result).toMatchObject({ loaded: false, running: false, pid: null, statePid: 4321, stale: true });
  });

  test.each([{ updatedAtMs: 10_000 }, { pid: 9999 }])("marks old or different-process state as stale: %j", async overrides => {
    const input = await fixture();
    await startCollectorService(input.options, input.deps);
    await saveState(input, overrides);
    expect(await collectorServiceStatus(input.options, input.deps)).toMatchObject({ stale: true });
  });

  test("distinguishes the caffeinate wrapper PID from its collector PID", async () => {
    const input = await fixture();
    await startCollectorService({ ...input.options, keepAwake: true }, input.deps);
    await saveState(input, { pid: 4322 });
    input.parents.set(4322, " 4321\n");
    input.calls.length = 0;
    expect(await collectorServiceStatus(input.options, input.deps)).toMatchObject({
      pid: 4321, statePid: 4322, stale: false, stateIdentity: "descendant", mode: "collecting"
    });
    expect(input.calls).toEqual([
      { file: "/bin/launchctl", args: ["print", target] },
      { file: "/bin/ps", args: ["-p", "4322", "-o", "ppid="] }
    ]);
  });

  test("verifies a genuine descendant through a bounded PPID chain", async () => {
    const input = await fixture();
    await startCollectorService({ ...input.options, keepAwake: true }, input.deps);
    await saveState(input, { pid: 4323 });
    input.parents.set(4323, "4322\n");
    input.parents.set(4322, "4321\n");
    input.calls.length = 0;
    expect(await collectorServiceStatus(input.options, input.deps)).toMatchObject({ stale: false, stateIdentity: "descendant" });
    expect(input.calls.filter(call => call.file === "/bin/ps").map(call => call.args))
      .toEqual([["-p", "4323", "-o", "ppid="], ["-p", "4322", "-o", "ppid="]]);
  });

  test("does not accept an unrelated PID just because caffeinate is enabled", async () => {
    const input = await fixture();
    await startCollectorService({ ...input.options, keepAwake: true }, input.deps);
    await saveState(input, { pid: 4322 });
    input.parents.set(4322, "9000\n");
    input.parents.set(9000, "1\n");
    const result = await collectorServiceStatus(input.options, input.deps);
    expect(result).toMatchObject({ stale: true, stateIdentity: "unverified" });
    expect(result.errors.join(" ")).toContain("STATE_IDENTITY_UNVERIFIED");
    expect(input.calls.filter(call => call.file === "/bin/ps").map(call => call.args[1])).toEqual(["4322", "9000"]);
  });

  test("marks a vanished collector process stale and does not expose ps errors", async () => {
    const input = await fixture();
    await startCollectorService({ ...input.options, keepAwake: true }, input.deps);
    await saveState(input, { pid: 4322 });
    input.parents.set(4322, Object.assign(new Error("gone: http://proxy-user:proxy-secret@localhost"), { code: 1 }));
    const result = await collectorServiceStatus(input.options, input.deps);
    expect(result).toMatchObject({ stale: true, stateIdentity: "unverified" });
    expect(result.errors.join(" ")).toContain("STATE_IDENTITY_UNVERIFIED");
    expect(result.errors.join(" ")).not.toContain("proxy-secret");
  });

  test.each(["stopped", "stopping", "failed"].flatMap(mode => [false, true].map(keepAwake => ({ mode, keepAwake })) ))(
    "rejects recent $mode state with keepAwake=$keepAwake", async ({ mode, keepAwake }) => {
      const input = await fixture();
      await startCollectorService({ ...input.options, keepAwake }, input.deps);
      await saveState(input, { pid: keepAwake ? 4322 : 4321, mode: mode as ContinuousStatus["mode"] });
      input.parents.set(4322, "4321\n");
      const result = await collectorServiceStatus(input.options, input.deps);
      expect(result).toMatchObject({ stale: true, mode, stateIdentity: "unverified" });
      expect(result.errors.join(" ")).toContain("STATE_INACTIVE");
      expect(input.calls.filter(call => call.file === "/bin/ps")).toEqual([]);
    }
  );

  test.each([false, true])("does not accept old state as current with keepAwake=%j", async keepAwake => {
    const input = await fixture();
    await startCollectorService({ ...input.options, keepAwake }, input.deps);
    await saveState(input, { pid: keepAwake ? 4322 : 4321, updatedAtMs: 10_000, lastRecordAtMs: 9000 });
    input.parents.set(4322, "4321\n");
    const result = await collectorServiceStatus(input.options, input.deps);
    expect(result).toMatchObject({ stale: true, stateIdentity: "unverified" });
    expect(result.errors.join(" ")).toContain("STATE_STALE");
    expect(input.calls.filter(call => call.file === "/bin/ps")).toEqual([]);
  });

  test.each(["starting", "collecting", "restarting", "paused_disk"] as const)("accepts fresh %s state from the current job PID", async mode => {
    const input = await fixture();
    await startCollectorService(input.options, input.deps);
    await saveState(input, { mode });
    expect(await collectorServiceStatus(input.options, input.deps)).toMatchObject({ mode, stale: false, stateIdentity: "job" });
    expect(input.calls.filter(call => call.file === "/bin/ps")).toEqual([]);
  });

  test.each(["", "4321\n2\n", "-1\n", "2147483648\n", "0\n", "4322\n"])(
    "rejects malformed, root, or cyclic parent output: %j", async parent => {
      const input = await fixture();
      await startCollectorService({ ...input.options, keepAwake: true }, input.deps);
      await saveState(input, { pid: 4322 });
      input.parents.set(4322, parent);
      expect(await collectorServiceStatus(input.options, input.deps)).toMatchObject({ stale: true, stateIdentity: "unverified" });
      expect(input.calls.filter(call => call.file === "/bin/ps")).toHaveLength(1);
    }
  );

  test("limits ancestor lookups when no owned ancestor is reached", async () => {
    const input = await fixture();
    await startCollectorService({ ...input.options, keepAwake: true }, input.deps);
    await saveState(input, { pid: 5000 });
    for (let pid = 5000; pid < 5100; pid += 1) input.parents.set(pid, `${pid + 1}\n`);
    const result = await collectorServiceStatus(input.options, input.deps);
    expect(result).toMatchObject({ stale: true, stateIdentity: "unverified" });
    const count = input.calls.filter(call => call.file === "/bin/ps").length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(16);
  });

  test("does not issue ps commands for invalid persisted PIDs", async () => {
    const input = await fixture();
    await startCollectorService({ ...input.options, keepAwake: true }, input.deps);
    await saveState(input, { pid: 2 ** 31 });
    expect(await collectorServiceStatus(input.options, input.deps)).toMatchObject({ stale: true, stateIdentity: "unverified" });
    expect(input.calls.filter(call => call.file === "/bin/ps")).toEqual([]);
  });

  test("uses the installed configuration's pulse interval when status omits --config", async () => {
    const input = await fixture({ pulseIntervalMs: 60_000 });
    await startCollectorService(input.options, input.deps);
    await saveState(input, { updatedAtMs: 10_000 });
    const result = await collectorServiceStatus({ projectDirectory: input.projectDirectory }, input.deps);
    expect(result).toMatchObject({ dataRoot: input.dataRoot, stateAgeMs: 40_000, stale: false });
  });

  test("reports an invalid installed config while retaining readable status ages", async () => {
    const input = await fixture();
    await startCollectorService(input.options, input.deps);
    await saveState(input);
    await writeFile(input.configPath, '{"proxyUrl":"proxy-secret",broken');
    const result = await collectorServiceStatus({ projectDirectory: input.projectDirectory }, input.deps);
    expect(result).toMatchObject({ pid: 4321, stateAgeMs: 5000, dataAgeMs: 8000, stale: true });
    expect(result.errors.join(" ")).toContain("CONFIG_INVALID");
    expect(result.errors.join(" ")).not.toContain("proxy-secret");
  });

  test("reports unreadable state without quoting a JSON parser's secret-bearing input", async () => {
    const input = await fixture();
    await mkdir(input.dataRoot);
    await writeFile(join(input.dataRoot, "state.json"), '{"error":"proxy-secret",broken');
    const result = await collectorServiceStatus(input.options, input.deps);
    expect(result).toMatchObject({ stale: true, stateAgeMs: null, dataAgeMs: null });
    expect(result.errors.join(" ")).toContain("STATE_INVALID");
    expect(result.errors.join(" ")).not.toContain("proxy-secret");
  });

  test("reports uncertain service presence when launchctl inspection fails", async () => {
    const input = await fixture();
    await saveState(input);
    input.failures.set("print", Object.assign(new Error("not authorized http://proxy-user:proxy-secret@localhost"), { code: "EACCES" }));
    const result = await collectorServiceStatus(input.options, input.deps);
    expect(result).toMatchObject({ loaded: null, running: null, pid: null, stale: true });
    expect(result.errors.join(" ")).toContain("COMMAND_FAILED");
    expect(result.errors.join(" ")).not.toContain("proxy-secret");
    expect(input.calls.map(call => call.args)).toEqual([["print", target]]);
  });
});


describe("receipt freshness is distinct from service process identity", () => {
  test.each([null, 40_000])("marks a matching live PID stale without recent receipts: %s", async lastRecordAtMs => {
    const input = await fixture();
    input.deps.now = () => 150_000;
    await startCollectorService(input.options, input.deps);
    await saveState(input, { updatedAtMs: 145_000, lastRecordAtMs });
    const result = await collectorServiceStatus(input.options, input.deps);
    expect(result).toMatchObject({ running: true, stateIdentity: "job", stale: true });
    expect(result.errors.some(error => error.startsWith("CONTINUOUS_SERVICE_DATA_STALE:"))).toBe(true);
  });

  test("keeps fresh paused-disk state distinct from missing capture data", async () => {
    const input = await fixture();
    await startCollectorService(input.options, input.deps);
    await saveState(input, { mode: "paused_disk", lastRecordAtMs: null });
    const result = await collectorServiceStatus(input.options, input.deps);
    expect(result).toMatchObject({ mode: "paused_disk", stateIdentity: "job", stale: false });
    expect(result.errors.some(error => error.startsWith("CONTINUOUS_SERVICE_DATA_STALE:"))).toBe(false);
  });
});
