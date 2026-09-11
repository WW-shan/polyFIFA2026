import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import { downloadResearchDataset, fetchMarketTrades, type ResearchRequestRecord } from "../../src/research/download.js";
import { normalizeResearchEvent } from "../../src/research/history.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const rawEvent = {
  id: "1", slug: "atp-a-b-2026-09-11", title: "A vs B", gameId: 123, startTime: "2026-09-11T10:00:00Z",
  finishedTimestamp: "2026-09-11T12:00:00Z", closed: true,
  markets: [{ id: "m1", slug: "a-b", conditionId: "condition", question: "A vs B", sportsMarketType: "moneyline",
    outcomes: ["A", "B"], clobTokenIds: ["100", "200"], closed: true, umaResolutionStatus: "resolved", outcomePrices: [1, 0] }]
};
const market = normalizeResearchEvent(rawEvent, "tennis")!.markets[0]!;
const row = (seconds: number, extra: Record<string, unknown> = {}) => ({
  asset: "100", conditionId: "condition", timestamp: seconds, side: "SELL", price: .69, size: 3,
  transactionHash: `tx-${seconds}`, proxyWallet: "public", ...extra
});

describe("bounded public trade downloads", () => {
  test("requests a fixed time window and exhausts pages, retaining both outcomes and raw responses", async () => {
    const urls: URL[] = [];
    const records: ResearchRequestRecord[] = [];
    const pages = [[row(19), row(18, { asset: "200", side: "BUY" })], [row(12)]];
    const result = await fetchMarketTrades(market, 10_000, 20_000, {
      request: async url => { urls.push(new URL(url)); return pages[urls.length - 1]; },
      onRequest: record => { records.push(record); }
    }, { pageSize: 2, maxPages: 3 });
    expect(result.coverage).toMatchObject({ status: "complete", reason: "api-window-exhausted", pages: 2, rawRows: 3, fromMs: 10_000, toMs: 20_000 });
    expect(result.trades.map(t => t.timestampMs)).toEqual([12_000, 18_000, 19_000]);
    expect(result.trades[1]?.tokenId).toBe("200");
    expect(Object.fromEntries(urls[0]!.searchParams)).toMatchObject({ market: "condition", takerOnly: "true", start: "10", end: "20", offset: "0", limit: "2" });
    expect(urls[1]?.searchParams.get("offset")).toBe("2");
    expect(records[0]?.response).toBe(pages[0]);
    expect(records[0]?.startedAt).toBeTruthy();
    expect(records[0]?.endedAt).toBeTruthy();
  });
  test("a full last page is incomplete, not a successful no-trade window", async () => {
    const result = await fetchMarketTrades(market, 10_000, 20_000, { request: async () => [row(19), row(18)] }, { pageSize: 2, maxPages: 1 });
    expect(result.coverage.status).toBe("incomplete");
    expect(result.coverage.reason).toBe("page-limit");
  });
  test("stalled pages cannot inflate volume", async () => {
    let requests = 0;
    const result = await fetchMarketTrades(market, 10_000, 20_000, { request: async () => { requests++; return [row(19), row(18)]; } }, { pageSize: 2, maxPages: 9 });
    expect(requests).toBe(2);
    expect(result.trades).toHaveLength(2);
    expect(result.coverage).toMatchObject({ status: "incomplete", reason: "pagination-stalled" });
  });
  test("deduplicates identical rows with a count while preserving different trades", async () => {
    const result = await fetchMarketTrades(market, 10_000, 20_000, { request: async () => [row(19), row(19), row(19, { size: 4 })] });
    expect(result.trades.map(t => t.size)).toEqual([3, 4]);
    expect(result.coverage.duplicateRows).toBe(1);
  });
  test.each([
    [row(19), row(21)], [row(19), row(18, { conditionId: "wrong" })], [row(18), row(19)]
  ])("flags out-of-window, mismatched and nonmonotonic responses", async (...rows) => {
    const result = await fetchMarketTrades(market, 10_000, 20_000, { request: async () => rows });
    expect(result.coverage.status).toBe("incomplete");
  });
  test("records a request failure and does not mark the remaining interval complete", async () => {
    const records: ResearchRequestRecord[] = [];
    const result = await fetchMarketTrades(market, 10_000, 20_000, {
      request: async () => { throw new Error("network unavailable"); }, onRequest: record => { records.push(record); }
    });
    expect(result.coverage.status).toBe("error");
    expect(records[0]?.error).toContain("network unavailable");
  });
  test("empty exhausted window is distinct from a failed response", async () => {
    const result = await fetchMarketTrades(market, 10_000, 20_000, { request: async () => [] });
    expect(result.trades).toEqual([]);
    expect(result.coverage).toMatchObject({ status: "complete", oldestMs: null, newestMs: null, rawRows: 0 });
  });
  test("recording failures are fatal rather than converted to ordinary coverage errors", async () => {
    await expect(fetchMarketTrades(market, 10_000, 20_000, {
      request: async () => [], onRequest: () => { throw new Error("disk full"); }
    })).rejects.toThrow("RESEARCH_RECORDING_FAILED");
  });
  test.each([
    { status: 429, statusText: "Too Many Requests", body: '{"retry":"later"}' },
    { status: 200, statusText: "OK", body: '{"incomplete":' }
  ])("retains exact HTTP response text on status or JSON failure: $status", async response => {
    const records: ResearchRequestRecord[] = [];
    const result = await fetchMarketTrades(market, 10_000, 20_000, {
      request: async () => { throw new Error("JSON-only route must not be used when raw transport is supplied"); },
      requestRaw: async () => ({ ...response, headers: { "content-type": "application/json" } }),
      onRequest: record => { records.push(record); }
    });
    expect(result.coverage.status).toBe("error");
    expect(records[0]?.httpResponse).toEqual({ ...response, headers: { "content-type": "application/json" } });
    expect(records[0]?.error).toBeTruthy();
  });
  test.each([{ pageSize: 0 }, { pageSize: 10_001 }, { maxPages: 0 }, { maxPages: 1.5 }])("rejects invalid pagination before requesting %j", async options => {
    let called = false;
    await expect(fetchMarketTrades(market, 10_000, 20_000, { request: async () => { called = true; return []; } }, options)).rejects.toThrow("RESEARCH_OPTIONS_INVALID");
    expect(called).toBe(false);
  });
});

