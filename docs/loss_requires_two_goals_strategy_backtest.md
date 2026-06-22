# Loss-Requires-2-Goals Strategy Backtest

更新时间：2026-06-23 Asia/Shanghai

## 1. 这次的正确口径

用户说的“1 个球也可以，买不胜”说明策略不是简单的“当前领先 2 球”，而是：

```text
下注要输，必须之后再发生至少 2 个不利进球。
```

也就是 `loss_requires_goals >= 2`。

例子：

| 场景 | 买什么 | 为什么输需要 2 球 |
| --- | --- | --- |
| A 领先 B 1 球 | 买 B 胜 No | B 进 1 球只是打平；B 要再进 2 球才会赢 |
| A 领先 B 2 球 | 买 A 胜 Yes | B 进 1 球 A 仍赢；B 进 2 球打平，A 胜才输 |
| A 领先 B 2 球 | 买平局 No | B 进 1 球还不是平；B 进 2 球才会平 |
| 当前总进球 4 | 买 Under 5.5 | 再进 1 球仍 under；再进 2 球才 over |
| 4-0 | 买 A -2.5 | 对手进 1 球仍赢 3 球；对手进 2 球盘口才输 |

## 2. 回测数据

新增文件：

- `data/loss_requires2_strategy_candidates.json`：所有候选市场。
- `data/loss_requires2_strategy_multiwindow_summary.csv`：逐市场、逐窗口成交统计。
- `data/loss_requires2_strategy_multiwindow_aggregate.csv`：按策略聚合。
- `data/loss_requires2_strategy_multiwindow_trades.json`：逐笔窗口成交。
- `data/loser_no_multiwindow_summary.csv`：落后方胜 No 的专项统计。
- `data/loser_no_multiwindow_aggregate.csv`：落后方胜 No 聚合。
- `data/loser_no_multiwindow_trades.json`：落后方胜 No 逐笔窗口成交。

窗口：60、120、180、300、480 秒。

价格收益用 stake-based net ROI：

```text
net_roi = 1 / price - 1 - 0.03 * (1 - price)
```

## 3. 尝试过的策略

### A. `loser_no`

领先方只领先 1 球也可用：买落后方胜 No。

```text
loss_requires_goals = 当前领先球数 + 1
```

如果只领先 1 球，落后方要连进 2 球才会赢。

### B. `leader_yes_lead_ge2`

领先方领先至少 2 球：买领先方 Moneyline Yes。

```text
loss_requires_goals = 当前领先球数
```

### C. `draw_no_lead_ge2`

领先方领先至少 2 球：买平局 No。

```text
loss_requires_goals = 当前领先球数
```

### D. `spread_tight_loss_ge2`

在 spread 里选最紧但仍满足 `loss_requires_goals >= 2` 的一侧。

例子：

- 4-0 买 `leader -2.5`，对手进 1 球仍赢盘口，对手进 2 球才输。
- 0-0 买 `underdog +1.5`，热门队要进 2 球才输。Polymarket 表示上经常是买 `favorite -1.5` 市场里的另一侧 outcome。

### E. `total_under_loss_ge2`

总进球 Under，且当前/最终总进球距离 over 至少还差 2 球。

例子：当前总进球 4，买 `Under 5.5`，再进 2 球才输。

### F. `team_total_under_loss_ge2`

球队总进球 Under，且该队还要再进 2 球才会 over。

例子：某队 0 球，买该队 `Under 1.5`。

### G. Locked 类策略

包括：

- `total_over_locked`
- `team_total_over_locked`
- `btts_yes_locked`

这些不是“输需要 2 球”，而是如果当时已经达成条件就理论上不会再输。它们有时出现极低价，但很可能发生在进球刚出现、市场尚未更新时，速度要求更高，需要单独处理。

## 4. 聚合结果重点

### 4.1 `loser_no`：一球领先买落后方不胜

| 窗口 | 样本 | 有成交 | <=0.99 样本 | <=0.98 样本 | <=0.97 样本 | 最低价 | 净 ROI |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 60s | 26 | 18 | 0 | 0 | 0 | 0.999 | 0.097% |
| 120s | 26 | 20 | 1 | 0 | 0 | 0.990 | 0.980% |
| 180s | 26 | 21 | 2 | 0 | 0 | 0.990 | 0.980% |
| 300s | 26 | 22 | 2 | 1 | 1 | 0.930 | 7.317% |
| 480s | 26 | 23 | 6 | 1 | 1 | 0.900 | 10.811% |

