# Polymarket 网球备选项目：有界库存与尾盘数据适用性

整理时间：2026-09-11 22:49（Asia/Shanghai，UTC+8）。公开 API 采样时间：当日 22:26–22:37；Valorant 未关闭页为 22:28:10，其余事件页最终统计为 22:34:45–48。数据会随开盘、完赛和结算变化。

建议继续网球历史下载与回测主线；新增项目先验证 CS2 的前向比分／盘口采集，随后考虑 Valorant。乒乓球有明确的比赛库存，但本次 Setka Cup 样本缺少比分与实际终场信息，应先补比赛数据源。Dota 2 需要更细的局内状态；羽毛球暂未找到相关对阵。此排序依据数据适用性；本轮没有重新探测网球历史、成交或 WebSocket，足球未纳入比较。

## 样本边界与库存

[Gamma `/sports`](https://gamma-api.polymarket.com/sports) 返回 465 个目录项。网球沿用主线标签 `864`（ATP/WTA、双打等）；本报告没有新增网球数量统计。乒乓球通用标签 `103767` 覆盖多个系列，目录还确认了 `ttchallenger`（主标签 `105711`、series `12327`）、`ttcl`（`105331`、`11917`）、`ttolympics`（`105330`、`11916`）及 WTT 男女等。目录存在不等于这些系列当前都有可用盘口。

下表是有界样本，不是全站总量。每项只考察两个不同事件分页：未关闭页 `closed=false&order=id&ascending=false`；已关闭页 `closed=true&order=endDate&ascending=false&end_date_max=2026-09-11T14:27:00Z`；均为 `limit=100&offset=0`。终端输出截断后，除 Valorant 未关闭页外，同页复取一次并在进程内汇总，没有扩展分页或重复计数。点击数量可复现原始查询。

“对阵”要求 `gameId`、`startTime`、至少一个非空 `sportsMarketType`，并核验标题含双方对阵；每页对阵的 `gameId` 均无重复。“市场”包含同场的地图、让局、大小盘等子市场。“接受委托”仅指 API 标记 `acceptingOrders=true && closed=false`。

| 项目／标签 | 未关闭页：事件／对阵／非对阵 | 对阵内市场：总数／接受委托 | 已关闭页：对阵／市场 |
| --- | ---: | ---: | ---: |
| 乒乓球 `103767` | [100／100／0](https://gamma-api.polymarket.com/events?tag_id=103767&closed=false&limit=100&offset=0&order=id&ascending=false) | 499／496 | [100／466](https://gamma-api.polymarket.com/events?tag_id=103767&closed=true&limit=100&offset=0&order=endDate&ascending=false&end_date_max=2026-09-11T14%3A27%3A00Z) |
| CS2 `100780` | [100／97／3](https://gamma-api.polymarket.com/events?tag_id=100780&closed=false&limit=100&offset=0&order=id&ascending=false) | 594／578 | [100／1,314](https://gamma-api.polymarket.com/events?tag_id=100780&closed=true&limit=100&offset=0&order=endDate&ascending=false&end_date_max=2026-09-11T14%3A27%3A00Z) |
| Dota 2 `102366` | [34／32／2](https://gamma-api.polymarket.com/events?tag_id=102366&closed=false&limit=100&offset=0&order=id&ascending=false) | 722／383 | [100／2,063](https://gamma-api.polymarket.com/events?tag_id=102366&closed=true&limit=100&offset=0&order=endDate&ascending=false&end_date_max=2026-09-11T14%3A27%3A00Z) |
| Valorant `101672` | [27／10／17](https://gamma-api.polymarket.com/events?tag_id=101672&closed=false&limit=100&offset=0&order=id&ascending=false) | 134／126 | [100／2,318](https://gamma-api.polymarket.com/events?tag_id=101672&closed=true&limit=100&offset=0&order=endDate&ascending=false&end_date_max=2026-09-11T14%3A27%3A00Z) |

非对阵实例：CS2 的 ESL Pro League Season 24 冠军盘；Dota 的新英雄发布／选手转队；Valorant 的 Boaster 等选手下一支队伍、资格和其他话题。不能把标签返回数直接当比赛数。

未关闭对阵中，CS2 有 14 场、Dota 有 18 场、Valorant 有 3 场已 `ended=true`，仍存在接受委托的子市场。排除这些后分别剩 83、14、7 场；其中又分别有 44、1、5 场缺少 `ended`，不能把缺字段解释为已确认未结束。乒乓球 100 场全部缺少该字段。现场 `live=true` 实际观察到 CS2 6 场、Dota 1 场、Valorant 0 场；乒乓球没有返回 `live`。

乒乓球两页均被 Setka Cup 占据：未关闭页乌克兰男子 69、摩尔多瓦男子 21、捷克男子 10；已关闭页分别为 73、3、20，另有乌克兰女子 4。没有据此推断 TT Challenger、WTT 等其他系列的库存或数据质量。

羽毛球核查上限为目录加两次搜索，各 `page=1&limit_per_type=100&search_tags=true&search_profiles=false&keep_closed_markets=1`：[英文 badminton](https://gamma-api.polymarket.com/public-search?q=badminton&limit_per_type=100&page=1&search_tags=true&search_profiles=false&keep_closed_markets=1) 返回 1 个无关的哥伦比亚世界杯首发事件（ID `584732`）；[中文羽毛球](https://gamma-api.polymarket.com/public-search?q=%E7%BE%BD%E6%AF%9B%E7%90%83&limit_per_type=100&page=1&search_tags=true&search_profiles=false&keep_closed_markets=1) 返回 0 个。两次均 `hasMore=false`，均无标签结果；目录亦未见对应条目。因此这里只能说“此次有界检索找到 0 个相关对阵”，别名或其他标签下的事件仍未知。

## 比赛时间与状态能否用于尾盘对齐

以下分母均为各项目已关闭页的 100 场对阵。四项的事件 `startTime`、市场 `gameStartTime` 均齐全，但本轮没有验证它们是否等于实际开赛时刻。

| 项目 | 非空 `score`／`ended=true` | 非空 `finishedTimestamp` 或 `finishedAt` | 本页 `endDate - startTime` | 本页开赛日期范围（UTC） |
| --- | ---: | ---: | --- | --- |
| 乒乓球 | 0／0；`ended` 缺失 | 0／100 | 全部 +7 天 | 09-04 08:55–14:25 |
| CS2 | 100／100 | 0／100 | 全部 +6 小时 | 09-09 至 09-11 |
| Dota 2 | 100／100 | 0／100 | 全部 +6 小时 | 08-27 至 09-11 |
| Valorant | 100／100 | 0／100 | 全部 +6 小时 | 08-22 至 09-10 |

未关闭页也呈现相同固定偏移。由于已关闭查询限制 `endDate ≤ 采样截点`，乒乓球页被推到了七天前；这不是近期没有比赛的证据，也说明按 `endDate` 取“最近完赛”会产生项目间不同的偏差。四项已关闭页都有 `closedTime`，但它表示平台关闭时间，不能代替现实终场时间。

具体例子：乒乓球 Budnikov–Tebenko（事件 `960504`）`startTime=09-04 14:25Z`、`closedTime=09-04 16:45:30Z`、`endDate=09-11 14:25Z`，已经关闭仍 `period="NS"`；两页 200 场的 `period` 全是 `NS`。CS2 Honvéd–Teletubisie（`1002039`）开赛 `09-11 08:20Z`，平台关闭 `13:07:24Z`，`endDate=14:20Z`，终局比分为 `000-000|2-1|Bo3`，没有实际终场字段。

状态粒度的差异更影响选择：

- CS2 的 6 场直播中，Acend–INOX（`1001733`）有 `score="3-12|0-0|Bo3"`、`period="1/3"`；3DMAX–100 Thieves（`1000135`）有 `5-7|0-0|Bo3`。其余 4 场回合部分为 `000-000`，应保留为未知，不能当作真实 0–0。它已有可验证的回合级入口，适合先做前向采集，但覆盖不完整。
- Dota 的现场样例 Stray Club–Rostik999（`1001787`）只有 `000-000|1-0|Bo3`、`period="2/3"`，`elapsed` 缺失；没有本轮可用的局内时钟、经济、建筑或击杀状态。系列领先一局不足以标记当前局的尾盘阶段。
- Valorant 已关闭样本保留系列比分和地图序号，但本轮没有直播样本验证回合分；可复用 CS2 的采集结构，实时字段覆盖仍待验证。

[官方 Gamma 事件 schema](https://docs.polymarket.com/api-reference/events/list-events.md) 把 `finishedTimestamp` 列为 nullable。[实时数据文档](https://docs.polymarket.com/market-data/realtime-data.md) 的 SportsEvent 有可选 `finishedAt`，说明比分／阶段／结束变化会触发更新，并列出电竞状态和 BO3/BO5 地图序号；同时注明可能延迟、错误或遗漏。该文档没有按本次各个乒乓球系列承诺覆盖。本轮没有连接 WebSocket，也没有验证这些项目的历史终场／逐局状态回补接口。字段存在于 schema，不代表本批比赛已经提供该数据。

## 市场类型与会改变历史标签的规则

- 乒乓球：未关闭样本有 `moneyline` 100、`table_tennis_match_totals` 200、`table_tennis_game_handicap` 199，分别是胜负、总局数、让局。样例 Dvoracek–Hanacek（事件 `1004304`，胜负市场 `4466206`）赛中退赛／失格按晋级者结算；赛前 walkover、取消、平局或七天未决为 50–50。大小／让局文案另外按“最少补足局数”判断已确定结果：其总局数规则明确举例，2–1 停赛时大 3.5 可赢，大 4.5 为 50–50。不能用同一条退赛处理规则覆盖全部盘口。来源字段为 `https://setkacup.com`，本轮未验证其历史比分 API。
- CS2、Valorant：观察到全场 `moneyline`、地图 `child_moneyline`、系列总地图数 `totals`、`map_handicap`，以及 `round_over_under_game_N`、`round_handicap_game_N`。全场胜负、地图胜负、回合盘具有不同结束条件，应分别对齐全场／地图终点。
- Dota：除上述系列／单局类型，还有 `first_blood_game`、`kill_over_under_game`，以及昼夜结束、双方 Roshan、双方兵营、Ultra Kill、Rampage 五类局内事件盘。它们使市场数增加，但不能当作更多独立对阵。MOUZ–Dawn Bulls 的昼夜盘（市场 `4463603`）按结束动作发生时的基础游戏时钟判定，并规定重赛按重赛局结算；Gamma 本轮状态不足以重建这些条件。
- 新近电竞规则样例（CS2 `4467102`、Dota `4463600`、Valorant `4465912`）区分赛前弃权与赛中弃权：前者通常 50–50，后者胜负盘可按获胜队结算；单图未完成可为 50–50。所读新盘延期窗口为 14 个日历日；全场让图／总图数另有比赛完成条件。应保存逐市场原文及版本，不能套用到全部历史市场。样例指定结果来源分别是 HLTV、Dotabuff、VLR；其中后两者与 `/sports` 目录写的 Liquipedia 不同，应以具体市场规则为准。

已关闭页中 `outcomePrices=["0.5","0.5"]` 的市场分别为乒乓球 0/466、CS2 66/1,314、Dota 360/2,063、Valorant 224/2,318，未逐一归因。例如 CS2 Drama–ReThink 最终 2–0，其第三图总回合 21.5 市场 `4457692` 为 0.5/0.5 且 `umaResolutionStatus="resolved"`。这种终态必须单独识别，不能作为仍在比赛中的 50% 价格样本。

## 对主线的具体建议与复现方法

1. 保持网球优先；本报告提供备选项目边界，不替代主线的网球实测结论。
2. CS2 先做少量前向联合采集：保存 `gameId`、地图／回合状态、原始消息时间与本地接收时间、对应市场及盘口变更；先确认真实终场来源和 `000-000` 缺失机制。Valorant 随后沿用这一结构，补直播覆盖验证。
3. 乒乓球先确认 Setka Cup 的比分、退赛及可靠终场来源，再接尾盘回测；WTT、TT Challenger 等应另做分系列有界采样，不能继承本次 Setka 结论。Dota 留作需要局内数据的独立扩展。羽毛球等待取得相关对阵样本后再投入适配。

[价格历史接口](https://docs.polymarket.com/api-reference/markets/get-prices-history) 仅返回 `t,p`，`fidelity` 以分钟计；它不包含挂单存续、排队位置或完整盘口变更。本轮没有下载这些替代项目的价格历史，历史覆盖与逐笔完整性未知。现有样本可支持库存筛选及终态识别；要研究尾盘挂价，需要再将可靠比赛状态与盘口／成交时间序列对齐。

API 请求使用仓库已有公开 HTTP 方法，无认证、无交易调用；原始响应只输出赛事和市场字段。复现以下两页查询可重新计算对阵数量（结果是运行当时快照）：

```sh
node --import tsx --input-type=module <<'NODE'
import { fetchJson } from './src/polymarket/http.ts';
for (const tag of [103767, 100780, 102366, 101672]) {
  for (const closed of [false, true]) {
    const p = new URLSearchParams({ tag_id: String(tag), closed: String(closed),
      limit: '100', offset: '0', order: closed ? 'endDate' : 'id', ascending: 'false' });
    if (closed) p.set('end_date_max', '2026-09-11T14:27:00Z');
    const url = 'https://gamma-api.polymarket.com/events?' + p;
    const rows = await fetchJson(url, { proxyUrl: 'http://127.0.0.1:10808', timeoutMs: 15000 });
    const games = rows.filter(e => e.gameId != null && e.startTime &&
      /\svs\.?\s/i.test(e.title) && e.markets?.some(m => m.sportsMarketType));
    console.log({ at: new Date().toISOString(), url, events: rows.length,
      matches: games.length, uniqueGameIds: new Set(games.map(e => e.gameId)).size });
  }
}
NODE
```

官方文档使用 smart-search-cli 技能的 URL 抓取流程；复用既有发现／历史文档，并执行下列精确 URL 抓取。既有 xAI 搜索超时、Exa 未配置，因此本轮沿用已知可用的 Tavily fetch，没有重复长时间搜索。

```sh
smart-search fetch 'https://docs.polymarket.com/api-reference/events/list-events.md' --format json
smart-search fetch 'https://docs.polymarket.com/api-reference/search/search-markets-events-and-profiles.md' --format json
smart-search fetch 'https://docs.polymarket.com/api-reference/wss/sports' --format json
smart-search fetch 'https://docs.polymarket.com/market-data/realtime-data.md' --format json
```
