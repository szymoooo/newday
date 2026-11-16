'use strict';
/* =====================  Mój Dzień  =====================
   Jeden plik z całą logiką aplikacji (bez bundlera).
   Dane: localStorage. AI: Claude API (klucz w Ustawieniach).
   ======================================================= */

const KEY = 'mojdzien.v1';
const DEF = {
  settings: { name: 'Ania', apiKey: '', model: 'claude-sonnet-5-5' },
  links: [], recipes: [], shopping: [], plants: [], events: [], notes: [], chat: []
};
let S = null;
let route = { v: 'start' };
let stack = [];
let draft = null;      // edytowany przepis
let scale = 1;         // skalowanie składników w widoku przepisu
let pendingImg = null; // zdjęcie wybrane w oknie "Dodaj"

/* ---------- narzędzia ---------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, r) => (r || document).querySelector(s);
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = () => ymd(new Date());
const plDate = d => d.toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const plShort = s => new Date(s + 'T12:00:00').toLocaleDateString('pl-PL', { weekday: 'short', day: 'numeric', month: 'long' });
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);
const cap1 = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const hasKey = () => !!(S && S.settings.apiKey);

function load() {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) || 'null');
    const base = JSON.parse(JSON.stringify(DEF));
    return r ? Object.assign(base, r, { settings: Object.assign(base.settings, r.settings || {}) }) : base;
  } catch (e) { return JSON.parse(JSON.stringify(DEF)); }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { toast('Brak miejsca w pamięci - usuń część zdjęć'); }
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}
function busy(on, txt) { $('#busyText').textContent = txt || 'Chwila…'; $('#busy').classList.toggle('hidden', !on); }
function sheet(html) { $('#panel').innerHTML = html; $('#sheet').classList.remove('hidden'); }
function closeSheet() { $('#sheet').classList.add('hidden'); $('#panel').innerHTML = ''; }
const val = id => { const e = $('#' + id); return e ? e.value.trim() : ''; };

function domainOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
function sourceOf(u) {
  const d = domainOf(u);
  if (/instagram/.test(d)) return 'Instagram';
  if (/youtu/.test(d)) return 'YouTube';
  if (/tiktok/.test(d)) return 'TikTok';
  if (/facebook|fb\./.test(d)) return 'Facebook';
  if (/pinterest|pin\.it/.test(d)) return 'Pinterest';
  if (/twitter|x\.com/.test(d)) return 'X';
  return d || 'Link';
}

/* ---------- powiadomienia (Capacitor Local Notifications) ---------- */
const LN = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) || null;
function nid(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return (Math.abs(h) % 2147483000) + 1; }
async function notify(key, title, body, at) {
  const p = LN(); if (!p || !(at > new Date())) return;
  try {
    const perm = await p.requestPermissions();
    if (perm.display !== 'granted') return;
    await p.cancel({ notifications: [{ id: nid(key) }] });
    await p.schedule({ notifications: [{ id: nid(key), title, body, schedule: { at, allowWhileIdle: true } }] });
  } catch (e) { /* brak zgody / brak natywnego środowiska */ }
}
async function unnotify(key) { const p = LN(); if (p) { try { await p.cancel({ notifications: [{ id: nid(key) }] }); } catch (e) {} } }

/* ---------- obrazy ---------- */
function fileToDataUrl(file, max, q) {
  max = max || 900; q = q || 0.7;
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onerror = rej;
    fr.onload = () => {
      const img = new Image();
      img.onerror = rej;
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', q));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
function pickImage(max) {
  return new Promise(res => {
    const inp = $('#filePick');
    inp.value = '';
    inp.onchange = async () => { const f = inp.files[0]; res(f ? await fileToDataUrl(f, max) : null); };
    inp.click();
  });
}

/* ---------- Claude API ---------- */
async function claude(opts) {
  if (!hasKey()) throw new Error('NO_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': S.settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({ model: S.settings.model, max_tokens: opts.max || 2000, system: opts.system, messages: opts.messages })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  return j.content.map(c => c.text || '').join('');
}
function extractJSON(t) {
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('AI nie zwróciło danych');
  return JSON.parse(t.slice(a, b + 1));
}
function imgBlock(dataUrl) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: dataUrl.split(',')[1] } };
}

const ANALYZE_SYSTEM = `Jesteś modułem rozpoznawania treści w polskiej aplikacji do codziennego życia. Dostajesz tekst, zawartość strony i/lub zdjęcie. Odpowiadasz WYŁĄCZNIE poprawnym JSON-em (bez komentarzy) w formacie:
{"type":"recipe|link|note|plant|event|shopping",
 "recipe":{"title":"","servings":null,"total_min":null,"cook_min":null,"temp_c":null,"groups":[{"name":"","items":["500 g mąki"]}],"steps":["krok 1"],"image_query":"krótka fraza do wyszukania zdjęcia gotowej potrawy"},
 "link":{"title":"","tags":["tag"]},
 "note":{"text":""},
 "plant":{"name":"","water_days":7,"fertilize_days":30,"tip":""},
 "event":{"title":"","date":"YYYY-MM-DD","time":"HH:MM"},
 "shopping":["produkt"]}
Wypełnij tylko pole pasujące do "type". Przepis: zachowaj oryginalne ilości i treść, rozdziel składniki na podgrupy (np. "Kruszonka", "Nadzienie") gdy tekst je wyróżnia, nazwa grupy pusta dla głównych składników. Kroki wykonania jako osobne krótkie pozycje. Czas i temperaturę podaj tylko jeśli wynikają z tekstu. Wszystko po polsku.`;

async function aiAnalyze(text, img) {
  const content = [];
  if (img) content.push(imgBlock(img));
  content.push({ type: 'text', text: 'Dzisiejsza data: ' + today() + '\n\nTreść do rozpoznania:\n' + (text || '(tylko zdjęcie)') });
  const out = await claude({ system: ANALYZE_SYSTEM, messages: [{ role: 'user', content }], max: 3000 });
  return extractJSON(out);
}

/* ---------- parsowanie składników i przepisów ---------- */
const UNIT_RE = 'g|kg|dag|ml|l|szt\\.?|łyżk\\w*|łyżecz\\w*|szklank\\w*|opak\\w*|ząbk\\w*|plast\\w*|pęczek|kostk\\w*|cm';
function parseQty(s) {
  s = String(s).replace(',', '.');
  if (s === '½') return 0.5;
  if (/^\d+\/\d+$/.test(s)) { const p = s.split('/'); return p[0] / p[1]; }
  return parseFloat(s);
}
function parseIngredient(raw) {
  raw = String(raw).trim().replace(/^[-•*]\s*/, '');
  const m = raw.match(new RegExp('^(\\d+(?:[.,]\\d+)?|\\d+/\\d+|½)\\s*(?:(' + UNIT_RE + ')(?=\\s|$))?\\s*(.*)$', 'i'));
  if (!m) return { q: null, u: '', n: raw, raw };
  const q = parseQty(m[1]);
  if (isNaN(q)) return { q: null, u: '', n: raw, raw };
  return { q, u: m[2] || '', n: m[3] || '', raw };
}
const fmtQ = x => String(Math.round(x * 100) / 100).replace('.', ',');
function itemText(it, f) {
  if (it.q == null) return it.raw;
  return [fmtQ(it.q * (f || 1)), it.u, it.n].filter(Boolean).join(' ');
}
function splitInline(s) { return s.split(/\s*,\s*|\s+i\s+(?=\d)/).map(x => x.trim().replace(/[.;]+$/, '')).filter(Boolean); }

function sumMinutes(str) {
  let t = 0, m; const re = /(\d+)\s*(godz\w*|h\b|min\w*)/gi;
  while ((m = re.exec(str))) t += /^(godz|h)/i.test(m[2]) ? +m[1] * 60 : +m[1];
  return t;
}

