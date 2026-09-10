import { fetchJson } from "../polymarket/http.js";
import {
  collectableTokenIds,
  discoverSportsEvents,
  fetchCollectorEvent,
  type CatalogDependencies,
  type CatalogOptions
} from "./catalog.js";
import { createJournal, type CollectorJournal } from "./journal.js";
import { createPublicStreams, type PublicStreams, type PublicStreamsOptions, type StreamTimerApi } from "./streams.js";
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
  lookbackHours?: number;
  aheadHours?: number;
  allOpen?: boolean;
  pageSize?: number;
  maxPages?: number;
  discoveryIntervalMs?: number;
  snapshotIntervalMs?: number;
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

export class CollectorRuntime {
  private readonly options: CollectorOptions;
  private readonly request: JsonRequester;
  private readonly discover: NonNullable<CollectorDependencies["discover"]>;
  private readonly fetchEvent: NonNullable<CollectorDependencies["fetchEvent"]>;
  private readonly makeJournal: NonNullable<CollectorDependencies["createJournal"]>;
  private readonly makeStreams: NonNullable<CollectorDependencies["createStreams"]>;
  private readonly now: () => Date | number;
  private readonly timers: CollectorTimerApi;
  private readonly discoveryIntervalMs: number;
  private readonly snapshotIntervalMs: number;
  private readonly httpTimeoutMs: number;
  private readonly durationSeconds: number | undefined;
  private readonly activeEvents = new Map<string, CollectorEvent>();
  private readonly knownEvents = new Map<string, CollectorEvent>();
  private desiredTokens: string[] = [];
  private journal: CollectorJournalLike | undefined;
  private streams: CollectorStreamLike | undefined;
  private started = false;
  private stopping = false;
  private stopped = false;
  private discoveryInFlight: Promise<void> | undefined;
  private snapshotInFlight: Promise<void> | undefined;
  private discoveryTimer: unknown;
  private snapshotTimer: unknown;
  private durationTimer: unknown;
  private startedAt = "";
  private endedAt = "";
  private fatalError: unknown;
  private stopPromise: Promise<CollectorRunResult> | undefined;
  private resolveRun: ((result: CollectorRunResult) => void) | undefined;
  private runResultPromise: Promise<CollectorRunResult> | undefined;

