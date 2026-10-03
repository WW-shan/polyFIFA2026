/**
 * `npm run tennis:tail -- [flags]` - live/dry-run tennis tail ladder watch.
 *
 * Dry-run is the default. Pass `--live true` to actually post orders.
 */
import { appendFile } from "node:fs/promises";
import { discoverSportsEvents, type CatalogDependencies } from "../collector/catalog.js";
import type { CollectorEvent } from "../collector/types.js";
import { TennisPointsPoller, SCORES365_BASE_URL, tennisNameKey } from "../collector/tennis-points.js";
import type { OrderbookSnapshot } from "../domain/types.js";
import { fetchJson } from "../polymarket/http.js";
import { normalizeOrderbook, type RawOrderbook } from "../polymarket/clob.js";
import { LiveLedger } from "../persistence/ledger.js";
import {
  DEFAULT_TENNIS_TAIL_LADDER,
  type TennisTailLadderConfig,
  type TennisTailMarket
} from "./tennis-tail-orchestrator.js";
import { runTennisTailWatch, type TennisTailArmRecord, type TennisTailEvent } from "./tennis-tail-live.js";
import { LiveExecutor, getLiveOrder, liveConfigFromEnv, type LiveOrderType } from "./live-executor.js";
import { PENDING_SUBMISSION_PREFIX } from "../persistence/ledger.js";
import { readPusdBalance } from "./balance.js";
import { createAutoSettlementMonitor } from "./auto-settlement.js";
import { TERMINAL_ORDER_SNAPSHOT_STATUSES, orderSnapshotStatus, restingFillFromSnapshot } from "./resting-reconcile.js";

const TENNIS_TAG_ID = "864";
const DEFAULT_LEAGUES = ["atp", "wta"];
const DEFAULT_LEDGER_FILE = "data/execution/tennis-tail-ledger.json";
const DEFAULT_LOG_FILE = "logs/tennis-tail.jsonl";
const DEFAULT_POLL_INTERVAL_MS = 15_000;

export interface TennisTailCliOptions {
  dryRun: boolean;
  config: TennisTailLadderConfig;
  orderType: LiveOrderType;
  restSeconds?: number;
  postOnly: boolean;
  intervalMs: number;
  maxIterations?: number;
  ledgerFile: string;
  logFile: string;
  proxyUrl?: string;
  clobHost: string;
  scores365BaseUrl: string;
  /** Tournament prefixes to trade; the backtest only has ATP/WTA evidence. */
  leagues: string[];
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main(process.argv.slice(2));
}

async function main(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const options = cliOptions(flags);
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    mode: options.dryRun ? "dry-run" : "live",
    ladder: options.config.prices ?? DEFAULT_TENNIS_TAIL_LADDER.prices,
    sharesPerLevel: options.config.sharesPerLevel,
    maxNotionalPerEvent: options.config.maxNotionalPerEvent,
    maxNotionalPerDay: options.config.maxNotionalPerDay,
    orderType: options.orderType,
    postOnly: options.postOnly,
    leagues: options.leagues,
    intervalMs: options.intervalMs,
    maxIterations: options.maxIterations ?? null,
    ledgerFile: options.ledgerFile
  }, null, 2));

  if (!options.dryRun) {
    try {
      const preflight = await tennisTailBalancePreflight(options, process.env);
      if (preflight) {
        console.log(JSON.stringify({ at: new Date().toISOString(), kind: "balance_preflight", ...preflight }));
        if (!preflight.sufficient) {
          console.warn(JSON.stringify({
            at: new Date().toISOString(),
            level: "warn",
            kind: "balance_preflight",
            details: `pUSD ${preflight.pUSD} is below one ladder level (${preflight.minimumLevelCost}); the CLOB will reject orders until ${preflight.wallet} is funded`
          }));
        }
      }
    } catch (error) {
      console.warn(JSON.stringify({
        at: new Date().toISOString(),
        level: "warn",
        kind: "balance_preflight",
        details: `balance preflight failed: ${describe(error)}`
      }));
    }
  }

  const request = (url: string, requestOptions?: Parameters<typeof fetchJson>[1]): Promise<unknown> =>
    fetchJson(url, { ...requestOptions, ...(options.proxyUrl ? { proxyUrl: options.proxyUrl } : {}) });
  const deps: CatalogDependencies = { request };
  const poller = new TennisPointsPoller({
    request,
    baseUrl: options.scores365BaseUrl,
    onError: (error, detail) => { void logRecord(options, { kind: "error", eventSlug: `scores365:${detail}`, details: describe(error) }); }
  });
  const ledger = new LiveLedger(options.ledgerFile);
  const executor = new LiveExecutor(liveConfigFromEnv(process.env));
  const settlement = createAutoSettlementMonitor({ env: process.env, ledger });

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    console.log("\nSIGINT received; stopping after the current poll. Resting orders remain on the book; use --cancel-order flow to pull them.");
  });

  if (settlement) console.log(JSON.stringify({ at: new Date().toISOString(), autoRedeem: "enabled" }));
  const summary = await runTennisTailWatch(
    {
      discover: () => discoverTennisTailEvents(deps, options.leagues),
      pollPoints: (targets) => stopping ? Promise.resolve([]) : poller.poll(targets),
      fetchOrderbook: (tokenId) => fetchTennisOrderbook(tokenId, options),
      placeLadder: (levels, executeOptions) => executor.placeRestingLadder(levels, executeOptions),
      ledger,
      reconcile: async () => {
        await reconcileTennisRestingOrders(ledger, process.env);
        settlement?.kick();
      },
      onRecord: (record) => logRecord(options, record)
    },
    {
      config: options.config,
      orderType: options.orderType,
      ...(options.restSeconds !== undefined ? { restSeconds: options.restSeconds } : {}),
      postOnly: options.postOnly,
      dryRun: options.dryRun,
      intervalMs: stopping ? 0 : options.intervalMs,
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {})
    }
  );
  await settlement?.waitForIdle();
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    summary,
    settlement: settlement?.lastResult ?? null,
    settlementError: settlement?.lastError ? describe(settlement.lastError) : null
  }, null, 2));
}

