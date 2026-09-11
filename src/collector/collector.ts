import { setMaxListeners } from "node:events";
import { fetchJson } from "../polymarket/http.js";
import {
  collectableTokenIds,
  discoverSportsEvents,
  fetchCollectorEvent,
  type CatalogDependencies,
  type CatalogOptions
} from "./catalog.js";
import { createJournal } from "./journal.js";
import { createPublicStreams, type PublicStreamsOptions, type StreamTimerApi } from "./streams.js";
import type { CollectorEvent, JsonRequestOptions, JsonRequester, RecordInput, RecordSink } from "./types.js";

export interface CollectorStreamLike {
  start(tokens: readonly string[]): Promise<void> | void;
  setTokens(tokens: readonly string[]): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface CollectorJournalLike extends RecordSink {
  readonly runId: string;
  readonly runDirectory: string;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface CollectorTimerApi extends StreamTimerApi {}

export interface CollectorOptions {
  rootDir?: string;
  runId?: string;
  gammaBaseUrl?: string;
  clobBaseUrl?: string;
  clobWsUrl?: string;
  sportsWsUrl?: string;
  proxyUrl?: string;
  tagId?: string;
  sports?: string[];
  eventSlugs?: string[];
  dateWindow?: "metadata-end" | "game-start";
  lookbackHours?: number;
  aheadHours?: number;
  allOpen?: boolean;
  pageSize?: number;
  maxPages?: number;
  discoveryIntervalMs?: number;
  snapshotIntervalMs?: number;
  snapshotConcurrency?: number;
  httpTimeoutMs?: number;
  durationSeconds?: number;
  maxTokensPerSocket?: number;
  maxSegmentBytes?: number;
  maxBufferBytes?: number;
}

export interface CollectorDependencies {
  request?: JsonRequester;
  discover?: (options: CatalogOptions, deps: CatalogDependencies) => Promise<CollectorEvent[]>;
  fetchEvent?: (slug: string, deps: CatalogDependencies, baseUrl?: string) => Promise<CollectorEvent>;
  createJournal?: (options: Parameters<typeof createJournal>[0]) => Promise<CollectorJournalLike>;
  createStreams?: (options: PublicStreamsOptions) => CollectorStreamLike;
  now?: () => Date | number;
  timers?: CollectorTimerApi;
}

export interface CollectorRunResult {
  status: "stopped";
  runId: string;
  runDirectory: string;
  startedAt: string;
  endedAt: string;
  eventCount: number;
  tokenCount: number;
  error?: unknown;
}

type EffectiveCollectorOptions = Required<Omit<CollectorOptions, "runId" | "proxyUrl" | "durationSeconds">>
  & Pick<CollectorOptions, "runId" | "proxyUrl" | "durationSeconds">;

export type CollectorStatus = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";

const defaultTimers: CollectorTimerApi = {
  setTimeout: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (handler, timeoutMs) => setInterval(handler, timeoutMs),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout)
};

function dateValue(value: Date | number): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("COLLECTOR_CLOCK_INVALID");
  return date;
}

function positiveInterval(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonnegativeDuration(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) throw new RangeError("durationSeconds must be finite and nonnegative");
  return value;
}

function baseUrl(value: string | undefined, fallback: string): string {
  return (value ?? fallback).replace(/\/+$/, "");
}

