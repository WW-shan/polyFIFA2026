import type { OrderbookSnapshot } from "../../domain/types.js";

export const LATE_SCORE_FEATURE_SPEC = ["margin/10", "margin*root/10", "margin/minutes/10", "root", "ot"] as const;
export const LATE_SCORE_FEATURE_COUNT = LATE_SCORE_FEATURE_SPEC.length;

export interface LateScoreState {
  period: number;
  clockSeconds: number;
  homeScore: number;
  awayScore: number;
}

export interface LateScoreSelfTest extends LateScoreState {
  clock: string;
  features: number[];
  probability: number;
}

export interface LateScoreModel {
  schemaVersion: 1;
  league: string;
  featureSpec: string[];
  finalPeriod: number;
  periodSeconds: number;
  feeRate: number;
  coefficients: number[];
  mean: number[];
  scale: number[];
  trainedGames: number;
  trainedStates: number;
  firstGameStart: string;
  lastGameStart: string;
  datasetSha256: string;
  createdAt: string;
  selfTest: LateScoreSelfTest[];
}

export interface LateScoreSignalOptions {
  windowSeconds: number;
  minProbability: number;
  minEdge: number;
  limitOffset: number;
  maxPrice: number;
  shares: number;
}

export interface BookFill {
  limitPrice: number;
  filledShares: number;
  cost: number;
  averagePrice: number | null;
  worstPrice: number | null;
  complete: boolean;
}

export type LateScoreReason =
  | "fire"
  | "state-unusable"
  | "outside-window"
  | "probability-below-minimum"
  | "no-ask"
  | "ask-above-limit"
  | "edge-too-small";

export interface LateScoreSideEvaluation {
  side: "home" | "away";
  fair: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  limit: number;
  edge: number | null;
  reason: LateScoreReason;
  fill: BookFill;
}

export interface LateScoreSignalEvaluation {
  fire: boolean;
  reason: LateScoreReason;
  side: "home" | "away" | null;
  pHome: number | null;
  remainingSeconds: number | null;
  fair: { home: number; away: number } | null;
  sides: { home: LateScoreSideEvaluation; away: LateScoreSideEvaluation };
}

export interface LateScoreSignalInput {
  state: LateScoreState;
  model: LateScoreModel;
  market: { homeTokenId: string; awayTokenId: string };
  books: { home: OrderbookSnapshot; away: OrderbookSnapshot };
  options: LateScoreSignalOptions;
}

function invalid(detail: string): never {
  throw new Error(`SHADOW_MODEL_INVALID: ${detail}`);
}

