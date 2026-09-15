import { decimal, objectValue } from "../collector/replay-values.js";
import type { ReplayLevel } from "../collector/replay-types.js";
import type { TailBookChange, TailClockIssue, TailMarket, TailSecond, TailTokenQuality, TailWindow } from "../collector/tail-types.js";
import type {
  EffectiveTailBacktestOptions, TailBacktestExclusion, TailBacktestInput, TailBacktestOptions, TailBacktestResult,
  TailBacktestSummary, TailBacktestTrial, TailContextCoverage, TailEntryReference, TailPriceCoverage, TailSettlement, TailTouchEvidence
} from "./tail-backtest-types.js";

export type * from "./tail-backtest-types.js";

/** Hard bounds are checked before expanding any scenario grid. */
export const TAIL_BACKTEST_LIMITS = Object.freeze({ prices: 64, windows: 64, combinations: 1_024, trials: 100_000, evidenceItems: 250_000,
  windowSeconds: 86_400, decimalCharacters: 128, shares: 1_000_000_000, queueAheadShares: 1_000_000_000_000 });

function inputError(message: string): never { throw new Error(`TAIL_BACKTEST_INPUT_INVALID: ${message}`); }
function optionsError(message: string): never { throw new Error(`TAIL_BACKTEST_OPTIONS_INVALID: ${message}`); }
function check(condition: unknown, message: string): asserts condition { if (!condition) inputError(message); }
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 4_096 && value.trim() === value; }
function nullableId(value: unknown): value is string | null { return value === null || id(value); }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function time(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000; }
function nullableTime(value: unknown): boolean { return value === null || time(value); }
function nullableNumber(value: unknown): boolean { return value === null || (typeof value === "number" && Number.isFinite(value)); }
function strings(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) if (!id(item)) return false;
  return true;
}
function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }
function key(...parts: (string | number)[]): string { return JSON.stringify(parts); }
function lexical(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function priceKey(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= TAIL_BACKTEST_LIMITS.decimalCharacters ? decimal(value, true)?.key : undefined;
}
function quantityKey(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= TAIL_BACKTEST_LIMITS.decimalCharacters && Number(value) <= Number.MAX_SAFE_INTEGER
    ? decimal(value)?.key : undefined;
}
function nullablePrice(value: unknown): boolean { return value === null || priceKey(value) !== undefined; }
/** Canonical [0,1] decimal keys have exact lexical order, including arbitrarily close prices. */
function comparePrice(a: string, b: string): number { return lexical(priceKey(a)!, priceKey(b)!); }
function samePrice(a: string | null, b: string | null): boolean { return a === null || b === null ? a === b : comparePrice(a, b) === 0; }
function rounded(value: number): number { return value === 0 ? 0 : Number(value.toPrecision(15)); }

// Fixed decimal units avoid fractional queue dust (e.g. 0.1 + 0.2 - 0.3).
const SHARE_SCALE = TAIL_BACKTEST_LIMITS.decimalCharacters;
function units(value: string | number, scale: number = SHARE_SCALE): bigint {
  const [whole = "0", fraction = ""] = decimal(value)!.key.split(".");
  return BigInt(whole + fraction.padEnd(scale, "0"));
}
function shares(value: bigint): number {
  const digits = value.toString().padStart(SHARE_SCALE + 1, "0");
  return Number(digits.slice(0, -SHARE_SCALE) + "." + digits.slice(-SHARE_SCALE));
}

// Number inputs can have at most 324 fractional decimal places (Number.MIN_VALUE).
// This scale represents every supported shares * price * fee / 10000 exactly; no digits are discarded.
const NUMBER_SCALE = 324;
const MONEY_SCALE = SHARE_SCALE * 2 + NUMBER_SCALE + 4;
const COST_SCALE_FACTOR = 10n ** BigInt(NUMBER_SCALE + 4);
const PAYOUT_SCALE_FACTOR = 10n ** BigInt(SHARE_SCALE + 4);
interface ExactAmounts { filled: bigint; cost: bigint; fee: bigint; payout: bigint | null; pnl: bigint | null }
function exactAmounts(trial: TailBacktestTrial, filled: bigint): ExactAmounts {
  const costProduct = filled * units(trial.bidPrice);
  const cost = costProduct * COST_SCALE_FACTOR;
  const fee = costProduct * units(trial.makerFeeBps, NUMBER_SCALE);
  const payout = filled === 0n ? 0n : trial.payoutPerShare === null ? null
    : filled * units(trial.payoutPerShare, NUMBER_SCALE) * PAYOUT_SCALE_FACTOR;
  return { filled, cost, fee, payout, pnl: payout === null ? null : payout - cost - fee };
}
function money(value: bigint): number {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(MONEY_SCALE + 1, "0");
  return rounded(Number((negative ? "-" : "") + digits.slice(0, -MONEY_SCALE) + "." + digits.slice(-MONEY_SCALE)));
}

function effectiveOptions(input: TailBacktestOptions = {}): EffectiveTailBacktestOptions {
  if (!objectValue(input)) optionsError("options must be an object");
  const defaults: EffectiveTailBacktestOptions = {
    prices: ["0.50", "0.60", "0.70", "0.80", "0.90", "0.95", "0.97", "0.99"], windowsSeconds: [60, 180, 300],
    entryMinBid: "0.90", shares: 1, queueAheadShares: 0, makerFeeBps: 0, fillModel: "quote-touch-assumed", requireFreshContext: false
  };
  if (Object.keys(input).some(name => !Object.hasOwn(defaults, name))) optionsError("unknown option");
  const result = { ...defaults, ...input };
  if (!Array.isArray(result.prices) || !result.prices.length || result.prices.length > TAIL_BACKTEST_LIMITS.prices ||
      [...result.prices].some(price => { const parsed = priceKey(price); return parsed === undefined || parsed === "0" || parsed === "1"; })) {
    optionsError(`prices must contain 1..${TAIL_BACKTEST_LIMITS.prices} decimal strings strictly between 0 and 1`);
  }
  if (!Array.isArray(result.windowsSeconds) || !result.windowsSeconds.length || result.windowsSeconds.length > TAIL_BACKTEST_LIMITS.windows ||
      [...result.windowsSeconds].some(window => !count(window) || window === 0 || window > TAIL_BACKTEST_LIMITS.windowSeconds)) {
    optionsError("windowsSeconds must contain bounded positive integer seconds");
  }
  if (priceKey(result.entryMinBid) === undefined) optionsError("entryMinBid must be a decimal string in [0,1]");
  for (const name of ["shares", "queueAheadShares"] as const) {
    const value = result[name], parsed = decimal(value);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (name === "shares" && value === 0) ||
        value > TAIL_BACKTEST_LIMITS[name] || !parsed || parsed.raw.length > TAIL_BACKTEST_LIMITS.decimalCharacters) optionsError(`invalid ${name}`);
  }
  if (!Number.isFinite(result.makerFeeBps) || result.makerFeeBps < 0 || result.makerFeeBps > 10_000) optionsError("makerFeeBps must be in [0,10000]");
  if (result.fillModel !== "quote-touch-assumed" && result.fillModel !== "sell-through-volume") optionsError("unknown fillModel");
  if (typeof result.requireFreshContext !== "boolean") optionsError("requireFreshContext must be boolean");
  const seenPrices = new Set<string>();
  result.prices = result.prices.filter(price => { const parsed = priceKey(price)!; if (seenPrices.has(parsed)) return false; seenPrices.add(parsed); return true; });
  result.windowsSeconds = [...new Set(result.windowsSeconds)];
  if (result.prices.length * result.windowsSeconds.length > TAIL_BACKTEST_LIMITS.combinations) optionsError("parameter combinations exceed 1024");
  return result;
}

