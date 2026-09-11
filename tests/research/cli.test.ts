import { describe, expect, test } from "vitest";
import { parseResearchCliArgs, runResearchCli } from "../../src/research/cli.js";

describe("research CLI", () => {
  test("parses bounded historical downloads independently of all live trading settings", () => {
    expect(parseResearchCliArgs(["download", "--sport", "tennis", "--max-events", "30", "--output-dir", "data/research/run", "--require-finish", "--market-types", "moneyline,tennis_match_totals"]))
      .toEqual({ command: "download", options: { sport: "tennis", maxEvents: 30, outputDirectory: "data/research/run", requireFinish: true, marketTypes: ["moneyline", "tennis_match_totals"] } });
  });
  test("parses a tunable resting price grid instead of hardcoding .7", () => {
    expect(parseResearchCliArgs(["backtest", "--input", "input.json", "--output-dir", "report", "--prices", ".5,.7,.85", "--windows", "60,300", "--shares", "100", "--entry-min-price", ".92", "--entry-mode", "price-trigger", "--fill-model", "sell-at-or-below", "--queue-ahead-shares", "20"]))
      .toMatchObject({ command: "backtest", inputPath: "input.json", outputDirectory: "report", options: { prices: [.5, .7, .85], windowsSeconds: [60, 300], shares: 100, entryMinPrice: .92, entryMode: "price-trigger", fillModel: "sell-at-or-below", queueAheadShares: 20 } });
  });
  test.each([
    [], ["trade"], ["download"], ["backtest", "--input", "input.json"],
    ["download", "--output-dir", "x", "--max-events", "0"], ["download", "--output-dir", "x", "--max-events", "1.5"],
    ["backtest", "--input", "x", "--output-dir", "y", "--prices", ".7,,.8"],
    ["backtest", "--input", "x", "--output-dir", "y", "--prices", "1"],
    ["backtest", "--input", "x", "--output-dir", "y", "--fill-model", "guaranteed"],
    ["download", "--output-dir", "x", "--private-key", "never-used"], ["backtest", "--input"]
  ])("rejects invalid or unrelated arguments %j", (...args) => {
    expect(() => parseResearchCliArgs(args)).toThrow("RESEARCH_OPTIONS_INVALID");
  });
  test("dispatches download options and outputs a compact result", async () => {
    let received: unknown;
    const lines: string[] = [];
    await runResearchCli(["download", "--output-dir", "run"], {
      download: async options => { received = options; return { datasetPath: "run/dataset.json", eventCount: 1, marketCount: 2, tradeCount: 3, incompleteMarkets: 0 }; },
      write: text => { lines.push(text); }
    });
    expect(received).toMatchObject({ sport: "tennis", outputDirectory: "run" });
    expect(JSON.parse(lines[0]!)).toMatchObject({ eventCount: 1, tradeCount: 3 });
  });
  test("backtests the input contents and includes its hash in report provenance", async () => {
    let reportOptions: unknown;
    await runResearchCli(["backtest", "--input", "input.json", "--output-dir", "report"], {
      readInput: async () => JSON.stringify({ schemaVersion: 1, kind: "public-trade-history", events: [] }),
      report: async (result, options) => { reportOptions = options; expect(result.basis).toBe("historical-public-trade-screen"); return { reportPath: "report/report.json", summaryPath: "report/summary.csv", trialsPath: "report/trials.csv" }; },
      write: () => {}
    });
    expect(reportOptions).toMatchObject({ inputPath: expect.stringContaining("input.json"), inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  test("help never starts requests or creates output", async () => {
    let called = false; const lines: string[] = [];
    await runResearchCli(["--help"], { download: async () => { called = true; throw new Error("unexpected"); }, write: text => { lines.push(text); } });
    expect(called).toBe(false); expect(lines.join("\n")).toContain("price-trigger");
  });
});
