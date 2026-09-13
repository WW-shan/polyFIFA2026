import { afterEach, describe, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { replayTail } from "../../src/collector/tail-replay.js";
import type { JournalRecord } from "../../src/collector/types.js";
import type { TailOptions, TailSecond, TailSnapshotAudit, TailStateChange } from "../../src/collector/tail-types.js";
import { book, eventMetadata, fixtureRecords, journalRecord, writeFixture } from "./tail-fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function ordered(records: JournalRecord[]): JournalRecord[] {
  return records.sort((a, b) => a.receivedAtMs - b.receivedAtMs).map((record, index) => ({
    ...record, sequence: index + 1, monotonicNs: String(BigInt(record.receivedAtMs) * 1_000_000n + BigInt(index))
  }));
}
async function run(records: JournalRecord[], options: Partial<TailOptions> = {}) {
  const root = await writeFixture(records); roots.push(root);
  const seconds: TailSecond[] = [], audits: TailSnapshotAudit[] = [], states: TailStateChange[] = [];
  const summary = await replayTail({ runDirectory: join(root, "run"), maxFeedSilenceMs: 600_000, sportsStaleAfterMs: 600_000, ...options }, {
    second: row => { seconds.push(row); }, audit: row => { audits.push(row); }, stateChange: row => { states.push(row); }, change() {}
  });
  return { seconds, audits, states, summary };
}
function httpBook(ms: number, hash: string, timestamp: number, bids: Array<{ price: string; size: string }>): JournalRecord {
  return journalRecord(1, ms, "clob", "book_snapshot", { tokenId: "A", response: {
    asset_id: "A", hash, timestamp: String(timestamp), bids, asks: [{ price: "0.97", size: "12" }]
  } });
}
function score(ms: number, value: string, sourceMs?: number, slug = true): JournalRecord {
  return journalRecord(1, ms, "sports", "ws_message", JSON.stringify({ gameId: 123, ...(slug ? { slug: "game" } : {}), sport: "soccer", score: value,
    period: "2H", ...(sourceMs !== undefined ? { last_update: new Date(sourceMs).toISOString() } : {}) }), "sports");
}

describe("review regression: uncertainty before emitting a second", () => {
  test("a sequence gap discovered after the window invalidates the possibly affected final second", async () => {
    const records = fixtureRecords();
    records[13] = journalRecord(14, 309_000, "clob", "ws_message", "PONG", "clob");
    records[14] = journalRecord(16, 310_100, "collector", "session_end", {});
    const result = await run(records);
    expect(result.seconds.find(row => row.tokenId === "A" && row.startAtMs === 309_000)?.wholeSecondValid).toBe(false);
    expect(result.summary.tokens.every(token => !token.readyForReplay)).toBe(true);
    expect(result.summary.journalQuality.sequenceGaps).toEqual([{ expected: 15, actual: 16 }]);
  });

  test("a pre-window sequence gap clears score context even after books are resnapshotted", async () => {
    const records = ordered([...fixtureRecords(),
      journalRecord(1, 9500, "clob", "ws_message", book("A", "0.95", "0.97", 9500, "recovered-A"), "clob"),
      journalRecord(1, 9501, "clob", "ws_message", book("B", "0.03", "0.05", 9501, "recovered-B"), "clob")
    ]);
    for (const record of records) if (record.receivedAtMs >= 9500) record.sequence++;
    const result = await run(records);
    expect(result.seconds.find(row => row.tokenId === "A" && row.startAtMs === 10_000)?.contextStatus).toBe("missing");
    expect(result.states.filter(change => change.kind === "score_increase")).toEqual([]);
  });

  test("a PONG cannot hide a stale interval earlier in the same second", async () => {
    const records = fixtureRecords();
    records[5] = journalRecord(6, 8499, "clob", "ws_message", book("A", "0.95", "0.97", 8499, "h1"), "clob");
    records[6] = journalRecord(7, 8500, "clob", "ws_message", book("B", "0.03", "0.05", 8500, "hB"), "clob");
    const result = await run(ordered([...records, journalRecord(1, 10_800, "clob", "ws_message", "PONG", "clob")]), { maxFeedSilenceMs: 2000 });
    expect(result.seconds.find(row => row.tokenId === "A" && row.startAtMs === 10_000)).toMatchObject({ status: "partial", wholeSecondValid: false });
  });
});

