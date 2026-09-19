# 全部单场比赛最后 180 秒紧凑采集器设计

**日期：** 2026-09-19  
**状态：** 待用户审阅  
**目标范围：** 由 `collector.config.json` 的运动 profile 发现的全部单场比赛；不再区分 BO3/BO5。当前网球任务默认保存所有网球单场比赛的终场前 180 秒，其他运动只有在 profile 显式启用时才采集。

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

1. 取消 BO3 限制，保留配置 profile 范围内的全部单场比赛。
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

数据库启动时设置：

- `journal_mode=DELETE`，避免 WAL 文件长期膨胀；
- `synchronous=NORMAL`；
- `foreign_keys=ON`；
- `auto_vacuum=INCREMENTAL`；
- 使用事务批量写入单场比赛。

核心表：

```sql
CREATE TABLE matches (
  game_id TEXT PRIMARY KEY,
  sport TEXT NOT NULL,
  title TEXT NOT NULL,
  event_ids_json TEXT NOT NULL,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  observed_finished_at_ms INTEGER,
  status TEXT NOT NULL,
  coverage_seconds INTEGER NOT NULL DEFAULT 0,
  expected_seconds INTEGER NOT NULL DEFAULT 180,
  source_run_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE markets (
  market_id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES matches(game_id) ON DELETE CASCADE,
  market_slug TEXT NOT NULL,
  question TEXT NOT NULL,
  outcomes_json TEXT NOT NULL,
  token_ids_json TEXT NOT NULL,
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE tail_samples (
  game_id TEXT NOT NULL REFERENCES matches(game_id) ON DELETE CASCADE,
  market_id TEXT NOT NULL REFERENCES markets(market_id) ON DELETE CASCADE,
  sample_second INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  score_json TEXT,
  book_blob BLOB,
  trades_blob BLOB,
  source_flags INTEGER NOT NULL DEFAULT 0,
  state_hash TEXT NOT NULL,
  PRIMARY KEY (game_id, market_id, sample_second)
) WITHOUT ROWID;

CREATE TABLE raw_audit_chunks (
  chunk_id TEXT PRIMARY KEY,
  game_id TEXT,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  compressed_bytes INTEGER NOT NULL,
  payload BLOB NOT NULL
) WITHOUT ROWID;

CREATE INDEX tail_samples_time_idx ON tail_samples(received_at_ms);
CREATE INDEX raw_audit_expiry_idx ON raw_audit_chunks(expires_at_ms);
```

`book_blob` 和 `trades_blob` 使用确定性 JSON 后再压缩；同一个市场同一秒的相同状态只保留一行。数据库只保存最终 180 秒窗口，不保存整场订单簿历史。

## 5. 采集与去重规则

### 5.1 比赛范围

- 不再使用 BO3/BO5 作为过滤条件。
- 仍使用 `singleMatchOnly`，避免冠军、赛程汇总等没有明确单场身份的事件进入市场采集。
- 当前生产配置默认只启用 `tennis`；`table-tennis` 或其他 profile 必须显式加入，避免因为默认 profile 产生无关数据。
- 一个 `gameId` 下所有开放且有订单簿的关联市场都保留，避免只收胜负盘而漏掉 set/total 等市场。

### 5.2 控制层

- 发现结果只保存规范化 metadata 及 hash；同一 event/market 的 metadata 未变化时只记录引用，不重复保存完整 Gamma response。
- Sports feed 只保存比分、period、live/ended、来源时间和必要的原始字段；heartbeat、重复比分和重复状态不写入结果表。
- 连接、订阅、错误只保留有限诊断记录，不把每次重连产生的完整 payload 当作业务数据。

### 5.3 滚动层

- CLOB 的 `book`、`price_change` 和成交消息先按 game/market/token 映射到内存状态。
- 只保留最近 210 秒；窗口外的逐帧消息立即丢弃。
- 对订单簿做状态 hash 去重；没有 bid/ask/trade/score 变化的更新不生成新样本。
- 每秒最多生成一个市场样本；一秒内的多次变更合并为该秒最后状态，并在样本中保留该秒的成交计数和极值。
- 进程异常退出时，未完成比赛的内存滚动层可以丢失；不会因此把无限时长 raw 流写到磁盘。

### 5.4 结束与发布

- 以 Sports `ended`/终场状态或现有生命周期确认作为结束信号。
- 结束后从滚动层截取 `[finish - 180s, finish)`；如果只知道观察到结束的时间，则写入 `finish_confidence=observed` 和覆盖状态，不伪造精确时间。
- SQLite 单事务写入 match、markets、tail_samples 和覆盖统计；提交成功后清理该比赛缓存。
- 没有可靠结束信号的比赛在内存 TTL 到期后只保存精简 metadata，不生成完整 tail 数据。

## 6. 磁盘上限与自动清理

新增配置：

- `tailWindowSeconds=180`；
- `tailBufferSeconds=30`；
- `rawAuditRetentionHours=24`；
- `maxRawAuditBytes=1 GiB`；
- `maxDatabaseBytes=8 GiB`；
- `maxCollectorBytes=10 GiB`；
- `databaseRetentionDays=30`；
- `maintenanceIntervalMs=60_000`。

维护顺序：

1. 删除过期 `raw_audit_chunks`；
2. 删除已经成功进入 SQLite 的旧 raw run/checkpoint/导出临时副本；
3. 删除超过 `databaseRetentionDays` 的最旧完整比赛结果；
4. 执行增量 vacuum，并在空闲时执行一次受限 `VACUUM`；
5. 若仍超过 `maxCollectorBytes` 或系统可用空间低于 `minFreeBytes`，暂停 CLOB 采集，只保留最小控制状态；
6. 维护操作必须是幂等的，清理失败只能记录错误，不能误删当前比赛或未提交事务。

达到阈值后不再单纯“暂停但保留全部数据”；系统必须先尝试释放最旧、已确认可重建/已入库的数据。

## 7. 兼容与导出

- 现有 `collect:tail` 增加从 `tail.sqlite` 导出 180 秒逐秒数据的路径，输出格式继续兼容现有 tail backtest。
- 旧 NDJSON run 仍可只读回放，但不再作为连续采集器的新默认存储。
- `status` 增加：数据库大小、raw 审计大小、缓存比赛数、已完成比赛数、最近维护时间和最近一次清理结果。
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

“最后三分钟”按项目现有尾盘定义解释为**比赛结束前最后 180 秒**，不是开赛后的前三分钟。如果要改成开赛后窗口，只需调整窗口锚点，不改变存储设计。
