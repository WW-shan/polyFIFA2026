import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo, Socket } from "node:net";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ContinuousStatus } from "./continuous-state.js";
import { artifactTypes, ContinuousArchiveCatalog, openArtifact, type ArtifactName, type HistoricalArchive } from "./continuous-archive-catalog.js";

// Only these constant filenames enter the script. All runtime metadata arrives as JSON
// through a same-origin fetch and is rendered with textContent, never HTML interpolation.
const browserScript = String.raw`
(() => {
  "use strict";
  const files = ` + JSON.stringify(Object.keys(artifactTypes).filter(filename => filename !== "raw-events.ndjson.gz")) + String.raw`;
  const byId = id => document.getElementById(id);
  const text = value => value == null ? "—" : String(value);
  const node = (tag, value) => {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = text(value);
    return element;
  };
  const age = ms => ms == null || !Number.isFinite(ms) ? "尚未收到" : Math.max(0, Math.floor((Date.now() - ms) / 1000)) + " 秒";
  const modes = { starting: "启动中", collecting: "采集中", restarting: "重启中", paused_disk: "磁盘不足，已暂停", stopping: "停止中", stopped: "已停止" };
  const phases = { watching: "实时采集", postmatch: "赛后保留", needs_finish: "待确认终场", missed: "错过采集", archiving: "归档中", archive_failed: "归档失败", archived: "已归档", interrupted: "已中断" };
  const label = (labels, value) => Object.hasOwn(labels, value) ? labels[value] : text(value);
  const safeKey = key => typeof key === "string" && key.length > 0 && key !== "." && key !== ".."
    && !["/", "\\", "%"].some(part => key.includes(part)) && !/[\u0000-\u001f\u007f]/.test(key);
  function render(status) {
    byId("mode").textContent = label(modes, status.mode) + " (" + text(status.mode) + ")";
    byId("free-gb").textContent = status.freeBytes == null ? "未知" : (status.freeBytes / 1e9).toFixed(2) + " GB";
    byId("last-record-age").textContent = age(status.lastRecordAtMs);
    byId("received-records").textContent = text(status.receivedRecords);
    byId("desired-tokens").textContent = text(status.desiredTokens);
    byId("raw-bytes").textContent = text(status.rawBytes) + " B";
    byId("queued-bytes").textContent = text(status.queuedBytes) + " B";
    const compression = status.compression;
    byId("compression-mode").textContent = !compression || !compression.enabled ? "未启用" : compression.running ? "压缩中" : "等待下轮";
    byId("compression-segments").textContent = text(compression ? compression.compressedSegments : 0);
    byId("compression-saved").textContent = ((compression ? compression.logicalBytesSaved : 0) / (1024 ** 3)).toFixed(2) + " GiB";
    byId("connection-counts").textContent = status.connections.filter(connection => connection.open).length + " / " + status.connections.length;
    byId("connections").replaceChildren(...status.connections.map(connection => {
      const row = node("tr");
      for (const value of [connection.source, connection.id, connection.open ? "已连接" : "已断开", age(connection.lastMessageAtMs)]) row.append(node("td", value));
      return row;
    }));
    byId("game-counts").textContent = Object.entries(phases).map(([phase, title]) => title + " " + status.games.filter(game => game.phase === phase).length).join(" · ");
    byId("games").replaceChildren(...status.games.map(game => {
      const row = node("tr"), title = node("td", game.title), phase = node("td", label(phases, game.phase));
      title.append(node("p", text(game.sport) + " · " + text(game.key)));
      if (game.finishConflict) phase.append(node("p", "终场时间存在冲突"));
      if (game.archive && game.archive.error) phase.append(node("p", game.archive.error));
      const complete = game.archive && game.archive.status === "complete";
      row.append(title, phase, node("td", game.tokenIds.length),
        node("td", "盘口 " + game.bookUpdates + " · 成交 " + game.trades + " · 状态 " + game.stateObservations),
        node("td", age(game.lastBookAtMs)), node("td", complete ? game.archive.priceReadyTokens : null),
        node("td", complete ? game.archive.strictReadyTokens : null));
      const links = node("td");
      if (complete && safeKey(game.key)) for (const base of files) {
        const filename = base === "raw-events.ndjson" && game.archive.rawEventsFile === "raw-events.ndjson.gz" ? "raw-events.ndjson.gz" : base;
        const link = node("a", filename);
        link.setAttribute("href", "/exports/" + encodeURIComponent(game.key) + "/" + filename);
        link.setAttribute("rel", "noreferrer");
        links.append(link);
      }
      row.append(links);
      return row;
    }));
    byId("errors").replaceChildren(...status.errors.map(error => node("li", text(error.scope) + "：" + text(error.message))));
    if (archivePage) renderArchives(archivePage);
  }
  let latest, archivePage, archiveNext = null, archiveBusy = false, archiveAttemptAt = -Infinity;
  function archiveButtons() {
    byId("archives-prev").disabled = archiveBusy || !archivePage || archivePage.offset === 0;
    byId("archives-next").disabled = archiveBusy || archiveNext === null;
  }
  function renderArchives(page) {
    byId("archives").replaceChildren(...page.entries.flatMap(entry => entry.games.map(game => {
      const row = node("tr"), title = node("td", game.title);
      title.append(node("p", game.key), node("p", "目录 " + entry.id), node("p", "来源 " + entry.sourceRunId));
      const stored = node("td", "存盘完成");
      stored.append(node("p", entry.createdAt));
      if (game.finishConflict) stored.append(node("p", "存盘终场时间存在冲突"));
      const current = latest ? latest.games.find(value => value.key === game.key) : game.current;
      const live = node("td", current ? label(phases, current.phase) : latest || page.liveStatusAvailable ? "当前热状态未保留" : "当前状态不可用");
      if (current && current.finishConflict) live.append(node("p", "终场时间存在冲突"));
      row.append(title, stored, live, node("td", game.tokenCount), node("td", game.priceReadyTokens), node("td", game.strictReadyTokens));
      const links = node("td");
      if (safeKey(entry.id)) for (const base of files) {
        const filename = base === "raw-events.ndjson" ? entry.rawEventsFile : base;
        if (base === "raw-events.ndjson" && filename !== "raw-events.ndjson" && filename !== "raw-events.ndjson.gz") continue;
        const link = node("a", filename);
        link.setAttribute("href", "/archives/" + encodeURIComponent(entry.id) + "/" + filename);
        link.setAttribute("rel", "noreferrer");
        links.append(link);
      }
      row.append(links);
      return row;
    })));
    const diagnostics = page.diagnostics;
    byId("archives-diagnostics").textContent = "未完成 " + diagnostics.incomplete + " · 元数据异常 " + diagnostics.invalid
      + " · 不安全路径 " + diagnostics.unsafe + " · 元数据过大 " + diagnostics.oversized + " · 读取失败 " + diagnostics.unreadable;
    byId("archives-page").textContent = "共 " + page.total + " 份 · 本页 " + page.entries.length + " 份 · 起始位置 " + page.offset;
  }
  async function refreshArchives(offset = archivePage ? archivePage.offset : 0) {
    if (archiveBusy) return;
    archiveBusy = true;
    archiveAttemptAt = Date.now();
    archiveButtons();
    try {
      const response = await fetch("/api/archives?offset=" + offset + "&limit=20", { cache: "no-store", mode: "same-origin", credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error("Archives unavailable");
      archivePage = await response.json();
      archiveNext = archivePage.nextOffset;
      renderArchives(archivePage);
      byId("archives-health").textContent = "历史目录已刷新 · 扫描距今 " + age(archivePage.scannedAtMs);
    } catch {
      byId("archives-health").textContent = archivePage ? "历史目录刷新失败；保留上次结果。" : "历史目录刷新失败；尚无结果。";
    } finally { archiveBusy = false; archiveButtons(); }
  }
  byId("archives-prev").addEventListener("click", () => { if (archivePage) void refreshArchives(Math.max(0, archivePage.offset - 20)); });
  byId("archives-next").addEventListener("click", () => { if (archiveNext !== null) void refreshArchives(archiveNext); });
  async function refresh() {
    if (Date.now() - archiveAttemptAt >= 30000) void refreshArchives();
    try {
      const response = await fetch("/api/status", { cache: "no-store", mode: "same-origin", credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Status unavailable");
      const status = await response.json();
      latest = status;
      render(status);
      byId("health").textContent = "状态已刷新 · 快照距今 " + age(status.updatedAtMs);
    } catch {
      if (latest) render(latest);
      byId("health").textContent = latest ? "状态刷新失败；下方保留上次结果。" : "状态刷新失败；尚无结果。";
    } finally { setTimeout(refresh, 2000); }
  }
  void refresh();
})();
`;

