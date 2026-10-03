# 网球尾盘挂单实盘链路（tennis tail ladder）

回测口径见 `data/research/backtest-audit-20261003.md`（本地，未提交）。
本文只写实盘/纸面运行方式与安全边界。

## 1. 策略是什么

- 只做 **网球 moneyline**。默认只做 **ATP/WTA**：回测样本里 ITF 的 573 场有盘口、
  但没有任何比分数据，等于 0 样本 0 证据（`--leagues all` 可以放开，但那是没验证过的）。
- 信号 Gen1：有一方"再拿一局就赢下整场"——它已拿 `setsToWin - 1` 盘，并且是当前盘的领先方
  （5-x(x≤4) 或 6-5）；6-6 时只有盘分领先方算（1-1 / 2-2 的平分决胜盘抢七不入场：
  旧的 /tmp 研究脚本在这里取了 feed 的 home 侧，实盘按"没有唯一热门方"处理并跳过）。
  判定只有一份实现：`src/domain/tennis-gen1.ts`，回测与实盘 import 同一函数。
  **Gen1 一出现就开始挂阶梯，不等点级丢分。**
- 比分源 = Polymarket 自己的 sports feed（`wss://sports-api.polymarket.com/ws`，按
  Gamma event 的 `gameId` 过滤，局级比分）；365Scores 不再参与挂单，只留在采集器里
  记录点级数据（Gen2 研究）。
- 男子大满贯（best-of-5）没有回测样本，发现阶段按赛事名排除；女子大满贯是 BO3，保留。
- **分档补挂（与回测对齐）**：回测里每个价位是在它自己"第一次满足条件"的那一秒挂进去的
  （bid 涨上来高档位才够条件）。实盘同样每轮重扫：Gen1 期间缺的档位会在后续轮询里补挂，
  已挂上的档不会重复挂；某一轮没有新的档可挂时也不会停扫（书涨上来才能挂高档位，
  这是回测里的真实成交来源），直到所有档位挂满、触到单场上限或扫瞄次数上限。
- 挂单：post-only 被动买单，阶梯 `0.80 / 0.85 / 0.88 / 0.90 / 0.92`，
  成交后持有到结算。被回破不自动撤（回测：不撤 ROI 12.68% > 撤 12.52%）。
- 挂单前每条腿都校验：`bestBid >= P` 且 `bestAsk > P`。不抢价、不追价、
  不改成吃单；书不满足就跳过该档，下一轮再试。
- 另外要求**领先方 token 的 bid 不低于另一个 outcome 的 bid**（回测的
  `b === maxBid` 条件）；盘口反转/滞后时不挂，等恢复正常。

## 2. 实盘与回测的一个关键差异：最小下单量

Polymarket 这些网球 moneyline 盘口的 `min_order_size = 5` 股（2026-10-04 实盘抽查
24 个 tennis moneyline token / 12 场，全部 = 5；官方 CLOB 文档：`min_order_size`
是“the minimum number of shares the CLOB accepts for an order”）。回测里“每档 1 股”
只是研究口径，实盘挂 1 股会被拒。因此：

- 规划器会把每档股数抬高到盘口 `min_order_size`；
- 默认 `--shares-per-level 5`；
- 默认单场上限 `--max-per-event 21.75`（= 5 × 4.35），
  默认单日上限 `--max-per-day 217.5`（≈10 个满阶梯）。
- 预算不够整档时就只挂放得下的档位（例如只剩 4.35 预算，就只挂 0.80 那一档）。

想按回测的“1 股”口径算资金效率，请把这些数字除以 5 再看。

**为什么网页上看起来 1u 以下也能下单？** 那是按美元计价的市价单（taker，FAK/FOK）：
网页金额 ÷ 成交价 = 股数，例如 $2.49 @0.83 只会成交 3 股（<5 股），所以流水里能看到
小于 5 股、甚至小于 $1 的成交。限价挂单按**股数**计价，5 股在低价位本来就很小
（盘口里 5 股 @0.14 = $0.70），所以“低于 1u 的成交”与“最小 5 股”并不矛盾。
本策略必须用被动挂单吃队列，市价单会立即吃卖单、付 taker 费且没有排队位置，
不能用来替代；要压小资金只能减档或减场，不能把每档压到 5 股以下。

