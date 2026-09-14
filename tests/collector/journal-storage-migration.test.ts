import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { createJournal, listJournalSegments } from "../../src/collector/journal.js";
import { scanJournal } from "../../src/collector/journal-reader.js";
import { emptyReplayQuality } from "../../src/collector/replay-types.js";
import { compactJournalStorage } from "../../src/collector/journal-compression.js";

const owned: string[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture(options: { closed?: boolean; aliases?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "poly-storage-migration-")); owned.push(root);
  const journal = await createJournal({ rootDir: root, runId: "run", now: () => 1_700_000_000_000, monotonicNs: () => 1n });
  journal.record({ source: "collector", kind: "session_start", data: {} });
  journal.record({ source: "gamma", kind: "http_request", data: { response: "原始数据🙂".repeat(20_000) } });
  if (options.closed !== false) journal.record({ source: "collector", kind: "session_end", data: { status: "stopped" } });
  await journal.close();
  const [name] = await listJournalSegments(journal.runDirectory);
  const source = join(journal.runDirectory, name!);
  const original = await readFile(source), aliases = [source];
  if (options.aliases !== false) {
    const checkpoint = join(root, "checkpoint"); await mkdir(checkpoint);
    const alias = join(checkpoint, name!); await link(source, alias); aliases.push(alias);
  }
  return { root, source, original, aliases, runDirectory: journal.runDirectory };
}
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

