import { createHash } from "node:crypto";
import { readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { exportTail } from "../../src/collector/tail-export.js";
import { fixtureRecords, writeFixture, eventMetadata } from "../collector/tail-fixture.js";
import { loadTailArchive, collectTailSettlements } from "../../src/research/tail-backtest-io.js";
import type { TailSummary } from "../../src/collector/tail-types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await writeFixture(fixtureRecords()); roots.push(root);
  const output = join(root, "archive");
  await exportTail({ runDirectory: join(root, "run"), outputDirectory: output, windowSeconds: 301 });
  return { root, output };
}
const response = (raw: unknown, status = 200) => ({ status, statusText: status === 200 ? "OK" : "Unavailable", headers: {}, body: JSON.stringify(raw) });
async function resolvedCopies(output: string, amend: (raw: Record<string, unknown>, index: number) => void) {
  const path = join(output, "quality.json"), summary = JSON.parse(await readFile(path, "utf8")) as TailSummary;
  summary.windows[0]!.markets.forEach((market, index) => {
    Object.assign(market.raw, { closed: true, umaResolutionStatus: "resolved", outcomePrices: ["1", "0"] });
    amend(market.raw, index);
  });
  await writeFile(path, JSON.stringify(summary));
}

test("loads an actual complete tail archive and fingerprints every input file", async () => {
  const f = await fixture(), result = await loadTailArchive(f.output, { sport: "soccer" });
  expect(result.input.sport).toBe("soccer");
  expect(result.input.summary.runId).toBe("tail-test");
  expect(result.input.seconds).toHaveLength(result.input.summary.seconds);
  expect(result.input.changes).toHaveLength(result.input.summary.changes);
  const seconds = result.provenance.files.find(file => file.name === "seconds.ndjson")!;
  expect(seconds.sha256).toBe(createHash("sha256").update(await readFile(join(f.output, "seconds.ndjson"))).digest("hex"));
});

test("refuses an incomplete manifest and a mismatched source run", async () => {
  const f = await fixture(), path = join(f.output, "manifest.json"), original = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...original, status: "failed" }));
  await expect(loadTailArchive(f.output)).rejects.toThrow("TAIL_BACKTEST_INPUT_INVALID");
  await writeFile(path, JSON.stringify({ ...original, sourceRunId: "other-run" }));
  await expect(loadTailArchive(f.output)).rejects.toThrow("TAIL_BACKTEST_INPUT_INVALID");
});

test("does not follow a depth-file symlink or trust a filename supplied by the manifest", async () => {
  const f = await fixture(), source = join(f.output, "seconds.ndjson"), outside = join(f.root, "external.ndjson");
  await rename(source, outside); await symlink(outside, source);
  await expect(loadTailArchive(f.output)).rejects.toThrow("TAIL_BACKTEST_INPUT_INVALID");
});

