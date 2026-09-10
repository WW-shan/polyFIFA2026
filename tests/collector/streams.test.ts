import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { connect as connectTcp, createServer as createTcpServer, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createPublicStreams, type CollectorSocket, type StreamRecord } from "../../src/collector/streams.js";
import type { RecordInput } from "../../src/collector/types.js";

class MemorySink {
  readonly records: RecordInput[] = [];

  record(input: RecordInput): void {
    this.records.push(input);
  }
}

class ControlledSocket implements CollectorSocket {
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: StreamRecord) => void>>();

  addEventListener(type: string, listener: (event: StreamRecord) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: StreamRecord) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.emit("close", { code, reason });
  }

  open(): void {
    this.emit("open", {});
  }

  message(data: string): void {
    this.emit("message", { data });
  }

  error(error: unknown): void {
    this.emit("error", { error });
  }

  private emit(type: string, event: StreamRecord): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class DelayedCloseSocket extends ControlledSocket {
  closeRequests = 0;
  terminations = 0;

  override close(): void {
    this.closeRequests += 1;
  }

  finishClose(): void {
    super.close(1000, "closed");
  }

  terminate(): void {
    this.terminations += 1;
    this.finishClose();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function clearProxyEnvironment(): void {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]) vi.stubEnv(name, undefined);
}

