# Polymarket 实时 Sports 数据源调查与测试计划

更新时间：2026-06-24 05:30 Asia/Shanghai
项目目录：`/Users/ww/Project/polyFIFA2026`

## 1. 一句话结论

Polymarket 页面确实有实时体育数据层。之前只看 Gamma / CLOB / price-history 会误以为没有实时比分；实际前端使用官方 Sports WebSocket：

```text
wss://sports-api.polymarket.com/ws
```

这个 WebSocket 无需鉴权，服务端推送所有 active sports events 的比分和比赛状态。它可以作为本项目“世界杯尾盘策略”的主实时数据源，用来获得 `score`、`period`、`elapsed`、`live`、`ended` 等字段。

需要注意：已在真实 World Cup 足球比赛进行中验证，Sports WebSocket / Gateway / 页面初始状态都能给出 `score`、`period`、`elapsed`、`live`、`ended`，但仍没有发现明确的补时总分钟字段。2026-06-25 已确认 365Scores 公开网页单场接口能给出 `addedTime + preciseGameTime`，因此项目现在用 Polymarket Sports 负责比分/事件映射，用 365Scores 严格计算最后 3 分钟；没有 365Scores 严格时钟就不下单。

## 2. 官方数据源

### 2.1 Sports WebSocket

官方文档：

- <https://docs.polymarket.com/market-data/websocket/sports>
- <https://docs.polymarket.com/asyncapi-sports.json>

关键信息：

- Endpoint：`wss://sports-api.polymarket.com/ws`
- 鉴权：不需要 auth，不需要 subscribe message
- 心跳：服务端每 5 秒发送 `ping`，客户端需要回复 `pong`
- 推送时机：比赛开始、比分变化、period 变化、比赛结束等
- 典型字段：

```json
{
  "slug": "mci-liv-2025-02-03",
  "live": true,
  "ended": false,
  "score": "1-0",
  "period": "1H",
  "elapsed": "32:15",
  "last_update": "2025-02-03T19:50:16.939Z"
}
```

官方也说明该 feed 是 informational，可能延迟、错误或漏事件；策略层应把它当作实时输入源，而不是结算依据。

### 2.2 Sports Gateway REST

官方文档：

- <https://docs.polymarket.us/api-reference/sports/get-events-by-sport-slug>
- <https://docs.polymarket.us/api-reference/sports/get-events-by-league-slug>
- <https://docs.polymarket.us/api-reference/sports/get-sports-events>

已验证可用 endpoint：

```bash
curl -x http://127.0.0.1:10808 \
  --compressed \
  'https://gateway.polymarket.us/v2/sports/soccer/events?limit=100'
```

返回的 event schema 包含：

- `score`
- `elapsed`
- `period`
- `live`
- `ended`
- `finishedTimestamp`
- `gameId`
- `sportradarGameId`
- `eventState`
- `metadata.gameState`
- `metadata.latestGameUpdate`

这个 Gateway 可以作为页面之外的 snapshot / fallback 数据源，但注意它是 `polymarket.us`，slug 和全球 Polymarket 页面不完全一致。

## 3. Polymarket 页面实际怎么用

以页面为例：

```text
https://polymarket.com/sports/world-cup/fifwc-prt-uzb-2026-06-23
```

页面初始状态在 `__NEXT_DATA__` 的 `props.pageProps.initialState` 中，是 base64 + zlib 压缩 JSON。解出来后可见：

```json
{
  "games": {
    "fifwc-prt-uzb-2026-06-23": {
      "event": "fifwc-prt-uzb-2026-06-23",
      "score": "0-0",
      "period": "NS",
      "elapsed": "",
      "live": false,
      "ended": false,
      "gameState": "not-started",
      "timestamp": "2026-06-23T17:00:00.000Z"
    }
  },
  "events": {
    "fifwc-prt-uzb-2026-06-23": {
      "slug": "fifwc-prt-uzb-2026-06-23",
      "title": "Portugal vs. Uzbekistan",
      "gameId": 90086952,
      "seriesSlug": "soccer-fifwc",
      "eventMetadata": {
        "sportradarGameId": "sr:sport_event:66457034"
      }
    }
  }
}
```

我下载了页面 JS worker，确认前端直接创建 WebSocket：

```js
url: "wss://sports-api.polymarket.com/ws"
```

前端更新逻辑大致是：

