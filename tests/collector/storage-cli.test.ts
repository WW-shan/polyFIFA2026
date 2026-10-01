import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { createJournal, listJournalSegments } from "../../src/collector/journal.js";
import { openCompactTailStore } from "../../src/collector/continuous-tail-store.js";
import { runStorageCli } from "../../src/collector/storage-cli.js";
import { runJournalCompression } from "../../src/collector/continuous-compression.js";
import { compactEventMetadata } from "../../src/collector/continuous-state.js";
import { DatabaseSync } from "node:sqlite";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "poly-storage-cli-")); roots.push(root);
  const journal = await createJournal({ rootDir: root, runId: "run" });
  journal.record({ source: "collector", kind: "session_start", data: "raw ".repeat(10_000) });
  journal.record({ source: "collector", kind: "session_end", data: {} });
  await journal.close();
  const path = join(journal.runDirectory, (await listJournalSegments(journal.runDirectory))[0]!);
  return { root, path, original: await readFile(path) };
}

test("storage help does not require paths or perform migration", async () => {
  const result = await runStorageCli(["--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("--replace-verified");
  expect(result.stdout).toContain("--root");
});

test("compact export rejects an invalid window before creating a store", async () => {
  const root = await mkdtemp(join(tmpdir(), "poly-storage-invalid-window-")); roots.push(root);
  const dataRoot = join(root, "data"), outputDirectory = join(root, "output");
  const result = await runStorageCli(["export-tail", "--data-root", dataRoot, "--output-dir", outputDirectory, "--window-seconds", "abc"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--window-seconds");
  expect(await readdir(root)).toEqual([]);
});

test("compact export refuses a missing data root instead of creating an empty store", async () => {
  const root = await mkdtemp(join(tmpdir(), "poly-storage-missing-root-")); roots.push(root);
  const dataRoot = join(root, "missing-data"), outputDirectory = join(root, "output");
  const result = await runStorageCli(["export-tail", "--data-root", dataRoot, "--output-dir", outputDirectory]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/data-root|data root/i);
  expect(await readdir(root)).toEqual([]);
});

test("compact export reads a live store without writing to it", async () => {
  const root = await mkdtemp(join(tmpdir(), "poly-storage-export-readonly-")); roots.push(root);
  const dataRoot = join(root, "data"), finish = 400_000, start = finish - 181_000;
  const rawMarket = { id: "market-1", conditionId: "0xc", slug: "market-1", question: "Will A win?", outcomes: ["Yes", "No"],
    clobTokenIds: ["yes", "no"], sportsMarketType: "moneyline", closed: false };
  const market = (tokenId: string, outcome: string) => ({ eventId: "evt-1", eventSlug: "a-vs-b", gameId: "42", marketId: "market-1",
    marketSlug: "market-1", conditionId: "0xc", tokenId, outcome, question: "Will A win?", marketType: "moneyline",
    closed: false, acceptingOrders: true, raw: rawMarket });
  const eventMetadata = compactEventMetadata({ eventId: "evt-1", eventSlug: "a-vs-b", title: "A vs B", gameId: "42", parentEventId: null,
    sport: "tennis", tags: ["tennis"], finishAtMs: null, finishSource: null, observedAtMs: 0, sequence: 1,
    raw: { id: "evt-1", slug: "a-vs-b", title: "A vs B", gameId: "42", sport: "tennis", markets: [rawMarket] },
    markets: [market("yes", "Yes"), market("no", "No")] });
  const store = await openCompactTailStore({ dataRoot, tailWindowMs: 181_000, bufferMs: 30_000, retentionMs: 3_600_000,
    maxBytes: 8 * 1024 ** 3, now: () => finish });
  store.ingest({ schemaVersion: 1, runId: "run-1", sequence: 1, receivedAt: new Date(start).toISOString(), receivedAtMs: start,
    monotonicNs: "1", source: "clob", kind: "book_snapshot", data: { tokenId: "yes",
      response: { market: "0xc", asset_id: "yes", timestamp: "1000", hash: "h1", bids: [{ price: "0.5", size: "10" }], asks: [{ price: "0.6", size: "20" }] } } }, ["game:42"]);
  store.finalize({ key: "game:42", title: "A vs B", sport: "tennis", gameId: "42", eventIds: ["evt-1"], eventSlugs: ["a-vs-b"],
    tokenIds: ["yes", "no"], marketIds: ["market-1"], firstSeenAtMs: 0, lastSeenAtMs: finish, firstBookAtMs: 0, lastBookAtMs: finish,
    lastActiveBookAtMs: finish, lastBookRunId: "run-1", lastActiveBookRunId: "run-1", bookUpdates: 1, trades: 0, stateObservations: 1,
    finishedAtMs: finish, finishAnchor: "book-quiet", finishConflict: false, retiredEventIds: ["evt-1"], phase: "postmatch", sources: [],
    eventMetadata }, finish);
  store.close();
  // A rollback-journal database makes any pragma or schema write visible in
  // the file itself; the collector's own WAL setting would be re-applied.
  const raw = new DatabaseSync(join(dataRoot, "tail.sqlite"));
  raw.exec("PRAGMA journal_mode = DELETE");
  raw.close();
  const before = await readFile(join(dataRoot, "tail.sqlite"));

  const result = await runStorageCli(["export-tail", "--data-root", dataRoot, "--output-dir", join(root, "output")]);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({ type: "tail-export", exported: 1, failed: 0 });
  expect((await readFile(join(dataRoot, "tail.sqlite"))).equals(before)).toBe(true);
});

test("compact repair refuses a missing data root instead of creating an empty store", async () => {
  const root = await mkdtemp(join(tmpdir(), "poly-storage-repair-missing-root-")); roots.push(root);
  const dataRoot = join(root, "missing-data");
  const result = await runStorageCli(["repair-tail", "--data-root", dataRoot]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/data-root|data root/i);
  expect(await readdir(root)).toEqual([]);
});

test("compact repair refuses while the collector lock is present", async () => {
  const root = await mkdtemp(join(tmpdir(), "poly-storage-repair-locked-")); roots.push(root);
  const store = await openCompactTailStore({ dataRoot: root, tailWindowMs: 181_000, bufferMs: 30_000,
    retentionMs: 30 * 24 * 3600_000, maxBytes: 8 * 1024 ** 3 });
  store.close();
  await writeFile(join(root, "collector.lock"), JSON.stringify({ schemaVersion: 1, kind: "poly-fifa-continuous-collector",
    hostname: "test-host", pid: process.pid, nonce: "test" }));
  const result = await runStorageCli(["repair-tail", "--data-root", root]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("collector.lock");
});

test("storage replacement requires explicit roots and the replacement flag", async () => {
  const f = await fixture();
  for (const args of [["compact"], ["compact", "--root", f.root], ["compact", "--replace-verified"],
    ["compact", "--root", f.root, "--replace-verified", "--max-segments", "0"],
    ["compact", "--root", f.root, "--replace-verified", "--unknown"]]) {
    expect((await runStorageCli(args)).exitCode).toBe(1);
    expect(await readFile(f.path)).toEqual(f.original);
  }
});

test("storage CLI emits a summary only after byte-verified migration", async () => {
  const f = await fixture();
  const result = await runStorageCli(["compact", "--root", f.root, "--replace-verified", "--quiet"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ type: "compression-summary", compressedSegments: 1, replacedAliases: 1 });
  expect(gunzipSync(await readFile(f.path + ".gz"))).toEqual(f.original);
});

test("the owned background process uses the same verified migration and returns its result", async () => {
  const f = await fixture();
  const result = await runJournalCompression({ roots: [f.root], maxSegments: 1, timeoutMs: 10_000 });
  expect(result.compressedSegments).toBe(1);
  expect(result.logicalBytesSaved).toBeGreaterThan(0);
  expect(gunzipSync(await readFile(f.path + ".gz"))).toEqual(f.original);
});

test("an already-aborted background request never starts replacing files", async () => {
  const f = await fixture(), controller = new AbortController();
  controller.abort(new Error("cancelled before start"));
  await expect(runJournalCompression({ roots: [f.root], maxSegments: 1, timeoutMs: 10_000 }, controller.signal)).rejects.toThrow("cancelled before start");
  expect(await readFile(f.path)).toEqual(f.original);
});

test("a pre-existing larger gzip is retained without replacing raw or reporting negative savings", async () => {
  const f = await fixture(), gzip = gzipSync(f.original, { level: 0 });
  expect(gzip.length).toBeGreaterThan(f.original.length);
  await writeFile(f.path + ".gz", gzip);
  const result = await runJournalCompression({ roots: [f.root], maxSegments: 1, timeoutMs: 10_000 });
  expect(result).toMatchObject({ compressedSegments: 0, logicalBytesSaved: 0 });
  expect(await readFile(f.path)).toEqual(f.original);
  expect(await readFile(f.path + ".gz")).toEqual(gzip);
});

test("the child runner rejects a timeout that Node would overflow to one millisecond", async () => {
  const f = await fixture();
  await expect(runJournalCompression({ roots: [f.root], maxSegments: 1, timeoutMs: 2_147_483_648 })).rejects.toThrow("COMPRESSION_TASK_INVALID");
  expect(await readFile(f.path)).toEqual(f.original);
});
