import type { TradeDecision, TradeResult } from "../domain/types.js";
import { signPoly1271Order } from "./poly1271-signature.js";

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
  depositWalletAddress?: string;
  rpcUrl?: string;
  syncBalanceAllowance?: boolean;
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
  Pick<LiveExecutorConfig, "funderAddress" | "depositWalletAddress" | "rpcUrl" | "syncBalanceAllowance">;

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
  const depositWalletAddress = env.POLY_DEPOSIT_WALLET_ADDRESS ?? env.DEPOSIT_WALLET_ADDRESS;
  const config: LiveExecutorConfig = {
    host: env.POLY_CLOB_HOST ?? "https://clob.polymarket.com",
    chainId: Number(env.POLY_CHAIN_ID ?? 137),
    signatureType: depositWalletAddress ? 3 : Number(env.POLY_SIGNATURE_TYPE ?? 1)
  };

  if (env.POLY_PRIVATE_KEY) config.privateKey = env.POLY_PRIVATE_KEY;
  const apiKey = env.POLY_API_KEY ?? env.CLOB_API_KEY;
  const apiSecret = env.POLY_API_SECRET ?? env.CLOB_SECRET;
  const passphrase = env.POLY_PASSPHRASE ?? env.CLOB_PASS_PHRASE;
  if (apiKey) config.apiKey = apiKey;
  if (apiSecret) config.apiSecret = apiSecret;
  if (passphrase) config.passphrase = passphrase;
  if (env.POLY_RPC_URL) config.rpcUrl = env.POLY_RPC_URL;
  if (env.POLY_SYNC_BALANCE_ALLOWANCE) config.syncBalanceAllowance = parseBooleanEnv(env.POLY_SYNC_BALANCE_ALLOWANCE);
  if (depositWalletAddress) {
    config.depositWalletAddress = depositWalletAddress;
    config.funderAddress = depositWalletAddress;
  } else if (env.POLY_FUNDER_ADDRESS) {
    config.funderAddress = env.POLY_FUNDER_ADDRESS;
  }

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
  if (config.depositWalletAddress) required.depositWalletAddress = config.depositWalletAddress;
  if (config.rpcUrl) required.rpcUrl = config.rpcUrl;
  if (config.syncBalanceAllowance !== undefined) required.syncBalanceAllowance = config.syncBalanceAllowance;
  return required;
}

async function defaultLiveClientFactory(config: RequiredLiveExecutorConfig): Promise<LiveClobClient> {
  try {
    const clob = await import("@polymarket/clob-client-v2");
    const viem = await import("viem");
    const accounts = await import("viem/accounts");
    const chains = await import("viem/chains");
    const account = accounts.privateKeyToAccount(config.privateKey as `0x${string}`);
    const chain = config.chainId === 80002 ? chains.polygonAmoy : chains.polygon;
    const signer = viem.createWalletClient({
      account,
      chain,
      transport: viem.http(config.rpcUrl)
    });
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
        if (config.syncBalanceAllowance) {
          await client.updateBalanceAllowance({ asset_type: clob.AssetType.COLLATERAL });
        }

        const orderType = clob.OrderType[order.orderType] as unknown;
        const userMarketOrder = {
          tokenID: order.tokenId,
          price: order.price,
          side: clob.Side.BUY,
          amount: order.price * order.size,
          orderType
        };
        const createOptions = { tickSize: order.tickSize, negRisk: order.negRisk };
        const raw = config.signatureType === 3
          ? await createAndPostPoly1271MarketOrder(client as unknown as Poly1271PostingClient, config, userMarketOrder, createOptions, orderType)
          : await client.createAndPostMarketOrder(userMarketOrder as never, createOptions, orderType as never);

        return normalizeLiveOrderResult(order, raw);
      }
    };
  } catch (error) {
    if (error instanceof LiveExecutionError) throw error;
    throw new LiveExecutionError("LIVE_CLIENT_UNAVAILABLE", `Unable to initialize Polymarket CLOB client: ${String(error)}`, { raw: error });
  }
}

interface Poly1271PostingClient {
  createMarketOrder: (userMarketOrder: any, options: any) => Promise<Record<string, unknown>>;
  postOrder: (signedOrder: Record<string, unknown>, orderType: any) => Promise<unknown>;
}

async function createAndPostPoly1271MarketOrder(
  client: Poly1271PostingClient,
  config: RequiredLiveExecutorConfig,
  userMarketOrder: unknown,
  createOptions: { negRisk: boolean },
  orderType: unknown
): Promise<unknown> {
  const signedOrder = await client.createMarketOrder(userMarketOrder, createOptions);
  signedOrder.signature = await signPoly1271Order({
    privateKey: config.privateKey,
    chainId: config.chainId,
    exchangeAddress: exchangeV2Address(createOptions.negRisk),
    order: {
      salt: field(signedOrder, "salt"),
      maker: stringRequired(signedOrder, "maker"),
      signer: stringRequired(signedOrder, "signer"),
      tokenId: field(signedOrder, "tokenId"),
      makerAmount: field(signedOrder, "makerAmount"),
      takerAmount: field(signedOrder, "takerAmount"),
      side: sideField(signedOrder.side),
      signatureType: field(signedOrder, "signatureType"),
      timestamp: field(signedOrder, "timestamp"),
      metadata: stringField(signedOrder, "metadata"),
      builder: stringField(signedOrder, "builder")
    }
  });
  return client.postOrder(signedOrder, orderType);
}

function exchangeV2Address(negRisk: boolean): string {
  return negRisk ? "0xe2222d279d744050d28e00520010520000310F59" : "0xE111180000d2663C0091e4f400237545B87B996B";
}

function field(record: Record<string, unknown>, key: string): string | number | bigint {
  const value = record[key];
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  throw new Error(`POLY_1271_ORDER_FIELD_MISSING: ${key}`);
}

function stringRequired(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key);
  if (value) return value;
  throw new Error(`POLY_1271_ORDER_FIELD_MISSING: ${key}`);
}

function sideField(value: unknown): "BUY" | "SELL" | 0 | 1 {
  if (value === "BUY" || value === "SELL" || value === 0 || value === 1) return value;
  throw new Error("POLY_1271_ORDER_FIELD_MISSING: side");
}

function parseBooleanEnv(value: string): boolean {
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

export function normalizeLiveOrderResult(order: LiveOrderRequest, raw: unknown): TradeResult {
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const errorMessage = nonEmptyString(record.errorMsg) ?? nonEmptyString(record.error);
    if (record.success === false || errorMessage) {
      throw new LiveExecutionError("LIVE_ORDER_REJECTED", errorMessage ?? "Polymarket rejected live order", { raw });
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