interface Interval { startAtMs: number; endAtMs: number }
interface IndexedToken {
  market: TailMarket;
  quality: TailTokenQuality | null;
  settlement: TailSettlement | null;
  rows: Map<number, TailSecond>;
  changes: TailBookChange[];
  changesBySecond: Map<number, TailBookChange[]>;
  facts: Map<number, RowFacts>;
  observedQuality: { validSeconds: number; closedSeconds: number; clockAffectedSeconds: number } | null;
}
interface IndexedWindow {
  window: TailWindow;
  tokens: Map<string, IndexedToken>;
  markets: Map<string, IndexedToken[]>;
  clockIntervals: Interval[];
}
interface IndexedSource {
  input: TailBacktestInput;
  windows: IndexedWindow[];
  countMismatch: boolean;
  journalIncomplete: boolean;
}
interface Registry {
  sources: Set<string>;
  games: Set<string>;
  eventIds: Set<string>;
  eventSlugs: Set<string>;
  markets: Set<string>;
  conditions: Set<string>;
  tokens: Set<string>;
}

function validateClockIssues(issues: TailClockIssue[] | undefined): Interval[] {
  if (issues === undefined) return [];
  check(Array.isArray(issues), "clockIssues must be an array");
  for (const issue of issues) {
    check(objectValue(issue) && issue.kind === "receipt-wall-clock-backstep" && time(issue.startAtMs) && time(issue.endAtMs) && issue.startAtMs <= issue.endAtMs,
      "invalid clock interval");
    for (const receipt of [issue.previous, issue.current]) check(objectValue(receipt) && count(receipt.sequence) && receipt.sequence > 0 &&
      time(receipt.receivedAtMs) && id(receipt.receivedAt) && id(receipt.monotonicNs) && /^\d+$/.test(receipt.monotonicNs) &&
      id(receipt.source) && id(receipt.kind) && nullableId(receipt.connectionId), "invalid clock receipt");
    check(issue.current.receivedAtMs === issue.startAtMs && issue.previous.receivedAtMs === issue.endAtMs && issue.current.sequence > issue.previous.sequence,
      "clock receipt mapping mismatch");
  }
  return issues.map(({ startAtMs, endAtMs }) => ({ startAtMs, endAtMs }));
}

function validateFinish(window: TailWindow): void {
  check(strings(window.finishSources) && unique(window.finishSources) && typeof window.finishConflict === "boolean", "invalid finish labels");
  check(nullableTime(window.startAtMs) && nullableTime(window.endAtMs) && (window.startAtMs === null) === (window.endAtMs === null), "invalid window boundaries");
  if (window.finishEvidence === undefined) return;
  check(Array.isArray(window.finishEvidence), "invalid finish evidence");
  for (const fact of window.finishEvidence) {
    check(objectValue(fact) && time(fact.atMs) && time(fact.observedAtMs) && nullableId(fact.eventSlug) &&
      (fact.source === "gamma.finishedTimestamp" || fact.source === "sports.finishedAt"), "invalid actual finish evidence");
    check(fact.eventId === undefined || nullableId(fact.eventId), "invalid finish event ID");
    check(fact.gameId === undefined || nullableId(fact.gameId), "invalid finish game ID");
    check(fact.sourceRunId === undefined || id(fact.sourceRunId), "invalid finish source run");
    check(fact.sourceRunDirectory === undefined || nullableId(fact.sourceRunDirectory), "invalid finish source directory");
    check(fact.sourceFile === undefined || id(fact.sourceFile), "invalid finish source file");
    check(fact.sequence === undefined || (count(fact.sequence) && fact.sequence > 0), "invalid finish sequence");
    check(fact.frameIndex === undefined || count(fact.frameIndex), "invalid finish frame index");
    const eventIndex = fact.eventId == null ? -1 : window.eventIds.indexOf(fact.eventId);
    const slugIndex = fact.eventSlug === null ? -1 : window.eventSlugs.indexOf(fact.eventSlug);
    const sameGame = fact.gameId != null && fact.gameId === window.gameId;
    // Native catalog witnesses omit optional IDs AFTER resolving the owning window.
    // Their slug may be absent or an uncaptured companion; explicit IDs still must agree.
    const compact = fact.gameId === undefined && fact.eventId === undefined;
    check((fact.gameId == null || sameGame) && (fact.eventSlug === null || slugIndex >= 0 || sameGame || compact) &&
      (fact.eventId == null || eventIndex >= 0 || sameGame) && (eventIndex < 0 || fact.eventSlug === null || fact.eventSlug === window.eventSlugs[eventIndex]) &&
      (slugIndex < 0 || fact.eventId == null || fact.eventId === window.eventIds[slugIndex]) &&
      (fact.eventSlug !== null || sameGame || compact), "finish identity mismatch");
    check(window.finishSources.includes(fact.source), "finish source mapping mismatch");
  }
}

function validateLevels(levels: ReplayLevel[] | null, best: string | null, descending: boolean): void {
  check(nullablePrice(best), "invalid best price");
  check(levels === null || Array.isArray(levels), "invalid book depth");
  if (levels === null) { check(best === null, "best price without depth"); return; }
  let previous: string | undefined;
  for (const level of levels) {
    check(objectValue(level) && priceKey(level.price) !== undefined && quantityKey(level.size) !== undefined && quantityKey(level.size) !== "0", "invalid book price/size");
    if (previous !== undefined) check(descending ? comparePrice(previous, level.price) > 0 : comparePrice(previous, level.price) < 0, "duplicate or unsorted depth");
    previous = level.price;
  }
  check(samePrice(best, levels[0]?.price ?? null), "best price/depth mismatch");
}

function validateSecond(row: TailSecond, indexed: IndexedWindow, firstMs: number): IndexedToken {
  check(objectValue(row) && id(row.windowKey) && id(row.tokenId), "invalid second identity");
  const token = indexed.tokens.get(row.tokenId), window = indexed.window;
  check(token, "unknown second token");
  for (const field of ["eventSlug", "gameId", "marketId", "conditionId", "question", "marketType", "outcome"] as const)
    check(row[field] === token.market[field], `second ${field} mapping mismatch`);
  check(window.startAtMs !== null && window.endAtMs !== null && count(row.secondIndex) &&
    row.startAtMs === window.startAtMs + row.secondIndex * 1_000 && row.endAtMs === row.startAtMs + 1_000 && row.endAtMs <= window.endAtMs &&
    row.secondsBeforeFinish === (window.endAtMs - row.startAtMs) / 1_000, "second holding boundary mismatch");
  check(["observed", "carried", "partial", "missing", "invalid", "feed_stale", "outside_run", "not_yet_known", "closed"].includes(row.status) &&
    typeof row.wholeSecondValid === "boolean" && nullableId(row.connectionId) && nullableId(row.bookHash) && strings(row.reasons), "invalid second status");
  check(["present", "missing", "stale", "disconnected"].includes(row.contextStatus) &&
    (row.contextSource === null || row.contextSource === "gamma" || row.contextSource === "sports-ws"), "invalid context status/source");
  for (const field of ["bookObservedAtMs", "bookSourceAtMs", "contextObservedAtMs", "contextSourceAtMs"] as const) check(nullableTime(row[field]), `invalid ${field}`);
  for (const field of ["bookAgeMs", "feedAgeMs", "contextAgeMs"] as const) check(nullableNumber(row[field]), `invalid ${field}`);
  for (const field of ["bookUpdates", "tradeCount", "stateChangeCount"] as const) check(count(row[field]), `invalid ${field}`);
  check(Number.isFinite(row.tradeShares) && row.tradeShares >= 0, "invalid tradeShares");
  for (const field of ["minBestBid", "maxBestBid", "minBestAsk", "maxBestAsk"] as const)
    check(row[field] === null || (Number.isFinite(row[field]) && row[field]! >= 0 && row[field]! <= 1), `invalid ${field}`);
  check(row.clockIssueSequences === undefined || (Array.isArray(row.clockIssueSequences) && row.clockIssueSequences.every(sequence => count(sequence) && sequence > 0)), "invalid clock issue references");
  validateLevels(row.bids, row.bestBid, true); validateLevels(row.asks, row.bestAsk, false);
  check(row.bestBid === null || row.bestAsk === null || comparePrice(row.bestBid, row.bestAsk) < 0, "crossed second book");
  if (row.wholeSecondValid && (row.status === "observed" || row.status === "carried")) {
    check(row.bids !== null && row.asks !== null && row.bookObservedAtMs !== null && row.connectionId !== null, "valid second without an observed book");
    check(row.bookObservedAtMs < row.endAtMs && row.bookObservedAtMs >= firstMs, "future or outside-run reference book");
    check(row.bookAgeMs === row.endAtMs - row.bookObservedAtMs, "book age mismatch");
    if (row.contextStatus === "present") check(row.contextSource !== null && row.contextObservedAtMs !== null &&
      row.contextObservedAtMs < row.endAtMs && row.contextObservedAtMs >= firstMs && row.contextAgeMs === row.endAtMs - row.contextObservedAtMs,
    "future or unobserved present context");
  }
  return token;
}

