const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const CAIXA = 'https://servicebus2.caixa.gov.br/portaldeloterias/api/lotofacil';
const MIRROR = 'https://valorfinal.com.br/data/lotofacil-historico.json';
const cache = new Map();
const TTL = 5 * 60 * 1000;

async function fetchTimed(url, options = {}, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...options, signal: ctrl.signal, redirect: 'follow' }); }
  finally { clearTimeout(timer); }
}

function caixaHeaders() {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'pt-BR,pt;q=0.9',
    referer: 'https://loterias.caixa.gov.br/',
    origin: 'https://loterias.caixa.gov.br',
    'user-agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36'
  };
}

function validNumbers(values) {
  const nums = values.map(Number).sort((a, b) => a - b);
  if (nums.length !== 15 || new Set(nums).size !== 15 || nums.some(n => !Number.isInteger(n) || n < 1 || n > 25)) throw new Error('Resultado com dezenas inválidas.');
  return nums;
}

function cleanCaixa(raw) {
  const numero = Number(raw.numero);
  if (!Number.isInteger(numero) || numero <= 0) throw new Error('Número de concurso inválido.');
  return {
    numero,
    data: raw.dataApuracao || null,
    dezenas: validNumbers(raw.listaDezenas || []),
    acumulado: Boolean(raw.acumulado),
    estimativaProximo: Number(raw.valorEstimadoProximoConcurso || 0),
    proximoNumero: Number(raw.numeroConcursoProximo || 0),
    proximaData: raw.dataProximoConcurso || null,
    local: raw.nomeMunicipioUFSorteio || raw.localSorteio || null,
    premiacao: (raw.listaRateioPremio || []).map(x => ({ faixa: x.descricaoFaixa, ganhadores: Number(x.numeroDeGanhadores || 0), valor: Number(x.valorPremio || 0) }))
  };
}

function validateWindow(results, count) {
  if (!Array.isArray(results) || results.length < count) throw new Error(`A fonte retornou apenas ${results?.length || 0} concursos.`);
  const out = results.slice(0, count);
  for (let i = 0; i < out.length; i++) {
    validNumbers(out[i].dezenas);
    if (!Number.isInteger(out[i].numero)) throw new Error('Concurso inválido.');
    if (i && out[i - 1].numero - out[i].numero !== 1) throw new Error(`Concursos não consecutivos: ${out[i - 1].numero} → ${out[i].numero}.`);
  }
  return out;
}

async function caixaJson(url) {
  const key = `cx:${url}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const r = await fetchTimed(url, { headers: caixaHeaders() });
  if (!r.ok) throw new Error(`CAIXA respondeu ${r.status}`);
  const data = await r.json();
  cache.set(key, { at: Date.now(), data });
  return data;
}

async function fromCaixa(count) {
  const latest = cleanCaixa(await caixaJson(CAIXA));
  const results = [latest];
  for (let n = latest.numero - 1; results.length < count; n--) {
    const item = cleanCaixa(await caixaJson(`${CAIXA}/${n}`));
    if (item.numero !== n) throw new Error(`CAIXA devolveu ${item.numero} ao solicitar ${n}.`);
    results.push(item);
  }
  return validateWindow(results, count);
}

async function fromMirror(count) {
  const key = 'mirror:valorfinal';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return validateWindow(hit.data, count);
  const r = await fetchTimed(MIRROR, { headers: { accept: 'application/json,*/*', 'user-agent': 'LotofacilPRO/1.3' } }, 15000);
  if (!r.ok) throw new Error(`Base espelho respondeu ${r.status}`);
  const data = await r.json();
  if (!data || !Array.isArray(data.concursos)) throw new Error('Formato inesperado da base espelho.');
  const results = data.concursos.map(row => {
    if (!Array.isArray(row) || row.length < 3) return null;
    const numero = Number(row[0]);
    const dezenas = Array.isArray(row[2]) ? row[2] : [];
    if (!Number.isInteger(numero) || dezenas.length !== 15) return null;
    return { numero, data: row[1] || null, dezenas: validNumbers(dezenas), acumulado: false, estimativaProximo: 0, proximoNumero: 0, proximaData: null, local: null, premiacao: [] };
  }).filter(Boolean).sort((a, b) => b.numero - a.numero);
  if (Number.isInteger(Number(data.ultimoConcurso)) && results[0]?.numero !== Number(data.ultimoConcurso)) throw new Error(`Base inconsistente: último declarado ${data.ultimoConcurso}, encontrado ${results[0]?.numero || '?'}.`);
  const valid = validateWindow(results, count);
  cache.set(key, { at: Date.now(), data: results });
  return valid;
}

async function getResults(count) {
  try {
    const results = await fromCaixa(count);
    return { results, mode: 'direct', source: 'CAIXA Econômica Federal', sourceUrl: CAIXA, warning: null };
  } catch (err) {
    console.warn(`[fonte] CAIXA direta indisponível: ${err.message}`);
    const results = await fromMirror(count);
    return { results, mode: 'mirror', source: 'Resultados oficiais da CAIXA via base validada', sourceUrl: MIRROR, warning: `A CAIXA bloqueou a consulta direta do servidor (${err.message}); dados carregados de base pública que importa e valida os resultados oficiais.` };
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0', pragma: 'no-cache', expires: '0', 'x-content-type-options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function mime(file) {
  const ext = path.extname(file);
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' })[ext] || 'application/octet-stream';
}

function serveStatic(reqPath, res) {
  const rel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Proibido', 'text/plain; charset=utf-8');
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC, 'index.html'), (e, html) => {
        if (e) return send(res, 404, 'Não encontrado', 'text/plain; charset=utf-8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, no-cache, must-revalidate, max-age=0', pragma: 'no-cache', expires: '0' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, {
      'content-type': mime(file),
      'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      pragma: 'no-cache',
      expires: '0',
      'x-content-type-options': 'nosniff'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (u.pathname === '/api/health') return send(res, 200, { ok: true, version: '1.3.0' });
  if (u.pathname === '/api/results') {
    try {
      const count = Math.min(Math.max(parseInt(u.searchParams.get('count') || '10', 10), 10), 80);
      const payload = await getResults(count);
      return send(res, 200, { source: payload.source, sourceMode: payload.mode, sourceUrl: payload.sourceUrl, warning: payload.warning, fetchedAt: new Date().toISOString(), latestOfficial: payload.results[0].numero, results: payload.results });
    } catch (err) {
      console.error(err);
      return send(res, 502, { error: 'Não foi possível validar os resultados oficiais agora.', detail: err.message });
    }
  }
  serveStatic(u.pathname, res);
});

server.listen(PORT, () => {
  console.log(`Lotofácil PRO v1.3.0 em http://localhost:${PORT}`);
  setTimeout(async () => {
    try {
      const payload = await getResults(10);
      const nums = payload.results.map(r => r.numero);
      console.log(`[selftest] OK fonte=${payload.mode} último=${nums[0]} janela=${nums.join(',')}`);
    } catch (err) {
      console.error(`[selftest] FALHA ${err.message}`);
    }
  }, 700);
});
