import { mkdir, open, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { replayTail } from "./tail-replay.js";
import { tailOptions } from "./tail-catalog.js";
import { renderTailViewer } from "./tail-view.js";
import { csvDocument } from "../research/report.js";
import type { TailOptions, TailPreviewRow, TailStateChange, TailSummary } from "./tail-types.js";
export interface TailExportResult {outputDirectory:string;viewerPath:string;summary:TailSummary}

class BufferedFile {
  private buffer="";private pendingBytes=0;
  bytes=0;
  constructor(private readonly handle:FileHandle){}
  async append(text:string):Promise<{offset:number;bytes:number}>{
    const offset=this.bytes,bytes=Buffer.byteLength(text);
    this.buffer+=text;this.bytes+=bytes;this.pendingBytes+=bytes;
    if(this.pendingBytes>=64*1024)await this.flush();
    return {offset,bytes};
  }
  async flush():Promise<void>{
    const data=Buffer.from(this.buffer);let offset=0;
    while(offset<data.length){const r=await this.handle.write(data,offset,data.length-offset);if(r.bytesWritten<=0)throw new Error("TAIL_EXPORT_WRITE_FAILED");offset+=r.bytesWritten;}
    this.buffer="";this.pendingBytes=0;
  }
  async close():Promise<void>{try{await this.flush();await this.handle.sync();}finally{await this.handle.close();}}
}
const COLUMNS:readonly (keyof TailPreviewRow)[]=["windowKey","eventSlug","gameId","marketId","conditionId","question","marketType","tokenId","outcome",
  "secondIndex","startAtMs","endAtMs","secondsBeforeFinish","status","wholeSecondValid","bestBid","bestAsk","minBestBid","maxBestBid","minBestAsk","maxBestAsk",
  "bookUpdates","tradeCount","tradeShares","bookObservedAtMs","bookSourceAtMs","bookAgeMs","feedAgeMs","bookHash","contextSource","contextObservedAtMs",
  "contextSourceAtMs","contextAgeMs","contextStatus","score","period","clock","stateChangeCount","reasons","depthOffset","depthBytes"];

export async function exportTail(input:TailOptions):Promise<TailExportResult>{
  const options=tailOptions(input);
  const outputDirectory=resolve(options.outputDirectory??join(options.runDirectory,"tail-5m"));
  await mkdir(dirname(outputDirectory),{recursive:true});
  try{await mkdir(outputDirectory);}catch(error){if((error as NodeJS.ErrnoException).code==="EEXIST")throw new Error("TAIL_EXPORT_EXISTS: "+outputDirectory);throw error;}
  const handles:FileHandle[]=[],writers=new Map<string,BufferedFile>();
  try{
    for(const name of ["seconds.ndjson","seconds.csv","changes.ndjson","state-changes.ndjson","audit.ndjson","raw-events.ndjson"]){
      const handle=await open(join(outputDirectory,name),"wx");handles.push(handle);writers.set(name,new BufferedFile(handle));
    }
    const header=csvDocument<TailPreviewRow>([],COLUMNS);await writers.get("seconds.csv")!.append(header);
    const rows:TailPreviewRow[]=[],stateChanges:Array<TailStateChange&{windowKey:string}>=[];
    const summary=await replayTail(options,{
      second:async row=>{
        const position=await writers.get("seconds.ndjson")!.append(JSON.stringify(row)+"\n");
        const {bids:_bids,asks:_asks,...preview}=row;
        const indexed={...preview,depthOffset:position.offset,depthBytes:position.bytes};rows.push(indexed);
        await writers.get("seconds.csv")!.append(csvDocument([indexed],COLUMNS).slice(header.length));
      },
      change:async row=>{await writers.get("changes.ndjson")!.append(JSON.stringify(row)+"\n");},
      stateChange:async row=>{stateChanges.push(row);await writers.get("state-changes.ndjson")!.append(JSON.stringify(row)+"\n");},
      audit:async row=>{await writers.get("audit.ndjson")!.append(JSON.stringify(row)+"\n");},
      rawRecord:async(record,windowKeys)=>{await writers.get("raw-events.ndjson")!.append(JSON.stringify({...record,windowKeys})+"\n");}
    });
    const closed=await Promise.allSettled([...writers.values()].map(writer=>writer.close()));
    const failure=closed.find((r):r is PromiseRejectedResult=>r.status==="rejected");if(failure)throw failure.reason;
    const depthFileBytes=writers.get("seconds.ndjson")!.bytes;
    const viewerPath=join(outputDirectory,"viewer.html");
    await writeFile(viewerPath,renderTailViewer({summary,rows,stateChanges,depthFile:"seconds.ndjson",depthFileBytes}),{flag:"wx"});
    await writeFile(join(outputDirectory,"quality.json"),JSON.stringify(summary,null,2)+"\n",{flag:"wx"});
    await writeFile(join(outputDirectory,"manifest.json"),JSON.stringify({status:"complete",sourceRunId:summary.runId,sourceRunDirectory:resolve(options.runDirectory),
      finishLabelsFile:options.finishLabelsFile?resolve(options.finishLabelsFile):null,createdAt:new Date().toISOString(),depthFile:"seconds.ndjson",depthFileBytes,
      finishFactsFile:options.finishFactsFile?resolve(options.finishFactsFile):null,
      seconds:summary.seconds,changes:summary.changes,stateChanges:summary.stateChanges,audits:summary.audits,rawRecords:summary.rawRecords,
      readyTokens:summary.tokens.filter(t=>t.readyForReplay).length,tokenCount:summary.tokens.length})+"\n",{flag:"wx"});
    return {outputDirectory,viewerPath,summary};
  }catch(error){
    await writeFile(join(outputDirectory,"failure.json"),JSON.stringify({status:"failed",error:String(error)})+"\n",{flag:"wx"}).catch(()=>{});
    throw error;
  }finally{await Promise.allSettled(handles.map(handle=>handle.close()));}
}
