export type MatchPeriod = "NS" | "1H" | "HT" | "2H" | "ET" | "FT" | "UNKNOWN";

export type TailWindowSource =
  | "remaining_seconds"
  | "not_enough_time_data"
  | "not_live_second_half";

export type RemainingSecondsSource = "365scores_added_time_precise_game_time";

export interface MatchState {
  eventSlug: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  minute: number;
  period: MatchPeriod;
  isLive: boolean;
  ended?: boolean;
  elapsed?: string;
  elapsedSeconds?: number;
  remainingSeconds?: number;
  remainingSecondsSource?: RemainingSecondsSource;
  gameId?: number;
  sportradarGameId?: string;
  startTime?: string;
  scores365GameId?: number;
  tailWindowSource?: TailWindowSource;
  tailWindowDetails?: string;
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

export type StrategyMarketType = "moneyline" | "draw" | "spread" | "total" | "team_total" | "btts" | "unknown";

export interface StrategyMarket {
  eventSlug: string;
  marketSlug: string;
  question: string;
  conditionId: string;
  clobTokenIds: [string, string] | string[];
  outcomes: [string, string] | string[];
  line?: number;
  marketType?: StrategyMarketType;
  team?: string;
  tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
  negRisk?: boolean;
}

export type TailStrategy =
  | "loser_no"
  | "leader_yes_lead_ge2"
  | "draw_no_lead_ge2"
  | "spread_tight_loss_ge2"
  | "total_under_loss_ge2"
  | "team_total_under_loss_ge2"
  | "total_over_locked"
  | "team_total_over_locked"
  | "btts_yes_locked";

export interface SelectedSpread extends SpreadMarket {
  outcome: string;
  tokenId: string;
  outcomeIndex: number;
  margin: number;
}

export interface SelectedStrategyMarket extends StrategyMarket {
  strategy: TailStrategy;
  outcome: string;
  tokenId: string;
  outcomeIndex: number;
  lossRequiresGoals: number;
  spreadSide?: "favorite_cover" | "other_side";
  locked?: boolean;
}

export type NoTradeReason =
  | "NOT_WORLD_CUP"
  | "MATCH_NOT_LATE_ENOUGH"
  | "LEAD_TOO_SMALL"
  | "NO_COVERED_SPREAD"
  | "NO_ELIGIBLE_STRATEGY"
  | "PRICE_TOO_HIGH"
  | "RETURN_TOO_LOW"
  | "DEPTH_TOO_SMALL"
  | "MARKET_NOT_FOUND"
  | "ORDERBOOK_UNAVAILABLE"
  | "INSUFFICIENT_BALANCE"
  | "DUPLICATE_TRADE";

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
  entryWindowMinutes: number;
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
  line?: number;
  strategy?: TailStrategy;
  lossRequiresGoals?: number;
  locked?: boolean;
  bestAsk: number;
  availableSize: number;
  shares: number;
  notional: number;
  estimatedFee: number;
  estimatedNetReturn: number;
  tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
  negRisk?: boolean;
  tailWindowSource?: TailWindowSource;
  tailWindowDetails?: string;
  legs?: BuyTradeLeg[];
}

export interface NoTradeDecision {
  action: "NO_TRADE";
  reason: NoTradeReason;
  eventSlug?: string;
  details?: string;
}

export type TradeDecision = BuyTradeDecision | NoTradeDecision;

export interface BuyTradeLeg {
  eventSlug: string;
  marketSlug: string;
  question: string;
  tokenId: string;
  conditionId: string;
  outcome: string;
  line?: number;
  strategy?: TailStrategy;
  lossRequiresGoals?: number;
  locked?: boolean;
  price: number;
  availableSize: number;
  shares: number;
  notional: number;
  estimatedFee: number;
  estimatedNetReturn: number;
  tickSize?: "0.1" | "0.01" | "0.001" | "0.0001";
  negRisk?: boolean;
  tailWindowSource?: TailWindowSource;
  tailWindowDetails?: string;
}

export interface TradeResult {
  mode: "paper" | "live";
  status: "filled" | "partial" | "posted" | "rejected" | "canceled";
  orderId: string;
  tokenId: string;
  price: number;
  shares: number;
  notional: number;
  fee: number;
  estimatedPayout: number;
  estimatedProfit: number;
  legs?: TradeResultLeg[];
  raw?: unknown;
}

export interface TradeResultLeg {
  mode: "paper" | "live";
  status: TradeResult["status"];
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
