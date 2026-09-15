import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { exportTail } from "../../src/collector/tail-export.js";
import type { JournalRecord } from "../../src/collector/types.js";
import type { HttpOptions, HttpResponseText } from "../../src/polymarket/http.js";
import { writeTailBacktestReport } from "../../src/research/tail-backtest-report.js";
import type { TailBacktestResult } from "../../src/research/tail-backtest-types.js";
import { eventMetadata, fixtureRecords, writeFixture } from "../collector/tail-fixture.js";

const roots: string[] = [];
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected real network request"); })); });
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function cli() {
  const module = await import("../../src/research/tail-backtest-cli.js");
  expect(module.runTailBacktestCli, "the CLI must export runTailBacktestCli").toBeTypeOf("function");
  return module.runTailBacktestCli!;
}
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "poly-tail-cli-test-")); roots.push(root); return root;
}
function secondGame(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(secondGame);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secondGame(v)]));
  if (value === 123) return 456;
  if (typeof value !== "string") return value;
  const replacements: Record<string, string> = { "tail-test": "tail-test-two", event: "event-two", game: "game-two", winner: "winner-two", condition: "condition-two", A: "C", B: "D" };
  if (Object.hasOwn(replacements, value)) return replacements[value];
  if (value.startsWith("{") || value.startsWith("[")) return JSON.stringify(secondGame(JSON.parse(value)));
  return value;
}
async function archive(distinct = false) {
  const records = distinct ? secondGame(fixtureRecords()) as JournalRecord[] : fixtureRecords();
  const root = await writeFixture(records); roots.push(root);
  const directory = join(root, "archive");
  await exportTail({ runDirectory: join(root, "run"), outputDirectory: directory, windowSeconds: 300,
    maxFeedSilenceMs: 600_000, sportsStaleAfterMs: 600_000 });
  return { root, directory, output: join(root, "report") };
}
function response(raw: unknown, status = 200): HttpResponseText {
  return { status, statusText: status === 200 ? "OK" : "Service Unavailable", headers: { "content-type": "application/json", "x-evidence": "preserve-me" }, body: JSON.stringify(raw) };
}
function resolvedEvent(distinct = false) {
  const event = structuredClone(eventMetadata().event) as Record<string, unknown>;
  Object.assign((event.markets as Record<string, unknown>[])[0]!, {
    closed: true, umaResolutionStatus: "resolved", clobTokenIds: ["B", "A"], outcomes: ["B", "A"], outcomePrices: ["1", "0"]
  });
  return distinct ? secondGame(event) : event;
}

test("help is read-only, returns captured output, and does not install process signal handlers", async () => {
  const run = await cli(), root = await temporary();
  const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const request = vi.fn(async () => response({}));
  const result = await run(["--archive-dir", join(root, "absent"), "--output-dir", join(root, "absent-parent", "report"), "--fetch-settlements", "--help"], { request });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("--windows-seconds");
  expect(result.stdout).toContain("--fetch-settlements");
  expect(result.stdout).toMatch(/hypothetical/i);
  expect(result.stderr).toBe("");
  expect(request).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(signals);
});

test.each([
  ["--unknown"], ["--prices", "0.7,,0.8"], ["--prices", "0"], ["--prices", "1"], ["--prices", "NaN"],
  ["--windows-seconds", "1.5"], ["--windows-seconds", "1e2"], ["--windows-seconds", "0"],
  ["--entry-min-bid", "1.1"], ["--shares", "0"], ["--shares", "Infinity"], ["--shares", "0x10"],
  ["--queue-ahead-shares", "-1"], ["--maker-fee-bps", "10001"], ["--fill-model", "live"],
  ["--proxy-url", "file:///tmp/proxy"], ["--sport", " "], ["--prices"],
  ["--shares", "1", "--shares", "2"], ["--require-fresh-context", "false"], ["--help", "--unknown"]
])("invalid arguments fail without output or public requests: %j", async (...flags) => {
  const run = await cli(), root = await temporary();
  const request = vi.fn(async () => response({}));
  const result = await run(["--archive-dir", join(root, "absent"), "--output-dir", join(root, "new-parent", "report"), "--fetch-settlements", ...flags], { request });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("TAIL_BACKTEST_OPTIONS_INVALID");
  expect(result.stdout).toBe("");
  expect(request).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});