function validateChange(change: TailBookChange, indexed: IndexedWindow, firstMs: number, lastMs: number): IndexedToken {
  check(objectValue(change) && id(change.tokenId) && count(change.sequence) && change.sequence > 0 &&
    Number.isSafeInteger(change.frameIndex) && change.frameIndex >= (change.kind === "invalidation" ? -1 : 0) &&
    time(change.observedAtMs) && nullableTime(change.sourceAtMs), "invalid change identity/time");
  const token = indexed.tokens.get(change.tokenId), window = indexed.window;
  check(token, "unknown change token");
  check(change.kind === "book" || change.kind === "trade" || change.kind === "invalidation", "unknown change kind");
  check(change.observedAtMs >= firstMs && change.observedAtMs <= lastMs, "change outside source run");
  const data = objectValue(change.data), uncertainFrom = data?.uncertainFromMs;
  if (uncertainFrom !== undefined) check(time(uncertainFrom) && uncertainFrom <= change.observedAtMs, "invalid invalidation boundary");
  check(window.startAtMs !== null && window.endAtMs !== null &&
    ((change.observedAtMs >= window.startAtMs && change.observedAtMs < window.endAtMs) ||
      (change.kind === "invalidation" && typeof uncertainFrom === "number" && uncertainFrom < window.endAtMs && change.observedAtMs >= window.startAtMs)),
  "change outside its window");
  if (change.kind === "book") {
    check(nullablePrice(change.bestBid) && nullablePrice(change.bestAsk), "invalid change book prices");
    check(change.bestBid == null || change.bestAsk == null || comparePrice(change.bestBid, change.bestAsk) < 0, "crossed change book");
    for (const field of ["bidMove", "askMove"] as const) check(change[field] === undefined || nullableNumber(change[field]), "invalid book move");
    check(change.rapidMove === undefined || typeof change.rapidMove === "boolean", "invalid rapid move");
  } else if (change.kind === "trade") {
    check(priceKey(change.price) !== undefined && quantityKey(change.size) !== undefined && quantityKey(change.size) !== "0", "invalid trade price/size");
    check(change.side === undefined || change.side === "BUY" || change.side === "SELL", "invalid trade side");
  } else if (data?.provisional !== undefined) check(typeof data.provisional === "boolean", "invalid provisional invalidation");
  return token;
}

function validateSettlements(input: TailBacktestInput, tokens: Map<string, IndexedToken>, markets: Map<string, IndexedToken[]>): void {
  if (input.settlements === undefined) return;
  check(Array.isArray(input.settlements), "settlements must be an array");
  for (const settlement of input.settlements) {
    check(objectValue(settlement) && id(settlement.marketId) && id(settlement.conditionId) && id(settlement.tokenId) &&
      typeof settlement.payout === "number" && Number.isFinite(settlement.payout) && settlement.payout >= 0 && settlement.payout <= 1 &&
      (settlement.source === "gamma-resolved-prices" || settlement.source === "clob-winner-flags") && time(settlement.observedAtMs) && id(settlement.sourceUrl),
    "invalid settlement schema/provenance");
    // Provenance may identify confirmed archived evidence (file:, urn:, etc.). Do not fetch or normalize it.
    try { new URL(settlement.sourceUrl); } catch { inputError("invalid settlement provenance URI"); }
    const token = tokens.get(settlement.tokenId);
    check(token && token.market.marketId === settlement.marketId && token.market.conditionId === settlement.conditionId, "settlement identity mismatch");
    check(token.settlement === null, "duplicate settlement token");
    if (settlement.source === "clob-winner-flags") check(settlement.payout === 0 || settlement.payout === 1, "non-boolean winner flag payout");
    token.settlement = { ...settlement };
  }
  for (const outcomes of markets.values()) {
    const vector = outcomes.map(token => token.settlement), first = vector.find(value => value !== null);
    if (!first) continue;
    check(vector.every(value => value !== null && value.source === first.source && value.sourceUrl === first.sourceUrl && value.observedAtMs === first.observedAtMs),
      "incomplete or incoherent settlement vector");
    check(Math.abs(vector.reduce((sum, value) => sum + value!.payout, 0) - 1) <= 1e-10, "invalid full outcome payout vector");
  }
}