describe("verified journal storage migration", () => {
  test("publishes verified gzip and integrity for every alias before replacing original hardlinks", async () => {
    const f = await fixture();
    let checkedPublication = false;
    const result = await compactJournalStorage({ roots: [f.root], onProgress: async event => {
      if (event.phase !== "published") return;
      checkedPublication = true;
      for (const path of f.aliases) {
        expect(await readFile(path)).toEqual(f.original);
        expect(gunzipSync(await readFile(path + ".gz"))).toEqual(f.original);
        const integrity = JSON.parse(await readFile(path + ".gz.integrity.json", "utf8"));
        expect(integrity.uncompressedSha256).toBe(digest(f.original));
        expect(integrity.uncompressedBytes).toBe(f.original.length);
      }
    } });
    expect(checkedPublication).toBe(true);
    expect(result.compressedSegments).toBe(1);
    expect(result.replacedAliases).toBe(2);
    expect(result.originalBytes).toBe(f.original.length);
    expect(result.logicalBytesSaved).toBeGreaterThan(0);
    const stamps = await Promise.all(f.aliases.map(path => lstat(path + ".gz")));
    expect(stamps[0]!.ino).toBe(stamps[1]!.ino);
    for (const path of f.aliases) {
      await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(gunzipSync(await readFile(path + ".gz"))).toEqual(f.original);
    }
    const read: unknown[] = [];
    await scanJournal(f.runDirectory, row => { read.push(row); }, emptyReplayQuality(), () => {});
    expect(read).toEqual(f.original.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line)));
  });

  test("refuses unknown hardlink aliases without removing any original", async () => {
    const f = await fixture({ aliases: false });
    const outside = await mkdtemp(join(tmpdir(), "poly-outside-migration-")); owned.push(outside);
    await link(f.source, join(outside, "unregistered.ndjson"));
    const result = await compactJournalStorage({ roots: [f.root] });
    expect(result.compressedSegments).toBe(0);
    expect(result.skipped.some(item => item.reason.includes("hardlink"))).toBe(true);
    expect(await readFile(f.source)).toEqual(f.original);
    await expect(lstat(f.source + ".gz")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not compact an unclosed run or assume a closed file descriptor means sealed data", async () => {
    const f = await fixture({ closed: false });
    const result = await compactJournalStorage({ roots: [f.root] });
    expect(result.compressedSegments).toBe(0);
    expect(result.skipped.some(item => item.reason.includes("sealed"))).toBe(true);
    expect(await readFile(f.source)).toEqual(f.original);
  });

  test("a publication interruption leaves readable originals and can resume idempotently", async () => {
    const f = await fixture();
    await expect(compactJournalStorage({ roots: [f.root], onProgress: event => {
      if (event.phase === "published") throw new Error("simulated interruption");
    } })).rejects.toThrow("simulated interruption");
    expect(await readFile(f.source)).toEqual(f.original);
    expect(gunzipSync(await readFile(f.source + ".gz"))).toEqual(f.original);
    const recovered = await compactJournalStorage({ roots: [f.root] });
    expect(recovered.compressedSegments).toBe(1);
    expect((await compactJournalStorage({ roots: [f.root] })).compressedSegments).toBe(0);
    expect(gunzipSync(await readFile(f.source + ".gz"))).toEqual(f.original);
  });

  test("a conflicting gzip target is preserved and prevents original replacement", async () => {
    const f = await fixture();
    const conflicting = Buffer.from("not the original gzip");
    await writeFile(f.aliases[1]! + ".gz", conflicting);
    await expect(compactJournalStorage({ roots: [f.root] })).rejects.toThrow(/GZIP|CONFLICT|compressed/);
    for (const path of f.aliases) expect(await readFile(path)).toEqual(f.original);
    expect(await readFile(f.aliases[1]! + ".gz")).toEqual(conflicting);
  });

  test("a conflicting integrity record cannot be overwritten to authorize deletion", async () => {
    const f = await fixture();
    const integrityPath = f.source + ".gz.integrity.json";
    await writeFile(integrityPath, "user data");
    await expect(compactJournalStorage({ roots: [f.root] })).rejects.toThrow(/INTEGRITY|CONFLICT/);
    for (const path of f.aliases) expect(await readFile(path)).toEqual(f.original);
    expect(await readFile(integrityPath, "utf8")).toBe("user data");
  });

  test("rejects a symlinked storage root and never follows symlinked gzip targets", async () => {
    const f = await fixture();
    const aliasRoot = join(f.root, "root-link"); await symlink(f.runDirectory, aliasRoot);
    await expect(compactJournalStorage({ roots: [aliasRoot] })).rejects.toThrow(/PATH|symlink/);
    const outside = join(f.root, "outside"); await writeFile(outside, "keep");
    await symlink(outside, f.source + ".gz");
    await expect(compactJournalStorage({ roots: [f.runDirectory, join(f.root, "checkpoint")] })).rejects.toThrow(/PATH|symlink|SEGMENT_INVALID/);
    expect(await readFile(outside, "utf8")).toBe("keep");
    expect(await readFile(f.source)).toEqual(f.original);
  });

  test("detects a source modification after compression and retains originals", async () => {
    const f = await fixture();
    await expect(compactJournalStorage({ roots: [f.root], onProgress: async event => {
      if (event.phase === "verified") await writeFile(f.source, f.original.toString("utf8").replace("原始数据", "已经改变"));
    } })).rejects.toThrow(/SOURCE_CHANGED/);
    expect((await readFile(f.source, "utf8")).includes("已经改变")).toBe(true);
    expect(await readFile(f.aliases[1]!)).toEqual(await readFile(f.source));
  });

  test("cancellation before replacement retains all originals and verified outputs are reusable", async () => {
    const f = await fixture(), controller = new AbortController();
    await expect(compactJournalStorage({ roots: [f.root], signal: controller.signal, onProgress: event => {
      if (event.phase === "published") controller.abort(new Error("cancel migration"));
    } })).rejects.toThrow("cancel migration");
    for (const path of f.aliases) expect(await readFile(path)).toEqual(f.original);
    expect((await compactJournalStorage({ roots: [f.root] })).compressedSegments).toBe(1);
  });

  test("a published gzip modification cannot authorize deleting the original", async () => {
    const f = await fixture();
    await expect(compactJournalStorage({ roots: [f.root], onProgress: async event => {
      if (event.phase === "published") await writeFile(f.source + ".gz", "corrupt after verification");
    } })).rejects.toThrow(/GZIP|COMPRESSED_CHANGED|CONFLICT/);
    for (const path of f.aliases) expect(await readFile(path)).toEqual(f.original);
  });

  test("same-size source edits with restored mtime still prevent replacement", async () => {
    const f = await fixture({ aliases: false }), fixed = new Date(1_700_000_000_000);
    await utimes(f.source, fixed, fixed);
    const changed = Buffer.from(f.original.toString("utf8").replace("原始数据", "已经改变"));
    expect(changed.length).toBe(f.original.length);
    await expect(compactJournalStorage({ roots: [f.root], onProgress: async event => {
      if (event.phase === "published") { await writeFile(f.source, changed); await utimes(f.source, fixed, fixed); }
    } })).rejects.toThrow(/SOURCE_CHANGED/);
    expect(await readFile(f.source)).toEqual(changed);
  });

  test("same-size reused gzip edits with restored mtime still prevent replacement", async () => {
    const f = await fixture({ aliases: false }), fixed = new Date(1_700_000_000_000);
    const gzipPath = f.source + ".gz", compressed = gzipSync(f.original);
    await writeFile(gzipPath, compressed); await utimes(gzipPath, fixed, fixed);
    const changed = Buffer.from(compressed); changed[changed.length - 8] = changed[changed.length - 8]! ^ 1;
    await expect(compactJournalStorage({ roots: [f.root], onProgress: async event => {
      if (event.phase === "published") { await writeFile(gzipPath, changed); await utimes(gzipPath, fixed, fixed); }
    } })).rejects.toThrow(/GZIP|COMPRESSED_CHANGED|CONFLICT/);
    expect(await readFile(f.source)).toEqual(f.original);
  });

  test("alternate spellings of one physical root cannot count as two registered hardlinks", async () => {
    const f = await fixture({ aliases: false });
    const parentLink = join(f.root, "parent-alias"); await symlink(f.root, parentLink);
    const outside = join(f.root, "outside"); await mkdir(outside);
    await link(f.source, join(outside, "unregistered.ndjson"));
    const result = await compactJournalStorage({ roots: [f.runDirectory, join(parentLink, "run")] });
    expect(result.compressedSegments).toBe(0);
    expect(result.skipped.some(item => item.reason.includes("hardlink"))).toBe(true);
    expect(await readFile(f.source)).toEqual(f.original);
  });

  test("only compacts earlier segments of the explicitly owned live run, never its active tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "poly-live-migration-")); owned.push(root);
    const journal = await createJournal({ rootDir: root, runId: "live", maxSegmentBytes: 5000 });
    journal.record({ source: "collector", kind: "session_start", data: {} });
    journal.record({ source: "gamma", kind: "http_request", data: "same ".repeat(1000) });
    journal.record({ source: "collector", kind: "heartbeat", data: {} });
    await journal.flush();
    const names = await listJournalSegments(journal.runDirectory), tail = names.at(-1)!;
    try {
      const result = await compactJournalStorage({ roots: [root], activeRunDirectory: journal.runDirectory });
      expect(result.compressedSegments).toBeGreaterThan(0);
      expect((await readdir(journal.runDirectory)).includes(tail)).toBe(true);
      await expect(lstat(join(journal.runDirectory, tail + ".gz"))).rejects.toMatchObject({ code: "ENOENT" });
      journal.record({ source: "collector", kind: "session_end", data: { status: "stopped" } });
      await journal.close();
      const read: unknown[] = [];
      await scanJournal(journal.runDirectory, row => { read.push(row); }, emptyReplayQuality(), () => {});
      expect(read).toHaveLength(4);
    } finally { await journal.close(); }
  });
});
