# 网球采集与回测续接验收 — 2026-09-18

本轮续接 `Review journal compression changes` 会话，并读取其引用的原开发记录。范围延续已确认的数据采集/存储恢复方案：先完成网球数据和回测，不启用实盘交易、不扩展体育配置、不把缺数或未结算样本当成收益。

## 1. 压缩日志与 checkpoint 修复

旧进程 PID `29981` 启动于修复之前，最后落盘停在 `2026-09-16T19:58:19.933Z`、序号 `14,971,447` 的 `checkpoint_end`。checkpoint 关闭写句柄后要列出旧分段，旧 gzip 前缀读取的提前退出路径会使 pipeline teardown 等待不结束，后续写入/flush 也被挡住。HTTP 仍可响应并不能证明 journal 在推进。

- 保留原来的显式 AbortController、`destroyOnReturn: false`、自动关闭源文件以及等待 pipeline 收尾的修复；完整读取的 gzip CRC/截断校验没有放宽。
- 新增真实 journal 集成回归：压缩后的历史大于 64 KiB；真实 checkpoint 尚未完成时排入后续大块 UTF-8 记录；验证 checkpoint/flush 完成、后续内容逐字节一致、读写句柄关闭。
- 同一回归在旧 `7eb7273` reader 的独立临时副本中触发 2,500 ms 截止时间，错误为 `JOURNAL_CHECKPOINT_GZIP_LIFECYCLE_TIMEOUT: checkpoint() listing gzip history`；修复版本通过（单项约 109 ms）。没有在共享工作区临时替换 reader。
- 真实卡住的 run 用修复 reader 列出 **359 个分段，约 243 ms**。这证明列段路径可结束，不等于把缺失区间补齐。

代码：`src/collector/journal-segments.ts`；新增回归：`tests/collector/journal-checkpoint-gzip-lifecycle.test.ts`。

## 2. 状态页与服务状态不再伪造新鲜度

- `updatedAtMs` 改为最近一次实际状态发布的时间，不再随着每次 HTTP/`snapshot()` 读取而刷新。
- 发布在原有串行持久化队列中执行；状态陈旧阈值为配置的 `pulseIntervalMs × 3`，旧格式默认 15 秒。
- “采集中”却没有最近 60 秒日志时，页面显示“采集停滞”，服务 CLI 返回 `stale: true`。进程身份仍单独核验，不把匹配 PID 当作采集健康。
- 连接表与顶部汇总共用同一个“状态新鲜且最近有入站消息”的判断。过期的 `open` 标志显示“连接记录陈旧”，不会继续计作当前连接。
- 新鲜的磁盘保护暂停仍明确显示暂停；HTTP 刷新失败、CSP、同源请求和 `textContent` 安全边界保持不变。

独立复核发现并修正了顶部连接计数仍使用旧 `open` 标志的问题；先用三项失败断言复现，再统一行标签和汇总条件。最终复核无剩余问题。

## 3. 实际部署与新数据证据

只重启本项目拥有的 LaunchAgent，先确认旧 PID 已退出，避免 `bootout` 刚返回就把退出中的旧实例误当成新进程。代理与公开 Gamma/CLOB 请求实测 HTTP 200，未修改代理配置。监听列表为空不是连接不可用的证据。

- 新进程：`78921`，新 run：`run-5ab92518-b49b-44b4-abeb-21cba8b0ad23`。
- 首轮因磁盘仅约 **18.5 GiB** 正确保持 `paused_disk`；无损压缩 56 个封存分段后，逻辑字节减少 **3,040,987,283（约 2.83 GiB）**，实际空闲升至约 **21.3 GiB**，自动越过恢复阈值继续采集。20 GiB 保护线及恢复余量没有降低。
- 新 run 第一条落盘记录：`2026-09-18T14:43:46.157Z`。与旧 run 最后已确认落盘时间之间有 **42 小时 45 分钟**的日志缺口；初始目录发现也不等同于收到盘口，直到 `2026-09-18T14:46:23.452798+00:00` 才在本次轮询中明确看到新网球盘口。
- `2026-09-18T14:50:57.933315+00:00` 的最终检查：`mode=collecting`，已接收 `153,467` 条记录，最新记录约 `0.126` 秒前，实际可用磁盘 `21.13 GiB`。服务 CLI 校验 `stateIdentity=job`、`stale=false`。
- 当前 run 已有 **28 场网球相关比赛**收到新盘口：14 个 `tennis`、9 个 `itf`、4 个 `wta-doubles`、1 个 `atp-doubles`。例：Biella 的 Jay Clarke–Felix Gill、Alejandro Moro Canas–Oriol Roca Batalla；Valencia 的 Yasmine Kabbaj–Despina Papamichail。
- 抽查 `2026-09-18T14:47:06.442Z` 至 `2026-09-18T14:48:54.602Z` 已落盘的活动分段前缀，确认网球 token 的 **208 条 book、49,553 条 price_change、103 条 last_trade_price 原始事件**。这是有限区间的原始事件计数，不是去重交易笔数，也不是整场完整性验收。

