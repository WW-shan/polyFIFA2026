import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fetchHttpResponseText, type HttpResponseText } from "../polymarket/http.js";
import { scanTailCatalog, tailOptions } from "./tail-catalog.js";
import { metadataFromRecord } from "./tail-context.js";
import type { JournalRecord } from "./types.js";
export interface FinishLabelOptions {runDirectory:string;outputDirectory:string;proxyUrl?:string;timeoutMs?:number;gammaBaseUrl?:string}
export interface FinishLabelDependencies {request?:(url:string)=>Promise<HttpResponseText>;now?:()=>number}
export async function captureFinishLabels(options:FinishLabelOptions,deps:FinishLabelDependencies={}):Promise<{labelsPath:string;events:number;withFinish:number}>{
  if(!options.outputDirectory?.trim())throw new Error("TAIL_LABEL_OPTIONS: outputDirectory");
  const timeoutMs=options.timeoutMs??15_000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0)throw new Error("TAIL_LABEL_OPTIONS: timeoutMs");
  const output=resolve(options.outputDirectory);
  await mkdir(dirname(output),{recursive:true});await mkdir(output);
  const events:Array<Record<string,unknown>>=[];
  const now=deps.now??Date.now;
  const request=deps.request??((url:string)=>fetchHttpResponseText(url,{timeoutMs,...(options.proxyUrl!==undefined?{proxyUrl:options.proxyUrl}:{})}));
  let withFinish=0;
  try{
    const catalog=await scanTailCatalog(tailOptions({runDirectory:options.runDirectory}));
    for(const window of catalog.windows)for(const [index,slug] of window.eventSlugs.entries()){
      const url=`${(options.gammaBaseUrl??"https://gamma-api.polymarket.com").replace(/\/+$/,"")}/events/slug/${encodeURIComponent(slug)}`;
      const requestedAt=new Date(now()).toISOString();
      const response=await request(url);
      const receivedAtMs=now();
      const evidence={eventId:window.eventIds[index],eventSlug:slug,gameId:window.gameId,url,requestedAt,receivedAtMs,response};
      // Save raw HTTP status/body even if it is not a valid usable label.
      await writeFile(join(output,`response-${events.length+1}.json`),JSON.stringify(evidence)+"\n",{flag:"wx"});
      if(response.status<200||response.status>=300)throw new Error(`TAIL_LABEL_HTTP: ${response.status}`);
      const raw=JSON.parse(response.body) as unknown;
      const record:JournalRecord={schemaVersion:1,runId:catalog.runId,sequence:events.length+1,receivedAtMs,receivedAt:new Date(receivedAtMs).toISOString(),
        monotonicNs:"0",source:"gamma",kind:"event_metadata",data:{event:raw}};
      const metadata=metadataFromRecord(record);
      if(!metadata||metadata.eventId!==window.eventIds[index]||metadata.eventSlug!==slug||metadata.gameId!==window.gameId)throw new Error("TAIL_LABEL_IDENTITY_MISMATCH");
      if(metadata.finishAtMs!==null)withFinish++;
      events.push(evidence);
    }
    const labelsPath=join(output,"finish-labels.json");
    await writeFile(labelsPath,JSON.stringify({schemaVersion:1,kind:"tail-finish-labels",runId:catalog.runId,createdAt:new Date(now()).toISOString(),events})+"\n",{flag:"wx"});
    return {labelsPath,events:events.length,withFinish};
  }catch(error){
    await writeFile(join(output,"failure.json"),JSON.stringify({status:"failed",error:String(error),events:events.length})+"\n",{flag:"wx"}).catch(()=>{});
    throw error;
  }
}