const style = `
:root{font-family:system-ui,sans-serif;color:#172a3b;background:#f3f5f7;font-size:14px;color-scheme:light}
body{margin:0}main{max-width:1300px;margin:auto;padding:18px}h1{font-size:22px}h2{font-size:16px}
section{background:#fff;border:1px solid #dbe1e7;border-radius:8px;padding:14px;margin:12px 0}
p,li{line-height:1.6;overflow-wrap:anywhere}.muted{color:#536476}dl{display:flex;gap:18px;flex-wrap:wrap}
dt{color:#536476}dd{margin:4px 0;font-variant-numeric:tabular-nums}.scroll{overflow:auto}.live-games{max-height:28rem}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:8px;text-align:left;border-bottom:1px solid #e5eaf0;vertical-align:top}
th{white-space:nowrap}td{max-width:300px;overflow-wrap:anywhere}td p{margin:4px 0}a{display:block;color:#173d61}
`;
const hash = (value: string): string => createHash("sha256").update(value).digest("base64");
const dashboardCsp = `default-src 'none'; script-src 'sha256-${hash(browserScript)}'; style-src 'sha256-${hash(style)}'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
const dashboard = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>连续采集状态</title><style>${style}</style></head><body><main>
<h1>连续采集状态</h1><p class="muted">只读页面，每 2 秒自动刷新。运行中不代表采集完整；归档完成不代表质量通过。请分别查看盘口价格与严格回放就绪数量。</p>
<p><a href="#historical-archives">查看历史归档与逐秒盘口</a></p>
<p id="health" role="status" aria-live="polite">正在读取状态…</p>
<section><h2>运行与接收</h2><dl>
<div><dt>运行模式</dt><dd id="mode">—</dd></div><div><dt>剩余磁盘</dt><dd id="free-gb">—</dd></div>
<div><dt>距最后接收</dt><dd id="last-record-age">—</dd></div><div><dt>已接收记录</dt><dd id="received-records">—</dd></div>
<div><dt>目标 tokens</dt><dd id="desired-tokens">—</dd></div><div><dt>本轮原始字节</dt><dd id="raw-bytes">—</dd></div>
<div><dt>排队字节</dt><dd id="queued-bytes">—</dd></div><div><dt>已连接 / 总连接</dt><dd id="connection-counts">—</dd></div>
<div><dt>后台压缩</dt><dd id="compression-mode">—</dd></div><div><dt>本进程已压缩分段</dt><dd id="compression-segments">—</dd></div>
<div><dt>本进程压缩减少的逻辑字节</dt><dd id="compression-saved">—</dd></div>
</dl><div class="scroll"><table><thead><tr><th>来源</th><th>连接</th><th>状态</th><th>距最后消息</th></tr></thead><tbody id="connections"></tbody></table></div></section>
<section><h2>比赛与归档</h2><p id="game-counts"></p><div class="scroll live-games" tabindex="0" aria-label="实时比赛列表"><table>
<thead><tr><th>比赛</th><th>阶段</th><th>tokens</th><th>观测计数</th><th>距最后盘口</th><th>价格就绪<br>priceReadyTokens</th><th>严格就绪<br>strictReadyTokens</th><th>已完成归档文件</th></tr></thead>
<tbody id="games"></tbody></table></div><p class="muted">本机回放页面可自动按字节范围读取所选秒的完整深度；离线打开时仍可选择 seconds.ndjson 文件。</p></section>
<section id="historical-archives"><h2>历史归档</h2><p class="muted">历史目录约每 30 秒刷新，按独立导出目录保留各次版本。存盘质量不代表当前采集通过；当前热状态未保留不代表没有归档。价格就绪与严格回放就绪分别列出；缺失数据不代表零成交。</p>
<p id="archives-health" role="status" aria-live="polite">正在读取历史目录…</p><p id="archives-diagnostics"></p>
<div class="scroll"><table><thead><tr><th>比赛与归档版本</th><th>存盘状态与生成时间</th><th>当前采集状态</th><th>tokens</th><th>存盘价格就绪<br>priceReadyTokens</th><th>存盘严格就绪<br>strictReadyTokens</th><th>该版本文件</th></tr></thead><tbody id="archives"></tbody></table></div>
<p id="archives-page"></p><button id="archives-prev" type="button" disabled>上一页</button> <button id="archives-next" type="button" disabled>下一页</button></section>
<section><h2>诊断</h2><ul id="errors"></ul></section><noscript>请启用 JavaScript 以自动刷新本机状态。</noscript>
<script>${browserScript}</script></main></body></html>`;