test("rejects a valid-looking final NDJSON row that lacks its commit newline", async () => {
  const f = await fixture(), path = join(f.output, "seconds.ndjson"), bytes = await readFile(path);
  await writeFile(path, bytes.subarray(0, -1));
  const manifestPath = join(f.output, "manifest.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, depthFileBytes: bytes.length - 1 }));
  await expect(loadTailArchive(f.output)).rejects.toThrow(/TAIL_BACKTEST_INPUT_INVALID.*newline/);
});

test("bounds input sizes before loading large book data", async () => {
  const f = await fixture();
  await expect(loadTailArchive(f.output, { maxFileBytes: 32 })).rejects.toThrow("TAIL_BACKTEST_INPUT_TOO_LARGE");
});

test("records new public Gamma evidence and maps payouts by exact token identity", async () => {
  const f = await fixture(), loaded = await loadTailArchive(f.output, { sport: "soccer" });
  const raw = structuredClone(eventMetadata().event) as Record<string, unknown>;
  const markets = raw.markets as Array<Record<string, unknown>>;
  Object.assign(markets[0]!, { closed: true, umaResolutionStatus: "resolved", outcomes: ["B", "A"], clobTokenIds: ["B", "A"], outcomePrices: ["0", "1"] });
  const result = await collectTailSettlements([loaded.input], { now: () => 1_700_000_000_000, request: async url => {
    expect(url).toContain("gamma-api.polymarket.com/events/slug/game"); return response(raw);
  } });
  expect(result.settlements).toEqual(expect.arrayContaining([
    expect.objectContaining({ tokenId: "A", payout: 1, marketId: "winner", conditionId: "condition" }),
    expect.objectContaining({ tokenId: "B", payout: 0 })
  ]));
  expect(result.observations).toHaveLength(1);
  expect(result.observations[0]!.response.body).toBe(JSON.stringify(raw));
  expect(loaded.input.summary.windows[0]!.markets[0]!.raw.closed).toBe(false);
});

test("falls back to closed CLOB winner flags without treating current quotes as payouts", async () => {
  const f = await fixture(), loaded = await loadTailArchive(f.output);
  const result = await collectTailSettlements([loaded.input], { request: async url => url.includes("gamma-api")
    ? response(eventMetadata().event)
    : response({ condition_id: "condition", closed: true, tokens: [{ token_id: "B", winner: true, price: 0.7 }, { token_id: "A", winner: false, price: 0.3 }] }) });
  expect(result.settlements).toEqual(expect.arrayContaining([
    expect.objectContaining({ tokenId: "A", payout: 0, source: "clob-winner-flags" }),
    expect.objectContaining({ tokenId: "B", payout: 1, source: "clob-winner-flags" })
  ]));
});

test("unknown winners and mismatched condition identities remain unresolved", async () => {
  const f = await fixture(), loaded = await loadTailArchive(f.output);
  for (const market of [
    { condition_id: "foreign", closed: true, tokens: [{ token_id: "A", winner: true }, { token_id: "B", winner: false }] },
    { condition_id: "condition", closed: true, tokens: [{ token_id: "A", winner: false }, { token_id: "B", winner: false }] }
  ]) {
    const result = await collectTailSettlements([loaded.input], { request: async url => url.includes("gamma-api") ? response(eventMetadata().event) : response(market) });
    expect(result.settlements).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  }
});

test("a fetched event cannot settle a market owned by another event in the same game", async () => {
  const f = await fixture(), loaded = await loadTailArchive(f.output);
  const window = loaded.input.summary.windows[0]!;
  window.eventIds.push("other-event"); window.eventSlugs.push("other-game");
  for (const market of window.markets) { market.eventId = "other-event"; market.eventSlug = "other-game"; }
  const foreign = structuredClone(eventMetadata().event) as Record<string, unknown>;
  Object.assign((foreign.markets as Record<string, unknown>[])[0]!, {
    closed: true, umaResolutionStatus: "resolved", outcomePrices: ["1", "0"]
  });
  const own = { ...(eventMetadata().event as Record<string, unknown>), id: "other-event", slug: "other-game" };
  const result = await collectTailSettlements([loaded.input], { request: async url =>
    url.endsWith("/game") ? response(foreign) : url.endsWith("/other-game") ? response(own) : response({}, 404) });
  expect(result.settlements).toEqual([]);
  expect(result.errors.join("\n")).toMatch(/event.*owner|ownership/);
  expect(result.observations[0]!.response.body).toBe(JSON.stringify(foreign));
});

test.each([
  { id: "foreign-market" }, { conditionId: "foreign-condition" }, { outcomes: ["A", "B", "C"] }
])("refuses foreign or incomplete archived settlement identity: %j", async patch => {
  const f = await fixture();
  await resolvedCopies(f.output, raw => { Object.assign(raw, patch); });
  await expect(loadTailArchive(f.output).then(() => true)).rejects.toThrow(/settlement.*identity|settlement.*cardinality/);
});

test("conflicting archived payout copies remain unresolved even when a later fetch agrees with one copy", async () => {
  const f = await fixture();
  await resolvedCopies(f.output, (raw, index) => { raw.outcomePrices = index === 0 ? ["1", "0"] : ["0", "1"]; });
  const loaded = await loadTailArchive(f.output);
  expect(loaded.input.settlements).toEqual([]);
  expect(loaded.input.summary.warnings.join("\n")).toContain("conflicting archived settlement evidence");
  const raw = structuredClone(eventMetadata().event) as Record<string, unknown>;
  Object.assign((raw.markets as Record<string, unknown>[])[0]!, { closed: true, umaResolutionStatus: "resolved", outcomePrices: ["1", "0"] });
  const result = await collectTailSettlements([loaded.input], { request: async () => response(raw) });
  expect(result.settlements).toEqual([]);
  expect(result.errors.join("\n")).toContain("conflicting archived settlement evidence");
});

test("identical archived vectors are compared by token identity, not raw array order", async () => {
  const f = await fixture();
  await resolvedCopies(f.output, (raw, index) => {
    if (index) Object.assign(raw, { outcomes: ["B", "A"], clobTokenIds: ["B", "A"], outcomePrices: ["0", "1"] });
  });
  const loaded = await loadTailArchive(f.output);
  expect(loaded.input.settlements).toHaveLength(2);
  expect(loaded.input.settlements).toEqual(expect.arrayContaining([expect.objectContaining({ tokenId: "A", payout: 1 })]));
  expect(loaded.input.summary.warnings.join("\n")).not.toContain("conflicting archived settlement evidence");
});

test("a later archived confirmed copy is not discarded when the first copy is unresolved", async () => {
  const f = await fixture();
  await resolvedCopies(f.output, (raw, index) => { if (index === 0) raw.closed = false; });
  expect((await loadTailArchive(f.output)).input.settlements).toHaveLength(2);
});
