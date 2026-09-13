import { JournalReplay } from "./replay.js";
import { objectValue, parsedJson } from "./replay-values.js";
import { scanJournal } from "./journal-reader.js";
import { metadataFromRecord, observationsFromRecord, changesBetween, windowKeyForIdentity } from "./tail-context.js";
import { journalStamp, scanTailCatalog, tailOptions } from "./tail-catalog.js";
import { TailBuckets, type TailLiveState } from "./tail-buckets.js";
import { auditBook, auditSnapshot, sourceMilliseconds } from "./tail-audit.js";
import type { JournalRecord } from "./types.js";
import type { ReplayInvalidation } from "./replay-types.js";
import type { TailAuditBook, TailBookChange, TailObservation, TailOptions, TailSecond, TailSink, TailSnapshotAudit, TailSummary, TailTokenQuality, TailWindow } from "./tail-types.js";

function freshQuality(window:TailWindow,tokenId:string,seconds:number):TailTokenQuality{
  const market=window.markets.find(m=>m.tokenId===tokenId)!;
  return {windowKey:window.key,tokenId,marketId:market.marketId,outcome:market.outcome,marketType:market.marketType,
    expectedSeconds:seconds,validSeconds:0,closedSeconds:0,partialSeconds:0,missingSeconds:0,staleSeconds:0,contextSeconds:0,
    snapshotMatches:0,snapshotMismatches:0,snapshotNotComparable:0,seedSnapshotMatches:0,seedSnapshotMismatches:0,seedSnapshotNotComparable:0,
    observedWindowComplete:false,snapshotAuditPassed:false,readyForReplay:false,reasons:[]};
}
function frameFor(record:JournalRecord,index:number,tokenId?:string):unknown{
  const parsed=parsedJson(record.data),frame=objectValue(Array.isArray(parsed)?parsed[index]:parsed);
  if(!frame)return record.data;
  if(tokenId&&Array.isArray(frame.price_changes))return {...frame,price_changes:frame.price_changes.filter(c=>objectValue(c)?.asset_id===tokenId)};
  return frame;
}
function sameAuditBatch(a:TailAuditBook,b:TailAuditBook):boolean{
  return a.hash!==null&&a.hash===b.hash&&a.sourceAtMs===b.sourceAtMs;
}