function finiteArray(value: unknown, length: number, name: string): number[] {
  if (!Array.isArray(value) || value.length !== length) invalid(`${name} must have ${length} finite numbers`);
  return value.map((item, index) => {
    if (typeof item !== "number" || !Number.isFinite(item)) invalid(`${name}[${index}] must be finite`);
    return item;
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(`${name} must be a nonempty string`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(`${name} must be a positive integer`);
  return value;
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(`${name} must be a nonnegative integer`);
  return value;
}

export function parseClockSeconds(display: string): number | null {
  const match = /^(\d{1,3}):([0-5]\d(?:\.\d+)?)$/.exec(display.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Same transform as tools/research/late_score_walk_forward.py:feature. */
export function lateScoreFeatures(state: LateScoreState, model: Pick<LateScoreModel, "finalPeriod" | "periodSeconds">): number[] | null {
  const { period, clockSeconds, homeScore, awayScore } = state;
  if (![period, clockSeconds, homeScore, awayScore].every(Number.isFinite)) return null;
  if (period < 1 || clockSeconds < 0) return null;
  const finalPeriod = model.finalPeriod;
  const periodSeconds = model.periodSeconds;
  let remaining: number;
  let overtime: number;
  if (period <= finalPeriod) {
    remaining = Math.max(0, (finalPeriod - period) * periodSeconds + clockSeconds);
    overtime = 0;
  } else {
    remaining = Math.max(0, clockSeconds);
    overtime = period - finalPeriod;
  }
  if (remaining > 900) return null;
  const minutes = (remaining + 1) / 60;
  const root = 1 / Math.sqrt(minutes);
  const margin = homeScore - awayScore;
  return [margin / 10, (margin * root) / 10, margin / minutes / 10, root, overtime];
}

export function predictHomeProbability(model: Pick<LateScoreModel, "coefficients" | "mean" | "scale">, features: readonly number[]): number {
  let eta = model.coefficients[0]!;
  for (let index = 0; index < LATE_SCORE_FEATURE_COUNT; index += 1) {
    eta += ((features[index]! - model.mean[index]!) / model.scale[index]!) * model.coefficients[index + 1]!;
  }
  const clipped = Math.max(-35, Math.min(35, eta));
  return 1 / (1 + Math.exp(-clipped));
}

function selfTestSelfCheck(model: LateScoreModel): void {
  for (const [index, check] of model.selfTest.entries()) {
    const clockSeconds = parseClockSeconds(check.clock);
    const features = clockSeconds === null ? null : lateScoreFeatures({ ...check, clockSeconds }, model);
    if (!features || features.length !== check.features.length) {
      throw new Error(`SHADOW_MODEL_SELFTEST_FAILED: check ${index} produced no usable features`);
    }
    for (let position = 0; position < features.length; position += 1) {
      if (Math.abs(features[position]! - check.features[position]!) > 1e-9) {
        throw new Error(`SHADOW_MODEL_SELFTEST_FAILED: check ${index} feature ${position} differs from the Python exporter`);
      }
    }
    const predicted = predictHomeProbability(model, features);
    if (Math.abs(predicted - check.probability) > 1e-9) {
      throw new Error(`SHADOW_MODEL_SELFTEST_FAILED: check ${index} probability differs from the Python exporter`);
    }
  }
}

export function parseLateScoreModel(value: unknown): LateScoreModel {
  const raw = record(value);
  if (!raw) invalid("artifact must be an object");
  if (raw.schemaVersion !== 1) invalid("schemaVersion must be 1");
  const featureSpec = Array.isArray(raw.featureSpec) ? raw.featureSpec.map(String) : null;
  if (!featureSpec || featureSpec.join(",") !== LATE_SCORE_FEATURE_SPEC.join(",")) {
    invalid(`featureSpec must be ${LATE_SCORE_FEATURE_SPEC.join(",")}`);
  }
  const coefficients = finiteArray(raw.coefficients, LATE_SCORE_FEATURE_COUNT + 1, "coefficients");
  const mean = finiteArray(raw.mean, LATE_SCORE_FEATURE_COUNT, "mean");
  const scale = finiteArray(raw.scale, LATE_SCORE_FEATURE_COUNT, "scale");
  if (scale.some(item => item === 0)) invalid("scale must not contain zero");
  const feeRate = raw.feeRate;
  if (typeof feeRate !== "number" || !Number.isFinite(feeRate) || feeRate < 0 || feeRate >= 1) invalid("feeRate must be in [0,1)");
  const selfTestRaw = raw.selfTest;
  if (!Array.isArray(selfTestRaw)) invalid("selfTest must be an array");
  const selfTest: LateScoreSelfTest[] = selfTestRaw.map((entry, index) => {
    const check = record(entry);
    if (!check) invalid(`selfTest[${index}] must be an object`);
    const clock = nonempty(check.clock, `selfTest[${index}].clock`);
    const features = finiteArray(check.features, LATE_SCORE_FEATURE_COUNT, `selfTest[${index}].features`);
    const probability = check.probability;
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability <= 0 || probability >= 1) {
      invalid(`selfTest[${index}].probability must be in (0,1)`);
    }
    return {
      period: positiveInteger(check.period, `selfTest[${index}].period`),
      clockSeconds: parseClockSeconds(clock) ?? invalid(`selfTest[${index}].clock is not a game clock`),
      clock,
      homeScore: finiteNumber(check.homeScore, `selfTest[${index}].homeScore`),
      awayScore: finiteNumber(check.awayScore, `selfTest[${index}].awayScore`),
      features,
      probability
    };
  });
  const model: LateScoreModel = {
    schemaVersion: 1,
    league: nonempty(raw.league, "league"),
    featureSpec: [...featureSpec],
    finalPeriod: positiveInteger(raw.finalPeriod, "finalPeriod"),
    periodSeconds: positiveInteger(raw.periodSeconds, "periodSeconds"),
    feeRate,
    coefficients,
    mean,
    scale,
    trainedGames: nonnegativeInteger(raw.trainedGames, "trainedGames"),
    trainedStates: nonnegativeInteger(raw.trainedStates, "trainedStates"),
    firstGameStart: nonempty(raw.firstGameStart, "firstGameStart"),
    lastGameStart: nonempty(raw.lastGameStart, "lastGameStart"),
    datasetSha256: nonempty(raw.datasetSha256, "datasetSha256"),
    createdAt: nonempty(raw.createdAt, "createdAt"),
    selfTest
  };
  selfTestSelfCheck(model);
  return model;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${name} must be finite`);
  return value;
}

export function walkBook(book: OrderbookSnapshot, limitPrice: number, shares: number): BookFill {
  const asks = [...book.asks].sort((left, right) => left.price - right.price);
  let remaining = Math.max(0, shares);
  let filledShares = 0;
  let cost = 0;
  let worstPrice: number | null = null;
  for (const level of asks) {
    if (remaining <= 0) break;
    if (level.price > limitPrice + 1e-9) break;
    const take = Math.min(remaining, level.size);
    if (take <= 0) continue;
    remaining -= take;
    filledShares += take;
    cost += take * level.price;
    worstPrice = level.price;
  }
  return {
    limitPrice,
    filledShares,
    cost,
    averagePrice: filledShares > 0 ? cost / filledShares : null,
    worstPrice,
    complete: filledShares >= shares && shares > 0
  };
}

function sideEvaluation(
  side: "home" | "away",
  fair: number,
  book: OrderbookSnapshot,
  options: LateScoreSignalOptions
): LateScoreSideEvaluation {
  const bid = book.bids[0]?.price ?? null;
  const ask = book.asks[0]?.price ?? null;
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
  const limit = Math.min(options.maxPrice, fair - options.limitOffset);
  const fill = walkBook(book, limit, options.shares);
  let reason: LateScoreReason = "fire";
  if (fair < options.minProbability) reason = "probability-below-minimum";
  else if (ask === null) reason = "no-ask";
  else if (ask > limit + 1e-9) reason = "ask-above-limit";
  else if (fair - ask < options.minEdge - 1e-9) reason = "edge-too-small";
  return { side, fair, bid, ask, mid, limit, edge: ask === null ? null : fair - ask, reason, fill };
}

export function evaluateLateScoreSignal(input: LateScoreSignalInput): LateScoreSignalEvaluation {
  const { state, model, books, options } = input;
  const emptyFill: BookFill = { limitPrice: 0, filledShares: 0, cost: 0, averagePrice: null, worstPrice: null, complete: false };
  const emptySide = (side: "home" | "away"): LateScoreSideEvaluation => ({
    side, fair: 0, bid: null, ask: null, mid: null, limit: 0, edge: null, reason: "state-unusable", fill: emptyFill
  });
  const unusable = (): LateScoreSignalEvaluation => ({
    fire: false, reason: "state-unusable", side: null, pHome: null, remainingSeconds: null, fair: null,
    sides: { home: emptySide("home"), away: emptySide("away") }
  });
  if (![state.period, state.clockSeconds, state.homeScore, state.awayScore].every(Number.isFinite) || state.period < 1 || state.clockSeconds < 0) {
    return unusable();
  }
  const remainingSeconds = state.period <= model.finalPeriod
    ? Math.max(0, (model.finalPeriod - state.period) * model.periodSeconds + state.clockSeconds)
    : Math.max(0, state.clockSeconds);
  const features = lateScoreFeatures(state, model);
  const pHome = features === null ? null : predictHomeProbability(model, features);
  const fair = pHome === null ? null : { home: pHome, away: 1 - pHome };
  const sides = fair === null
    ? { home: emptySide("home"), away: emptySide("away") }
    : {
        home: sideEvaluation("home", fair.home, books.home, options),
        away: sideEvaluation("away", fair.away, books.away, options)
      };
  if (remainingSeconds > options.windowSeconds) {
    return { fire: false, reason: "outside-window", side: null, pHome, remainingSeconds, fair, sides };
  }
  if (fair === null || pHome === null) return unusable();
  const ranked = [sides.home, sides.away].sort((left, right) => right.fair - left.fair || (right.edge ?? -1) - (left.edge ?? -1));
  const best = ranked[0]!;
  if (best.reason === "fire") {
    return { fire: true, reason: "fire", side: best.side, pHome, remainingSeconds, fair, sides };
  }
  return { fire: false, reason: best.reason, side: null, pHome, remainingSeconds, fair, sides };
}
