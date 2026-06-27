import type { BuyTradeLeg, TradeDecision, TradeResult, TradeResultLeg } from "../domain/types.js";

export class PaperExecutionError extends Error {
  readonly code: "PAPER_NO_TRADE_DECISION";

  constructor(message: string) {
    super(message);
    this.name = "PaperExecutionError";
    this.code = "PAPER_NO_TRADE_DECISION";
  }
}

export class PaperExecutor {
  async execute(decision: TradeDecision): Promise<TradeResult> {
    if (decision.action !== "BUY") {
      throw new PaperExecutionError(`Paper executor cannot execute NO_TRADE decision: ${decision.reason}`);
    }

    const legs = decision.legs?.length ? decision.legs : [decisionToLeg(decision)];
    const results = legs.map((leg) => paperFillLeg(leg));
    const aggregate = aggregatePaperResults(results);
    return {
      mode: "paper",
      status: "filled",
      orderId: results.length === 1 ? results[0]!.orderId : deterministicPaperOrderId(decision.conditionId, decision.tokenId, aggregate.shares, decision.bestAsk),
      tokenId: decision.tokenId,
      price: decision.bestAsk,
      shares: aggregate.shares,
      notional: aggregate.notional,
      fee: aggregate.fee,
      estimatedPayout: aggregate.estimatedPayout,
      estimatedProfit: aggregate.estimatedProfit,
      ...(decision.legs?.length ? { legs: results } : {}),
      raw: {
        marketSlug: decision.marketSlug,
        outcome: decision.outcome,
        line: decision.line
      }
    };
  }
}

function decisionToLeg(decision: Extract<TradeDecision, { action: "BUY" }>): BuyTradeLeg {
  const leg: BuyTradeLeg = {
    eventSlug: decision.eventSlug,
    marketSlug: decision.marketSlug,
    question: decision.question,
    tokenId: decision.tokenId,
    conditionId: decision.conditionId,
    outcome: decision.outcome,
    price: decision.bestAsk,
    availableSize: decision.availableSize,
    shares: decision.shares,
    notional: decision.notional,
    estimatedFee: decision.estimatedFee,
    estimatedNetReturn: decision.estimatedNetReturn
  };
  if (decision.line !== undefined) leg.line = decision.line;
  if (decision.strategy !== undefined) leg.strategy = decision.strategy;
  if (decision.lossRequiresGoals !== undefined) leg.lossRequiresGoals = decision.lossRequiresGoals;
  if (decision.locked !== undefined) leg.locked = decision.locked;
  if (decision.tickSize !== undefined) leg.tickSize = decision.tickSize;
  if (decision.negRisk !== undefined) leg.negRisk = decision.negRisk;
  if (decision.tailWindowSource !== undefined) leg.tailWindowSource = decision.tailWindowSource;
  if (decision.tailWindowDetails !== undefined) leg.tailWindowDetails = decision.tailWindowDetails;
  return leg;
}

function paperFillLeg(leg: BuyTradeLeg): TradeResultLeg {
  return {
    mode: "paper",
    status: "filled",
    orderId: deterministicPaperOrderId(leg.conditionId, leg.tokenId, leg.shares, leg.price),
    tokenId: leg.tokenId,
    price: leg.price,
    shares: leg.shares,
    notional: leg.notional,
    fee: leg.estimatedFee,
    estimatedPayout: leg.shares,
    estimatedProfit: leg.shares - leg.notional - leg.estimatedFee,
    raw: {
      marketSlug: leg.marketSlug,
      outcome: leg.outcome,
      line: leg.line
    }
  };
}

function aggregatePaperResults(results: readonly TradeResultLeg[]): Pick<TradeResult, "shares" | "notional" | "fee" | "estimatedPayout" | "estimatedProfit"> {
  return {
    shares: results.reduce((total, result) => total + result.shares, 0),
    notional: results.reduce((total, result) => total + result.notional, 0),
    fee: results.reduce((total, result) => total + result.fee, 0),
    estimatedPayout: results.reduce((total, result) => total + result.estimatedPayout, 0),
    estimatedProfit: results.reduce((total, result) => total + result.estimatedProfit, 0)
  };
}

function deterministicPaperOrderId(conditionId: string, tokenId: string, shares: number, price: number): string {
  return `paper-${sanitize(conditionId)}-${sanitize(tokenId)}-${shares.toFixed(6)}-${price.toFixed(4)}`;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}
