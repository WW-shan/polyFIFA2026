export type CollectorSource = "collector" | "gamma" | "clob" | "sports";

export interface RecordInput {
  source: CollectorSource;
  kind: string;
  connectionId?: string;
  data: unknown;
}

export interface JournalRecord extends RecordInput {
  schemaVersion: 1;
  runId: string;
  sequence: number;
  receivedAt: string;
  receivedAtMs: number;
  monotonicNs: string;
}

export interface RecordSink {
  record(input: RecordInput): void;
}

export interface CollectorMarket {
  marketId: string;
  conditionId: string;
  marketSlug: string;
  question: string;
  outcomes: string[];
  tokenIds: string[];
  closed: boolean;
  collectable: boolean;
  raw: Record<string, unknown>;
}

export interface CollectorEvent {
  eventId: string;
  eventSlug: string;
  title: string;
  tags: string[];
  sport: string | null;
  gameId: string | null;
  parentEventId: string | null;
  markets: CollectorMarket[];
  raw: Record<string, unknown>;
}

export interface JsonRequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type JsonRequester = (url: string, options?: JsonRequestOptions) => Promise<unknown>;
