# Last 3 Minutes Loss-Requires-2-Goals Review

更新时间：2026-06-23 Asia/Shanghai

## 1. 本次口径

这次只看最新统一策略：下注要输，必须之后发生至少 2 个不利进球，即 `lossRequiresGoals >= 2`。

最后 3 分钟窗口定义为终场前 180 秒内的 Polymarket BUY trades。收益继续使用 stake-based net ROI：

```text
net_roi = 1 / price - 1 - 0.03 * (1 - price)
```

价格对应：`0.99 -> 0.9801%`，`0.98 -> 1.9808%`，`0.97 -> 3.0028%`，`0.95 -> 5.1132%`。

新增数据文件：

- `data/loss_requires2_last180_strategy_rank.csv`：最后 180 秒策略排名。
- `data/loss_requires2_last180_all_candidates.csv`：最后 180 秒所有候选行，共 275 条。
- `data/loss_requires2_last180_opportunities_le_099.csv`：最后 180 秒最低价 `<=0.99` 的机会，共 52 条。

## 2. 最后 3 分钟非拼速主线策略排名

| 策略 | 样本 | 有成交 | <=0.99 | <=0.98 | <=0.97 | <=0.99 size | 最低价 | 最低价净ROI | 判断 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| total_under_loss_ge2 | 38 | 35 | 13 (34.21%) | 1 (2.63%) | 1 (2.63%) | 38376.22 | 0.95 | 5.1132% | 最后3分钟最稳的非拼速主线，<=0.99 样本最多，<=0.98 很少 |
| spread_tight_loss_ge2 | 40 | 29 | 11 (27.5%) | 3 (7.5%) | 3 (7.5%) | 88460.84832 | 0.85 | 17.1971% | 价格最好但方向复杂；适合作为第二主线，需要严格解析 |
| team_total_under_loss_ge2 | 36 | 18 | 5 (13.89%) | 1 (2.78%) | 1 (2.78%) | 497.33 | 0.96 | 4.0467% | 有少量高 ROI，但深度小 |
| draw_no_lead_ge2 | 19 | 11 | 2 (10.53%) | 0 (0.0%) | 0 (0.0%) | 39840.207827 | 0.9870000007046698 | 1.2781% | 2球领先可做，3分钟通常约1%左右 |
| leader_yes_lead_ge2 | 19 | 16 | 2 (10.53%) | 0 (0.0%) | 0 (0.0%) | 7607.31 | 0.989 | 1.0792% | 2球领先可做，3分钟通常约1%左右 |
| loser_no | 26 | 21 | 2 (7.69%) | 0 (0.0%) | 0 (0.0%) | 3227.76 | 0.99 | 0.9801% | 一球领先强队不输逻辑正确，但3分钟窗口肉最少 |

结论：最后 3 分钟里，真正还能稳定扫到肉的优先级是：

1. `total_under_loss_ge2`：样本最多，13/38 个样本最低价到过 `<=0.99`，但只有 1 个到过 `<=0.98`。
2. `spread_tight_loss_ge2`：价格最好，3 个到过 `<=0.98`，但必须严格解析盘口方向。
3. `team_total_under_loss_ge2`：有个别 4% 左右机会，但深度非常小。
4. `draw_no_lead_ge2` / `leader_yes_lead_ge2`：3 分钟窗口多为 1% 左右。
5. `loser_no`：逻辑覆盖“弱队落后 1 球，买弱队胜 No = 强队不输”，但最后 3 分钟通常已经太贵。

## 3. 最后 3 分钟非拼速机会清单（最低价 <= 0.99）

