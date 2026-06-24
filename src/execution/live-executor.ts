import type { TradeDecision, TradeResult } from "../domain/types.js";
import { sportsTakerFeePerShare } from "../domain/fees.js";
import { signPoly1271Order } from "./poly1271-signature.js";

export type LiveOrderType = "FOK" | "FAK";
export type LiveErrorCode =
  | "LIVE_CREDENTIALS_MISSING"
  | "LIVE_NO_TRADE_DECISION"
  | "LIVE_ORDER_REJECTED"
  | "LIVE_ORDER_CONFIRMATION_FAILED"
  | "LIVE_CLIENT_UNAVAILABLE";

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
  notional: number;
  orderType: LiveOrderType;
  tickSize: "0.1" | "0.01" | "0.001" | "0.0001";
  negRisk: boolean;
  estimatedFee: number;
}

export interface LiveClobClient {
  placeLimitBuy(order: LiveOrderRequest): Promise<TradeResult>;
}

export interface LiveOrderConfirmation {
  postResponse: unknown;
  order?: unknown;
  orderError?: unknown;
  trades?: unknown[];
  openOrders?: unknown[];
  cancelResponse?: unknown;
  cancelError?: unknown;
  confirmationErrors?: LiveOrderConfirmationError[];
}

export interface LiveOrderConfirmationError {
  source: string;
  error: unknown;
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
      notional: decision.notional,
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
          amount: order.notional,
          orderType
        };
        const createOptions = { tickSize: order.tickSize, negRisk: order.negRisk };
        const postResponse = config.signatureType === 3
          ? await createAndPostPoly1271MarketOrder(client as unknown as Poly1271PostingClient, config, userMarketOrder, createOptions, orderType)
          : await client.createAndPostMarketOrder(userMarketOrder as never, createOptions, orderType as never);

        assertNoPostError(postResponse);

        const confirmationClient = client as unknown as LiveClobConfirmationClient;
        const orderId = extractLiveOrderId(postResponse);
        const orderLookup = orderId ? await getOrderSoft(confirmationClient, orderId) : {};
        const trades = await getTradesOrThrow(confirmationClient, order.tokenId);
        const openOrders = await getOpenOrdersOrThrow(confirmationClient, order.tokenId);
        const hasOpenOrder = orderId ? hasMatchingOpenOrder(order, orderId, openOrders) : false;
        const cancelAttempt = hasOpenOrder && orderId ? await safeCancelOrder(confirmationClient, orderId) : { type: "none" as const };
        const confirmation: LiveOrderConfirmation = { postResponse, trades, openOrders };
        if (orderLookup.order !== undefined) confirmation.order = orderLookup.order;
        if (orderLookup.error !== undefined) confirmation.orderError = orderLookup.error;
        if (cancelAttempt.type === "response") confirmation.cancelResponse = cancelAttempt.response;
        if (cancelAttempt.type === "error") confirmation.cancelError = cancelAttempt.error;
        return normalizeConfirmedLiveOrderResult(order, confirmation);
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

interface LiveClobConfirmationClient {
  getOrder?: (orderID: string) => Promise<unknown>;
  getTrades?: (params?: { asset_id?: string }, onlyFirstPage?: boolean, nextCursor?: string) => Promise<unknown>;
  getOpenOrders?: (params?: { asset_id?: string }, onlyFirstPage?: boolean, nextCursor?: string) => Promise<unknown>;
  cancelOrder?: (payload: { orderID: string }) => Promise<unknown>;
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
  assertNoPostError(raw);

  const orderId = extractLiveOrderId(raw) ?? "live-order-unknown";
  const rawStatus = isRecord(raw) ? orderStatus(raw) ?? "" : "";
  if (["rejected", "failed", "expired"].includes(rawStatus)) {
    return emptyConfirmedLiveResult(order, orderId, "rejected", raw);
  }
  if (["canceled", "cancelled"].includes(rawStatus)) {
    return emptyConfirmedLiveResult(order, orderId, "canceled", raw);
  }
  return emptyConfirmedLiveResult(order, orderId, "posted", raw);
}

