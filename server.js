const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const CAIXA = 'https://servicebus2.caixa.gov.br/portaldeloterias/api/lotofacil';
const FALLBACK_JSON = 'https://valorfinal.com.br/data/lotofacil-historico.json';
const cache = new Map();
const TTL = 5 * 60 * 1000;

function browserHeaders() {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'pt-BR,pt;q=0.9,en;q=0.7',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    referer: 'https://loterias.caixa.gov.br/',
    origin: 'https://loterias.caixa.gov.br',
    'user-agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
  };
}

async function fetchWithTimeout(url, options = {}, timeout = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function caixaFetch(url) {
  const key = `caixa:${url}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL) return cached.data;
  const r = await fetchWithTimeout(url, { headers: browserHeaders(), redirect: 'follow' });
  if (!r.ok) throw new Error(`CAIXA respondeu ${r.status}`);
  const data = await r.json();
  cache.set(key, { at: Date.now(), data });
  return data;
}

function clean(raw) {
  const nums = (raw.listaDezenas || raw.dezenas || []).map(Number).sort((a, b) => a - b);
  const numero = Number(raw.numero ?? raw.concurso);
  if (!Number.isInteger(numero) || nums.length !== 15 || new Set(nums).size !== 15 || nums.some(n => n < 1 || n > 25)) {
    throw new Error('Concurso retornado em formato inválido.');
  }
  return {
    numero,
    data: raw.dataApuracao || raw.data || null,
    dezenas: nums,
    acumulado: Boolean(raw.acumulado ?? raw.acumulou ?? false),
    estimativaProximo: Number(raw.valorEstimadoProximoConcurso || 0),
    proximoNumero: Number(raw.numeroConcursoProximo || raw.proximoConcurso || 0),
    proximaData: raw.dataProximoConcurso || null,
    local: raw.nomeMunicipioUFSorteio || raw.localSorteio || raw.local || null,
    premiacao: (raw.listaRateioPremio || raw.premiacoes || []).map(x => ({
      faixa: x.descricaoFaixa || x.descricao || x.acertos || '',
      ganhadores: Number(x.numeroDeGanhadores ?? x.ganhadores ?? x.vencedores ?? 0),
      valor: Number(x.valorPremio ?? x.premio ?? 0) || 0
    }))
  };
}

function normalizeNumbers(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  if (typeof value === 'string') return (value.match(/\d{1,2}/g) || []).map(Number);
  return [];
}

function normalizeGenericRecord(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const entries = Object.entries(obj);
  const byKey = new Map(entries.map(([k, v]) => [k.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''), v]));
  const numero = Number(byKey.get('concurso') ?? byKey.get('numero') ?? byKey.get('numeroconcurso'));
  if (!Number.isInteger(numero) || numero <= 0) return null;

  let dezenas = [];
  for (const key of ['dezenas', 'listadezenas', 'numeros', 'resultado']) {
    if (byKey.has(key)) {
      dezenas = normalizeNumbers(byKey.get(key));
      if (dezenas.length >= 15) break;
    }
  }
  if (dezenas.length < 15) {
    const numbered = [];
    for (const [k, v] of byKey.entries()) {
      if (/^(d|dezena|bola)\d{1,2}$/.test(k)) {
        const n = Number(v);
        if (Number.isFinite(n)) numbered.push([Number(k.match(/\d+/)[0]), n]);
      }
    }
    numbered.sort((a, b) => a[0] - b[0]);
    dezenas = numbered.map(x => x[1]);
  }
  dezenas = [...new Set(dezenas.filter(n => n >= 1 && n <= 25))].slice(0, 15).sort((a, b) => a - b);
  if (dezenas.length !== 15) return null;

  return {
    numero,
    data: byKey.get('dataapuracao') || byKey.get('data') || byKey.get('datasorteio') || null,
    dezenas,
    acumulado: Boolean(byKey.get('acumulado') || byKey.get('acumulou') || false),
    estimativaProximo: 0,
    proximoNumero: 0,
    proximaData: null,
    local: byKey.get('local') || null,
    premiacao: []
  };
}

function collectRecords(root) {
  const records = [];
  const seenObjects = new Set();
  function walk(node, depth = 0) {
    if (depth > 8 || node == null) return;
    if (typeof node === 'object') {
      if (seenObjects.has(node)) return;
      seenObjects.add(node);
      if (!Array.isArray(node)) {
        const rec = normalizeGenericRecord(node);
        if (rec) records.push(rec);
        for (const v of Object.values(node)) walk(v, depth + 1);
      } else {
        for (const v of node) walk(v, depth + 1);
      }
    }
  }
  walk(root);
  const dedup = new Map();
  for (const r of records) dedup.set(r.numero, r);
  return [...dedup.values()].sort((a, b) => b.numero - a.numero);
}

function validateWindow(results, count) {
  if (!Array.isArray(results) || results.length < count) throw new Error(`A fonte retornou apenas ${results?.length || 0} concursos.`);
  const out = results.slice(0, count);
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    if (!Number.isInteger(r.numero) || r.dezenas.length !== 15 || new Set(r.dezenas).size !== 15 || r.dezenas.some(n => n < 1 || n > 25)) {
      throw new Error(`Concurso ${r.numero || '?'} inválido.`);
    }
    if (i > 0 && out[i - 1].numero - r.numero !== 1) {
      throw new Error(`Janela não consecutiva: ${out[i - 1].numero} → ${r.numero}.`);
    }
  }
  return out;
}

async function getFromCaixa(count) {
  const latest = clean(await caixaFetch(CAIXA));
  const out = [latest];
  for (let n = latest.numero - 1; out.length < count && n > 0; n--) {
    const item = clean(await caixaFetch(`${CAIXA}/${n}`));
    if (item.numero !== n) throw new Error(`A CAIXA retornou concurso ${item.numero} ao solicitar ${n}.`);
    out.push(item);
  }
  return validateWindow(out, count);
}

async function getFromOfficialMirror(count) {
  const key = 'fallback:valorfinal';
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL) return validateWindow(cached.data, count);
  const r = await fetchWithTimeout(FALLBACK_JSON, {
    headers: {
      accept: 'application/json,text/plain,*/*',
      'user-agent': 'Mozilla/5.0 LotofacilPRO/1.1'
    },
    redirect: 'follow'
  }, 15000);
  if (!r.ok) throw new Error(`Espelho oficial respondeu ${r.status}`);
  const data = await r.json();
  const records = collectRecords(data);
  const valid = validateWindow(records, count);
  cache.set(key, { at: Date.now(), data: records });
  return valid;
}

async function getResults(count) {
  try {
    const results = await getFromCaixa(count);
    return { results, source: 'CAIXA Econômica Federal', mode: 'direct', sourceUrl: CAIXA };
  } catch (directError) {
    console.warn(`[fonte] CAIXA direta indisponível: ${directError.message}`);
    const results = await getFromOfficialMirror(count);
    return {
      results,
      source: 'Resultados oficiais da CAIXA via base espelho',
      mode: 'mirror',
      sourceUrl: FALLBACK_JSON,
      warning: `Consulta direta à CAIXA indisponível no servidor (${directError.message}); janela validada em base espelho dos resultados oficiais.`
    };
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function mime(file) {
  const e = path.extname(file);
  return ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' }[e] || 'application/octet-stream');
}
function staticFile(reqPath, res) {
  const rel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Proibido', 'text/plain; charset=utf-8');
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC, 'index.html'), (e, html) => e ? send(res, 404, 'Não encontrado', 'text/plain; charset=utf-8') : send(res, 200, html, mime('index.html')));
      return;
    }
    res.writeHead(200, { 'content-type': mime(file), 'cache-control': file.endsWith('.html') ? 'no-store' : 'public, max-age=300', 'x-content-type-options': 'nosniff' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (u.pathname === '/api/health') return send(res, 200, { ok: true, version: '1.1.1' });
  if (u.pathname === '/api/results') {
    try {
      const count = Math.min(Math.max(parseInt(u.searchParams.get('count') || '10', 10), 10), 80);
      const payload = await getResults(count);
      const latest = payload.results[0];
      return send(res, 200, {
        source: payload.source,
        sourceMode: payload.mode,
        sourceUrl: payload.sourceUrl,
        warning: payload.warning || null,
        fetchedAt: new Date().toISOString(),
        latestOfficial: latest.numero,
        results: payload.results
      });
    } catch (err) {
      console.error(err);
      return send(res, 502, { error: 'Não foi possível validar os resultados oficiais agora.', detail: err.message });
    }
  }
  staticFile(u.pathname, res);
});

server.listen(PORT, () => {
  console.log(`Lotofácil PRO v1.1.1 em http://localhost:${PORT}`);
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