async function ignoredClosePeer() {
  const server = createServer();
  const peers = new Set<Duplex>();
  let closeFrames = 0;
  server.on("connection", (socket) => {
    peers.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => peers.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        let size = pending[1]! & 0x7f;
        let offset = 2;
        if (size === 126) {
          if (pending.length < 4) return;
          size = pending.readUInt16BE(2);
          offset = 4;
        } else if (size === 127) {
          if (pending.length < 10) return;
          size = Number(pending.readBigUInt64BE(2));
          offset = 10;
        }
        if (pending[1]! & 0x80) offset += 4;
        if (pending.length < offset + size) return;
        if ((pending[0]! & 0x0f) === 8) closeFrames += 1;
        pending = pending.subarray(offset + size);
      }
      // Deliberately send no frames, including no reply to the closing handshake.
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`,
    get closeFrames() { return closeFrames; },
    async close() {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function tunnelProxy(targetUrl: string) {
  const server = createServer();
  const peers = new Set<Duplex>();
  const target = new URL(targetUrl);
  const track = (socket: Duplex) => {
    peers.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => peers.delete(socket));
  };
  server.on("connection", track);
  server.on("connect", (_request, socket, head) => {
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
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function runCollectorChild(script: string, onSpawn?: (child: ChildProcess) => void, environment: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { NO_PROXY: "*", ...environment },
    stdio: onSpawn ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let forced = false;
  child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const timeout = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 2_000);
  try {
    onSpawn?.(child);
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

describe("public collector streams", () => {
  test("keeps token shards stable while adding and removing subscriptions", async () => {
    const sink = new MemorySink();
    const sockets: Array<{ url: string; socket: ControlledSocket }> = [];
    const streams = createPublicStreams({
      journal: sink,
      maxTokensPerSocket: 2,
      reconnectDelayMs: 50,
      socketFactory: (url) => {
        const socket = new ControlledSocket();
        sockets.push({ url, socket });
        return socket;
      },
      connectSports: false
    });

    await streams.start(["a", "b", "c"]);
    expect(sockets.map((item) => item.url)).toEqual([
      "wss://ws-subscriptions-clob.polymarket.com/ws/market",
      "wss://ws-subscriptions-clob.polymarket.com/ws/market"
    ]);
    sockets[0]!.socket.open();
    sockets[1]!.socket.open();
    expect(sockets[0]!.socket.sent).toEqual([JSON.stringify({ assets_ids: ["a", "b"], type: "market", custom_feature_enabled: true })]);
    expect(sockets[1]!.socket.sent).toEqual([JSON.stringify({ assets_ids: ["c"], type: "market", custom_feature_enabled: true })]);

    await streams.setTokens(["a", "b", "c", "d"]);
    expect(sockets[0]!.socket.sent).toHaveLength(1);
    expect(sockets[1]!.socket.sent).toHaveLength(2);
    expect(JSON.parse(sockets[1]!.socket.sent[1]!)).toEqual({ assets_ids: ["d"], operation: "subscribe" });

    await streams.setTokens(["a", "c", "d", "e"]);
    expect(JSON.parse(sockets[0]!.socket.sent[1]!)).toEqual({ assets_ids: ["b"], operation: "unsubscribe" });
    expect(JSON.parse(sockets[0]!.socket.sent[2]!)).toEqual({ assets_ids: ["e"], operation: "subscribe" });
    expect(sockets[1]!.socket.sent).toHaveLength(2);
    await streams.stop();
  });

  test("records raw frames before handling sports and CLOB heartbeat protocols", async () => {
    vi.useFakeTimers();
    try {
      const sink = new MemorySink();
      const sockets: Array<{ url: string; socket: ControlledSocket }> = [];
      const seen: string[] = [];
      const streams = createPublicStreams({
        journal: sink,
        heartbeatIntervalMs: 10,
        socketFactory: (url) => {
          const socket = new ControlledSocket();
          sockets.push({ url, socket });
          return socket;
        },
        onFrame: ({ frame }) => {
          seen.push(frame);
        }
      });

      await streams.start(["token"]);
      const clob = sockets.find((item) => item.url.includes("clob"))!.socket;
      const sports = sockets.find((item) => item.url.includes("sports"))!.socket;
      clob.open();
      sports.open();
      vi.advanceTimersByTime(10);
      expect(clob.sent).toContain("PING");

      sports.message("ping");
      sports.message(JSON.stringify({ type: "update", score: "1-0" }));
      expect(sports.sent).toContain("pong");
      expect(seen).toEqual(["ping", JSON.stringify({ type: "update", score: "1-0" })]);
      expect(sink.records.filter((record) => record.kind === "ws_message").map((record) => record.data)).toEqual([
        "ping",
        JSON.stringify({ type: "update", score: "1-0" })
      ]);
      await streams.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test("reconnects a closed shard with a new connection epoch and resubscribes", async () => {
    vi.useFakeTimers();
    try {
      const sink = new MemorySink();
      const sockets: ControlledSocket[] = [];
      const streams = createPublicStreams({
        journal: sink,
        connectSports: false,
        reconnectDelayMs: 5,
        socketFactory: () => {
          const socket = new ControlledSocket();
          sockets.push(socket);
          return socket;
        }
      });
      await streams.start(["token"]);
      sockets[0]!.open();
      sockets[0]!.close(1006, "network");
      vi.advanceTimersByTime(5);
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      expect(sockets[1]!.sent[0]).toContain("token");
      const connections = sink.records
        .filter((record) => record.kind === "connection_open")
        .map((record) => record.connectionId);
      expect(connections).toEqual(["clob-0-e1", "clob-0-e2"]);
      await streams.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each(["clob", "sports"] as const)("times out a %s socket that never opens and records the gap", async (source) => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    const sockets: ControlledSocket[] = [];
    const streams = createPublicStreams({
      journal: sink,
      connectSports: source === "sports",
      openTimeoutMs: 20,
      reconnectDelayMs: 5,
      socketFactory: () => { const socket = new ControlledSocket(); sockets.push(socket); return socket; }
    });
    await streams.start(source === "clob" ? ["token"] : []);
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(sink.records).toContainEqual(expect.objectContaining({
        kind: "connection_gap", connectionId: `${source}-0-e1`, data: expect.objectContaining({ reason: "opening_timeout" })
      }));
      await vi.advanceTimersByTimeAsync(5);
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      expect(streams.activeConnectionIds).toEqual([`${source}-0-e2`]);
    } finally {
      await streams.stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(["clob", "sports"] as const)("reconnects a %s socket that stays open but receives no frames", async (source) => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    const sockets: ControlledSocket[] = [];
    const streams = createPublicStreams({
      journal: sink,
      connectSports: source === "sports",
      heartbeatIntervalMs: 10,
      inboundTimeoutMs: 30,
      reconnectDelayMs: 5,
      socketFactory: () => { const socket = new ControlledSocket(); sockets.push(socket); return socket; }
    });
    await streams.start(source === "clob" ? ["token"] : []);
    sockets[0]!.open();
    try {
      await vi.advanceTimersByTimeAsync(29);
      expect(streams.activeConnectionIds).toEqual([`${source}-0-e1`]);
      if (source === "clob") expect(sockets[0]!.sent.filter((frame) => frame === "PING")).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(streams.activeConnectionIds).toEqual([]);
      expect(sink.records).toContainEqual(expect.objectContaining({
        kind: "connection_gap", connectionId: `${source}-0-e1`, data: expect.objectContaining({ reason: "inbound_timeout" })
      }));
      await vi.advanceTimersByTimeAsync(5);
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      expect(streams.activeConnectionIds).toEqual([`${source}-0-e2`]);
      if (source === "clob") expect(JSON.parse(sockets[1]!.sent[0]!)).toMatchObject({ assets_ids: ["token"] });
      sockets[0]!.message("stale frame");
      expect(sink.records.filter((record) => record.kind === "ws_message")).toHaveLength(0);
    } finally {
      await streams.stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each(["clob", "sports"] as const)("resets the %s silence deadline only when an inbound frame arrives", async (source) => {
    vi.useFakeTimers();
    const socket = new ControlledSocket();
    const streams = createPublicStreams({
      journal: new MemorySink(), connectSports: source === "sports", heartbeatIntervalMs: 10, inboundTimeoutMs: 30,
      socketFactory: () => socket, autoReconnect: false
    });
    await streams.start(source === "clob" ? ["token"] : []);
    socket.open();
    try {
      await vi.advanceTimersByTimeAsync(20);
      socket.message(source === "clob" ? "PONG" : "ping");
      await vi.advanceTimersByTimeAsync(20);
      expect(streams.activeConnectionIds).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(streams.activeConnectionIds).toEqual([]);
    } finally {
      await streams.stop();
    }
  });

  test("bounds exponential reconnect delays for repeated failed opening attempts", async () => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    const attempts = vi.fn(() => { throw new Error("unreachable"); });
    const streams = createPublicStreams({ journal: sink, connectSports: false, reconnectDelayMs: 5, maxReconnectDelayMs: 20, socketFactory: attempts });
    await streams.start(["token"]);
    try {
      expect(attempts).toHaveBeenCalledTimes(1);
      for (const [delay, count] of [[5, 2], [10, 3], [20, 4], [20, 5]]) {
        await vi.advanceTimersByTimeAsync(delay! - 1);
        expect(attempts).toHaveBeenCalledTimes(count! - 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(attempts).toHaveBeenCalledTimes(count!);
      }
      const gaps = sink.records.filter((record) => record.kind === "connection_gap");
      expect(gaps).toHaveLength(5);
      expect(new Set(gaps.map((record) => record.connectionId)).size).toBe(5);
    } finally {
      await streams.stop();
    }
  });

  test("keeps backing off when handshakes succeed but every connection remains silent", async () => {
    vi.useFakeTimers();
    const sockets: ControlledSocket[] = [];
    const streams = createPublicStreams({
      journal: new MemorySink(), connectSports: false, inboundTimeoutMs: 10, reconnectDelayMs: 5, maxReconnectDelayMs: 20,
      socketFactory: () => { const socket = new ControlledSocket(); sockets.push(socket); return socket; }
    });
    await streams.start(["token"]);
    sockets[0]!.open();
    try {
      await vi.advanceTimersByTimeAsync(15);
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      await vi.advanceTimersByTimeAsync(19);
      expect(sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(3);
      sockets[2]!.open();
      sockets[2]!.message("PONG");
      await vi.advanceTimersByTimeAsync(15);
      expect(sockets).toHaveLength(4);
    } finally {
      await streams.stop();
    }
  });

  test("does not reuse sports connection epochs after stopping and restarting", async () => {
    const sink = new MemorySink();
    const sockets: ControlledSocket[] = [];
    const streams = createPublicStreams({ journal: sink, socketFactory: () => { const socket = new ControlledSocket(); sockets.push(socket); return socket; } });
    await streams.start();
    sockets[0]!.open();
    await streams.stop();
    await streams.start();
    sockets[1]!.open();
    await streams.stop();
    expect(sink.records.filter((record) => record.kind === "connection_open").map((record) => record.connectionId)).toEqual(["sports-0-e1", "sports-0-e2"]);
  });

  test("waits for a socket close event and closes only once across concurrent stops", async () => {
    vi.useFakeTimers();
    const socket = new DelayedCloseSocket();
    const streams = createPublicStreams({ journal: new MemorySink(), connectSports: false, closeTimeoutMs: 20, socketFactory: () => socket });
    await streams.start(["token"]);
    socket.open();
    let stopped = false;
    const first = streams.stop().then(() => { stopped = true; });
    const second = streams.stop();
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(stopped).toBe(false);
      expect(socket.closeRequests).toBe(1);
      socket.finishClose();
      await Promise.all([first, second]);
      expect(stopped).toBe(true);
      expect(socket.terminations).toBe(0);
    } finally {
      socket.finishClose();
      await vi.advanceTimersByTimeAsync(40);
      await Promise.all([first, second]);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  test("forcibly terminates a socket whose peer ignores the close handshake", async () => {
    vi.useFakeTimers();
    const socket = new DelayedCloseSocket();
    const streams = createPublicStreams({ journal: new MemorySink(), connectSports: false, closeTimeoutMs: 20, socketFactory: () => socket });
    await streams.start(["token"]);
    socket.open();
    const stopped = streams.stop();
    await vi.advanceTimersByTimeAsync(20);
    await stopped;
    expect(socket.terminations).toBe(1);
    expect(streams.activeConnectionIds).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("reports a bounded shutdown failure for custom sockets that cannot confirm closure", async () => {
    vi.useFakeTimers();
    const socket = new ControlledSocket();
    vi.spyOn(socket, "close").mockImplementation(() => {});
    const streams = createPublicStreams({ journal: new MemorySink(), connectSports: false, closeTimeoutMs: 20, socketFactory: () => socket });
    await streams.start(["token"]);
    socket.open();
    const stopped = streams.stop().then(() => undefined, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);
    expect(await stopped).toMatchObject({ message: expect.stringContaining("STREAM_CLOSE_TIMEOUT") });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("does not create a sports socket when stop interrupts start", async () => {
    const socketFactory = vi.fn(() => new ControlledSocket());
    const streams = createPublicStreams({ journal: new MemorySink(), socketFactory });
    const starting = streams.start(["token"]);
    await streams.stop();
    await starting;
    expect(socketFactory).toHaveBeenCalledTimes(1);
    expect(streams.activeConnectionIds).toEqual([]);
  });

  test("does not restart sockets when a new stop arrives while restart awaits previous cleanup", async () => {
    const socketFactory = vi.fn(() => new ControlledSocket());
    const streams = createPublicStreams({ journal: new MemorySink(), connectSports: false, socketFactory });
    await streams.start(["token"]);
    await streams.stop();
    const restarting = streams.start(["token"]);
    await streams.stop();
    await restarting;
    try {
      expect(socketFactory).toHaveBeenCalledTimes(1);
    } finally {
      await streams.stop();
    }
  });

  test("rejects stop when custom resource cleanup rejects without an error value", async () => {
    const onFatal = vi.fn();
    const socket = Object.assign(new ControlledSocket(), { destroy: () => Promise.reject(undefined) });
    const streams = createPublicStreams({ journal: new MemorySink(), connectSports: false, socketFactory: () => socket, onFatal });
    await streams.start(["token"]);
    socket.open();
    await expect(streams.stop()).rejects.toThrow("STREAM_CLOSE_FAILED");
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(streams.error).toBeInstanceOf(Error);
  });

  test("waits for sockets already retiring after their last token was removed", async () => {
    vi.useFakeTimers();
    const socket = new DelayedCloseSocket();
    const streams = createPublicStreams({ journal: new MemorySink(), connectSports: false, closeTimeoutMs: 20, socketFactory: () => socket });
    await streams.start(["token"]);
    socket.open();
    await streams.setTokens([]);
    let stopped = false;
    const stopping = streams.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(10);
    try {
      expect(stopped).toBe(false);
      expect(socket.closeRequests).toBe(1);
    } finally {
      socket.finishClose();
      await stopping;
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  test("waits for owned resource destruction after the WebSocket has closed", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const resourcesClosed = new Promise<void>((resolve) => { release = resolve; });
    const socket = Object.assign(new ControlledSocket(), { destroy: vi.fn(() => resourcesClosed) });
    const streams = createPublicStreams({ journal: new MemorySink(), connectSports: false, closeTimeoutMs: 20, socketFactory: () => socket });
    await streams.start(["token"]);
    socket.open();
    let stopped = false;
    const stopping = streams.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(10);
    try {
      expect(stopped).toBe(false);
      expect(socket.destroy).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await stopping;
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  test("does not report successful shutdown when forced termination fails to close the socket", async () => {
    vi.useFakeTimers();
    const socket = new DelayedCloseSocket();
    vi.spyOn(socket, "terminate").mockImplementation(() => {});
    const streams = createPublicStreams({ journal: new MemorySink(), connectSports: false, closeTimeoutMs: 20, socketFactory: () => socket });
    await streams.start(["token"]);
    socket.open();
    const stopping = streams.stop().then(() => undefined, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(40);
    expect(await stopping).toMatchObject({ message: expect.stringContaining("STREAM_CLOSE_TIMEOUT") });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("records forced closure before teardown and ignores late activity from the retired epoch", async () => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    const retired = new DelayedCloseSocket();
    const replacement = new ControlledSocket();
    let recordedBeforeTeardown = false;
    vi.spyOn(retired, "terminate").mockImplementation(() => {
      recordedBeforeTeardown = sink.records.some((record) => record.kind === "connection_close" && record.connectionId === "clob-0-e1");
      retired.open();
      retired.message("stale");
      retired.finishClose();
    });
    const socketFactory = vi.fn<() => CollectorSocket>().mockReturnValueOnce(retired).mockReturnValue(replacement);
    const streams = createPublicStreams({
      journal: sink, connectSports: false, inboundTimeoutMs: 10, closeTimeoutMs: 20, reconnectDelayMs: 5, socketFactory
    });
    await streams.start(["token"]);
    retired.open();
    try {
      await vi.advanceTimersByTimeAsync(15);
      replacement.open();
      await vi.advanceTimersByTimeAsync(9);
      replacement.message("fresh");
      await vi.advanceTimersByTimeAsync(6);
      expect(recordedBeforeTeardown).toBe(true);
      expect(streams.activeConnectionIds).toEqual(["clob-0-e2"]);
      expect(sink.records.filter((record) => record.kind === "ws_message").map((record) => record.data)).toEqual(["fresh"]);
      expect(sink.records.filter((record) => record.kind === "connection_close")).toEqual([
        expect.objectContaining({ connectionId: "clob-0-e1", data: expect.objectContaining({ forced: true }) })
      ]);
    } finally {
      await streams.stop();
    }
  });

  test.each(["direct", "HTTP_PROXY", "explicit"] as const)("lets a child process exit naturally when the %s transport peer ignores close", async (mode) => {
    const peer = await ignoredClosePeer();
    const proxy = mode === "direct" ? undefined : await tunnelProxy(peer.url);
    const script = `
      import { createPublicStreams } from './src/collector/streams.ts';
      let opened;
      const ready = new Promise(resolve => { opened = resolve; });
      const streams = createPublicStreams({
        journal: { record(record) { if (record.kind === 'connection_open') opened(); } },
        clobUrl: ${JSON.stringify(peer.url)}, connectSports: false, autoReconnect: false, closeTimeoutMs: 50,
        ${mode === "explicit" ? `proxyUrl: ${JSON.stringify(proxy!.url)}` : ""}
      });
      await streams.start(['token']);
      await ready;
      await streams.stop();
      process.stdout.write('STOPPED\\n');
    `;
    try {
      const { stdout, stderr, ...result } = await runCollectorChild(script, undefined,
        mode === "HTTP_PROXY" ? { HTTP_PROXY: proxy!.url, NO_PROXY: "" } : {});
      expect(stdout, stderr).toContain("STOPPED");
      expect(peer.closeFrames).toBe(1);
      expect(result, stderr).toEqual({ forced: false, code: 0, signal: null });
    } finally {
      await proxy?.close();
      await peer.close();
    }
  }, 5_000);

  test.each(["direct TLS", "proxy TLS"] as const)("closes a child process during an unfinished %s handshake", async (mode) => {
    const peers = new Set<Duplex>();
    let receivedHello!: () => void;
    const hello = new Promise<void>((resolve) => { receivedHello = resolve; });
    const server = mode === "direct TLS" ? createTcpServer() : createServer();
    server.on("connection", (socket) => {
      peers.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => peers.delete(socket));
      if (mode === "direct TLS") socket.once("data", receivedHello);
    });
    if (mode === "proxy TLS") {
      server.on("connect", (_request, socket: Duplex) => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.once("data", receivedHello);
      });
    }
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    const script = `
      import { createPublicStreams } from './src/collector/streams.ts';
      const stopRequested = new Promise(resolve => process.once('message', resolve));
      const streams = createPublicStreams({
        journal: { record() {} }, clobUrl: ${JSON.stringify(`wss://${address}/ws`)},
        ${mode === "proxy TLS" ? `proxyUrl: ${JSON.stringify(`http://${address}`)},` : ""}
        connectSports: false, autoReconnect: false, closeTimeoutMs: 50
      });
      await streams.start(['token']);
      await stopRequested;
      await streams.stop();
      process.stdout.write('STOPPED\\n');
      process.disconnect();
    `;
    try {
      const { stdout, stderr, ...result } = await runCollectorChild(script, (child) => {
        void hello.then(() => { if (child.connected) child.send("stop"); });
      });
      expect(stdout, stderr).toContain("STOPPED");
      expect(result, stderr).toEqual({ forced: false, code: 0, signal: null });
    } finally {
      for (const socket of peers) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 5_000);

  test.each(["HTTP_PROXY", "HTTPS_PROXY", "explicit"] as const)("uses %s for the default WebSocket transport", async (setting) => {
    clearProxyEnvironment();
    const proxy = createServer();
    const peers = new Set<Duplex>();
    const targets: string[] = [];
    proxy.on("connection", (socket) => {
      peers.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => peers.delete(socket));
    });
    proxy.on("connect", (request, socket) => {
      targets.push(request.url!);
      socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const target = `127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const proxyUrl = `http://${target}`;
    if (setting !== "explicit") vi.stubEnv(setting, proxyUrl);
    else {
      vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
      vi.stubEnv("NO_PROXY", "*");
    }
    const streams = createPublicStreams({
      journal: new MemorySink(), clobUrl: `${setting === "HTTPS_PROXY" ? "wss" : "ws"}://${target}/ws`,
      connectSports: false, autoReconnect: false, closeTimeoutMs: 50,
      ...(setting === "explicit" ? { proxyUrl } : {})
    });
    try {
      await streams.start(["token"]);
      await expect.poll(() => targets, { timeout: 500, interval: 10 }).toEqual([target]);
    } finally {
      await streams.stop();
      for (const socket of peers) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  test.each(["explicit", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] as const)(
    "rejects unsupported %s proxy protocols before streams can start", (setting) => {
      clearProxyEnvironment();
      const proxyUrl = "socks5://127.0.0.1:1080";
      if (setting !== "explicit") vi.stubEnv(setting, proxyUrl);
      expect(() => createPublicStreams({ journal: new MemorySink(), ...(setting === "explicit" ? { proxyUrl } : {}) }))
        .toThrow("UNSUPPORTED_PROXY_PROTOCOL");
    }
  );

  test("rejects a SOCKS proxy before its greeting and lets a child exit naturally", async () => {
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
      import { createPublicStreams } from './src/collector/streams.ts';
      try {
        const streams = createPublicStreams({
          journal: { record() {} }, clobUrl: ${JSON.stringify(`wss://${address}/ws`)},
          proxyUrl: ${JSON.stringify(`socks5://${address}`)}, connectSports: false, autoReconnect: false, closeTimeoutMs: 50
        });
        await streams.start(['token']);
        await new Promise(resolve => setTimeout(resolve, 75));
        await streams.stop();
        process.stdout.write('UNEXPECTED_SUCCESS\\n');
      } catch (error) {
        process.stdout.write(error.message + '\\n');
      }
    `;
    try {
      const { stdout, stderr, ...result } = await runCollectorChild(script);
      expect(stdout, stderr).toContain("UNSUPPORTED_PROXY_PROTOCOL");
      expect(connections).toBe(0);
      expect(result, stderr).toEqual({ forced: false, code: 0, signal: null });
    } finally {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 5_000);
});
