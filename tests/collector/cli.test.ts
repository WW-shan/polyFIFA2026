import { spawn } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { parseCollectorCliArgs, runCollectorCli } from "../../src/collector/cli.js";
import { createCollector, type CollectorJournalLike, type CollectorOptions } from "../../src/collector/collector.js";

const originalExitCode = process.exitCode;
afterEach(() => { process.exitCode = originalExitCode; });

async function settled<T>(promise: Promise<T>) {
  return Promise.race([
    promise.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    ),
    new Promise<{ status: "pending" }>((resolve) => setImmediate(() => resolve({ status: "pending" })))
  ]);
}

function cliRuntime(options: CollectorOptions = {}) {
  const cleanup: string[] = [];
  let onFatal: ((error: unknown) => void) | undefined;
  const journal: CollectorJournalLike = {
    runId: "cli-memory", runDirectory: "cli-memory",
    record() {},
    async flush() { cleanup.push("flush"); },
    async close() { cleanup.push("close"); }
  };
  const runtime = createCollector(options, {
    createJournal: async () => journal,
    discover: async () => [],
    createStreams: (options) => {
      onFatal = options.onFatal;
      return { start() {}, setTokens() {}, stop() { cleanup.push("streams"); } };
    },
    timers: { setInterval() {}, clearInterval() {}, setTimeout() {}, clearTimeout() {} }
  });
  return { runtime, journal, cleanup, fail(error: unknown) { onFatal?.(error); } };
}