## 3. 运行

默认就是 **dry-run**，只发现、只算、只打印，不提交任何订单：

```bash
npm run tennis:tail -- --max-iterations 2 --interval-ms 0 \
  --proxy http://127.0.0.1:10808
```

常驻观察（每 10s 扫一次 CLOB book，比分推送到达时立刻再扫一次；每天自动用
`data/execution/tennis-tail-ledger.json` 记账）：

```bash
npm run tennis:tail -- --proxy http://127.0.0.1:10808
```

真正下单用 live 脚本（它用 `node --env-file=.env.local` 自动加载凭证和代理，
等价于显式 `--live true`；凭证沿用 `POLY_PRIVATE_KEY / POLY_API_KEY /
POLY_API_SECRET / POLY_PASSPHRASE`，签名类型/funder 同现有 live 链路）：

```bash
npm run tennis:tail:live
```

live 启动时会做一次只读的余额预检：从 deposit wallet 读 pUSD，若低于最便宜
一档的占用（默认 5 股 × 0.80 = $4）会打印 `balance_preflight` 警告——此时
CLOB 会拒单，先去入金再跑。预检失败只警告，不阻塞。

### 常用参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--live true` | 关 | 不加就是 dry-run |
| `--ladder 0.8,0.85,...` | 0.80–0.92 | 阶梯价格 |
| `--shares-per-level N` | 5 | 每档股数，低于盘口最小量会被抬高到最小量 |
| `--max-per-event N` | 21.75 | 单场挂单占用上限（USDC） |
| `--max-per-day N` | 217.5 | 当日挂单占用上限（USDC） |
| `--order-type GTC\|GTD` | GTC | GTD 需配合 `--rest-seconds` |
| `--max-iterations N` | 无限 | 跑 N 轮后退出，便于先验收 |
| `--leagues atp,wta` | atp,wta | 赛事前缀；`all` = 不筛，包含 ITF（无回测证据） |
| `--interval-ms N` | 10000 | 每场 Gen1 期间的 book 重扫间隔（比分推送仍会即时触发） |
| `--sports-ws-url URL` | 官方 sports WS | 比分源覆盖，测试/换区用 |
| `--proxy URL` | 环境变量 | 走本地代理 |

## 4. 结算与赎回

- 策略**没有卖出**：成交后持有到结算，赢 1 USDC/股、输 0。
- 自动赎回默认开启（`POLY_AUTO_REDEEM=false` 关闭）：复用 `src/execution/settlement.ts`，
  只要有 funder/deposit wallet 地址和私钥就会在 watch 里周期性领取已结算仓位，
  并把 ledger 里的持仓标成 `redeemed` / `lost`。依赖的额外环境变量与世界杯实盘一致
  （`POLY_RELAYER_URL`、`POLY_AUTO_REDEEM_INTERVAL_MS`、relayer/builder key 等）。
- 未配置钱包/私钥时自动赎回静默跳过，持仓留在 ledger 里等人工处理。

## 5. 风险控制与去重

- **单场上限**：本场已挂/已成交占用 ≥ 单场上限时不再加档。
- **单日上限**：所有 active 挂单/持仓的占用合计达到上限后不再开新梯。
- **同场去重**：同一 event 在本进程内只挂一次梯；进程重启后由 ledger 的
  占用（满阶梯 = 单场上限）兜底，不会重复挂第二套。
- **崩溃安全**：每档先写 write-ahead `pending-submission-*`，提交后用 venue
  返回替换；进程死在提交中间也不会重复开梯。
- **对账**：每 8 轮做一次只读对账，`size_matched` > 0 的挂单转成持仓，
  终态订单释放预留；读失败时保留预留，绝不少算敞口。
