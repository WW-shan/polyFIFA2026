import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { csvDocument, writeBacktestReport } from "../../src/research/report.js";
import { backtestDataset } from "../../src/research/backtest.js";
import type { ResearchDataset } from "../../src/research/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
test("CSV preserves commas, newlines, quotes, numbers, missing fields and exclusion lists", () => {
  const csv = csvDocument([{ name: 'A, "B"\nC', amount: -.7, missing: null, reasons: ["stale", "unresolved"] }], ["name", "amount", "missing", "reasons"]);
  expect(csv).toContain('"A, ""B""\nC",-0.7,,"[""stale"",""unresolved""]"');
  expect(csv.startsWith("name,amount,missing,reasons\n")).toBe(true);
});
test("CSV neutralizes spreadsheet formulas in untrusted market names", () => {
  expect(csvDocument([{ question: "=1+1" }], ["question"])).toBe("question\n'=1+1\n");
});
test("writes self-describing JSON and separate trial/parameter CSVs, never overwrites existing evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "poly-research-report-")); roots.push(root);
  const outputDirectory = join(root, "report");
  const dataset = { schemaVersion: 1, kind: "public-trade-history", events: [] } as unknown as ResearchDataset;
  const result = backtestDataset(dataset);
  const written = await writeBacktestReport(result, { outputDirectory, inputPath: "/data/input.json", inputSha256: "a".repeat(64) });
  expect((await readdir(outputDirectory)).sort()).toEqual(["manifest.json", "report.json", "summary.csv", "trials.csv"]);
  expect(JSON.parse(await readFile(written.reportPath, "utf8"))).toMatchObject({ basis: "historical-public-trade-screen", trials: [], warnings: result.warnings });
  expect(JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8"))).toMatchObject({ inputPath: "/data/input.json", inputSha256: "a".repeat(64) });
  expect(await readFile(join(outputDirectory, "summary.csv"), "utf8")).toContain("eligibleTrials");
  await expect(writeBacktestReport(result, { outputDirectory })).rejects.toThrow();
});