  constructor(options: CollectorOptions = {}, dependencies: CollectorDependencies = {}) {
    this.options = options;
    this.request = dependencies.request ?? ((url, requestOptions) => fetchJson(url, requestOptions));
    this.discover = dependencies.discover ?? discoverSportsEvents;
    this.fetchEvent = dependencies.fetchEvent ?? fetchCollectorEvent;
    this.makeJournal = dependencies.createJournal ?? createJournal;
    this.makeStreams = dependencies.createStreams ?? ((streamOptions) => createPublicStreams(streamOptions));
    this.now = dependencies.now ?? (() => new Date());
    this.timers = dependencies.timers ?? defaultTimers;
    this.discoveryIntervalMs = positiveInterval(options.discoveryIntervalMs, 60_000, "discoveryIntervalMs");
    this.snapshotIntervalMs = positiveInterval(options.snapshotIntervalMs, 60_000, "snapshotIntervalMs");
    this.httpTimeoutMs = positiveInterval(options.httpTimeoutMs, 10_000, "httpTimeoutMs");
    this.durationSeconds = nonnegativeDuration(options.durationSeconds);
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

  async start(): Promise<void> {
    if (this.started) return;
    if (this.stopped) throw new Error("COLLECTOR_ALREADY_STOPPED");
    this.started = true;
    this.startedAt = dateValue(this.now()).toISOString();
    const journalOptions: Parameters<typeof createJournal>[0] = {};
    if (this.options.rootDir !== undefined) journalOptions.rootDir = this.options.rootDir;
    if (this.options.runId !== undefined) journalOptions.runId = this.options.runId;
    if (this.options.maxSegmentBytes !== undefined) journalOptions.maxSegmentBytes = this.options.maxSegmentBytes;
    if (this.options.maxBufferBytes !== undefined) journalOptions.maxBufferBytes = this.options.maxBufferBytes;
    this.journal = await this.makeJournal(journalOptions);
    this.record({ source: "collector", kind: "session_start", data: {
      config: this.options,
      startedAt: this.startedAt
    } });

    // Discover before opening sockets so the first subscription is complete.
    await this.discoverOnce();
    if (!this.journal) throw new Error("COLLECTOR_JOURNAL_MISSING");
    const streamOptions: PublicStreamsOptions = {
      journal: this.journal,
      onFatal: (error) => this.fail(error)
    };
    if (this.options.clobWsUrl !== undefined) streamOptions.clobUrl = this.options.clobWsUrl;
    if (this.options.sportsWsUrl !== undefined) streamOptions.sportsUrl = this.options.sportsWsUrl;
    if (this.options.proxyUrl !== undefined) streamOptions.proxyUrl = this.options.proxyUrl;
    if (this.options.maxTokensPerSocket !== undefined) streamOptions.maxTokensPerSocket = this.options.maxTokensPerSocket;
    this.streams = this.makeStreams(streamOptions);
    await this.streams.start(this.desiredTokens);
    await this.snapshotOnce();

    this.discoveryTimer = this.timers.setInterval(() => {
      void this.discoverOnce();
    }, this.discoveryIntervalMs);
    this.snapshotTimer = this.timers.setInterval(() => {
      void this.snapshotOnce();
    }, this.snapshotIntervalMs);
  }

  async run(): Promise<CollectorRunResult> {
    if (!this.runResultPromise) {
      this.runResultPromise = new Promise<CollectorRunResult>((resolve) => {
        this.resolveRun = resolve;
      });
    }
    await this.start();
    if (this.durationSeconds !== undefined) {
      this.durationTimer = this.timers.setTimeout(() => {
        void this.stop();
      }, this.durationSeconds * 1000);
    }
    if (this.durationSeconds === 0) await this.stop();
    return this.runResultPromise;
  }

  async discoverOnce(): Promise<void> {
    if (!this.started || this.stopping) return;
    if (this.discoveryInFlight) return this.discoveryInFlight;
    this.discoveryInFlight = this.performDiscovery().finally(() => {
      this.discoveryInFlight = undefined;
    });
    return this.discoveryInFlight;
  }

  async snapshotOnce(): Promise<void> {
    if (!this.started || this.stopping) return;
    if (this.snapshotInFlight) return this.snapshotInFlight;
    this.snapshotInFlight = this.performSnapshots().finally(() => {
      this.snapshotInFlight = undefined;
    });
    return this.snapshotInFlight;
  }

  async stop(): Promise<CollectorRunResult> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.finish();
    return this.stopPromise;
  }

  private async performDiscovery(): Promise<void> {
    const catalogOptions: CatalogOptions = { now: () => dateValue(this.now()).getTime() };
    if (this.options.gammaBaseUrl !== undefined) catalogOptions.baseUrl = this.options.gammaBaseUrl;
    if (this.options.tagId !== undefined) catalogOptions.tagId = this.options.tagId;
    if (this.options.sports !== undefined) catalogOptions.sports = this.options.sports;
    if (this.options.eventSlugs !== undefined) catalogOptions.eventSlugs = this.options.eventSlugs;
    if (this.options.lookbackHours !== undefined) catalogOptions.lookbackHours = this.options.lookbackHours;
    if (this.options.aheadHours !== undefined) catalogOptions.aheadHours = this.options.aheadHours;
    if (this.options.allOpen !== undefined) catalogOptions.allOpen = this.options.allOpen;
    if (this.options.pageSize !== undefined) catalogOptions.pageSize = this.options.pageSize;
    if (this.options.maxPages !== undefined) catalogOptions.maxPages = this.options.maxPages;
    const catalogDependencies: CatalogDependencies = {
      request: this.request,
      onRequest: (request) => {
        const data = { ...request } as { url: string; requestStartedAt: string; requestEndedAt: string; response?: unknown; error?: unknown };
        if (request.error !== undefined) data.error = serializeError(request.error);
        this.record({ source: "gamma", kind: "http_request", data });
      },
      onPage: (page) => {
        this.record({
          source: "gamma",
          kind: "discovery_page",
          data: page
        });
      }
    };
    let discovered: CollectorEvent[];
    try {
      discovered = await this.discover(catalogOptions, catalogDependencies);
    } catch (error) {
      this.record({ source: "collector", kind: "discovery_error", data: { error: serializeError(error) } });
      return;
    }

    const next = new Map(discovered.map((event) => [event.eventId, event]));
    const previous = [...this.activeEvents.values()];
    for (const event of discovered) {
      this.knownEvents.set(event.eventId, event);
      this.record({ source: "gamma", kind: "event_metadata", data: { event: event.raw, normalized: event, status: "discovered" } });
    }

    for (const event of previous) {
      if (next.has(event.eventId)) continue;
      await this.reconcileDisappearedEvent(event, catalogDependencies);
    }

    this.activeEvents.clear();
    for (const [id, event] of next) this.activeEvents.set(id, event);
    this.desiredTokens = collectableTokenIds(discovered);
    if (this.streams) {
      try {
        await this.streams.setTokens(this.desiredTokens);
      } catch (error) {
        this.fail(error);
      }
    }
  }

