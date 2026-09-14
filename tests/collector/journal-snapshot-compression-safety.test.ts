import { mkdtemp, open, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createJournal } from "../../src/collector/journal.js";
import { sealJournalSnapshot } from "../../src/collector/sealed-journal.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const roots: string[] = [];
beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockReset().mockImplementation(actual.open);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test.each(["cutoff", "header"])("a newly appearing plain sibling cannot substitute gzip %s validation", async mode => {
  const root = await mkdtemp(join(tmpdir(), "poly-snapshot-codec-race-")); roots.push(root);
  const journal = await createJournal({ rootDir: root, runId: "run", maxSegmentBytes: 1 });
  if (mode === "header") journal.record({ source: "collector", kind: "session_start", data: {} });
  const checkpoint = await journal.checkpoint(); await journal.close();
  const logical = join(journal.runDirectory, checkpoint.segments[0]!);
  const original = await readFile(logical, "utf8"), changed = JSON.parse(original);
  changed.sequence = checkpoint.sequence + 1;
  await writeFile(logical + ".gz", gzipSync(JSON.stringify(changed) + "\n")); await unlink(logical);
  vi.spyOn(journal, "checkpoint").mockResolvedValue(checkpoint);
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let inserted = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    const file = await actual.open(...args);
    if (String(args[0]) === logical + ".gz" && !inserted) { inserted = true; await writeFile(logical, original); }
    return file;
  });

  await expect(sealJournalSnapshot(journal, join(root, "snapshot"), mode === "header" ? { fromSequence: 1 } : {}))
    .rejects.toThrow("JOURNAL_SNAPSHOT_INVALID");
  expect(inserted).toBe(true);
});
