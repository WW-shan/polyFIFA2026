export interface BacktestOptions {
  prices?: number[];
  windowsSeconds?: number[];
  shares?: number;
  entryMinPrice?: number;
  maxEntryAgeSeconds?: number;
  entryMode?: "finish-relative" | "price-trigger";
  fillModel?: "sell-through" | "sell-at-or-below";
  queueAheadShares?: number;
  makerFeeBps?: number;
  marketTypes?: string[];
}
export type EffectiveBacktestOptions = Required<BacktestOptions>;

export interface OrderTrial {
  eventId: string; eventSlug: string; eventTitle: string; sport: string;
  marketId: string; conditionId: string; marketType: string; question: string;
  tokenId: string | null; outcome: string | null;
  entryMode: EffectiveBacktestOptions["entryMode"]; fillModel: EffectiveBacktestOptions["fillModel"];
  bidPrice: number; windowSeconds: number; orderShares: number; queueAheadShares: number;
  entryAtMs: number | null; expiryAtMs: number | null; finishAtMs: number | null;
  referenceAtMs: number | null; referencePrice: number | null;
  referenceBasis: "last-second-trades-binary-complement" | "last-second-direct-trades" | null;
  referenceAgeSeconds: number | null;
  exclusions: string[];
  touchTradeCount: number; touchShares: number; sellThroughShares: number; equalSellShares: number;
  minimumTradePrice: number | null; firstTouchAtMs: number | null; firstSimulatedFillAtMs: number | null;
  simulatedFilledShares: number; simulatedCost: number; simulatedFee: number;
  payoutPerShare: number | null; simulatedPnl: number | null;
}

export interface ParameterSummary {
  sport: string; marketType: string; entryMode: OrderTrial["entryMode"]; fillModel: OrderTrial["fillModel"];
  bidPrice: number; windowSeconds: number; orderShares: number; queueAheadShares: number;
  trials: number; events: number; eligibleTrials: number; excludedTrials: number;
  touchedTrials: number; filledTrials: number; unfilledTrials: number;
  winningFills: number; losingFills: number; splitPayoutFills: number;
  simulatedFilledShares: number; simulatedCost: number; simulatedFees: number; simulatedPnl: number;
  returnOnFilledCapital: number | null; pnlPerEligibleTrial: number | null;
  exclusions: Record<string, number>;
}

export interface BacktestResult {
  schemaVersion: 1;
  basis: "historical-public-trade-screen";
  options: EffectiveBacktestOptions;
  warnings: string[];
  trials: OrderTrial[];
  summaries: ParameterSummary[];
}