function indexSource(input: TailBacktestInput, registry: Registry): IndexedSource {
  check(objectValue(input) && id(input.sourceId) && id(input.sport), "invalid source identity");
  check(!registry.sources.has(input.sourceId), "duplicate source archive"); registry.sources.add(input.sourceId);
  const summary = input.summary;
  check(objectValue(summary) && summary.schemaVersion === 1 && summary.basis === "received-order-book-tail" && id(summary.runId), "invalid summary schema/source run");
  check(time(summary.firstReceivedAtMs) && time(summary.lastReceivedAtMs) && summary.firstReceivedAtMs <= summary.lastReceivedAtMs &&
    count(summary.windowSeconds) && summary.windowSeconds > 0 && summary.windowSeconds <= TAIL_BACKTEST_LIMITS.windowSeconds, "invalid source run bounds/window");
  for (const field of ["records", "seconds", "changes", "stateChanges", "audits"] as const) check(count(summary[field]), `invalid summary ${field}`);
  check(summary.rawRecords === undefined || count(summary.rawRecords), "invalid raw record count");
  check(summary.clockPolicy === undefined || summary.clockPolicy === "strict" || summary.clockPolicy === "flag-backsteps", "invalid clock policy");
  check(Array.isArray(summary.windows) && Array.isArray(summary.tokens) && strings(summary.warnings) && Array.isArray(input.seconds) && Array.isArray(input.changes), "invalid archive arrays");
  const journal = summary.journalQuality;
  check(objectValue(journal) && Array.isArray(journal.sequenceGaps), "invalid journal quality");
  for (const gap of journal.sequenceGaps) check(objectValue(gap) && count(gap.expected) && count(gap.actual), "invalid journal sequence gap");
  for (const field of ["incompleteFinalLines", "malformedLines", "invalidBookUpdates", "connectionInvalidations", "unknownFrames", "outOfOrderMessages"] as const)
    check(count(journal[field]), `invalid journal ${field}`);
  const clockIntervals = validateClockIssues(summary.clockIssues);
  const windowMap = new Map<string, IndexedWindow>(), allTokens = new Map<string, IndexedToken>(), allMarkets = new Map<string, IndexedToken[]>();
  for (const window of summary.windows) {
    check(objectValue(window) && id(window.key) && id(window.title) && nullableId(window.gameId) && strings(window.eventIds) && strings(window.eventSlugs) &&
      window.eventIds.length > 0 && window.eventIds.length === window.eventSlugs.length && unique(window.eventIds) && unique(window.eventSlugs) && Array.isArray(window.markets), "invalid window identity");
    check(window.gameId === null ? window.eventIds.length === 1 && window.key === `event:${window.eventIds[0]}` : window.key === `game:${window.gameId}`, "window/game identity mismatch");
    check(!registry.games.has(window.key), "duplicate same-game archive/window"); registry.games.add(window.key);
    for (const eventId of window.eventIds) { check(!registry.eventIds.has(eventId), "duplicate event archive/window"); registry.eventIds.add(eventId); }
    for (const slug of window.eventSlugs) { check(!registry.eventSlugs.has(slug), "duplicate event slug archive/window"); registry.eventSlugs.add(slug); }
    validateFinish(window);
    check(window.startAtMs === null || window.endAtMs! - window.startAtMs === summary.windowSeconds * 1_000, "source-run/window duration mismatch");
    const indexed: IndexedWindow = { window, tokens: new Map(), markets: new Map(), clockIntervals: [...clockIntervals, ...validateClockIssues(window.clockIssues)] };
    windowMap.set(window.key, indexed);
    for (const market of window.markets) {
      check(objectValue(market), "invalid market");
      for (const field of ["eventId", "eventSlug", "marketId", "marketSlug", "conditionId", "tokenId", "outcome", "question", "marketType"] as const)
        check(id(market[field]), `invalid market ${field}`);
      check(market.gameId === window.gameId && window.eventIds.includes(market.eventId) && window.eventSlugs[window.eventIds.indexOf(market.eventId)] === market.eventSlug &&
        typeof market.closed === "boolean" && (market.acceptingOrders === null || typeof market.acceptingOrders === "boolean") && objectValue(market.raw), "market/window identity mismatch");
      check(!registry.tokens.has(market.tokenId), "duplicate token mapping"); registry.tokens.add(market.tokenId);
      let outcomes = indexed.markets.get(market.marketId);
      if (!outcomes) {
        check(!registry.markets.has(market.marketId) && !registry.conditions.has(market.conditionId), "duplicate market/condition mapping");
        registry.markets.add(market.marketId); registry.conditions.add(market.conditionId);
        outcomes = []; indexed.markets.set(market.marketId, outcomes); allMarkets.set(market.marketId, outcomes);
      } else {
        for (const field of ["conditionId", "eventId", "eventSlug", "gameId", "marketSlug", "question", "marketType"] as const)
          check(outcomes[0]!.market[field] === market[field], `conflicting market ${field}`);
        check(!outcomes.some(token => token.market.outcome === market.outcome), "duplicate outcome name");
      }
      const token: IndexedToken = { market, quality: null, settlement: null, rows: new Map(), changes: [], changesBySecond: new Map(), facts: new Map(), observedQuality: null };
      indexed.tokens.set(market.tokenId, token); allTokens.set(market.tokenId, token); outcomes.push(token);
    }
    for (const outcomes of indexed.markets.values()) {
      check(outcomes.length >= 2, "market requires a full outcome identity mapping");
      outcomes.sort((a, b) => lexical(a.market.tokenId, b.market.tokenId));
    }
  }
  for (const quality of summary.tokens) {
    check(objectValue(quality) && id(quality.windowKey) && id(quality.tokenId), "invalid token quality identity");
    const token = windowMap.get(quality.windowKey)?.tokens.get(quality.tokenId);
    check(token && !token.quality, "unknown or duplicate token quality");
    for (const field of ["marketId", "outcome", "marketType"] as const) check(quality[field] === token.market[field], `token quality ${field} mismatch`);
    for (const field of ["expectedSeconds", "validSeconds", "closedSeconds", "partialSeconds", "missingSeconds", "staleSeconds", "contextSeconds",
      "snapshotMatches", "snapshotMismatches", "snapshotNotComparable", "seedSnapshotMatches", "seedSnapshotMismatches", "seedSnapshotNotComparable"] as const)
      check(count(quality[field]), `invalid token quality ${field}`);
    check(quality.expectedSeconds === summary.windowSeconds && quality.validSeconds + quality.closedSeconds + quality.partialSeconds + quality.missingSeconds + quality.staleSeconds <= quality.expectedSeconds &&
      quality.contextSeconds <= quality.expectedSeconds && (quality.clockAffectedSeconds === undefined || (count(quality.clockAffectedSeconds) && quality.clockAffectedSeconds <= quality.expectedSeconds)) &&
      typeof quality.observedWindowComplete === "boolean" && typeof quality.snapshotAuditPassed === "boolean" && typeof quality.readyForReplay === "boolean" && strings(quality.reasons), "invalid token quality counters/flags");
    token.quality = quality;
  }
  for (const row of input.seconds) {
    check(objectValue(row) && id(row.windowKey), "invalid second window");
    const indexed = windowMap.get(row.windowKey); check(indexed, "unknown second window");
    const token = validateSecond(row, indexed, summary.firstReceivedAtMs);
    check(!token.rows.has(row.secondIndex), "duplicate second identity"); token.rows.set(row.secondIndex, row);
  }
  const seenChanges = new Set<string>(), receiptTimes = new Map<number, number>();
  for (const change of input.changes) {
    check(objectValue(change) && id(change.windowKey), "invalid change window");
    const indexed = windowMap.get(change.windowKey); check(indexed, "unknown change window");
    const token = validateChange(change, indexed, summary.firstReceivedAtMs, summary.lastReceivedAtMs);
    // Invalidation frames use -1; their diagnostic fields distinguish separate invalidations in one receipt.
    const diagnostic = change.kind === "invalidation" ? JSON.stringify(change.data ?? null) : "";
    const identity = key(change.windowKey, change.tokenId, change.sequence, change.frameIndex, change.kind, diagnostic);
    check(!seenChanges.has(identity), "duplicate change identity"); seenChanges.add(identity);
    check(!receiptTimes.has(change.sequence) || receiptTimes.get(change.sequence) === change.observedAtMs, "source run/sequence receipt mismatch");
    receiptTimes.set(change.sequence, change.observedAtMs);
    token.changes.push(change);
    const secondIndex = Math.floor((change.observedAtMs - indexed.window.startAtMs!) / 1_000);
    const bin = token.changesBySecond.get(secondIndex) ?? []; bin.push(change); token.changesBySecond.set(secondIndex, bin);
  }
  const receipts = [...receiptTimes].sort(([a], [b]) => a - b);
  for (let i = 1; i < receipts.length; i++) if (receipts[i]![1] < receipts[i - 1]![1]) {
    const interval = { startAtMs: receipts[i]![1], endAtMs: receipts[i - 1]![1] };
    for (const indexed of windowMap.values()) indexed.clockIntervals.push(interval);
  }
  for (const token of allTokens.values()) {
    token.changes.sort(changeOrder);
    for (const bin of token.changesBySecond.values()) bin.sort(changeOrder);
  }
  validateSettlements(input, allTokens, allMarkets);
  return { input, windows: [...windowMap.values()], countMismatch: summary.seconds !== input.seconds.length || summary.changes !== input.changes.length,
    journalIncomplete: journal.malformedLines > 0 || journal.incompleteFinalLines > 0 || summary.warnings.some(warning => warning === "damaged-journal-lines" || warning === "collector-session-failed") };
}

function changeOrder(a: TailBookChange, b: TailBookChange): number {
  return a.observedAtMs - b.observedAtMs || a.sequence - b.sequence || a.frameIndex - b.frameIndex || lexical(a.kind, b.kind);
}

