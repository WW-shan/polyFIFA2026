import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createCollector, type CollectorRuntime, type CollectorStreamLike } from "../../src/collector/collector.js";
import { continuousConfig } from "../../src/collector/continuous-config.js";
import { ContinuousCollector } from "../../src/collector/continuous.js";
import { ContinuousState } from "../../src/collector/continuous-state.js";
import { writeCaptureState } from "../../src/collector/continuous-storage.js";
import { scanJournal } from "../../src/collector/journal-reader.js";
import { emptyReplayQuality } from "../../src/collector/replay-types.js";
import type { JournalCompressionTask } from "../../src/collector/continuous-compression.js";
import type { RecordSink, JournalRecord } from "../../src/collector/types.js";
import { fixtureRecords, journalRecord } from "./tail-fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "poly-maintenance-")); roots.push(path); return path; }
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 3000;
  while (!await predicate()) { if (Date.now() > end) throw new Error("condition not reached"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const noServer = async () => ({ port: 8765, async close() {} });
const emptyStreams = (): CollectorStreamLike => ({ start() {}, setTokens() {}, stop() {} });
const report = { compressedSegments: 1, replacedAliases: 2, originalBytes: 1000, compressedBytes: 100, logicalBytesSaved: 900, skipped: [] };

test("compression is explicitly configurable and validates maintenance limits", () => {
  expect(continuousConfig().compressionEnabled).toBe(false);
  expect(continuousConfig({ compressionEnabled: true }).compressionEnabled).toBe(true);
  for (const input of [{ compressionEnabled: "yes" }, { compressionIntervalMs: 0 }, { compressionMaxSegments: 0 }, { compressionTimeoutMs: -1 }]) {
    expect(() => continuousConfig(input as never)).toThrow("CONFIG_INVALID");
  }
  expect(continuousConfig({ compressionTimeoutMs: 2_147_483_647 }).compressionTimeoutMs).toBe(2_147_483_647);
  expect(() => continuousConfig({ compressionTimeoutMs: 2_147_483_648 })).toThrow("compressionTimeoutMs");
  expect(continuousConfig().singleMatchOnly).toBe(true);
  expect(() => continuousConfig({ singleMatchOnly: "false" } as never)).toThrow("singleMatchOnly");
});

test.each([true, false])("continuous wiring records compact provenance and respects single-match scope: %s", async singleMatchOnly => {
  const path = await root(), config = continuousConfig({ dataRoot: join(path, "capture"), minFreeBytes: 100_000, pulseIntervalMs: 100_000, singleMatchOnly }, path);
  const match = { id: "m", slug: "match", title: "Sinner vs Alcaraz", gameId: "g", markets: [
    { id: "market", conditionId: "condition", outcomes: ["Sinner", "Alcaraz"], clobTokenIds: ["a", "b"], sportsMarketType: "moneyline" }
  ] };
  const outright = { id: "future", slug: "us-open-winner", title: "2026 US Open Winner", markets: [
    { id: "future-market", conditionId: "future-condition", outcomes: ["Yes", "No"], clobTokenIds: ["x", "y"], sportsMarketType: "outright" }
  ] };
  let runtime: CollectorRuntime | undefined;
  const manager = new ContinuousCollector(config, { startServer: noServer, diskBytes: async () => 1_000_000,
    createCollector: (options, deps) => (runtime = createCollector(options, { ...deps, createStreams: emptyStreams,
      request: async url => new URL(url).pathname === "/books" ? [] : new URL(url).searchParams.has("game_id") ? [match] : [match, outright]
    })) });
  let runDirectory = "";
  try {
    await manager.start(); await until(() => runtime?.status === "running");
    expect(runtime!.tokenIds).toEqual(singleMatchOnly ? ["a", "b"] : ["a", "b", "x", "y"]);
    runDirectory = manager.state.snapshot().runDirectory!;
  } finally { await manager.stop(); }
  const rows: JournalRecord[] = [];
  await scanJournal(runDirectory, row => { rows.push(row); }, emptyReplayQuality(), () => {});
  const page = rows.find(row => row.kind === "discovery_page_ref");
  expect(page).toBeDefined();
  const ref = (page!.data as { responseRef: { runId: string; sequence: number } }).responseRef;
  expect(ref.runId).toBe(page!.runId);
  expect(rows.find(row => row.sequence === ref.sequence)?.kind).toBe("http_request");
  expect(ref.sequence).toBeLessThan(page!.sequence);
});

test("bounded maintenance runs beside capture and stop cancels its owned task", async () => {
  const path = await root(), config = continuousConfig({ dataRoot: join(path, "capture"), minFreeBytes: 100_000,
    pulseIntervalMs: 100_000, compressionEnabled: true, compressionIntervalMs: 10, compressionMaxSegments: 2 }, path);
  let now = 1000, runtime: CollectorRuntime | undefined, sink: RecordSink | undefined, cancelled = false;
  const tasks: JournalCompressionTask[] = [];
  const manager = new ContinuousCollector(config, { now: () => now, startServer: noServer, diskBytes: async () => 1_000_000,
    createCollector: (options, deps) => (runtime = createCollector(options, { ...deps, discover: async () => [], request: async () => ({}),
      createStreams: options => { sink = options.journal; return emptyStreams(); } })),
    runCompression: async (task, signal) => {
      tasks.push(task);
      await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => { cancelled = true; reject(signal!.reason); }, { once: true }));
      return report;
    }
  });
  try {
    await manager.start(); await until(() => runtime?.status === "running");
    now += 11; await manager.pulse(); await until(() => tasks.length === 1);
    expect(tasks[0]).toMatchObject({ roots: [join(config.dataRoot, "runs"), join(config.dataRoot, "checkpoints")], maxSegments: 2,
      activeRunDirectory: manager.state.snapshot().runDirectory });
    const before = manager.state.snapshot().receivedRecords;
    sink!.record({ source: "clob", kind: "ws_message", data: "PONG" });
    expect(manager.state.snapshot().receivedRecords).toBe(before + 1);
    expect(manager.state.snapshot().compression.running).toBe(true);
    expect(runtime!.status).toBe("running");
  } finally { await manager.stop(); }
  expect(cancelled).toBe(true);
  expect(manager.state.snapshot().compression.running).toBe(false);
});

