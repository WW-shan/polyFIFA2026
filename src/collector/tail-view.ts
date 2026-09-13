import type { TailPreviewRow, TailViewerInput } from "./tail-types.js";

function pick<T, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) result[key] = value[key];
  return result;
}

const previewFields = [
  "windowKey", "marketId", "tokenId", "outcome", "secondIndex", "startAtMs", "endAtMs", "secondsBeforeFinish",
  "status", "wholeSecondValid", "bestBid", "bestAsk", "minBestBid", "maxBestBid", "minBestAsk", "maxBestAsk",
  "bookUpdates", "tradeCount", "tradeShares", "bookObservedAtMs", "bookSourceAtMs", "bookAgeMs", "feedAgeMs",
  "contextSource", "contextObservedAtMs", "contextSourceAtMs", "contextAgeMs", "contextStatus", "score", "period", "clock",
  "stateChangeCount", "reasons", "depthOffset", "depthBytes"
] as const satisfies readonly (keyof TailPreviewRow)[];

/** Full books stay in separate NDJSON, read by local file slice or loopback HTTP Range. */
export function renderTailViewer(input: TailViewerInput): string {
  // Project explicitly: runtime extras can include full books and large market.raw payloads.
  const data = {
    summary: {
      ...pick(input.summary, ["schemaVersion", "basis", "runId", "windowSeconds", "firstReceivedAtMs", "lastReceivedAtMs", "warnings"]),
      windows: input.summary.windows.map(window => ({
        ...pick(window, ["key", "title", "gameId", "eventSlugs", "startAtMs", "endAtMs", "finishSources", "finishConflict"]),
        markets: window.markets.map(market => pick(market, ["marketId", "tokenId", "question", "outcome", "marketType", "closed", "acceptingOrders"]))
      })),
      tokens: input.summary.tokens.map(token => pick(token, [
        "windowKey", "tokenId", "marketId", "outcome", "expectedSeconds", "validSeconds", "closedSeconds", "partialSeconds",
        "missingSeconds", "staleSeconds", "contextSeconds", "snapshotMatches", "snapshotMismatches", "snapshotNotComparable",
        "observedWindowComplete", "snapshotAuditPassed", "readyForReplay", "reasons"
      ]))
    },
    rows: input.rows.map(row => pick(row, previewFields)),
    stateChanges: input.stateChanges.map(change => pick(change, [
      "windowKey", "source", "kind", "observedAtMs", "sourceAtMs", "sequence", "frameIndex", "before", "after", "actualEventTimeKnown"
    ])),
    depthFile: input.depthFile,
    depthFileBytes: input.depthFileBytes
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return html + '<script id="tail-data" type="application/json">' + json + '</script><script>' + browserScript + '</script></main></body></html>';
}

const html = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>尾盘逐秒订单簿</title>
<style>
:root{color-scheme:light;font-family:system-ui,sans-serif;color:#172a3b;background:#f3f5f7;font-size:14px}
*{box-sizing:border-box}body{margin:0}main{max-width:1440px;margin:auto;padding:18px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:0 0 10px}h3{font-size:14px;margin:0 0 8px}
p{line-height:1.55;margin:6px 0}.muted{color:#536476;font-size:12px}.panel{background:white;border:1px solid #dbe1e7;border-radius:8px;padding:14px;margin-top:12px}
.selectors{display:flex;gap:12px;flex-wrap:wrap}.selectors label{flex:1;min-width:170px;font-weight:600}
select{display:block;width:100%;margin-top:5px;padding:8px;border:1px solid #aebbc8;border-radius:5px;background:white;color:inherit}
button{font:inherit;cursor:pointer;border:1px solid #b7c4d0;border-radius:4px;background:#fff;color:#173d61;padding:4px 7px;text-align:left}
button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #285eaf;outline-offset:2px}
#quality{white-space:pre-line;border-left:4px solid #ab6420;padding:8px 12px;background:#fff5e8;line-height:1.7;margin-top:12px}
#quality[data-ready="true"]{border-color:#237c62;background:#eff8f3}
#warnings{color:#865015;max-height:100px;overflow:auto;margin:6px 0;padding-left:20px;overflow-wrap:anywhere}
#price-chart{display:block;width:100%;height:auto;min-height:180px}.legend{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;margin:6px 0}
.bid{color:#086f87}.ask{color:#ac4d20}.state{color:#77529b}
#state-changes{max-height:125px;overflow:auto;padding-left:20px;font-size:12px;line-height:1.65;overflow-wrap:anywhere}
.scroll{overflow:auto;max-height:430px;border:1px solid #e2e7ec;border-radius:4px}table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
th,td{padding:7px 8px;border-bottom:1px solid #e5eaf0;text-align:left;vertical-align:top}th{position:sticky;top:0;background:#f0f4f8;z-index:1;white-space:nowrap}
#seconds-table{min-width:1180px}#seconds-table td{max-width:240px;overflow-wrap:anywhere}#seconds-table td:first-child{white-space:nowrap}
tr[data-selected="true"]{background:#e8f2ff}tr[data-status="missing"],tr[data-status="feed_stale"],tr[data-status="partial"]{color:#865015}
.depth-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.depth-grid td{overflow-wrap:anywhere;max-width:260px}
#depth-status,#file-status,#depth-file-hint,#window-info{overflow-wrap:anywhere}#depth-status{white-space:pre-line}
input[type=file]{max-width:100%;margin:6px 0}summary{cursor:pointer}
@media(max-width:650px){main{padding:10px}.panel{padding:10px}.depth-grid{grid-template-columns:1fr}.selectors label{min-width:100%}}
</style></head>
<body><main>
<h1>尾盘逐秒订单簿</h1>
<p id="run-info" class="muted"></p>
<p class="muted">图表依据接收时间与订单簿重建，展示采集证据。比分变化时间是接收／更新时间，不是已确认的实际进球时间。表格时间均为 UTC。</p>
<section class="panel" aria-label="选择比赛与结果">
<div class="selectors">
<label for="match-select">比赛<select id="match-select"></select></label>
<label for="market-select">市场<select id="market-select"></select></label>
<label for="outcome-select">结果<select id="outcome-select"></select></label>
</div>
<p id="window-info" class="muted"></p>
<div id="quality" role="status" aria-live="polite"></div>
<ul id="warnings" aria-label="采集告警与结束时间未知的窗口"></ul>
</section>
<section class="panel" aria-label="逐秒价格图">
<h2>买卖报价与秒内波动</h2>
<div class="legend"><span class="bid">买价</span><span class="ask">卖价</span><span>线与点：秒末价 · 竖条：秒内最低–最高</span><span class="state">菱形／虚线：状态变化接收时刻</span></div>
<svg id="price-chart" viewBox="0 0 1040 250" role="img" aria-label="买卖价、秒内极值与状态变化"></svg>
<p class="muted">缺失、过期与不完整秒会断线；竖条悬停可看极值。极值可揭示秒内下跌与回升，但不能还原秒内的全部先后顺序。沿用且无更新的秒只是复用已有观测，缺失不表示价格不变。</p>
<details open><summary>状态变化（接收／来源更新时间）</summary><ul id="state-changes"></ul></details>
</section>
<section class="panel">
<h2>逐秒记录 <span class="muted">点击时间选择完整深度</span></h2>
<p id="rows-info" class="muted"></p>
<div class="scroll"><table id="seconds-table">
<thead><tr><th>秒 / 接收时间 UTC / 距结束</th><th>订单簿状态</th><th>比分</th><th>阶段 / 时钟</th><th>更新数</th><th>秒末买价</th><th>买价最低–最高</th><th>秒末卖价</th><th>卖价最低–最高</th><th>状态变化数</th><th>比分上下文</th><th>缺失原因</th></tr></thead>
<tbody id="seconds-body"></tbody>
</table></div>
</section>
<section class="panel" aria-label="完整深度检查">
<h2>选中秒的完整深度</h2>
<p id="depth-selection" class="muted"></p>
<label for="depth-file">选择本地深度文件</label>
<input id="depth-file" type="file" accept=".ndjson,.jsonl,application/x-ndjson">
<p id="depth-file-hint" class="muted"></p>
<p class="muted">通过本地服务器打开时会自动读取所选秒；离线打开时请选择本地深度文件。用户选择的本地文件优先读取，不会上传。每次仅按字节读取选中秒，不会将整个文件载入内存。身份核验只检查索引对应关系，数据质量见上方。</p>
<p id="file-status" class="muted" role="status"></p>
<p id="depth-status" role="status" aria-live="polite"></p>
<div class="depth-grid">
<div><h3 class="bid">买盘（完整档位）</h3><div class="scroll"><table><thead><tr><th>价格</th><th>数量</th></tr></thead><tbody id="depth-bids"></tbody></table></div></div>
<div><h3 class="ask">卖盘（完整档位）</h3><div class="scroll"><table><thead><tr><th>价格</th><th>数量</th></tr></thead><tbody id="depth-asks"></tbody></table></div></div>
</div>
</section>
<noscript><p>请启用 JavaScript 查看本地逐秒数据；此页面不需要网络。</p></noscript>
`;

// Plain browser JavaScript: no imports, external assets, or serialization of executable input.
const browserScript = String.raw`
(() => {
  "use strict";
  const byId = id => document.getElementById(id);
  const data = JSON.parse(byId("tail-data").textContent);
  const summary = data.summary;
  const matches = byId("match-select"), markets = byId("market-select"), outcomes = byId("outcome-select");
  const chart = byId("price-chart");
  const statusLabels = {
    observed: "本秒有更新", carried: "沿用此前订单簿", partial: "部分缺失", missing: "缺失", invalid: "无效",
    feed_stale: "数据流过期", outside_run: "采集范围外", not_yet_known: "尚未知晓", closed: "已关闭／非可交易时段"
  };
  const contextLabels = { present: "有上下文", missing: "上下文缺失", stale: "上下文过期", disconnected: "比分连接中断" };
  const changeLabels = { score_change: "比分变化", score_increase: "比分增加", score_decrease: "比分回退", period_change: "阶段变化", ended_change: "结束状态变化" };
  const reasonLabels = {
    ...statusLabels,
    missing_book: "缺少订单簿", missing_seconds: "存在缺失秒", feed_stale: "数据流过期", feed_silence: "数据流静默",
    outside_run: "采集范围外", not_yet_known: "市场尚未知晓", connection_gap: "连接中断",
    snapshot_mismatch: "快照校验不一致", missing_context: "比分上下文缺失", context_missing: "比分上下文缺失",
    context_stale: "比分上下文过期", context_disconnected: "比分连接中断", unknown_finish: "结束时间未知",
    missing_actual_finish: "缺少实际结束时间", conflicting_finish_labels: "结束时间来源冲突",
    snapshot_audit_not_passed: "快照校验未通过", no_active_book_seconds: "无有效盘口价格秒",
    within_second_invalidation: "秒内订单簿失效", pending_snapshot_audit: "快照校验待完成",
    unresolved_snapshot_audit: "快照校验未完成", missing_book_source_time: "缺少订单簿来源时间",
    book_source_clock_invalid: "订单簿来源时钟无效"
  };
  // Current exports use hyphens; retain labels for older underscore reason codes too.
  for (const [code, title] of Object.entries(reasonLabels)) reasonLabels[code.replace(/_/g, "-")] = title;
  const text = value => value == null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);
  const label = (labels, value) => Object.hasOwn(labels, value) ? labels[value] : text(value);
  const reasons = values => values.map(value => label(reasonLabels, value) + (Object.hasOwn(reasonLabels, value) ? " (" + value + ")" : "")).join("；");
  const time = ms => {
    const date = new Date(ms);
    return ms != null && Number.isFinite(date.getTime()) ? date.toISOString().slice(11, 23) : "未知";
  };
  const dateTime = ms => {
    const date = new Date(ms);
    return ms != null && Number.isFinite(date.getTime()) ? date.toISOString().replace("T", " ").replace("Z", " UTC") : "未知";
  };
  const price = value => {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
  };
  const decimal = value => {
    const number = price(value);
    return number === null ? "—" : Number.isInteger(number * 100) ? number.toFixed(2) : String(number);
  };
  const range = (low, high) => decimal(low) + "–" + decimal(high);
  const valid = row => row.wholeSecondValid === true && (row.status === "observed" || row.status === "carried");
  const knownWindow = window => window && Number.isFinite(window.startAtMs) && Number.isFinite(window.endAtMs) && window.endAtMs > window.startAtMs;
  // Display-only: price evidence is independent of the stricter readyForReplay flag.
  const priceUsable = (window, quality) => !!(knownWindow(window) && !window.finishConflict && quality
    && quality.observedWindowComplete === true && quality.snapshotAuditPassed === true && quality.validSeconds > 0);
  const allClosed = quality => quality && quality.expectedSeconds > 0 && quality.validSeconds === 0
    && quality.closedSeconds === quality.expectedSeconds;
  const key = (window, market, token) => JSON.stringify([window, market, token]);
  const rowsByChoice = new Map(), changesByWindow = new Map(), qualityByChoice = new Map();
  for (const row of data.rows) {
    const id = key(row.windowKey, row.marketId, row.tokenId);
    if (!rowsByChoice.has(id)) rowsByChoice.set(id, []);
    rowsByChoice.get(id).push(row);
  }
  for (const change of data.stateChanges) {
    if (!changesByWindow.has(change.windowKey)) changesByWindow.set(change.windowKey, []);
    changesByWindow.get(change.windowKey).push(change);
  }
  for (const quality of summary.tokens) qualityByChoice.set(key(quality.windowKey, quality.marketId, quality.tokenId), quality);
  let currentWindow = null, currentRows = [], selectedRow = null, localFile = null, readVersion = 0;
  let depthRequest = null;
  const remoteDepthUrl = loopbackDepthUrl();
  let rowNodes = [];

  const qualityFor = (window, market) => qualityByChoice.get(key(window.key, market.marketId, market.tokenId));
  function priceLabel(window, quality) {
    if (!knownWindow(window)) return "结束时间未知；不可回放";
    if (window.finishConflict) return "结束时间来源冲突；不可回放";
    if (!quality) return "缺少该结果的质量记录；不可回放";
    if (priceUsable(window, quality)) return "盘口价格可回放"
      + (quality.contextSeconds < quality.expectedSeconds ? "；比分上下文不完整/过期" : "");
    if (allClosed(quality)) return "已关闭／非可交易时段；无有效盘口价格秒"
      + (quality.snapshotAuditPassed ? "" : "；快照校验未通过");
    const issues = quality.reasons.filter(code => !/^(context[-_]|missing[-_]context$)/.test(code)).map(code => label(reasonLabels, code));
    if (!quality.observedWindowComplete && !issues.length) issues.push("盘口观测窗口不完整");
    if (!quality.snapshotAuditPassed) issues.push("快照校验未通过");
    if (quality.validSeconds === 0) issues.push("无有效盘口价格秒");
    return "盘口价格不可回放；" + Array.from(new Set(issues)).join("；");
  }
  function groupLabel(window, choices) {
    const usable = choices.filter(market => priceUsable(window, qualityFor(window, market))).length;
    if (usable) return "含可回放盘口价格 " + usable + "/" + choices.length + " 个结果";
    return choices.length ? Array.from(new Set(choices.map(market => priceLabel(window, qualityFor(window, market))))).join("；")
      : priceLabel(window, null);
  }

  function element(tag, value = "") {
    const node = document.createElement(tag);
    node.textContent = text(value);
    return node;
  }
  function svg(tag, attributes = {}, value) {
    const node = document.createElementNS(chart.namespaceURI, tag);
    for (const [name, attribute] of Object.entries(attributes)) node.setAttribute(name, String(attribute));
    if (value !== undefined) node.textContent = text(value);
    return node;
  }
  function options(select, entries) {
    const fragment = document.createDocumentFragment();
    for (const [value, title] of entries) {
      const option = element("option", title);
      option.value = value;
      fragment.append(option);
    }
    select.replaceChildren(fragment);
    select.disabled = entries.length === 0;
    select.value = entries.length ? (entries.find(entry => entry[2]) || entries[0])[0] : "";
  }

  function renderQuality() {
    const quality = currentWindow && qualityByChoice.get(key(currentWindow.key, markets.value, outcomes.value));
    const known = knownWindow(currentWindow);
    const ready = !!(known && !currentWindow.finishConflict && quality && quality.readyForReplay === true
      && quality.observedWindowComplete === true && quality.snapshotAuditPassed === true);
    const lines = [];
    if (!currentWindow) lines.push("暂无比赛数据；不可回放。");
    else lines.push(priceLabel(currentWindow, quality));
    if (known && !currentWindow.finishConflict && quality) lines.push(ready ? "质量通过（可回放）" : "综合质量未通过（严格回放条件）");
    if (outcomes.value) lines.push("结果 token：" + outcomes.value);
    if (quality) {
      lines.push("整秒有效 " + quality.validSeconds + "/" + quality.expectedSeconds + " · 缺失 " + quality.missingSeconds
        + " · 过期 " + quality.staleSeconds + " · 部分缺失 " + quality.partialSeconds + " · 已关闭 " + quality.closedSeconds);
      lines.push("观测窗口完整：" + (quality.observedWindowComplete ? "是" : "否") + " · 比分上下文 " + quality.contextSeconds
        + "/" + quality.expectedSeconds + " 秒 · 快照校验：" + (quality.snapshotAuditPassed ? "通过" : "未通过") + "（一致 " + quality.snapshotMatches
        + " / 不一致 " + quality.snapshotMismatches + " / 不可比较 " + quality.snapshotNotComparable + "）");
      if (quality.reasons.length) lines.push("质量原因：" + reasons(quality.reasons));
    }
    byId("quality").textContent = lines.join("\n");
    byId("quality").setAttribute("data-ready", String(ready));
  }

  function renderWindow() {
    currentWindow = summary.windows.find(window => window.key === matches.value) || null;
    const choices = new Map();
    for (const market of currentWindow ? currentWindow.markets : []) {
      if (!choices.has(market.marketId)) choices.set(market.marketId, []);
      choices.get(market.marketId).push(market);
    }
    options(markets, Array.from(choices, ([id, tokens]) => [id,
      tokens[0].question + " · " + tokens[0].marketType + " · " + groupLabel(currentWindow, tokens),
      tokens.some(market => priceUsable(currentWindow, qualityFor(currentWindow, market)))]));
    byId("window-info").textContent = !currentWindow ? "无比赛窗口" : knownWindow(currentWindow)
      ? dateTime(currentWindow.startAtMs) + " → " + dateTime(currentWindow.endAtMs) + " · 结束依据：" + currentWindow.finishSources.join("、")
      : "结束时间未知：没有可定位的最后 " + summary.windowSeconds + " 秒窗口。";
    return renderMarket();
  }

  function renderMarket() {
    const choices = currentWindow ? currentWindow.markets.filter(market => market.marketId === markets.value) : [];
    options(outcomes, choices.map(market => [market.tokenId,
      market.outcome + (market.closed ? "（已关闭）" : "") + " · " + priceLabel(currentWindow, qualityFor(currentWindow, market)),
      priceUsable(currentWindow, qualityFor(currentWindow, market))]));
    return renderToken();
  }

  function renderToken() {
    currentRows = currentWindow ? (rowsByChoice.get(key(currentWindow.key, markets.value, outcomes.value)) || []).slice() : [];
    currentRows.sort((a, b) => a.startAtMs - b.startAtMs || a.secondIndex - b.secondIndex);
    const changes = currentWindow ? (changesByWindow.get(currentWindow.key) || []).slice() : [];
    changes.sort((a, b) => a.observedAtMs - b.observedAtMs || a.sequence - b.sequence || a.frameIndex - b.frameIndex);
    renderQuality();
    renderChart(changes);
    renderStateChanges(changes);
    renderSeconds();
    return selectSecond(currentRows[0] || null);
  }

  function changeText(change) {
    return "接收 " + time(change.observedAtMs) + " UTC · 来源更新 " + time(change.sourceAtMs) + " UTC · "
      + label(changeLabels, change.kind) + "：" + text(change.before) + " → " + text(change.after) + " · 来源 " + change.source;
  }
  function renderStateChanges(changes) {
    const fragment = document.createDocumentFragment();
    for (const change of changes) fragment.append(element("li", changeText(change)));
    if (!changes.length) fragment.append(element("li", "未记录状态变化（不代表实际比赛没有变化）"));
    byId("state-changes").replaceChildren(fragment);
  }

  function renderSeconds() {
    const fragment = document.createDocumentFragment();
    rowNodes = [];
    for (const row of currentRows) {
      const tr = element("tr"), timeCell = element("td");
      tr.setAttribute("data-second-index", row.secondIndex);
      tr.setAttribute("data-status", row.status);
      const button = element("button", row.secondIndex + " · " + time(row.startAtMs) + " · −" + row.secondsBeforeFinish + "s");
      button.setAttribute("type", "button");
      button.setAttribute("aria-label", "查看 " + time(row.startAtMs) + " 的完整深度");
      button.addEventListener("click", () => selectSecond(row));
      timeCell.append(button);
      tr.append(timeCell);
      const status = element("td", label(statusLabels, row.status)
        + (!row.wholeSecondValid && ["observed", "carried"].includes(row.status) ? "（整秒不完整）" : ""));
      status.setAttribute("title", "订单簿接收 " + dateTime(row.bookObservedAtMs) + "；来源时间 " + dateTime(row.bookSourceAtMs)
        + "；订单簿年龄 " + text(row.bookAgeMs) + "ms；数据流年龄 " + text(row.feedAgeMs) + "ms");
      tr.append(status);
      const values = [row.score, text(row.period) + " / " + text(row.clock), row.bookUpdates, row.bestBid,
        range(row.minBestBid, row.maxBestBid), row.bestAsk, range(row.minBestAsk, row.maxBestAsk), row.stateChangeCount,
        label(contextLabels, row.contextStatus) + " · " + text(row.contextAgeMs) + "ms",
        reasons(row.reasons) || (row.wholeSecondValid ? "—" : label(statusLabels, row.status))];
      for (const value of values) tr.append(element("td", value));
      rowNodes.push({ row, tr, button });
      fragment.append(tr);
    }
    byId("seconds-body").replaceChildren(fragment);
    byId("rows-info").textContent = currentRows.length
      ? "本结果 " + currentRows.length + " 个逐秒记录 · 窗口长度 " + summary.windowSeconds + " 秒 · 价格范围见竖条与表格"
      : "没有逐秒记录。结束时间未知或缺少数据时，不推断价格不变。";
  }

  function selectSecond(row) {
    selectedRow = row;
    for (const entry of rowNodes) {
      entry.tr.setAttribute("data-selected", String(entry.row === row));
      entry.button.setAttribute("aria-pressed", String(entry.row === row));
    }
    byId("depth-selection").textContent = row
      ? "token " + row.tokenId + " · 第 " + row.secondIndex + " 秒 · " + dateTime(row.startAtMs) + " · " + label(statusLabels, row.status)
      : "没有可选择的逐秒记录";
    return readDepth();
  }

  function renderChart(changes) {
    chart.replaceChildren();
    chart.append(svg("title", {}, "接收时间订单簿：秒末买卖价、秒内极值和状态变化"));
    if (!currentRows.length) {
      chart.append(svg("text", { x: 48, y: 110, fill: "#536476", "font-size": 15 }, "没有可绘制的逐秒记录"));
      return;
    }
    const start = knownWindow(currentWindow) ? currentWindow.startAtMs : currentRows[0].startAtMs;
    const end = knownWindow(currentWindow) ? currentWindow.endAtMs : currentRows[currentRows.length - 1].endAtMs;
    const span = Math.max(1, end - start);
    const left = 48, right = 1020, top = 20, bottom = 212;
    const x = ms => left + (ms - start) / span * (right - left);
    const y = value => bottom - value * (bottom - top);
    for (let step = 0; step <= 4; step++) {
      const value = step / 4;
      chart.append(svg("line", { x1: left, x2: right, y1: y(value), y2: y(value), stroke: "#e1e7ee" }));
      chart.append(svg("text", { x: left - 8, y: y(value) + 4, "text-anchor": "end", "font-size": 11, fill: "#536476" }, value.toFixed(2)));
    }
    for (let step = 0; step <= 5; step++) {
      const ms = start + span * step / 5;
      chart.append(svg("text", { x: x(ms), y: 235, "text-anchor": step === 0 ? "start" : step === 5 ? "end" : "middle",
        "font-size": 11, fill: "#536476" }, "距结束 " + Math.round((end - ms) / 1000) + "s"));
    }
    for (const row of currentRows) {
      if (valid(row)) continue;
      const gap = svg("rect", { x: x(row.startAtMs), y: top, width: Math.max(1, x(row.endAtMs) - x(row.startAtMs)),
        height: bottom - top, fill: "#ab6420", opacity: .12 });
      gap.append(svg("title", {}, time(row.startAtMs) + " " + label(statusLabels, row.status) + "；" + reasons(row.reasons)));
      chart.append(gap);
    }
    for (const [side, suffix, color] of [["bid", "Bid", "#086f87"], ["ask", "Ask", "#ac4d20"]]) {
      const name = side === "bid" ? "买价" : "卖价";
      const commands = [];
      let previous = null;
      for (const row of currentRows) {
        const middle = (row.startAtMs + row.endAtMs) / 2;
        const low = price(row["minBest" + suffix]), high = price(row["maxBest" + suffix]);
        // Partial seconds can retain observed extrema, but are never joined to the price line.
        if (["observed", "carried", "partial"].includes(row.status) && low !== null && high !== null && low <= high) {
          const rangeX = x(middle) + (side === "bid" ? -1 : 1);
          const envelope = svg("line", { x1: rangeX, x2: rangeX, y1: y(low), y2: y(high), stroke: color,
            "stroke-width": 3, opacity: valid(row) ? .5 : .25, "data-series": side + "-range",
            "data-min": low, "data-max": high, "data-second-index": row.secondIndex });
          envelope.append(svg("title", {}, time(row.startAtMs) + " " + name + "最低 " + decimal(low) + " / 最高 " + decimal(high)
            + " / 秒末 " + text(row["best" + suffix]) + " / 更新 " + row.bookUpdates + (valid(row) ? "" : "（仅部分观测）")));
          chart.append(envelope);
        }
        const quote = price(row["best" + suffix]);
        if (!valid(row) || quote === null) { previous = null; continue; }
        const connected = previous && row.secondIndex === previous.secondIndex + 1 && row.startAtMs === previous.endAtMs;
        commands.push((connected ? "L" : "M") + x(middle) + " " + y(quote));
        const point = svg("circle", { cx: x(middle), cy: y(quote), r: 1.8, fill: color });
        point.append(svg("title", {}, time(row.startAtMs) + " 秒末" + name + " " + text(row["best" + suffix])));
        chart.append(point);
        previous = row;
      }
      chart.append(svg("path", { d: commands.join(" "), fill: "none", stroke: color, "stroke-width": 1.6, "data-series": side }));
    }
    for (const change of changes) {
      if (!Number.isFinite(change.observedAtMs) || change.observedAtMs < start || change.observedAtMs >= end) continue;
      const at = x(change.observedAtMs);
      const marker = svg("g", { "data-state-kind": change.kind, "data-observed-at-ms": change.observedAtMs });
      marker.append(svg("title", {}, changeText(change)));
      marker.append(svg("line", { x1: at, x2: at, y1: top, y2: bottom, stroke: "#77529b", "stroke-dasharray": "3 4" }));
      marker.append(svg("path", { d: "M" + at + " 8 l5 5 l-5 5 l-5 -5 Z", fill: "#77529b" }));
      chart.append(marker);
    }
  }

  function validDepth(levels) {
    return levels === null || (Array.isArray(levels) && levels.every(level => level && typeof level.price === "string" && typeof level.size === "string"));
  }
  function showDepth(id, levels) {
    const fragment = document.createDocumentFragment();
    for (const level of levels || []) {
      const tr = element("tr");
      // Keep decimal strings verbatim; Number would lose precision in prices and sizes.
      tr.append(element("td", level.price), element("td", level.size));
      fragment.append(tr);
    }
    byId(id).replaceChildren(fragment);
  }
  function loopbackDepthUrl() {
    if (typeof location === "undefined") return null;
    const name = data.depthFile;
    // A basename only: no URLs, paths, encoded separators, parent segments or controls.
    if (typeof name !== "string" || !name || name === "." || name.includes("..") || /[^A-Za-z0-9_.-]/.test(name)) return null;
    try {
      const page = new URL(location.href);
      if (!["http:", "https:"].includes(page.protocol) || !["127.0.0.1", "localhost"].includes(page.hostname)) return null;
      const url = new URL("./" + name, page);
      if (url.origin !== page.origin) return null;
      url.username = ""; url.password = "";
      return url.href;
    } catch { return null; }
  }
  async function readRemoteDepth(row, signal) {
    const bytes = row.depthBytes, end = row.depthOffset + bytes - 1;
    if (bytes > 16 * 1024 * 1024) throw new Error("所选秒深度过大（超过 16 MiB）；请选择本地文件读取");
    let response = null, reader = null;
    try {
      response = await fetch(remoteDepthUrl, { method: "GET", headers: { Range: "bytes=" + row.depthOffset + "-" + end },
        mode: "same-origin", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal });
      if (signal.aborted) throw new Error("读取已取消");
      // Never consume a full-file fallback, a different range, or a compressed byte stream.
      if (response.status !== 206) throw new Error("服务器未返回所选字节范围（需要 HTTP 206）");
      if (response.headers.get("Content-Range") !== "bytes " + row.depthOffset + "-" + end + "/" + data.depthFileBytes) {
        throw new Error("响应字节范围或文件大小与索引不符");
      }
      const length = response.headers.get("Content-Length"), encoding = response.headers.get("Content-Encoding");
      if (length !== null && length !== String(bytes)) throw new Error("响应字节长度与索引不符");
      if (encoding !== null && encoding !== "identity") throw new Error("不支持压缩的字节范围响应");
      if (!response.body) throw new Error("没有深度响应内容");
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let received = 0, line = "";
      while (true) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw new Error("读取已取消");
        if (done) break;
        received += value.byteLength;
        if (received > bytes) throw new Error("响应内容超出所选字节范围");
        line += decoder.decode(value, { stream: true });
      }
      if (received !== bytes) throw new Error("响应内容不足所选字节范围");
      return line + decoder.decode();
    } finally {
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      else if (response && response.body) await response.body.cancel().catch(() => {});
    }
  }
  async function readDepth() {
    const version = ++readVersion, row = selectedRow, file = localFile;
    if (depthRequest) depthRequest.abort();
    depthRequest = null;
    byId("depth-bids").replaceChildren();
    byId("depth-asks").replaceChildren();
    if (!row) { byId("depth-status").textContent = "没有可检查的秒。"; return; }
    if (!file && !remoteDepthUrl) { byId("depth-status").textContent = "已选择该秒；请选择匹配的本地深度文件。"; return; }
    byId("depth-status").textContent = "正在读取所选秒的字节范围…";
    try {
      if (file && file.size !== data.depthFileBytes) throw new Error("文件大小不符");
      const depthOffset = row.depthOffset, depthBytes = row.depthBytes, end = depthOffset + depthBytes;
      if (!Number.isSafeInteger(depthOffset) || depthOffset < 0 || !Number.isSafeInteger(depthBytes) || depthBytes <= 0
        || !Number.isSafeInteger(data.depthFileBytes) || data.depthFileBytes < 0
        || !Number.isSafeInteger(end) || end > data.depthFileBytes) throw new Error("字节索引无效或超出文件范围");
      const controller = file ? null : new AbortController();
      depthRequest = controller;
      const line = file ? await file.slice(depthOffset, depthOffset + depthBytes).text() : await readRemoteDepth(row, controller.signal);
      // Selection/file changes invalidate pending reads before either parsing or displaying them.
      if (version !== readVersion) return;
      const full = JSON.parse(line);
      if (!full || full.tokenId !== row.tokenId || full.secondIndex !== row.secondIndex || full.startAtMs !== row.startAtMs
        || full.windowKey !== row.windowKey || full.marketId !== row.marketId) {
        throw new Error("订单簿行身份不匹配（tokenId / secondIndex / startAtMs / windowKey / marketId）");
      }
      if (!validDepth(full.bids) || !validDepth(full.asks)) throw new Error("完整深度结构无效：需要价格与数量字符串");
      showDepth("depth-bids", full.bids);
      showDepth("depth-asks", full.asks);
      byId("depth-status").textContent = "身份已核验 · 买盘 " + (full.bids === null ? "未知" : full.bids.length) + " 档 · 卖盘 "
        + (full.asks === null ? "未知" : full.asks.length) + " 档"
        + (full.bids === null || full.asks === null ? "；本秒未记录完整深度。" : "。")
        + " 数据质量与整秒有效性请见上方记录。";
    } catch (error) {
      if (version !== readVersion) return;
      byId("depth-bids").replaceChildren();
      byId("depth-asks").replaceChildren();
      byId("depth-status").textContent = "读取失败：" + text(error && error.message ? error.message : error)
        + (file ? "" : "；可选择匹配的本地文件读取。");
    } finally {
      if (version === readVersion) depthRequest = null;
    }
  }

  byId("run-info").textContent = "采集 " + summary.runId + " · 各结果最后 " + summary.windowSeconds + " 秒 · "
    + dateTime(summary.firstReceivedAtMs) + " → " + dateTime(summary.lastReceivedAtMs);
  byId("depth-file-hint").textContent = "需要文件：" + data.depthFile + " · 精确大小 " + data.depthFileBytes + " 字节";
  byId("file-status").textContent = remoteDepthUrl ? "本地服务器自动读取所选秒；也可选择本地文件优先读取。"
    : "离线或外部站点不自动请求深度数据；请选择匹配的本地文件。";
  for (const warning of summary.warnings) byId("warnings").append(element("li", warning));
  for (const window of summary.windows) {
    if (!knownWindow(window)) byId("warnings").append(element("li", "结束时间未知：" + window.title + "；无法确定最后 " + summary.windowSeconds + " 秒。"));
  }
  options(matches, summary.windows.map(window => [window.key, window.title + " · " + groupLabel(window, window.markets),
    window.markets.some(market => priceUsable(window, qualityFor(window, market)))]));
  matches.addEventListener("change", renderWindow);
  markets.addEventListener("change", renderMarket);
  outcomes.addEventListener("change", renderToken);
  byId("depth-file").addEventListener("change", () => {
    const file = byId("depth-file").files[0] || null;
    localFile = file;
    if (!file) byId("file-status").textContent = "尚未选择本地文件。";
    else if (!Number.isSafeInteger(data.depthFileBytes) || data.depthFileBytes < 0 || file.size !== data.depthFileBytes) {
      byId("file-status").textContent = "文件大小不符：需要 " + data.depthFileBytes + " 字节，所选文件为 " + file.size + " 字节。";
    } else {
      byId("file-status").textContent = "已选择 " + file.name + "（" + file.size + " 字节）；文件留在本机。";
    }
    return readDepth();
  });
  return renderWindow();
})();
`;