| 策略 | 比赛 | 比分 | 市场 | 买 | 输需球 | 最低价 | 净ROI | <=0.99 size | <=0.98 size |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| spread_tight_loss_ge2 | Ecuador vs. Curaçao | 0-0 | Spread: Ecuador (-1.5) | Curaçao | 2 | 0.85 | 17.1971% | 777.192 | 777.192 |
| total_under_loss_ge2 | Ecuador vs. Curaçao | 0-0 | Ecuador vs. Curaçao: O/U 1.5 | Under | 2 | 0.95 | 5.1132% | 2127.31 | 958.8 |
| spread_tight_loss_ge2 | Sweden vs. Tunisia | 5-1 | Spread: Sweden (-2.5) | Sweden | 2 | 0.96 | 4.0467% | 6409.427149 | 2382.134633 |
| team_total_under_loss_ge2 | Türkiye vs. Paraguay | 0-1 | Türkiye vs. Paraguay: Türkiye O/U 1.5 | Under | 2 | 0.96 | 4.0467% | 8.33 | 8.33 |
| spread_tight_loss_ge2 | Iraq vs. Norway | 1-4 | Spread: Norway (-1.5) | Norway | 2 | 0.97 | 3.0028% | 17899.819171 | 3138.098162 |
| spread_tight_loss_ge2 | Brazil vs. Haiti | 3-0 | Spread: Brazil (-4.5) | Haiti | 2 | 0.981 | 1.8798% | 279.33 | 0 |
| total_under_loss_ge2 | Germany vs. Curaçao | 7-1 | Germany vs. Curaçao: O/U 9.5 | Under | 2 | 0.981 | 1.8798% | 10.09 | 0 |
| draw_no_lead_ge2 | Austria vs. Jordan | 3-1 | Will Austria vs. Jordan end in a draw? | No | 2 | 0.9870000007046698 | 1.2781% | 6792.797827 | 0 |
| leader_yes_lead_ge2 | Austria vs. Jordan | 3-1 | Will Austria win on 2026-06-17? | Yes | 2 | 0.989 | 1.0792% | 5275.91 | 0 |
| spread_tight_loss_ge2 | United States vs. Paraguay | 4-1 | Spread: United States (-1.5) | United States | 2 | 0.99 | 0.9801% | 57280.27 | 0 |
| total_under_loss_ge2 | Spain vs. Cabo Verde | 0-0 | Spain vs. Cabo Verde: O/U 1.5 | Under | 2 | 0.99 | 0.9801% | 33479.94 | 0 |
| draw_no_lead_ge2 | Uzbekistan vs. Colombia | 1-3 | Will Uzbekistan vs. Colombia end in a draw? | No | 2 | 0.99 | 0.9801% | 33047.41 | 0 |
| spread_tight_loss_ge2 | Germany vs. Curaçao | 7-1 | Spread: Germany (-4.5) | Germany | 2 | 0.99 | 0.9801% | 3822.46 | 0 |
| loser_no | Germany vs. Côte d'Ivoire | 2-1 | Will Côte d'Ivoire win on 2026-06-20? | No | 2 | 0.99 | 0.9801% | 2527.76 | 0 |
| leader_yes_lead_ge2 | Uzbekistan vs. Colombia | 1-3 | Will Colombia win on 2026-06-17? | Yes | 2 | 0.99 | 0.9801% | 2331.4 | 0 |
| total_under_loss_ge2 | Canada vs. Qatar | 6-0 | Canada vs. Qatar: O/U 7.5 | Under | 2 | 0.99 | 0.9801% | 1325.54 | 0 |
| spread_tight_loss_ge2 | Brazil vs. Morocco | 1-1 | Spread: Brazil (-1.5) | Morocco | 2 | 0.99 | 0.9801% | 1000.0 | 0 |
| loser_no | Côte d'Ivoire vs. Ecuador | 1-0 | Will Ecuador win on 2026-06-14? | No | 2 | 0.99 | 0.9801% | 700.0 | 0 |
| spread_tight_loss_ge2 | Spain vs. Cabo Verde | 0-0 | Spread: Spain (-1.5) | Cabo Verde | 2 | 0.99 | 0.9801% | 662.23 | 0 |
| team_total_under_loss_ge2 | Spain vs. Cabo Verde | 0-0 | Spain vs. Cabo Verde: Spain O/U 1.5 | Under | 2 | 0.99 | 0.9801% | 438.45 | 0 |

这张表显示：如果只做最后 3 分钟，`<=0.98` 的非拼速机会很少，主要集中在 `spread_tight_loss_ge2` 和一个 `total_under_loss_ge2` 样本。`<=0.99` 的机会更多，但净 ROI 大约只有 0.98%。

## 4. “弱队落后 1 球，买强队不输”的最后 3 分钟结论

实盘表达应为：买弱队胜 `No`，不是买强队胜 `Yes`。弱队进 1 球只是打平，弱队必须再进 2 球反超才会输。

只看终场赢 1 球样本：

| 窗口 | 样本 | 有成交 | <=0.99 | <=0.98 | <=0.97 | <=0.99 size | 最低价 | 最低价净ROI |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 180s | 8 | 8 | 2 | 0 | 0 | 3227.76 | 0.99 | 0.9801% |
| 300s | 8 | 8 | 2 | 1 | 1 | 118628.286682 | 0.93 | 7.3169% |
| 480s | 8 | 8 | 5 | 1 | 1 | 231015.53892 | 0.9 | 10.8111% |

结论：这个策略逻辑正确，但如果只等最后 3 分钟，历史样本里最低只有 `0.99`，净 ROI 约 `0.98%`；5-8 分钟明显更有肉。

## 5. 已锁定类策略单独观察

