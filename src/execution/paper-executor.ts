import type { TradeDecision, TradeResult } from "../domain/types.js";

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

    return {
      mode: "paper",
      status: "filled",
      orderId: deterministicPaperOrderId(decision.conditionId, decision.tokenId, decision.shares, decision.bestAsk),
      tokenId: decision.tokenId,
      price: decision.bestAsk,
      shares: decision.shares,
      notional: decision.notional,
      fee: decision.estimatedFee,
      estimatedPayout: decision.shares,
      estimatedProfit: decision.shares - decision.notional - decision.estimatedFee,
      raw: {
        marketSlug: decision.marketSlug,
        outcome: decision.outcome,
        line: decision.line
      }
    };
  }
}

function deterministicPaperOrderId(conditionId: string, tokenId: string, shares: number, price: number): string {
  return `paper-${sanitize(conditionId)}-${sanitize(tokenId)}-${shares.toFixed(6)}-${price.toFixed(4)}`;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}