// Permit only same-origin data reads; viewer code additionally requires a
// loopback hostname. Offline pages keep the explicit local-file path.
const viewerCsp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function artifactRoute(path: string): { kind: string; key: string; filename: ArtifactName } | null {
  // Do not use URL.pathname: URL parsing normalizes dot segments before validation.
  const match = /^\/(exports|archives)\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return null;
  try {
    const key = decodeURIComponent(match[2]!);
    const filename = decodeURIComponent(match[3]!);
    // A remaining percent sign includes double encoding. Neither component can
    // contain separators, dot traversal or control characters after one decode.
    if ([key, filename].some(value => value === "." || value === ".." || /[\\/%\u0000-\u001f\u007f]/.test(value))) return null;
    if (!Object.hasOwn(artifactTypes, filename)) return null;
    return { kind: match[1]!, key, filename: filename as ArtifactName };
  } catch { return null; }
}

function byteRange(value: string, size: number): { start: number; end: number } | null {
  // Deliberately support one range, bounded by the opened file's size. BigInt
  // prevents attacker-supplied offsets from overflowing before they are clamped.
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const length = BigInt(size);
  let start: bigint;
  let end = length - 1n;
  if (!match[1]) {
    const suffix = BigInt(match[2]!);
    if (suffix === 0n) return null;
    start = suffix >= length ? 0n : length - suffix;
  } else {
    start = BigInt(match[1]);
    if (match[2]) end = BigInt(match[2]);
    if (start >= length || end < start) return null;
    if (end >= length) end = length - 1n;
  }
  return { start: Number(start), end: Number(end) };
}

