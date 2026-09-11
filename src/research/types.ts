/** Public observations and simulation assumptions deliberately live apart. */
export interface ResearchTrade {
  id: string;
  tokenId: string;
  conditionId: string;
  timestampMs: number;
  price: number;
  size: number;
  side: "BUY" | "SELL";
  transactionHash: string | null;
}

export interface TradeCoverage {
  status: "complete" | "incomplete" | "error";
  reason: string;
  fromMs: number;
  toMs: number;
  pages: number;
  rawRows: number;
  invalidRows: number;
  duplicateRows: number;
  oldestMs: number | null;
  newestMs: number | null;
}

export interface ResearchOutcome {
  tokenId: string;
  name: string;
  payout: number | null;
}

export interface ResearchMarket {
  marketId: string;
  conditionId: string;
  marketSlug: string;
  question: string;
  marketType: string;
  horizon: "match" | "set" | "unknown";
  outcomes: ResearchOutcome[];
  resolutionSource: "gamma-resolved-prices" | "unresolved";
  raw: Record<string, unknown>;
  trades: ResearchTrade[];
  coverage: TradeCoverage | null;
}

export interface ResearchEvent {
  eventId: string;
  eventSlug: string;
  title: string;
  sport: string;
  gameId: string | null;
  startMs: number | null;
  startSource: "gamma.startTime" | "gamma.market.gameStartTime" | null;
  finishMs: number | null;
  finishSource: "gamma.finishedTimestamp" | null;
  raw: Record<string, unknown>;
  markets: ResearchMarket[];
}

export interface ResearchSelection {
  sport: string;
  tagId: string;
  eventSlugs: string[];
  marketTypes: string[];
  maxEvents: number;
  requireFinish: boolean;
  catalogPages: number;
  catalogRows: number;
  skippedNonMatches: number;
  skippedMissingFinish: number;
  catalogTruncated: boolean;
}

export interface ResearchDataset {
  schemaVersion: 1;
  kind: "public-trade-history";
  createdAt: string;
  selection: ResearchSelection;
  events: ResearchEvent[];
  warnings: string[];
}