describe("review regression: persistent canonical score clock", () => {
  test.each([{eventSlugs:undefined},{eventSlugs:["game"]}])("a contradictory captured slug cannot supply another game's score (filter: %j)", async ({eventSlugs}) => {
    const other=eventMetadata(0,{id:"other-event",slug:"other-game",gameId:456,markets:[]});
    const badScore=journalRecord(1,12_300,"sports","ws_message",JSON.stringify({gameId:123,slug:"other-game",score:"9-9",last_update:new Date(12_200).toISOString()}),"sports");
    await expect(run(ordered([...fixtureRecords(),journalRecord(1,500,"gamma","event_metadata",other),badScore]),eventSlugs?{eventSlugs}:{}).then(()=>undefined)).rejects.toThrow("TAIL_IDENTITY_CONFLICT");
  });

  test.each([true, false])("untimed updates cannot reset the source watermark (slug supplied: %s)", async slug => {
    const result = await run(ordered([...fixtureRecords(), score(12_200, "1-0"), score(12_300, "0-0", 9000, slug)]));
    expect(result.seconds.find(row => row.tokenId === "A" && row.startAtMs === 13_000)?.score).toBe("1-0");
    expect(result.states.filter(change => change.kind === "score_decrease")).toHaveLength(0);
    expect(result.summary.warnings.join(" ")).toContain("out-of-order-state");
  });

  test("a genuinely newer source-clock correction is retained", async () => {
    const result = await run(ordered([...fixtureRecords(), score(12_300, "0-0", 12_200, false)]));
    expect(result.seconds.find(row => row.tokenId === "A" && row.startAtMs === 13_000)?.score).toBe("0-0");
    expect(result.states).toContainEqual(expect.objectContaining({ kind: "score_decrease", observedAtMs: 12_300, sourceAtMs: 12_200 }));
  });

  test.each([8900, undefined])("a recently polled Gamma score cannot roll back a newer Sports state (source time: %s)", async sourceMs => {
    const meta=eventMetadata(310_000,{score:"0-0",period:"2H",...(sourceMs===undefined?{}:{last_update:new Date(sourceMs).toISOString()})});
    const result=await run(ordered([...fixtureRecords(),journalRecord(1,14_000,"gamma","event_metadata",meta)]),{sportsStaleAfterMs:2000});
    expect(result.seconds.find(row=>row.tokenId==="A"&&row.startAtMs===14_000)).toMatchObject({score:"1-0",contextSource:"sports-ws",contextStatus:"stale"});
  });

  test("a provably newer Gamma correction can supply the stale Sports fallback", async () => {
    const meta=eventMetadata(310_000,{score:"0-0",period:"2H",last_update:new Date(13_800).toISOString()});
    const result=await run(ordered([...fixtureRecords(),journalRecord(1,14_000,"gamma","event_metadata",meta)]),{sportsStaleAfterMs:2000});
    expect(result.seconds.find(row=>row.tokenId==="A"&&row.startAtMs===14_000)).toMatchObject({score:"0-0",contextSource:"gamma",contextStatus:"present"});
  });
});