function validateFinishMappings(sources: IndexedSource[]): void {
  const eventWindows = new Map<string, string>(), slugWindows = new Map<string, string>();
  for (const source of sources) for (const { window } of source.windows) {
    for (const eventId of window.eventIds) eventWindows.set(eventId, window.key);
    for (const slug of window.eventSlugs) slugWindows.set(slug, window.key);
  }
  for (const source of sources) for (const { window } of source.windows) for (const fact of window.finishEvidence ?? []) {
    const byEvent = fact.eventId == null ? undefined : eventWindows.get(fact.eventId);
    const bySlug = fact.eventSlug === null ? undefined : slugWindows.get(fact.eventSlug);
    check((byEvent === undefined || byEvent === window.key) && (bySlug === undefined || bySlug === window.key), "finish references another captured window");
  }
}

interface RowFacts {
  clockAffected: boolean;
  activeValid: boolean;
  closedValid: boolean;
  invalidated: boolean;
  changesMatch: boolean;
  bookCoherent: boolean;
}
function extremaMatch(minimum: number | null, maximum: number | null, prices: (string | null | undefined)[]): boolean {
  let min: number | null = null, max: number | null = null;
  // These floating extrema only cross-check collector diagnostics. Fills compare original decimal strings.
  for (const price of prices) if (price != null) {
    const value = Number(price); min = min === null ? value : Math.min(min, value); max = max === null ? value : Math.max(max, value);
  }
  return minimum === min && maximum === max;
}
function rowFacts(row: TailSecond, token: IndexedToken, indexed: IndexedWindow, source: IndexedSource): RowFacts {
  const cached = token.facts.get(row.secondIndex); if (cached) return cached;
  const bin = token.changesBySecond.get(row.secondIndex) ?? [];
  const books = bin.filter(change => change.kind === "book"), trades = bin.filter(change => change.kind === "trade");
  const clockAffected = (row.clockIssueSequences?.length ?? 0) > 0 ||
    row.reasons.some(reason => reason === "receipt-wall-clock-backstep" || reason === "book-source-clock-invalid") ||
    indexed.clockIntervals.some(issue => issue.startAtMs < row.endAtMs && issue.endAtMs >= row.startAtMs);
  const invalidated = row.status !== "closed" && (row.reasons.some(reason => ["within-second-invalidation", "pending-snapshot-audit", "unresolved-snapshot-audit"].includes(reason)) ||
    token.changes.some(change => {
      if (change.kind !== "invalidation") return false;
      const data = objectValue(change.data), from = typeof data?.uncertainFromMs === "number" ? data.uncertainFromMs : change.observedAtMs;
      if (from >= row.endAtMs || change.observedAtMs < row.startAtMs) return false;
      // The exporter permits a source batch that reconciles within the same complete second.
      if (data?.provisional === true && from >= row.startAtMs && change.observedAtMs < row.endAtMs &&
          books.some(book => changeOrder(book, change) > 0)) return false;
      return true;
    }));
  const tradeShares = trades.reduce((sum, change) => sum + Number(change.size), 0);
  const changesMatch = books.length === row.bookUpdates && trades.length === row.tradeCount &&
    Math.abs(tradeShares - row.tradeShares) <= 1e-10 * Math.max(1, tradeShares, row.tradeShares);
  const lastBook = books.at(-1), previous = token.rows.get(row.secondIndex - 1);
  const active = row.status === "observed" || row.status === "carried";
  // Closed rows may retain historical timestamps/counters, but cannot also expose a valid active book.
  let bookCoherent = row.status !== "closed" || (!row.wholeSecondValid && row.bestBid === null && row.bestAsk === null &&
    (row.bids?.length ?? 0) === 0 && (row.asks?.length ?? 0) === 0);
  if (active && row.wholeSecondValid) {
    bookCoherent = (row.status === "observed") === (row.bookUpdates > 0);
    if (row.bookUpdates === 0) bookCoherent &&= row.bookObservedAtMs !== null && row.bookObservedAtMs < row.startAtMs;
    if (lastBook) bookCoherent &&= samePrice(row.bestBid, lastBook.bestBid ?? null) && samePrice(row.bestAsk, lastBook.bestAsk ?? null) &&
      row.bookObservedAtMs === lastBook.observedAtMs && row.bookSourceAtMs === lastBook.sourceAtMs;
    else if (previous?.wholeSecondValid && (previous.status === "observed" || previous.status === "carried")) {
      bookCoherent &&= samePrice(row.bestBid, previous.bestBid) && samePrice(row.bestAsk, previous.bestAsk) && row.bookObservedAtMs === previous.bookObservedAtMs;
    }
    if (books.length === 0 || (previous?.bids !== null && previous?.asks !== null && previous !== undefined)) {
      const seed = books.length === 0 ? row : previous!;
      bookCoherent &&= extremaMatch(row.minBestBid, row.maxBestBid, [seed.bestBid, ...books.map(book => book.bestBid)]) &&
        extremaMatch(row.minBestAsk, row.maxBestAsk, [seed.bestAsk, ...books.map(book => book.bestAsk)]);
    }
  }
  const withinRun = row.startAtMs >= source.input.summary.firstReceivedAtMs && row.endAtMs <= source.input.summary.lastReceivedAtMs;
  const safe = withinRun && !clockAffected && !invalidated && changesMatch && bookCoherent;
  const facts: RowFacts = { clockAffected, invalidated, changesMatch, bookCoherent,
    activeValid: active && row.wholeSecondValid && safe, closedValid: row.status === "closed" && safe };
  token.facts.set(row.secondIndex, facts); return facts;
}

function referenceFor(token: IndexedToken, entryAtMs: number | null, indexed: IndexedWindow, source: IndexedSource): TailEntryReference {
  let chosen: TailSecond | undefined;
  const entryRow = entryAtMs === null || indexed.window.startAtMs === null ? undefined : token.rows.get((entryAtMs - indexed.window.startAtMs) / 1_000 - 1);
  if (entryAtMs !== null) for (const row of token.rows.values()) {
    if (row.endAtMs <= entryAtMs && (!chosen || row.endAtMs > chosen.endAtMs) && rowFacts(row, token, indexed, source).activeValid) chosen = row;
  }
  return { tokenId: token.market.tokenId, outcome: token.market.outcome, secondIndex: chosen?.secondIndex ?? null,
    startAtMs: chosen?.startAtMs ?? null, endAtMs: chosen?.endAtMs ?? null, bookObservedAtMs: chosen?.bookObservedAtMs ?? null,
    bookSourceAtMs: chosen?.bookSourceAtMs ?? null, bestBid: chosen?.bestBid ?? null, bestAsk: chosen?.bestAsk ?? null, status: chosen?.status ?? null,
    entryStatus: entryRow?.status ?? null, clockAffected: entryRow !== undefined && rowFacts(entryRow, token, indexed, source).clockAffected,
    quality: token.quality ? { observedWindowComplete: token.quality.observedWindowComplete, snapshotAuditPassed: token.quality.snapshotAuditPassed, validSeconds: token.quality.validSeconds } : null,
    // With aligned one-second archives, a gap or intervening closure cannot carry an old quote into entry.
    priceValid: chosen !== undefined && chosen.endAtMs === entryAtMs,
    contextStatus: chosen?.contextStatus ?? null, contextFresh: chosen?.contextStatus === "present" };
}

function observedQuality(token: IndexedToken, indexed: IndexedWindow, source: IndexedSource): NonNullable<IndexedToken["observedQuality"]> {
  if (token.observedQuality) return token.observedQuality;
  const quality = { validSeconds: 0, closedSeconds: 0, clockAffectedSeconds: 0 };
  for (const row of token.rows.values()) {
    const facts = rowFacts(row, token, indexed, source);
    if (facts.activeValid) quality.validSeconds++;
    if (facts.closedValid) quality.closedSeconds++;
    if (facts.clockAffected) quality.clockAffectedSeconds++;
  }
  token.observedQuality = quality; return quality;
}