function effectiveOptions(options: CollectorOptions): EffectiveCollectorOptions {
  if (options.dateWindow !== undefined && options.dateWindow !== "metadata-end" && options.dateWindow !== "game-start") {
    throw new RangeError("dateWindow must be metadata-end or game-start");
  }
  const effective: EffectiveCollectorOptions = {
    ...options,
    rootDir: options.rootDir ?? "data/collector",
    gammaBaseUrl: baseUrl(options.gammaBaseUrl, "https://gamma-api.polymarket.com"),
    clobBaseUrl: baseUrl(options.clobBaseUrl, "https://clob.polymarket.com"),
    clobWsUrl: options.clobWsUrl ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    sportsWsUrl: options.sportsWsUrl ?? "wss://sports-api.polymarket.com/ws",
    tagId: options.tagId ?? "100639",
    sports: [...(options.sports ?? [])],
    eventSlugs: [...(options.eventSlugs ?? [])],
    dateWindow: options.dateWindow ?? "metadata-end",
    lookbackHours: options.lookbackHours ?? 48,
    aheadHours: options.aheadHours ?? 24,
    allOpen: options.allOpen ?? false,
    pageSize: positiveInterval(options.pageSize, 100, "pageSize"),
    maxPages: positiveInterval(options.maxPages, 200, "maxPages"),
    discoveryIntervalMs: positiveInterval(options.discoveryIntervalMs, 60_000, "discoveryIntervalMs"),
    snapshotIntervalMs: positiveInterval(options.snapshotIntervalMs, 60_000, "snapshotIntervalMs"),
    snapshotConcurrency: positiveInterval(options.snapshotConcurrency, 8, "snapshotConcurrency"),
    httpTimeoutMs: positiveInterval(options.httpTimeoutMs, 10_000, "httpTimeoutMs"),
    maxTokensPerSocket: positiveInterval(options.maxTokensPerSocket, 200, "maxTokensPerSocket"),
    maxSegmentBytes: positiveInterval(options.maxSegmentBytes, 64 * 1024 * 1024, "maxSegmentBytes"),
    maxBufferBytes: positiveInterval(options.maxBufferBytes, 32 * 1024 * 1024, "maxBufferBytes")
  };
  nonnegativeDuration(effective.durationSeconds);
  for (const name of ["lookbackHours", "aheadHours"] as const) {
    if (!Number.isFinite(effective[name]) || effective[name] < 0) throw new RangeError(`${name} must be finite and nonnegative`);
  }
  const proxyUrl = options.proxyUrl ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.https_proxy ?? process.env.http_proxy;
  if (proxyUrl !== undefined) effective.proxyUrl = proxyUrl;
  return effective;
}

function terminalEvent(event: CollectorEvent): boolean {
  return event.raw.closed === true || event.raw.archived === true;
}

export class CollectorRuntime {
  private readonly options: EffectiveCollectorOptions;
  private readonly request: JsonRequester;
  private readonly discover: NonNullable<CollectorDependencies["discover"]>;
  private readonly fetchEvent: NonNullable<CollectorDependencies["fetchEvent"]>;
  private readonly makeJournal: NonNullable<CollectorDependencies["createJournal"]>;
  private readonly makeStreams: NonNullable<CollectorDependencies["createStreams"]>;
  private readonly now: () => Date | number;
  private readonly timers: CollectorTimerApi;
  private readonly cancellation = new AbortController();
  private readonly activeEvents = new Map<string, CollectorEvent>();
  private readonly requestsInFlight = new Set<Promise<unknown>>();
  private desiredTokens: string[] = [];
  private journal: CollectorJournalLike | undefined;
  private streams: CollectorStreamLike | undefined;
  private state: CollectorStatus = "idle";
  private runRequested = false;
  private startPromise: Promise<void> | undefined;
  private stoppedStartPromise: Promise<void> | undefined;
  private discoveryInFlight: Promise<void> | undefined;
  private snapshotInFlight: Promise<void> | undefined;
  private discoveryTimer: unknown;
  private snapshotTimer: unknown;
  private durationTimer: unknown;
  private startedAt = "";
  private endedAt = "";
  private fatalError: Error | undefined;
  private resolveRun!: (result: CollectorRunResult) => void;
  private rejectRun!: (error: Error) => void;
  private readonly done: Promise<CollectorRunResult>;

