# 持续采集器：运行入口、归档与数据边界

这套入口用于持续收集不同场次，不是之前固定 30 分钟的静态验证样本。它不读取交易账户、不下单，不按挂单价、赔率、交易量或最后赢家过滤数据。

最新修复与回测见文末的 **2026-09-16** 记录；中间较早的部署快照保留作为历史证据，不代表当前运行状态。

## 打开和控制

本机状态页：**http://127.0.0.1:8765/**。

在项目目录执行：

```sh
npm run collect:start
npm run collect:status
npm run collect:stop
```

`start` 安装并启动本用户的 `com.polyfifa.public-collector` LaunchAgent，异常退出由系统重新拉起；已经运行则不重复启动。`stop` 只停止本采集器，保留配置和全部数据。`status` 同时显示服务、保存状态和最后数据时间，不能仅凭 PID 存在认定数据健康。

前台调试用 `npm run collect:continuous`，退出该终端会停止前台实例。不要与后台实例重复运行；数据目录的独占锁会拒绝重复写入。

配置：[collector.config.json](../collector.config.json)。当前默认网球 `864`、乒乓球 `103767`，按比赛开赛时间范围发现新事件，包含低／零成交量、双方方向、关联子盘口；之后持续跟踪已发现的事件。其他球类可加入已核验的 Gamma 标签。代理 `http://127.0.0.1:10808` 是本机配置，不是通用互联网地址。换机器应调整代理、存储目录及运行方式。

配置修改后先 `collect:stop` 再 `collect:start`。改变数据目录不会自动迁移旧文件。macOS 开机登录后服务可启动；本机保持空闲不休眠，但合盖、关机、注销或网络中断仍会造成缺口。这些缺口不能用插值伪装成完整行情。

### 当前紧凑采集模式（2026-09-19）

生产配置已启用 `compactStorageEnabled=true`。这不是减少比赛范围，而是减少无用落盘：所有配置 profile 发现的比赛仍参与身份、比分和生命周期处理，但完整 CLOB/Sports 原始帧不再永久写进 NDJSON。

- 订单簿、成交和状态帧先进入有界的 SQLite staging 区，正常情况只保留最近 `tailWindowSeconds + tailBufferSeconds`（当前 180+30 秒）；连续重复 payload 按 hash 合并，但同一场比赛最多只合并 60 秒：全天合并会让静止不动的盘口在自己窗口里一行都不剩，finalize 拿到空窗口反而无法归档（`redundantKeepAliveMs`）。仍未拿到终场标签的比赛会豁免这条墙钟规则：只保留该场自己最后 `tailWindowSeconds` 的滚动片段，`pendingFinishRetentionMs`（当前 15 分钟）后释放。理由见下面“终场标签补查”。这个豁免在 finalize 写入 `matches` 后立即失效，所以不会让已归档的场次继续占空间。
- 已知终场但尚未 finalize 的比赛会把自己的窗口钉住：维护任务按墙钟时间裁剪，若不等归档完成就删，尾窗最前面的秒数会被静默吃掉。finalize 返回窗口覆盖情况，前段缺失时写入 `error`，不再当成干净成功。
- CLOB WebSocket 一条消息会批量携带多场比赛的帧。落库前按 token 归属逐帧拆分，只写给拥有该 token 的比赛；无归属或跨比赛的帧丢弃，避免把别场的盘口混进本场 tail。
- `/books` 批量锚点一次请求 50 个 token，上游可能只答其中一部分：状态机只把**响应里真正返回**的 token 记为收到盘口（`book_snapshot_batch` 的 `response`，不是请求列表 `tokenIds`）。把请求列表当证据会把 `lastBookAtMs` 推到该场真实最后一帧之后，静默锚点落在空窗口上，整场归档成 `no compact records in final window`。
- 归档前先看请求窗口 `[终点-180s, 终点]` 里到底有没有帧。没有帧时说明发布的终点时钟和库里的帧不重叠，两个方向都会发生：时钟晚于最后一帧（`/books` 批量只答了别的 token、或时钟本身迟到），或者时钟早于最后一帧（网球盘口在比赛结束后仍继续交易、终场标签晚十几分钟才到，此时比赛末尾那 180s 已被墙钟规则释放）。两种情况下都改用**库里真实持有的最后一帧**当窗口终点，`finish_anchor` 记为 `book-tail`，并在归档 `error` 里写清发布时钟与所用尾帧（`finish anchor moved to the last stored frame (...)`）。这样发布的是真实市场尾段，而不是一个空窗口；原始终点时钟仍然保留在错误说明里。
- 因为拆分后同一 `(game, run, sequence)` 会对应多条帧，`staging_records` / `tail_records` 的主键包含 `frame_index`（schema v2）。旧库启动时自动原地迁移，已有行以 `frame_index=0` 保留；`compact_meta.schema_version` 记录版本。
- `matches` 另存窗口覆盖（`window_start_ms` / `window_complete` / `missing_front_ms`，schema v3）与窗口终点来源 `finish_anchor`（schema v4）。回测筛选样本时以 `window_complete` 为准，不要假定每场都是完整 180 秒；需要只用官方终场钟的样本时按 `finish_anchor` 过滤。
- 逐帧归属修复前写入的 tail 含别场帧。用 `npm run collect:compact -- repair-tail --data-root <PATH>` 先做 dry-run，确认后加 `--apply` 就地重写：只保留本场帧、丢弃只剩别场帧的记录，并按保留帧回填真实窗口覆盖。命令不做锁，执行前必须先 `collect:stop`。
- 比赛确认结束后，只把终场前 180 秒复制到最终结果表；成功写入后删除该比赛的 staging 记录。
- compact 模式默认不再做每分钟逐 token HTTP book 快照；WebSocket 的市场帧是主要价格来源，发现 metadata、身份冲突和终场证据仍保留。
- `compactAnchorSnapshots=true`（当前生产配置）时保留低频 HTTP book 快照作为**锚点**：`price_change` 只是增量，没有全量 book 锚点就无法把 SELL 档位变化重建成 ask ladder，而 WebSocket 并不保证对每个 token 都推全量 book。实测开启后 91% 的订阅 token 在窗口内拿到锚点。HTTP 锚点同样计入 `firstBookAtMs`，否则只靠锚点拿到全量 book 的比赛会被误判为 `missed` 而永不归档。
- 已解析子盘口（每盘胜者、大小分、让盘等）会在 Gamma 翻转 `closed` **之前**先从 CLOB 撤掉订单簿。旧实现把它们当成“批量响应身份不匹配”，每个快照周期都对同一批 token 重新请求、重新记一条 `book_snapshot_batch_error`：实测 4 个 raw run 里有 876 条这类记录、1150 个 token。逐 token 复核证明这些 token 调单 token `/book` 一律返回 404 `No orderbook exists`，且 151 个“既拿到过锚点又被报缺失”的 token 中，**没有一个**是在报缺失之后才拿到锚点的——缺失始终是真实无盘口，不是上游偶发漏发，所以不能加 GET 兜底。现在 `absentBookCooldownMs`（默认 5 分钟）记住这类 token 并暂时移出锚点轮换，同一段缺失期只报告一次；token 重新拿到 book 后立即清除记录，之后的再次缺失会重新报告。这既省掉无意义的上游配额，也不再往 raw run 里写重复诊断。
- 超上限时的裁剪按**每场实际占用**估算要释放的字节，再删最旧的场次，最后 `PRAGMA incremental_vacuum` 真正把页还给系统。旧实现把 `databaseBytes()` 放在删除循环里当停止条件：`auto_vacuum=INCREMENTAL` 下删行只把页放进 freelist，文件大小在提交和回收前根本不降，于是条件永远不成立，**一次超限就把整库删空**（实测 5 场全删）。现在按 `databaseBytes()/存活行数` 摊到每场，删够就停，最多 4 轮收敛。
- `window_complete` / `missing_front_ms` 衡量的是**有没有证据**，不是"有没有行"。连续相同的 payload 会被 keep-alive 合并成每 60 秒一条，于是窗口开头常常没有行——但那条被合并的帧与它之前存下的帧逐字节相同，说明盘口在这段时间根本没动，ask ladder 照样能从窗口起点重建。现在 store 记录每条合并链覆盖的区间 `[上一个已存帧, 最后一条被合并帧]`，只要这个区间跨过窗口起点就判定窗口完整。实测 71 场里有 62 场被标成 `window_complete=0`，其中 **54 场属于这种误判**（行密度 ≤1.5 行/秒，是合并造成的），只有 8 场是真的缺数据（6 场还是修复前的 `finish_anchor=NULL` 旧行）。按 `window_complete` 过滤样本会白白扔掉约四分之三的可用比赛。
- `maxTailStoreBytes=8 GiB` 是 SQLite 上限，`tailRetentionDays=30` 是最终结果保留期；超过上限先删除最旧结果并增量回收空间。
- `rawRunRetentionHours`（当前 6 小时）只约束 compact 模式下的 raw run：帧证据在 SQLite 里，raw run 只是发现／审计上下文，按小时清理而不是按 `tailRetentionDays` 的 30 天清理，否则每天几十 GB 的 metadata 会把磁盘吃满。关闭 compact 模式时该值不生效，raw run 仍需保留 `tailRetentionDays`，因为旧的导出路径直接读它。
- 维护任务还会删除超过保留期、且不是当前 run 的旧 raw run。系统剩余空间低于 `minFreeBytes` 时仍会暂停，清理失败不会静默丢数据。
- `collect:stop` 会在 `dataRoot/.collector-stopped` 留下标记，`collect:start` 清除它。健康守护据此区分"人为停"和"自己挂了"：有标记时不重启、也不再刷 `mode_not_collecting` / `status_stale`。旧守护分不清两者，`collect:stop` 之后 300 秒就被自动拉起来，而且在等待期间每 5 秒写一条告警——`repair-tail` 的文档恰恰要求先 `collect:stop`，会被这个自动重启打断。

