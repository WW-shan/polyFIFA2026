# Polymarket World Cup 单场 Spreads 尾盘机会研究

更新时间：2026-06-22 22:55 Asia/Shanghai  
项目目录：`/Users/ww/Project/polyFIFA2026`

## 1. 一句话结论

这次讨论的机会不是 World Cup futures，也不是 Moneyline，而是 **世界杯单场比赛的 Spreads / 让球盘尾盘交易**：

- 比赛临近结束，通常是 88 分钟以后、90 分钟补时、或终场前 1-2 分钟；
- 当前比分已经让领先方覆盖某条 spread；
- Polymarket 上对应 spread outcome 价格还没有完全回到 `0.995~0.999`；
- 买覆盖方，等待比赛结束兑付 `1.00`。

最典型盘口选择：

| 当前净胜 | 应重点看 | 原因 |
| --- | --- | --- |
| 净胜 2 球 | `winner -1.5` | 最小覆盖盘口，通常成交最多 |
| 净胜 3 球 | `winner -2.5` | 比 `-1.5` 更可能还没完全归 1 |
| 净胜 4 球 | `winner -3.5` | `-1.5/-2.5` 往往已经太贵 |
| 净胜 5+ 球 | `winner -4.5/-5.5` | 高盘口可能还有滞后价格 |

## 2. 重要修正

之前一开始把“所有已完赛世界杯 spread”都当作同质样本是不够精确的。后面重新分了两层：

1. **price-history 回测**：CLOB `/prices-history` 返回的分钟价格曲线。它能说明当时价格曲线存在，但不等价于可成交深度。
2. **actual trades 回测**：Data API `/trades` 的逐笔成交，过滤终场前 60 秒、买入 winning outcome 的成交。这个更接近“真的有人能买到”。

实际发现：

- `prices-history` 中最后一分钟看到 `0.97~0.98` 的场次更多；
- 但逐笔成交验证后，真正最后 60 秒有 `0.97~0.98` BUY 成交的样本更少；
- 很多比赛最后 60 秒实际成交已经是 `0.999`，只剩约 `0.1%`；
- **2-3% 机会更多出现在终场前 2-8 分钟，或补时刚公布、盘口还没完全反应的时候**，不一定严格是最后 60 秒。

用户截图里“昨天晚上手动试过，赚了 3%”如果指 Spain 4-0 Saudi Arabia 的 `Spain -3.5`，逐笔成交显示 `0.97` 附近成交发生在终场前约 7 分半，而最后 60 秒实际 BUY 是 `0.999`。如果指 Egypt 3-1 New Zealand 的 `Egypt -1.5`，price-history 最后 60 秒有 `0.98`，但逐笔成交没有看到最后 60 秒 BUY 成交。

## 3. 世界杯时间与样本范围

世界杯正赛从 **2026-06-11** 开始。

本次已抓数据范围：

- Polymarket series：`soccer-fifwc`
- 已完赛单场 match event：40 场
- 过滤条件：event slug 以 `YYYY-MM-DD` 结尾，排除 `halftime-result`、`exact-score` 等子事件
- 最终净胜 `>= 2` 的候选：19 场
- 数据保存：
  - `data/poly_tail_backtest.json`
  - `data/poly_tail_trades_backtest.json`
  - `data/price_history_summary.csv`
  - `data/trades_summary.csv`

## 4. 数据源与 API

### 4.1 Polymarket 官方文档

- API 总览：<https://docs.polymarket.com/api-reference/introduction>
- Market data overview：<https://docs.polymarket.com/market-data/overview>
- Gamma list markets：<https://docs.polymarket.com/api-reference/markets/list-markets>
- CLOB prices history：<https://docs.polymarket.com/api-reference/markets/get-prices-history>
- Data API trades：<https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets.md>
- Fees：<https://docs.polymarket.com/trading/fees>
- Geoblock：<https://docs.polymarket.com/api-reference/geoblock>

### 4.2 实际用到的 API

Gamma API：发现 event / market / token。

```bash
https://gamma-api.polymarket.com/events?series_slug=soccer-fifwc&closed=true&limit=500
https://gamma-api.polymarket.com/markets/{market_id}
```

Polymarket 页面 Next.js state：用来稳定提取每场的 spread market 列表。页面里的 `initialState` 是 base64 + zlib 压缩 JSON。

```bash
https://polymarket.com/sports/world-cup/{event_slug}
```

CLOB prices history：查询 token 的历史价格曲线。