  constructor(options: CollectorOptions = {}, dependencies: CollectorDependencies = {}) {
    this.options = effectiveOptions(options);
    // Each bounded HTTP worker and its transport may listen for cancellation.
    setMaxListeners(this.options.snapshotConcurrency * 3 + 10, this.cancellation.signal);
    const request = dependencies.request ?? ((url, requestOptions) => fetchJson(url, {
      ...requestOptions,
      ...(this.options.proxyUrl !== undefined ? { proxyUrl: this.options.proxyUrl } : {})
    }));
    this.request = (url, requestOptions = {}) => {
      const signal = requestOptions.signal
        ? AbortSignal.any([this.cancellation.signal, requestOptions.signal])
        : this.cancellation.signal;
      return this.untilStopped(() => request(url, {
        ...requestOptions,
        timeoutMs: requestOptions.timeoutMs ?? this.options.httpTimeoutMs,
        signal
      }), signal);
    };
    this.discover = dependencies.discover ?? discoverSportsEvents;
    this.fetchEvent = dependencies.fetchEvent ?? fetchCollectorEvent;
    this.makeJournal = dependencies.createJournal ?? createJournal;
    this.makeStreams = dependencies.createStreams ?? ((streamOptions) => createPublicStreams(streamOptions));
    this.now = dependencies.now ?? (() => new Date());
    this.timers = dependencies.timers ?? defaultTimers;
    this.done = new Promise<CollectorRunResult>((resolve, reject) => {
      this.resolveRun = resolve;
      this.rejectRun = reject;
    });
    // start(), timer callbacks, and fatal callbacks can all initiate shutdown
    // before a caller has attached to run() or stop(). Keep that rejection owned.
    void this.done.catch(() => {});
  }

  get status(): CollectorStatus {
    return this.state;
  }

  private get collecting(): boolean {
    return this.state === "starting" || this.state === "running";
  }

  get error(): unknown {
    return this.fatalError;
  }

  get runId(): string | undefined {
    return this.journal?.runId;
  }

  get runDirectory(): string | undefined {
    return this.journal?.runDirectory;
  }

  get events(): readonly CollectorEvent[] {
    return [...this.activeEvents.values()];
  }

  get tokenIds(): readonly string[] {
    return [...this.desiredTokens];
  }

  start(): Promise<void> {
    if (this.cancellation.signal.aborted) {
      this.stoppedStartPromise ??= this.done.then(() => {});
      void this.stoppedStartPromise.catch(() => {});
      return this.stoppedStartPromise;
    }
    if (this.startPromise) return this.startPromise;
    this.state = "starting";
    this.startPromise = this.initialize().catch((error: unknown) => {
      if (!this.isCancellation(error)) this.fail(error);
    }).then(async () => {
      if (this.cancellation.signal.aborted) await this.done;
    });
    void this.startPromise.catch(() => {});
    return this.startPromise;
  }

  private async initialize(): Promise<void> {
    this.startedAt = dateValue(this.now()).toISOString();
    const journalOptions: Parameters<typeof createJournal>[0] = {
      rootDir: this.options.rootDir,
      maxSegmentBytes: this.options.maxSegmentBytes,
      maxBufferBytes: this.options.maxBufferBytes,
      now: this.now,
      onError: (error) => this.fail(error)
    };
    if (this.options.runId !== undefined) journalOptions.runId = this.options.runId;

    // Opening storage is not abortable. A late result still belongs to this
    // runtime and must be closed without resuming the canceled initialization.
    await this.untilStopped(() => this.makeJournal(journalOptions).then(async (journal) => {
      if (!this.collecting) {
        await this.attemptCleanup(() => journal.close());
        return;
      }
      this.journal = journal;
    }));
    if (!this.collecting) return;
    this.record({ source: "collector", kind: "session_start", data: {
      config: { ...this.options, runId: this.journal?.runId, durationSeconds: this.options.durationSeconds ?? null },
      status: "starting",
      startedAt: this.startedAt
    } });
    if (!this.collecting) return;

    // Discover before opening sockets so the first subscription is complete.
    await this.discoverOnce();
    if (!this.collecting) return;
    if (!this.journal) throw new Error("COLLECTOR_JOURNAL_MISSING");
    const streamOptions: PublicStreamsOptions = {
      journal: this.journal,
      clobUrl: this.options.clobWsUrl,
      sportsUrl: this.options.sportsWsUrl,
      maxTokensPerSocket: this.options.maxTokensPerSocket,
      onFatal: (error) => this.fail(error)
    };
    if (this.options.proxyUrl !== undefined) streamOptions.proxyUrl = this.options.proxyUrl;
    const streams = this.makeStreams(streamOptions);
    if (!this.collecting) {
      await this.attemptCleanup(() => streams.stop());
      return;
    }
    this.streams = streams;
    await this.untilStopped(() => streams.start(this.desiredTokens));
    if (!this.collecting) return;
    await this.snapshotOnce();
    if (!this.collecting) return;

    this.state = "running";
    this.discoveryTimer = this.timers.setInterval(() => {
      void this.discoverOnce();
    }, this.options.discoveryIntervalMs);
    if (!this.collecting) return;
    this.snapshotTimer = this.timers.setInterval(() => {
      void this.snapshotOnce();
    }, this.options.snapshotIntervalMs);
  }

