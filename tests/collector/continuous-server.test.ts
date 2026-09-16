import { cp, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { Agent, request, Server, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CapturedGame, ContinuousStatus } from "../../src/collector/continuous-state.js";
import { renderTailViewer } from "../../src/collector/tail-view.js";
import { exportTail } from "../../src/collector/tail-export.js";
import { fixtureRecords } from "./tail-fixture.js";
import * as archiveFs from "node:fs/promises";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});

type StatusServer = { port: number; close(): Promise<void> };
type HttpResult = { status: number; headers: IncomingHttpHeaders; body: Buffer };

let dataRoot: string;
let status: ContinuousStatus;
const servers: StatusServer[] = [];
const sockets: Socket[] = [];
const agents: Agent[] = [];

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "continuous-server-test-"));
  status = {
    schemaVersion: 1, instanceId: "instance-test", pid: 123, startedAtMs: 1_000, updatedAtMs: 20_000,
    dataRoot, port: 0, mode: "collecting", runId: "run-test", runDirectory: join(dataRoot, "runs", "run-test"),
    receivedRecords: 42, lastRecordAtMs: 15_000, freeBytes: 25_000_000_000, rawBytes: 4096, queuedBytes: 128,
    desiredTokens: 3, games: [], connections: [], errors: [],
    compression: { enabled: false, running: false, lastCompletedAtMs: null, compressedSegments: 0, logicalBytesSaved: 0, lastError: null }
  };
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const agent of agents.splice(0)) agent.destroy();
  for (const server of servers.splice(0)) await server.close();
  await rm(dataRoot, { recursive: true, force: true });
});

async function start(getStatus = () => status, port = 0): Promise<StatusServer> {
  const { startContinuousServer } = await import("../../src/collector/continuous-server.js");
  const server = await startContinuousServer({ port, dataRoot, getStatus });
  servers.push(server);
  return server;
}

function http(port: number, path = "/api/status", options: {
  method?: string; headers?: OutgoingHttpHeaders; agent?: Agent;
} = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, ...options, agent: options.agent ?? false }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.once("error", reject);
    req.setTimeout(2_000, () => req.destroy(new Error("localhost HTTP request timed out")));
    req.end();
  });
}

function game(overrides: Partial<CapturedGame> = {}): CapturedGame {
  return {
    key: "game:123", title: "甲队 vs 乙队", sport: "tennis", gameId: "123",
    eventIds: ["event"], eventSlugs: ["match"], tokenIds: ["A", "B"], marketIds: ["winner"],
    firstSeenAtMs: 1000, lastSeenAtMs: 15_000, firstBookAtMs: 2000, lastBookAtMs: 14_000,
    lastBookRunId: "run-test", bookUpdates: 12, trades: 3, stateObservations: 4,
    finishedAtMs: null, finishConflict: false, retiredEventIds: [], phase: "watching", sources: [], ...overrides
  };
}

// As in tail-view.test.ts, run the delivered script against a small DOM boundary.
// HTTP and JSON fetching remain real localhost requests; HTML insertion is forbidden.
class Element {
  children: Element[] = [];
  attributes: Record<string, string> = {};
  private ownText = "";
  disabled = false;
  private listeners: Array<() => unknown> = [];
  constructor(readonly tagName: string) {}
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.ownText = String(value ?? ""); this.children = []; }
  set innerHTML(_value: string) { throw new Error("HTML insertion is forbidden"); }
  setAttribute(name: string, value: unknown): void { this.attributes[name] = String(value); }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  append(...nodes: Element[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]): void { this.ownText = ""; this.children = nodes; }
  addEventListener(event: string, listener: () => unknown): void { if (event === "click") this.listeners.push(listener); }
  click(): void { if (!this.disabled) for (const listener of this.listeners) listener(); }
  find(predicate: (element: Element) => boolean): Element[] {
    return this.children.flatMap(child => [...(predicate(child) ? [child] : []), ...child.find(predicate)]);
  }
}

async function openDashboard(server: StatusServer) {
  const result = await http(server.port, "/");
  expect(result.status).toBe(200);
  const html = result.body.toString();
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  expect(scripts).toHaveLength(1);
  const nodes = new Map<string, Element>();
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) nodes.set(match[2]!, new Element(match[1]!));
  const timers: Array<() => unknown> = [];
  const delays: number[] = [];
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const context: Record<string, unknown> = {
    document: { getElementById: (id: string) => nodes.get(id), createElement: (tag: string) => new Element(tag) },
    Date: class extends Date { static override now() { return 20_000; } },
    AbortSignal,
    setTimeout: (callback: () => unknown, delay: number) => { timers.push(callback); delays.push(delay); return timers.length; },
    fetch: async (path: string, init: RequestInit) => {
      expect(path === "/api/status" || path.startsWith("/api/archives?")).toBe(true);
      requests.push({ path, init });
      const response = await http(server.port, path);
      return { ok: response.status === 200, json: async () => JSON.parse(response.body.toString()) };
    }
  };
  runInNewContext(scripts[0]![1]!, context, { timeout: 1000 });
  await vi.waitFor(() => expect(timers.length).toBe(1));
  if (nodes.has("archives-health")) await vi.waitFor(() => expect(nodes.get("archives-health")!.textContent).not.toContain("正在读取"));
  return {
    html, headers: result.headers, context, requests, delays,
    get(id: string): Element { expect(nodes.has(id), id).toBe(true); return nodes.get(id)!; },
    async refresh() { await timers.shift()!(); await vi.waitFor(() => expect(timers.length).toBe(1)); }
  };
}

test("historical books have a top-level jump link and are not buried under an unbounded live table", async () => {
  const server = await start(), result = await http(server.port, "/"), html = result.body.toString();
  expect(result.status).toBe(200);
  expect(html).toContain('href="#historical-archives"');
  expect(html).toContain('<section id="historical-archives">');
  expect(html.indexOf('href="#historical-archives"')).toBeLessThan(html.indexOf('<tbody id="games">'));
  expect(html).toContain('class="scroll live-games"');
  expect(html).toContain('.live-games{max-height:28rem}');
});

