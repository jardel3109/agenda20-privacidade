const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const pad = n => String(n).padStart(2,'0');
const LOTERIAS_URL = 'https://www.loteriasonline.caixa.gov.br/';
let results = [];
let worker;
let currentGames = [];
let backtestWorker;
let backtestStarted = false;
let exclusionAudit = null;

function loading(){
  $('#gamesGrid').innerHTML = '<div class="loading-card"></div><div class="loading-card"></div><div class="loading-card"></div>';
}
function setStatus(ok,text){ $('#statusDot').className='dot '+(ok?'ok':'bad'); $('#sourceStatus').textContent=text; }
function currency(v){return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL',maximumFractionDigits:0}).format(v||0)}

$$('.tab').forEach(btn=>btn.addEventListener('click',()=>{
  $$('.tab').forEach(x=>x.classList.remove('active')); $$('.tab-panel').forEach(x=>x.classList.remove('active'));
  btn.classList.add('active'); $('#'+btn.dataset.tab).classList.add('active');
  if(btn.dataset.tab==='performance'&&!backtestStarted) loadBacktest();
}));

async function load(){
  loading(); $('#engineState').textContent='Validando resultados e histórico...'; $('#refreshBtn').disabled=true;
  try{
    const [rr,er]=await Promise.all([
      fetch('/api/results?count=10',{cache:'no-store'}),
      fetch('/api/exclusions',{cache:'no-store'})
    ]);
    const [data,ex]=await Promise.all([rr.json(),er.json()]);
    if(!rr.ok) throw new Error(data.detail||data.error||'Falha na consulta');
    if(!er.ok) throw new Error(ex.detail||ex.error||'Falha ao validar histórico completo');
    results=data.results;
    if(results.length!==10) throw new Error('Janela oficial incompleta.');
    if(!Array.isArray(ex.signatures)||!ex.signatures.length) throw new Error('Histórico de exclusão vazio.');
    if(Number(ex.latestOfficial)!==Number(data.latestOfficial)) throw new Error(`Histórico ainda não sincronizado com o concurso ${data.latestOfficial}.`);
    exclusionAudit=ex;
    renderHeader(data); renderDraws(); renderAnalysis(); renderHistoryGuard(); runEngine(ex.signatures);
    setStatus(true,'Fonte + histórico completo validados');
  }catch(e){
    setStatus(false,'Falha na validação');
    $('#engineState').textContent='Cálculo bloqueado';
    $('#gamesGrid').innerHTML=`<div class="card game-card" style="grid-column:1/-1"><b>Não gerei jogos.</b><p style="color:var(--muted)">${e.message}</p><p style="color:var(--muted);font-size:12px">A trava histórica exige os resultados oficiais e o arquivo completo sincronizados.</p></div>`;
  } finally {$('#refreshBtn').disabled=false;}
}

function renderHeader(data){
  const latest=results[0];
  $('#latestNumber').textContent=latest.numero; $('#latestDate').textContent=latest.data;
  $('#windowStat').textContent=`${results[9].numero}–${latest.numero}`;
  $('#fetchedAt').textContent='atualizado '+new Date(data.fetchedAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
}
function renderHistoryGuard(){
  const el=$('#historyGuard');
  if(!el||!exclusionAudit)return;
  const d=exclusionAudit.duplicateGroups?.length||0;
  el.innerHTML=`<b>Trava histórica ativa:</b> ${exclusionAudit.uniqueCombinations.toLocaleString('pt-BR')} combinações já sorteadas estão bloqueadas. ${d?`O histórico tem <b>${d}</b> grupo${d>1?'s':''} de concursos com resultado exatamente repetido.`:'Até agora não há resultado completo repetido no histórico carregado.'}`;
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
function runEngine(excludedSignatures){
  $('#engineState').textContent='Avaliando 3.268.760 combinações...';
  if(worker) worker.terminate(); worker=new Worker('/worker.js?v=150');
  worker.onmessage=e=>{
    if(e.data.type==='progress') $('#engineState').textContent=`Calculando ${e.data.pct}%`;
    if(e.data.type==='done'){
      renderGames(e.data.games);
      $('#engineState').textContent=`3.268.760 avaliadas • ${e.data.excludedUnique.toLocaleString('pt-BR')} históricas bloqueadas`;
    }
  };
  worker.postMessage({results,excludedSignatures});
}

function renderGames(games){
  currentGames = games;
  $('#gamesGrid').innerHTML=games.map((g,i)=>`<article class="card game-card ${i===0?'best':''}"><div class="game-rank"><strong>${i===0?'★ JOGO PRINCIPAL':`JOGO ${i+1}`}</strong><span class="score">Score ${g.score.toFixed(1)}/100</span></div><div class="balls">${g.numbers.map(n=>`<span class="ball">${pad(n)}</span>`).join('')}</div><div class="game-meta"><div class="meta"><span>Pares</span><b>${g.even}</b></div><div class="meta"><span>Soma</span><b>${g.sum}</b></div><div class="meta"><span>Repete últ.</span><b>${g.repeat}</b></div></div><div style="margin-top:10px;color:var(--green2);font-size:11px;font-weight:800">✓ nunca sorteado como resultado completo</div><button class="bet-btn" data-bet="${i}"><span>↗</span> Abrir Loterias CAIXA</button></article>`).join('');
  $$('.bet-btn').forEach(b=>b.onclick=()=>startBetMode(Number(b.dataset.bet)));
}

async function loadBacktest(){
  backtestStarted=true;
  $('#backtestState').textContent='Carregando histórico...';
  try{
    const r=await fetch('/api/history?count=310',{cache:'no-store'});const data=await r.json();
    if(!r.ok)throw new Error(data.detail||data.error||'Falha ao carregar histórico');
    if(!Array.isArray(data.results)||data.results.length<310)throw new Error('Histórico insuficiente para 300 janelas.');
    if(!exclusionAudit?.draws?.length)throw new Error('Arquivo histórico de exclusões não disponível.');
    $('#backtestState').textContent='Preparando 300 janelas...';
    if(backtestWorker)backtestWorker.terminate();
    backtestWorker=new Worker('/backtest-worker.js?v=150');
    backtestWorker.onmessage=e=>{
      const d=e.data;
      if(d.type==='progress')$('#backtestState').textContent=`Backtest ${d.pct}% • ${d.done}/${d.total}`;
      if(d.type==='error'){backtestStarted=false;$('#backtestState').textContent='Falha no backtest';renderBacktestError(d.message);}
      if(d.type==='done'){renderBacktest(d);$('#backtestState').textContent='300 concursos validados';}
    };
    backtestWorker.onerror=e=>{backtestStarted=false;$('#backtestState').textContent='Falha no backtest';renderBacktestError(e.message||'Erro no worker');};
    backtestWorker.postMessage({history:data.results,count:300,archiveDraws:exclusionAudit.draws});
  }catch(e){backtestStarted=false;$('#backtestState').textContent='Falha no backtest';renderBacktestError(e.message);}
}

function renderBacktestError(message){
  $('#backtestInsights').innerHTML=`<div class="insight"><span>ERRO</span><b>${message}</b></div>`;
  $('#backtestHistory').innerHTML='<div class="bt-placeholder">Não foi possível concluir a validação histórica.</div>';
}

function renderBacktest(d){
  const s=d.summary;
  $('#backtestSummary').innerHTML=`
    <div class="card bt-stat"><span>Concursos testados</span><strong>${d.count}</strong><small>janela móvel de 10</small></div>
    <div class="card bt-stat"><span>Jogos simulados</span><strong>${d.totalGames}</strong><small>3 por concurso</small></div>
    <div class="card bt-stat"><span>11+ acertos</span><strong>${s.hits11}</strong><small>esperado ≈ ${s.expected11.toFixed(1)}</small></div>
    <div class="card bt-stat"><span>13+ acertos</span><strong>${s.hits13}</strong><small>esperado ≈ ${s.expected13.toFixed(1)}</small></div>`;

  const hits=[11,12,13,14,15];
  const max=Math.max(1,...hits.flatMap(k=>[d.gameDist[k]||0,d.expected[k]||0]));
  $('#backtestBars').innerHTML=hits.map(k=>{
    const actual=d.gameDist[k]||0,exp=d.expected[k]||0;
    return `<div class="bt-row"><div class="bt-row-head"><b>${k} acertos</b><span>${actual} reais • ${exp.toFixed(1)} esperados</span></div><div class="bt-track"><i class="actual" style="width:${actual/max*100}%"></i></div><div class="bt-track expected"><i style="width:${exp/max*100}%"></i></div></div>`;
  }).join('');

  const ratio=s.expected11>0?s.hits11/s.expected11:0;
  const reading=ratio>1.15?'Acima da linha de base nesta amostra':ratio<.85?'Abaixo da linha de base nesta amostra':'Próximo da linha de base nesta amostra';
  $('#backtestInsights').innerHTML=`
    <div class="insight"><span>MELHOR RESULTADO OBSERVADO</span><b>${s.bestEver} acertos</b></div>
    <div class="insight"><span>12+ ACERTOS</span><b>${s.hits12} • esperado ≈ ${s.expected12.toFixed(1)}</b></div>
    <div class="insight"><span>14+ ACERTOS</span><b>${s.hits14} • esperado ≈ ${s.expected14.toFixed(2)}</b></div>
    <div class="insight"><span>TRAVA HISTÓRICA</span><b>${d.noRepeatRule?'Ativa em cada época':'Inativa'}</b></div>
    <div class="insight"><span>LEITURA</span><b>${reading}</b></div>
    <div class="insight"><span>INTERPRETAÇÃO CORRETA</span><b>Histórico não garante vantagem futura</b></div>`;

  $('#backtestHistory').innerHTML=d.rows.slice(0,20).map(r=>`<div class="bt-history-row"><div><b>#${r.contest}</b><span>${r.date||''}</span></div><div class="bt-hit-set"><span>J1 ${r.hits[0]}</span><span>J2 ${r.hits[1]}</span><span>J3 ${r.hits[2]}</span></div><strong class="bt-best ${r.best>=13?'high':''}">${r.best} pts</strong></div>`).join('');
}

function ensureBetDock(){
  let dock = $('#betDock');
  if(dock) return dock;
  dock = document.createElement('div');
  dock.id = 'betDock';
  dock.className = 'bet-dock';
  document.body.appendChild(dock);
  return dock;
}

function startBetMode(index){
  const game = currentGames[index];
  if(!game) return;
  const dock = ensureBetDock();
  const title = index===0 ? 'Jogo principal' : `Jogo ${index+1}`;
  dock.innerHTML = `
    <div class="bet-dock-head"><div><span>MODO APOSTA</span><strong>${title}</strong></div><button class="bet-close" aria-label="Fechar">×</button></div>
    <div class="bet-help">Marque estas 15 dezenas no volante da Lotofácil no site oficial da CAIXA.</div>
    <div class="bet-numbers">${game.numbers.map(n=>`<b>${pad(n)}</b>`).join('')}</div>
    <div class="bet-actions"><button class="bet-reopen">↗ Abrir / voltar à CAIXA</button><button class="bet-done">Fechar modo aposta</button></div>
    <div class="bet-tip">A CAIXA abre em outra aba. Volte a esta aba quando quiser conferir os números.</div>`;
  dock.classList.add('show');document.body.classList.add('bet-mode-open');
  dock.querySelector('.bet-close').onclick = closeBetMode;dock.querySelector('.bet-done').onclick = closeBetMode;dock.querySelector('.bet-reopen').onclick = openCaixa;openCaixa();
}

function openCaixa(){
  const link = document.createElement('a');link.href = LOTERIAS_URL;link.target = '_blank';link.rel = 'noopener noreferrer';document.body.appendChild(link);link.click();link.remove();
}
function closeBetMode(){const dock=$('#betDock');if(dock)dock.classList.remove('show');document.body.classList.remove('bet-mode-open');}

$('#refreshBtn').addEventListener('click',load);
load();
setInterval(load,10*60*1000);
