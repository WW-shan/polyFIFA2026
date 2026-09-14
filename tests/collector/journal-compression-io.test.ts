import { mkdtemp, open, readFile, readdir, rm, utimes, writeFile, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createJournal, listJournalSegments } from "../../src/collector/journal.js";
import { compactJournalStorage } from "../../src/collector/journal-compression.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const roots: string[] = [], handles: FileHandle[] = [];
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockReset().mockImplementation(actual.open);
});
afterEach(async () => {
  await Promise.all(handles.splice(0).map(file => file.close().catch(() => {})));
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "poly-compression-io-")); roots.push(root);
  const journal = await createJournal({ rootDir: root, runId: "run" });
  journal.record({ source: "collector", kind: "session_start", data: "unchanged ".repeat(1000) });
  journal.record({ source: "collector", kind: "session_end", data: {} });
  await journal.close();
  const path = join(journal.runDirectory, (await listJournalSegments(journal.runDirectory))[0]!);
  return { root, path, bytes: await readFile(path) };
}

test("a failed exclusive temporary open closes the already-open original handle", async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementation(async (...args) => {
    if (String(args[0]).includes(".gz.pending-")) throw Object.assign(new Error("temporary open failed"), { code: "EIO" });
    const file = await actual.open(...args); handles.push(file); return file;
  });
  await expect(compactJournalStorage({ roots: [f.root] })).rejects.toThrow("temporary open failed");
  expect(handles.every(file => file.fd === -1)).toBe(true);
  expect(await readFile(f.path)).toEqual(f.bytes);
});

test("a failed compressed-file fsync retains the original and closes all owned handles", async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementation(async (...args) => {
    const file = await actual.open(...args); handles.push(file);
    if (String(args[0]).includes(".gz.pending-")) vi.spyOn(file, "sync").mockRejectedValue(new Error("sync failed"));
    return file;
  });
  await expect(compactJournalStorage({ roots: [f.root] })).rejects.toThrow("sync failed");
  expect(handles.every(file => file.fd === -1)).toBe(true);
  expect(await readFile(f.path)).toEqual(f.bytes);
  expect((await readdir(join(f.root, "run"))).some(name => name.endsWith(".gz"))).toBe(false);
});

test("a failed verification stat closes its already-open gzip handle", async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementation(async (...args) => {
    const file = await actual.open(...args); handles.push(file);
    if (String(args[0]).includes(".gz.pending-") && args[1] !== "wx") {
      let calls = 0;
      const stat = file.stat.bind(file);
      vi.spyOn(file, "stat").mockImplementation((async () => {
        if (++calls === 2) throw new Error("verification stat failed");
        return stat();
      }) as FileHandle["stat"]);
    }
    return file;
  });
  await expect(compactJournalStorage({ roots: [f.root] })).rejects.toThrow(/verification stat|GZIP/);
  expect(handles.every(file => file.fd === -1)).toBe(true);
  expect(await readFile(f.path)).toEqual(f.bytes);
});

test("reused gzip and integrity files are file-synced before originals are removed", async () => {
  const f = await fixture(), encoded = gzipSync(f.bytes), gzipPath = f.path + ".gz", integrityPath = gzipPath + ".integrity.json";
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  await writeFile(gzipPath, encoded);
  await writeFile(integrityPath, JSON.stringify({ schemaVersion: 1, kind: "collector-gzip-integrity", uncompressedBytes: f.bytes.length,
    uncompressedSha256: hash(f.bytes), compressedBytes: encoded.length, compressedSha256: hash(encoded) }));
  const synced = new Set<string>();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementation(async (...args) => {
    const file = await actual.open(...args); handles.push(file);
    const path = String(args[0]), sync = file.sync.bind(file);
    if (path === gzipPath || path === integrityPath) vi.spyOn(file, "sync").mockImplementation(async () => { await sync(); synced.add(path); });
    return file;
  });
  await compactJournalStorage({ roots: [f.root] });
  expect(synced.has(gzipPath)).toBe(true);
  expect(synced.has(integrityPath)).toBe(true);
});

test.each(["source", "gzip"])("a same-mtime %s write during the final sync cannot pass the commit boundary", async target => {
  const f = await fixture(), gzipPath = f.path + ".gz", encoded = gzipSync(f.bytes), fixed = new Date(1_700_000_000_000);
  await writeFile(gzipPath, encoded); await utimes(gzipPath, fixed, fixed); await utimes(f.path, fixed, fixed);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let published = false, changed = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    const file = await actual.open(...args); handles.push(file);
    if (String(args[0]) === gzipPath) {
      const sync = file.sync.bind(file);
      vi.spyOn(file, "sync").mockImplementation(async () => {
        await sync();
        if (published && !changed) {
          changed = true;
          if (target === "source") {
            await writeFile(f.path, f.bytes.toString("utf8").replace("unchanged", "DIFFERENT"));
            await utimes(f.path, fixed, fixed);
          } else {
            const bad = Buffer.from(encoded); bad[bad.length - 8] = bad[bad.length - 8]! ^ 1;
            await writeFile(gzipPath, bad); await utimes(gzipPath, fixed, fixed);
          }
        }
      });
    }
    return file;
  });
  await expect(compactJournalStorage({ roots: [f.root], onProgress: event => { if (event.phase === "published") published = true; } }))
    .rejects.toThrow(/CHANGED|GZIP|CONFLICT/);
  expect(changed).toBe(true);
  expect(await readFile(f.path)).toBeDefined();
});
