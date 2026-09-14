import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { discoverSportsEvents, type CatalogDependencies } from "../../src/collector/catalog.js";
import { createCollector, type CollectorDependencies, type CollectorOptions, type CollectorTimerApi } from "../../src/collector/collector.js";
import { createJournal } from "../../src/collector/journal.js";
import { readJournalRecords } from "../../src/collector/replay.js";
import type { JournalRecord } from "../../src/collector/types.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const epoch = Date.parse("2026-09-14T12:00:00.000Z");
const timestamp = new Date(epoch).toISOString();
type Page = Parameters<NonNullable<CatalogDependencies["onPage"]>>[0];
type Reference = { runId: string; sequence: number; sha256: string; bytes: number };
type ReferencedPage = Omit<Page, "response"> & { responseRef: Reference };

class ManualTimers implements CollectorTimerApi {
  setInterval(): number { return 1; }
  clearInterval(): void {}
  setTimeout(): number { return 2; }
  clearTimeout(): void {}
}

function event() {
  return {
    id: "match", slug: "itf-match", title: "ITF: Player A vs. Player B", gameId: null,
    startTime: timestamp, closed: false,
    markets: [{ id: "winner", slug: "match-winner", conditionId: "condition",
      question: "Match winner", sportsMarketType: "moneyline", volume: 0,
      outcomes: ["Player A", "Player B"], clobTokenIds: ["0001", "0002"] }]
  };
}

async function fixture(options: CollectorOptions = {}, dependencies: CollectorDependencies = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "poly-discovery-storage-"));
  temporaryDirectories.push(rootDir);
  const starts: string[][] = [];
  let clock = epoch;
  const runtime = createCollector({ rootDir, runId: "discovery", durationSeconds: 0, ...options }, {
    now: () => clock++, timers: new ManualTimers(),
    createStreams: () => ({ start: tokens => { starts.push([...tokens]); }, setTokens: () => {}, stop: () => {} }),
    request: async url => new URL(url).pathname === "/events" ? [event()]
      : { asset_id: new URL(url).searchParams.get("token_id"), bids: [], asks: [] },
    ...dependencies
  });
  return { runtime, starts, rootDir };
}

function assertReference(records: JournalRecord[], page: JournalRecord): JournalRecord {
  const data = page.data as ReferencedPage;
  const source = records.find(record => record.runId === data.responseRef.runId && record.sequence === data.responseRef.sequence);
  expect(source).toBeDefined();
  expect(source).toMatchObject({ source: "gamma", kind: "http_request", runId: page.runId });
  expect(source!.sequence).toBeLessThan(page.sequence);
  expect(source!.data).toHaveProperty("url", data.url);
  const response = JSON.stringify((source!.data as { response: unknown }).response);
  expect(data.responseRef).toEqual({
    runId: page.runId, sequence: source!.sequence,
    sha256: createHash("sha256").update(response).digest("hex"), bytes: Buffer.byteLength(response)
  });
  expect(data).not.toHaveProperty("response");
  return source!;
}