```bash
https://clob.polymarket.com/prices-history?market={clob_token_id}&startTs={ts}&endTs={ts}&fidelity=1
```

Data API trades：查询逐笔成交。注意这里 `market` 参数传 **conditionId**，不是 token id。

```bash
https://data-api.polymarket.com/trades?market={conditionId}&limit=10000&takerOnly=false&side=BUY
```

### 4.3 代理

本地直接访问 Polymarket API 会超时，用户提供代理后可用：

```bash
http://127.0.0.1:10808
socks5h://127.0.0.1:10808
```

已验证 HTTP proxy 可用：

```bash
curl -x http://127.0.0.1:10808 \
  'https://gamma-api.polymarket.com/events/slug/fifwc-esp-ksa-2026-06-21'
```

## 5. 手续费与收益计算

Polymarket sports taker fee rate：`0.03`。官方公式：

```text
fee = shares * feeRate * p * (1 - p)
```

买入价为 `p`，最终兑付 `1.00`，单 share 成本为 `p + fee`，收益率约：

```text
net_return = (1 - p - 0.03 * p * (1 - p)) / p
```

常见价格对应收益：

| 买入价 p | 扣 sports taker fee 后净收益 |
| --- | ---: |
| 0.999 | ~0.097% |
| 0.995 | ~0.488% |
| 0.990 | ~0.980% |
| 0.980 | ~1.981% |
| 0.970 | ~3.003% |
| 0.960 | ~4.047% |
| 0.950 | ~5.113% |

所以用户说“0.97 左右赚 3 个点”与手续费公式吻合。

## 6. Price-history 回测结论

口径：

- 每场选两种盘口：
  - `max_covered`：最终仍被覆盖的最高盘口，例如 4-0 选 `-3.5`；
  - `minus_1_5`：只看 `-1.5`，即最保守盘口；
- 回放 `finishedTimestamp - 60s` 到 `finishedTimestamp`；
- `last_p_60` 是最后 60 秒窗口内最后一个 price-history 点；
- `min_p_120` 是最后 120 秒窗口内最低 price-history 点。

### 6.1 最后 60 秒 price-history 有 2% 左右或以上的样本

| 比赛 | 比分 | 盘口 | last_p_60 | 净收益 | 备注 |
| --- | --- | --- | ---: | ---: | --- |
| Australia vs Türkiye | 2-0 | Australia -1.5 | 0.965 | 3.52% | price-history 显示尾盘明显滞后 |
| Iraq vs Norway | 1-4 | Norway -2.5 | 0.965 | 3.52% | price-history 与 trades 都支持有机会 |
| Mexico vs South Africa | 2-0 | Mexico -1.5 | 0.975 | 2.49% | price-history 支持，最后 60 秒 trades 未见 BUY |
| New Zealand vs Egypt | 1-3 | Egypt -1.5 | 0.980 | 1.98% | 昨天样本，price-history 支持，trades 未见最后 60 秒 BUY |

### 6.2 最后 120 秒 price-history 有 2%+ 的样本

| 比赛 | 比分 | 盘口 | min_p_120 | 净收益 |
| --- | --- | --- | ---: | ---: |
| Switzerland vs Bosnia-Herzegovina | 4-1 | Switzerland -2.5 | 0.732 | 35.81% |
| Australia vs Türkiye | 2-0 | Australia -1.5 | 0.890 | 12.03% |
| Netherlands vs Sweden | 5-1 | Netherlands -3.5 | 0.940 | 6.20% |
| Brazil vs Haiti | 3-0 | Brazil -2.5 | 0.943 | 5.87% |
| Mexico vs South Africa | 2-0 | Mexico -1.5 | 0.957 | 4.36% |
| Iraq vs Norway | 1-4 | Norway -2.5 | 0.965 | 3.52% |
| Argentina vs Algeria | 3-0 | Argentina -2.5 | 0.970 | 3.00% |
| United States vs Australia | 2-0 | United States -1.5 | 0.975 | 2.49% |
| New Zealand vs Egypt | 1-3 | Egypt -1.5 | 0.975 | 2.49% |

解释：最后 120 秒明显比最后 60 秒机会多，说明“严格最后一分钟”会错过大量收益；尾盘触发时间应考虑 `T-8min ~ T-0min`，而不是只盯最后 60 秒。

## 7. Actual trades 回测结论

口径：

- 查询 Data API `/trades`；
- `market={conditionId}`；
- `takerOnly=false`；
- `side=BUY`；
- 过滤：
  - `asset == winning outcome token`
  - `outcome == winner team`
  - `timestamp` 在 `finishedTimestamp - 60s` 到 `finishedTimestamp` 之间

