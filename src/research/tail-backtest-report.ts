import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { csvDocument } from "./report.js";
import type { ArchiveFingerprint, LoadedTailArchive, SettlementCollection } from "./tail-backtest-io.js";
import type { TailBacktestResult, TailBacktestSummary, TailBacktestTrial } from "./tail-backtest-types.js";

export type TailBacktestProvenance = LoadedTailArchive["provenance"] & {
  sourceId?: string;
  sourceRunId?: string;
  sport?: string;
};
export interface TailBacktestReportOptions {
  outputDirectory: string;
  provenance: readonly TailBacktestProvenance[];
  evidence?: SettlementCollection;
}
export interface TailBacktestReportFiles {
  outputDirectory: string;
  reportPath: string;
  summaryPath: string;
  trialsPath: string;
  htmlPath: string;
  inputsPath: string;
  settlementsPath?: string;
  manifestPath: string;
}

type ReportTrial = TailBacktestTrial & { pnlStatus: "excluded" | "unresolved" | "no-fill" | "resolved" };
const TITLE = "假设限价挂单情景回测";
const ASSUMPTIONS = [
  "本报告仅在收到的历史盘口上计算假设限价挂单情景。价格触及与假设成交均不是实际下单或成交记录，不保证收益。",
  "quote-touch-assumed：有效卖价或直接 SELL 成交触及限价时假设全部成交，未证明排队位置、可用深度或延迟；排队份额仅用于 sell-through-volume。",
  "sell-through-volume：仅累计严格低于限价的直接 SELL 成交量，扣除一次固定排队份额，并以申请份额为上限；BUY 与同价成交不提供穿价成交量。",
  "入场时间以事后确认的比赛结束时刻倒推；入场方向来自入场前已完整记录的盘口，不使用结算结果选边，也不是实时预测比赛结束。",
  "数据合格与盈亏合格分别统计。排除行和未结算成交的盈亏保持 null；CSV 对应空白。已确认的零成交情景可计入零盈亏。",
  "不同参数、时间窗口和同场比赛的市场可能重叠，不可将情景盈亏相加作为投资组合收益。小样本与样本内结果不能证明未来最优收益。",
  "JSON 是权威记录。电子表格导入时请将长 token ID 及其他标识符列设为文本；CSV 对长数字 ID 加前导单引号以减少精度丢失，未使用公式。"
] as const;
const DENOMINATORS = {
  trials: "全部参数情景（含数据排除），并非独立交易数量。",
  eligibleTrials: "满足入场和数据质量条件的情景；不要求结算标签已知。",
  pnlTrialDenominator: "仅盈亏合格情景，包含已确认的零成交，排除未结算成交和无效数据。",
  filledCapitalDenominator: "仅已结算假设成交的成本加费用；不含未结算占用资金。",
  pnlPerTrial: "已知假设盈亏 / 盈亏样本分母；分母为零则为 null。",
  returnOnFilledCapital: "已知假设盈亏 / 已结算投入分母；分母为零则为 null。"
};

