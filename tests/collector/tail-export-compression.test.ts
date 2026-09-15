import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";
import { exportTail } from "../../src/collector/tail-export.js";
import { parseTailCliArgs } from "../../src/collector/tail-cli.js";
import { tailOptions } from "../../src/collector/tail-catalog.js";
import type { TailOptions } from "../../src/collector/tail-types.js";
import * as compression from "../../src/collector/journal-compression-file.js";
import { fixtureRecords, writeFixture } from "./tail-fixture.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("optional raw evidence compression preserves every byte and publishes integrity before the complete manifest", async () => {
  const root = await writeFixture(fixtureRecords()); roots.push(root);
  const runDirectory = join(root, "run"), plain = join(root, "plain"), compressed = join(root, "compressed");
  await exportTail({ runDirectory, outputDirectory: plain });
  await exportTail(Object.assign({ runDirectory, outputDirectory: compressed }, { compressRawEvents: true }));
  const original = await readFile(join(plain, "raw-events.ndjson"));
  const encoded = await readFile(join(compressed, "raw-events.ndjson.gz"));
  expect(gunzipSync(encoded)).toEqual(original);
  expect(await readdir(compressed)).not.toContain("raw-events.ndjson");
  const sha256 = createHash("sha256").update(original).digest("hex");
  const manifest = JSON.parse(await readFile(join(compressed, "manifest.json"), "utf8"));
  expect(manifest).toMatchObject({ status: "complete", rawEventsFile: "raw-events.ndjson.gz",
    rawEventsBytes: encoded.length, rawEventsUncompressedBytes: original.length, rawEventsSha256: sha256 });
  const integrity = JSON.parse(await readFile(join(compressed, "raw-events.ndjson.gz.integrity.json"), "utf8"));
  expect(integrity).toMatchObject({ uncompressedBytes: original.length, uncompressedSha256: sha256, compressedBytes: encoded.length });
  expect(await readFile(join(compressed, "seconds.ndjson"))).toEqual(await readFile(join(plain, "seconds.ndjson")));
  expect(await readFile(join(compressed, "changes.ndjson"))).toEqual(await readFile(join(plain, "changes.ndjson")));
});

test("compression failure retains generated raw evidence and cannot publish a complete archive", async () => {
  const root = await writeFixture(fixtureRecords()); roots.push(root);
  vi.spyOn(compression, "compressJournalAliases").mockRejectedValueOnce(new Error("test gzip conflict"));
  const outputDirectory = join(root, "failed");
  await expect(exportTail(Object.assign({ runDirectory: join(root, "run"), outputDirectory }, { compressRawEvents: true })).then(() => true))
    .rejects.toThrow("test gzip conflict");
  expect((await readFile(join(outputDirectory, "raw-events.ndjson"))).length).toBeGreaterThan(0);
  expect(await readdir(outputDirectory)).not.toContain("manifest.json");
});

test("the raw compression CLI flag is explicit and defaults preserve legacy plain exports", () => {
  const parsed = parseTailCliArgs(["export", "--run-dir", "run", "--compress-raw-events"]);
  expect(parsed).toMatchObject({ command: "export", options: { compressRawEvents: true } });
  expect(() => tailOptions({ runDirectory: "run", compressRawEvents: "yes" } as unknown as TailOptions))
    .toThrow("TAIL_OPTIONS_INVALID");
});