export function normalizeConfirmedLiveOrderResult(order: LiveOrderRequest, confirmation: LiveOrderConfirmation): TradeResult {
  assertNoPostError(confirmation.postResponse);
  assertConfirmationAvailable(confirmation);

  const orderId = extractLiveOrderId(confirmation.postResponse) ?? extractLiveOrderId(confirmation.order) ?? "live-order-unknown";
  const fills = confirmedTradeFills(order, orderId, confirmation.trades);
  const openOrder = hasMatchingOpenOrder(order, orderId, confirmation.openOrders);
  const pendingTrade = hasPendingMatchingTrade(order, orderId, confirmation.trades);
  const canceled = isCancelConfirmed(orderId, confirmation.cancelResponse);

  const shares = fills.reduce((total, fill) => total + fill.shares, 0);
  if (shares > 0) {
    const notional = fills.reduce((total, fill) => total + fill.notional, 0);
    const fee = fills.reduce((total, fill) => total + fill.fee, 0);
    const price = notional / shares;
    return {
      mode: "live",
      status: fillsRequestedSize(shares, order.size) && !openOrder ? "filled" : "partial",
      orderId,
      tokenId: order.tokenId,
      price,
      shares,
      notional,
      fee,
      estimatedPayout: shares,
      estimatedProfit: shares - notional - fee,
      raw: confirmation
    };
  }

  if (openOrder || canceled || pendingTrade) {
    return emptyConfirmedLiveResult(order, orderId, canceled ? "canceled" : "posted", confirmation);
  }

  return emptyConfirmedLiveResult(order, orderId, "rejected", confirmation);
}

function assertNoPostError(raw: unknown): void {
  if (!isRecord(raw)) return;

  const errorMessage = errorFieldMessage(raw.errorMsg) ?? errorFieldMessage(raw.error);
  if (raw.success === false || errorMessage) {
    throw new LiveExecutionError("LIVE_ORDER_REJECTED", errorMessage ?? "Polymarket rejected live order", { raw });
  }
}

function assertConfirmationAvailable(confirmation: LiveOrderConfirmation): asserts confirmation is LiveOrderConfirmation & { trades: unknown[]; openOrders: unknown[] } {
  const blockingErrors = confirmation.confirmationErrors?.filter((error) => error.source !== "getOrder") ?? [];
  if (blockingErrors.length > 0) {
    const sources = blockingErrors.map((error) => error.source).join(", ");
    throw new LiveExecutionError("LIVE_ORDER_CONFIRMATION_FAILED", `Unable to confirm live order result from CLOB state: ${sources}`, { raw: confirmation });
  }

  const missing: string[] = [];
  if (!Array.isArray(confirmation.trades)) missing.push("getTrades");
  if (!Array.isArray(confirmation.openOrders)) missing.push("getOpenOrders");
  if (missing.length > 0) {
    throw new LiveExecutionError("LIVE_ORDER_CONFIRMATION_FAILED", `Unable to confirm live order result from CLOB state: ${missing.join(", ")}`, { raw: confirmation });
  }
}

interface ConfirmedFill {
  shares: number;
  price: number;
  notional: number;
  fee: number;
}

function confirmedTradeFills(order: LiveOrderRequest, orderId: string, trades: unknown[]): ConfirmedFill[] {
  if (!isKnownOrderId(orderId)) return [];

  const fills: ConfirmedFill[] = [];
  for (const trade of trades) {
    const fill = topLevelTradeFill(order, orderId, trade);
    if (fill) {
      fills.push(fill);
      continue;
    }

    if (!isRecord(trade) || !Array.isArray(trade.maker_orders)) continue;
    for (const makerOrder of trade.maker_orders) {
      const makerFill = makerOrderTradeFill(order, orderId, makerOrder, trade);
      if (makerFill) fills.push(makerFill);
    }
  }

  return fills;
}

