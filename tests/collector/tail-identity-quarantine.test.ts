import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { exportTail } from "../../src/collector/tail-export.js";
import { scanTailCatalog, tailOptions } from "../../src/collector/tail-catalog.js";
import { windowKeyForIdentity } from "../../src/collector/tail-context.js";
import type { JournalRecord } from "../../src/collector/types.js";
import { eventMetadata, fixtureRecords, journalRecord, writeFixture } from "./tail-fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function other(gameId: string, extra: Record<string, unknown> = {}) {
  return eventMetadata(0, { id: "unstable", slug: "unstable-match", gameId, markets: [{ id: "other-market", conditionId: "other-condition",
    outcomes: ["C", "D"], clobTokenIds: ["C", "D"], closed: false }], ...extra });
}
function order(rows: JournalRecord[]): JournalRecord[] {
  return [...rows].sort((a, b) => a.receivedAtMs - b.receivedAtMs)
    .map((row, index) => journalRecord(index + 1, row.receivedAtMs, row.source, row.kind, row.data, row.connectionId));
}
function drift(extra: JournalRecord[] = [], nextGame = "new-game"): JournalRecord[] {
  return order([...fixtureRecords(),
    journalRecord(1, 150, "gamma", "event_metadata", other("old-game")),
    journalRecord(1, 15_000, "gamma", "event_metadata", other(nextGame)), ...extra]);
}
async function write(rows: JournalRecord[]) {
  const root = await writeFixture(rows); roots.push(root); return { root, runDirectory: join(root, "run") };
}
const replay = { maxFeedSilenceMs: 600_000, sportsStaleAfterMs: 600_000 };

test("a disjoint unstable game ID does not change a selected game's price or score rows", async () => {
  const baseline = await write(fixtureRecords()), changed = await write(drift([
    journalRecord(1, 16_000, "sports", "ws_message", JSON.stringify({ slug: "unstable-match", gameId: "old-game", score: "99-0", ended: true, finishedAt: new Date(16_000).toISOString() })),
    journalRecord(1, 17_000, "sports", "ws_message", JSON.stringify({ slug: "unstable-match", gameId: "new-game", score: "0-99" }))
  ]));
  const a = join(baseline.root, "export"), b = join(changed.root, "export");
  await exportTail({ ...baseline, ...replay, outputDirectory: a, eventSlugs: ["game"] });
  const result = await exportTail({ ...changed, ...replay, outputDirectory: b, eventSlugs: ["game"] });
  expect(await readFile(join(b, "seconds.ndjson"))).toEqual(await readFile(join(a, "seconds.ndjson")));
  expect(result.summary.windows.map(window => window.key)).toEqual(["game:123"]);
  expect(result.summary.warnings.join("\n")).toMatch(/quarantined.*unstable.*old-game.*new-game/);
  expect(await readFile(join(b, "raw-events.ndjson"), "utf8")).toContain("unstable-match");
});

test.each([undefined, ["unstable-match"]])("the changed identity itself never becomes an approved window: %j", async eventSlugs => {
  const data = await write(drift());
  await expect(scanTailCatalog(tailOptions({ ...data, ...(eventSlugs ? { eventSlugs } : {}) }))).rejects.toThrow("TAIL_METADATA_IDENTITY_CONFLICT");
});

test("a drift into the selected game's identity cannot be hidden by filtering", async () => {
  const data = await write(drift([], "123"));
  await expect(scanTailCatalog(tailOptions({ ...data, eventSlugs: ["game"] }))).rejects.toThrow("TAIL_METADATA_IDENTITY_CONFLICT");
});

test.each(["condition", "token", "market"])("quarantine follows a shared historical %s identity", async shared => {
  const fields = { id: shared === "market" ? "winner" : "bridge-market", conditionId: shared === "condition" ? "condition" : "bridge-condition",
    outcomes: ["C", "D"], clobTokenIds: shared === "token" ? ["A", "D"] : ["C", "D"] };
  const rows = drift([journalRecord(1, 160, "gamma", "event_metadata", other("old-game", { markets: [fields] }))]);
  const data = await write(rows);
  await expect(scanTailCatalog(tailOptions({ ...data, eventSlugs: ["game"] }))).rejects.toThrow(/TAIL_(?:METADATA_IDENTITY|TOKEN_MAPPING)_CONFLICT/);
});