async function serveArtifact(request: IncomingMessage, response: ServerResponse, exportsRoot: string, outputDirectory: string, filename: ArtifactName): Promise<void> {
  const file = await openArtifact(exportsRoot, outputDirectory, filename);
  if (!file) { respond(request, response, 404, "Not found\n"); return; }
  try {
    if (response.destroyed) return;
    response.setHeader("Accept-Ranges", "bytes");
    let bounds = { start: 0, end: file.size - 1 };
    // Range applies only to GET. Without validators, If-Range cannot match.
    if (request.method === "GET" && request.headers.range !== undefined && request.headers["if-range"] === undefined) {
      const range = byteRange(request.headers.range, file.size);
      if (!range) {
        response.setHeader("Content-Range", `bytes */${file.size}`);
        respond(request, response, 416, "Range not satisfiable\n");
        return;
      }
      bounds = range;
      response.statusCode = 206;
      response.setHeader("Content-Range", `bytes ${bounds.start}-${bounds.end}/${file.size}`);
    }
    response.setHeader("Content-Type", artifactTypes[filename]);
    response.setHeader("Content-Disposition", `${filename === "viewer.html" ? "inline" : "attachment"}; filename="${filename}"`);
    response.setHeader("Content-Length", bounds.end - bounds.start + 1);
    if (filename === "viewer.html") response.setHeader("Content-Security-Policy", viewerCsp);
    if (request.method === "HEAD" || file.size === 0) { response.end(); return; }
    // Explicit bounds keep Content-Length correct even if an output grows.
    await pipeline(file.handle.createReadStream({ ...bounds, autoClose: false }), response);
  } finally { await file.handle.close(); }
}

function respond(request: IncomingMessage, response: ServerResponse, code: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  response.statusCode = code;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(request.method === "HEAD" ? undefined : body);
}