describe("compact discovery storage", () => {
  test("stores one multi-megabyte UTF-8 HTTP body and a verifiable page reference", async () => {
    const response = { events: [event()], directoryPayload: "原始🎾".repeat(350_000) };
    const serialized = JSON.stringify(response);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(3 * 1024 * 1024);
    const pages: Page[] = [];
    const run = await fixture({ compactDiscoveryPages: true }, {
      request: async url => new URL(url).pathname === "/events" ? response : { bids: [], asks: [] },
      discover: (options, deps) => discoverSportsEvents(options, {
        ...deps, onPage: async page => { pages.push(page); await deps.onPage?.(page); }
      })
    });
    const result = await run.runtime.run();
    const replay = await readJournalRecords(result.runDirectory);
    const refs = replay.records.filter(record => record.kind === "discovery_page_ref");
    expect(refs).toHaveLength(1);
    expect(replay.records.filter(record => record.kind === "discovery_page")).toHaveLength(0);
    expect(replay.records.filter(record => record.source === "gamma" && record.kind === "http_request")).toHaveLength(1);
    const http = assertReference(replay.records, refs[0]!);
    expect((http.data as { response: unknown }).response).toEqual(response);
    expect(refs[0]!.data).toEqual({
      url: pages[0]!.url, requestStartedAt: pages[0]!.requestStartedAt, requestEndedAt: pages[0]!.requestEndedAt,
      responseRef: { runId: result.runId, sequence: http.sequence,
        sha256: createHash("sha256").update(serialized).digest("hex"), bytes: Buffer.byteLength(serialized) }
    });
    const metadata = replay.records.filter(record => record.kind === "event_metadata");
    expect(metadata).toHaveLength(1);
    expect(metadata[0]!.data).toEqual({ event: response.events[0], status: "discovered" });
    expect(metadata[0]!.sequence).toBeGreaterThan(refs[0]!.sequence);
    expect(run.starts).toEqual([["0001", "0002"]]);
    expect(replay.markets.map(market => market.tokenId)).toEqual(["0001", "0002"]);
    const files = (await readdir(result.runDirectory)).filter(name => name.endsWith(".ndjson"));
    const raw = (await Promise.all(files.map(name => readFile(join(result.runDirectory, name), "utf8")))).join("");
    expect(raw.split('"directoryPayload":').length - 1).toBe(1);
    expect(Buffer.byteLength(raw)).toBeLessThan(Buffer.byteLength(serialized) + 20_000);
  });

  test.each<CollectorOptions>([{}, { compactDiscoveryPages: false }])("keeps legacy full-page collection by default: %j", async options => {
    const run = await fixture(options);
    const result = await run.runtime.run();
    const replay = await readJournalRecords(result.runDirectory);
    const pages = replay.records.filter(record => record.kind === "discovery_page");
    expect(pages).toHaveLength(1);
    expect(pages[0]!.data).toHaveProperty("response", [event()]);
    expect(replay.records.some(record => record.kind === "discovery_page_ref")).toBe(false);
    expect(replay.records.find(record => record.kind === "session_start")!.data)
      .toHaveProperty("config.compactDiscoveryPages", false);
    expect(replay.markets.map(market => market.tokenId)).toEqual(["0001", "0002"]);
  });

  test.each(["custom", "equal-clone", "different-url"])("preserves a full %s page without reliable request correlation", async variant => {
    const url = "https://gamma.fixture.test/events";
    const response = { events: [], evidence: "custom response" };
    const page: Page = { url, requestStartedAt: timestamp, requestEndedAt: timestamp, response };
    const run = await fixture({ compactDiscoveryPages: true }, {
      request: async () => response,
      discover: async (_options, deps) => {
        if (variant !== "custom") {
          const tracked = await deps.request(url);
          page.response = variant === "equal-clone" ? structuredClone(tracked) : tracked;
          if (variant === "different-url") page.url = `${url}?other=1`;
        }
        await deps.onPage?.(page);
        return [];
      }
    });
    const result = await run.runtime.run();
    const { records } = await readJournalRecords(result.runDirectory);
    expect(records.filter(record => record.kind === "discovery_page_ref")).toHaveLength(0);
    expect(records.filter(record => record.kind === "discovery_page").map(record => record.data)).toEqual([page]);
  });

  test("mutation after an HTTP response preserves its original body and the changed page", async () => {
    const original = { events: [], version: "http response" };
    const url = "https://gamma.fixture.test/events";
    const run = await fixture({ compactDiscoveryPages: true }, {
      request: async () => original,
      discover: async (_options, deps) => {
        const response = await deps.request(url) as typeof original;
        response.version = "changed before onPage";
        await deps.onPage?.({ url, requestStartedAt: timestamp, requestEndedAt: timestamp, response });
        return [];
      }
    });
    const result = await run.runtime.run();
    const { records } = await readJournalRecords(result.runDirectory);
    expect(records.find(record => record.kind === "http_request")!.data).toHaveProperty("response.version", "http response");
    expect(records.find(record => record.kind === "discovery_page")!.data).toHaveProperty("response.version", "changed before onPage");
    expect(records.some(record => record.kind === "discovery_page_ref")).toBe(false);
  });

  test("keeps a full tracked page when the custom callback has no request end time", async () => {
    const url = "https://gamma.fixture.test/events";
    const run = await fixture({ compactDiscoveryPages: true }, {
      request: async () => ({ events: [], custom: true }),
      discover: async (_options, deps) => {
        await deps.onPage?.({ url, requestStartedAt: timestamp, response: await deps.request(url) });
        return [];
      }
    });
    const result = await run.runtime.run();
    const { records } = await readJournalRecords(result.runDirectory);
    expect(records.filter(record => record.kind === "discovery_page_ref")).toHaveLength(0);
    expect(records.find(record => record.kind === "discovery_page")!.data)
      .toEqual({ url, requestStartedAt: timestamp, response: { events: [], custom: true } });
  });

  test("an unserializable changed page keeps the existing fatal journal failure behavior", async () => {
    const url = "https://gamma.fixture.test/events";
    const run = await fixture({ compactDiscoveryPages: true }, {
      request: async () => ({ events: [] }),
      discover: async (_options, deps) => {
        const response = await deps.request(url) as Record<string, unknown>;
        response.circular = response;
        await deps.onPage?.({ url, requestStartedAt: timestamp, requestEndedAt: timestamp, response });
        return [];
      }
    });
    await expect(run.runtime.run()).rejects.toThrow(/circular/i);
    const { records } = await readJournalRecords(run.runtime.runDirectory!);
    expect(records.find(record => record.kind === "http_request")!.data).toHaveProperty("response", { events: [] });
    expect(records.some(record => record.kind === "discovery_page_ref")).toBe(false);
  });

  test("snapshots the HTTP response before admission can wait on storage", async () => {
    const response = { events: [], version: "at HTTP completion" };
    const run = await fixture({ compactDiscoveryPages: true }, {
      request: async () => response,
      createJournal: async options => {
        const journal = await createJournal(options);
        return { runId: journal.runId, runDirectory: journal.runDirectory,
          record: input => journal.record(input), close: () => journal.close(),
          flush: async () => { response.version = "mutated while waiting for admission"; await journal.flush(); } };
      }
    });
    const result = await run.runtime.run();
    const { records } = await readJournalRecords(result.runDirectory);
    expect(records.find(record => record.kind === "http_request")!.data)
      .toHaveProperty("response.version", "at HTTP completion");
    const ref = records.find(record => record.kind === "discovery_page_ref");
    expect(ref).toBeDefined();
    assertReference(records, ref!);
  });

  test("correlates concurrent requests even when the transport reuses one object and URL", async () => {
    const response = { events: [], evidence: "same transport object" };
    const urls = ["https://gamma.fixture.test/events?profile=a", "https://gamma.fixture.test/events?profile=b", "https://gamma.fixture.test/events?profile=a"];
    const observed: Page[] = [];
    let journal: Awaited<ReturnType<typeof createJournal>>;
    let entered = 0;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const run = await fixture({ compactDiscoveryPages: true }, {
      createJournal: async options => { journal = await createJournal(options); return journal; },
      request: async () => { if (++entered === urls.length) release(); await ready; return response; },
      discover: async (_options, deps) => {
        const pages = await Promise.all(urls.map(async url => ({
          url, requestStartedAt: timestamp, requestEndedAt: timestamp, response: await deps.request(url)
        })));
        journal.record({ source: "sports", kind: "ws_message", connectionId: "sports-0", data: "PONG" });
        for (const page of pages.reverse()) { observed.push(page); await deps.onPage?.(page); }
        return [];
      }
    });
    const result = await run.runtime.run();
    const { records } = await readJournalRecords(result.runDirectory);
    const http = records.filter(record => record.source === "gamma" && record.kind === "http_request");
    const refs = records.filter(record => record.kind === "discovery_page_ref");
    expect(http).toHaveLength(3);
    expect(refs).toHaveLength(3);
    expect(refs.map(record => (record.data as ReferencedPage).responseRef.sequence)).toEqual(http.map(record => record.sequence).reverse());
    refs.forEach((ref, index) => {
      assertReference(records, ref);
      expect(ref.data).toMatchObject({ url: observed[index]!.url, requestStartedAt: timestamp, requestEndedAt: timestamp });
    });
    expect(records.find(record => record.source === "sports")).toMatchObject({ kind: "ws_message", data: "PONG", connectionId: "sports-0" });
  });

  test("a new HTTP observation of a reused object gets a new reference", async () => {
    const response = { events: [], version: 1 };
    const url = "https://gamma.fixture.test/events";
    const run = await fixture({ compactDiscoveryPages: true }, {
      request: async () => response,
      discover: async (_options, deps) => {
        for (const version of [1, 2]) {
          response.version = version;
          await deps.onPage?.({ url, requestStartedAt: timestamp, requestEndedAt: timestamp, response: await deps.request(url) });
        }
        return [];
      }
    });
    const result = await run.runtime.run();
    const { records } = await readJournalRecords(result.runDirectory);
    const refs = records.filter(record => record.kind === "discovery_page_ref");
    expect(refs).toHaveLength(2);
    const sources = refs.map(ref => assertReference(records, ref));
    expect(sources.map(source => (source.data as { response: typeof response }).response.version)).toEqual([1, 2]);
    expect(sources[0]!.sequence).not.toBe(sources[1]!.sequence);
  });

  test("does not reuse a previous sweep's receipt for a custom page", async () => {
    const url = "https://gamma.fixture.test/events";
    let response: unknown;
    let sweeps = 0;
    const run = await fixture({ compactDiscoveryPages: true }, {
      request: async () => ({ events: [], evidence: "first sweep" }),
      discover: async (_options, deps) => {
        if (++sweeps === 1) response = await deps.request(url);
        await deps.onPage?.({ url, requestStartedAt: timestamp, requestEndedAt: timestamp, response });
        return [];
      }
    });
    try { await run.runtime.start(); await run.runtime.discoverOnce(); }
    finally { await run.runtime.stop(); }
    const { records } = await readJournalRecords(run.runtime.runDirectory!);
    expect(records.filter(record => record.kind === "http_request")).toHaveLength(1);
    const refs = records.filter(record => record.kind === "discovery_page_ref");
    expect(refs).toHaveLength(1);
    assertReference(records, refs[0]!);
    const pages = records.filter(record => record.kind === "discovery_page");
    expect(pages).toHaveLength(1);
    expect(pages[0]!.data).toHaveProperty("response", response);
  });

  test.each(["void", "wrong-run"])("falls back to full pages when a journal wrapper returns %s provenance", async variant => {
    const run = await fixture({ compactDiscoveryPages: true }, {
      createJournal: async options => {
        const journal = await createJournal(options);
        return { runId: journal.runId, runDirectory: journal.runDirectory,
          flush: () => journal.flush(), close: () => journal.close(), record: input => {
            const receipt = journal.record(input);
            if (variant === "wrong-run") return { ...receipt, runId: "another-run" };
          } };
      }
    });
    const result = await run.runtime.run();
    const { records } = await readJournalRecords(result.runDirectory);
    expect(records.filter(record => record.kind === "discovery_page_ref")).toHaveLength(0);
    expect(records.filter(record => record.kind === "discovery_page")).toHaveLength(1);
    expect(records.find(record => record.kind === "discovery_page")!.data).toHaveProperty("response", [event()]);
  });

  test("uses the actual unique journal run ID when a requested ID is reused", async () => {
    const first = await fixture({ runId: "same/run", compactDiscoveryPages: true });
    const firstResult = await first.runtime.run();
    const second = await fixture({ rootDir: first.rootDir, runId: "same/run", compactDiscoveryPages: true });
    const secondResult = await second.runtime.run();
    expect(firstResult.runId).not.toBe(secondResult.runId);
    for (const result of [firstResult, secondResult]) {
      const { records } = await readJournalRecords(result.runDirectory);
      const refs = records.filter(record => record.kind === "discovery_page_ref");
      expect(refs).toHaveLength(1);
      expect((refs[0]!.data as ReferencedPage).responseRef.runId).toBe(result.runId);
      assertReference(records, refs[0]!);
    }
  });

  test("preserves the original HTTP error without inventing a successful page", async () => {
    const failure = new TypeError("Gamma unavailable");
    const run = await fixture({ compactDiscoveryPages: true }, { request: async () => { throw failure; } });
    const result = await run.runtime.run();
    const { records } = await readJournalRecords(result.runDirectory);
    const requests = records.filter(record => record.kind === "http_request");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.data).toMatchObject({ error: { name: "TypeError", message: failure.message },
      requestStartedAt: expect.any(String), requestEndedAt: expect.any(String) });
    expect(requests[0]!.data).not.toHaveProperty("response");
    expect(records.some(record => record.kind.startsWith("discovery_page"))).toBe(false);
    expect(records.some(record => record.kind === "discovery_error")).toBe(true);
  });

  test("keeps every metadata observation and its time identical to legacy collection", async () => {
    const observations: unknown[][] = [];
    for (const compactDiscoveryPages of [false, true]) {
      let sweep = 0;
      const run = await fixture({ compactDiscoveryPages }, {
        request: async url => new URL(url).pathname === "/events"
          ? [{ ...event(), score: `${++sweep}-0`, endDate: "2000-01-01T00:00:00Z" }]
          : { bids: [], asks: [] }
      });
      try { await run.runtime.start(); await run.runtime.discoverOnce(); }
      finally { await run.runtime.stop(); }
      const replay = await readJournalRecords(run.runtime.runDirectory!);
      const metadata = replay.records.filter(record => record.kind === "event_metadata");
      expect(metadata).toHaveLength(2);
      expect(metadata.map(record => (record.data as { event: { score: string } }).event.score)).toEqual(["1-0", "2-0"]);
      expect(metadata[1]!.receivedAtMs).toBeGreaterThan(metadata[0]!.receivedAtMs);
      observations.push(metadata.map(({ data, receivedAt, receivedAtMs, sequence }) => ({ data, receivedAt, receivedAtMs, sequence })));
      expect(replay.markets.map(market => market.tokenId)).toEqual(["0001", "0002"]);
    }
    expect(observations[1]).toEqual(observations[0]);
  });
});