test.each(["condition", "market"])("quarantine follows a removed companion's shared %s", async shared => {
  const data = await write(drift([
    journalRecord(1, 160, "gamma", "event_metadata", other("old-game", { id: "bridge", slug: "bridge-match", markets: [{
      id: shared === "market" ? "winner" : "bridge-market", conditionId: shared === "condition" ? "condition" : "bridge-condition",
      outcomes: ["E", "F"], clobTokenIds: ["E", "F"]
    }] })),
    journalRecord(1, 20_000, "gamma", "event_metadata", other("old-game", { id: "bridge", slug: "bridge-match", markets: [] }))
  ]));
  await expect(scanTailCatalog(tailOptions({ ...data, eventSlugs: ["game"] }))).rejects.toThrow("TAIL_METADATA_IDENTITY_CONFLICT");
});

test.each([true, false])("a quarantined slug cannot smuggle a selected game's score or finish (early=%s)", async early => {
  const data = await write(drift([journalRecord(1, early ? 50 : 18_000, "sports", "ws_message",
    JSON.stringify({ slug: "unstable-match", gameId: "123", score: "99-0", finishedAt: new Date(30_000).toISOString() }))]));
  await expect(exportTail({ ...data, ...replay, outputDirectory: join(data.root, "failed"), eventSlugs: ["game"] }).then(() => true))
    .rejects.toThrow("TAIL_IDENTITY_CONFLICT");
});

test("unrelated game-ID quarantine preserves global sequence validation", async () => {
  const rows = drift(); rows[rows.length - 2]!.sequence = rows[rows.length - 3]!.sequence;
  const data = await write(rows);
  await expect(scanTailCatalog(tailOptions({ ...data, eventSlugs: ["game"] }))).rejects.toThrow("TAIL_SEQUENCE_ORDER");
});

test("a changed slug remains a hard identity failure", async () => {
  const data = await write(order([...fixtureRecords(), journalRecord(1, 150, "gamma", "event_metadata", other("old-game")),
    journalRecord(1, 15_000, "gamma", "event_metadata", other("old-game", { slug: "different-match" }))]));
  await expect(scanTailCatalog(tailOptions({ ...data, eventSlugs: ["game"] }))).rejects.toThrow("TAIL_METADATA_IDENTITY_CONFLICT");
});

test("a quarantined finish fact cannot contradict a healthy event ID", async () => {
  const data = await write(drift()), finishFactsFile = join(data.root, "facts.json");
  await writeFile(finishFactsFile, JSON.stringify({ schemaVersion: 1, kind: "tail-finish-facts", runId: "tail-test", facts: [{
    eventId: "event", eventSlug: "unstable-match", gameId: "old-game", atMs: 16_000, observedAtMs: 400_000,
    source: "sports.finishedAt", sourceRunId: "later", sourceRunDirectory: null, sequence: 1, frameIndex: 0
  }] }));
  await expect(scanTailCatalog(tailOptions({ ...data, eventSlugs: ["game"], finishFactsFile })).then(() => true))
    .rejects.toThrow("TAIL_FACTS_IDENTITY_MISMATCH");
});

test("same-game companion observations preserve the pre-existing shared-market behavior", async () => {
  const data = await write(order([...fixtureRecords(),
    journalRecord(1, 150, "gamma", "event_metadata", other("old-game")),
    journalRecord(1, 160, "gamma", "event_metadata", other("old-game", { id: "peer", slug: "peer-match" }))
  ]));
  const catalog = await scanTailCatalog(tailOptions({ ...data, eventSlugs: ["game"] }));
  expect(catalog.windows.map(window => window.key)).toEqual(["game:123"]);
  expect(catalog.windowIdentities).toContainEqual({ key: "game:old-game", gameId: "old-game", eventSlugs: ["unstable-match", "peer-match"] });
});

