import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { scanTailCatalog, tailOptions } from "../../src/collector/tail-catalog.js";
import { exportTail } from "../../src/collector/tail-export.js";
import { replayTail } from "../../src/collector/tail-replay.js";
import type { TailFinishFact, TailOptions, TailSecond, TailStateChange } from "../../src/collector/tail-types.js";
import type { JournalRecord } from "../../src/collector/types.js";
import { eventMetadata, fixtureRecords, journalRecord, writeFixture } from "./tail-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const replayOptions = { maxFeedSilenceMs: 600_000, sportsStaleAfterMs: 600_000 };
function fact(overrides: Partial<TailFinishFact> = {}): TailFinishFact {
  return { eventId: "event", eventSlug: "game", gameId: "123", atMs: 310_000, observedAtMs: 450_000,
    source: "gamma.finishedTimestamp", sourceRunId: "r2", sourceRunDirectory: "/original/r2", sequence: 42, frameIndex: 0, ...overrides };
}
function document(facts: unknown[] = [fact()]): Record<string, unknown> {
  return { schemaVersion: 1, kind: "tail-finish-facts", runId: "tail-test", facts };
}
function oldRecords(): JournalRecord[] {
  const records = fixtureRecords();
  records[1]!.data = eventMetadata(0);
  return records;
}
async function input(payload: unknown = document(), records = oldRecords()) {
  const root = await writeFixture(records);
  roots.push(root);
  const runDirectory = join(root, "run"), finishFactsFile = join(root, "finish-facts.json");
  await writeFile(finishFactsFile, JSON.stringify(payload));
  return { root, runDirectory, finishFactsFile, records };
}
async function replay(options: TailOptions) {
  const seconds: TailSecond[] = [], raw: JournalRecord[] = [], stateChanges: Array<TailStateChange & { windowKey: string }> = [];
  const summary = await replayTail({ ...replayOptions, ...options }, {
    second: row => { seconds.push(structuredClone(row)); }, rawRecord: record => { raw.push(record); },
    change: () => {}, audit: () => {}, stateChange: row => { stateChanges.push(row); }
  });
  return { summary, seconds, raw, stateChanges };
}
function twoGames(): JournalRecord[] {
  const records = oldRecords();
  records.splice(2, 0, journalRecord(1, 101, "gamma", "event_metadata",
    eventMetadata(0, { id: "other-event", slug: "other-game", gameId: "456", markets: [] })));
  records.forEach((record, index) => { record.sequence = index + 1; });
  return records;
}

