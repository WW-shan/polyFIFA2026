import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TailOptions } from "./tail-types.js";
import { exportTail, type TailExportResult } from "./tail-export.js";
import { captureFinishLabels, type FinishLabelOptions } from "./tail-labels.js";
import { tailOptions } from "./tail-catalog.js";
export type TailCliArgs={command:"export";options:TailOptions}|{command:"labels";options:FinishLabelOptions}|{command:"help"};
export interface TailCliDependencies {exporter?:(options:TailOptions)=>Promise<TailExportResult>;labels?:(options:FinishLabelOptions)=>Promise<unknown>;write?:(text:string)=>void}
function invalid(message:string):never{throw new Error("TAIL_CLI_ARGUMENTS_INVALID: "+message);}
function value(args:readonly string[],index:number):string{const v=args[index+1];if(!v?.trim()||v.startsWith("--"))invalid(`${args[index]} requires a value`);return v;}
function positive(text:string,integer=true):number{const n=Number(text);if(!Number.isFinite(n)||n<=0||(integer&&!Number.isSafeInteger(n)))invalid("expected a positive number");return n;}
export function parseTailCliArgs(args:readonly string[]):TailCliArgs{
  if(args.length===1&&["--help","help"].includes(args[0]!))return {command:"help"};
  if(args.length===2&&["export","labels"].includes(args[0]!)&&args[1]==="--help")return {command:"help"};
  const command=args[0];if(command!=="export"&&command!=="labels")invalid("expected export or labels");
  const options:TailOptions&Partial<FinishLabelOptions>={runDirectory:""};
  for(let index=1;index<args.length;index++){
    const flag=args[index]!;
    if(flag==="--run-dir"||flag==="--run-directory")options.runDirectory=value(args,index++);
    else if(flag==="--output-dir")options.outputDirectory=value(args,index++);
    else if(command==="export")switch(flag){
      case "--window-seconds":options.windowSeconds=positive(value(args,index++));break;
      case "--finish-labels":options.finishLabelsFile=value(args,index++);break;
      case "--finish-facts":options.finishFactsFile=value(args,index++);break;
      case "--event-slugs":options.eventSlugs=value(args,index++).split(",").map(s=>s.trim());break;
      case "--max-feed-silence-ms":options.maxFeedSilenceMs=positive(value(args,index++));break;
      case "--sports-stale-after-ms":options.sportsStaleAfterMs=positive(value(args,index++));break;
      case "--max-clock-drift-ms":options.maxClockDriftMs=positive(value(args,index++));break;
      case "--clock-policy":{
        const policy=value(args,index++);
        if(policy!=="strict"&&policy!=="flag-backsteps")invalid("clock policy must be strict or flag-backsteps");
        options.clockPolicy=policy;break;
      }
      case "--max-line-bytes":options.maxLineBytes=positive(value(args,index++));break;
      case "--shock-threshold":options.shockThreshold=positive(value(args,index++),false);break;
      default:invalid("unknown export option "+flag);
    }
    else switch(flag){
      case "--proxy-url":options.proxyUrl=value(args,index++);break;
      case "--gamma-base-url":options.gammaBaseUrl=value(args,index++);break;
      case "--timeout-ms":options.timeoutMs=positive(value(args,index++));break;
      default:invalid("unknown labels option "+flag);
    }
  }
  if(!options.runDirectory)invalid("--run-dir is required");
  if(command==="labels"){
    if(!options.outputDirectory)invalid("labels requires a new --output-dir");
    return {command,options:{...options,outputDirectory:options.outputDirectory}};
  }
  tailOptions(options);return {command,options};
}
const HELP=`Public orderbook evidence, no orders. Use completed collector runs.
export --run-dir PATH [--output-dir NEW_PATH] [--window-seconds 300]
  [--event-slugs CSV] [--finish-labels FILE] [--max-feed-silence-ms 30000]
  [--finish-facts FILE]
  [--sports-stale-after-ms 60000] [--shock-threshold 0.1]
  [--clock-policy strict|flag-backsteps] [--max-clock-drift-ms 5000]
Clock policy defaults to strict. flag-backsteps marks bounded receipt-clock uncertainty in quality.
labels --run-dir PATH --output-dir NEW_PATH [--proxy-url URL] [--timeout-ms 15000]
labels saves later Gamma finish evidence; export uses it only for boundaries, never past scores.
finish-facts imports normalized journal finish boundaries with original run/sequence/frame provenance.
The viewer is offline; select its seconds.ndjson file locally for full-depth inspection.
Missing/partial seconds stay explicit. No overwrite or interpolation of missing books.`;
export async function runTailCli(args:readonly string[],deps:TailCliDependencies={}):Promise<unknown>{
  const parsed=parseTailCliArgs(args),write=deps.write??(text=>process.stdout.write(text+"\n"));
  if(parsed.command==="help"){write(HELP);return;}
  if(parsed.command==="labels"){const r=await(deps.labels??captureFinishLabels)(parsed.options);write(JSON.stringify(r));return r;}
  const r=await(deps.exporter??exportTail)(parsed.options);
  write(JSON.stringify({outputDirectory:r.outputDirectory,viewerPath:r.viewerPath,windows:r.summary.windows.length,seconds:r.summary.seconds,
    readyTokens:r.summary.tokens.filter(t=>t.readyForReplay).length,tokenCount:r.summary.tokens.length,warnings:r.summary.warnings}));
  return r;
}
const entry=process.argv[1];
if(entry&&import.meta.url===pathToFileURL(resolve(entry)).href)void runTailCli(process.argv.slice(2)).catch(error=>{process.stderr.write(String(error)+"\n");process.exitCode=1;});