function parseRecipeText(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const isIng = l => (/^(\d+(?:[.,]\d+)?|\d+\/\d+|½)\s*[^\s.)]/.test(l)) || /^(szczypt|pół\s|troch|do smaku|kilka|opakowan)/i.test(l);
  let title = '', mode = 'start';
  const groups = [{ name: '', items: [] }];
  let cur = groups[0];
  const steps = [];
  let idx = 0;
  if (lines.length && !isIng(lines[0]) && lines[0].length < 80 && !/[.:]$/.test(lines[0]) && !/^(składniki|wykonanie|przygotowanie)/i.test(lines[0])) { title = lines[0]; idx = 1; }
  for (; idx < lines.length; idx++) {
    const l = lines[idx];
    if (/^(składniki|ingredients)\s*:?$/i.test(l)) { mode = 'ing'; continue; }
    if (/^(wykonanie|przygotowanie|sposób przygotowania|instrukcja|kroki|przepis)\s*:?$/i.test(l)) { mode = 'steps'; continue; }
    if (mode !== 'steps') {
      const g = l.match(/^([^:\d]{2,40}):\s*(.+)$/);
      if (g && /\d/.test(g[2]) && isIng(splitInline(g[2])[0] || '')) {
        cur = { name: cap1(g[1].replace(/^na\s+/i, '').trim()), items: [] };
        groups.push(cur);
        splitInline(g[2]).forEach(x => cur.items.push(parseIngredient(x)));
        continue;
      }
      if (isIng(l)) { cur.items.push(parseIngredient(l)); continue; }
      mode = 'steps';
    }
    l.split(/(?<=[.!?])\s+(?=[A-ZĄĆĘŁŃÓŚŹŻ0-9])/).forEach(s => { if (s.trim()) steps.push(s.trim()); });
  }
  const gs = groups.filter(g => g.items.length);
  const all = steps.join(' ');
  // temperatura i czasy
  const temp = (String(text).match(/(\d{2,3})\s*(?:°\s*C?|stopni|st\.)/i) || [])[1];
  let cook = null;
  const cm = all.match(/(?:piecz\w*|smaż\w*|gotuj\w*|duś\w*)[^.]*?(\d+)\s*(min\w*|godz\w*)/i);
  if (cm) cook = /^godz/i.test(cm[2]) ? +cm[1] * 60 : +cm[1];
  const total = sumMinutes(all) || null;
  // porcje
  let servings = null;
  const sm = String(text).match(/(?:na|dla)\s+(\d+)\s*(?:porcji|porcje|osób|osoby|sztuk|szt)/i);
  if (sm) servings = +sm[1];
  else {
    const re = /dziel\w*[^.]*?na\s+(\d+)/gi; const nums = []; let m;
    while ((m = re.exec(all))) nums.push(+m[1]);
    if (nums.length === 2) servings = nums[0] * nums[1];
  }
  return {
    id: uid(), title: title || 'Nowy przepis', servings, total, cook, temp: temp ? +temp : null,
    groups: gs, steps, image: '', imgs: [], source: '', fav: false, ts: Date.now()
  };
}
function looksLikeRecipe(text) {
  const r = parseRecipeText(text);
  const n = r.groups.reduce((a, g) => a + g.items.length, 0);
  return n >= 3 && r.steps.length >= 1;
}
function aiToRecipe(a) {
  const groups = (a.groups || []).map(g => ({ name: g.name || '', items: (g.items || []).map(parseIngredient) })).filter(g => g.items.length);
  return {
    id: uid(), title: a.title || 'Nowy przepis', servings: a.servings || null, total: a.total_min || null,
    cook: a.cook_min || null, temp: a.temp_c || null, groups, steps: a.steps || [],
    image: '', imgs: [], imageQuery: a.image_query || '', source: '', fav: false, ts: Date.now()
  };
}

/* ---------- zdjęcia z internetu (Wikimedia, bez klucza) ---------- */
async function findImages(query) {
  const out = [];
  const add = u => { if (u && !out.includes(u)) out.push(u); };
  try {
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=' +
      encodeURIComponent(query + ' filetype:bitmap') + '&prop=imageinfo&iiprop=url&iiurlwidth=700&format=json&origin=*';
    const j = await (await fetch(u)).json();
    Object.values((j.query && j.query.pages) || {}).forEach(p => {
      const ii = p.imageinfo && p.imageinfo[0];
      if (ii && /\.(jpe?g|png)$/i.test(ii.url)) add(ii.thumburl || ii.url);
    });
  } catch (e) {}
  try {
    const u = 'https://pl.wikipedia.org/w/api.php?action=query&generator=search&gsrlimit=5&gsrsearch=' + encodeURIComponent(query) +
      '&prop=pageimages&piprop=thumbnail&pithumbsize=700&format=json&origin=*';
    const j = await (await fetch(u)).json();
    Object.values((j.query && j.query.pages) || {}).forEach(p => add(p.thumbnail && p.thumbnail.source));
  } catch (e) {}
  return out;
}