这些不是“输需要 2 球”，而是条件已经达成后理论锁定，例如 total over 已经打出。它们最后 3 分钟数据很夸张，但更可能依赖进球后盘口更新延迟，应该单独作为速度型策略，不和主线混在一起。

| 策略 | 样本 | 有成交 | <=0.99 | <=0.98 | <=0.99 size | 最低价 | 最低价净ROI | 判断 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| total_over_locked | 37 | 33 | 11 (29.73%) | 6 (16.22%) | 410693.644416 | 0.04 | 2397.12% | 结果已锁类，数据显著但更像盘口更新延迟 |
| team_total_over_locked | 37 | 23 | 5 (13.51%) | 2 (5.41%) | 10964.046178 | 0.0839454094292804 | 1088.5022% | 结果已锁类，深度小于 total over locked |
| btts_yes_locked | 23 | 23 | 1 (4.35%) | 0 (0.0%) | 7548.47 | 0.99 | 0.9801% | 结果已锁类，3分钟仅少量 <=0.99 |

最后 3 分钟 locked 类前排样本：

| 策略 | 比赛 | 比分 | 市场 | 买 | 最低价 | 净ROI | <=0.99 size |
| --- | --- | --- | --- | --- | --- | --- | --- |
| total_over_locked | Iraq vs. Norway | 1-4 | Iraq vs. Norway: O/U 4.5 | Over | 0.04 | 2397.12% | 196265.122451 |
| total_over_locked | Uzbekistan vs. Colombia | 1-3 | Uzbekistan vs. Colombia: O/U 3.5 | Over | 0.05183895139668645 | 1826.2069% | 41762.403371 |
| total_over_locked | Sweden vs. Tunisia | 5-1 | Sweden vs. Tunisia: O/U 5.5 | Over | 0.05799995309564932 | 1621.3133% | 26664.048963 |
| total_over_locked | Switzerland vs. Bosnia-Herzegovina | 4-1 | Switzerland vs. Bosnia and Herzegovina: O/U 4.5 | Over | 0.07 | 1325.7814% | 83457.818283 |
| team_total_over_locked | Uzbekistan vs. Colombia | 1-3 | Uzbekistan vs. Colombia: Colombia O/U 2.5 | Over | 0.0839454094292804 | 1088.5022% | 1878.416664 |
| total_over_locked | Austria vs. Jordan | 3-1 | Austria vs. Jordan: O/U 3.5 | Over | 0.65 | 52.7962% | 37803.720848 |
| team_total_over_locked | Austria vs. Jordan | 3-1 | Austria vs. Jordan: Austria O/U 2.5 | Over | 0.69 | 43.9975% | 3774.629514 |
| total_over_locked | Qatar vs. Switzerland | 1-1 | Qatar vs. Switzerland: O/U 1.5 | Over | 0.98 | 1.9808% | 12311.0105 |
| btts_yes_locked | Qatar vs. Switzerland | 1-1 | Qatar vs. Switzerland: Both Teams to Score | Yes | 0.99 | 0.9801% | 7548.47 |
| total_over_locked | United States vs. Paraguay | 4-1 | United States vs. Paraguay: O/U 4.5 | Over | 0.99 | 0.9801% | 5794.42 |
| total_over_locked | Germany vs. Curaçao | 7-1 | Germany vs. Curaçao: O/U 7.5 | Over | 0.99 | 0.9801% | 3198.81 |
| team_total_over_locked | Netherlands vs. Japan | 2-2 | Netherlands vs. Japan: Japan O/U 1.5 | Over | 0.99 | 0.9801% | 2814.4 |

## 6. Bot 默认策略建议

最后 3 分钟默认只开这些：

```text
primary:
  total_under_loss_ge2 if ask <= 0.99
  spread_tight_loss_ge2 if ask <= 0.99 and parser_confidence == strict

secondary:
  team_total_under_loss_ge2 if ask <= 0.98 or size is acceptable
  draw_no_lead_ge2 if ask <= 0.99
  leader_yes_lead_ge2 if ask <= 0.99
  loser_no if ask <= 0.99

separate_speed_mode:
  total_over_locked
  team_total_over_locked
  btts_yes_locked
```

如果目标是 3%+ 净收益，最后 3 分钟应使用 `ask <= 0.97`；这个阈值下非拼速样本非常少。若目标是更多成交，`ask <= 0.99` 更现实，但单笔净 ROI 约 1%。

## 7. 数据限制

历史成交没有逐秒比分流，这里仍然用终场比分/最终市场结果回放最后 180 秒成交。实盘必须由 live score 在下单瞬间确认当前确实满足 `lossRequiresGoals >= 2`。
