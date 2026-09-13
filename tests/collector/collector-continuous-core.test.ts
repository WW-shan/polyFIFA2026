import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { discoverSportsEvents, normalizeCollectorEvent, type CatalogDependencies } from "../../src/collector/catalog.js";
import { createCollector, type CollectorDependencies, type CollectorJournalLike, type CollectorOptions, type CollectorTimerApi } from "../../src/collector/collector.js";
import { discoverContinuousEvents } from "../../src/collector/continuous-discovery.js";
import { createJournal } from "../../src/collector/journal.js";
import { expandRelatedEvents } from "../../src/collector/related-catalog.js";
import { readJournalRecords } from "../../src/collector/replay.js";
import { createPublicStreams, type CollectorSocket, type PublicStreamsOptions, type StreamRecord } from "../../src/collector/streams.js";
import type { CollectorEvent, JsonRequestOptions, RecordInput } from "../../src/collector/types.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function game(id: string, raw: Record<string, unknown> = {}): CollectorEvent {
  return normalizeCollectorEvent({
    id, slug: id, gameId: `game-${id}`, live: true,
    markets: [{ id: `market-${id}`, conditionId: `condition-${id}`, slug: `winner-${id}`,
      outcomes: ["Yes", "No"], clobTokenIds: [`${id}-yes`, `${id}-no`] }],
    ...raw
  })!;
}

class ManualTimers implements CollectorTimerApi {
  private next = 0;
  readonly intervals = new Map<number, { handler: () => void; ms: number }>();
  readonly timeouts = new Map<number, { handler: () => void; ms: number }>();
  setInterval(handler: () => void, ms: number): number { const id = ++this.next; this.intervals.set(id, { handler, ms }); return id; }
  clearInterval(id: unknown): void { this.intervals.delete(id as number); }
  setTimeout(handler: () => void, ms: number): number { const id = ++this.next; this.timeouts.set(id, { handler, ms }); return id; }
  clearTimeout(id: unknown): void { this.timeouts.delete(id as number); }
  fireIntervals(ms: number): void { for (const timer of [...this.intervals.values()]) if (timer.ms === ms) timer.handler(); }
}

class Socket implements CollectorSocket {
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, (event: StreamRecord) => void>();
  addEventListener(type: string, handler: (event: StreamRecord) => void): void { this.handlers.set(type, handler); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.emit("close", { code: 1000 }); }
  emit(type: string, event: StreamRecord = {}): void { this.handlers.get(type)?.(event); }
}

function fixture(options: CollectorOptions = {}, overrides: CollectorDependencies = {}) {
  const records: RecordInput[] = [];
  const timers = new ManualTimers();
  const starts: string[][] = [], updates: string[][] = [];
  let streamOptions: PublicStreamsOptions | undefined;
  let closed = false;
  const journal: CollectorJournalLike = {
    runId: "memory", runDirectory: "memory", record: input => { records.push(input); },
    flush: async () => {}, close: async () => { closed = true; }
  };
  const runtime = createCollector(options, {
    now: () => 1000, timers, discover: async () => [], request: async () => ({}), ...overrides,
    createJournal: overrides.createJournal ?? (async () => journal),
    createStreams: value => {
      streamOptions = value;
      return overrides.createStreams?.(value) ?? {
        start: tokens => { starts.push([...tokens]); }, setTokens: tokens => { updates.push([...tokens]); }, stop: () => {}
      };
    }
  });
  return { runtime, records, journal, timers, starts, updates,
    get streamOptions() { return streamOptions!; }, get closed() { return closed; } };
}

