import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createCollector,
  type CollectorDependencies,
  type CollectorJournalLike,
  type CollectorOptions,
  type CollectorStreamLike,
  type CollectorTimerApi
} from "../../src/collector/collector.js";
import { readJournalRecords } from "../../src/collector/replay.js";
import { discoverSportsEvents, type CatalogDependencies, type CatalogOptions } from "../../src/collector/catalog.js";
import type { CollectorEvent, JsonRequester, RecordInput } from "../../src/collector/types.js";
import * as http from "../../src/polymarket/http.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function event(): CollectorEvent {
  const market = {
    marketId: "market-1",
    conditionId: "condition-1",
    marketSlug: "winner",
    question: "Who wins?",
    outcomes: ["Yes", "No"],
    tokenIds: ["token-yes", "token-no"],
    closed: false,
    collectable: true,
    raw: { id: "market-1" }
  };
  return {
    eventId: "event-1",
    eventSlug: "game-1",
    title: "Game 1",
    tags: ["soccer"],
    sport: "soccer",
    gameId: "game-id",
    parentEventId: null,
    markets: [market],
    raw: { id: "event-1", slug: "game-1" }
  };
}

class FakeStreams implements CollectorStreamLike {
  readonly starts: string[][] = [];
  readonly updates: string[][] = [];
  stopped = false;

  async start(tokens: readonly string[]): Promise<void> {
    this.starts.push([...tokens]);
  }

  async setTokens(tokens: readonly string[]): Promise<void> {
    this.updates.push([...tokens]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

async function settled<T>(promise: Promise<T>) {
  return Promise.race([
    promise.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason })
    ),
    new Promise<{ status: "pending" }>((resolve) => setImmediate(() => resolve({ status: "pending" })))
  ]);
}

class ManualTimers implements CollectorTimerApi {
  private nextId = 0;
  readonly intervals = new Map<number, { handler: () => void; milliseconds: number }>();
  readonly timeouts = new Map<number, { handler: () => void; milliseconds: number }>();

  setInterval(handler: () => void, milliseconds: number): number {
    const id = ++this.nextId;
    this.intervals.set(id, { handler, milliseconds });
    return id;
  }

  clearInterval(handle: unknown): void { this.intervals.delete(handle as number); }

  setTimeout(handler: () => void, milliseconds: number): number {
    const id = ++this.nextId;
    this.timeouts.set(id, { handler, milliseconds });
    return id;
  }

  clearTimeout(handle: unknown): void { this.timeouts.delete(handle as number); }

  fireTimeouts(): void {
    for (const [id, timer] of [...this.timeouts]) {
      this.timeouts.delete(id);
      timer.handler();
    }
  }
}

function memoryRuntime(options: CollectorOptions = {}, overrides: CollectorDependencies = {}) {
  const records: RecordInput[] = [];
  const cleanup: string[] = [];
  const timers = new ManualTimers();
  const stream = new FakeStreams();
  let journalOptions: Parameters<NonNullable<CollectorDependencies["createJournal"]>>[0] | undefined;
  let streamOptions: Parameters<NonNullable<CollectorDependencies["createStreams"]>>[0] | undefined;
  let journalCreations = 0;
  const journal: CollectorJournalLike = {
    runId: "memory",
    runDirectory: "memory",
    record(input) { records.push(input); },
    async flush() { cleanup.push("flush"); },
    async close() { cleanup.push("close"); }
  };
  stream.stop = async () => { cleanup.push("streams"); stream.stopped = true; };
  const runtime = createCollector(options, {
    now: () => Date.parse("2026-09-10T12:00:00.000Z"),
    timers,
    request: async () => ({}),
    discover: async () => [],
    ...overrides,
    createJournal: (value) => {
      journalOptions = value;
      journalCreations += 1;
      return overrides.createJournal?.(value) ?? Promise.resolve(journal);
    },
    createStreams: (value) => {
      streamOptions = value;
      return overrides.createStreams?.(value) ?? stream;
    }
  });
  return {
    runtime, journal, stream, records, cleanup, timers,
    get journalOptions() { return journalOptions; },
    get streamOptions() { return streamOptions; },
    get journalCreations() { return journalCreations; }
  };
}

async function journalRecords(root: string, runId: string): Promise<RecordInput[]> {
  const directory = join(root, runId);
  const files = (await readdir(directory)).sort();
  const records: RecordInput[] = [];
  for (const file of files) {
    const content = await readFile(join(directory, file), "utf8");
    for (const line of content.split("\n")) {
      if (line.trim()) records.push(JSON.parse(line) as RecordInput);
    }
  }
  return records;
}

