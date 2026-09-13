import { File } from "node:buffer";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { renderTailViewer as render } from "../../src/collector/tail-view.js";
import type { TailMarket, TailPreviewRow, TailSecond, TailSummary, TailViewerInput } from "../../src/collector/tail-types.js";

function market(tokenId: string, marketId = "winner"): TailMarket {
  return { eventId: "event", eventSlug: "game", gameId: "123", marketId, marketSlug: marketId,
    conditionId: marketId + "-condition", tokenId, outcome: tokenId, question: marketId === "winner" ? "谁获胜？" : "总进球大于 2.5？",
    marketType: marketId === "winner" ? "moneyline" : "totals", closed: false, acceptingOrders: true, raw: {} };
}

function row(overrides: Partial<TailPreviewRow> = {}): TailPreviewRow {
  return { windowKey: "game", eventSlug: "game", gameId: "123", marketId: "winner", conditionId: "winner-condition",
    question: "谁获胜？", marketType: "moneyline", tokenId: "A", outcome: "A", secondIndex: 0,
    startAtMs: 10_000, endAtMs: 11_000, secondsBeforeFinish: 300, status: "observed", wholeSecondValid: true,
    connectionId: "clob", bookObservedAtMs: 10_000, bookSourceAtMs: 9990, bookAgeMs: 0, feedAgeMs: 0, bookHash: "hash",
    bestBid: ".95", bestAsk: ".97", minBestBid: .95, maxBestBid: .95, minBestAsk: .97, maxBestAsk: .97,
    bookUpdates: 1, tradeCount: 0, tradeShares: 0, contextSource: "sports-ws", contextObservedAtMs: 10_000,
    contextSourceAtMs: 9900, contextAgeMs: 0, contextStatus: "present", score: "0-0", period: "2H", clock: "89:59",
    stateChangeCount: 0, reasons: [], depthOffset: 0, depthBytes: 1, ...overrides };
}

function quality(tokenId: string, ready: boolean, marketId = "winner"): TailSummary["tokens"][number] {
  return { windowKey: "game", tokenId, marketId, outcome: tokenId, marketType: "moneyline", expectedSeconds: 300,
    validSeconds: ready ? 300 : 4, closedSeconds: 0, partialSeconds: 0, missingSeconds: ready ? 0 : 295,
    staleSeconds: ready ? 0 : 1, contextSeconds: 300, snapshotMatches: 1, snapshotMismatches: ready ? 0 : 1,
    snapshotNotComparable: 0, observedWindowComplete: ready, snapshotAuditPassed: ready, readyForReplay: ready,
    seedSnapshotMatches: 0, seedSnapshotMismatches: 0, seedSnapshotNotComparable: 0,
    reasons: ready ? [] : ["snapshot_mismatch", "missing_seconds"] };
}

function fixture(): TailViewerInput {
  const markets = [market("A"), market("B"), market("Over", "total")];
  return {
    summary: { schemaVersion: 1, basis: "received-order-book-tail", runId: "tail-local", firstReceivedAtMs: 0,
      lastReceivedAtMs: 310_000, windowSeconds: 300, records: 20, seconds: 9, changes: 2, stateChanges: 1, audits: 2,
      windows: [
        { key: "game", eventIds: ["event"], eventSlugs: ["game"], title: "甲队 vs 乙队", gameId: "123",
          startAtMs: 10_000, endAtMs: 310_000, finishSources: ["gamma.finishedTimestamp"], finishConflict: false, markets },
        { key: "unknown", eventIds: ["other"], eventSlugs: ["other"], title: "结束时间待确认的比赛", gameId: "456",
          startAtMs: null, endAtMs: null, finishSources: [], finishConflict: false, markets: [market("Unknown")] }
      ], tokens: [quality("A", false), quality("B", false), quality("Over", false, "total")], warnings: ["unknown_finish: other"],
      journalQuality: { sequenceGaps: [], incompleteFinalLines: 0, malformedLines: 0, invalidBookUpdates: 0,
        connectionInvalidations: 0, unknownFrames: 0, outOfOrderMessages: 0 } },
    rows: [row(), row({ secondIndex: 1, startAtMs: 11_000, endAtMs: 12_000, secondsBeforeFinish: 299,
      bestBid: ".94", minBestBid: .60, maxBestBid: .95, bookUpdates: 2, score: "1-0", stateChangeCount: 1 }),
    row({ secondIndex: 2, startAtMs: 12_000, endAtMs: 13_000, status: "missing", wholeSecondValid: false,
      bestBid: null, bestAsk: null, minBestBid: null, maxBestBid: null, minBestAsk: null, maxBestAsk: null, reasons: ["missing_book"] }),
    row({ secondIndex: 3, startAtMs: 13_000, endAtMs: 14_000 }),
    row({ secondIndex: 4, startAtMs: 14_000, endAtMs: 15_000, status: "feed_stale", wholeSecondValid: false, reasons: ["feed_stale"] }),
    row({ secondIndex: 5, startAtMs: 15_000, endAtMs: 16_000, status: "carried", bookUpdates: 0 }),
    row({ secondIndex: 7, startAtMs: 17_000, endAtMs: 18_000 }),
    row({ tokenId: "B", outcome: "B", bestBid: ".03", bestAsk: ".05", minBestBid: .03, maxBestBid: .03, minBestAsk: .05, maxBestAsk: .05 }),
    row({ tokenId: "Over", outcome: "Over", marketId: "total", conditionId: "total-condition" })],
    stateChanges: [{ windowKey: "game", eventSlug: "game", gameId: "123", source: "sports-ws", kind: "score_increase",
      observedAtMs: 11_900, sourceAtMs: 11_400, sequence: 10, frameIndex: 0, before: "0-0", after: "1-0", actualEventTimeKnown: false }],
    depthFile: "seconds.ndjson", depthFileBytes: 0
  };
}