function coverageFor(token: IndexedToken | undefined, entryAtMs: number | null, windowSeconds: number, indexed: IndexedWindow,
  source: IndexedSource, references: TailEntryReference[]): { price: TailPriceCoverage; context: TailContextCoverage; rows: TailSecond[] } {
  const price: TailPriceCoverage = { expectedSeconds: windowSeconds, recordedSeconds: 0, validSeconds: 0, observedSeconds: 0, carriedSeconds: 0,
    closedSeconds: 0, partialSeconds: 0, missingSeconds: 0, invalidSeconds: 0, staleSeconds: 0, outsideRunSeconds: 0, notYetKnownSeconds: 0,
    absentSeconds: windowSeconds, clockAffectedSeconds: 0, invalidationSeconds: 0, changeCountsMatch: true, bookEvidenceCoherent: true, complete: false };
  const context: TailContextCoverage = { expectedSeconds: windowSeconds, presentSeconds: 0, missingSeconds: 0, staleSeconds: 0, disconnectedSeconds: 0,
    absentSeconds: windowSeconds, entryReferencesFresh: references.length > 0 && references.every(reference => reference.priceValid && reference.contextFresh), complete: false };
  const rows = token && entryAtMs !== null ? [...token.rows.values()].filter(row => row.startAtMs >= entryAtMs && row.endAtMs <= entryAtMs + windowSeconds * 1_000)
    .sort((a, b) => a.startAtMs - b.startAtMs) : [];
  for (const row of rows) {
    const facts = rowFacts(row, token!, indexed, source);
    price.recordedSeconds++; price.absentSeconds--; context.absentSeconds--;
    if (facts.activeValid) price.validSeconds++;
    switch (row.status) {
      case "observed": price.observedSeconds++; break;
      case "carried": price.carriedSeconds++; break;
      case "closed": price.closedSeconds++; break;
      case "partial": price.partialSeconds++; break;
      case "missing": price.missingSeconds++; break;
      case "invalid": price.invalidSeconds++; break;
      case "feed_stale": price.staleSeconds++; break;
      case "outside_run": price.outsideRunSeconds++; break;
      case "not_yet_known": price.notYetKnownSeconds++; break;
    }
    if (facts.clockAffected) price.clockAffectedSeconds++;
    if (facts.invalidated) price.invalidationSeconds++;
    price.changeCountsMatch &&= facts.changesMatch; price.bookEvidenceCoherent &&= facts.bookCoherent;
    switch (row.contextStatus) {
      case "present": context.presentSeconds++; break;
      case "missing": context.missingSeconds++; break;
      case "stale": context.staleSeconds++; break;
      case "disconnected": context.disconnectedSeconds++; break;
    }
  }
  price.complete = rows.length === windowSeconds && rows.every(row => {
    const facts = rowFacts(row, token!, indexed, source); return facts.activeValid || facts.closedValid;
  });
  context.complete = context.entryReferencesFresh && context.presentSeconds === windowSeconds;
  return { price, context, rows };
}

function addExclusion(trial: TailBacktestTrial, exclusion: TailBacktestExclusion): void {
  if (!trial.exclusions.includes(exclusion)) trial.exclusions.push(exclusion);
}

function trialFor(source: IndexedSource, indexed: IndexedWindow, outcomes: IndexedToken[], bidPrice: string, windowSeconds: number,
  options: EffectiveTailBacktestOptions, accounting: Map<TailBacktestTrial, ExactAmounts>): TailBacktestTrial {
  const { window } = indexed, market = outcomes[0]!.market;
  // Older TailSummary archives carry explicit source labels without optional compact witnesses.
  const finishKnown = window.endAtMs !== null && window.finishSources.length > 0 &&
    window.finishSources.every(label => label === "gamma.finishedTimestamp" || label === "sports.finishedAt");
  const finishAtMs = finishKnown ? window.endAtMs : null;
  const finishConflict = window.finishConflict || (window.endAtMs !== null && (window.finishEvidence ?? []).some(fact => fact.atMs !== window.endAtMs));
  const entryAtMs = finishAtMs === null ? null : finishAtMs - windowSeconds * 1_000;
  const references = outcomes.map(token => referenceFor(token, entryAtMs, indexed, source));
  const allReferencesValid = references.every(reference => reference.priceValid);
  const reference = allReferencesValid ? references.filter(row => row.bestBid !== null)
    .sort((a, b) => comparePrice(b.bestBid!, a.bestBid!) || lexical(a.tokenId, b.tokenId))[0] : undefined;
  const token = reference ? indexed.tokens.get(reference.tokenId) : undefined;
  const coverage = coverageFor(token, entryAtMs, windowSeconds, indexed, source, references);
  const settlement = token?.settlement ?? null;
  const trial: TailBacktestTrial = {
    sourceId: source.input.sourceId, sourceRunId: source.input.summary.runId, windowKey: window.key, gameId: window.gameId,
    eventId: market.eventId, eventSlug: market.eventSlug, eventTitle: window.title, sport: source.input.sport,
    marketId: market.marketId, marketSlug: market.marketSlug, conditionId: market.conditionId, marketType: market.marketType, question: market.question,
    tokenId: token?.market.tokenId ?? null, outcome: token?.market.outcome ?? null, windowBasis: "match-finish", fillModel: options.fillModel,
    bidPrice, windowSeconds, orderShares: options.shares, queueAheadShares: options.queueAheadShares, makerFeeBps: options.makerFeeBps,
    finishAtMs, finishConflict, finishSources: [...window.finishSources], finishEvidence: (window.finishEvidence ?? []).map(fact => ({ ...fact })),
    entryAtMs, expiryAtMs: finishAtMs, referenceStartAtMs: reference?.startAtMs ?? null, referenceAtMs: reference?.endAtMs ?? null,
    referenceBookObservedAtMs: reference?.bookObservedAtMs ?? null, referenceBid: reference?.bestBid ?? null, referenceAsk: reference?.bestAsk ?? null,
    entryReferences: references, tokenQuality: token?.quality ? { ...token.quality, reasons: [...token.quality.reasons] } : null,
    priceCoverage: coverage.price, contextCoverage: coverage.context, exclusions: [], eligible: false, pnlEligible: false,
    touched: false, touchBookChangeCount: 0, touchSecondCount: 0, touchTradeCount: 0, touchSellShares: 0,
    equalSellTradeCount: 0, equalSellShares: 0, sellThroughTradeCount: 0, sellThroughShares: 0,
    firstTouch: null, firstTouchAtMs: null, firstModeledFillAtMs: null,
    modeledFilledShares: null, modeledCost: null, modeledFee: null, modeledPayout: null, modeledPnl: null,
    payoutPerShare: settlement?.payout ?? null, settlement: settlement ? { ...settlement } : null,
    settlementVector: outcomes.flatMap(outcome => outcome.settlement ? [{ ...outcome.settlement }] : [])
  };
  if (!finishKnown) addExclusion(trial, "missing-actual-finish");
  if (finishConflict) addExclusion(trial, "conflicting-finish-labels");
  if (!allReferencesValid) addExclusion(trial, "missing-entry-reference");
  if (references.some(reference => reference.entryStatus === "closed")) addExclusion(trial, "entry-book-closed");
  if (references.some(reference => reference.clockAffected)) addExclusion(trial, "clock-affected-data");
  if (allReferencesValid && !reference) addExclusion(trial, "missing-entry-bid");
  if (reference && comparePrice(reference.bestBid!, options.entryMinBid) < 0) addExclusion(trial, "entry-below-threshold");
  // A price-valid reference has complete depth; null bestAsk means an observed empty ask side, which cannot be crossed.
  if (reference?.bestAsk != null && comparePrice(bidPrice, reference.bestAsk) >= 0) addExclusion(trial, "limit-not-below-entry-ask");
  if (source.countMismatch) addExclusion(trial, "archive-count-mismatch");
  if (source.journalIncomplete) addExclusion(trial, "journal-data-incomplete");
  // All outcome references are supported by their archive quality; holding coverage below concerns the selected token.
  for (const outcome of outcomes) {
    const quality = outcome.quality, observed = observedQuality(outcome, indexed, source);
    if (!quality?.observedWindowComplete || outcome.rows.size !== quality.expectedSeconds ||
      quality.validSeconds !== observed.validSeconds || quality.closedSeconds !== observed.closedSeconds ||
      observed.validSeconds + observed.closedSeconds !== quality.expectedSeconds) addExclusion(trial, "token-window-incomplete");
    if (!quality?.snapshotAuditPassed || quality.snapshotMismatches > 0 || (quality.snapshotMatches === 0 && quality.closedSeconds !== quality.expectedSeconds) ||
        quality.reasons.some(reason => reason === "pending-snapshot-audit" || reason === "unresolved-snapshot-audit")) addExclusion(trial, "snapshot-audit-not-passed");
    if (!quality || quality.validSeconds === 0 || observed.validSeconds === 0) addExclusion(trial, "no-active-book-seconds");
    if (observed.clockAffectedSeconds > 0 || (quality?.clockAffectedSeconds ?? 0) > 0 || quality?.reasons.includes("book-source-clock-invalid")) addExclusion(trial, "clock-affected-data");
  }
  if (entryAtMs !== null && (entryAtMs < (window.startAtMs ?? Infinity) || entryAtMs < source.input.summary.firstReceivedAtMs ||
    finishAtMs! > source.input.summary.lastReceivedAtMs)) addExclusion(trial, "holding-window-not-covered");
  if (token && !coverage.price.complete) addExclusion(trial, "holding-data-incomplete");
  if (coverage.price.clockAffectedSeconds > 0) addExclusion(trial, "clock-affected-data");
  if (!coverage.price.changeCountsMatch) addExclusion(trial, "change-count-mismatch");
  if (!coverage.price.bookEvidenceCoherent) addExclusion(trial, "inconsistent-book-evidence");
  if (options.requireFreshContext && !coverage.context.complete) addExclusion(trial, "context-not-fresh");
  trial.eligible = trial.exclusions.length === 0;
  if (token) simulate(trial, token, indexed, source, coverage.rows, options, accounting);
  return trial;
}

