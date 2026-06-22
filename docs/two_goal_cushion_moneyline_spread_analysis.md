# World Cup Two-Goal Cushion: Moneyline vs Spread Analysis

更新时间：2026-06-23 Asia/Shanghai

## 1. 口径修正

用户说的“净胜两球”不是“最终比分 margin = 2”，而是 **最后几分钟盘口还有 2 个球的冗余**。

需要分两类市场定义：

### Moneyline / 胜负线

买领先方 `Will Team win? = Yes`。

```text
moneyline_cushion = 当前领先球数
```

如果最后几分钟 2-0、3-1、4-2，领先方 moneyline 有 2 球 cushion。对手需要再进 2 球才会打平，使领先方 win=No。

### Spread / 让分线

买领先方让分盘口，例如 `Spain -1.5`。

```text
required_margin = abs(line) + 0.5
spread_cushion = 当前领先球数 - required_margin
```

例子：

| 当前比分 | 当前领先 | 盘口 | 盘口需要赢 | spread_cushion |
| --- | ---: | ---: | ---: | ---: |
| 2-0 | 2 | -1.5 | 2 | 0 |
| 3-0 | 3 | -1.5 | 2 | 1 |
| 4-0 | 4 | -1.5 | 2 | 2 |
| 4-0 | 4 | -2.5 | 3 | 1 |
| 4-0 | 4 | -3.5 | 4 | 0 |

所以之前“4-0 买 -3.5”不是 2 球冗余，而是 0 球冗余；“4-0 买 -1.5”才是 2 球冗余。

## 2. 收益计算口径

Polymarket sports taker fee 官方公式：

```text
fee = shares * feeRate * p * (1 - p)
```

其中 sports taker `feeRate = 0.03`。

如果投入 1u，以价格 `p` 买入并最终兑付 1：

```text
shares = 1 / p
payout_multiple = 1 / p
毛利润率 = 1 / p - 1
手续费占本金约 = 0.03 * (1 - p)
净利润率 = 1 / p - 1 - 0.03 * (1 - p)
```

例子：`p = 0.91` 时，1u 买入显示赢约 1.1u，这是总返还，不是纯利润。

```text
payout_multiple = 1 / 0.91 = 1.0989
净利润率约 = 9.62%
```

| 买入价 | 总返还倍数 | 扣 sports fee 后净 ROI |
| ---: | ---: | ---: |
| 0.91 | 1.0989x | 9.62% |
| 0.95 | 1.0526x | 5.11% |
| 0.97 | 1.0309x | 3.00% |
| 0.98 | 1.0204x | 1.98% |
| 0.99 | 1.0101x | 0.98% |
| 0.999 | 1.0010x | 0.097% |

## 3. 数据文件

本次新增/重算：

- `data/moneyline_last60_summary.csv`
- `data/moneyline_last60_trades.json`
- `data/spread_cushion2_last60_summary.csv`
- `data/spread_cushion2_last60_trades.json`
- `data/margin2_last60_summary.csv`
- `data/margin2_last60_trades_recheck.json`

代理：`http://127.0.0.1:10808`

数据源：

- Gamma event moneyline markets：`https://gamma-api.polymarket.com/events/slug/{event_slug}`
- More markets spreads：`https://gamma-api.polymarket.com/events/slug/{event_slug}-more-markets`
- Data API trades：`https://data-api.polymarket.com/trades?market={conditionId}&limit=1000&offset={offset}&takerOnly=false&side=BUY`

分页使用 `offset=0,1000,2000,3000`，避免热门市场最后 60 秒成交被最新成交挤掉。

## 4. Moneyline 最后 60 秒结论

筛选：世界杯已完赛、最终领先方 margin >= 2，买领先方 moneyline Yes。

结果：最后 60 秒有成交的 moneyline 基本全部是 `0.999`。

- `0.999` 扣费后净 ROI 约 `0.097%`。
- 没看到 `0.97~0.99` 这种 1%-3% 级别的最后 60 秒 moneyline 成交。
- Moneyline 符合“2 球领先低风险”，但可赚比率太低，接近 0.1%。

典型样本：

| 比赛 | 比分 | Moneyline | 最后60秒最低 BUY | 净 ROI |
| --- | --- | --- | ---: | ---: |
| Australia vs Türkiye | 2-0 | Australia Yes | 0.999 | 0.097% |
| Spain vs Saudi Arabia | 4-0 | Spain Yes | 0.999 | 0.097% |
| New Zealand vs Egypt | 1-3 | Egypt Yes | 0.999 | 0.097% |
| Argentina vs Algeria | 3-0 | Argentina Yes | 0.999 | 0.097% |

## 5. Spread 严格 2 球冗余最后 60 秒结论

