import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JournalRecord } from "../../src/collector/types.js";

export function journalRecord(sequence: number, ms: number, source: JournalRecord["source"], kind: string, data: unknown, connectionId?: string): JournalRecord {
  return {schemaVersion:1,runId:"tail-test",sequence,receivedAt:new Date(ms).toISOString(),receivedAtMs:ms,
    monotonicNs:String(BigInt(ms)*1_000_000n+BigInt(sequence)),source,kind,data,...(connectionId?{connectionId}:{})};
}
export function eventMetadata(finish = 310_000, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {event:{id:"event",slug:"game",title:"A vs B",gameId:123,sport:"soccer",tags:[{slug:"soccer"}],startTime:new Date(0).toISOString(),
    ...(finish ? {finishedTimestamp:new Date(finish).toISOString()} : {}),
    markets:[{id:"winner",slug:"winner",conditionId:"condition",question:"Winner?",outcomes:["A","B"],clobTokenIds:["A","B"],sportsMarketType:"moneyline",closed:false,acceptingOrders:true}],...extra}};
}
function wirePrice(value:string):string{return value.startsWith(".")?"0"+value:value;}
export function book(tokenId = "A", bid = "0.95", ask = "0.97", sourceTime = 9000, hash = "h1"): string {
  return JSON.stringify({event_type:"book",asset_id:tokenId,bids:[{price:wirePrice(bid),size:"10"}],asks:[{price:wirePrice(ask),size:"12"}],timestamp:String(sourceTime),hash});
}
export function delta(tokenId: string, oldBid: string, bid: string, atMs: number, hash: string): string {
  return JSON.stringify({event_type:"price_change",timestamp:String(atMs),price_changes:[
    {asset_id:tokenId,side:"BUY",price:wirePrice(oldBid),size:"0",hash}, {asset_id:tokenId,side:"BUY",price:wirePrice(bid),size:"10",hash}
  ]});
}
export function fixtureRecords(): JournalRecord[] {
  return [
    journalRecord(1,0,"collector","session_start",{}),
    journalRecord(2,100,"gamma","event_metadata",eventMetadata()),
    journalRecord(3,200,"collector","connection_open",{source:"clob"},"clob"),
    journalRecord(4,300,"collector","subscription",{type:"market",assets_ids:["A","B"]},"clob"),
    journalRecord(5,400,"collector","connection_open",{source:"sports"},"sports"),
    journalRecord(6,9000,"clob","ws_message",book("A"),"clob"),
    journalRecord(7,9001,"clob","ws_message",book("B",".03",".05",9001,"hB"),"clob"),
    journalRecord(8,9002,"sports","ws_message",JSON.stringify({gameId:123,slug:"game",sport:"soccer",score:"0-0",period:"2H",last_update:new Date(8900).toISOString()}),"sports"),
    journalRecord(9,11_100,"clob","ws_message",delta("A",".95",".60",11_090,"h2"),"clob"),
    journalRecord(10,11_800,"clob","ws_message",delta("A",".60",".94",11_790,"h3"),"clob"),
    journalRecord(11,11_900,"sports","ws_message",JSON.stringify({gameId:123,slug:"game",sport:"soccer",score:"1-0",period:"2H",last_update:new Date(11_400).toISOString()}),"sports"),
    journalRecord(12,12_000,"clob","book_snapshot",{tokenId:"A",response:{asset_id:"A",hash:"h3",timestamp:"11790",bids:[{price:"0.94",size:"10"}],asks:[{price:"0.97",size:"12"}]}}),
    journalRecord(13,12_001,"clob","book_snapshot",{tokenId:"B",response:{asset_id:"B",hash:"hB",timestamp:"9001",bids:[{price:"0.03",size:"10"}],asks:[{price:"0.05",size:"12"}]}}),
    journalRecord(14,309_999,"clob","ws_message","PONG","clob"),
    journalRecord(15,310_100,"collector","session_end",{})
  ];
}
export async function writeFixture(records: JournalRecord[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(),"poly-tail-test-"));
  await mkdir(join(root,"run"));
  await writeFile(join(root,"run","1970-01-01-000000.ndjson"), records.map(row=>JSON.stringify(row)).join("\n")+"\n");
  return root;
}
