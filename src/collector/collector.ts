import { createHash } from "node:crypto";
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
import { expandRelatedEvents } from "./related-catalog.js";
import { EventLifecycle, type EventLifecycleSelection, type EventLifecycleState } from "./lifecycle.js";
import { createPublicStreams, type PublicStreamsOptions, type StreamTimerApi } from "./streams.js";
import type { CollectorEvent, JournalRecord, JsonRequestOptions, JsonRequester, RecordInput, RecordSink } from "./types.js";

export interface CollectorStreamLike {
  start(tokens: readonly string[]): Promise<void> | void;
  setTokens(tokens: readonly string[]): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface CollectorJournalLike extends RecordSink {
  readonly runId: string;
  readonly runDirectory: string;
  /** Wrappers should forward the receipt to enable compact discovery provenance. */
  record(input: RecordInput): JournalRecord | void;
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
  includeRelatedEvents?: boolean;
  /** Replace duplicate discovery page bodies with references to their HTTP records. */
  compactDiscoveryPages?: boolean;
  lookbackHours?: number;
  aheadHours?: number;
  allOpen?: boolean;
  pageSize?: number;
  maxPages?: number;
  discoveryIntervalMs?: number;
  snapshotIntervalMs?: number;
  snapshotConcurrency?: number;
  /** 1 keeps legacy GET /book; larger batches use public POST /books. */
  snapshotBatchSize?: number;
  /** Start discovery timers without waiting for the first HTTP snapshot pass. */
  backgroundInitialSnapshots?: boolean;
  /** Keep raw market frames out of the NDJSON journal; the continuous wrapper owns compact storage. */
  compactStorageEnabled?: boolean;
  /**
   * In compact mode, periodically fetch one full HTTP book per token to anchor
   * the incremental `price_change` stream. Without an anchor the SELL-side
   * depth deltas cannot be replayed into an ask ladder, and WebSocket does not
   * reliably push a full book for every subscribed token.
   */
  compactAnchorSnapshots?: boolean;
  httpTimeoutMs?: number;
  durationSeconds?: number;
  maxTokensPerSocket?: number;
  maxSegmentBytes?: number;
  maxBufferBytes?: number;
  postFinishRetentionMs?: number;
  reconciliationConcurrency?: number;
  /**
   * The public `/books` endpoint omits tokens whose market no longer has an
   * orderbook (resolved sub-markets such as set winners, totals and handicaps
   * that Gamma still reports as open). Re-requesting those tokens every pass
   * produces an `identity mismatch` record per pass and burns upstream quota
   * for a book that does not exist. Remember an absent token for this long
   * before asking for it again.
   */
  absentBookCooldownMs?: number;
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

type EffectiveCollectorOptions = Required<Omit<CollectorOptions, "runId" | "proxyUrl" | "durationSeconds" | "postFinishRetentionMs">>
  & Pick<CollectorOptions, "runId" | "proxyUrl" | "durationSeconds" | "postFinishRetentionMs">;

type DiscoveryPage = Parameters<NonNullable<CatalogDependencies["onPage"]>>[0];
type DiscoveryResponses = WeakMap<object, {
  url: string;
  responseRef: { runId: string; sequence: number; sha256: string; bytes: number };
}>;

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
    includeRelatedEvents: options.includeRelatedEvents ?? false,
    compactDiscoveryPages: options.compactDiscoveryPages ?? options.compactStorageEnabled ?? false,
    lookbackHours: options.lookbackHours ?? 48,
    aheadHours: options.aheadHours ?? 24,
    allOpen: options.allOpen ?? false,
    pageSize: positiveInterval(options.pageSize, 100, "pageSize"),
    maxPages: positiveInterval(options.maxPages, 200, "maxPages"),
    discoveryIntervalMs: positiveInterval(options.discoveryIntervalMs, 60_000, "discoveryIntervalMs"),
    snapshotIntervalMs: positiveInterval(options.snapshotIntervalMs, 60_000, "snapshotIntervalMs"),
    snapshotConcurrency: positiveInterval(options.snapshotConcurrency, 8, "snapshotConcurrency"),
    snapshotBatchSize: positiveInterval(options.snapshotBatchSize, 1, "snapshotBatchSize"),
    backgroundInitialSnapshots: options.backgroundInitialSnapshots ?? false,
    compactStorageEnabled: options.compactStorageEnabled ?? false,
    compactAnchorSnapshots: options.compactAnchorSnapshots ?? false,
    httpTimeoutMs: positiveInterval(options.httpTimeoutMs, 10_000, "httpTimeoutMs"),
    maxTokensPerSocket: positiveInterval(options.maxTokensPerSocket, 200, "maxTokensPerSocket"),
    maxSegmentBytes: positiveInterval(options.maxSegmentBytes, 64 * 1024 * 1024, "maxSegmentBytes"),
    maxBufferBytes: positiveInterval(options.maxBufferBytes, 32 * 1024 * 1024, "maxBufferBytes"),
    reconciliationConcurrency: positiveInterval(options.reconciliationConcurrency, 1, "reconciliationConcurrency"),
    absentBookCooldownMs: positiveInterval(options.absentBookCooldownMs, 300_000, "absentBookCooldownMs")
  };
  nonnegativeDuration(effective.durationSeconds);
  // Collector resource bound, not a claim about the server's maximum batch size.
  if (effective.snapshotBatchSize > 100) throw new RangeError("snapshotBatchSize must be at most 100");
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
  private snapshotTokens: string[] = [];
  private snapshotTokenSet = new Set<string>();
  private snapshotBatchSequence = 0;
  /** Tokens whose last `/books` reply proved there is no orderbook, with the time we may retry. */
  private readonly absentBookRetryAtMs = new Map<string, number>();
  /** Absent tokens already reported once in this run, so one absence is not re-logged per pass. */
  private readonly reportedAbsentBookTokens = new Set<string>();
  private readonly lifecycle: EventLifecycle | undefined;
  private journal: CollectorJournalLike | undefined;
  private streams: CollectorStreamLike | undefined;
  private state: CollectorStatus = "idle";
  private runRequested = false;
  private startPromise: Promise<void> | undefined;
  private stoppedStartPromise: Promise<void> | undefined;
  private discoveryInFlight: Promise<void> | undefined;
  private snapshotInFlight: Promise<void> | undefined;
  private controlledWrites: Promise<void> = Promise.resolve();
  private subscriptionWrites: Promise<void> = Promise.resolve();
  private discoveryTimer: unknown;
  private snapshotTimer: unknown;
  private lifecycleTimer: unknown;
  private durationTimer: unknown;
  private startedAt = "";
  private endedAt = "";
  private fatalError: Error | undefined;
  private resolveRun!: (result: CollectorRunResult) => void;
  private rejectRun!: (error: Error) => void;
  private readonly done: Promise<CollectorRunResult>;

