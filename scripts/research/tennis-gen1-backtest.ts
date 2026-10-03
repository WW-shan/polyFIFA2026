/**
 * Archived replay of the tennis-tail Gen1 universe.
 *
 * The entry rule is *not* re-implemented in this file: it imports the shared
 * `tennisGen1` decision, the same one the live watcher uses. On top of it the
 * replay keeps the archived per-price semantics (each ladder price arms at its
 * own first qualifying snapshot) and the live market-leader guard.
 *
 * `tests/research/tennis-gen1-parity.test.ts` additionally drives captured
 * fixtures through the production `planTennisTailFromScore` composition and
 * asserts both paths arm every price at the same snapshot.
 *
 * Usage:
 *   npx tsx scripts/research/tennis-gen1-backtest.ts \
 *     --db data/collector/continuous/tail.sqlite --out /tmp/gen1-orders.json
 *   npx tsx scripts/research/tennis-gen1-backtest.ts \
 *     --db data/collector/continuous/tail.sqlite --fixture game:6374478 \
 *     --out tests/fixtures/tennis-gen1/game-6374478.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { inflateRawSync } from "node:zlib";
import { tennisGen1 } from "../../src/domain/tennis-gen1.js";
import type { MarketTickSize } from "../../src/domain/types.js";

export const DEFAULT_REPLAY_PRICES: readonly number[] = [0.70, 0.75, 0.80, 0.85, 0.88, 0.90, 0.92, 0.95, 0.97, 0.99];
/** The live ladder; the summary reports this subset. */
export const LIVE_LADDER_PRICES: readonly number[] = [0.80, 0.85, 0.88, 0.90, 0.92];

export interface ReplayBookSnapshot {
  tMs: number;
  bid: number | null;
  ask: number | null;
}

export interface ReplaySportsFrame {
  tMs: number;
  score: string;
  homeName: string | null;
  awayName: string | null;
}

export interface ReplayTokenSeries {
  tokenKey: string;
  /** Side in the sports feed's home/away coordinate. */
  side: "home" | "away";
  snapshots: readonly ReplayBookSnapshot[];
  /** The other outcome's series, for the live market-leader guard. */
  otherTokenKey?: string;
}

export interface ReplayOptions {
  prices: readonly number[];
  setsToWin: number;
  finishAtMs?: number;
  /** Live skips a token whose best bid is behind the other outcome's. */
  marketLeaderGuard?: boolean;
}

export interface ReplayOrder {
  tokenKey: string;
  side: "home" | "away";
  price: number;
  entryAtMs: number;
  entryScore: string;
  entryKind: "game" | "tiebreak";
  entryBid: number | null;
  entryAsk: number | null;
  filled: boolean;
  touchAtMs: number | null;
  leadMs: number | null;
  /** Milliseconds from the entry snapshot to the archived finish, when known. */
  entryMsToFinish: number | null;
  /** Snapshots skipped because the other outcome held a higher best bid. */
  marketLeaderBlocks: number;
}