describe("collector runtime", () => {
  test.each<CollectorOptions>([{}, { dateWindow: "metadata-end" }, { dateWindow: "game-start" }])("propagates the date window through initial and repeated discovery: %j", async (options) => {
    const discoveries: CatalogOptions[] = [];
    const fixture = memoryRuntime(options, {
      discover: async (catalogOptions) => { discoveries.push(catalogOptions); return []; }
    });
    await fixture.runtime.start();
    await fixture.runtime.discoverOnce();
    await fixture.runtime.stop();

    const expected = options.dateWindow ?? "metadata-end";
    expect(discoveries.map((item) => item.dateWindow)).toEqual([expected, expected]);
    expect(fixture.records.find((record) => record.kind === "session_start")?.data).toMatchObject({ config: { dateWindow: expected } });
  });

  test.each(["start-date", "", null])("rejects an invalid runtime dateWindow %j", (dateWindow) => {
    expect(() => createCollector({ dateWindow } as unknown as CollectorOptions))
      .toThrow("dateWindow must be metadata-end or game-start");
  });

  test("game-start discovers and snapshots every tennis market despite a seven-day metadata end offset", async () => {
    const raw = {
      id: "tennis", slug: "atp-brunold-heide-2026-09-11", sport: "ATP", tags: [{ slug: "tennis" }],
      startTime: "2026-09-11T10:00:00Z", endDate: "2026-09-18T10:00:00Z",
      finishedTimestamp: "2026-09-11T11:26:00Z", closed: false,
      markets: ["winner", "sets"].map((id) => ({
        id, conditionId: "condition-" + id, slug: id, question: id,
        outcomes: ["Yes", "No"], clobTokenIds: [id + "-yes", id + "-no"],
        closed: false, enableOrderBook: true
      }))
    };
    const snapshots: string[] = [];
    const fixture = memoryRuntime({ dateWindow: "game-start", sports: ["tennis"], lookbackHours: 6, aheadHours: 2, durationSeconds: 0 }, {
      now: () => Date.parse("2026-09-11T12:00:00Z"),
      discover: discoverSportsEvents,
      request: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/events") {
          const min = parsed.searchParams.get("end_date_min");
          const max = parsed.searchParams.get("end_date_max");
          const end = Date.parse(raw.endDate);
          return (min !== null && end < Date.parse(min)) || (max !== null && end > Date.parse(max)) ? [] : [raw];
        }
        if (parsed.pathname === "/book") {
          const token = parsed.searchParams.get("token_id")!;
          snapshots.push(token);
          return { asset_id: token, bids: [], asks: [] };
        }
        throw new Error("Unexpected request: " + url);
      }
    });
    const result = await fixture.runtime.run();

    expect(result).toMatchObject({ status: "stopped", eventCount: 1, tokenCount: 4 });
    expect(fixture.stream.starts).toEqual([["winner-yes", "winner-no", "sets-yes", "sets-no"]]);
    expect(snapshots).toEqual(["winner-yes", "winner-no", "sets-yes", "sets-no"]);
    expect(fixture.records.find((record) => record.kind === "discovery_page")?.data).toMatchObject({ response: [raw] });
    expect(fixture.records.filter((record) => record.source === "gamma" && record.kind === "http_request")).toHaveLength(1);
  });

  test("performs a finite discovery/snapshot run and closes the independent stream set", async () => {
    const root = await mkdtemp(join(tmpdir(), "poly-fifa-collector-runtime-"));
    temporaryDirectories.push(root);
    const stream = new FakeStreams();
    const requests: string[] = [];
    const request: JsonRequester = async (url) => {
      requests.push(url);
      return { asset_id: "token-yes", bids: [], asks: [], observed: true };
    };
    const discover = async (_options: CatalogOptions, deps: CatalogDependencies): Promise<CollectorEvent[]> => {
      deps.onPage?.({ url: "https://gamma.example.test/events?offset=0", requestStartedAt: "2026-09-10T12:00:00.000Z", response: [event()] });
      return [event()];
    };

    const runtime = createCollector({
      rootDir: root,
      runId: "finite",
      durationSeconds: 0,
      snapshotIntervalMs: 60_000,
      discoveryIntervalMs: 60_000
    }, {
      request,
      discover,
      createStreams: () => stream
    });
    const result = await runtime.run();

    expect(result.status).toBe("stopped");
    expect(result.tokenCount).toBe(2);
    expect(stream.starts).toEqual([["token-yes", "token-no"]]);
    expect(stream.stopped).toBe(true);
    expect(requests).toEqual([
      "https://clob.polymarket.com/book?token_id=token-yes",
      "https://clob.polymarket.com/book?token_id=token-no"
    ]);
    const records = await journalRecords(root, "finite");
    expect(records.map((record) => record.kind)).toEqual(expect.arrayContaining([
      "session_start",
      "discovery_page",
      "event_metadata",
      "book_snapshot",
      "session_end"
    ]));
  });

  test("keeps the last good subscriptions when a periodic discovery fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "poly-fifa-collector-runtime-"));
    temporaryDirectories.push(root);
    const stream = new FakeStreams();
    let calls = 0;
    const discover = async (): Promise<CollectorEvent[]> => {
      calls += 1;
      if (calls > 1) throw new Error("temporary gamma outage");
      return [event()];
    };
    const runtime = createCollector({ rootDir: root, runId: "retry" }, { request: async () => ({}), discover, createStreams: () => stream });
    await runtime.start();
    await runtime.discoverOnce();

    expect(calls).toBe(2);
    expect(stream.starts).toEqual([["token-yes", "token-no"]]);
    expect(stream.updates).toEqual([]);
    expect(runtime.error).toBeUndefined();
    await runtime.stop();
  });

  test("reconciles an event that disappears before removing its subscriptions", async () => {
    const root = await mkdtemp(join(tmpdir(), "poly-fifa-collector-runtime-"));
    temporaryDirectories.push(root);
    const stream = new FakeStreams();
    let calls = 0;
    let reconciled = 0;
    const discover = async (): Promise<CollectorEvent[]> => {
      calls += 1;
      return calls === 1 ? [event()] : [];
    };
    const runtime = createCollector({ rootDir: root, runId: "reconcile" }, {
      request: async () => ({}),
      discover,
      fetchEvent: async (slug) => {
        expect(slug).toBe("game-1");
        reconciled += 1;
        return { ...event(), markets: event().markets.map((market) => ({ ...market, collectable: false, closed: true })) };
      },
      createStreams: () => stream
    });
    await runtime.start();
    await runtime.discoverOnce();
    await runtime.stop();

    expect(reconciled).toBe(1);
    expect(stream.starts).toEqual([["token-yes", "token-no"]]);
    expect(stream.updates).toEqual([[]]);
    const replay = await readJournalRecords(join(root, "reconcile"));
    expect(replay.records.some((record) => record.kind === "reconciliation_error")).toBe(false);
    expect(replay.records.some((record) => record.kind === "event_metadata" && (record.data as { status?: string }).status === "reconciled")).toBe(true);
  });
});

