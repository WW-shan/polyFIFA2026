import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { parseShadowArgs, runShadowCli, shadowHelp, type ShadowCliDependencies } from "../../../src/research/shadow/cli.js";
import type { ShadowMonitorDeps, ShadowMonitorOptions, ShadowRunSummary } from "../../../src/research/shadow/monitor.js";

const modelText = readFileSync(resolve("tests/fixtures/shadow/late-score-model.json"), "utf8");

function deps(overrides: Partial<ShadowCliDependencies> = {}) {
  const appended: Array<{ path: string; record: Record<string, unknown> }> = [];
  const runs: Array<{ options: ShadowMonitorOptions; deps: ShadowMonitorDeps }> = [];
  const base: ShadowCliDependencies = {
    readFile: async () => modelText,
    appendRecord: async (path: string, record: Record<string, unknown>) => { appended.push({ path, record }); },
    run: async (options, runDeps): Promise<ShadowRunSummary> => {
      runs.push({ options, deps: runDeps });
      await runDeps.sink({ kind: "run-start", atMs: 0 });
      return { iterations: 1, trackedGames: 0, signals: 0, startedAtMs: 0, endedAtMs: 1 };
    },
    write: () => {},
    mkdir: async () => {},
    now: () => Date.parse("2026-09-28T12:00:00Z")
  };
  return { ...base, appended, runs, ...overrides };
}

describe("parseShadowArgs", () => {
  test("parses a full command line", () => {
    const parsed = parseShadowArgs(["--league", "nfl", "--model", "m.json", "--out", "o.ndjson", "--interval-ms", "7000",
      "--duration-minutes", "3", "--shares", "10", "--min-edge", "0.04", "--lookback-hours", "8", "--ahead-hours", "24", "--quiet"]);
    expect(parsed).toMatchObject({ command: "run", league: "nfl", modelPath: "m.json", outPath: "o.ndjson",
      intervalMs: 7000, durationMs: 180_000, shares: 10, minEdge: 0.04, lookbackHours: 8, aheadHours: 24, quiet: true });
  });

  test("defaults the model and output paths per league", () => {
    // The default output path is a UTC timestamp; pin the clock so the
    // assertion cannot rot when the calendar day changes.
    const parsed = parseShadowArgs(["--league", "nba", "--once"], Date.parse("2026-09-28T12:00:00Z"));
    expect(parsed).toMatchObject({ command: "run", league: "nba", once: true });
    if (parsed.command !== "run") throw new Error("expected run");
    expect(parsed.modelPath).toContain("late-score-nba.json");
    expect(parsed.outPath).toBe("data/research/shadow/nba-20260928T120000Z.ndjson");
  });

  test("rejects bad input", () => {
    expect(() => parseShadowArgs([])).toThrow(/SHADOW_CLI_INVALID/);
    expect(() => parseShadowArgs(["--league", "soccer"])).toThrow(/SHADOW_CLI_INVALID/);
    expect(() => parseShadowArgs(["--league", "nfl", "--interval-ms", "0"])).toThrow(/SHADOW_CLI_INVALID/);
    expect(() => parseShadowArgs(["--league", "nfl", "--nope"])).toThrow(/SHADOW_CLI_INVALID/);
    expect(parseShadowArgs(["--help"])).toMatchObject({ command: "help" });
  });
});

describe("runShadowCli", () => {
  test("loads the exported model and runs a single shadow tick", async () => {
    const d = deps();
    const code = await runShadowCli(["--league", "nfl", "--model", "model.json", "--out", "/tmp/shadow.ndjson", "--once"], d);
    expect(code).toBe(0);
    expect(d.runs).toHaveLength(1);
    const options = d.runs[0]!.options;
    expect(options.shadowOnly).toBe(true);
    expect(options.maxIterations).toBe(1);
    expect(options.league.name).toBe("nfl");
    expect(options.model.league).toBe("nfl");
    expect(d.appended.length).toBeGreaterThan(0);
    expect(d.appended[0]!.path).toBe("/tmp/shadow.ndjson");
  });

  test("reports model and runtime failures as an error exit code", async () => {
    const bad = deps({ readFile: async () => "{not json" });
    expect(await runShadowCli(["--league", "nfl", "--out", "/tmp/x.ndjson", "--once"], bad)).toBe(2);
    const failing = deps({ run: async () => { throw new Error("boom"); } });
    expect(await runShadowCli(["--league", "nfl", "--out", "/tmp/x.ndjson", "--once"], failing)).toBe(2);
  });

  test("prints help without running", async () => {
    const d = deps();
    let text = "";
    const code = await runShadowCli(["--help"], { ...d, write: value => { text += value; } });
    expect(code).toBe(0);
    expect(d.runs).toHaveLength(0);
    expect(text).toContain("Shadow only");
    expect(shadowHelp()).toContain("--league");
  });

  test("requires the shadow-only flag to survive injection", async () => {
    const d = deps();
    await runShadowCli(["--league", "nfl", "--out", "/tmp/x.ndjson", "--once"], d);
    const options = d.runs[0]!.options;
    expect(options.shadowOnly).toBe(true);
    expect(JSON.stringify(options)).not.toContain("privateKey");
  });
});