  run(): Promise<CollectorRunResult> {
    if (!this.runRequested && !this.cancellation.signal.aborted) {
      this.runRequested = true;
      try {
        // A positive duration includes startup, even if a dependency stalls.
        if (this.options.durationSeconds !== undefined && this.options.durationSeconds > 0) {
          this.durationTimer = this.timers.setTimeout(() => { void this.stop(); }, this.options.durationSeconds * 1000);
        }
        void this.start().then(() => {
          // Preserve duration=0 as a single initial discovery/snapshot pass.
          if (this.options.durationSeconds === 0) void this.stop();
        }, (error: unknown) => this.fail(error));
      } catch (error) {
        this.fail(error);
      }
    }
    return this.done;
  }

  discoverOnce(): Promise<void> {
    if (!this.collecting || !this.journal) return Promise.resolve();
    if (this.discoveryInFlight) return this.discoveryInFlight;
    this.discoveryInFlight = Promise.resolve().then(() => this.performDiscovery()).catch((error: unknown) => {
      if (!this.isCancellation(error)) this.fail(error);
    }).finally(() => {
      this.discoveryInFlight = undefined;
    });
    return this.discoveryInFlight;
  }

  snapshotOnce(): Promise<void> {
    if (!this.collecting || !this.journal) return Promise.resolve();
    if (this.snapshotInFlight) return this.snapshotInFlight;
    this.snapshotInFlight = Promise.resolve().then(() => this.performSnapshots()).catch((error: unknown) => {
      if (!this.isCancellation(error)) this.fail(error);
    }).finally(() => {
      this.snapshotInFlight = undefined;
    });
    return this.snapshotInFlight;
  }

  stop(): Promise<CollectorRunResult> {
    if (this.cancellation.signal.aborted) return this.done;
    this.state = "stopping";
    this.cancellation.abort(new DOMException("Collector stopped", "AbortError"));
    for (const timer of [this.discoveryTimer, this.snapshotTimer]) {
      try {
        if (timer !== undefined) this.timers.clearInterval(timer);
      } catch (error) {
        this.fail(error);
      }
    }
    try {
      if (this.durationTimer !== undefined) this.timers.clearTimeout(this.durationTimer);
    } catch (error) {
      this.fail(error);
    }
    this.discoveryTimer = this.snapshotTimer = this.durationTimer = undefined;
    void this.finish();
    return this.done;
  }

