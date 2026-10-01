"""Causal late-game score/time model with chronological holdout."""
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

def feature(st,final_period,period_seconds):
 per=int(st.get('period') or 0); sec=cs(st.get('clock'))
 try: margin=float(st['homeScore'])-float(st['awayScore'])
 except Exception: return None
 if not per or sec is None: return None
 if per<=final_period: t=max(0,(final_period-per)*period_seconds+sec); ot=0
 else: t=max(0,sec); ot=per-final_period
 if t>900: return None
 minutes=(t+1)/60
 root=1/math.sqrt(minutes)
 # Deliberately redundant: early margin, late-game margin scaled by time,
 # and the time scale itself. Ridge decides how much of each survives.
 return [margin/10, margin*root/10, margin/minutes/10, root, float(ot)]

def design(states,final_period,period_seconds):
 return [x for st in states if (x:=feature(st,final_period,period_seconds)) is not None]

def fit(X,y,sw,l2):
 X=np.asarray(X,float); y=np.asarray(y,float); sw=np.asarray(sw,float)
 mean=X.mean(0); scale=X.std(0); scale[scale<1e-9]=1
 Z=(X-mean)/scale
 beta=np.zeros(Z.shape[1]+1)
 for _ in range(60):
  eta=np.clip(beta[0]+Z@beta[1:],-35,35); mu=1/(1+np.exp(-eta)); var=np.maximum(mu*(1-mu),1e-9)
  w=var*sw; z=eta+(y-mu)/var
  Z1=np.column_stack([np.ones(len(Z)),Z])
  H=Z1.T@(w[:,None]*Z1); H[1:,1:]+=np.eye(Z.shape[1])*l2
  delta=np.linalg.solve(H,Z1.T@(w*(z-eta))-np.r_[0,l2*beta[1:]])
  beta+=delta
  if np.max(np.abs(delta))<1e-10: break
 return beta,mean,scale

def predict(model,X):
 beta,mean,scale=model; X=np.asarray(X,float); Z=(X-mean)/scale; eta=np.clip(beta[0]+Z@beta[1:],-35,35); return 1/(1+np.exp(-eta))

def load_games(path):
 S=json.load(gzip.open(path,'rt')); out=[]
 for slug,sr in S.items():
  if not sr or not sr.get('states'): continue
  h=(sr.get('teams') or {}).get('home') or {}; a=(sr.get('teams') or {}).get('away') or {}
  if h.get('winner') is None: continue
  out.append({'slug':slug,'start':sr['states'][0]['t'],'states':sr['states'],'won':bool(h['winner'])})
 return sorted(out,key=lambda g:g['start'])

def train(games,fp,ps):
 X=[]; y=[]; w=[]
 for g in games:
  rows=design(g['states'],fp,ps)
  if not rows: continue
  X += rows; y += [int(g['won'])]*len(rows); w += [1/len(rows)]*len(rows)
 return np.asarray(X),np.asarray(y),np.asarray(w)

def brier(y,p): return float(np.mean((np.asarray(y)-p)**2))
def logloss(y,p):
 y=np.asarray(y); p=np.clip(p,1e-9,1-1e-9); return float(np.mean(-y*np.log(p)-(1-y)*np.log(1-p)))

def signal(e,sr,model,cutoff,edge,delay,fairmin,fp,ps,pricing):
 m=next((x for x in e['markets'] if x['marketType']=='moneyline' and len(x.get('outcomes',[]))==2),None)
 if not m: return None
 home=(sr.get('teams',{}).get('home') or {}).get('name'); away=(sr.get('teams',{}).get('away') or {}).get('name')
 if not home or not away: return None
 hi=0 if match(home,m['outcomes'][0]['name']) else 1 if match(home,m['outcomes'][1]['name']) else None
 if hi is None: return None
 pay=[o.get('payout') for o in m['outcomes']]
 if None in pay or sorted(pay)!=[0,1]: return None
 toks=[o['tokenId'] for o in m['outcomes']]; tr=sorted(m['trades'],key=lambda x:x['timestampMs'])
 if not tr: return None
 tms=[x['timestampMs'] for x in tr]; imp=[]
 for x in tr:
  i=toks.index(x['tokenId']); p=float(x['price']); imp.append((p,1-p) if i==0 else (1-p,p))
 for st in sr['states']:
  per=st.get('period'); sec=cs(st.get('clock'))
  if not per or per<fp or (per==fp and (sec is None or sec>cutoff)): continue
  f=feature(st,fp,ps)
  if f is None or (per==fp and (ps*(fp-per)+sec)>cutoff): continue
  ph=float(predict(model,[f])[0]); fair=[ph,1-ph] if hi==0 else [1-ph,ph]
  t=st['t']; j=bisect.bisect_right(tms,t)-1
  if j<0 or t-tms[j]>90000: continue
  choices=[i for i in (0,1) if fair[i]>=fairmin and fair[i]-imp[j][i]>=edge]
  if not choices: continue
  i=max(choices,key=lambda x:fair[x]-imp[j][x]); limit=min(.99,fair[i]-.01); start=t+delay*1000
  prices=[]
  for k in range(bisect.bisect_left(tms,start),len(tr)):
   z=tr[k]
   if z['timestampMs']>start+60_000: break
   if z['tokenId']==toks[i] and z['side']=='BUY' and float(z['price'])<=limit+1e-9: prices.append(float(z['price']))
  if not prices: return None
  entry=min(prices) if pricing=='first' else max(prices) if pricing=='worst' else sum(prices)/len(prices)
  return {'game':e['eventSlug'],'startMs':e['startMs'],'fair':fair[i],'market':imp[j][i],'edge':fair[i]-imp[j][i],
          'entry':entry,'won':pay[i]==1,'ret':((1 if pay[i]==1 else 0)-entry-FEE*entry*(1-entry))/entry}

