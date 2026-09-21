import { readFile } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import { validateProxyConfiguration } from "../polymarket/owned-transport.js";

export interface SportProfile {
  name: string;
  tagId: string;
}

export interface ContinuousConfig {
  dataRoot: string;
  profiles: SportProfile[];
  discoveryIntervalMs: number;
  snapshotIntervalMs: number;
  httpTimeoutMs: number;
  postFinishRetentionMs: number;
  pulseIntervalMs: number;
  minFreeBytes: number;
  port: number;
  lookbackHours: number;
  aheadHours: number;
  proxyUrl?: string;
  gammaBaseUrl: string;
  clobBaseUrl: string;
  clobWsUrl: string;
  sportsWsUrl: string;
  retryDelayMs: number;
  exportTimeoutMs: number;
  compressionEnabled: boolean;
  compressionIntervalMs: number;
  compressionMaxSegments: number;
  compressionTimeoutMs: number;
  singleMatchOnly: boolean;
  compactStorageEnabled: boolean;
  compactAnchorSnapshots: boolean;
  tailWindowSeconds: number;
  tailBufferSeconds: number;
  tailRetentionDays: number;
  maxTailStoreBytes: number;
  /**
   * How long a sealed raw run directory is kept once compact storage owns the
   * order-book evidence. Raw runs in compact mode hold discovery/audit records
   * only (the frames live in the SQLite tail), so they are pruned by the hour
   * instead of by `tailRetentionDays`, which is what filled the disk.
   * Ignored when `compactStorageEnabled` is off: the legacy export path reads
   * the raw run and keeps it for `tailRetentionDays`.
   */
  rawRunRetentionHours: number;
  maintenanceIntervalMs: number;
  /**
   * How long an unfinished match's rolling tail stays protected from
   * wall-clock pruning while its finish label is still missing, and how long
   * the collector keeps asking Gamma for that label.
   */
  pendingFinishRetentionMs: number;
  /** Retry cadence for a finish-label follow-up whose evidence is still salvageable. */
  finishFollowupIntervalMs: number;
  /** Follow-up requests issued per pulse. */
  finishFollowupBatchSize: number;
  /**
   * How long a token whose `/books` reply proved it has no orderbook stays out
   * of the anchor rotation. Resolved sub-markets (set winners, totals,
   * handicaps) lose their book before Gamma flips `closed`, so without a
   * backoff every snapshot pass re-requests and re-reports the same absence.
   */
  absentBookCooldownMs: number;
  /**
   * How long a retired match waits for a published finish clock before its own
   * last order-book frame becomes the window end. Gamma closes most events
   * without ever publishing a clock, so this cannot wait indefinitely.
   */
  finishAnchorGraceMs: number;
}

function invalid(message: string): never {
  const error = new Error(`CONTINUOUS_CONFIG_INVALID: ${message}`);
  error.name = "CONTINUOUS_CONFIG_INVALID";
  throw error;
}

function configObject(value: unknown): asserts value is Partial<ContinuousConfig> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("configuration must be an object");
  }
}

function nonemptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${field} must be a nonempty string`);
  return value;
}

function pathString(value: unknown, field: string): string {
  const path = nonemptyString(value, field);
  if (path.includes("\0")) invalid(`${field} must not contain a null byte`);
  return path;
}

function validateUrl(value: unknown, field: string, protocols: readonly string[]): void {
  const message = `${field} must be an absolute ${protocols.join("/")} URL`;
  let protocol: string;
  try {
    if (typeof value !== "string") throw new Error();
    protocol = new URL(value).protocol;
  } catch {
    invalid(message);
  }
  if (!protocols.includes(protocol)) invalid(message);
}

export function continuousConfig(
  input: Partial<ContinuousConfig> = {},
  projectDirectory = process.cwd()
): ContinuousConfig {
  configObject(input);
  const defaults: ContinuousConfig = {
    dataRoot: resolve(projectDirectory, "data/collector/continuous"),
    profiles: [{ name: "tennis", tagId: "864" }, { name: "table-tennis", tagId: "103767" }],
    discoveryIntervalMs: 30_000,
    snapshotIntervalMs: 60_000,
    httpTimeoutMs: 10_000,
    postFinishRetentionMs: 600_000,
    pulseIntervalMs: 5_000,
    minFreeBytes: 20 * 1024 ** 3,
    port: 8765,
    lookbackHours: 6,
    aheadHours: 2,
    gammaBaseUrl: "https://gamma-api.polymarket.com",
    clobBaseUrl: "https://clob.polymarket.com",
    clobWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
    sportsWsUrl: "wss://sports-api.polymarket.com/ws",
    retryDelayMs: 5_000,
    exportTimeoutMs: 600_000,
    compressionEnabled: false,
    compressionIntervalMs: 60_000,
    compressionMaxSegments: 4,
    compressionTimeoutMs: 120_000,
    singleMatchOnly: true,
    compactStorageEnabled: false,
    compactAnchorSnapshots: false,
    tailWindowSeconds: 181,
    tailBufferSeconds: 30,
    tailRetentionDays: 30,
    maxTailStoreBytes: 8 * 1024 ** 3,
    rawRunRetentionHours: 6,
    maintenanceIntervalMs: 60_000,
    pendingFinishRetentionMs: 900_000,
    finishFollowupIntervalMs: 15_000,
    finishFollowupBatchSize: 8,
    finishAnchorGraceMs: 300_000,
    absentBookCooldownMs: 300_000
  };
  const overrides = Object.fromEntries(Object.entries(input).filter(([key, value]) =>
    value !== undefined && (Object.hasOwn(defaults, key) || key === "proxyUrl")
  ));
  const config: ContinuousConfig = { ...defaults, ...overrides };

  for (const field of [
    "discoveryIntervalMs", "snapshotIntervalMs", "httpTimeoutMs", "pulseIntervalMs",
    "retryDelayMs", "exportTimeoutMs", "minFreeBytes", "port",
    "compressionIntervalMs", "compressionMaxSegments", "compressionTimeoutMs",
    "tailWindowSeconds", "tailBufferSeconds", "maxTailStoreBytes", "maintenanceIntervalMs",
    "finishFollowupIntervalMs", "finishFollowupBatchSize", "finishAnchorGraceMs", "absentBookCooldownMs"
  ] as const) {
    if (!Number.isSafeInteger(config[field]) || config[field] < 1) invalid(`${field} must be a positive safe integer`);
  }
  if (config.port > 65_535) invalid("port must be between 1 and 65535");
  if (typeof config.compressionEnabled !== "boolean") invalid("compressionEnabled must be boolean");
  if (typeof config.singleMatchOnly !== "boolean") invalid("singleMatchOnly must be boolean");
  if (typeof config.compactStorageEnabled !== "boolean") invalid("compactStorageEnabled must be boolean");
  if (typeof config.compactAnchorSnapshots !== "boolean") invalid("compactAnchorSnapshots must be boolean");
  if (config.compressionMaxSegments > 1024) invalid("compressionMaxSegments must be at most 1024");
  if (config.compressionTimeoutMs > 2_147_483_647) invalid("compressionTimeoutMs exceeds Node's timer limit");
  if (!Number.isSafeInteger(config.tailRetentionDays) || config.tailRetentionDays < 0) invalid("tailRetentionDays must be a nonnegative safe integer");
  if (!Number.isSafeInteger(config.rawRunRetentionHours) || config.rawRunRetentionHours < 0) {
    invalid("rawRunRetentionHours must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(config.pendingFinishRetentionMs) || config.pendingFinishRetentionMs < 0) {
    invalid("pendingFinishRetentionMs must be a nonnegative safe integer");
  }
  if (config.pendingFinishRetentionMs < config.finishFollowupIntervalMs) {
    invalid("pendingFinishRetentionMs must be at least finishFollowupIntervalMs or no retry can ever be due");
  }
  if (config.finishAnchorGraceMs > config.pendingFinishRetentionMs) {
    invalid("finishAnchorGraceMs must not exceed pendingFinishRetentionMs or the fallback window is already released");
  }
  if (!Number.isSafeInteger(config.postFinishRetentionMs) || config.postFinishRetentionMs < 0) {
    invalid("postFinishRetentionMs must be a nonnegative safe integer");
  }
  for (const field of ["lookbackHours", "aheadHours"] as const) {
    if (!Number.isFinite(config[field]) || config[field] < 0) invalid(`${field} must be finite and nonnegative`);
  }

  if (!Array.isArray(config.profiles) || config.profiles.length === 0) invalid("profiles must be a nonempty array");
  const names = new Set<string>();
  const tags = new Set<string>();
  config.profiles = Array.from(config.profiles, (profile) => {
    if (typeof profile !== "object" || profile === null || Array.isArray(profile)) invalid("profiles entries must be objects");
    const name = nonemptyString(profile.name, "profiles.name").trim();
    const tagId = nonemptyString(profile.tagId, "profiles.tagId").trim();
    if (names.has(name) || tags.has(tagId)) invalid("profiles must have unique names and tagIds");
    names.add(name);
    tags.add(tagId);
    return { name, tagId };
  });

  config.dataRoot = resolve(projectDirectory, pathString(config.dataRoot, "dataRoot"));
  if (config.dataRoot === parse(config.dataRoot).root || config.dataRoot === resolve(projectDirectory)) {
    invalid("dataRoot must not be the filesystem root or project directory");
  }
  for (const field of ["gammaBaseUrl", "clobBaseUrl"] as const) validateUrl(config[field], field, ["http:", "https:"]);
  for (const field of ["clobWsUrl", "sportsWsUrl"] as const) validateUrl(config[field], field, ["ws:", "wss:"]);
  if (config.proxyUrl !== undefined) {
    try {
      if (typeof config.proxyUrl !== "string") throw new Error();
      validateProxyConfiguration(config.proxyUrl);
    } catch {
      // The original error may contain a URL or even a credential-like protocol.
      invalid("proxyUrl must be an HTTP(S) proxy URL, or empty for a direct connection");
    }
  }
  return config;
}

export async function loadContinuousConfig(
  path: string | undefined,
  projectDirectory = process.cwd()
): Promise<ContinuousConfig> {
  if (path === undefined) return continuousConfig({}, projectDirectory);
  const configPath = resolve(projectDirectory, pathString(path, "path"));
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (cause) {
    const code = typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? cause.code : "";
    const detail = /^[A-Z][A-Z0-9_]*$/.test(code) ? ` (${code})` : "";
    const error = new Error(`CONTINUOUS_CONFIG_READ_FAILED: unable to read configuration file ${configPath}${detail}`);
    error.name = "CONTINUOUS_CONFIG_READ_FAILED";
    throw error;
  }
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    // JSON parser errors can quote the configuration's proxy credentials.
    invalid(`invalid JSON in configuration file ${configPath}`);
  }
  configObject(input);
  if (input.dataRoot !== undefined) {
    input.dataRoot = resolve(dirname(configPath), pathString(input.dataRoot, "dataRoot"));
  }
  return continuousConfig(input, projectDirectory);
}
