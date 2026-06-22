export type MatchPeriod = "1H" | "2H" | "ET" | "FT" | "UNKNOWN";

export interface MatchState {
  eventSlug: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  minute: number;
  period: MatchPeriod;
  isLive: boolean;
}

export interface SpreadMarket {
  eventSlug: string;
  marketSlug: string;
  question: string;
  conditionId: string;
  clobTokenIds: [string, string] | string[];
  outcomes: [string, string] | string[];
  line: number;
  tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
  negRisk?: boolean;
}

export interface SelectedSpread extends SpreadMarket {
  outcome: string;
  tokenId: string;
  outcomeIndex: number;
  margin: number;
}

export type NoTradeReason =
  | "NOT_WORLD_CUP"
  | "MATCH_NOT_LATE_ENOUGH"
  | "LEAD_TOO_SMALL"
  | "NO_COVERED_SPREAD"
  | "PRICE_TOO_HIGH"
  | "RETURN_TOO_LOW"
  | "DEPTH_TOO_SMALL"
  | "MARKET_NOT_FOUND"
  | "ORDERBOOK_UNAVAILABLE";

export type SpreadSelection =
  | { action: "SELECTED"; market: SelectedSpread }
  | { action: "NO_TRADE"; reason: NoTradeReason; details?: string };

export interface PriceLevel {
  price: number;
  size: number;
}

export interface OrderbookSnapshot {
  tokenId: string;
  market?: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
  tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
  negRisk?: boolean;
  hash?: string;
  timestamp?: string;
}

export interface DecisionThresholds {
  watchStartMinute: number;
  maxEntryPrice: number;
  minimumNetReturn: number;
  minimumNotional: number;
  maxNotional: number;
}

export interface BuyTradeDecision {
  action: "BUY";
  eventSlug: string;
  marketSlug: string;
  question: string;
  tokenId: string;
  conditionId: string;
  outcome: string;
  line: number;
  bestAsk: number;
  availableSize: number;
  shares: number;
  notional: number;
  estimatedFee: number;
  estimatedNetReturn: number;
  tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
  negRisk?: boolean;
}

export interface NoTradeDecision {
  action: "NO_TRADE";
  reason: NoTradeReason;
  eventSlug?: string;
  details?: string;
}

export type TradeDecision = BuyTradeDecision | NoTradeDecision;

export interface TradeResult {
  mode: "paper" | "live";
  status: "filled" | "posted" | "rejected";
  orderId: string;
  tokenId: string;
  price: number;
  shares: number;
  notional: number;
  fee: number;
  estimatedPayout: number;
  estimatedProfit: number;
  raw?: unknown;
}
