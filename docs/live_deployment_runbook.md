# Live Deployment Runbook — polyFIFA2026 Tail-Entry Bot

更新日期: 2026-06-26 Asia/Shanghai · branch `random-control-poc`

## 前置条件 (do not skip)

本 bot 在 **2026 FIFA World Cup 单场比赛** 最后 3-8 分钟下单 Polymarket spread/total/moneyline 市场。需要满足:

1. **Polymarket 账户 + pUSD 余额**
   - 用户必须已经 KYC 通过且账户有 pUSD (USDC.e on Polygon)。
   - 首次资金建议 **\$50-\$100** 用于初期 smoke + watch。

2. **CLOB v2 API 凭证**
   - 在 Polymarket Settings → Relayer API 创建 API key 三元组 (key/secret/passphrase)。
   - **Signer address 必须匹配 POLY_PRIVATE_KEY 派生地址** —— 否则下单时 maker address 不被允许。
   - 如果你的账户使用 deposit-wallet 流程 (CLOB 报 "use deposit wallet flow"),改用 `POLY_DEPOSIT_WALLET_ADDRESS`,bot 会自动切到 signature type 3。

3. **365Scores 公开 web clock 可达**
   - bot 唯一开仓的时间源是 365Scores `addedTime + preciseGameTime` 解析出的 `remainingSeconds`。
   - 如果 365Scores 抓不到 (网络/区域),`time-window.ts:26` 直接拒绝下单 —— 这是设计上的安全锁。

4. **HTTP/HTTPS 代理 (上海/中国大陆必填)**
   - Polymarket 在中国大陆地理屏蔽,365Scores 不稳定。
   - 准备一个稳定 HTTP 或 SOCKS5 代理,bot 直接读 `HTTP_PROXY` / `HTTPS_PROXY`。

5. **`random_control` 已通过 (本仓库已完成)**
   - 见 `docs/random_control_tier2_report.md`。
   - 8/9 决策格 PASS at 95% CI;**只交易 `total_under_loss_ge2 @ 300s/480s` 作为首选**,其次 `spread_tight_loss_ge2 @ 480s` (CI 宽,警惕)。
   - **绝对不交易 `*_locked` 类策略 (`total_over_locked` / `team_total_over_locked` / `btts_yes_locked`)**:Tier 2 显示这些是盘口更新延迟造成的一次性 outlier,没有 speed-bot 抓不到。

## 配置文件: `.env.local`

复制 `.env.example` 到 `.env.local`,逐项填写:

```bash
cp .env.example .env.local
chmod 600 .env.local  # 权限锁死
```

关键字段:

```bash
# 来自 Polymarket Settings → API
POLY_PRIVATE_KEY=0x...               # 必填,匹配 Relayer signer
POLY_API_KEY=...
POLY_API_SECRET=...
POLY_PASSPHRASE=...

# Funder/Deposit wallet
POLY_FUNDER_ADDRESS=0x...            # 老账户填 proxy/profile wallet
# POLY_DEPOSIT_WALLET_ADDRESS=0x...  # 若 CLOB v2 报 deposit-wallet flow 才填

# Polygon mainnet
POLY_CHAIN_ID=137
POLY_CLOB_HOST=https://clob.polymarket.com
POLY_RPC_URL=https://polygon-bor-rpc.publicnode.com

# Stake safety
POLY_USE_LIVE_BALANCE=true           # 让 bot 读真实 pUSD 余额作为 stake 上限
POLY_BALANCE_BUFFER=0.02             # 保留 $0.02 不动
POLY_LEDGER_FILE=data/live-ledger.json

# 时间源 timezone
POLY_365SCORES_TIMEZONE=Asia/Shanghai

# 代理
HTTP_PROXY=http://127.0.0.1:10808
HTTPS_PROXY=http://127.0.0.1:10808

# 单笔参数
LIVE_STAKE=5                         # 首次 smoke 用 $5
LIVE_ORDER_TYPE=FOK                  # Fill-Or-Kill,避免挂单久留
```

## Smoke 测试序列

### A. 离线 sanity (无需 .env.local)

```bash
npm install
npm run typecheck    # 应该 0 error
npm test             # 141 tests pass (已确认)
npm run paper:fixture  # 应该输出 strategy=spread_tight_loss_ge2 status=filled bestAsk=0.97
```

如果 A 阶段任何一步失败,**停止下一步**。

### B. 凭证检查 (需要 .env.local)

```bash
set -a; source .env.local; set +a
npm run live:status
```

应该输出:
- 当前 pUSD 余额
- 当前 ledger 状态
- 不下任何单