/* ---------- przepisy ze stron (JSON-LD) ---------- */
function isoMin(s) {
  if (!s) return null;
  const m = String(s).match(/P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m) return null;
  return (+m[1] || 0) * 60 + (+m[2] || 0) || null;
}
function findRecipeLD(obj) {
  if (!obj) return null;
  if (Array.isArray(obj)) { for (const o of obj) { const r = findRecipeLD(o); if (r) return r; } return null; }
  if (typeof obj === 'object') {
    const t = obj['@type'];
    if (t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'))) return obj;
    if (obj['@graph']) return findRecipeLD(obj['@graph']);
  }
  return null;
}
function ldInstructions(x) {
  if (!x) return [];
  if (typeof x === 'string') return x.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (Array.isArray(x)) return x.flatMap(ldInstructions);
  if (x.itemListElement) return ldInstructions(x.itemListElement);
  if (x.text) return [String(x.text).trim()];
  return [];
}
function decodeHtml(s) { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; }
function recipeFromHtml(html, url) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) {
    try {
      const r = findRecipeLD(JSON.parse(m[1].trim()));
      if (!r) continue;
      let img = r.image; if (Array.isArray(img)) img = img[0]; if (img && img.url) img = img.url;
      const y = Array.isArray(r.recipeYield) ? r.recipeYield[0] : r.recipeYield;
      return {
        id: uid(), title: decodeHtml(r.name || 'Przepis'), servings: parseInt(y) || null,
        total: isoMin(r.totalTime), cook: isoMin(r.cookTime), temp: null,
        groups: [{ name: '', items: (r.recipeIngredient || []).map(x => parseIngredient(decodeHtml(String(x)))) }],
        steps: ldInstructions(r.recipeInstructions).map(decodeHtml),
        image: typeof img === 'string' ? img : '', imgs: [], source: url, fav: false, ts: Date.now()
      };
    } catch (e) { /* następny blok */ }
  }
  return null;
}
function htmlToText(html) {
  return decodeHtml(html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/* ---------- porównywanie / duplikaty / wyszukiwanie ---------- */
const stem = w => w.toLowerCase().replace(/[^a-ząćęłńóśźż0-9]/g, '').slice(0, 3);
const STOP = new Set(['co', 'mogę', 'moge', 'zrobić', 'zrobic', 'mam', 'mi', 'ze', 'z', 'na', 'i', 'oraz', 'przepis', 'przepisy', 'jaki', 'jakie', 'dla', 'do', 'się', 'sie', 'mogę']);
function tokens(s) { return String(s).split(/[\s,;.?!]+/).filter(w => w.length > 2 && !STOP.has(w.toLowerCase())).map(stem); }
function recipeIngTokens(r) { return new Set(r.groups.flatMap(g => g.items.flatMap(i => tokens(i.n || i.raw)))); }
function jaccard(a, b) { const A = new Set(a), B = new Set(b); let i = 0; A.forEach(x => { if (B.has(x)) i++; }); const u = A.size + B.size - i; return u ? i / u : 0; }
function findDuplicate(r) {
  const tt = tokens(r.title), it = recipeIngTokens(r);
  return S.recipes.find(o => o.id !== r.id && (jaccard(tt, tokens(o.title)) >= 0.6 || (it.size > 3 && jaccard([...it], [...recipeIngTokens(o)]) >= 0.75)));
}
function searchRecipes(q) {
  const qt = tokens(q);
  if (!qt.length) return S.recipes.map(r => ({ r, hit: 0, of: 0 }));
  return S.recipes.map(r => {
    const ing = recipeIngTokens(r), tt = new Set(tokens(r.title));
    let hit = 0; qt.forEach(t => { if (ing.has(t) || tt.has(t)) hit++; });
    return { r, hit, of: qt.length };
  }).filter(x => x.hit > 0).sort((a, b) => b.hit - a.hit);
}

/* ---------- rośliny ---------- */
function plantDue(p) {
  const w = addDays(p.lastWater || today(), +p.waterDays || 7);
  const f = p.fertDays ? addDays(p.lastFert || today(), +p.fertDays) : null;
  return { water: daysBetween(today(), w), fert: f ? daysBetween(today(), f) : 99 };
}
function dueLabel(n, what) {
  if (n < 0) return `<span class=warn>${what}: spóźnione ${-n} d</span>`;
  if (n === 0) return `<span class=warn>${what}: dziś</span>`;
  return `<span class=muted>${what}: za ${n} d</span>`;
}
function schedulePlant(p) {
  const d = plantDue(p);
  const at = days => { const x = new Date(addDays(today(), days) + 'T09:00:00'); return x; };
  notify('pw' + p.id, 'Podlewanie 🌿', 'Podlej: ' + p.name, at(Math.max(d.water, 0)));
  if (p.fertDays) notify('pf' + p.id, 'Nawożenie 🌿', 'Nawieź: ' + p.name, at(Math.max(d.fert, 0)));
}

/* =====================  WIDOKI  ===================== */
const hdr = (title, back, right) => `<div class="hdr">${back ? '<button class="ibtn" data-act="back">←</button>' : ''}<h1>${title}</h1>${right || ''}</div>`;

function vStart() {
  const td = today(), now = new Date();
  const ev = S.events.filter(e => e.date === td).sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
  const pl = S.plants.filter(p => { const d = plantDue(p); return d.water <= 0 || d.fert <= 0; });
  const open = S.shopping.filter(x => !x.done).length;
  const overdue = S.events.filter(e => e.kind === 'task' && !e.done && e.date < td);
  let plan = '';
  overdue.forEach(e => plan += evRow(e, true));
  ev.forEach(e => plan += evRow(e));
  pl.forEach(p => plan += `<div class="row" style="padding:6px 0"><span>🌿</span><div class="grow">${esc(p.name)} - ${plantDue(p).water <= 0 ? 'podlej' : 'nawieź'}</div><button class="btn sm ghost" data-act="plantsGo">Kwiaty</button></div>`);
  if (open) plan += `<div class="row" style="padding:6px 0"><span>🛒</span><div class="grow">Do kupienia: ${open} ${open === 1 ? 'pozycja' : 'pozycji'}</div><button class="btn sm ghost" data-act="tab" data-v="shopping">Zakupy</button></div>`;
  if (!plan) plan = '<div class="muted">Na dziś pusto - miłego dnia! ☀️</div>';
  return `<div class="hdr" style="display:block"><div class="sub">${esc(plDate(now))}</div><h1>Hej ${esc(S.settings.name)}!</h1></div>
  <input id="gsearch" placeholder="🔎 Szukaj wszędzie (przepisy, linki, notatki…)" data-enter="gsearch">
  <h2>Plan dnia</h2><div class="card">${plan}</div>
  <h2>Szybkie akcje</h2>
  <div class="grid">
    <button class="tile" data-act="add"><span>➕</span>Dodaj</button>
    <button class="tile" data-act="newNote"><span>📝</span>Notatka</button>
    <button class="tile" data-act="newEvent"><span>📅</span>Wydarzenie</button>
    <button class="tile" data-act="tab" data-v="shopping"><span>🛒</span>Zakupy</button>
    <button class="tile" data-act="go" data-v="chat"><span>💬</span>Asystent</button>
    <button class="tile" data-act="go" data-v="plants"><span>🌿</span>Kwiaty</button>
  </div>`;
}
function evRow(e, late) {
  return `<div class="row" style="padding:6px 0">
    ${e.kind === 'task' ? `<button class="check ${e.done ? 'on' : ''}" data-act="evDone" data-id="${e.id}">${e.done ? '✓' : ''}</button>` : '<span>📅</span>'}
    <div class="grow ${e.done ? 'done' : ''}">${esc(e.title)}${e.time ? ` <span class=muted>· ${esc(e.time)}</span>` : ''}${late ? ' <span class=warn>zaległe</span>' : ''}</div></div>`;
}

/* --- Linki --- */
function listLinks(q) {
  q = (q || '').toLowerCase();
  const ls = S.links.filter(l => !q || (l.title + ' ' + l.url + ' ' + (l.tags || []).join(' ') + ' ' + (l.note || '')).toLowerCase().includes(q));
  if (!ls.length) return '<div class="muted card">Brak zapisanych linków. Użyj „Udostępnij” w innej aplikacji i wybierz Mój Dzień, albo wklej link przyciskiem ＋.</div>';
  return ls.map(l => `<div class="card"><div class="row"><div class="grow"><h3>${esc(l.title || l.url)}</h3>
    <div class="muted">${esc(sourceOf(l.url))}</div>${(l.tags || []).map(t => `<span class=chip>${esc(t)}</span>`).join('')}${l.note ? `<div class="muted">${esc(l.note)}</div>` : ''}</div></div>
    <div class="btns"><button class="btn sm" data-act="openLink" data-id="${l.id}">Otwórz</button><button class="btn sm ghost" data-act="editLink" data-id="${l.id}">Edytuj</button><button class="btn sm red" data-act="delLink" data-id="${l.id}">Usuń</button></div></div>`).join('');
}
function vLinks() {
  return hdr('Moje linki') + `<input id="lq" placeholder="Szukaj w linkach…" data-live="links"><div id="list">${listLinks('')}</div>`;
}

/* --- Przepisy --- */
function listRecipes(q, favOnly) {
  let res = searchRecipes(q);
  if (favOnly) res = res.filter(x => x.r.fav);
  if (!res.length) return `<div class="muted card">${S.recipes.length ? 'Nic nie pasuje.' : 'Brak przepisów. Wklej tekst, link lub zdjęcie przepisu przyciskiem ＋ - AI zrobi z tego kartę.'}</div>`;
  return res.map(({ r, hit, of }) => `<div class="card tap" data-act="openRecipe" data-id="${r.id}"><div class="row">
    ${r.image ? `<img class="thumb sm" src="${esc(r.image)}" alt="" loading="lazy">` : '<div class="thumb sm"></div>'}
    <div class="grow"><h3>${r.fav ? '⭐ ' : ''}${esc(r.title)}</h3>
    <div class="muted">${r.servings ? r.servings + ' porcji · ' : ''}${r.groups.reduce((a, g) => a + g.items.length, 0)} składników${of ? ` · <span class=okc>masz ${hit}/${of}</span>` : ''}</div></div></div></div>`).join('');
}
let favOnly = false;
function vRecipes() {
  return hdr('Przepisy', false, `<button class="ibtn" data-act="toggleFav">${favOnly ? '⭐' : '☆'}</button>`) +
    `<input id="rq" placeholder="Szukaj lub: „co z jajek, mleka i mąki?”" data-live="recipes"><div id="list">${listRecipes('', favOnly)}</div>`;
}
function metaChips(r, f) {
  const c = [];
  if (r.servings) c.push('🍽 ' + Math.round(r.servings * f * 10) / 10 + ' porcji');
  if (r.total) c.push('⏱ łącznie ' + (r.total >= 60 ? Math.floor(r.total / 60) + ' h ' + (r.total % 60 ? r.total % 60 + ' min' : '') : r.total + ' min'));
  if (r.cook) c.push('🔥 pieczenie/gotowanie ' + r.cook + ' min');
  if (r.temp) c.push('🌡 ' + r.temp + '°C');
  return c.map(x => `<span class=chip>${esc(x.trim())}</span>`).join('');
}
function vRecipe(id) {
  const r = S.recipes.find(x => x.id === id);
  if (!r) return hdr('Przepis', true) + '<div class="muted">Nie znaleziono.</div>';
  const sc = [0.5, 1, 2, 3].map(k => `<button class="btn sm ${scale === k ? '' : 'ghost'}" data-act="setScale" data-k="${k}">×${String(k).replace('.', ',')}</button>`).join('');
  return hdr('', true, `<button class="star" data-act="favRecipe" data-id="${r.id}">${r.fav ? '⭐' : '☆'}</button>`) +
    (r.image ? `<img class="thumb" src="${esc(r.image)}" alt="">` : '') +
    `<h1 style="margin-top:10px">${esc(r.title)}</h1><div>${metaChips(r, scale)}</div>
    ${r.source ? `<div class="muted">Źródło: ${esc(domainOf(r.source) || r.source)}</div>` : ''}
    <div class="btns"><button class="btn block" data-act="toShop" data-id="${r.id}">🛒 Dodaj składniki do zakupów</button></div>
    <h2>Składniki</h2><div class="btns" style="margin:0 0 6px">${sc}</div>
    ${r.groups.map(g => `${g.name ? `<h3 style="margin-top:12px">${esc(g.name)}</h3>` : ''}<ul class="ing">${g.items.map(i => `<li>${esc(itemText(i, scale))}</li>`).join('')}</ul>`).join('')}
    <h2>Wykonanie</h2><ol class="steps">${r.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
    <div class="btns" style="margin-top:20px"><button class="btn ghost" data-act="editRecipe" data-id="${r.id}">✏️ Edytuj</button><button class="btn red" data-act="delRecipe" data-id="${r.id}">Usuń</button></div>`;
}

/* --- Zakupy --- */
function vShopping() {
  const items = S.shopping;
  const todo = items.filter(x => !x.done), done = items.filter(x => x.done);
  const row = x => `<div class="card row"><button class="check ${x.done ? 'on' : ''}" data-act="shopTick" data-id="${x.id}">${x.done ? '✓' : ''}</button>
    <div class="grow ${x.done ? 'done' : ''}">${esc(x.text)}${x.from ? `<div class="muted">${esc(x.from)}</div>` : ''}</div>
    <button class="ibtn" data-act="shopDel" data-id="${x.id}">✕</button></div>`;
  return hdr('Zakupy', false, done.length ? '<button class="ibtn" data-act="shopClear">Usuń kupione</button>' : '') +
    `<div class="row"><input id="newItem" placeholder="Dodaj produkt…" data-enter="shopAdd" style="margin:0"><button class="btn" data-act="shopAdd">Dodaj</button></div>
    <div style="margin-top:10px">${todo.map(row).join('') || '<div class="muted card">Lista pusta ✨</div>'}${done.length ? '<h2>Kupione</h2>' + done.map(row).join('') : ''}</div>`;
}

/* --- Więcej --- */
function vMore() {
  return hdr('Więcej') + `<div class="grid">
    <button class="tile" data-act="go" data-v="chat"><span>💬</span>Asystent AI</button>
    <button class="tile" data-act="go" data-v="plants"><span>🌿</span>Kwiaty</button>
    <button class="tile" data-act="go" data-v="events"><span>📅</span>Kalendarz</button>
    <button class="tile" data-act="go" data-v="notes"><span>📝</span>Notatki</button>
    <button class="tile" data-act="go" data-v="search"><span>🔎</span>Szukaj</button>
    <button class="tile" data-act="go" data-v="settings"><span>⚙️</span>Ustawienia</button></div>`;
}

/* --- Kwiaty --- */
function vPlants() {
  const cards = S.plants.map(p => {
    const d = plantDue(p);
    return `<div class="card">${p.img ? `<img class="thumb" src="${p.img}" alt="">` : ''}
      <h3 style="margin-top:8px">🌿 ${esc(p.name)}</h3>
      <div>${dueLabel(d.water, 'Podlewanie')}${p.fertDays ? ' · ' + dueLabel(d.fert, 'Nawożenie') : ''}</div>
      ${p.note ? `<div class="muted">${esc(p.note)}</div>` : ''}
      <div class="btns"><button class="btn sm" data-act="plantWater" data-id="${p.id}">💧 Podlane</button>
      ${p.fertDays ? `<button class="btn sm ghost" data-act="plantFert" data-id="${p.id}">🧪 Nawiezione</button>` : ''}
      <button class="btn sm ghost" data-act="editPlant" data-id="${p.id}">Edytuj</button></div></div>`;
  }).join('') || '<div class="muted card">Brak roślin. Dodaj pierwszą - możesz zrobić zdjęcie i poprosić AI o rozpoznanie.</div>';
  return hdr('Kwiaty', true, '<button class="btn sm" data-act="newPlant">＋ Roślina</button>') + cards;
}

/* --- Kalendarz --- */
function vEvents() {
  const td = today();
  const list = S.events.filter(e => e.date >= td || (e.kind === 'task' && !e.done))
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  let html = '', last = '';
  list.forEach(e => {
    if (e.date !== last) { html += `<h2>${e.date < td ? 'Zaległe' : e.date === td ? 'Dziś' : esc(plShort(e.date))}</h2>`; last = e.date; }
    html += `<div class="card row">${e.kind === 'task' ? `<button class="check ${e.done ? 'on' : ''}" data-act="evDone" data-id="${e.id}">${e.done ? '✓' : ''}</button>` : '<span>📅</span>'}
      <div class="grow ${e.done ? 'done' : ''}" data-act="editEvent" data-id="${e.id}">${esc(e.title)}${e.time ? ` <span class=muted>· ${esc(e.time)}</span>` : ''}${e.note ? `<div class="muted">${esc(e.note)}</div>` : ''}</div></div>`;
  });
  return hdr('Kalendarz', true, '<button class="btn sm" data-act="newEvent">＋ Dodaj</button>') + (html || '<div class="muted card">Brak nadchodzących wydarzeń i zadań.</div>');
}

/* --- Notatki --- */
function vNotes() {
  const ns = [...S.notes].sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0) || b.ts - a.ts);
  return hdr('Notatki', true, '<button class="btn sm" data-act="newNote">＋ Notatka</button>') +
    (ns.map(n => `<div class="card tap" data-act="editNote" data-id="${n.id}">${n.img ? `<img class="thumb" src="${n.img}" alt="" style="height:120px">` : ''}
      <div style="white-space:pre-wrap;margin-top:${n.img ? 8 : 0}px">${n.pin ? '📌 ' : ''}${esc((n.text || '').slice(0, 280))}</div>
      <div class="muted">${new Date(n.ts).toLocaleDateString('pl-PL')}</div></div>`).join('') || '<div class="muted card">Brak notatek.</div>');
}