function singleTokenFixture(overrides: Partial<TailSummary["tokens"][number]> = {}, second: Partial<TailPreviewRow> = {}): TailViewerInput {
  const input = fixture();
  input.summary.windows = input.summary.windows.slice(0, 1);
  input.summary.windows[0]!.markets = [market("A")];
  input.summary.tokens = [{ ...quality("A", true), snapshotMatches: 119, ...overrides }];
  input.rows = Array.from({ length: 300 }, (_, index) => row({ secondIndex: index, startAtMs: 10_000 + index * 1000,
    endAtMs: 11_000 + index * 1000, secondsBeforeFinish: 300 - index, ...second }));
  input.summary.seconds = input.rows.length;
  return input;
}

// A small DOM boundary lets the actual inline script run without installing a browser or DOM dependency.
class Element {
  children: Element[] = [];
  attributes: Record<string, string> = {};
  value = "";
  disabled = false;
  files: File[] = [];
  namespaceURI = "svg";
  private ownText = "";
  private listeners = new Map<string, Array<() => unknown>>();
  constructor(readonly tagName: string) {}
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.ownText = String(value ?? ""); this.children = []; }
  set innerHTML(_value: string) { throw new Error("HTML insertion is forbidden"); }
  setAttribute(name: string, value: unknown): void { this.attributes[name] = String(value); }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  append(...nodes: Element[]): void {
    for (const node of nodes) this.children.push(...(node.tagName === "#fragment" ? node.children : [node]));
  }
  replaceChildren(...nodes: Element[]): void { this.ownText = ""; this.children = []; this.append(...nodes); }
  addEventListener(name: string, handler: () => unknown): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(handler);
    this.listeners.set(name, listeners);
  }
  async fire(name: string): Promise<void> { for (const handler of this.listeners.get(name) ?? []) await handler(); }
  find(predicate: (element: Element) => boolean): Element[] {
    return this.children.flatMap(child => [...(predicate(child) ? [child] : []), ...child.find(predicate)]);
  }
}

async function openViewer(input = fixture(), globals: Record<string, unknown> = {}) {
  const html = await render(input);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const dataScript = scripts.find(match => /type="application\/json"/.test(match[1]!));
  expect(dataScript, "embedded preview JSON").toBeDefined();
  const nodes = new Map<string, Element>();
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    nodes.set(match[2]!, new Element(match[1]!));
  }
  const dataId = /id="([^"]+)"/.exec(dataScript![1]!)![1]!;
  nodes.get(dataId)!.textContent = dataScript![2]!;
  const document = { getElementById: (id: string) => nodes.get(id) ?? null,
    createElement: (tag: string) => new Element(tag), createElementNS: (_ns: string, tag: string) => new Element(tag),
    createDocumentFragment: () => new Element("#fragment") };
  const context: Record<string, unknown> = { document, URL, TextDecoder, AbortController, ...globals };
  const ready = Promise.all(scripts.filter(match => match !== dataScript)
    .map(script => runInNewContext(script[2]!, context, { timeout: 1000 })));
  const get = (id: string): Element => { expect(nodes.has(id), id).toBe(true); return nodes.get(id)!; };
  return { html, get, context, ready, payload: JSON.parse(dataScript![2]!),
    async choose(id: string, value: string) { get(id).value = value; await get(id).fire("change"); },
    async selectSecond(index: number) {
      const tr = get("seconds-body").children.find(node => node.getAttribute("data-second-index") === String(index));
      expect(tr, "selectable second " + index).toBeDefined();
      await tr!.find(node => node.tagName === "button")[0]!.fire("click");
    },
    async selectFile(file: File) { get("depth-file").files = [file]; await get("depth-file").fire("change"); }
  };
}

class TrackedFile extends File {
  ranges: Array<[number | undefined, number | undefined]> = [];
  override slice(start?: number, end?: number, contentType?: string): ReturnType<File["slice"]> {
    this.ranges.push([start, end]);
    return super.slice(start, end, contentType);
  }
  override async text(): Promise<string> { throw new Error("must not read the whole depth file"); }
  override async arrayBuffer(): Promise<ArrayBuffer> { throw new Error("must not buffer the whole depth file"); }
}

function depthFile(input: TailViewerInput, change: (book: TailSecond, index: number) => unknown = book => book): TrackedFile {
  const prefix = JSON.stringify({ note: "未选择的 UTF-8 字节，不能按字符偏移" }) + "\n";
  const parts = [prefix];
  let offset = Buffer.byteLength(prefix);
  input.rows.forEach((preview, index) => {
    const { depthOffset: _offset, depthBytes: _bytes, ...second } = preview;
    const full: TailSecond = { ...second,
      bids: preview.status === "missing" ? null : [{ price: ".940000000000000001", size: "12345678901234567890.123400000" }],
      asks: preview.status === "missing" ? null : [{ price: ".970000000000000002", size: "2.000000000000000001" }] };
    const line = JSON.stringify(change(full, index)) + "\n";
    preview.depthOffset = offset;
    preview.depthBytes = Buffer.byteLength(line);
    offset += preview.depthBytes;
    parts.push(line);
  });
  input.depthFileBytes = offset;
  return new TrackedFile(parts, "seconds.ndjson");
}

function controlledFetch() {
  const requests: Array<{ url: string; options: RequestInit; resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
  const fetcher: typeof globalThis.fetch = (url, options = {}) => new Promise<Response>((resolve, reject) => {
    requests.push({ url: String(url), options, resolve, reject });
  });
  return { requests, fetch: fetcher };
}

function rangeResponse(file: File, second: TailPreviewRow): Response {
  const slice = File.prototype.slice.call(file, second.depthOffset, second.depthOffset + second.depthBytes);
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    controller.enqueue(new Uint8Array(await slice.arrayBuffer()));
    controller.close();
  } }, { highWaterMark: 0 });
  return new Response(body, {
    status: 206, headers: { "Content-Range": `bytes ${second.depthOffset}-${second.depthOffset + second.depthBytes - 1}/${file.size}`,
      "Content-Length": String(second.depthBytes) }
  });
}