export interface TennisTailBalancePreflight {
  wallet: string;
  pUSD: number;
  minimumLevelCost: number;
  sufficient: boolean;
}

/**
 * Live-mode preflight: one read-only RPC call turns "every order is rejected"
 * into an explicit warning before the watch loop starts. A read failure only
 * warns (the caller catches it); it never blocks trading.
 */
export async function tennisTailBalancePreflight(
  options: Pick<TennisTailCliOptions, "config">,
  env: Record<string, string | undefined>,
  readBalance: (wallet: string, rpcUrl?: string) => Promise<number> = readPusdBalance
): Promise<TennisTailBalancePreflight | null> {
  const wallet = env.POLY_DEPOSIT_WALLET_ADDRESS?.trim() || env.POLY_FUNDER_ADDRESS?.trim();
  if (!wallet) return null;
  const prices = (options.config.prices ?? DEFAULT_TENNIS_TAIL_LADDER.prices ?? [])
    .filter((price) => Number.isFinite(price) && price > 0 && price < 1)
    .sort((a, b) => a - b);
  const cheapest = prices[0];
  if (cheapest === undefined) return null;
  const minimumLevelCost = Number((options.config.sharesPerLevel * cheapest).toFixed(6));
  const balance = await readBalance(wallet, env.POLY_RPC_URL);
  return { wallet, pUSD: balance, minimumLevelCost, sufficient: balance + 1e-9 >= minimumLevelCost };
}

/** Slugs are `<league>-<players>-<date>`; `itf` has no score feed in the archive. */
export function tennisLeagueOf(eventSlug: string): string {
  return eventSlug.split("-")[0]?.trim().toLowerCase() ?? "";
}

