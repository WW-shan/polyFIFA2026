import { allocateTradeLegs, buildTradeDecision, buildTradeLevels, buyDecisionFromLegs, lockedConditionMatchesScore } from "./domain/decision.js";
import { selectLossRequiresCandidates } from "./domain/loss-requires-strategy.js";
import { classifyTailWindow } from "./domain/time-window.js";
import type { DecisionThresholds, MatchState, OrderbookSnapshot, SelectedStrategyMarket, StrategyMarket, TradeDecision, TradeResult } from "./domain/types.js";
import { LiveExecutor, type LiveExecuteOptions, type LiveExecutorConfig } from "./execution/live-executor.js";
import { PaperExecutor } from "./execution/paper-executor.js";
import { DEFAULT_ENTRY_WINDOW_MINUTES } from "./domain/risk-thresholds.js";

export const DEFAULT_THRESHOLDS: Omit<DecisionThresholds, "maxNotional"> = {
  entryWindowMinutes: DEFAULT_ENTRY_WINDOW_MINUTES,
  maxEntryPrice: 0.999999,
  minimumNetReturn: 0.005,
  minimumNotional: 1
};

export interface FlowInput {
  match: MatchState;
  markets: StrategyMarket[];
  orderbook?: OrderbookSnapshot;
  orderbooks?: OrderbookSnapshot[];
  stake: number;
  thresholds?: Partial<Omit<DecisionThresholds, "maxNotional">>;
  lockedIncidentPreviousMatch?: MatchState;
  suppressLockedIncidentCandidates?: boolean;
}

export interface FlowResult {
  decision: TradeDecision;
  trade?: TradeResult;
}

export function buildThresholds(stake: number, overrides: Partial<Omit<DecisionThresholds, "maxNotional">> = {}): DecisionThresholds {
  if (!Number.isFinite(stake) || stake <= 0) {
    throw new RangeError("stake must be a positive number");
  }

  const definedOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined)
  ) as Partial<Omit<DecisionThresholds, "maxNotional">>;

  return {
    ...DEFAULT_THRESHOLDS,
    ...definedOverrides,
    maxNotional: stake
  };
}

export function runDecisionFlow(input: FlowInput): TradeDecision {
  const thresholds = buildThresholds(input.stake, input.thresholds);
  const tailWindowOptions = {
    entryWindowMinutes: thresholds.entryWindowMinutes
  };
  const tailWindow = classifyTailWindow(input.match, tailWindowOptions);
  const strategyOptions = {
    entryWindowMinutes: thresholds.entryWindowMinutes,
    allowLockedOutsideEntryWindow: true
  };
  const baseCandidates = selectLossRequiresCandidates(input.match, input.markets, strategyOptions);
  const candidates = filterLockedIncidentCandidates(
    baseCandidates,
    input.lockedIncidentPreviousMatch,
    input.suppressLockedIncidentCandidates === true
  );

  if (candidates.length === 0) {
    if (baseCandidates.length > 0 && input.lockedIncidentPreviousMatch) {
      return {
        action: "NO_TRADE",
        reason: "NO_ELIGIBLE_STRATEGY",
        eventSlug: input.match.eventSlug,
        details: `No new locked candidate for score incident ${input.lockedIncidentPreviousMatch.homeGoals}-${input.lockedIncidentPreviousMatch.awayGoals} -> ${input.match.homeGoals}-${input.match.awayGoals}`
      };
    }
    if (!tailWindow.eligible) {
      return {
        action: "NO_TRADE",
        reason: "MATCH_NOT_LATE_ENOUGH",
        eventSlug: input.match.eventSlug,
        details: tailWindow.details
      };
    }
    return { action: "NO_TRADE", reason: "NO_ELIGIBLE_STRATEGY", eventSlug: input.match.eventSlug };
  }

  const orderbooks = input.orderbooks ?? (input.orderbook ? [input.orderbook] : []);
  if (orderbooks.length === 0) {
    return { action: "NO_TRADE", reason: "ORDERBOOK_UNAVAILABLE", eventSlug: input.match.eventSlug, details: "No orderbooks provided" };
  }

  const decisions = candidates.flatMap((candidate) => {
    const orderbook = orderbooks.find((book) => book.tokenId === candidate.tokenId);
    if (!orderbook) return [];
    return [buildTradeDecision(input.match, candidate, orderbook, thresholds)];
  });
  const levels = candidates.flatMap((candidate) => {
    const orderbook = orderbooks.find((book) => book.tokenId === candidate.tokenId);
    if (!orderbook) return [];
    return buildTradeLevels(input.match, candidate, orderbook, thresholds);
  });
  const legs = allocateTradeLegs(levels, thresholds);
  if (legs.length > 0) return buyDecisionFromLegs(legs);

  const buys = decisions
    .filter((decision): decision is Extract<TradeDecision, { action: "BUY" }> => decision.action === "BUY")
    .sort((a, b) => {
      const returnDelta = b.estimatedNetReturn - a.estimatedNetReturn;
      if (returnDelta !== 0) return returnDelta;
      return (b.lossRequiresGoals ?? 0) - (a.lossRequiresGoals ?? 0);
    });

  if (buys[0]) return buys[0];

  const noTrade = decisions.find((decision) => decision.action === "NO_TRADE");
  if (noTrade) return noTrade;

  return {
    action: "NO_TRADE",
    reason: "ORDERBOOK_UNAVAILABLE",
    eventSlug: input.match.eventSlug,
    details: "No orderbook matched any eligible strategy token"
  };
}

function filterLockedIncidentCandidates(
  candidates: readonly SelectedStrategyMarket[],
  previousMatch: MatchState | undefined,
  suppressLocked: boolean
): SelectedStrategyMarket[] {
  if (!previousMatch) return [...candidates];
  if (suppressLocked) return candidates.filter((candidate) => candidate.locked !== true);
  const newLocked = candidates.filter((candidate) =>
    candidate.locked === true && !lockedConditionMatchesScore(previousMatch, candidate)
  );
  if (newLocked.length > 0) return newLocked;
  return candidates.filter((candidate) => candidate.locked !== true);
}

export async function runPaperFlow(input: FlowInput): Promise<FlowResult> {
  const decision = runDecisionFlow(input);
  if (decision.action !== "BUY") {
    return { decision };
  }

  const trade = await new PaperExecutor().execute(decision);
  return { decision, trade };
}

export async function runLiveFlow(input: FlowInput, config?: LiveExecutorConfig, options: LiveExecuteOptions = {}): Promise<FlowResult> {
  const decision = runDecisionFlow(input);
  if (decision.action !== "BUY") {
    return { decision };
  }

  const trade = await new LiveExecutor(config).execute(decision, options);
  return { decision, trade };
}
