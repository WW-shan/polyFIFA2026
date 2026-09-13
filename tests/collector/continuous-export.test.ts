import { afterEach, expect, test } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runTailExport } from "../../src/collector/continuous-export.js";
import { fixtureRecords, writeFixture } from "./tail-fixture.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("exports a completed game in a real child process and reads its actual quality", async () => {
  const root = await writeFixture(fixtureRecords()); roots.push(root);
  const outputDirectory = join(root, "export");
  const result = await runTailExport({ snapshotDirectory: join(root, "run"), outputDirectory, eventSlugs: ["game"], gameKey: "game:123", timeoutMs: 10_000 });
  expect(result).toMatchObject({ outputDirectory, strictReadyTokens: 0 });
  const quality = JSON.parse(await readFile(join(outputDirectory, "quality.json"), "utf8"));
  expect(quality.seconds).toBe(600);
  expect(result.priceReadyTokens).toBe(quality.tokens.filter((q: { observedWindowComplete: boolean; snapshotAuditPassed: boolean; validSeconds: number }) => q.observedWindowComplete && q.snapshotAuditPassed && q.validSeconds > 0).length);
}, 15_000);

test("cancellation before starting never launches an export", async () => {
  const abort = new AbortController(); abort.abort(new Error("stopped"));
  await expect(runTailExport({ snapshotDirectory: "/missing", outputDirectory: "/not-created", eventSlugs: ["game"], gameKey: "game:123", timeoutMs: 1000 }, abort.signal)).rejects.toThrow("stopped");
});

test("child failure cannot be reported as a completed archive", async () => {
  const root = await writeFixture(fixtureRecords().slice(0, -1)); roots.push(root);
  await expect(runTailExport({ snapshotDirectory: join(root, "run"), outputDirectory: join(root, "failed"), eventSlugs: ["game"], gameKey: "game:123", timeoutMs: 10_000 })).rejects.toThrow("TAIL_EXPORT_CHILD_FAILED");
}, 15_000);

test("continuous exports flag bounded wall-clock backsteps without discarding an entire input", async () => {
  const records = fixtureRecords(); records[9]!.receivedAtMs = 11_099; records[9]!.receivedAt = new Date(11_099).toISOString();
  const root = await writeFixture(records); roots.push(root); const outputDirectory = join(root, "clock");
  await runTailExport({ snapshotDirectory: join(root, "run"), outputDirectory, eventSlugs: ["game"], gameKey: "game:123", timeoutMs: 10_000 });
  const quality = JSON.parse(await readFile(join(outputDirectory, "quality.json"), "utf8"));
  expect(quality.clockPolicy).toBe("flag-backsteps"); expect(quality.clockIssues).toHaveLength(1);
  expect(quality.tokens.every((token: { readyForReplay: boolean }) => !token.readyForReplay)).toBe(true);
}, 15_000);