const filenames = ["viewer.html", "seconds.ndjson", "seconds.csv", "quality.json", "manifest.json", "changes.ndjson", "state-changes.ndjson", "audit.ndjson", "raw-events.ndjson"];

async function archiveFixture() {
  const outputDirectory = join(dataRoot, "exports", "nested", "finished");
  await mkdir(outputDirectory, { recursive: true });
  for (const filename of filenames) await writeFile(join(outputDirectory, filename), `已完成 ${filename}\n`);
  const captured = game({ key: "game:比赛 123", phase: "archived", archive: {
    status: "complete", runId: "run-test", attempt: 1, outputDirectory, priceReadyTokens: 2, strictReadyTokens: 0
  } });
  status.games = [captured];
  const server = await start();
  const url = (filename = "seconds.ndjson") => `/exports/${encodeURIComponent(captured.key)}/${filename}`;
  return { server, captured, outputDirectory, url };
}

async function storedArchive(id = "stored-archive") {
  const runDirectory = join(dataRoot, "source-run");
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, "1970-01-01-000000.ndjson"), fixtureRecords().map(row => JSON.stringify(row)).join("\n") + "\n");
  return exportTail({ runDirectory, outputDirectory: join(dataRoot, "exports", id),
    maxFeedSilenceMs: 600_000, sportsStaleAfterMs: 30_000 });
}

describe("continuous loopback status server", () => {
  test("shows compression activity separately from disk-paused collection", async () => {
    status.mode = "paused_disk";
    status.compression = { enabled: true, running: true, lastCompletedAtMs: 19_000,
      compressedSegments: 2, logicalBytesSaved: 1024 ** 3, lastError: null };
    const view = await openDashboard(await start());
    expect(view.get("mode").textContent).toContain("已暂停");
    expect(view.get("compression-mode").textContent).toContain("压缩中");
    expect(view.get("compression-saved").textContent).toContain("1.00 GiB");
    expect(view.get("compression-segments").textContent).toBe("2");
  });

  test("serves the current getter snapshot with no caching or configuration fields", async () => {
    const server = await start();
    const first = await http(server.port);
    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toMatch(/^application\/json/);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers["x-content-type-options"]).toBe("nosniff");
    expect(first.headers["access-control-allow-origin"]).toBeUndefined();
    expect(JSON.parse(first.body.toString())).toEqual(status);

    status = { ...status, mode: "paused_disk", receivedRecords: 57, freeBytes: 1000 };
    const next = await http(server.port);
    expect(JSON.parse(next.body.toString())).toEqual(status);
    expect(JSON.parse(next.body.toString())).not.toHaveProperty("config");
  });

  test("actually binds only IPv4 127.0.0.1 and reports the allocated port", async () => {
    // Observe the real server's bound address; the listener and HTTP transport are not mocked.
    const listen = vi.spyOn(Server.prototype, "listen");
    const server = await start();
    expect(server.port).toBeGreaterThan(0);
    expect((listen.mock.contexts[0] as Server).address()).toEqual({ address: "127.0.0.1", family: "IPv4", port: server.port });
    expect((await http(server.port)).status).toBe(200);
  });

  test("HEAD returns the JSON headers and byte length without a body", async () => {
    const server = await start();
    const result = await http(server.port, "/api/status", { method: "HEAD" });
    expect(result.status).toBe(200);
    expect(result.body.length).toBe(0);
    expect(result.headers["content-length"]).toBe(String(Buffer.byteLength(JSON.stringify(status))));
    expect(result.headers["cache-control"]).toBe("no-store");
  });

  test.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"])("rejects %s with 405 on every route", async method => {
    const server = await start();
    for (const path of ["/", "/api/status", "/api/archives", "/archives/id/viewer.html", "/exports/game%3A1/viewer.html", "/unknown"]) {
      const result = await http(server.port, path, { method });
      expect(result.status, path).toBe(405);
      expect(result.headers.allow).toBe("GET, HEAD");
    }
  });

  test("CONNECT receives 405 without establishing a tunnel", async () => {
    const server = await start();
    const socket = connect({ host: "127.0.0.1", port: server.port }); sockets.push(socket);
    const reply = new Promise<string>((resolve, reject) => {
      let data = "";
      socket.on("data", chunk => { data += String(chunk); });
      socket.once("end", () => resolve(data));
      socket.once("error", reject);
      socket.setTimeout(1000, () => socket.destroy(new Error("CONNECT response timed out")));
    });
    socket.end(`CONNECT 127.0.0.1:${server.port} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n\r\n`);
    expect(await reply).toMatch(/^HTTP\/1\.1 405 Method Not Allowed\r\nAllow: GET, HEAD\r\n/);
  });

  test("unknown and reflected URLs return a plain 404 without echoing the request", async () => {
    const server = await start();
    for (const path of ["/config", "/.env", "/%3Cscript%3Ealert(1)%3C/script%3E", "/api/status/", "http://outside.invalid/api/status"]) {
      const result = await http(server.port, path);
      expect(result.status, path).toBe(404);
      expect(result.body.toString()).toBe("Not found\n");
      expect(result.headers["content-type"]).toMatch(/^text\/plain/);
    }
  });

  test("rejects foreign Host and Origin headers without granting CORS access", async () => {
    const server = await start();
    for (const headers of [{ host: "outside.invalid" }, { origin: "https://outside.invalid" }, { origin: "null" }]) {
      const result = await http(server.port, "/api/status", { headers });
      expect(result.status).toBe(403);
      expect(result.headers["access-control-allow-origin"]).toBeUndefined();
      expect(result.body.toString()).not.toContain("outside.invalid");
    }
    expect((await http(server.port, "/api/status", { headers: { origin: `http://127.0.0.1:${server.port}` } })).status).toBe(200);
    expect((await http(server.port, "/api/status", { headers: { host: `localhost:${server.port}` } })).status).toBe(200);
  });

  test("getter errors are contained without returning private diagnostics", async () => {
    const server = await start(() => { throw new Error("http://user:proxy-secret@proxy.invalid:1234/private/config"); });
    const result = await http(server.port);
    expect(result.status).toBe(503);
    expect(result.body.toString()).toBe("Status unavailable\n");
    expect(result.headers["cache-control"]).toBe("no-store");
  });

  test("close is idempotent and ends owned keepalives and unfinished connections promptly", async () => {
    const server = await start();
    const agent = new Agent({ keepAlive: true }); agents.push(agent);
    expect((await http(server.port, "/api/status", { agent })).status).toBe(200);
    expect(Object.values(agent.freeSockets).flat().length).toBe(1);
    const unfinished = connect({ host: "127.0.0.1", port: server.port }); sockets.push(unfinished);
    unfinished.on("error", () => {}); // Closing an unfinished HTTP request may reset this test client.
    await once(unfinished, "connect");
    unfinished.write("GET /api/status HTTP/1.1\r\n");

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([server.close(), server.close()]),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("server close hung")), 1000); })
      ]);
    } finally { clearTimeout(timer); }
    await server.close();
    await expect(http(server.port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  test("a port collision rejects startup and leaves the existing server available", async () => {
    const server = await start();
    await expect(start(() => status, server.port)).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect((await http(server.port)).status).toBe(200);
  });

  test("invalid port numbers are rejected before listening", async () => {
    for (const port of [-1, 65536, 1.5, NaN]) await expect(start(() => status, port)).rejects.toThrow(RangeError);
  });
});

