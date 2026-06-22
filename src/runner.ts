import { buildTradeDecision } from "./domain/decision.js";
import { selectCoveredSpread } from "./domain/spread-selector.js";
import type { DecisionThresholds, MatchState, OrderbookSnapshot, SpreadMarket, TradeDecision, TradeResult } from "./domain/types.js";
import { LiveExecutor, type LiveExecuteOptions, type LiveExecutorConfig } from "./execution/live-executor.js";
import { PaperExecutor } from "./execution/paper-executor.js";

export const DEFAULT_THRESHOLDS: Omit<DecisionThresholds, "maxNotional"> = {
  watchStartMinute: 82,
  maxEntryPrice: 0.98,
  minimumNetReturn: 0.019,
  minimumNotional: 5
};

export interface FlowInput {
  match: MatchState;
  markets: SpreadMarket[];
  orderbook: OrderbookSnapshot;
  stake: number;
  thresholds?: Partial<Omit<DecisionThresholds, "maxNotional">>;
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
  const selection = selectCoveredSpread(input.match, input.markets, { watchStartMinute: thresholds.watchStartMinute });

  if (selection.action === "NO_TRADE") {
    const decision: TradeDecision = { action: "NO_TRADE", reason: selection.reason, eventSlug: input.match.eventSlug };
    if (selection.details) decision.details = selection.details;
    return decision;
  }

  return buildTradeDecision(input.match, selection.market, input.orderbook, thresholds);
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
