import type { ReplayQuoteRow } from "./replay-types.js";
import type { EffectiveTailOptions } from "./tail-catalog.js";
import type { TailAuditBook, TailBookStatus, TailMarket, TailObservation, TailSecond, TailWindow } from "./tail-types.js";

export interface TailCurrentBook { quote:ReplayQuoteRow; snapshotSequence:number; snapshotFrameIndex:number; valid:boolean; quarantine:boolean; provisional?:boolean; auditUncertainty?:TailAuditBook }
export interface TailLiveState {
  books:Map<string,TailCurrentBook>; markets:Map<string,TailMarket>; feeds:Map<string,number>; connections:Map<string,boolean>;
  contexts:Map<string,{ws?:TailObservation;gamma?:TailObservation}>;
  firstMs:number;lastMs:number;
}
interface Stats { startValid:boolean; startClosed:boolean; bad:boolean; updates:number; trades:number; shares:number; stateChanges:number;
  minBid:number|null;maxBid:number|null;minAsk:number|null;maxAsk:number|null }
function top(book:TailCurrentBook|undefined){return {bid:book?.quote.bids[0]?.price??null,ask:book?.quote.asks[0]?.price??null};}
function good(status:TailBookStatus):boolean{return status==="observed"||status==="carried";}
export class TailBuckets {
  private index=0;
  private started=false;
  private readonly stats=new Map<string,Stats>();
  constructor(readonly window:TailWindow,private readonly live:TailLiveState,private readonly options:EffectiveTailOptions){}
  contains(ms:number):boolean{return this.window.startAtMs!==null&&this.window.endAtMs!==null&&ms>=this.window.startAtMs&&ms<this.window.endAtMs;}
  private status(token:string,at:number):TailBookStatus{
    if(at<this.live.firstMs||at>this.live.lastMs)return "outside_run";
    const market=this.live.markets.get(token);
    if(!market)return "not_yet_known";
    if(market.closed)return "closed";
    const current=this.live.books.get(token);
    if(!current)return "missing";
    if(!current.valid||current.quarantine||current.auditUncertainty||this.live.connections.get(current.quote.connectionId)===false)return "invalid";
    const last=this.live.feeds.get(current.quote.connectionId);
    if(last===undefined||at-last>this.options.maxFeedSilenceMs)return "feed_stale";
    return "carried";
  }
  private seed():void{
    const at=this.window.startAtMs!+this.index*1000;
    this.stats.clear();
    for(const market of this.window.markets){
      const status=this.status(market.tokenId,at),prices=good(status)?top(this.live.books.get(market.tokenId)):{bid:null,ask:null};
      this.stats.set(market.tokenId,{startValid:good(status),startClosed:status==="closed",bad:false,updates:0,trades:0,shares:0,stateChanges:0,
        minBid:prices.bid===null?null:Number(prices.bid),maxBid:prices.bid===null?null:Number(prices.bid),minAsk:prices.ask===null?null:Number(prices.ask),maxAsk:prices.ask===null?null:Number(prices.ask)});
    }
  }
  async advance(toMs:number,emit:(row:TailSecond)=>void|Promise<void>):Promise<void>{
    if(this.window.startAtMs===null||this.window.endAtMs===null||toMs<this.window.startAtMs)return;
    if(!this.started){this.started=true;this.seed();}
    while(this.index<this.options.windowSeconds&&this.window.startAtMs+(this.index+1)*1000<=toMs){
      for(const market of this.window.markets)await emit(this.row(market));
      this.index++;if(this.index<this.options.windowSeconds)this.seed();
    }
  }
  beforeFeed(connectionId:string,at:number):void{
    if(!this.contains(at)||at<=this.window.startAtMs!+this.index*1000)return;
    const previous=this.live.feeds.get(connectionId);
    if(previous!==undefined&&at-previous>this.options.maxFeedSilenceMs){
      for(const [token,stats] of this.stats)if(this.live.books.get(token)?.quote.connectionId===connectionId)stats.bad=true;
    }
  }
  invalidate(token:string,at:number):void{if(this.contains(at)){const stats=this.stats.get(token);if(stats)stats.bad=true;}}
  book(quote:ReplayQuoteRow):void{
    if(!this.contains(quote.receivedAtMs))return;
    const stats=this.stats.get(quote.tokenId);if(!stats)return;
    stats.updates++;
    const bid=quote.bids[0]?.price,ask=quote.asks[0]?.price;
    if(bid!==undefined){stats.minBid=Math.min(stats.minBid??Infinity,Number(bid));stats.maxBid=Math.max(stats.maxBid??-Infinity,Number(bid));}
    if(ask!==undefined){stats.minAsk=Math.min(stats.minAsk??Infinity,Number(ask));stats.maxAsk=Math.max(stats.maxAsk??-Infinity,Number(ask));}
  }
  trade(token:string,at:number,size:number):void{if(this.contains(at)){const s=this.stats.get(token);if(s){s.trades++;s.shares+=size;}}}
  stateChange(at:number):void{if(this.contains(at))for(const s of this.stats.values())s.stateChanges++;}
  private context(at:number):{observation:TailObservation|undefined;status:TailSecond["contextStatus"]}{
    const context=this.live.contexts.get(this.window.key);
    const meaningful=(o:TailObservation|undefined):boolean=>!!o&&[o.score,o.period,o.clock].some(value=>value!==null&&value!==undefined&&value!=="");
    const ws=meaningful(context?.ws)?context?.ws:undefined;
    const candidate=meaningful(context?.gamma)?context?.gamma:undefined;
    // A fresh HTTP receipt can contain an old cached score. Only a source
    // clock at least as new as Sports may replace that known Sports state.
    const gamma=candidate&&(!ws||(candidate.sourceAtMs!==null&&ws.sourceAtMs!==null&&candidate.sourceAtMs>=ws.sourceAtMs))?candidate:undefined;
    const wsConnected=ws?.connectionId===null||this.live.connections.get(ws?.connectionId??"")!==false;
    if(ws&&wsConnected&&at-ws.observedAtMs<=this.options.sportsStaleAfterMs)return {observation:ws,status:"present"};
    if(gamma&&at-gamma.observedAtMs<=this.options.sportsStaleAfterMs)return {observation:gamma,status:"present"};
    const observation=ws&&(!gamma||ws.observedAtMs>=gamma.observedAtMs)?ws:gamma;
    return {observation,status:!observation?"missing":observation===ws&&!wsConnected?"disconnected":"stale"};
  }
  private row(market:TailMarket):TailSecond{
    const start=this.window.startAtMs!+this.index*1000,end=start+1000,stats=this.stats.get(market.tokenId)!;
    const current=this.live.books.get(market.tokenId),base=this.status(market.tokenId,end-.001);
    let status:TailBookStatus=base;
    const whole=good(base)&&stats.startValid&&!stats.bad;
    if(good(base))status=whole?(stats.updates?"observed":"carried"):"partial";
    else if(base==="closed"&&!stats.startClosed)status="partial";
    if(start<this.live.firstMs||end>this.live.lastMs)status="outside_run";
    const usable=good(base),prices=usable?top(current):{bid:null,ask:null};
    const context=this.context(end-.001),observation=context.observation;
    const source=current?.quote.serverTimestamp;
    const sourceAt=source!==undefined&&/^\d+$/.test(source)&&Number.isSafeInteger(Number(source))?Number(source):null;
    const reasons:string[]=[];
    if(this.window.finishConflict)reasons.push("conflicting-finish-labels");
    if(!whole&&status!=="closed")reasons.push(status);
    if(stats.bad)reasons.push("within-second-invalidation");
    if(current?.auditUncertainty&&status!=="closed")reasons.push("pending-snapshot-audit");
    if(context.status!=="present")reasons.push(`context-${context.status}`);
    if(usable&&sourceAt===null)reasons.push("missing-book-source-time");
    if(usable&&sourceAt!==null&&(sourceAt>end+this.options.maxClockDriftMs||(end>1e11&&sourceAt<1e11)))reasons.push("book-source-clock-invalid");
    return {windowKey:this.window.key,eventSlug:market.eventSlug,gameId:market.gameId,marketId:market.marketId,conditionId:market.conditionId,
      question:market.question,marketType:market.marketType,tokenId:market.tokenId,outcome:market.outcome,secondIndex:this.index,startAtMs:start,endAtMs:end,
      secondsBeforeFinish:this.options.windowSeconds-this.index,status,wholeSecondValid:whole&&status!=="outside_run",connectionId:current?.quote.connectionId??null,
      bids:usable?current!.quote.bids:null,asks:usable?current!.quote.asks:null,bookObservedAtMs:current?.quote.receivedAtMs??null,
      bookSourceAtMs:sourceAt,bookAgeMs:current?end-current.quote.receivedAtMs:null,
      feedAgeMs:current&&this.live.feeds.has(current.quote.connectionId)?end-this.live.feeds.get(current.quote.connectionId)!:null,
      bookHash:current?.quote.bookHash??null,bestBid:prices.bid,bestAsk:prices.ask,minBestBid:stats.minBid,maxBestBid:stats.maxBid,minBestAsk:stats.minAsk,maxBestAsk:stats.maxAsk,
      bookUpdates:stats.updates,tradeCount:stats.trades,tradeShares:stats.shares,contextSource:observation?.source??null,
      contextObservedAtMs:observation?.observedAtMs??null,contextSourceAtMs:observation?.sourceAtMs??null,contextAgeMs:observation?end-observation.observedAtMs:null,
      contextStatus:context.status,score:observation?.score??null,period:observation?.period??null,clock:observation?.clock??null,stateChangeCount:stats.stateChanges,reasons};
  }
}
