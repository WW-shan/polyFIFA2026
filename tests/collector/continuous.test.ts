import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createCollector, type CollectorRuntime, type CollectorStreamLike } from "../../src/collector/collector.js";
import { continuousConfig } from "../../src/collector/continuous-config.js";
import { ContinuousCollector } from "../../src/collector/continuous.js";
import { ContinuousState } from "../../src/collector/continuous-state.js";
import { writeCaptureState } from "../../src/collector/continuous-storage.js";
import { normalizeCollectorEvent } from "../../src/collector/catalog.js";
import { createJournal } from "../../src/collector/journal.js";
import { readJournalRecords } from "../../src/collector/replay.js";
import { book, eventMetadata, fixtureRecords, journalRecord } from "./tail-fixture.js";
import type { RecordSink } from "../../src/collector/types.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "poly-continuous-")); roots.push(path); return path; }
async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw new Error("condition not reached"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
const noServer = async () => ({ port: 8765, async close() {} });
const emptyStreams = (): CollectorStreamLike => ({ start() {}, setTokens() {}, stop() {} });

test("startup refuses corrupt state without overwriting its evidence", async () => {
  const path = await root(), config = continuousConfig({ dataRoot: join(path, "capture") }, path);
  await mkdir(config.dataRoot); await writeFile(join(config.dataRoot, "state.json"), "broken-state");
  const manager = new ContinuousCollector(config, { startServer: noServer });
  await expect(manager.start()).rejects.toThrow();
  await manager.stop();
  expect(await readFile(join(config.dataRoot, "state.json"), "utf8")).toBe("broken-state");
});

test.each(["runs", "checkpoints"])("startup rejects a symlinked %s parent without using its target", async kind => {
  const path = await root(), config = continuousConfig({ dataRoot: join(path, "capture"), minFreeBytes: 100_000 }, path);
  const outside = join(path, "outside"); await mkdir(outside); await mkdir(config.dataRoot);
  await symlink(outside, join(config.dataRoot, kind));
  const manager = new ContinuousCollector(config, { startServer: noServer, diskBytes: async () => 1_000_000,
    createCollector: (options, deps) => createCollector(options, { ...deps, discover: async () => [], request: async () => ({}), createStreams: emptyStreams }) });
  try { await expect(manager.start()).rejects.toThrow("PATH"); }
  finally { await manager.stop(); }
  expect(await readdir(outside)).toEqual([]);
});

test.each([false, true])("recovers pending stopped-run archives without using a new unrelated run (finish conflict: %s)", async conflict => {
  const path = await root(), config = continuousConfig({ dataRoot: join(path, "capture"), minFreeBytes: 100_000, pulseIntervalMs: 100_000 }, path);
  const oldDirectory = join(config.dataRoot, "runs", "tail-test"); await mkdir(oldDirectory, { recursive: true });
  const records = fixtureRecords();
  if (conflict) records.splice(-1, 0, journalRecord(1, 310_000, "gamma", "event_metadata", eventMetadata(310_001)));
  records.forEach((r, index) => { r.sequence = index + 1; r.monotonicNs = String(BigInt(r.receivedAtMs) * 1_000_000n + BigInt(index)); });
  await writeFile(join(oldDirectory, "1970-01-01-000000.ndjson"), records.map(r => JSON.stringify(r)).join("\n") + "\n");
  const previous = new ContinuousState(config.dataRoot, config.port); previous.setRun("tail-test", oldDirectory);
  for (const record of records) previous.observe(record);
  previous.observe(journalRecord(99, 320_000, "collector", "event_retired", { eventId: "event", finishedAtMs: 310_000 }));
  if (conflict) previous.markArchive("game:123", { status: "complete", runId: "tail-test", attempt: 1, snapshotDirectory: join(config.dataRoot, "checkpoints", "obsolete") });
  await writeCaptureState(config.dataRoot, previous.snapshot());
  let runtime: CollectorRuntime | undefined;
  const manager = new ContinuousCollector(config, { startServer: noServer, diskBytes: async () => 1_000_000,
    createCollector: (options, deps) => (runtime = createCollector(options, { ...deps, discover: async () => [], request: async () => ({}), createStreams: emptyStreams })),
    sealSnapshot: async () => { throw new Error("the old stopped source must be used, not the current unrelated run"); }
  });
  try {
    await manager.start(); await until(() => runtime?.status === "running"); await manager.pulse();
    await until(() => manager.state.snapshot().games[0]?.archive?.status === "complete");
    const archive = manager.state.snapshot().games[0]!.archive!;
    expect(archive.runId).toBe("tail-test"); expect(archive.snapshotDirectory).toBe(oldDirectory);
    const quality = JSON.parse(await readFile(join(archive.outputDirectory!, "quality.json"), "utf8"));
    expect(quality.windows[0].finishConflict).toBe(conflict);
    if (conflict) expect(archive).toMatchObject({ priceReadyTokens: 0, strictReadyTokens: 0 });
  } finally { await manager.stop(); }
}, 10_000);

test("new-run finish evidence is evaluated alongside old-run books before the first archive", async () => {
  const path = await root(), config = continuousConfig({ dataRoot: join(path, "capture"), minFreeBytes: 100_000, pulseIntervalMs: 100_000 }, path);
  const oldDirectory = join(config.dataRoot, "runs", "tail-test"); await mkdir(oldDirectory, { recursive: true });
  const records = fixtureRecords();
  await writeFile(join(oldDirectory, "1970-01-01-000000.ndjson"), records.map(r => JSON.stringify(r)).join("\n") + "\n");
  const saved = new ContinuousState(config.dataRoot, config.port); saved.setRun("tail-test", oldDirectory);
  records.forEach(record => saved.observe(record));
  saved.observe(journalRecord(99, 320_000, "collector", "event_retired", { eventId: "event", finishedAtMs: 310_000 }));
  await writeCaptureState(config.dataRoot, saved.snapshot());
  let runtime: CollectorRuntime | undefined, sink: RecordSink | undefined, release!: () => void;
  const discoveryGate = new Promise<void>(resolve => { release = resolve; });
  const manager = new ContinuousCollector(config, { startServer: noServer, diskBytes: async () => 1_000_000,
    createCollector: (options, deps) => (runtime = createCollector(options, { ...deps,
      createJournal: async options => { const journal = await deps!.createJournal!(options); sink = journal; return journal; },
      discover: async () => { await discoveryGate; return []; }, request: async () => ({}), createStreams: emptyStreams
    })) });
  try {
    await manager.start(); await until(() => sink !== undefined);
    sink!.record({ source: "gamma", kind: "event_metadata", data: eventMetadata(310_001) });
    release(); await until(() => runtime?.status === "running"); await manager.pulse();
    await until(() => manager.state.snapshot().games[0]?.archive?.status === "complete");
    const archive = manager.state.snapshot().games[0]!.archive!;
    expect(archive.snapshotDirectory).toBe(oldDirectory);
    expect(archive.finishFactsFile).toBeDefined();
    const quality = JSON.parse(await readFile(join(archive.outputDirectory!, "quality.json"), "utf8"));
    expect(quality.windows[0].finishConflict).toBe(true);
    expect(archive).toMatchObject({ priceReadyTokens: 0, strictReadyTokens: 0 });
    const facts = JSON.parse(await readFile(archive.finishFactsFile!, "utf8"));
    expect(facts.facts).toContainEqual(expect.objectContaining({ atMs: 310_001, sourceRunId: runtime!.runId }));
  } finally { release(); await manager.stop(); }
}, 10_000);

test("low disk pauses without deletion and restored space resumes with a new run", async () => {
  const path = await root(), config = continuousConfig({ dataRoot: join(path, "capture"), minFreeBytes: 100_000, pulseIntervalMs: 100_000 }, path);
  let free = 1_000_000; const runtimes: CollectorRuntime[] = [];
  const manager = new ContinuousCollector(config, { diskBytes: async () => free, startServer: noServer,
    createCollector: (options, deps) => { const value = createCollector(options, { ...deps, discover: async () => [], request: async () => ({}), createStreams: emptyStreams }); runtimes.push(value); return value; } });
  try {
    await manager.start(); await until(() => runtimes[0]?.status === "running");
    free = 1; await manager.pulse();
    expect(manager.state.snapshot().mode).toBe("paused_disk");
    expect(runtimes[0]?.status).toBe("stopped");
    const before = await readdir(join(config.dataRoot, "runs")); expect(before).toHaveLength(1);
    free = 1_000_000; await manager.pulse(); await until(() => runtimes[1]?.status === "running");
    expect(runtimes[1]?.runId).not.toBe(runtimes[0]?.runId);
    expect(await readdir(join(config.dataRoot, "runs"))).toHaveLength(2);
  } finally { await manager.stop(); }
  expect(JSON.parse(await readFile(join(config.dataRoot, "state.json"), "utf8"))).toMatchObject({ mode: "stopped" });
}, 10_000);

test("a large wall-clock discontinuity retires its run and starts a clean clock epoch", async () => {
  const path = await root(), config = continuousConfig({ dataRoot: join(path, "capture"), minFreeBytes: 100_000, pulseIntervalMs: 100_000, retryDelayMs: 1 }, path);
  let now = 1000, mono = 1000; const runtimes: CollectorRuntime[] = []; let sink: RecordSink | undefined;
  const manager = new ContinuousCollector(config, { now: () => now, startServer: noServer, diskBytes: async () => 1_000_000,
    createJournal: options => createJournal({ ...options, monotonicNs: () => BigInt(mono) * 1_000_000n }),
    createCollector: (options, deps) => { const runtime = createCollector(options, { ...deps, discover: async () => [], request: async () => ({}),
      createStreams: options => { sink = options.journal; return emptyStreams(); } }); runtimes.push(runtime); return runtime; }
  });
  try {
    await manager.start(); await until(() => runtimes[0]?.status === "running");
    now += 10_000; mono += 1;
    sink!.record({ source: "clob", kind: "ws_message", connectionId: "c", data: "PONG" });
    await manager.pulse(); expect(runtimes[0]?.status).toBe("stopped");
    now += 2; mono += 2; await manager.pulse(); await until(() => runtimes[1]?.status === "running");
    expect(runtimes[1]?.runId).not.toBe(runtimes[0]?.runId);
    expect(manager.state.snapshot().errors.some(error => error.scope === "clock")).toBe(true);
  } finally { await manager.stop(); }
}, 10_000);

test("finish lookups rotate fairly instead of starving games behind the first retry batch", async () => {
  const path = await root(), config = continuousConfig({ dataRoot: join(path, "capture"), minFreeBytes: 100_000, pulseIntervalMs: 100_000 }, path);
  let now = 1000, sink: RecordSink | undefined, runtime: CollectorRuntime | undefined; const requested: string[] = [];
  const event = (id: string) => ({ id, slug: id, gameId: id, closed: true, markets: [{ id: `${id}-m`, conditionId: `${id}-c`, outcomes: ["Yes", "No"], clobTokenIds: [`${id}-yes`, `${id}-no`], closed: true }] });
  const manager = new ContinuousCollector(config, { now: () => now, diskBytes: async () => 1_000_000, startServer: noServer,
    createJournal: options => createJournal({ ...options, monotonicNs: () => BigInt(now) * 1_000_000n }),
    request: async url => { const id = decodeURIComponent(new URL(url).pathname.split("/").at(-1)!); requested.push(id); return event(id); },
    createCollector: (options, deps) => (runtime = createCollector(options, { ...deps, discover: async () => [], request: async () => ({}), createStreams: options => { sink = options.journal; return emptyStreams(); } }))
  });
  try {
    await manager.start(); await until(() => runtime?.status === "running");
    for (let i = 0; i < 15; i++) {
      const id = `g${i}`;
      sink!.record({ source: "gamma", kind: "event_metadata", data: { event: event(id) } });
      sink!.record({ source: "clob", kind: "ws_message", connectionId: "c", data: book(`${id}-yes`, "0.5", "0.6", now, id) });
      sink!.record({ source: "collector", kind: "event_retired", data: { eventId: id, finishedAtMs: null } });
    }
    for (let i = 0; i < 15; i++) { now += 5000; await manager.pulse(); }
    expect(new Set(requested).size).toBe(15);
  } finally { await manager.stop(); }
}, 10_000);

test.each([{withFinish:true,changeDuringExport:false},{withFinish:false,changeDuringExport:false},{withFinish:true,changeDuringExport:true}])("completed A archives asynchronously while B continues %j", async ({withFinish,changeDuringExport}) => {
  const path = await root(), config = continuousConfig({ dataRoot: join(path, "capture"), minFreeBytes: 100_000, pulseIntervalMs: 100_000, postFinishRetentionMs: 1000 }, path);
  let now = 1000, finishA = false, sink: RecordSink | undefined, runtime: CollectorRuntime | undefined;
  let exportStarted = false, releaseExport: (() => void) | undefined;
  const event = (id: string) => normalizeCollectorEvent({ id, slug: id, gameId: id, title: id,
    ...(id === "A" && finishA ? { closed: true, ...(withFinish ? { finishedTimestamp: new Date(310_000).toISOString() } : {}) } : {}),
    markets: [{ id: `${id}-m`, slug: `${id}-m`, conditionId: `${id}-c`, outcomes: ["Yes", "No"], clobTokenIds: [`${id}-yes`, `${id}-no`], closed: id === "A" && finishA }] })!;
  const manager = new ContinuousCollector(config, {
    now: () => now, diskBytes: async () => 1_000_000, startServer: noServer,
    request: async () => ({ ...event("A").raw, finishedTimestamp: new Date(310_000).toISOString() }),
    createJournal: options => createJournal({ ...options, monotonicNs: () => BigInt(now) * 1_000_000n }),
    createCollector: (options, deps) => {
      runtime = createCollector(options, { ...deps, now: () => now, discover: async () => [event("A"), event("B")], request: async () => ({}),
        createStreams: options => { sink = options.journal; return { start(tokens) {
          sink!.record({ source: "collector", kind: "connection_open", connectionId: "c", data: { source: "clob" } });
          sink!.record({ source: "collector", kind: "subscription", connectionId: "c", data: { type: "market", assets_ids: tokens } });
          for (const token of tokens) sink!.record({ source: "clob", kind: "ws_message", connectionId: "c", data: book(token, "0.5", "0.6", now, token) });
        }, setTokens() {}, stop() {} }; }
      }); return runtime;
    },
    runExport: async (task, signal) => {
      exportStarted = true;
      await new Promise<void>((resolve, reject) => { releaseExport = resolve; signal?.addEventListener("abort", () => reject(signal.reason), { once: true }); });
      return { outputDirectory: task.outputDirectory, priceReadyTokens: 0, strictReadyTokens: 0 };
    }
  });
  try {
    await manager.start(); await until(() => runtime?.status === "running");
    now = 310_100; finishA = true; await runtime!.discoverOnce();
    now = 311_101; await runtime!.discoverOnce(); await manager.pulse();
    await until(() => exportStarted);
    const before = manager.state.snapshot().receivedRecords;
    sink!.record({ source: "clob", kind: "ws_message", connectionId: "c", data: book("B-yes", "0.51", "0.6", now, "B-later") });
    expect(manager.state.snapshot().receivedRecords).toBe(before + 1);
    expect(runtime!.status).toBe("running");
    if (changeDuringExport) sink!.record({ source: "gamma", kind: "event_metadata", data: { event: { ...event("A").raw, finishedTimestamp: new Date(310_001).toISOString() } } });
    releaseExport!();
    await until(() => manager.state.snapshot().games.some(game => game.key === "game:A" && game.phase === (changeDuringExport ? "archive_failed" : "archived")));
    if (changeDuringExport) {
      const archive = manager.state.snapshot().games.find(game => game.key === "game:A")!.archive!;
      expect(archive.refreshSnapshot).toBe(true); expect(archive.snapshotDirectory).toBeUndefined();
    }
  } finally { releaseExport?.(); await manager.stop(); }
}, 10_000);

test("compact mode keeps raw market frames out of NDJSON and finalizes them in SQLite", async () => {
  const path = await root();
  let now = 900, sink: RecordSink | undefined, runtime: CollectorRuntime | undefined;
  const config = continuousConfig({ dataRoot: join(path, "capture"), compactStorageEnabled: true,
    minFreeBytes: 100_000, pulseIntervalMs: 100_000, postFinishRetentionMs: 0 }, path);
  const event = normalizeCollectorEvent({ id: "A", slug: "A", gameId: "A", live: true,
    markets: [{ id: "A-m", conditionId: "A-c", slug: "A-m", outcomes: ["Yes", "No"], clobTokenIds: ["A-yes", "A-no"] }] })!;
  const manager = new ContinuousCollector(config, {
    now: () => now, diskBytes: async () => 1_000_000, startServer: noServer,
    createJournal: options => createJournal({ ...options, monotonicNs: () => BigInt(now) * 1_000_000n }),
    createCollector: (options, deps) => (runtime = createCollector(options, { ...deps, now: () => now,
      discover: async () => [event], request: async () => ({}), createStreams: options => {
        sink = options.journal;
        return { start() {}, setTokens() {}, stop() {} };
      } }))
  });
  try {
    await manager.start(); await until(() => runtime?.status === "running");
    sink!.record({ source: "clob", kind: "ws_message", connectionId: "c", data: book("A-yes", "0.50", "0.60", now, "first") });
    now = 1_000;
    sink!.record({ source: "sports", kind: "ws_message", connectionId: "sports", data: JSON.stringify({
      gameId: "A", slug: "A", sport: "soccer", ended: true, finishedAt: new Date(now).toISOString()
    }) });
    sink!.record({ source: "collector", kind: "event_retired", data: { eventId: "A", finishedAtMs: now } });
    await manager.pulse();
    await until(() => manager.state.snapshot().games.some(game => game.key === "game:A" && game.archive?.status === "complete"));
    const sqlite = await import("../../src/collector/continuous-tail-store.js");
    const store = await sqlite.openCompactTailStore({ dataRoot: config.dataRoot, tailWindowMs: 180_000, bufferMs: 30_000,
      retentionMs: 30 * 24 * 3600_000, maxBytes: 8 * 1024 ** 3, now: () => now });
    expect(store.readFinalized("game:A")).toHaveLength(2);
    store.close();
  } finally { await manager.stop(); }
  const { records } = await readJournalRecords(join(config.dataRoot, "runs", manager.state.snapshot().runId!));
  expect(records.some(row => row.kind === "ws_message")).toBe(false);
});