主要机会：

| 窗口 | 比赛 | 市场 | 最低价 | 净 ROI | <=0.98 size |
| ---: | --- | --- | ---: | ---: | ---: |
| 300s | Germany vs Côte d'Ivoire 2-1 | Côte d'Ivoire win No | 0.930 | 7.317% | 48,357.32 |
| 480s | Germany vs Côte d'Ivoire 2-1 | Côte d'Ivoire win No | 0.900 | 10.811% | 132,481.92 |

结论：最后 1-3 分钟肉不多；5-8 分钟可能有肉，但样本集中，需要 live score 证明当时确实只领先 1 球且落后方要反超才输。

### 4.2 `leader_yes_lead_ge2`：领先 2 球买领先方胜

| 窗口 | 样本 | <=0.99 样本 | <=0.98 样本 | <=0.97 样本 | 最低价 | 净 ROI |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 60s | 19 | 0 | 0 | 0 | 0.999 | 0.097% |
| 120s | 19 | 0 | 0 | 0 | 0.999 | 0.097% |
| 180s | 19 | 2 | 0 | 0 | 0.989 | 1.079% |
| 300s | 19 | 4 | 3 | 3 | 0.920 | 8.456% |
| 480s | 19 | 5 | 4 | 3 | 0.916 | 8.918% |

5-8 分钟比 1-2 分钟明显更有价值。

### 4.3 `draw_no_lead_ge2`：领先 2 球买平局 No

| 窗口 | 样本 | <=0.99 样本 | <=0.98 样本 | <=0.97 样本 | 最低价 | 净 ROI |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 60s | 19 | 0 | 0 | 0 | 0.999 | 0.097% |
| 120s | 19 | 2 | 0 | 0 | 0.989 | 1.079% |
| 180s | 19 | 2 | 0 | 0 | 0.987 | 1.278% |
| 300s | 19 | 3 | 3 | 3 | 0.930 | 7.317% |
| 480s | 19 | 4 | 3 | 3 | 0.910 | 9.620% |

`draw No` 和 `leader Yes` 很像，有时 `draw No` 更便宜，因为它只怕打平，不怕反超；在领先 2 球时，打平需要 2 球。

### 4.4 `spread_tight_loss_ge2`：最高安全 spread / 让分另一侧

| 窗口 | 样本 | <=0.99 样本 | <=0.98 样本 | <=0.97 样本 | 最低价 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 60s | 40 | 5 | 0 | 0 | 0.990 |
| 120s | 40 | 10 | 2 | 2 | 0.850 |
| 180s | 40 | 11 | 3 | 3 | 0.850 |
| 300s | 40 | 15 | 6 | 5 | 0.130 |
| 480s | 40 | 21 | 15 | 9 | 0.130 |

这个策略数据最“有肉”，但也最需要清洗：

- 它会选 `favorite -1.5` 的另一侧，即等价于 underdog `+1.5`。
- 平局时买 underdog `+1.5`，热门队需要进 2 球才输。
- 个别 `0.13` 这种价格很可能是比分/盘口状态变化前后的异常或方向理解需要人工复核，不能直接当稳定机会。

比较可信的样本：

| 窗口 | 比赛 | 市场 | 最低价 | 净 ROI |
| ---: | --- | --- | ---: | ---: |
| 180s | Sweden vs Tunisia 5-1 | Sweden -2.5 | 0.960 | 4.047% |
| 180s | Iraq vs Norway 1-4 | Norway -1.5 | 0.970 | 3.003% |
| 480s | Sweden vs Tunisia 5-1 | Sweden -2.5 | 0.840 | 18.568% |
| 480s | Iraq vs Norway 1-4 | Norway -1.5 | 0.930 | 7.317% |

### 4.5 `total_under_loss_ge2`：总进球 Under，还有 2 球才输

这是目前最值得重点看的一类。