const TRIAL_FIELDS: readonly (keyof ReportTrial)[] = [
  "sourceId", "sourceRunId", "windowKey", "gameId", "eventId", "eventSlug", "eventTitle", "sport", "marketId", "marketSlug",
  "conditionId", "marketType", "question", "tokenId", "outcome", "windowBasis", "fillModel", "bidPrice", "windowSeconds",
  "orderShares", "queueAheadShares", "makerFeeBps", "finishAtMs", "finishConflict", "finishSources", "finishEvidence", "entryAtMs",
  "expiryAtMs", "referenceStartAtMs", "referenceAtMs", "referenceBookObservedAtMs", "referenceBid", "referenceAsk", "entryReferences",
  "tokenQuality", "priceCoverage", "contextCoverage", "exclusions", "eligible", "pnlEligible", "pnlStatus", "touched",
  "touchBookChangeCount", "touchSecondCount", "touchTradeCount", "touchSellShares", "equalSellTradeCount", "equalSellShares",
  "sellThroughTradeCount", "sellThroughShares", "firstTouch", "firstTouchAtMs", "firstModeledFillAtMs", "modeledFilledShares",
  "modeledCost", "modeledFee", "modeledPayout", "modeledPnl", "payoutPerShare", "settlement", "settlementVector"
];
const SUMMARY_FIELDS: readonly (keyof TailBacktestSummary)[] = [
  "sport", "marketType", "bidPrice", "windowSeconds", "windowBasis", "fillModel", "orderShares", "queueAheadShares", "makerFeeBps",
  "trials", "games", "sources", "eligibleTrials", "excludedTrials", "unresolvedTrials", "pnlEligibleTrials", "priceCompleteTrials",
  "contextCompleteTrials", "touchedTrials", "modeledFilledTrials", "settledFilledTrials", "zeroFillTrials", "winningFills", "losingFills",
  "breakEvenFills", "splitPayoutFills", "modeledFilledShares", "modeledCost", "modeledFees", "unresolvedFilledCost", "unresolvedFilledFees",
  "modeledPayout", "modeledPnl", "winnings", "losses", "pnlTrialDenominator", "filledCapitalDenominator", "pnlPerTrial", "returnOnFilledCapital", "exclusions"
];

function labeledTrial(trial: TailBacktestTrial): ReportTrial {
  const pnlStatus = !trial.eligible ? "excluded" : !trial.pnlEligible || trial.modeledPnl === null ? "unresolved"
    : trial.modeledFilledShares === 0 ? "no-fill" : "resolved";
  return { ...trial, pnlStatus };
}

/** CSV cannot declare types. Preserve IDs as text without executable spreadsheet formulas. */
function csvTrial(trial: ReportTrial): ReportTrial {
  const row = { ...trial };
  for (const field of ["sourceId", "sourceRunId", "gameId", "eventId", "marketId", "conditionId", "tokenId"] as const) {
    const value = row[field];
    if (value !== null && /^(?:\d{16,}|0\d+)$/.test(value)) row[field] = "'" + value;
  }
  return row;
}