function hasPendingMatchingTrade(order: LiveOrderRequest, orderId: string, trades: unknown[]): boolean {
  if (!isKnownOrderId(orderId)) return false;

  for (const trade of trades) {
    if (topLevelPendingTrade(order, orderId, trade)) return true;

    if (!isRecord(trade) || !Array.isArray(trade.maker_orders)) continue;
    for (const makerOrder of trade.maker_orders) {
      if (makerOrderPendingTrade(order, orderId, makerOrder, trade)) return true;
    }
  }

  return false;
}

function topLevelTradeFill(order: LiveOrderRequest, orderId: string, trade: unknown): ConfirmedFill | undefined {
  if (!isRecord(trade)) return undefined;
  if (!isFillConfirmingTrade(trade)) return undefined;
  if (!matchesAnyField(trade, ["taker_order_id", "maker_order_id", "order_id"], orderId)) return undefined;
  if (!matchesAnyField(trade, ["asset_id", "assetId"], order.tokenId)) return undefined;

  const shares = numberField(trade, "size");
  const price = numberField(trade, "price");
  return validFill(shares, price);
}

function topLevelPendingTrade(order: LiveOrderRequest, orderId: string, trade: unknown): boolean {
  if (!isRecord(trade)) return false;
  if (!isPendingTradeEvidence(trade)) return false;
  if (!matchesAnyField(trade, ["taker_order_id", "maker_order_id", "order_id"], orderId)) return false;
  return matchesAnyField(trade, ["asset_id", "assetId"], order.tokenId);
}

function makerOrderTradeFill(order: LiveOrderRequest, orderId: string, makerOrder: unknown, parentTrade: Record<string, unknown>): ConfirmedFill | undefined {
  if (!isRecord(makerOrder)) return undefined;
  if (!isFillConfirmingTrade(parentTrade) || hasTradeError(makerOrder) || hasNonConfirmingStatus(makerOrder)) return undefined;
  if (!matchesAnyField(makerOrder, ["order_id", "orderID", "orderId", "id", "maker_order_id"], orderId)) return undefined;
  if (!matchesAnyField(makerOrder, ["asset_id", "assetId"], order.tokenId) && !matchesAnyField(parentTrade, ["asset_id", "assetId"], order.tokenId)) return undefined;

  const shares = numberField(makerOrder, "matched_amount") ?? numberField(makerOrder, "size");
  const price = numberField(makerOrder, "price") ?? numberField(parentTrade, "price");
  return validFill(shares, price);
}

function makerOrderPendingTrade(order: LiveOrderRequest, orderId: string, makerOrder: unknown, parentTrade: Record<string, unknown>): boolean {
  if (!isRecord(makerOrder)) return false;
  if (hasTradeError(parentTrade) || hasTradeError(makerOrder)) return false;
  const makerStatus = tradeStatus(makerOrder);
  const parentStatus = tradeStatus(parentTrade);
  if (!isPendingTradeStatus(makerStatus ?? parentStatus)) return false;
  if (!matchesAnyField(makerOrder, ["order_id", "orderID", "orderId", "id", "maker_order_id"], orderId)) return false;
  return matchesAnyField(makerOrder, ["asset_id", "assetId"], order.tokenId) || matchesAnyField(parentTrade, ["asset_id", "assetId"], order.tokenId);
}

function isFillConfirmingTrade(trade: Record<string, unknown>): boolean {
  if (hasTradeError(trade)) return false;
  return tradeStatus(trade) === "confirmed";
}

function isPendingTradeEvidence(trade: Record<string, unknown>): boolean {
  if (hasTradeError(trade)) return false;
  return isPendingTradeStatus(tradeStatus(trade));
}

function isPendingTradeStatus(status: string | undefined): boolean {
  return status === "matched" || status === "mined" || status === "retrying";
}

function hasNonConfirmingStatus(record: Record<string, unknown>): boolean {
  const status = tradeStatus(record);
  return status !== undefined && status !== "confirmed";
}

