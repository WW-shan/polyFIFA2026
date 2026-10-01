"""Expanding-window score/time model; every evaluated game used only past games."""
import bisect,gzip,json,math,re,statistics,sys
import numpy as np
from collections import defaultdict
FEE=.05

def norm(s): return re.sub(r'[^a-z0-9]','',(s or '').lower())
def match(a,b):
 a,b=norm(a),norm(b); return bool(a and b and (b in a or a in b))
def cs(x):
 try:
  if ':' in x:
   m,s=x.split(':',1); return int(m)*60+float(s)
  return float(x)
 except: return None

def feature(st,fp,ps):
 per=int(st.get('period') or 0); sec=cs(st.get('clock'))
 try: margin=float(st['homeScore'])-float(st['awayScore'])
 except Exception: return None
 if not per or sec is None: return None
 if per<=fp: t=max(0,(fp-per)*ps+sec); ot=0
 else: t=max(0,sec); ot=per-fp
 if t>900: return None
 minutes=(t+1)/60; root=1/math.sqrt(minutes)
 return [margin/10,margin*root/10,margin/minutes/10,root,float(ot)]

def design(states,fp,ps): return [x for st in states if (x:=feature(st,fp,ps)) is not None]

def fit(X,y,sw,l2=1.0):
 X=np.asarray(X,float); y=np.asarray(y,float); sw=np.asarray(sw,float)
 mean=X.mean(0); scale=X.std(0); scale[scale<1e-9]=1; Z=(X-mean)/scale
 b=np.zeros(Z.shape[1]+1)
 for _ in range(60):
  eta=np.clip(b[0]+Z@b[1:],-35,35); mu=1/(1+np.exp(-eta)); var=np.maximum(mu*(1-mu),1e-9); w=var*sw; z=eta+(y-mu)/var
  Z1=np.column_stack([np.ones(len(Z)),Z]); H=Z1.T@(w[:,None]*Z1); H[1:,1:]+=np.eye(Z.shape[1])*l2
  d=np.linalg.solve(H,Z1.T@(w*(z-eta))-np.r_[0,l2*b[1:]])
  b+=d
  if np.max(np.abs(d))<1e-10: break
 return (b,mean,scale)

def predict(m,X):
 b,mean,scale=m; Z=(np.asarray(X,float)-mean)/scale; eta=np.clip(b[0]+Z@b[1:],-35,35); return 1/(1+np.exp(-eta))

def load_games(league):
 S=json.load(gzip.open(league if league.endswith('.json.gz') else f'/tmp/espn_states_{league}.json.gz','rt')); out=[]
 for slug,sr in S.items():
  if not sr or not sr.get('states'): continue
  h=(sr.get('teams') or {}).get('home') or {}; a=(sr.get('teams') or {}).get('away') or {}
  if h.get('winner') is None: continue
  out.append({'slug':slug,'start':sr['states'][0]['t'],'states':sr['states'],'won':bool(h['winner'])})
 return sorted(out,key=lambda g:g['start'])

def fit_row(g,fp,ps):
 rows=design(g['states'],fp,ps)
 if not rows: return None
 return np.asarray(rows),np.asarray([int(g['won'])]*len(rows)),np.asarray([1/len(rows)]*len(rows))

def candidates_for_event(e,sr,model,fp,ps,cutoffs=(300,180,120),edges=(.03,.05,.08,.10),fairmins=(.7,.75,.8,.9)):
 m=next((x for x in e['markets'] if x['marketType']=='moneyline' and len(x.get('outcomes',[]))==2),None)
 if not m: return {}
 home=(sr.get('teams',{}).get('home') or {}).get('name'); away=(sr.get('teams',{}).get('away') or {}).get('name')
 if not home or not away: return {}
 hi=0 if match(home,m['outcomes'][0]['name']) else 1 if match(home,m['outcomes'][1]['name']) else None
 if hi is None: return {}
 pay=[o.get('payout') for o in m['outcomes']]
 if None in pay or sorted(pay)!=[0,1]: return {}
 toks=[o['tokenId'] for o in m['outcomes']]; tr=sorted(m['trades'],key=lambda x:x['timestampMs'])
 if not tr: return {}
 tms=[x['timestampMs'] for x in tr]; imp=[]
 for x in tr:
  i=toks.index(x['tokenId']); p=float(x['price']); imp.append((p,1-p) if i==0 else (1-p,p))
 policies={(c,ed,fm) for c in cutoffs for ed in edges for fm in fairmins}; found={}
 for st in sr['states']:
  if not policies: break
  per=st.get('period'); sec=cs(st.get('clock'))
  if not per or per<fp: continue
  f=feature(st,fp,ps)
  if f is None: continue
  remaining=(ps*(fp-per)+sec) if per==fp else max(0,sec)
  ph=float(predict(model,[f])[0]); fair=[ph,1-ph] if hi==0 else [1-ph,ph]
  t=st['t']; j=bisect.bisect_right(tms,t)-1
  if j<0 or t-tms[j]>90000: continue
  for key in list(policies):
   cutoff,edge,fairmin=key
   if per==fp and (sec is None or sec>cutoff): continue
   if remaining>cutoff: continue
   choices=[i for i in (0,1) if fair[i]>=fairmin and fair[i]-imp[j][i]>=edge]
   if not choices: continue
   i=max(choices,key=lambda x:fair[x]-imp[j][x]); limit=min(.99,fair[i]-.01)
   found[key]={'game':e['eventSlug'],'startMs':e['startMs'],'t':t,'fair':fair[i],'market':imp[j][i],'edge':fair[i]-imp[j][i],
               'won':pay[i]==1,'side':i,'token':toks[i],'limit':limit}
   policies.remove(key)
 return found