describe("controlled journal admission", () => {
  test("a real 18,020,881-byte catalog page preserves both HTTP evidence and page fixtures under 32 MiB", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "poly-large-page-")); temporaryDirectories.push(rootDir);
    const raw = { ...game("A").raw, description: "" };
    const response = [raw];
    raw.description = "x".repeat(18_020_881 - Buffer.byteLength(JSON.stringify(response)));
    expect(Buffer.byteLength(JSON.stringify(response))).toBe(18_020_881);
    const run = fixture({ rootDir, durationSeconds: 0, maxBufferBytes: 32 * 1024 * 1024 }, {
      createJournal, discover: discoverSportsEvents,
      request: async url => new URL(url).pathname === "/events" ? response : { bids: [], asks: [] }
    });
    const result = await run.runtime.run();
    const { records } = await readJournalRecords(result.runDirectory);
    const http = records.find(row => row.source === "gamma" && row.kind === "http_request")!;
    const page = records.find(row => row.kind === "discovery_page")!;
    const metadata = records.find(row => row.kind === "event_metadata")!;
    expect((http.data as { response: unknown }).response).toEqual(response);
    expect((page.data as { response: unknown }).response).toEqual(response);
    expect(metadata.data).toEqual({ event: raw, status: "discovered" });
    expect(http.sequence).toBeLessThan(page.sequence);
    expect(page.sequence).toBeLessThan(metadata.sequence);
    expect(run.starts).toEqual([["A-yes", "A-no"]]);
  });

  test("concurrent reconciliation responses and snapshots share admission without serializing HTTP workers", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "poly-concurrent-admission-")); temporaryDirectories.push(rootDir);
    const events = [game("A"), game("B"), game("C")];
    const release = deferred<void>();
    const entered = deferred<void>();
    let discoveries = 0, lookups = 0, active = 0, maximum = 0;
    const run = fixture({ rootDir, maxBufferBytes: 32_000, reconciliationConcurrency: 3, snapshotConcurrency: 2 }, {
      createJournal, discover: async () => ++discoveries === 1 ? events : [],
      request: async url => {
        const path = new URL(url).pathname;
        if (path.startsWith("/events/slug/")) {
          active++; maximum = Math.max(maximum, active);
          if (++lookups === 3) entered.resolve();
          await release.promise; active--;
          return { ...events.find(event => path.endsWith(`/${event.eventSlug}`))!.raw, description: "x".repeat(18_000) };
        }
        return { asset_id: new URL(url).searchParams.get("token_id"), bids: [], asks: [], padding: "x".repeat(18_000) };
      }
    });
    try {
      await run.runtime.start();
      const discovery = run.runtime.discoverOnce();
      await entered.promise;
      const snapshots = run.runtime.snapshotOnce();
      release.resolve();
      await Promise.all([discovery, snapshots]);
      expect(run.runtime.status).toBe("running");
      expect(maximum).toBe(3);
    } finally { release.resolve(); await run.runtime.stop(); }
    const { records } = await readJournalRecords(run.runtime.runDirectory!);
    expect(records.filter(row => row.kind === "http_request" && row.source === "gamma")).toHaveLength(3);
    expect(records.filter(row => row.kind === "discovery_page")).toHaveLength(3);
    expect(records.filter(row => row.kind === "event_metadata")).toHaveLength(6);
    expect(records.filter(row => row.kind === "book_snapshot")).toHaveLength(12);
  });

  test("a pending controlled flush does not hold WebSocket recording", async () => {
    const run = fixture({}, { discover: async () => [game("A")] });
    await run.runtime.start();
    const release = deferred<void>();
    const flushing = deferred<void>();
    run.journal.flush = async () => { flushing.resolve(); await release.promise; };
    const snapshot = run.runtime.snapshotOnce();
    try {
      await turn();
      expect(run.records.filter(row => row.kind === "book_snapshot")).toHaveLength(2);
      run.streamOptions.journal.record({ source: "clob", kind: "ws_message", data: "delta during flush" });
      expect(run.records.at(-1)?.data).toBe("delta during flush");
    } finally { release.resolve(); await snapshot; await run.runtime.stop(); }
    await flushing.promise;
    expect(run.records.filter(row => row.kind === "book_snapshot")).toHaveLength(4);
  });
});