/** A read-only, owned listener: no collector controls, configuration reads or network clients. */
export async function startContinuousServer(options: {
  port: number; dataRoot: string; getStatus: () => ContinuousStatus;
}): Promise<{ port: number; close(): Promise<void> }> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new RangeError("Invalid status port");
  const exportsRoot = resolve(options.dataRoot, "exports");
  const archives = new ContinuousArchiveCatalog(exportsRoot);
  let port = options.port;
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      response.setHeader("Connection", "close");
      respond(request, response, 405, "Method not allowed\n");
      return;
    }
    // Checking Host also prevents a foreign DNS name resolving to loopback from reading status.
    const host = request.headers.host;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, ...(port === 80 ? ["127.0.0.1", "localhost"] : [])];
    if (!hosts.includes(host ?? "") || (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`)) {
      respond(request, response, 403, "Forbidden\n");
      return;
    }
    const path = (request.url ?? "").split("?")[0];
    if (path === "/") {
      response.setHeader("Content-Security-Policy", dashboardCsp);
      respond(request, response, 200, dashboard, "text/html; charset=utf-8");
      return;
    }
    if (path === "/api/status") {
      try {
        const status = options.getStatus();
        const games = status.games.map(game => {
          const rawEventsFile = game.archive?.outputDirectory && archives.cachedRawEventsFile(game.archive.outputDirectory);
          return rawEventsFile ? { ...game, archive: { ...game.archive, rawEventsFile } } : game;
        });
        respond(request, response, 200, JSON.stringify({ ...status, games }), "application/json; charset=utf-8");
      } catch {
        respond(request, response, 503, "Status unavailable\n");
      }
      return;
    }
    if (path === "/api/archives") {
      const query = new URLSearchParams((request.url ?? "").split("?")[1]);
      const offset = query.get("offset") ?? "0", limit = query.get("limit") ?? "20";
      if (!/^\d+$/.test(offset) || !/^\d+$/.test(limit) || query.getAll("offset").length > 1 || query.getAll("limit").length > 1) {
        respond(request, response, 400, "Invalid archive page\n"); return;
      }
      void archives.page(Number(offset), Number(limit)).then(page => {
        let current: ContinuousStatus | undefined;
        try { current = options.getStatus(); } catch { /* Disk history remains available. */ }
        const games = new Map(current?.games.map(game => [game.key, game]));
        respond(request, response, 200, JSON.stringify({ ...page, liveStatusAvailable: current !== undefined,
          entries: page.entries.map(entry => ({ ...entry, games: entry.games.map(game => {
            const hot = games.get(game.key);
            return { ...game, current: hot ? { phase: hot.phase, archiveStatus: hot.archive?.status ?? null, finishConflict: hot.finishConflict } : null };
          }) })) }), "application/json; charset=utf-8");
      }).catch(error => respond(request, response, error instanceof RangeError ? 400 : 503,
        error instanceof RangeError ? "Invalid archive page\n" : "Archives unavailable\n"));
      return;
    }
    const route = artifactRoute(path ?? "");
    if (route) {
      const serve = (directory: string) => serveArtifact(request, response, exportsRoot, directory, route.filename);
      const failed = () => {
        if (response.headersSent) response.destroy();
        else respond(request, response, 404, "Not found\n");
      };
      const serveStored = (entry: HistoricalArchive | undefined) => {
        if (!entry || ((route.filename === "raw-events.ndjson" || route.filename === "raw-events.ndjson.gz") && route.filename !== entry.rawEventsFile)) {
          failed(); return;
        }
        return serve(join(exportsRoot, entry.id));
      };
      if (route.kind === "archives") {
        void archives.find(route.key).then(serveStored).catch(failed);
        return;
      }
      let game;
      try { game = options.getStatus().games.find(game => game.key === route.key); }
      catch { respond(request, response, 503, "Status unavailable\n"); return; }
      if (game?.archive?.status === "complete" && typeof game.archive.outputDirectory === "string") {
        void serve(game.archive.outputDirectory).catch(failed);
        return;
      }
      // Only eviction/absence may fall back. A current failed, conflicted or
      // unfinished game must retain its current status and output selection.
      if (!game) {
        void archives.latest(route.key).then(entry => {
          // A scan can outlast a discovery/status update. Recheck before using
          // historical fallback so a newly failed current game still wins.
          let current;
          try { current = options.getStatus().games.find(game => game.key === route.key); }
          catch { respond(request, response, 503, "Status unavailable\n"); return; }
          if (!current) return serveStored(entry);
          if (current.archive?.status === "complete" && typeof current.archive.outputDirectory === "string") return serve(current.archive.outputDirectory);
          failed();
        }).catch(failed);
        return;
      }
    }
    respond(request, response, 404, "Not found\n");
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // Node dispatches CONNECT separately from ordinary HTTP requests.
  server.on("connect", (_request, socket) => {
    socket.end("HTTP/1.1 405 Method Not Allowed\r\nAllow: GET, HEAD\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  let closing: Promise<void> | undefined;
  return {
    port,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        // Includes idle keepalives and peers that have not finished sending HTTP headers.
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    }
  };
}