/* --- Asystent --- */
function mdLite(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>'); }
function vChat() {
  const msgs = S.chat.map(m => `<div class="bubble ${m.role === 'user' ? 'me' : 'ai'}">${mdLite(m.text)}</div>`).join('') ||
    `<div class="muted card">Cześć ${esc(S.settings.name)}! Zapytaj mnie np. „gdzie zapisałam tamten przepis na rogaliki?”, „co mam dziś w planie?” albo poproś o pomoc w codziennych sprawach.${hasKey() ? '' : '<br><br><span class=warn>Najpierw dodaj klucz AI w Ustawieniach.</span>'}</div>`;
  return hdr('Asystent', true, '<button class="ibtn" data-act="chatClear">Wyczyść</button>') + msgs +
    `<div class="chatbar"><textarea id="chatIn" placeholder="Napisz wiadomość…" data-enter="chatSend"></textarea><button class="btn" data-act="chatSend">➤</button></div>`;
}
function buildContext() {
  const td = today();
  const c = [];
  c.push('Dzisiaj: ' + plDate(new Date()) + ' (' + td + '). Użytkownik: ' + S.settings.name + '.');
  c.push('WYDARZENIA/ZADANIA: ' + (S.events.filter(e => e.date >= td || (e.kind === 'task' && !e.done)).slice(0, 25).map(e => `${e.date} ${e.time || ''} ${e.title}${e.done ? ' [zrobione]' : ''}`).join('; ') || 'brak'));
  c.push('ZAKUPY: ' + (S.shopping.filter(x => !x.done).map(x => x.text).join('; ') || 'pusto'));
  c.push('PRZEPISY: ' + (S.recipes.map(r => `${r.title} (${r.groups.flatMap(g => g.items.map(i => i.n || i.raw)).slice(0, 12).join(', ')})`).join(' | ') || 'brak'));
  c.push('LINKI: ' + (S.links.slice(0, 60).map(l => `${l.title || ''} <${l.url}> ${(l.tags || []).join(',')}`).join(' | ') || 'brak'));
  c.push('NOTATKI: ' + (S.notes.slice(0, 40).map(n => (n.text || '').slice(0, 120).replace(/\n/g, ' ')).join(' | ') || 'brak'));
  c.push('ROŚLINY: ' + (S.plants.map(p => `${p.name} (podlewanie co ${p.waterDays} d, ostatnio ${p.lastWater || '?'})`).join('; ') || 'brak'));
  return c.join('\n').slice(0, 14000);
}

/* --- Ustawienia --- */
function vSettings() {
  return hdr('Ustawienia', true) + `<div class="card">
    <label>Twoje imię (powitanie)</label><input id="sName" value="${esc(S.settings.name)}">
    <label>Klucz API Claude (do funkcji AI)</label><input id="sKey" type="password" value="${esc(S.settings.apiKey)}" placeholder="sk-ant-…">
    <label>Model</label><input id="sModel" value="${esc(S.settings.model)}">
    <button class="btn block" data-act="saveSettings">Zapisz</button>
    <p class="muted">Klucz jest zapisany tylko na tym telefonie. Bez klucza aplikacja nadal działa - przepisy rozpoznaje prostszym, lokalnym parserem.</p></div>
    <div class="card"><h3>Kopia zapasowa</h3><div class="btns"><button class="btn ghost" data-act="exportData">Skopiuj dane do schowka</button><button class="btn ghost" data-act="importData">Wczytaj z kopii</button></div></div>`;
}

/* --- Szukaj wszędzie --- */
function globalSearch(q) {
  q = (q || '').toLowerCase().trim(); if (!q) return [];
  const out = [];
  const has = s => String(s || '').toLowerCase().includes(q);
  S.recipes.forEach(r => { if (has(r.title) || r.groups.some(g => g.items.some(i => has(i.raw)))) out.push({ t: '🍳 Przepis', title: r.title, act: 'openRecipe', id: r.id }); });
  S.links.forEach(l => { if (has(l.title) || has(l.url) || has(l.note) || (l.tags || []).some(has)) out.push({ t: '🔗 Link', title: l.title || l.url, act: 'openLink', id: l.id }); });
  S.notes.forEach(n => { if (has(n.text)) out.push({ t: '📝 Notatka', title: (n.text || '').slice(0, 80), act: 'editNote', id: n.id }); });
  S.plants.forEach(p => { if (has(p.name)) out.push({ t: '🌿 Roślina', title: p.name, act: 'plantsGo', id: p.id }); });
  S.events.forEach(e => { if (has(e.title)) out.push({ t: '📅 Wydarzenie', title: e.title + ' (' + e.date + ')', act: 'editEvent', id: e.id }); });
  S.shopping.forEach(x => { if (has(x.text)) out.push({ t: '🛒 Zakupy', title: x.text, act: 'tab', v: 'shopping' }); });
  return out;
}
function vSearch(q) {
  const res = globalSearch(q);
  return hdr('Szukaj', true) + `<input id="gq" value="${esc(q || '')}" placeholder="Szukaj…" data-enter="gsearch2">` +
    (q ? (res.map(r => `<div class="card tap" data-act="${r.act}" data-id="${r.id || ''}" data-v="${r.v || ''}"><div class="muted">${r.t}</div>${esc(r.title)}</div>`).join('') || '<div class="muted card">Nic nie znaleziono.</div>') : '');
}

/* =====================  ROUTER  ===================== */
const VIEWS = { start: vStart, links: vLinks, recipes: vRecipes, recipe: vRecipe, shopping: vShopping, more: vMore, plants: vPlants, events: vEvents, notes: vNotes, chat: vChat, settings: vSettings, search: vSearch };
function render() {
  $('#view').innerHTML = VIEWS[route.v](route.p);
  const m = { start: 'start', links: 'links', recipes: 'recipes', recipe: 'recipes', shopping: 'shopping' }[route.v] || 'more';
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.t === m));
  $('#fab').classList.toggle('hidden', route.v === 'chat' || route.v === 'settings');
  if (route.v === 'chat') window.scrollTo(0, document.body.scrollHeight);
}
function go(v, p) { stack.push(route); route = { v, p }; render(); window.scrollTo(0, 0); }
function back() { route = stack.pop() || { v: 'start' }; render(); }
function tab(v) { stack = []; route = { v }; render(); window.scrollTo(0, 0); }