describe("awaitable catalog page observers", () => {
  const runners: Array<[string, (deps: CatalogDependencies) => Promise<unknown>]> = [
    ["catalog", deps => discoverSportsEvents({ pageSize: 1 }, deps)],
    ["related", deps => expandRelatedEvents([game("A")], {}, deps)],
    ["continuous profile", deps => discoverContinuousEvents({ pageSize: 1 }, deps, [{ name: "soccer", tagId: "1" }])]
  ];
  test.each(runners)("%s waits before the next request and reports an async observer failure", async (_name, run) => {
    const release = deferred<void>();
    const entered = deferred<void>();
    const failure = new Error("page sink failed");
    let requests = 0;
    const pending = run({
      request: async url => {
        requests++;
        if (new URL(url).pathname === "/events/keyset") return { events: [], next_cursor: "next" };
        return requests === 1 ? [game("A").raw] : [];
      },
      onPage: () => {
        entered.resolve();
        const writing = release.promise.then(() => { throw failure; });
        void writing.catch(() => {});
        return writing;
      }
    }).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    await turn();
    const beforeRelease = requests;
    release.resolve();
    const result = await pending;
    expect(beforeRelease).toBe(1);
    expect(result).toHaveProperty("error");
    if (_name !== "continuous profile") expect(result).toEqual({ error: failure });
  });
});

describe("background initial snapshots", () => {
  test("starts timers and discovers a new game while the initial HTTP pass hangs, then aborts on stop", async () => {
    const response = deferred<unknown>();
    const entered = deferred<void>();
    const signals: AbortSignal[] = [];
    let events = [game("A")], startFinished = false;
    const run = fixture({ backgroundInitialSnapshots: true, snapshotConcurrency: 1, discoveryIntervalMs: 100, snapshotIntervalMs: 200 }, {
      discover: async () => events,
      request: (_url, options) => { signals.push(options!.signal!); entered.resolve(); return response.promise; }
    });
    const starting = run.runtime.start().then(() => { startFinished = true; });
    try {
      await entered.promise;
      await turn();
      expect(run.runtime.status).toBe("running");
      expect(startFinished).toBe(true);
      expect([...run.timers.intervals.values()].map(timer => timer.ms)).toEqual([100, 200]);
      events = [game("A"), game("B")];
      run.timers.fireIntervals(100);
      await run.runtime.discoverOnce();
      expect(run.runtime.tokenIds).toEqual(["A-yes", "A-no", "B-yes", "B-no"]);
      expect(run.updates.at(-1)).toEqual(run.runtime.tokenIds);
      run.timers.fireIntervals(200);
      await turn();
      expect(signals).toHaveLength(1);
    } finally { await run.runtime.stop(); await starting; }
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(run.timers.intervals.size).toBe(0);
    expect(run.closed).toBe(true);
    response.resolve({ asset_id: "A-yes", bids: [], asks: [] });
    await turn();
    expect(signals).toHaveLength(1);
    expect(run.records.filter(row => row.kind === "book_snapshot")).toHaveLength(0);
    expect(run.records.filter(row => row.kind === "http_error")).toHaveLength(1);
  });

  test("legacy startup still waits for the first snapshot pass", async () => {
    const response = deferred<unknown>();
    const entered = deferred<void>();
    const run = fixture({}, {
      discover: async () => [game("A")], request: () => { entered.resolve(); return response.promise; }
    });
    const starting = run.runtime.start();
    try {
      await entered.promise;
      expect(run.runtime.status).toBe("starting");
      expect(run.timers.intervals.size).toBe(0);
      response.resolve({});
      await starting;
      expect(run.runtime.status).toBe("running");
    } finally { await run.runtime.stop(); }
  });

  test("duration zero waits for the entire initial pass even in background mode", async () => {
    const response = deferred<unknown>();
    const entered = deferred<void>();
    const tokens: string[] = [];
    const run = fixture({ backgroundInitialSnapshots: true, durationSeconds: 0, snapshotConcurrency: 1 }, {
      discover: async () => [game("A")],
      request: url => { tokens.push(new URL(url).searchParams.get("token_id")!); entered.resolve(); return response.promise; }
    });
    let finished = false;
    const running = run.runtime.run().then(result => { finished = true; return result; });
    await entered.promise;
    await turn();
    expect(finished).toBe(false);
    expect(run.closed).toBe(false);
    response.resolve({ bids: [], asks: [] });
    const result = await running;
    expect(result.status).toBe("stopped");
    expect(tokens).toEqual(["A-yes", "A-no"]);
    expect(run.records.filter(row => row.kind === "book_snapshot")).toHaveLength(2);
    expect(run.timers.intervals.size + run.timers.timeouts.size).toBe(0);
  });
});