test("disk-paused maintenance can release space and collection then resumes", async () => {
  const path = await root(), config = continuousConfig({ dataRoot: join(path, "capture"), minFreeBytes: 100_000,
    pulseIntervalMs: 100_000, compressionEnabled: true, compressionIntervalMs: 10 }, path);
  let now = 1000, free = 1, calls = 0, runtime: CollectorRuntime | undefined;
  const manager = new ContinuousCollector(config, { now: () => now, startServer: noServer, diskBytes: async () => free,
    createCollector: (options, deps) => (runtime = createCollector(options, { ...deps, discover: async () => [], request: async () => ({}), createStreams: emptyStreams })),
    runCompression: async task => { expect(task.activeRunDirectory).toBeUndefined(); calls++; free = 1_000_000; return report; }
  });
  try {
    await manager.start(); expect(manager.state.mode).toBe("paused_disk");
    now += 11; await manager.pulse(); await until(() => calls === 1 && !manager.state.snapshot().compression.running);
    await manager.pulse(); await until(() => runtime?.status === "running");
    expect(manager.state.snapshot().compression.logicalBytesSaved).toBe(900);
  } finally { await manager.stop(); }
});

test("maintenance and an archive cannot mutate/read the journal concurrently", async () => {
  const path = await root(), config = continuousConfig({ dataRoot: join(path, "capture"), minFreeBytes: 100_000,
    pulseIntervalMs: 100_000, compressionEnabled: true, compressionIntervalMs: 10 }, path);
  const oldDirectory = join(config.dataRoot, "runs", "tail-test"); await mkdir(oldDirectory, { recursive: true });
  const records = fixtureRecords(); await writeFile(join(oldDirectory, "1970-01-01-000000.ndjson"), records.map(r => JSON.stringify(r)).join("\n") + "\n");
  const previous = new ContinuousState(config.dataRoot, config.port); previous.setRun("tail-test", oldDirectory);
  records.forEach(record => previous.observe(record));
  previous.observe(journalRecord(99, 320_000, "collector", "event_retired", { eventId: "event", finishedAtMs: 310_000 }));
  await writeCaptureState(config.dataRoot, previous.snapshot());
  let now = 1_000_000, runtime: CollectorRuntime | undefined, exports = 0, compressions = 0;
  let releaseExport = () => {}, releaseCompression = () => {};
  const manager = new ContinuousCollector(config, { now: () => now, startServer: noServer, diskBytes: async () => 1_000_000,
    createCollector: (options, deps) => (runtime = createCollector(options, { ...deps, discover: async () => [], request: async () => ({}), createStreams: emptyStreams })),
    runExport: async task => { exports++; await new Promise<void>(resolve => { releaseExport = resolve; }); return { outputDirectory: task.outputDirectory, priceReadyTokens: 0, strictReadyTokens: 0 }; },
    runCompression: async () => { compressions++; await new Promise<void>(resolve => { releaseCompression = resolve; }); return report; }
  });
  try {
    await manager.start(); await until(() => runtime?.status === "running"); await manager.pulse(); await until(() => exports === 1);
    now += 11; await manager.pulse(); expect(compressions).toBe(0);
    releaseExport(); await until(() => manager.state.snapshot().games[0]?.archive?.status === "complete");
    // The archive's final state write can still be draining when its completed
    // result first appears. Drive the normal next-pulse scheduling until idle.
    await until(async () => { await manager.pulse(); return compressions === 1; });
    manager.state.markArchive("game:123", { status: "failed", runId: "tail-test", attempt: 1, snapshotDirectory: oldDirectory, retryAtMs: now });
    await manager.pulse(); expect(exports).toBe(1);
    releaseCompression(); await until(() => !manager.state.snapshot().compression.running);
    await manager.pulse(); await until(() => exports === 2); releaseExport();
  } finally { releaseExport(); releaseCompression(); await manager.stop(); }
});

