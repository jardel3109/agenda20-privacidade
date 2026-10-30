const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const CAIXA = 'https://servicebus2.caixa.gov.br/portaldeloterias/api/lotofacil';
const cache = new Map();
const TTL = 5 * 60 * 1000;

async function caixaFetch(url) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < TTL) return cached.data;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(url, {headers:{accept:'application/json, text/plain, */*','user-agent':'LotofacilPRO/1.0'}, signal:ctrl.signal});
    if (!r.ok) throw new Error(`CAIXA respondeu ${r.status}`);
    const data = await r.json();
    cache.set(url, {at:Date.now(), data});
    return data;
  } finally { clearTimeout(timer); }
}

function clean(raw) {
  const nums = (raw.listaDezenas || []).map(Number).sort((a,b)=>a-b);
  if (!Number.isInteger(raw.numero) || nums.length !== 15 || new Set(nums).size !== 15 || nums.some(n=>n<1||n>25)) {
    throw new Error('Concurso oficial retornado em formato inválido.');
  }
  return {
    numero: raw.numero,
    data: raw.dataApuracao,
    dezenas: nums,
    acumulado: Boolean(raw.acumulado),
    estimativaProximo: Number(raw.valorEstimadoProximoConcurso || 0),
    proximoNumero: Number(raw.numeroConcursoProximo || 0),
    proximaData: raw.dataProximoConcurso || null,
    local: raw.nomeMunicipioUFSorteio || raw.localSorteio || null,
    premiacao: (raw.listaRateioPremio || []).map(x=>({faixa:x.descricaoFaixa,ganhadores:Number(x.numeroDeGanhadores||0),valor:Number(x.valorPremio||0)}))
  };
}

function send(res, status, body, type='application/json; charset=utf-8') {
  res.writeHead(status, {'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function mime(file){ const e=path.extname(file); return ({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8'}[e]||'application/octet-stream'); }
function staticFile(reqPath,res){
  let rel=reqPath==='/'?'index.html':reqPath.replace(/^\/+/, '');
  const file=path.normalize(path.join(PUBLIC,rel));
  if(!file.startsWith(PUBLIC)) return send(res,403,'Proibido','text/plain; charset=utf-8');
  fs.readFile(file,(err,data)=>{
    if(err){ fs.readFile(path.join(PUBLIC,'index.html'),(e,html)=>e?send(res,404,'Não encontrado','text/plain; charset=utf-8'):send(res,200,html,mime('index.html'))); return; }
    res.writeHead(200, {'content-type':mime(file),'cache-control':file.endsWith('.html')?'no-store':'public, max-age=3600','x-content-type-options':'nosniff'});res.end(data);
  });
}

const server=http.createServer(async (req,res)=>{
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(u.pathname==='/api/health') return send(res,200,{ok:true,version:'1.0.0'});
  if(u.pathname==='/api/results'){
    try{
      const count=Math.min(Math.max(parseInt(u.searchParams.get('count')||'10',10),10),80);
      const latest=clean(await caixaFetch(CAIXA));
      const out=[latest];
      for(let n=latest.numero-1;out.length<count&&n>0;n--){
        const item=clean(await caixaFetch(`${CAIXA}/${n}`));
        if(item.numero!==n) throw new Error(`A CAIXA retornou concurso ${item.numero} ao solicitar ${n}.`);
        out.push(item);
      }
      return send(res,200,{source:'CAIXA Econômica Federal',sourceUrl:CAIXA,fetchedAt:new Date().toISOString(),latestOfficial:latest.numero,results:out});
    }catch(err){console.error(err);return send(res,502,{error:'Não foi possível validar os resultados oficiais da CAIXA agora.',detail:err.message});}
  }
  staticFile(u.pathname,res);
});
server.listen(PORT,()=>console.log(`Lotofácil PRO em http://localhost:${PORT}`));