- **价位记忆**：已挂档位从 ledger 恢复，进程重启也不会重复挂同一档；
  venue 拒单（post-only 被拒等）不算已挂，下一轮会重试。
- **多场隔离**：每笔挂单的 token 只取自该 event 自己的 moneyline market。
  比分源按 Gamma event 的 `gameId` 过滤（一个 gameId 只对应一场比赛），取到比分后
  再用球员名做 title/outcome 映射校验；名字对不上的比分永远不会挂到该 event 上，
  两场同名/近名的比赛不会互相下单。
- **重复上架去重**：Gamma 若把同一场比赛挂成两个 event（conditionId、token
  集合或球员组合相同），发现阶段只保留第一个，并写 `duplicate_event` 日志，
  避免同一比分源被挂两套梯子。
- **转写容差**：球员名允许保守的拼写变体（如 sports feed `Abdullah Shelbayh`
  vs Polymarket `Abedallah Shelbayh`），前提是双方共享一个 4 字符以上的
  family-name token 且只有一处 edit distance ≤ 2 的差异；共享姓氏的不同球员
  （Mirra vs Erika Andreeva）仍然拒绝配对。
- **监控心跳**：默认每 20 轮（10s 间隔约 3.5 分钟）写一条 `heartbeat` 日志，
  含 `discovered`（发现场次）、`monitored`（当前有帧）、`neverPolled`
  （从未配上 sports feed 比分的场次）和 `stale`（超 180s 没帧）。`neverPolled`
  非空说明有比赛在监控但拿不到局分，需要本人查看日志而不是默默漏挂。
- **无 365 回退**：sports feed 断线时实盘不会换用别的比分源（换来的是没对拍过的
  信号）。feed 挂了就只监控不挂单，等重连；心跳和 `stale` 会把这种情况写进日志。

## 6. 撤单

不自动撤单。要手动撤某条腿（用同一个 ledger）：

```bash
npx tsx src/cli.ts --mode live --cancel-order <orderId> \
  --ledger-file data/execution/tennis-tail-ledger.json
```

venue 未确认撤单时不会释放预留（避免重复挂单）。

## 7. 已知边界

- `quote-touch-assumed` 只验证“价格触达”，不验证队列位置、深度和延迟；
  实盘先用 5 股/档小仓跑，核对真实成交率与滑点。
- Gen2（常规局丢分）目前只有 7 场/182 帧/0 candidate，还不能作为触发条件；
  采集器会继续记录，样本足够后再回测对比。
- 小盘口（set winner / handicap / totals 等）样本 1–6 笔，暂不参与主资金；
  `tennis_completed_match` 一律排除。
- ITF 默认不挂：归档里 ITF 只有 CLOB 盘口、没有比分（抽查 5,792 条秒级盘口 0 条带 score），
  Gen1 无法判定，也没有任何回测样本。
- 比赛在挂单途中结束/退赛会留下未成交挂单，由对账在终态时释放。

## 8. 与回测的时间对齐（2026-10-04 审计 + 重构）

回测口径（`quote-touch-assumed`，产出 188/0 的那套）：

- **挂单时钟**：归档的 CLOB `book_snapshot`；采集器名义间隔 10s，但实测每个 token
  的有效快照间隔 **p50 ≈ 20.1s、p90 ≈ 21.4s**（当时 104 个 token 序列、1,043 个间隔）。
- **Gen1 来源**：Polymarket 自己的 sports feed（WS 推送，局级比分 `"6-2, 5-2"`）。
- **Gen1 判定**：已拿 `setsToWin-1` 盘 + 当前盘 5-x / 6-5 / 6-6（1-1、2-2 平分决胜盘
  抢七没有唯一热门方，返回 null）。
- **挂单条件**：第一笔同时满足 Gen1 且 `bestBid ≥ P`、`bestAsk > P` 的快照；
  再加上领先方 token 的 bid 不低于另一个 outcome 的 bid（盘口反转保护，新归档上
  0 次触发）。
