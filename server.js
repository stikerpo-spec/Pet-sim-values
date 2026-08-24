const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const SNAPSHOT_FILE = path.join(DATA_DIR, 'history.json');
const API = 'https://ps99.biggamesapi.io';
const SNAPSHOT_MS = 30 * 60 * 1000;
const RETAIN_MS = 36 * 60 * 60 * 1000;
const PET_REFRESH_MS = 4 * 60 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });
let cache = { updatedAt: 0, pets: [], rap: {}, exists: {}, history: [] };
try { cache = { ...cache, ...JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')) }; } catch {}

function apiGet(pathname) {
  return new Promise((resolve, reject) => {
    const req = https.get(API + pathname, { headers: { 'User-Agent': 'PS99ValueFinder/2.0' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`${pathname}: HTTP ${res.statusCode}`));
        try {
          const json = JSON.parse(body);
          if (json.status !== 'ok') return reject(new Error(json.error?.message || `API error: ${pathname}`));
          resolve(json.data);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('API timeout')));
  });
}

function configKey(c) { return JSON.stringify(c || {}); }
function assetId(asset) { const m = String(asset || '').match(/(\d+)$/); return m ? m[1] : ''; }
function imageFor(p, variant) {
  const asset = variant === 'gold' && p.goldenThumbnail ? p.goldenThumbnail : p.thumbnail;
  const id = assetId(asset);
  return id ? `${API}/image/${id}` : '';
}
function buildPetVariants(pets, rapRows, existsRows) {
  const rap = {}, exists = {};
  for (const r of rapRows || []) if (r.category === 'Pet') rap[configKey(r.configData)] = Number(r.value || 0);
  for (const r of existsRows || []) if (r.category === 'Pet') exists[configKey(r.configData)] = Number(r.value || 0);
  const out = [];
  const variants = [
    ['normal', {}], ['gold', { pt: 1 }], ['rainbow', { pt: 2 }]
  ];
  for (const p of pets || []) {
    const id = p.configName || p.id || p.configData?.id || p.configData?.name;
    if (!id) continue;
    const name = p.configData?.name || p.configData?.displayName || id;
    const base = {
      id, name, category: p.category || p.configData?.category || (p.configData?.huge ? 'Huge' : 'Pet'),
      thumbnail: p.configData?.thumbnail || p.configData?.icon || '', goldenThumbnail: p.configData?.goldenThumbnail || '',
      huge: !!p.configData?.huge, obtainable: p.configData?.indexObtainable !== false, desc: p.configData?.indexDesc || ''
    };
    for (const [variant, pt] of variants) {
      const cfg = { id, ...pt };
      const rapValue = rap[configKey(cfg)] || 0, existsValue = exists[configKey(cfg)] || 0;
      if (rapValue || existsValue || variant === 'normal') out.push({ ...base, variant, shiny: false, rap: rapValue, exists: existsValue, image: imageFor(base, variant) });
      const scfg = { ...cfg, sh: 1 };
      const sRap = rap[configKey(scfg)] || 0, sExists = exists[configKey(scfg)] || 0;
      if (sRap || sExists) out.push({ ...base, variant, shiny: true, rap: sRap, exists: sExists, image: imageFor(base, variant) });
    }
  }
  return { out, rap, exists };
}

async function refresh(forcePet = false) {
  const needsPets = forcePet || !cache.updatedAt || Date.now() - cache.updatedAt > PET_REFRESH_MS || !cache.pets.length;
  const [pets, rapRows, existsRows] = await Promise.all([
    needsPets ? apiGet('/api/collection/Pets') : Promise.resolve(null),
    apiGet('/api/rap'), apiGet('/api/exists')
  ]);
  const built = needsPets ? buildPetVariants(pets, rapRows, existsRows) : buildPetVariants(cache.pets, rapRows, existsRows);
  cache.updatedAt = Date.now();
  cache.pets = needsPets ? pets : cache.pets;
  cache.rap = built.rap; cache.exists = built.exists;
  cache.variants = built.out;
  const snapshot = { ts: Date.now(), rap: built.rap, exists: built.exists };
  const last = cache.history[cache.history.length - 1];
  if (!last || Date.now() - last.ts >= SNAPSHOT_MS - 30_000) cache.history.push(snapshot);
  const cutoff = Date.now() - RETAIN_MS;
  cache.history = cache.history.filter(s => s.ts >= cutoff);
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ updatedAt: cache.updatedAt, pets: cache.pets, rap: cache.rap, exists: cache.exists, history: cache.history }, null, 2));
  return cache;
}