原始日志目录：[新 run](../data/collector/continuous/runs/run-5ab92518-b49b-44b4-abeb-21cba8b0ad23/)。只读状态页：[http://127.0.0.1:8765](http://127.0.0.1:8765)。原有乒乓配置保留，未新增其他体育配置。

后台继续压缩新封存段；最终观测累计 59 个分段，逻辑减少 3,221,612,128 字节，压缩无错误。逻辑节省和实际空闲空间不是同一指标；新数据及其他进程仍会消耗磁盘。

## 4. 两套网球回测已从原归档重新核验

核验两份报告各五个文件的 manifest 大小/SHA-256，并重新读取 30 份归档、核对全部源文件指纹。两套模型分别重新计算 **12,240 个情景及 264 个参数组**，与保存结果逐项一致（trial 比较去除仅用于展示的 `pnlStatus` 字段）。没有新网络结算请求，也没有再写两套大体积报告。

| 口径 | quote-touch-assumed | sell-through-volume |
| --- | ---: | ---: |
| 输入归档 / 不同比赛 | 30 / 30 | 30 / 30 |
| 参数情景 | 12,240 | 12,240 |
| 合格 / 被排除情景 | 1,044 / 11,196 | 1,044 / 11,196 |
| 合格的不同比赛 / 比赛-窗口组合 / 市场 | 23 / 44 / 83 | 23 / 44 / 83 |
| 合格触价情景 / 涉及比赛 | 7 / 5 | 7 / 5 |
| 模型假设成交情景 | 7 | 0 |
| 有确认结算的模拟成交情景 | 0 | 0 |

触价价格是 `0.90 / 0.97 / 0.99`。旧说明中的“2 次”来自**单个参数组最大值**，不是情景总数；“23”是不同比赛数，不是比赛-窗口组合数。旧“61 分钟陈旧”也已修正为 **61,142,136 ms，约 16.98 小时**。这些统计口径更正已同步到[来源审计](collector-source-audit-2026-09-16.md)。重叠情景不能相加成独立实盘交易或组合收益，未确认结算仍为未知。

已有可读报告：
- [触价假设模型](../data/research/collected-books/20260917-tennis-all-touch/report.html)
- [成交量穿价模型](../data/research/collected-books/20260917-tennis-all-sell-through/report.html)

## 5. 验证结果与尚存缺口

最终当前工作区执行：

```sh
npm run typecheck
npm test -- --maxWorkers=2
git diff --check
```

结果：**90 个文件、2,527 项测试全部通过**，typecheck 与空白检查通过。首次修改前的高并发基线曾使既有 locked-refill 压力测试触发 5 秒超时；单项复跑及限制两 worker 的完整基线/最终测试通过。没有提高测试超时、删减断言或把首次失败隐去。

仍不能宣称全部网球数据完整：

1. 历史约 42 小时 45 分钟缺口无法从连接状态或价格插值恢复。
2. `/books` 部分响应缺少请求的 token，实际错误是 `CLOB_BOOK_BATCH_IDENTITY_MISMATCH`。抽查区间有 15 条此类诊断；验证过身份的其余快照仍被记录，缺失 token 不伪造空盘口或通过审计。本轮验证的是采集恢复，不是把上游缺数清零。
3. ITF/部分比赛的可靠终场、独立盘/局结束时间及结算证据仍不齐。新的进行中比赛尚未完成全尾窗验收；旧回测的 7 个触价假设成交仍无确认结算。本轮没有新收益结论。
4. 当前磁盘余量仍有限，低于保护线会再次安全暂停；不能保证这台 Mac 永不休眠、网络不断线或上游永不漏发。

### 可复查的本地证据

位于 `data/research/source-evidence/`（数据目录保持 git 忽略）：

- `tennis-collector-pre-restart-20260918.json`：旧状态、持久化末条记录、末段 SHA-256 和真实磁盘观测。
- `tennis-real-segment-listing-20260918.json`：真实 run 的 359 段列举验证。
- `tennis-collector-recovery-20260918.json`：暂停→压缩→恢复的连续轮询和最终状态。
- `tennis-new-raw-receipts-20260918.json`：实际落盘盘口/公开成交事件、检查前缀范围及快照缺失诊断。
- `tennis-backtest-audit-20260918.json`：两份报告哈希、统计口径与七个触价情景。
- `tennis-backtest-replay-20260918.json`：30 份源指纹和两套模型的逐项重算验证。

代码已应用到原工作区，未提交、未推送。隔离验证工作区保留在 `.worktrees/tennis-resume-20260918`，不影响现有 `.worktrees/continuous-collector`。