- **成交判定**：挂单之后任一快照出现 `bestAsk ≤ P`（只看价格触达，不建模排队与部分成交）。

实盘链路逐项对照（2026-10-04 重构后）：

| 环节 | 回测 | 实盘 |
|---|---|---|
| Gen1 来源 | sports WS 推送 | **同一个 feed**（`wss://sports-api.polymarket.com/ws`，按 `gameId` 过滤） |
| Gen1 判定 | `tennisGen1` | **同一个 `tennisGen1`** |
| 挂单条件 | bid ≥ P 且 ask > P + 领先方 bid 保护 | 相同（`planTennisTailFromScore`） |
| 重扫时钟 | 每张 book 快照（实测 ~20s） | 每 10s + 每次比分推送即时扫 |
| 撤单 | 不撤，持有到结算 | 相同 |
| 成交 | ask ≤ P 触达假设 | 真实撮合（队列、部分成交） |
| best-of-5 | 无样本 | 男子大满贯按赛事名排除；女子大满贯 BO3 保留 |
| 365Scores | 不用于挂单 | 不用于挂单（只在采集器做点级 Gen2 研究） |

**对拍 harness（常驻测试）**：

- `scripts/research/tennis-gen1-backtest.ts`：归档回放。每个价位仍按"它自己第一个
  合格快照"入场（旧口径），但入场判定 import 生产用的 `tennisGen1`。
  `npm run research:tennis-gen1 -- --db data/collector/continuous/tail.sqlite --out /tmp/gen1.json`
- `tests/research/tennis-gen1-parity.test.ts` + `tests/fixtures/tennis-gen1/*.json`：
  把真实归档的（sports 比分帧 + CLOB book 快照）同时喂给 (a) 回放脚本和
  (b) 生产的 `planTennisTailFromScore` 逐快照组合，断言每个价位的入场快照完全一致。
  当前 fixture `game:6374478`（Curitiba 单打）5 个价位分三批入场
  （0.80/0.85 → 0.88/0.90 → 0.92），两条路径逐笔一致、且和冻结的期望值一致。
- 旧 20GB 归档已在 2026-10-04 删除（见 `data/research/old-tail-archive-20261004.md`），
  文档里的 188/0 无法在本地重算；新库（5 场网球）用于对拍而不是重算旧结论。
  新库当前回放：20 个默认阶梯入场、4 个触达、0 个领先方保护拦截、结算数据未归档。

**每笔 arm 的延迟字段**（`logs/tennis-tail.jsonl` 的 `timing`）：

- `score` / `gen1Kind`：这次 arm 依据的比分与 Gen1 类型（`game` / `tiebreak`）；
- `signalAgeMs`：sports feed 首次可见该比分 → 开始扫 book 的间隔；
- `orderbookMs`：扫 book 耗时（两本书并行）；
- `sweepMs` / `submitMs`：到 arm / 到提交完成。

实测网络延迟（2026-10-04 03:20，走本机代理，n=8）：CLOB 单本书
p50 0.91s / p90 1.12s；sports feed 是服务端主动推送，没有轮询间隔。

**仍然存在的偏差（诚实清单）**：

- **采样粒度**：实盘每 10s 扫一次，比分变化即时扫 → 只可能比回测 ~20s 网格**更早**
  入场。回测网格是采集限制而不是策略定义；每笔 arm 都带时间戳，可以逐笔核对。
- **两个 feed 的时钟**：实盘用推送时刻的比分 + 当次 HTTP book；回测用归档快照时刻的
  比分 + 该快照。两者都受各自延迟影响，book 抓取实测 p50 0.91s。
- **成交模型**：回测是价格触达假设，实盘有真实排队与部分成交。回测的"触达"是上界，
  实盘吃到的单可能更少（也可能因队列位置更靠前而更多）。
- **旧归档已删**：188/0 是删除前记录的结论，本地无法重算；现在的证据是
  冻结 fixture 上的回测/实盘逐笔对拍 + 采集器持续积累的新样本。