export async function replayTail(input: TailOptions, sink: TailSink): Promise<TailSummary> {
  const options=tailOptions(input),catalog=await scanTailCatalog(options);
  const live:TailLiveState={books:new Map(),markets:new Map(),feeds:new Map(),connections:new Map(),contexts:new Map(),firstMs:catalog.firstMs,lastMs:catalog.lastMs};
  const buckets=catalog.windows.map(window=>new TailBuckets(window,live,options));
  const selectedWindowKeys=new Set(catalog.windows.map(window=>window.key));
  const tokenWindows=new Map<string,TailBuckets[]>();
  const qualities=new Map<string,TailTokenQuality>();
  for(const bucket of buckets)for(const market of bucket.window.markets){
    const list=tokenWindows.get(market.tokenId)??[];list.push(bucket);tokenWindows.set(market.tokenId,list);
    qualities.set(bucket.window.key+":"+market.tokenId,freshQuality(bucket.window,market.tokenId,options.windowSeconds));
  }
  const versions=new Map<string,TailAuditBook[]>();
  // At most one HTTP response per token waits for a provisional source batch.
  const pendingAudits=new Map<string,JournalRecord>();
  const previousObservations=new Map<string,TailObservation>();
  const sourceWatermarks=new Map<string,number>();
  const resolvedTokens=new Set<string>();
  const contextWarnings=new Set<string>();
  const pendingInvalidations:TailBookChange[]=[];
  let current:JournalRecord|undefined;
  let sequenceGapPrechecked=false;
  let seconds=0,changes=0,stateChangeCount=0,audits=0,records=0,rawRecords=0;
  const invalidateTail=(event:ReplayInvalidation,uncertainFromMs=current?.receivedAtMs):void=>{
    if(!current)return;
    if(event.connectionId===undefined&&event.tokenId===undefined){
      live.contexts.clear();previousObservations.clear();
    }
    const tokens=event.tokenId?[event.tokenId]:[...live.books].filter(([,book])=>event.connectionId===undefined||book.quote.connectionId===event.connectionId).map(([token])=>token);
    for(const tokenId of tokens){
      const book=live.books.get(tokenId);
      if(book&&(event.connectionId===undefined||book.quote.connectionId===event.connectionId)){book.valid=false;book.provisional=event.provisional===true;}
      if(event.reason==="market_resolved"){
        resolvedTokens.add(tokenId);
        const market=live.markets.get(tokenId);if(market)live.markets.set(tokenId,{...market,closed:true,acceptingOrders:false});
      }
      for(const bucket of tokenWindows.get(tokenId)??[]){
        // A source batch that fully reconciles before the bucket boundary is
        // not a missing message interval. An unresolved/persistent batch is.
        if(!event.provisional)bucket.invalidate(tokenId,uncertainFromMs!);
        if(bucket.contains(current.receivedAtMs)||bucket.contains(uncertainFromMs!))pendingInvalidations.push({windowKey:bucket.window.key,tokenId,sequence:current.sequence,
          frameIndex:-1,observedAtMs:current.receivedAtMs,sourceAtMs:null,kind:"invalidation",data:{reason:event.reason,provisional:event.provisional??false,connectionId:event.connectionId??null,uncertainFromMs}});
      }
    }
  };
  const replay=new JournalReplay({sportsStaleAfterMs:options.sportsStaleAfterMs,onInvalidation:event=>{
    if(event.reason!=="sequence_gap"||!sequenceGapPrechecked)invalidateTail(event);
  }});
  const emitSecond=async(row:TailSecond):Promise<void>=>{
    seconds++;
    const q=qualities.get(row.windowKey+":"+row.tokenId)!;
    if(row.wholeSecondValid)q.validSeconds++;
    else if(row.status==="closed")q.closedSeconds++;
    else if(row.status==="partial")q.partialSeconds++;
    else if(row.status==="feed_stale")q.staleSeconds++;
    else q.missingSeconds++;
    if(row.contextStatus==="present")q.contextSeconds++;
    for(const reason of row.reasons)if(!q.reasons.includes(reason))q.reasons.push(reason);
    await sink.second(row);
  };
  const emitInvalidations=async():Promise<void>=>{
    for(const row of pendingInvalidations.splice(0)){await sink.change(row);changes++;}
  };
  const emitAudit=async(record:JournalRecord,books:readonly TailAuditBook[],checkedAtMs=record.receivedAtMs,notComparableReason?:string):Promise<void>=>{
    const tokenId=objectValue(record.data)?.tokenId;if(typeof tokenId!=="string")return;
    for(const bucket of tokenWindows.get(tokenId)??[])if(bucket.window.endAtMs!==null&&record.receivedAtMs<bucket.window.endAtMs){
      const scope=bucket.contains(record.receivedAtMs)?"window":"seed";
      const audit:TailSnapshotAudit={...auditSnapshot(record,books,bucket.window.key,checkedAtMs),scope};
      if(audit.status==="not_comparable"&&notComparableReason)audit.reason=notComparableReason;
      const q=qualities.get(bucket.window.key+":"+tokenId)!;
      if(scope==="window"&&notComparableReason==="source-batch-not-finalized"&&!q.reasons.includes("unresolved-snapshot-audit"))q.reasons.push("unresolved-snapshot-audit");
      if(audit.status==="match"){
        q[scope==="seed"?"seedSnapshotMatches":"snapshotMatches"]++;
        const book=live.books.get(tokenId);
        if(book?.auditUncertainty&&!book.quarantine&&audit.websocketSequence===book.quote.sequence&&
          audit.websocketFrameIndex===(book.quote.frameIndex??0)&&sameAuditBatch(book.auditUncertainty,auditBook(book.quote)))delete book.auditUncertainty;
      }
      else if(audit.status==="mismatch"||audit.status==="invalid_snapshot"){
        q[scope==="seed"?"seedSnapshotMismatches":"snapshotMismatches"]++;
        if(!notComparableReason){
          const book=live.books.get(tokenId);
          // A historical mismatch says nothing about a newer independent WS
          // snapshot. Only descendants of the audited state are quarantined.
          if(book&&(audit.status==="invalid_snapshot"||(audit.websocketSequence!==undefined&&
            (audit.websocketSequence>book.snapshotSequence||(audit.websocketSequence===book.snapshotSequence&&(audit.websocketFrameIndex??0)>=book.snapshotFrameIndex))))){
            book.quarantine=true;bucket.invalidate(tokenId,record.receivedAtMs);
          }
        }
      }else q[scope==="seed"?"seedSnapshotNotComparable":"snapshotNotComparable"]++;
      await sink.audit(audit);audits++;
    }
  };
  const auditWaitsForBatch=(record:JournalRecord,books:readonly TailAuditBook[],checkedAtMs:number):boolean=>{
    const tokenId=objectValue(record.data)?.tokenId;if(typeof tokenId!=="string")return false;
    const book=live.books.get(tokenId),audit=auditSnapshot(record,books,"",checkedAtMs);
    // Matching tops only reconcile the visible book. A same-hash source batch
    // can still have later lower-depth fragments, even without a provisional
    // cross. Delay disagreement until depth matches or that batch has ended.
    const waiting=audit.status==="mismatch"&&book?.quote.updateKind==="delta"&&audit.websocketSequence===book.quote.sequence&&audit.websocketFrameIndex===(book.quote.frameIndex??0);
    // Keep uncertainty with the book, independently of the bounded HTTP queue.
    // Replacing a response cannot erase it; bucket boundaries must see it too.
    if(waiting&&book)book.auditUncertainty??=auditBook(book.quote);
    return waiting;
  };
  await scanJournal(options.runDirectory,async record=>{
    const previousRecord=current;
    current=record;records++;
    sequenceGapPrechecked=record.sequence!==(previousRecord?.sequence??0)+1;
    // A missing journal record may belong anywhere after the last receipt.
    // Mark that uncertainty before emitting the seconds preceding detection.
    if(sequenceGapPrechecked)invalidateTail({reason:"sequence_gap"},previousRecord?.receivedAtMs??record.receivedAtMs);
    for(const bucket of buckets)await bucket.advance(record.receivedAtMs,emitSecond);
    const activeWindows=buckets.filter(b=>b.contains(record.receivedAtMs)).map(b=>b.window.key);
    if(activeWindows.length){await sink.rawRecord?.(record,activeWindows);rawRecords++;}
    if(record.connectionId){
      if(record.kind==="connection_open")live.connections.set(record.connectionId,true);
      if(["connection_close","connection_gap","connection_timeout","heartbeat_timeout"].includes(record.kind))live.connections.set(record.connectionId,false);
      if(record.kind==="ws_message"){
        for(const bucket of buckets)bucket.beforeFeed(record.connectionId,record.receivedAtMs);
        live.feeds.set(record.connectionId,record.receivedAtMs);
      }
    }
    const metadata=metadataFromRecord(record);
    if(metadata)for(const market of metadata.markets)if(tokenWindows.has(market.tokenId))live.markets.set(market.tokenId,
      resolvedTokens.has(market.tokenId)||metadata.raw.closed===true||metadata.raw.archived===true?{...market,closed:true}:market);
    for(const observation of observationsFromRecord(record)){
      const key=windowKeyForIdentity(observation,catalog.windowIdentities);if(!key||!selectedWindowKeys.has(key))continue;
      const sourceKey=key+":"+observation.source;
      const previous=previousObservations.get(sourceKey);
      const watermark=sourceWatermarks.get(sourceKey);
      if(watermark!==undefined&&observation.sourceAtMs!==null&&observation.sourceAtMs<watermark){
        contextWarnings.add(`out-of-order-state-ignored:${sourceKey}`);continue;
      }
      if(observation.sourceAtMs!==null)sourceWatermarks.set(sourceKey,observation.sourceAtMs);
      // The registry has already established the canonical game/window identity.
      // Optional or companion slugs must not split its change baseline, while
      // emitted changes still retain the new observation's original identity.
      const observedChanges=changesBetween(previous?{...previous,eventSlug:observation.eventSlug,gameId:observation.gameId}:undefined,observation);
      previousObservations.set(sourceKey,observation);
      const context=live.contexts.get(key)??{};
      if(observation.source==="sports-ws")context.ws=observation;else context.gamma=observation;
      live.contexts.set(key,context);
      const bucket=buckets.find(b=>b.window.key===key)!;
      for(const change of observedChanges)if(bucket.contains(change.observedAtMs)){
        bucket.stateChange(change.observedAtMs);await sink.stateChange({...change,windowKey:key});stateChangeCount++;
      }
    }
    for(const batch of replay.replay(record)){
      await emitInvalidations();
      for(const quote of batch.quotes){
        const concerned=tokenWindows.get(quote.tokenId);if(!concerned)continue;
        const old=live.books.get(quote.tokenId);
        const comparable=(old?.valid||(old?.provisional&&quote.updateKind==="delta"))&&!old.quarantine&&!old.auditUncertainty&&record.receivedAtMs-(live.feeds.get(old.quote.connectionId)??-Infinity)<=options.maxFeedSilenceMs;
        const bid=quote.bids[0]?.price??null,ask=quote.asks[0]?.price??null;
        const bidMove=comparable&&bid!==null&&old.quote.bids[0]?Number(bid)-Number(old.quote.bids[0].price):null;
        const askMove=comparable&&ask!==null&&old.quote.asks[0]?Number(ask)-Number(old.quote.asks[0].price):null;
        const version=auditBook(quote);
        const leftUnresolvedBatch=quote.updateKind!=="snapshot"&&old?.auditUncertainty!==undefined&&!sameAuditBatch(old.auditUncertainty,version);
        const quarantine=(old?.quarantine===true||leftUnresolvedBatch)&&quote.updateKind!=="snapshot";
        if(leftUnresolvedBatch)for(const bucket of concerned)bucket.invalidate(quote.tokenId,record.receivedAtMs);
        if((old?.provisional||old?.auditUncertainty)&&quote.updateKind==="snapshot")for(const bucket of concerned)bucket.invalidate(quote.tokenId,record.receivedAtMs);
        live.books.set(quote.tokenId,{quote,snapshotSequence:quote.updateKind==="snapshot"?quote.sequence:old?.snapshotSequence??quote.sequence,
          snapshotFrameIndex:quote.updateKind==="snapshot"?quote.frameIndex??0:old?.snapshotFrameIndex??0,
          ...(quote.updateKind!=="snapshot"&&old?.auditUncertainty?{auditUncertainty:old.auditUncertainty}:{}),
          valid:replay.getBookStatus(quote.connectionId,quote.tokenId)==="valid",quarantine});
        const history=versions.get(quote.tokenId)??[];
        history.push(version);
        while(history.length>512||(history[0]&&history[0].observedAtMs<record.receivedAtMs-60_000))history.shift();
        versions.set(quote.tokenId,history);
        const pending=pendingAudits.get(quote.tokenId);
        if(pending){
          if(quote.updateKind==="snapshot"){
            pendingAudits.delete(quote.tokenId);await emitAudit(pending,[],record.receivedAtMs,"source-batch-replaced-by-snapshot");
          }else if(live.books.get(quote.tokenId)!.valid&&!auditWaitsForBatch(pending,history,record.receivedAtMs)){
            pendingAudits.delete(quote.tokenId);
            // This verifies a source state; never backfill earlier WS rows.
            await emitAudit(pending,history,record.receivedAtMs);
          }
        }
        for(const bucket of concerned){
          bucket.book(quote);
          if(bucket.contains(record.receivedAtMs)){
            await sink.change({windowKey:bucket.window.key,tokenId:quote.tokenId,sequence:record.sequence,frameIndex:quote.frameIndex??0,
              observedAtMs:record.receivedAtMs,sourceAtMs:sourceMilliseconds(quote.serverTimestamp),kind:"book",bestBid:bid,bestAsk:ask,bidMove,askMove,
              rapidMove:Math.abs(bidMove??0)>=options.shockThreshold||Math.abs(askMove??0)>=options.shockThreshold,data:frameFor(record,quote.frameIndex??0,quote.tokenId)});changes++;
          }
        }
      }
      for(const trade of batch.trades){
        if(!trade.tokenId)continue;
        for(const bucket of tokenWindows.get(trade.tokenId)??[])if(bucket.contains(record.receivedAtMs)){
          bucket.trade(trade.tokenId,record.receivedAtMs,Number(trade.size??0));
          await sink.change({windowKey:bucket.window.key,tokenId:trade.tokenId,sequence:record.sequence,frameIndex:trade.frameIndex??0,
            observedAtMs:record.receivedAtMs,sourceAtMs:sourceMilliseconds(trade.data.timestamp),kind:"trade",
            ...(trade.price!==undefined?{price:trade.price}:{}),...(trade.size!==undefined?{size:trade.size}:{}),...(trade.side!==undefined?{side:trade.side}:{}),data:trade.data});changes++;
        }
      }
    }
    await emitInvalidations();
    for(const [tokenId,pending] of pendingAudits)if(!live.books.get(tokenId)?.valid&&!live.books.get(tokenId)?.provisional){
      pendingAudits.delete(tokenId);await emitAudit(pending,[],record.receivedAtMs,"provisional-batch-invalidated");
    }
    if(record.source==="clob"&&record.kind==="book_snapshot"){
      const tokenId=objectValue(record.data)?.tokenId;
      if(typeof tokenId==="string"&&(tokenWindows.get(tokenId)??[]).some(bucket=>bucket.window.endAtMs!==null&&record.receivedAtMs<bucket.window.endAtMs)){
        const pending=pendingAudits.get(tokenId);
        if(pending){pendingAudits.delete(tokenId);await emitAudit(pending,[],record.receivedAtMs,"provisional-batch-unresolved");}
        const book=live.books.get(tokenId);
        if(book?.provisional||(book?.valid&&auditWaitsForBatch(record,versions.get(tokenId)??[],record.receivedAtMs)))pendingAudits.set(tokenId,record);
        else await emitAudit(record,book?.valid?versions.get(tokenId)??[]:[],record.receivedAtMs,book?.valid?undefined:"websocket-book-unavailable");
      }
    }
  },replay.quality,()=>{replay.invalidate();},options);
  for(const pending of pendingAudits.values())await emitAudit(pending,[],catalog.lastMs,"source-batch-not-finalized");
  for(const bucket of buckets)if(bucket.window.endAtMs!==null)await bucket.advance(bucket.window.endAtMs,emitSecond);
  if(records!==catalog.records||await journalStamp(options.runDirectory)!==catalog.stamp)throw new Error("TAIL_INPUT_CHANGED");
  if(options.finishLabelsFile&&await readFile(options.finishLabelsFile,"utf8")!==catalog.labelText)throw new Error("TAIL_INPUT_CHANGED: finish labels");
  for(const q of qualities.values()){
    const window=catalog.windows.find(w=>w.key===q.windowKey)!;
    q.observedWindowComplete=window.endAtMs!==null&&!window.finishConflict&&q.validSeconds+q.closedSeconds===q.expectedSeconds;
    q.snapshotAuditPassed=(q.snapshotMatches>0||q.closedSeconds===q.expectedSeconds)&&q.snapshotMismatches===0&&
      !q.reasons.includes("unresolved-snapshot-audit")&&!q.reasons.includes("pending-snapshot-audit");
    if(window.endAtMs===null){q.reasons.push("missing-actual-finish");q.missingSeconds=q.expectedSeconds;}
    if(window.finishConflict)q.reasons.push("conflicting-finish-labels");
    if(!q.snapshotAuditPassed)q.reasons.push("snapshot-audit-not-passed");
    if(q.validSeconds===0)q.reasons.push("no-active-book-seconds");
    q.readyForReplay=q.observedWindowComplete&&q.snapshotAuditPassed&&q.validSeconds>0&&q.contextSeconds===q.expectedSeconds&&
      !q.reasons.includes("book-source-clock-invalid")&&!catalog.warnings.includes("damaged-journal-lines")&&!catalog.warnings.includes("collector-session-failed");
  }
  return {schemaVersion:1,basis:"received-order-book-tail",runId:catalog.runId,firstReceivedAtMs:catalog.firstMs,lastReceivedAtMs:catalog.lastMs,
    windowSeconds:options.windowSeconds,records,seconds,changes,stateChanges:stateChangeCount,audits,rawRecords,windows:catalog.windows,tokens:[...qualities.values()],
    journalQuality:replay.quality,warnings:[...catalog.warnings,...contextWarnings,
      "Rows use half-open one-second receipt-time intervals; source timestamps are separate. No future score is backfilled.",
      "A carried book is the last valid observed state on a live stream, not a fresh snapshot or proof that the upstream exchange omitted no events.",
      "Full depth audits compare matching source states; non-comparable snapshots are not counted as verification.",
      "Same-hash/source-time batch fragments may reconcile within one second; raw-events retains every record, including withheld fragments and global messages in the time window.",
      "Score changes are observations, not confirmed goals or actual event-time/causality proof.",
      "The market universe is the recorded metadata. Missing or late discovery and absent actual finish labels remain data limitations."
    ]};
}
import { readFile } from "node:fs/promises";