test("a same-game peer sharing a disputed market stays inside quarantine", async () => {
  const data = await write(drift([
    journalRecord(1, 16_000, "gamma", "event_metadata", other("new-game", { markets: [] })),
    journalRecord(1, 17_000, "gamma", "event_metadata", other("new-game", { id: "peer", slug: "peer-match" }))
  ]));
  const catalog = await scanTailCatalog(tailOptions({ ...data, eventSlugs: ["game"] }));
  expect(catalog.windows.map(window => window.key)).toEqual(["game:123"]);
  const reserved = catalog.windowIdentities.find(window => window.key.startsWith("quarantine:"))!;
  expect(reserved.eventSlugs).toEqual(expect.arrayContaining(["unstable-match", "peer-match"]));
  expect(reserved.gameIdAliases).toEqual(expect.arrayContaining(["old-game", "new-game"]));
  expect(() => windowKeyForIdentity({ eventSlug: "peer-match", gameId: "123" }, catalog.windowIdentities)).toThrow("TAIL_IDENTITY_CONFLICT");
  await expect(scanTailCatalog(tailOptions({ ...data, eventSlugs: ["peer-match"] }))).rejects.toThrow("TAIL_METADATA_IDENTITY_CONFLICT");
});

test("a cross-event token transfer into a different game remains a hard failure", async () => {
  const data = await write(drift([journalRecord(1, 17_000, "gamma", "event_metadata", other("foreign-game", { id: "peer", slug: "peer-match" }))]));
  await expect(scanTailCatalog(tailOptions({ ...data, eventSlugs: ["game"] }))).rejects.toThrow("TAIL_TOKEN_MAPPING_CONFLICT");
});

test.each(["condition", "market", "token"])("an incomplete raw market cannot hide a shared %s edge", async shared => {
  const partial = { id: shared === "market" ? "winner" : "partial-market",
    conditionId: shared === "condition" ? "condition" : "partial-condition",
    clobTokenIds: shared === "token" ? ["A"] : ["G", "H"] }; // No outcomes: normalization drops it.
  const data = await write(drift([journalRecord(1, 160, "gamma", "event_metadata", other("old-game", { markets: [partial] }))]));
  await expect(exportTail({ ...data, ...replay, outputDirectory: join(data.root, "failed"), eventSlugs: ["game"] }).then(() => true))
    .rejects.toThrow("TAIL_METADATA_IDENTITY_CONFLICT");
});

test.each([
  { changed: true, finish: true }, { changed: false, finish: true },
  { changed: true, finish: false }, { changed: false, finish: false }
])("partial native Gamma state keeps its known event binding: %j", async ({ changed, finish }) => {
  const partial = journalRecord(1, 18_000, "gamma", "event_metadata", { event: {
    id: "unstable", gameId: "123", ...(finish ? { finishedTimestamp: new Date(310_000).toISOString() } : { score: "99-0" })
  } }); // No slug, but its event ID belongs to the other game.
  const rows = changed ? drift([partial]) : order([...fixtureRecords(),
    journalRecord(1, 150, "gamma", "event_metadata", other("old-game")), partial]);
  if (finish) for (const row of rows) {
    const event = (row.data as { event?: Record<string, unknown> })?.event;
    if (event?.id === "event") delete event.finishedTimestamp;
  }
  const data = await write(rows);
  await expect(exportTail({ ...data, ...replay, outputDirectory: join(data.root, "failed"), eventSlugs: ["game"] }).then(() => true))
    .rejects.toThrow(/TAIL_(?:METADATA_)?IDENTITY_CONFLICT/);
});