def ci(v): return 1.96*(statistics.stdev(v) if len(v)>1 else 0)/math.sqrt(len(v))

def main(league,paths,fp,ps):
 games=load_games(f'/tmp/espn_states_{league}.json.gz'); split=int(len(games)*.7); train_g,test_g=games[:split],games[split:]
 best=None
 for l2 in (1,5,20,100,500):
  X,y,w=train(train_g,fp,ps); model=fit(X,y,w,l2)
  ys=[]; pss=[]
  for g in test_g:
   rows=design(g['states'],fp,ps)
   if rows: pss.extend(predict(model,rows)); ys.extend([int(g['won'])]*len(rows))
  score=(brier(ys,pss),l2,model,ys,pss)
  if best is None or score[:2]<best[:2]: best=score
 _,l2,model,ys,pss=best
 print('MODEL',league,'train/test',len(train_g),len(test_g),'l2',l2,'brier',round(brier(ys,pss),4),'logloss',round(logloss(ys,pss),4))
 for th in (.5,.7,.8,.9,.95,.98):
  ix=[i for i,p in enumerate(pss) if p>=th]
  if ix: print(' CAL',th,'n',len(ix),'pred',round(sum(pss[i] for i in ix)/len(ix),4),'actual',round(sum(ys[i] for i in ix)/len(ix),4))
 allsr=json.load(gzip.open(f'/tmp/espn_states_{league}.json.gz','rt')); testslugs={g['slug'] for g in test_g}; data=[]
 for path in paths.split(','): data.extend(json.load(open(path))['events'])
 rows=defaultdict(list)
 for e in data:
  if e['eventSlug'] not in testslugs: continue
  sr=allsr.get(e['eventSlug'])
  if not sr: continue
  for cutoff in (300,180,120):
   for edge in (.03,.05,.08,.10):
    for delay in (15,30,60):
     for fairmin in (.8,.9):
      for pricing in ('first','worst'):
       r=signal(e,sr,model,cutoff,edge,delay,fairmin,fp,ps,pricing)
       if r: rows[(cutoff,edge,delay,fairmin,pricing)].append(r)
 ranked=[]
 for key,rs in rows.items():
  vals=[r['ret'] for r in rs]; ranked.append((sum(vals)/len(vals)-ci(vals),key,rs,sum(vals)/len(vals),ci(vals)))
 for _,key,rs,m,c in sorted(ranked,reverse=True)[:30]:
  print('POL',key,'n',len(rs),'won',sum(r['won'] for r in rs),'fair',round(sum(r['fair'] for r in rs)/len(rs),3),'mkt',round(sum(r['market'] for r in rs)/len(rs),3),'ret',round(m,4),'ci',round(c,4))
 print('TARGET')
 for key,rs in sorted(rows.items()):
  cutoff,edge,delay,fairmin,pricing=key
  if cutoff!=180 or delay!=30: continue
  vals=[r['ret'] for r in rs]; m=sum(vals)/len(vals) if vals else 0; c=ci(vals) if vals else 0
  rs2=sorted(rs,key=lambda r:r['startMs']); med=rs2[len(rs2)//2]['startMs']
  a=[r['ret'] for r in rs2 if r['startMs']<=med]; b=[r['ret'] for r in rs2 if r['startMs']>med]
  print(' T',key,'n',len(rs),'won',sum(r['won'] for r in rs),'ret',round(m,4),'ci',round(c,4),'h1',round(sum(a)/len(a),4) if a else None,'h2',round(sum(b)/len(b),4) if b else None)

if __name__=='__main__': main(sys.argv[1],sys.argv[2],int(sys.argv[3]),int(sys.argv[4]))
