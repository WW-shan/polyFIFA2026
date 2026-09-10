import { WebSocket } from "undici";
import { createOwnedTransport, validateProxyConfiguration } from "../polymarket/owned-transport.js";
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
  /** Force the transport closed; implementations must still emit close. */
  terminate?(): Promise<void> | void;
  /** Tear down the transport and release any owned dispatcher resources. */
  destroy?(): Promise<void> | void;
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
  openTimeoutMs?: number;
  inboundTimeoutMs?: number;
  closeTimeoutMs?: number;
  reconnectDelayMs?: number | ((attempt: number) => number);
  maxReconnectDelayMs?: number;
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
  connection: SocketConnection | undefined;
  connectionId: string | undefined;
  open: boolean;
  heartbeat: unknown | undefined;
  watchdog: unknown | undefined;
  reconnectTimer: unknown | undefined;
  disposed: boolean;
}

interface SocketConnection {
  socket: CollectorSocket;
  id: string;
  closed: boolean;
  closeRecorded: boolean;
  closedPromise: Promise<void>;
  resolveClosed: () => void;
  shutdownPromise?: Promise<void>;
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

function defaultSocketFactory(proxyUrl: string | undefined, connectTimeout: number): (url: string) => CollectorSocket {
  validateProxyConfiguration(proxyUrl);
  return (url) => {
    const transport = createOwnedTransport({ proxyUrl, connectTimeoutMs: connectTimeout });
    let socket: InstanceType<typeof WebSocket>;
    try {
      socket = new WebSocket(url, { dispatcher: transport.dispatcher });
      socket.binaryType = "arraybuffer";
    } catch (error) {
      void transport.destroy().catch(() => {});
      throw error;
    }
    return {
      addEventListener: (type, listener) => socket.addEventListener(type, (event) => listener(event as StreamRecord)),
      send: (data) => socket.send(data),
      close: (code, reason) => socket.close(code, reason),
      destroy() {
        if (socket.readyState === WebSocket.CONNECTING) socket.close();
        return transport.destroy();
      }
    };
  };
}

export class PublicStreams {
  private readonly journal: RecordSink;
  private readonly clobUrl: string;
  private readonly sportsUrl: string;
  private readonly maxTokensPerSocket: number;
  private readonly heartbeatIntervalMs: number;
  private readonly openTimeoutMs: number;
  private readonly inboundTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly reconnectDelayMs: number | ((attempt: number) => number);
  private readonly maxReconnectDelayMs: number;
  private readonly autoReconnect: boolean;
  private readonly connectSports: boolean;
  private readonly socketFactory: (url: string) => CollectorSocket;
  private readonly timers: StreamTimerApi;
  private readonly onFrame: ((frame: StreamFrame) => Promise<void> | void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly onFatal: ((error: unknown) => void) | undefined;
  private readonly shards: ChannelState[] = [];
  private readonly tokenShard = new Map<string, ChannelState>();
  private readonly epochs = new Map<string, number>();
  private readonly pendingClosures = new Set<Promise<void>>();
  private nextShardId = 0;
  private sportsChannel: ChannelState | undefined;
  private started = false;
  private stopping = false;
  private lifecycle = 0;
  private stopPromise: Promise<void> | undefined;
  private closeError: unknown;
  private fatalError: unknown;

  constructor(options: PublicStreamsOptions) {
    this.journal = options.journal;
    this.clobUrl = options.clobUrl ?? DEFAULT_CLOB_URL;
    this.sportsUrl = options.sportsUrl ?? DEFAULT_SPORTS_URL;
    this.maxTokensPerSocket = positiveInteger(options.maxTokensPerSocket, 200, "maxTokensPerSocket");
    this.heartbeatIntervalMs = positiveInteger(options.heartbeatIntervalMs, 10_000, "heartbeatIntervalMs");
    this.openTimeoutMs = positiveInteger(options.openTimeoutMs, 10_000, "openTimeoutMs");
    this.inboundTimeoutMs = positiveInteger(options.inboundTimeoutMs, Math.max(30_000, this.heartbeatIntervalMs * 3), "inboundTimeoutMs");
    this.closeTimeoutMs = positiveInteger(options.closeTimeoutMs, 1_000, "closeTimeoutMs");
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.maxReconnectDelayMs = positiveInteger(options.maxReconnectDelayMs, 30_000, "maxReconnectDelayMs");
    this.autoReconnect = options.autoReconnect ?? true;
    this.connectSports = options.connectSports ?? true;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory(options.proxyUrl, this.openTimeoutMs);
    this.timers = options.timers ?? defaultTimers;
    this.onFrame = options.onFrame;
    this.onError = options.onError;
    this.onFatal = options.onFatal;
  }

  async start(tokens: readonly string[] = []): Promise<void> {
    const lifecycle = this.lifecycle;
    if (this.stopPromise) {
      await this.stopPromise;
      if (lifecycle !== this.lifecycle) return;
      this.stopPromise = undefined;
    }
    if (this.started) {
      await this.setTokens(tokens);
      return;
    }
    this.started = true;
    this.stopping = false;
    await this.setTokens(tokens);
    if (lifecycle !== this.lifecycle || !this.started || this.stopping) return;
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

  stop(): Promise<void> {
    this.lifecycle += 1;
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.started = false;
    for (const channel of [...this.shards]) this.disposeChannel(channel);
    if (this.sportsChannel) this.disposeChannel(this.sportsChannel);
    this.sportsChannel = undefined;
    this.tokenShard.clear();
    this.stopPromise = (async () => {
      while (this.pendingClosures.size > 0) await Promise.allSettled([...this.pendingClosures]);
      if (this.closeError !== undefined) throw this.closeError;
    })();
    return this.stopPromise;
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
      connection: undefined,
      connectionId: undefined,
      open: false,
      heartbeat: undefined,
      watchdog: undefined,
      reconnectTimer: undefined,
      disposed: false
    };
    if (source === "clob") this.shards.push(channel);
    return channel;
  }

  private connect(channel: ChannelState): void {
    if (channel.disposed || !this.started || this.fatalError) return;
    const key = `${channel.source}-${channel.id}`;
    channel.epoch = (this.epochs.get(key) ?? 0) + 1;
    this.epochs.set(key, channel.epoch);
    channel.connectionId = `${key}-e${channel.epoch}`;
    channel.open = false;
    let socket: CollectorSocket;
    try {
      socket = this.socketFactory(channel.source === "clob" ? this.clobUrl : this.sportsUrl);
    } catch (error) {
      this.recordGap(channel, "opening_error");
      this.reportError(error);
      this.scheduleReconnect(channel);
      return;
    }
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const connection: SocketConnection = { socket, id: channel.connectionId, closed: false, closeRecorded: false, closedPromise, resolveClosed };
    channel.connection = connection;
    socket.addEventListener("open", () => this.handleOpen(channel, connection));
    socket.addEventListener("message", (event) => this.handleMessage(channel, connection, event.data));
    socket.addEventListener("close", (event) => this.handleClose(channel, connection, event));
    socket.addEventListener("error", (event) => this.handleSocketError(channel, connection, event.error));
    this.armWatchdog(channel, connection, "opening_timeout", this.openTimeoutMs);
  }

  private handleOpen(channel: ChannelState, connection: SocketConnection): void {
    if (!this.isCurrent(channel, connection) || channel.open) return;
    channel.open = true;
    this.armWatchdog(channel, connection, "inbound_timeout", this.inboundTimeoutMs);
    if (!this.safeRecord({
      source: "collector",
      kind: "connection_open",
      connectionId: channel.connectionId!,
      data: { source: channel.source, url: channel.source === "clob" ? this.clobUrl : this.sportsUrl, epoch: channel.epoch }
    })) return;
    if (channel.source === "clob") {
      this.sendSubscription(channel, "initial", [...channel.tokens]);
      if (!this.isCurrent(channel, connection)) return;
      channel.heartbeat = this.timers.setInterval(() => {
        if (!this.isCurrent(channel, connection) || !channel.open) return;
        if (!this.safeRecord({ source: "collector", kind: "heartbeat", connectionId: connection.id, data: "PING" })) return;
        try {
          connection.socket.send("PING");
        } catch (error) {
          this.reportError(error);
          this.retireConnection(channel, connection, "heartbeat_error");
        }
      }, this.heartbeatIntervalMs);
    }
  }

  private handleMessage(channel: ChannelState, connection: SocketConnection, data: unknown): void {
    if (!this.isCurrent(channel, connection) || !channel.open) return;
    channel.reconnectAttempt = 0;
    this.armWatchdog(channel, connection, "inbound_timeout", this.inboundTimeoutMs);
    const frame = frameText(data);
    if (frame === null) return;
    if (!this.safeRecord({ source: channel.source, kind: "ws_message", connectionId: channel.connectionId!, data: frame })) return;
    const callback = this.onFrame;
    if (callback) {
      try {
        void Promise.resolve(callback({ source: channel.source, connectionId: connection.id, frame })).catch((error: unknown) => this.reportError(error));
      } catch (error) {
        this.reportError(error);
      }
    }
    if (channel.source === "sports" && (frame.toLowerCase() === "ping" || isJsonHeartbeat(frame))) {
      try {
        connection.socket.send(frame.toLowerCase() === "ping" ? "pong" : JSON.stringify({ type: "pong" }));
      } catch (error) {
        this.reportError(error);
        this.retireConnection(channel, connection, "heartbeat_error");
      }
    }
  }

  private handleClose(channel: ChannelState, connection: SocketConnection, event: StreamRecord): void {
    if (connection.closed) return;
    connection.closed = true;
    connection.resolveClosed();
    this.recordClose(connection, { code: event.code, reason: event.reason });
    this.releaseConnection(connection);
    if (!this.isCurrent(channel, connection)) return;
    this.retireConnection(channel, connection, "socket_close");
  }

  private handleSocketError(channel: ChannelState, connection: SocketConnection, error: unknown): void {
    if (!this.isCurrent(channel, connection)) return;
    this.safeRecord({ source: "collector", kind: "socket_error", connectionId: channel.connectionId!, data: error });
    this.reportError(error);
    this.retireConnection(channel, connection, "socket_error");
  }

  private sendSubscription(channel: ChannelState, operation: "initial" | "subscribe" | "unsubscribe", tokens: string[]): void {
    const connection = channel.connection;
    if (!connection || !channel.open || tokens.length === 0) return;
    const payload = operation === "initial"
      ? { assets_ids: tokens, type: "market", custom_feature_enabled: true }
      : { assets_ids: tokens, operation };
    if (!this.safeRecord({ source: "collector", kind: "subscription", connectionId: channel.connectionId!, data: payload })) return;
    try {
      connection.socket.send(JSON.stringify(payload));
    } catch (error) {
      this.reportError(error);
      this.retireConnection(channel, connection, "subscription_error");
    }
  }

  private scheduleReconnect(channel: ChannelState): void {
    if (channel.reconnectTimer !== undefined || channel.disposed || !this.started || !this.autoReconnect || this.fatalError) return;
    if (channel.source === "clob" && channel.tokens.size === 0) return;
    channel.reconnectAttempt += 1;
    let configured: number;
    try {
      configured = typeof this.reconnectDelayMs === "function"
        ? this.reconnectDelayMs(channel.reconnectAttempt)
        : this.reconnectDelayMs * 2 ** Math.min(channel.reconnectAttempt - 1, 30);
    } catch (error) {
      this.reportError(error);
      configured = 1_000;
    }
    const delay = Math.min(this.maxReconnectDelayMs, Number.isFinite(configured) && configured >= 0 ? configured : 1_000);
    channel.reconnectTimer = this.timers.setTimeout(() => {
      channel.reconnectTimer = undefined;
      this.connect(channel);
    }, delay);
  }

  private disposeChannel(channel: ChannelState): void {
    if (channel.disposed) return;
    channel.disposed = true;
    this.clearHeartbeat(channel);
    this.clearWatchdog(channel);
    if (channel.reconnectTimer !== undefined) {
      this.timers.clearTimeout(channel.reconnectTimer);
      channel.reconnectTimer = undefined;
    }
    const connection = channel.connection;
    channel.connection = undefined;
    channel.open = false;
    if (connection) this.releaseConnection(connection);
    const index = this.shards.indexOf(channel);
    if (index >= 0) this.shards.splice(index, 1);
  }

  private clearHeartbeat(channel: ChannelState): void {
    if (channel.heartbeat !== undefined) {
      this.timers.clearInterval(channel.heartbeat);
      channel.heartbeat = undefined;
    }
  }

  private clearWatchdog(channel: ChannelState): void {
    if (channel.watchdog !== undefined) {
      this.timers.clearTimeout(channel.watchdog);
      channel.watchdog = undefined;
    }
  }

  private armWatchdog(channel: ChannelState, connection: SocketConnection, reason: string, timeoutMs: number): void {
    this.clearWatchdog(channel);
    channel.watchdog = this.timers.setTimeout(() => {
      channel.watchdog = undefined;
      if (this.isCurrent(channel, connection)) this.retireConnection(channel, connection, reason);
    }, timeoutMs);
  }

  private recordGap(channel: ChannelState, reason: string): void {
    this.safeRecord({
      source: "collector", kind: "connection_gap", connectionId: channel.connectionId!,
      data: { source: channel.source, reason, epoch: channel.epoch }
    });
  }

  private recordClose(connection: SocketConnection, data: Record<string, unknown>): void {
    if (connection.closeRecorded) return;
    connection.closeRecorded = true;
    this.safeRecord({ source: "collector", kind: "connection_close", connectionId: connection.id, data });
  }

  private retireConnection(channel: ChannelState, connection: SocketConnection, reason: string): void {
    if (!this.isCurrent(channel, connection)) return;
    this.recordGap(channel, reason);
    channel.open = false;
    channel.connection = undefined;
    this.clearHeartbeat(channel);
    this.clearWatchdog(channel);
    this.releaseConnection(connection);
    this.scheduleReconnect(channel);
  }

  private releaseConnection(connection: SocketConnection): void {
    if (connection.shutdownPromise) return;
    // Defer the handshake until the promise is registered: fake sockets and
    // some transports can emit close synchronously from close().
    const closing = Promise.resolve().then(() => this.closeConnection(connection));
    connection.shutdownPromise = closing;
    this.pendingClosures.add(closing);
    void closing.then(() => {
      this.pendingClosures.delete(closing);
    }, (error: unknown) => {
      this.pendingClosures.delete(closing);
      const failure = error instanceof Error ? error : new Error("STREAM_CLOSE_FAILED", { cause: error });
      this.closeError ??= failure;
      this.reportError(failure);
      this.fail(failure);
    });
  }

  private async closeConnection(connection: SocketConnection): Promise<void> {
    const socket = connection.socket;
    let graceful = connection.closed;
    if (!graceful) {
      const closed = this.withCloseDeadline(connection.closedPromise, connection.id).then(() => true, () => false);
      try {
        socket.close(1000, this.stopping ? "collector stopping" : "collector reconnecting");
      } catch (error) {
        this.reportError(error);
      }
      graceful = await closed;
    }
    if (!graceful) {
      const force = socket.destroy ?? socket.terminate;
      if (!force) throw new Error(`STREAM_CLOSE_TIMEOUT: ${connection.id} has no forced teardown`);
      this.recordClose(connection, { code: 1006, reason: "close_timeout", forced: true });
      await this.withCloseDeadline(Promise.resolve().then(() => force.call(socket)).then(() => connection.closedPromise), connection.id);
    } else if (socket.destroy) {
      await this.withCloseDeadline(Promise.resolve().then(() => socket.destroy!()), connection.id);
    }
  }

  private withCloseDeadline(work: Promise<void>, connectionId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => reject(new Error(`STREAM_CLOSE_TIMEOUT: ${connectionId}`)), this.closeTimeoutMs);
      void work.then(() => {
        this.timers.clearTimeout(timer);
        resolve();
      }, (error: unknown) => {
        this.timers.clearTimeout(timer);
        reject(error);
      });
    });
  }

  private isCurrent(channel: ChannelState, connection: SocketConnection): boolean {
    return !channel.disposed && channel.connection === connection;
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
    void this.stop().catch((closeError: unknown) => this.reportError(closeError));
  }
}

export function createPublicStreams(options: PublicStreamsOptions): PublicStreams {
  return new PublicStreams(options);
}