/** Latest row with `tMs <= atMs`, or undefined. Input must be time-sorted. */
function latestAtOrBefore<T extends { tMs: number }>(rows: readonly T[], atMs: number): T | undefined {
  let low = 0;
  let high = rows.length - 1;
  let found: T | undefined;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const row = rows[mid]!;
    if (row.tMs <= atMs) {
      found = row;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * Per-price replay: each price arms at the first snapshot where
 * `tennisGen1` names this token's side and `bid >= price && (ask == null || ask > price)`
 * holds, then fills when a later snapshot prints `ask <= price`.
 */
export function replayTennisGen1Orders(
  sportsInput: readonly ReplaySportsFrame[],
  tokensInput: readonly ReplayTokenSeries[],
  options: ReplayOptions
): ReplayOrder[] {
  const sports = [...sportsInput].sort((a, b) => a.tMs - b.tMs);
  const snapshotsByToken = new Map<string, ReplayBookSnapshot[]>();
  for (const token of tokensInput) snapshotsByToken.set(token.tokenKey, [...token.snapshots].sort((a, b) => a.tMs - b.tMs));
  const leaderGuard = options.marketLeaderGuard ?? true;
  const orders: ReplayOrder[] = [];

  for (const token of tokensInput) {
    const rows = snapshotsByToken.get(token.tokenKey) ?? [];
    if (rows.length === 0) continue;
    const otherRows = token.otherTokenKey !== undefined ? snapshotsByToken.get(token.otherTokenKey) ?? [] : [];
    for (const price of options.prices) {
      let entry: ReplayBookSnapshot | undefined;
      let entryScore: string | null = null;
      let entryKind: "game" | "tiebreak" = "game";
      let leaderBlocks = 0;
      for (const row of rows) {
        const scored = latestAtOrBefore(sports, row.tMs);
        if (!scored) continue;
        const decision = tennisGen1(scored.score, options.setsToWin);
        if (!decision || decision.side !== token.side) continue;
        if (row.bid === null || row.bid < price) continue;
        if (row.ask !== null && row.ask <= price) continue;
        if (leaderGuard && otherRows.length > 0) {
          const other = latestAtOrBefore(otherRows, row.tMs);
          if (other && other.bid !== null && (row.bid === null || row.bid < other.bid)) {
            leaderBlocks += 1;
            continue;
          }
        }
        entry = row;
        entryScore = scored.score;
        entryKind = decision.kind;
        break;
      }
      if (!entry) continue;
      let touch: ReplayBookSnapshot | undefined;
      for (const row of rows) {
        if (row.tMs <= entry.tMs) continue;
        if (row.ask !== null && row.ask <= price) {
          touch = row;
          break;
        }
      }
      orders.push({
        tokenKey: token.tokenKey,
        side: token.side,
        price,
        entryAtMs: entry.tMs,
        entryScore: entryScore ?? "",
        entryKind,
        entryBid: entry.bid,
        entryAsk: entry.ask,
        filled: touch !== undefined,
        touchAtMs: touch?.tMs ?? null,
        leadMs: touch !== undefined ? touch.tMs - entry.tMs : null,
        entryMsToFinish: options.finishAtMs !== undefined ? options.finishAtMs - entry.tMs : null,
        marketLeaderBlocks: leaderBlocks
      });
    }
  }
  return orders;
}

export interface ReplaySummary {
  orders: number;
  entries: number;
  fills: number;
  /** Fills whose token has no archived settlement yet. */
  unpriced: number;
  wins: number;
  losses: number;
  cost: number;
  pnl: number;
  roi: number;
  perPrice: Record<string, { entries: number; fills: number; wins: number; losses: number; cost: number; pnl: number }>;
}

export function summarizeReplay(
  orders: readonly ReplayOrder[],
  payoutOf: (tokenKey: string) => number | undefined,
  prices: readonly number[] = LIVE_LADDER_PRICES
): ReplaySummary {
  const ladder = new Set(prices.map((price) => Number(price.toFixed(6))));
  const selected = orders.filter((order) => ladder.has(Number(order.price.toFixed(6))));
  const summary: ReplaySummary = {
    orders: orders.length, entries: selected.length, fills: 0, unpriced: 0, wins: 0, losses: 0, cost: 0, pnl: 0, roi: 0, perPrice: {}
  };
  for (const order of selected) {
    const bucket = summary.perPrice[String(order.price)] ?? { entries: 0, fills: 0, wins: 0, losses: 0, cost: 0, pnl: 0 };
    bucket.entries += 1;
    if (!order.filled) {
      summary.perPrice[String(order.price)] = bucket;
      continue;
    }
    const payout = payoutOf(order.tokenKey);
    bucket.fills += 1;
    summary.fills += 1;
    if (payout === undefined) {
      summary.unpriced += 1;
      summary.perPrice[String(order.price)] = bucket;
      continue;
    }
    const pnl = payout - order.price;
    bucket.cost += order.price;
    bucket.pnl += pnl;
    summary.cost += order.price;
    summary.pnl += pnl;
    if (payout >= 1) {
      bucket.wins += 1;
      summary.wins += 1;
    } else {
      bucket.losses += 1;
      summary.losses += 1;
    }
    summary.perPrice[String(order.price)] = bucket;
  }
  summary.roi = summary.cost > 0 ? summary.pnl / summary.cost : 0;
  return summary;
}

export function loadPayouts(directory: string, files: readonly string[]): Map<string, number> {
  const payouts = new Map<string, number>();
  for (const file of files) {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(`${directory}/${file}`, "utf8")) as unknown;
    } catch {
      continue;
    }
    const settlements = recordValue(doc)?.["settlements"];
    if (!Array.isArray(settlements)) continue;
    for (const value of settlements) {
      const entry = recordValue(value);
      if (!entry) continue;
      const tokenId = entry["tokenId"];
      const payout = Number(entry["payout"]);
      if (typeof tokenId === "string" && Number.isFinite(payout)) payouts.set(tokenId, payout);
    }
  }
  return payouts;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function decodePayload(payload: unknown): unknown {
  try {
    const buffer = Buffer.from(payload as Uint8Array);
    return JSON.parse(inflateRawSync(buffer).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function normalizeName(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
}

/** Side of an outcome name in the sports feed's home/away coordinate. */
export function sideOfName(name: string, home: string | null, away: string | null): "home" | "away" | null {
  const target = normalizeName(name);
  if (!target) return null;
  const matches = (candidate: string | null): boolean => {
    if (!candidate) return false;
    const other = normalizeName(candidate);
    return other.length > 0 && (other === target || other.includes(target) || target.includes(other));
  };
  const homeMatch = matches(home);
  const awayMatch = matches(away);
  if (homeMatch === awayMatch) return null;
  return homeMatch ? "home" : "away";
}

export interface ArchiveMatch {
  gameKey: string;
  title: string;
  gameId: string;
  metadata: Record<string, unknown>;
  finishedAtMs: number | null;
  market: Record<string, unknown>;
  outcomes: string[];
  tokenIds: string[];
}

/** Moneyline matches that have both a sports score feed and archived books. */
export function loadArchiveMatches(db: DatabaseSync): ArchiveMatch[] {
  const rows = db.prepare(
    "select game_key,title,game_id,metadata_json,finished_at_ms from matches where sport in ('tennis','itf')"
  ).all() as Array<Record<string, unknown>>;
  const matches: ArchiveMatch[] = [];
  for (const row of rows) {
    const metadata = recordValue(parseMaybe(row["metadata_json"]));
    if (!metadata) continue;
    const markets = Array.isArray(metadata["markets"]) ? metadata["markets"] : [];
    const market = markets.map((value) => recordValue(value)).find((value) => value?.["sportsMarketType"] === "moneyline");
    if (!market) continue;
    const outcomes = parseMaybe(market["outcomes"]);
    const tokenIds = parseMaybe(market["clobTokenIds"]);
    if (!Array.isArray(outcomes) || outcomes.length !== 2 || !Array.isArray(tokenIds) || tokenIds.length !== 2) continue;
    matches.push({
      gameKey: String(row["game_key"]),
      title: String(row["title"] ?? ""),
      gameId: String(row["game_id"] ?? ""),
      metadata,
      finishedAtMs: row["finished_at_ms"] === null || row["finished_at_ms"] === undefined ? null : Number(row["finished_at_ms"]),
      market,
      outcomes: outcomes.map((value) => String(value)),
      tokenIds: tokenIds.map((value) => String(value))
    });
  }
  return matches;
}

export interface ArchiveSeries {
  sports: ReplaySportsFrame[];
  books: Map<string, ReplayBookSnapshot[]>;
}

/** Sports frames and book snapshots for one game key (both tokens). */
export function loadArchiveSeries(db: DatabaseSync, gameKey: string): ArchiveSeries {
  const sports: ReplaySportsFrame[] = [];
  const sportsRows = db.prepare(
    "select t.received_at_ms,p.payload from tail_records t join payloads p on p.hash=t.payload_hash " +
    "where t.source='sports' and t.kind='ws_message' and t.game_key=?"
  ).all(gameKey) as Array<Record<string, unknown>>;
  for (const row of sportsRows) {
    const decoded = recordValue(decodePayload(row["payload"]));
    const data = recordValue(parseMaybe(decoded?.["data"]));
    const score = typeof data?.["score"] === "string" ? data["score"] : null;
    if (!score) continue;
    sports.push({
      tMs: Number(row["received_at_ms"]),
      score,
      homeName: typeof data?.["homeTeam"] === "string" ? data["homeTeam"] : null,
      awayName: typeof data?.["awayTeam"] === "string" ? data["awayTeam"] : null
    });
  }
  const books = new Map<string, ReplayBookSnapshot[]>();
  const bookRows = db.prepare(
    "select t.received_at_ms,p.payload from tail_records t join payloads p on p.hash=t.payload_hash " +
    "where t.source='clob' and t.kind='book_snapshot' and t.game_key=?"
  ).all(gameKey) as Array<Record<string, unknown>>;
  for (const row of bookRows) {
    const decoded = recordValue(decodePayload(row["payload"]));
    const data = recordValue(parseMaybe(decoded?.["data"]));
    const response = recordValue(data?.["response"]);
    const tokenId = typeof response?.["asset_id"] === "string" ? response["asset_id"]
      : typeof data?.["tokenId"] === "string" ? data["tokenId"] : null;
    if (!tokenId || !response) continue;
    const prices = (value: unknown): number[] => (Array.isArray(value) ? value : [])
      .map((level) => Number(recordValue(level)?.["price"]))
      .filter((price) => Number.isFinite(price));
    const bids = prices(response["bids"]);
    const asks = prices(response["asks"]);
    const series = books.get(tokenId) ?? [];
    series.push({
      tMs: Number(row["received_at_ms"]),
      bid: bids.length > 0 ? Math.max(...bids) : null,
      ask: asks.length > 0 ? Math.min(...asks) : null
    });
    books.set(tokenId, series);
  }
  return { sports, books };
}

export interface FixtureToken extends ReplayTokenSeries {
  tokenId: string;
  outcome: string;
  minimumOrderSize: number;
  tickSize: MarketTickSize;
  negRisk: boolean;
}

export interface TennisGen1Fixture {
  generatedFrom: string;
  gameKey: string;
  gameId: string;
  setsToWin: number;
  title: string;
  market: {
    eventSlug: string;
    eventTitle: string;
    marketSlug: string;
    conditionId: string;
    outcomes: string[];
    tokenIds: string[];
    marketType: "moneyline";
    tickSize: MarketTickSize;
    negRisk: boolean;
  };
  tokens: FixtureToken[];
  sports: ReplaySportsFrame[];
  prices: number[];
  finishedAtMs: number | null;
  expectedOrders: ReplayOrder[];
}

/**
 * One match captured as a fixture: the exact sports/book sequence plus the
 * per-price entries the archived rule produced at capture time.
 */
export function buildFixture(
  db: DatabaseSync,
  dbPath: string,
  gameKey: string,
  prices: readonly number[] = LIVE_LADDER_PRICES
): TennisGen1Fixture {
  const match = loadArchiveMatches(db).find((candidate) => candidate.gameKey === gameKey);
  if (!match) throw new Error(`no moneyline tennis match ${gameKey}`);
  const series = loadArchiveSeries(db, gameKey);
  const sample = series.sports.find((frame) => frame.homeName !== null && frame.awayName !== null);
  if (!sample) throw new Error(`no sports score frames for ${gameKey}`);
  const tokens: FixtureToken[] = [];
  for (let index = 0; index < 2; index += 1) {
    const tokenId = match.tokenIds[index]!;
    const outcome = match.outcomes[index]!;
    const side = sideOfName(outcome, sample.homeName, sample.awayName);
    if (!side) throw new Error(`cannot map ${outcome} onto the sports feed for ${gameKey}`);
    tokens.push({
      tokenId,
      outcome,
      tokenKey: tokenId,
      side,
      snapshots: series.books.get(tokenId) ?? [],
      otherTokenKey: match.tokenIds[1 - index]!,
      minimumOrderSize: 5,
      tickSize: "0.01",
      negRisk: false
    });
  }
  const expectedOrders = replayTennisGen1Orders(series.sports, tokens, {
    prices,
    setsToWin: 2,
    marketLeaderGuard: true,
    ...(match.finishedAtMs !== null ? { finishAtMs: match.finishedAtMs } : {})
  });
  return {
    generatedFrom: dbPath,
    gameKey,
    gameId: match.gameId,
    setsToWin: 2,
    title: match.title,
    market: {
      eventSlug: `capture-${match.gameId}`,
      eventTitle: match.title,
      marketSlug: typeof match.market["slug"] === "string" ? match.market["slug"] : `capture-${match.gameId}-moneyline`,
      conditionId: typeof match.market["conditionId"] === "string" ? match.market["conditionId"] : `capture-${match.gameId}`,
      outcomes: match.outcomes,
      tokenIds: match.tokenIds,
      marketType: "moneyline",
      tickSize: "0.01",
      negRisk: false
    },
    tokens,
    sports: series.sports,
    prices: [...prices],
    finishedAtMs: match.finishedAtMs,
    expectedOrders
  };
}

interface CliFlags {
  db: string;
  out: string;
  fixture: string | null;
  settlements: string;
}

function parseFlags(argv: readonly string[]): CliFlags {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) continue;
    flags.set(token.slice(2), value);
    index += 1;
  }
  return {
    db: flags.get("db") ?? "data/collector/continuous/tail.sqlite",
    out: flags.get("out") ?? "/tmp/gen1-orders.json",
    fixture: flags.get("fixture") ?? null,
    settlements: flags.get("settlements") ?? "data/research/settlements"
  };
}

function main(argv: readonly string[]): void {
  const flags = parseFlags(argv);
  const db = new DatabaseSync(flags.db, { readOnly: true });
  try {
    if (flags.fixture) {
      const fixture = buildFixture(db, flags.db, flags.fixture);
      writeFileSync(flags.out, `${JSON.stringify(fixture, null, 1)}\n`);
      console.log(JSON.stringify({
        out: flags.out, gameKey: fixture.gameKey, sports: fixture.sports.length,
        snapshots: fixture.tokens.reduce((total, token) => total + token.snapshots.length, 0),
        expectedOrders: fixture.expectedOrders.length
      }));
      return;
    }
    const matches = loadArchiveMatches(db);
    const orders: Array<ReplayOrder & { gameKey: string; title: string; outcome: string }> = [];
    for (const match of matches) {
      const series = loadArchiveSeries(db, match.gameKey);
      if (series.sports.length === 0) continue;
      const sample = series.sports.find((frame) => frame.homeName !== null && frame.awayName !== null);
      if (!sample) continue;
      const tokens: ReplayTokenSeries[] = [];
      const orderMetadata = new Map<string, { title: string; outcome: string }>();
      for (let index = 0; index < 2; index += 1) {
        const tokenId = match.tokenIds[index]!;
        const outcome = match.outcomes[index]!;
        const side = sideOfName(outcome, sample.homeName, sample.awayName);
        if (!side) continue;
        tokens.push({
          tokenKey: tokenId,
          side,
          snapshots: series.books.get(tokenId) ?? [],
          otherTokenKey: match.tokenIds[1 - index]!
        });
        orderMetadata.set(tokenId, { title: match.title, outcome });
      }
      const replayed = replayTennisGen1Orders(series.sports, tokens, {
        prices: DEFAULT_REPLAY_PRICES,
        setsToWin: 2,
        marketLeaderGuard: true,
        ...(match.finishedAtMs !== null ? { finishAtMs: match.finishedAtMs } : {})
      });
      for (const order of replayed) {
        const meta = orderMetadata.get(order.tokenKey);
        orders.push({ ...order, gameKey: match.gameKey, title: meta?.title ?? match.title, outcome: meta?.outcome ?? "" });
      }
    }
    writeFileSync(flags.out, `${JSON.stringify(orders)}\n`);
    const payouts = loadPayouts(flags.settlements, ["clob-latest.json", "gamma-20260923.json"]);
    const summary = summarizeReplay(orders, (tokenKey) => payouts.get(tokenKey));
    console.log(JSON.stringify({
      db: flags.db, out: flags.out, matches: matches.length, orders: orders.length, summary,
      marketLeaderBlocks: orders.reduce((total, order) => total + order.marketLeaderBlocks, 0)
    }, null, 2));
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2));
}