1. 收到 sports WebSocket update。
2. 如果 update 有 `slug`，直接用 slug 找比赛。
3. 如果 update 没有 `slug`，用 `gameId` 查询页面状态中的 `gameIdToSlug`。
4. 更新 `games[slug]` 的 `score / period / elapsed / live / ended / gameState`。

因此我们项目也应按这个映射方式做，而不是只靠 slug。

## 4. 当前世界杯事件映射

同一场比赛在不同 Polymarket 数据源里可能 slug 不同，但 `gameId` / `sportradarGameId` 一致。

### 4.1 全球 Polymarket 页面 / Gamma

```json
{
  "slug": "fifwc-prt-uzb-2026-06-23",
  "title": "Portugal vs. Uzbekistan",
  "seriesSlug": "soccer-fifwc",
  "gameId": 90086952,
  "sportradarGameId": "sr:sport_event:66457034"
}
```

### 4.2 Polymarket US Gateway

```json
{
  "slug": "fwc-por-uzb-2026-06-23",
  "title": "Portugal vs. Uzbekistan",
  "seriesSlug": "fwc",
  "gameId": 90086952,
  "sportradarGameId": "sr:sport_event:66457034"
}
```

结论：实时数据匹配优先级应为：

1. `slug` 精确匹配；
2. `gameId` 匹配；
3. `sportradarGameId` 匹配；
4. fallback 到队名 + 开赛日期匹配。

不要只用 `fifwc-*` slug，因为 WebSocket 实盘消息可能没有 slug，或 slug 与页面不同。

## 5. 已执行验证

### 5.1 WebSocket 连接验证

命令：

```bash
HTTPS_PROXY=http://127.0.0.1:10808 \
HTTP_PROXY=http://127.0.0.1:10808 \
MAX_MS=20000 \
WANT='fwc|fifwc|world|soccer|por|uzb' \
node tmp/probe-polymarket-sports-ws-undici.mjs
```

结果摘要：

```json
{
  "url": "wss://sports-api.polymarket.com/ws",
  "proxy": "http://127.0.0.1:10808",
  "maxMs": 20000,
  "totalJson": 12,
  "matched": 0,
  "leagues": ["atp", "challenger", "grand slam", "wta"],
  "liveCount": 12,
  "fifwcCount": 0
}
```

解释：WebSocket 可连通、无鉴权、实时推送正常。当时是 2026-06-23 13:30 UTC，下一场 World Cup `Portugal vs. Uzbekistan` 开赛时间是 2026-06-23 17:00 UTC，所以没有收到 World Cup live 更新是正常的。

### 5.2 Gateway 当前 World Cup snapshot

命令：

```bash
curl -x http://127.0.0.1:10808 \
  --compressed \
  'https://gateway.polymarket.us/v2/sports/soccer/events?limit=100'
```

样本：

```json
{
  "slug": "fwc-por-uzb-2026-06-23",
  "title": "Portugal vs. Uzbekistan",
  "startTime": "2026-06-23T17:00:00Z",
  "seriesSlug": "fwc",
  "score": null,
  "elapsed": null,
  "period": "NS",
  "live": null,
  "ended": null,
  "gameId": 90086952,
  "sportradarGameId": "sr:sport_event:66457034",
  "eventState": {
    "mainSpreadLine": -2.5,
    "mainTotalLine": 3.5
  }
}
```

### 5.3 页面初始状态验证

命令：

```bash
HTTPS_PROXY=http://127.0.0.1:10808 \
HTTP_PROXY=http://127.0.0.1:10808 \
npx tsx tmp/probe-match-state.ts fifwc-prt-uzb-2026-06-23
```

结果摘要：

```json
{
  "match": {
    "eventSlug": "fifwc-prt-uzb-2026-06-23",
    "homeTeam": "Portugal",
    "awayTeam": "Uzbekistan",
    "homeGoals": 0,
    "awayGoals": 0,
    "minute": 0,
    "period": "UNKNOWN",
    "isLive": false
  },
  "marketCount": 28,
  "firstMarkets": [
    { "marketType": "moneyline", "question": "Will Portugal win on 2026-06-23?" },
    { "marketType": "draw", "question": "Will Portugal vs. Uzbekistan end in a draw?" },
    { "marketType": "spread", "question": "Spread: Portugal (-1.5)" }
  ]
}
```

说明：项目当前页面解析层已经能从页面拿到完整盘口，但 `findMatchState` 还没有正确把 `NS` 映射成 not-started，也还没有接入 WebSocket 动态更新；后续要新增 live provider。