因此当前模式的可查询结果在 `tail.sqlite`，不是 `runs/` 中的全量市场 raw。需要旧的逐帧 NDJSON 回放时，必须显式关闭 compact 模式；不要把两种存储的覆盖语义混在一起。

## 程序持续做什么

1. 周期查询各项目目录，独立处理项目或关联事件的查询失败；有效新场次继续加入，旧场次不会因一次接口失败就被当作结束。
2. 在 compact 模式下处理收到的 CLOB 深度／成交帧和 Sports 状态帧，按比赛和 payload hash 去重并只保留滚动窗口；旧 NDJSON 模式才原样保留全量 raw。订阅不会等几千个 HTTP 快照全取完才开始下一轮发现。
3. compact 模式不做周期性逐 token HTTP book 快照；发现 metadata、身份冲突和必要的 HTTP 摘要仍留证。旧模式仍可使用公共 `/books` 批量审计，每批 50 个 token，按 asset ID 关联响应。
4. 对明确的结束信息执行短暂保留期，当前生产配置为 30 秒；终场前 180 秒由 SQLite 结果层固定保存。结束信号的重复出现不重置计时；子盘口早关闭不等于全场结束。
5. 对达到条件的场次把滚动帧事务性写入 `tail.sqlite`，不为每场再复制一份全量 raw checkpoint；回放导出放到单独进程执行，不占用接收行情的事件循环。
6. 结束标签晚到时继续补查，记录原始响应；不把后来比分倒灌到此前的每秒数据。终场钟始终缺失时按 `finishAnchorGraceMs` 回落到该场最后一帧盘口时间，并把来源写进 `finish_anchor`，不把回落终点伪装成官方终场时间。重启后的待导出场次仍关联原来的 raw run，不拿一个新空运行冒充旧数据。

终场标签补查（2026-09-20 修正）：Gamma 的 `finishedTimestamp` 通常在 Sports 状态流报结束后才写入，所以事件退役不等于拿到终场钟，必须重试。旧实现每 5 秒只发一个请求，并在“所有已退役但未拿到标签的场次”里按上次尝试时间排队；线上该队列有 400+ 场，新结束的比赛第一次补查（那时 Gamma 往往还没有标签）之后就被排到队尾，等轮到它时终场前 180 秒早已被裁剪，`matches` 里什么也不剩。实测 13 场终场标签的到达延迟中位数 445 秒、p90 3126 秒，远超 210 秒的 staging 保留期。

现在的规则：证据最新的场次优先（陈旧场次不能挤掉刚结束的比赛），证据仍在 `pendingFinishRetentionMs` 内的场次按 `finishFollowupIntervalMs`（当前 15 秒）重试，每轮 `finishFollowupBatchSize` 个请求并发执行；证据已经过期、标签再查也拼不出窗口的场次只做一次尝试后停止，避免继续消耗配额。跨运行的终场事实保存源 run、原始序号、帧下标和观察时间，只用于补充边界；不会改写旧盘口、旧比分或关闭状态。终场证据变化会让旧归档重新核验，不能继续复用过时结论。

窗口终点来源（2026-09-20 修正）：Gamma 只在少数事件上写 `finishedTimestamp`。实测抽样 30 场已收盘、确实收到过盘口的网球／乒乓球比赛，`closed=true` 且 `finishedTimestamp=null`（多数事件永远不写这个字段）；Sports 状态流也只为部分比赛推送终场帧。因此“等官方终场钟”本身就会丢样本。现在按 `finishAnchorGraceMs`（当前 5 分钟）给官方时钟留出补发时间，之后用该场自己**最后一帧盘口时间**作为窗口终点，记为 `finish_anchor='book-quiet'`。这个终点按定义落在比赛之内，窗口是真实末尾 180 秒的子集，不是猜测；已经用 `book-quiet` 发布的窗口不会被后来才出现的时钟改写（差别只有秒级，重写只会让已发布样本不可复现）。`finish_anchor` 取值：`gamma.finishedTimestamp` / `sports.finishedAt`（官方钟）、`book-quiet`（来源从未发布时钟时的盘口静默回落）或 `book-tail`（发布时钟与库内帧不重叠时改用真实最后一帧），旧行升级后为 NULL 表示来源未知，不假定。

当前捕获的“结束”是源报告，不是视频核准的场上结束毫秒。默认尾窗跟随全场实际结束标签；每一盘、每一局等自己的尾窗仍需要独立且可信的阶段终点。原始阶段信息会保留，不用全场终点冒充盘末终点。

## 数据位置

默认根目录：`data/collector/continuous/`。

```text
state.json                 当前运行及热缓存内的比赛状态，不是完整历史归档目录
tail.sqlite                去重后的滚动窗口与终场前 180 秒结果库
collector.lock             当前写入实例的独占锁
runs/<runId>/*.ndjson[.gz]  compact 模式下主要是控制/metadata；旧模式才是全量原始记录
*.gz.integrity.json       解压字节数与 SHA-256、压缩文件 SHA-256
checkpoints/<id>/          已封口分段的只读硬链接视图
exports/<id>/             逐秒深度、变化、审计、质量报告和查看器
finish-facts/             带原始来源引用的终场事实，仅用于回放边界
logs/                     后台服务标准输出与错误日志
```

