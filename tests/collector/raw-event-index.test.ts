import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadRawEventIndex } from "../../src/collector/raw-event-index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "poly-fifa-raw-index-")); roots.push(path); return path; }

function eventDocument(options: { id: string; closed: boolean; markets?: number }): Record<string, unknown> {
  const markets = Array.from({ length: options.markets ?? 1 }, (_, index) => ({
    id: `${options.id}-m${index}`, conditionId: `0x${options.id}${index}`.padEnd(66, "0"), slug: `${options.id}-m${index}`,
    question: "Winner?", outcomes: ["A", "B"], clobTokenIds: [`${options.id}-t${index}a`, `${options.id}-t${index}b`],
    sportsMarketType: "moneyline", closed: options.closed, acceptingOrders: !options.closed
  }));
  return { id: options.id, slug: `${options.id}-slug`, title: `${options.id} match`, gameId: `g-${options.id}`,
    sport: "tennis", tags: [{ slug: "tennis" }], markets };
}

function record(runId: string, sequence: number, receivedAtMs: number, data: unknown): string {
  return JSON.stringify({ schemaVersion: 1, runId, sequence, receivedAt: new Date(receivedAtMs).toISOString(),
    receivedAtMs, monotonicNs: String(sequence), source: "gamma", kind: "event_metadata", data }) + "\n";
}

async function writeRun(runsRoot: string, name: string, lines: string[]): Promise<void> {
  const directory = join(runsRoot, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "2026-09-20-000001.ndjson"), lines.join(""));
}

describe("raw run event index", () => {
  test("keeps the trading-time document instead of a later reconciled terminal copy", async () => {
    const path = await root(), runs = join(path, "runs");
    // The open document is written first and the terminal one last, so a
    // "last observation wins" index would pick the closed shape.
    await writeRun(runs, "a-open", [record("run-a", 1, 1_000, { event: eventDocument({ id: "evt", closed: false, markets: 2 }) })]);
    await writeRun(runs, "z-closed", [record("run-z", 1, 900_000, { event: eventDocument({ id: "evt", closed: true, markets: 2 }) })]);

    const index = await loadRawEventIndex(runs);
    const shape = index.get("event:evt");
    expect(shape).toBeDefined();
    const markets = shape!.markets as Array<{ closed?: boolean }>;
    expect(markets.every(market => market.closed === false)).toBe(true);
    expect(index.get("game:g-evt")).toBe(shape);
  });

  test("prefers the document covering more markets when neither is terminal", async () => {
    const path = await root(), runs = join(path, "runs");
    await writeRun(runs, "a-partial", [record("run-a", 1, 1_000, { event: eventDocument({ id: "evt", closed: false, markets: 1 }) })]);
    await writeRun(runs, "b-full", [record("run-b", 1, 2_000, { event: eventDocument({ id: "evt", closed: false, markets: 3 }) })]);

    const index = await loadRawEventIndex(runs);
    expect((index.get("event:evt")!.markets as unknown[]).length).toBe(3);
  });

  test("still returns an all-closed document when nothing better was retained", async () => {
    const path = await root(), runs = join(path, "runs");
    await writeRun(runs, "only", [record("run-a", 1, 1_000, { event: eventDocument({ id: "evt", closed: true, markets: 1 }) })]);
    const index = await loadRawEventIndex(runs);
    expect((index.get("event:evt")!.markets as Array<{ closed?: boolean }>)[0]?.closed).toBe(true);
  });

  test("one malformed envelope does not discard later event metadata in the same run", async () => {
    const path = await root(), runs = join(path, "runs");
    const broken = JSON.stringify({ schemaVersion: 1, runId: "run-a", sequence: 2, receivedAtMs: 2_000,
      receivedAt: new Date(2_000).toISOString(), monotonicNs: "2", source: "gamma", kind: "event_metadata" }) + "\n";
    await writeRun(runs, "mixed-envelope", [
      record("run-a", 1, 1_000, { event: eventDocument({ id: "first", closed: false }) }),
      broken,
      record("run-a", 3, 3_000, { event: eventDocument({ id: "after", closed: false }) })
    ]);
    const index = await loadRawEventIndex(runs);
    expect(index.has("event:first")).toBe(true);
    expect(index.has("event:after")).toBe(true);
  });

  test("one unreadable document does not discard the rest of the run", async () => {
    const path = await root(), runs = join(path, "runs");
    // A metadata record whose gameId fields disagree makes metadataFromRecord throw.
    const conflicting = { event: { ...eventDocument({ id: "broken", closed: false }), gameId: "g-1", eventMetadata: { gameId: "g-2" } } };
    await writeRun(runs, "mixed", [
      record("run-a", 1, 1_000, conflicting),
      record("run-a", 2, 2_000, { event: eventDocument({ id: "good", closed: false }) })
    ]);
    const index = await loadRawEventIndex(runs);
    expect(index.has("event:good")).toBe(true);
  });
});
