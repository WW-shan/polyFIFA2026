# 体育比赛原始行情采集器

日期：2026-09-10

## 目标与边界

为后续研究保留比赛发生时可以观察到的原始数据：完整买卖盘口、盘口增量、公开成交推送、比赛比分/阶段/时钟、市场规则与最终结果信息。第一版只使用公开接口，不导入交易执行器，不读取交易密钥，不发送订单。账户订单采集需另行接入账户流。

研究问题包括：85 分钟后落后方胜 No 在什么情况下出现 0.99/0.95/0.90/0.80/0.70/0.60 的报价或成交，低价持续多久、可见深度多少、与进球/比分更正如何对应。价格触及、公开成交和自己的挂单成交是不同证据；本功能不把前两者换算为确定成交或收益。

## 当前项目

- `worldcup-events.ts` 只发现世界杯单场比赛，不能作为全体育采集入口。
- `sports-live.ts` 把比分和阶段归一化为足球类型，不能直接用于网球、篮球、电竞等数据保全。
- `cli.ts` 的深度审计发生在策略决策时，缺少连续盘口；采集器使用独立入口。
- 现有回测文档承认使用终场比分回放历史成交，不能据此推断暴跌成交条件下的失败概率。
- 基线验证：242 项测试通过，TypeScript 类型检查通过。

## 选择

采用 WebSocket 原始日志 + 定期 HTTP 校验快照 + 离线导出。相比固定频率查询，可以保留短暂的盘口变化；相比立即搭建数据库/网页回测平台，可以尽快得到完整、可重新解释的数据。

## 采集范围与发现

Gamma 的 Games 标签（`100639`）覆盖足球、篮球、网球及电竞等单场比赛。按 ID 排序分页，去重，不设置成交量下限，不丢弃 More Markets、角球、让分、大小分、分节/分局等子盘口。保留未知 `sportsMarketType` 和原始市场描述。

默认发现窗口为过去 48 小时到未来 24 小时的市场结束日期，滚动刷新。该日期是 Gamma 的 `endDate`，不宣称是实际终场时间。`--all-open` 取消日期窗口；`--event-slugs` 可指定比赛；`--sports` 按标签/联赛代码筛选。配置及分页异常写入日志；达到分页上限时报告发现不完整，不能悄悄当作全部比赛。

每次发现保存原始 HTTP 响应和请求起止时间，再保存逐赛事元数据供导出建立 token→market→event 映射。长期运行时，对已订阅但从开放列表消失的比赛单独查询，记录关闭/结果状态后移除订阅；新比赛/新 token 动态订阅。一次发现失败不能撤销已有订阅。

## 原始记录

统一外壳：`schemaVersion`、`runId`、进程内严格递增 `sequence`、`receivedAt`（UTC）、`receivedAtMs`、`monotonicNs`、`source`、`kind`、可选 `connectionId`、`data`。

- `clob/ws_message`：原始文本帧，保留 JSON 数组、未知事件、字符串价格及服务器时间戳。
- `sports/ws_message`：原始比分帧，包含无法映射的赛事及非足球比分格式，供事后关联。
- `gamma/discovery_page`、`gamma/event_metadata`：原始事件、市场规则、token/outcome、成交量、费用字段及结果字段。
- `clob/book_snapshot`：定期批量 HTTP 盘口，以及请求开始和结束时间。与 WebSocket 流分开保留，不把跨越请求时间的 HTTP 快照强行插入增量序列。
- `collector/session_start`、`status`、`session_end` 及连接/订阅/异常记录：审计配置、数据缺口和采集进度。

本地接收顺序是实际观察顺序；服务器时间原样保留，不能据此假设不同接口时钟同步。补时、VAR 原因、红牌等字段只有源数据提供时才存在。比分回退可被观察，但不等同于已核验 VAR 原因。

## 连接与运行

- CLOB：`wss://ws-subscriptions-clob.polymarket.com/ws/market`；订阅 token，开启 `custom_feature_enabled`，每 10 秒发送 `PING`。
- Sports：`wss://sports-api.polymarket.com/ws`；无需订阅，收到 `ping` 回复 `pong`。
- CLOB 连接按 token 数分片，默认每连接 200 个；新增/移除订阅不重连其他比赛。
- 记录连接代次；断线或心跳超时后退避重连，重订阅获得新书本快照。离线期间无法恢复的增量保持为缺口。
- 保留现有代理环境设置；采集器不加载 `.env.local`，不需要交易凭证。
- SIGINT/SIGTERM 或 `--duration-seconds` 到期时停止网络工作并刷盘。磁盘错误或写入积压超限导致明确失败退出，避免静默丢包。

## 存储与导出

`data/collector/<runId>/YYYY-MM-DD-NNNNNN.ndjson`，按 UTC 日期和大小分段；默认 64 MiB，权限 0600；每次运行创建独立目录，已有数据不覆盖。写入队列默认上限 32 MiB，顺序批量落盘，所有采集数据被 git 忽略。压缩/Parquet/数据库后续可从原始文件生成。

离线导出以单次运行目录为输入，按序列回放，产生 `quotes.csv`、`trades.csv`、`sports.csv`、`markets.csv` 和质量摘要。报价来自收到完整 WebSocket book 后的全深度重建；增量 size 是该价格的新总量，0 删除档位。只在同一连接代次内更新，断线后旧书本无效；未知/乱序/无初始快照不能输出为可用深度。HTTP 快照保留在原始档案中，避免与实时流竞态。

导出记录当时最后收到的比分、时钟和比分数据年龄，不用未来比分改写过去行情。未知映射/缺失时钟/连接缺口标明缺失。盘口最优价和公开成交分开输出；不进行排队成交模拟，不输出策略胜率。

## 验收

1. 多页发现包含非世界杯、电竞、未知盘口类型、低/零成交量、Yes/No 两边及子赛事。
2. 实际文本帧逐条保存；重启产生新目录，分段不覆盖；并发接收的序列保持可回放。
3. 心跳、动态订阅、断线重连、停止和异常退出有可验证行为。
4. 回放验证绝对档位数量、零删除、0.99→0.70、比分回退、连接代次和事件缺失。
5. 离线测试及类型检查通过，公开网络有限时长试采成功；试采不触发交易。

## 核对依据

- 官方实时数据文档（旧路径当前重定向至统一实时文档）：https://docs.polymarket.com/market-data/websocket/market-channel
- 官方 Sports 文档：https://docs.polymarket.com/market-data/websocket/sports
- 2026-09-10 对 `/sports`、`/events?tag_id=100639` 的公开接口验证：返回足球、电竞及 More Markets 等子赛事；未知类型需要原样保留。
- 文档读取命令：`smart-search fetch https://docs.polymarket.com/market-data/websocket/market-channel --format json`。搜索主通道诊断超时，官方文档读取和公开 API 请求成功。
