import { execFile } from "node:child_process";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { exportRun } from "../../src/collector/export.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true }); });
const row = (sequence: number, data: unknown) => ({
  schemaVersion: 1, runId: "streaming", sequence, source: "clob", kind: "ws_message", connectionId: "clob-0-e1",
  receivedAt: new Date(sequence).toISOString(), receivedAtMs: sequence, monotonicNs: String(BigInt(sequence) * 1000000n),
  data: JSON.stringify(data)
});
async function fixture(): Promise<{ root: string; run: string }> {
  const root = await mkdtemp(join(tmpdir(), "poly-export-streaming-"));
  dirs.push(root);
  const run = join(root, "run");
  await mkdir(run);
  return { root, run };
}

describe("bounded streaming export", () => {
  test.each(["many-records", "one-array-frame"])("exports %s full-depth history under a 96 MiB V8 heap", async shape => {
    const { root, run } = await fixture();
    const file = await open(join(run, "2026-09-10-000000.ndjson"), "wx");
    const changes = 12000;
    const levels = Array.from({ length: 200 }, (_, i) => ({ price: ((i + 1) / 1000).toFixed(3), size: "10" }));
    try {
      const initialBook = { event_type: "book", asset_id: "t", bids: levels, asks: [] };
      if (shape === "many-records") await file.writeFile(JSON.stringify(row(1, initialBook)) + "\n");
      const arrayFrames: unknown[] = shape === "one-array-frame" ? [initialBook] : [];
      for (let start = 0; start < changes; start += 500) {
        const chunk = Array.from({ length: Math.min(500, changes - start) }, (_, offset) => {
          const index = start + offset;
          const frame = { event_type: "price_change", price_changes: [{ asset_id: "t", price: "0.100", size: String(index + 1), side: "BUY" }] };
          if (shape === "one-array-frame") arrayFrames.push(frame);
          return JSON.stringify(row(index + 2, frame));
        }).join("\n") + "\n";
        if (shape === "many-records") await file.writeFile(chunk);
      }
      if (shape === "one-array-frame") await file.writeFile(JSON.stringify(row(1, arrayFrames)) + "\n");
    } finally { await file.close(); }
    const moduleUrl = new URL("../../src/collector/export.ts", import.meta.url).href;
    const script = 'import {exportRun} from ' + JSON.stringify(moduleUrl) + '; const result=await exportRun(' + JSON.stringify({ runDirectory: run, outputDirectory: join(root, "output") }) + '); console.log(JSON.stringify(result));';
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--max-old-space-size=96", "--import", fileURLToPath(import.meta.resolve("tsx")), "--input-type=module", "--eval", script
    ], { timeout: 25000, maxBuffer: 1024 * 1024 });
    expect(JSON.parse(stdout)).toMatchObject({ counts: { quotes: changes + 1 } });
  }, 30000);

  test("exports deterministically and leaves the previous export untouched on invalid overwrite input", async () => {
    const { root, run } = await fixture();
    const journal = join(run, "2026-09-10-000000.ndjson");
    const first = row(1, { event_type: "book", asset_id: "t", bids: [], asks: [] });
    await writeFile(journal, JSON.stringify(first) + "\n");
    const one = join(root, "one");
    const two = join(root, "two");
    await exportRun({ runDirectory: run, outputDirectory: one });
    await exportRun({ runDirectory: run, outputDirectory: two });
    for (const file of ["quotes.csv", "trades.csv", "sports.csv", "markets.csv", "quality.json"]) {
      expect(await readFile(join(one, file), "utf8")).toBe(await readFile(join(two, file), "utf8"));
    }
    const before = await readFile(join(one, "quotes.csv"), "utf8");
    await writeFile(journal, JSON.stringify(first) + "\n" + JSON.stringify({ ...first, sequence: 2, runId: "other" }) + "\n");
    await expect(exportRun({ runDirectory: run, outputDirectory: one, overwrite: true })).rejects.toThrow("REPLAY_RUN_MISMATCH");
    expect(await readFile(join(one, "quotes.csv"), "utf8")).toBe(before);
  });
});
