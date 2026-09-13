import { expect, test } from "vitest";
import { parseTailCliArgs, runTailCli } from "../../src/collector/tail-cli.js";
import { tailOptions } from "../../src/collector/tail-catalog.js";
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
test("manual exports default to strict clocks and explicitly accept either clock policy",()=>{
  const manual=parseTailCliArgs(["export","--run-dir","run"]);
  expect(manual.command).toBe("export");
  if(manual.command!=="export")throw new Error("expected export");
  expect(tailOptions(manual.options).clockPolicy).toBe("strict");
  for(const clockPolicy of ["strict","flag-backsteps"]){
    expect(parseTailCliArgs(["export","--run-dir","run","--clock-policy",clockPolicy]))
      .toMatchObject({command:"export",options:{clockPolicy}});
  }
});
test.each([
  ["export","--run-dir","run","--clock-policy"],
  ["export","--run-dir","run","--clock-policy","ignore"],
  ["labels","--run-dir","run","--output-dir","out","--clock-policy","flag-backsteps"]
])("rejects invalid clock policy arguments %j",(...args)=>{
  expect(()=>parseTailCliArgs(args)).toThrow("TAIL_CLI_ARGUMENTS_INVALID");
});
test("help describes the opt-in policy and strict default",async()=>{
  const lines:string[]=[];
  await runTailCli(["export","--help"],{write:text=>{lines.push(text);}});
  expect(lines.join(" ")).toContain("--clock-policy");
  expect(lines.join(" ")).toContain("flag-backsteps");
  expect(lines.join(" ")).toContain("strict");
});
test("parses normalized finish facts alongside the existing HTTP labels option",()=>{
  expect(parseTailCliArgs(["export","--run-dir","r1","--finish-facts","facts.json","--finish-labels","http-labels.json"]))
    .toMatchObject({command:"export",options:{runDirectory:"r1",finishFactsFile:"facts.json",finishLabelsFile:"http-labels.json"}});
});
test.each([
  ["export","--run-dir","r1","--finish-facts"],
  ["export","--run-dir","r1","--finish-facts",""],
  ["labels","--run-dir","r1","--output-dir","out","--finish-facts","facts.json"]
])("rejects invalid finish facts arguments %j",(...args)=>{
  expect(()=>parseTailCliArgs(args)).toThrow("TAIL_CLI_ARGUMENTS_INVALID");
});
test("help describes normalized finish facts as journal-derived boundary evidence",async()=>{
  const lines:string[]=[];
  await runTailCli(["export","--help"],{write:text=>{lines.push(text);}});
  expect(lines.join(" ")).toContain("--finish-facts");
  expect(lines.join(" ")).toContain("journal");
});