function hasTradeError(record: Record<string, unknown>): boolean {
  return errorFieldMessage(record.err_msg) !== undefined || errorFieldMessage(record.errorMsg) !== undefined || errorFieldMessage(record.error) !== undefined;
}

function tradeStatus(record: Record<string, unknown>): string | undefined {
  return normalizedStatus(record, "TRADE_STATUS_");
}

function orderStatus(record: Record<string, unknown>): string | undefined {
  return normalizedStatus(record, "ORDER_STATUS_");
}

function normalizedStatus(record: Record<string, unknown>, prefix: string): string | undefined {
  const value = stringField(record, "status");
  if (!value) return undefined;

  const lower = value.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  const withoutPrefix = lower.startsWith(lowerPrefix) ? lower.slice(lowerPrefix.length) : lower;
  return withoutPrefix.replace(/[\s_-]+/g, "");
}

function validFill(shares: number | undefined, price: number | undefined): ConfirmedFill | undefined {
  if (shares === undefined || price === undefined || shares <= 0 || price <= 0 || price >= 1) return undefined;

  const notional = shares * price;
  return {
    shares,
    price,
    notional,
    fee: shares * sportsTakerFeePerShare(price)
  };
}

function fillsRequestedSize(filledShares: number, requestedShares: number): boolean {
  return filledShares >= requestedShares || Math.abs(filledShares - requestedShares) <= 1e-9;
}

function hasMatchingOpenOrder(order: LiveOrderRequest, orderId: string, openOrders: unknown[]): boolean {
  if (!isKnownOrderId(orderId)) return false;
  return openOrders.some((candidate) => isMatchingOpenOrder(order, orderId, candidate));
}

function isMatchingOpenOrder(order: LiveOrderRequest, orderId: string, candidate: unknown): boolean {
  if (!isRecord(candidate)) return false;
  if (!matchesAnyField(candidate, ["id", "orderID", "orderId"], orderId)) return false;
  if (!matchesAnyField(candidate, ["asset_id", "assetId"], order.tokenId)) return false;

  const status = orderStatus(candidate);
  return !status || ["live", "open", "unmatched"].includes(status);
}

function emptyConfirmedLiveResult(order: LiveOrderRequest, orderId: string, status: "posted" | "rejected" | "canceled", raw: unknown): TradeResult {
  return {
    mode: "live",
    status,
    orderId,
    tokenId: order.tokenId,
    price: order.price,
    shares: 0,
    notional: 0,
    fee: 0,
    estimatedPayout: 0,
    estimatedProfit: 0,
    raw
  };
}

type SoftOrderLookup = { order?: unknown; error?: unknown };

async function getOrderSoft(client: LiveClobConfirmationClient, orderId: string): Promise<SoftOrderLookup> {
  if (!client.getOrder) return { error: new Error("CLOB client does not expose getOrder") };
  try {
    const response = await client.getOrder(orderId);
    assertNoConfirmationResponseError("getOrder", response);
    return { order: response };
  } catch (error) {
    return { error };
  }
}

async function getTradesOrThrow(client: LiveClobConfirmationClient, tokenId: string): Promise<unknown[]> {
  if (!client.getTrades) throwConfirmationFailed("getTrades", new Error("CLOB client does not expose getTrades"));
  try {
    return arrayFromConfirmationResponse("getTrades", await client.getTrades({ asset_id: tokenId }));
  } catch (error) {
    if (error instanceof LiveExecutionError) throw error;
    throwConfirmationFailed("getTrades", error);
  }
}

async function getOpenOrdersOrThrow(client: LiveClobConfirmationClient, tokenId: string): Promise<unknown[]> {
  if (!client.getOpenOrders) throwConfirmationFailed("getOpenOrders", new Error("CLOB client does not expose getOpenOrders"));
  try {
    return arrayFromConfirmationResponse("getOpenOrders", await client.getOpenOrders({ asset_id: tokenId }));
  } catch (error) {
    if (error instanceof LiveExecutionError) throw error;
    throwConfirmationFailed("getOpenOrders", error);
  }
}