每次采集进程重新建立运行，都创建新的 run，不覆盖当前 run。时间窗跨过实际断线或重启时，如果缺少所需数据就标为不完整。compact 模式下旧 run 只保留到 raw retention 到期，最终比赛结果在 `tail.sqlite` 中独立保存。

Checkpoint 记录明确的 `checkpoint_end`，它只代表一次不可变的观测截止点，**不是采集器停机或比赛结束**。旧 NDJSON 模式仍可从 checkpoint 回放；compact 模式不为市场 raw 生成全量 checkpoint，避免把同一行情复制到 runs、checkpoints 和 exports。

compact 模式有自动清理策略：SQLite 默认上限 **8 GiB**，结果保留 30 天，旧 raw run 也按保留期清理；系统剩余不足 **20 GiB** 时仍停止网络采集并标为 `paused_disk`。空间恢复后用新 run 继续。清理只针对已过期且非当前 run 的数据，不删除当前滚动窗口。

触发暂停后，要恢复到至少 **21 GiB** 空闲空间才会自动恢复，以免在阈值附近反复启停。`checkpoints/` 与 `runs/` 中有共享同一 inode 的硬链接，`du` 会把共享字节计到先遍历的目录；不能把 checkpoint 的目录大小当作可直接清理的重复副本。

旧 NDJSON 模式已实现经过校验的 gzip 存储：逻辑分段名不变，读取器自动选择普通／压缩文件，旧快照清单不需要改写。每个 inode 只压缩一次；全部已知硬链接的压缩文件及完整性说明发布并落盘、整文件解压校验通过后，才替换未压缩文件。原始消息、顺序和时钟字节不改写。不要直接对目录批量运行普通 gzip，以免遗漏共享链接或完整性校验。

旧 NDJSON 模式的后台压缩由 `compressionEnabled` 显式开启，每批数量、间隔和超时可配置。当前部署每批最多 64 个分段，间隔 60 秒、超时 120 秒；compact 模式的主要容量控制由 SQLite staging、结果保留和 raw-run 清理完成。它与归档互斥，排除正在写入的尾段；每批压缩后给待归档场次执行机会。状态页单独显示压缩状态和本进程减少的逻辑字节数，实际磁盘余量仍以文件系统为准。手工迁移同一数据根目录前先停服务：

```sh
npm run collect:stop
npm run collect:compact -- --root data/collector/continuous/runs --root data/collector/continuous/checkpoints --replace-verified
npm run collect:start
```

`seconds.ndjson` 等导出结果保持原格式，因此查看器的字节范围索引不受原始日志压缩影响。

新连续导出的 `raw-events.ndjson` 副本在写入封口后也执行整文件无损校验压缩，通常保存为 `raw-events.ndjson.gz`；不压缩逐秒深度或变化文件。`manifest.json` 记录实际原始证据文件名、编码前后字节数和原文 SHA-256，gzip 同时有完整性侧车文件。压缩失败不能发布完整归档；压缩不更小则保留普通格式。普通手工 `collect:tail` 默认不改变格式，需要时加 `--compress-raw-events`。

状态页打开的回放可自动从同一本机服务按字节范围读取所选秒的完整盘口；直接双击离线 HTML 时仍用文件选择器。不会为了显示历史盘口而去请求当前交易所价格，也不会向外部站点上传文件。

页面中的“历史归档”从磁盘上的完整导出读取，分页接口为 `/api/archives?offset=0&limit=20`。即使比赛被移出实时热缓存，`/archives/<导出目录名>/viewer.html` 及同目录的深度下载仍可使用。同场重新导出会保留为不同版本；历史质量不是对当前有冲突的终场信息重新背书。目录缓存最长约 30 秒，未完成的导出尝试单独计数，不算成完整比赛。

损坏的状态文件不会被空状态覆盖。独占锁不会杀死其他进程；极少数情况下，进程恰好在恢复旧锁时被强制终止，会留下 `collector.lock.recovery`，需要核查锁记录和进程后处理，不能直接删除整份数据目录。

## 如何判断“能不能用”

状态页的“采集中”仅表示程序正在录制；不等于该场已经录全。尚未结束的比赛自然没有完整的事后最后 180 秒报告。启动时已经进行或结束的比赛，缺少的之前行情也不会凭空补出来。

归档查看器分别展示：

- **盘口价格可回放**：价格窗口覆盖和快照审计达到要求。
- **比分不完整／过期**：价格可能完整，但不能把该样本当成完整的价格＋实时比分联合数据。
- **已关闭**：该窗口内盘口已关闭，不是“缺价格就等于价格没变”。
- **采集范围外／实际缺失**：没有足够数据，保留原因，不隐藏失败样本。
- **终场来源冲突**：需要重新核查。旧快照不能自动当成新终点；已知冲突不能产生合格计数。

`archive.status=complete` 只表示文件写完，是否合格还要看 `priceReadyTokens`、`strictReadyTokens` 和具体的 `quality.json`。公开数据源缺少逐分、发球方、时钟或真正事件时刻时，相关字段保持缺失，不能据此声称已经确认某一次跳价由某个得分造成。

连续导出使用 `--clock-policy flag-backsteps`：原始 UTC、单调时钟和序号全部保留，受小幅 UTC 回拨影响的秒明确标为不确定，其他时间窗仍可核验。单调时钟倒退、大幅偏移仍不能通过；连续进程发现超过 5 秒的时钟偏移会换新 run。普通手工 `collect:tail` 仍默认严格模式。

连续导出保留 **301 秒**：最后 300 秒用于研究，额外 1 秒提供 T−300 之前已经知道的入场报价。旧的 300 秒归档仍可回放，也可研究其中的 60／180 秒窗口，但不能凭空制造 T−300 的事前报价。

## 盘口挂单回测

这是逐秒盘口与秒内变动回测，不替换原来的成交历史 `research:backtest`。例如：

```sh
npm run research:books -- \
  --archive-dir data/collector/continuous/exports/verified-raw-gzip-preroll-20260916 \
  --output-dir data/research/my-new-book-report \
  --sport tennis --prices 0.50,0.60,0.70,0.80,0.90,0.95,0.97,0.99 \
  --windows-seconds 60,180,300 --entry-min-bid 0.90 \
  --allow-book-anchor-finish --allow-partial-archive-window \
  --fetch-settlements --proxy-url http://127.0.0.1:10808
```

`--archive-dir` 可重复；输出目录必须尚不存在，且不能位于输入归档内。默认不联网，`--fetch-settlements` 才补查公开结算标签。报告保存输入文件路径／哈希及结算响应，输出 HTML、JSON、场景 CSV 和汇总 CSV。

默认在入场前完整一秒的盘口中选择最高买价方向，而不是事后挑赢家；完整且明确为空的卖盘可以挂买单，缺失的盘口不可以。默认 `quote-touch-assumed` 按触价假设成交；`--fill-model sell-through-volume` 则只计该方向严格低于限价的主动卖出成交量，并可设置挂单量、排队量和费率。未结算的假设成交收益保持空值；数据不合格的场景也不会被当成零亏损。盈亏符号按精确十进制计算，不用浮点残差决定胜负。

