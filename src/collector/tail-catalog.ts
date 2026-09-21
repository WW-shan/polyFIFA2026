import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { listJournalSegments } from "./journal.js";
import { resolveJournalSegment } from "./journal-segments.js";
import { scanJournal } from "./journal-reader.js";
import { emptyReplayQuality } from "./replay-types.js";
import { identifier, objectValue } from "./replay-values.js";
import { gammaEventFromRecord, metadataFromRecord, observationsFromRecord, windowKeyForIdentity, windowKeyForBoundIdentity } from "./tail-context.js";
import { TailIdentityScope } from "./tail-identity-scope.js";
import type { JournalRecord } from "./types.js";
import { isTailFinishSource } from "./tail-types.js";
import type { TailClockIssue, TailClockPolicy, TailClockReceipt, TailEventIdentity, TailFinishFact, TailMetadata, TailObservation, TailOptions, TailWindow, TailWindowIdentity } from "./tail-types.js";

export type EffectiveTailOptions = TailOptions & Required<Pick<TailOptions,"windowSeconds"|"maxFeedSilenceMs"|"sportsStaleAfterMs"|"maxClockDriftMs"|"shockThreshold"|"clockPolicy">>;
export interface TailCatalog {
  windows: TailWindow[];
  windowIdentities: TailWindowIdentity[];
  eventIdentities: ReadonlyMap<string,TailEventIdentity>;
  clockPolicy: TailClockPolicy; clockIssues: TailClockIssue[];
  factsStamp: string | null;
  runId: string; firstMs: number; lastMs: number; records: number; stamp: string; labelText: string | null; warnings: string[];
}
type FinishEvidence = NonNullable<TailWindow["finishEvidence"]>[number];
type CatalogFinish = FinishEvidence & { gameId: string | null; order: number };
// Keep every original witness (including overlaps), with a hard memory bound.
// Exceeding it fails before replay can emit any seconds; never drop provenance.
const MAX_TAIL_CLOCK_ISSUES = 1024;
function clockReceipt(record: JournalRecord): TailClockReceipt {
  const { sequence, receivedAt, receivedAtMs, monotonicNs, source, kind } = record;
  return { sequence, receivedAt, receivedAtMs, monotonicNs, source, kind, connectionId: record.connectionId ?? null };
}
const MAX_TAIL_FINISH_FACTS = 10_000;
const MAX_TAIL_FINISH_FACTS_BYTES = 16 * 1024 * 1024;
async function finishFactsBytes(file: string): Promise<Buffer> {
  const stream = createReadStream(file), chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      if (size > MAX_TAIL_FINISH_FACTS_BYTES) throw new Error("TAIL_FACTS_FILE_TOO_LARGE: maximum 16 MiB");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  } finally { stream.destroy(); }
}
/** Retain a content fingerprint, not the sidecar's potentially large ignored raw fields. */
export async function finishFactsStamp(file: string): Promise<string> {
  return createHash("sha256").update(await finishFactsBytes(file)).digest("hex");
}
function exactFactId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}
function nullableFactId(value: unknown): value is string | null {
  return value === null || exactFactId(value);
}
function factDate(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
}
function finishFactsFromBytes(bytes: Buffer, runId: string): TailFinishFact[] {
  let file: Record<string, unknown> | undefined;
  try { file = objectValue(JSON.parse(bytes.toString("utf8"))); }
  catch { throw new Error("TAIL_FACTS_SCHEMA_INVALID: invalid JSON"); }
  if (file?.schemaVersion !== 1 || file.kind !== "tail-finish-facts" || file.runId !== runId || !Array.isArray(file.facts)) {
    throw new Error("TAIL_FACTS_SCHEMA_INVALID");
  }
  if (file.facts.length > MAX_TAIL_FINISH_FACTS) throw new Error(`TAIL_FACTS_LIMIT_EXCEEDED: ${MAX_TAIL_FINISH_FACTS}`);
  return file.facts.map((value: unknown) => {
    const row = objectValue(value);
    if (!row || !nullableFactId(row.eventId) || !nullableFactId(row.eventSlug) || !nullableFactId(row.gameId)
      || (row.eventSlug === null && row.gameId === null) || !factDate(row.atMs) || !factDate(row.observedAtMs)
      || !isTailFinishSource(row.source) || !exactFactId(row.sourceRunId)
      || !(row.sourceRunDirectory === null || (typeof row.sourceRunDirectory === "string" && row.sourceRunDirectory.trim()))
      || typeof row.sequence !== "number" || !Number.isSafeInteger(row.sequence) || row.sequence < 1
      || typeof row.frameIndex !== "number" || !Number.isSafeInteger(row.frameIndex) || row.frameIndex < 0) {
      throw new Error("TAIL_FACTS_SCHEMA_INVALID: invalid fact");
    }
    // Facts are not HTTP bodies or replayable observations. Copy only the declared
    // boundary/provenance fields, leaving all scores, books and raw extras behind.
    return { eventId: row.eventId, eventSlug: row.eventSlug, gameId: row.gameId,
      atMs: row.atMs, observedAtMs: row.observedAtMs, source: row.source,
      sourceRunId: row.sourceRunId, sourceRunDirectory: row.sourceRunDirectory,
      sequence: row.sequence, frameIndex: row.frameIndex };
  });
}
export function tailOptions(options: TailOptions): EffectiveTailOptions {
  const result = { windowSeconds:300,maxFeedSilenceMs:30_000,sportsStaleAfterMs:60_000,maxClockDriftMs:5000,shockThreshold:.1,...options,clockPolicy:options.clockPolicy??"strict" };
  if (!result.runDirectory?.trim()) throw new Error("TAIL_OPTIONS_INVALID: runDirectory");
  if(result.clockPolicy!=="strict"&&result.clockPolicy!=="flag-backsteps")throw new Error("TAIL_OPTIONS_INVALID: clockPolicy");
  if(result.finishFactsFile!==undefined&&(typeof result.finishFactsFile!=="string"||!result.finishFactsFile.trim()))throw new Error("TAIL_OPTIONS_INVALID: finishFactsFile");
  if(result.compressRawEvents!==undefined&&typeof result.compressRawEvents!=="boolean")throw new Error("TAIL_OPTIONS_INVALID: compressRawEvents");
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
  return JSON.stringify(await Promise.all(files.map(async file=>{const physical=await resolveJournalSegment(join(directory,file));
    const s=physical.stamp;return [file,s.size,s.mtimeMs,physical.compressed,s.dev,s.ino];})));
}
export async function scanTailCatalog(options:EffectiveTailOptions):Promise<TailCatalog>{
  const stamp=await journalStamp(options.runDirectory);
  const metadata=new Map<string,TailMetadata>();
  const markets=new Map<string,TailMetadata["markets"][number]>();
  const identityScope=new TailIdentityScope();
  const finishes=new Map<string,CatalogFinish[]>();
  let finishOrder=0;
  const rememberFinish=(observation:TailObservation,sourceFile?:string):void=>{
    if(observation.finishAtMs===null||observation.finishSource===null)return;
    const eventId=observation.source==="gamma"?identifier(observation.raw.id)??null:null;
    const key=JSON.stringify([eventId,observation.eventSlug,observation.gameId,observation.finishSource,sourceFile]);
    const evidence=finishes.get(key)??[];
    // One first boundary and one first differing witness per identity/provenance suffice
    // to prove conflict. Raw metadata and scores remain in the journal or sidecar.
    if(evidence.length===2||evidence.some(value=>value.atMs===observation.finishAtMs))return;
    evidence.push({atMs:observation.finishAtMs,observedAtMs:observation.observedAtMs,
      source:observation.finishSource,eventId,eventSlug:observation.eventSlug,gameId:observation.gameId,
      order:finishOrder++,...(sourceFile?{sourceFile}:{})});
    finishes.set(key,evidence);
  };
  const warnings=new Set<string>();
  const clockIssues:TailClockIssue[]=[];
  let first:JournalRecord|undefined,last:JournalRecord|undefined,count=0;
  let damageAfterLastRecord=false;
  await scanJournal(options.runDirectory,record=>{
    if(first&&record.runId!==first.runId)throw new Error("TAIL_RUN_MISMATCH");
    if(last&&record.sequence<=last.sequence)throw new Error("TAIL_SEQUENCE_ORDER");
    if(last&&BigInt(record.monotonicNs)<BigInt(last.monotonicNs))throw new Error("TAIL_CLOCK_ORDER");
    const backstep=last!==undefined&&record.receivedAtMs<last.receivedAtMs;
    if(backstep&&options.clockPolicy==="strict")throw new Error("TAIL_CLOCK_ORDER");
    first??=record;
    const elapsed=Number(BigInt(record.monotonicNs)-BigInt(first.monotonicNs))/1e6;
    if(Math.abs(record.receivedAtMs-first.receivedAtMs-elapsed)>options.maxClockDriftMs)throw new Error("TAIL_CLOCK_DISCONTINUITY");
    if(backstep){
      if(last!.receivedAtMs-record.receivedAtMs>options.maxClockDriftMs)throw new Error("TAIL_CLOCK_DISCONTINUITY");
      if(clockIssues.length>=MAX_TAIL_CLOCK_ISSUES)throw new Error(`TAIL_CLOCK_ISSUE_LIMIT_EXCEEDED: ${MAX_TAIL_CLOCK_ISSUES}`);
      clockIssues.push({kind:"receipt-wall-clock-backstep",startAtMs:record.receivedAtMs,endAtMs:last!.receivedAtMs,
        previous:clockReceipt(last!),current:clockReceipt(record)});
    }
    last=record;count++;damageAfterLastRecord=false;
    const rawEvent=gammaEventFromRecord(record);if(rawEvent)identityScope.observeRaw(rawEvent,record);
    const meta=metadataFromRecord(record);
    if(meta){
      const prior=metadata.get(meta.eventId);
      if(prior&&prior.eventSlug!==meta.eventSlug)throw new Error("TAIL_METADATA_IDENTITY_CONFLICT: event slug changed for "+meta.eventId);
      identityScope.observe(meta,prior,record.runId);
      metadata.set(meta.eventId,meta);
      const rawMarkets=Array.isArray(meta.raw.markets)?meta.raw.markets:[];
      if(new Set(meta.markets.map(m=>m.marketId)).size<rawMarkets.length)warnings.add(`unmapped-market-metadata:${meta.eventSlug}`);
      for(const market of meta.markets){
        const before=markets.get(market.tokenId);
        if(before&&(before.conditionId!==market.conditionId||before.outcome!==market.outcome||
          (before.gameId!==market.gameId&&before.eventId!==market.eventId)))throw new Error("TAIL_TOKEN_MAPPING_CONFLICT");
        markets.set(market.tokenId,market);
      }
    }
    for(const observation of observationsFromRecord(record))rememberFinish(observation);
  },emptyReplayQuality(),()=>{warnings.add("damaged-journal-lines");damageAfterLastRecord=true;},options);
  const sealedCheckpoint=!damageAfterLastRecord&&last?.kind==="checkpoint_end"&&(last.data as {sealed?:unknown})?.sealed===true;
  if(!first||!last||last.source!=="collector"||(last.kind!=="session_end"&&!sealedCheckpoint))throw new Error("TAIL_RUN_NOT_CLOSED: use a completed journal or sealed checkpoint");
  if(sealedCheckpoint)warnings.add("sealed-checkpoint: immutable cutoff; collection continued in the source run");
  if(last.kind==="session_end"&&(last.data as {status?:unknown})?.status==="failed")warnings.add("collector-session-failed");
  const quarantine=identityScope.resolve(options.eventSlugs);
  for(const warning of quarantine.warnings)warnings.add(warning);
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
    if(quarantine.eventIds.has(meta.eventId))continue;
    const key=meta.gameId!==null?`game:${meta.gameId}`:`event:${meta.eventId}`;
    let window=groups.get(key);
    if(!window){window={key,eventIds:[],eventSlugs:[],title:meta.title,gameId:meta.gameId,startAtMs:null,endAtMs:null,finishSources:[],finishConflict:false,markets:[]};groups.set(key,window);}
    window.eventIds.push(meta.eventId);window.eventSlugs.push(meta.eventSlug);
  }
  for(const market of markets.values()){
    if(quarantine.eventIds.has(market.eventId))continue;
    const key=market.gameId!==null?`game:${market.gameId}`:`event:${market.eventId}`;
    groups.get(key)?.markets.push(market);
  }
  const allWindows=[...groups.values()];
  const windowIdentities:TailWindowIdentity[]=[...allWindows.map(({key,gameId,eventSlugs})=>({key,gameId,eventSlugs:[...eventSlugs]})),...quarantine.identities];
  const eventIdentities=quarantine.eventIdentities;
  for(const finish of [...finishes.values()].flat().sort((a,b)=>a.order-b.order)){
    const key=windowKeyForBoundIdentity(finish,windowIdentities,eventIdentities);
    if(key===undefined)continue;
    const window=groups.get(key);if(!window)continue; // Reserved, non-exportable quarantine identity.
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
  let factsStamp:string|null=null;
  if(options.finishFactsFile){
    const bytes=await finishFactsBytes(options.finishFactsFile);
    factsStamp=createHash("sha256").update(bytes).digest("hex");
    const facts=finishFactsFromBytes(bytes,first.runId);
    const slugEventIds=new Map<string,Set<string>>();
    for(const meta of metadata.values()){
      const ids=slugEventIds.get(meta.eventSlug)??new Set<string>();
      ids.add(meta.eventId);slugEventIds.set(meta.eventSlug,ids);
    }
    for(const fact of facts){
      // Resolve before selection so a filtered-out known slug cannot hide a
      // contradiction. Unknown companions require a captured shared game.
      let key:string|undefined;
      try{key=windowKeyForBoundIdentity(fact,windowIdentities,eventIdentities);}
      catch(error){throw new Error("TAIL_FACTS_IDENTITY_MISMATCH: raw event binding",{cause:error});}
      if(key===undefined)throw new Error("TAIL_FACTS_IDENTITY_MISMATCH: no captured window");
      const known=fact.eventId===null?undefined:metadata.get(fact.eventId);
      const knownSlug=fact.eventSlug===null?undefined:slugEventIds.get(fact.eventSlug);
      if(fact.eventId!==null&&knownSlug&&(knownSlug.size!==1||!knownSlug.has(fact.eventId)))throw new Error("TAIL_FACTS_IDENTITY_MISMATCH: known slug");
      const window=groups.get(key);
      if(!window){
        // Quarantine is not permission to hide a fact which also names a
        // different/healthy event. Validate that binding before omitting it.
        if(known&&(windowKeyForIdentity({eventSlug:known.eventSlug,gameId:known.gameId},windowIdentities)!==key||
          (fact.eventSlug!==null&&fact.eventSlug!==known.eventSlug)))throw new Error("TAIL_FACTS_IDENTITY_MISMATCH: quarantined event binding");
        continue;
      }
      if(known){
        const expectedKey=known.gameId!==null?`game:${known.gameId}`:`event:${known.eventId}`;
        if(key!==expectedKey||(fact.eventSlug!==null&&fact.eventSlug!==known.eventSlug)||
          (fact.gameId!==null&&known.gameId!==null&&fact.gameId!==known.gameId))throw new Error("TAIL_FACTS_IDENTITY_MISMATCH: known event");
      }else if(fact.eventId!==null&&(fact.gameId===null||window.gameId!==fact.gameId)){
        throw new Error("TAIL_FACTS_IDENTITY_MISMATCH: unknown companion requires a shared game");
      }
      // Native/HTTP evidence retains the first boundary. Later-run facts can
      // prove conflict without replacing the old run's books or live metadata.
      if(window.endAtMs===null){window.endAtMs=fact.atMs;window.startAtMs=fact.atMs-options.windowSeconds*1000;}
      else if(window.endAtMs!==fact.atMs)window.finishConflict=true;
      if(!window.finishSources.includes(fact.source))window.finishSources.push(fact.source);
      (window.finishEvidence??=[]).push({...fact,sourceFile:options.finishFactsFile});
    }
    warnings.add("normalized finish facts imported only for window boundaries; original observations remain in their source journals");
  }
  for(const window of allWindows){
    if(window.finishConflict)warnings.add(`conflicting-finish-labels:${window.key}`);
    if(window.endAtMs===null)warnings.add(`missing-actual-finish:${window.key}`);
  }
  for(const slug of options.eventSlugs??[])if(![...metadata.values()].some(meta=>meta.eventSlug===slug))throw new Error(`TAIL_UNKNOWN_EVENT: ${slug}`);
  const windows=[...groups.values()].filter(w=>!options.eventSlugs?.length||w.eventSlugs.some(slug=>options.eventSlugs!.includes(slug)));
  for(const window of windows){
    // Windows/seconds are half-open, but both original receipt endpoints are
    // uncertain. Pre-scan must flag even a second emitted before the backstep.
    window.clockIssues=clockIssues.filter(issue=>window.startAtMs!==null&&window.endAtMs!==null&&
      issue.startAtMs<window.endAtMs&&issue.endAtMs>=window.startAtMs);
  }
  if(clockIssues.length)warnings.add("receipt-wall-clock-backstep: chronology follows captured sequence; clock-affected bins are not precise");
  if(await journalStamp(options.runDirectory)!==stamp)throw new Error("TAIL_INPUT_CHANGED");
  return {windows,windowIdentities,eventIdentities,clockPolicy:options.clockPolicy,clockIssues,runId:first.runId,firstMs:first.receivedAtMs,lastMs:last.receivedAtMs,records:count,stamp,labelText,factsStamp,warnings:[...warnings]};
}
