import crypto from "node:crypto";
import { createPublicClient, encodeFunctionData, http, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import { POLYMARKET_PUSD_ADDRESS, DEFAULT_POLYGON_RPC_URL } from "./balance.js";
import { fetchJson, postJson, type HttpOptions } from "../polymarket/http.js";

export const POLYMARKET_CONDITIONAL_TOKENS_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
export const POLYMARKET_CTF_COLLATERAL_ADAPTER = "0xAdA100Db00Ca00073811820692005400218FcE1f";
export const POLYMARKET_NEG_RISK_CTF_COLLATERAL_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
export const POLYMARKET_DEPOSIT_WALLET_FACTORY = "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
export const DEFAULT_POLYMARKET_RELAYER_URL = "https://relayer-v2.polymarket.com";
export const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

const BINARY_INDEX_SETS = [1n, 2n] as const;
const DEPOSIT_WALLET_DOMAIN_NAME = "DepositWallet";
const DEPOSIT_WALLET_DOMAIN_VERSION = "1";
const DEFAULT_REDEEM_LIMIT = 100;
const DEFAULT_MAX_REDEEM_PAGES = 10;

const ctfApprovalAbi = parseAbi([
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)"
]);

const adapterRedeemAbi = parseAbi([
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)"
]);

const depositWalletTypes = {
  Call: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" }
  ],
  Batch: [
    { name: "wallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "calls", type: "Call[]" }
  ]
} as const;

export interface RedeemablePosition {
  conditionId: string;
  size: number;
  negativeRisk: boolean;
  marketSlug?: string;
  eventSlug?: string;
}

export interface DepositWalletCall {
  target: string;
  value: string;
  data: string;
}

export interface SettlementConfig {
  enabled: boolean;
  walletAddress?: string;
  ownerAddress?: string;
  privateKey?: string;
  relayerUrl: string;
  chainId: number;
  rpcUrl: string;
  intervalMs: number;
  deadlineSeconds: number;
  sizeThreshold: number;
  proxyUrl?: string;
  relayerApiKey?: string;
  relayerApiKeyAddress?: string;
  builderApiKey?: string;
  builderApiSecret?: string;
  builderPassphrase?: string;
}

export type SettlementStatus = "disabled" | "unconfigured" | "no_positions" | "no_calls" | "submitted";

export interface SettlementResult {
  status: SettlementStatus;
  positions: number;
  conditions: number;
  calls: number;
  transactionID?: string;
  transactionHash?: string;
  state?: string;
}

export interface SubmitDepositWalletBatchInput {
  walletAddress: string;
  ownerAddress?: string;
  privateKey: string;
  calls: DepositWalletCall[];
  relayerUrl: string;
  chainId: number;
  deadlineSeconds: number;
  proxyUrl?: string;
  relayerApiKey?: string;
  relayerApiKeyAddress?: string;
  builderApiKey?: string;
  builderApiSecret?: string;
  builderPassphrase?: string;
}

export interface SettlementDependencies {
  fetchRedeemablePositions?: (walletAddress: string, config: SettlementConfig) => Promise<RedeemablePosition[]>;
  isApprovedForAll?: (owner: string, operator: string) => Promise<boolean>;
  submitDepositWalletBatch?: (input: SubmitDepositWalletBatchInput) => Promise<unknown>;
  markRedeemedConditionIds?: (conditionIds: readonly string[]) => Promise<void>;
}

export interface SettlementMonitorDependencies extends SettlementDependencies {
  settle?: (config: SettlementConfig, deps: SettlementDependencies) => Promise<SettlementResult>;
  onError?: (error: unknown) => void;
}

export function normalizeRedeemablePositions(raw: unknown): RedeemablePosition[] {
  const records = rawPositionArray(raw);
  const positions: RedeemablePosition[] = [];

  for (const record of records) {
    if (!isRecord(record)) continue;
    if (!booleanValue(record.redeemable)) continue;
    const conditionId = stringValue(record.conditionId ?? record.condition_id);
    if (!isBytes32(conditionId)) continue;
    const size = numberValue(record.size ?? record.positionSize ?? record.shares);
    if (size === undefined || size <= 0) continue;

    const position: RedeemablePosition = {
      conditionId,
      size,
      negativeRisk: booleanValue(record.negativeRisk ?? record.negRisk ?? record.neg_risk) === true
    };
    const marketSlug = stringValue(record.marketSlug ?? record.slug ?? record.market);
    if (marketSlug) position.marketSlug = marketSlug;
    const eventSlug = stringValue(record.eventSlug ?? record.event_slug);
    if (eventSlug) position.eventSlug = eventSlug;
    positions.push(position);
  }

  return positions;
}

