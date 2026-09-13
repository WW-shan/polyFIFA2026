import { describe, expect, test } from "vitest";
import { auditSnapshot, auditBook } from "../../src/collector/tail-audit.js";
import type { JournalRecord } from "../../src/collector/types.js";
import type { ReplayQuoteRow } from "../../src/collector/replay-types.js";
const quote: ReplayQuoteRow = { sequence: 1, receivedAt: new Date(1000).toISOString(), receivedAtMs: 1000,
  connectionId: "clob", tokenId: "token", bids: [{price:"0.50",size:"10.0"}], asks: [{price:"0.7",size:"20"}], serverTimestamp: "900", bookHash: "state-hash" };
function snapshot(extra: Record<string, unknown> = {}): JournalRecord {
  return { schemaVersion: 1, runId: "run", sequence: 2, receivedAt: new Date(2000).toISOString(), receivedAtMs: 2000, monotonicNs: "2000000000",
    source: "clob", kind: "book_snapshot", data: { tokenId: "token", requestStartedAt: new Date(500).toISOString(), response: {
      asset_id: "token", hash: "state-hash", timestamp: "900", bids: [{price:"0.5",size:"10"}], asks: [{price:"0.70",size:"20.0"}], ...extra
    } } };
}
describe("HTTP snapshots audit, never overwrite WS history", () => {
  test("compares exact normalized depth under the same source hash despite decimal spellings", () => {
    expect(auditSnapshot(snapshot(), [auditBook(quote)], "game")).toMatchObject({status:"match",basis:"hash",snapshotAtMs:900,websocketAtMs:900});
  });
  test("same hash plus different depth exposes replay divergence", () => {
    expect(auditSnapshot(snapshot({bids:[{price:"0.5",size:"11"}]}), [auditBook(quote)], "game")).toMatchObject({status:"mismatch",basis:"hash"});
  });
  test("finds a comparable older WS version instead of comparing a delayed snapshot to the newest state", () => {
    const later = auditBook({...quote, receivedAtMs:1900, serverTimestamp:"1800", bookHash:"later", bids:[{price:"0.6",size:"10"}]});
    expect(auditSnapshot(snapshot(), [auditBook(quote),later], "game").status).toBe("match");
  });
  test("different hashes/times are not proof of a lost update", () => {
    expect(auditSnapshot(snapshot({hash:"different",timestamp:"950"}),[auditBook(quote)],"game")).toMatchObject({status:"not_comparable",basis:"none"});
  });
  test("conflicting hashes are not made comparable by the same millisecond timestamp", () => {
    expect(auditSnapshot(snapshot({hash:"different"}),[auditBook(quote)],"game").status).toBe("not_comparable");
  });
  test("matching source timestamps can confirm equal depth when hashes are absent", () => {
    const noHash = {...quote}; delete noHash.bookHash;
    expect(auditSnapshot(snapshot({hash:undefined}),[auditBook(noHash)],"game")).toMatchObject({status:"match",basis:"source_timestamp"});
  });
  test("invalid or mismatched snapshot identities and levels are explicit", () => {
    for(const extra of [{asset_id:"other"},{bids:[{price:"2",size:"1"}]},{asks:null},{timestamp:"not-time"}]) {
      expect(auditSnapshot(snapshot(extra),[auditBook(quote)],"game").status).toBe("invalid_snapshot");
    }
  });
  test("no captured comparable state stays unknown", () => {
    expect(auditSnapshot(snapshot(),[],"game").status).toBe("not_comparable");
  });
  test("checks the latest version of a same-hash batch, not its superseded fragments",()=>{
    const fragment=auditBook({...quote,bids:[{price:"0.50",size:"11"}]});
    const completed=auditBook({...quote,receivedAtMs:1001});
    expect(auditSnapshot(snapshot(),[fragment,completed],"game").status).toBe("match");
    expect(auditSnapshot(snapshot(),[completed,{...fragment,observedAtMs:1002}],"game").status).toBe("mismatch");
  });
});