### 5.4 开赛后 live 字段验证

验证时间：2026-06-24 05:21-05:30 Asia/Shanghai
比赛：England vs. Ghana，全球页面 slug `fifwc-eng-gha-2026-06-23`，Gateway slug `fwc-eng-gha-2026-06-23`

Gateway snapshot：

```bash
curl --compressed \
  'https://gateway.polymarket.us/v2/sports/soccer/events?limit=100'
```

关键字段：

```json
{
  "slug": "fwc-eng-gha-2026-06-23",
  "title": "England vs. Ghana",
  "startTime": "2026-06-23T20:00:00Z",
  "score": "0-0",
  "elapsed": "64'",
  "period": "2H",
  "live": true,
  "ended": false,
  "gameId": 90086953,
  "sportradarGameId": "sr:sport_event:66457046",
  "eventStateKeys": [
    "id",
    "gameId",
    "sportradarGameId",
    "type",
    "createdAt",
    "updatedAt",
    "score",
    "elapsed",
    "period",
    "live",
    "ended",
    "mainSpreadLine",
    "mainTotalLine",
    "marketGroupStats"
  ],
  "latestGameUpdate": {
    "type": "corner_kick",
    "clock": "61'"
  }
}
```

Sports WebSocket capture：

```bash
HTTPS_PROXY=http://127.0.0.1:10808 \
HTTP_PROXY=http://127.0.0.1:10808 \
MAX_MS=240000 \
WANT='90086953|fifwc|eng|gha|England|Ghana' \
node tmp/probe-polymarket-sports-ws-undici.mjs
```

关键字段：

```json
{
  "gameId": 90086953,
  "leagueAbbreviation": "fifwc",
  "homeTeam": "England",
  "awayTeam": "Ghana",
  "status": "InProgress",
  "eventState": {
    "type": "soccer",
    "createdAt": "2026-06-23T21:29:14.742061847Z",
    "updatedAt": "2026-06-23T21:29:14.742061847Z",
    "score": "0-0",
    "elapsed": "66",
    "period": "2H",
    "live": true,
    "ended": false
  },
  "score": "0-0",
  "elapsed": "66",
  "period": "2H",
  "live": true,
  "ended": false
}
```

页面初始状态 live sample：

```json
{
  "event": "fifwc-eng-gha-2026-06-23",
  "gameState": "live",
  "timestamp": "2026-06-23T20:00:00.000Z",
  "live": true,
  "ended": false,
  "score": "0-0",
  "period": "2H",
  "elapsed": "62",
  "delayed": false
}
```

结论：

- 必需的基础 live 字段存在：`score`、`period`、`elapsed`、`live`、`ended`、`gameId`。
- WebSocket 当前没有推送 `slug`，但有 `gameId = 90086953`，所以 `gameId` 映射是必须的。
- WebSocket 的 `elapsed` 是纯数字字符串，例如 `"66"`；Gateway 会带撇号，例如 `"64'"`；页面初始状态可能比 WebSocket/Gateway 更滞后。
- Gateway 的 `metadata.latestGameUpdate.clock` 是最近事件的发生时间，例如角球 `"61'"`，不是当前比赛剩余时间。
- 本次 live 样本仍没有发现 `remainingMinutes`、`remainingTime`、`stoppageTime`、`addedTime`、`injuryTime`、`expectedEndMinute`、`endMinute` 等字段。

## 6. 目前没有确认的字段

我在以下位置都搜索过这些字段：

- 官方 Sports WebSocket docs / AsyncAPI schema
- 官方 Sports Gateway docs
- 当前 World Cup 页面 HTML 初始状态，包括 2026-06-24 05:29 Asia/Shanghai 的 England vs. Ghana live 页面样本
- 下载后的 Polymarket 前端 JS chunks 和 worker
- 真实 World Cup live WebSocket 样本

未发现：

```text
remainingMinutes
remainingTime
stoppageTime
addedTime
injuryTime
expectedEndMinute
endMinute
```

已发现并可用：

```text
score
period
elapsed
live
ended
gameState
finishedTimestamp
metadata.latestGameUpdate.clock
```

其中 `metadata.latestGameUpdate.clock` 只表示最近事件的时钟，不是剩余时间字段，不能直接用于尾盘入场判断。

这意味着：

- 不能把“比赛最后 3 分钟”简单写成 `minute >= 87`；
- 也不能假设 Polymarket 会直接告诉我们补时几分钟；
- 需要等真实足球 live 消息确认 `elapsed` 在 90 分钟后如何显示。