function rememberTouch(trial: TailBacktestTrial, evidence: TailTouchEvidence): void {
  const previous = trial.firstTouch;
  if (!previous || evidence.observedAtMs < previous.observedAtMs || (evidence.observedAtMs === previous.observedAtMs &&
    ((evidence.sequence ?? Infinity) < (previous.sequence ?? Infinity) || (evidence.sequence === previous.sequence && (evidence.frameIndex ?? Infinity) < (previous.frameIndex ?? Infinity))))) {
    trial.firstTouch = evidence; trial.firstTouchAtMs = evidence.observedAtMs;
  }
  trial.touched = true;
}

function simulate(trial: TailBacktestTrial, token: IndexedToken, indexed: IndexedWindow, source: IndexedSource, rows: TailSecond[],
  options: EffectiveTailBacktestOptions, accounting: Map<TailBacktestTrial, ExactAmounts>): void {
  const entry = trial.entryAtMs!, expiry = trial.expiryAtMs!;
  const queue = units(options.queueAheadShares), requested = units(options.shares);
  let through = 0n, equal = 0n, touchedShares = 0n;
  let firstVolumeFillAtMs: number | null = null;
  for (const change of token.changes) {
    if (change.observedAtMs < entry || change.observedAtMs >= expiry) continue;
    const secondIndex = Math.floor((change.observedAtMs - indexed.window.startAtMs!) / 1_000), row = token.rows.get(secondIndex);
    if (!row || !rowFacts(row, token, indexed, source).activeValid) continue;
    if (change.kind === "book" && change.bestAsk != null && comparePrice(change.bestAsk, trial.bidPrice) <= 0) {
      trial.touchBookChangeCount++;
      rememberTouch(trial, { kind: "book-ask", evidenceSource: "change", observedAtMs: change.observedAtMs, sourceAtMs: change.sourceAtMs,
        sequence: change.sequence, frameIndex: change.frameIndex, secondIndex, price: change.bestAsk, size: null });
    }
    if (change.kind !== "trade" || change.side !== "SELL") continue;
    const comparison = comparePrice(change.price!, trial.bidPrice);
    if (comparison > 0) continue;
    const size = units(change.size!);
    trial.touchTradeCount++; touchedShares += size;
    rememberTouch(trial, { kind: "sell-print", evidenceSource: "change", observedAtMs: change.observedAtMs, sourceAtMs: change.sourceAtMs,
      sequence: change.sequence, frameIndex: change.frameIndex, secondIndex, price: change.price!, size: change.size! });
    if (comparison === 0) { trial.equalSellTradeCount++; equal += size; }
    else {
      trial.sellThroughTradeCount++; through += size;
      if (through > queue && firstVolumeFillAtMs === null) firstVolumeFillAtMs = change.observedAtMs;
    }
  }
  // Closing rows add evidence for a persistent ask. They never stand in for an unseen intra-second minimum.
  for (const row of rows) if (rowFacts(row, token, indexed, source).activeValid && row.bestAsk !== null && comparePrice(row.bestAsk, trial.bidPrice) <= 0) {
    trial.touchSecondCount++;
    if (row.bookObservedAtMs !== null && row.bookObservedAtMs >= entry && row.bookObservedAtMs < expiry) rememberTouch(trial, {
      kind: "book-ask", evidenceSource: "second-close", observedAtMs: row.bookObservedAtMs, sourceAtMs: row.bookSourceAtMs,
      sequence: null, frameIndex: null, secondIndex: row.secondIndex, price: row.bestAsk, size: null
    });
  }
  trial.touchSellShares = shares(touchedShares); trial.equalSellShares = shares(equal); trial.sellThroughShares = shares(through);
  if (!trial.eligible) return;
  const available = through > queue ? through - queue : 0n;
  const filled = options.fillModel === "quote-touch-assumed" ? (trial.touched ? requested : 0n) : (available < requested ? available : requested);
  trial.modeledFilledShares = shares(filled);
  trial.firstModeledFillAtMs = filled === 0n ? null : options.fillModel === "quote-touch-assumed" ? trial.firstTouchAtMs : firstVolumeFillAtMs;
  const amounts = exactAmounts(trial, filled); accounting.set(trial, amounts);
  trial.modeledCost = money(amounts.cost); trial.modeledFee = money(amounts.fee);
  trial.modeledPayout = amounts.payout === null ? null : money(amounts.payout);
  trial.modeledPnl = amounts.pnl === null ? null : money(amounts.pnl);
  trial.pnlEligible = amounts.pnl !== null;
}