describe("collector audited lifecycle regressions", () => {
  test("C12 rejects the run and stop with the original fatal error", async () => {
    const fixture = memoryRuntime();
    const failure = new Error("JOURNAL_BUFFER_OVERFLOW");
    await fixture.runtime.start();
    const running = settled(fixture.runtime.run());

    fixture.streamOptions?.onFatal?.(failure);
    fixture.streamOptions?.onFatal?.(new Error("secondary failure"));

    expect(await running).toEqual({ status: "rejected", reason: failure });
    expect(await settled(fixture.runtime.stop())).toEqual({ status: "rejected", reason: failure });
    expect(fixture.cleanup).toEqual(["streams", "flush", "close"]);
    expect(fixture.runtime.status).toBe("failed");
    expect(fixture.records.find((record) => record.kind === "session_end")?.data).toMatchObject({
      error: { name: "Error", message: "JOURNAL_BUFFER_OVERFLOW" }
    });
  });

  test.each(["streams", "flush", "close"])("C13 settles run after a %s cleanup failure and attempts remaining cleanup", async (stage) => {
    const fixture = memoryRuntime();
    const failure = new Error(`failed ${stage}`);
    await fixture.runtime.start();
    if (stage === "streams") fixture.stream.stop = async () => { fixture.cleanup.push("streams"); throw failure; };
    if (stage === "flush") fixture.journal.flush = async () => { fixture.cleanup.push("flush"); throw failure; };
    if (stage === "close") fixture.journal.close = async () => { fixture.cleanup.push("close"); throw failure; };
    const running = settled(fixture.runtime.run());
    const stopping = settled(fixture.runtime.stop());

    expect(await stopping).toEqual({ status: "rejected", reason: failure });
    expect(await running).toEqual({ status: "rejected", reason: failure });
    expect(fixture.cleanup).toEqual(["streams", "flush", "close"]);
    expect(fixture.runtime.error).toBe(failure);
    expect(fixture.timers.intervals.size + fixture.timers.timeouts.size).toBe(0);
  });

  test("C13 shares startup failure with every lifecycle caller", async () => {
    const failure = new Error("EACCES: journal directory");
    const fixture = memoryRuntime({}, { createJournal: async () => { throw failure; } });
    const running = settled(fixture.runtime.run());

    expect(await running).toEqual({ status: "rejected", reason: failure });
    expect(await settled(fixture.runtime.start())).toEqual({ status: "rejected", reason: failure });
    expect(await settled(fixture.runtime.stop())).toEqual({ status: "rejected", reason: failure });
    expect(fixture.journalCreations).toBe(1);
  });

  test("C14 stop before start is terminal and run returns the same completion", async () => {
    const fixture = memoryRuntime({ durationSeconds: 1 });
    const stopping = fixture.runtime.stop();
    expect(await settled(stopping)).toMatchObject({ status: "fulfilled", value: { status: "stopped" } });

    expect(await settled(fixture.runtime.start())).toMatchObject({ status: "fulfilled" });
    expect(fixture.runtime.run()).toBe(stopping);
    expect(fixture.runtime.stop()).toBe(stopping);
    expect(fixture.journalCreations).toBe(0);
    expect(fixture.streamOptions).toBeUndefined();
    expect(fixture.timers.intervals.size + fixture.timers.timeouts.size).toBe(0);
  });

  test("C14 canceled journal initialization settles promptly and closes a late journal", async () => {
    const opening = deferred<CollectorJournalLike>();
    const fixture = memoryRuntime({ durationSeconds: 60 }, { createJournal: () => opening.promise });
    const running = fixture.runtime.run();
    const runningResult = settled(running);
    const stopping = fixture.runtime.stop();
    const stopped = await settled(stopping);
    const resultBeforeOpening = await runningResult;
    opening.resolve(fixture.journal);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stopped).toMatchObject({ status: "fulfilled", value: { status: "stopped" } });
    expect(resultBeforeOpening).toMatchObject({ status: "fulfilled" });
    expect(fixture.cleanup).toContain("close");
    expect(fixture.stream.starts).toEqual([]);
    expect(fixture.records).toEqual([]);
    expect(fixture.timers.intervals.size + fixture.timers.timeouts.size).toBe(0);
  });

  test("C14 cancellation during discovery prevents stream initialization", async () => {
    const discovery = deferred<CollectorEvent[]>();
    const entered = deferred<void>();
    const fixture = memoryRuntime({}, { discover: () => { entered.resolve(); return discovery.promise; } });
    const running = settled(fixture.runtime.run());
    await entered.promise;
    const stopping = fixture.runtime.stop();
    const resultBeforeDiscovery = await settled(stopping);
    discovery.resolve([event()]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(resultBeforeDiscovery).toMatchObject({ status: "fulfilled" });
    expect(await running).toMatchObject({ status: "fulfilled" });
    expect(fixture.runtime.tokenIds).toEqual([]);
    expect(fixture.streamOptions).toBeUndefined();
    expect(fixture.cleanup).toEqual(["flush", "close"]);
    expect(fixture.timers.intervals.size + fixture.timers.timeouts.size).toBe(0);
  });

  test("C14 aborts pending snapshots, audits cancellation, and does not restart timers", async () => {
    const snapshot = deferred<unknown>();
    const entered = deferred<void>();
    const requestOptions: unknown[] = [];
    const fixture = memoryRuntime({ durationSeconds: 60 }, {
      discover: async () => [event()],
      request: (_url, options) => { requestOptions.push(options); entered.resolve(); return snapshot.promise; }
    });
    const running = settled(fixture.runtime.run());
    await entered.promise;
    const stopping = fixture.runtime.stop();
    const resultBeforeSnapshot = await settled(stopping);
    snapshot.resolve({ bids: [], asks: [] });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(resultBeforeSnapshot).toMatchObject({ status: "fulfilled" });
    expect(await running).toMatchObject({ status: "fulfilled" });
    expect(requestOptions).toEqual(expect.arrayContaining([expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) })]));
    const cancellations = fixture.records.filter((record) => record.kind === "http_error");
    expect(cancellations).toHaveLength(2);
    expect(cancellations[0]?.data).toMatchObject({
      requestStartedAt: "2026-09-10T12:00:00.000Z", requestEndedAt: "2026-09-10T12:00:00.000Z",
      error: { name: "AbortError" }
    });
    expect(fixture.records.at(-1)?.kind).toBe("session_end");
    expect(fixture.timers.intervals.size + fixture.timers.timeouts.size).toBe(0);
    expect(fixture.cleanup).toEqual(["streams", "flush", "close"]);
  });

  test("C14 finite duration applies while journal startup is stalled", async () => {
    const opening = deferred<CollectorJournalLike>();
    const fixture = memoryRuntime({ durationSeconds: 5 }, { createJournal: () => opening.promise });
    const running = fixture.runtime.run();
    const observed = settled(running);
    const deadlines = [...fixture.timers.timeouts.values()].map((timer) => timer.milliseconds);
    fixture.timers.fireTimeouts();
    const resultBeforeOpening = await observed;
    await fixture.runtime.stop();
    opening.resolve(fixture.journal);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(deadlines).toEqual([5000]);
    expect(resultBeforeOpening).toMatchObject({ status: "fulfilled" });
    expect(fixture.cleanup).toContain("close");
    expect(fixture.stream.starts).toEqual([]);
    expect(fixture.timers.intervals.size + fixture.timers.timeouts.size).toBe(0);
  });

  test("C14 concurrent start and run calls share initialization and one deadline", async () => {
    const opening = deferred<CollectorJournalLike>();
    const fixture = memoryRuntime({ durationSeconds: 2 }, { createJournal: () => opening.promise });
    const starting = fixture.runtime.start();
    const secondStart = fixture.runtime.start();
    const running = fixture.runtime.run();
    const secondRun = fixture.runtime.run();
    opening.resolve(fixture.journal);
    await starting;
    await secondStart;
    const deadlineCount = fixture.timers.timeouts.size;
    const stopping = fixture.runtime.stop();
    await stopping;

    expect(secondStart).toBe(starting);
    expect(secondRun).toBe(running);
    expect(stopping).toBe(running);
    expect(deadlineCount).toBe(1);
    expect(fixture.journalCreations).toBe(1);
    expect(fixture.stream.starts).toHaveLength(1);
    expect(fixture.cleanup).toEqual(["streams", "flush", "close"]);
    expect(fixture.timers.intervals.size + fixture.timers.timeouts.size).toBe(0);
  });

  test("C12/C14 journal fatal during discovery terminates without a promise cycle", async () => {
    const failure = new Error("JOURNAL_BUFFER_OVERFLOW");
    const entered = deferred<void>();
    const fixture = memoryRuntime({}, {
      discover: async (_options, deps) => {
        deps.onPage?.({ url: "https://gamma.example.test/events", requestStartedAt: "2026-09-10T12:00:00.000Z", response: [] });
        entered.resolve();
        return [event()];
      }
    });
    fixture.journal.record = (input) => {
      if (input.kind === "discovery_page") throw failure;
      fixture.records.push(input);
    };
    const running = settled(fixture.runtime.run());
    await entered.promise;

    expect(await running).toEqual({ status: "rejected", reason: failure });
    expect(fixture.streamOptions).toBeUndefined();
    expect(fixture.cleanup).toEqual(["flush", "close"]);
    expect(fixture.timers.intervals.size + fixture.timers.timeouts.size).toBe(0);
  });

  test("journal asynchronous errors stop collection immediately", async () => {
    const fixture = memoryRuntime();
    const failure = new Error("ENOSPC: background journal write");
    await fixture.runtime.start();
    const running = settled(fixture.runtime.run());
    fixture.journalOptions?.onError?.(failure);
    const result = await running;
    await settled(fixture.runtime.stop());

    expect(fixture.journalOptions?.onError).toBeTypeOf("function");
    expect(result).toEqual({ status: "rejected", reason: failure });
    expect(fixture.cleanup).toEqual(["streams", "flush", "close"]);
  });

  test.each(["lookup-error", "still-open"])("C15 retains and retries a disappeared event after %s until terminal", async (mode) => {
    let discoveries = 0;
    let lookups = 0;
    const fixture = memoryRuntime({}, {
      discover: async () => ++discoveries === 1 ? [event()] : [],
      fetchEvent: async () => {
        lookups += 1;
        if (lookups < 3) {
          if (mode === "lookup-error") throw new Error("temporary 503");
          return event();
        }
        return { ...event(), raw: { ...event().raw, closed: true }, markets: [] };
      }
    });
    await fixture.runtime.start();
    await fixture.runtime.discoverOnce();
    await fixture.runtime.discoverOnce();
    const retainedEvents = fixture.runtime.events;
    const retainedTokens = fixture.runtime.tokenIds;
    await fixture.runtime.discoverOnce();
    await fixture.runtime.stop();

    expect(retainedEvents).toHaveLength(1);
    expect(retainedTokens).toEqual(["token-yes", "token-no"]);
    expect(lookups).toBe(3);
    expect(fixture.runtime.events).toEqual([]);
    expect(fixture.runtime.tokenIds).toEqual([]);
    expect(fixture.stream.updates.at(-1)).toEqual([]);
  });

  test("C15 retains token mappings when a still-open reconciliation omits market metadata", async () => {
    let discoveries = 0;
    let lookups = 0;
    const fixture = memoryRuntime({}, {
      discover: async () => ++discoveries === 1 ? [event()] : [],
      fetchEvent: async () => {
        lookups += 1;
        return { ...event(), raw: { ...event().raw, closed: false }, markets: [] };
      }
    });
    await fixture.runtime.start();
    await fixture.runtime.discoverOnce();
    await fixture.runtime.discoverOnce();
    await fixture.runtime.stop();

    expect(lookups).toBe(2);
    expect(fixture.runtime.tokenIds).toEqual(["token-yes", "token-no"]);
    expect(fixture.runtime.events).toHaveLength(1);
  });

  test.each([false, undefined])("C15 retries events with closed=%s when only their current markets are closed", async (closed) => {
    let discoveries = 0;
    let lookups = 0;
    const fixture = memoryRuntime({}, {
      discover: async () => ++discoveries === 1 ? [event()] : [],
      fetchEvent: async () => {
        lookups += 1;
        return {
          ...event(), raw: { ...event().raw, ...(closed === undefined ? {} : { closed }) },
          markets: event().markets.map((market) => ({ ...market, collectable: false, closed: true }))
        };
      }
    });
    await fixture.runtime.start();
    await fixture.runtime.discoverOnce();
    await fixture.runtime.discoverOnce();
    await fixture.runtime.stop();

    expect(lookups).toBe(2);
    expect(fixture.runtime.events).toHaveLength(1);
    expect(fixture.runtime.tokenIds).toEqual([]);
  });

  test("C15 does not accept another event as terminal evidence for a disappeared event", async () => {
    let discoveries = 0;
    let lookups = 0;
    const fixture = memoryRuntime({}, {
      discover: async () => ++discoveries === 1 ? [event()] : [],
      fetchEvent: async () => {
        lookups += 1;
        return { ...event(), eventId: "other-event", eventSlug: "other-game", raw: { id: "other-event", slug: "other-game", closed: true } };
      }
    });
    await fixture.runtime.start();
    await fixture.runtime.discoverOnce();
    await fixture.runtime.discoverOnce();
    await fixture.runtime.stop();

    expect(lookups).toBe(2);
    expect(fixture.runtime.events.map((item) => item.eventId)).toEqual(["event-1"]);
    expect(fixture.runtime.tokenIds).toEqual(["token-yes", "token-no"]);
    expect(fixture.records.filter((record) => record.kind === "reconciliation_error")).toHaveLength(2);
  });
});

