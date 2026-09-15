import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { exportTail } from "../../src/collector/tail-export.js";
import { backtestTailArchives } from "../../src/research/tail-backtest.js";
import { loadTailArchive } from "../../src/research/tail-backtest-io.js";
import type { SettlementCollection } from "../../src/research/tail-backtest-io.js";
import { fixtureRecords, journalRecord, writeFixture } from "../collector/tail-fixture.js";

// Keep real filesystem operations; make the module exports observable for durability/failure tests.
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>() }));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function writer() {
  const module = await import("../../src/research/tail-backtest-report.js");
  expect(module.writeTailBacktestReport, "the report module must export writeTailBacktestReport").toBeTypeOf("function");
  return module.writeTailBacktestReport!;
}
async function fixture(prices = ["0.70"], windowsSeconds = [180]) {
  const records = fixtureRecords();
  records.splice(13, 0, journalRecord(14, 150_000, "clob", "ws_message", JSON.stringify({
    event_type: "last_trade_price", asset_id: "A", side: "SELL", price: "0.69", size: "3", timestamp: "149999"
  }), "clob"));
  records.forEach((row, index) => { row.sequence = index + 1; });
  const root = await writeFixture(records); roots.push(root);
  const directory = join(root, "archive");
  await exportTail({ runDirectory: join(root, "run"), outputDirectory: directory, windowSeconds: 300,
    maxFeedSilenceMs: 600_000, sportsStaleAfterMs: 600_000 });
  const loaded = await loadTailArchive(directory, { sport: "soccer" });
  const result = backtestTailArchives([loaded.input], { prices, windowsSeconds });
  const provenance = [{ ...loaded.provenance, sourceId: loaded.input.sourceId, sourceRunId: loaded.input.summary.runId, sport: loaded.input.sport }];
  return { root, result, provenance, outputDirectory: join(root, "report") };
}
function csvRows(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i]!;
    if (character === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (character === "," || character === "\n")) {
      row.push(field); field = "";
      if (character === "\n") { rows.push(row); row = []; }
    } else field += character;
  }
  const headers = rows.shift()!;
  return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index]!])));
}

test("writes private exclusive artifacts, source hashes, actual options and a verifiable final completion manifest", async () => {
  const write = await writer(), f = await fixture();
  const files = await write(f.result, f);
  expect(files).toMatchObject({ outputDirectory: f.outputDirectory, reportPath: join(f.outputDirectory, "report.json"),
    summaryPath: join(f.outputDirectory, "summary.csv"), trialsPath: join(f.outputDirectory, "trials.csv"),
    htmlPath: join(f.outputDirectory, "report.html"), inputsPath: join(f.outputDirectory, "inputs.json"), manifestPath: join(f.outputDirectory, "manifest.json") });
  expect((await fs.readdir(f.outputDirectory)).sort()).toEqual(["inputs.json", "manifest.json", "report.html", "report.json", "summary.csv", "trials.csv"]);
  expect((await fs.stat(f.outputDirectory)).mode & 0o777).toBe(0o700);
  const report = JSON.parse(await fs.readFile(files.reportPath, "utf8"));
  expect(report).toMatchObject(f.result);
  expect(report.provenance).toEqual(f.provenance);
  expect(report.assumptions.join(" ")).toMatch(/假设|hypothetical/i);
  const inputs = JSON.parse(await fs.readFile(files.inputsPath, "utf8"));
  expect(inputs).toMatchObject({ options: f.result.options, provenance: f.provenance, sources: f.result.sources });
  const manifest = JSON.parse(await fs.readFile(files.manifestPath, "utf8"));
  expect(manifest).toMatchObject({ status: "complete", execution: "hypothetical", basis: "received-order-book-tail", scenarioTrials: 1, parameterGroups: 1 });
  expect(manifest.files.map((file: { name: string }) => file.name).sort()).toEqual(["inputs.json", "report.html", "report.json", "summary.csv", "trials.csv"]);
  for (const file of manifest.files) {
    const path = join(f.outputDirectory, file.name), bytes = await fs.readFile(path);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect(file.bytes).toBe(bytes.length);
    expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  }
  expect((await fs.stat(files.manifestPath)).mode & 0o777).toBe(0o600);
});