describe("Chinese read-only dashboard", () => {
  test("uses a hashed CSP for its static script/style and permits only same-origin health requests", async () => {
    const server = await start();
    const result = await http(server.port, "/");
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toMatch(/^text\/html/);
    const html = result.body.toString();
    expect(html).toContain('lang="zh-CN"');
    const csp = String(result.headers["content-security-policy"]);
    for (const directive of ["default-src 'none'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) expect(csp).toContain(directive);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
    for (const tag of ["script", "style"]) {
      const content = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html)?.[1];
      expect(content, tag).toBeDefined();
      expect(csp).toContain(`${tag}-src 'sha256-${createHash("sha256").update(content!).digest("base64")}'`);
    }
    expect(html).not.toMatch(/<(?:form|input)\b|\bon\w+=|<script[^>]+src=/i);
    const head = await http(server.port, "/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers["content-length"]).toBe(String(result.body.length));
  });

  test("shows observations and every game phase with separate price and strict readiness", async () => {
    const phases: CapturedGame["phase"][] = ["watching", "postmatch", "needs_finish", "missed", "archiving", "archive_failed", "archived", "interrupted"];
    status.games = phases.map(phase => game({ key: `game:${phase}`, title: `比赛-${phase}`, phase,
      ...(["archiving", "archive_failed", "archived"].includes(phase) ? {
        archive: { status: phase === "archived" ? "complete" as const : phase === "archiving" ? "running" as const : "failed" as const,
          runId: "run-test", attempt: 1, outputDirectory: join(dataRoot, "exports", phase), priceReadyTokens: 2, strictReadyTokens: 0 }
      } : {})
    }));
    status.connections = [{ id: "clob-1", source: "clob", open: true, lastMessageAtMs: 16_000 }, { id: "sports-1", source: "sports", open: false, lastMessageAtMs: null }];
    const view = await openDashboard(await start());
    expect(view.get("mode").textContent).toContain("collecting");
    expect(view.get("free-gb").textContent).toBe("25.00 GB");
    expect(view.get("last-record-age").textContent).toBe("5 秒");
    expect(view.get("received-records").textContent).toBe("42");
    expect(view.get("desired-tokens").textContent).toBe("3");
    expect(view.get("connection-counts").textContent).toBe("1 / 2");
    expect(view.get("connections").textContent).toContain("clob-1");
    expect(view.get("connections").textContent).toContain("已断开");
    for (const label of ["实时采集", "赛后保留", "待确认终场", "错过采集", "归档中", "归档失败", "已归档", "已中断"]) expect(view.get("game-counts").textContent).toContain(label + " 1");
    const rows = view.get("games").children;
    expect(rows).toHaveLength(phases.length);
    const archived = rows.find(row => row.textContent.includes("比赛-archived"))!;
    expect(archived.children[5]!.textContent).toBe("2");
    expect(archived.children[6]!.textContent).toBe("0");
    expect(archived.find(node => node.tagName === "a")).toHaveLength(9);
    for (const row of rows.filter(row => row !== archived)) {
      expect(row.children[5]!.textContent).toBe("—");
      expect(row.children[6]!.textContent).toBe("—");
      expect(row.find(node => node.tagName === "a")).toHaveLength(0);
    }
    expect(view.html).toContain("priceReadyTokens");
    expect(view.html).toContain("strictReadyTokens");
    expect(view.html).toContain("运行中不代表采集完整");
    expect(view.html).toContain("归档完成不代表质量通过");
  });

  test("metadata including closing script tags remains inert text and cannot choose filenames", async () => {
    const hostile = '</script><script>globalThis.pwned=true</script><img src="https://outside.invalid/" onerror="globalThis.pwned=true">';
    const key = 'game:" onmouseover="globalThis.pwned=true';
    status.games = [game({ key, title: hostile, phase: "archived", archive: {
      status: "complete", runId: "run-test", attempt: 1, outputDirectory: join(dataRoot, "exports", "safe"), error: hostile,
      priceReadyTokens: 2, strictReadyTokens: 0
    } })];
    status.connections = [{ id: hostile, source: hostile, open: true, lastMessageAtMs: null }];
    status.errors = [{ atMs: 12_000, scope: hostile, message: hostile }];
    const view = await openDashboard(await start());
    expect(view.html).not.toContain(hostile);
    expect(view.context.pwned).toBeUndefined();
    for (const id of ["games", "connections", "errors"]) {
      expect(view.get(id).textContent).toContain(hostile);
      expect(view.get(id).find(node => ["img", "script"].includes(node.tagName))).toHaveLength(0);
    }
    const links = view.get("games").find(node => node.tagName === "a");
    expect(links.map(link => link.textContent).sort()).toEqual([
      "viewer.html", "seconds.ndjson", "seconds.csv", "quality.json", "manifest.json", "changes.ndjson", "state-changes.ndjson", "audit.ndjson", "raw-events.ndjson"
    ].sort());
    for (const link of links) expect(link.getAttribute("href")).toBe(`/exports/${encodeURIComponent(key)}/${link.textContent}`);
  });

  test("auto-refresh fetches only the same-origin JSON and displays unknown disk/receive state honestly", async () => {
    const view = await openDashboard(await start());
    status = { ...status, mode: "paused_disk", freeBytes: null, lastRecordAtMs: null, receivedRecords: 58 };
    await view.refresh();
    expect(view.get("mode").textContent).toContain("paused_disk");
    expect(view.get("free-gb").textContent).toBe("未知");
    expect(view.get("last-record-age").textContent).toBe("尚未收到");
    expect(view.get("received-records").textContent).toBe("58");
    expect(view.requests.filter(request => request.path === "/api/status")).toHaveLength(2);
    for (const request of view.requests) expect(request.init).toMatchObject({ cache: "no-store", mode: "same-origin", redirect: "error" });
    expect(view.delays.every(delay => delay >= 1000 && delay <= 10_000)).toBe(true);
  });

  test("a failed health refresh marks the displayed snapshot as stale and keeps retrying", async () => {
    let unavailable = false;
    const view = await openDashboard(await start(() => { if (unavailable) throw new Error("private diagnostic"); return status; }));
    unavailable = true;
    await view.refresh();
    expect(view.get("health").textContent).toContain("刷新失败");
    expect(view.get("health").textContent).toContain("上次结果");
    expect(view.get("health").textContent).not.toContain("private diagnostic");
    expect(view.get("received-records").textContent).toBe("42");
    unavailable = false;
    await view.refresh();
    expect(view.get("health").textContent).toContain("已刷新");
  });
});

describe("historical archives after hot-state eviction", () => {
  test("keeps a real complete archive readable with an empty hot game list", async () => {
    await storedArchive();
    const server = await start();
    expect(status.games).toEqual([]);
    const result = await http(server.port, "/exports/game%3A123/viewer.html");
    expect(result.status).toBe(200);
    expect(result.body.toString()).toContain("seconds.ndjson");
  });

  test("lists a real complete archive independently of the hot game list", async () => {
    await storedArchive();
    const server = await start();
    const result = await http(server.port, "/api/archives");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body.toString())).toMatchObject({ total: 1, entries: [
      { id: "stored-archive", games: [{ key: "game:123", current: null }] }
    ] });
  });

  test("renders historical links, stored readiness, absent live state and diagnostic counts honestly", async () => {
    const result = await storedArchive();
    await mkdir(join(dataRoot, "exports", "partial"));
    const view = await openDashboard(await start());
    expect(view.get("archives").children).toHaveLength(1);
    expect(view.get("archives").textContent).toContain("A vs B");
    expect(view.get("archives").textContent).toContain("当前热状态未保留");
    expect(view.get("archives").textContent).toContain("存盘完成");
    expect(view.get("archives-diagnostics").textContent).toContain("未完成 1");
    expect(view.html).toContain("缺失数据不代表零成交");
    expect(view.html).toContain("存盘质量不代表当前采集通过");
    const links = view.get("archives").find(node => node.tagName === "a");
    expect(links).toHaveLength(9);
    for (const link of links) expect(link.getAttribute("href")).toBe(`/archives/stored-archive/${link.textContent}`);
    const row = view.get("archives").children[0]!;
    expect(row.children[4]!.textContent).toBe(String(result.summary.tokens.filter(q => q.observedWindowComplete && q.snapshotAuditPassed && q.validSeconds > 0).length));
    expect(row.children[5]!.textContent).toBe(String(result.summary.tokens.filter(q => q.readyForReplay).length));
  });

  test.each(["failed", "running", "conflicted"])("never upgrades a present %s game from stale complete history", async kind => {
    await storedArchive();
    status.games = [game({ phase: kind === "running" ? "archiving" : "archive_failed", finishConflict: kind === "conflicted",
      archive: { status: kind === "running" ? "running" : "failed", runId: "current-run", attempt: 2 } })];
    const server = await start();
    expect((await http(server.port, "/exports/game%3A123/viewer.html")).status).toBe(404);
    const page = JSON.parse((await http(server.port, "/api/archives")).body.toString());
    expect(page.entries[0].games[0].current).toEqual({ phase: status.games[0]!.phase,
      archiveStatus: status.games[0]!.archive!.status, finishConflict: kind === "conflicted" });
    expect(page.entries[0].games[0]).not.toHaveProperty("latest");
    expect((await http(server.port, "/archives/stored-archive/viewer.html")).status).toBe(200);
    const view = await openDashboard(server);
    expect(view.get("games").find(node => node.tagName === "a")).toHaveLength(0);
    expect(view.get("archives").textContent).toContain(kind === "running" ? "归档中" : "归档失败");
    if (kind === "conflicted") expect(view.get("archives").textContent).toContain("终场时间存在冲突");
    expect(view.get("archives").textContent).not.toMatch(/最新通过|当前通过/);
  });

  test("bounds HTTP pages and lets dashboard users navigate stored directory revisions", async () => {
    const { outputDirectory } = await storedArchive("revision-00");
    for (let i = 1; i <= 20; i++) await cp(outputDirectory, join(dataRoot, "exports", `revision-${String(i).padStart(2, "0")}`), { recursive: true });
    const server = await start();
    const first = JSON.parse((await http(server.port, "/api/archives?offset=0&limit=1")).body.toString());
    const second = JSON.parse((await http(server.port, "/api/archives?offset=1&limit=1")).body.toString());
    expect(first).toMatchObject({ total: 21, limit: 1, nextOffset: 1 });
    expect(first.entries).toHaveLength(1);
    expect(second.entries[0].id).not.toBe(first.entries[0].id);
    for (const query of ["limit=0", "limit=101", "limit=1.1", "limit=NaN", "offset=-1", "offset=9007199254740992", "limit=1&limit=2", "offset=1&offset=2"]) {
      expect((await http(server.port, "/api/archives?" + query)).status, query).toBe(400);
    }
    const view = await openDashboard(server);
    expect(view.get("archives").children).toHaveLength(20);
    expect(view.get("archives-prev").disabled).toBe(true);
    view.get("archives-next").click();
    await vi.waitFor(() => expect(view.get("archives").children).toHaveLength(1));
    expect(view.get("archives-next").disabled).toBe(true);
    view.get("archives-prev").click();
    await vi.waitFor(() => expect(view.get("archives").children).toHaveLength(20));
  });

  test("keeps directory URLs durable across restart and current status failures", async () => {
    await storedArchive();
    const first = await start();
    expect((await http(first.port, "/archives/stored-archive/viewer.html")).status).toBe(200);
    await first.close();
    const second = await start(() => { throw new Error("private status error"); });
    expect((await http(second.port, "/archives/stored-archive/viewer.html")).status).toBe(200);
    const page = await http(second.port, "/api/archives");
    expect(page.status).toBe(200);
    expect(JSON.parse(page.body.toString())).toMatchObject({ total: 1, liveStatusAvailable: false });
    expect(page.body.toString()).not.toContain("private status error");
  });

  test("serves historical downloads with the existing fixed MIME, CSP, HEAD and range behavior", async () => {
    const { outputDirectory } = await storedArchive();
    const server = await start();
    const bytes = await readFile(join(outputDirectory, "seconds.ndjson"));
    for (const base of ["/archives/stored-archive/", "/exports/game%3A123/"]) {
      for (const filename of filenames) {
        const head = await http(server.port, base + filename, { method: "HEAD" });
        expect(head.status, filename).toBe(200);
        expect(head.body.length).toBe(0);
        expect(head.headers["content-disposition"]).toBe(`${filename === "viewer.html" ? "inline" : "attachment"}; filename="${filename}"`);
        if (filename === "viewer.html") expect(head.headers["content-security-policy"]).toContain("connect-src 'self'");
      }
      const range = await http(server.port, base + "seconds.ndjson", { headers: { range: "bytes=2-12" } });
      expect(range.status).toBe(206);
      expect(range.body).toEqual(bytes.subarray(2, 13));
      expect(range.headers["content-range"]).toBe(`bytes 2-12/${bytes.length}`);
      expect((await http(server.port, base + "seconds.ndjson", { headers: { range: "bytes=0-1,3-4" } })).status).toBe(416);
    }
  });

  test("rejects traversal, non-allowlisted names and symlink replacements on historical URLs", async () => {
    const { outputDirectory } = await storedArchive();
    const server = await start();
    expect((await http(server.port, "/archives/stored-archive/viewer.html")).status).toBe(200);
    for (const path of ["../stored-archive/viewer.html", "%2e%2e/viewer.html", "%252e%252e/viewer.html", "stored-archive/%2e%2e/viewer.html",
      "stored-archive%2fother/viewer.html", "stored-archive/%2576iewer.html", "stored-archive/%5cviewer.html", "stored-archive/viewer.html%00",
      "%FF/viewer.html", "stored-archive/.env", "stored-archive/failure.json", "stored-archive/constructor", "stored-archive/%"]) {
      expect((await http(server.port, "/archives/" + path)).status, path).toBe(404);
    }
    for (const path of ["/api/archives", "/archives/stored-archive/viewer.html"]) {
      for (const headers of [{ host: "outside.invalid" }, { origin: "https://outside.invalid" }]) expect((await http(server.port, path, { headers })).status).toBe(403);
    }
    await rename(join(outputDirectory, "viewer.html"), join(dataRoot, "private-viewer"));
    await symlink(join(dataRoot, "private-viewer"), join(outputDirectory, "viewer.html"));
    expect((await http(server.port, "/archives/stored-archive/viewer.html")).status).toBe(404);
    await rename(outputDirectory, join(dataRoot, "moved-archive"));
    await symlink(join(dataRoot, "moved-archive"), outputDirectory);
    expect((await http(server.port, "/archives/stored-archive/seconds.ndjson")).status).toBe(404);
  });

  test("links and downloads declared gzip raw exports without changing depth ranges", async () => {
    const { outputDirectory } = await storedArchive();
    const raw = await readFile(join(outputDirectory, "raw-events.ndjson"));
    const compressed = gzipSync(raw);
    await rename(join(outputDirectory, "raw-events.ndjson"), join(outputDirectory, "kept-raw"));
    await writeFile(join(outputDirectory, "raw-events.ndjson.gz"), compressed);
    const manifest = JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8"));
    await writeFile(join(outputDirectory, "manifest.json"), JSON.stringify({ ...manifest, rawEventsFile: "raw-events.ndjson.gz" }));
    const server = await start();
    const result = await http(server.port, "/archives/stored-archive/raw-events.ndjson.gz");
    expect(result.status).toBe(200);
    expect(result.body).toEqual(compressed);
    expect(result.headers["content-type"]).toBe("application/gzip");
    expect(result.headers["content-encoding"]).toBeUndefined();
    expect(result.headers["content-disposition"]).toBe('attachment; filename="raw-events.ndjson.gz"');
    expect((await http(server.port, "/exports/game%3A123/raw-events.ndjson.gz")).status).toBe(200);
    const view = await openDashboard(server);
    const links = view.get("archives").find(node => node.tagName === "a");
    expect(links.map(link => link.textContent)).toContain("raw-events.ndjson.gz");
    expect(links.map(link => link.textContent)).not.toContain("raw-events.ndjson");
    status.games = [game({ phase: "archived", archive: { status: "complete", runId: "tail-test", attempt: 1, outputDirectory } })];
    await view.refresh();
    const currentLinks = view.get("games").find(node => node.tagName === "a");
    expect(currentLinks.map(link => link.textContent)).toContain("raw-events.ndjson.gz");
    expect(currentLinks.map(link => link.textContent)).not.toContain("raw-events.ndjson");
    expect(status.games[0]!.archive).not.toHaveProperty("rawEventsFile");
  });

  test("status polls stay responsive during a coalesced scan and newly failed games block fallback", async () => {
    await storedArchive();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    const scans = vi.mocked(archiveFs.opendir).mockClear().mockImplementationOnce(async (...args) => {
      entered = true;
      await gate;
      return actual.opendir(...args);
    });
    const server = await start();
    const fallback = http(server.port, "/exports/game%3A123/viewer.html");
    const history = http(server.port, "/api/archives");
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      for (let i = 0; i < 3; i++) expect((await http(server.port, "/api/status")).status).toBe(200);
      expect(scans).toHaveBeenCalledTimes(1);
      status.games = [game({ phase: "archive_failed", archive: { status: "failed", runId: "new-run", attempt: 2 } })];
    } finally { release(); }
    const [file, page] = await Promise.all([fallback, history]);
    expect(file.status).toBe(404);
    expect(JSON.parse(page.body.toString()).entries[0].games[0].current.archiveStatus).toBe("failed");
  });

  test("pins older directory revisions while the legacy absent-game route chooses the latest complete export", async () => {
    const { outputDirectory } = await storedArchive("older");
    const next = join(dataRoot, "exports", "newer");
    await cp(outputDirectory, next, { recursive: true });
    const original = await readFile(join(outputDirectory, "viewer.html"), "utf8");
    await writeFile(join(next, "viewer.html"), original + "<!-- newer revision -->");
    const manifest = JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8"));
    await writeFile(join(outputDirectory, "manifest.json"), JSON.stringify({ ...manifest, createdAt: "2026-01-01T00:00:00Z" }));
    await writeFile(join(next, "manifest.json"), JSON.stringify({ ...manifest, createdAt: "2026-01-02T00:00:00Z" }));
    const server = await start();
    expect((await http(server.port, "/exports/game%3A123/viewer.html")).body.toString()).toBe(original + "<!-- newer revision -->");
    expect((await http(server.port, "/archives/older/viewer.html")).body.toString()).toBe(original);
    expect((await http(server.port, "/archives/newer/viewer.html")).body.toString()).toBe(original + "<!-- newer revision -->");
  });
});

