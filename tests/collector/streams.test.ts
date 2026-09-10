import { describe, expect, test, vi } from "vitest";
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
});
