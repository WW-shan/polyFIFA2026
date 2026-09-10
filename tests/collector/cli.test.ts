import { describe, expect, test } from "vitest";
import { parseCollectorCliArgs } from "../../src/collector/cli.js";

describe("collector CLI", () => {
  test("parses finite collection settings without loading credentials", () => {
    const parsed = parseCollectorCliArgs([
      "collect",
      "--duration-seconds", "12.5",
      "--sports", "NBA,tennis",
      "--event-slugs", "game-a,game-b",
      "--all-open",
      "--max-tokens-per-socket", "50"
    ]);

    expect(parsed).toMatchObject({
      command: "collect",
      options: {
        durationSeconds: 12.5,
        sports: ["NBA", "tennis"],
        eventSlugs: ["game-a", "game-b"],
        allOpen: true,
        maxTokensPerSocket: 50
      }
    });
  });

  test("parses export paths and explicit overwrite", () => {
    expect(parseCollectorCliArgs(["export", "--run-dir", "data/collector/run", "--output-dir", "tmp/export", "--overwrite"])).toEqual({
      command: "export",
      options: { runDirectory: "data/collector/run", outputDirectory: "tmp/export", overwrite: true }
    });
  });

  test.each([
    ["collect", "--duration-seconds", "-1"],
    ["collect", "--max-tokens-per-socket", "0"],
    ["collect", "--unknown", "x"],
    ["export"]
  ])("rejects invalid invocation %j", (...args) => {
    expect(() => parseCollectorCliArgs(args)).toThrow("CLI_ARGUMENTS_INVALID");
  });
});
