const API = 'https://ps99.biggamesapi.io';
const PAGE_SIZE = 48;
let allPets = [];
let visible = [];
let shown = PAGE_SIZE;
let state = { category: 'all', variant: 'normal', sort: 'rap-asc', favOnly: false };
const favorites = new Set(JSON.parse(localStorage.getItem('ps99-favs') || '[]'));

const $ = (id) => document.getElementById(id);
const els = {
  grid: $('grid'), loading: $('loading'), error: $('errorBox'), loadMore: $('loadMoreBtn'),
  search: $('searchInput'), minRap: $('minRap'), maxRap: $('maxRap'), sort: $('sortSelect'),
  resultCount: $('resultCount'), petCount: $('petCount'), lastUpdated: $('lastUpdated'),
  status: $('statusPill'), refresh: $('refreshBtn'), clear: $('clearBtn'), favOnly: $('favOnlyBtn')
};

function apiImage(asset) {
  if (!asset) return '';
  const m = String(asset).match(/(\d+)$/);
  return m ? `${API}/image/${m[1]}` : '';
}
function fmt(n) {
  n = Number(n || 0); if (!n) return '–';
  const units = [[1e15,'Q'],[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K']];
  for (const [v,u] of units) if (n >= v) return `${(n/v).toLocaleString('de-DE',{maximumFractionDigits:2})}${u}`;
  return n.toLocaleString('de-DE');
}
function pct(n) { return n == null ? '–' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`; }
function keyFor(p) { return `${p.id}|${p.variant}|${p.shiny ? 'shiny' : 'normal'}`; }
function variantLabel(p) { if (p.shiny) return 'Shiny'; if (p.variant === 'gold') return 'Golden'; if (p.variant === 'rainbow') return 'Rainbow'; return 'Normal'; }

async function fetchJson(path) {
  const r = await fetch(API + path, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.status !== 'ok') throw new Error(j.error?.message || `API-Fehler bei ${path}`);
  return j.data;
}

function makePetBase(rows) {
  return rows.map(row => ({
    id: row.configName,
    name: row.configData?.name || row.configName,
    category: row.category || (row.configData?.huge ? 'Huge' : 'Pet'),
    thumbnail: row.configData?.thumbnail || '',
    goldenThumbnail: row.configData?.goldenThumbnail || '',
    huge: !!row.configData?.huge,
    obtainable: row.configData?.indexObtainable !== false,
    desc: row.configData?.indexDesc || ''
  }));
}

function makeIndexes(rapRows, existsRows) {
  const rap = new Map(); const ex = new Map();
  for (const r of rapRows) if (r.category === 'Pet') rap.set(JSON.stringify(r.configData || {}), Number(r.value || 0));
  for (const r of existsRows) if (r.category === 'Pet') ex.set(JSON.stringify(r.configData || {}), Number(r.value || 0));
  return { rap, ex };
}
function getMetric(map, id, variant, shiny) {
  const variants = [];
  if (shiny) variants.push({id, sh: 1, ...(variant === 'gold' ? {pt:1} : variant === 'rainbow' ? {pt:2}: {})});
  variants.push({id, ...(variant === 'gold' ? {pt:1} : variant === 'rainbow' ? {pt:2}: {})});
  for (const cfg of variants) { const v = map.get(JSON.stringify(cfg)); if (v != null) return v; }
  return 0;
}
function buildVariants(base, rapMap, exMap) {
  const out = [];
  for (const p of base) {
    for (const v of ['normal','gold','rainbow']) {
      const rap = getMetric(rapMap,p.id,v,false);
      const exists = getMetric(exMap,p.id,v,false);
      if (rap || exists || v === 'normal') out.push({...p, variant:v, shiny:false, rap, exists, move:null, image: apiImage(v === 'gold' && p.goldenThumbnail ? p.goldenThumbnail : p.thumbnail)});
      const sRap = getMetric(rapMap,p.id,v,true); const sEx = getMetric(exMap,p.id,v,true);
      if (sRap || sEx) out.push({...p, variant:v, shiny:true, rap:sRap, exists:sEx, move:null, image:apiImage(p.thumbnail)});
    }
  }
  return out;
}

function apply() {
  const q = els.search.value.trim().toLowerCase();
  const min = Number(els.minRap.value || 0), max = Number(els.maxRap.value || 0);
  visible = allPets.filter(p => {
    if (state.category !== 'all' && p.category !== state.category) return false;
    if (state.variant !== 'normal' && p.variant !== state.variant) return false;
    if (state.variant === 'normal' && p.shiny) return false;
    if (state.favOnly && !favorites.has(keyFor(p))) return false;
    if (q && !`${p.name} ${p.id} ${p.category}`.toLowerCase().includes(q)) return false;
    if ($('onlyTracked').checked && !p.rap) return false;
    if (min && p.rap < min) return false;
    if (max && p.rap > max) return false;
    return true;
  });
  visible.sort((a,b)=>{
    switch(state.sort){
      case 'rap-desc': return b.rap-a.rap;
      case 'exists-desc': return b.exists-a.exists;
      case 'exists-asc': return a.exists-b.exists;
      case 'move-desc': return (b.move||0)-(a.move||0);
      case 'move-asc': return (a.move||0)-(b.move||0);
      case 'name-asc': return a.name.localeCompare(b.name);
      default: return a.rap-b.rap;
    }
  });
  shown = PAGE_SIZE; render();
}

function card(p) {
  const k=keyFor(p), active=favorites.has(k), cat=p.category==='Pet'?'':p.category;
  return `<article class="pet-card">
    <button class="fav ${active?'active':''}" data-fav="${encodeURIComponent(k)}" title="Favorit">★</button>
    <div class="pet-image"><img src="${p.image || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22180%22 height=%22180%22%3E%3Crect width=%22180%22 height=%22180%22 rx=%2230%22 fill=%22%23111a2b%22/%3E%3Ctext x=%2250%25%22 y=%2254%25%22 text-anchor=%22middle%22 fill=%22%2394a3b8%22 font-size=%2215%22 font-family=%22Arial%22%3EPS99%3C/text%3E%3Ctext x=%2250%25%22 y=%2268%25%22 text-anchor=%22middle%22 fill=%22%2394a3b8%22 font-size=%2211%22 font-family=%22Arial%22%3EPet Bild%3C/text%3E%3C/svg%3E'}" alt="${escapeHtml(p.name)}" loading="lazy"></div>
    <div class="pet-body">
      <div class="pet-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
      <div class="pet-meta"><span class="tag">${cat || 'Pet'}</span><span class="tag ${p.variant==='gold'?'gold':''} ${p.shiny?'shiny':''}">${variantLabel(p)}</span>${p.obtainable===false?'<span class="tag">Index only</span>':''}</div>
      <div class="values">
        <div class="value-box"><small>RAP</small><b>${fmt(p.rap)} 💎</b></div>
        <div class="value-box"><small>Exists</small><b>${fmt(p.exists)}</b></div>
      </div>
    </div>
  </article>`;
}
function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function render(){
  els.resultCount.textContent=visible.length.toLocaleString('de-DE');
  els.grid.innerHTML=visible.slice(0,shown).map(card).join('');
  els.loadMore.classList.toggle('hidden', shown >= visible.length);
  els.loading.classList.add('hidden');
  els.grid.querySelectorAll('[data-fav]').forEach(b=>b.addEventListener('click',()=>{
    const k=decodeURIComponent(b.dataset.fav); favorites.has(k)?favorites.delete(k):favorites.add(k);
    localStorage.setItem('ps99-favs',JSON.stringify([...favorites])); apply();
  }));
}

async function load() {
  setStatus('Lade live Daten…','loading'); els.loading.classList.remove('hidden'); els.error.classList.add('hidden');
  try {
    const [pets, rap, exists] = await Promise.all([fetchJson('/api/collection/Pets'),fetchJson('/api/rap'),fetchJson('/api/exists')]);
    const bases=makePetBase(pets), indexes=makeIndexes(rap,exists);
    allPets=buildVariants(bases,indexes.rap,indexes.ex);
    els.petCount.textContent = allPets.length.toLocaleString('de-DE');
    els.lastUpdated.textContent = new Date().toLocaleString('de-DE',{hour:'2-digit',minute:'2-digit',day:'2-digit',month:'2-digit'});
    setStatus('Live verbunden','ok'); apply();
  } catch (e) {
    setStatus('API nicht erreichbar','loading'); els.loading.classList.add('hidden'); els.error.classList.remove('hidden');
    els.error.innerHTML = `<strong>Daten konnten nicht geladen werden.</strong><br>${escapeHtml(e.message)}<br><br>Die Seite ist für die öffentliche BIG-Games-API gebaut. Öffne sie über einen normalen Webserver (z. B. GitHub Pages/Netlify) statt als <code>file://</code>.`;
  }
}
function setStatus(text,kind){els.status.textContent=text;els.status.className=`status-pill ${kind}`;}

['input','change'].forEach(ev=>{
  els.search.addEventListener(ev,()=>apply());els.minRap.addEventListener(ev,()=>apply());els.maxRap.addEventListener(ev,()=>apply());$('onlyTracked').addEventListener(ev,()=>apply());
});
$('categoryFilter').addEventListener('click',e=>{if(e.target.dataset.value){state.category=e.target.dataset.value;toggleActive('categoryFilter',state.category);apply();}});
$('variantFilter').addEventListener('click',e=>{if(e.target.dataset.value){state.variant=e.target.dataset.value;toggleActive('variantFilter',state.variant);apply();}});
els.sort.addEventListener('change',()=>{state.sort=els.sort.value;apply();});
els.clear.addEventListener('click',()=>{els.search.value='';els.minRap.value='';els.maxRap.value='';$('onlyTracked').checked=true;state={category:'all',variant:'normal',sort:'rap-asc',favOnly:false};els.sort.value='rap-asc';toggleActive('categoryFilter','all');toggleActive('variantFilter','normal');apply();});
els.favOnly.addEventListener('click',()=>{state.favOnly=!state.favOnly;els.favOnly.classList.toggle('active',state.favOnly);apply();});
els.loadMore.addEventListener('click',()=>{shown+=PAGE_SIZE;render();});els.refresh.addEventListener('click',load);
function toggleActive(id,val){document.querySelectorAll(`#${id} button`).forEach(b=>b.classList.toggle('active',b.dataset.value===val));}
load();
setInterval(load, 4*60*60*1000);