function variantKey(id, variant, shiny) { return configKey({ id, ...(variant === 'gold' ? { pt: 1 } : variant === 'rainbow' ? { pt: 2 } : {}), ...(shiny ? { sh: 1 } : {}) }); }
function currentFor(id, variant, shiny) {
  const k = variantKey(id, variant, shiny);
  return { rap: Number(cache.rap[k] || 0), exists: Number(cache.exists[k] || 0) };
}
function petFromId(id, variant = 'normal', shiny = false) {
  return cache.variants?.find(p => p.id === id && p.variant === variant && !!p.shiny === !!shiny) || null;
}
function seriesFor(id, variant, shiny) {
  const k = variantKey(id, variant, shiny);
  return cache.history.map(s => ({ ts: s.ts, rap: Number(s.rap?.[k] || 0), exists: Number(s.exists?.[k] || 0) })).filter(x => x.rap || x.exists);
}
function pct(now, old) { return old > 0 ? ((now - old) / old) * 100 : null; }
function metrics(series, pet) {
  const now = series.at(-1)?.rap || pet?.rap || 0;
  const old = series.find(x => x.ts <= Date.now() - 24 * 60 * 60 * 1000)?.rap || series[0]?.rap || 0;
  const move24 = pct(now, old);
  const recent = series.slice(-5).map(x => x.rap).filter(Boolean);
  const previous = series.slice(-10, -5).map(x => x.rap).filter(Boolean);
  const recentAvg = recent.length ? recent.reduce((a,b)=>a+b,0)/recent.length : now;
  const previousAvg = previous.length ? previous.reduce((a,b)=>a+b,0)/previous.length : old;
  const acceleration = pct(recentAvg, previousAvg);
  const exists = pet?.exists || 0;
  const scarcity = exists > 0 ? Math.max(0, Math.min(100, 100 - Math.log10(exists) * 11)) : 50;
  const momentum = Math.max(0, Math.min(100, 50 + (move24 || 0) * 2.5));
  const accelScore = Math.max(0, Math.min(100, 50 + (acceleration || 0) * 3));
  const rarityBonus = pet?.category === 'Gargantuan' ? 18 : pet?.category === 'Titanic' ? 12 : pet?.category === 'Huge' ? 6 : 0;
  const potential = Math.round(Math.max(0, Math.min(100, momentum * 0.45 + scarcity * 0.25 + accelScore * 0.15 + rarityBonus * 0.15)));
  let label = potential >= 72 ? 'Starkes Potenzial' : potential >= 57 ? 'Beobachten' : potential >= 42 ? 'Neutral' : 'Eher schwach';
  return { move24, acceleration, scarcity, potential, label, old, now };
}
function sendJson(res, obj, code=200) { const body = JSON.stringify(obj); res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(body); }
function serveStatic(req, res) {
  let pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return sendJson(res, {error:'Not found'},404);
  const ext = path.extname(file); const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'}[ext] || 'application/octet-stream';
  res.writeHead(200, {'Content-Type': mime}); fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req,res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    if (u.pathname === '/api/data') {
      if (!cache.variants?.length || Date.now()-cache.updatedAt>SNAPSHOT_MS) await refresh();
      const pets = cache.variants.map(p => { const series = seriesFor(p.id, p.variant, p.shiny); const m = metrics(series, p); return { ...p, move24: m.move24, potential: m.potential }; });
      return sendJson(res, { updatedAt: cache.updatedAt, pets, snapshotCount: cache.history.length });
    }
    if (u.pathname === '/api/pet') {
      if (!cache.variants?.length) await refresh();
      const id = u.searchParams.get('id'); const variant = u.searchParams.get('variant') || 'normal'; const shiny = u.searchParams.get('shiny') === '1';
      const pet = petFromId(id, variant, shiny);
      if (!pet) return sendJson(res,{error:'Pet not found'},404);
      const series = seriesFor(id, variant, shiny); const m = metrics(series, pet);
      return sendJson(res, { pet, series, metrics: m, historyAvailable: series.length >= 2, snapshotCount: cache.history.length });
    }
    if (u.pathname === '/api/refresh') { await refresh(true); return sendJson(res,{ok:true,updatedAt:cache.updatedAt}); }
    return serveStatic(req,res);
  } catch(e) { sendJson(res,{error:e.message || 'Server error'},500); }
});

server.listen(PORT, () => console.log(`PS99 Value Finder running on http://localhost:${PORT}`));
refresh().catch(e => console.error('Initial refresh failed:', e.message));
setInterval(() => refresh().catch(e => console.error('Scheduled refresh failed:', e.message)), SNAPSHOT_MS);