describe("collector CLI", () => {
  test("parses same-game related markets without expanding sports",()=>{
    expect(parseCollectorCliArgs(["collect","--include-related-events"])).toEqual({command:"collect",options:{includeRelatedEvents:true}});
  });
  test("leaves an omitted date window to the legacy collector default", () => {
    expect(parseCollectorCliArgs(["collect"])).toEqual({ command: "collect", options: {} });
  });

  test.each(["metadata-end", "game-start"] as const)("parses --date-window %s", (dateWindow) => {
    expect(parseCollectorCliArgs(["collect", "--date-window", dateWindow])).toEqual({
      command: "collect", options: { dateWindow }
    });
  });

  test.each(["start-date", "", "GAME-START"])("rejects invalid --date-window %j", (dateWindow) => {
    expect(() => parseCollectorCliArgs(["collect", "--date-window", dateWindow]))
      .toThrow("CLI_ARGUMENTS_INVALID: --date-window must be metadata-end or game-start");
  });

  test.each([{ following: [] }, { following: ["--all-open"] }])("requires a value after --date-window %j", ({ following }) => {
    expect(() => parseCollectorCliArgs(["collect", "--date-window", ...following]))
      .toThrow("CLI_ARGUMENTS_INVALID: --date-window requires a value");
  });

  test.each(["metadata-end", "game-start"] as const)("passes --date-window %s into the collector runtime", async (dateWindow) => {
    const received: CollectorOptions[] = [];
    const stdout: string[] = [];
    const result = await runCollectorCli(["collect", "--date-window", dateWindow, "--duration-seconds", "0"], {
      createCollector: (options) => { received.push(options); return cliRuntime(options).runtime; },
      write: (value) => stdout.push(value),
      error() {}
    });

    expect(received).toEqual([{ dateWindow, durationSeconds: 0 }]);
    expect(result).toMatchObject({ status: "stopped" });
    expect(stdout).toEqual([JSON.stringify(result)]);
  });

  test("parses finite collection settings without loading credentials", () => {
    const parsed = parseCollectorCliArgs([
      "collect",
      "--duration-seconds", "12.5",
      "--sports", "NBA,tennis",
      "--event-slugs", "game-a,game-b",
      "--all-open",
      "--max-tokens-per-socket", "50"
    ]);

    expect(parsed).toMatchObject({
      command: "collect",
      options: {
        durationSeconds: 12.5,
        sports: ["NBA", "tennis"],
        eventSlugs: ["game-a", "game-b"],
        allOpen: true,
        maxTokensPerSocket: 50
      }
    });
  });

  test("parses export paths and explicit overwrite", () => {
    expect(parseCollectorCliArgs(["export", "--run-dir", "data/collector/run", "--output-dir", "tmp/export", "--overwrite"])).toEqual({
      command: "export",
      options: { runDirectory: "data/collector/run", outputDirectory: "tmp/export", overwrite: true }
    });
  });

  test("parses the snapshot request concurrency limit", () => {
    expect(parseCollectorCliArgs(["collect", "--snapshot-concurrency", "3"])).toEqual({
      command: "collect", options: { snapshotConcurrency: 3 }
    });
  });

  test.each([
    ["collect", "--duration-seconds", "-1"],
    ["collect", "--max-tokens-per-socket", "0"],
    ["collect", "--snapshot-concurrency", "0"],
    ["collect", "--snapshot-concurrency", "1.5"],
    ["collect", "--unknown", "x"],
    ["export"]
  ])("rejects invalid invocation %j", (...args) => {
    expect(() => parseCollectorCliArgs(args)).toThrow("CLI_ARGUMENTS_INVALID");
  });

  test("C12 reports fatal journal errors and exits 1 without a successful result", async () => {
    const fixture = cliRuntime();
    await fixture.runtime.start();
    const failure = new Error("JOURNAL_BUFFER_OVERFLOW");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const running = settled(runCollectorCli(["collect"], {
      createCollector: () => fixture.runtime,
      write: (value) => stdout.push(value),
      error: (value) => stderr.push(value)
    }));
    fixture.fail(failure);
    fixture.fail(failure);

    expect(await running).toEqual({ status: "rejected", reason: failure });
    expect(process.exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("JOURNAL_BUFFER_OVERFLOW");
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    expect(fixture.cleanup).toEqual(["streams", "flush", "close"]);
  });

  test.each(["SIGINT", "SIGTERM"] as const)("C13 %s cleanup failure rejects the CLI and exits 1", async (signal) => {
    const fixture = cliRuntime();
    await fixture.runtime.start();
    const failure = new Error("ENOSPC: flush failed");
    fixture.journal.flush = async () => { fixture.cleanup.push("flush"); throw failure; };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const running = settled(runCollectorCli(["collect"], {
      createCollector: () => fixture.runtime,
      write: (value) => stdout.push(value),
      error: (value) => stderr.push(value)
    }));
    process.emit(signal);

    expect(await running).toEqual({ status: "rejected", reason: failure });
    expect(process.exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain("ENOSPC: flush failed");
    expect(fixture.cleanup).toEqual(["streams", "flush", "close"]);
  });

  test("C14 keeps repeated signal handlers installed until cleanup completes", async () => {
    const fixture = cliRuntime();
    await fixture.runtime.start();
    let release!: () => void;
    fixture.journal.flush = () => new Promise<void>((resolve) => { fixture.cleanup.push("flush"); release = resolve; });
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const stdout: string[] = [];
    const running = runCollectorCli(["collect"], {
      createCollector: () => fixture.runtime,
      write: (value) => stdout.push(value),
      error() {}
    });
    process.emit("SIGINT");
    const listenersDuringStop = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    process.emit("SIGINT");
    process.emit("SIGTERM");
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await running;

    expect(listenersDuringStop).toEqual(before.map((count) => count + 1));
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    expect(fixture.cleanup).toEqual(["streams", "flush", "close"]);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ status: "stopped" });
    expect(process.exitCode).toBe(originalExitCode);
  });

  test.each(["fatal", "flush", "close"])("C12/C13 %s causes a natural subprocess exit 1 with no unhandled rejection", async (mode) => {
    const script = `
      import { createCollector } from "./src/collector/collector.ts";
      import { runCollectorCli } from "./src/collector/cli.ts";
      const mode = ${JSON.stringify(mode)};
      let fatal;
      const journal = {
        runId: "memory", runDirectory: "memory", record() {},
        async flush() { if (mode === "flush") throw new Error("ENOSPC: flush failed"); },
        async close() { if (mode === "close") throw new Error("EIO: close failed"); }
      };
      const runtime = createCollector({}, {
        createJournal: async () => journal,
        discover: async () => [],
        request: async () => ({}),
        createStreams(options) {
          fatal = options.onFatal;
          return { start() {}, setTokens() {}, stop() {} };
        }
      });
      await runtime.start();
      const running = runCollectorCli(["collect"], { createCollector: () => runtime });
      if (mode === "fatal") fatal(new Error("JOURNAL_BUFFER_OVERFLOW"));
      else { process.emit("SIGTERM"); process.emit("SIGTERM"); }
      try { await running; } catch {}
    `;
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--unhandled-rejections=strict", "--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], timeout: 3000
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });

    expect(result.code).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    const message = mode === "fatal" ? "JOURNAL_BUFFER_OVERFLOW" : mode === "flush" ? "ENOSPC: flush failed" : "EIO: close failed";
    expect(result.stderr).toBe(`Error: ${message}\n`);
  });
});
