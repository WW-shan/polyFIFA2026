import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fetchJson } from "../polymarket/http.js";
import { createCollector, type CollectorDependencies, type CollectorRuntime } from "./collector.js";
import { createJournal, type CollectorJournal } from "./journal.js";
import { discoverContinuousEvents } from "./continuous-discovery.js";
import type { ContinuousConfig } from "./continuous-config.js";
import { ContinuousState, type CapturedGame } from "./continuous-state.js";
import { runTailExport } from "./continuous-export.js";
import { sealJournalSnapshot } from "./sealed-journal.js";
import { startContinuousServer } from "./continuous-server.js";
import { acquireCaptureLock, availableDiskBytes, rawRunBytes, readCaptureState, writeCaptureState } from "./continuous-storage.js";
import type { JsonRequester, RecordInput } from "./types.js";
import { metadataFromRecord } from "./tail-context.js";

export interface ContinuousDependencies {
  createCollector?: typeof createCollector;
  createJournal?: typeof createJournal;
  diskBytes?: typeof availableDiskBytes;
  startServer?: typeof startContinuousServer;
  runExport?: typeof runTailExport;
  sealSnapshot?: typeof sealJournalSnapshot;
  now?: () => number;
  request?: JsonRequester;
}

export class ContinuousCollector {
  readonly state: ContinuousState;
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private rejectDone!: (error: unknown) => void;
  private readonly cancellation = new AbortController();
  private readonly now: () => number;
  private runtime: CollectorRuntime | undefined;
  private journal: CollectorJournal | undefined;
  private captureTask: Promise<void> | undefined;
  private archiveTask: Promise<void> | undefined;
  private archiveCancellation: AbortController | undefined;
  private startTask: Promise<void> | undefined;
  private stopTask: Promise<void> | undefined;
  private pulseTask: Promise<void> | undefined;
  private persistence: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private lock: Awaited<ReturnType<typeof acquireCaptureLock>> | undefined;
  private server: Awaited<ReturnType<typeof startContinuousServer>> | undefined;
  private nextStartAtMs = 0;
  private pausedForDisk = false;
  private stopping = false;
  private stateReady = false;
  private readonly finishLookups = new Map<string, number>();
  private clock: { runId: string; firstWall: number; firstMono: bigint; lastWall: number; lastMono: bigint } | undefined;
  private clockFaultRunId: string | undefined;
  private clockRestartRequested = false;

