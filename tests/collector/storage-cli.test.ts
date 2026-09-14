import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { createJournal, listJournalSegments } from "../../src/collector/journal.js";
import { runStorageCli } from "../../src/collector/storage-cli.js";
import { runJournalCompression } from "../../src/collector/continuous-compression.js";

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