export async function fetchRedeemablePositions(
  walletAddress: string,
  config: SettlementConfig,
  options: HttpOptions = {}
): Promise<RedeemablePosition[]> {
  const limit = DEFAULT_REDEEM_LIMIT;
  const maxPages = DEFAULT_MAX_REDEEM_PAGES;
  const positions: RedeemablePosition[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * limit;
    const params = new URLSearchParams({
      user: walletAddress,
      redeemable: "true",
      sizeThreshold: String(config.sizeThreshold),
      limit: String(limit),
      offset: String(offset),
      sortBy: "CURRENT",
      sortDirection: "DESC"
    });
    const httpOptions: HttpOptions = { ...options };
    const proxyUrl = config.proxyUrl ?? options.proxyUrl;
    if (proxyUrl) httpOptions.proxyUrl = proxyUrl;
    const raw = await fetchJson<unknown>(`https://data-api.polymarket.com/positions?${params.toString()}`, httpOptions);
    const records = rawPositionArray(raw);
    positions.push(...normalizeRedeemablePositions(records));
    if (records.length < limit) break;
  }
  return positions;
}

export async function buildRedeemSettlementCalls(
  positions: readonly RedeemablePosition[],
  options: {
    walletAddress: string;
    isApprovedForAll?: (owner: string, operator: string) => Promise<boolean>;
  }
): Promise<DepositWalletCall[]> {
  const groups = conditionGroups(positions);
  const calls: DepositWalletCall[] = [];
  const approvedAdapters = new Set<string>();

  for (const group of groups) {
    const adapter = adapterForNegativeRisk(group.negativeRisk);
    const adapterKey = adapter.toLowerCase();
    if (!approvedAdapters.has(adapterKey)) {
      const shouldApprove = await needsAdapterApproval(options.walletAddress, adapter, options.isApprovedForAll);
      if (shouldApprove) calls.push(setApprovalForAllCall(adapter));
      approvedAdapters.add(adapterKey);
    }
    calls.push(redeemPositionsCall(adapter, group.conditionId));
  }

  return calls;
}

export async function settleRedeemablePositions(
  config: SettlementConfig,
  deps: SettlementDependencies = {}
): Promise<SettlementResult> {
  if (!config.enabled) return { status: "disabled", positions: 0, conditions: 0, calls: 0 };
  if (!config.walletAddress) return { status: "unconfigured", positions: 0, conditions: 0, calls: 0 };
  if (!config.privateKey && !deps.submitDepositWalletBatch) return { status: "unconfigured", positions: 0, conditions: 0, calls: 0 };

  const fetchPositions = deps.fetchRedeemablePositions ?? fetchRedeemablePositions;
  const positions = await fetchPositions(config.walletAddress, config);
  const groups = conditionGroups(positions);
  if (positions.length === 0 || groups.length === 0) {
    return { status: "no_positions", positions: positions.length, conditions: groups.length, calls: 0 };
  }

  const isApprovedForAll = deps.isApprovedForAll ?? defaultApprovalReader(config);
  const calls = await buildRedeemSettlementCalls(positions, {
    walletAddress: config.walletAddress,
    isApprovedForAll
  });
  if (calls.length === 0) return { status: "no_calls", positions: positions.length, conditions: groups.length, calls: 0 };

  const submit = deps.submitDepositWalletBatch ?? submitDepositWalletBatch;
  const submitInput: SubmitDepositWalletBatchInput = {
    walletAddress: config.walletAddress,
    privateKey: config.privateKey ?? "0x",
    calls,
    relayerUrl: config.relayerUrl,
    chainId: config.chainId,
    deadlineSeconds: config.deadlineSeconds
  };
  if (config.ownerAddress) submitInput.ownerAddress = config.ownerAddress;
  if (config.proxyUrl) submitInput.proxyUrl = config.proxyUrl;
  if (config.relayerApiKey) submitInput.relayerApiKey = config.relayerApiKey;
  if (config.relayerApiKeyAddress) submitInput.relayerApiKeyAddress = config.relayerApiKeyAddress;
  if (config.builderApiKey) submitInput.builderApiKey = config.builderApiKey;
  if (config.builderApiSecret) submitInput.builderApiSecret = config.builderApiSecret;
  if (config.builderPassphrase) submitInput.builderPassphrase = config.builderPassphrase;
  const response = await submit(submitInput);
  await deps.markRedeemedConditionIds?.(groups.map((group) => group.conditionId));

  const result: SettlementResult = {
    status: "submitted",
    positions: positions.length,
    conditions: groups.length,
    calls: calls.length
  };
  const transactionID = stringValue(field(response, "transactionID") ?? field(response, "transactionId") ?? field(response, "id"));
  if (transactionID) result.transactionID = transactionID;
  const transactionHash = stringValue(field(response, "transactionHash") ?? field(response, "hash"));
  if (transactionHash) result.transactionHash = transactionHash;
  const state = stringValue(field(response, "state"));
  if (state) result.state = state;
  return result;
}