  constructor(options: CollectorOptions = {}, dependencies: CollectorDependencies = {}) {
    this.options = effectiveOptions(options);
    this.lifecycle = options.postFinishRetentionMs === undefined ? undefined : new EventLifecycle(options.postFinishRetentionMs);
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

  get lifecycleStates(): readonly EventLifecycleState[] { return this.lifecycle?.states ?? []; }

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
      onFrame: async (frame) => {
        if (!this.collecting || !this.lifecycle || frame.source !== "sports") return;
        // PublicStreams has already recorded the raw frame before this callback.
        try {
          this.lifecycle.observeSports(frame.frame, dateValue(this.now()).getTime());
        } catch (error) {
          await this.recordControlled({ source: "collector", kind: "lifecycle_error", connectionId: frame.connectionId,
            data: { error: serializeError(error) } }, true);
          throw error;
        }
        await this.refreshLifecycle();
      },
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
    if (this.lifecycle) {
      this.lifecycleTimer = this.timers.setInterval(() => { void this.refreshLifecycle(); },
        Math.min(1000, Math.max(1, this.options.postFinishRetentionMs!)));
    }
    const initialSnapshots = this.options.compactStorageEnabled ? Promise.resolve() : this.snapshotOnce();
    // Compact mode receives the market stream and stores only the bounded tail; repeated HTTP books are redundant.
    if (!this.options.compactStorageEnabled && (!this.options.backgroundInitialSnapshots || this.options.durationSeconds === 0)) await initialSnapshots;
    if (!this.collecting) return;

    this.state = "running";
    this.discoveryTimer = this.timers.setInterval(() => {
      void this.discoverOnce();
    }, this.options.discoveryIntervalMs);
    if (!this.collecting) return;
    if (!this.options.compactStorageEnabled) {
      this.snapshotTimer = this.timers.setInterval(() => {
        void this.snapshotOnce();
      }, this.options.snapshotIntervalMs);
    } else if (this.options.compactAnchorSnapshots) {
      // Anchor cadence only: these full books let the SELL-side deltas be
      // replayed into an ask ladder. They are far cheaper than the legacy
      // every-token-every-minute sweep, and the rolling window keeps only the
      // last one before the tail.
      this.snapshotTimer = this.timers.setInterval(() => {
        void this.snapshotOnce();
      }, this.options.snapshotIntervalMs);
    }
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

  refreshLifecycle(): Promise<void> {
    if (!this.collecting || !this.journal || !this.lifecycle) return Promise.resolve();
    return this.trackRequest(Promise.resolve().then(() => {
      if (this.collecting) return this.applySelection(this.lifecycle!.tick(dateValue(this.now()).getTime()), false);
    }).catch((error: unknown) => {
      if (!this.isCancellation(error)) this.fail(error);
    }));
  }

  stop(): Promise<CollectorRunResult> {
    if (this.cancellation.signal.aborted) return this.done;
    this.state = "stopping";
    this.cancellation.abort(new DOMException("Collector stopped", "AbortError"));
    for (const timer of [this.discoveryTimer, this.snapshotTimer, this.lifecycleTimer]) {
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
    this.discoveryTimer = this.snapshotTimer = this.lifecycleTimer = this.durationTimer = undefined;
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
    // Only small receipts are retained, weakly, for this sweep's response objects.
    const responses: DiscoveryResponses | undefined = this.options.compactDiscoveryPages ? new WeakMap() : undefined;
    const catalogDependencies: CatalogDependencies = {
      request: (url, options) => this.catalogRequest(url, options, responses),
      onPage: (page) => this.recordDiscoveryPage(page, responses)
    };
    let discovered: CollectorEvent[];
    try {
      discovered = await this.untilStopped(() => this.discover(catalogOptions, catalogDependencies));
      if(this.options.includeRelatedEvents)discovered=await this.untilStopped(()=>expandRelatedEvents(discovered,
        {baseUrl:this.options.gammaBaseUrl,pageSize:this.options.pageSize,maxPages:Math.min(this.options.maxPages,20),now:()=>dateValue(this.now()).getTime()},catalogDependencies));
    } catch (error) {
      if (this.collecting) await this.recordControlled({ source: "collector", kind: "discovery_error", data: { error: serializeError(error) } });
      return;
    }
    if (!this.collecting) return;

    const next = new Map(discovered.map((event) => [event.eventId, event]));
    const previous = [...this.activeEvents.values()];
    for (const event of discovered) {
      await this.recordMetadata(event, "discovered");
      if (!this.collecting) return;
    }

    const missing = previous.filter(event => !next.has(event.eventId));
    const reconciled: Array<CollectorEvent | undefined> = new Array(missing.length);
    let nextMissing = 0;
    await Promise.all(Array.from({ length: Math.min(missing.length, this.options.reconciliationConcurrency) }, async () => {
      while (this.collecting) {
        const index = nextMissing++, event = missing[index]; if (!event) return;
        reconciled[index] = await this.reconcileDisappearedEvent(event, catalogDependencies);
      }
    }));
    if (!this.collecting) return;
    for (const retained of reconciled) if (retained) next.set(retained.eventId, retained);

    const selection = this.lifecycle?.select([...next.values()], dateValue(this.now()).getTime());
    const tokenIds = selection?.tokenIds ?? collectableTokenIds([...next.values()]);
    await this.applySelection(selection ?? { events: [...next.values()], tokenIds, snapshotTokenIds: tokenIds, retired: [] }, true);
  }

  private async applySelection(selection: EventLifecycleSelection, forceSubscriptionUpdate: boolean): Promise<void> {
    const changed = this.desiredTokens.length !== selection.tokenIds.length || this.desiredTokens.some((token, index) => token !== selection.tokenIds[index]);
    this.activeEvents.clear();
    for (const event of selection.events) this.activeEvents.set(event.eventId, event);
    this.desiredTokens = selection.tokenIds;
    this.snapshotTokens = selection.snapshotTokenIds;
    this.snapshotTokenSet = new Set(this.snapshotTokens);
    // Absence bookkeeping only matters for tokens still in the anchor rotation;
    // retired tokens would otherwise accumulate for the life of the process.
    for (const tokenId of this.absentBookRetryAtMs.keys()) {
      if (this.snapshotTokenSet.has(tokenId)) continue;
      this.absentBookRetryAtMs.delete(tokenId);
      this.reportedAbsentBookTokens.delete(tokenId);
    }
    for (const state of selection.retired) await this.recordControlled({ source: "collector", kind: "event_retired", data: state });
    if (this.streams && (changed || forceSubscriptionUpdate)) {
      const update = this.subscriptionWrites.then(async () => {
        if (this.collecting && this.streams) await this.untilStopped(() => this.streams!.setTokens(this.desiredTokens));
      });
      this.subscriptionWrites = update.catch((error: unknown) => {
        if (!this.isCancellation(error)) this.fail(error);
      });
      await this.subscriptionWrites;
    }
  }

  private async reconcileDisappearedEvent(event: CollectorEvent, dependencies: CatalogDependencies): Promise<CollectorEvent | undefined> {
    try {
      const refreshed = await this.untilStopped(() => this.fetchEvent(event.eventSlug, dependencies, this.options.gammaBaseUrl));
      if (!this.collecting) return;
      if (refreshed.eventId !== event.eventId || refreshed.eventSlug !== event.eventSlug) {
        throw new Error(`CATALOG_EVENT_MISMATCH: expected ${event.eventId}/${event.eventSlug}, received ${refreshed.eventId}/${refreshed.eventSlug}`);
      }
      await this.recordMetadata(refreshed, "reconciled");
      if (terminalEvent(refreshed) && !this.lifecycle) return;
      // Metadata-only responses do not establish that known markets closed.
      return refreshed.markets.length > 0 ? refreshed : { ...refreshed, markets: event.markets };
    } catch (error) {
      if (this.collecting) {
        await this.recordControlled({ source: "collector", kind: "reconciliation_error", data: {
          eventId: event.eventId,
          eventSlug: event.eventSlug,
          error: serializeError(error)
        } });
      }
      return event;
    }
  }

  private catalogRequest(url: string, options?: JsonRequestOptions, responses?: DiscoveryResponses): Promise<unknown> {
    if (!this.collecting) return Promise.reject(this.cancellation.signal.reason);
    return this.trackRequest((async () => {
      const requestStartedAt = dateValue(this.now()).toISOString();
      let response: unknown;
      try {
        response = await this.request(url, options);
      } catch (error) {
        const requestEndedAt = dateValue(this.now()).toISOString();
        await this.recordControlled({ source: "gamma", kind: "http_request", data: { url, requestStartedAt, requestEndedAt, error: serializeError(error) } }, true);
        throw error;
      }
      const requestEndedAt = dateValue(this.now()).toISOString();
      let serialized: string | undefined;
      if (responses && typeof response === "object" && response !== null) {
        try {
          serialized = JSON.stringify(response);
          // Snapshot before journal admission can wait. Each HTTP observation gets
          // its own value even if a custom transport reuses/mutates one object.
          if (serialized !== undefined) response = JSON.parse(serialized) as unknown;
        } catch (error) {
          this.fail(error);
          throw error;
        }
      }
      const responseSummary = this.options.compactStorageEnabled && serialized !== undefined
        ? { sha256: createHash("sha256").update(serialized).digest("hex"), bytes: Buffer.byteLength(serialized) }
        : undefined;
      const input: RecordInput = { source: "gamma", kind: "http_request", data: {
        url, requestStartedAt, requestEndedAt,
        ...(responseSummary === undefined ? { response } : { responseSummary })
      } };
      await this.recordControlled(input, true, receipt => {
        if (!responses || serialized === undefined || typeof response !== "object" || response === null
          || !receipt || receipt.runId !== this.journal?.runId || receipt.source !== "gamma" || receipt.kind !== "http_request"
          || receipt.data !== input.data || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) return;
        responses.set(response, { url, responseRef: {
          runId: receipt.runId, sequence: receipt.sequence,
          sha256: createHash("sha256").update(serialized).digest("hex"), bytes: Buffer.byteLength(serialized)
        } });
      });
      return response;
    })());
  }

  private recordDiscoveryPage(page: DiscoveryPage, responses?: DiscoveryResponses): Promise<void> {
    const response = page.response;
    if (responses && typeof response === "object" && response !== null) {
      const recorded = responses.get(response);
      responses.delete(response);
      if (recorded?.url === page.url && page.requestEndedAt !== undefined) {
        let serialized: string | undefined;
        try { serialized = JSON.stringify(response); }
        catch { /* Fall through to the journal's normal serialization/failure path. */ }
        // Custom discovery can mutate a request result before invoking onPage.
        // Identity alone is insufficient evidence for omitting that page's body.
        if (serialized !== undefined && Buffer.byteLength(serialized) === recorded.responseRef.bytes
          && createHash("sha256").update(serialized).digest("hex") === recorded.responseRef.sha256) {
          const { url, requestStartedAt, requestEndedAt } = page;
          return this.recordControlled({ source: "gamma", kind: "discovery_page_ref",
            data: { url, requestStartedAt, requestEndedAt, responseRef: recorded.responseRef } });
        }
      }
    }
    return this.recordControlled({ source: "gamma", kind: "discovery_page", data: page });
  }

  private recordMetadata(event: CollectorEvent, status: string): Promise<void> {
    return this.recordControlled({ source: "gamma", kind: "event_metadata", data: { event: event.raw, status } });
  }

  private recordControlled(input: RecordInput, duringStop = false, onRecorded?: (record: JournalRecord | void) => void): Promise<void> {
    // Serialize admission, not HTTP work. Every controlled producer shares this
    // barrier; WebSocket recording goes straight to the bounded journal.
    const write = this.controlledWrites.then(async () => {
      if (!this.journal || (!this.collecting && !duringStop) || this.state === "stopped" || this.state === "failed") return;
      if (duringStop) await this.journal.flush();
      else await this.untilStopped(() => this.journal!.flush());
      if (this.collecting || duringStop) {
        const receipt = this.journal.record(input);
        onRecorded?.(receipt);
      }
    });
    // Own even an ignored callback rejection, while returning it to callers that
    // await the page. A storage failure remains fatal with its original cause.
    this.controlledWrites = write.catch((error: unknown) => {
      if (!this.isCancellation(error)) this.fail(error);
    });
    return write;
  }

  private async performSnapshots(): Promise<void> {
    const nowMs = dateValue(this.now()).getTime();
    const tokens = this.snapshotTokens.filter(tokenId => !this.absentBookSuppressed(tokenId, nowMs));
    const batchSize = this.options.snapshotBatchSize;
    let nextToken = 0;
    await Promise.all(Array.from({ length: Math.min(Math.ceil(tokens.length / batchSize), this.options.snapshotConcurrency) }, async () => {
      while (this.collecting) {
        const batch: string[] = [];
        while (nextToken < tokens.length && batch.length < batchSize) {
          const tokenId = tokens[nextToken++]!;
          // Discovery and lifecycle ticks can remove queued tokens mid-pass.
          if (this.snapshotTokenSet.has(tokenId)) batch.push(tokenId);
        }
        if (batch.length === 0) return;
        await this.trackRequest(batchSize === 1 ? this.snapshotToken(batch[0]!) : this.snapshotBatch(batch));
      }
    }));
  }

  private async snapshotBatch(tokenIds: string[]): Promise<void> {
    const url = `${this.options.clobBaseUrl}/books`;
    const method = "POST";
    const requestBody = tokenIds.map(token_id => ({ token_id }));
    const batchId = `${this.journal!.runId}:books:${++this.snapshotBatchSequence}`;
    const requestStartedAt = dateValue(this.now()).toISOString();
    let response: unknown;
    try {
      response = await this.request(url, { method, body: JSON.stringify(requestBody), headers: { "Content-Type": "application/json" } });
    } catch (error) {
      const requestEndedAt = dateValue(this.now()).toISOString();
      await this.recordControlled({ source: "clob", kind: "http_error", data: {
        batchId, tokenIds, url, method, requestBody, requestStartedAt, requestEndedAt, error: serializeError(error)
      } }, true);
      return;
    }
    const requestEndedAt = dateValue(this.now()).toISOString();
    const audit = { batchId, tokenIds, url, method, requestBody, requestStartedAt, requestEndedAt };
    await this.recordControlled({ source: "clob", kind: "book_snapshot_batch", data: { ...audit, response } }, true);

    const requested = new Set(tokenIds);
    const returned = new Map<string, Array<{ response: Record<string, unknown>; responseIndex: number }>>();
    const invalidResponseIndices: number[] = [];
    if (Array.isArray(response)) {
      response.forEach((value: unknown, responseIndex) => {
        const book = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
        // Never coerce numeric IDs (which may already have lost precision), trim,
        // or infer identity from the array position.
        if (!book || typeof book.asset_id !== "string" || book.asset_id.length === 0) {
          invalidResponseIndices.push(responseIndex);
          return;
        }
        const matches = returned.get(book.asset_id) ?? [];
        matches.push({ response: book, responseIndex });
        returned.set(book.asset_id, matches);
      });
    }
    const missingTokenIds = tokenIds.filter(tokenId => !returned.has(tokenId));
    const duplicateTokenIds = [...returned].filter(([, values]) => values.length > 1).map(([tokenId]) => tokenId);
    const unrequestedTokenIds = [...returned.keys()].filter(tokenId => !requested.has(tokenId));
    // An omitted token means the market has no orderbook, not that the reply is
    // corrupt: the single-token `/book` endpoint answers those with
    // 404 "No orderbook exists". Only duplicates, unrequested or malformed
    // entries are real contract violations, so report one absence episode once
    // and back off before asking again.
    const nowMs = dateValue(this.now()).getTime();
    const newlyMissingTokenIds = missingTokenIds.filter(tokenId => !this.reportedAbsentBookTokens.has(tokenId));
    for (const tokenId of missingTokenIds) {
      this.reportedAbsentBookTokens.add(tokenId);
      this.absentBookRetryAtMs.set(tokenId, nowMs + this.options.absentBookCooldownMs);
    }
    for (const tokenId of returned.keys()) {
      // A book that came back clears the earlier absence.
      this.absentBookRetryAtMs.delete(tokenId);
      this.reportedAbsentBookTokens.delete(tokenId);
    }
    if (!Array.isArray(response) || newlyMissingTokenIds.length || duplicateTokenIds.length || unrequestedTokenIds.length || invalidResponseIndices.length) {
      await this.recordControlled({ source: "clob", kind: "book_snapshot_batch_error", data: {
        ...audit, code: Array.isArray(response) ? "CLOB_BOOK_BATCH_IDENTITY_MISMATCH" : "CLOB_BOOK_BATCH_INVALID_RESPONSE",
        missingTokenIds: newlyMissingTokenIds, duplicateTokenIds, unrequestedTokenIds, invalidResponseIndices
      } }, true);
    }
    for (const tokenId of tokenIds) {
      const matches = returned.get(tokenId);
      // Ambiguous or missing books remain only in raw evidence and diagnostics.
      // No fallback GET burst, empty substitute, or verification is manufactured.
      if (matches?.length !== 1) continue;
      const match = matches[0]!;
      await this.recordControlled({ source: "clob", kind: "book_snapshot", data: {
        tokenId, url, method, requestStartedAt, requestEndedAt, response: match.response,
        provenance: { batchId, responseIndex: match.responseIndex }
      } }, true);
    }
  }

  /** True while a proven-absent token is inside its backoff window. */
  private absentBookSuppressed(tokenId: string, nowMs: number): boolean {
    const retryAtMs = this.absentBookRetryAtMs.get(tokenId);
    if (retryAtMs === undefined) return false;
    if (nowMs < retryAtMs) return true;
    this.absentBookRetryAtMs.delete(tokenId);
    return false;
  }

  private async snapshotToken(tokenId: string): Promise<void> {
    const requestStartedAt = dateValue(this.now()).toISOString();
    const url = `${this.options.clobBaseUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
    let response: unknown;
    try {
      response = await this.request(url);
    } catch (error) {
      const requestEndedAt = dateValue(this.now()).toISOString();
      await this.recordControlled({ source: "clob", kind: "http_error", data: { tokenId, url, requestStartedAt, requestEndedAt, error: serializeError(error) } }, true);
      return;
    }
    const requestEndedAt = dateValue(this.now()).toISOString();
    await this.recordControlled({ source: "clob", kind: "book_snapshot", data: { tokenId, url, requestStartedAt, requestEndedAt, response } }, true);
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
      await this.controlledWrites;
      await this.subscriptionWrites;
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