def prices_for(c,sr,tr,toks,delay):
 tms=[x['timestampMs'] for x in tr]; start=c['t']+delay*1000; out=[]
 for k in range(bisect.bisect_left(tms,start),len(tr)):
  z=tr[k]
  if z['timestampMs']>start+60000: break
  if z['tokenId']==toks[c['side']] and z['side']=='BUY' and float(z['price'])<=c['limit']+1e-9: out.append(float(z['price']))
 return out

def ci(v): return 1.96*(statistics.stdev(v) if len(v)>1 else 0)/math.sqrt(len(v))

def ret(price,won): return ((1 if won else 0)-price-FEE*price*(1-price))/price

def main(league,paths,fp,ps):
 games=load_games(league); n=len(games); initial=max(100,int(n*.2)); block=max(25,int(n*.05)); models={}
 for start in range(initial,n,block):
  train=games[:start]; X=[];Y=[];W=[]
  for g in train:
   r=fit_row(g,fp,ps)
   if r: X+=list(r[0]);Y+=list(r[1]);W+=list(r[2])
  models[start//block]=fit(np.asarray(X),np.asarray(Y),np.asarray(W),1.0)
 print('WF',league,'games',n,'models',len(models))
 allsr=json.load(gzip.open(f'/tmp/espn_states_{league}.json.gz','rt')); slug_index={g['slug']:i for i,g in enumerate(games)}
 bypol=defaultdict(list); sigcounts=defaultdict(int); fillcounts=defaultdict(int)
 for path in paths.split(','):
  data=json.load(open(path))
  for e in data['events']:
   idx=slug_index.get(e['eventSlug']);
   if idx is None or idx<initial: continue
   model=models.get(idx//block)
   sr=allsr.get(e['eventSlug'])
   if model is None or not sr: continue
   found=candidates_for_event(e,sr,model,fp,ps)
   m=next((x for x in e['markets'] if x['marketType']=='moneyline' and len(x.get('outcomes',[]))==2),None)
   if not m or sorted(o.get('payout') for o in m['outcomes'])!=[0,1]: continue
   tr=sorted(m['trades'],key=lambda x:x['timestampMs']); toks=[o['tokenId'] for o in m['outcomes']]
   for key,c in found.items():
    cutoff,edge,fairmin=key
    for delay in (15,30,60):
     psx=prices_for(c,sr,tr,toks,delay)
     sigcounts[(cutoff,edge,fairmin,delay)] += 1
     if not psx: continue
     fillcounts[(cutoff,edge,fairmin,delay)] += 1
     for pricing in ('first','mean','worst'):
      price=min(psx) if pricing=='first' else max(psx) if pricing=='worst' else sum(psx)/len(psx)
      r=dict(c); r.update({'ret':ret(price,c['won']),'entry':price,'pricing':pricing,'delay':delay})
      bypol[(cutoff,edge,fairmin,delay,pricing)].append(r)
 ranked=[]
 for key,rs in bypol.items():
  vals=[r['ret'] for r in rs]
  ranked.append((sum(vals)/len(vals)-ci(vals),key,rs,sum(vals)/len(vals),ci(vals)))
 print('SIGNALS/FILLS target rules:')
 for key in sorted(sigcounts):
  if key[0]==180 and key[3]==30:
   print(' ',key,'signals',sigcounts[key],'fills',fillcounts.get(key,0))
 print('TOP')
 for _,key,rs,m,c in sorted(ranked,reverse=True)[:25]:
  print(' POL',key,'n',len(rs),'won',sum(r['won'] for r in rs),'fair',round(sum(r['fair'] for r in rs)/len(rs),3),'mkt',round(sum(r['market'] for r in rs)/len(rs),3),'ret',round(m,4),'ci',round(c,4))
 print('TARGET 180/30')
 for key,rs in sorted(bypol.items()):
  if key[0]!=180 or key[3]!=30: continue
  vals=[r['ret'] for r in rs]; m=sum(vals)/len(vals) if vals else 0; c=ci(vals) if vals else 0
  ordered=sorted(rs,key=lambda r:r['startMs']); med=ordered[len(ordered)//2]['startMs']
  a=[r['ret'] for r in ordered if r['startMs']<=med]; b=[r['ret'] for r in ordered if r['startMs']>med]
  print(' T',key,'n',len(rs),'won',sum(r['won'] for r in rs),'ret',round(m,4),'ci',round(c,4),'h1',round(sum(a)/len(a),4) if a else None,'h2',round(sum(b)/len(b),4) if b else None)
 print('WF_END',league)

if __name__=='__main__': main(sys.argv[1],sys.argv[2],int(sys.argv[3]),int(sys.argv[4]))