这些场景用的是事后确认的**全场终点**。每盘、每局的盘口可以作为该全场时间窗中的不同赌局研究，但报告没有把全场终点说成它们自己的盘末／局末。不同价位、窗口和同场盘口相互重叠，不可把场景收益直接相加当投资组合收益。

## 本次实际排错

实际扩大网球采集时发现元数据突发写入触发 `JOURNAL_BUFFER_OVERFLOW`，原程序在订阅前就退出。已给受控的 HTTP／目录／元数据写入加排队等待，去掉重复的 normalized 原始对象；WebSocket 原文仍直接录入。

随后发现初始逐 token HTTP 请求会让数千 token 的启动停在 `starting`，并推迟发现下一批比赛。现在发现计时与 HTTP 暖启动解耦，并使用批量接口。批量接口已经用安装的官方客户端实现和真实公开请求核对；一次四个活跃 token 的测试返回四份完整深度，顺序与请求不同；过期 token 可返回空列表。没有声称文档抓取成功，也没有把空列表当成有效空书本。

调试期间保留的真实历史运行：

- `data/collector/continuous-bootstrap-tennis-fixed-20260913/`：连续录制约 3 小时 31 分钟，之后正常停止。
- `data/collector/continuous-bootstrap-table-tennis-20260913/`：连续录制约 3 小时 42 分钟，之后正常停止。
- `data/collector/continuous-bootstrap-tennis-20260913/`：最初发生缓冲溢出的失败运行，保留诊断证据。

前两路是在新的总采集进程已收到两类行情后才停止的，不是删掉旧数据重做。当前应看持续采集状态页，而不是把以前 `tail-final-20260913/viewer.html` 的静态样本当成实时页面。

本次还实际定位到一处 UTC 回拨：序号 1622887 → 1622888，墙钟回退 131 ms，单调时钟前进 16.513 ms。修复后重放 Kichenok–Hibino：该场末段不与回拨区间重叠，6 个开放方向各有 300 个有效盘口秒；比分新鲜度为 256/300。结果在 `data/collector/continuous/exports/verified-clock-sample-20260914/`。原时间未改写，受回拨影响的其他窗口不会被假装完整。

## 部署验收快照：2026-09-14 19:04（北京时间）

这是一次有时间标记的实测记录，之后的实时状态以状态页和 `collect:status` 为准。

- 代码已本地合并到主项目。用户级 LaunchAgent 已安装；实际启动、正常停止、重新启动已验证，服务使用主项目路径，不依赖开发 worktree。此次复核的进程 PID 为 `57005`，plist 校验通过。
- **本次复核时不是采集中。** 服务为 `paused_disk`，磁盘约剩 20.03 GiB；该进程接收计数为 0、没有行情连接。服务和状态页存活不代表仍在录制。未降低磁盘安全余量，未删除或替换任何原始日志。
- 保存状态中共 343 个比赛／事件条目：338 个中断、4 个已归档、1 个错过采集。条目数不是完整比赛数。已保存场次的最近盘口观察时间为 2026-09-14 07:55:40（北京时间）；磁盘暂停错误记录于 08:14:37。暂停期间的历史盘口不能事后补成连续数据。
- 四场自动归档的查看器、质量报告、清单和深度文件入口均返回 HTTP 200。实际归档结果如下；方向指一个 outcome/token，不是比赛或盘口数量。

| 比赛 | 有效盘口秒（开放方向） | 价格就绪方向 | 严格就绪方向 |
| --- | --- | --- | --- |
| Kozyreva/Lumsden–Day/Zarazua | 2 个方向各 30/300 | 0 | 0 |
| Kichenok–Hibino | 6 个方向各 300/300 | 6 | 0 |
| Sorribes Tormo–Dolehide | 2 个方向各 299/300 | 0 | 0 |
| Monnet–Scott | 2 个方向各 297/300，另 2 个各 299/300 | 0 | 0 |

