import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { createServer, type RequestListener, type Server } from "node:http";
import { connect as connectTcp, createServer as createTcpServer, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { Dispatcher } from "undici";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchHttpResponseText, fetchJson, fetchText, postJson, type HttpOptions } from "../../src/polymarket/http.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const readers = [
  { name: "JSON", read: (url: string, options: HttpOptions) => fetchJson(url, options) },
  { name: "text", read: (url: string, options: HttpOptions) => fetchText(url, options) },
  { name: "raw text", read: (url: string, options: HttpOptions) => fetchHttpResponseText(url, options) },
  { name: "POST JSON", read: (url: string, options: HttpOptions) => postJson(url, "{}", options) }
];

describe("HTTP request lifetime", () => {
  test.each([
    { status: 429, body: '{"retry":"later"}\n' },
    { status: 200, body: '{"incomplete":' }
  ])("raw response reader preserves HTTP $status text before validation", async ({ status, body }) => {
    await withServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json", "x-evidence": "retained" });
      response.end(body);
    }, async url => {
      const result = await fetchHttpResponseText(url, { proxyUrl: "", timeoutMs: 1000 });
      expect(result).toMatchObject({ status, body, headers: { "content-type": "application/json", "x-evidence": "retained" } });
    });
  });
  test.each(readers)("times out a stalled $name body after receiving headers", async ({ read }) => {
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":');
    }, async (url) => {
      const controller = new AbortController();
      const outcome = await observeWithin(read(url, { timeoutMs: 50, proxyUrl: "", signal: controller.signal }));
      expect(outcome).toMatchObject({ status: "rejected", error: { name: "AbortError" } });
      expect(controller.signal.aborted).toBe(false);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    });
  });

  test.each(readers)("cancels a pending $name body through the caller's signal", async ({ name, read }) => {
    let bodyReadStarted!: () => void;
    const readingBody = new Promise<void>((resolve) => { bodyReadStarted = resolve; });
    const method = name === "text" || name === "raw text" ? "text" : "json";
    const originalRead = Response.prototype[method];
    vi.spyOn(Response.prototype, method).mockImplementation(function (this: Response) {
      const pending = originalRead.call(this);
      bodyReadStarted();
      return pending;
    });
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":');
    }, async (url) => {
      const controller = new AbortController();
      const reason = new Error("collector stopped");
      const options = { timeoutMs: 10_000, proxyUrl: "", signal: controller.signal };
      const pending = observeWithin(read(url, options));
      await readingBody;
      controller.abort(reason);
      expect(await pending).toMatchObject({ status: "rejected", error: reason });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    });
  });

  test("rejects an already aborted caller signal before starting a request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const controller = new AbortController();
    const reason = new Error("already stopped");
    controller.abort(reason);
    const options = { proxyUrl: "", signal: controller.signal };

    await expect(fetchJson("http://unused.invalid", options)).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("still times out while waiting for response headers", async () => {
    await withServer(() => {}, async (url) => {
      expect(await observeWithin(fetchJson(url, { timeoutMs: 50, proxyUrl: "" })))
        .toMatchObject({ status: "rejected", error: { name: "AbortError" } });
    });
  });

  test("cancels an unread HTTP error body and releases its connection", async () => {
    let responseClosed!: () => void;
    const closed = new Promise<void>((resolve) => { responseClosed = resolve; });
    await withServer((_request, response) => {
      response.once("close", responseClosed);
      response.writeHead(503, { "content-type": "application/json" });
      response.write('{"error":');
    }, async (url) => {
      await expect(fetchJson(url, { timeoutMs: 1000, proxyUrl: "" })).rejects.toThrow("HTTP 503");
      expect(await observeWithin(closed)).toEqual({ status: "fulfilled", value: undefined });
    });
  });

  test.each(["success", "invalid JSON", "network failure"])("cleans timers and cancellation listeners after %s", async (result) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    if (result === "network failure") fetchMock.mockRejectedValue(new Error("offline"));
    else fetchMock.mockResolvedValue(new Response(result === "success" ? '{"ok":true}' : "invalid"));
    const options = { timeoutMs: 500, proxyUrl: "", signal: controller.signal };
    const pending = fetchJson("http://unused.invalid", options);
    if (result === "success") await expect(pending).resolves.toEqual({ ok: true });
    else await expect(pending).rejects.toThrow();

    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("preserves request headers, method and body", async () => {
    await withServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.end(JSON.stringify({
        method: request.method,
        header: request.headers["x-test"],
        body: Buffer.concat(chunks).toString()
      }));
    }, async (url) => {
      await expect(postJson(url, '{"value":1}', { proxyUrl: "", headers: { "x-test": "kept" } }))
        .resolves.toEqual({ method: "POST", header: "kept", body: '{"value":1}' });
    });
  });

  test("uses a fresh owned dispatcher for every request, including direct requests", async () => {
    const dispatchers: Array<Dispatcher | undefined> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      dispatchers.push((options as RequestInit & { dispatcher?: Dispatcher }).dispatcher);
      return new Response("{}");
    });
    try {
      await fetchJson("http://unused.invalid", { proxyUrl: "http://127.0.0.1:8111" });
      await fetchJson("http://unused.invalid", { proxyUrl: "http://127.0.0.1:8111" });
      await fetchJson("http://unused.invalid", { proxyUrl: "" });
      expect(dispatchers.every((dispatcher) => dispatcher !== undefined)).toBe(true);
      expect(new Set(dispatchers).size).toBe(3);
    } finally {
      await Promise.all([...new Set(dispatchers)].map((dispatcher) => dispatcher?.destroy()));
    }
  });

  test("closes the HTTP connection after a successful body read", async () => {
    let responseClosed!: () => void;
    const closed = new Promise<void>((resolve) => { responseClosed = resolve; });
    await withServer((request, response) => {
      request.socket.once("close", () => responseClosed());
      response.end('{"ok":true}');
    }, async (url) => {
      await expect(fetchJson(url, { proxyUrl: "" })).resolves.toEqual({ ok: true });
      expect(await observeWithin(closed)).toEqual({ status: "fulfilled", value: undefined });
    });
  });

  test.each(["direct TLS", "HTTP CONNECT", "proxy destination TLS", "HTTPS proxy TLS", "caller abort"] as const)(
    "lets a child exit promptly after aborting a stalled %s connection", async (mode) => {
      const peers = new Set<Duplex>();
      let attempts = 0;
      const tunnel = mode === "HTTP CONNECT" || mode === "proxy destination TLS";
      const server = tunnel ? createServer() : createTcpServer();
      server.on("connection", (socket) => {
        peers.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => peers.delete(socket));
        if (!tunnel) socket.once("data", () => { attempts += 1; });
      });
      if (tunnel) server.on("connect", (_request, socket: Duplex) => {
        attempts += 1;
        if (mode === "proxy destination TLS") socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
      const proxyUrl = tunnel ? `http://${address}` : mode === "HTTPS proxy TLS" ? `https://${address}` : "";
      const script = `
        import { fetchJson } from './src/polymarket/http.ts';
        const controller = new AbortController();
        const reason = new Error('caller stop');
        ${mode === "caller abort" ? "setTimeout(() => controller.abort(reason), 50);" : ""}
        try {
          await fetchJson(${JSON.stringify(`https://${address}/test`)}, {
            timeoutMs: ${mode === "caller abort" ? 10_000 : 50}, proxyUrl: ${JSON.stringify(proxyUrl)}, signal: controller.signal
          });
          process.stdout.write('UNEXPECTED_SUCCESS\\n');
        } catch (error) {
          process.stdout.write(JSON.stringify({ name: error.name, sameReason: error === reason, message: error.message, cause: error.cause?.message }) + '\\n');
        }
      `;
      try {
        const { stdout, stderr, ...result } = await runHttpChild(script);
        expect(attempts, JSON.stringify({ stdout, stderr })).toBeGreaterThan(0);
        expect(JSON.parse(stdout), stderr).toMatchObject({ name: mode === "caller abort" ? "Error" : "AbortError", sameReason: mode === "caller abort" });
        expect(result, stderr).toEqual({ forced: false, code: 0, signal: null });
      } finally {
        for (const peer of peers) peer.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 5_000
  );

  test.each(["explicit", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const)(
    "rejects unsupported %s proxy protocols before fetch starts", async (setting) => {
      clearProxyEnvironment();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
      const proxyUrl = "socks5://127.0.0.1:1080";
      if (setting !== "explicit") vi.stubEnv(setting, proxyUrl);
      await expect(fetchJson("https://unused.invalid", setting === "explicit" ? { proxyUrl } : {}))
        .rejects.toThrow("UNSUPPORTED_PROXY_PROTOCOL");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  test("rejects a SOCKS proxy before any connection and lets a child exit naturally", async () => {
    const peers = new Set<Duplex>();
    let connections = 0;
    const server = createTcpServer((socket) => {
      connections += 1;
      peers.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => peers.delete(socket));
      socket.on("data", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const script = `
      import { fetchJson } from './src/polymarket/http.ts';
      try {
        await fetchJson(${JSON.stringify(`https://${address}/test`)}, { proxyUrl: ${JSON.stringify(`socks5://${address}`)}, timeoutMs: 50 });
        process.stdout.write('UNEXPECTED_SUCCESS\\n');
      } catch (error) {
        process.stdout.write(error.message + '\\n');
      }
    `;
    try {
      const { stdout, stderr, ...result } = await runHttpChild(script);
      expect(stdout, stderr).toContain("UNSUPPORTED_PROXY_PROTOCOL");
      expect(connections).toBe(0);
      expect(result, stderr).toEqual({ forced: false, code: 0, signal: null });
    } finally {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 5_000);

  test("preserves explicit proxy precedence, environment routing, and an empty proxy override", async () => {
    clearProxyEnvironment();
    await withServer((_request, response) => response.end('{"ok":true}'), async (url) => {
      const environmentProxy = await tunnelProxy(url);
      const explicitProxy = await tunnelProxy(url);
      vi.stubEnv("HTTP_PROXY", environmentProxy.url);
      vi.stubEnv("HTTPS_PROXY", environmentProxy.url);
      vi.stubEnv("NO_PROXY", "*");
      try {
        await expect(fetchJson(url, { proxyUrl: explicitProxy.url })).resolves.toEqual({ ok: true });
        expect(explicitProxy.targets).toEqual([new URL(url).host]);
        expect(environmentProxy.targets).toEqual([]);
        await expect(fetchJson(url, { proxyUrl: "" })).resolves.toEqual({ ok: true });
        await expect(fetchJson(url)).resolves.toEqual({ ok: true });
        expect(environmentProxy.targets).toEqual([]);
        vi.stubEnv("NO_PROXY", "");
        await expect(fetchJson(url)).resolves.toEqual({ ok: true });
        expect(environmentProxy.targets).toEqual([new URL(url).host]);
      } finally {
        await explicitProxy.close();
        await environmentProxy.close();
      }
    });
  });

  test("aborting one request leaves another request's transport and body intact", async () => {
    let firstReady!: () => void;
    let secondReady!: () => void;
    let finishSecond!: () => void;
    const firstHeaders = new Promise<void>((resolve) => { firstReady = resolve; });
    const secondHeaders = new Promise<void>((resolve) => { secondReady = resolve; });
    await withServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":');
      if (request.url?.endsWith("cancel")) firstReady();
      else {
        finishSecond = () => response.end("true}");
        secondReady();
      }
    }, async (url) => {
      const controller = new AbortController();
      const reason = new Error("cancel one request");
      const first = fetchJson(`${url}?cancel`, { proxyUrl: "", signal: controller.signal })
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      const second = fetchJson(`${url}?keep`, { proxyUrl: "" })
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      await Promise.all([firstHeaders, secondHeaders]);
      controller.abort(reason);
      expect(await first).toEqual({ error: reason });
      finishSecond();
      expect(await second).toEqual({ value: { ok: true } });
    });
  });
});

function clearProxyEnvironment(): void {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]) vi.stubEnv(name, undefined);
}

async function tunnelProxy(targetUrl: string) {
  const server = createServer();
  const peers = new Set<Duplex>();
  const targets: string[] = [];
  const target = new URL(targetUrl);
  const track = (socket: Duplex) => {
    peers.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => peers.delete(socket));
  };
  server.on("connection", track);
  server.on("connect", (request, socket, head) => {
    targets.push(request.url!);
    const upstream = connectTcp({ host: target.hostname, port: Number(target.port) });
    track(upstream);
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, targets,
    async close() {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function runHttpChild(script: string, environment: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(), env: { NO_PROXY: "*", ...environment }, stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let forced = false;
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const timeout = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 2_000);
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    return { forced, ...result, stdout, stderr };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

async function withServer(handler: RequestListener, run: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback TCP server");
  try {
    await run(`http://127.0.0.1:${address.port}/test`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function observeWithin(pending: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(
        (value) => ({ status: "fulfilled", value }),
        (error: unknown) => ({ status: "rejected", error })
      ),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ status: "pending" }), 350); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