describe("reproducible research cache", () => {
  async function directory() { const root = await mkdtemp(join(tmpdir(), "poly-research-test-")); roots.push(root); return join(root, "run"); }
  test.each(["explicit-direct", "environment-no-proxy"])("default transport preserves %s routing", async mode => {
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) vi.stubEnv(name, "http://127.0.0.1:9");
    for (const name of ["NO_PROXY", "no_proxy"]) vi.stubEnv(name, mode === "environment-no-proxy" ? "127.0.0.1" : "");
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url?.startsWith("/events") ? [rawEvent] : []));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const outputDirectory = await directory();
      await expect(downloadResearchDataset({ outputDirectory, sport: "tennis", gammaBaseUrl: baseUrl, dataBaseUrl: baseUrl,
        timeoutMs: 1000, ...(mode === "explicit-direct" ? { proxyUrl: "" } : {}) })).resolves.toMatchObject({ eventCount: 1, marketCount: 1, incompleteMarkets: 0 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  test("saves raw requests and a versioned dataset, and keeps unknown finish samples unless explicitly filtered", async () => {
    const outputDirectory = await directory();
    const unknown = { ...rawEvent, id: "2", slug: "itf-a-b-2026-09-11", finishedTimestamp: undefined };
    const result = await downloadResearchDataset({ outputDirectory, sport: "tennis", maxEvents: 3 }, {
      request: async url => new URL(url).pathname === "/events" ? [rawEvent, unknown] : [],
      now: () => Date.parse("2026-09-11T14:00:00Z")
    });
    const dataset = JSON.parse(await readFile(result.datasetPath, "utf8"));
    expect(dataset).toMatchObject({ schemaVersion: 1, kind: "public-trade-history", selection: { sport: "tennis", tagId: "864", requireFinish: false } });
    expect(dataset.events).toHaveLength(2);
    expect(dataset.events[1].finishMs).toBeNull();
    expect(dataset.events[0].markets[0].coverage.status).toBe("complete");
    expect((await readdir(join(outputDirectory, "raw"))).length).toBeGreaterThanOrEqual(3);
    let called = false;
    await expect(downloadResearchDataset({ outputDirectory, sport: "tennis" }, { request: async () => { called = true; return []; } })).rejects.toThrow();
    expect(called).toBe(false);
  });
  test("filters only the explicit research universe and counts missing-finish and non-match exclusions", async () => {
    const outputDirectory = await directory();
    const result = await downloadResearchDataset({ outputDirectory, sport: "tennis", maxEvents: 3, requireFinish: true }, {
      request: async url => new URL(url).pathname === "/events" ? [
        { ...rawEvent, id: "news", slug: "tennis-news", gameId: undefined, startTime: undefined },
        { ...rawEvent, id: "unknown", slug: "itf-unknown", finishedTimestamp: undefined }, rawEvent
      ] : []
    });
    const dataset = JSON.parse(await readFile(result.datasetPath, "utf8"));
    expect(dataset.events).toHaveLength(1);
    expect(dataset.selection).toMatchObject({ skippedNonMatches: 1, skippedMissingFinish: 1, catalogTruncated: false });
  });
  test("checks options before creating files or starting network requests", async () => {
    const outputDirectory = await directory();
    await expect(downloadResearchDataset({ outputDirectory, sport: "tennis", maxEvents: -1 }, { request: async () => [] })).rejects.toThrow("RESEARCH_OPTIONS_INVALID");
    await expect(readdir(outputDirectory)).rejects.toThrow();
  });
  test("never publishes a successful manifest when the recording sink fails", async () => {
    const outputDirectory = await directory(); let recorded = 0;
    await expect(downloadResearchDataset({ outputDirectory, sport: "tennis" }, {
      request: async url => new URL(url).pathname === "/events" ? [rawEvent] : [],
      onRequest: () => { if (++recorded === 2) throw new Error("recording sink unavailable"); }
    })).rejects.toThrow("RESEARCH_RECORDING_FAILED");
    await expect(readFile(join(outputDirectory, "manifest.json"), "utf8")).rejects.toThrow();
    expect(JSON.parse(await readFile(join(outputDirectory, "failure.json"), "utf8"))).toMatchObject({ status: "failed" });
  });
});
