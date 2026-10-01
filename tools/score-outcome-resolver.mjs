// Market outcome resolver: derive token payouts from the final sports score.
export function norm(s){return String(s??'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'');}
export function parseTennis(score){
  const sets=[]; for(const part of String(score).split(',')){
    const m=part.trim().match(/^(\d+)-(\d+)/); if(!m) continue;
    sets.push([Number(m[1]),Number(m[2])]);
  }
  if(!sets.length) return null;
  let h=0,a=0,hg=0,ag=0; for(const [x,y] of sets){hg+=x;ag+=y; if(x>y)h++;else if(y>x)a++;}
  return {sets,homeSets:h,awaySets:a,homeGames:hg,awayGames:ag};
}
export function parseScore(score){ // generic "2-1" / "110-105"
  const m=String(score).trim().match(/^(\d+)\s*[-:]\s*(\d+)/); return m?[Number(m[1]),Number(m[2])]:null;
}
function isTennis(state){return /tennis|itf|wta|atp|challenger/i.test(state.league||'')||/^[0-9,\s()\-]+$/.test(String(state.score||''));}
function sideOf(name,state){ // which side is this outcome name on
  const n=norm(name), h=norm(state.home), a=norm(state.away);
  if(!n) return null;
  if(n===h) return 'home'; if(n===a) return 'away';
  if(h.includes(n)||n.includes(h)) return 'home';
  if(a.includes(n)||n.includes(a)) return 'away';
  return null;
}
// returns [payoutToken0, payoutToken1] or null when the market cannot be derived from the score
export function resolveMarket(market,state){
  const type=market.sportsMarketType||''; const q=String(market.question||'');
  let outcomes=market.outcomes; if(typeof outcomes==='string'){try{outcomes=JSON.parse(outcomes);}catch{outcomes=[];}}
  outcomes=outcomes||[];
  const tennis=isTennis(state);
  const t=tennis?parseTennis(state.score):null;
  const g=tennis?null:parseScore(state.score);
  const numLine=m=>{const m2=q.match(/(-?\d+(?:\.\d+)?)\s*$/); return m2?Number(m2[1]):null;};
  const overUnder=(total)=>{const line=numLine(); if(line===null||total===null) return null; const over=total>line;
    return outcomes.map(o=>/under/i.test(String(o))?(over?0:1):/over/i.test(String(o))?(over?1:0):0);};
  switch(true){
    case type==='moneyline':{
      const winner=tennis?(t.homeSets>t.awaySets?'home':'away'):(g?(g[0]>g[1]?'home':'away'):null);
      if(!winner) return null;
      return outcomes.map(o=>sideOf(o,state)===winner?1:0);
    }
    case type==='tennis_completed_match': return outcomes.map(o=>/yes/i.test(String(o))?1:0);
    case /^tennis_(first_set|set)_winner$/.test(type):{
      if(!t) return null; const n=type.includes('first')?0:Number((q.match(/Set\s*(\d+)/i)||[])[1]??NaN)-1;
      const set=t.sets[n]; if(!set) return null; const winner=set[0]>set[1]?'home':'away';
      return outcomes.map(o=>sideOf(o,state)===winner?1:0);
    }
    case type==='tennis_match_totals': return t?overUnder(t.homeGames+t.awayGames):null;
    case type==='tennis_first_set_totals': return t&&t.sets[0]?overUnder(t.sets[0][0]+t.sets[0][1]):null;
    case type==='tennis_set_games_totals':{
      if(!t) return null; const n=Number((q.match(/Set\s*(\d+)/i)||[])[1]??NaN)-1; const set=t.sets[n]; return set?overUnder(set[0]+set[1]):null;
    }
    case type==='tennis_set_totals': return t?overUnder(t.sets.length):null;
    case type==='tennis_set_handicap':{
      if(!t) return null; const line=numLine(); const favoured=sideOf((q.match(/Handicap:\s*(.+?)\s*\(/)||[])[1],state);
      if(line===null||!favoured) return null;
      const margin=favoured==='home'?t.homeSets-t.awaySets:t.awaySets-t.homeSets;
      const covers=margin+line>0; // line is negative for the favoured side
      return outcomes.map(o=>{const s=sideOf(o,state); return (s===favoured)===covers?1:0;});
    }
    case type==='tennis_game_handicap':{
      if(!t) return null; const line=numLine(); const favoured=sideOf((q.match(/Spread:\s*(.+?)\s*\(/)||[])[1],state);
      if(line===null||!favoured) return null;
      const margin=favoured==='home'?t.homeGames-t.awayGames:t.awayGames-t.homeGames;
      const covers=margin+line>0;
      return outcomes.map(o=>{const s=sideOf(o,state); return (s===favoured)===covers?1:0;});
    }
    case type==='totals': return g?overUnder(g[0]+g[1]):null;
    case type==='spreads':{
      if(!g) return null; const line=numLine(); const favoured=sideOf((q.match(/Spread:\s*(.+?)\s*\(/)||[])[1],state);
      if(line===null||!favoured) return null;
      const margin=favoured==='home'?g[0]-g[1]:g[1]-g[0]; const covers=margin+line>0;
      return outcomes.map(o=>{const s=sideOf(o,state); return s===null?0:((s===favoured)===covers?1:0);});
    }
    case type==='both_teams_to_score':{
      if(!g) return null; const yes=g[0]>0&&g[1]>0;
      return outcomes.map(o=>/yes/i.test(String(o))?(yes?1:0):/no/i.test(String(o))?(yes?0:1):0);
    }
    case type==='soccer_exact_score':{
      if(!g) return null; const scoreText=`${g[0]}-${g[1]}`;
      return outcomes.map(o=>norm(o)===norm(scoreText)?1:0);
    }
    default: return null;
  }
}