直接打开已验证样本：[Kichenok–Hibino 逐秒盘口](http://127.0.0.1:8765/exports/game%3A6237021/viewer.html)。此链接由本机服务提供；不是实时盘口，也不是完整比分样本。

对该查看器索引中的全部 **9,600 行** 实际发起独立 HTTP Range 请求，逐行核验 HTTP 206、字节范围、长度、行身份及价格／数量字符串，并与磁盘上的 `seconds.ndjson` 逐字节比较，全部一致。索引无缺口地覆盖 12,453,781 字节，SHA-256 为 `73ce2335ff016e1956f145fedfb1b09ae0d65eb9ce62c5b6031157bcf0b26ab5`。其中 1,800 行为有效盘口秒，3,000 行为关闭状态，4,800 行为无效状态；后两类没有当作有效价格。6 个价格就绪方向各覆盖 300 秒，比分新鲜度仍是 256/300。

这项验证证明归档字节和本机按秒读取链路一致，不是对交易所从未漏发的保证，也不是浏览器视觉自动化测试。已请求系统浏览器打开该样本。

新一轮验证：72 个测试文件／1,999 项测试通过，typecheck 通过。首次与 typecheck 并行运行时，一项既有 `locked-refill-watch-stress` 测试超过 5 秒；单项复测和不改代码的全量重跑均通过，未通过增加超时或删减断言掩盖失败。

**仍未通过的运行验收：** 解决容量后，确认自动恢复、新 raw 文件持续增长、两路公共数据重新到达、新比赛加入以及新完赛归档。当前不能据此宣称已实现不间断采集。

### 容量核查：只读测量，未执行压缩迁移

本次 `du -sk data/collector` 为 80,871,856 KiB，约 **77.13 GiB**。按设备号和 inode 去重，持续运行及三份 bootstrap 的原始 NDJSON 共 **78,666,759,290 字节（73.26 GiB）／1,212 个 inode**。持续运行的 923 个原始文件占 59,691,727,879 字节；checkpoint 的 6,746 条文件路径全部指向其中已有的 838 个 inode，没有额外的独立原始字节。删除 checkpoint 路径不能释放仍被 run 引用的这些字节。

从持续运行、网球 bootstrap、乒乓球 bootstrap 各选一个封口分段的前 32 MiB，只在内存／流管道中进行 gzip level 6 → 解压 → SHA-256 校验，共测试 96 MiB。压缩结果合计 9,478,304 字节，约保留原大小的 **9.42%**；三个样本解压前后哈希均一致，没有创建压缩文件，也没有替换源文件。

样本分别为 `run-d3d643d3-daee-4ec1-9fae-dc309f1cc4d3/2026-09-13-000419.ndjson`、`continuous-bootstrap-tennis-fixed-20260913/2026-09-13-000111.ndjson`、`continuous-bootstrap-table-tennis-20260913/2026-09-13-000031.ndjson`。这些仅占原始字节约 0.128%，不能把样本压缩率当作全库已释放空间或保证值。

可选后续是指定更大存储位置，或实现读取器／快照兼容的无损压缩及可恢复迁移。历史文件只有在整文件压缩、持久化和解压字节校验均通过、全部引用兼容，并得到存储表示替换授权后，才能替换旧的未压缩副本；不能直接对硬链接日志批量执行 gzip。只复制或额外生成压缩副本不会释放源盘空间。

## 2026-09-15 存储恢复实测

用户已授权无损压缩替换。上述“尚未压缩”是之前的验收快照，不是本节之后的实时状态。

- 持续采集的 923 个分段／7,669 个链接路径：59,691,727,879 字节压至 6,377,539,272 字节，全部通过整文件字节与 SHA-256 校验，无跳过项。
- 三份 bootstrap 的 289 个分段：18,975,031,411 字节压至 1,995,111,656 字节，同样全部通过，无跳过项。
- 合计 1,212 个原始分段，78,666,759,290 字节变为 8,372,650,928 字节，减少约 **65.47 GiB** 逻辑存储。实测文件系统空闲恢复到约 **84.48 GiB**；实际值还会受新的录制及其他应用影响。
- 新版支持原始格式／gzip 混合读取、旧 checkpoint、来源版本变动拒绝、文件落盘失败保留、中断重试和无异步插入的最终链接切换。错误或不更小的压缩文件不会授权移除原文。
- 已从压缩后的 Kichenok–Hibino 日志成功导出 301 秒样本；额外一秒供回测入场参考，原 300 秒查看器没有覆盖。
- 新记录的同次 Gamma 分页正文改存来源引用，HTTP 响应原文保留一次；每次比赛状态观察仍保留，盘口与审计采样频率不降低。

9 月 15 日恢复部署时 `singleMatchOnly` 暂为 `false`。9 月 16 日文本边界复核完成后已启用 `true`；排除赛季累计、排名、冠军等非单场事件，同时保留无 gameId 的 ITF、双打、单场统计和关联盘口。运行健康仍须结合模式、最近行情时间和新记录增长判断。

## 2026-09-16 增量修复与真实结果

- 大行读取原本反复搜索已累计的字符串：8 MiB 测试记录产生约 540 MiB 搜索工作。现按输入块线性分行，保留完整 JSON／记录封套验证。相同真实 gzip 样本耗时 1,263 → 253 ms，13 条记录的内容摘要完全一致。
- 4 分段压缩批次无法追上采集和长归档；已提高为 64，保留 20／21 GiB 保护阈值。启动本轮时实际只剩约 21 GiB，已经发生过保护暂停，不能宣称此前全程连续。
- 一次受控停止后的 64 分段压缩将 4,087,490,774 字节变为 475,853,373 字节。只替换已完整核验的存储表示，没有删除行情记录。重启前最后盘口为北京时间 04:08:15.492，重启后第一条为 04:11:39.359，实际间隔 **203.867 秒**，不插值补齐。
- 此前持续超时的 Kinoshita–Brace、Osuigwe–Tikhonova、Zverev–Shelton、Vidmanova–Tjen 已生成完整文件。Zverev–Shelton 的终场仍有冲突，因此价格就绪保持 0；文件导出成功不等于质量合格。
- 已定位并修复热缓存淘汰导致历史链接 404：文件原本仍在磁盘上。05:01 的目录扫描找到 32 份完整导出、29 个不同比赛；同场验证版本不重复计入研究样本。未完成目录是导出尝试，不是同等数量的比赛。
- `verified-raw-gzip-preroll-20260916` 的原始消息副本 226,887,270 → 24,948,335 字节；原版与解压后 SHA-256 都是 `e146cb642849eb2b449cb082a9302ba6517a0105bc2d0524ccb3b8a30a3fb22c`。其 9,632 行逐秒盘口、变化及质量文件与之前 301 秒版本逐字节一致。
- 初始触价回测已保存在 `data/research/collected-books/20260916-tennis-touch/`：29 场、11,856 个参数场景，996 个场景满足数据和入场条件，涉及 22 场／81 个盘口。只有 1 份输入已有 301 秒，因此旧样本的五分钟入场参考缺失仍会明确排除。
- 这批样本的 0.50／0.60／0.70／0.80 挂单价没有合格触价；0.90、0.97、0.99 分别有 1、1、5 个触价场景。这是重叠场景的触价计数，不是 7 笔真实交易，也不足以选出未来最优价位。
- 对照报告 `20260916-tennis-sell-through/` 复用相同输入以及 988 个已确认结算标签、30 份原始公共响应，没有再查一遍网络。它同样发现 7 个触价场景，但没有满足“该方向主动卖出严格穿过限价”的模型成交；两份报告的成交口径不同。

### 同一日志里的上游身份变更

后续运行验收发现：Setka 事件 `1021055` 的事件 slug、盘口 ID 和 10 个 token 均未变，但原始序号 `9440520 → 9461275` 中 `gameId` 从 `339600145` 变成 `1798263461`，间隔 41.579 秒。它使同一 run 中无关网球场次遇到全局 `TAIL_METADATA_IDENTITY_CONFLICT`。

现在仍拒绝该场及所有与它共享历史身份的场次，也拒绝没有明确赛事筛选的整库导出；不会自动认定新编号或旧编号正确。仅对明确筛选且与冲突完全不相连的场次，隔离冲突涉及的事件、slug、全部比赛编号、market、condition 和 token。旧身份仍被保留占用，不能伪装成其他比赛的关联比分；记录封套、顺序、时钟、解压和跨身份检查仍执行。诊断包含原 run、序号、接收时间和两份身份，原始日志不改写。

身份先从原始记录统一登记：不完整事件／盘口中可识别的 ID 也保留，原生比分、终场和外部终场事实都使用同一份登记。只出现于不完整记录的事件不能冒用其他比赛；`slug` 与 `eventSlug` 的改名也同样拒绝，不因为标准化时缺字段而漏过校验。

真实重放 `verified-identity-boyer-winter-20260916` 已完成：301 秒、34 个方向、10,234 行，12 个价格可回放方向、0 个严格就绪方向。原始证据 574,916,224 → 61,651,383 字节。该源 run 自身有 `collector-session-failed` 标记，因此仍不自动进入合格收益统计；隔离无关身份冲突不是清除源日志失败或缺失证据。

最终校验版本另存为 `verified-identity-boyer-winter-final-20260916`。历史页面顶部提供直达入口，实时比赛表使用有限高度的可滚动区域，不再让上千条记录把历史入口推到很远的页面下方。

### 仍缺少的来源信息

本轮在热状态中看到 611 个 Setka 乒乓球事件和 271 个 ITF 事件已有盘口观察，但没有匹配比分观察或实际终场时间。对当前 run 的一次原始扫描包含 1,666 条 Sports 帧、1,517 条可解析状态：382 条网球、586 条足球，其余 549 条未标明标准运动类型。仅凭这批消息不能宣称已拿到乒乓球完整盘末／局末数据。

官方 [Sports 页面](https://docs.polymarket.com/api-reference/wss/sports)及[实时数据页](https://docs.polymarket.com/market-data/realtime-data)的检索证据保存在 `data/research/source-evidence/`。搜索主通道本轮返回 502，之后通过已配置的 Context7 文档检索和 Tavily 原页抓取完成核对；没有把检索摘要当作新的赛事时间证据。官方直连格式与当前解析一致，连上后自动推送全部比赛更新，不需要订阅帧；这不保证每个体育标签都提供状态，也没有给出独立网球盘末时间。

仍需可靠且能精确匹配比赛的实时比分／阶段终点来源；不使用市场结算时刻、endDate 或最后一次报价冒充真正终场。原始盘口继续留存，当前不会把这些场次包装成已完成的末段回测样本。复现文档核对可运行 `smart-search fetch https://docs.polymarket.com/market-data/realtime-data --format json`；只有实际获取的原页内容被用于上述结论。

## 2026-09-16 最终部署与容量验收

应用改动已本地合并并实际运行，未推送远程。最终应用验证为 **89 个测试文件／2,515 项测试通过**，typecheck 通过。历史页面顶部的直达入口、有限高度实时列表、历史查看器 HTTP 200、逐秒深度 HTTP 206 均已验证。

部署后新采集的 Etchecoin/Etchecoin–Cash/Seggerman 双打自动生成 301 秒、9,632 行归档，32 个方向通过价格覆盖／审计门槛，严格比分就绪为 0。可用价格数据和完整比分数据仍分开统计。对应初始回测另存于 `data/research/collected-books/20260916-live-doubles/`，384 个场景中 136 个符合数据／入场条件；当时还有 11 条未确认结算／请求诊断，不能把未确认标签当作已获利。

随后发现旧的完整导出还保留约 38.26 GB 普通 `raw-events.ndjson` 副本，再次触发磁盘保护。采用本机 APFS 透明文件压缩处理其中 **81 份**：逻辑原文共 **22,523,732,776 字节**，实际分配空间减少 **18,391,085,056 字节（17.128 GiB）**。每份都在替换前完整核对原文 SHA-256、源版本、单链接、权限及文件时间，并提前落盘校验证据。文件名、普通读取的内容、HTTP Range 语义和 manifest 均不改写；这不是把 gzip 数据冒充 `.ndjson`。

替换后又完整读取这 81 份文件验 SHA-256，并核对所有 manifest 哈希，全部一致。第一轮 29 场回测的 116 份输入文件哈希也全部未变。系统工具未压缩的较大文件仍保留原样；仅移除了一份 **537,626,933 字节**、已验证与原文件完全相同的临时重复副本，原文件仍在，可重新复制。

一次性迁移脚本和逐文件证据留在本机数据目录，未作为自动服务启用：

- `data/research/transparent-archive-compression-20260916.mjs`
- `data/research/source-evidence/transparent-archives-1789523516738.ndjson`（预先复制的验证样本）
- `data/research/source-evidence/transparent-archives-1789523672026.ndjson`（80 份批量转换）

透明压缩后文件的逻辑大小不变，磁盘实际占用应看分配块或文件系统空闲量。需要普通存储副本时，可用 `ditto --noclone --nohfsCompression --nopreserveHFSCompression 原文件 新文件`，并核对内容哈希，不要覆盖唯一源文件。

10:48（北京时间）的实测：PID `95588`，`mode=collecting`，新 run `run-8543da80-8097-4631-b2df-2769a85d9665` 已收到新盘口；空闲约 **36.34 GiB**。历史接口找到 157 份完整导出（含重复验证版本，不能等同独立比赛数），透明压缩文件的 1,024 字节 HTTP Range 与磁盘读取逐字节一致。20／21 GiB 保护阈值未降低，未删除行情记录。该数值是验收时点，后续状态以状态页为准。

### 本轮真实采集缺口

下表由相邻 run 的末条／首条原始盘口记录测得。它们是全局收流边界，单场是否覆盖仍看质量报告；不会用插值隐藏这些间隔。

| 操作 | 上一条盘口（北京时间） | 下一条盘口（北京时间） | 间隔 |
| --- | --- | --- | --- |
| 初次压缩恢复与部署 | 04:08:15.492 | 04:11:39.359 | 203.867 秒 |
| 历史入口／回测部署 | 06:57:43.822 | 07:02:34.457 | 290.635 秒 |
| 身份校验最终部署 | 08:29:55.019 | 08:30:26.174 | 31.155 秒 |
| 旧归档容量触发保护，释放空间后自动恢复 | 09:22:13.013 | 09:55:26.129 | 1,993.116 秒 |

最后一次暂停约 33 分钟。恢复后的采集已经验证，但这段历史没有补成“完整”；例如暂停期间完赛的场次仍可能得到 0 个价格就绪方向。

## 2026-09-21：compact 归档可回测、种子锚点、WAL

这一轮是系统审计，不是又一处补丁。以下四点一起决定“compact 模式收集到的数据到底能不能用来回测”。

### 1. compact 数据以前根本导不出来（已修）

`beginCompactArchive` 只把帧写进 `tail.sqlite`，而 `beginArchive` → `runTailExport` → `tail-cli export` → `tail-replay` 这条链路扫的是**原始 run 的 NDJSON**；compact 模式故意不往 NDJSON 写盘口帧，所以那条链路在线上是死代码。同时 `readFinalized` 没有任何调用方，`tail-backtest-cli` 只接受 `--archive-dir`（导出产物），于是收集到的盘口无法回测。

新增：

```sh
npm run collect:export-tail -- --data-root data/collector/continuous --output-dir data/collector/continuous/exports
npm run collect:export-tail -- --data-root data/collector/continuous --output-dir OUT --game-key game:123 --game-key event:456
npm run collect:export-tail -- --data-root data/collector/continuous --output-dir OUT --limit 20 --window-seconds 180
```

每场输出标准归档目录（`manifest.json` / `quality.json` / `seconds.ndjson` / `changes.ndjson` / `raw-events.ndjson.gz` / `viewer.html`），可直接：

```sh
npm run research:books -- --archive-dir <该目录> --output-dir <新目录>
```

### 2. 回放引擎只认 WebSocket `book` 帧，compact 里它早就被裁掉了（已修）

`replay.ts` 只用 WS `book` 帧建立盘口，`clob/book_snapshot`（HTTP 锚点）只当审计证据。compact 只保留最近几分钟，订阅时那一帧全量 `book` 早已被裁掉，于是任何一场 compact 回放都是 `validSeconds=0`。

导出时会把每个锚点**同时**写两条记录：原样的 `book_snapshot`（保留审计）和一条等价的 WS `book` 帧（用同一 connectionId，用来播种）。因此重建的盘口仍然被后续锚点独立校验（`snapshotMatches`），不是自证。

### 3. finalize 以前只拷 `[终点-180s, 终点]`，把种子锚点丢在外面（已修）

窗口地板是边界，不是起始状态。要能从地板重建 ask 阶梯，必须保留**地板之前最后一个全量锚点**以及它到地板之间的所有增量。以前这些行留在 staging 里随后被裁掉，导出的窗口前段只能是空的。

现在：

- `finalize` 的拷贝区间从“地板前最后一个 `book_snapshot` 锚点”开始；找不到锚点时才退回原来的 `[地板, 终点]`。
- `missing_front_ms` 按“盘口何时已知”计算：地板之前有锚点 → `0`，否则按第一个已知状态到地板的距离计。以前它只按“窗口内第一帧”算，导致 87% 的场次被误判为不完整。
- 保护窗口相应多留一个窗口（未决比赛 `2 × tailWindowSeconds`），否则种子锚点会在归档前先被裁掉。

### 4. `journal_mode=DELETE` 会让一次长查询冻住采集（已改 WAL）

2026-09-21 02:37–03:16 采集器**静默停摆 38 分钟**：状态 API 无响应、心跳停止、健康守护只记 `watch_cycle_failed` 不重启。原因是一次长时间只读事务（对 `payloads` 的全表扫描）持有读锁，回滚日志模式下写事务无法提交，而采集器的 SQLite 调用是同步的，整个事件循环被阻塞。

- 存储改为 `PRAGMA journal_mode=WAL`：读者走快照，不再阻塞写入；`maintain` 每 10 分钟 `wal_checkpoint(TRUNCATE)` 控制 `-wal` 大小；超出字节上限且增量回收不够时用 `VACUUM` 收尾。
- `tools/collector-health-watch.py` 改为按“连续失败次数”触发重启，不再要求守护进程自己先看到过一次健康周期——守护进程自身重启后，原本 `started=False` 会让它永远不重启已经卡死的采集器。

实测：持有一个 25 秒的只读事务期间，采集器心跳保持在 5 秒内、`receivedRecords` 持续增长。

### 顺带修正

- `matches.metadata_json`（schema v5）保存裁剪后的 Gamma 事件（只留 `normalizeCollectorEvent`/`metadataFromRecord` 需要的字段，约 1 KB，而不是原始事件平均 52 KB）。没有它，compact 归档无法重建市场身份（conditionId、outcome、marketType）。导出时若该列为空，会从仍在保留期内的 raw run 里回捞。
- 终场事实来源新增 `book-quiet` / `book-tail`：`book-quiet` 是采集器在两边都不发布终场时钟时的兜底，必须如实标注，不能伪装成 `gamma.finishedTimestamp`。回测里这类窗口 `finishKnown=false`，是保守判断，不是失败。
- 导出的 compact 归档默认 `--max-feed-silence-ms 90000`：compact 的周期性全量证据只有每分钟一次的 HTTP 锚点，沿用 WS 的 30 秒阈值会把一半安静窗口误判为 stale。

## 2026-09-21 第二次全链路审计（回测读不进去的根因）

前一轮修的是"采不到/存不下"，这一轮把**采集 → 导出 → 回测**整条链一次性跑通，发现 6 个真实缺陷。最关键的一条此前一直没暴露：**采集器导出的归档，回测一份都读不进去。**

### 1. 回测输入校验拒绝 `book-quiet` / `book-tail`，导致 100% 归档不可读（已修，致命）

`TailFinishFact.source` 扩成 4 个取值后，`src/research/tail-backtest.ts` 的 `validateFinish` 仍在硬编码只接受两个"真实时钟"：

```ts
(fact.source === "gamma.finishedTimestamp" || fact.source === "sports.finishedAt")
```

于是**每一份** compact 归档（网球/乒乓几乎全是 `book-quiet`）都在解析阶段直接抛 `TAIL_BACKTEST_INPUT_INVALID: invalid actual finish evidence`。不是被排除，是根本读不进来。

- 修法：把来源集合收敛到 `tail-types.ts` 的 `TAIL_FINISH_FACT_SOURCES` / `isTailFinishSource`，catalog 写入端和 research 读取端共用同一个判定，避免再次漂移。
- **能否用兜底锚点定价是策略问题，不是解析问题**：解析一律通过，是否排除交给 `trialFor` 的 `finishKnown`。
- 验证：120 份归档全部可解析（修前 0 份）。

### 2. 兜底锚点让全部场次被 `missing-actual-finish` 排除（已加显式开关）

网球/乒乓的 Gamma 源基本不发布 `finishedTimestamp`，采集器的结束点几乎全部落在"最后一帧盘口"（`book-quiet`）。而回测要求结束时间必须来自真实时钟，于是 3356 个场景全部排除、可成交场景 0——采集器存了数据，回测一个都不用。

- 新增 `--allow-book-anchor-finish`（默认**关闭**）。开启后 `book-quiet` / `book-tail` 窗口可以定价，且每条 trial 仍记录 `finishSources`，报告顶部追加一条假设说明。
- 默认行为不变：不显式开启时仍然按 `missing-actual-finish` 排除，不会悄悄放松研究口径。
- 验证：`--allow-book-anchor-finish` 下同一批归档出现可成交场景（6 份高质量归档 648 个场景中 56 个 eligible）。

### 3. `loadRawEventIndex` 用"最后一条"事件元数据覆盖交易中的那条（已修，致命）

schema v5 之前 finalize 的场次没有 `metadata_json`，导出时从 raw run 回捞市场身份。旧实现是 `index.set(...)` 逐条覆盖，**最后一条通常就是 Gamma 收盘后的 `reconciled` 文档（每个 market 都 `closed:true`）**。用这种元数据播种，回放把每一秒都判成"已结算"，`validSeconds=0`，导出"成功"但整场作废。

线上实测：130 场里 20 场命中（如 `event:1049707` 的 179/180 秒全部 `closed`）。

- 修法：按 `(是否全 closed, market 数量, 接收时间)` 择优——**全 closed 的文档永远不能覆盖交易中的文档**，其次保留 market 更多的一份，再次取最早的一份（与实时路径 `game.eventMetadata ??=` 的"保留首次观测"一致）。
- 同时让单条损坏/身份冲突的记录不再中断整个 run 的回捞（以前一条坏记录会让该 run 之后的元数据全部丢失）。
- 验证：130 场中"全 closed"从 20 场降到 1 场（该场保留期内只剩收盘文档，无法恢复）；可导出且至少有一个有效 token 的归档从 92/114 提升到 116/119。

### 4. 导出会伪造 `gamma.finishedTimestamp`（已修）

`eventDocument()` 无条件把窗口终点写成 `finishedTimestamp`。对兜底锚点来说，这等于宣称"Gamma 发布过这个结束时钟"，而实际上它只是采集器自己的最后一帧盘口。

- 修法：只有 `gamma.finishedTimestamp` / `sports.finishedAt` 才写该字段；兜底锚点只由 finish-facts sidecar 提供边界，并保留真实来源标签。
- 验证：归档 `finishSources` 从 `["book-quiet","gamma.finishedTimestamp"]` 变为 `["book-quiet"]`（115 场）/`["book-tail"]`（1 场）/真实时钟（4 场）。

### 5. `book-tail` 被压成 `book-quiet`（已修）

`finishFact()` 把非时钟来源一律标成 `book-quiet`，`matches.finish_anchor` 里的 `book-tail` 在归档里消失，两个兜底路径无法区分。改为原样保留。

### 6. `repairAttribution` 会把空窗口标成完整（已修）

`windowStartMs` 在"窗口内没有任何行"时回退到"窗口之前的最早一行"，于是 `missing_front_ms` 算成 0、`window_complete=1`——一个窗口里一行都没有的尾巴会被报成完整。改为只认窗口内的行（与 `windowCoverage` 一致），并把种子锚点搜索限制在一个额外窗口内，过老的锚点不能证明地板状态。

### 7. 归档窗口完整性与持有窗口完整性被错误绑定（已修）

`token-window-incomplete` 原来要求每个 token 的**整段归档窗口**（通常 180 秒）都完整，即使某个 trial 实际只持有最后 60 秒。多数场次的盘口在归档前段尚未建立，导致完整持有窗口仍被整段归档门槛全部排除。

- 新增 `--allow-partial-archive-window`（默认**关闭**）。开启后只允许归档窗口在**所选持有窗口之外**存在缺口；`coverageFor()` 仍强制持有窗口逐秒完整，`holding-data-incomplete` 不受影响。
- 聚合 token 计数与实际行不一致时仍然排除，不会用开关掩盖损坏或缺失的归档。
- 报告 options 和 warnings 都记录该研究口径，不能静默放松。
- 实测 120 份归档、默认 8 价格 × 3 窗口：严格口径 20,136 个场景中 56 个 eligible；开启该开关后 632 个 eligible。`holding-data-incomplete` 数量保持 336，证明持有窗口校验没有被放宽。

### 8. 全量默认参数网格被证据上限提前拒绝（已修）

原来的 `evidenceItems: 250_000` 是未区分实际对象结构的保守上限。当前 120 份归档、839 个市场、20,136 个默认场景的投影为 272,472 项，旧上限直接拒绝，和内存风险不成比例。

- 上限提高到 `1_000_000`，同时保留 `trials: 100_000` 和其他网格硬上限。
- 回归测试覆盖 270,336 项可运行、1,048,576 项仍被拒绝的边界。
- 全量默认网格现在能在约 5 秒内完成，报告约 160 MB；更大样本仍应分批或缩小网格，不能把上限当成无界承诺。

### 这一轮之后的实测结论

- 全量导出 120/134 场成功（14 场 `COMPACT_NO_METADATA`：raw run 已过 24h 保留期且 `metadata_json` 为空，身份已不可恢复）。
- 120 份归档全部能被回测解析；`--allow-book-anchor-finish` 下出现可成交场景。
- 多数场次的盘口在归档前段尚未建立（`validSeconds` 中位数约 136/180），这是市场数据事实，不是采集缺陷；`missing_front_ms`、`window_complete`、`quality.json` 都已如实标注。需要利用最后几分钟的完整持有窗口时，显式开启 `--allow-partial-archive-window`，不要伪造归档完整性。
- 参数网格过大仍会触发明确的 `expanded trial count` 或 `expanded evidence items` 错误；全量 120 场默认网格已可直接运行，更大样本请分批或缩小网格。


## 2026-09-21 第三次全链路审计：证据、终场与重连

这次没有只修一个报错点，而是按“原始记录 → staging → finalize → compact 导出 → 回放/回测”逐层核对，并把确认的问题一起收口。以下修复都要求可回放、可审计，不能用插值、空窗口或伪造终场来让报告看起来完整。

### 1. 连接生命周期证据不再丢失（已修，致命）

`CaptureConnection` 新增 `gameKeys`，连接打开、关闭、缺口、超时和心跳超时都按该连接实际承载过的比赛归属写入 compact 存储。连接断开/重连会切断同 payload 去重链，避免跨断线把两段不连续的盘口误判成连续。

验证：新增断线端到端回归；断线后的秒必须是 `invalid`，且 `connectionInvalidations > 0`。compact 导出会原样恢复连接生命周期记录。

### 2. coverage 不再被 Sports/生命周期行伪证（已修）

`hasStagedInWindow()`、`stagedTailAt()`、`finalize()` 和 `windowCoverage()` 现在只把 CLOB `ws_message` / `book_snapshot` 当作盘口证据。窗口里只剩比分或连接记录时，不会创建空 match，也不会宣称窗口完整。

### 3. 单条坏 journal envelope 不再拖掉后续记录（已修）

`journal-reader.ts` 将 `assertJournalRecord()` 失败计入 `malformedLines` 并触发 damage 回调。同一 run 中遇到一条坏 envelope 后，后续合法 `event_metadata` 仍可由 `raw-event-index` 回捞，不再整段丢失。

### 4. compact 归档保存完整终场 provenance（schema v6）

`matches` 新增：

- `finish_conflict INTEGER NOT NULL DEFAULT 0`
- `finish_facts_json TEXT`

`finalize()` 保存完整 `finishFacts`，compact 导出优先导出全部 witness，不再伪造单条 finish fact。新增 `refreshFinishEvidence()`，允许已 finalize 但已无剩余 depth 的 match 刷新 provenance。

真实库 `game:6286534` 已从 `finish_conflict=0 / facts=NULL` 修正为 `finish_conflict=1 / 1093 bytes`。

### 5. 重启后重新 pin 未完成归档（已修）

`ContinuousCollector.initialize()` 恢复状态后会遍历 `state.gamesView()`；对已经完成终场、但 archive 未 complete 的比赛重新 `markPendingFinalize`，同时回填已有 `finishFacts`。重启不再让待归档比赛掉出维护队列。

### 6. 迟到的真实终场时钟不再被静默丢弃（已修）

删除“`finishAnchor === "book-quiet"` 就直接 return”的旧逻辑。语义现在是：

- book-quiet 且 archive 尚未 complete：真实 clock 到达后改用真实 clock。
- archive 已 complete：保留已发布 artifact 的边界，但记录新的 witness、标记 `finishConflict=true`，并使归档失效后重跑。
- 即使新 witness 边界相同，也会触发 provenance revision，避免归档后的终场来源永久缺失。

### 7. compact 导出正确归因重连后的 HTTP anchor（已修）

导出不再固定使用“找到的第一个 WS connection”。现在跟踪活跃的 `connection_open/close/gap`、每个 token 最近的 WS connection 以及最近 CLOB connection；HTTP anchor 会归到当时的活跃连接。重连后的 anchor 不会再被挂到旧连接上。

### 8. 健康守护自动重启路径修复（已修）

`tools/collector-health-watch.py` 的自动重启路径把 `LogFile` 实例当成函数调用，真正触发重启时会抛 `TypeError: 'LogFile' object is not callable`，导致守护进程无法拉起卡死的采集器。现已改为 `self.log.write(...)`。

同时增加 SQLite 读取的有限重试：采集器重启的短暂窗口里，单次 `unable to open database file` 不再立刻记为 `watch_cycle_failed`；连续失败仍会按原策略升级并触发重启。

验证：Python 语法编译通过；用回归脚本验证自动重启日志路径会依次写入 `restart_collector` / `restart_collector_done`，并验证数据库前两次打开失败、第三次成功时不会误报。

### 9. 本轮核查后确认不是问题的点

- `continuous-server.ts /api/status`：实测 973 个 games、约 4.93 MB，连续 5 次请求耗时 15–33 ms，当前不是性能故障。
- `finishEvidence === undefined`：旧归档兼容字段，未贸然改写。
- `tail-backtest-io` 固定四文件输入：manifest 负责完整性和哈希校验，当前输入契约正确。

### 本轮验证证据

- 全量测试：**93 个测试文件 / 2,620 项测试通过，0 失败**。
- TypeScript：`npx tsc --noEmit` 通过。
- 采集器范围测试：**61 个测试文件 / 2,090 项测试通过**。
- 从正式 SQLite 只读副本导出 **30 份归档**：`exported 30 / failed 0`；30 场 match-level `window_complete` 全部为 true，每场 `anchorFrames` 为 6–16。归档内仍有 13 场存在至少一个 token 的 `observedWindowComplete=false`（多为 1 秒缺口或未活跃的子盘口），所以回测只有在实际持有窗口完整时才会纳入，不能被 match-level 标志替代。
- 对上述 30 份归档运行真实回测：**2,208 个 scenario、64 个参数组、152 个 eligible**；未出现解析或执行异常。
- 正式采集器连续采样：`mode=collecting`、`errors=[]`、`lastRecordAtMs` 持续推进、`dataAgeMs` 保持在约 1–2 秒；正式库为 schema v6，当前 `matches=153`、`tail.sqlite` 约 245.7 MB，磁盘空闲约 85 GiB。
- 健康守护：`python3 -m py_compile` 通过；自动重启日志路径和 SQLite 短暂打开失败重试均有直接回归验证。

### 仍需保留的边界

当前不能声称“零 bug”。以下属于数据源和证据边界，不能通过代码静默补齐：

- 部分比赛没有匹配到精确比分或独立终场来源，只能明确标为 `book-tail` / `book-quiet`，回测必须显式开启 `--allow-book-anchor-finish`。
- compact 归档依赖 `metadata_json`；raw run 超过保留期且 metadata 为空时，市场身份不可恢复，导出会失败而不是猜测。
- 真实成交仍使用 `quote-touch-assumed` 等假设模型，不能把回测 PnL 当作已成交实盘收益。
- 盘口前段可能尚未建立，持有窗口的逐秒完整性仍必须单独校验；`--allow-partial-archive-window` 只放宽归档窗口之外的前段，不放宽实际持有窗口。