注意：Data API 一笔成交通常有 BUY/SELL 两条记录，使用 `side=BUY` 避免重复统计方向，但仍需理解这是成交记录，不是完整 orderbook depth。

### 7.1 最后 60 秒实际 BUY 成交有 2%+ 的样本

| 比赛 | 比分 | 盘口 | 最低成交价 | 估算净收益 | BUY size | 成交笔数 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Iraq vs Norway | 1-4 | Norway -2.5 | 0.950 | 5.11% | 17,980 | 133 |
| Australia vs Türkiye | 2-0 | Australia -1.5 | 0.960 | 4.05% | 3,676 | 19 |
| United States vs Australia | 2-0 | United States -1.5 | 0.970 | 3.00% | 4,909 | 12 |
| Argentina vs Algeria | 3-0 | Argentina -2.5 | 0.980 | 1.98% | 2,772 | 6 |

另外 `France vs Senegal 3-1 / France -1.5` 的 Data API 显示最后 60 秒最低 BUY `0.1`、size `27,662`，但这与 price-history 的 `0.9945` 冲突，暂时标记为异常，需要二次人工验证，不能直接纳入稳定策略判断。

### 7.2 昨天 2026-06-21 的三场候选

| 比赛 | 比分 | 盘口 | price-history last 60s | trades last 60s | 结论 |
| --- | --- | --- | ---: | --- | --- |
| Tunisia vs Japan | 0-4 | Japan -3.5 | 0.9955 | 无最后 60 秒 BUY | 没有 2-3% 逐笔证据 |
| Tunisia vs Japan | 0-4 | Japan -1.5 | 0.9995 | BUY 0.999，size 260.89 | 太贵，只约 0.1% |
| Spain vs Saudi Arabia | 4-0 | Spain -3.5 | 0.9945 | BUY 0.999，size 758.03 | 最后 60 秒无 3%；0.97 出现在约 T-7.5min |
| Spain vs Saudi Arabia | 4-0 | Spain -1.5 | 0.9995 | 无最后 60 秒 BUY | 太贵 |
| New Zealand vs Egypt | 1-3 | Egypt -1.5 | 0.980 | 无最后 60 秒 BUY | 价格曲线有 2%，但没看到最后 60 秒成交 |

## 8. 机会在哪里

真正值得监控的不是所有盘口，而是：

1. **当前净胜正好覆盖最高有效盘口**
   - 4-0 看 `-3.5`，不要看 `-1.5`；
   - 3-0 看 `-2.5`；
   - 2-0 看 `-1.5`。

2. **盘口刚从不稳变稳的时间段**
   - 通常在 80’ 以后到补时结束；
   - 特别是补时公布后，市场还没完全回到 `0.999` 的几分钟；
   - 逐笔回测显示机会经常在最后 2-8 分钟，而不是严格最后 60 秒。

3. **高盘口比低盘口更可能有滞后**
   - 比如 4-0 的 `-3.5` 比 `-1.5` 更有可能还在 `0.97~0.995`；
   - `-1.5` 经常很早就 `0.999`。

4. **成交量与价格要同时看**
   - `price-history` 有价不等于能买到量；
   - `trades` 有成交说明至少有人买到；
   - 真正自动化还要接 live orderbook 看 ask depth。

## 9. 当前回测的局限

1. **price-history 不是 orderbook depth**
   - 只能说明价格曲线，不说明盘口有多少 size 可吃。

2. **Data API trades 不是完整盘口快照**
   - 有成交才看得到；没有成交不代表没有挂单。

3. **finishedTimestamp 不一定等于实际可交易截止秒**
   - 某些市场在终场后仍可能有成交/结算期成交；
   - 回测时只取 `finishedTimestamp - 60s` 到 `finishedTimestamp`，但实际 bot 应以 live clock / official match status 为准。

4. **France vs Senegal 出现异常 trade 数据**
   - trades 显示 `France -1.5` 最后 60 秒有 `0.1` 大量 BUY；
   - price-history 同窗口显示约 `0.9945`；
   - 该样本需要单独查 transaction/orderbook，不应直接作为策略收益依据。

5. **地域限制**
   - Polymarket 官方有 geoblock 文档；不要做绕过限制相关逻辑。本文只记录数据研究与技术接口。

## 10. 下一步 agent 接手建议

### 10.1 先读这些文件