export class AutoSettlementMonitor {
  private running: Promise<void> | undefined;
  private nextRunAt = 0;
  lastResult: SettlementResult | undefined;
  lastError: unknown;

  constructor(
    private readonly config: SettlementConfig,
    private readonly deps: SettlementMonitorDependencies = {}
  ) {}

  kick(nowMs = Date.now()): void {
    if (!this.config.enabled || this.running || nowMs < this.nextRunAt) return;
    this.nextRunAt = nowMs + this.config.intervalMs;
    const settle = this.deps.settle ?? settleRedeemablePositions;
    this.running = settle(this.config, this.deps)
      .then((result) => {
        this.lastResult = result;
        this.lastError = undefined;
      })
      .catch((error: unknown) => {
        this.lastError = error;
        this.deps.onError?.(error);
      })
      .finally(() => {
        this.running = undefined;
      });
  }

  async waitForIdle(): Promise<void> {
    await this.running;
  }
}

async function submitDepositWalletBatch(input: SubmitDepositWalletBatchInput): Promise<unknown> {
  const account = privateKeyToAccount(input.privateKey as Hex);
  const ownerAddress = input.ownerAddress ?? account.address;
  const relayerUrl = input.relayerUrl.replace(/\/$/, "");
  const nonceOptions: HttpOptions = { headers: relayerHeaders(input, "GET", "/nonce") };
  if (input.proxyUrl) nonceOptions.proxyUrl = input.proxyUrl;
  const noncePayload = await fetchJson<unknown>(`${relayerUrl}/nonce?${new URLSearchParams({ address: ownerAddress, type: "WALLET" }).toString()}`, nonceOptions);
  const nonce = stringValue(field(noncePayload, "nonce"));
  if (!nonce) throw new Error("POLY_REDEEM_NONCE_MISSING");

  const deadline = String(Math.floor(Date.now() / 1000) + input.deadlineSeconds);
  const signature = await account.signTypedData({
    domain: {
      name: DEPOSIT_WALLET_DOMAIN_NAME,
      version: DEPOSIT_WALLET_DOMAIN_VERSION,
      chainId: input.chainId,
      verifyingContract: input.walletAddress as Address
    },
    types: depositWalletTypes,
    primaryType: "Batch",
    message: {
      wallet: input.walletAddress as Address,
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
      calls: input.calls.map((call) => ({
        target: call.target as Address,
        value: BigInt(call.value),
        data: call.data as Hex
      }))
    }
  });
  const body = {
    type: "WALLET",
    from: ownerAddress,
    to: POLYMARKET_DEPOSIT_WALLET_FACTORY,
    nonce,
    signature,
    depositWalletParams: {
      depositWallet: input.walletAddress,
      deadline,
      calls: input.calls
    }
  };
  const bodyText = JSON.stringify(body);
  const submitOptions: HttpOptions = { headers: relayerHeaders(input, "POST", "/submit", bodyText) };
  if (input.proxyUrl) submitOptions.proxyUrl = input.proxyUrl;
  return postJson<unknown>(`${relayerUrl}/submit`, bodyText, submitOptions);
}

