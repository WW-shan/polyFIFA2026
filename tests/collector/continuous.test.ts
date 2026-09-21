import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
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

test("finish lookups skip matches whose window is already past saving", async () => {
  const path = await root(), config = continuousConfig({ dataRoot: join(path, "capture"), minFreeBytes: 100_000, pulseIntervalMs: 100_000 }, path);
  let now = 1000, sink: RecordSink | undefined, runtime: CollectorRuntime | undefined; const requested: string[] = [];
  const event = (id: string) => ({ id, slug: id, gameId: id, closed: true, markets: [{ id: `${id}-m`, conditionId: `${id}-c`, outcomes: ["Yes", "No"], clobTokenIds: [`${id}-yes`, `${id}-no`], closed: true }] });
  const manager = new ContinuousCollector(config, { now: () => now, diskBytes: async () => 1_000_000, startServer: noServer,
    createJournal: options => createJournal({ ...options, monotonicNs: () => BigInt(now) * 1_000_000n }),
    request: async url => { requested.push(decodeURIComponent(new URL(url).pathname.split("/").at(-1)!)); return event("stale"); },
    createCollector: (options, deps) => (runtime = createCollector(options, { ...deps, discover: async () => [], request: async () => ({}), createStreams: options => { sink = options.journal; return emptyStreams(); } }))
  });
  try {
    await manager.start(); await until(() => runtime?.status === "running");
    // The order book stopped long ago and no label ever arrived, so the tail
    // store has released the rows: a lookup now could only burn quota.
    for (const id of ["stale0", "stale1"]) {
      sink!.record({ source: "gamma", kind: "event_metadata", data: { event: event(id) } });
      sink!.record({ source: "clob", kind: "ws_message", connectionId: "c", data: book(`${id}-yes`, "0.5", "0.6", now, id) });
      sink!.record({ source: "collector", kind: "event_retired", data: { eventId: id, finishedAtMs: null } });
    }
    now += config.pendingFinishRetentionMs + 1;
    for (let step = 0; step < 6; step++) { await manager.pulse(); }
    expect(requested).toEqual([]);
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
    sink!.record({ source: "collector", kind: "connection_gap", connectionId: "c", data: { reason: "inbound_timeout" } });
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
    const finalized = store.readFinalized("game:A");
    expect(finalized).toHaveLength(3);
    expect(finalized.map(row => row.kind)).toContain("connection_gap");
    expect(manager.state.snapshot().compactStorage).toMatchObject({ finalizedMatches: 1, finalizedRecords: 3 });
    store.close();
  } finally { await manager.stop(); }
  const { records } = await readJournalRecords(join(config.dataRoot, "runs", manager.state.snapshot().runId!));
  expect(records.some(row => row.kind === "ws_message")).toBe(false);
});

test("the anchor container is audit evidence and does not file every book twice", async () => {
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
    // Exactly what the anchor pass writes: the raw container plus the
    // per-token snapshot the collector derived from it.
    const book = { asset_id: "A-yes", asks: [{ price: "0.6", size: "7" }], bids: [{ price: "0.4", size: "3" }] };
    sink!.record({ source: "clob", kind: "book_snapshot_batch", data: {
      batchId: "run:books:1", tokenIds: ["A-yes", "A-no"], response: [book] } });
    sink!.record({ source: "clob", kind: "book_snapshot", data: {
      tokenId: "A-yes", url: "https://clob.polymarket.com/books", method: "POST", response: book,
      provenance: { batchId: "run:books:1", responseIndex: 0 } } });
    now = 1_000;
    sink!.record({ source: "sports", kind: "ws_message", connectionId: "sports", data: JSON.stringify({
      gameId: "A", slug: "A", sport: "tennis", ended: true, finishedAt: new Date(now).toISOString() }) });
    sink!.record({ source: "collector", kind: "event_retired", data: { eventId: "A", finishedAtMs: now } });
    await manager.pulse();
    await until(() => manager.state.snapshot().games.some(game => game.key === "game:A" && game.archive?.status === "complete"));
    const sqlite = await import("../../src/collector/continuous-tail-store.js");
    const store = await sqlite.openCompactTailStore({ dataRoot: config.dataRoot, tailWindowMs: 180_000, bufferMs: 30_000,
      retentionMs: 30 * 24 * 3600_000, maxBytes: 8 * 1024 ** 3, now: () => now });
    const rows = store.readFinalized("game:A");
    const anchors = rows.filter(row => row.kind === "book_snapshot");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.data).toMatchObject({ tokenId: "A-yes", response: book });
    store.close();
  } finally { await manager.stop(); }
}, 10_000);