describe("registered finished artifacts", () => {
  test("serves only registered complete files with fixed MIME/disposition and correct HEAD byte lengths", async () => {
    const { server, url } = await archiveFixture();
    for (const filename of filenames) {
      const result = await http(server.port, url(filename));
      const body = Buffer.from(`已完成 ${filename}\n`);
      expect(result.status, filename).toBe(200);
      expect(result.body).toEqual(body);
      expect(result.headers["content-length"]).toBe(String(body.length));
      expect(result.headers["content-type"]).toContain(filename.endsWith(".ndjson") ? "application/x-ndjson" : filename.endsWith(".json") ? "application/json" : filename.endsWith(".csv") ? "text/csv" : "text/html");
      expect(result.headers["content-disposition"]).toBe(`${filename === "viewer.html" ? "inline" : "attachment"}; filename="${filename}"`);
      expect(result.headers["x-content-type-options"]).toBe("nosniff");
      const head = await http(server.port, url(filename), { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.body.length).toBe(0);
      expect(head.headers["content-length"]).toBe(String(body.length));
    }
  });

  test("serves the existing offline viewer unchanged and allows its local file picker script", async () => {
    const { server, outputDirectory, url } = await archiveFixture();
    const viewer = renderTailViewer({
      summary: { schemaVersion: 1, basis: "received-order-book-tail", runId: "run-test", firstReceivedAtMs: 0, lastReceivedAtMs: 0,
        windowSeconds: 300, records: 0, seconds: 0, changes: 0, stateChanges: 0, audits: 0, windows: [], tokens: [], warnings: [],
        journalQuality: { sequenceGaps: [], incompleteFinalLines: 0, malformedLines: 0, invalidBookUpdates: 0,
          connectionInvalidations: 0, unknownFrames: 0, outOfOrderMessages: 0 } },
      rows: [], stateChanges: [], depthFile: "seconds.ndjson", depthFileBytes: 0
    });
    await writeFile(join(outputDirectory, "viewer.html"), viewer);
    const result = await http(server.port, url("viewer.html"));
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe(viewer);
    expect(result.body.toString()).toContain('<input id="depth-file" type="file"');
    expect(result.body.toString().includes("connect-src 'self'")).toBe(true);
    expect(result.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(result.headers["content-security-policy"]).toContain("script-src 'unsafe-inline'");
    expect(result.headers["content-security-policy"]).not.toContain("sha256-");
  });

  test("rechecks registration, completion and the current output directory for each request", async () => {
    const { server, captured, url } = await archiveFixture();
    expect((await http(server.port, url())).status).toBe(200);
    status = { ...status, games: [] };
    expect((await http(server.port, url())).status).toBe(404);
    for (const archive of [undefined, { ...captured.archive!, status: "running" as const }, { ...captured.archive!, status: "failed" as const }]) {
      const incomplete = game({ key: captured.key, phase: "archived", ...(archive ? { archive } : {}) });
      status.games = [incomplete];
      expect((await http(server.port, url())).status).toBe(404);
    }
    const second = join(dataRoot, "exports", "second");
    await mkdir(second);
    await writeFile(join(second, "seconds.ndjson"), "new output\n");
    status.games = [{ ...captured, archive: { ...captured.archive!, outputDirectory: second } }];
    expect((await http(server.port, url())).body.toString()).toBe("new output\n");
    expect((await http(server.port, "/exports/unregistered/seconds.ndjson")).status).toBe(404);
  });

  test("requires outputDirectory strictly below the configured exports root, not a prefix or the status dataRoot", async () => {
    const { server, captured, url } = await archiveFixture();
    expect((await http(server.port, url())).status).toBe(200);
    for (const directory of [join(dataRoot, "private"), join(dataRoot, "exports-other"), join(dataRoot, "exports"), join(dataRoot, "private", "exports", "game")]) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "seconds.ndjson"), "private-config-proxy-credentials");
      status = { ...status, dataRoot: join(dataRoot, "private"), games: [{ ...captured, archive: { ...captured.archive!, outputDirectory: directory } }] };
      const response = await http(server.port, url());
      expect(response.status, directory).toBe(404);
      expect(response.body.toString()).toBe("Not found\n");
    }
    status.games = [{ ...captured, archive: { status: "complete", runId: "run-test", attempt: 1 } }];
    expect((await http(server.port, url())).status).toBe(404);
  });

  test.each(["file", "directory", "ancestor", "inside"])("blocks %s symlinks even when the lexical path is registered", async kind => {
    const { server, outputDirectory, captured, url } = await archiveFixture();
    expect((await http(server.port, url())).status).toBe(200);
    const target = join(dataRoot, kind === "inside" ? "exports" : "private", "target");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "seconds.ndjson"), "secret symlink target\n");
    if (kind === "file" || kind === "inside") {
      await rename(join(outputDirectory, "seconds.ndjson"), join(outputDirectory, "original.ndjson"));
      await symlink(join(target, "seconds.ndjson"), join(outputDirectory, "seconds.ndjson"));
    } else if (kind === "directory") {
      const linked = join(dataRoot, "exports", "linked");
      await symlink(target, linked);
      status.games = [{ ...captured, archive: { ...captured.archive!, outputDirectory: linked } }];
    } else {
      const linked = join(dataRoot, "exports", "linked");
      await symlink(join(dataRoot, "private"), linked);
      status.games = [{ ...captured, archive: { ...captured.archive!, outputDirectory: join(linked, "target") } }];
    }
    const result = await http(server.port, url());
    expect(result.status).toBe(404);
    expect(result.body.toString()).toBe("Not found\n");
  });

  test("blocks a symlink replacing the exports root", async () => {
    const { server, url } = await archiveFixture();
    expect((await http(server.port, url())).status).toBe(200);
    const moved = join(dataRoot, "moved-exports");
    await rename(join(dataRoot, "exports"), moved);
    await symlink(moved, join(dataRoot, "exports"));
    expect((await http(server.port, url())).status).toBe(404);
  });

  test("missing files and directories named like artifacts cannot be downloaded or listed", async () => {
    const { server, outputDirectory, url } = await archiveFixture();
    expect((await http(server.port, url())).status).toBe(200);
    await rename(join(outputDirectory, "seconds.ndjson"), join(outputDirectory, "original.ndjson"));
    expect((await http(server.port, url())).status).toBe(404);
    await mkdir(join(outputDirectory, "seconds.ndjson"));
    const result = await http(server.port, url());
    expect(result.status).toBe(404);
    expect(result.body.toString()).toBe("Not found\n");
    expect((await http(server.port, url(""))).status).toBe(404);
  });

  test("rejects malformed encodings, traversal, double encoding and encoded slashes without URL normalization", async () => {
    const { server, captured, url } = await archiveFixture();
    expect((await http(server.port, url())).status).toBe(200);
    const key = encodeURIComponent(captured.key);
    const paths = [
      `/exports/${key}/../seconds.ndjson`, `/exports/${key}/%2e%2e/seconds.ndjson`, `/exports/${key}/..%2fseconds.ndjson`,
      `/exports/${key}/%2573econds.ndjson`, `/exports/${key}/seconds.ndjson%00`, `/exports/${key}/seconds.ndjson/extra`,
      `/exports/${key}/%`, `/exports/${key}/%FF`, `/exports/${key}/%2fseconds.ndjson`, `/exports/${key}/%5cseconds.ndjson`,
      `/exports/${key}/seconds.ndjson#reflected`, `/exports/${key}\\seconds.ndjson`, `/exports/${key}/./seconds.ndjson`,
      "/exports/../seconds.ndjson", "/exports/%2e%2e/seconds.ndjson", "/exports/%252e%252e/seconds.ndjson",
      "/exports/%/seconds.ndjson", "/exports/%E0%A4%A/seconds.ndjson", "/exports/%ED%A0%80/seconds.ndjson", "/exports/%FF/seconds.ndjson",
      `/exports/${encodeURIComponent(key)}/seconds.ndjson`, "/exports//seconds.ndjson", `//exports/${key}/seconds.ndjson`
    ];
    for (const path of paths) {
      const response = await http(server.port, path);
      expect(response.status, path).toBe(404);
      expect(response.body.toString(), path).toBe("Not found\n");
    }
    for (const unsafeKey of ["..", ".", "game:part/other", "game:part\\other", "game:%2f", "game:\u0000", "game:\u007f"]) {
      status.games = [{ ...captured, key: unsafeKey }];
      expect((await http(server.port, `/exports/${encodeURIComponent(unsafeKey)}/seconds.ndjson`)).status, unsafeKey).toBe(404);
    }
    expect((await http(server.port)).status).toBe(200);
  });

  test("unknown basenames stay private and URL parameters cannot choose files or reflected download names", async () => {
    const { server, outputDirectory, url } = await archiveFixture();
    expect((await http(server.port, url())).status).toBe(200);
    for (const filename of ["config.json", ".env", "failure.json", "Viewer.html", "script.js", "__proto__", "constructor"]) {
      await writeFile(join(outputDirectory, filename), "private-config-proxy-credentials");
      const result = await http(server.port, url(filename));
      expect(result.status, filename).toBe(404);
      expect(result.body.toString()).toBe("Not found\n");
    }
    const reflected = await http(server.port, url() + '?file=../../.env&filename=%3Cscript%3Ealert(1)%3C/script%3E');
    expect(reflected.status).toBe(200);
    expect(reflected.body.toString()).toBe("已完成 seconds.ndjson\n");
    expect(reflected.headers["content-disposition"]).toBe('attachment; filename="seconds.ndjson"');
  });

  test("streams a multi-GB sparse artifact and remains responsive while the client stops reading", async () => {
    const { server, outputDirectory, url } = await archiveFixture();
    const size = 3 * 1024 ** 3 + 17;
    const file = await open(join(outputDirectory, "seconds.ndjson"), "r+");
    try { await file.truncate(size); } finally { await file.close(); }
    const first = await new Promise<HttpResult>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: server.port, path: url(), agent: false }, response => {
        response.on("error", () => {}); // This download is deliberately interrupted by server.close().
        response.once("data", (body: Buffer) => {
          response.pause();
          resolve({ status: response.statusCode!, headers: response.headers, body });
        });
      });
      req.on("socket", socket => sockets.push(socket));
      req.once("error", reject);
      req.setTimeout(2000, () => req.destroy(new Error("streamed response timed out")));
      req.end();
    });
    expect(first.status).toBe(200);
    expect(first.headers["content-length"]).toBe(String(size));
    expect(first.body.length).toBeGreaterThan(0);
    expect(first.body.length).toBeLessThan(1024 * 1024);
    expect((await http(server.port)).status).toBe(200);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([server.close(), new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("active download prevented close")), 1000);
      })]);
    } finally { clearTimeout(timeout); }
  });
});

