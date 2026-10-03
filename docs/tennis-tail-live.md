# 网球尾盘挂单实盘链路（tennis tail ladder）

回测口径见 `data/research/backtest-audit-20261003.md`（本地，未提交）。
本文只写实盘/纸面运行方式与安全边界。

## 1. 策略是什么

- 只做 **网球 moneyline**。默认只做 **ATP/WTA**：回测样本里 ITF 的 573 场有盘口、
  但没有任何比分数据，等于 0 样本 0 证据（`--leagues all` 可以放开，但那是没验证过的）。
- 信号 Gen1：领先方已拿 `setsToWin - 1` 盘，且当前盘进入 5-x(x≤4)、6-5 或 6-6
  （`oneSetFromMatch && lateSet`）。**Gen1 一出现就开始挂阶梯，不等点级丢分。**
- **分档补挂（与回测对齐）**：回测里每个价位是在它自己"第一次满足条件"的那一秒挂进去的
  （bid 涨上来高档位才够条件）。实盘同样每轮重扫：Gen1 期间缺的档位会在后续轮询里补挂，
  已挂上的档不会重复挂；全部档位挂满或触到单场上限就停。
- 挂单：post-only 被动买单，阶梯 `0.80 / 0.85 / 0.88 / 0.90 / 0.92`，
  成交后持有到结算。被回破不自动撤（回测：不撤 ROI 12.68% > 撤 12.52%）。
- 挂单前每条腿都校验：`bestBid >= P` 且 `bestAsk > P`。不抢价、不追价、
  不改成吃单；书不满足就跳过该档，下一轮再试。
- 另外要求**领先方 token 的 bid 不低于另一个 outcome 的 bid**（回测的
  `b === maxBid` 条件）；盘口反转/滞后时不挂，等恢复正常。

## 2. 实盘与回测的一个关键差异：最小下单量

Polymarket 这些网球 moneyline 盘口的 `min_order_size = 5` 股。回测里“每档 1 股”
只是研究口径，实盘挂 1 股会被拒。因此：

- 规划器会把每档股数抬高到盘口 `min_order_size`；
- 默认 `--shares-per-level 5`；
- 默认单场上限 `--max-per-event 21.75`（= 5 × 4.35），
  默认单日上限 `--max-per-day 217.5`（≈10 个满阶梯）。
- 预算不够整档时就只挂放得下的档位（例如只剩 4.35 预算，就只挂 0.80 那一档）。

想按回测的“1 股”口径算资金效率，请把这些数字除以 5 再看。

## 3. 运行

默认就是 **dry-run**，只发现、只算、只打印，不提交任何订单：

```bash
npm run tennis:tail -- --max-iterations 2 --interval-ms 0 \
  --proxy http://127.0.0.1:10808
```

常驻观察（每 15s 轮询一次 365Scores，每天自动用 `data/execution/tennis-tail-ledger.json` 记账）：

```bash
npm run tennis:tail -- --interval-ms 15000 --proxy http://127.0.0.1:10808
```

真正下单需要显式 `--live true`（凭证沿用 `POLY_PRIVATE_KEY / POLY_API_KEY /
POLY_API_SECRET / POLY_PASSPHRASE`，签名类型/funder 同现有 live 链路）：

```bash
npm run tennis:tail -- --live true --interval-ms 15000 \
  --proxy http://127.0.0.1:10808
```

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