test("end-to-end: batched CLOB frames are attributed per game and finalize into complete tails", async () => {
  const path = await root();
  const finish = 1_800_000;
  let now = finish - 181_000, sink: RecordSink | undefined, runtime: CollectorRuntime | undefined;
  const config = continuousConfig({ dataRoot: join(path, "capture"), compactStorageEnabled: true,
    compactAnchorSnapshots: true, minFreeBytes: 100_000, pulseIntervalMs: 100_000, postFinishRetentionMs: 0 }, path);
  const eventFor = (id: string) => normalizeCollectorEvent({ id, slug: id, gameId: id, live: true,
    markets: [{ id: `${id}-m`, conditionId: `${id}-c`, slug: `${id}-m`, outcomes: ["Yes", "No"],
      clobTokenIds: [`${id}-yes`, `${id}-no`] }] })!;
  const manager = new ContinuousCollector(config, {
    now: () => now, diskBytes: async () => 1_000_000_000, startServer: noServer,
    createJournal: options => createJournal({ ...options, monotonicNs: () => BigInt(now) * 1_000_000n }),
    createCollector: (options, deps) => (runtime = createCollector(options, { ...deps, now: () => now,
      discover: async () => [eventFor("A"), eventFor("B")], request: async () => ({}), createStreams: options => {
        sink = options.journal;
        return { start() {}, setTokens() {}, stop() {} };
      } }))
  });
  try {
    await manager.start(); await until(() => runtime?.status === "running");
    // One batched message mixing both games' tokens, as the real CLOB socket sends.
    const batched = JSON.stringify([
      { event_type: "book", asset_id: "A-yes", bids: [{ price: "0.4", size: "5" }], asks: [{ price: "0.6", size: "10" }] },
      { event_type: "price_change", price_changes: [{ asset_id: "B-yes", side: "SELL", price: "0.7", size: "9" }] },
      { event_type: "price_change", price_changes: [{ asset_id: "A-yes", side: "SELL", price: "0.61", size: "12" }] }
    ]);
    sink!.record({ source: "clob", kind: "ws_message", connectionId: "c", data: batched });
    // A full-window anchor for each game, so the tail can seed an ask ladder.
    for (const id of ["A", "B"]) {
      sink!.record({ source: "clob", kind: "book_snapshot", data: { tokenId: `${id}-yes`,
        response: { asset_id: `${id}-yes`, asks: [{ price: "0.65", size: "7" }], bids: [{ price: "0.35", size: "3" }] } } });
    }
    // Keep the stream alive across the whole final window so the tail is
    // anchored inside it, then finish.
    for (let step = 0; step < 6; step++) {
      now = finish - 150_000 + step * 30_000;
      for (const id of ["A", "B"]) {
        sink!.record({ source: "clob", kind: "ws_message", connectionId: "c", data: JSON.stringify(
          { event_type: "price_change", price_changes: [{ asset_id: `${id}-yes`, side: "SELL", price: "0.6", size: String(step + 1) }] }) });
      }
    }
    now = finish;
    for (const id of ["A", "B"]) {
      sink!.record({ source: "sports", kind: "ws_message", connectionId: "sports",
        data: JSON.stringify({ gameId: id, slug: id, sport: "tennis", ended: true, finishedAt: new Date(now).toISOString() }) });
      sink!.record({ source: "collector", kind: "event_retired", data: { eventId: id, finishedAtMs: now } });
    }
    // One archive turn per pulse, so drive the supervisor until both finish.
    for (let attempt = 0; attempt < 40; attempt++) {
      await manager.pulse();
      if (["A", "B"].every(id => manager.state.snapshot().games.some(game => game.key === `game:${id}` && game.archive?.status === "complete"))) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    for (const id of ["A", "B"]) {
      const game = manager.state.snapshot().games.find(value => value.key === `game:${id}`);
      expect(game?.archive?.status).toBe("complete");
    }

    const sqlite = await import("../../src/collector/continuous-tail-store.js");
    const store = await sqlite.openCompactTailStore({ dataRoot: config.dataRoot, tailWindowMs: 180_000, bufferMs: 30_000,
      retentionMs: 30 * 24 * 3600_000, maxBytes: 8 * 1024 ** 3, now: () => now });
    // Each game keeps only its own frames: no foreign token leaks across.
    for (const [id, own, foreign] of [["A", "A-yes", "B-yes"], ["B", "B-yes", "A-yes"]] as const) {
      const rows = store.readFinalized(`game:${id}`);
      expect(rows.length).toBeGreaterThan(0);
      const tokens = new Set<string>();
      for (const row of rows) {
        const data = row.data as { asset_id?: string; price_changes?: Array<{ asset_id?: string }> };
        if (typeof data.asset_id === "string") tokens.add(data.asset_id);
        for (const change of data.price_changes ?? []) if (typeof change.asset_id === "string") tokens.add(change.asset_id);
      }
      expect([...tokens]).toContain(own);
      expect([...tokens]).not.toContain(foreign);
    }
    store.close();
  } finally { await manager.stop(); }
}, 15_000);

test("a book-snapshot batch is filed per token instead of under every match it mentions", () => {
  const state = new ContinuousState("/capture", 8765); state.setRun("tail-test", "/capture/runs/tail-test");
  state.observe(journalRecord(1, 0, "gamma", "event_metadata", eventMetadata(0)));
  state.observe(journalRecord(2, 1, "clob", "ws_message", book("A", "0.5", "0.6", 1, "h1"), "clob"));
  const batch = journalRecord(3, 2, "clob", "book_snapshot_batch", { batchId: "run:books:1",
    tokenIds: ["A", "unknown-token"], response: [
      { asset_id: "A", asks: [{ price: "0.6", size: "1" }] },
      { asset_id: "unknown-token", asks: [{ price: "0.9", size: "1" }] }
    ] }, "clob");
  const frames = state.clobFramesForRecord(batch);
  // Only the tracked token is attributable; the record is narrowed to the
  // single-token snapshot shape so every kind-based reader still understands it.
  expect(frames).toEqual([{ gameKey: "game:123", kind: "book_snapshot", frameIndex: 0,
    frame: { tokenId: "A", response: { asset_id: "A", asks: [{ price: "0.6", size: "1" }] }, batchId: "run:books:1" } }]);
  // A batch that only mentions untracked tokens belongs to no game at all.
  expect(state.clobFramesForRecord(journalRecord(4, 3, "clob", "book_snapshot_batch",
    { tokenIds: ["unknown-token"], response: [{ asset_id: "unknown-token" }] }, "clob"))).toEqual([]);
});

test("a finish label that arrives minutes late still retries and archives the complete window", async () => {
  const path = await root();
  const finish = 3_600_000, labelAtMs = finish + 300_000;
  let now = finish - 200_000, sink: RecordSink | undefined, runtime: CollectorRuntime | undefined;
  const requested: Array<{ slug: string; atMs: number }> = [];
  const config = continuousConfig({ dataRoot: join(path, "capture"), compactStorageEnabled: true,
    minFreeBytes: 100_000, pulseIntervalMs: 100_000, postFinishRetentionMs: 0, maintenanceIntervalMs: 30_000 }, path);
  // Gamma only publishes `finishedTimestamp` minutes after the sports feed
  // reports the end; until then the slug lookup returns the event without it.
  const rawEvent = (slug: string) => ({ id: slug, slug, gameId: slug,
    ...(now >= labelAtMs ? { finishedTimestamp: new Date(finish).toISOString() } : {}),
    markets: [{ id: `${slug}-m`, conditionId: `${slug}-c`, slug: `${slug}-m`, outcomes: ["Yes", "No"],
      clobTokenIds: [`${slug}-yes`, `${slug}-no`], sportsMarketType: "moneyline" }] });
  const manager = new ContinuousCollector(config, {
    now: () => now, diskBytes: async () => 1_000_000_000, startServer: noServer,
    createJournal: options => createJournal({ ...options, monotonicNs: () => BigInt(now) * 1_000_000n }),
    request: async url => {
      const slug = decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);
      requested.push({ slug, atMs: now });
      return rawEvent(slug);
    },
    createCollector: (options, deps) => (runtime = createCollector(options, { ...deps, now: () => now,
      discover: async () => [], request: async () => ({}), createStreams: options => {
        sink = options.journal;
        return emptyStreams();
      } }))
  });
  try {
    await manager.start(); await until(() => runtime?.status === "running");
    // Matches that ended a few minutes earlier and still have no label mirror
    // the production backlog: the fresh match must not wait behind them.
    now = finish - 400_000;
    for (let index = 0; index < 24; index++) {
      const id = `backlog${index}`;
      sink!.record({ source: "gamma", kind: "event_metadata", data: { event: { id, slug: id, gameId: id,
        markets: [{ id: `${id}-m`, conditionId: `${id}-c`, slug: `${id}-m`, outcomes: ["Yes", "No"],
          clobTokenIds: [`${id}-yes`, `${id}-no`] }] } } });
      sink!.record({ source: "clob", kind: "ws_message", connectionId: "c", data: book(`${id}-yes`, "0.5", "0.6", now, id) });
      sink!.record({ source: "collector", kind: "event_retired", data: { eventId: id, finishedAtMs: null } });
    }
    sink!.record({ source: "gamma", kind: "event_metadata", data: { event: rawEvent("target") } });
    // One book frame per 10s across the whole final window.
    for (let offset = 180_000; offset >= 0; offset -= 10_000) {
      now = finish - offset;
      sink!.record({ source: "clob", kind: "ws_message", connectionId: "c",
        data: book("target-yes", "0.5", "0.6", now, `target-${offset}`) });
    }
    now = finish;
    // The match ends: the event retires but the finish clock is not known yet.
    sink!.record({ source: "collector", kind: "event_retired", data: { eventId: "target", finishedAtMs: null } });
    for (let step = 0; step < 120; step++) {
      now += 5_000;
      await manager.pulse();
      if (manager.state.snapshot().games.some(game => game.key === "game:target" && game.archive?.status === "complete")) break;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    const targetLookups = requested.filter(entry => entry.slug === "target");
    const beforeLabel = targetLookups.filter(entry => entry.atMs < labelAtMs);
    expect(beforeLabel.length).toBeGreaterThanOrEqual(2);
    // Retry cadence, not queue position, decides when the clock is seen.
    expect(beforeLabel[1]!.atMs - beforeLabel[0]!.atMs).toBeLessThanOrEqual(30_000);
    expect(targetLookups.at(-1)!.atMs).toBeGreaterThanOrEqual(labelAtMs);

    const sqlite = await import("../../src/collector/continuous-tail-store.js");
    const store = await sqlite.openCompactTailStore({ dataRoot: config.dataRoot, tailWindowMs: 180_000, bufferMs: 30_000,
      retentionMs: 30 * 24 * 3600_000, maxBytes: 8 * 1024 ** 3, now: () => now });
    const rows = store.readFinalized("game:target");
    expect(rows.length).toBeGreaterThan(0);
    expect(Math.min(...rows.map(row => row.receivedAtMs))).toBe(finish - 180_000);
    expect(store.readMatchCoverage("game:target")).toMatchObject({ windowStartMs: finish - 180_000, windowComplete: true, missingFrontMs: 0 });
    store.close();
  } finally { await manager.stop(); }
}, 30_000);

test("a match whose source never publishes a finish clock anchors on its own last frame", async () => {
  const path = await root();
  const finish = 3_600_000;
  let now = finish - 200_000, sink: RecordSink | undefined, runtime: CollectorRuntime | undefined;
  const config = continuousConfig({ dataRoot: join(path, "capture"), compactStorageEnabled: true,
    minFreeBytes: 100_000, pulseIntervalMs: 100_000, postFinishRetentionMs: 0, maintenanceIntervalMs: 30_000 }, path);
  // Most closed tennis and table-tennis events answer with `closed: true` and
  // no finishedTimestamp, so this lookup never carries a clock.
  const rawEvent = (slug: string) => ({ id: slug, slug, gameId: slug, closed: true,
    markets: [{ id: `${slug}-m`, conditionId: `${slug}-c`, slug: `${slug}-m`, outcomes: ["Yes", "No"],
      clobTokenIds: [`${slug}-yes`, `${slug}-no`], sportsMarketType: "moneyline", closed: true }] });
  const manager = new ContinuousCollector(config, {
    now: () => now, diskBytes: async () => 1_000_000_000, startServer: noServer,
    createJournal: options => createJournal({ ...options, monotonicNs: () => BigInt(now) * 1_000_000n }),
    request: async url => rawEvent(decodeURIComponent(new URL(url).pathname.split("/").at(-1)!)),
    createCollector: (options, deps) => (runtime = createCollector(options, { ...deps, now: () => now,
      discover: async () => [], request: async () => ({}), createStreams: options => {
        sink = options.journal;
        return emptyStreams();
      } }))
  });
  try {
    await manager.start(); await until(() => runtime?.status === "running");
    sink!.record({ source: "gamma", kind: "event_metadata", data: { event: rawEvent("target") } });
    for (let offset = 180_000; offset >= 0; offset -= 10_000) {
      now = finish - offset;
      sink!.record({ source: "clob", kind: "ws_message", connectionId: "c",
        data: book("target-yes", "0.5", "0.6", now, `target-${offset}`) });
    }
    now = finish;
    // The match ends and the event retires, but nothing ever publishes a clock.
    sink!.record({ source: "collector", kind: "event_retired", data: { eventId: "target", finishedAtMs: null } });
    for (let step = 0; step < 100; step++) {
      now += 5_000;
      await manager.pulse();
      if (manager.state.snapshot().games.some(game => game.key === "game:target" && game.archive?.status === "complete")) break;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    const game = manager.state.snapshot().games.find(value => value.key === "game:target");
    expect(game?.finishedAtMs).toBe(finish);
    expect(game?.finishAnchor).toBe("book-quiet");
    expect(game?.archive?.status).toBe("complete");

    const sqlite = await import("../../src/collector/continuous-tail-store.js");
    const store = await sqlite.openCompactTailStore({ dataRoot: config.dataRoot, tailWindowMs: 180_000, bufferMs: 30_000,
      retentionMs: 30 * 24 * 3600_000, maxBytes: 8 * 1024 ** 3, now: () => now });
    expect(store.readMatchCoverage("game:target")).toMatchObject({ windowStartMs: finish - 180_000,
      windowComplete: true, missingFrontMs: 0, finishAnchor: "book-quiet" });
    const rows = store.readFinalized("game:target");
    expect(Math.min(...rows.map(row => row.receivedAtMs))).toBe(finish - 180_000);
    store.close();
  } finally { await manager.stop(); }
}, 30_000);

test("a finish clock later than the last stored frame still archives the frames it holds", async () => {
  const path = await root();
  const lastFrame = 3_600_000;
  let now = lastFrame - 190_000, sink: RecordSink | undefined, runtime: CollectorRuntime | undefined;
  const config = continuousConfig({ dataRoot: join(path, "capture"), compactStorageEnabled: true, minFreeBytes: 100_000,
    pulseIntervalMs: 100_000, postFinishRetentionMs: 0, maintenanceIntervalMs: 1_000 }, path);
  const rawEvent = (slug: string, finishedAtMs: number | null) => ({ id: slug, slug, gameId: null, sport: "tennis",
    closed: finishedAtMs !== null, ...(finishedAtMs === null ? {} : { finishedTimestamp: new Date(finishedAtMs).toISOString() }),
    markets: [{ id: `${slug}-m`, conditionId: `${slug}-c`, slug: `${slug}-m`, outcomes: ["Yes", "No"],
      clobTokenIds: [`${slug}-yes`, `${slug}-no`], sportsMarketType: "moneyline", closed: finishedAtMs !== null }] });
  const manager = new ContinuousCollector(config, {
    now: () => now, diskBytes: async () => 1_000_000_000, startServer: noServer,
    createJournal: options => createJournal({ ...options, monotonicNs: () => BigInt(now) * 1_000_000n }),
    request: async () => rawEvent("target", null),
    createCollector: (options, deps) => (runtime = createCollector(options, { ...deps, now: () => now,
      discover: async () => [], request: async () => ({}), createStreams: options => {
        sink = options.journal;
        return emptyStreams();
      } }))
  });
  try {
    await manager.start(); await until(() => runtime?.status === "running");
    sink!.record({ source: "gamma", kind: "event_metadata", data: { event: rawEvent("target", null) } });
    for (let offset = 180_000; offset >= 0; offset -= 10_000) {
      now = lastFrame - offset;
      await manager.pulse();
      sink!.record({ source: "clob", kind: "ws_message", connectionId: "c",
        data: book("target-yes", "0.5", "0.6", now, `target-${offset}`) });
    }
    // The published clock arrives well after the last quote: anchoring the
    // window on it would leave nothing to archive.
    now = lastFrame + 400_000;
    sink!.record({ source: "gamma", kind: "event_metadata", data: { event: rawEvent("target", now) } });
    sink!.record({ source: "collector", kind: "event_retired", data: { eventId: "target", finishedAtMs: null } });
    for (let step = 0; step < 100; step++) {
      now += 5_000;
      await manager.pulse();
      if (manager.state.snapshot().games.some(game => game.key === "event:target" && game.archive?.status === "complete")) break;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    const game = manager.state.snapshot().games.find(value => value.key === "event:target");
    expect(game?.archive?.status).toBe("complete");
    expect(game?.archive?.error).toContain("finish anchor moved to the last stored frame");

    const sqlite = await import("../../src/collector/continuous-tail-store.js");
    const store = await sqlite.openCompactTailStore({ dataRoot: config.dataRoot, tailWindowMs: 180_000, bufferMs: 30_000,
      retentionMs: 30 * 24 * 3600_000, maxBytes: 8 * 1024 ** 3, now: () => now });
    expect(store.readMatchCoverage("event:target")).toMatchObject({ windowComplete: true, missingFrontMs: 0,
      finishAnchor: "book-tail" });
    const rows = store.readFinalized("event:target");
    expect(rows.length).toBeGreaterThan(0);
    expect(Math.max(...rows.map(row => row.receivedAtMs))).toBe(lastFrame);
    store.close();
  } finally { await manager.stop(); }
}, 30_000);

test("compact maintenance prunes sealed raw runs by the hour, not by the result retention", async () => {
  const path = await root();
  const config = continuousConfig({ dataRoot: join(path, "capture"), compactStorageEnabled: true, rawRunRetentionHours: 1,
    minFreeBytes: 100_000, pulseIntervalMs: 100_000, maintenanceIntervalMs: 1 }, path);
  const stale = join(config.dataRoot, "runs", "run-stale");
  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, "2026-09-20-000000.ndjson"), "{}\n");
  const twoHoursAgo = (Date.now() - 2 * 3600_000) / 1000;
  await utimes(stale, twoHoursAgo, twoHoursAgo);
  let now = Date.now();
  const manager = new ContinuousCollector(config, { now: () => now, diskBytes: async () => 1_000_000_000, startServer: noServer });
  try {
    await manager.start();
    now += 2_000;
    await manager.pulse();
    expect(await readdir(join(config.dataRoot, "runs"))).not.toContain("run-stale");
  } finally { await manager.stop(); }
}, 30_000);

test("a clock that arrives after the market moved on archives the real market tail", async () => {
  const path = await root();
  const clock = 3_600_000, tailEnd = clock + 600_000;
  let now = clock - 200_000, sink: RecordSink | undefined, runtime: CollectorRuntime | undefined;
  const config = continuousConfig({ dataRoot: join(path, "capture"), compactStorageEnabled: true, minFreeBytes: 100_000,
    pulseIntervalMs: 100_000, postFinishRetentionMs: 0, maintenanceIntervalMs: 1_000 }, path);
  const rawEvent = (slug: string, finishedAtMs: number | null) => ({ id: slug, slug, gameId: null, sport: "tennis",
    closed: finishedAtMs !== null, ...(finishedAtMs === null ? {} : { finishedTimestamp: new Date(finishedAtMs).toISOString() }),
    markets: [{ id: `${slug}-m`, conditionId: `${slug}-c`, slug: `${slug}-m`, outcomes: ["Yes", "No"],
      clobTokenIds: [`${slug}-yes`, `${slug}-no`], sportsMarketType: "moneyline", closed: finishedAtMs !== null }] });
  const manager = new ContinuousCollector(config, {
    now: () => now, diskBytes: async () => 1_000_000_000, startServer: noServer,
    createJournal: options => createJournal({ ...options, monotonicNs: () => BigInt(now) * 1_000_000n }),
    request: async () => rawEvent("target", null),
    createCollector: (options, deps) => (runtime = createCollector(options, { ...deps, now: () => now,
      discover: async () => [], request: async () => ({}), createStreams: options => {
        sink = options.journal;
        return emptyStreams();
      } }))
  });
  try {
    await manager.start(); await until(() => runtime?.status === "running");
    sink!.record({ source: "gamma", kind: "event_metadata", data: { event: rawEvent("target", null) } });
    // The market keeps quoting for ten minutes after the sporting finish, which
    // is how tennis markets resolve; the published clock only arrives at the
    // very end, by which time the pre-finish seconds are already released.
    for (let at = clock - 180_000; at <= tailEnd; at += 10_000) {
      now = at;
      await manager.pulse();
      sink!.record({ source: "clob", kind: "ws_message", connectionId: "c",
        data: book("target-yes", "0.5", "0.6", now, `target-${at}`) });
    }
    now = tailEnd + 1_000;
    sink!.record({ source: "gamma", kind: "event_metadata", data: { event: rawEvent("target", clock) } });
    sink!.record({ source: "collector", kind: "event_retired", data: { eventId: "target", finishedAtMs: null } });
    for (let step = 0; step < 60; step++) {
      now += 5_000;
      await manager.pulse();
      if (manager.state.snapshot().games.some(game => game.key === "event:target" && game.archive?.status === "complete")) break;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    const game = manager.state.snapshot().games.find(value => value.key === "event:target");
    expect(game?.archive?.status).toBe("complete");
    expect(game?.archive?.error).toContain("finish anchor moved to the last stored frame");

    const sqlite = await import("../../src/collector/continuous-tail-store.js");
    const store = await sqlite.openCompactTailStore({ dataRoot: config.dataRoot, tailWindowMs: 180_000, bufferMs: 30_000,
      retentionMs: 30 * 24 * 3600_000, maxBytes: 8 * 1024 ** 3, now: () => now });
    const rows = store.readFinalized("event:target");
    expect(rows.length).toBeGreaterThan(0);
    // The archived window is the market's own last three minutes, not the
    // published match clock, and it is labelled as such.
    expect(Math.max(...rows.map(row => row.receivedAtMs))).toBe(tailEnd);
    expect(store.readMatchCoverage("event:target")).toMatchObject({ windowComplete: true, finishAnchor: "book-tail" });
    store.close();
  } finally { await manager.stop(); }
}, 30_000);

test("restart re-pins restored finished compact tails before maintenance", async () => {
  const path = await root();
  const finish = 310_000, now = 600_000;
  const config = continuousConfig({ dataRoot: join(path, "capture"), compactStorageEnabled: true,
    minFreeBytes: 100_000, pulseIntervalMs: 100_000, maintenanceIntervalMs: 1,
    tailWindowSeconds: 180, tailBufferSeconds: 30, pendingFinishRetentionMs: 900_000 }, path);
  const oldDirectory = join(config.dataRoot, "runs", "tail-test");
  await mkdir(oldDirectory, { recursive: true });
  const previous = new ContinuousState(config.dataRoot, config.port);
  previous.setRun("tail-test", oldDirectory);
  previous.observe(journalRecord(1, 100, "gamma", "event_metadata", eventMetadata(finish)));
  previous.observe(journalRecord(2, finish - 60_000, "clob", "ws_message", book("A"), "clob-0-e1"));
  await writeCaptureState(config.dataRoot, previous.snapshot());
  const store = await (await import("../../src/collector/continuous-tail-store.js")).openCompactTailStore({
    dataRoot: config.dataRoot, tailWindowMs: 180_000, bufferMs: 30_000, retentionMs: 30 * 24 * 3600_000,
    maxBytes: 8 * 1024 ** 3, pendingFinishMs: 900_000, now: () => now });
  store.ingest(journalRecord(2, finish - 60_000, "clob", "ws_message", book("A"), "clob-0-e1"), ["game:123"]);
  store.flush(); store.close();
  const manager = new ContinuousCollector(config, { now: () => now, diskBytes: async () => 1_000_000,
    startServer: noServer, createCollector: (options, deps) => createCollector(options, { ...deps,
      discover: async () => [], request: async () => ({}), createStreams: emptyStreams }) });
  try {
    await manager.start();
    expect(manager.state.snapshot().compactStorage?.stagingRecords).toBeGreaterThan(0);
  } finally { await manager.stop(); }
});

test("startup prunes stale restored games using the discovery horizon", async () => {
  const path = await root();
  const config = continuousConfig({ dataRoot: join(path, "capture"), minFreeBytes: 100_000, pulseIntervalMs: 100_000 }, path);
  const previous = new ContinuousState(config.dataRoot, config.port);
  previous.setRun("old", join(config.dataRoot, "runs", "old"));
  previous.observe(journalRecord(1, Date.now() - 24 * 3600_000, "gamma", "event_metadata", eventMetadata(0)));
  const saved = previous.snapshot();
  await mkdir(config.dataRoot, { recursive: true });
  await writeCaptureState(config.dataRoot, saved);

  const manager = new ContinuousCollector(config, { diskBytes: async () => 0, startServer: noServer });
  try {
    await manager.start();
    expect(manager.state.snapshot().games).toEqual([]);
  } finally {
    await manager.stop();
  }
});

test("only actual state publication advances supervisor freshness", async () => {
  const path = await root(), config = continuousConfig({ dataRoot: join(path, "capture"), minFreeBytes: 100_000, pulseIntervalMs: 100_000 }, path);
  let now = 1000;
  const manager = new ContinuousCollector(config, { now: () => now, diskBytes: async () => 0, startServer: noServer });
  try {
    await manager.start();
    expect(manager.state.snapshot()).toMatchObject({ mode: "paused_disk", updatedAtMs: 1000, stateStaleAfterMs: 300_000 });
    now = 2000;
    expect(manager.state.snapshot().updatedAtMs).toBe(1000);
    await manager.pulse();
    expect(manager.state.snapshot().updatedAtMs).toBe(2000);
    expect(JSON.parse(await readFile(join(config.dataRoot, "state.json"), "utf8")).updatedAtMs).toBe(2000);
    now = 3000;
    expect(manager.state.snapshot().updatedAtMs).toBe(2000);
  } finally { await manager.stop(); }
});
