import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createCollector, type CollectorStreamLike } from "../../src/collector/collector.js";
import { readJournalRecords } from "../../src/collector/replay.js";
import type { CatalogDependencies, CatalogOptions } from "../../src/collector/catalog.js";
import type { CollectorEvent, JsonRequester, RecordInput } from "../../src/collector/types.js";

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
