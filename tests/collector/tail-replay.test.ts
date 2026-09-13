import { afterEach, describe, expect, test } from "vitest";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { replayTail } from "../../src/collector/tail-replay.js";
import type { TailSecond, TailBookChange, TailSnapshotAudit, TailStateChange, TailOptions } from "../../src/collector/tail-types.js";
import type { JournalRecord } from "../../src/collector/types.js";
import { fixtureRecords, journalRecord, eventMetadata, book, writeFixture } from "./tail-fixture.js";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function replay(records=fixtureRecords(),extra:Partial<TailOptions>={}) {
  const root=await writeFixture(records);roots.push(root);
  const seconds:TailSecond[]=[],changes:TailBookChange[]=[],audits:TailSnapshotAudit[]=[],stateChanges:Array<TailStateChange&{windowKey:string}>=[];
  const summary=await replayTail({runDirectory:join(root,"run"),maxFeedSilenceMs:600_000,sportsStaleAfterMs:600_000,...extra}, {
    second:row=>{seconds.push(row);},change:row=>{changes.push(row);},audit:row=>{audits.push(row);},stateChange:row=>{stateChanges.push(row);}
  });
  return {summary,seconds,changes,audits,stateChanges};
}
describe("auditable second-by-second final-five-minute books",()=>{
  test("emits 300 rows per outcome and preserves an intrasecond drop and recovery",async()=>{
    const r=await replay();
    expect(r.seconds).toHaveLength(600);
    const second=r.seconds.find(row=>row.tokenId==="A"&&row.startAtMs===11_000)!;
    expect(second).toMatchObject({status:"observed",wholeSecondValid:true,minBestBid:.60,maxBestBid:.95,bestBid:"0.94",bookUpdates:2,score:"1-0"});
    expect(second.bids).toEqual([{price:"0.94",size:"10"}]);
    expect(r.changes.filter(c=>c.tokenId==="A"&&c.kind==="book").map(c=>c.observedAtMs)).toEqual([11_100,11_800]);
    expect(r.changes.some(c=>c.rapidMove)).toBe(true);
    expect(r.summary.tokens.every(t=>t.observedWindowComplete&&t.snapshotAuditPassed&&t.readyForReplay)).toBe(true);
  });
  test("score/source times are distinct and future score changes never rewrite earlier seconds",async()=>{
    const r=await replay();
    expect(r.seconds.find(row=>row.tokenId==="A"&&row.startAtMs===10_000)?.score).toBe("0-0");
    expect(r.stateChanges).toContainEqual(expect.objectContaining({kind:"score_increase",observedAtMs:11_900,sourceAtMs:11_400,actualEventTimeKnown:false}));
    expect(r.seconds.find(row=>row.tokenId==="A"&&row.startAtMs===11_000)?.contextSourceAtMs).toBe(11_400);
  });
  test("no updates on a healthy stream is explicitly carried, not a new snapshot",async()=>{
    const r=await replay();
    expect(r.seconds.find(row=>row.tokenId==="A"&&row.startAtMs===13_000)).toMatchObject({status:"carried",bookUpdates:0,bestBid:"0.94",wholeSecondValid:true});
  });
  test("a gap followed by a snapshot within one second is still partial",async()=>{
    const records=fixtureRecords();
    records.splice(13,0,
      journalRecord(1,13_100,"collector","connection_gap",{},"clob"),
      journalRecord(1,13_200,"collector","connection_open",{source:"clob"},"clob2"),
      journalRecord(1,13_300,"collector","subscription",{type:"market",assets_ids:["A","B"]},"clob2"),
      journalRecord(1,13_400,"clob","ws_message",book("A",".90",".97",13_390,"h4"),"clob2")
    );
    records.forEach((r,i)=>{r.sequence=i+1;r.monotonicNs=String(BigInt(r.receivedAtMs)*1_000_000n+BigInt(i));});
    const r=await replay(records);
    expect(r.seconds.find(s=>s.tokenId==="A"&&s.startAtMs===13_000)).toMatchObject({status:"partial",wholeSecondValid:false});
    expect(r.summary.tokens.find(t=>t.tokenId==="A")?.observedWindowComplete).toBe(false);
  });
  test("silence is not assumed flat for the rest of the match",async()=>{
    const r=await replay(fixtureRecords(),{maxFeedSilenceMs:2000});
    expect(r.seconds.find(s=>s.tokenId==="A"&&s.startAtMs===20_000)?.status).toBe("feed_stale");
    expect(r.summary.tokens.every(t=>!t.readyForReplay)).toBe(true);
  });
  test("short capture retains missing leading and trailing seconds",async()=>{
    const records=fixtureRecords().filter(r=>r.receivedAtMs>=9000&&r.receivedAtMs<13_000);
    records.unshift(journalRecord(1,8998,"collector","session_start",{}),journalRecord(1,8999,"gamma","event_metadata",eventMetadata()));
    records.push(journalRecord(1,13_000,"collector","session_end",{}));
    records.forEach((r,i)=>{r.sequence=i+1;r.monotonicNs=String(BigInt(r.receivedAtMs)*1_000_000n+BigInt(i));});
    const r=await replay(records);
    expect(r.seconds.find(s=>s.tokenId==="A"&&s.startAtMs===14_000)?.status).toBe("outside_run");
    expect(r.summary.tokens.every(t=>!t.observedWindowComplete)).toBe(true);
  });
  test("already closed side markets are retained as closed, not fabricated flat books",async()=>{
    const records=fixtureRecords();
    const meta=records[1]!.data as {event:{markets:Record<string,unknown>[]}};
    meta.event.markets.push({id:"set",slug:"set",conditionId:"set-condition",question:"First set",outcomes:["Over","Under"],clobTokenIds:["O","U"],sportsMarketType:"tennis_first_set_totals",closed:true});
    const r=await replay(records);
    expect(r.seconds.filter(s=>s.tokenId==="O")).toHaveLength(300);
    expect(r.seconds.filter(s=>s.tokenId==="O").every(s=>s.status==="closed"&&s.bids===null)).toBe(true);
  });
  test("metadata expiry is never used as actual finish",async()=>{
    const records=fixtureRecords();records[1]!.data=eventMetadata(0,{endDate:new Date(310_000).toISOString(),closedTime:new Date(310_000).toISOString()});
    const r=await replay(records);
    expect(r.seconds).toEqual([]);
    expect(r.summary.windows[0]?.endAtMs).toBeNull();
    expect(r.summary.warnings.join(" ")).toContain("finish");
  });
  test("rejects active/unclosed journals and wall-clock discontinuities",async()=>{
    await expect(replay(fixtureRecords().slice(0,-1))).rejects.toThrow("TAIL_RUN_NOT_CLOSED");
    const records=fixtureRecords();records[3]!.receivedAtMs=150;records[3]!.receivedAt=new Date(150).toISOString();
    await expect(replay(records)).rejects.toThrow("TAIL_CLOCK");
  });
  test("same-hash snapshot mismatch quarantines the reconstructed book",async()=>{
    const records=fixtureRecords();
    (records[11]!.data as {response:{bids:unknown[]}}).response.bids=[{price:"0.94",size:"11"}];
    // A complete WS snapshot establishes final depth, not a possibly still
    // fragmented price_change batch carrying the exchange's final hash.
    records.splice(11,0,journalRecord(1,11_999,"clob","ws_message",book("A","0.94","0.97",11_790,"h3"),"clob"));
    records.forEach((r,i)=>{r.sequence=i+1;r.monotonicNs=String(BigInt(r.receivedAtMs)*1_000_000n+BigInt(i));});
    const r=await replay(records);
    expect(r.audits[0]?.status).toBe("mismatch");
    expect(r.summary.tokens.find(t=>t.tokenId==="A")).toMatchObject({snapshotMismatches:1,readyForReplay:false});
    expect(r.seconds.find(s=>s.tokenId==="A"&&s.startAtMs===12_000)?.wholeSecondValid).toBe(false);
  });
  test("finish-only metadata is not claimed as a complete score context",async()=>{
    const records=fixtureRecords().filter(r=>r.source!=="sports");
    records.forEach((r,i)=>{r.sequence=i+1;r.monotonicNs=String(BigInt(r.receivedAtMs)*1_000_000n+BigInt(i));});
    const r=await replay(records);
    expect(r.summary.tokens.every(q=>q.contextSeconds===0&&!q.readyForReplay)).toBe(true);
  });
  test("late older source-clock score updates cannot fake a score rollback",async()=>{
    const records=fixtureRecords();
    records.splice(13,0,journalRecord(1,12_300,"sports","ws_message",JSON.stringify({gameId:123,slug:"game",score:"0-0",period:"2H",last_update:new Date(9000).toISOString()}),"sports"));
    records.forEach((r,i)=>{r.sequence=i+1;r.monotonicNs=String(BigInt(r.receivedAtMs)*1_000_000n+BigInt(i));});
    const r=await replay(records);
    expect(r.seconds.find(s=>s.tokenId==="A"&&s.startAtMs===13_000)?.score).toBe("1-0");
    expect(r.stateChanges.filter(c=>c.kind==="score_decrease")).toHaveLength(0);
    expect(r.summary.warnings.join(" ")).toContain("out-of-order-state");
  });
  test("stale Gamma metadata cannot reopen a token resolved on the market stream",async()=>{
    const records=fixtureRecords();
    records.splice(13,0,
      journalRecord(1,13_100,"clob","ws_message",JSON.stringify({event_type:"market_resolved",assets_ids:["A"],market:"condition"}),"clob"),
      journalRecord(1,14_100,"gamma","event_metadata",eventMetadata())
    );
    records.forEach((r,i)=>{r.sequence=i+1;r.monotonicNs=String(BigInt(r.receivedAtMs)*1_000_000n+BigInt(i));});
    const r=await replay(records);
    expect(r.seconds.find(s=>s.tokenId==="A"&&s.startAtMs===15_000)?.status).toBe("closed");
  });
  test("unknown finish and conflicting finish labels stay explicit in quality and every derived row",async()=>{
    const missing=fixtureRecords();missing[1]!.data=eventMetadata(0);
    expect((await replay(missing)).summary.tokens.every(q=>q.missingSeconds===300)).toBe(true);
    const conflict=fixtureRecords();conflict.splice(13,0,journalRecord(1,14_100,"gamma","event_metadata",eventMetadata(310_001)));
    conflict.forEach((r,i)=>{r.sequence=i+1;r.monotonicNs=String(BigInt(r.receivedAtMs)*1_000_000n+BigInt(i));});
    const r=await replay(conflict);
    expect(r.summary.windows[0]?.finishConflict).toBe(true);
    expect(r.seconds.every(s=>s.reasons.includes("conflicting-finish-labels"))).toBe(true);
  });
  test("a fully reconciled same-hash/timestamp batch is not a lost second and its full raw fragments are retained",async()=>{
    const records=fixtureRecords();
    const initial=JSON.parse(records[5]!.data as string);initial.bids.push({price:"0.85",size:"10"},{price:"0.60",size:"10"});records[5]!.data=JSON.stringify(initial);
    for(const [index,price,ms] of [[8,"0.95",11100],[9,"0.85",11101]] as const){
      records[index]=journalRecord(index+1,ms,"clob","ws_message",JSON.stringify({event_type:"price_change",timestamp:"11090",price_changes:[
        {asset_id:"A",price,size:"0",side:"BUY",hash:"batch",best_bid:"0.60",best_ask:"0.97"}
      ]}),"clob");
    }
    const root=await writeFixture(records);roots.push(root);const seconds:TailSecond[]=[],raw:JournalRecord[]=[],changes:TailBookChange[]=[];
    await replayTail({runDirectory:join(root,"run"),maxFeedSilenceMs:600_000,sportsStaleAfterMs:600_000},{
      second:r=>{seconds.push(r);},change:r=>{changes.push(r);},stateChange:()=>{},audit:()=>{},rawRecord:r=>{raw.push(r);}
    });
    expect(seconds.find(s=>s.tokenId==="A"&&s.startAtMs===11_000)).toMatchObject({wholeSecondValid:true,minBestBid:.6,bestBid:"0.60"});
    expect(changes).toContainEqual(expect.objectContaining({tokenId:"A",kind:"book",rapidMove:true,bidMove:-.35}));
    expect(raw.filter(r=>r.sequence===9||r.sequence===10).map(r=>r.data)).toEqual([records[8]!.data,records[9]!.data]);
  });
});