test("leaves unknown PnL null in JSON and blank in CSV with explicit unresolved labels and denominators", async () => {
  const write = await writer(), f = await fixture();
  expect(f.result.trials[0]).toMatchObject({ eligible: true, pnlEligible: false, modeledFilledShares: 1, modeledPnl: null });
  const files = await write(f.result, f);
  const report = JSON.parse(await fs.readFile(files.reportPath, "utf8"));
  expect(report.trials[0]).toMatchObject({ modeledPnl: null, modeledPayout: null, pnlStatus: "unresolved" });
  expect(report.summaries[0]).toMatchObject({ unresolvedTrials: 1, modeledPnl: null, pnlTrialDenominator: 0, filledCapitalDenominator: 0,
    pnlPerTrial: null, returnOnFilledCapital: null });
  const trials = csvRows(await fs.readFile(files.trialsPath, "utf8")), summaries = csvRows(await fs.readFile(files.summaryPath, "utf8"));
  expect(trials[0]).toMatchObject({ eligible: "true", pnlEligible: "false", pnlStatus: "unresolved", modeledPnl: "", modeledPayout: "" });
  expect(summaries[0]).toMatchObject({ unresolvedTrials: "1", pnlTrialDenominator: "0", filledCapitalDenominator: "0", modeledPnl: "", returnOnFilledCapital: "" });
  const html = await fs.readFile(files.htmlPath, "utf8");
  expect(html).toContain("未结算");
  expect(html).toContain("未知（null）");
  expect(html).toContain("盈亏样本分母");
  expect(html).toContain("已结算投入分母");
  expect(html).toContain("假设限价挂单情景");
});

test("CSV neutralizes formulas, retains nested evidence and protects long IDs while HTML escapes selected fields", async () => {
  const write = await writer(), f = await fixture();
  const title = '<img src=x onerror="alert(1)">&\'quoted\'';
  const question = '=HYPERLINK("https://invalid.example/", "click"),\nnext';
  const tokenId = "12345678901234567890123456789012345678901234567890";
  Object.assign(f.result.trials[0]!, { eventTitle: title, question, tokenId, sourceId: "\t=1+1" });
  f.result.trials[0]!.entryReferences[0]!.outcome = "<script>nested evidence</script>";
  f.result.summaries[0]!.sport = "+SUM(1,2)";
  f.provenance[0]!.directory = '</td><script>alert("path")</script>';
  const files = await write(f.result, f);
  const report = JSON.parse(await fs.readFile(files.reportPath, "utf8"));
  expect(report.trials[0].tokenId).toBe(tokenId);
  expect(report.trials[0].question).toBe(question);
  const trials = csvRows(await fs.readFile(files.trialsPath, "utf8")), summaries = csvRows(await fs.readFile(files.summaryPath, "utf8"));
  expect(trials[0]).toMatchObject({ question: "'" + question, sourceId: "'\t=1+1", eventTitle: title, tokenId: "'" + tokenId });
  expect(JSON.parse(trials[0]!.entryReferences!)).toEqual(f.result.trials[0]!.entryReferences);
  expect(Object.keys(trials[0]!)).toEqual(expect.arrayContaining(Object.keys(f.result.trials[0]!)));
  expect(summaries[0]!.sport).toBe("'+SUM(1,2)");
  expect(Object.keys(summaries[0]!)).toEqual(expect.arrayContaining(Object.keys(f.result.summaries[0]!)));
  const html = await fs.readFile(files.htmlPath, "utf8");
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;quoted&#39;");
  expect(html).toContain("&lt;/td&gt;&lt;script&gt;alert(&quot;path&quot;)&lt;/script&gt;");
  expect(html).not.toMatch(/<script\b|<img\b|<iframe\b|<link\b/i);
  expect(html).not.toContain("entryReferences");
  expect(html).toContain("JSON");
  expect(html).toMatch(/长.*ID.*文本/);
});

test("zero eligible scenarios display exclusions and null returns without a portfolio total", async () => {
  const write = await writer(), f = await fixture(["0.99"], [60, 180]);
  expect(f.result.trials.every(trial => !trial.eligible)).toBe(true);
  const files = await write(f.result, f);
  const report = JSON.parse(await fs.readFile(files.reportPath, "utf8"));
  expect(report.summaries).toHaveLength(2);
  expect(report.summaries.every((summary: { modeledPnl: number | null }) => summary.modeledPnl === null)).toBe(true);
  expect(report.trials.every((trial: { pnlStatus: string }) => trial.pnlStatus === "excluded")).toBe(true);
  const html = await fs.readFile(files.htmlPath, "utf8");
  expect(html).toContain("没有数据合格的情景");
  expect(html).toContain("limit-not-below-entry-ask");
  expect(html).toMatch(/不同参数.*时间窗口.*市场.*不可.*相加/);
  expect(html).not.toMatch(/总利润|总收益|保证盈利/);
});

