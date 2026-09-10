import { ProxyAgent, WebSocket } from "undici";
import type { RecordSink } from "./types.js";

export interface StreamRecord {
  data?: unknown;
  code?: number;
  reason?: string;
  error?: unknown;
}

export interface CollectorSocket {
  addEventListener(type: string, listener: (event: StreamRecord) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface StreamFrame {
  source: "clob" | "sports";
  connectionId: string;
  frame: string;
}

export interface StreamTimerApi {
  setTimeout(handler: () => void, timeoutMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(handler: () => void, timeoutMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface PublicStreamsOptions {
  journal: RecordSink;
  clobUrl?: string;
  sportsUrl?: string;
  proxyUrl?: string;
  maxTokensPerSocket?: number;
  heartbeatIntervalMs?: number;
  reconnectDelayMs?: number | ((attempt: number) => number);
  autoReconnect?: boolean;
  connectSports?: boolean;
  socketFactory?: (url: string) => CollectorSocket;
  timers?: StreamTimerApi;
  onFrame?: (frame: StreamFrame) => Promise<void> | void;
  onError?: (error: unknown) => void;
  onFatal?: (error: unknown) => void;
}

interface ChannelState {
  source: "clob" | "sports";
  id: number;
  tokens: Set<string>;
  epoch: number;
  reconnectAttempt: number;
  socket: CollectorSocket | undefined;
  connectionId: string | undefined;
  open: boolean;
  heartbeat: unknown | undefined;
  reconnectTimer: unknown | undefined;
  disposed: boolean;
}

const DEFAULT_CLOB_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const DEFAULT_SPORTS_URL = "wss://sports-api.polymarket.com/ws";

const defaultTimers: StreamTimerApi = {
  setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (handler, timeoutMs) => setInterval(handler, timeoutMs),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout)
};

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function frameText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return null;
}

function isJsonHeartbeat(frame: string): boolean {
  try {
    const parsed = JSON.parse(frame) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const value = parsed as Record<string, unknown>;
    return value.type === "ping" || value.event === "ping" || value.action === "ping";
  } catch {
    return false;
  }
}

function normalizeTokens(tokens: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const token of tokens) {
    if (typeof token !== "string" || token.trim().length === 0) continue;
    normalized.add(token.trim());
  }
  return [...normalized];
}

function defaultSocketFactory(proxyUrl: string | undefined): (url: string) => CollectorSocket {
  return (url) => {
    const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
    return new WebSocket(url, dispatcher ? { dispatcher } : undefined) as unknown as CollectorSocket;
  };
}

export class PublicStreams {
  private readonly journal: RecordSink;
  private readonly clobUrl: string;
  private readonly sportsUrl: string;
  private readonly maxTokensPerSocket: number;
  private readonly heartbeatIntervalMs: number;
  private readonly reconnectDelayMs: number | ((attempt: number) => number);
  private readonly autoReconnect: boolean;
  private readonly connectSports: boolean;
  private readonly socketFactory: (url: string) => CollectorSocket;
  private readonly timers: StreamTimerApi;
  private readonly onFrame: ((frame: StreamFrame) => Promise<void> | void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly onFatal: ((error: unknown) => void) | undefined;
  private readonly shards: ChannelState[] = [];
  private readonly tokenShard = new Map<string, ChannelState>();
  private nextShardId = 0;
  private sportsChannel: ChannelState | undefined;
  private started = false;
  private stopping = false;
  private fatalError: unknown;

  constructor(options: PublicStreamsOptions) {
    this.journal = options.journal;
    this.clobUrl = options.clobUrl ?? DEFAULT_CLOB_URL;
    this.sportsUrl = options.sportsUrl ?? DEFAULT_SPORTS_URL;
    this.maxTokensPerSocket = positiveInteger(options.maxTokensPerSocket, 200, "maxTokensPerSocket");
    this.heartbeatIntervalMs = positiveInteger(options.heartbeatIntervalMs, 10_000, "heartbeatIntervalMs");
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.autoReconnect = options.autoReconnect ?? true;
    this.connectSports = options.connectSports ?? true;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory(options.proxyUrl);
    this.timers = options.timers ?? defaultTimers;
    this.onFrame = options.onFrame;
    this.onError = options.onError;
    this.onFatal = options.onFatal;
  }

  async start(tokens: readonly string[] = []): Promise<void> {
    if (this.started) {
      await this.setTokens(tokens);
      return;
    }
    this.started = true;
    this.stopping = false;
    await this.setTokens(tokens);
    if (this.connectSports) {
      const channel = this.createChannel("sports", 0);
      this.sportsChannel = channel;
      this.connect(channel);
    }
  }

  async setTokens(tokens: readonly string[]): Promise<void> {
    if (!this.started) throw new Error("STREAMS_NOT_STARTED");
    if (this.fatalError) throw new Error("STREAMS_FATAL", { cause: this.fatalError });
    const wanted = new Set(normalizeTokens(tokens));

    for (const [token, channel] of [...this.tokenShard.entries()]) {
      if (!wanted.has(token)) {
        this.tokenShard.delete(token);
        channel.tokens.delete(token);
        if (channel.open) this.sendSubscription(channel, "unsubscribe", [token]);
      }
    }

    for (const token of wanted) {
      if (this.tokenShard.has(token)) continue;
      const existing = this.shards.find((candidate) => !candidate.disposed && candidate.tokens.size < this.maxTokensPerSocket);
      const channel = existing ?? this.createChannel("clob", this.nextShardId++);
      channel.tokens.add(token);
      this.tokenShard.set(token, channel);
      if (!existing) this.connect(channel);
      if (channel.open) this.sendSubscription(channel, "subscribe", [token]);
    }

    for (const channel of [...this.shards]) {
      if (channel.tokens.size === 0) this.disposeChannel(channel);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.started = false;
    for (const channel of [...this.shards]) this.disposeChannel(channel);
    if (this.sportsChannel) this.disposeChannel(this.sportsChannel);
    this.sportsChannel = undefined;
    this.tokenShard.clear();
  }

  get activeConnectionIds(): string[] {
    return [...this.shards, ...(this.sportsChannel ? [this.sportsChannel] : [])]
      .filter((channel) => channel.open && channel.connectionId !== undefined)
      .map((channel) => channel.connectionId!);
  }

  get error(): unknown {
    return this.fatalError;
  }

  private createChannel(source: "clob" | "sports", id: number): ChannelState {
    const channel: ChannelState = {
      source,
      id,
      tokens: new Set<string>(),
      epoch: 0,
      reconnectAttempt: 0,
      socket: undefined,
      connectionId: undefined,
      open: false,
      heartbeat: undefined,
      reconnectTimer: undefined,
      disposed: false
    };
    if (source === "clob") this.shards.push(channel);
    return channel;
  }

  private connect(channel: ChannelState): void {
    if (channel.disposed || !this.started || this.fatalError) return;
    channel.epoch += 1;
    channel.connectionId = `${channel.source}-${channel.id}-e${channel.epoch}`;
    channel.open = false;
    let socket: CollectorSocket;
    try {
      socket = this.socketFactory(channel.source === "clob" ? this.clobUrl : this.sportsUrl);
    } catch (error) {
      this.reportError(error);
      this.scheduleReconnect(channel);
      return;
    }
    channel.socket = socket;
    socket.addEventListener("open", () => this.handleOpen(channel, socket));
    socket.addEventListener("message", (event) => this.handleMessage(channel, socket, event.data));
    socket.addEventListener("close", (event) => this.handleClose(channel, socket, event));
    socket.addEventListener("error", (event) => this.handleSocketError(channel, socket, event.error));
  }

  private handleOpen(channel: ChannelState, socket: CollectorSocket): void {
    if (!this.isCurrent(channel, socket)) return;
    channel.open = true;
    channel.reconnectAttempt = 0;
    this.safeRecord({
      source: "collector",
      kind: "connection_open",
      connectionId: channel.connectionId!,
      data: { source: channel.source, url: channel.source === "clob" ? this.clobUrl : this.sportsUrl, epoch: channel.epoch }
    });
    if (channel.source === "clob") {
      this.sendSubscription(channel, "initial", [...channel.tokens]);
      channel.heartbeat = this.timers.setInterval(() => {
        if (!channel.open || !channel.socket) return;
        this.safeRecord({ source: "collector", kind: "heartbeat", connectionId: channel.connectionId!, data: "PING" });
        try {
          channel.socket.send("PING");
        } catch (error) {
          this.reportError(error);
        }
      }, this.heartbeatIntervalMs);
    }
  }

  private handleMessage(channel: ChannelState, socket: CollectorSocket, data: unknown): void {
    if (!this.isCurrent(channel, socket)) return;
    const frame = frameText(data);
    if (frame === null) return;
    if (!this.safeRecord({ source: channel.source, kind: "ws_message", connectionId: channel.connectionId!, data: frame })) return;
    const callback = this.onFrame;
    if (callback) {
      void Promise.resolve(callback({ source: channel.source, connectionId: channel.connectionId!, frame })).catch((error: unknown) => this.reportError(error));
    }
    if (channel.source === "sports" && (frame.toLowerCase() === "ping" || isJsonHeartbeat(frame))) {
      try {
        channel.socket?.send(frame.toLowerCase() === "ping" ? "pong" : JSON.stringify({ type: "pong" }));
      } catch (error) {
        this.reportError(error);
      }
    }
  }

  private handleClose(channel: ChannelState, socket: CollectorSocket, event: StreamRecord): void {
    if (!this.isCurrent(channel, socket)) return;
    channel.open = false;
    this.clearHeartbeat(channel);
    this.safeRecord({
      source: "collector",
      kind: "connection_close",
      connectionId: channel.connectionId!,
      data: { code: event.code, reason: event.reason }
    });
    channel.socket = undefined;
    if (this.started && this.autoReconnect && !channel.disposed && (channel.source === "sports" || channel.tokens.size > 0)) {
      this.scheduleReconnect(channel);
    }
  }

  private handleSocketError(channel: ChannelState, socket: CollectorSocket, error: unknown): void {
    if (!this.isCurrent(channel, socket)) return;
    this.safeRecord({ source: "collector", kind: "socket_error", connectionId: channel.connectionId!, data: error });
    this.reportError(error);
  }

  private sendSubscription(channel: ChannelState, operation: "initial" | "subscribe" | "unsubscribe", tokens: string[]): void {
    if (!channel.socket || !channel.open || tokens.length === 0) return;
    const payload = operation === "initial"
      ? { assets_ids: tokens, type: "market", custom_feature_enabled: true }
      : { assets_ids: tokens, operation };
    if (!this.safeRecord({ source: "collector", kind: "subscription", connectionId: channel.connectionId!, data: payload })) return;
    try {
      channel.socket.send(JSON.stringify(payload));
    } catch (error) {
      this.reportError(error);
    }
  }

  private scheduleReconnect(channel: ChannelState): void {
    if (channel.reconnectTimer !== undefined || channel.disposed || !this.started || !this.autoReconnect) return;
    channel.reconnectAttempt += 1;
    const configured = typeof this.reconnectDelayMs === "function"
      ? this.reconnectDelayMs(channel.reconnectAttempt)
      : this.reconnectDelayMs;
    const delay = Number.isFinite(configured) && configured >= 0 ? configured : 1_000;
    channel.reconnectTimer = this.timers.setTimeout(() => {
      channel.reconnectTimer = undefined;
      this.connect(channel);
    }, delay);
  }

  private disposeChannel(channel: ChannelState): void {
    if (channel.disposed) return;
    channel.disposed = true;
    this.clearHeartbeat(channel);
    if (channel.reconnectTimer !== undefined) {
      this.timers.clearTimeout(channel.reconnectTimer);
      channel.reconnectTimer = undefined;
    }
    const socket = channel.socket;
    channel.socket = undefined;
    channel.open = false;
    if (socket) {
      try {
        socket.close(1000, "collector stopping");
      } catch (error) {
        this.reportError(error);
      }
    }
    const index = this.shards.indexOf(channel);
    if (index >= 0) this.shards.splice(index, 1);
  }

  private clearHeartbeat(channel: ChannelState): void {
    if (channel.heartbeat !== undefined) {
      this.timers.clearInterval(channel.heartbeat);
      channel.heartbeat = undefined;
    }
  }

  private isCurrent(channel: ChannelState, socket: CollectorSocket): boolean {
    return !channel.disposed && channel.socket === socket && channel.connectionId !== undefined;
  }

  private safeRecord(input: Parameters<RecordSink["record"]>[0]): boolean {
    try {
      this.journal.record(input);
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // An observer must not break WebSocket callbacks.
    }
  }

  private fail(error: unknown): void {
    if (this.fatalError) return;
    this.fatalError = error;
    try {
      this.onFatal?.(error);
    } catch {
      // Keep the original storage error available through the public state.
    }
  }
}

export function createPublicStreams(options: PublicStreamsOptions): PublicStreams {
  return new PublicStreams(options);
}