type CancelAttempt = { type: "none" } | { type: "response"; response: unknown } | { type: "error"; error: unknown };

async function safeCancelOrder(client: LiveClobConfirmationClient, orderId: string): Promise<CancelAttempt> {
  if (!client.cancelOrder) return { type: "error", error: new Error("CLOB client does not expose cancelOrder") };
  try {
    return { type: "response", response: await client.cancelOrder({ orderID: orderId }) };
  } catch (error) {
    return { type: "error", error };
  }
}

function throwConfirmationFailed(source: string, error: unknown): never {
  throw new LiveExecutionError("LIVE_ORDER_CONFIRMATION_FAILED", `Unable to confirm live order result from CLOB state: ${source}`, {
    raw: { source, error }
  });
}

function arrayFromConfirmationResponse(source: string, response: unknown): unknown[] {
  assertNoConfirmationResponseError(source, response);
  if (Array.isArray(response)) return response;
  if (!isRecord(response)) throwConfirmationFailed(source, new Error("CLOB confirmation response was not an array"));
  const data = response.data ?? response.trades ?? response.orders ?? response.results;
  if (Array.isArray(data)) return data;
  throwConfirmationFailed(source, new Error("CLOB confirmation response did not include an array payload"));
}

function assertNoConfirmationResponseError(source: string, response: unknown): void {
  if (!isRecord(response)) return;
  const errorMessage = errorFieldMessage(response.errorMsg) ?? errorFieldMessage(response.error);
  if (response.success === false || errorMessage) {
    throwConfirmationFailed(source, errorMessage ?? "CLOB confirmation response reported failure");
  }
}

function extractLiveOrderId(value: unknown): string | undefined {
  return stringField(value, "orderID") ?? stringField(value, "orderId") ?? stringField(value, "id");
}

function isKnownOrderId(orderId: string): boolean {
  return orderId !== "live-order-unknown" && orderId.trim().length > 0;
}

function isCancelConfirmed(orderId: string, cancelResponse: unknown): boolean {
  if (!isKnownOrderId(orderId) || !isRecord(cancelResponse)) return false;
  if (cancelResponse.success === false || errorFieldMessage(cancelResponse.errorMsg) || errorFieldMessage(cancelResponse.error)) return false;

  const notCanceled = cancelResponse.not_canceled ?? cancelResponse.notCanceled;
  if (containsOrderId(notCanceled, orderId)) return false;

  const canceled = cancelResponse.canceled ?? cancelResponse.cancelled;
  if (canceled === true || containsOrderId(canceled, orderId)) return true;

  const status = orderStatus(cancelResponse);
  if (status === "canceled" || status === "cancelled") return true;
  return cancelResponse.success === true;
}

function containsOrderId(value: unknown, orderId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => String(item) === orderId);
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, orderId);
}

function matchesAnyField(record: Record<string, unknown>, fields: string[], expected: string): boolean {
  return fields.some((field) => stringField(record, field) === expected);
}

function numberField(value: unknown, field: string): number | undefined {
  if (!isRecord(value)) return undefined;

  const fieldValue = value[field];
  const parsed = typeof fieldValue === "number" ? fieldValue : typeof fieldValue === "string" ? Number(fieldValue.trim()) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(value: unknown, field: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const fieldValue = value[field];
  if (typeof fieldValue === "string") {
    const trimmed = fieldValue.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof fieldValue === "number" && Number.isFinite(fieldValue)) return String(fieldValue);
  if (typeof fieldValue === "bigint") return fieldValue.toString();
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function errorFieldMessage(value: unknown): string | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  if (typeof value === "string") return nonEmptyString(value);
  if (typeof value === "number" && value === 0) return undefined;
  if (isRecord(value)) {
    return nonEmptyString(value.message) ?? nonEmptyString(value.errorMsg) ?? nonEmptyString(value.error) ?? "Polymarket rejected live order";
  }
  return String(value);
}