test("a raw-only quarantined event ID cannot lend a healthy game its finish", async () => {
  const rows = drift([journalRecord(1, 160, "gamma", "event_metadata", { event: { id: "partial-peer", gameId: "old-game" } })]);
  for (const row of rows) {
    const event = (row.data as { event?: Record<string, unknown> })?.event;
    if (event?.id === "event") delete event.finishedTimestamp;
  }
  const data = await write(rows), finishFactsFile = join(data.root, "facts.json");
  await writeFile(finishFactsFile, JSON.stringify({ schemaVersion: 1, kind: "tail-finish-facts", runId: "tail-test", facts: [{
    eventId: "partial-peer", eventSlug: null, gameId: "123", atMs: 310_000, observedAtMs: 400_000,
    source: "sports.finishedAt", sourceRunId: "later", sourceRunDirectory: null, sequence: 1, frameIndex: 0
  }] }));
  await expect(exportTail({ ...data, ...replay, eventSlugs: ["game"], finishFactsFile, outputDirectory: join(data.root, "failed") }).then(() => true))
    .rejects.toThrow(/TAIL_(?:FACTS_IDENTITY_MISMATCH|IDENTITY_CONFLICT)/);
});

test("game-ID changes in entirely partial native events are still registered", async () => {
  const rows = order([...fixtureRecords(),
    journalRecord(1, 150, "gamma", "event_metadata", { event: { id: "partial-peer", gameId: "456" } }),
    journalRecord(1, 18_000, "gamma", "event_metadata", { event: { id: "partial-peer", gameId: "123", finishedTimestamp: new Date(310_000).toISOString() } })
  ]);
  for (const row of rows) {
    const event = (row.data as { event?: Record<string, unknown> })?.event;
    if (event?.id === "event") delete event.finishedTimestamp;
  }
  const data = await write(rows);
  await expect(exportTail({ ...data, ...replay, eventSlugs: ["game"], outputDirectory: join(data.root, "failed") }).then(() => true))
    .rejects.toThrow("TAIL_METADATA_IDENTITY_CONFLICT");
});

test.each(["123", "old-game"])("raw-only market links constrain later finish game %s", async gameId => {
  const rows = order([...fixtureRecords(),
    journalRecord(1, 150, "gamma", "event_metadata", other("old-game")),
    journalRecord(1, 160, "gamma", "event_metadata", { event: { id: "partial-peer", markets: [{ conditionId: "condition" }] } })
  ]);
  const data = await write(rows), finishFactsFile = join(data.root, "facts.json");
  await writeFile(finishFactsFile, JSON.stringify({ schemaVersion: 1, kind: "tail-finish-facts", runId: "tail-test", facts: [{
    eventId: "partial-peer", eventSlug: null, gameId, atMs: 310_000, observedAtMs: 400_000,
    source: "sports.finishedAt", sourceRunId: "later", sourceRunDirectory: null, sequence: 1, frameIndex: 0
  }] }));
  const run = scanTailCatalog(tailOptions({ ...data, eventSlugs: [gameId === "123" ? "game" : "unstable-match"], finishFactsFile }));
  if (gameId === "123") expect((await run).windows[0]!.key).toBe("game:123");
  else await expect(run.then(() => true)).rejects.toThrow(/TAIL_(?:FACTS_IDENTITY_MISMATCH|IDENTITY_CONFLICT)/);
});

test.each([true, false])("a changed native eventSlug alias is still a hard conflict (finish=%s)", async finish => {
  const rows = order([...fixtureRecords(), journalRecord(1, 18_000, "gamma", "event_metadata", { event: {
    id: "event", eventSlug: "renamed-game", gameId: "123",
    ...(finish ? { finishedTimestamp: new Date(310_000).toISOString() } : { score: "99-0" })
  } })]);
  if (finish) for (const row of rows) {
    const event = (row.data as { event?: Record<string, unknown> })?.event;
    if (event?.slug === "game") delete event.finishedTimestamp;
  }
  const data = await write(rows);
  await expect(exportTail({ ...data, ...replay, eventSlugs: ["game"], outputDirectory: join(data.root, "failed") }).then(() => true))
    .rejects.toThrow("TAIL_METADATA_IDENTITY_CONFLICT");
});
