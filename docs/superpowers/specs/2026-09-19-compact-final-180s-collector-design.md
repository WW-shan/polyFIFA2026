# 全部单场比赛最后 180 秒紧凑采集器设计

**日期：** 2026-09-19  
**状态：** 待用户审阅  
**目标范围：** 由 `collector.config.json` 的运动 profile 发现的全部单场比赛；当前网球任务保存所有网球单场比赛的终场前 180 秒，其他运动只有在 profile 显式启用时才采集。

## 1. 背景与现状问题

当前连续采集器不是数据库，而是把以下内容全部写进逐条 NDJSON journal，再对已封存分段做 gzip：

- Sports WebSocket 的完整原始帧；
- CLOB WebSocket 的完整 `book`、`price_change`、成交和连接帧；
- 每 60 秒对所有 token 做完整订单簿快照；
- Gamma 发现页、HTTP 请求、事件 metadata；
- 比赛完成后的完整 run、checkpoint、导出副本。

现有 `postFinishRetentionMs=600000` 只控制比赛结束后继续订阅多久，不会删除比赛前的原始文件。gzip 只能压缩，不能消除相同快照和重复 frame，因此连续运行仍会快速增长。

## 2. 目标与非目标

### 目标

1. 保留配置 profile 范围内的全部单场比赛，不因赛事格式做额外筛选。
2. 每场比赛最终只发布终场前 180 秒的数据产品。
3. 保留市场、订单簿、成交、比分/period 和时间覆盖信息，但相同状态不重复落盘。
4. 使用 Node 26 已提供的 `node:sqlite`，不增加 native npm 依赖。
5. 采集器有独立的原始数据上限、数据库上限和总目录上限，达到阈值时先清理最旧数据，清不出空间才暂停。
6. 采集器重启、异常结束或没有收到结束帧时不会把无限期原始流留在磁盘上。

### 非目标

- 不保存整场比赛的逐帧原始 WebSocket 审计流。
- 不通过估算开赛时间伪造“最后 180 秒”；没有可靠结束标记的比赛只保存有限的状态摘要并标为 incomplete。
- 不改动交易下单、回测和既有研究数据目录。

## 3. 设计总览

数据分为三层：

1. **控制层（小）：** 所有已发现比赛只保存精简 metadata 和 Sports 状态/比分采样，用于识别比赛结束和维护订阅。
2. **滚动层（内存）：** 每场比赛、每个市场只保留最近约 210 秒的归一化变更。210 秒包含 180 秒目标窗口和 30 秒延迟/时钟误差缓冲；相同 book 状态和重复 frame 在进入滚动层时去重。
3. **结果层（SQLite）：** 收到可靠的结束信号后，在单个事务中把该比赛最后 180 秒的压缩结果写入 `tail.sqlite`，并写入覆盖、来源和完整性状态。成功提交后释放该比赛滚动缓存。

不再把比赛开始到结束的原始 CLOB/Sports frame 逐条写入连续 raw journal。必要的原始审计只在有限时间内保留，且也受总大小上限约束。

## 4. SQLite 数据模型

数据库路径：`data/collector/continuous/tail.sqlite`。

当前实现使用 Node 26 的 `node:sqlite`，不增加 native npm 依赖。启动时设置 `journal_mode=DELETE`、`synchronous=NORMAL`、外键约束和增量 vacuum。

实际表为：

- `compact_meta`：schema 版本；
- `payloads(hash, payload)`：按稳定 payload hash 去重的 deflate 压缩正文；
- `matches(game_key, title, sport, game_id, event_ids_json, event_slugs_json, token_ids_json, market_ids_json, finished_at_ms, updated_at_ms)`：已完成比赛索引；
- `staging_records(game_key, run_id, sequence, received_at_ms, source, kind, payload_hash)`：最近滚动窗口；
- `tail_records(game_key, run_id, sequence, received_at_ms, source, kind, payload_hash)`：已完成比赛最后 180 秒的去重帧引用。

`staging_records` 和 `tail_records` 使用复合主键，`payloads` 由多个比赛/记录共享。删除 staging 或最终比赛后会清理无引用 payload。最终库保存去重后的原始业务帧及完整接收时间、来源、序号；逐秒深度/变化的现有回放格式仍由旧导出链处理，不在 SQLite 写入路径中复制一套第二种逐秒结构。

## 5. 采集与去重规则

### 5.1 比赛范围

