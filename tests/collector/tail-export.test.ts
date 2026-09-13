import { afterEach, expect, test } from "vitest";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exportTail } from "../../src/collector/tail-export.js";
import { fixtureRecords, writeFixture } from "./tail-fixture.js";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
test("exports exact one-second depth, raw changes, state changes, audits and an offline indexed viewer",async()=>{
  const root=await writeFixture(fixtureRecords());roots.push(root);
  const out=join(root,"tail");
  const result=await exportTail({runDirectory:join(root,"run"),outputDirectory:out,maxFeedSilenceMs:600_000,sportsStaleAfterMs:600_000});
  expect(result.summary.seconds).toBe(600);
  expect((await readdir(out)).sort()).toEqual(["audit.ndjson","changes.ndjson","manifest.json","quality.json","raw-events.ndjson","seconds.csv","seconds.ndjson","state-changes.ndjson","viewer.html"]);
  const raw=await readFile(join(out,"seconds.ndjson"));
  const rows=raw.toString().trim().split("\n").map(line=>JSON.parse(line));
  expect(rows.find(r=>r.tokenId==="A"&&r.startAtMs===11_000)).toMatchObject({bestBid:"0.94",minBestBid:.6,bookUpdates:2});
  const html=await readFile(join(out,"viewer.html"),"utf8");
  const payload=JSON.parse(/<script id="tail-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!);
  const selected=payload.rows.find((r:{tokenId:string;startAtMs:number})=>r.tokenId==="A"&&r.startAtMs===11_000);
  const depth=JSON.parse(raw.subarray(selected.depthOffset,selected.depthOffset+selected.depthBytes).toString());
  expect(depth.tokenId).toBe("A");expect(depth.bids).toEqual([{price:"0.94",size:"10"}]);
  expect(payload.depthFileBytes).toBe(raw.length);
  expect(await readFile(join(out,"seconds.csv"),"utf8")).toContain("wholeSecondValid");
  const manifest=JSON.parse(await readFile(join(out,"manifest.json"),"utf8"));
  expect(manifest).toMatchObject({status:"complete",sourceRunId:"tail-test"});
  await expect(exportTail({runDirectory:join(root,"run"),outputDirectory:out})).rejects.toThrow("TAIL_EXPORT_EXISTS");
});
test("a broken/unclosed source never publishes a successful manifest",async()=>{
  const root=await writeFixture(fixtureRecords().slice(0,-1));roots.push(root);
  await expect(exportTail({runDirectory:join(root,"run"),outputDirectory:join(root,"tail")})).rejects.toThrow("TAIL_RUN_NOT_CLOSED");
  await expect(readFile(join(root,"tail","manifest.json"))).rejects.toThrow();
});
test("does not replace a pre-existing file at the export target",async()=>{
  const root=await writeFixture(fixtureRecords());roots.push(root);const target=join(root,"tail");await writeFile(target,"keep");
  await expect(exportTail({runDirectory:join(root,"run"),outputDirectory:target})).rejects.toThrow("TAIL_EXPORT_EXISTS");
  expect(await readFile(target,"utf8")).toBe("keep");
});