export async function discoverTennisTailEvents(
  deps: CatalogDependencies,
  leagues: readonly string[] = DEFAULT_LEAGUES
): Promise<TennisTailEvent[]> {
  const allowed = new Set(leagues.map((league) => league.trim().toLowerCase()).filter(Boolean));
  const events = await discoverSportsEvents({
    tagId: TENNIS_TAG_ID,
    sports: ["tennis"],
    dateWindow: "game-start",
    liveOnly: true,
    pageSize: 100,
    maxPages: 20
  }, deps);
  const discovered: TennisTailEvent[] = [];
  // Two Gamma events for one match (relisted market, duplicated tag page) would
  // arm two ladders on the same point feed and defeat the per-event exposure
  // cap. Keep the first event and make every duplicate visible in the log.
  const seenConditionIds = new Set<string>();
  const seenTokenSets = new Set<string>();
  const seenPairings = new Set<string>();
  for (const event of events) {
    const market = moneylineTennisMarket(event);
    if (!market) continue;
    // The backtest universe is singles only; doubles titles share a surname and
    // must never be paired with a singles point feed.
    if (event.title.includes("/")) continue;
    // ITF has book data but no score data in the archive (0 backtest samples),
    // so it is excluded unless the operator explicitly opts in.
    if (allowed.size > 0 && !allowed.has(tennisLeagueOf(event.eventSlug))) continue;
    const tokenKey = [...market.tokenIds].sort().join(" ");
    const pairingKey = tennisPairingKey(event.title);
    const duplicate = seenConditionIds.has(market.conditionId)
      || seenTokenSets.has(tokenKey)
      || (pairingKey !== null && seenPairings.has(pairingKey));
    if (duplicate) {
      console.warn(JSON.stringify({
        at: new Date().toISOString(),
        kind: "duplicate_event",
        eventSlug: event.eventSlug,
        details: `skipped duplicate tennis event (conditionId ${market.conditionId})`
      }));
      continue;
    }
    seenConditionIds.add(market.conditionId);
    seenTokenSets.add(tokenKey);
    if (pairingKey !== null) seenPairings.add(pairingKey);
    discovered.push({ eventSlug: event.eventSlug, eventTitle: event.title, markets: [market] });
  }
  return discovered;
}

/** Player-pairing identity of a title, ignoring the tournament prefix. */
function tennisPairingKey(title: string): string | null {
  const [left, right] = title.split(/\s+vs\.?\s+/i);
  if (!left || !right) return null;
  const bare = (value: string): string => {
    const colon = value.lastIndexOf(":");
    return (colon >= 0 ? value.slice(colon + 1) : value).trim() || value.trim();
  };
  const names = [tennisNameKey(bare(left)), tennisNameKey(bare(right))].filter((name) => name.length > 0).sort();
  return names.length === 2 ? names.join("|") : null;
}

function moneylineTennisMarket(event: CollectorEvent): TennisTailMarket | null {
  for (const market of event.markets) {
    if (market.raw.sportsMarketType !== "moneyline") continue;
    if (market.outcomes.length !== 2 || market.tokenIds.length !== 2) continue;
    const tickSize = tickSizeFromMarket(market.raw);
    const result: TennisTailMarket = {
      eventSlug: event.eventSlug,
      eventTitle: event.title,
      marketSlug: market.marketSlug,
      conditionId: market.conditionId,
      outcomes: market.outcomes,
      tokenIds: market.tokenIds,
      marketType: "moneyline"
    };
    if (tickSize) result.tickSize = tickSize;
    if (typeof market.raw.negRisk === "boolean") result.negRisk = market.raw.negRisk;
    else if (typeof market.raw.neg_risk === "boolean") result.negRisk = market.raw.neg_risk;
    return result;
  }
  return null;
}

function tickSizeFromMarket(raw: Record<string, unknown>): TennisTailMarket["tickSize"] {
  const value = raw.orderPriceMinTickSize ?? raw.tickSize;
  const parsed = Number(value);
  if (parsed === 0.1) return "0.1";
  if (parsed === 0.01) return "0.01";
  if (parsed === 0.005) return "0.005";
  if (parsed === 0.0025) return "0.0025";
  if (parsed === 0.001) return "0.001";
  if (parsed === 0.0001) return "0.0001";
  return undefined;
}

/**
 * Read-only reconciliation of resting bids already recorded in the ledger.
 * Fills become owned positions; terminal orders release their reservation.
 * A read error keeps the reservation so exposure is never under-counted.
 */
export async function reconcileTennisRestingOrders(
  ledger: LiveLedger,
  env: Record<string, string | undefined>
): Promise<void> {
  const active = await ledger.readActiveEntries();
  const resting = active.filter((entry) =>
    Boolean(entry.orderId)
    && !entry.orderId.startsWith(PENDING_SUBMISSION_PREFIX)
    && entry.orderId !== "live-order-unknown"
    && (entry.status === "posted" || (entry.reservedNotional ?? 0) > 0));
  if (resting.length === 0) return;
  const config = liveConfigFromEnv(env);
  for (const entry of resting) {
    try {
      const snapshot = await getLiveOrder(config, entry.orderId);
      const fill = restingFillFromSnapshot(entry, snapshot);
      if (fill) await ledger.recordRestingOrderFill(entry.orderId, fill);
      const status = orderSnapshotStatus(snapshot);
      if (status && TERMINAL_ORDER_SNAPSHOT_STATUSES.has(status)) {
        await ledger.markCanceledByOrderId(entry.orderId);
      }
    } catch {
      // Unknown venue state keeps the reservation: never release on a read error.
    }
  }
}

