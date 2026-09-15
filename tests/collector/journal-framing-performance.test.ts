import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test, vi } from "vitest";
import { scanJournal } from "../../src/collector/journal-reader.js";
import { emptyReplayQuality } from "../../src/collector/replay-types.js";
import { journalRecord } from "./tail-fixture.js";

test.each([false, true])("long records are framed with linear newline work (gzip=%s)", async compressed => {
  const root = await mkdtemp(join(tmpdir(), "poly-linear-framing-"));
  const values = [journalRecord(1, 0, "gamma", "http_request", { response: "x".repeat(8 * 1024 * 1024) }),
    journalRecord(2, 1, "collector", "session_end", {})];
  const bytes = Buffer.from(values.map(value => JSON.stringify(value)).join("\n") + "\n");
  await writeFile(join(root, "1970-01-01-000000.ndjson" + (compressed ? ".gz" : "")), compressed ? gzipSync(bytes) : bytes);
  const native = String.prototype.indexOf;
  const concat = Buffer.concat;
  let searchedCharacters = 0, copiedBytes = 0;
  // Count work, not elapsed wall time: the regression searched the growing
  // multi-megabyte prefix again for every 64-KiB input chunk.
  const spy = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (this: string, search: string, position?: number) {
    if (search === "\n" && this.length > 1024 * 1024) searchedCharacters += this.length;
    return native.call(this, search, position);
  });
  const copySpy = vi.spyOn(Buffer, "concat").mockImplementation((list, length) => {
    copiedBytes += length ?? list.reduce((total, chunk) => total + chunk.length, 0);
    return concat(list, length);
  });
  const actual: unknown[] = [];
  try {
    await scanJournal(root, value => { actual.push(value); }, emptyReplayQuality(), () => {});
  } finally { spy.mockRestore(); copySpy.mockRestore(); await rm(root, { recursive: true, force: true }); }
  expect(actual).toEqual(values);
  expect(searchedCharacters).toBeLessThanOrEqual(bytes.length * 4);
  expect(copiedBytes).toBeLessThanOrEqual(bytes.length * 4);
});

test.each([false, true])("decoded replacement bytes still obey the line bound (terminated=%s)", async terminated => {
  const root = await mkdtemp(join(tmpdir(), "poly-framing-bound-"));
  try {
    await writeFile(join(root, "1970-01-01-000000.ndjson"), Buffer.from(terminated ? [0xff, 0xff, 0x0a] : [0xff, 0xff]));
    await expect(scanJournal(root, () => {}, emptyReplayQuality(), () => {}, { maxLineBytes: 4 }))
      .rejects.toThrow("REPLAY_LINE_TOO_LARGE");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("framing preserves UTF-8, damaged-line accounting and sequential callbacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "poly-framing-integrity-"));
  const values = [journalRecord(1, 0, "gamma", "http_request", { text: "汉🙂".repeat(20_000) }),
    journalRecord(2, 1, "collector", "session_end", {})];
  const quality = emptyReplayQuality(), actual: unknown[] = [];
  let damage = 0;
  try {
    await writeFile(join(root, "1970-01-01-000000.ndjson"), JSON.stringify(values[0]) + "\n\n{broken\n" + JSON.stringify(values[1]) + "\n{unfinished");
    await scanJournal(root, async value => {
      await Promise.resolve();
      actual.push(value);
    }, quality, () => { damage++; });
    expect(actual).toEqual(values);
    expect(quality).toMatchObject({ malformedLines: 2, incompleteFinalLines: 1 });
    expect(damage).toBe(3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