function defaultApprovalReader(config: SettlementConfig): (owner: string, operator: string) => Promise<boolean> {
  const chain = config.chainId === 80002 ? polygonAmoy : polygon;
  const client = createPublicClient({ chain, transport: http(config.rpcUrl || DEFAULT_POLYGON_RPC_URL) });
  return async (owner, operator) => {
    const result = await client.readContract({
      address: POLYMARKET_CONDITIONAL_TOKENS_ADDRESS as Address,
      abi: ctfApprovalAbi,
      functionName: "isApprovedForAll",
      args: [owner as Address, operator as Address]
    });
    return result === true;
  };
}

function conditionGroups(positions: readonly RedeemablePosition[]): Array<{ conditionId: string; negativeRisk: boolean }> {
  const seen = new Set<string>();
  const groups: Array<{ conditionId: string; negativeRisk: boolean }> = [];
  for (const position of positions) {
    const key = `${position.negativeRisk ? "1" : "0"}:${position.conditionId.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push({ conditionId: position.conditionId, negativeRisk: position.negativeRisk });
  }
  return groups;
}

async function needsAdapterApproval(
  walletAddress: string,
  adapter: string,
  isApprovedForAll: ((owner: string, operator: string) => Promise<boolean>) | undefined
): Promise<boolean> {
  if (!isApprovedForAll) return false;
  try {
    return !await isApprovedForAll(walletAddress, adapter);
  } catch {
    return true;
  }
}

function setApprovalForAllCall(adapter: string): DepositWalletCall {
  return {
    target: POLYMARKET_CONDITIONAL_TOKENS_ADDRESS,
    value: "0",
    data: encodeFunctionData({
      abi: ctfApprovalAbi,
      functionName: "setApprovalForAll",
      args: [adapter as Address, true]
    })
  };
}

function redeemPositionsCall(adapter: string, conditionId: string): DepositWalletCall {
  return {
    target: adapter,
    value: "0",
    data: encodeFunctionData({
      abi: adapterRedeemAbi,
      functionName: "redeemPositions",
      args: [
        POLYMARKET_PUSD_ADDRESS as Address,
        ZERO_BYTES32 as Hex,
        conditionId as Hex,
        [...BINARY_INDEX_SETS]
      ]
    })
  };
}

function adapterForNegativeRisk(negativeRisk: boolean): string {
  return negativeRisk ? POLYMARKET_NEG_RISK_CTF_COLLATERAL_ADAPTER : POLYMARKET_CTF_COLLATERAL_ADAPTER;
}

function relayerHeaders(
  input: Pick<SubmitDepositWalletBatchInput, "relayerApiKey" | "relayerApiKeyAddress" | "builderApiKey" | "builderApiSecret" | "builderPassphrase">,
  method: "GET" | "POST",
  path: string,
  body?: string
): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (input.relayerApiKey) {
    headers.POLY_RELAYER_API_KEY = input.relayerApiKey;
    headers["X-API-KEY"] = input.relayerApiKey;
  }
  if (input.relayerApiKeyAddress) headers.POLY_RELAYER_API_KEY_ADDRESS = input.relayerApiKeyAddress;
  if (input.builderApiKey && input.builderApiSecret && input.builderPassphrase) {
    Object.assign(headers, builderHeaders({
      key: input.builderApiKey,
      secret: input.builderApiSecret,
      passphrase: input.builderPassphrase
    }, method, path, body));
  }
  return headers;
}

function builderHeaders(
  creds: { key: string; secret: string; passphrase: string },
  method: string,
  path: string,
  body?: string
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  let message = `${timestamp}${method}${path}`;
  if (body !== undefined) message += body;
  const secret = Buffer.from(creds.secret, "base64");
  const signature = crypto.createHmac("sha256", secret).update(message).digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return {
    POLY_BUILDER_API_KEY: creds.key,
    POLY_BUILDER_PASSPHRASE: creds.passphrase,
    POLY_BUILDER_SIGNATURE: signature,
    POLY_BUILDER_TIMESTAMP: String(timestamp)
  };
}

function rawPositionArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw)) {
    if (Array.isArray(raw.positions)) return raw.positions;
    if (Array.isArray(raw.data)) return raw.data;
  }
  return [];
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isBytes32(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim().length === 0) return undefined;
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

function booleanValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}