- 不因赛事格式、盘数或比赛名称做额外过滤。
- 仍使用 `singleMatchOnly`，避免冠军、赛程汇总等没有明确单场身份的事件进入市场采集。
- 当前生产配置默认只启用 `tennis`；`table-tennis` 或其他 profile 必须显式加入，避免因为默认 profile 产生无关数据。
- 一个 `gameId` 下所有开放且有订单簿的关联市场都保留，避免只收胜负盘而漏掉 set/total 等市场。

### 5.2 控制层

- 发现结果只保存规范化 metadata 及 hash；同一 event/market 的 metadata 未变化时只记录引用，不重复保存完整 Gamma response。
- Sports feed 只保存比分、period、live/ended、来源时间和必要的原始字段；heartbeat、重复比分和重复状态不写入结果表。
- 连接、订阅、错误只保留有限诊断记录，不把每次重连产生的完整 payload 当作业务数据。

### 5.3 滚动层

- CLOB 的 `book`、`price_change` 和成交消息按 game/token 映射到 staging；Sports 状态帧按 game identity 映射。
- 只保留最近 210 秒；窗口外的逐帧消息由维护任务删除。
- 对稳定 payload 做 hash 去重；同一比赛连续重复帧不再写入 staging。
- 终场时把 `[finish - 180s, finish]` 的 staging 行复制到最终表，保留原始来源、序号、接收时间和压缩正文。
- 进程异常退出时，未完成比赛的 staging 只保留有限窗口；不会因此把无限时长 raw 流写到磁盘。

### 5.4 结束与发布

- 以 Sports `ended`/终场状态或现有生命周期确认作为结束信号。
- 结束后从滚动层截取 `[finish - 180s, finish)`；如果只知道观察到结束的时间，则写入 `finish_confidence=observed` 和覆盖状态，不伪造精确时间。
- SQLite 单事务写入 matches、tail_records 和 payload 引用；提交成功后清理该比赛的 staging 缓存。
- 没有可靠结束信号的比赛在内存 TTL 到期后只保存精简 metadata，不生成完整 tail 数据。

## 6. 磁盘上限与自动清理

新增配置：

- `tailWindowSeconds=180`；
- `tailBufferSeconds=30`；
- `maxTailStoreBytes=8 GiB`；
- `tailRetentionDays=30`；
- `maintenanceIntervalMs=60_000`；
- 继续使用已有 `minFreeBytes=20 GiB` 作为系统空间保护线。

维护顺序：

1. 删除 staging 中超过 210 秒窗口的数据；
2. 删除已经超过 `tailRetentionDays` 且不是当前 run 的旧 raw run；
3. 删除超过 `tailRetentionDays` 的最旧完整比赛结果及无引用 payload；
4. 执行增量 vacuum；
5. 若 SQLite 仍超过 `maxTailStoreBytes`，从最旧完整比赛开始释放，清不出空间时记录错误并暂停采集；
6. 维护操作必须是幂等的，清理失败只能记录错误，不能误删当前比赛或未提交事务。

达到阈值后不再单纯“暂停但保留全部数据”；系统必须先尝试释放最旧、已确认可重建/已入库的数据。

## 7. 兼容与导出

- 旧 `collect:tail` 和 NDJSON 回放路径保持兼容；compact 结果通过 `tail.sqlite` 的紧凑读取接口保存，后续导出可在不重新收集 raw 的情况下生成。
- 旧 NDJSON run 仍可只读回放，但不再作为连续采集器的新默认市场存储。
- `status` 增加：SQLite 路径/大小、staging 行数、已完成比赛数/行数、最近维护时间和最近一次清理删除计数。
- 不删除 `data/research`、策略回测结果或用户明确保留的历史数据。

## 8. 验收标准

1. 连续运行时，未结束比赛不产生无限增长的 raw run；内存和审计区都有明确上限。
2. 一场比赛结束后，数据库中最多有该比赛目标 180 秒的去重样本，重复 book 状态不会重复计数。
3. 同一输入重复处理两次，SQLite 主键和 state hash 保证结果不重复。
4. 数据库重启后可继续写入，且不会产生长期 `-wal` 文件。
5. 超过 raw、数据库或总目录上限时，最旧可删数据被清理；清理失败时采集暂停并在状态中给出原因。
6. 导出结果保留现有逐秒 tail 所需的比分、订单簿、成交、时间覆盖和完整性标记。
7. 单元测试覆盖去重、窗口裁剪、比赛结束提交、崩溃恢复、限额清理和 SQLite 导出；类型检查、完整测试和磁盘维护测试全部通过。

## 9. 默认假设

“最后三分钟”按项目现有尾盘定义解释为**比赛结束前最后 180 秒**，不是开赛后的前三分钟；赛事格式不是采集筛选条件。如果要改成开赛后窗口，只需调整窗口锚点，不改变存储设计。
