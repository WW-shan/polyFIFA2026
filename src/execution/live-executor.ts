import type { TradeDecision, TradeResult } from "../domain/types.js";

export type LiveOrderType = "FOK" | "FAK";
export type LiveErrorCode = "LIVE_CREDENTIALS_MISSING" | "LIVE_NO_TRADE_DECISION" | "LIVE_ORDER_REJECTED" | "LIVE_CLIENT_UNAVAILABLE";

export interface LiveExecutorConfig {
  host: string;
  chainId: number;
  signatureType: number;
  privateKey?: string;
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  funderAddress?: string;
}

export interface LiveExecuteOptions {
  orderType?: LiveOrderType;
}

export interface LiveOrderRequest {
  tokenId: string;
  price: number;
  size: number;
  orderType: LiveOrderType;
  tickSize: "0.1" | "0.01" | "0.001" | "0.0001";
  negRisk: boolean;
  estimatedFee: number;
}

export interface LiveClobClient {
  placeLimitBuy(order: LiveOrderRequest): Promise<TradeResult>;
}

export type LiveClientFactory = (config: RequiredLiveExecutorConfig) => Promise<LiveClobClient>;

type RequiredLiveExecutorConfig = Required<Pick<LiveExecutorConfig, "host" | "chainId" | "signatureType" | "privateKey" | "apiKey" | "apiSecret" | "passphrase">> &
  Pick<LiveExecutorConfig, "funderAddress">;

export class LiveExecutionError extends Error {
  readonly code: LiveErrorCode;
  readonly missing?: string[];
  readonly raw?: unknown;

  constructor(code: LiveErrorCode, message: string, options: { missing?: string[]; raw?: unknown } = {}) {
    super(message);
    this.name = "LiveExecutionError";
    this.code = code;
    if (options.missing) this.missing = options.missing;
    if (options.raw !== undefined) this.raw = options.raw;
  }
}

export class LiveExecutor {
  constructor(
    private readonly config: LiveExecutorConfig = liveConfigFromEnv(process.env),
    private readonly clientFactory: LiveClientFactory = defaultLiveClientFactory
  ) {}

  async execute(decision: TradeDecision, options: LiveExecuteOptions = {}): Promise<TradeResult> {
    if (decision.action !== "BUY") {
      throw new LiveExecutionError("LIVE_NO_TRADE_DECISION", `Live executor cannot execute NO_TRADE decision: ${decision.reason}`);
    }

    const config = requireLiveConfig(this.config);
    const client = await this.clientFactory(config);
    return client.placeLimitBuy({
      tokenId: decision.tokenId,
      price: decision.bestAsk,
      size: decision.shares,
      orderType: options.orderType ?? "FOK",
      tickSize: decision.tickSize ?? "0.001",
      negRisk: decision.negRisk ?? false,
      estimatedFee: decision.estimatedFee
    });
  }
}

export function liveConfigFromEnv(env: Record<string, string | undefined>): LiveExecutorConfig {
  const config: LiveExecutorConfig = {
    host: env.POLY_CLOB_HOST ?? "https://clob.polymarket.com",
    chainId: Number(env.POLY_CHAIN_ID ?? 137),
    signatureType: Number(env.POLY_SIGNATURE_TYPE ?? 1)
  };

  if (env.POLY_PRIVATE_KEY) config.privateKey = env.POLY_PRIVATE_KEY;
  if (env.POLY_API_KEY) config.apiKey = env.POLY_API_KEY;
  if (env.POLY_API_SECRET) config.apiSecret = env.POLY_API_SECRET;
  if (env.POLY_PASSPHRASE) config.passphrase = env.POLY_PASSPHRASE;
  if (env.POLY_FUNDER_ADDRESS) config.funderAddress = env.POLY_FUNDER_ADDRESS;

  return config;
}

function requireLiveConfig(config: LiveExecutorConfig): RequiredLiveExecutorConfig {
  const privateKey = config.privateKey;
  const apiKey = config.apiKey;
  const apiSecret = config.apiSecret;
  const passphrase = config.passphrase;
  const missing: string[] = [];
  if (!privateKey) missing.push("POLY_PRIVATE_KEY");
  if (!apiKey) missing.push("POLY_API_KEY");
  if (!apiSecret) missing.push("POLY_API_SECRET");
  if (!passphrase) missing.push("POLY_PASSPHRASE");

  if (missing.length > 0 || !privateKey || !apiKey || !apiSecret || !passphrase) {
    throw new LiveExecutionError("LIVE_CREDENTIALS_MISSING", `Missing live Polymarket credentials: ${missing.join(", ")}`, { missing });
  }

  const required: RequiredLiveExecutorConfig = {
    host: config.host,
    chainId: config.chainId,
    signatureType: config.signatureType,
    privateKey,
    apiKey,
    apiSecret,
    passphrase
  };
  if (config.funderAddress) required.funderAddress = config.funderAddress;
  return required;
}

async function defaultLiveClientFactory(config: RequiredLiveExecutorConfig): Promise<LiveClobClient> {
  try {
    const clob = await import("@polymarket/clob-client-v2");
    const walletModule = await import("@ethersproject/wallet");
    const signer = new walletModule.Wallet(config.privateKey);
    const creds = {
      key: config.apiKey,
      secret: config.apiSecret,
      passphrase: config.passphrase
    };
    const clientOptions = {
      host: config.host,
      chain: config.chainId as typeof clob.Chain.POLYGON,
      signer,
      creds,
      signatureType: config.signatureType as typeof clob.SignatureTypeV2.POLY_PROXY,
      retryOnError: true
    };
    const client = new clob.ClobClient(config.funderAddress ? { ...clientOptions, funderAddress: config.funderAddress } : clientOptions);

    return {
      async placeLimitBuy(order: LiveOrderRequest): Promise<TradeResult> {
        const raw = await client.createAndPostMarketOrder(
          {
            tokenID: order.tokenId,
            price: order.price,
            side: clob.Side.BUY,
            amount: order.price * order.size,
            orderType: clob.OrderType[order.orderType]
          },
          { tickSize: order.tickSize, negRisk: order.negRisk },
          clob.OrderType[order.orderType]
        );

        return normalizeLiveOrderResult(order, raw);
      }
    };
  } catch (error) {
    if (error instanceof LiveExecutionError) throw error;
    throw new LiveExecutionError("LIVE_CLIENT_UNAVAILABLE", `Unable to initialize Polymarket CLOB client: ${String(error)}`, { raw: error });
  }
}

export function normalizeLiveOrderResult(order: LiveOrderRequest, raw: unknown): TradeResult {
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    if (record.success === false || typeof record.error === "string" || typeof record.errorMsg === "string") {
      throw new LiveExecutionError("LIVE_ORDER_REJECTED", String(record.errorMsg ?? record.error ?? "Polymarket rejected live order"), { raw });
    }
  }

  const orderId = stringField(raw, "orderID") ?? stringField(raw, "orderId") ?? stringField(raw, "id") ?? "live-order-unknown";
  const rawStatus = stringField(raw, "status")?.toLowerCase() ?? "";
  const status = rawStatus === "matched" || rawStatus === "filled" ? "filled" : "posted";
  const notional = order.price * order.size;
  return {
    mode: "live",
    status,
    orderId,
    tokenId: order.tokenId,
    price: order.price,
    shares: order.size,
    notional,
    fee: order.estimatedFee,
    estimatedPayout: order.size,
    estimatedProfit: order.size - notional - order.estimatedFee,
    raw
  };
}

function stringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "string" ? fieldValue : undefined;
}