/* =====================  DODAWANIE  ===================== */
function openAdd(prefill) {
  pendingImg = null;
  sheet(`<h1 style="font-size:22px">Dodaj do aplikacji</h1>
    <p class="muted">Wklej link, przepis, notatkę, listę zakupów… albo dodaj zdjęcie. AI rozpozna, co to jest, i zapisze we właściwym miejscu.</p>
    <textarea id="addText" placeholder="Wklej tutaj…">${esc(prefill || '')}</textarea>
    <div id="addImgBox"></div>
    <div class="btns"><button class="btn ghost" data-act="addPhoto">📷 Zdjęcie</button><button class="btn" data-act="addGo" style="flex:1">Rozpoznaj i zapisz</button></div>
    <div class="btns"><button class="btn red" data-act="closeSheet">Anuluj</button></div>`);
  if (prefill) setTimeout(() => handleAdd(prefill, null), 100);
}

async function handleAdd(text, img) {
  text = (text || '').trim();
  if (!text && !img) { toast('Wklej coś albo dodaj zdjęcie'); return; }
  busy(true, 'Analizuję…');
  try {
    const url = (text.match(/https?:\/\/\S+/) || [])[0];
    if (url && !img && text.replace(url, '').trim().length < 60) { await handleUrl(url, text.replace(url, '').trim()); return; }
    if (!hasKey()) {
      if (img) { addNote(text, img); toast('Zdjęcie zapisane jako notatka - do rozpoznawania dodaj klucz AI w Ustawieniach'); return; }
      if (looksLikeRecipe(text)) { openRecipeEditor(parseRecipeText(text), true); return; }
      if (text.split(/\n/).length >= 2 && text.split(/\n/).every(l => l.trim().length < 50)) { /* lista -> notatka */ }
      addNote(text); return;
    }
    const ai = await aiAnalyze(text, img);
    routeAI(ai, text, img);
  } catch (e) {
    toast('Błąd: ' + (e.message || e));
  } finally { busy(false); }
}