describe("bounded artifact byte ranges", () => {
  test("returns 206 for bounded, open-ended and suffix ranges, clamping enormous ends without overflow", async () => {
    const { server, outputDirectory, url } = await archiveFixture();
    await writeFile(join(outputDirectory, "seconds.ndjson"), "0123456789");
    for (const [range, body, contentRange] of [
      ["bytes=2-5", "2345", "bytes 2-5/10"], ["bytes=8-", "89", "bytes 8-9/10"], ["bytes=-3", "789", "bytes 7-9/10"],
      ["bytes=0-999", "0123456789", "bytes 0-9/10"], ["bytes=0-0", "0", "bytes 0-0/10"],
      ["bytes=0-900719925474099999999", "0123456789", "bytes 0-9/10"], ["bytes=-900719925474099999999", "0123456789", "bytes 0-9/10"]
    ] as const) {
      const result = await http(server.port, url(), { headers: { range } });
      expect(result.status, range).toBe(206);
      expect(result.headers["accept-ranges"]).toBe("bytes");
      expect(result.headers["content-range"]).toBe(contentRange);
      expect(result.headers["content-length"]).toBe(String(body.length));
      expect(result.body.toString()).toBe(body);
    }
  });

  test("rejects unsatisfiable, malformed and multiple ranges with 416 and the file length", async () => {
    const { server, outputDirectory, url } = await archiveFixture();
    await writeFile(join(outputDirectory, "seconds.ndjson"), "0123456789");
    for (const range of ["bytes=10-", "bytes=10-20", "bytes=5-3", "bytes=-0", "bytes=", "bytes=abc-def", "bytes=-", "bytes=0-1,4-5", "bytes=90071992547409930-", "items=0-3"]) {
      const result = await http(server.port, url(), { headers: { range } });
      expect(result.status, range).toBe(416);
      expect(result.headers["content-range"]).toBe("bytes */10");
      expect(result.headers["accept-ranges"]).toBe("bytes");
      expect(result.body.toString()).not.toContain("0123456789");
    }
    await writeFile(join(outputDirectory, "seconds.ndjson"), "");
    const empty = await http(server.port, url(), { headers: { range: "bytes=0-0" } });
    expect(empty.status).toBe(416);
    expect(empty.headers["content-range"]).toBe("bytes */0");
    const whole = await http(server.port, url());
    expect(whole.status).toBe(200);
    expect(whole.headers["content-length"]).toBe("0");
    expect(whole.body.length).toBe(0);
  });

  test("HEAD ignores Range; If-Range without a matching validator falls back to the whole file", async () => {
    const { server, outputDirectory, url } = await archiveFixture();
    await writeFile(join(outputDirectory, "seconds.ndjson"), "0123456789");
    const head = await http(server.port, url(), { method: "HEAD", headers: { range: "bytes=2-4" } });
    expect(head.status).toBe(200);
    expect(head.headers["content-range"]).toBeUndefined();
    expect(head.headers["content-length"]).toBe("10");
    expect(head.headers["accept-ranges"]).toBe("bytes");
    expect(head.body.length).toBe(0);
    const conditional = await http(server.port, url(), { headers: { range: "bytes=2-4", "if-range": '"unknown-validator"' } });
    expect(conditional.status).toBe(200);
    expect(conditional.headers["content-range"]).toBeUndefined();
    expect(conditional.body.toString()).toBe("0123456789");
  });
});
