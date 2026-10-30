const C = (n,k)=>{if(k<0||k>n)return 0;k=Math.min(k,n-k);let r=1;for(let i=1;i<=k;i++)r=r*(n-k+i)/i;return r;};
const intersectCount=(a,b)=>{let c=0;const s=new Set(b);for(const n of a)if(s.has(n))c++;return c;};

function buildModel(results){
  const freq=Array(26).fill(0), rec=Array(26).fill(0), pair=Array.from({length:26},()=>Array(26).fill(0));
  results.forEach((d,idx)=>{
    const w=10-idx;
    d.dezenas.forEach(n=>{freq[n]++;rec[n]+=w;});
    for(let i=0;i<15;i++)for(let j=i+1;j<15;j++){pair[d.dezenas[i]][d.dezenas[j]]++;pair[d.dezenas[j]][d.dezenas[i]]++;}
  });
  const sums=results.map(r=>r.dezenas.reduce((a,b)=>a+b,0));
  const meanSum=sums.reduce((a,b)=>a+b,0)/10;
  const reps=results.slice(0,9).map((r,i)=>r.dezenas.filter(n=>results[i+1].dezenas.includes(n)).length);
  const meanRep=reps.reduce((a,b)=>a+b,0)/reps.length;
  return {freq,rec,pair,meanSum,meanRep,lastSet:new Set(results[0].dezenas)};
}

function score(nums,m){
  let sf=0,sr=0,sp=0,even=0,sum=0,repeat=0,low=0,maxSeq=1,seq=1;
  const rows=Array(5).fill(0),cols=Array(5).fill(0);
  for(let i=0;i<15;i++){
    const n=nums[i];sf+=m.freq[n]/10;sr+=m.rec[n]/55;if(n%2===0)even++;sum+=n;if(m.lastSet.has(n))repeat++;if(n<=13)low++;
    rows[Math.floor((n-1)/5)]++;cols[(n-1)%5]++;
    if(i&&n===nums[i-1]+1){seq++;maxSeq=Math.max(maxSeq,seq)}else seq=1;
    for(let j=0;j<i;j++)sp+=m.pair[n][nums[j]]/10;
  }
  const f=sf/15,r=sr/15,p=sp/105;
  const evenFit=1-Math.min(Math.abs(even-7.5)/4.5,1);
  const lowFit=1-Math.min(Math.abs(low-8)/5,1);
  const sumFit=1-Math.min(Math.abs(sum-m.meanSum)/60,1);
  const repFit=1-Math.min(Math.abs(repeat-m.meanRep)/5,1);
  const seqFit=maxSeq<=5?1:maxSeq===6?.75:.45;
  const spreadFit=[...rows,...cols].reduce((a,x)=>a+(x>=2&&x<=4?1:.45),0)/10;
  const structure=(evenFit+lowFit+sumFit+repFit+seqFit+spreadFit)/6;
  return f*.26+r*.24+p*.18+structure*.32;
}

function uniqueSorted(arr){return [...new Set(arr)].sort((a,b)=>a-b);}

function hillClimb(seed,m,rounds=4){
  let current=uniqueSorted(seed);
  if(current.length!==15)return null;
  let currentScore=score(current,m);
  for(let round=0;round<rounds;round++){
    const inside=new Set(current);
    const outside=[];for(let n=1;n<=25;n++)if(!inside.has(n))outside.push(n);
    let best=current,bestScore=currentScore;
    for(let i=0;i<15;i++){
      for(const add of outside){
        const next=current.slice();next[i]=add;next.sort((a,b)=>a-b);
        const s=score(next,m);
        if(s>bestScore+1e-12){best=next;bestScore=s;}
      }
    }
    if(best===current)break;
    current=best;currentScore=bestScore;
  }
  return {numbers:current,raw:currentScore};
}

