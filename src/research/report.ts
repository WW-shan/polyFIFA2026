import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BacktestResult, OrderTrial, ParameterSummary } from "./backtest-types.js";
export interface ReportOptions { outputDirectory: string; inputPath?: string; inputSha256?: string }
export interface ReportFiles { reportPath: string; summaryPath: string; trialsPath: string }
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (typeof value === "string" && /^[\s]*[=+@-]|^[\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
export function csvDocument<T extends object>(rows: readonly T[], fields: readonly (keyof T)[]): string {
  return [fields.map(field => cell(String(field))).join(","), ...rows.map(row => fields.map(field => cell(row[field])).join(","))].join("\n") + "\n";
}
const TRIAL_FIELDS: (keyof OrderTrial)[] = [
  "eventId", "eventSlug", "eventTitle", "sport", "marketId", "conditionId", "marketType", "question", "tokenId", "outcome",
  "entryMode", "fillModel", "bidPrice", "windowSeconds", "orderShares", "queueAheadShares", "entryAtMs", "expiryAtMs", "finishAtMs",
  "referenceAtMs", "referencePrice", "referenceBasis", "referenceAgeSeconds", "exclusions", "touchTradeCount", "touchShares", "sellThroughShares",
  "equalSellShares", "minimumTradePrice", "firstTouchAtMs", "firstSimulatedFillAtMs", "simulatedFilledShares", "simulatedCost", "simulatedFee", "payoutPerShare", "simulatedPnl"
];
const SUMMARY_FIELDS: (keyof ParameterSummary)[] = [
  "sport", "marketType", "entryMode", "fillModel", "bidPrice", "windowSeconds", "orderShares", "queueAheadShares", "trials", "events",
  "eligibleTrials", "excludedTrials", "touchedTrials", "filledTrials", "unfilledTrials", "winningFills", "losingFills", "splitPayoutFills",
  "simulatedFilledShares", "simulatedCost", "simulatedFees", "simulatedPnl", "returnOnFilledCapital", "pnlPerEligibleTrial", "exclusions"
];
export async function writeBacktestReport(result: BacktestResult, options: ReportOptions): Promise<ReportFiles> {
  if (!options.outputDirectory?.trim()) throw new Error("RESEARCH_OPTIONS_INVALID: outputDirectory is required");
  const directory = resolve(options.outputDirectory);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  const files: ReportFiles = { reportPath: join(directory, "report.json"), summaryPath: join(directory, "summary.csv"), trialsPath: join(directory, "trials.csv") };
  const writes = await Promise.allSettled([
    writeFile(files.reportPath, JSON.stringify(result) + "\n", { flag: "wx" }),
    writeFile(files.summaryPath, csvDocument(result.summaries, SUMMARY_FIELDS), { flag: "wx" }),
    writeFile(files.trialsPath, csvDocument(result.trials, TRIAL_FIELDS), { flag: "wx" })
  ]);
  const failure = writes.find((write): write is PromiseRejectedResult => write.status === "rejected");
  if (failure) throw failure.reason;
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ status: "complete", createdAt: new Date().toISOString(),
    inputPath: options.inputPath ?? null, inputSha256: options.inputSha256 ?? null, basis: result.basis,
    scenarioTrials: result.trials.length, parameterGroups: result.summaries.length }) + "\n", { flag: "wx" });
  return files;
}
