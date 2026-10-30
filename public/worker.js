self.onmessage = ({data}) => {
  const results=data.results;
  const excluded=new Set(Array.isArray(data.excludedSignatures)?data.excludedSignatures:[]);
  const freq=Array(26).fill(0), rec=Array(26).fill(0), pair=Array.from({length:26},()=>Array(26).fill(0));
  results.forEach((d,idx)=>{
    const w=10-idx;
    d.dezenas.forEach(n=>{freq[n]++; rec[n]+=w;});
    for(let i=0;i<15;i++) for(let j=i+1;j<15;j++){pair[d.dezenas[i]][d.dezenas[j]]++;pair[d.dezenas[j]][d.dezenas[i]]++;}
  });
  const sums=results.map(r=>r.dezenas.reduce((a,b)=>a+b,0)); const meanSum=sums.reduce((a,b)=>a+b,0)/10;
  const reps=results.slice(0,9).map((r,i)=>r.dezenas.filter(n=>results[i+1].dezenas.includes(n)).length); const meanRep=reps.reduce((a,b)=>a+b,0)/reps.length;
  const lastSet=new Set(results[0].dezenas);
  const top=[]; let checked=0, blocked=0; const total=3268760;
  const comb=Array(15).fill(0);
  function signature(nums){return nums.map(n=>String(n).padStart(2,'0')).join('-');}
  function evaluate(nums){
    let sf=0,sr=0,sp=0,even=0,sum=0,repeat=0,low=0,maxSeq=1,seq=1; const rows=Array(5).fill(0), cols=Array(5).fill(0);
    for(let i=0;i<15;i++){
      const n=nums[i]; sf+=freq[n]/10; sr+=rec[n]/55; if(n%2===0) even++; sum+=n; if(lastSet.has(n)) repeat++; if(n<=13) low++;
      rows[Math.floor((n-1)/5)]++; cols[(n-1)%5]++;
      if(i&&n===nums[i-1]+1){seq++;maxSeq=Math.max(maxSeq,seq)}else seq=1;
      for(let j=0;j<i;j++) sp+=pair[n][nums[j]]/10;
    }
    const f=sf/15, r=sr/15, p=sp/105;
    const evenFit=1-Math.min(Math.abs(even-7.5)/4.5,1);
    const lowFit=1-Math.min(Math.abs(low-8)/5,1);
    const sumFit=1-Math.min(Math.abs(sum-meanSum)/60,1);
    const repFit=1-Math.min(Math.abs(repeat-meanRep)/5,1);
    const seqFit=maxSeq<=5?1:maxSeq===6?.75:.45;
    const spreadFit=[...rows,...cols].reduce((a,x)=>a+(x>=2&&x<=4?1:.45),0)/10;
    const structure=(evenFit+lowFit+sumFit+repFit+seqFit+spreadFit)/6;
    const raw=(f*.26+r*.24+p*.18+structure*.32);
    return {raw,even,sum,repeat};
  }
  function keep(item){
    if(top.length<120){top.push(item);top.sort((a,b)=>b.raw-a.raw);return}
    if(item.raw>top[top.length-1].raw){top[top.length-1]=item;top.sort((a,b)=>b.raw-a.raw)}
  }
  function recGen(pos,start){
    if(pos===15){
      const nums=comb.slice();
      checked++;
      if(excluded.has(signature(nums))){blocked++;if(checked%250000===0)postMessage({type:'progress',pct:Math.floor(checked/total*100)});return;}
      const m=evaluate(nums);keep({numbers:nums,...m});
      if(checked%250000===0) postMessage({type:'progress',pct:Math.floor(checked/total*100)});
      return;
    }
    const remaining=15-pos;
    for(let n=start;n<=25-remaining+1;n++){comb[pos]=n;recGen(pos+1,n+1)}
  }
  recGen(0,1);
  const chosen=[];
  for(const c of top){
    if(chosen.every(x=>intersection(x.numbers,c.numbers)<=12)){chosen.push(c);if(chosen.length===3)break}
  }
  while(chosen.length<3) chosen.push(top.find(c=>!chosen.includes(c)));
  const max=top[0].raw, min=top[top.length-1].raw;
  const games=chosen.map(c=>({...c,score:Math.max(70,Math.min(99.8,82+(c.raw-min)/(max-min||1)*17.8)),historicallyDrawn:false}));
  postMessage({type:'done',games,blockedHistorical:blocked,excludedUnique:excluded.size});
};
function intersection(a,b){let i=0,j=0,c=0;while(i<a.length&&j<b.length){if(a[i]===b[j]){c++;i++;j++}else if(a[i]<b[j])i++;else j++;}return c}