筛选：对每场选“仍有 2 球 cushion 的最高让分线”。

规则：

```text
current_margin - required_margin >= 2
```

样本：

| 比赛 | 比分 | 选择盘口 | required_margin | cushion | 最后60秒最低 BUY | 净 ROI |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Germany vs Curaçao | 7-1 | Germany -3.5 | 4 | 2 | 0.999 | 0.097% |
| Sweden vs Tunisia | 5-1 | Sweden -1.5 | 2 | 2 | 0.999 | 0.097% |
| Canada vs Qatar | 6-0 | Canada -3.5 | 4 | 2 | 无 BUY | - |
| Netherlands vs Sweden | 5-1 | Netherlands -1.5 | 2 | 2 | 0.999 | 0.097% |
| Tunisia vs Japan | 0-4 | Japan -1.5 | 2 | 2 | 0.999 | 0.097% |
| Spain vs Saudi Arabia | 4-0 | Spain -1.5 | 2 | 2 | 无 BUY | - |

结论：严格 2 球冗余的 spread，也已经被市场定到 `0.999` 左右，最后 60 秒可赚比率仍然只有约 `0.1%`。

## 6. 为什么之前看起来有 2%-4%？

之前高收益样本主要来自 **0 球冗余** 或 **1 球冗余** 的 spread，而不是 2 球冗余。

例子：

| 比赛 | 比分 | 买入盘口 | 盘口需要赢 | cushion | 最后60秒最低 BUY | 净 ROI |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Australia vs Türkiye | 2-0 | Australia -1.5 | 2 | 0 | 0.96 | 4.05% |
| United States vs Australia | 2-0 | United States -1.5 | 2 | 0 | 0.97 | 3.00% |
| New Zealand vs Egypt | 1-3 | Egypt -1.5 | 2 | 0 | 0.97 | 3.00% |
| Mexico vs South Africa | 2-0 | Mexico -1.5 | 2 | 0 | 0.96 | 4.05% |

这些交易的逻辑是：当前刚好覆盖 `-1.5`，对手只要进 1 球就会输掉 spread，所以市场给了 3%-4% 的价格补偿。

这和“最后几分钟还有 2 球冗余”不是同一个策略。

## 7. 策略含义

如果坚持“最后几分钟还有 2 球冗余，几乎没风险”：

- Moneyline：价格基本 `0.999`，净 ROI 约 `0.097%`。
- Spread：选到仍有 2 球 cushion 的盘口，价格也基本 `0.999`，净 ROI 约 `0.097%`。
- 很难达到 2%-3%。

如果目标是 2%-4%：

- 需要买 0 球 cushion 或 1 球 cushion 的 spread；
- 或更早时间点买入，当市场还没完全 repricing；
- 这不是“2 球冗余无风险”策略。

## 8. 对代码的改法

原来的 `spread-selector` 选“最高仍被覆盖盘口”，例如 4-0 会选 `-3.5`。这适合找高 ROI，但不符合 2 球冗余。

应新增策略模式：

```text
mode = moneyline-two-goal-lead
  condition: current_margin >= 2
  market: winning team moneyline Yes

mode = spread-two-goal-cushion
  condition: current_margin - required_margin >= 2
  selection: highest spread with cushion >= 2

mode = spread-max-covered
  condition: required_margin <= current_margin
  selection: highest covered spread
  note: higher ROI, but cushion can be 0
```

验收时要分别输出：

```json
{
  "marketType": "moneyline",
  "cushionGoals": 2,
  "price": 0.999,
  "payoutMultiple": 1.001001,
  "netProfitRate": 0.000971
}
```

和：

```json
{
  "marketType": "spread",
  "line": -1.5,
  "requiredMargin": 2,
  "cushionGoals": 2,
  "price": 0.999,
  "payoutMultiple": 1.001001,
  "netProfitRate": 0.000971
}
```

## 9. 1/2/3/5/8 分钟窗口复算

新增全量分页复算文件：

- `data/two_goal_cushion_multiwindow_aggregate.csv`
- `data/two_goal_cushion_multiwindow_summary.csv`
- `data/two_goal_cushion_multiwindow_markets.json`
- `data/moneyline_last120_summary.csv`
- `data/moneyline_last120_trades.json`
- `data/spread_cushion2_last120_summary.csv`
- `data/spread_cushion2_last120_trades.json`

窗口：60、120、180、300、480 秒。

注意：Polymarket 历史数据没有逐分钟比分事件流。本节用终场 margin 和最终可覆盖盘口做市场成交复算；真正实盘触发仍必须用 live score 确认“当时确实还有 2 球冗余”。

### 9.1 聚合结果