async function handleUrl(url, extra) {
  let html = '';
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36', 'Accept-Language': 'pl,en;q=0.8' } });
    html = await r.text();
  } catch (e) { html = ''; }
  const rec = html && recipeFromHtml(html, url);
  if (rec) { openRecipeEditor(rec, true); return; }
  const title = html ? decodeHtml(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim()) : '';
  if (hasKey() && html) {
    try {
      const ai = await aiAnalyze('Adres: ' + url + '\nTytuł: ' + title + '\n' + htmlToText(html).slice(0, 12000));
      if (ai.type === 'recipe' && ai.recipe) { const r = aiToRecipe(ai.recipe); r.source = url; openRecipeEditor(r, true); return; }
      addLink({ url, title: (ai.link && ai.link.title) || title, tags: (ai.link && ai.link.tags) || [], note: extra });
      return;
    } catch (e) { /* zapisz zwykły link */ }
  }
  addLink({ url, title: title || domainOf(url), tags: [], note: extra });
}

function routeAI(ai, text, img) {
  switch (ai.type) {
    case 'recipe':
      if (ai.recipe) { const r = aiToRecipe(ai.recipe); if (img && !r.image) r.image = img; openRecipeEditor(r, true); return; }
      break;
    case 'link': {
      const url = (text.match(/https?:\/\/\S+/) || [''])[0];
      addLink({ url, title: (ai.link && ai.link.title) || text.slice(0, 60), tags: (ai.link && ai.link.tags) || [], note: '' }); return;
    }
    case 'plant':
      if (ai.plant) { closeSheet(); go('plants'); openPlantEditor({ name: ai.plant.name, waterDays: ai.plant.water_days || 7, fertDays: ai.plant.fertilize_days || 30, note: ai.plant.tip || '', img: img || '' }); return; }
      break;
    case 'event':
      if (ai.event) { closeSheet(); openEventEditor({ title: ai.event.title, date: ai.event.date || today(), time: ai.event.time || '', kind: 'event' }, true); return; }
      break;
    case 'shopping':
      if (ai.shopping && ai.shopping.length) {
        ai.shopping.forEach(t => S.shopping.push({ id: uid(), text: t, done: false, from: '' })); save(); closeSheet();
        toast('Dodano do zakupów: ' + ai.shopping.length); tab('shopping'); return;
      }
      break;
  }
  addNote((ai.note && ai.note.text) || text, img);
}
function addLink(o) {
  S.links.unshift({ id: uid(), url: o.url, title: o.title, tags: o.tags || [], note: o.note || '', ts: Date.now() });
  save(); closeSheet(); toast('Zapisano w „Moje linki”'); tab('links');
}
function addNote(text, img) {
  S.notes.unshift({ id: uid(), text, img: img || '', pin: false, ts: Date.now() });
  save(); closeSheet(); toast('Zapisano notatkę'); go('notes');
}