test.each([[], ["--archive-dir", "missing"], ["--output-dir", "missing"]])("requires archives and a new output directory: %j", async (...args) => {
  const run = await cli();
  const result = await run(args);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("TAIL_BACKTEST_OPTIONS_INVALID");
  expect(fetch).not.toHaveBeenCalled();
});

test("runs a real exported archive offline and preserves exact price strings and every parsed option", async () => {
  const run = await cli(), f = await archive();
  const request = vi.fn(async () => response({}));
  const result = await run(["--archive-dir", f.directory, "--output-dir", f.output, "--sport", "soccer",
    "--prices", "0.70000000000000001,0.8000", "--windows-seconds", "60,180", "--entry-min-bid", "0.9000",
    "--shares", "2.5", "--queue-ahead-shares", "0.25", "--maker-fee-bps", "12.5",
    "--fill-model", "sell-through-volume", "--require-fresh-context"], { request });
  expect(result.exitCode, result.stderr).toBe(0);
  const paths = JSON.parse(result.stdout);
  expect(paths.reportPath).toBe(join(await realpath(f.root), "report", "report.json"));
  const report = JSON.parse(await readFile(paths.reportPath, "utf8"));
  expect(report.options).toEqual({ prices: ["0.70000000000000001", "0.8000"], windowsSeconds: [60, 180], entryMinBid: "0.9000",
    shares: 2.5, queueAheadShares: .25, makerFeeBps: 12.5, fillModel: "sell-through-volume", requireFreshContext: true });
  expect(report.sources).toHaveLength(1);
  expect(report.sources[0].sport).toBe("soccer");
  expect(report.trials).toHaveLength(4);
  expect(request).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(await readdir(f.output)).not.toContain("settlements.json");
  const inputs = JSON.parse(await readFile(paths.inputsPath, "utf8"));
  expect(inputs.provenance[0].directory).toBe(await realpath(f.directory));
  expect(inputs.provenance[0].sourceRunId).toBe("tail-test");
  for (const file of inputs.provenance[0].files) {
    const bytes = await readFile(join(f.directory, file.name));
    expect(file.bytes).toBe(bytes.length);
    expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  }
});

test("defaults sport to unknown and supports report capture without creating an output directory", async () => {
  const run = await cli(), f = await archive();
  let captured: TailBacktestResult | undefined;
  const result = await run(["--archive-dir", f.directory, "--output-dir", f.output], {
    report: async (value, options) => {
      captured = value;
      expect(options.provenance[0]!.directory).toBe(await realpath(f.directory));
      return { outputDirectory: f.output, reportPath: join(f.output, "report.json"), summaryPath: join(f.output, "summary.csv"),
        trialsPath: join(f.output, "trials.csv"), htmlPath: join(f.output, "report.html"), inputsPath: join(f.output, "inputs.json"), manifestPath: join(f.output, "manifest.json") };
    }
  });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(captured?.sources[0]?.sport).toBe("unknown");
  expect(captured?.options).toMatchObject({ prices: ["0.50", "0.60", "0.70", "0.80", "0.90", "0.95", "0.97", "0.99"], windowsSeconds: [60, 180, 300] });
  expect(await readdir(f.root)).not.toContain("report");
});

test("rejects an existing output directory before fetching or changing its files", async () => {
  const run = await cli(), f = await archive(), before = await readFile(join(f.directory, "manifest.json"));
  const alias = join(f.root, "parent-alias"); await symlink(f.root, alias, "dir");
  const request = vi.fn(async () => response(resolvedEvent()));
  for (const output of [f.directory, join(alias, "archive")]) {
    const result = await run(["--archive-dir", f.directory, "--output-dir", output, "--fetch-settlements"], { request });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("TAIL_BACKTEST_OUTPUT_EXISTS");
  }
  expect(request).not.toHaveBeenCalled();
  expect(await readFile(join(f.directory, "manifest.json"))).toEqual(before);
  expect(await readdir(f.directory)).not.toContain("report.json");
});

