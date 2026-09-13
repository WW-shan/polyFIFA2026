import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { captureFinishLabels } from "../../src/collector/tail-labels.js";
import { replayTail } from "../../src/collector/tail-replay.js";
import { eventMetadata, fixtureRecords, writeFixture } from "./tail-fixture.js";
import type { TailSecond } from "../../src/collector/tail-types.js";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
test("late finish metadata anchors a window without backfilling final scores or market state",async()=>{
  const records=fixtureRecords();records[1]!.data=eventMetadata(0);
  const root=await writeFixture(records);roots.push(root);
  const event=(eventMetadata(310_000,{score:"9-9",closed:true}) as {event:unknown}).event;
  const result=await captureFinishLabels({runDirectory:join(root,"run"),outputDirectory:join(root,"labels")},{
    request:async()=>({status:200,statusText:"OK",headers:{},body:JSON.stringify(event)}),now:()=>400_000
  });
  const data=JSON.parse(await readFile(result.labelsPath,"utf8"));
  expect(data).toMatchObject({kind:"tail-finish-labels",runId:"tail-test"});
  expect(data.events[0].response.body).toBe(JSON.stringify(event));
  const seconds:TailSecond[]=[];
  const summary=await replayTail({runDirectory:join(root,"run"),finishLabelsFile:result.labelsPath,maxFeedSilenceMs:600_000,sportsStaleAfterMs:600_000},
    {second:r=>{seconds.push(r);},change:()=>{},stateChange:()=>{},audit:()=>{}});
  expect(seconds).toHaveLength(600);
  expect(seconds.find(s=>s.tokenId==="A"&&s.startAtMs===10_000)?.score).toBe("0-0");
  expect(seconds.some(s=>s.score==="9-9")).toBe(false);
  expect(summary.windows[0]?.finishEvidence).toContainEqual(expect.objectContaining({atMs:310_000,observedAtMs:400_000,sourceFile:result.labelsPath}));
  let calls=0;
  await expect(captureFinishLabels({runDirectory:join(root,"run"),outputDirectory:join(root,"labels")},{request:async()=>{calls++;throw new Error("not used");}})).rejects.toThrow();
  expect(calls).toBe(0);
});
test("wrong event identities cannot become a finish label",async()=>{
  const root=await writeFixture(fixtureRecords());roots.push(root);
  const event=(eventMetadata(310_000,{gameId:999}) as {event:unknown}).event;
  await expect(captureFinishLabels({runDirectory:join(root,"run"),outputDirectory:join(root,"labels")},{request:async()=>({status:200,statusText:"OK",headers:{},body:JSON.stringify(event)})})).rejects.toThrow("TAIL_LABEL_IDENTITY");
});
test("conflicting Gamma game ID aliases cannot become labels, while the original response is saved",async()=>{
  const root=await writeFixture(fixtureRecords());roots.push(root);
  const event=(eventMetadata(310_000,{gameId:undefined,eventMetadata:{gameId:123},game_id:"other-game"}) as {event:unknown}).event;
  const body=JSON.stringify(event),outputDirectory=join(root,"labels");
  await expect(captureFinishLabels({runDirectory:join(root,"run"),outputDirectory},{
    request:async()=>({status:200,statusText:"OK",headers:{},body}),now:()=>400_000
  })).rejects.toThrow("TAIL_IDENTITY_CONFLICT");
  expect(JSON.parse(await readFile(join(outputDirectory,"response-1.json"),"utf8")).response.body).toBe(body);
  await expect(readFile(join(outputDirectory,"finish-labels.json"),"utf8")).rejects.toThrow();
});