/* =====================  EDYTOR PRZEPISU  ===================== */
function ingToText(groups) {
  return groups.map(g => (g.name ? '# ' + g.name + '\n' : '') + g.items.map(i => itemText(i, 1)).join('\n')).join('\n');
}
function textToGroups(t) {
  const groups = []; let cur = null;
  t.split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(l => {
    if (l.startsWith('#')) { cur = { name: l.replace(/^#+\s*/, ''), items: [] }; groups.push(cur); return; }
    if (!cur) { cur = { name: '', items: [] }; groups.push(cur); }
    cur.items.push(parseIngredient(l));
  });
  return groups.filter(g => g.items.length);
}
function openRecipeEditor(r, isNew) {
  draft = JSON.parse(JSON.stringify(r)); draft._new = !!isNew;
  if (!draft.imgs) draft.imgs = [];
  sheet(`<h1 style="font-size:22px">${isNew ? 'Sprawdź przepis' : 'Edytuj przepis'}</h1>
    ${isNew ? '<p class="muted">AI/parser rozpoznał przepis. Popraw, jeśli coś się nie zgadza, i zapisz.</p>' : ''}
    <div id="rimg" class="rimg"></div>
    <div class="btns"><button class="btn sm ghost" data-act="imgNext">🔄 Inne zdjęcie z internetu</button><button class="btn sm ghost" data-act="imgOwn">📷 Własne</button><button class="btn sm red" data-act="imgNone">Bez zdjęcia</button></div>
    <label>Nazwa</label><input id="rTitle" value="${esc(draft.title)}">
    <div class="cols3"><div><label>Porcje</label><input id="rServ" inputmode="numeric" value="${draft.servings || ''}"></div>
    <div><label>Temp. °C</label><input id="rTemp" inputmode="numeric" value="${draft.temp || ''}"></div>
    <div><label>Pieczenie min</label><input id="rCook" inputmode="numeric" value="${draft.cook || ''}"></div></div>
    <label>Czas łączny (min)</label><input id="rTotal" inputmode="numeric" value="${draft.total || ''}">
    <label>Składniki (podgrupy zaczynaj od „# Nazwa”)</label><textarea id="rIng" style="min-height:170px">${esc(ingToText(draft.groups))}</textarea>
    <label>Wykonanie (jeden krok w linii)</label><textarea id="rSteps" style="min-height:170px">${esc(draft.steps.join('\n'))}</textarea>
    <div class="btns"><button class="btn" data-act="saveRecipe" style="flex:1">Zapisz przepis</button><button class="btn red" data-act="closeSheet">Anuluj</button></div>`);
  paintRecipeImg();
  if (!draft.image) loadDraftImages();
}
function paintRecipeImg() {
  const b = $('#rimg'); if (!b) return;
  b.innerHTML = draft.image ? `<img class="thumb" src="${esc(draft.image)}" alt="" onerror="this.style.display='none'">` : '<div class="muted card">Szukam zdjęcia w internecie…</div>';
}
async function loadDraftImages() {
  const q = draft.imageQuery || draft.title;
  const imgs = await findImages(q);
  if (!draft) return;
  draft.imgs = imgs; draft._i = 0;
  if (!draft.image && imgs.length) draft.image = imgs[0];
  if (!imgs.length && $('#rimg') && !draft.image) $('#rimg').innerHTML = '<div class="muted card">Nie znaleziono zdjęcia - dodaj własne.</div>';
  else paintRecipeImg();
}
function readDraftFields() {
  draft.title = val('rTitle') || 'Przepis';
  draft.servings = parseInt(val('rServ')) || null;
  draft.temp = parseInt(val('rTemp')) || null;
  draft.cook = parseInt(val('rCook')) || null;
  draft.total = parseInt(val('rTotal')) || null;
  draft.groups = textToGroups($('#rIng').value);
  draft.steps = $('#rSteps').value.split(/\n/).map(s => s.trim()).filter(Boolean);
}
function saveDraftRecipe() {
  readDraftFields();
  const dup = findDuplicate(draft);
  if (dup && !confirm('Podobny przepis już istnieje: „' + dup.title + '”. Zapisać mimo to?')) return;
  const r = Object.assign({}, draft); delete r._new; delete r._i; delete r.imgs; delete r.imageQuery;
  const i = S.recipes.findIndex(x => x.id === r.id);
  if (i >= 0) S.recipes[i] = r; else S.recipes.unshift(r);
  save(); draft = null; closeSheet(); toast('Zapisano w „Przepisy”');
  if (route.v === 'recipe') render(); else { stack = []; route = { v: 'recipes' }; render(); }
}

/* =====================  EDYTORY: roślina / wydarzenie / notatka / link  ===================== */
let plantDraftImg = '';
function openPlantEditor(p) {
  p = p || {}; plantDraftImg = p.img || '';
  sheet(`<h1 style="font-size:22px">${p.id ? 'Edytuj roślinę' : 'Nowa roślina'}</h1>
    <div id="pImg">${plantDraftImg ? `<img class="thumb" src="${plantDraftImg}" alt="">` : ''}</div>
    <div class="btns"><button class="btn sm ghost" data-act="plantPhoto">📷 Zdjęcie</button><button class="btn sm ghost" data-act="plantAI">🤖 Rozpoznaj (AI)</button></div>
    <input type="hidden" id="pId" value="${p.id || ''}">
    <label>Nazwa</label><input id="pName" value="${esc(p.name || '')}">
    <div class="cols2"><div><label>Podlewanie co (dni)</label><input id="pWater" inputmode="numeric" value="${p.waterDays || 7}"></div>
    <div><label>Nawożenie co (dni, 0 = brak)</label><input id="pFert" inputmode="numeric" value="${p.fertDays == null ? 30 : p.fertDays}"></div></div>
    <label>Notatka</label><textarea id="pNote" style="min-height:70px">${esc(p.note || '')}</textarea>
    <div class="btns"><button class="btn" data-act="savePlant" style="flex:1">Zapisz</button>${p.id ? `<button class="btn red" data-act="delPlant" data-id="${p.id}">Usuń</button>` : ''}<button class="btn red" data-act="closeSheet">Anuluj</button></div>`);
}
function openEventEditor(e, isNew) {
  e = e || { kind: 'event', date: today() };
  sheet(`<h1 style="font-size:22px">${e.id ? 'Edytuj' : 'Nowe wydarzenie / zadanie'}</h1>
    <input type="hidden" id="eId" value="${e.id || ''}">
    <label>Tytuł</label><input id="eTitle" value="${esc(e.title || '')}">
    <div class="cols2"><div><label>Data</label><input id="eDate" type="date" value="${esc(e.date || today())}"></div>
    <div><label>Godzina</label><input id="eTime" type="time" value="${esc(e.time || '')}"></div></div>
    <div class="cols2"><div><label>Rodzaj</label><select id="eKind"><option value="event" ${e.kind !== 'task' ? 'selected' : ''}>Wydarzenie</option><option value="task" ${e.kind === 'task' ? 'selected' : ''}>Zadanie</option></select></div>
    <div><label>Przypomnienie</label><select id="eRemind">${[['-1', 'brak'], ['0', 'o czasie'], ['10', '10 min wcześniej'], ['30', '30 min wcześniej'], ['60', '1 h wcześniej'], ['1440', '1 dzień wcześniej']].map(o => `<option value="${o[0]}" ${String(e.remind == null ? '0' : e.remind) === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select></div></div>
    <label>Notatka</label><input id="eNote" value="${esc(e.note || '')}">
    <div class="btns"><button class="btn" data-act="saveEvent" style="flex:1">Zapisz</button>${e.id ? `<button class="btn red" data-act="delEvent" data-id="${e.id}">Usuń</button>` : ''}<button class="btn red" data-act="closeSheet">Anuluj</button></div>`);
}
function scheduleEvent(e) {
  unnotify('ev' + e.id);
  if (e.remind == null || e.remind < 0 || e.done) return;
  const at = new Date(e.date + 'T' + (e.time || '09:00') + ':00');
  at.setMinutes(at.getMinutes() - e.remind);
  notify('ev' + e.id, e.kind === 'task' ? 'Zadanie' : 'Wydarzenie', e.title, at);
}
function openNoteEditor(n) {
  n = n || {};
  sheet(`<h1 style="font-size:22px">${n.id ? 'Notatka' : 'Nowa notatka'}</h1>
    <input type="hidden" id="nId" value="${n.id || ''}">
    <textarea id="nText" style="min-height:200px" placeholder="Pisz…">${esc(n.text || '')}</textarea>
    <div class="btns"><button class="btn" data-act="saveNote" style="flex:1">Zapisz</button>${n.id ? `<button class="btn ghost" data-act="pinNote" data-id="${n.id}">${n.pin ? 'Odepnij' : '📌 Przypnij'}</button><button class="btn red" data-act="delNote" data-id="${n.id}">Usuń</button>` : ''}<button class="btn red" data-act="closeSheet">Anuluj</button></div>`);
}
function openLinkEditor(l) {
  sheet(`<h1 style="font-size:22px">Edytuj link</h1>
    <input type="hidden" id="lId" value="${l.id}">
    <label>Tytuł</label><input id="lTitle" value="${esc(l.title || '')}">
    <label>Adres</label><input id="lUrl" value="${esc(l.url || '')}">
    <label>Tagi (po przecinku)</label><input id="lTags" value="${esc((l.tags || []).join(', '))}">
    <label>Notatka</label><input id="lNote" value="${esc(l.note || '')}">
    <div class="btns"><button class="btn" data-act="saveLink" style="flex:1">Zapisz</button><button class="btn red" data-act="closeSheet">Anuluj</button></div>`);
}

/* =====================  AKCJE (delegacja kliknięć)  ===================== */
const byId = (arr, id) => arr.find(x => x.id === id);
const A = {
  tab: (d) => tab(d.v),
  go: (d) => go(d.v),
  back: () => back(),
  plantsGo: () => go('plants'),
  add: () => openAdd(''),
  closeSheet: () => { draft = null; closeSheet(); },
  addPhoto: async () => {
    const img = await pickImage(1200); if (!img) return;
    pendingImg = img; $('#addImgBox').innerHTML = `<img class="thumb" src="${img}" alt="" style="height:140px;margin-bottom:8px">`;
  },
  addGo: () => handleAdd(val('addText'), pendingImg),
  gsearch: () => { const q = val('gsearch'); go('search', q); },
  gsearch2: () => { route.p = val('gq'); render(); },

  /* linki */
  openLink: (d) => { const l = byId(S.links, d.id); if (l && l.url) window.open(l.url, '_blank'); },
  editLink: (d) => openLinkEditor(byId(S.links, d.id)),
  saveLink: () => {
    const l = byId(S.links, val('lId')); if (!l) return;
    l.title = val('lTitle'); l.url = val('lUrl'); l.tags = val('lTags').split(',').map(s => s.trim()).filter(Boolean); l.note = val('lNote');
    save(); closeSheet(); render();
  },
  delLink: (d) => { if (confirm('Usunąć link?')) { S.links = S.links.filter(l => l.id !== d.id); save(); render(); } },

  /* przepisy */
  toggleFav: () => { favOnly = !favOnly; render(); },
  openRecipe: (d) => { scale = 1; go('recipe', d.id); },
  setScale: (d) => { scale = parseFloat(d.k); render(); },
  favRecipe: (d) => { const r = byId(S.recipes, d.id); r.fav = !r.fav; save(); render(); },
  editRecipe: (d) => openRecipeEditor(byId(S.recipes, d.id), false),
  delRecipe: (d) => { if (confirm('Usunąć przepis?')) { S.recipes = S.recipes.filter(r => r.id !== d.id); save(); back(); } },
  saveRecipe: () => saveDraftRecipe(),
  imgNext: () => { if (!draft) return; if (!draft.imgs.length) { loadDraftImages(); return; } draft._i = ((draft._i || 0) + 1) % draft.imgs.length; draft.image = draft.imgs[draft._i]; paintRecipeImg(); },
  imgOwn: async () => { const i = await pickImage(900); if (i && draft) { draft.image = i; paintRecipeImg(); } },
  imgNone: () => { if (draft) { draft.image = ''; draft.imgs = []; const b = $('#rimg'); if (b) b.innerHTML = ''; } },
  toShop: (d) => {
    const r = byId(S.recipes, d.id); let n = 0;
    r.groups.forEach(g => g.items.forEach(i => {
      const t = itemText(i, scale);
      if (!S.shopping.some(x => !x.done && x.text.toLowerCase() === t.toLowerCase())) { S.shopping.push({ id: uid(), text: t, done: false, from: r.title }); n++; }
    }));
    save(); toast(n ? 'Dodano ' + n + ' składników do zakupów' : 'Wszystko już jest na liście');
  },

  /* zakupy */
  shopAdd: () => { const t = val('newItem'); if (!t) return; S.shopping.push({ id: uid(), text: t, done: false, from: '' }); save(); render(); const e = $('#newItem'); if (e) e.focus(); },
  shopTick: (d) => { const x = byId(S.shopping, d.id); x.done = !x.done; save(); render(); },
  shopDel: (d) => { S.shopping = S.shopping.filter(x => x.id !== d.id); save(); render(); },
  shopClear: () => { S.shopping = S.shopping.filter(x => !x.done); save(); render(); },

  /* rośliny */
  newPlant: () => openPlantEditor(),
  editPlant: (d) => openPlantEditor(byId(S.plants, d.id)),
  plantPhoto: async () => { const i = await pickImage(800); if (i) { plantDraftImg = i; $('#pImg').innerHTML = `<img class="thumb" src="${i}" alt="">`; } },
  plantAI: async () => {
    if (!plantDraftImg) { toast('Najpierw dodaj zdjęcie'); return; }
    if (!hasKey()) { toast('Dodaj klucz AI w Ustawieniach'); return; }
    busy(true, 'Rozpoznaję roślinę…');
    try {
      const out = await claude({ system: 'Rozpoznajesz rośliny doniczkowe ze zdjęć. Odpowiedz WYŁĄCZNIE JSON-em: {"name":"polska nazwa","water_days":7,"fertilize_days":30,"tip":"krótka wskazówka pielęgnacji"}', messages: [{ role: 'user', content: [imgBlock(plantDraftImg), { type: 'text', text: 'Jaka to roślina? Podaj typowe odstępy podlewania i nawożenia.' }] }], max: 500 });
      const j = extractJSON(out);
      $('#pName').value = j.name || ''; $('#pWater').value = j.water_days || 7; $('#pFert').value = j.fertilize_days == null ? 30 : j.fertilize_days; $('#pNote').value = j.tip || '';
    } catch (e) { toast('Błąd: ' + e.message); } finally { busy(false); }
  },
  savePlant: () => {
    const name = val('pName'); if (!name) { toast('Podaj nazwę'); return; }
    let p = byId(S.plants, val('pId'));
    if (!p) { p = { id: uid(), lastWater: today(), lastFert: today() }; S.plants.push(p); }
    p.name = name; p.waterDays = parseInt(val('pWater')) || 7; p.fertDays = parseInt(val('pFert')) || 0; p.note = val('pNote'); p.img = plantDraftImg;
    save(); schedulePlant(p); closeSheet(); if (route.v !== 'plants') go('plants'); else render();
  },
  delPlant: (d) => { if (confirm('Usunąć roślinę?')) { unnotify('pw' + d.id); unnotify('pf' + d.id); S.plants = S.plants.filter(p => p.id !== d.id); save(); closeSheet(); render(); } },
  plantWater: (d) => { const p = byId(S.plants, d.id); p.lastWater = today(); save(); schedulePlant(p); toast('Podlane 💧'); render(); },
  plantFert: (d) => { const p = byId(S.plants, d.id); p.lastFert = today(); save(); schedulePlant(p); toast('Nawiezione 🧪'); render(); },

  /* kalendarz */
  newEvent: () => openEventEditor(),
  editEvent: (d) => openEventEditor(byId(S.events, d.id)),
  saveEvent: () => {
    const title = val('eTitle'); if (!title) { toast('Podaj tytuł'); return; }
    let e = byId(S.events, val('eId'));
    if (!e) { e = { id: uid(), done: false }; S.events.push(e); }
    e.title = title; e.date = val('eDate') || today(); e.time = val('eTime'); e.kind = val('eKind'); e.remind = parseInt(val('eRemind')); e.note = val('eNote');
    save(); scheduleEvent(e); closeSheet(); if (route.v === 'events') render(); else go('events');
  },
  delEvent: (d) => { unnotify('ev' + d.id); S.events = S.events.filter(e => e.id !== d.id); save(); closeSheet(); render(); },
  evDone: (d) => { const e = byId(S.events, d.id); e.done = !e.done; save(); scheduleEvent(e); render(); },

  /* notatki */
  newNote: () => openNoteEditor(),
  editNote: (d) => openNoteEditor(byId(S.notes, d.id)),
  saveNote: () => {
    const t = val('nText'); if (!t) { closeSheet(); return; }
    let n = byId(S.notes, val('nId'));
    if (!n) { n = { id: uid(), pin: false, ts: Date.now() }; S.notes.unshift(n); }
    n.text = t; save(); closeSheet(); if (route.v === 'notes') render(); else go('notes');
  },
  pinNote: (d) => { const n = byId(S.notes, d.id); n.pin = !n.pin; save(); closeSheet(); render(); },
  delNote: (d) => { if (confirm('Usunąć notatkę?')) { S.notes = S.notes.filter(n => n.id !== d.id); save(); closeSheet(); render(); } },

  /* asystent */
  chatClear: () => { S.chat = []; save(); render(); },
  chatSend: async () => {
    const t = val('chatIn'); if (!t) return;
    if (!hasKey()) { toast('Dodaj klucz AI w Ustawieniach'); return; }
    S.chat.push({ role: 'user', text: t }); save(); render();
    busy(true, 'Myślę…');
    try {
      const msgs = S.chat.slice(-12).map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
      while (msgs.length && msgs[0].role !== 'user') msgs.shift();
      const out = await claude({
        system: 'Jesteś ciepłym, zwięzłym asystentem osobistym w aplikacji „Mój Dzień”. Odpowiadasz po polsku. Masz dostęp do danych użytkownika (poniżej) - korzystaj z nich, gdy pytanie dotyczy jej/jego planów, przepisów, linków, notatek, zakupów czy roślin; gdy czegoś nie ma w danych, powiedz to wprost.\n\nDANE UŻYTKOWNIKA:\n' + buildContext(),
        messages: msgs, max: 1500
      });
      S.chat.push({ role: 'assistant', text: out });
    } catch (e) { S.chat.push({ role: 'assistant', text: 'Błąd: ' + e.message }); }
    finally { busy(false); save(); render(); }
  },

  /* ustawienia */
  saveSettings: () => { S.settings.name = val('sName') || 'Ania'; S.settings.apiKey = val('sKey'); S.settings.model = val('sModel') || 'claude-sonnet-5-5'; save(); toast('Zapisano'); },
  exportData: async () => { try { await navigator.clipboard.writeText(JSON.stringify(S)); toast('Skopiowano - wklej do notatki/maila'); } catch (e) { toast('Nie udało się skopiować'); } },
  importData: () => sheet(`<h1 style="font-size:22px">Wczytaj kopię</h1><p class="muted">Wklej skopiowane dane. Zastąpią obecne.</p><textarea id="impText"></textarea><div class="btns"><button class="btn" data-act="doImport">Wczytaj</button><button class="btn red" data-act="closeSheet">Anuluj</button></div>`),
  doImport: () => { try { const j = JSON.parse(val('impText')); S = Object.assign(JSON.parse(JSON.stringify(DEF)), j); save(); closeSheet(); tab('start'); toast('Wczytano'); } catch (e) { toast('Niepoprawne dane'); } }
};

function init() {
  S = load();
  document.addEventListener('click', ev => {
    if (ev.target.id === 'sheet') { draft = null; closeSheet(); return; }
    const t = ev.target.closest('[data-act]');
    if (!t) return;
    const f = A[t.dataset.act]; if (f) f(t.dataset, t, ev);
  });
  document.addEventListener('input', ev => {
    const live = ev.target.dataset && ev.target.dataset.live;
    if (live === 'links') $('#list').innerHTML = listLinks(ev.target.value);
    if (live === 'recipes') $('#list').innerHTML = listRecipes(ev.target.value, favOnly);
  });
  document.addEventListener('keydown', ev => {
    const en = ev.target.dataset && ev.target.dataset.enter;
    if (en && ev.key === 'Enter' && !(ev.shiftKey && en === 'chatSend')) { ev.preventDefault(); A[en](); }
  });
  window.onShared = () => { const t = window.__shared; window.__shared = null; if (t) { render(); openAdd(t); } };
  render();
  if (window.__shared) window.onShared();
  // przypomnienia o roślinach po starcie (np. po restarcie telefonu)
  S.plants.forEach(schedulePlant);
}

if (typeof document !== 'undefined') init();
if (typeof module !== 'undefined') module.exports = { parseRecipeText, parseIngredient, itemText, looksLikeRecipe, searchRecipes: null };