test("an empty result still emits CSV headers and an explicit no-sample explanation", async () => {
  const write = await writer(), root = await fs.mkdtemp(join(tmpdir(), "poly-tail-report-test-")); roots.push(root);
  const files = await write(backtestTailArchives([]), { outputDirectory: join(root, "report"), provenance: [] });
  expect(await fs.readFile(files.summaryPath, "utf8")).toContain("pnlTrialDenominator");
  expect(await fs.readFile(files.trialsPath, "utf8")).toContain("modeledPnl");
  expect(await fs.readFile(files.htmlPath, "utf8")).toContain("没有数据合格的情景");
});

test("stores full new settlement observations and errors separately and includes their artifact in the manifest", async () => {
  const write = await writer(), f = await fixture();
  const evidence: SettlementCollection = { settlements: [], errors: ['upstream <script>alert("error")</script>'], observations: [{ provider: "gamma",
    sourceUrl: "https://gamma-api.polymarket.com/events/slug/game", observedAtMs: 1_700_000_000_000,
    response: { status: 502, statusText: "Bad Gateway", headers: { "x-raw": "full header" }, body: "<h1>full raw response</h1>" } }] };
  const files = await write(f.result, { ...f, evidence });
  expect(files.settlementsPath).toBe(join(f.outputDirectory, "settlements.json"));
  expect(JSON.parse(await fs.readFile(files.settlementsPath!, "utf8"))).toMatchObject(evidence);
  const manifest = JSON.parse(await fs.readFile(files.manifestPath, "utf8"));
  expect(manifest.files).toEqual(expect.arrayContaining([expect.objectContaining({ name: "settlements.json" })]));
  const html = await fs.readFile(files.htmlPath, "utf8");
  expect(html).toContain("upstream &lt;script&gt;alert(&quot;error&quot;)&lt;/script&gt;");
  expect(html).not.toContain("<h1>full raw response</h1>");
});

test("refuses existing directories and files without overwriting or adding artifacts", async () => {
  const write = await writer(), f = await fixture();
  await fs.mkdir(f.outputDirectory); await fs.writeFile(join(f.outputDirectory, "keep"), "keep");
  await expect(write(f.result, f)).rejects.toThrow("TAIL_BACKTEST_OUTPUT_EXISTS");
  expect(await fs.readdir(f.outputDirectory)).toEqual(["keep"]);
  const target = join(f.root, "file"); await fs.writeFile(target, "keep");
  await expect(write(f.result, { ...f, outputDirectory: target })).rejects.toThrow("TAIL_BACKTEST_OUTPUT_EXISTS");
  expect(await fs.readFile(target, "utf8")).toBe("keep");
});

test("syncs and closes all artifact files before opening the completion manifest", async () => {
  const write = await writer(), f = await fixture(), actualOpen = fs.open;
  const synced = new Set<string>(), closed = new Set<string>();
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const path = String(args[0]);
    if (path === join(f.outputDirectory, "manifest.json")) {
      for (const name of ["report.json", "summary.csv", "trials.csv", "report.html", "inputs.json"]) {
        expect(synced.has(join(f.outputDirectory, name)), name + " must be synced").toBe(true);
        expect(closed.has(join(f.outputDirectory, name)), name + " must be closed").toBe(true);
      }
    }
    const handle = await actualOpen(...args), sync = handle.sync.bind(handle), close = handle.close.bind(handle);
    vi.spyOn(handle, "sync").mockImplementation(async () => { await sync(); synced.add(path); });
    vi.spyOn(handle, "close").mockImplementation(async () => { await close(); closed.add(path); });
    return handle;
  });
  const files = await write(f.result, f);
  expect(synced.has(files.manifestPath)).toBe(true);
  expect(closed.has(files.manifestPath)).toBe(true);
});

test("a write failure preserves completed artifacts and never publishes a completion manifest or overwrites on retry", async () => {
  const write = await writer(), f = await fixture(), actualOpen = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === join(f.outputDirectory, "summary.csv")) throw new Error("synthetic disk failure");
    return actualOpen(...args);
  });
  await expect(write(f.result, f)).rejects.toThrow("synthetic disk failure");
  const names = await fs.readdir(f.outputDirectory);
  expect(names).toContain("report.json");
  expect(names).not.toContain("manifest.json");
  expect(JSON.parse(await fs.readFile(join(f.outputDirectory, "report.json"), "utf8"))).toMatchObject(f.result);
  await expect(write(f.result, f)).rejects.toThrow("TAIL_BACKTEST_OUTPUT_EXISTS");
});