| 窗口 | 样本 | 有成交 | <=0.99 样本 | <=0.98 样本 | <=0.97 样本 | 最低价 | 净 ROI |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 60s | 38 | 33 | 4 | 0 | 0 | 0.990 | 0.980% |
| 120s | 38 | 35 | 9 | 1 | 1 | 0.950 | 5.113% |
| 180s | 38 | 35 | 13 | 1 | 1 | 0.950 | 5.113% |
| 300s | 38 | 36 | 25 | 13 | 5 | 0.910 | 9.620% |
| 480s | 38 | 37 | 31 | 27 | 18 | 0.781 | 27.384% |

典型机会：

| 窗口 | 比赛 | 市场 | 最低价 | 净 ROI | <=0.98 size |
| ---: | --- | --- | ---: | ---: | ---: |
| 300s | Spain vs Saudi Arabia 4-0 | Under 5.5 | 0.910 | 9.620% | 5,215.17 |
| 300s | Canada vs Qatar 6-0 | Under 7.5 | 0.939 | 6.313% | 3,336.39 |
| 480s | Spain vs Saudi Arabia 4-0 | Under 5.5 | 0.781 | 27.384% | 40,143.12 |
| 480s | Canada vs Qatar 6-0 | Under 7.5 | 0.800 | 24.400% | 14,131.82 |
| 480s | Mexico vs South Africa 2-0 | Under 3.5 | 0.930 | 7.317% | 8,211.22 |

这个策略符合“再进 2 球才输”，而且比 moneyline 更容易有价格滞后。

### 4.6 `team_total_under_loss_ge2`：球队总进球 Under，还有 2 球才输

| 窗口 | 样本 | <=0.99 样本 | <=0.98 样本 | <=0.97 样本 | 最低价 | 净 ROI |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 60s | 36 | 2 | 0 | 0 | 0.990 | 0.980% |
| 120s | 36 | 3 | 0 | 0 | 0.990 | 0.980% |
| 180s | 36 | 5 | 1 | 1 | 0.960 | 4.047% |
| 300s | 36 | 6 | 4 | 2 | 0.960 | 4.047% |
| 480s | 36 | 9 | 6 | 3 | 0.890 | 12.030% |

有机会，但成交深度比总进球 Under 小很多。

## 5. 排序结论

按“输需要 2 球 + 有肉 + 不太依赖极限速度”排序：

1. **总进球 Under，loss_requires >= 2**
   - 最值得做。
   - 5-8 分钟窗口机会明显。
   - 逻辑简单：当前总进球距离 over 还差 2 球。

2. **落后方胜 No**
   - 适合 1 球领先。
   - 最后 5-8 分钟可能有高 ROI。
   - 1-2 分钟通常已经太贵。

3. **领先方胜 Yes / 平局 No**
   - 适合 2 球领先。
   - 3 分钟开始有约 1%，5-8 分钟更明显。

4. **Spread 最高安全线 / underdog +1.5**
   - 理论机会很多。
   - 但盘口方向复杂，异常价较多，必须做严格 market parser 和 live score 验证。

5. **球队总进球 Under**
   - 逻辑好，但样本深度小。

6. **已锁定 Over / BTTS Yes**
   - 数据里有离谱高 ROI。
   - 这类通常是进球后市场没更新，速度要求高，不符合“不拼速度”的主线，暂不优先。

## 6. 对 bot 的策略模式建议

新增统一字段：

```ts
lossRequiresGoals: number
```

优先实现这些 mode：

```text
mode = total-under-loss-ge2
  condition: line_floor + 1 - current_total_goals >= 2
  buy: Under

mode = loser-no-loss-ge2
  condition: current_margin >= 1
  buy: trailing_team_moneyline No

mode = leader-yes-loss-ge2
  condition: current_margin >= 2
  buy: leading_team_moneyline Yes

mode = draw-no-loss-ge2
  condition: current_margin >= 2
  buy: draw No

mode = spread-tight-loss-ge2
  condition: selected spread outcome loses only after >=2 adverse goals
  buy: highest ROI candidate after strict parser validation
```

推荐默认窗口：

```text
watchStartSeconds = 480
primaryDecisionWindow = 300
```

最后 60-120 秒太晚，市场基本归 0.999。

## 7. 重要限制

历史 Polymarket 成交没有逐秒比分流。这里用终场比分和最终市场结果回放成交窗口，所以 5-8 分钟窗口必须在实盘里用 live score 校验：

```text
成交发生当时，是否已经满足 lossRequiresGoals >= 2。
```

没有这个校验，不能把所有 5-8 分钟低价都当成真实可执行策略收益。