describe("normalized cross-run finish facts", () => {
  test("anchors old books from a later fact without importing late scores, closure, markets or raw bodies", async () => {
    const original = fact();
    const data = await input(document([{ ...original, score: "99-99", period: "FINAL", closed: true,
      event: { id: "future-event", score: "99-99", closed: true, markets: [{ clobTokenIds: ["future-A", "future-B"] }] },
      response: { status: 200, body: "not an HTTP response" }, raw: "do-not-retain-this-body" }]));
    const journalFile = join(data.runDirectory, "1970-01-01-000000.ndjson");
    const before = await readFile(journalFile, "utf8"), factsBefore = await readFile(data.finishFactsFile, "utf8");
    const result = await replay(data);
    expect(result.summary).toMatchObject({ runId: "tail-test", records: data.records.length, seconds: 600 });
    expect(result.summary.windows[0]).toMatchObject({ startAtMs: 10_000, endAtMs: 310_000, finishConflict: false,
      finishEvidence: [{ ...original, sourceFile: data.finishFactsFile }] });
    expect(result.summary.windows[0]?.markets.map(market => market.tokenId)).toEqual(["A", "B"]);
    expect(result.summary.tokens.every(token => token.readyForReplay)).toBe(true);
    expect(result.seconds.find(row => row.tokenId === "A" && row.startAtMs === 10_000))
      .toMatchObject({ score: "0-0", bestBid: "0.95", bookObservedAtMs: 9000, bookSourceAtMs: 9000 });
    expect(result.seconds.find(row => row.tokenId === "A" && row.startAtMs === 12_000)).toMatchObject({ score: "1-0", bestBid: "0.94" });
    expect(result.stateChanges.every(change => change.observedAtMs < 310_000)).toBe(true);
    expect(result.raw).toEqual(data.records.filter(record => record.receivedAtMs >= 10_000 && record.receivedAtMs < 310_000));
    expect(JSON.stringify(result.summary)).not.toContain("do-not-retain-this-body");
    expect(await readFile(journalFile, "utf8")).toBe(before);
    expect(await readFile(data.finishFactsFile, "utf8")).toBe(factsBefore);
  });

  test("native F1 plus r2 F2 retains r1 books and marks the conflicting finish", async () => {
    const newer = fact({ atMs: 310_001 });
    const data = await input(document([newer]), fixtureRecords());
    const { summary, seconds, raw } = await replay(data);
    expect(summary.windows[0]).toMatchObject({ startAtMs: 10_000, endAtMs: 310_000, finishConflict: true });
    expect(summary.windows[0]?.finishEvidence).toContainEqual({ ...newer, sourceFile: data.finishFactsFile });
    expect(summary.windows[0]?.finishEvidence).toContainEqual({ atMs: 310_000, observedAtMs: 100,
      source: "gamma.finishedTimestamp", eventSlug: "game" });
    expect(summary.tokens.every(token => !token.observedWindowComplete && !token.readyForReplay)).toBe(true);
    expect(seconds).toHaveLength(600);
    expect(seconds.every(row => row.reasons.includes("conflicting-finish-labels"))).toBe(true);
    expect(seconds.find(row => row.tokenId === "A" && row.startAtMs === 11_000)?.bestBid).toBe("0.94");
    expect(raw).toEqual(data.records.filter(record => record.receivedAtMs >= 10_000 && record.receivedAtMs < 310_000));
  });

  test("retains independent source-run, sequence and frame provenance for conflicting and agreeing facts", async () => {
    const facts = [fact(), fact({ sourceRunId: "r3", sourceRunDirectory: null, sequence: 1 }),
      fact({ atMs: 310_001, source: "sports.finishedAt", eventId: null, eventSlug: null, sequence: 43, frameIndex: 7 })];
    const data = await input(document(facts));
    const catalog = await scanTailCatalog(tailOptions(data));
    expect(catalog.windows[0]).toMatchObject({ endAtMs: 310_000, finishConflict: true,
      finishSources: ["gamma.finishedTimestamp", "sports.finishedAt"] });
    expect(catalog.windows[0]?.finishEvidence).toEqual(facts.map(value => ({ ...value, sourceFile: data.finishFactsFile })));
  });

  test.each([
    { eventId: null, eventSlug: null, gameId: "123", source: "sports.finishedAt" },
    { eventId: "event", eventSlug: null, gameId: "123" },
    { eventId: null, eventSlug: "game", gameId: null },
    { eventId: "companion-event", eventSlug: "game-companion", gameId: "123" },
    { eventId: null, eventSlug: "game-companion", gameId: "123" }
  ] as const)("resolves compatible optional and companion identities %j", async identity => {
    const data = await input(document([fact(identity)]), twoGames());
    const catalog = await scanTailCatalog(tailOptions({ ...data, eventSlugs: ["game"] }));
    expect(catalog.windows).toHaveLength(1);
    expect(catalog.windows[0]).toMatchObject({ key: "game:123", endAtMs: 310_000, eventIds: ["event"], eventSlugs: ["game"] });
    expect(catalog.windowIdentities).toHaveLength(2);
  });

  test.each([
    { eventId: null, eventSlug: "other-game", gameId: "123" },
    { eventId: "event", eventSlug: "other-game", gameId: "456" },
    { eventId: "other-event", eventSlug: null, gameId: "123" },
    { eventId: "event", eventSlug: "game-companion", gameId: "123" },
    { eventId: "unknown-event", eventSlug: "game", gameId: "123" },
    { eventId: "unknown-event", eventSlug: "game-companion", gameId: null },
    { eventId: null, eventSlug: "game", gameId: "0123" },
    { eventId: null, eventSlug: "unknown-game", gameId: "unknown-id" }
  ])("rejects conflicting or unresolved identities despite event selection %j", async identity => {
    const data = await input(document([fact(identity)]), twoGames());
    await expect(scanTailCatalog(tailOptions({ ...data, eventSlugs: ["game"] }))).rejects.toThrow(/TAIL_(?:FACTS_IDENTITY_MISMATCH|IDENTITY_CONFLICT)/);
  });

  test("existing HTTP finish labels and normalized facts coexist with independent provenance", async () => {
    const newer = fact({ atMs: 310_001 });
    const data = await input(document([newer]));
    const finishLabelsFile = join(data.root, "http-labels.json");
    const body = JSON.stringify((eventMetadata(310_000, { score: "88-88", closed: true }) as { event: unknown }).event);
    const labelText = JSON.stringify({ schemaVersion: 1, kind: "tail-finish-labels", runId: "tail-test", events: [{
      eventId: "event", eventSlug: "game", gameId: "123", receivedAtMs: 400_000, response: { status: 200, body }
    }] });
    await writeFile(finishLabelsFile, labelText);
    const { summary, seconds } = await replay({ ...data, finishLabelsFile });
    expect(summary.windows[0]).toMatchObject({ endAtMs: 310_000, finishConflict: true });
    expect(summary.windows[0]?.finishEvidence).toEqual([
      { atMs: 310_000, observedAtMs: 400_000, source: "gamma.finishedTimestamp", eventSlug: "game", sourceFile: finishLabelsFile },
      { ...newer, sourceFile: data.finishFactsFile }
    ]);
    expect(seconds[0]?.score).toBe("0-0");
    expect(await readFile(finishLabelsFile, "utf8")).toBe(labelText);
  });

  test("detects same-length sidecar changes between catalog and replay even when only ignored extras change", async () => {
    const payload = document([{ ...fact(), note: "before" }]);
    const data = await input(payload, fixtureRecords());
    let changed = false;
    await expect(replayTail(data, {
      second: async () => {
        if (changed) return;
        changed = true;
        await writeFile(data.finishFactsFile, JSON.stringify(document([{ ...fact(), note: "after!" }])));
      }, change: () => {}, audit: () => {}, stateChange: () => {}
    })).rejects.toThrow("TAIL_INPUT_CHANGED: finish facts");
    expect(changed).toBe(true);
  });

  test("the export manifest records the normalized facts path and exports the old run", async () => {
    const data = await input();
    const outputDirectory = join(data.root, "tail");
    const result = await exportTail({ ...data, outputDirectory, ...replayOptions });
    expect(JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8")))
      .toMatchObject({ sourceRunId: "tail-test", sourceRunDirectory: resolve(data.runDirectory), finishFactsFile: resolve(data.finishFactsFile), finishLabelsFile: null });
    expect(result.summary.seconds).toBe(600);
  });

  test.each([null, [], {}, { ...document(), schemaVersion: "1" }, { ...document(), kind: "tail-finish-labels" },
    { ...document(), runId: "r2" }, { ...document(), runId: 123 }, { ...document(), facts: {} }, { ...document(), facts: [null] },
    document([{ ...fact(), eventSlug: null, gameId: null }])].map(payload => ({ payload })))("rejects invalid schema or target run %j", async ({ payload }) => {
    const data = await input(payload);
    await expect(scanTailCatalog(tailOptions(data))).rejects.toThrow("TAIL_FACTS_SCHEMA_INVALID");
  });

  test.each([
    ["eventId", 123], ["eventId", ""], ["eventId", " event"], ["eventId", undefined],
    ["eventSlug", 123], ["eventSlug", " game"], ["eventSlug", ""], ["eventSlug", undefined],
    ["gameId", 123], ["gameId", "123 "], ["gameId", ""], ["gameId", undefined],
    ["atMs", "310000"], ["atMs", null], ["atMs", 310_000.5], ["atMs", Number.MAX_SAFE_INTEGER],
    ["atMs", 8_640_000_000_000_001], ["atMs", -8_640_000_000_000_001], ["atMs", Infinity],
    ["observedAtMs", "450000"], ["observedAtMs", null], ["observedAtMs", 450_000.5], ["observedAtMs", Number.MAX_SAFE_INTEGER],
    ["source", "gamma"], ["source", "sports-ws"], ["source", null],
    ["sourceRunId", 2], ["sourceRunId", null], ["sourceRunId", ""], ["sourceRunId", " r2"], ["sourceRunId", undefined],
    ["sourceRunDirectory", 2], ["sourceRunDirectory", ""], ["sourceRunDirectory", undefined],
    ["sequence", 0], ["sequence", -1], ["sequence", 1.5], ["sequence", "42"], ["sequence", Number.MAX_SAFE_INTEGER + 1],
    ["frameIndex", -1], ["frameIndex", 1.5], ["frameIndex", "0"], ["frameIndex", Number.MAX_SAFE_INTEGER + 1]
  ])("rejects invalid fact field %s=%j without coercion", async (field, value) => {
    const data = await input(document([{ ...fact(), [field as string]: value }]));
    await expect(scanTailCatalog(tailOptions(data))).rejects.toThrow("TAIL_FACTS_SCHEMA_INVALID");
  });

  test("rejects malformed JSON explicitly", async () => {
    const data = await input();
    await writeFile(data.finishFactsFile, '{"schemaVersion":1,');
    await expect(scanTailCatalog(tailOptions(data))).rejects.toThrow("TAIL_FACTS_SCHEMA_INVALID");
  });

  test("an explicitly empty facts path is invalid", () => {
    expect(() => tailOptions({ runDirectory: "unused", finishFactsFile: "" })).toThrow("TAIL_OPTIONS_INVALID: finishFactsFile");
  });

  test("retains at most 10000 normalized facts and rejects the next without truncation", async () => {
    for (const count of [10_000, 10_001]) {
      const facts = Array.from({ length: count }, (_, index) => fact({ sequence: index + 1 }));
      const data = await input(document(facts));
      const scan = scanTailCatalog(tailOptions(data));
      if (count > 10_000) await expect(scan).rejects.toThrow("TAIL_FACTS_LIMIT_EXCEEDED");
      else {
        const catalog = await scan;
        expect(catalog.windows[0]?.finishEvidence).toHaveLength(count);
        expect(catalog.windows[0]?.finishEvidence?.at(-1)).toEqual({ ...facts.at(-1), sourceFile: data.finishFactsFile });
        expect(catalog.factsStamp).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  });

  test("rejects oversized raw extras before retaining an unbounded sidecar", async () => {
    const data = await input(document([{ ...fact(), raw: "x".repeat(16 * 1024 * 1024) }]));
    await expect(scanTailCatalog(tailOptions(data))).rejects.toThrow("TAIL_FACTS_FILE_TOO_LARGE");
  });
});