| 市场组 | 窗口 | 样本数 | 有成交样本 | <=0.99 样本 | <=0.98 样本 | <=0.97 样本 | 最低价 | 最低价净 ROI |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Moneyline | 60s | 19 | 16 | 0 | 0 | 0 | 0.999 | 0.097% |
| Moneyline | 120s | 19 | 16 | 0 | 0 | 0 | 0.999 | 0.097% |
| Moneyline | 180s | 19 | 16 | 2 | 0 | 0 | 0.989 | 1.079% |
| Moneyline | 300s | 19 | 16 | 4 | 3 | 3 | 0.920 | 8.456% |
| Moneyline | 480s | 19 | 16 | 5 | 4 | 3 | 0.916 | 8.918% |
| Spread 2球冗余 | 60s | 6 | 4 | 0 | 0 | 0 | 0.999 | 0.097% |
| Spread 2球冗余 | 120s | 6 | 6 | 0 | 0 | 0 | 0.999 | 0.097% |
| Spread 2球冗余 | 180s | 6 | 6 | 0 | 0 | 0 | 0.999 | 0.097% |
| Spread 2球冗余 | 300s | 6 | 6 | 1 | 0 | 0 | 0.990 | 0.980% |
| Spread 2球冗余 | 480s | 6 | 6 | 2 | 0 | 0 | 0.990 | 0.980% |

### 9.2 3 分钟窗口

Moneyline 在 3 分钟窗口开始出现接近 1% 的机会，但不是 2%-3%：

| 比赛 | 比分 | 市场 | 最低价 | 净 ROI | <=0.99 size |
| --- | ---: | --- | ---: | ---: | ---: |
| Austria vs Jordan | 3-1 | Austria ML Yes | 0.989 | 1.079% | 5,275.91 |
| Uzbekistan vs Colombia | 1-3 | Colombia ML Yes | 0.990 | 0.980% | 2,331.40 |

Spread 2球冗余在 3 分钟窗口仍没有 `<=0.99` 的成交，最低还是 `0.999`。

### 9.3 5 分钟窗口

Moneyline 在 5 分钟窗口出现 2%-8% 的成交，但这需要 live score 二次确认当时是否已经有 2 球领先。

| 比赛 | 比分 | 市场 | 最低价 | 净 ROI | <=0.98 size | <=0.97 size |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| France vs Senegal | 3-1 | France ML Yes | 0.951 | 5.006% | 122,380.81 | 9,744.91 |
| Austria vs Jordan | 3-1 | Austria ML Yes | 0.960 | 4.047% | 21,628.40 | 6,869.84 |
| Uzbekistan vs Colombia | 1-3 | Colombia ML Yes | 0.920 | 8.456% | 56,711.91 | 54,435.67 |
| Australia vs Türkiye | 2-0 | Australia ML Yes | 0.990 | 0.980% | 0 | 0 |

Spread 2球冗余在 5 分钟窗口仍基本没有高收益；只有 Sweden -1.5 出现 `0.990`，净 ROI 约 `0.98%`。

### 9.4 8 分钟窗口

Moneyline 在 8 分钟窗口机会更多：

| 比赛 | 比分 | 市场 | 最低价 | 净 ROI | <=0.98 size | <=0.97 size |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| France vs Senegal | 3-1 | France ML Yes | 0.916 | 8.918% | 147,457.20 | 28,374.60 |
| Austria vs Jordan | 3-1 | Austria ML Yes | 0.930 | 7.317% | 72,162.45 | 57,403.89 |
| Uzbekistan vs Colombia | 1-3 | Colombia ML Yes | 0.920 | 8.456% | 87,989.53 | 85,713.30 |
| New Zealand vs Egypt | 1-3 | Egypt ML Yes | 0.980 | 1.981% | 51,390.52 | 0 |

Spread 2球冗余在 8 分钟窗口仍只到约 `0.99`：

| 比赛 | 比分 | 市场 | 最低价 | 净 ROI | <=0.99 size |
| --- | ---: | --- | ---: | ---: | ---: |
| Germany vs Curaçao | 7-1 | Germany -3.5 | 0.990 | 0.980% | 376.07 |
| Sweden vs Tunisia | 5-1 | Sweden -1.5 | 0.990 | 0.980% | 5,089.03 |

### 9.5 实操结论

- 最后 1-2 分钟：2球冗余市场基本都已经到 `0.999`，只能赚约 `0.1%`。
- 最后 3 分钟：moneyline 偶尔有约 `1%`，spread 2球冗余仍没有明显机会。
- 最后 5-8 分钟：moneyline 可能出现 `2%-8%`，但必须用 live score 验证当时是否已经领先 2 球；仅靠终场比分不能证明。
- 如果目标是稳定 2%-3% 且坚持 2球冗余，重点应该从最后 60 秒改成最后 5-8 分钟，并优先看 moneyline，而不是 spread。
