# Add random_control falsification + live deployment runbook

Hey 善哥, 一个朋友也想跑这个 bot，但他自己有一套 "audit-first" 的回测纪律
(他自己的 A 股量化项目花了 9 个月反复证伪自己策略才敢上线)，所以来给你
这个项目做了一遍同样的工序。结论非常有利于你 — 8/9 决策格 PASS — 但有
些 caveat 应该写下来防止误下注。这个 PR 是把分析结果 + 部署 runbook 贡献
回上游，方便其他想跑的人。

## 加了什么

```
analysis/
  random_control/
    metrics.py            # 与 src/domain/fees.ts 完全一致，加自检
    io.py                 # 加载 candidates + trades + summary
    tier2.py              # within-window time-randomization 主测
    tier3.py              # universe null vs 非策略市场
    report.py
  fetch_event_markets.ts  # 复用 src/polymarket/event-page.ts 拉取全市场列表
  fetch_universe_trades.py # 拉取 736 个非策略市场的 BUY 成交
  run_tier2.py            # 一键运行 Tier 2
  run_tier3.py            # 一键运行 Tier 3
docs/
  random_control_tier2_report.md
  random_control_tier3_report.md
  live_deployment_runbook.md
data/
  random_control_tier2.csv
  random_control_tier3.csv
  event_markets_universe.json
  universe_tail_trades.json
```

## 三层验证设计

每层都用 **cluster bootstrap by `slug` (match-date), B=10,000** 保持 within-match correlation。net_roi 公式严格对齐你的 `src/domain/fees.ts`，metrics 自检在 6 个价位锚点 (0.99, 0.98, 0.97, 0.95, 0.93, 0.781) 上对齐你 docs/ 里的回测数字。

| 层 | 问题 | 数据 | 状态 |
|---|---|---|---|
| Tier 1 | 不同策略之间是否真有差异 | 现有 | 跳过 (信息含量不大) |
| **Tier 2** | min_price 是 outlier 还是窗口真的便宜 | 现有 trades JSON | ✅ 8/9 PASS |
| **Tier 3** | lossRequiresGoals 过滤器到底有没有 alpha | 新抓的 736 个非策略市场 trades | [Tier 3 verdict TBD pending fetch] |

## Tier 2 关键发现

**最稳决策格: `total_under_loss_ge2 @ 480s`**
- min-ROI 4.38% vs 随机 1.52%
- 命中率 ≤0.99: 83.8% vs 随机 57.4%
- ROI Δ 95% CI [+1.73, +3.76]，完全不含 0

**Caveat 警告 (这些不能 trade)**:
- `total_over_locked` / `team_total_over_locked` / `btts_yes_locked` ROI 数字 1000%+ 但 CI 跨好几百 pp。Tier 2 确认这些是进球后盘口更新滞后的单次 outlier，没有 speed bot 抓不到。**Runbook 默认把这些列入黑名单**。
- 60s 窗口和随机无法区分。180s-480s 是甜蜜点。

## Tier 3 关键发现

[Will be filled after Tier 3 fetch + analysis completes]

## 部署 runbook 摘要

写了 `docs/live_deployment_runbook.md`：从 0 到 \$5 smoke 的 A→B→C→D 序列：
- A: typecheck + tests + paper:fixture 全过 (已确认: 141 tests pass)
- B: live:status 检查 pUSD 余额
- C: live:smoke \$5 一次性
- D: live:watch:worldcup 持续盯盘

加了 5 个 hard stop conditions 和起步推荐配置 (\$10-30 单笔, \$100 单日 cap, ROI 阈值 1%, 排除 locked 类)。

## 建议的代码改动 (没在这个 PR 里做，留给你判断)

只是 runbook 里提了一句，看你接不接：
- `src/runner.ts:8-13` 的 `DEFAULT_THRESHOLDS` 把 `minimumNetReturn` 默认从 0 改成 0.01
- `src/domain/loss-requires-strategy.ts` 把 `includeLocked` 默认从 true 改成 false
- `LiveLedger` 加 `dailyTradeCap` interlock

如果你觉得 random_control 这套思路有用，我朋友也愿意把他 bili_stock 项目里 9 个月跑出来的 6 类策略证伪方法移植过来 — `random_control` + `null_event_test` + `cost_consistency_audit` + ... 但那是后话，这个 PR 先把第一步打稳。

## 跑法

```bash
npm install
npm test                              # 141 pass

# random control (需要 uv: brew install uv)
cd analysis
uv sync
uv run python run_tier2.py            # Tier 2: 用现有 trades JSON
# Tier 3 需要重新抓 ~14 分钟
npx tsx fetch_event_markets.ts
uv run python fetch_universe_trades.py
uv run python run_tier3.py
```

## 一些 honest 数据局限

- 历史 Polymarket 成交没有逐秒比分流，回测用终场比分回放，所以 Tier 2 默认假定回放期间的 `lossRequiresGoals >= 2` 状态没变 — 实盘里 `time-window.ts:26` 的 365Scores verified clock 是必要约束，bot 本身已经在做。
- n=22-37 match-days 算大样本但不大。`spread_tight_loss_ge2` 的 CI 宽 ([+1.14, +33.86]) 说明 edge 真但量级不确定。
- Tier 3 universe 只包括 type-eligible 市场 (moneyline/spread/total/team_total/btts/draw)，没包括 "first scorer" 这种 prop。如果未来开 prop 市场，需要单独再做一遍。

干杯! 准备入金了。

— 一个 audit-纪律传教士

EOF
