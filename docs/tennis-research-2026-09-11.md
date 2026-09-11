# 网球优先：真实数据、首轮挂单筛选和当前边界

日期：2026-09-11，Asia/Shanghai。目标是收集当时的公开盘口、成交和比赛上下文，优化提前挂单的入场时间、挂单价与数量；不沿用世界杯吃单逻辑，也不把 0.70 固化为采集条件。

## 这次已得到什么

1. 修正网球日期漏采：新增 `game-start` 模式和 `collect:tennis`。部分比赛的 `endDate` 比比赛晚七天；新模式按 `startTime` / `gameStartTime` 筛选，并保留直播中、开赛时间未知的事件。真实目录扫描得到 56 个范围内事件，包含 10 个缺事件级 startTime 的事件；这不是 56 场确认正在进行的比赛。
2. 已下载 30 场网球、493 个盘口、12,978 条公开逐笔成交；双方 outcome、token、规则和明确结算支付一并保留。下载器按时间窗口翻页，保存每个请求、原始响应、错误及完整性状态。
3. 已运行价格网格和两种入场方式，输出逐试验 CSV、参数汇总 CSV、JSON 及输入文件哈希。不同价格、窗口、订单量可重跑；零成交和缺数据不混为一类。
4. 90 秒公开实采保存 23,404 条原始日志，回放出 44,978 条盘口记录、37 笔成交、69 条 Sports 消息。没有提交任何交易，没有启动常驻服务。

## 本地证据位置

以下相对仓库根目录；原始数据和输出已加入 Git 忽略，不随代码提交。

- 历史输入：[dataset.json](../data/research/tennis-20260911-v1/dataset.json)。同目录 `raw/` 保留 HTTP 请求、查询上下界和完整响应，`manifest.json` 为下载完成记录。
- 终场相对窗口：[参数汇总](../data/research/tennis-20260911-v1/backtest-tail/summary.csv)、[逐单场景](../data/research/tennis-20260911-v1/backtest-tail/trials.csv)、[报告及假设](../data/research/tennis-20260911-v1/backtest-tail/report.json)。
- 价格触发窗口（审阅修正后）：[参数汇总](../data/research/tennis-20260911-v1/backtest-trigger-reviewed/summary.csv)、[逐单场景](../data/research/tennis-20260911-v1/backtest-trigger-reviewed/trials.csv)。旧 `backtest-trigger/` 保留作对照，不是当前版本。
- 实时样本：[质量结果](../data/collector/tennis-research-20260911/export/quality.json)、[盘口导出](../data/collector/tennis-research-20260911/export/quotes.csv)、[成交导出](../data/collector/tennis-research-20260911/export/trades.csv)。完整原始分段日志保留在该运行目录中。

## 样本是怎样选的

历史下载时间为 14:42–14:44 UTC。Gamma Tennis 标签 `864`，`closed=true`，按 `endDate` 降序，每页 100，扫描了 2 页；达到 **30 场有实际结束标签的对阵**后停止。处理到的事件中排除了 3 个非对阵、71 个缺实际结束时间的对阵。原始目录页仍在缓存中，不是按胜方、最低价、交易量或最终收益选择比赛。

这是单日附近的有界样本，`catalogTruncated=true`，不是全网球市场或随机样本。30 场的所有盘口都返回了短尾页，`incompleteMarkets=0`；这里的“完整”只表示固定时间窗口内的这个公开成交接口已经翻到底，不代表重建了历史 L2 盘口、每笔排队顺序或交易所绝对无漏报。

首批 v1 保存的是完整解析后 JSON 响应。审阅后下载器增加了 HTTP 状态、响应头和解析前正文保留，包括非 2xx／坏 JSON；2026-09-12 又用同场胜负盘实际下载验证，证据在 `data/research/tennis-http-evidence-20260912/`。没有改写最初缓存。缓存落盘失败现在会让任务失败，不会发布成功 manifest。

各类型本次窗口内的公开成交分布：

| 类型 | 盘口数 | 有成交的盘口数 | 成交条数 |
| --- | ---: | ---: | ---: |
| 全场胜负 moneyline | 30 | 30 | 12,535 |
| 是否完成比赛 | 30 | 7 | 91 |
| 第一盘胜者 | 30 | 14 | 81 |
| 后续盘胜者 | 30 | 1 | 54 |
| 总盘数 | 30 | 3 | 36 |
| 第一盘局数大小 | 90 | 1 | 6 |
| 后续盘局数大小 | 90 | 0 | 0 |
| 全场总局数 | 90 | 30 | 107 |
| 让盘 | 51 | 8 | 58 |
| 让局 | 22 | 5 | 10 |