test.each([
  { interval: 60_000, duration: 65_000, pulseDelay: 1 },
  { interval: 1, duration: 2, pulseDelay: 10 }
])("ready archives get a turn after maintenance even when another batch is due: %j", async ({ interval, duration, pulseDelay }) => {
  const path = await root(), config = continuousConfig({ dataRoot: join(path, "capture"), minFreeBytes: 100_000,
    pulseIntervalMs: 100_000, compressionEnabled: true, compressionIntervalMs: interval }, path);
  const oldDirectory = join(config.dataRoot, "runs", "tail-test"); await mkdir(oldDirectory, { recursive: true });
  const records = fixtureRecords(); await writeFile(join(oldDirectory, "1970-01-01-000000.ndjson"), records.map(r => JSON.stringify(r)).join("\n") + "\n");
  const previous = new ContinuousState(config.dataRoot, config.port); previous.setRun("tail-test", oldDirectory);
  records.forEach(record => previous.observe(record));
  previous.observe(journalRecord(99, 320_000, "collector", "event_retired", { eventId: "event", finishedAtMs: 310_000 }));
  await writeCaptureState(config.dataRoot, previous.snapshot());
  let now = 1_000_000, runtime: CollectorRuntime | undefined, exports = 0, compressions = 0;
  const manager = new ContinuousCollector(config, { now: () => now, startServer: noServer, diskBytes: async () => 1_000_000,
    createCollector: (options, deps) => (runtime = createCollector(options, { ...deps, discover: async () => [], request: async () => ({}), createStreams: emptyStreams })),
    runCompression: async () => { compressions++; now += duration; return report; },
    runExport: async task => { exports++; return { outputDirectory: task.outputDirectory, priceReadyTokens: 0, strictReadyTokens: 0 }; }
  });
  try {
    await manager.start(); await until(() => runtime?.status === "running");
    now += interval; await manager.pulse(); await until(() => compressions === 1 && !manager.state.snapshot().compression.running);
    now += pulseDelay; await manager.pulse(); await until(() => exports === 1);
    expect(compressions).toBe(1);
  } finally { await manager.stop(); }
});
