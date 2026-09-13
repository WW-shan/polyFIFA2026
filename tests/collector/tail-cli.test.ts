import { expect, test } from "vitest";
import { parseTailCliArgs, runTailCli } from "../../src/collector/tail-cli.js";
test("parses an exact final-five-minute export and separate finish-label evidence",()=>{
  expect(parseTailCliArgs(["export","--run-dir","run","--output-dir","out","--window-seconds","300","--finish-labels","labels.json","--event-slugs","a,b","--shock-threshold","0.08"]))
    .toMatchObject({command:"export",options:{runDirectory:"run",outputDirectory:"out",windowSeconds:300,finishLabelsFile:"labels.json",eventSlugs:["a","b"],shockThreshold:.08}});
  expect(parseTailCliArgs(["labels","--run-dir","run","--output-dir","labels","--proxy-url","http://localhost:1"]))
    .toEqual({command:"labels",options:{runDirectory:"run",outputDirectory:"labels",proxyUrl:"http://localhost:1"}});
});
test.each([
  [],["other"],["export"],["export","--run-dir","r","--window-seconds","0"],
  ["export","--run-dir","r","--window-seconds","1.5"],["export","--run-dir","r","--shock-threshold","NaN"],
  ["export","--run-dir","r","--event-slugs",","],["labels","--run-dir","r"],["export","--run-dir","r","--overwrite"]
])("rejects invalid or destructive invocation %j",(...args)=>{expect(()=>parseTailCliArgs(args)).toThrow("TAIL_");});
test.each([["--help"],["export","--help"],["labels","--help"]])("help %j performs no file reads or requests",async(...args)=>{
  const lines:string[]=[];
  await runTailCli(args,{write:t=>{lines.push(t);},exporter:async()=>{throw new Error("must not run");},labels:async()=>{throw new Error("must not run");}});
  expect(lines.join(" ")).toContain("300");expect(lines.join(" ")).toContain("finish-labels");
});