describe("runtime sports retention", () => {
  test("primary Gamma finish emits retirement for every same-game event ID so companions cannot strand archiving", async () => {
    const primary = game("primary", { gameId: "same-match", markets: [{ ...game("primary").markets[0]!.raw, sportsMarketType: "moneyline" }] });
    const companion = game("companion", { gameId: "same-match", parentEventId: "primary" });
    let now = 1000, events = [primary, companion, game("other")];
    const run = fixture({ postFinishRetentionMs: 1000 }, { now: () => now, discover: async () => events });
    try {
      await run.runtime.start();
      now = 2000;
      events = [normalizeCollectorEvent({ ...primary.raw, finishedTimestamp: new Date(1900).toISOString(), live: false })!, companion, game("other")];
      await run.runtime.discoverOnce();
      now = 3000;
      await run.runtime.refreshLifecycle();
      const retired = run.records.filter(row => row.kind === "event_retired").map(row => row.data as { eventId: string; finishedAtMs: number | null });
      expect(retired.map(state => state.eventId).sort()).toEqual(["companion", "primary"]);
      expect(retired.every(state => state.finishedAtMs === 1900)).toBe(true);
      expect(run.runtime.tokenIds).toEqual(["other-yes", "other-no"]);
      expect(run.updates.at(-1)).toEqual(["other-yes", "other-no"]);
      expect(run.runtime.status).toBe("running");
    } finally { await run.runtime.stop(); }
  });

  test("retires on its own tick during a Gamma outage and keeps another match's deltas recording", async () => {
    let now = 1000, discoveries = 0;
    const sockets: Socket[] = [];
    const streamTimers = new ManualTimers();
    const errors: unknown[] = [];
    const run = fixture({ postFinishRetentionMs: 1000, discoveryIntervalMs: 60_000 }, {
      now: () => now,
      discover: async () => { if (++discoveries > 1) throw new Error("Gamma outage"); return [game("A"), game("B")]; },
      createStreams: options => createPublicStreams({ ...options, timers: streamTimers, onError: error => { errors.push(error); },
        socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; } })
    });
    try {
      await run.runtime.start();
      sockets.forEach(socket => socket.emit("open"));
      const [clob, sports] = sockets;
      now = 2000;
      const frame = JSON.stringify({ gameId: "game-A", ended: true });
      sports!.emit("message", { data: frame });
      expect(run.records.at(-1)).toMatchObject({ source: "sports", kind: "ws_message", data: frame });
      await turn();
      expect(run.runtime.lifecycleStates.find(state => state.eventId === "A")).toMatchObject({ phase: "postmatch", finishedAtMs: null, retireAtMs: 3000 });
      await run.runtime.discoverOnce();
      expect(run.records.some(row => row.kind === "discovery_error")).toBe(true);
      now = 3001;
      run.timers.fireIntervals(1000);
      await turn();
      expect(discoveries).toBe(2);
      expect(run.runtime.tokenIds).toEqual(["B-yes", "B-no"]);
      const unsubscribed = clob!.sent.map(value => JSON.parse(value) as { operation?: string; assets_ids: string[] })
        .filter(value => value.operation === "unsubscribe").flatMap(value => value.assets_ids);
      expect(unsubscribed).toEqual(["A-yes", "A-no"]);
      const delta = JSON.stringify({ event_type: "price_change", price_changes: [{ asset_id: "B-yes", price: "0.6", size: "12", side: "BUY" }] });
      clob!.emit("message", { data: delta });
      expect(run.records.at(-1)?.data).toBe(delta);
      const retired = run.records.filter(row => row.kind === "event_retired");
      expect(retired).toHaveLength(1);
      expect(retired[0]?.data).toMatchObject({ eventId: "A", finishedAtMs: null });
      expect(errors).toEqual([]);
      expect(run.runtime.status).toBe("running");
    } finally { await run.runtime.stop(); }
  });

  test("identity rejection is audited after raw evidence and still reaches a caller's stream error handler", async () => {
    const sockets: Socket[] = [];
    const errors: unknown[] = [];
    const run = fixture({ postFinishRetentionMs: 1000 }, {
      discover: async () => [game("A"), game("B")],
      createStreams: options => createPublicStreams({ ...options, timers: new ManualTimers(), onError: error => { errors.push(error); },
        socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; } })
    });
    try {
      await run.runtime.start(); sockets.forEach(socket => socket.emit("open"));
      const frame = JSON.stringify({ slug: "A", gameId: "game-B", ended: true });
      sockets[1]!.emit("message", { data: frame });
      await turn();
      const rawIndex = run.records.findIndex(row => row.kind === "ws_message" && row.data === frame);
      const errorIndex = run.records.findIndex(row => row.kind === "lifecycle_error");
      expect(rawIndex).toBeGreaterThan(-1);
      expect(errorIndex).toBeGreaterThan(rawIndex);
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain("IDENTITY_CONFLICT");
      expect(run.runtime.lifecycleStates.every(state => state.phase === "watching")).toBe(true);
      expect(run.runtime.status).toBe("running");
    } finally { await run.runtime.stop(); }
  });
});