  constructor(readonly config: ContinuousConfig, private readonly dependencies: ContinuousDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
    this.state = new ContinuousState(config.dataRoot, config.port);
    this.done = new Promise<void>((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
    void this.done.catch(() => {});
  }
  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error("CONTINUOUS_STOPPED"));
    this.startTask ??= this.initialize().catch(async error => {
      this.stopping = true; this.cancellation.abort(error); this.state.issue("startup", error);
      await this.cleanup().catch(cleanupError => this.state.issue("cleanup", cleanupError));
      this.rejectDone(error); throw error;
    });
    return this.startTask;
  }
  private async initialize(): Promise<void> {
    await mkdir(this.config.dataRoot, { recursive: true, mode: 0o700 });
    for (const name of ["runs", "checkpoints", "exports", "finish-facts", "logs"]) await this.ownedDirectory(name);
    this.lock = await acquireCaptureLock(this.config.dataRoot);
    this.cancellation.signal.throwIfAborted();
    const previous = await readCaptureState(this.config.dataRoot);
    if (previous) this.state.restore(previous);
    this.stateReady = true;
    this.server = await (this.dependencies.startServer ?? startContinuousServer)({ port: this.config.port, dataRoot: this.config.dataRoot, getStatus: () => this.state.snapshot() });
    this.cancellation.signal.throwIfAborted();
    await this.pulse();
    this.cancellation.signal.throwIfAborted();
    this.timer = setInterval(() => {
      void this.pulse().catch(error => {
        this.state.issue("supervisor", error);
        void this.runtime?.stop().catch(stopError => this.state.issue("capture", stopError));
      });
    }, this.config.pulseIntervalMs);
  }
  private record(journal: CollectorJournal, input: RecordInput): void {
    const record = journal.record(input);
    this.state.observe(record);
    const mono = BigInt(record.monotonicNs);
    if (this.clock?.runId !== record.runId) {
      this.clock = { runId: record.runId, firstWall: record.receivedAtMs, firstMono: mono, lastWall: record.receivedAtMs, lastMono: mono };
      this.clockFaultRunId = undefined;
    } else {
      const drift = record.receivedAtMs - this.clock.firstWall - Number(mono - this.clock.firstMono) / 1e6;
      if ((mono < this.clock.lastMono || Math.abs(drift) > 5000) && this.clockFaultRunId !== record.runId) {
        this.clockFaultRunId = record.runId; this.clockRestartRequested = true;
        this.state.issue("clock", `receipt clock discontinuity in ${record.runId}; drift=${Math.round(drift)}ms; new run required`, record.receivedAtMs);
      } else if (record.receivedAtMs < this.clock.lastWall && this.clockFaultRunId !== record.runId) {
        this.state.issue("clock", `UTC moved backward ${this.clock.lastWall - record.receivedAtMs}ms; raw timestamps retained`, record.receivedAtMs);
      }
      this.clock.lastWall = record.receivedAtMs; this.clock.lastMono = mono;
    }
  }
  private startCapture(): void {
    if (this.runtime || this.stopping) return;
    const config = this.config;
    const dependencies: CollectorDependencies = {
      now: this.now,
      discover: (options, deps) => discoverContinuousEvents(options, deps, config.profiles, issue => {
        this.state.issue(`discovery:${issue.scope}`, `${issue.key}: ${issue.message}`, this.now());
        if (this.journal) this.record(this.journal, { source: "collector", kind: "discovery_scope_error", data: issue });
      }),
      createJournal: async options => {
        const journal = await (this.dependencies.createJournal ?? createJournal)(options);
        this.journal = journal;
        this.state.setRun(journal.runId, journal.runDirectory);
        return { runId: journal.runId, runDirectory: journal.runDirectory,
          record: input => this.record(journal, input), flush: () => journal.flush(), close: () => journal.close() };
      }
    };
    const runtime = (this.dependencies.createCollector ?? createCollector)({ rootDir: join(config.dataRoot, "runs"),
      gammaBaseUrl: config.gammaBaseUrl, clobBaseUrl: config.clobBaseUrl, clobWsUrl: config.clobWsUrl, sportsWsUrl: config.sportsWsUrl,
      ...(config.proxyUrl === undefined ? {} : { proxyUrl: config.proxyUrl }),
      dateWindow: "game-start", lookbackHours: config.lookbackHours, aheadHours: config.aheadHours,
      discoveryIntervalMs: config.discoveryIntervalMs, snapshotIntervalMs: config.snapshotIntervalMs,
      httpTimeoutMs: config.httpTimeoutMs, postFinishRetentionMs: config.postFinishRetentionMs, reconciliationConcurrency: 4,
      backgroundInitialSnapshots: true, snapshotBatchSize: 50
    }, dependencies);
    this.runtime = runtime;
    this.state.mode = "starting";
    this.captureTask = runtime.run().then(() => {
      if (!this.stopping && !this.pausedForDisk) this.state.issue("capture", "collector stopped; restart scheduled", this.now());
    }).catch(error => this.state.issue("capture", error, this.now())).finally(() => {
      if (this.runtime === runtime) { this.runtime = undefined; this.journal = undefined; }
      if (!this.stopping && !this.pausedForDisk) {
        this.nextStartAtMs = this.now() + config.retryDelayMs;
        this.state.mode = "restarting";
      }
    });
  }
  pulse(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.pulseTask ??= this.performPulse().finally(() => { this.pulseTask = undefined; });
    return this.pulseTask;
  }
  private async performPulse(): Promise<void> {
    const free = await (this.dependencies.diskBytes ?? availableDiskBytes)(this.config.dataRoot);
    if (this.stopping) return;
    this.state.freeBytes = free;
    if (this.clockRestartRequested && this.runtime) {
      this.clockRestartRequested = false; this.state.mode = "restarting";
      await this.runtime.stop().catch(error => this.state.issue("capture", error));
      await this.captureTask;
    }
    if (this.stopping) return;
    if (free < this.config.minFreeBytes) {
      if (!this.pausedForDisk) this.state.issue("disk", "free space below reserve; collection paused without deleting data", this.now());
      this.pausedForDisk = true; this.state.mode = "paused_disk";
      this.archiveCancellation?.abort(new Error("CAPTURE_DISK_LOW"));
      await this.runtime?.stop().catch(error => this.state.issue("capture", error));
      await this.captureTask;
    } else {
      const resumeMargin = this.pausedForDisk ? Math.min(1024 ** 3, Math.floor(this.config.minFreeBytes / 20)) : 0;
      if (free >= this.config.minFreeBytes + resumeMargin) this.pausedForDisk = false;
      if (!this.stopping && !this.pausedForDisk && !this.runtime && this.now() >= this.nextStartAtMs) this.startCapture();
      if (this.runtime?.status === "running") this.state.mode = "collecting";
    }
    if (this.stopping) return;
    this.state.desiredTokens = this.runtime?.tokenIds.length ?? 0;
    this.state.queuedBytes = this.journal?.pendingBytes ?? 0;
    if (this.journal) this.state.rawBytes = await rawRunBytes(this.journal.runDirectory);
    if (!this.pausedForDisk && this.journal && this.runtime?.status === "running") await this.refreshMissingFinish(this.journal);
    if (this.stopping) return;
    if (!this.pausedForDisk && !this.archiveTask && this.journal && this.runtime?.status === "running") {
      const game = this.state.readyToArchive(this.journal.runId, this.now())[0];
      if (game) this.beginArchive(game, this.journal);
    }
    await this.persist();
  }
  private beginArchive(game: CapturedGame, journal: CollectorJournal): void {
    const controller = new AbortController();
    this.archiveCancellation = controller;
    const signal = AbortSignal.any([controller.signal, this.cancellation.signal]);
    const key = createHash("sha256").update(game.key).digest("hex").slice(0, 16);
    const id = `${key}-${this.now()}-${randomUUID().slice(0, 8)}`;
    const outputDirectory = join(this.config.dataRoot, "exports", id);
    const attempt = (game.archive?.attempt ?? 0) + 1;
    const revision = game.finishRevision ?? 0;
    const refresh = game.archive?.refreshSnapshot === true || game.finishConflict;
    const existingSnapshot = !refresh && game.archive?.status === "failed" ? game.archive.snapshotDirectory : undefined;
    // Price evidence stays in its recorded run. Newer finish evidence is an
    // independent facts sidecar, never a replacement by an empty newer run.
    const sourceRunId = existingSnapshot ? game.archive!.runId : game.lastBookRunId ?? journal.runId;
    const stoppedSource = sourceRunId !== journal.runId ? game.sources.find(source => source.runId === sourceRunId)?.runDirectory : undefined;
    const inputDirectory = existingSnapshot ?? stoppedSource;
    let inputReady = false;
    const assertRevision = (): void => { if ((game.finishRevision ?? 0) !== revision) throw new Error("CAPTURE_FINISH_CHANGED_DURING_EXPORT"); };
    this.state.markArchive(game.key, { status: "running", runId: sourceRunId, attempt,
      ...(inputDirectory ? { snapshotDirectory: inputDirectory } : {}), ...(refresh ? { refreshSnapshot: true } : {}) });
    this.archiveTask = (async () => {
      await this.persist(); signal.throwIfAborted(); assertRevision();
      let snapshotDirectory: string;
      if (inputDirectory) {
        snapshotDirectory = await this.validateArchiveInput(inputDirectory, sourceRunId);
      } else {
        if (sourceRunId !== journal.runId) throw new Error("CAPTURE_ARCHIVE_SOURCE_MISSING");
        const firstSequence = game.sourceFirstSequences?.[journal.runId];
        const sealed = await (this.dependencies.sealSnapshot ?? sealJournalSnapshot)(journal, join(this.config.dataRoot, "checkpoints", id),
          Number.isSafeInteger(firstSequence) && firstSequence! > 0 ? { fromSequence: firstSequence! } : {});
        snapshotDirectory = sealed.runDirectory;
      }
      assertRevision();
      // Keep the source record durable before publishing derived finish facts.
      await journal.flush(); signal.throwIfAborted(); assertRevision();
      const finishFactsFile = await this.writeFinishFacts(game, id, sourceRunId);
      assertRevision();
      this.state.markArchive(game.key, { status: "running", runId: sourceRunId, attempt, snapshotDirectory,
        finishRevision: revision, ...(finishFactsFile ? { finishFactsFile } : {}) });
      inputReady = true;
      await this.persist(); signal.throwIfAborted();
      const result = await (this.dependencies.runExport ?? runTailExport)({ snapshotDirectory, outputDirectory,
        eventSlugs: [...game.eventSlugs], gameKey: game.key, timeoutMs: this.config.exportTimeoutMs,
        ...(finishFactsFile ? { finishFactsFile } : {}) }, signal);
      assertRevision();
      this.state.markArchive(game.key, { status: "complete", runId: sourceRunId, attempt, snapshotDirectory,
        finishRevision: revision, ...(finishFactsFile ? { finishFactsFile } : {}), ...result });
    })().catch(error => {
      const current = this.state.snapshot().games.find(value => value.key === game.key)?.archive;
      const refreshSnapshot = current?.refreshSnapshot === true || (game.finishRevision ?? 0) !== revision || (refresh && !inputReady);
      this.state.markArchive(game.key, { status: "failed", runId: sourceRunId, attempt, error: String(error),
        ...(refreshSnapshot ? { refreshSnapshot: true } : current?.snapshotDirectory ? { snapshotDirectory: current.snapshotDirectory } : {}),
        ...(!refreshSnapshot && current?.finishFactsFile ? { finishFactsFile: current.finishFactsFile } : {}),
        retryAtMs: this.now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(attempt - 1, 6)) });
      this.state.issue("archive", error, this.now());
    }).finally(async () => {
      await this.persist().catch(error => this.state.issue("state", error));
      this.archiveTask = undefined; this.archiveCancellation = undefined;
    });
  }
  private async ownedDirectory(name: string): Promise<string> {
    const target = join(this.config.dataRoot, name);
    try { await mkdir(target, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const entry = await lstat(target), root = await realpath(this.config.dataRoot), actual = await realpath(target), suffix = relative(root, actual);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !suffix || suffix.startsWith("..")) throw new Error("CAPTURE_PATH_INVALID: storage subdirectory must stay inside data root");
    return target;
  }
  private async writeFinishFacts(game: CapturedGame, id: string, runId: string): Promise<string | undefined> {
    if (!game.finishFacts?.length) return undefined;
    const directory = await this.ownedDirectory("finish-facts"), path = join(directory, `${id}.json`);
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ schemaVersion: 1, kind: "tail-finish-facts", runId, facts: game.finishFacts }) + "\n"); await file.sync(); }
    finally { await file.close(); }
    return path;
  }
  private async validateArchiveInput(input: string, sourceRunId: string): Promise<string> {
    const target = resolve(input), entry = await lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("CAPTURE_SNAPSHOT_PATH_INVALID");
    const actual = await realpath(target);
    for (const kind of ["checkpoints", "runs"] as const) {
      const parent = await this.ownedDirectory(kind), suffix = relative(parent, target);
      if (!suffix || suffix.startsWith("..") || resolve(parent, suffix) !== target) continue;
      const actualParent = await realpath(parent), actualSuffix = relative(actualParent, actual);
      if (!actualSuffix || actualSuffix.startsWith("..") || resolve(actualParent, actualSuffix) !== actual) continue;
      if (kind === "runs" && (basename(target) !== sourceRunId || sourceRunId === this.journal?.runId)) continue;
      return target;
    }
    throw new Error("CAPTURE_SNAPSHOT_PATH_INVALID");
  }
  private async refreshMissingFinish(journal: CollectorJournal): Promise<void> {
    const now = this.now();
    const game = this.state.snapshot().games.filter(game => game.firstBookAtMs !== null && game.finishedAtMs === null &&
      game.eventIds.every(id => game.retiredEventIds.includes(id)) && now - game.firstSeenAtMs < 72 * 3600_000 &&
      now - (this.finishLookups.get(game.key) ?? -Infinity) >= 60_000)
      .sort((a, b) => (this.finishLookups.get(a.key) ?? -Infinity) - (this.finishLookups.get(b.key) ?? -Infinity))[0];
    if (!game) return;
    this.finishLookups.set(game.key, now);
    const slug = game.eventSlugs[0]!, url = `${this.config.gammaBaseUrl.replace(/\/+$/, "")}/events/slug/${encodeURIComponent(slug)}`;
    const request = this.dependencies.request ?? ((url, options) => fetchJson(url, { ...options,
      ...(this.config.proxyUrl === undefined ? {} : { proxyUrl: this.config.proxyUrl }) }));
    const requestStartedAt = new Date(now).toISOString();
    try {
      const response = await request(url, { timeoutMs: this.config.httpTimeoutMs, signal: this.cancellation.signal });
      if (this.stopping || this.journal !== journal) return;
      await journal.flush();
      this.record(journal, { source: "gamma", kind: "http_request", data: { url, requestStartedAt, requestEndedAt: new Date(this.now()).toISOString(), response } });
      const at = this.now(), metadata = metadataFromRecord({ schemaVersion: 1, runId: journal.runId, sequence: 1,
        receivedAtMs: at, receivedAt: new Date(at).toISOString(), monotonicNs: "0", source: "gamma", kind: "event_metadata", data: { event: response } });
      if (!metadata || !game.eventIds.includes(metadata.eventId) || metadata.eventSlug !== slug || metadata.gameId !== game.gameId) throw new Error("CAPTURE_FINISH_IDENTITY_MISMATCH");
      await journal.flush();
      if (!this.stopping && this.journal === journal) this.record(journal, { source: "gamma", kind: "event_metadata", data: { event: response, status: "finish-followup" } });
    } catch (error) { if (!this.stopping) this.state.issue("finish_labels", error, this.now()); }
    if (this.finishLookups.size > 2048) this.finishLookups.delete(this.finishLookups.keys().next().value!);
  }
  private persist(): Promise<void> {
    if (!this.lock || !this.stateReady) return Promise.resolve();
    const work = this.persistence.catch(() => {}).then(() => writeCaptureState(this.config.dataRoot, this.state.snapshot()));
    this.persistence = work; return work;
  }
  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopping = true; this.state.mode = "stopping";
    this.cancellation.abort(new Error("CONTINUOUS_STOPPED"));
    if (this.timer) clearInterval(this.timer);
    this.stopTask = (async () => {
      await this.startTask?.catch(() => {});
      await this.pulseTask?.catch(error => this.state.issue("pulse", error));
      await this.cleanup(); this.resolveDone();
    })().catch(error => { this.rejectDone(error); throw error; });
    return this.stopTask;
  }
  private async cleanup(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.archiveCancellation?.abort(new Error("CONTINUOUS_STOPPED"));
    await this.runtime?.stop().catch(error => this.state.issue("capture", error));
    await this.captureTask;
    await this.archiveTask;
    this.state.mode = "stopped";
    try { await this.persist(); }
    finally {
      const server = this.server; this.server = undefined;
      const lock = this.lock; this.lock = undefined;
      try { await server?.close(); } finally { await lock?.release(); }
    }
  }
}
