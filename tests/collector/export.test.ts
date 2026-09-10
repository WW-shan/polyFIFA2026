import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { exportRun } from "../../src/collector/export.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function journalLine(sequence: number, source: string, kind: string, data: unknown, connectionId?: string): string {
  const record: Record<string, unknown> = {
    schemaVersion: 1,
    runId: "run",
    sequence,
    receivedAt: new Date(sequence * 1_000).toISOString(),
    receivedAtMs: sequence * 1_000,
    monotonicNs: String(sequence),
    source,
    kind,
    data
  };
  if (connectionId) record.connectionId = connectionId;
  return JSON.stringify(record);
}

describe("collector CSV export", () => {
  test("writes escaped CSV files and a quality summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "poly-fifa-collector-export-"));
    temporaryDirectories.push(root);
    const run = join(root, "run");
    const output = join(root, "export");
    await (await import("node:fs/promises")).mkdir(run, { recursive: true });
    await writeFile(join(run, "2026-09-10-000000.ndjson"), [
      journalLine(1, "gamma", "event_metadata", { normalized: { eventId: "e1", eventSlug: "slug,with,comma", markets: [{ marketId: "m1", tokenIds: ["token"], outcomes: ["Yes"] }] } }),
      journalLine(2, "clob", "ws_message", JSON.stringify({ event_type: "book", asset_id: "token", bids: [{ price: "0.5", size: "1" }], asks: [] }), "clob-0-e1"),
      journalLine(3, "sports", "ws_message", JSON.stringify({ eventSlug: "slug,with,comma", note: "quote\"value" })),
      journalLine(4, "clob", "ws_message", JSON.stringify({ event_type: "last_trade_price", asset_id: "token", price: "0.5", size: "1" }), "clob-0-e1")
    ].join("\n") + "\n");

    const result = await exportRun({ runDirectory: run, outputDirectory: output });

    expect(result.files).toEqual(expect.arrayContaining(["quotes.csv", "trades.csv", "sports.csv", "markets.csv", "quality.json"]));
    expect(await readFile(join(output, "markets.csv"), "utf8")).toContain('"slug,with,comma"');
    expect(await readFile(join(output, "sports.csv"), "utf8")).toContain('"{""eventSlug"":""slug,with,comma""');
    expect(JSON.parse(await readFile(join(output, "quality.json"), "utf8"))).toMatchObject({ malformedLines: 0 });
  });

  test("refuses to overwrite an existing export", async () => {
    const root = await mkdtemp(join(tmpdir(), "poly-fifa-collector-export-"));
    temporaryDirectories.push(root);
    const run = join(root, "run");
    const output = join(root, "export");
    await (await import("node:fs/promises")).mkdir(run, { recursive: true });
    await writeFile(join(run, "2026-09-10-000000.ndjson"), `${journalLine(1, "collector", "session_start", {})}\n`);
    await expect(exportRun({ runDirectory: run, outputDirectory: output })).resolves.toBeDefined();
    await expect(exportRun({ runDirectory: run, outputDirectory: output })).rejects.toThrow("EXPORT_EXISTS");
  });
});
