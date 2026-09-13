import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { listJournalSegments } from "./journal.js";
import { scanJournal } from "./journal-reader.js";
import { emptyReplayQuality } from "./replay-types.js";
import { metadataFromRecord, observationsFromRecord, windowKeyForIdentity } from "./tail-context.js";
import type { JournalRecord } from "./types.js";
import type { TailMetadata, TailObservation, TailOptions, TailWindow } from "./tail-types.js";

export type EffectiveTailOptions = TailOptions & Required<Pick<TailOptions,"windowSeconds"|"maxFeedSilenceMs"|"sportsStaleAfterMs"|"maxClockDriftMs"|"shockThreshold">>;
export interface TailCatalog {
  windows: TailWindow[];
  windowIdentities: Array<Pick<TailWindow,"key"|"gameId"|"eventSlugs">>;
  runId: string; firstMs: number; lastMs: number; records: number; stamp: string; labelText: string | null; warnings: string[];
}
type FinishEvidence = NonNullable<TailWindow["finishEvidence"]>[number];
type CatalogFinish = FinishEvidence & { gameId: string | null; order: number };
export function tailOptions(options: TailOptions): EffectiveTailOptions {
  const result = { windowSeconds:300,maxFeedSilenceMs:30_000,sportsStaleAfterMs:60_000,maxClockDriftMs:5000,shockThreshold:.1,...options };
  if (!result.runDirectory?.trim()) throw new Error("TAIL_OPTIONS_INVALID: runDirectory");
  if (!Number.isSafeInteger(result.windowSeconds)||result.windowSeconds<1||result.windowSeconds>3600) throw new Error("TAIL_OPTIONS_INVALID: windowSeconds must be in 1..3600");
  for(const key of ["maxFeedSilenceMs","sportsStaleAfterMs","maxClockDriftMs"] as const) {
    if(!Number.isFinite(result[key])||result[key]<=0) throw new Error(`TAIL_OPTIONS_INVALID: ${key}`);
  }
  if(!Number.isFinite(result.shockThreshold)||result.shockThreshold<=0||result.shockThreshold>=1) throw new Error("TAIL_OPTIONS_INVALID: shockThreshold");
  if(result.eventSlugs?.some(slug=>typeof slug!=="string"||!slug.trim()))throw new Error("TAIL_OPTIONS_INVALID: eventSlugs");
  return result;
}
export async function journalStamp(directory:string):Promise<string>{
  const files=await listJournalSegments(directory);
  return JSON.stringify(await Promise.all(files.map(async file=>{const s=await stat(join(directory,file));return [file,s.size,s.mtimeMs];})));
}
export async function scanTailCatalog(options:EffectiveTailOptions):Promise<TailCatalog>{
  const stamp=await journalStamp(options.runDirectory);
  const metadata=new Map<string,TailMetadata>();
  const markets=new Map<string,TailMetadata["markets"][number]>();
  const finishes=new Map<string,CatalogFinish[]>();
  let finishOrder=0;
  const rememberFinish=(observation:TailObservation,sourceFile?:string):void=>{
    if(observation.finishAtMs===null||observation.finishSource===null)return;
    const key=JSON.stringify([observation.eventSlug,observation.gameId,observation.finishSource,sourceFile]);
    const evidence=finishes.get(key)??[];
    // One first boundary and one first differing witness per identity/provenance suffice
    // to prove conflict. Raw metadata and scores remain in the journal or sidecar.
    if(evidence.length===2||evidence.some(value=>value.atMs===observation.finishAtMs))return;
    evidence.push({atMs:observation.finishAtMs,observedAtMs:observation.observedAtMs,
      source:observation.finishSource,eventSlug:observation.eventSlug,gameId:observation.gameId,
      order:finishOrder++,...(sourceFile?{sourceFile}:{})});
    finishes.set(key,evidence);
  };
  const warnings=new Set<string>();
  let first:JournalRecord|undefined,last:JournalRecord|undefined,count=0;
  await scanJournal(options.runDirectory,record=>{
    if(first&&record.runId!==first.runId)throw new Error("TAIL_RUN_MISMATCH");
    if(last&&record.sequence<=last.sequence)throw new Error("TAIL_SEQUENCE_ORDER");
    if(last&&(record.receivedAtMs<last.receivedAtMs||BigInt(record.monotonicNs)<BigInt(last.monotonicNs)))throw new Error("TAIL_CLOCK_ORDER");
    first??=record;
    const elapsed=Number(BigInt(record.monotonicNs)-BigInt(first.monotonicNs))/1e6;
    if(Math.abs(record.receivedAtMs-first.receivedAtMs-elapsed)>options.maxClockDriftMs)throw new Error("TAIL_CLOCK_DISCONTINUITY");
    last=record;count++;
    const meta=metadataFromRecord(record);
    if(meta){
      const prior=metadata.get(meta.eventId);
      if(prior&&(prior.eventSlug!==meta.eventSlug||prior.gameId!==meta.gameId))throw new Error("TAIL_METADATA_IDENTITY_CONFLICT");
      metadata.set(meta.eventId,meta);
      const rawMarkets=Array.isArray(meta.raw.markets)?meta.raw.markets:[];
      if(new Set(meta.markets.map(m=>m.marketId)).size<rawMarkets.length)warnings.add(`unmapped-market-metadata:${meta.eventSlug}`);
      for(const market of meta.markets){
        const before=markets.get(market.tokenId);
        if(before&&(before.conditionId!==market.conditionId||before.outcome!==market.outcome||before.gameId!==market.gameId))throw new Error("TAIL_TOKEN_MAPPING_CONFLICT");
        markets.set(market.tokenId,market);
      }
    }
    for(const observation of observationsFromRecord(record))rememberFinish(observation);
  },emptyReplayQuality(),()=>{warnings.add("damaged-journal-lines");},options);
  if(!first||!last||last.source!=="collector"||last.kind!=="session_end")throw new Error("TAIL_RUN_NOT_CLOSED: use a completed journal");
  if((last.data as {status?:unknown})?.status==="failed")warnings.add("collector-session-failed");
  let labelText:string|null=null;
  if(options.finishLabelsFile){
    labelText=await readFile(options.finishLabelsFile,"utf8");
    const labels=JSON.parse(labelText) as {schemaVersion?:unknown;kind?:unknown;runId?:unknown;events?:unknown};
    if(labels.schemaVersion!==1||labels.kind!=="tail-finish-labels"||labels.runId!==first.runId||!Array.isArray(labels.events))throw new Error("TAIL_LABEL_SCHEMA_INVALID");
    for(const [index,entry] of labels.events.entries()){
      const row=entry as {eventId?:string;eventSlug?:string;gameId?:string|null;receivedAtMs?:number;response?:{status?:number;body?:string}};
      if(typeof row.response?.body!=="string"||!Number.isSafeInteger(row.receivedAtMs)||!row.response.status||row.response.status<200||row.response.status>=300)throw new Error("TAIL_LABEL_SCHEMA_INVALID");
      const evidence:JournalRecord={schemaVersion:1,runId:first.runId,sequence:index+1,receivedAtMs:row.receivedAtMs!,receivedAt:new Date(row.receivedAtMs!).toISOString(),
        monotonicNs:"0",source:"gamma",kind:"event_metadata",data:{event:JSON.parse(row.response.body) as unknown}};
      const meta=metadataFromRecord(evidence),expected=meta?metadata.get(meta.eventId):undefined;
      if(!meta||!expected||meta.eventSlug!==expected.eventSlug||meta.gameId!==expected.gameId||meta.eventId!==row.eventId||meta.eventSlug!==row.eventSlug||meta.gameId!==row.gameId)throw new Error("TAIL_LABEL_IDENTITY_MISMATCH");
      // Only the finish label is imported. Never add these future markets or scores to live state.
      for(const observation of observationsFromRecord(evidence))rememberFinish(observation,options.finishLabelsFile);
    }
    warnings.add("late finish labels imported only for window boundaries; not score or book state");
  }
  const groups=new Map<string,TailWindow>();
  for(const meta of metadata.values()){
    const key=meta.gameId!==null?`game:${meta.gameId}`:`event:${meta.eventId}`;
    let window=groups.get(key);
    if(!window){window={key,eventIds:[],eventSlugs:[],title:meta.title,gameId:meta.gameId,startAtMs:null,endAtMs:null,finishSources:[],finishConflict:false,markets:[]};groups.set(key,window);}
    window.eventIds.push(meta.eventId);window.eventSlugs.push(meta.eventSlug);
  }
  for(const market of markets.values()){
    const key=market.gameId!==null?`game:${market.gameId}`:`event:${market.eventId}`;
    groups.get(key)?.markets.push(market);
  }
  const allWindows=[...groups.values()];
  const windowIdentities=allWindows.map(({key,gameId,eventSlugs})=>({key,gameId,eventSlugs:[...eventSlugs]}));
  for(const finish of [...finishes.values()].flat().sort((a,b)=>a.order-b.order)){
    const key=windowKeyForIdentity(finish,windowIdentities);
    if(key===undefined)continue;
    const window=groups.get(key)!;
    if(window.endAtMs===null){
      window.endAtMs=finish.atMs;window.startAtMs=finish.atMs-options.windowSeconds*1000;
    }else if(window.endAtMs!==finish.atMs)window.finishConflict=true;
    if(!window.finishSources.includes(finish.source))window.finishSources.push(finish.source);
    const evidence=window.finishEvidence??=[];
    const provenance=evidence.filter(value=>value.source===finish.source&&value.eventSlug===finish.eventSlug&&value.sourceFile===finish.sourceFile);
    // Missing/present optional IDs can converge on the same canonical provenance.
    if(provenance.length<2&&!provenance.some(value=>value.atMs===finish.atMs)){
      evidence.push({atMs:finish.atMs,observedAtMs:finish.observedAtMs,source:finish.source,eventSlug:finish.eventSlug,
        ...(finish.sourceFile?{sourceFile:finish.sourceFile}:{})});
    }
  }
  for(const window of allWindows){
    if(window.finishConflict)warnings.add(`conflicting-finish-labels:${window.key}`);
    if(window.endAtMs===null)warnings.add(`missing-actual-finish:${window.key}`);
  }
  for(const slug of options.eventSlugs??[])if(![...metadata.values()].some(meta=>meta.eventSlug===slug))throw new Error(`TAIL_UNKNOWN_EVENT: ${slug}`);
  const windows=[...groups.values()].filter(w=>!options.eventSlugs?.length||w.eventSlugs.some(slug=>options.eventSlugs!.includes(slug)));
  if(await journalStamp(options.runDirectory)!==stamp)throw new Error("TAIL_INPUT_CHANGED");
  return {windows,windowIdentities,runId:first.runId,firstMs:first.receivedAtMs,lastMs:last.receivedAtMs,records:count,stamp,labelText,warnings:[...warnings]};
}
