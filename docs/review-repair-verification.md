# 2026-09-11 审查修复与验证

范围：基于 `7295f2b` 的 28 项审查问题（T1–T6、C1–C15、O1–O7），以及修复后的独立复核发现的相关边界。原先 315 项测试没有覆盖这些问题；不再以旧测试全绿代替逐项验收。

## 回归覆盖

| 审查项 | 行为要求 | 仓库回归用例 |
| --- | --- | --- |
| T1 | 保存成功订单腿，未知提交保持活动；CLI 重试和 watch refill 都不能重复提交；诊断对象可安全持久化 | `tests/execution/live-executor-recovery.test.ts`、`tests/integration/execution-recovery.test.ts`、`tests/stress/locked-recovery.test.ts` |
| T2 | 同一路径的不同 ledger 实例串行修改、原子发布；结算与新增交易均保留 | `tests/persistence/ledger-recovery.test.ts` |
| T3 | 撤销剩余订单不清除已经匹配但未解释的数量；部分失败不能解释整笔匹配 | `tests/execution/live-executor-recovery.test.ts` |
| T4 | 比分回退后的重复更新保持保护；独立确认恢复后仍遵守已花预算 | `tests/stress/locked-recovery.test.ts` |
| T5 | 提交前到达的无效进球、VAR、比分冲突持续生效，包括 SDK 准备订单期间 | `tests/stress/locked-recovery.test.ts`、`tests/execution/live-executor-recovery.test.ts` |
| T6 | 嵌套赛事、事件数组/映射及 Flight 中的父归属必须一致 | `tests/polymarket/event-page.test.ts` |
| C1 | 只关联同一比赛的最新观察；规范化别名、排除心跳、保留比分回退及单调时钟年龄 | `tests/collector/replay-integrity.test.ts` |
| C2 | `0.70` 与 `0.7` 更新同一数值档位，零数量正确删除 | `tests/collector/replay-integrity.test.ts` |
| C3 | 两侧完整有效快照才能初始化盘口，非法价格/数量不能变成空书本 | `tests/collector/replay-integrity.test.ts` |
| C4 | 损坏/未知修改使相关盘口失效；合法非盘口帧不破坏深度 | `tests/collector/replay-integrity.test.ts` |
| C5 | 时间倒退被标记；无时间戳快照不重置水位，同一增量数组也校验时序 | `tests/collector/replay-integrity.test.ts` |
| C6 | 重新订阅必须等待快照，退订 token 的迟到帧不影响同连接的其他 token | `tests/collector/replay-integrity.test.ts` |
| C7 | 严格验证 schema/run/source/sequence；未换行尾记录不能成为有效深度 | `tests/collector/replay-integrity.test.ts` |
| C8 | 分条及单个大型数组帧均流式导出；确定性输出，损坏输入不覆盖旧结果 | `tests/collector/export-streaming.test.ts` |
| C9 | 建连超时、入站静默、重连代次和指数退避有明确行为 | `tests/collector/streams.test.ts` |
| C10 | 正常关闭及强制关闭释放自有传输资源，包括直连、代理和未完成握手 | `tests/collector/streams.test.ts`、`tests/polymarket/http.test.ts` |
| C11 | UTC 跨日回拨仍可落盘；旧的按日分段也按记录序号排序 | `tests/collector/journal.test.ts`、`tests/collector/replay-integrity.test.ts` |
| C12 | fatal 错误使共享完成 promise 失败，CLI 非零退出 | `tests/collector/collector.test.ts`、`tests/collector/cli.test.ts` |
| C13 | flush/close 失败仍执行剩余清理并结束等待，不遗留未处理 rejection | `tests/collector/collector.test.ts`、`tests/collector/cli.test.ts` |
| C14 | 初始化每个阶段取消都不能再安装资源；有限时长覆盖启动 | `tests/collector/collector.test.ts` |
| C15 | 消失赛事查找失败或仍开放时保留订阅并重试 | `tests/collector/collector.test.ts` |
| O1 | basket 逐 token/condition 结算，保守保留不能分配的旧账本敞口 | `tests/persistence/ledger-recovery.test.ts`、`tests/execution/settlement-recovery.test.ts` |
| O2 | 提交中、失败及未知状态不标已赎回；只认确认状态或链上核验 | `tests/execution/settlement-recovery.test.ts` |
| O3 | 明确失败的成交不能被旧订单快照兜底成成交 | `tests/execution/live-executor-recovery.test.ts` |
| O4 | 常规时间和加时严格区分，包括缩写与冲突阶段字段 | `tests/polymarket/scores365-clock.test.ts` |
| O5 | 历史否定信号不影响无关当前事件；补时写法、旧前帧及当前模糊信号均有控制用例 | `tests/polymarket/scores365-clock.test.ts` |
| O6 | Flight-only 比赛页面可以复用现有解码器取得比赛状态 | `tests/polymarket/event-page.test.ts` |
| O7 | HTTP 超时/取消覆盖响应体和未完成连接的传输资源释放 | `tests/polymarket/http.test.ts` |