## 7. 后续实现方案

新增一个 Polymarket 原生 live provider，建议命名：

```text
src/polymarket/sports-live.ts
```

职责：

1. 读取当前 World Cup 页面/Gamma event，建立映射表：
   - `eventSlug`
   - `gameId`
   - `sportradarGameId`
   - `homeTeam`
   - `awayTeam`
   - `startTime`
2. 连接 `wss://sports-api.polymarket.com/ws`。
3. 回复 heartbeat：收到 `ping` 发送 `pong`。
4. 接收 update，按 `slug -> gameId -> sportradarGameId -> teams/date` 映射回事件。
5. 归一化为项目内部 `MatchState`：

```ts
interface LiveMatchState {
  eventSlug: string;
  gameId?: number;
  sportradarGameId?: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  score: string;
  period: "NS" | "1H" | "HT" | "2H" | "ET" | "FT" | "UNKNOWN";
  elapsed: string;
  elapsedSeconds?: number;
  isLive: boolean;
  ended: boolean;
  raw: unknown;
  receivedAt: string;
}
```

6. 把 raw update 写入本地 audit 文件，方便复盘。

## 8. 实盘测试计划

### 8.1 开赛前测试

目标：确认 event 映射和盘口识别可用。

检查项：

- 能抓到 `fifwc-prt-uzb-2026-06-23` 页面；
- 能解析 `gameId = 90086952`；
- 能解析 `sportradarGameId = sr:sport_event:66457034`；
- 能解析 moneyline / draw / spread / total / team_total；
- 能用 Gateway 找到对应 `fwc-por-uzb-2026-06-23`。

### 8.2 开赛后 5 分钟测试

目标：确认 soccer live update 格式。

命令模板：

```bash
HTTPS_PROXY=http://127.0.0.1:10808 \
HTTP_PROXY=http://127.0.0.1:10808 \
MAX_MS=600000 \
WANT='90086952|fifwc|fwc|por|uzb|Portugal|Uzbekistan|soccer' \
node tmp/probe-polymarket-sports-ws-undici.mjs \
  | tee tmp/worldcup-live-prt-uzb-early.json
```

验收：

- 收到 World Cup / soccer 更新；
- update 中至少有 `score`、`period`、`elapsed`、`live`；
- 能用 `gameId` 映射到 `fifwc-prt-uzb-2026-06-23`。

### 8.3 80 分钟后测试

目标：验证尾盘策略真正需要的时间字段。

观察重点：

- `period` 是否为 `2H`；
- `elapsed` 是 `80:xx`、`89:xx`、`90:xx`，还是其他格式；
- 进入补时后 `elapsed` 是否继续增长，例如 `91:30`；
- 是否出现额外字段表示补时或剩余时间。

### 8.4 终场测试

目标：确认结束事件。

验收：

- `ended = true`；
- `live = false`；
- `period` 是否变成 `FT` 或其他最终状态；
- 是否出现 `finishedTimestamp` / `finished_timestamp`；
- 最终比分与页面/Gamma/Gateway 一致。

## 9. 2026-06-25 新增结论：免费网页源可严格计算最后 3 分钟

验证时间：2026-06-25 04:49-04:52 Asia/Shanghai
验证比赛：Switzerland vs Canada，365Scores `gameId = 4627855`

结论：Polymarket 自己的 Sports feed 仍没有确认给出下半场补时总分钟数，但 365Scores 的公开网页单场接口已经在真实 World Cup 比赛下半场补时阶段给出足够字段，可以严格计算“距离官方 90 分钟 + 补时结束还剩多少秒”。

公开网页接口：

```text
https://webws.365scores.com/web/game/?appTypeId=5&langId=1&timezoneName=Asia%2FShanghai&userCountryId=2&gameId=4627855
```

关键字段：

```json
{
  "statusText": "2nd Half",
  "gameTimeDisplay": "90+4'",
  "addedTime": 6.0,
  "preciseGameTime": {
    "minutes": 93,
    "seconds": 9,
    "autoProgress": true,
    "clockDirection": 1
  }
}
```

严格计算公式：

```text
remaining_seconds = (90 + addedTime) * 60
  - (preciseGameTime.minutes * 60 + preciseGameTime.seconds)
```

本次实测最后 3 分钟证据：

