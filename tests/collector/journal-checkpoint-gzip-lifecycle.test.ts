import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

test("a checkpoint over large gzip history releases queued writes, persists their full data and closes handles", async () => {
  const root = await mkdtemp(join(tmpdir(), "poly-checkpoint-gzip-lifecycle-"));
  try {
    const moduleUrl = new URL("../../src/collector/journal.ts", import.meta.url).href;
    // Isolate the hang: even a stuck checkpoint/close cannot strand the test's
    // file handles or prevent the parent from removing its temporary journal.
    const script = `
      import assert from "node:assert/strict";
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      import { join } from "node:path";
      import { gzipSync } from "node:zlib";
      import { createJournal } from ${JSON.stringify(moduleUrl)};

      const handles = [], open = fs.open;
      fs.open = async (...args) => {
        const file = await open(...args);
        handles.push({ path: String(args[0]), file });
        return file;
      };
      syncBuiltinESMExports();
      const journal = await createJournal({ rootDir: ${JSON.stringify(root)}, runId: "lifecycle",
        now: () => 1_700_000_000_000, monotonicNs: () => 100n });
      let phase = "initial checkpoint";
      const deadline = setTimeout(() => {
        console.error("JOURNAL_CHECKPOINT_GZIP_LIFECYCLE_TIMEOUT: " + phase);
        process.exit(1);
      }, 2500);
      try {
        // Keep the encoded history between one and two 64 KiB source chunks:
        // this hits cancellation near the final read, unlike a tiny gzip or a
        // much larger incompressible archive. A fixed seed keeps it reproducible.
        const noise = Buffer.alloc(110_000);
        let seed = 0x12345678;
        for (let index = 0; index < noise.length; index++) {
          seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
          noise[index] = seed & 255;
        }
        journal.record({ source: "collector", kind: "session_start",
          data: { payload: noise.toString("base64") + "A".repeat(1_000_000) } });
        const first = await journal.checkpoint();
        assert.equal(first.segments.length, 1);
        const oldPath = join(journal.runDirectory, first.segments[0]);
        const encoded = gzipSync(await fs.readFile(oldPath));
        assert.ok(encoded.length > 64 * 1024 && encoded.length < 2 * 64 * 1024);
        await fs.writeFile(oldPath + ".gz", encoded);
        await fs.unlink(oldPath);

        phase = "checkpoint() listing gzip history";
        const pending = journal.checkpoint();
        // Queue synchronously behind the real checkpoint barrier, before it
        // resolves; the entire multi-chunk UTF-8 record must survive that barrier.
        const later = journal.record({ source: "collector", kind: "after_checkpoint",
          data: { text: "网球🙂".repeat(20_000), price: "0.12345678901234567890" } });
        const checkpoint = await pending;
        phase = "flush() of queued record";
        await journal.flush();
        assert.equal(journal.pendingBytes, 0);
        assert.equal(journal.error, undefined);
        assert.equal(checkpoint.sequence + 1, later.sequence);
        assert.equal(checkpoint.segments.length, 2);
        assert.equal(checkpoint.segments[0], first.segments[0]);
        phase = "close() after flush";
        await journal.close();
        assert.ok(handles.some(({ path }) => path === oldPath + ".gz"), "gzip reader was not exercised");
        assert.ok(handles.every(({ file }) => file.fd === -1), "journal reader/writer handle leaked");

        const laterFiles = (await fs.readdir(journal.runDirectory))
          .filter(name => name.endsWith(".ndjson") && !checkpoint.segments.includes(name));
        assert.equal(laterFiles.length, 1);
        const persisted = await fs.readFile(join(journal.runDirectory, laterFiles[0]), "utf8");
        assert.equal(persisted, JSON.stringify(later) + "\\n");
        assert.ok(Buffer.byteLength(persisted) > 64 * 1024);
        console.log(JSON.stringify({ checkpointSequence: checkpoint.sequence, laterSequence: later.sequence,
          pendingBytes: journal.pendingBytes, closedHandles: handles.length }));
      } finally {
        try { await journal.close(); }
        finally { clearTimeout(deadline); fs.open = open; syncBuiltinESMExports(); }
      }
    `;
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      "--unhandled-rejections=strict", "--import", fileURLToPath(import.meta.resolve("tsx")),
      "--input-type=module", "--eval", script
    ], { timeout: 4000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
      env: { ...process.env, TSX_DISABLE_CACHE: "1" } });
    expect(stderr).toBe("");
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ checkpointSequence: 3, laterSequence: 4, pendingBytes: 0 });
    expect(result.closedHandles).toBeGreaterThan(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