```text
docs/worldcup_tail_spread_research.md
data/poly_tail_backtest.json
data/poly_tail_trades_backtest.json
data/price_history_summary.csv
data/trades_summary.csv
```

### 10.2 推荐实现方向

自动监控器应做四件事：

1. **赛程/市场发现**
   - Gamma events：找 `series_slug=soccer-fifwc` 的 live/upcoming events；
   - Polymarket page initialState：提取 `spreads` 列表、market id、clobTokenIds、conditionId。

2. **实时比分/比赛时间**
   - 使用可靠 live score 源；
   - 至少需要：当前比分、比赛分钟、补时时间、比赛是否即将结束。

3. **目标盘口选择**
   - `margin = abs(home_goals - away_goals)`；
   - 选择 `line_abs < margin` 且最接近 margin 的最高盘口；
   - 例如 margin=4 选 `-3.5`。

4. **盘口价格/深度判断**
   - CLOB `/book` 或 websocket market channel 读取 best ask 和 size；
   - 若 best ask <= 阈值，例如 `0.98` 或 `0.99`，再根据 size 估算可买金额；
   - 不能只用 price-history 做实时决策。

### 10.3 关键阈值建议

用于研究，不是最终交易建议：

```text
watch_start_minute = 82
strong_watch_minute = 88
entry_price_max_for_3pct = 0.97
entry_price_max_for_2pct = 0.98
entry_price_max_for_1pct = 0.99
minimum_depth_usdc = 视资金而定
```

按回测看，如果只等最后 60 秒和 `0.97~0.98`，机会不多；如果从 82-90+ 分钟开始监控更现实。

## 11. 可复用命令

通过代理拉世界杯已完赛 event：

```bash
curl -x http://127.0.0.1:10808 \
  -G 'https://gamma-api.polymarket.com/events' \
  --data-urlencode 'series_slug=soccer-fifwc' \
  --data-urlencode 'closed=true' \
  --data-urlencode 'limit=500'
```

查询单个 market：

```bash
curl -x http://127.0.0.1:10808 \
  'https://gamma-api.polymarket.com/markets/2585405'
```

查询 token price history：

```bash
curl -x http://127.0.0.1:10808 \
  -G 'https://clob.polymarket.com/prices-history' \
  --data-urlencode 'market=95451333954242013873964294785874587472204608914494242676636160307379359090814' \
  --data-urlencode 'startTs=1782064786' \
  --data-urlencode 'endTs=1782064906' \
  --data-urlencode 'fidelity=1'
```

查询逐笔成交，注意 `market` 是 conditionId：

```bash
curl -x http://127.0.0.1:10808 \
  -G 'https://data-api.polymarket.com/trades' \
  --data-urlencode 'market=0x86fc2f4dc631cc096262b8ae9873d993318703ac3cb307f53b05a311e3e90ed7' \
  --data-urlencode 'limit=10000' \
  --data-urlencode 'takerOnly=false' \
  --data-urlencode 'side=BUY'
```

## 12. 目前最重要的结论给下一个 agent

如果下一个 agent 只看一段话，看这里：

> 用户要做的是 Polymarket 世界杯单场 Spreads 尾盘自动识别。机会不是 futures，也不是 moneyline，而是比赛末段领先方已经覆盖 `-1.5/-2.5/-3.5` 等 spread，但 CLOB 价格还停在 `0.97~0.99`。回测显示，最终结果层 19/19 净胜 2+ 都命中；但真实最后 60 秒可成交的 2-3% 机会并不是每场都有。更可靠的触发窗口应从 82-88 分钟开始，重点监控“最高仍覆盖盘口”的 best ask 和 depth，而不是严格只等最后一分钟。手续费公式已验证，0.97 约等于 3% 净收益，0.98 约等于 2% 净收益。使用代理 `http://127.0.0.1:10808` 可访问 Gamma/CLOB/Data API。已有数据文件在 `data/`，核心研究文档就是本文件。

## 12. 2026-06-23 实时数据源补充

详细调查与测试计划见：`docs/polymarket_live_sports_data.md`。重点结论：Polymarket 页面确实使用官方 `wss://sports-api.polymarket.com/ws` 实时体育 WebSocket；可以拿到 `score / period / elapsed / live / ended`，但没有补时总分钟字段。2026-06-25 已确认 365Scores 公开网页单场接口能用 `addedTime + preciseGameTime` 严格计算最后 3 分钟；实盘逻辑应只在该严格时钟给出 `remainingSeconds <= 180` 时开单。
