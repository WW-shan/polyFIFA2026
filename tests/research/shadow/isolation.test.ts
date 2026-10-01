import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const sourceRoot = resolve("src");
const shadowRoot = resolve("src/research/shadow");
const shadowFiles = readdirSync(shadowRoot).filter(file => file.endsWith(".ts")).map(file => resolve(shadowRoot, file));

function relativeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specifiers = [...text.matchAll(/from\s+"([^"]+)"/g)].map(match => match[1]!);
  return specifiers
    .filter(specifier => specifier.startsWith("."))
    .map(specifier => {
      const target = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
      return target;
    })
    .filter(target => existsSync(target));
}

function reachable(startFiles: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...startFiles];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const next of relativeImports(file)) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

describe("shadow module isolation", () => {
  test("the import graph never reaches the executor, ledger, runner or main CLI", () => {
    const reached = [...reachable(shadowFiles)].map(file => relative(sourceRoot, file));
    expect(reached.filter(file => file.startsWith("execution/"))).toEqual([]);
    expect(reached.filter(file => file === "persistence/ledger.ts")).toEqual([]);
    expect(reached.filter(file => file === "cli.ts" || file === "runner.ts")).toEqual([]);
    expect(reached.some(file => file.startsWith("persistence/"))).toBe(false);
    expect(reached).toContain("research/shadow/monitor.ts");
  });

  test("shadow sources never reference live-trading configuration", () => {
    for (const file of shadowFiles) {
      const text = readFileSync(file, "utf8");
      expect(text, `${relative(sourceRoot, file)} must not mention private key material`).not.toMatch(/privateKey|PRIVATE_KEY|BOT_MODE/);
      expect(text, `${relative(sourceRoot, file)} must not import the live executor`).not.toMatch(/live-executor|LiveExecutor/);
    }
  });

  test("the exported monitor options cannot disable the shadow flag", async () => {
    const { runLateGameShadow } = await import("../../../src/research/shadow/monitor.js");
    const { parseLateScoreModel } = await import("../../../src/research/shadow/model.js");
    const model = parseLateScoreModel(JSON.parse(readFileSync(resolve("tests/fixtures/shadow/late-score-model.json"), "utf8")));
    const options = { league: { name: "nfl", tagId: "450", espnSport: "football/nfl", finalPeriod: 4, periodSeconds: 900 },
      model, shadowOnly: false, pollIntervalMs: 5_000, idlePollIntervalMs: 30_000, discoveryIntervalMs: 60_000,
      recordWindowSeconds: 900, windowSeconds: 180, minProbability: 0.9, minEdge: 0.03, limitOffset: 0.01, maxPrice: 0.99,
      shares: 5, delaySeconds: 30, followupWindowSeconds: 60, followupStepSeconds: 15, heartbeatIntervalMs: 60_000,
      lookbackHours: 6, aheadHours: 2 };
    await expect(runLateGameShadow(options, {
      discoverMarkets: async () => [], fetchScoreboard: async () => [],
      fetchSummary: async () => ({ status: { state: "unknown", completed: false, period: null, clock: null, clockSeconds: null, detail: null },
        homeScore: null, awayScore: null, winner: null, lastPlay: null }),
      fetchBook: async () => { throw new Error("unused"); }, sink: async () => {}
    })).rejects.toThrow(/SHADOW_ONLY_REQUIRED/);
  });
});
