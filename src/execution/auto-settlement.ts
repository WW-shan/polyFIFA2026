/**
 * Auto-redeem wiring shared by the live watch entries.
 *
 * The World Cup watch builds this inline in `cli.ts`; the tennis tail watch
 * needs the same behaviour, so the env -> config mapping lives here.
 */
import { DEFAULT_POLYGON_RPC_URL } from "./balance.js";
import { liveConfigFromEnv, type LiveExecutorConfig } from "./live-executor.js";
import { AutoSettlementMonitor, DEFAULT_POLYMARKET_RELAYER_URL, type SettlementConfig, type SettlementMonitorDependencies } from "./settlement.js";
import type { LiveLedger } from "../persistence/ledger.js";

export interface AutoSettlementOptions {
  env: Record<string, string | undefined>;
  ledger: LiveLedger;
  /** Explicit CLI proxy, overriding the env-derived settlement proxy. */
  proxyUrl?: string;
  /** Test/live overrides; ledger callbacks and onError are filled in below. */
  deps?: SettlementMonitorDependencies;
}

/**
 * Map the environment onto a settlement config, mirroring the World Cup watch:
 * `POLY_AUTO_REDEEM=false` disables it, and it needs a wallet plus a private key.
 */
export function settlementConfigFromEnv(
  env: Record<string, string | undefined>,
  liveConfig: LiveExecutorConfig
): SettlementConfig | undefined {
  if (booleanEnv(env.POLY_AUTO_REDEEM) === false) return undefined;
  const walletAddress = liveConfig.depositWalletAddress ?? liveConfig.funderAddress;
  if (!walletAddress || !liveConfig.privateKey) return undefined;

  const config: SettlementConfig = {
    enabled: true,
    walletAddress,
    privateKey: liveConfig.privateKey,
    relayerUrl: nonEmptyEnv(env.POLY_RELAYER_URL) ?? DEFAULT_POLYMARKET_RELAYER_URL,
    chainId: liveConfig.chainId,
    rpcUrl: liveConfig.rpcUrl ?? DEFAULT_POLYGON_RPC_URL,
    intervalMs: numberEnv(env.POLY_AUTO_REDEEM_INTERVAL_MS) ?? 60_000,
    deadlineSeconds: numberEnv(env.POLY_AUTO_REDEEM_DEADLINE_SECONDS) ?? 600,
    sizeThreshold: numberEnv(env.POLY_AUTO_REDEEM_SIZE_THRESHOLD) ?? 0.000001
  };
  const ownerAddress = nonEmptyEnv(env.POLY_RELAYER_API_KEY_ADDRESS) ?? nonEmptyEnv(env.RELAYER_API_KEY_ADDRESS);
  if (ownerAddress) config.ownerAddress = ownerAddress;
  const relayerApiKey = nonEmptyEnv(env.POLY_RELAYER_API_KEY) ?? nonEmptyEnv(env.RELAYER_API_KEY);
  if (relayerApiKey) config.relayerApiKey = relayerApiKey;
  if (ownerAddress) config.relayerApiKeyAddress = ownerAddress;
  const builderApiKey = nonEmptyEnv(env.POLY_BUILDER_API_KEY);
  const builderApiSecret = nonEmptyEnv(env.POLY_BUILDER_API_SECRET);
  const builderPassphrase = nonEmptyEnv(env.POLY_BUILDER_PASSPHRASE);
  if (builderApiKey) config.builderApiKey = builderApiKey;
  if (builderApiSecret) config.builderApiSecret = builderApiSecret;
  if (builderPassphrase) config.builderPassphrase = builderPassphrase;
  const proxyUrl = proxyFromEnv(env);
  if (proxyUrl) config.proxyUrl = proxyUrl;
  return config;
}

export function createAutoSettlementMonitor(options: AutoSettlementOptions): AutoSettlementMonitor | undefined {
  const config = settlementConfigFromEnv(options.env, liveConfigFromEnv(options.env));
  if (!config) return undefined;
  if (options.proxyUrl) config.proxyUrl = options.proxyUrl;
  const ledger = options.ledger;
  const overrides = options.deps ?? {};
  const deps: SettlementMonitorDependencies = {
    ...overrides,
    readActiveLedgerEntries: overrides.readActiveLedgerEntries ?? (() => ledger.readActiveEntries()),
    markRedeemedConditionIds: overrides.markRedeemedConditionIds ?? ((conditionIds) => ledger.markRedeemedByConditionIds(conditionIds)),
    markLostConditionIds: overrides.markLostConditionIds ?? ((conditionIds) => ledger.markLostByConditionIds(conditionIds)),
    onError: overrides.onError ?? ((error) => {
      console.error(`AUTO_REDEEM_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    })
  };
  return new AutoSettlementMonitor(config, deps);
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function numberEnv(value: string | undefined): number | undefined {
  const trimmed = nonEmptyEnv(value);
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanEnv(value: string | undefined): boolean | undefined {
  const normalized = nonEmptyEnv(value)?.toLowerCase();
  if (normalized === undefined) return undefined;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return undefined;
}

function proxyFromEnv(env: Record<string, string | undefined>): string | undefined {
  for (const value of [env.HTTPS_PROXY, env.HTTP_PROXY, env.https_proxy, env.http_proxy]) {
    const nonEmpty = nonEmptyEnv(value);
    if (nonEmpty) return nonEmpty;
  }
  return undefined;
}