describe("review regression: seed and provisional snapshot audits", () => {
  test("a contradictory snapshot before the window quarantines its seed book", async () => {
    const result = await run(ordered([...fixtureRecords(), httpBook(9500, "h1", 9000, [{ price: "0.95", size: "11" }])]));
    expect(result.seconds.find(row => row.tokenId === "A" && row.startAtMs === 10_000)?.wholeSecondValid).toBe(false);
    expect(result.summary.tokens.find(token => token.tokenId === "A")?.readyForReplay).toBe(false);
    expect(result.audits).toContainEqual(expect.objectContaining({ observedAtMs: 9500, status: "mismatch", scope: "seed" }));
  });

  test("a real snapshot before the window can replace the bad seed", async () => {
    const recovered = JSON.parse(book("A", "0.95", "0.97", 9800, "corrected-seed")); recovered.bids[0].size = "11";
    const result = await run(ordered([...fixtureRecords(), httpBook(9500, "h1", 9000, [{ price: "0.95", size: "11" }]),
      journalRecord(1, 9800, "clob", "ws_message", JSON.stringify(recovered), "clob")]));
    expect(result.summary.tokens.find(token => token.tokenId === "A")?.readyForReplay).toBe(true);
  });

  test("a delayed historical mismatch cannot quarantine an independently replaced seed", async () => {
    const result=await run(ordered([...fixtureRecords(),
      journalRecord(1,9800,"clob","ws_message",book("A","0.95","0.97",9800,"new-seed"),"clob"),
      httpBook(9900,"h1",9000,[{price:"0.95",size:"11"}])
    ]));
    expect(result.audits).toContainEqual(expect.objectContaining({observedAtMs:9900,status:"mismatch",scope:"seed"}));
    expect(result.summary.tokens.find(token=>token.tokenId==="A")?.readyForReplay).toBe(true);
  });

  test("independent snapshots within one array frame retain distinct audit generations", async () => {
    const records=fixtureRecords();
    records[5]!.data=JSON.stringify([JSON.parse(book("A")),JSON.parse(book("A","0.95","0.97",9000,"replacement"))]);
    const result=await run(ordered([...records,httpBook(9500,"h1",9000,[{price:"0.95",size:"11"}])]));
    expect(result.summary.tokens.find(token=>token.tokenId==="A")?.readyForReplay).toBe(true);
  });

  function pendingBatch(complete = true): JournalRecord[] {
    const records = fixtureRecords().filter(record => record.sequence !== 9 && record.sequence !== 10 && record.sequence !== 12);
    const initial = JSON.parse(records.find(record => record.sequence === 6)!.data as string);
    initial.bids.push({ price: "0.85", size: "10" }, { price: "0.60", size: "10" }, { price: "0.40", size: "10" });
    records.find(record => record.sequence === 6)!.data = JSON.stringify(initial);
    const fragment = (ms: number, updates: Array<[string, string]>) => journalRecord(1, ms, "clob", "ws_message", JSON.stringify({
      event_type: "price_change", timestamp: "11090", price_changes: updates.map(([price, size]) => ({ asset_id: "A", price, size, side: "BUY", hash: "batch", best_bid: "0.95", best_ask: "0.97" }))
    }), "clob");
    const bids = [{ price: "0.95", size: "10" }, { price: "0.85", size: "20" }, { price: "0.60", size: "10" }];
    records.push(fragment(11_100, [["0.40", "0"]]), fragment(11_101, [["0.98", "1"]]), httpBook(11_102, "batch", 11_090, bids));
    if (complete) records.push(fragment(11_103, [["0.98", "0"], ["0.85", "20"]]));
    records.push(httpBook(12_000, "batch", 11_090, bids));
    return ordered(records);
  }

  test("an HTTP final snapshot waits for the provisional batch before judging its depth", async () => {
    const result = await run(pendingBatch());
    expect(result.audits.filter(audit => audit.tokenId === "A").every(audit => audit.status === "match")).toBe(true);
    expect(result.seconds.find(row => row.tokenId === "A" && row.startAtMs === 13_000)?.wholeSecondValid).toBe(true);
    expect(result.summary.tokens.find(token => token.tokenId === "A")?.readyForReplay).toBe(true);
  });

  test("an unresolved batch is not repaired or verified by a deferred HTTP audit", async () => {
    const result = await run(pendingBatch(false));
    expect(result.audits.filter(audit => audit.tokenId === "A").every(audit => audit.status === "not_comparable")).toBe(true);
    expect(result.summary.tokens.find(token => token.tokenId === "A")?.readyForReplay).toBe(false);
  });

  test("a deferred audit cannot quarantine a newer independent websocket snapshot", async () => {
    const records = pendingBatch(false);
    records.push(journalRecord(1, 12_100, "clob", "ws_message", book("A", "0.90", "0.97", 12_090, "fresh"), "clob"));
    const result = await run(ordered(records));
    expect(result.audits.filter(audit => audit.tokenId === "A").every(audit => audit.status === "not_comparable")).toBe(true);
    expect(result.seconds.find(row => row.tokenId === "A" && row.startAtMs === 13_000)?.wholeSecondValid).toBe(true);
  });

  test("top-price recovery is not final depth while more fragments share its batch hash", async () => {
    const records=pendingBatch();
    for(const record of records)if(record.kind==="book_snapshot"&&(record.data as {tokenId:string}).tokenId==="A"){
      (record.data as {response:{bids:Array<{price:string;size:string}>}}).response.bids.find(level=>level.price==="0.60")!.size="11";
    }
    records.push(journalRecord(1,11_104,"clob","ws_message",JSON.stringify({event_type:"price_change",timestamp:"11090",price_changes:[
      {asset_id:"A",price:"0.60",size:"11",side:"BUY",hash:"batch",best_bid:"0.95",best_ask:"0.97"}
    ]}),"clob"));
    const result=await run(ordered(records));
    expect(result.audits.filter(audit=>audit.tokenId==="A").every(audit=>audit.status==="match")).toBe(true);
    expect(result.summary.tokens.find(token=>token.tokenId==="A")?.readyForReplay).toBe(true);
  });

  test("a top-consistent partial batch also waits for its remaining depth changes", async () => {
    const result=await run(ordered(pendingBatch().filter(record=>record.receivedAtMs!==11_101)));
    expect(result.audits.filter(audit=>audit.tokenId==="A").every(audit=>audit.status==="match")).toBe(true);
    expect(result.summary.tokens.find(token=>token.tokenId==="A")?.readyForReplay).toBe(true);
  });

  test("an unfinished top-consistent audit remains unverified despite an earlier matching snapshot", async () => {
    const records=pendingBatch(false).filter(record=>record.receivedAtMs!==11_101);
    const initial=JSON.parse(records.find(record=>record.source==="clob"&&typeof record.data==="string"&&JSON.parse(record.data).asset_id==="A")!.data as string);
    records.push(httpBook(10_100,"h1",9000,initial.bids));
    const result=await run(ordered(records));
    expect(result.summary.tokens.find(token=>token.tokenId==="A")).toMatchObject({snapshotMatches:1,snapshotMismatches:0,readyForReplay:false});
    expect(result.audits.filter(audit=>audit.tokenId==="A"&&audit.observedAtMs>11_100).every(audit=>audit.status==="not_comparable")).toBe(true);
  });

  test("replacing a pending response with an older matching audit cannot erase depth uncertainty", async () => {
    const records=pendingBatch(false).filter(record=>record.receivedAtMs!==11_101);
    const initial=JSON.parse(records.find(record=>record.source==="clob"&&typeof record.data==="string"&&JSON.parse(record.data).asset_id==="A")!.data as string);
    records.push(httpBook(10_100,"h1",9000,initial.bids));
    records.find(record=>record.kind==="book_snapshot"&&record.receivedAtMs===12_000)!.data=httpBook(12_000,"h1",9000,initial.bids).data;
    const result=await run(ordered(records));
    expect(result.summary.tokens.find(token=>token.tokenId==="A")).toMatchObject({snapshotAuditPassed:false,readyForReplay:false});
  });

  test("HTTP-detected partial depth crossing a second edge cannot produce two complete seconds", async () => {
    const records=pendingBatch().filter(record=>record.receivedAtMs!==11_101).map(record=>{
      const at=record.receivedAtMs===11_100||record.receivedAtMs===11_102?11_999:record.receivedAtMs===11_103?12_001:record.receivedAtMs===12_000?12_100:record.receivedAtMs;
      return journalRecord(record.sequence,at,record.source,record.kind,record.data,record.connectionId);
    });
    const result=await run(ordered(records));
    for(const startAtMs of [11_000,12_000])expect(result.seconds.find(row=>row.tokenId==="A"&&row.startAtMs===startAtMs)?.wholeSecondValid).toBe(false);
    expect(result.summary.tokens.find(token=>token.tokenId==="A")?.readyForReplay).toBe(false);
  });

  test("an independent snapshot cannot erase earlier audit uncertainty within the same second", async () => {
    const records=pendingBatch(false).filter(record=>record.receivedAtMs!==11_101);
    records.push(journalRecord(1,11_300,"clob","ws_message",book("A","0.95","0.97",11_290,"independent"),"clob"));
    records.find(record=>record.kind==="book_snapshot"&&record.receivedAtMs===12_000)!.data=httpBook(12_000,"independent",11_290,[{price:"0.95",size:"10"}]).data;
    const result=await run(ordered(records));
    expect(result.seconds.find(row=>row.tokenId==="A"&&row.startAtMs===11_000)).toMatchObject({status:"partial",wholeSecondValid:false});
    expect(result.seconds.find(row=>row.tokenId==="A"&&row.startAtMs===13_000)?.wholeSecondValid).toBe(true);
    expect(result.summary.tokens.find(token=>token.tokenId==="A")?.readyForReplay).toBe(false);
  });
});