describe("collector request lifecycle", () => {
  test("journals effective default settings for reproducible runs", async () => {
    const fixture = memoryRuntime({ durationSeconds: 0 });
    await fixture.runtime.run();

    expect(fixture.records.find((record) => record.kind === "session_start")?.data).toMatchObject({
      config: {
        rootDir: "data/collector", gammaBaseUrl: "https://gamma-api.polymarket.com", clobBaseUrl: "https://clob.polymarket.com",
        clobWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market", sportsWsUrl: "wss://sports-api.polymarket.com/ws",
        tagId: "100639", sports: [], eventSlugs: [], dateWindow: "metadata-end", lookbackHours: 48, aheadHours: 24, allOpen: false,
        pageSize: 100, maxPages: 200, discoveryIntervalMs: 60_000, snapshotIntervalMs: 60_000, httpTimeoutMs: 10_000,
        snapshotConcurrency: 8, maxTokensPerSocket: 200, maxSegmentBytes: 64 * 1024 * 1024, maxBufferBytes: 32 * 1024 * 1024,
        durationSeconds: 0
      }
    });
    expect(fixture.records.find((record) => record.kind === "session_end")?.data).toMatchObject({ status: "stopped" });
  });

  test("default HTTP dependency uses the same configured proxy as streams plus timeout and cancellation", async () => {
    const fetch = vi.spyOn(http, "fetchJson").mockResolvedValue({});
    const fixture = memoryRuntime();
    let streamProxy: string | undefined;
    const runtime = createCollector({ proxyUrl: "http://proxy.example.test:8080", httpTimeoutMs: 1234 }, {
      createJournal: async () => fixture.journal,
      createStreams: (options) => { streamProxy = options.proxyUrl; return fixture.stream; },
      timers: fixture.timers,
      discover: async (_options, deps) => { await deps.request("https://gamma.example.test/events"); return [event()]; }
    });
    await runtime.start();
    await runtime.stop();

    expect(streamProxy).toBe("http://proxy.example.test:8080");
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, options] of fetch.mock.calls) {
      expect(options).toMatchObject({ proxyUrl: streamProxy, timeoutMs: 1234, signal: expect.objectContaining({ aborted: true }) });
    }
  });

  test("records a canceled Gamma request before closing the journal", async () => {
    const response = deferred<unknown>();
    const entered = deferred<void>();
    const fixture = memoryRuntime({}, {
      discover: discoverSportsEvents,
      request: () => { entered.resolve(); return response.promise; }
    });
    const running = settled(fixture.runtime.run());
    await entered.promise;
    const stopping = settled(fixture.runtime.stop());
    const stoppedBeforeResponse = await stopping;
    response.resolve([]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stoppedBeforeResponse).toMatchObject({ status: "fulfilled" });
    expect(await running).toMatchObject({ status: "fulfilled" });
    const requests = fixture.records.filter((record) => record.source === "gamma" && record.kind === "http_request");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.data).toMatchObject({
      requestStartedAt: "2026-09-10T12:00:00.000Z", requestEndedAt: "2026-09-10T12:00:00.000Z", error: { name: "AbortError" }
    });
    expect(fixture.records.at(-1)?.kind).toBe("session_end");
  });

  test("bounds snapshot concurrency while eventually collecting every token", async () => {
    const events = Array.from({ length: 6 }, (_, index) => ({
      ...event(), eventId: `event-${index}`, eventSlug: `game-${index}`,
      markets: event().markets.map((market) => ({ ...market, tokenIds: [`yes-${index}`, `no-${index}`] }))
    }));
    const responses: ReturnType<typeof deferred<unknown>>[] = [];
    const urls: string[] = [];
    let inFlight = 0;
    let maximum = 0;
    const fixture = memoryRuntime({ snapshotConcurrency: 2 }, {
      discover: async () => events,
      request: async (url) => {
        urls.push(url);
        inFlight += 1;
        maximum = Math.max(maximum, inFlight);
        const response = deferred<unknown>();
        responses.push(response);
        await response.promise;
        inFlight -= 1;
        return { bids: [], asks: [] };
      }
    });
    const starting = fixture.runtime.start();
    for (let turn = 0; turn < 14; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const response of responses.splice(0)) response.resolve({});
    }
    const result = await settled(starting);
    await fixture.runtime.stop();

    expect(result).toMatchObject({ status: "fulfilled" });
    expect(maximum).toBe(2);
    expect(new Set(urls).size).toBe(12);
    expect(fixture.records.filter((record) => record.kind === "book_snapshot")).toHaveLength(12);
  });

  test("does not issue queued snapshot requests after cancellation", async () => {
    const response = deferred<unknown>();
    let requests = 0;
    const fixture = memoryRuntime({ snapshotConcurrency: 1 }, {
      discover: async () => [event()],
      request: () => { requests += 1; return response.promise; }
    });
    const running = settled(fixture.runtime.run());
    await new Promise<void>((resolve) => setImmediate(resolve));
    const beforeStop = requests;
    const stopping = settled(fixture.runtime.stop());
    response.resolve({ bids: [], asks: [] });
    await stopping;
    await running;

    expect(beforeStop).toBe(1);
    expect(requests).toBe(1);
    expect(fixture.records.filter((record) => record.kind === "http_error")).toHaveLength(1);
    expect(fixture.records.filter((record) => record.kind === "book_snapshot")).toHaveLength(0);
  });

  test("keeps periodic discovery and snapshot scans non-overlapping", async () => {
    let discoveries = 0;
    let requests = 0;
    const discovery = deferred<CollectorEvent[]>();
    const snapshot = deferred<unknown>();
    const fixture = memoryRuntime({ discoveryIntervalMs: 100, snapshotIntervalMs: 200 }, {
      discover: async () => ++discoveries === 1 ? [event()] : discovery.promise,
      request: async () => ++requests <= 2 ? {} : snapshot.promise
    });
    await fixture.runtime.start();
    for (const timer of fixture.timers.intervals.values()) { timer.handler(); timer.handler(); }
    const discovering = fixture.runtime.discoverOnce();
    const snapshotting = fixture.runtime.snapshotOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const countsWhilePending = { discoveries, requests };
    discovery.resolve([event()]);
    snapshot.resolve({});
    await discovering;
    await snapshotting;
    await fixture.runtime.stop();

    expect(countsWhilePending).toEqual({ discoveries: 2, requests: 4 });
    expect(fixture.timers.intervals.size).toBe(0);
  });

  test("fatal subscription updates inside a discovery settle without waiting on themselves", async () => {
    const fixture = memoryRuntime({}, { discover: async () => [event()] });
    await fixture.runtime.start();
    const failure = new Error("subscription failed");
    fixture.stream.setTokens = async () => { throw failure; };
    const running = settled(fixture.runtime.run());
    const discovering = fixture.runtime.discoverOnce();

    expect(await settled(discovering)).toMatchObject({ status: "fulfilled" });
    expect(await running).toEqual({ status: "rejected", reason: failure });
    expect(fixture.cleanup).toEqual(["streams", "flush", "close"]);
    expect(fixture.timers.intervals.size).toBe(0);
  });

  test("stop during event reconciliation does not change subscriptions when the lookup completes later", async () => {
    let discoveries = 0;
    const lookup = deferred<CollectorEvent>();
    const entered = deferred<void>();
    const fixture = memoryRuntime({}, {
      discover: async () => ++discoveries === 1 ? [event()] : [],
      fetchEvent: () => { entered.resolve(); return lookup.promise; }
    });
    await fixture.runtime.start();
    const discovering = fixture.runtime.discoverOnce();
    await entered.promise;
    const stopping = fixture.runtime.stop();
    const result = await settled(stopping);
    lookup.resolve({ ...event(), raw: { closed: true } });
    await discovering;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(result).toMatchObject({ status: "fulfilled" });
    expect(fixture.stream.updates).toEqual([]);
    expect(fixture.runtime.tokenIds).toEqual(["token-yes", "token-no"]);
    expect(fixture.records.at(-1)?.kind).toBe("session_end");
    expect(fixture.cleanup).toEqual(["streams", "flush", "close"]);
  });

  test("stop waits for asynchronous stream teardown before closing the journal", async () => {
    const fixture = memoryRuntime();
    const teardown = deferred<void>();
    await fixture.runtime.start();
    fixture.stream.stop = async () => { fixture.cleanup.push("streams"); await teardown.promise; };
    const stopping = fixture.runtime.stop();
    const stateDuringStop = fixture.runtime.status;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const pending = await settled(stopping);
    const cleanupBeforeTeardown = [...fixture.cleanup];
    teardown.resolve();
    await stopping;

    expect(stateDuringStop).toBe("stopping");
    expect(pending).toEqual({ status: "pending" });
    expect(cleanupBeforeTeardown).toEqual(["streams"]);
    expect(fixture.cleanup).toEqual(["streams", "flush", "close"]);
    expect(fixture.runtime.status).toBe("stopped");
  });

  test("cancels a request when its caller-provided signal aborts", async () => {
    const caller = new AbortController();
    const entered = deferred<void>();
    const response = deferred<unknown>();
    const failure = new DOMException("Canceled lookup", "AbortError");
    let signal: AbortSignal | undefined;
    const fixture = memoryRuntime({}, {
      discover: async (_options, deps) => { await deps.request("https://gamma.example.test/events", { signal: caller.signal }); return []; },
      request: (_url, options) => { signal = options?.signal; entered.resolve(); return response.promise; }
    });
    const starting = fixture.runtime.start();
    await entered.promise;
    caller.abort(failure);
    const canceledBeforeStop = signal?.aborted;
    const resultBeforeResponse = await settled(starting);
    response.resolve([]);
    await starting;
    await fixture.runtime.stop();

    expect(canceledBeforeStop).toBe(true);
    expect(resultBeforeResponse).toMatchObject({ status: "fulfilled" });
    expect(fixture.records.find((record) => record.kind === "http_request")?.data).toMatchObject({ error: { message: "Canceled lookup", name: "AbortError" } });
    expect(fixture.runtime.error).toBeUndefined();
  });
});