```text
captured_at UTC: 2026-06-24T20:52:58.311370+00:00
captured_at Asia/Shanghai: 2026-06-25 04:52:58
display: 90+4'
addedTime: 6.0
preciseGameTime: 93:09
remaining_seconds: 171
score: Switzerland 2 - 1 Canada
```

因此，当 `remaining_seconds <= 180` 时，可以认为已经进入“严格可计算的最后 3 分钟”。这不是默认第 87 分钟，也不是按开赛时间瞎推，而是由网页实时源公布的 `addedTime` 和精确走表字段计算出来。

已保存证据：

- `data/live-clock/365scores_swiss_canada_final3_summary_20260625.json`
- `data/live-clock/365scores_swiss_canada_final3_evidence_20260625.ndjson`
- `data/live-clock/365scores_swiss_canada_final3_raw_20260625.json`

### 9.1 接入原则

实盘交易的时间门禁应改成：

1. 用 Polymarket 页面/Gamma/CLOB 识别市场和 token；
2. 用 Polymarket Sports feed 或 365Scores 获取实时比分；
3. 用 365Scores 单场接口获取 `addedTime + preciseGameTime`；
4. 只有满足以下条件才允许“最后 3 分钟”交易：
   - `statusText` 为 `2nd Half`；
   - `addedTime` 是有效数字；
   - `preciseGameTime.minutes/seconds` 是有效数字；
   - `autoProgress = true`；
   - `remaining_seconds <= 180`；
   - 比分源和 Polymarket 事件能通过队名 + 开赛时间，或后续映射表，匹配到同一场比赛。

如果 365Scores 没有给出 `addedTime`，或 `preciseGameTime` 缺失，应视为没有真实时间源：不下单。

## 10. 对交易策略的影响

### 10.1 可以立即修正的点

- 实时比分来源改为 Sports WebSocket；
- 最后 3 分钟门禁接入 365Scores `addedTime + preciseGameTime`；
- 当前页面/Gamma 只负责发现 event、market、token；
- CLOB 只负责价格和下单；
- 事件匹配不要依赖 slug，必须支持 `gameId`。

### 10.2 仍然不能做假的点

不能在没有数据支持时声称“已经知道真正最后 3 分钟”。

当前 strict 方案：

- Polymarket Sports feed 只作为实时比分和事件匹配来源；
- 365Scores 单场接口给出 `addedTime + preciseGameTime` 时，才计算 `remaining_seconds <= 180`；
- 如果 365Scores 没有给出这两个字段，不能用 `elapsed >= 87` 或 `elapsed >= 90` 替代真实最后 3 分钟。

这会少抓部分机会，但符合“没有真实源就不下单”的要求。

## 11. 下一步给下一个 agent 的任务

1. 实现 `SportsLiveProvider`，接入 `wss://sports-api.polymarket.com/ws`。
2. 建立 `gameId` / `sportradarGameId` 映射表。
3. 把 `fetchEventMatchState` 从静态页面解析升级为“页面 snapshot + live update”。
4. 增加 live capture 脚本，把 World Cup 原始 update 落盘。
5. 实现 `365ScoresLiveClockProvider`，用单场接口计算 `remaining_seconds`。
6. 增加 fixtures 测试：`addedTime = 6`、`preciseGameTime = 93:09` 时应输出 `remaining_seconds = 171`。
7. 判定逻辑接回策略层和 live executor 做真实下单验收。

## 12. 资料位置

本轮调查的临时证据文件：

```text
tmp/research/polymarket-live/sports-websocket.md
tmp/research/polymarket-live/asyncapi-sports.json
tmp/research/polymarket-live/get-events-by-sport-slug.md
tmp/research/polymarket-live/gateway-soccer-events-now.json
tmp/research/polymarket-live/polymarket-fifwc-prt-uzb-page.html
tmp/research/polymarket-live/sports-ws-probe-20s-now.json
tmp/research/polymarket-live/global-page-fifwc-prt-uzb-state-hits.json
tmp/research/polymarket-live/gateway-soccer-events-live-eng-gha-2026-06-24.json
tmp/research/polymarket-live/gateway-live-eng-gha-field-check-2026-06-24.json
tmp/research/polymarket-live/sports-ws-live-eng-gha-2026-06-24.json
tmp/research/polymarket-live/page-state-live-eng-gha-field-check-2026-06-24.json
```

`tmp/` 通常不进 git；如果要长期保留，需要把精简后的样本复制到 `data/fixtures/` 或 `tests/fixtures/`。