## 有限公开采集证据

首次修复试采使用已配置的本机 HTTP 代理，选择一个开放 NPB 市场，保存到 `data/collector/review-20260911/`。数据保留在工作区且被 git 忽略。

```bash
npm run collect -- --duration-seconds 20 \
  --event-slugs npb-tok-chu-2026-09-04 \
  --proxy-url http://127.0.0.1:10808 \
  --run-id review-20260911 \
  --snapshot-interval-ms 7000 --discovery-interval-ms 7000
npm run collect:export -- --run-dir data/collector/review-20260911 \
  --output-dir data/collector/review-20260911/export-a
```

观察到 42 条原始记录、123,010 字节、3 次 Gamma 发现、6 次 HTTP book 快照、两路独立 WebSocket 的打开/正常关闭记录。导出为 2 条报价、0 条成交、15 条 Sports 消息、2 条 token 映射；序列缺口/损坏/乱序为零。质量摘要的 1 次盘口失效来自采集结束时正常关闭 CLOB 连接。两次导出的五个文件逐字节一致。

此样本没有该比赛的实时比分，报价明确标记 `sportsStatus=missing`，没有把全球 Sports 流中别的比赛挂到 NPB 盘口上。没有观察到公开成交，不能将零成交行解释成完整的成交覆盖证明。文件大小包含三次元数据响应，不可据此推算全部赛事长期磁盘成本。

传输层最后调整后又执行了 15 秒试采，保存在 `data/collector/review-20260911-final/`。结果为 48 条记录、2 条报价、22 条 Sports 消息、2 条 token 映射；损坏、缺口和乱序仍为零，进程正常退出。两次样本都保留，可用当前导出器重新生成 CSV。`npm run paper:fixture` 也通过，维持正常纸面执行路径。

## 操作边界

所有交易回归均使用合成输入和注入客户端；没有发真实订单或赎回。未知提交保持活动状态并阻止重复下单，需要取得后续确认或人工核对后才能解除；不能用清空账本来代替确认。

账本更新锁覆盖同一 Node 进程中的不同实例，文件发布对其他读者原子可见。多个独立交易进程不能同时共享同一个 ledger 文件；这需要进程间协调，不属于本次原有单进程后台结算并发修复。

完整检查命令：`npm test`、`npm run typecheck`、`git diff --check`。针对导出，受限子进程分别以 12,001 条记录及一个含 12,001 子消息的 JSON 数组，在 96 MiB V8 堆限制下完成 200 档全深度输出。

本轮最终集成验证：41 个测试文件、710 项测试通过，类型检查和差异检查通过。相比原有 315 项，增加了 395 项有效场景/参数用例。额外复核涵盖 SDK 的异步 L2 鉴权头（含自定义路径前缀）、响应丢失后的重试、持续多分钟的 VAR、多进球合并更新、同连接单 token 退订，以及真实挂起的 TCP/TLS/代理连接。测试通过代表列出的回归场景已验证，不是对任意市场/网络输入的无缺陷保证。