  private async reconcileDisappearedEvent(event: CollectorEvent, dependencies: CatalogDependencies): Promise<void> {
    try {
      const refreshed = await this.fetchEvent(event.eventSlug, dependencies, this.options.gammaBaseUrl);
      this.knownEvents.set(refreshed.eventId, refreshed);
      this.record({ source: "gamma", kind: "event_metadata", data: { event: refreshed.raw, normalized: refreshed, status: "reconciled" } });
    } catch (error) {
      this.record({ source: "collector", kind: "reconciliation_error", data: {
        eventId: event.eventId,
        eventSlug: event.eventSlug,
        error: serializeError(error)
      } });
    }
  }

  private async performSnapshots(): Promise<void> {
    const tokens = [...this.desiredTokens];
    await Promise.all(tokens.map(async (tokenId) => {
      const requestStartedAt = dateValue(this.now()).toISOString();
      const url = `${baseUrl(this.options.clobBaseUrl, "https://clob.polymarket.com")}/book?token_id=${encodeURIComponent(tokenId)}`;
      try {
        const response = await this.request(url, { timeoutMs: this.httpTimeoutMs });
        const requestEndedAt = dateValue(this.now()).toISOString();
        this.record({ source: "clob", kind: "book_snapshot", data: { tokenId, url, requestStartedAt, requestEndedAt, response } });
      } catch (error) {
        const requestEndedAt = dateValue(this.now()).toISOString();
        this.record({ source: "clob", kind: "http_error", data: { tokenId, url, requestStartedAt, requestEndedAt, error: serializeError(error) } });
      }
    }));
  }

  private async finish(): Promise<CollectorRunResult> {
    if (this.stopped && this.runResultPromise) return this.runResultPromise;
    this.stopping = true;
    this.started = false;
    if (this.discoveryTimer !== undefined) this.timers.clearInterval(this.discoveryTimer);
    if (this.snapshotTimer !== undefined) this.timers.clearInterval(this.snapshotTimer);
    if (this.durationTimer !== undefined) this.timers.clearTimeout(this.durationTimer);
    try {
      await this.discoveryInFlight;
      await this.snapshotInFlight;
      await this.streams?.stop();
      this.endedAt = dateValue(this.now()).toISOString();
      this.record({ source: "collector", kind: "session_end", data: {
        endedAt: this.endedAt,
        eventCount: this.activeEvents.size,
        tokenCount: this.desiredTokens.length,
        error: this.fatalError ? serializeError(this.fatalError) : undefined
      } });
      await this.journal?.flush();
    } finally {
      await this.journal?.close();
      this.stopped = true;
    }
    const result: CollectorRunResult = {
      status: "stopped",
      runId: this.journal?.runId ?? "",
      runDirectory: this.journal?.runDirectory ?? "",
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      eventCount: this.activeEvents.size,
      tokenCount: this.desiredTokens.length
    };
    if (this.fatalError !== undefined) result.error = this.fatalError;
    this.resolveRun?.(result);
    return result;
  }

  private record(input: RecordInput): void {
    try {
      this.journal?.record(input);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.fatalError !== undefined) return;
    this.fatalError = error;
    if (this.started && !this.stopping) void this.stop();
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