interface ExactTotals {
  filled: bigint; cost: bigint; fee: bigint; unresolvedCost: bigint; unresolvedFee: bigint;
  payout: bigint; pnl: bigint; winnings: bigint; losses: bigint; capital: bigint;
}
function summarize(trials: TailBacktestTrial[], accounting: Map<TailBacktestTrial, ExactAmounts>): TailBacktestSummary[] {
  const groups = new Map<string, { summary: TailBacktestSummary; games: Set<string>; sources: Set<string>; totals: ExactTotals }>();
  for (const trial of trials) {
    const groupKey = key(trial.sport, trial.marketType, trial.bidPrice, trial.windowSeconds, trial.fillModel);
    let group = groups.get(groupKey);
    if (!group) {
      group = { games: new Set(), sources: new Set(), totals: {
        filled: 0n, cost: 0n, fee: 0n, unresolvedCost: 0n, unresolvedFee: 0n, payout: 0n, pnl: 0n, winnings: 0n, losses: 0n, capital: 0n
      }, summary: {
        sport: trial.sport, marketType: trial.marketType, bidPrice: trial.bidPrice, windowSeconds: trial.windowSeconds, windowBasis: "match-finish",
        fillModel: trial.fillModel, orderShares: trial.orderShares, queueAheadShares: trial.queueAheadShares, makerFeeBps: trial.makerFeeBps,
        trials: 0, games: 0, sources: 0, eligibleTrials: 0, excludedTrials: 0, unresolvedTrials: 0, pnlEligibleTrials: 0,
        priceCompleteTrials: 0, contextCompleteTrials: 0, touchedTrials: 0, modeledFilledTrials: 0, settledFilledTrials: 0,
        zeroFillTrials: 0, winningFills: 0, losingFills: 0, breakEvenFills: 0, splitPayoutFills: 0,
        modeledFilledShares: 0, modeledCost: 0, modeledFees: 0, unresolvedFilledCost: 0, unresolvedFilledFees: 0,
        modeledPayout: null, modeledPnl: null, winnings: 0, losses: 0, pnlTrialDenominator: 0, filledCapitalDenominator: 0,
        pnlPerTrial: null, returnOnFilledCapital: null, exclusions: {}
      } }; groups.set(groupKey, group);
    }
    const { summary, totals } = group;
    summary.trials++; group.games.add(trial.windowKey); group.sources.add(trial.sourceId);
    if (trial.priceCoverage.complete) summary.priceCompleteTrials++;
    if (trial.contextCoverage.complete) summary.contextCompleteTrials++;
    if (!trial.eligible) {
      summary.excludedTrials++;
      for (const exclusion of trial.exclusions) summary.exclusions[exclusion] = (summary.exclusions[exclusion] ?? 0) + 1;
      continue;
    }
    summary.eligibleTrials++;
    if (trial.touched) summary.touchedTrials++;
    const amounts = accounting.get(trial)!, { filled, cost, fee } = amounts;
    totals.filled += filled; totals.cost += cost; totals.fee += fee;
    if (filled > 0n) summary.modeledFilledTrials++; else summary.zeroFillTrials++;
    if (!trial.pnlEligible) {
      summary.unresolvedTrials++;
      totals.unresolvedCost += cost; totals.unresolvedFee += fee;
      continue;
    }
    summary.pnlEligibleTrials++; summary.pnlTrialDenominator++;
    const pnl = amounts.pnl!;
    totals.payout += amounts.payout!; totals.pnl += pnl;
    if (filled > 0n) {
      summary.settledFilledTrials++; totals.capital += cost + fee;
      if (pnl > 0n) { summary.winningFills++; totals.winnings += pnl; }
      else if (pnl < 0n) { summary.losingFills++; totals.losses -= pnl; }
      else summary.breakEvenFills++;
      if (trial.payoutPerShare !== 0 && trial.payoutPerShare !== 1) summary.splitPayoutFills++;
    }
  }
  return [...groups.values()].map(({ summary, games, sources, totals }) => {
    summary.games = games.size; summary.sources = sources.size;
    summary.modeledFilledShares = rounded(shares(totals.filled));
    summary.modeledCost = money(totals.cost); summary.modeledFees = money(totals.fee);
    summary.unresolvedFilledCost = money(totals.unresolvedCost); summary.unresolvedFilledFees = money(totals.unresolvedFee);
    summary.modeledPayout = summary.pnlEligibleTrials > 0 ? money(totals.payout) : null;
    summary.modeledPnl = summary.pnlEligibleTrials > 0 ? money(totals.pnl) : null;
    summary.winnings = money(totals.winnings); summary.losses = money(totals.losses);
    summary.filledCapitalDenominator = money(totals.capital);
    summary.pnlPerTrial = summary.pnlTrialDenominator > 0 ? rounded(summary.modeledPnl! / summary.pnlTrialDenominator) : null;
    summary.returnOnFilledCapital = summary.filledCapitalDenominator > 0 ? rounded(summary.modeledPnl! / summary.filledCapitalDenominator) : null;
    return summary;
  });
}

/** Pure research over already collected archives. This function performs no IO and places no orders. */
export function backtestTailArchives(inputs: readonly TailBacktestInput[], inputOptions?: TailBacktestOptions): TailBacktestResult {
  const options = effectiveOptions(inputOptions);
  check(Array.isArray(inputs), "inputs must be an array");
  const registry: Registry = { sources: new Set(), games: new Set(), eventIds: new Set(), eventSlugs: new Set(), markets: new Set(), conditions: new Set(), tokens: new Set() };
  const sources: IndexedSource[] = [];
  for (const input of inputs) sources.push(indexSource(input, registry));
  validateFinishMappings(sources);
  let projectedTrials = 0, projectedEvidence = 0;
  const combinations = options.windowsSeconds.length * options.prices.length;
  for (const source of sources) for (const indexed of source.windows) for (const outcomes of indexed.markets.values()) {
    projectedTrials += combinations;
    let reasonCount = 0;
    for (const token of outcomes) reasonCount = Math.max(reasonCount, token.quality?.reasons.length ?? 0);
    // Entry references, entry quality, settlement vector, finish witnesses and copied reason/source arrays.
    projectedEvidence += combinations * (outcomes.length * 3 + (indexed.window.finishEvidence?.length ?? 0) + indexed.window.finishSources.length + reasonCount + 1);
    if (projectedTrials > TAIL_BACKTEST_LIMITS.trials) optionsError(`expanded trial count exceeds ${TAIL_BACKTEST_LIMITS.trials}`);
    if (projectedEvidence > TAIL_BACKTEST_LIMITS.evidenceItems) optionsError(`expanded evidence items exceed ${TAIL_BACKTEST_LIMITS.evidenceItems}`);
  }
  const trials: TailBacktestTrial[] = [];
  const accounting = new Map<TailBacktestTrial, ExactAmounts>();
  for (const source of sources) for (const indexed of source.windows) for (const outcomes of indexed.markets.values())
    for (const windowSeconds of options.windowsSeconds) for (const price of options.prices) trials.push(trialFor(source, indexed, outcomes, price, windowSeconds, options, accounting));
  return {
    schemaVersion: 1, basis: "received-order-book-tail", execution: "hypothetical", options,
    sources: sources.map(({ input }) => ({ sourceId: input.sourceId, sourceRunId: input.summary.runId, sport: input.sport,
      archiveWindowSeconds: input.summary.windowSeconds, firstReceivedAtMs: input.summary.firstReceivedAtMs, lastReceivedAtMs: input.summary.lastReceivedAtMs,
      windowKeys: input.summary.windows.map(window => window.key), warnings: [...input.summary.warnings] })),
    trials, summaries: summarize(trials, accounting), warnings: [
      "All fills are hypothetical. Quote-touch-assumed assigns the full requested size to a valid ask or direct SELL touch; it assumes execution without proof of queue position, available depth or latency. Fixed queue-ahead applies only to sell-through-volume.",
      "Sell-through-volume uses direct SELL prints strictly below the limit, subtracts fixed queue-ahead once and caps at requested shares. BUY and equal-price prints supply no strict-through volume; this is not proof of execution.",
      "Entries use retrospective actual match finish and a complete book second known before entry. Match finish is not an observed per-set finish or a live prediction of when the match ends.",
      "Parameter alternatives, overlapping windows and same-game markets are not independent portfolio trades. Do not add their scenario profits as a portfolio return.",
      "A small or tiny in-sample result is not proof of optimal future expectation. Recorded market discovery, receipt timing and hypothetical fills limit the inference.",
      "Price coverage and context freshness are separate. Excluded trials have null modeled amounts; unresolved modeled fills have null PnL and are omitted from profit/return denominators. Complete zero-fills contribute zero PnL.",
      "Cost, fee, payout and PnL use exact decimal netting and aggregation at the resting limit and configured notional maker fee. Only numeric output amounts are rounded to 15 significant digits; fill classifications use exact net amounts. Raw price strings are preserved."
    ]
  };
}