function generateGames(window){
  const m=buildModel(window);
  const nums=Array.from({length:25},(_,i)=>i+1);
  const composite=nums.slice().sort((a,b)=>{
    const sa=m.freq[a]*3+m.rec[a]/11, sb=m.freq[b]*3+m.rec[b]/11;
    return sb-sa||a-b;
  });
  const byFreq=nums.slice().sort((a,b)=>m.freq[b]-m.freq[a]||m.rec[b]-m.rec[a]||a-b);
  const byRec=nums.slice().sort((a,b)=>m.rec[b]-m.rec[a]||m.freq[b]-m.freq[a]||a-b);
  const last=window[0].dezenas.slice();
  const mix=uniqueSorted([...composite.slice(0,10),...byRec.filter(n=>!composite.slice(0,10).includes(n)).slice(0,5)]);
  const seeds=[composite.slice(0,15),byFreq.slice(0,15),byRec.slice(0,15),last,mix];
  const candidates=[];
  for(const seed of seeds){const c=hillClimb(seed,m,4);if(c)candidates.push(c);}
  const dedup=new Map();
  for(const c of candidates)dedup.set(c.numbers.join('-'),c);
  let list=[...dedup.values()].sort((a,b)=>b.raw-a.raw);
  if(!list.length)return [];

  const best=list[0];
  const rankOut=composite.filter(n=>!best.numbers.includes(n));
  for(let swaps=1;swaps<=3;swaps++){
    const v=best.numbers.slice();
    for(let s=0;s<swaps;s++)v[14-s]=rankOut[s]||v[14-s];
    const c=hillClimb(uniqueSorted(v),m,2);if(c)list.push(c);
  }
  const again=new Map();for(const c of list)again.set(c.numbers.join('-'),c);
  list=[...again.values()].sort((a,b)=>b.raw-a.raw);

  const chosen=[];
  for(const c of list){
    if(chosen.every(x=>intersectCount(x.numbers,c.numbers)<=12)){chosen.push(c);if(chosen.length===3)break;}
  }
  for(const c of list){if(chosen.length===3)break;if(!chosen.some(x=>x.numbers.join('-')===c.numbers.join('-')))chosen.push(c);}
  return chosen.slice(0,3);
}

function expectedDistribution(totalGames){
  const den=C(25,15),out={};
  for(let k=5;k<=15;k++)out[k]=totalGames*(C(15,k)*C(10,15-k)/den);
  return out;
}

self.onmessage=({data})=>{
  const history=data.history||[];
  const requested=Math.min(Number(data.count)||300,300);
  const count=Math.min(requested,Math.max(0,history.length-10));
  if(count<1){postMessage({type:'error',message:'Histórico insuficiente para o backtest.'});return;}

  const gameDist=Array(16).fill(0),bestDist=Array(16).fill(0),rows=[];
  for(let t=0;t<count;t++){
    const target=history[t];
    const window=history.slice(t+1,t+11);
    const games=generateGames(window);
    if(games.length<3){postMessage({type:'error',message:`Falha ao gerar jogos históricos no concurso ${target.numero}.`});return;}
    const hits=games.map(g=>intersectCount(g.numbers,target.dezenas));
    for(const h of hits)gameDist[h]++;
    const best=Math.max(...hits);bestDist[best]++;
    rows.push({contest:target.numero,date:target.data,hits,best});
    if(t%5===0||t===count-1)postMessage({type:'progress',pct:Math.round((t+1)/count*100),done:t+1,total:count});
  }

  const expected=expectedDistribution(count*3);
  const sumFrom=(dist,k)=>dist.slice(k).reduce((a,b)=>a+b,0);
  const expFrom=k=>Object.entries(expected).filter(([n])=>Number(n)>=k).reduce((a,[,v])=>a+v,0);
  postMessage({
    type:'done',
    count,
    totalGames:count*3,
    gameDist,
    bestDist,
    expected,
    summary:{
      hits11:sumFrom(gameDist,11),expected11:expFrom(11),
      hits12:sumFrom(gameDist,12),expected12:expFrom(12),
      hits13:sumFrom(gameDist,13),expected13:expFrom(13),
      hits14:sumFrom(gameDist,14),expected14:expFrom(14),
      hits15:gameDist[15],expected15:expected[15]||0,
      bestEver:bestDist.findLastIndex?bestDist.findLastIndex(v=>v>0):(()=>{for(let i=15;i>=0;i--)if(bestDist[i])return i;return 0;})()
    },
    rows:rows.slice(0,30)
  });
};