function escapeHtml(value: unknown): string {
  const text = value === null || value === undefined ? "未知（null）" : String(value);
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function table(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return `<div class="table-wrap"><table><thead><tr>${headers.map(header => `<th scope="col">${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${
    rows.map(row => `<tr>${row.map(value => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("")
  }</tbody></table></div>`;
}
function percent(value: number | null): string | null { return value === null ? null : `${Number((value * 100).toPrecision(10))}%`; }
function exclusionCounts(counts: TailBacktestSummary["exclusions"]): string {
  return Object.entries(counts).map(([reason, count]) => `${reason}: ${count}`).join("；") || "无";
}

function renderHtml(result: TailBacktestResult, trials: readonly ReportTrial[], options: TailBacktestReportOptions): string {
  const config = result.options, evidence = options.evidence;
  const eligible = trials.filter(trial => trial.eligible).length;
  const noSamples = eligible ? "" : `<p class="notice">没有数据合格的情景，无法据此评估盈利能力。请查看下方排除原因及来源警告；无可用市场时不会产生情景行。</p>`;
  const pnlLabels: Record<ReportTrial["pnlStatus"], string> = { excluded: "数据排除", unresolved: "未结算", "no-fill": "零成交（已知）", resolved: "已结算（假设成交）" };
  const warnings = [...result.warnings, ...result.sources.flatMap(source => source.warnings.map(warning => `${source.sourceId}: ${warning}`))];
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${TITLE}</title><style>
body{font-family:system-ui,sans-serif;max-width:1440px;margin:32px auto;padding:0 20px;color:#182638;background:#f6f8fa;line-height:1.6}
h1{font-size:1.7rem}h2{margin-top:2rem;font-size:1.2rem}a{color:#175c9e}.notice{padding:12px;background:#fff0cc;border-left:4px solid #8b6400}
.table-wrap{overflow-x:auto;background:white;border:1px solid #d8e0e6;border-radius:6px}table{border-collapse:collapse;width:100%;font-size:.88rem}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #d8e0e6;vertical-align:top;overflow-wrap:anywhere}th{background:#eaf0f5;white-space:nowrap}
li{margin:6px 0}details{margin:16px 0}code{overflow-wrap:anywhere}p{max-width:1100px}
</style></head><body><h1>${TITLE}</h1>
<p>来源 ${result.sources.length} 个；参数组 ${result.summaries.length} 个；情景 ${trials.length} 行；数据合格 ${eligible} 行。计数包含参数重叠。</p>
${noSamples}<ul>${ASSUMPTIONS.map(note => `<li>${escapeHtml(note)}</li>`).join("")}</ul>
<p><a href="report.json">完整 JSON</a> · <a href="summary.csv">参数汇总 CSV</a> · <a href="trials.csv">情景与证据 CSV</a> · <a href="inputs.json">输入路径与哈希</a>${evidence ? ' · <a href="settlements.json">新增公开结算证据</a>' : ""} · <a href="manifest.json">完成清单</a></p>
<h2>实际参数</h2>${table(["参数", "值"], [
    ["限价（原始十进制字符串）", config.prices.join(", ")], ["距比赛结束的窗口（秒）", config.windowsSeconds.join(", ")],
    ["入场最低买价", config.entryMinBid], ["每单份额 / 排队份额", `${config.shares} / ${config.queueAheadShares}`],
    ["maker 费用（bps）", config.makerFeeBps], ["假设成交模型", config.fillModel], ["要求新鲜上下文", config.requireFreshContext ? "是" : "否"]
  ])}
<h2>各参数情景汇总</h2><p>每行独立展示该组情景，不提供跨窗口或跨市场的投资组合总计。价格完整和上下文完整分别保留在 JSON/CSV。</p>
${table(["运动", "市场类型", "限价 / 窗口秒", "数据合格 / 全部", "触及 / 假设成交", "排除 / 未结算成交", "盈亏样本分母", "已结算投入分母", "假设盈亏", "每样本盈亏", "投入回报", "排除原因"],
    result.summaries.map(summary => [summary.sport, summary.marketType, `${summary.bidPrice} / ${summary.windowSeconds}`,
      `${summary.eligibleTrials} / ${summary.trials}`, `${summary.touchedTrials} / ${summary.modeledFilledTrials}`,
      `${summary.excludedTrials} / ${summary.unresolvedTrials}`, summary.pnlTrialDenominator, summary.filledCapitalDenominator,
      summary.modeledPnl, summary.pnlPerTrial, percent(summary.returnOnFilledCapital), exclusionCounts(summary.exclusions)]))}
<p>盈亏样本分母：${escapeHtml(DENOMINATORS.pnlTrialDenominator)} 已结算投入分母：${escapeHtml(DENOMINATORS.filledCapitalDenominator)} 未知回报显示为“未知（null）”，不补零。</p>
<h2>情景明细</h2>${table(["比赛", "市场", "方向 / token ID", "限价 / 窗口秒", "数据合格 / 盈亏合格", "结算状态", "假设成交份额", "假设成本 / 费用", "假设盈亏", "排除原因"],
    trials.map(trial => [trial.eventTitle, trial.question, `${trial.outcome ?? "未知"} / ${trial.tokenId ?? "未知"}`,
      `${trial.bidPrice} / ${trial.windowSeconds}`, `${trial.eligible ? "是" : "否"} / ${trial.pnlEligible ? "是" : "否"}`, pnlLabels[trial.pnlStatus],
      trial.modeledFilledShares, `${trial.modeledCost ?? "未知（null）"} / ${trial.modeledFee ?? "未知（null）"}`, trial.modeledPnl, trial.exclusions.join("；") || "无"]))}
<h2>输入来源</h2>${table(["目录", "源运行 / 运动", "输入文件", "字节", "SHA-256"], options.provenance.flatMap(source =>
    source.files.map(file => [source.directory, `${source.sourceRunId ?? "未知"} / ${source.sport ?? "未知"}`, file.name, file.bytes, file.sha256])))}
<h2>公开结算证据</h2><p>${evidence ? `新增响应 ${evidence.observations.length} 条；错误 ${evidence.errors.length} 条。完整响应状态、头部、正文和错误见 settlements.json。` : "本次未请求网络；仅使用归档内已有的明确结算证据。"}</p>
${evidence?.errors.length ? `<ul>${evidence.errors.map(error => `<li>${escapeHtml(error)}</li>`).join("")}</ul>` : ""}
<details><summary>引擎假设与来源警告（完整原文）</summary><ul>${warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></details>
</body></html>\n`;
}

async function writeExclusive(path: string, contents: string): Promise<ArchiveFingerprint> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  return { name: path.slice(path.lastIndexOf("/") + 1), bytes: Buffer.byteLength(contents), sha256: createHash("sha256").update(contents).digest("hex") };
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
function json(value: unknown): string { return JSON.stringify(value, null, 2) + "\n"; }

/** A failed write leaves its evidence in place. Only a complete, synced report receives a manifest. */
export async function writeTailBacktestReport(result: TailBacktestResult, options: TailBacktestReportOptions): Promise<TailBacktestReportFiles> {
  if (!options.outputDirectory?.trim() || options.outputDirectory.includes("\0")) throw new Error("TAIL_BACKTEST_OPTIONS_INVALID: outputDirectory is required");
  const outputDirectory = resolve(options.outputDirectory);
  await mkdir(dirname(outputDirectory), { recursive: true, mode: 0o700 });
  try { await mkdir(outputDirectory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("TAIL_BACKTEST_OUTPUT_EXISTS: " + outputDirectory);
    throw error;
  }
  const files: TailBacktestReportFiles = {
    outputDirectory, reportPath: join(outputDirectory, "report.json"), summaryPath: join(outputDirectory, "summary.csv"),
    trialsPath: join(outputDirectory, "trials.csv"), htmlPath: join(outputDirectory, "report.html"),
    inputsPath: join(outputDirectory, "inputs.json"), manifestPath: join(outputDirectory, "manifest.json"),
    ...(options.evidence ? { settlementsPath: join(outputDirectory, "settlements.json") } : {})
  };
  const fingerprints: ArchiveFingerprint[] = [], trials = result.trials.map(labeledTrial);
  fingerprints.push(await writeExclusive(files.inputsPath, json({ schemaVersion: 1, options: result.options, sources: result.sources, provenance: options.provenance })));
  // Capture fresh public observations before writing any derived presentation.
  if (files.settlementsPath) fingerprints.push(await writeExclusive(files.settlementsPath, json(options.evidence)));
  fingerprints.push(await writeExclusive(files.reportPath, json({ ...result, trials, title: TITLE, assumptions: ASSUMPTIONS,
    denominators: DENOMINATORS, provenance: options.provenance, evidenceFile: files.settlementsPath ? "settlements.json" : null })));
  fingerprints.push(await writeExclusive(files.summaryPath, csvDocument(result.summaries, SUMMARY_FIELDS)));
  fingerprints.push(await writeExclusive(files.trialsPath, csvDocument(trials.map(csvTrial), TRIAL_FIELDS)));
  fingerprints.push(await writeExclusive(files.htmlPath, renderHtml(result, trials, options)));
  await syncDirectory(outputDirectory);
  await writeExclusive(files.manifestPath, json({ schemaVersion: 1, status: "complete", createdAt: new Date().toISOString(),
    basis: result.basis, execution: result.execution, scenarioTrials: trials.length, parameterGroups: result.summaries.length,
    sourceCount: result.sources.length, files: fingerprints }));
  await syncDirectory(outputDirectory);
  await syncDirectory(dirname(outputDirectory));
  return files;
}