因此第一轮应重点看全场胜负盘。其余盘口继续全量采集，但这批历史成交太稀疏，不能仅凭“挂牌盘口多”认为更容易接到订单。单打、双打、赛事级别需要继续拆样本；这轮还不足以排出各级别利润榜。

## 找到的真实回落样本

[US Open WTA: Coco Gauff vs Elena Rybakina](https://polymarket.com/event/wta-gauff-rybakin-2026-09-10)。Gamma `gameId=6210626`，记录开赛 `2026-09-11 00:55:00Z`，结束标签 `03:10:08.449Z`，最终比分 `6-3, 4-6, 4-6`。Rybakina outcome 的明确支付为 1；双方映射与规则均在缓存。

- 终场前 8 分钟入场时，按当时最近一秒成交形成的参考价为 **0.90**。
- 后续记录的最低价格为 **0.57**，不是仅从分钟 K 线猜测。
- 终场前 328.449 秒有 248.58 份 SELL 成交于 0.64；314.449 秒有 108.69 份 SELL 成交于 0.64；之后仍有多笔。
- 整个 8 分钟窗口内，Rybakina token 低于 0.70 的直接 SELL 成交量合计 **8,008.04 份**。这是公开成交量，不是声称自己的同等大小订单必然全部成交。

它说明“高参考价之后出现深回落、最终仍兑付”的路径在网球样本里确实出现了。也说明入场时点很关键：如果直到终场前 5 分钟才执行“参考价至少 0.90”条件，价格已经回落，就不会入场；不能把该策略未入场误解为最后五分钟没有低价成交。

本轮默认参数：入场参考价 ≥0.90、参考年龄 ≤120 秒、每场景 10 份、maker fee=0。参考价只用入场前的成交；二元对侧用 `1-price` 形成**明确标注的互补价格信号**，不是假造盘口。没有用最终赢家选边。

### 挂单价对比：全场胜负、终场前 8 分钟入场

30 场中，这四个价位各有 13 个满足入场和数据条件的试验。采用 `sell-through` 场景：直接 SELL 低于限价才计模拟成交，同价不计自己的成交，固定前排数量为 0。

| 挂单价 | 满足条件 | 触价场数 | 模拟成交场数 | 模拟成交份数 | 本样本模拟盈亏 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0.50 | 13 | 0 | 0 | 0 | 0 |
| 0.60 | 13 | 1 | 1 | 10 | +4 |
| 0.70 | 13 | 1 | 1 | 10 | +3 |
| 0.80 | 13 | 1 | 1 | 10 | +2 |

后三行是**同一场比赛的互斥价格方案**，不能相加为赚了 9。仅凭这一场不能选定“最优期望挂单价”。这轮 0.70 在最后 1、3、5 分钟才入场的方案分别有 20、14、15 个合格试验，均未触价；8 分钟方案有上述 1 次。未入场／缺参考的场次仍在逐单 CSV，且每个排除原因单列。

另一个已运行的模式是 `price-trigger`：比赛开始后，首次观察到达到阈值的参考价，再挂固定 1／3／5／8 分钟，不预知最终结束时间。它只是基础价格触发基线，不冒充“比赛尾段识别器”。例如 moneyline、5 分钟、0.80 方案的直接 SELL 模拟里出现了 1 个兑付 1 和 1 个兑付 0 的成交试验；失败样本没有被按最终赢家过滤掉。CSV 可检查相应比赛。

价格触发模式的入场和到期都不使用事后终场标签，因此可能在终场后才触发或继续挂至到期；可用 CSV 的 `entryAtMs`、`expiryAtMs`、`finishAtMs` 检查。这批子盘口有 224 个参数场景在终场后才首次触发，不能称为“终场前机会”。审阅修正没有改变本批 moneyline 结果，也没有改变终场相对模式的任何试验。

成交场景仍有范围限制：不重建挂单队列变化、互补 token 的撮合路径、历史 post-only 接受状态。`sell-through` 只算直接 SELL，不是实际成交率，更不是收益下界（被漏掉的潜在成交也可能亏损）。任何方向的触价另有列，不应拿模拟盈亏当作已经实现的收益。

## 实采检查：能拿到什么、还缺什么

运行时间 `15:13:47.627Z–15:15:18.030Z`，三场 ATP：Kolar–Barrena、Droguet–Glinka、Djere–Sakellaridis。102 个 token 的市场映射被保留；结束时仍列为可采的 token 为 54，二者不是同一计数口径。

| 比赛 | 盘口回放记录 | 关联到新鲜 Sports 状态 | 未匹配 | 状态过旧 |
| --- | ---: | ---: | ---: | ---: |
| Kolar–Barrena | 23,112 | 16,174 | 6,938 | 0 |
| Droguet–Glinka | 11,828 | 10,614 | 992 | 222 |
| Djere–Sakellaridis | 10,038 | 7,626 | 2,412 | 0 |

本地序号缺口、格式损坏、非法盘口更新、乱序均为 0。`connectionInvalidations=1`；原始日志只见运行结束时 CLOB/Sports code 1000 的正常关闭，没有中途 connection_gap/socket_error，不能把主动关闭当丢包，也不能由本地日志反推上游绝对无漏发。

能保留买卖深度更新、成交、原始 WebSocket 帧、收到时间、请求边界，以及部分盘比分和 `S2/S3` 阶段。Gamma 的较慢比分快照也在原始 metadata 中。

**还没有完成的验收**：整场从开赛到结算的连续覆盖；逐分比分、发球方、盘／抢七实际结束时间；断线后的历史逐笔补洞；盘口队列级被动单回放。当前研究回测读的是历史成交 dataset，不直接把 L2 journal 变成已验证的被动成交。免费 Sports 在这次短样本没有提供可用的逐分／发球数据，双打先前样本甚至只有 `0-0`，不能用这些缺字段制造可靠的赛点信号。

## 下一步优先顺序

1. 网球单打全场胜负继续按原始全深度采集，扩展 WTA/ATP、不同赛事级别和时间段。第一轮深回落来自 WTA 大赛，不应预先只选“小联赛不卷”。
2. 保留双打与所有子盘口，但先补逐分／盘终点标签，再比较赛点、发球胜赛局、抢七等可当时识别的入场条件。
3. CS2 做下一组前向盘口＋回合状态采集；乒乓球先补 Setka/WTT 的比赛状态源。羽毛球此次限定搜索没有相关对阵，不宣称全站不存在。详见[备选项目调查](sports-comparison-2026-09-11.md)。

这里没有依据交易量去断言足球没有利润，或网球天然更不卷；优先级来自已观测的数据可用性和真实价格路径。

## 可复现命令与来源

命令中的输出目录必须不存在；换一个新的 run 名称即可重新下载。当前机器访问公共接口使用本地 HTTP 代理；不需要 Polymarket 交易密钥。

```sh
npm run research:download -- --sport tennis --max-events 30 --max-catalog-pages 4 \
  --require-finish --concurrency 6 --proxy-url http://127.0.0.1:10808 \
  --output-dir data/research/tennis-next

npm run research:backtest -- --input data/research/tennis-next/dataset.json \
  --output-dir data/research/tennis-next/tail --prices 0.5,0.6,0.7,0.8,0.9,0.95,0.97,0.99 \
  --windows 60,180,300,480 --shares 10

npm run research:backtest -- --input data/research/tennis-next/dataset.json \
  --output-dir data/research/tennis-next/trigger --entry-mode price-trigger

npm run research:backtest -- --input data/research/tennis-next/dataset.json \
  --output-dir data/research/tennis-next/queue100 --fill-model sell-at-or-below \
  --queue-ahead-shares 100 --shares 100 --entry-min-price 0.95

npm run collect:tennis -- --duration-seconds 60 --run-id tennis-next \
  --proxy-url http://127.0.0.1:10808
```

- [Gamma Tennis 目录查询](https://gamma-api.polymarket.com/events?tag_id=864&closed=true&limit=100&offset=0&order=endDate&ascending=false)：原始页已保存，实时重查结果会变化。
- [Brunold–Heide 事件 API](https://gamma-api.polymarket.com/events/slug/atp-brunold-heide-2026-09-11)：用于复现实际比赛日期与 endDate 相差一周。
- [Gauff–Rybakina 事件 API](https://gamma-api.polymarket.com/events/slug/wta-gauff-rybakin-2026-09-10)：结算与结束标签；价格路径来自该 condition 的原始 Data API 成交缓存。
- [官方公开成交接口](https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets)：支持 start/end 时间窗口，offset 最大 10000；本次通过 `smart-search fetch` 抓取核对，并实际验证固定窗口返回的时间边界。
- [官方实时数据](https://docs.polymarket.com/market-data/realtime-data)、[价格历史](https://docs.polymarket.com/api-reference/markets/get-prices-history)、[结算](https://docs.polymarket.com/concepts/resolution)：已抓取资料用于核对字段与用途；分钟价格历史没有被冒充 L2 历史盘口。

```sh
smart-search fetch 'https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets' --format json
```
