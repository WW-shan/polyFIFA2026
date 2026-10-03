/**
 * Polymarket sports-feed score frames for the live tennis tail watcher.
 *
 * The backtest (data/research/backtest-audit-20261003.md) arms on the
 * `wss://sports-api.polymarket.com/ws` game score, measured against archived
 * CLOB book snapshots. The live path must consume the *same* feed, so this
 * module parses those frames and keeps the latest score per `gameId`; the
 * Gen1 rule itself lives in `src/domain/tennis-gen1.ts`.
 *
 * The frame is the raw feed payload:
 *   `{"gameId":6374886,"homeTeam":"Gustavo Heide","awayTeam":"Pedro Boscardin Dias",
 *     "status":"inprogress","score":"6-2, 5-2","period":"S2","live":true,"ended":false}`
 *
 * Some producers wrap that JSON in a string (the collector journal stores the
 * frame text inside `data`), so the parser accepts either nesting.
 */

export interface TennisSportsScore {
  gameId: string;
  /** Sports-feed score string, e.g. `"6-2, 5-2"` or `"6-4, 6-6(5-2)"`. */
  score: string;
  homeName: string;
  awayName: string;
  league: string | null;
  status: string | null;
  period: string | null;
  live: boolean;
  ended: boolean;
  /** When this score/state first became visible (the feed's change time). */
  observedAtMs: number;
  /** When the feed last sent this score, including unchanged repeats. */
  receivedAtMs: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** `gameId` arrives as a number; it is kept as a string so lookups are type-stable. */
function gameIdValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  return null;
}

function parseMaybe(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== "string") return current;
    const text = current.trim();
    if (text.length === 0) return null;
    try {
      current = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Parses one sports-feed frame. Returns null for anything that is not a tennis
 * score update (heartbeats, malformed payloads, partial frames without both
 * player names).
 */
export function parseTennisSportsScore(raw: unknown, observedAtMs: number): TennisSportsScore | null {
  let value = parseMaybe(raw);
  let frame = record(value);
  // The collector journal wraps the raw frame text in `data`.
  if (frame && "data" in frame && (frame.score === undefined || frame.gameId === undefined)) {
    value = parseMaybe(frame.data);
    frame = record(value);
  }
  if (!frame) return null;
  const gameId = gameIdValue(frame.gameId);
  const score = nonemptyString(frame.score);
  const homeName = nonemptyString(frame.homeTeam);
  const awayName = nonemptyString(frame.awayTeam);
  if (!gameId || !score || !homeName || !awayName) return null;
  const status = nonemptyString(frame.status);
  const live = frame.live === true || status === "inprogress";
  const ended = frame.ended === true || status === "finished";
  return {
    gameId,
    score,
    homeName,
    awayName,
    league: nonemptyString(frame.leagueAbbreviation),
    status,
    period: nonemptyString(frame.period),
    live,
    ended,
    observedAtMs,
    receivedAtMs: observedAtMs
  };
}

/**
 * Latest score per `gameId`, with a wake-up primitive for the watch loop.
 *
 * The board never filters which frames are *stored* (that is one cheap map
 * write); `setMonitoredGameIds` only decides whose updates wake the loop, so a
 * busy tennis afternoon cannot turn into a discovery storm.
 */
export class TennisSportsScoreBoard {
  private readonly now: () => number;
  private readonly latest = new Map<string, TennisSportsScore>();
  private monitored: Set<string> | null = null;
  private waiters = new Set<() => void>();
  private revision = 0;
  private disposed = false;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Frames parsed and stored. */
  get size(): number {
    return this.latest.size;
  }

  /** Monotonic counter: bumps on every stored (monitored) update. */
  get version(): number {
    return this.revision;
  }

  selectMonitoredGameIds(gameIds: Iterable<string>): void {
    this.monitored = new Set(gameIds);
  }

  /** Parses and stores one frame. Returns the parsed score, or null when ignored. */
  ingest(raw: unknown, observedAtMs?: number): TennisSportsScore | null {
    if (this.disposed) return null;
    const parsed = parseTennisSportsScore(raw, observedAtMs ?? this.now());
    if (!parsed) return null;
    const previous = this.latest.get(parsed.gameId);
    // The feed repeats frames; only a changed score/state is a new observation.
    // Repeats still refresh `receivedAtMs` so liveness detection stays honest.
    if (previous && previous.score === parsed.score && previous.status === parsed.status
      && previous.ended === parsed.ended) {
      this.latest.set(parsed.gameId, { ...previous, receivedAtMs: parsed.receivedAtMs });
      return parsed;
    }
    this.latest.set(parsed.gameId, parsed);
    if (this.monitored === null || this.monitored.has(parsed.gameId)) {
      this.revision += 1;
      this.releaseWaiters();
    }
    return parsed;
  }

  latestFor(gameId: string): TennisSportsScore | undefined {
    return this.latest.get(gameId);
  }

  /**
   * Resolves when the monitored revision moves past `sinceVersion`, or after
   * `timeoutMs`. The timeout path is the scan-cadence fallback; the resolver
   * path is what makes a score tick sweep the book immediately.
   */
  async waitForVersionChange(sinceVersion: number, timeoutMs: number): Promise<void> {
    if (this.disposed || this.revision !== sinceVersion) return;
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        this.waiters.delete(finish);
        if (timer) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(finish, Math.max(0, timeoutMs));
      this.waiters.add(finish);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.releaseWaiters();
  }

  private releaseWaiters(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}