  private async performDiscovery(): Promise<void> {
    if (!this.collecting) return;
    const catalogOptions: CatalogOptions = {
      now: () => dateValue(this.now()).getTime(),
      baseUrl: this.options.gammaBaseUrl,
      tagId: this.options.tagId,
      sports: this.options.sports,
      eventSlugs: this.options.eventSlugs,
      dateWindow: this.options.dateWindow,
      lookbackHours: this.options.lookbackHours,
      aheadHours: this.options.aheadHours,
      allOpen: this.options.allOpen,
      pageSize: this.options.pageSize,
      maxPages: this.options.maxPages
    };
    const catalogDependencies: CatalogDependencies = {
      request: (url, options) => this.catalogRequest(url, options),
      onPage: (page) => {
        if (this.collecting) this.record({ source: "gamma", kind: "discovery_page", data: page });
      }
    };
    let discovered: CollectorEvent[];
    try {
      discovered = await this.untilStopped(() => this.discover(catalogOptions, catalogDependencies));
    } catch (error) {
      if (this.collecting) this.record({ source: "collector", kind: "discovery_error", data: { error: serializeError(error) } });
      return;
    }
    if (!this.collecting) return;

    const next = new Map(discovered.map((event) => [event.eventId, event]));
    const previous = [...this.activeEvents.values()];
    for (const event of discovered) {
      this.record({ source: "gamma", kind: "event_metadata", data: { event: event.raw, normalized: event, status: "discovered" } });
      if (!this.collecting) return;
    }

    for (const event of previous) {
      if (next.has(event.eventId)) continue;
      const retained = await this.reconcileDisappearedEvent(event, catalogDependencies);
      if (!this.collecting) return;
      if (retained) next.set(retained.eventId, retained);
    }

    this.activeEvents.clear();
    for (const [id, event] of next) this.activeEvents.set(id, event);
    this.desiredTokens = collectableTokenIds([...next.values()]);
    if (this.streams) {
      try {
        const streams = this.streams;
        await this.untilStopped(() => streams.setTokens(this.desiredTokens));
      } catch (error) {
        if (!this.isCancellation(error)) this.fail(error);
      }
    }
  }

  private async reconcileDisappearedEvent(event: CollectorEvent, dependencies: CatalogDependencies): Promise<CollectorEvent | undefined> {
    try {
      const refreshed = await this.untilStopped(() => this.fetchEvent(event.eventSlug, dependencies, this.options.gammaBaseUrl));
      if (!this.collecting) return;
      if (refreshed.eventId !== event.eventId || refreshed.eventSlug !== event.eventSlug) {
        throw new Error(`CATALOG_EVENT_MISMATCH: expected ${event.eventId}/${event.eventSlug}, received ${refreshed.eventId}/${refreshed.eventSlug}`);
      }
      this.record({ source: "gamma", kind: "event_metadata", data: { event: refreshed.raw, normalized: refreshed, status: "reconciled" } });
      if (terminalEvent(refreshed)) return;
      // Metadata-only responses do not establish that known markets closed.
      return refreshed.markets.length > 0 ? refreshed : { ...refreshed, markets: event.markets };
    } catch (error) {
      if (this.collecting) {
        this.record({ source: "collector", kind: "reconciliation_error", data: {
          eventId: event.eventId,
          eventSlug: event.eventSlug,
          error: serializeError(error)
        } });
      }
      return event;
    }
  }

  private catalogRequest(url: string, options?: JsonRequestOptions): Promise<unknown> {
    if (!this.collecting) return Promise.reject(this.cancellation.signal.reason);
    return this.trackRequest((async () => {
      const requestStartedAt = dateValue(this.now()).toISOString();
      let response: unknown;
      try {
        response = await this.request(url, options);
      } catch (error) {
        const requestEndedAt = dateValue(this.now()).toISOString();
        this.record({ source: "gamma", kind: "http_request", data: { url, requestStartedAt, requestEndedAt, error: serializeError(error) } });
        throw error;
      }
      const requestEndedAt = dateValue(this.now()).toISOString();
      this.record({ source: "gamma", kind: "http_request", data: { url, requestStartedAt, requestEndedAt, response } });
      return response;
    })());
  }

  private async performSnapshots(): Promise<void> {
    const tokens = [...this.desiredTokens];
    let nextToken = 0;
    await Promise.all(Array.from({ length: Math.min(tokens.length, this.options.snapshotConcurrency) }, async () => {
      while (this.collecting) {
        const tokenId = tokens[nextToken++];
        if (tokenId === undefined) return;
        await this.trackRequest(this.snapshotToken(tokenId));
      }
    }));
  }