如果报错:
- `LIVE_CREDENTIALS_MISSING`: 检查 4 个 POLY_* 字段
- `maker address not allowed`: 切换到 deposit-wallet flow (填 `POLY_DEPOSIT_WALLET_ADDRESS`)
- 网络超时: 检查代理

### C. \$5 实盘 smoke (一次性)

**只在 B 阶段成功后做。等待一个正在踢的 fifwc 比赛 88+ 分钟时启动:**

```bash
set -a; source .env.local; set +a
npm run live:smoke
```

(它已经写死了 stake=5 和 FOK,用 Spain-Saudi 历史 fixture 作 match-file —— 但 mode=live,会真的查 orderbook,如果价格合适会真的下 \$5 单。)

**结果验证:**
- 成功: ledger 里出现一条 `mode=live, status=filled` 记录,Polymarket 网页 portfolio 里出现持仓
- 部分成交: `status=partial`,部分 shares 被填,剩余取消 (FOK 应该不会有 partial,这是 sanity 校验)
- 拒单: `status=rejected`,看 raw error,通常是 fee/price 或 wallet 问题

### D. Watch 模式 (持续盯盘)

通过 A/B/C 后,开 watch 模式自动盯当前所有 fifwc 比赛:

```bash
set -a; source .env.local; set +a
npm run live:watch:worldcup
```

bot 行为:
- 每次有 365Scores `remainingSeconds <= 180` (默认 3 分钟尾盘) 且某个 candidate 满足 `lossRequiresGoals >= 2` 且 best ask 满足 `estimatedNetReturn > 0`,自动下 FOK BUY 单。
- 同一比赛同一 token 已有 active 持仓 → 跳过 (ledger interlock)。
- 默认无最低 ROI 阈值,但你应该手动加 `--minimum-net-return 0.01` (1%) 或更高,过滤掉 0.999 这种擦边机会。

## Stop conditions (any single one → kill)

立即 `Ctrl+C` 关掉 watch + 检查日志:

1. **365Scores 多次连续失败**: 没有 verified clock 就别下单,但反复重试可能 hit rate limit。
2. **pUSD 余额低于 buffer**: ledger 会拒绝下新单,但应该手动停。
3. **同一日下单超过 3 笔**: 比赛节奏不应该这么密集,可能是逻辑 bug 或代码改动后的回归。
4. **Polymarket API 返回 5xx 持续 > 1 min**: 可能是 Polymarket 侧问题,等他们恢复再开。
5. **任何 trade 的 `estimatedNetReturn < 0`**: 不应该发生 (decision.ts 已经 filter),但如果发生说明 fee 模型可能改了。

## 推荐起步配置

基于 random_control Tier 2 结论:

| 项 | 推荐值 | 理由 |
|---|---|---|
| 单笔 stake | \$10-\$30 | 95% CI 下,total_under @ 480s 单笔期望 \$0.4-\$1.3 利润,亏的话约 \$10-\$30 |
| 单日总 cap | \$100 | 限制单日上限,避免出现单日多场比赛连下 |
| 最低 ROI | 1% (`--minimum-net-return 0.01`) | 过滤 0.999 擦边 trade |
| Window | 默认 3 分钟 | 数据上 3 分钟窗口稳定,5-8 分钟更有肉但风险更大 |
| Strategy 白名单 (代码层面 TODO) | `total_under_loss_ge2`, `loser_no`, `leader_yes_lead_ge2`, `draw_no_lead_ge2`, `team_total_under_loss_ge2`, `spread_tight_loss_ge2` (PASS Tier 2) | 排除 *_locked |

**代码层面建议改动 (post-deployment):**
- 在 `src/runner.ts:8-13` 的 `DEFAULT_THRESHOLDS` 加 `minimumNetReturn: 0.01`
- 在 `src/domain/loss-requires-strategy.ts` 加 `includeLocked: false` 作为默认 (现在默认 true)
- 加 `dailyTradeCap` interlock 到 `LiveLedger`

## 部署后第一周 review checklist

记录:
- [ ] 触发次数 vs 实际下单数 (期望 1:1,差异说明 ROI/depth 过滤了多少)
- [ ] 平均 fill price vs strategy 的 `best ask` (滑点)
- [ ] 单笔实际 ROI 分布 vs Tier 2 预测 (random-pick 0.69%-1.52%, min-pick 1.8%-4.4%)
- [ ] 总 ROI > 0 的 t-statistic (n 应该够大可以做单样本 t-test)

如果实际平均 ROI 落在 random-pick 区间而不在 min-pick 区间,说明 FOK 抓不到最优价 —— 重新评估是否值得继续。
