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
      ], tokens: [quality("A", false), quality("B", true), quality("Over", false, "total")], warnings: ["unknown_finish: other"],
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

async function openViewer(input = fixture()) {
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
  const context: Record<string, unknown> = { document };
  for (const script of scripts.filter(match => match !== dataScript)) runInNewContext(script[2]!, context, { timeout: 1000 });
  const get = (id: string): Element => { expect(nodes.has(id), id).toBe(true); return nodes.get(id)!; };
  return { html, get, context, payload: JSON.parse(dataScript![2]!),
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
    for (const label of ["比赛", "市场", "结果", "接收时间", "订单簿", "进球时间", "不会上传", "300", "缺失原因"]) expect(html).toContain(label);
    expect(html).not.toMatch(/https?:\/\/|<script[^>]+src\s*=|<link\b|\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|@import|url\s*\(/i);
    expect(html).toContain("connect-src 'none'");
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
    const view = await openViewer();
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