  private async snapshotToken(tokenId: string): Promise<void> {
    const requestStartedAt = dateValue(this.now()).toISOString();
    const url = `${this.options.clobBaseUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
    try {
      const response = await this.request(url);
      const requestEndedAt = dateValue(this.now()).toISOString();
      this.record({ source: "clob", kind: "book_snapshot", data: { tokenId, url, requestStartedAt, requestEndedAt, response } });
    } catch (error) {
      const requestEndedAt = dateValue(this.now()).toISOString();
      this.record({ source: "clob", kind: "http_error", data: { tokenId, url, requestStartedAt, requestEndedAt, error: serializeError(error) } });
    }
  }

  private trackRequest<T>(request: Promise<T>): Promise<T> {
    this.requestsInFlight.add(request);
    void request.then(() => this.requestsInFlight.delete(request), () => this.requestsInFlight.delete(request));
    return request;
  }

  private untilStopped<T>(operation: () => T | PromiseLike<T>, signal = this.cancellation.signal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const onAbort = (): void => { signal.removeEventListener("abort", onAbort); reject(signal.reason); };
      signal.addEventListener("abort", onAbort, { once: true });
      const success = (value: T): void => { signal.removeEventListener("abort", onAbort); resolve(value); };
      const failure = (error: unknown): void => { signal.removeEventListener("abort", onAbort); reject(error); };
      try {
        void Promise.resolve(operation()).then(success, failure);
      } catch (error) {
        failure(error);
      }
    });
  }

  private isCancellation(error: unknown): boolean {
    return this.cancellation.signal.aborted && error === this.cancellation.signal.reason;
  }

  private async attemptCleanup(operation: () => void | Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.fail(error);
    }
  }

  private async finish(): Promise<void> {
    try {
      // Never await start()/done here: a fatal discovery or canceled initializer
      // may itself be waiting for this completion. All request waits are abortable.
      await Promise.allSettled([this.discoveryInFlight, this.snapshotInFlight, ...this.requestsInFlight]);
      await this.attemptCleanup(() => this.streams?.stop());
      await this.attemptCleanup(() => { this.endedAt = dateValue(this.now()).toISOString(); });
      this.record({ source: "collector", kind: "session_end", data: {
        status: this.fatalError ? "failed" : "stopped",
        endedAt: this.endedAt,
        eventCount: this.activeEvents.size,
        tokenCount: this.desiredTokens.length,
        error: this.fatalError ? serializeError(this.fatalError) : undefined
      } });
      await this.attemptCleanup(() => this.journal?.flush());
    } catch (error) {
      this.fail(error);
    } finally {
      await this.attemptCleanup(() => this.journal?.close());
      this.state = this.fatalError ? "failed" : "stopped";
      if (this.fatalError) {
        this.rejectRun(this.fatalError);
      } else {
        this.resolveRun({
          status: "stopped",
          runId: this.journal?.runId ?? "",
          runDirectory: this.journal?.runDirectory ?? "",
          startedAt: this.startedAt,
          endedAt: this.endedAt,
          eventCount: this.activeEvents.size,
          tokenCount: this.desiredTokens.length
        });
      }
    }
  }

  private record(input: RecordInput): void {
    if (this.state === "stopped" || this.state === "failed") return;
    try {
      this.journal?.record(input);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.fatalError !== undefined) return;
    this.fatalError = error instanceof Error ? error : new Error(String(error));
    void this.stop();
  }
}

function serializeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

export function createCollector(options: CollectorOptions = {}, dependencies: CollectorDependencies = {}): CollectorRuntime {
  return new CollectorRuntime(options, dependencies);
}

export async function runCollector(options: CollectorOptions = {}, dependencies: CollectorDependencies = {}): Promise<CollectorRunResult> {
  return createCollector(options, dependencies).run();
}
