const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const pad = n => String(n).padStart(2,'0');
let results = [];
let worker;

function loading(){
  $('#gamesGrid').innerHTML = '<div class="loading-card"></div><div class="loading-card"></div><div class="loading-card"></div>';
}
function setStatus(ok,text){ $('#statusDot').className='dot '+(ok?'ok':'bad'); $('#sourceStatus').textContent=text; }
function currency(v){return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:0}).format(v||0)}

$$('.tab').forEach(btn=>btn.addEventListener('click',()=>{
  $$('.tab').forEach(x=>x.classList.remove('active')); $$('.tab-panel').forEach(x=>x.classList.remove('active'));
  btn.classList.add('active'); $('#'+btn.dataset.tab).classList.add('active');
}));

async function load(){
  loading(); $('#engineState').textContent='Validando resultados...'; $('#refreshBtn').disabled=true;
  try{
    const r = await fetch('/api/results?count=10',{cache:'no-store'}); const data = await r.json();
    if(!r.ok) throw new Error(data.detail||data.error||'Falha na consulta');
    results=data.results;
    if(results.length!==10) throw new Error('Janela oficial incompleta.');
    renderHeader(data); renderDraws(); renderAnalysis(); runEngine();
    setStatus(true,'Fonte oficial validada');
  }catch(e){
    setStatus(false,'Falha ao validar a CAIXA');
    $('#engineState').textContent='Cálculo bloqueado';
    $('#gamesGrid').innerHTML=`<div class="card game-card" style="grid-column:1/-1"><b>Não gerei jogos.</b><p style="color:var(--muted)">${e.message}</p><p style="color:var(--muted);font-size:12px">O sistema só calcula depois de receber 10 concursos oficiais válidos.</p></div>`;
  } finally {$('#refreshBtn').disabled=false;}
}

function renderHeader(data){
  const latest=results[0];
  $('#latestNumber').textContent=latest.numero; $('#latestDate').textContent=latest.data;
  $('#windowStat').textContent=`${results[9].numero}–${latest.numero}`;
  $('#fetchedAt').textContent='atualizado '+new Date(data.fetchedAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
}
function renderDraws(){
  $('#drawList').innerHTML=results.map((d,i)=>`<div class="draw"><div class="draw-contest"><b>#${d.numero}</b><span>${i===0?' último oficial':''}</span></div><div class="draw-date">${d.data}</div><div class="draw-balls">${d.dezenas.map(n=>`<span class="small-ball">${pad(n)}</span>`).join('')}</div><div class="draw-check">✓ validado</div></div>`).join('');
}
function metrics(){
  const freq=Array(26).fill(0), last=Array(26).fill(99), weighted=Array(26).fill(0);
  results.forEach((d,i)=>d.dezenas.forEach(n=>{freq[n]++; weighted[n]+=10-i; if(last[n]===99) last[n]=i;}));
  return {freq,last,weighted};
}
function renderAnalysis(){
  const {freq,last}=metrics();
  $('#heatmap').innerHTML=Array.from({length:25},(_,i)=>i+1).map(n=>`<div class="heat-cell"><div class="heat-top"><span class="heat-num">${pad(n)}</span><span class="heat-count">${freq[n]}/10</span></div><div class="mini-bar"><i style="width:${freq[n]*10}%"></i></div><div class="heat-last">${last[n]===0?'saiu no último':last[n]===99?'não saiu na janela':`ausente há ${last[n]} concurso${last[n]>1?'s':''}`}</div></div>`).join('');
  const ranked=Array.from({length:25},(_,i)=>i+1).sort((a,b)=>freq[b]-freq[a]||a-b);
  const hot=ranked.slice(0,5).map(pad).join(' • '); const cold=ranked.slice(-5).reverse().map(pad).join(' • ');
  const sums=results.map(d=>d.dezenas.reduce((a,b)=>a+b,0)); const avg=Math.round(sums.reduce((a,b)=>a+b,0)/sums.length);
  const repeats=results.slice(0,9).map((d,i)=>d.dezenas.filter(n=>results[i+1].dezenas.includes(n)).length); const avgRep=(repeats.reduce((a,b)=>a+b,0)/repeats.length).toFixed(1);
  $('#insights').innerHTML=`<div class="insight"><span>MAIS PRESENTES</span><b>${hot}</b></div><div class="insight"><span>MENOS PRESENTES</span><b>${cold}</b></div><div class="insight"><span>SOMA MÉDIA</span><b>${avg}</b></div><div class="insight"><span>REPETIÇÃO MÉDIA</span><b>${avgRep} dezenas</b></div><div class="insight"><span>PRÓXIMO CONCURSO INFORMADO</span><b>#${results[0].proximoNumero||'—'} • ${results[0].proximaData||'—'}</b></div><div class="insight"><span>ESTIMATIVA OFICIAL</span><b>${currency(results[0].estimativaProximo)}</b></div>`;
}
function runEngine(){
  $('#engineState').textContent='Avaliando 3.268.760 combinações...';
  if(worker) worker.terminate(); worker=new Worker('/worker.js');
  worker.onmessage=e=>{ if(e.data.type==='progress') $('#engineState').textContent=`Calculando ${e.data.pct}%`; if(e.data.type==='done'){renderGames(e.data.games);$('#engineState').textContent='3.268.760 combinações avaliadas';} };
  worker.postMessage({results});
}
function renderGames(games){
  $('#gamesGrid').innerHTML=games.map((g,i)=>`<article class="card game-card ${i===0?'best':''}"><div class="game-rank"><strong>${i===0?'★ JOGO PRINCIPAL':`JOGO ${i+1}`}</strong><span class="score">Score ${g.score.toFixed(1)}/100</span></div><div class="balls">${g.numbers.map(n=>`<span class="ball">${pad(n)}</span>`).join('')}</div><div class="game-meta"><div class="meta"><span>Pares</span><b>${g.even}</b></div><div class="meta"><span>Soma</span><b>${g.sum}</b></div><div class="meta"><span>Repete últ.</span><b>${g.repeat}</b></div></div><button class="copy-btn" data-copy="${g.numbers.map(pad).join(' ')}">Copiar dezenas</button></article>`).join('');
  $$('.copy-btn').forEach(b=>b.onclick=async()=>{await navigator.clipboard.writeText(b.dataset.copy);const old=b.textContent;b.textContent='✓ Copiado';setTimeout(()=>b.textContent=old,1200)});
}
$('#refreshBtn').addEventListener('click',load);
load();
setInterval(load,10*60*1000);