async function fetchTennisOrderbook(tokenId: string, options: TennisTailCliOptions): Promise<OrderbookSnapshot> {
  const url = `${options.clobHost.replace(/\/$/, "")}/book?token_id=${encodeURIComponent(tokenId)}`;
  const raw = await fetchJson<RawOrderbook>(url, options.proxyUrl ? { proxyUrl: options.proxyUrl } : {});
  return normalizeOrderbook(raw);
}

export function cliOptions(flags: ReadonlyMap<string, string | true>): TennisTailCliOptions {
  const live = flagBoolean(flags, "live") ?? false;
  const dryRun = flags.has("dry-run") ? (flagBoolean(flags, "dry-run") ?? true) : !live;
  const prices = flags.has("ladder")
    ? String(flags.get("ladder")).split(",").map((value) => Number(value.trim()))
    : [...(DEFAULT_TENNIS_TAIL_LADDER.prices ?? [])];
  if (prices.length === 0 || prices.some((price) => !Number.isFinite(price) || price <= 0 || price >= 1)) {
    throw new Error("--ladder must be a comma-separated list of prices between 0 and 1");
  }
  const orderType = String(flags.get("order-type") ?? "GTC").toUpperCase();
  if (orderType !== "GTC" && orderType !== "GTD") throw new Error("--order-type must be GTC or GTD");
  const options: TennisTailCliOptions = {
    dryRun,
    config: {
      prices,
      sharesPerLevel: numberFlag(flags, "shares-per-level") ?? DEFAULT_TENNIS_TAIL_LADDER.sharesPerLevel,
      maxNotionalPerEvent: numberFlag(flags, "max-per-event") ?? DEFAULT_TENNIS_TAIL_LADDER.maxNotionalPerEvent,
      maxNotionalPerDay: numberFlag(flags, "max-per-day") ?? DEFAULT_TENNIS_TAIL_LADDER.maxNotionalPerDay
    },
    orderType,
    postOnly: flagBoolean(flags, "post-only") ?? true,
    intervalMs: numberFlag(flags, "interval-ms") ?? DEFAULT_POLL_INTERVAL_MS,
    ledgerFile: String(flags.get("ledger-file") ?? DEFAULT_LEDGER_FILE),
    logFile: String(flags.get("log-file") ?? DEFAULT_LOG_FILE),
    clobHost: String(flags.get("clob-host") ?? process.env.POLY_CLOB_HOST ?? "https://clob.polymarket.com"),
    scores365BaseUrl: String(flags.get("scores365-base-url") ?? SCORES365_BASE_URL),
    leagues: [...DEFAULT_LEAGUES]
  };
  const restSeconds = numberFlag(flags, "rest-seconds");
  if (restSeconds !== undefined) options.restSeconds = restSeconds;
  const maxIterations = numberFlag(flags, "max-iterations");
  if (maxIterations !== undefined) options.maxIterations = maxIterations;
  const leaguesArg = flags.get("leagues");
  if (typeof leaguesArg === "string") {
    const leagues = leaguesArg.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    options.leagues = leagues.includes("all") ? [] : leagues;
  }
  const proxyUrl = flags.get("proxy") ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.https_proxy ?? process.env.http_proxy;
  if (typeof proxyUrl === "string" && proxyUrl.trim()) options.proxyUrl = proxyUrl.trim();
  return options;
}

async function logRecord(options: TennisTailCliOptions, record: TennisTailArmRecord): Promise<void> {
  const line = JSON.stringify({ at: new Date().toISOString(), ...record });
  console.log(line);
  await appendFile(options.logFile, `${line}\n`, "utf8").catch(() => undefined);
}

function parseFlags(argv: readonly string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "discovery-interval-ms") {
      // Reserved: discovery cadence is currently the poll cadence.
      index += 1;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.set(key, true);
    } else {
      flags.set(key, next);
      index += 1;
    }
  }
  return flags;
}

function numberFlag(flags: ReadonlyMap<string, string | true>, key: string): number | undefined {
  if (!flags.has(key)) return undefined;
  const raw = flags.get(key);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a number`);
  return value;
}

function flagBoolean(flags: ReadonlyMap<string, string | true>, key: string): boolean | undefined {
  if (!flags.has(key)) return undefined;
  const raw = flags.get(key);
  if (raw === true) return true;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`--${key} must be true or false`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