test.each(["direct", "missing-parents", "output-ancestor-alias", "input-ancestor-alias", "second-archive"])(
  "rejects output nested in an archive before fetching or report writes: %s", async layout => {
    const run = await cli(), first = await archive();
    const archives = [first], inputs = [first.directory];
    let output = join(first.directory, "report");
    if (layout === "missing-parents") output = join(first.directory, "new-parent", "new-child", "report");
    if (layout === "output-ancestor-alias" || layout === "input-ancestor-alias") {
      const alias = join(first.root, "parent-alias"); await symlink(first.root, alias, "dir");
      if (layout === "output-ancestor-alias") output = join(alias, "archive", "new-parent", "report");
      else inputs[0] = join(alias, "archive");
    }
    if (layout === "second-archive") {
      const second = await archive(true); archives.push(second); inputs.push(second.directory);
      output = join(second.directory, "new-parent", "report");
    }
    const snapshots = await Promise.all(archives.map(async item => {
      const names = (await readdir(item.directory)).sort();
      return { directory: item.directory, names, bytes: await Promise.all(names.map(name => readFile(join(item.directory, name)))) };
    }));
    const request = vi.fn(async (url: string) => response(resolvedEvent(url.endsWith("game-two"))));
    const report = vi.fn(writeTailBacktestReport);
    const result = await run([...inputs.flatMap(directory => ["--archive-dir", directory]), "--output-dir", output, "--fetch-settlements"], { request, report });
    expect(result.exitCode, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("TAIL_BACKTEST_OUTPUT_IN_ARCHIVE");
    expect(result.stdout).toBe("");
    expect(request).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    for (const snapshot of snapshots) {
      expect((await readdir(snapshot.directory)).sort()).toEqual(snapshot.names);
      for (let i = 0; i < snapshot.names.length; i++) expect(await readFile(join(snapshot.directory, snapshot.names[i]!))).toEqual(snapshot.bytes[i]);
    }
  }
);

test("allows sibling reports with a shared archive-name prefix through ancestor aliases", async () => {
  const run = await cli(), f = await archive(), names = (await readdir(f.directory)).sort();
  const alias = join(f.root, "parent-alias"); await symlink(f.root, alias, "dir");
  const output = join(alias, "archive-report", "new-parent", "report");
  const canonicalOutput = join(await realpath(f.root), "archive-report", "new-parent", "report");
  const request = vi.fn(async () => response({}));
  const report = vi.fn(writeTailBacktestReport);
  const result = await run(["--archive-dir", join(alias, "archive"), "--output-dir", output], { request, report });
  expect(result.exitCode, result.stderr).toBe(0);
  const files = JSON.parse(result.stdout);
  expect(files.outputDirectory).toBe(canonicalOutput);
  expect(report.mock.calls[0]![1].outputDirectory).toBe(canonicalOutput);
  for (const key of ["reportPath", "summaryPath", "trialsPath", "htmlPath", "inputsPath", "manifestPath"]) {
    expect(files[key]).toBe(await realpath(files[key]));
  }
  expect(JSON.parse(await readFile(files.manifestPath, "utf8"))).toMatchObject({ status: "complete" });
  expect((await readdir(f.directory)).sort()).toEqual(names);
  expect(request).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

test.each(["archive", "other-sibling"])("rejects an output alias retargeted during settlement fetching to %s", async target => {
  const run = await cli(), f = await archive(), names = (await readdir(f.directory)).sort();
  const safe = join(f.root, "safe"), other = join(f.root, "other");
  await mkdir(safe); await mkdir(other);
  const alias = join(f.root, "output-alias"); await symlink(safe, alias, "dir");
  const request = vi.fn(async () => {
    await unlink(alias); await symlink(target === "archive" ? f.directory : other, alias, "dir");
    return response(resolvedEvent());
  });
  const report = vi.fn(writeTailBacktestReport);
  const result = await run(["--archive-dir", f.directory, "--output-dir", join(alias, "report"), "--fetch-settlements"], { request, report });
  expect(result.exitCode, result.stderr).not.toBe(0);
  expect(result.stderr).toContain(target === "archive" ? "TAIL_BACKTEST_OUTPUT_IN_ARCHIVE" : "TAIL_BACKTEST_OUTPUT_CHANGED");
  expect(result.stdout).toBe("");
  expect(request).toHaveBeenCalledTimes(1);
  expect(report).not.toHaveBeenCalled();
  expect((await readdir(f.directory)).sort()).toEqual(names);
  expect(await readdir(safe)).toEqual([]);
  expect(await readdir(other)).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

test("writes to the checked canonical destination even if the original alias changes at the writer boundary", async () => {
  const run = await cli(), f = await archive(), names = (await readdir(f.directory)).sort();
  const safe = join(f.root, "safe"); await mkdir(safe);
  const alias = join(f.root, "output-alias"); await symlink(safe, alias, "dir");
  const canonicalOutput = join(await realpath(safe), "report");
  const report = vi.fn(async (...args: Parameters<typeof writeTailBacktestReport>) => {
    await unlink(alias); await symlink(f.directory, alias, "dir");
    return writeTailBacktestReport(...args);
  });
  const result = await run(["--archive-dir", f.directory, "--output-dir", join(alias, "report")], { report });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(report.mock.calls[0]![1].outputDirectory).toBe(canonicalOutput);
  const files = JSON.parse(result.stdout);
  expect(files.outputDirectory).toBe(canonicalOutput);
  expect(files.manifestPath).toBe(join(canonicalOutput, "manifest.json"));
  expect(JSON.parse(await readFile(files.manifestPath, "utf8"))).toMatchObject({ status: "complete" });
  expect((await readdir(f.directory)).sort()).toEqual(names);
  expect(await readdir(safe)).toEqual(["report"]);
  expect(fetch).not.toHaveBeenCalled();
});

test("rejects an existing output file or dangling symlink before fetching", async () => {
  const run = await cli(), root = await temporary(), request = vi.fn(async () => response({}));
  const file = join(root, "keep"); await writeFile(file, "keep");
  const link = join(root, "link"); await symlink(join(root, "missing"), link);
  for (const output of [file, link]) {
    const result = await run(["--archive-dir", join(root, "absent"), "--output-dir", output, "--fetch-settlements"], { request });
    expect(result.stderr).toContain("TAIL_BACKTEST_OUTPUT_EXISTS");
  }
  expect(request).not.toHaveBeenCalled();
  expect(await readFile(file, "utf8")).toBe("keep");
});

test.each(["failed", "incomplete", "malformed", "missing"])("a %s archive fails the entire run instead of being skipped", async state => {
  const run = await cli(), good = await archive(), bad = await archive(true);
  const manifest = join(bad.directory, "manifest.json");
  if (state === "missing") await rm(manifest);
  else if (state === "malformed") await writeFile(join(bad.directory, "seconds.ndjson"), "{broken\n");
  else await writeFile(manifest, JSON.stringify({ ...JSON.parse(await readFile(manifest, "utf8")), status: state }));
  const request = vi.fn(async () => response({}));
  const result = await run(["--archive-dir", good.directory, "--archive-dir", bad.directory, "--output-dir", good.output, "--fetch-settlements"], { request });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain(bad.directory);
  expect(request).not.toHaveBeenCalled();
  expect(await readdir(good.root)).not.toContain("report");
});

test("engine preflight rejects repeated archives and same-game copies before settlement fetching", async () => {
  const run = await cli(), first = await archive(), copy = await archive();
  const request = vi.fn(async () => response({}));
  for (const second of [first.directory, copy.directory]) {
    const result = await run(["--archive-dir", first.directory, "--archive-dir", second, "--output-dir", first.output, "--fetch-settlements"], { request });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/TAIL_BACKTEST_INPUT_INVALID.*duplicate/);
  }
  expect(request).not.toHaveBeenCalled();
  expect(await readdir(first.root)).not.toContain("report");
});

test("fetch preserves complete public responses and maps settlements to each archive without changing prices or selected sides", async () => {
  const run = await cli(), first = await archive(), second = await archive(true);
  const originals = await Promise.all([first, second].map(f => readFile(join(f.directory, "quality.json"))));
  const controller = new AbortController();
  const request = vi.fn(async (url: string, options?: HttpOptions) => {
    expect(options?.proxyUrl).toBe("http://127.0.0.1:9999");
    expect(options?.signal).toBe(controller.signal);
    expect(url).toMatch(/^https:\/\/gamma-api\.polymarket\.com\/events\/slug\/game(?:-two)?$/);
    return response(resolvedEvent(url.endsWith("game-two")));
  });
  const result = await run(["--archive-dir", first.directory, "--archive-dir", second.directory, "--output-dir", first.output,
    "--sport", "soccer", "--prices", "0.7000", "--windows-seconds", "180", "--fetch-settlements", "--proxy-url", "http://127.0.0.1:9999"],
  { request, signal: controller.signal, now: () => 1_700_000_000_000 });
  expect(result.exitCode, result.stderr).toBe(0);
  const paths = JSON.parse(result.stdout), report = JSON.parse(await readFile(paths.reportPath, "utf8"));
  expect(report.sources).toHaveLength(2);
  expect(report.trials.map((trial: { tokenId: string; bidPrice: string; payoutPerShare: number }) => [trial.tokenId, trial.bidPrice, trial.payoutPerShare])).toEqual([
    ["A", "0.7000", 0], ["C", "0.7000", 0]
  ]);
  expect(report.trials[0].settlementVector.map((label: { tokenId: string }) => label.tokenId).sort()).toEqual(["A", "B"]);
  expect(report.trials[1].settlementVector.map((label: { tokenId: string }) => label.tokenId).sort()).toEqual(["C", "D"]);
  const evidence = JSON.parse(await readFile(paths.settlementsPath, "utf8"));
  expect(evidence.observations).toHaveLength(2);
  expect(evidence.observations[0]).toEqual({ provider: "gamma", sourceUrl: "https://gamma-api.polymarket.com/events/slug/game",
    observedAtMs: 1_700_000_000_000, response: response(resolvedEvent()) });
  expect(evidence.errors).toEqual([]);
  expect(request).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 2; i++) expect(await readFile(join([first, second][i]!.directory, "quality.json"))).toEqual(originals[i]);
});

test("failed public responses remain in settlement evidence alongside errors and unresolved labels", async () => {
  const run = await cli(), f = await archive();
  const failed: HttpResponseText = { status: 503, statusText: "Service Unavailable", headers: { "retry-after": "1" }, body: "<html>upstream unavailable</html>" };
  const result = await run(["--archive-dir", f.directory, "--output-dir", f.output, "--fetch-settlements"], { request: async () => failed });
  expect(result.exitCode, result.stderr).toBe(0);
  const paths = JSON.parse(result.stdout), evidence = JSON.parse(await readFile(paths.settlementsPath, "utf8"));
  expect(evidence.settlements).toEqual([]);
  expect(evidence.observations).toHaveLength(2);
  expect(evidence.observations.every((observation: { response: HttpResponseText }) => JSON.stringify(observation.response) === JSON.stringify(failed))).toBe(true);
  expect(evidence.errors).toHaveLength(2);
  expect(result.stderr).toMatch(/settlement/i);
  const report = JSON.parse(await readFile(paths.reportPath, "utf8"));
  expect(report.trials.every((trial: { settlement: unknown }) => trial.settlement === null)).toBe(true);
});

test("an aborted caller performs no requests or output writes", async () => {
  const run = await cli(), root = await temporary(), controller = new AbortController();
  controller.abort(new Error("test cancellation"));
  const request = vi.fn(async () => response({}));
  const result = await run(["--archive-dir", join(root, "missing"), "--output-dir", join(root, "report"), "--fetch-settlements"], { signal: controller.signal, request });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("test cancellation");
  expect(request).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});
