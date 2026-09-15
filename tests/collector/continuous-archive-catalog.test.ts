import * as fs from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ContinuousArchiveCatalog } from "../../src/collector/continuous-archive-catalog.js";
import { exportTail } from "../../src/collector/tail-export.js";
import { fixtureRecords, writeFixture } from "./tail-fixture.js";

// Observe actual filesystem work; retain real IO and file handles.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), opendir: vi.fn(actual.opendir) };
});

let root: string;
let output: string;
let catalog: ContinuousArchiveCatalog;

beforeEach(async () => {
  root = await writeFixture(fixtureRecords());
  output = join(root, "exports", "original");
  await exportTail({ runDirectory: join(root, "run"), outputDirectory: output, maxFeedSilenceMs: 600_000, sportsStaleAfterMs: 30_000 });
  catalog = new ContinuousArchiveCatalog(join(root, "exports"));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

async function editJson(filename: string, edit: (value: any) => void, directory = output) {
  const path = join(directory, filename);
  const value = JSON.parse(await fs.readFile(path, "utf8"));
  edit(value);
  await fs.writeFile(path, JSON.stringify(value));
}

describe("read-only historical archive catalog", () => {
  test("reconstructs stored readiness from real export quality without creating an index", async () => {
    const before = await fs.readdir(output);
    const manifest = await fs.readFile(join(output, "manifest.json"));
    const qualityBytes = await fs.readFile(join(output, "quality.json"));
    const quality = JSON.parse(qualityBytes.toString());
    const page = await catalog.page();
    expect(page).toMatchObject({ total: 1, offset: 0, limit: 20, nextOffset: null,
      diagnostics: { incomplete: 0, invalid: 0, unsafe: 0, oversized: 0, unreadable: 0 } });
    expect(page.entries[0]).toMatchObject({ id: "original", sourceRunId: "tail-test", windowSeconds: 300, seconds: 600,
      games: [{ key: "game:123", title: "A vs B", tokenCount: 2,
        priceReadyTokens: quality.tokens.filter((q: any) => q.observedWindowComplete && q.snapshotAuditPassed && q.validSeconds > 0).length,
        strictReadyTokens: quality.tokens.filter((q: any) => q.readyForReplay).length }] });
    expect(JSON.stringify(page)).not.toContain(root);
    expect(await fs.readdir(output)).toEqual(before);
    expect(await fs.readFile(join(output, "manifest.json"))).toEqual(manifest);
    expect(await fs.readFile(join(output, "quality.json"))).toEqual(qualityBytes);
    expect(await fs.readdir(join(root, "exports"))).toEqual(["original"]);
  });

  test("keeps revisions distinct, pages deterministically and reconstructs IDs after restart", async () => {
    const second = join(root, "exports", "revision-two");
    await fs.cp(output, second, { recursive: true });
    await editJson("manifest.json", value => { value.createdAt = "2026-01-01T00:00:00Z"; });
    await editJson("manifest.json", value => { value.createdAt = "2026-01-02T00:00:00Z"; }, second);
    const first = await catalog.page(0, 1), last = await catalog.page(1, 1);
    expect(first).toMatchObject({ total: 2, nextOffset: 1, entries: [{ id: "revision-two" }] });
    expect(last).toMatchObject({ total: 2, nextOffset: null, entries: [{ id: "original" }] });
    expect((await catalog.page(2, 1)).entries).toEqual([]);
    expect(await catalog.latest("game:123")).toEqual(first.entries[0]);
    expect(await catalog.find("original")).toEqual(last.entries[0]);
    expect((await new ContinuousArchiveCatalog(join(root, "exports")).page()).entries).toEqual([...first.entries, ...last.entries]);
  });

  test.each([[0, 0], [0, 101], [-1, 20], [1.5, 20], [0, Infinity], [Number.MAX_SAFE_INTEGER + 1, 20]])(
    "rejects unbounded/invalid paging %s %s", async (offset, limit) => {
      await expect(catalog.page(offset, limit)).rejects.toThrow(RangeError);
    });

  test("reports unfinished directories while preserving their files", async () => {
    const partial = join(root, "exports", "partial");
    await fs.mkdir(partial);
    await fs.writeFile(join(partial, "seconds.ndjson"), "not finished yet\n");
    const missingQuality = join(root, "exports", "missing-quality");
    await fs.cp(output, missingQuality, { recursive: true });
    await fs.rename(join(missingQuality, "quality.json"), join(missingQuality, "pending.json"));
    const running = join(root, "exports", "running");
    await fs.cp(output, running, { recursive: true });
    await editJson("manifest.json", value => { value.status = "running"; }, running);
    expect(await catalog.page()).toMatchObject({ total: 1, diagnostics: { incomplete: 3 } });
    expect(await fs.readFile(join(partial, "seconds.ndjson"), "utf8")).toBe("not finished yet\n");
  });

  test.each([
    ["sourceRunId", "another-source"], ["sourceRunDirectory", "relative-source"], ["depthFile", "../private"],
    ["depthFileBytes", 1], ["seconds", 1], ["tokenCount", 10], ["readyTokens", 10], ["createdAt", "not-a-time"],
    ["rawEventsFile", "../private.gz"], ["rawEventsFile", "other.gz"], ["rawEventsFile", null]
  ])("excludes inconsistent manifest field %s with visible diagnostics", async (field, value) => {
    await editJson("manifest.json", manifest => { manifest[field] = value; });
    expect(await catalog.page()).toMatchObject({ total: 0, diagnostics: { invalid: 1 } });
  });

  test("excludes malformed JSON and never replaces missing quality counts with zero", async () => {
    const broken = join(root, "exports", "broken");
    await fs.cp(output, broken, { recursive: true });
    await fs.writeFile(join(broken, "quality.json"), "{");
    await editJson("quality.json", quality => { delete quality.tokens[0].validSeconds; });
    expect(await catalog.page()).toMatchObject({ total: 0, diagnostics: { invalid: 2 } });
  });

  test("checks summary seconds against token/window counts even if both metadata totals agree", async () => {
    await editJson("manifest.json", manifest => { manifest.seconds = 1; });
    await editJson("quality.json", quality => { quality.seconds = 1; });
    expect(await catalog.page()).toMatchObject({ total: 0, diagnostics: { invalid: 1 } });
  });

  test("rejects contradictory strict readiness even when its manifest count agrees", async () => {
    await editJson("quality.json", quality => { quality.tokens[0].observedWindowComplete = false; quality.tokens[0].readyForReplay = true; });
    const quality = JSON.parse(await fs.readFile(join(output, "quality.json"), "utf8"));
    await editJson("manifest.json", manifest => { manifest.readyTokens = quality.tokens.filter((q: any) => q.readyForReplay).length; });
    expect(await catalog.page()).toMatchObject({ total: 0, diagnostics: { invalid: 1 } });
  });

  test.each(["manifest.json", "quality.json"])("bounds %s reads before loading oversized metadata", async filename => {
    const handle = await fs.open(join(output, filename), "r+");
    try { await handle.truncate(4 * 1024 * 1024); } finally { await handle.close(); }
    expect(await catalog.page()).toMatchObject({ total: 0, diagnostics: { oversized: 1 } });
  });

  test("lists multi-GB sparse depth/raw files using metadata and stats only", async () => {
    const size = 3 * 1024 ** 3 + 17;
    for (const filename of ["seconds.ndjson", "raw-events.ndjson"]) {
      const handle = await fs.open(join(output, filename), "r+");
      try { await handle.truncate(size); } finally { await handle.close(); }
    }
    await editJson("manifest.json", manifest => { manifest.depthFileBytes = size; });
    const opens = vi.mocked(fs.open).mockClear();
    expect(await catalog.page()).toMatchObject({ total: 1, entries: [{ depthFileBytes: size }] });
    const canonical = await fs.realpath(output);
    expect(opens.mock.calls.map(call => call[0])).toEqual([join(canonical, "manifest.json"), join(canonical, "quality.json")]);
  });

  test("coalesces concurrent scans and caches for 30 seconds including empty results", async () => {
    const scans = vi.mocked(fs.opendir).mockClear();
    await Promise.all(Array.from({ length: 12 }, () => catalog.page()));
    expect(scans).toHaveBeenCalledTimes(1);
    await fs.cp(output, join(root, "exports", "later"), { recursive: true });
    expect((await catalog.page()).total).toBe(1);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 30_001);
    expect((await catalog.page()).total).toBe(2);
    expect(scans).toHaveBeenCalledTimes(2);
    const empty = new ContinuousArchiveCatalog(join(root, "missing"));
    expect((await empty.page()).total).toBe(0);
    await fs.mkdir(join(root, "missing"));
    await fs.cp(output, join(root, "missing", "new"), { recursive: true });
    expect((await empty.page()).total).toBe(0);
    expect(scans).toHaveBeenCalledTimes(2);
  });

  test.each(["directory", "root", "manifest.json", "quality.json", "seconds.ndjson", "raw-events.ndjson"])(
    "never lists a %s symlink, including targets inside the data root", async kind => {
      const path = kind === "root" ? join(root, "exports") : kind === "directory" ? output : join(output, kind);
      const target = join(root, "symlink-target");
      await fs.rename(path, target);
      await fs.symlink(target, path);
      expect(await catalog.page()).toMatchObject({ total: 0, diagnostics: { unsafe: 1 } });
    });

  test("IDs cannot traverse, select arbitrary paths, or double-decode", async () => {
    for (const id of ["..", ".", "../original", "/original", "a\\b", "%2e%2e", "original%00", "a\u0000", "a".repeat(256)]) {
      expect(await catalog.find(id), id).toBeUndefined();
    }
  });

  test("selects only the declared gzip raw artifact and falls back to legacy ndjson when absent", async () => {
    const legacy = (await catalog.page()).entries[0];
    expect(legacy).toMatchObject({ rawEventsFile: "raw-events.ndjson" });
    const compressed = join(root, "exports", "gzip-archive");
    await fs.cp(output, compressed, { recursive: true });
    const raw = await fs.readFile(join(compressed, "raw-events.ndjson"));
    await fs.rename(join(compressed, "raw-events.ndjson"), join(compressed, "original-raw"));
    await fs.writeFile(join(compressed, "raw-events.ndjson.gz"), gzipSync(raw));
    await editJson("manifest.json", manifest => { manifest.rawEventsFile = "raw-events.ndjson.gz"; }, compressed);
    const fresh = new ContinuousArchiveCatalog(join(root, "exports"));
    expect(await fresh.find("gzip-archive")).toMatchObject({ rawEventsFile: "raw-events.ndjson.gz" });
    expect((await fresh.page()).total).toBe(2);
  });
});