function book(tokenId: string, padding = "") {
  return { asset_id: tokenId, market: "condition", bids: [{ price: "0.45", size: "12" }],
    asks: [{ price: "0.55", size: "7" }], hash: `hash-${tokenId}`, timestamp: "1100", padding };
}

describe("batch HTTP snapshots", () => {
  test.each([0, -1, 1.5, NaN, Infinity, 101])("rejects invalid snapshotBatchSize %s", snapshotBatchSize => {
    expect(() => createCollector({ snapshotBatchSize })).toThrow("snapshotBatchSize");
  });

  test("matches out-of-order books by exact asset IDs and preserves the raw request, response, times and provenance", async () => {
    const tokens = ["900719925474099312340001", "900719925474099312340002", "001", "1"];
    const current = game("A", { markets: [{ id: "market", conditionId: "condition", outcomes: ["A", "B", "C", "D"], clobTokenIds: tokens }] });
    const response = [book(tokens[2]!), book(tokens[0]!), book(tokens[3]!), book(tokens[1]!)];
    const requests: Array<{ url: string; options: JsonRequestOptions | undefined }> = [];
    let now = 1000;
    const run = fixture({ durationSeconds: 0, snapshotBatchSize: 50 }, {
      now: () => now, discover: async () => [current],
      request: async (url, options) => { requests.push({ url, options }); now = 1200; return response; }
    });
    await run.runtime.run();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: "https://clob.polymarket.com/books", options: { method: "POST", headers: { "Content-Type": "application/json" } } });
    const body = tokens.map(token_id => ({ token_id }));
    expect(JSON.parse(requests[0]!.options!.body!)).toEqual(body);
    const batch = run.records.find(row => row.kind === "book_snapshot_batch")?.data as Record<string, unknown>;
    expect(batch).toMatchObject({ method: "POST", tokenIds: tokens, requestBody: body, response,
      requestStartedAt: new Date(1000).toISOString(), requestEndedAt: new Date(1200).toISOString() });
    expect(batch.batchId).toBeTypeOf("string");
    const snapshots = run.records.filter(row => row.kind === "book_snapshot");
    expect(snapshots).toHaveLength(4);
    for (const tokenId of tokens) {
      const responseIndex = response.findIndex(value => value.asset_id === tokenId);
      expect(snapshots.find(row => (row.data as { tokenId: string }).tokenId === tokenId)?.data).toMatchObject({
        tokenId, response: response[responseIndex], url: "https://clob.polymarket.com/books", method: "POST",
        requestStartedAt: batch.requestStartedAt, requestEndedAt: batch.requestEndedAt,
        provenance: { batchId: batch.batchId, responseIndex }
      });
    }
  });

  test("diagnoses missing, duplicate, unrequested and invalid IDs without inventing books or GET fallbacks", async () => {
    const response = [book("B-no"), book("A-yes"), { ...book("A-yes"), hash: "conflicting-hash" }, book("extra"), { ...book("5"), asset_id: 5 }];
    const requests: string[] = [];
    const run = fixture({ durationSeconds: 0, snapshotBatchSize: 50 }, {
      discover: async () => [game("A"), game("B")], request: async url => { requests.push(url); return response; }
    });
    await run.runtime.run();
    expect(requests).toEqual(["https://clob.polymarket.com/books"]);
    expect(run.records.filter(row => row.kind === "book_snapshot").map(row => (row.data as { tokenId: string }).tokenId)).toEqual(["B-no"]);
    expect(run.records.find(row => row.kind === "book_snapshot_batch")?.data).toMatchObject({ response });
    expect(run.records.find(row => row.kind === "book_snapshot_batch_error")?.data).toMatchObject({
      missingTokenIds: ["A-no", "B-yes"], duplicateTokenIds: ["A-yes"], unrequestedTokenIds: ["extra"], invalidResponseIndices: [4]
    });
  });

  test.each([{ response: [] }, { response: { error: "not an array" } }])("an empty or malformed reply remains explicit absence: %j", async ({ response }) => {
    let requests = 0;
    const run = fixture({ durationSeconds: 0, snapshotBatchSize: 100 }, {
      discover: async () => Array.from({ length: 50 }, (_, index) => game(String(index))),
      request: async () => { requests++; return response; }
    });
    await run.runtime.run();
    expect(requests).toBe(1);
    expect(run.records.filter(row => row.kind === "book_snapshot")).toHaveLength(0);
    const issue = run.records.find(row => row.kind === "book_snapshot_batch_error");
    expect(issue).toBeDefined();
    expect((issue!.data as { missingTokenIds: string[] }).missingTokenIds).toHaveLength(100);
  });

  test("keeps batch workers bounded and continues later batches after a partial HTTP failure", async () => {
    const requests: Array<{ url: string; tokens: string[]; response: ReturnType<typeof deferred<unknown>> }> = [];
    let active = 0, maximum = 0;
    const run = fixture({ backgroundInitialSnapshots: true, snapshotBatchSize: 2, snapshotConcurrency: 2 }, {
      discover: async () => [game("A"), game("B"), game("C")],
      request: async (url, options) => {
        const response = deferred<unknown>();
        requests.push({ url, tokens: options?.body ? (JSON.parse(options.body) as Array<{ token_id: string }>).map(value => value.token_id) : [], response });
        active++; maximum = Math.max(maximum, active);
        try { return await response.promise; } finally { active--; }
      }
    });
    try {
      await run.runtime.start(); await turn();
      expect(requests).toHaveLength(2);
      expect(requests[0]!.tokens).toEqual(["A-yes", "A-no"]);
      requests[0]!.response.reject(new Error("503 batch unavailable"));
      await turn();
      expect(requests).toHaveLength(3);
      for (const request of requests.slice(1)) request.response.resolve(request.tokens.map(token => book(token)).reverse());
      await run.runtime.snapshotOnce();
      expect(maximum).toBe(2);
      expect(requests.every(request => request.url.endsWith("/books"))).toBe(true);
      expect(run.records.filter(row => row.kind === "http_error")).toHaveLength(1);
      expect(run.records.filter(row => row.kind === "book_snapshot")).toHaveLength(4);
      expect(run.runtime.status).toBe("running");
    } finally { await run.runtime.stop(); }
  });

  test("stop aborts active batches and prevents all remaining requests and late replies", async () => {
    const requests: Array<{ url: string; options: JsonRequestOptions | undefined }> = [];
    const response = deferred<unknown>();
    const run = fixture({ backgroundInitialSnapshots: true, snapshotBatchSize: 2, snapshotConcurrency: 2 }, {
      discover: async () => [game("A"), game("B"), game("C"), game("D")],
      request: (url, options) => { requests.push({ url, options }); return response.promise; }
    });
    try {
      await run.runtime.start(); await turn();
      expect(requests).toHaveLength(2);
      expect(requests.every(request => request.options?.method === "POST")).toBe(true);
      run.streamOptions.journal.record({ source: "clob", kind: "ws_message", data: "delta while batches wait" });
      expect(run.records.at(-1)?.data).toBe("delta while batches wait");
    } finally { await run.runtime.stop(); }
    expect(requests.every(request => request.options?.signal?.aborted)).toBe(true);
    response.resolve([book("A-yes")]); await turn();
    expect(requests).toHaveLength(2);
    expect(run.records.filter(row => row.kind === "book_snapshot")).toHaveLength(0);
    const errors = run.records.filter(row => row.kind === "http_error");
    expect(errors).toHaveLength(2);
    expect(errors[0]?.data).toMatchObject({ method: "POST", error: { name: "AbortError" } });
    expect(run.records.at(-1)?.kind).toBe("session_end");
  });

  test.each([undefined, 1000])("skips tokens closed mid-pass, including WS grace retention %s", async postFinishRetentionMs => {
    const first = deferred<unknown>();
    const requests: string[][] = [];
    let events = [game("A"), game("B"), game("C")];
    const run = fixture({ backgroundInitialSnapshots: true, snapshotBatchSize: 2, snapshotConcurrency: 1,
      ...(postFinishRetentionMs === undefined ? {} : { postFinishRetentionMs }) }, {
      discover: async () => events,
      request: async (url, options) => {
        const tokens = options?.body ? (JSON.parse(options.body) as Array<{ token_id: string }>).map(value => value.token_id)
          : [new URL(url).searchParams.get("token_id")!];
        requests.push(tokens);
        return requests.length === 1 ? first.promise : tokens.map(token => book(token));
      }
    });
    try {
      await run.runtime.start(); await turn();
      events = [game("A"), game("B", { closed: true }), game("C")];
      await run.runtime.discoverOnce();
      if (postFinishRetentionMs !== undefined) expect(run.runtime.tokenIds).toContain("B-yes");
      first.resolve([book("A-yes"), book("A-no")]);
      await run.runtime.snapshotOnce();
      expect(requests).toEqual([["A-yes", "A-no"], ["C-yes", "C-no"]]);
    } finally { await run.runtime.stop(); }
  });

  test("a real bounded journal drains between concurrent raw batch replies and per-token rows", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "poly-batch-admission-")); temporaryDirectories.push(rootDir);
    const run = fixture({ rootDir, durationSeconds: 0, snapshotBatchSize: 2, snapshotConcurrency: 2, maxBufferBytes: 32_000 }, {
      createJournal, discover: async () => [game("A"), game("B")],
      request: async (_url, options) => options?.body
        ? (JSON.parse(options.body) as Array<{ token_id: string }>).map(value => book(value.token_id, "x".repeat(9000))) : []
    });
    const result = await run.runtime.run();
    const { records } = await readJournalRecords(result.runDirectory);
    expect(records.filter(row => row.kind === "book_snapshot_batch")).toHaveLength(2);
    expect(records.filter(row => row.kind === "book_snapshot")).toHaveLength(4);
    expect(run.runtime.error).toBeUndefined();
  });
});