describe("offline human tail viewer", () => {
  test("embeds hostile metadata as inert JSON and inserts data only as text", async () => {
    const input = fixture();
    const hostile = '</script><script>globalThis.compromised=true</script><img src=x onerror=alert(1)>\u2028\u2029&"';
    input.summary.windows[0]!.title = hostile;
    input.summary.windows[0]!.markets[0]!.question = hostile;
    input.summary.windows[0]!.markets[0]!.outcome = hostile;
    input.summary.warnings.push(hostile);
    input.rows[0]!.score = { text: hostile };
    input.rows[0]!.reasons = [hostile];
    input.stateChanges[0]!.after = hostile;
    input.depthFile = hostile;
    const view = await openViewer(input);
    expect(view.html.match(/<script\b/gi)).toHaveLength(2);
    expect(view.html).not.toContain(hostile);
    expect(view.html).toContain("\\u003c/script>");
    expect(view.html).toContain("\\u2028\\u2029");
    expect(view.payload.summary.windows[0].title).toBe(hostile);
    expect(view.get("match-select").textContent).toContain(hostile);
    expect(view.get("seconds-body").textContent).toContain(hostile);
    expect(view.get("state-changes").textContent).toContain(hostile);
    expect(view.context.compromised).toBeUndefined();
    expect(view.html).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|document\.write\s*\(/);
  });

  test("is self-contained and labels receipt evidence, local files and goal-time uncertainty in Chinese", async () => {
    const html = await render(fixture());
    for (const label of ["比赛", "市场", "结果", "接收时间", "订单簿", "进球时间", "不会上传", "300", "缺失原因", "本地服务器", "自动读取", "离线"]) expect(html).toContain(label);
    expect(html).not.toMatch(/https?:\/\/|<script[^>]+src\s*=|<link\b|XMLHttpRequest|WebSocket|sendBeacon|@import/i);
    expect(html.match(/<style>([\s\S]*?)<\/style>/)![1]).not.toMatch(/url\s*\(/i);
    expect(html).toContain("connect-src 'self'");
    for (const directive of ["default-src 'none'", "base-uri 'none'", "img-src 'none'", "form-action 'none'"]) expect(html).toContain(directive);
    expect(html).not.toMatch(/盈利|收益率|利润|profit/i);
  });

  test("projects lightweight data without serializing extra full books or raw metadata", async () => {
    const input = fixture();
    const secretBook = [{ price: ".95", size: "FULL_DEPTH_MUST_STAY_OUT_" + "9".repeat(100_000) }];
    Object.assign(input.rows[0]!, { bids: secretBook, asks: secretBook, extra: { bids: secretBook } });
    input.summary.windows[0]!.markets[0]!.raw = { bids: secretBook, asks: secretBook };
    const view = await openViewer(input);
    expect(view.html).not.toContain("FULL_DEPTH_MUST_STAY_OUT");
    expect(view.payload.rows[0]).not.toHaveProperty("bids");
    expect(view.payload.rows[0]).not.toHaveProperty("asks");
    expect(view.payload.summary.windows[0].markets[0]).not.toHaveProperty("raw");
    expect(view.payload.rows[0]).toMatchObject({ depthOffset: 0, depthBytes: 1 });
    expect(view.html.length).toBeLessThan(70_000);
  });

  test("filters match, market and outcome and reports quality for the selected token", async () => {
    const input = fixture();
    input.summary.tokens[1] = quality("B", true);
    const view = await openViewer(input);
    await view.choose("outcome-select", "A");
    expect(view.get("seconds-body").children).toHaveLength(7);
    expect(view.get("quality").textContent).toContain("不可回放");
    expect(view.get("quality").textContent).toContain("295");
    expect(view.get("seconds-body").textContent).toContain("缺失");
    expect(view.get("seconds-body").textContent).toContain("数据流过期");
    expect(view.get("seconds-body").textContent).toContain("沿用");
    expect(view.get("seconds-body").textContent).not.toContain("稳定");
    await view.choose("outcome-select", "B");
    expect(view.get("seconds-body").children).toHaveLength(1);
    expect(view.get("seconds-body").textContent).toContain(".03");
    expect(view.get("quality").textContent).toContain("质量通过");
    await view.choose("outcome-select", "A");
    expect(view.get("quality").textContent).toContain("不可回放");
    await view.choose("market-select", "total");
    expect(view.get("outcome-select").value).toBe("Over");
    expect(view.get("seconds-body").children).toHaveLength(1);
    await view.choose("match-select", "unknown");
    expect(view.get("seconds-body").children).toHaveLength(0);
    expect(view.get("quality").textContent).toContain("结束时间未知");
    expect(view.get("quality").textContent).toContain("不可回放");
    expect(view.get("warnings").textContent).toContain("结束时间待确认的比赛");
  });

  test.each(["stale", "missing", "disconnected"] as const)("keeps complete audited prices replayable when score context is %s", async contextStatus => {
    const input = singleTokenFixture({ contextSeconds: 273, readyForReplay: false, reasons: ["context-" + contextStatus] });
    for (const second of input.rows.slice(273)) {
      Object.assign(second, { contextStatus, contextAgeMs: 31_000, reasons: ["context-" + contextStatus] });
    }
    const before = structuredClone(input);
    const view = await openViewer(input);
    expect(view.get("quality").textContent).toContain("盘口价格可回放；比分上下文不完整/过期");
    expect(view.get("quality").textContent).not.toContain("不可回放");
    expect(view.get("quality").textContent).not.toContain("质量通过");
    expect(view.get("quality").getAttribute("data-ready")).toBe("false");
    expect(view.get("quality").textContent).toContain("300/300");
    expect(view.get("quality").textContent).toContain("273");
    expect(view.get("quality").textContent).toContain("一致 119");
    expect(view.payload.summary.tokens[0]).toMatchObject({ validSeconds: 300, contextSeconds: 273, snapshotMatches: 119,
      observedWindowComplete: true, snapshotAuditPassed: true, readyForReplay: false, reasons: ["context-" + contextStatus] });
    expect(input).toEqual(before);
    const path = view.get("price-chart").find(node => node.getAttribute("data-series") === "bid")[0]!;
    expect(path.getAttribute("d")!.match(/L/g)).toHaveLength(299);
  });

  test("labels an all-closed window as non-trading time without inventing missing prices", async () => {
    const input = singleTokenFixture({ validSeconds: 0, closedSeconds: 300, snapshotMatches: 0, readyForReplay: false,
      reasons: ["no-active-book-seconds"] }, { status: "closed", wholeSecondValid: false, bestBid: null, bestAsk: null,
      minBestBid: null, maxBestBid: null, minBestAsk: null, maxBestAsk: null });
    Object.assign(input.summary.windows[0]!.markets[0]!, { closed: true, acceptingOrders: false });
    const view = await openViewer(input);
    expect(view.get("quality").textContent).toContain("已关闭／非可交易时段");
    expect(view.get("quality").textContent).not.toContain("质量通过");
    expect(view.get("quality").textContent).not.toContain("盘口价格可回放");
    expect(view.get("quality").getAttribute("data-ready")).toBe("false");
    expect(view.get("seconds-body").children).toHaveLength(300);
    expect(view.get("seconds-body").textContent).not.toMatch(/缺失|整秒不完整|证据不完整/);
    for (const id of ["match-select", "market-select", "outcome-select"]) {
      expect(view.get(id).textContent).toContain("已关闭");
      expect(view.get(id).disabled).toBe(false);
    }
    for (const side of ["bid", "ask"]) {
      const path = view.get("price-chart").find(node => node.getAttribute("data-series") === side)[0]!;
      expect(path.getAttribute("d")).toBe("");
    }
    expect(view.payload.summary.tokens[0]).toMatchObject({ validSeconds: 0, closedSeconds: 300, missingSeconds: 0,
      observedWindowComplete: true, snapshotAuditPassed: true, readyForReplay: false });
  });

  test.each([
    { status: "outside_run", message: "采集范围外", missingSeconds: 300, staleSeconds: 0 },
    { status: "missing", message: "缺失", missingSeconds: 300, staleSeconds: 0 },
    { status: "feed_stale", message: "数据流过期", missingSeconds: 0, staleSeconds: 300 }
  ] as const)("keeps $status explicit in quality, selectors and seconds", async ({ status, message, missingSeconds, staleSeconds }) => {
    const input = singleTokenFixture({ validSeconds: 0, missingSeconds, staleSeconds, observedWindowComplete: false,
      snapshotAuditPassed: false, snapshotMatches: 0, readyForReplay: false,
      reasons: [status, "snapshot-audit-not-passed", "no-active-book-seconds"] },
    { status, wholeSecondValid: false, bestBid: null, bestAsk: null, minBestBid: null, maxBestBid: null,
      minBestAsk: null, maxBestAsk: null, reasons: [status] });
    const view = await openViewer(input);
    expect(view.get("quality").textContent.split("\n")[0]).toContain(message);
    expect(view.get("quality").textContent).toContain("不可回放");
    expect(view.get("quality").getAttribute("data-ready")).toBe("false");
    for (const id of ["match-select", "market-select", "outcome-select"]) expect(view.get(id).textContent).toContain(message);
    expect(view.get("seconds-body").children[0]!.children[1]!.textContent).toBe(message);
    expect(view.get("price-chart").find(node => node.getAttribute("data-series") === "bid")[0]!.getAttribute("d")).toBe("");
  });

  test("never makes a missing-finish window price-usable even if its token flags pass", async () => {
    const input = singleTokenFixture({ reasons: ["missing-actual-finish"] });
    Object.assign(input.summary.windows[0]!, { startAtMs: null, endAtMs: null, finishSources: [] });
    input.rows = [];
    const view = await openViewer(input);
    expect(view.get("quality").textContent).toContain("结束时间未知");
    expect(view.get("quality").textContent).toContain("不可回放");
    expect(view.get("quality").textContent).toContain("缺少实际结束时间 (missing-actual-finish)");
    expect(view.get("quality").textContent).not.toContain("盘口价格可回放");
    expect(view.get("quality").getAttribute("data-ready")).toBe("false");
    for (const id of ["match-select", "market-select", "outcome-select"]) expect(view.get(id).textContent).toContain("结束时间未知");
  });

  test("keeps conflicting finish evidence distinct even if token flags pass", async () => {
    const input = singleTokenFixture({ reasons: ["conflicting-finish-labels"] });
    input.summary.windows[0]!.finishConflict = true;
    const view = await openViewer(input);
    expect(view.get("quality").textContent).toContain("结束时间来源冲突");
    expect(view.get("quality").textContent).toContain("不可回放");
    expect(view.get("quality").textContent).not.toContain("盘口价格可回放");
    expect(view.get("quality").getAttribute("data-ready")).toBe("false");
    for (const id of ["match-select", "market-select", "outcome-select"]) expect(view.get(id).textContent).toContain("结束时间来源冲突");
  });

  test("does not make complete prices usable when snapshot audits fail", async () => {
    const input = singleTokenFixture({ snapshotAuditPassed: false, snapshotMismatches: 1, readyForReplay: false,
      reasons: ["snapshot-audit-not-passed"] });
    const view = await openViewer(input);
    expect(view.get("quality").textContent.split("\n")[0]).toContain("快照校验未通过");
    expect(view.get("quality").textContent).toContain("不可回放");
    expect(view.get("quality").textContent).not.toContain("盘口价格可回放");
    expect(view.get("quality").getAttribute("data-ready")).toBe("false");
    for (const id of ["match-select", "market-select", "outcome-select"]) expect(view.get(id).textContent).toContain("快照校验未通过");
  });

  test("preserves other strict quality failures when prices and score coverage are complete", async () => {
    const input = singleTokenFixture({ readyForReplay: false, reasons: ["book-source-clock-invalid"] });
    input.summary.warnings.push("damaged-journal-lines");
    const view = await openViewer(input);
    expect(view.get("quality").textContent).toContain("盘口价格可回放");
    expect(view.get("quality").textContent).not.toMatch(/不可回放|质量通过|比分上下文不完整/);
    expect(view.get("quality").textContent).toContain("综合质量未通过");
    expect(view.get("quality").textContent).toContain("订单簿来源时钟无效 (book-source-clock-invalid)");
    expect(view.get("warnings").textContent).toContain("damaged-journal-lines");
    expect(view.get("quality").getAttribute("data-ready")).toBe("false");
    expect(view.payload.summary.tokens[0].readyForReplay).toBe(false);
  });

  test("initially prefers usable game, market and outcome while keeping every failure selectable", async () => {
    const input = fixture();
    const usable = { ...input.summary.windows[0]!, key: "usable", title: "有完整价格的比赛",
      markets: [market("Closed", "closed"), market("Missing", "prices"), market("Prices", "prices")] };
    Object.assign(usable.markets[0]!, { closed: true, acceptingOrders: false });
    // Latest closed metadata does not erase usable historical prices in this window.
    Object.assign(usable.markets[2]!, { closed: true, acceptingOrders: false });
    input.summary.windows.push(usable);
    input.summary.tokens.push(
      { ...quality("Closed", true, "closed"), windowKey: "usable", validSeconds: 0, closedSeconds: 300,
        snapshotMatches: 0, readyForReplay: false, reasons: ["no-active-book-seconds"] },
      { ...quality("Missing", false, "prices"), windowKey: "usable" },
      { ...quality("Prices", true, "prices"), windowKey: "usable", validSeconds: 299, closedSeconds: 1,
        contextSeconds: 273, readyForReplay: false, reasons: ["context-stale"] }
    );
    input.rows.push(row({ windowKey: "usable", marketId: "prices", tokenId: "Prices", outcome: "Prices" }));
    const view = await openViewer(input);
    expect(view.get("match-select").value).toBe("usable");
    expect(view.get("market-select").value).toBe("prices");
    expect(view.get("outcome-select").value).toBe("Prices");
    expect(view.get("quality").textContent).toContain("盘口价格可回放；比分上下文不完整/过期");
    expect(view.get("match-select").children.map(node => node.value)).toEqual(["game", "unknown", "usable"]);
    expect(view.get("market-select").children.map(node => node.value)).toEqual(["closed", "prices"]);
    expect(view.get("outcome-select").children.map(node => node.value)).toEqual(["Missing", "Prices"]);
    expect(view.get("market-select").children[0]!.textContent).toContain("已关闭");
    expect(view.get("outcome-select").children[0]!.textContent).toContain("不可回放");
    expect(view.get("outcome-select").children[1]!.textContent).toContain("盘口价格可回放");
    expect(view.get("outcome-select").children[1]!.textContent).toContain("已关闭");
    await view.choose("outcome-select", "Missing");
    expect(view.get("quality").textContent).toContain("不可回放");
    await view.choose("market-select", "closed");
    expect(view.get("outcome-select").value).toBe("Closed");
    expect(view.get("quality").textContent).toContain("非可交易时段");
    await view.choose("match-select", "unknown");
    expect(view.get("quality").textContent).toContain("结束时间未知");
    await view.choose("match-select", "game");
    expect(view.get("market-select").value).toBe("winner");
    expect(view.get("outcome-select").value).toBe("A");
    expect(view.get("seconds-body").children).toHaveLength(7);
  });

  test.each([
    ["context-stale", "比分上下文过期"], ["context-missing", "比分上下文缺失"], ["context-disconnected", "比分连接中断"],
    ["missing-actual-finish", "缺少实际结束时间"], ["conflicting-finish-labels", "结束时间来源冲突"],
    ["snapshot-audit-not-passed", "快照校验未通过"], ["no-active-book-seconds", "无有效盘口价格秒"],
    ["within-second-invalidation", "秒内订单簿失效"], ["pending-snapshot-audit", "快照校验待完成"],
    ["unresolved-snapshot-audit", "快照校验未完成"], ["missing-book-source-time", "缺少订单簿来源时间"],
    ["book-source-clock-invalid", "订单簿来源时钟无效"]
  ])("translates emitted reason %s and its underscore alias without hiding the code", async (code, message) => {
    const codes = [code!, code!.replaceAll("-", "_")];
    const input = singleTokenFixture({ reasons: codes, readyForReplay: false }, { reasons: codes });
    const view = await openViewer(input);
    for (const reason of codes) {
      expect(view.get("quality").textContent).toContain(message + " (" + reason + ")");
      expect(view.get("seconds-body").children[0]!.textContent).toContain(message + " (" + reason + ")");
    }
  });

  test("keeps drop/rebound extrema visible and breaks both lines across missing, stale and absent seconds", async () => {
    const view = await openViewer();
    const ranges = view.get("price-chart").find(node => node.getAttribute("data-series") === "bid-range");
    expect(ranges.some(node => node.getAttribute("data-min") === "0.6" && node.getAttribute("data-max") === "0.95")).toBe(true);
    const second = view.get("seconds-body").children[1]!;
    expect(second.textContent).toContain("0.60");
    expect(second.textContent).toContain("0.95");
    expect(second.textContent).toContain(".94");
    for (const side of ["bid", "ask"]) {
      const path = view.get("price-chart").find(node => node.tagName === "path" && node.getAttribute("data-series") === side)[0]!;
      expect(path, side + " price line").toBeDefined();
      expect(path.getAttribute("d")!.match(/M/g)).toHaveLength(4);
      expect(path.getAttribute("d")!.match(/L/g)).toHaveLength(1);
    }
    const markers = view.get("price-chart").find(node => node.getAttribute("data-state-kind") === "score_increase");
    expect(markers).toHaveLength(1);
    expect(markers[0]!.getAttribute("data-observed-at-ms")).toBe("11900");
    expect(view.get("state-changes").textContent).toContain("00:00:11.900");
    expect(view.get("state-changes").textContent).toContain("00:00:11.400");
    expect(view.get("state-changes").textContent).toContain("0-0 → 1-0");
  });

  test("partial seconds cannot connect a line even when they contain quotes", async () => {
    const input = fixture();
    Object.assign(input.rows[1]!, { wholeSecondValid: false, status: "partial", reasons: ["connection_gap"] });
    const view = await openViewer(input);
    const path = view.get("price-chart").find(node => node.tagName === "path" && node.getAttribute("data-series") === "bid")[0]!;
    expect(path.getAttribute("d")).not.toContain("L");
    expect(view.get("seconds-body").textContent).toContain("部分缺失");
  });

  test("handles a completely empty export without claiming readiness", async () => {
    const input = fixture();
    input.rows = []; input.stateChanges = []; input.summary.windows = []; input.summary.tokens = [];
    const view = await openViewer(input);
    expect(view.get("match-select").disabled).toBe(true);
    expect(view.get("seconds-body").children).toHaveLength(0);
    expect(view.get("quality").textContent).toContain("不可回放");
  });

  test("reads only the selected UTF-8 byte slice and preserves every decimal digit", async () => {
    const input = fixture();
    const file = depthFile(input);
    const view = await openViewer(input);
    expect(file.ranges).toEqual([]);
    await view.selectSecond(1);
    await view.selectFile(file);
    const selected = input.rows[1]!;
    expect(file.ranges).toEqual([[selected.depthOffset, selected.depthOffset + selected.depthBytes]]);
    expect(view.get("depth-bids").textContent).toContain(".940000000000000001");
    expect(view.get("depth-bids").textContent).toContain("12345678901234567890.123400000");
    expect(view.get("depth-asks").textContent).toContain("2.000000000000000001");
    expect(view.get("depth-status").textContent).toContain("身份已核验");
    await view.selectSecond(2);
    expect(view.get("depth-bids").children).toHaveLength(0);
    expect(view.get("depth-status").textContent).toContain("未记录完整深度");
  });

  test("rejects a file of the wrong byte size without reading it", async () => {
    const input = fixture(); depthFile(input);
    const file = new TrackedFile(["wrong"], "seconds.ndjson");
    const view = await openViewer(input);
    await view.selectFile(file);
    expect(file.ranges).toEqual([]);
    expect(view.get("file-status").textContent).toContain("文件大小不符");
    expect(view.get("depth-bids").children).toHaveLength(0);
  });

  test.each(["tokenId", "secondIndex", "startAtMs"] as const)("rejects a same-size indexed line with mismatched %s", async field => {
    const input = fixture();
    const file = depthFile(input, book => ({ ...book, [field]: field === "tokenId" ? "WRONG" : -1 }));
    const view = await openViewer(input);
    await view.selectFile(file);
    expect(file.ranges).toHaveLength(1);
    expect(view.get("depth-status").textContent).toContain("身份不匹配");
    expect(view.get("depth-bids").children).toHaveLength(0);
    expect(view.get("depth-asks").children).toHaveLength(0);
  });

  test.each([{ depthOffset: -1 }, { depthOffset: .5 }, { depthBytes: 0 }, { depthBytes: Number.MAX_SAFE_INTEGER }])(
    "rejects invalid or out-of-file byte indexes %j before slicing", async patch => {
      const input = fixture(); const file = depthFile(input); Object.assign(input.rows[0]!, patch);
      const view = await openViewer(input);
      await view.selectFile(file);
      expect(file.ranges).toEqual([]);
      expect(view.get("depth-status").textContent).toContain("字节索引无效");
    });

  test("shows malformed local JSON as an error and never leaves old depth on screen", async () => {
    const input = fixture(); const valid = depthFile(input);
    const view = await openViewer(input); await view.selectFile(valid);
    const broken = new TrackedFile(["x".repeat(valid.size)], "seconds.ndjson");
    await view.selectFile(broken);
    expect(view.get("depth-status").textContent).toContain("读取失败");
    expect(view.get("depth-bids").children).toHaveLength(0);
    expect(view.get("depth-asks").children).toHaveLength(0);
  });

  test("treats depth-file text as inert text too", async () => {
    const input = fixture();
    const malicious = '<img src=x onerror="globalThis.compromised=true">';
    const file = depthFile(input, book => ({ ...book, bids: [{ price: malicious, size: "1.000" }] }));
    const view = await openViewer(input); await view.selectFile(file);
    expect(view.get("depth-bids").textContent).toContain(malicious);
    expect(view.context.compromised).toBeUndefined();
  });

  test("ignores an older asynchronous read when the selected second changes", async () => {
    const input = fixture(); const file = depthFile(input);
    const originalSlice = file.slice.bind(file);
    let release: (() => void) | undefined;
    file.slice = (start, end, type) => {
      const blob = originalSlice(start, end, type);
      if (start === input.rows[0]!.depthOffset) {
        const originalText = blob.text.bind(blob);
        blob.text = () => new Promise<string>(resolve => { release = () => { void originalText().then(resolve); }; });
      }
      return blob;
    };
    const view = await openViewer(input);
    const pending = view.selectFile(file);
    expect(release).toBeDefined();
    await view.selectSecond(2);
    expect(view.get("depth-status").textContent).toContain("未记录完整深度");
    release!(); await pending;
    expect(view.get("depth-status").textContent).toContain("未记录完整深度");
    expect(view.get("depth-bids").children).toHaveLength(0);
  });
});

describe("loopback archive depth loading", () => {
  const page = "http://127.0.0.1:4318/exports/game%3A123/viewer.html?unused=1#second";

  test.each(["http://127.0.0.1:4318", "https://127.0.0.1:4318", "http://localhost:4318", "https://localhost:4318"])(
    "automatically reads only the selected byte range on %s", async origin => {
      const input = fixture(); const file = depthFile(input); const network = controlledFetch();
      const location = new URL(origin + "/exports/game%3A123/viewer.html?unused=1#second");
      const view = await openViewer(input, { location, fetch: network.fetch });
      expect(network.requests).toHaveLength(1);
      for (const index of [0, 1]) {
        const pending = index === 0 ? view.ready : view.selectSecond(index);
        const request = network.requests[index]!;
        const second = input.rows[index]!;
        expect(new URL(request.url, location).href).toBe(origin + "/exports/game%3A123/seconds.ndjson");
        expect(request.options).toMatchObject({ method: "GET", mode: "same-origin", credentials: "omit", redirect: "error" });
        expect(request.options.body).toBeUndefined();
        expect(new Headers(request.options.headers).get("Range")).toBe(`bytes=${second.depthOffset}-${second.depthOffset + second.depthBytes - 1}`);
        request.resolve(rangeResponse(file, second));
        await pending;
        expect(view.get("depth-status").textContent).toContain("身份已核验");
        expect(view.get("depth-bids").textContent).toContain("12345678901234567890.123400000");
        expect(view.get("depth-asks").textContent).toContain(".970000000000000002");
      }
      expect(network.requests).toHaveLength(2);
      expect(file.ranges).toEqual([]);
      expect(view.get("file-status").textContent).toContain("自动读取");
      expect(view.get("quality").getAttribute("data-ready")).toBe("false");
    });

  test.each(["status", "start", "end", "total", "missing-range", "multiple-ranges", "length", "encoding"])(
    "rejects invalid %s headers and cancels without consuming the response body", async invalid => {
      const input = fixture(); const file = depthFile(input); const network = controlledFetch();
      const second = input.rows[0]!;
      const headers = rangeResponse(file, second).headers;
      const end = second.depthOffset + second.depthBytes - 1;
      if (invalid === "start") headers.set("Content-Range", `bytes ${second.depthOffset + 1}-${end}/${file.size}`);
      if (invalid === "end") headers.set("Content-Range", `bytes ${second.depthOffset}-${end - 1}/${file.size}`);
      if (invalid === "total") headers.set("Content-Range", `bytes ${second.depthOffset}-${end}/${file.size + 1}`);
      if (invalid === "missing-range") headers.delete("Content-Range");
      if (invalid === "multiple-ranges") headers.set("Content-Range", headers.get("Content-Range") + ", bytes 0-1/2");
      if (invalid === "length") headers.set("Content-Length", String(second.depthBytes + 1));
      if (invalid === "encoding") headers.set("Content-Encoding", "gzip");
      let reads = 0, cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { reads++; controller.enqueue(new Uint8Array([32])); controller.close(); },
        cancel() { cancelled = true; }
      }, { highWaterMark: 0 });
      const view = await openViewer(input, { location: new URL(page), fetch: network.fetch });
      expect(network.requests).toHaveLength(1);
      network.requests[0]!.resolve(new Response(body, { status: invalid === "status" ? 200 : 206, headers }));
      await view.ready;
      expect(reads).toBe(0);
      expect(cancelled).toBe(true);
      expect(view.get("depth-status").textContent).toContain("读取失败");
      expect(view.get("depth-bids").children).toHaveLength(0);
    });

  test("accepts exactly bounded streaming UTF-8 even without Content-Length", async () => {
    const input = fixture(); const file = depthFile(input); const network = controlledFetch();
    const second = input.rows[0]!;
    const response = rangeResponse(file, second);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const split = Buffer.from(bytes).indexOf(Buffer.from("谁")) + 1;
    expect(split).toBeGreaterThan(0);
    const chunks = [bytes.slice(0, split), bytes.slice(split)];
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close();
    } }, { highWaterMark: 0 });
    const view = await openViewer(input, { location: new URL(page), fetch: network.fetch });
    expect(network.requests).toHaveLength(1);
    network.requests[0]!.resolve(new Response(body, { status: 206, headers: { "Content-Range": response.headers.get("Content-Range")! } }));
    await view.ready;
    expect(view.get("depth-status").textContent).toContain("身份已核验");
  });

  test.each(["short", "long"])("rejects a %s body despite matching range headers", async length => {
    const input = fixture(); const file = depthFile(input); const network = controlledFetch();
    const response = rangeResponse(file, input.rows[0]!);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Both variants would still parse as JSON; byte counts must be checked before parsing.
    const chunks = length === "short" ? [bytes.slice(0, -1)] : [bytes, new Uint8Array([32]), new Uint8Array(100_000)];
    let reads = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; const chunk = chunks.shift(); if (chunk) controller.enqueue(chunk); else controller.close(); },
      cancel() { cancelled = true; }
    }, { highWaterMark: 0 });
    const view = await openViewer(input, { location: new URL(page), fetch: network.fetch });
    expect(network.requests).toHaveLength(1);
    network.requests[0]!.resolve(new Response(body, { status: 206, headers: response.headers }));
    await view.ready;
    expect(view.get("depth-status").textContent).toContain("读取失败");
    expect(view.get("depth-bids").children).toHaveLength(0);
    if (length === "long") { expect(reads).toBe(2); expect(cancelled).toBe(true); }
  });

  test.each([{ depthOffset: -1 }, { depthOffset: .5 }, { depthBytes: 0 }, { depthBytes: Number.MAX_SAFE_INTEGER }])(
    "rejects invalid remote indexes %j before making a request", async patch => {
      const input = fixture(); depthFile(input); Object.assign(input.rows[0]!, patch);
      const network = controlledFetch();
      const view = await openViewer(input, { location: new URL(page), fetch: network.fetch });
      await view.ready;
      expect(network.requests).toHaveLength(0);
      expect(view.get("depth-status").textContent).toContain("字节索引无效");
    });

  test("bounds automatic reads to 16 MiB per second and leaves the file picker available", async () => {
    const input = fixture(); input.rows[0]!.depthBytes = 16 * 1024 * 1024 + 1; input.depthFileBytes = input.rows[0]!.depthBytes;
    const network = controlledFetch();
    const view = await openViewer(input, { location: new URL(page), fetch: network.fetch });
    await view.ready;
    expect(network.requests).toHaveLength(0);
    expect(view.get("depth-status").textContent).toContain("过大");
    expect(view.get("depth-status").textContent).toContain("本地文件");
    expect(view.get("depth-file").disabled).toBe(false);
  });

  test.each(["tokenId", "secondIndex", "startAtMs", "windowKey", "marketId", "levels"] as const)(
    "applies the existing identity/time/level validation to remote %s", async field => {
      const input = fixture();
      const file = depthFile(input, book => field === "levels" ? { ...book, bids: [{ price: .94, size: 1 }] }
        : { ...book, [field]: field === "secondIndex" || field === "startAtMs" ? -1 : "WRONG" });
      const network = controlledFetch();
      const view = await openViewer(input, { location: new URL(page), fetch: network.fetch });
      expect(network.requests).toHaveLength(1);
      network.requests[0]!.resolve(rangeResponse(file, input.rows[0]!));
      await view.ready;
      expect(view.get("depth-status").textContent).toContain(field === "levels" ? "完整深度结构无效" : "身份不匹配");
      expect(view.get("depth-bids").children).toHaveLength(0);
      expect(view.get("depth-asks").children).toHaveLength(0);
    });

  test.each(["file:///exports/game/viewer.html", "file://localhost/exports/game/viewer.html", "https://example.com/viewer.html",
    "http://127.0.0.2/viewer.html", "http://localhost.example.com/viewer.html", "http://example.localhost/viewer.html",
    "http://127.0.0.1.example.com/viewer.html", "http://[::1]/viewer.html", "ftp://127.0.0.1/viewer.html", "blob:http://localhost/id"])(
    "makes no automatic requests from %s and still reads selected local files", async href => {
      const input = fixture(); const file = depthFile(input); const network = controlledFetch();
      const view = await openViewer(input, { location: new URL(href), fetch: network.fetch });
      await view.ready; await view.selectSecond(1);
      expect(network.requests).toHaveLength(0);
      expect(view.get("depth-status").textContent).toContain("请选择");
      await view.selectFile(file);
      expect(view.get("depth-status").textContent).toContain("身份已核验");
      expect(file.ranges).toEqual([[input.rows[1]!.depthOffset, input.rows[1]!.depthOffset + input.rows[1]!.depthBytes]]);
      expect(network.requests).toHaveLength(0);
    });

  test.each(["../seconds.ndjson", "..\\seconds.ndjson", ".", "..", "a/seconds.ndjson", "a\\seconds.ndjson",
    "https://example.com/seconds.ndjson", "//example.com/seconds.ndjson", "seconds.ndjson?x=1", "seconds.ndjson#hash",
    "%2e%2e%2fseconds.ndjson", "%252e%252e%252fseconds.ndjson", "seconds\n.ndjson", "seconds..ndjson",
    '</script><script>globalThis.compromised=true</script>', null])("does not request unsafe metadata basename %j", async depthFileName => {
    const input = fixture(); depthFile(input); Object.assign(input, { depthFile: depthFileName });
    const network = controlledFetch();
    const view = await openViewer(input, { location: new URL(page), fetch: network.fetch });
    await view.ready; await view.selectSecond(1);
    expect(network.requests).toHaveLength(0);
    expect(view.get("depth-status").textContent).toContain("请选择");
    expect(view.context.compromised).toBeUndefined();
    expect(view.html.match(/<script\b/gi)).toHaveLength(2);
  });

  test.each(["success", "failure"])("ignores a stale response's %s after another second is selected", async status => {
    const input = fixture();
    const file = depthFile(input, (book, index) => ({ ...book, bids: [{ price: ".94", size: index + ".000" }] }));
    const network = controlledFetch();
    const view = await openViewer(input, { location: new URL(page), fetch: network.fetch });
    expect(network.requests).toHaveLength(1);
    const next = view.selectSecond(1);
    expect(network.requests).toHaveLength(2);
    expect(network.requests[0]!.options.signal?.aborted).toBe(true);
    network.requests[1]!.resolve(rangeResponse(file, input.rows[1]!));
    await next;
    network.requests[0]!.resolve(status === "success" ? rangeResponse(file, input.rows[0]!) : new Response("bad", { status: 200 }));
    await view.ready;
    expect(view.get("depth-bids").children[0]!.children[1]!.textContent).toBe("1.000");
    expect(view.get("depth-status").textContent).toContain("身份已核验");
  });

  test("a selected local file takes precedence over a pending request and all subsequent selections", async () => {
    const input = fixture();
    const file = depthFile(input, (book, index) => ({ ...book, bids: [{ price: ".94", size: index + ".000" }] }));
    const network = controlledFetch();
    const view = await openViewer(input, { location: new URL(page), fetch: network.fetch });
    expect(network.requests).toHaveLength(1);
    await view.selectFile(file);
    await view.selectSecond(1);
    expect(network.requests).toHaveLength(1);
    expect(network.requests[0]!.options.signal?.aborted).toBe(true);
    network.requests[0]!.resolve(rangeResponse(file, input.rows[0]!));
    await view.ready;
    expect(view.get("depth-bids").children[0]!.children[1]!.textContent).toBe("1.000");
    expect(file.ranges).toEqual(input.rows.slice(0, 2).map(second => [second.depthOffset, second.depthOffset + second.depthBytes]));
  });

  test("does not fall back to network after the user selects a local file of the wrong size", async () => {
    const input = fixture(); const file = depthFile(input); const network = controlledFetch();
    const view = await openViewer(input, { location: new URL(page), fetch: network.fetch });
    expect(network.requests).toHaveLength(1);
    network.requests[0]!.resolve(rangeResponse(file, input.rows[0]!));
    await view.ready;
    await view.selectFile(new TrackedFile(["wrong"], "seconds.ndjson"));
    await view.selectSecond(1);
    expect(network.requests).toHaveLength(1);
    expect(view.get("depth-status").textContent).toContain("文件大小不符");
    expect(view.get("depth-bids").children).toHaveLength(0);
  });
});
