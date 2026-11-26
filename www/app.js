'use strict';
/* =====================  Mój Dzień  =====================
   Jeden plik z całą logiką aplikacji (bez bundlera).
   Dane: localStorage. AI: Claude API (klucz w Ustawieniach).
   ======================================================= */

const KEY = 'mojdzien.v1';
const APP_VERSION = (typeof window !== 'undefined' && window.APP_VERSION) || 'dev';
const APP_DATE = (typeof window !== 'undefined' && window.APP_DATE) || '';
const APP_CFG = (typeof window !== 'undefined' && window.APP_CONFIG) || {};
const DEF = {
  settings: { name: 'Ania', provider: 'anthropic', apiKey: '', model: 'claude-sonnet-5-5', baseUrl: '' },
  links: [], recipes: [], shopping: [], expenses: [], budget: { limit: 0, cats: {} }, plants: [], events: [], notes: [], chat: []
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
function aiCfg() {
  const st = S.settings, own = !!st.apiKey;
  return {
    provider: own ? (st.provider || 'anthropic') : (APP_CFG.provider || st.provider || 'anthropic'),
    apiKey: st.apiKey || APP_CFG.apiKey || '',
    model: own ? st.model : (APP_CFG.model || st.model),
    baseUrl: own ? st.baseUrl : (APP_CFG.baseUrl || st.baseUrl)
  };
}
const hasKey = () => !!(S && (aiCfg().apiKey || (APP_CFG.fallbacks || []).some(f => f.apiKey)));

function load() {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) || 'null');
    const base = JSON.parse(JSON.stringify(DEF));
    return r ? Object.assign(base, r, { settings: Object.assign(base.settings, r.settings || {}) }) : base;
  } catch (e) { return JSON.parse(JSON.stringify(DEF)); }
}
const DRAFT_KEY = 'mojdzien.draft';
let idbP = null;
function idb() {
  if (idbP) return idbP;
  idbP = new Promise((res, rej) => {
    try {
      const q = indexedDB.open('mojdzien', 1);
      q.onupgradeneeded = () => q.result.createObjectStore('kv');
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    } catch (e) { rej(e); }
  });
  idbP.catch(() => { idbP = null; });
  return idbP;
}
function idbOp(mode, fn) {
  return idb().then(db => new Promise((res, rej) => {
    const tx = db.transaction('kv', mode), st = tx.objectStore('kv'); const r = fn(st);
    tx.oncomplete = () => res(r && r.result); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
  }));
}
const idbGet = k => idbOp('readonly', st => st.get(k));
const idbSet = (k, v) => idbOp('readwrite', st => st.put(v, k));
const idbDel = k => idbOp('readwrite', st => st.delete(k));
const idbKeys = () => idbOp('readonly', st => st.getAllKeys());
let idbTimer = null;
function mirrorSoon() {
  clearTimeout(idbTimer);
  idbTimer = setTimeout(async () => {
    try {
      const json = JSON.stringify(S);
      await idbSet('state', json);
      const day = 'backup-' + ymd(new Date());
      const keys = await idbKeys();
      if (!keys.includes(day)) {
        await idbSet(day, json);
        const old = keys.filter(k => /^backup-/.test(k)).sort();
        for (const k of old.slice(0, Math.max(0, old.length + 1 - 7))) await idbDel(k);
      }
    } catch (e) { /* kopia w IndexedDB jest dodatkiem */ }
  }, 800);
}
function save() {
  S.savedAt = Date.now();
  let ok = true;
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { ok = false; toast('Brak miejsca w pamięci telefonu - zapisano kopię awaryjną'); }
  mirrorSoon();
  return ok;
}
function hasData(o) { return !!o && ['links', 'recipes', 'shopping', 'plants', 'events', 'notes', 'chat'].some(k => (o[k] || []).length); }
/* po starcie: jeśli localStorage jest pusty/starszy niż kopia w IndexedDB (np. system go wyczyścił), odzyskaj dane */
async function recoverFromIdb() {
  try {
    const json = await idbGet('state'); if (!json) return;
    const o = JSON.parse(json);
    if (!hasData(o)) return;
    if (!hasData(S) || (o.savedAt || 0) > (S.savedAt || 0) + 1000) {
      S = Object.assign(JSON.parse(JSON.stringify(DEF)), o, { settings: Object.assign({}, DEF.settings, o.settings || {}) });
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
      render(); toast('Przywrócono dane z kopii zapasowej');
    }
  } catch (e) {}
}
async function listBackups() { try { return (await idbKeys()).filter(k => /^backup-/.test(k)).sort().reverse(); } catch (e) { return []; } }
function saveDraftSoon() {
  if (!draft) return;
  try {
    readDraftFields();
    const d = Object.assign({}, draft); delete d.imgs;
    if (d.image && d.image.length > 1500000) delete d.image;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
  } catch (e) {}
}
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} }

function xfetch(url, opts, ms) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = setTimeout(() => ctl && ctl.abort(), ms || 60000);
  return fetch(url, Object.assign({}, opts || {}, ctl ? { signal: ctl.signal } : {}))
    .catch(e => { throw new Error(e && e.name === 'AbortError' ? 'Przekroczono czas oczekiwania - sprawdź internet i spróbuj ponownie' : 'Brak połączenia z internetem'); })
    .finally(() => clearTimeout(t));
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}
function busy(on, txt) { $('#busyText').textContent = txt || 'Chwila…'; $('#busy').classList.toggle('hidden', !on); }
function sheet(html) { $('#panel').innerHTML = html; $('#sheet').classList.remove('hidden'); try { addMics(); } catch (e) {} }
function dismissSheet() {
  if (draft && !confirm('Odrzucić niezapisany przepis?')) return;
  draft = null; clearDraft(); closeSheet();
}
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
let chanReady = false;
async function ensureChannel(p) {
  if (chanReady) return;
  try { await p.deleteChannel({ id: 'mojdzien_alerts' }); } catch (e) {}
  try { await p.createChannel({ id: 'mojdzien_alerts_v2', name: 'Przypomnienia', description: 'Wydarzenia, zadania i podlewanie', importance: 4, sound: 'mojdzien_cowbell.wav', vibration: true, visibility: 1 }); } catch (e) {}
  chanReady = true;
}
async function notify(key, title, body, at) {
  const p = LN(); if (!p || !(at > new Date())) return;
  try {
    const perm = await p.requestPermissions();
    if (perm.display !== 'granted') return;
    await ensureChannel(p);
    await p.cancel({ notifications: [{ id: nid(key) }] });
    await p.schedule({ notifications: [{ id: nid(key), title, body, channelId: 'mojdzien_alerts_v2', sound: 'mojdzien_cowbell.wav', smallIcon: 'ic_stat_mojdzien', largeIcon: 'ic_notif_large', iconColor: '#EE7A38', schedule: { at, allowWhileIdle: true } }] });
  } catch (e) { /* brak zgody / brak natywnego środowiska */ }
}
async function unnotify(key) { const p = LN(); if (p) { try { await p.cancel({ notifications: [{ id: nid(key) }] }); } catch (e) {} } }

/* ---------- obrazy ---------- */
function fileToDataUrl(file, max, q) {
  max = max || 900; q = q || 0.7;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('Zdjęcie wczytuje się zbyt długo')), 25000);
    const done = (img, url) => {
      try {
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        const k = Math.min(1, max / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        let out = c.toDataURL('image/jpeg', q);
        if (out.length > 450000) out = c.toDataURL('image/jpeg', 0.55);
        c.width = c.height = 1;
        clearTimeout(timer); if (url) URL.revokeObjectURL(url); res(out);
      } catch (e) { clearTimeout(timer); rej(e); }
    };
    const viaReader = () => {
      const fr = new FileReader();
      fr.onerror = () => { clearTimeout(timer); rej(new Error('Nie udało się wczytać zdjęcia')); };
      fr.onload = () => { const img = new Image(); img.onerror = () => { clearTimeout(timer); rej(new Error('Nie udało się wczytać zdjęcia')); }; img.onload = () => done(img); img.src = fr.result; };
      fr.readAsDataURL(file);
    };
    try {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => done(img, url);
      img.onerror = () => { URL.revokeObjectURL(url); viaReader(); };
      img.src = url;
    } catch (e) { viaReader(); }
  });
}
function pickImage(max, cam) {
  return new Promise(res => {
    const inp = $(cam ? '#fileCam' : '#filePick');
    inp.value = '';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) { res(null); return; }
      busy(true, 'Przygotowuję zdjęcie…');
      try { res(await fileToDataUrl(f, max)); }
      catch (e) { toast('Zdjęcie się nie udało: ' + (e.message || e)); res(null); }
      finally { busy(false); }
    };
    inp.click();
  });
}

/* ---------- AI: Claude / Gemini / kompatybilne z OpenAI ---------- */
const PROVIDERS = {
  anthropic: { label: 'Claude (Anthropic) - płatne za użycie', model: 'claude-sonnet-5-5', base: '' },
  gemini: { label: 'Google Gemini - ma darmowy limit dzienny', model: 'gemini-2.5-flash', base: '' },
  openai: { label: 'Inne (Groq, OpenRouter, OpenAI…)', model: 'llama-3.3-70b-versatile', base: 'https://api.groq.com/openai/v1' }
};
function quotaMsg(j) {
  const m = (j && j.error && j.error.message) || '';
  const t = (m.match(/retry in ([0-9hms.]+)/i) || [])[1];
  return 'Dzienny limit darmowego Gemini jest wyczerpany' + (t ? ' (odnowi się za ok. ' + t.replace(/\.$/, '').replace(/\.\d+s/, 's') + ')' : '') + '. Spróbuj później albo wpisz w Ustawieniach inny klucz lub model.';
}
const PROV_NAME = { anthropic: 'Claude', gemini: 'Gemini', openai: 'AI' };
const aiDownUntil = {};   // dostawca -> do kiedy pomijamy po wyczerpaniu limitu
let aiNote = '';
async function claude(opts) {
  if (!hasKey()) throw new Error('NO_KEY');
  const hasImg = opts.messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image'));
  const chain = [];
  const p0 = aiCfg(); if (p0.apiKey) chain.push(Object.assign({ label: PROV_NAME[p0.provider] || 'AI', id: 'main', vision: true }, p0));
  (APP_CFG.fallbacks || []).forEach((f, i) => { if (f.apiKey && !chain.some(c => c.apiKey === f.apiKey && c.model === f.model)) chain.push(Object.assign({ id: 'fb' + i }, f)); });
  let list = chain.filter(c => !hasImg || c.vision !== false);
  if (!list.length) throw new Error('Rozpoznanie zdjęcia wymaga Gemini lub Claude - ich limit jest wyczerpany. Spróbuj później.');
  const live = list.filter(c => !(aiDownUntil[c.id] > Date.now()));
  if (live.length) list = live;
  let firstErr = null; aiNote = '';
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    try {
      const out = await callAI(c, opts);
      return out;
    } catch (e) {
      if (!firstErr) firstErr = e;
      if (/limit|quota|429|rate/i.test(String(e && e.message))) aiDownUntil[c.id] = Date.now() + 10 * 60000;
    }
  }
  const msg = String((firstErr && firstErr.message) || '');
  if (/zdjęci/i.test(msg)) throw firstErr;
  throw new Error('Asystent AI jest chwilowo niedostępny (limity lub brak internetu). Spróbuj za kilka minut - albo zmień dostawcę w Ustawieniach.');
}
/* model niedostępny u dostawcy (np. wycofany) -> pobierz listę modeli i wybierz pasujący */
const modelPick = {};
async function pickModel(st) {
  const base = (st.baseUrl || PROVIDERS.openai.base).replace(/\/+$/, '');
  if (modelPick[base]) return modelPick[base];
  const r = await xfetch(base + '/models', { headers: { authorization: 'Bearer ' + st.apiKey } }, 15000);
  const j = await r.json();
  let ids = ((j && j.data) || []).map(m => m.id).filter(Boolean);
  if (/openrouter/.test(base)) ids = ids.filter(i => /:free$/.test(i));
  ids = ids.filter(i => !/whisper|guard|tts|embed|orpheus|playai|moderation|image|audio|speech|safeguard/i.test(i));
  const pref = [/gpt-oss-120b/, /llama-3\.3-70b/, /llama-4/, /qwen.*(235|32b|27b)/, /gpt-oss-20b/, /llama.*70b/, /gemma.*(27|12)b/, /llama.*(8b|3b)/];
  let best = null;
  for (const re of pref) { best = ids.find(i => re.test(i)); if (best) break; }
  best = best || ids[0];
  if (!best) throw new Error('brak modeli');
  return (modelPick[base] = best);
}
async function callAI(st, opts) {
  try { return await callAI1(st, opts); }
  catch (e) {
    if ((st.provider || '') === 'openai' && /model|not exist|not found|decommission|access/i.test(String(e && e.message))) {
      const m = await pickModel(st);
      if (m && m !== st.model) return callAI1(Object.assign({}, st, { model: m }), opts);
    }
    throw e;
  }
}
async function callAI1(st, opts) {
  const prov = st.provider || 'anthropic';
  const msgs = opts.messages.map(m => ({ role: m.role, parts: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content }));
  let r, j;
  if (prov === 'gemini') {
    const body = {
      contents: msgs.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: m.parts.map(p => p.type === 'image' ? { inline_data: { mime_type: 'image/jpeg', data: p.dataUrl.split(',')[1] } } : { text: p.text })
      })),
      generationConfig: { maxOutputTokens: Math.max(opts.max || 2000, 4000) }
    };
    if (opts.json) body.generationConfig.responseMimeType = 'application/json';
    if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
    const callG = m => xfetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(m) + ':generateContent', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': st.apiKey }, body: JSON.stringify(body)
    });
    r = await callG(st.model);
    if (r.status === 429 && !/lite/.test(st.model)) { const r2 = await callG('gemini-2.5-flash-lite'); if (r2.ok) r = r2; }
    j = await r.json();
    if (!r.ok) throw new Error(r.status === 429 ? quotaMsg(j) : ((j.error && j.error.message) || ('HTTP ' + r.status)));
    const c = j.candidates && j.candidates[0];
    const text = ((c && c.content && c.content.parts) || []).map(p => p.text || '').join('');
    if (!text) throw new Error('Pusta odpowiedź modelu');
    return text;
  }
  if (prov === 'openai') {
    const base = (st.baseUrl || PROVIDERS.openai.base).replace(/\/+$/, '');
    const messages = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    msgs.forEach(m => {
      const onlyText = m.parts.every(p => p.type === 'text');
      messages.push({
        role: m.role,
        content: onlyText ? m.parts.map(p => p.text).join('\n') : m.parts.map(p => p.type === 'image' ? { type: 'image_url', image_url: { url: p.dataUrl } } : { type: 'text', text: p.text })
      });
    });
    r = await xfetch(base + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + st.apiKey },
      body: JSON.stringify({ model: st.model, messages, max_tokens: opts.max || 2000 })
    });
    j = await r.json();
    if (!r.ok) throw new Error((j.error && (j.error.message || j.error)) || ('HTTP ' + r.status));
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  }
  // Anthropic
  r = await xfetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': st.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: st.model, max_tokens: opts.max || 2000, system: opts.system,
      messages: msgs.map(m => ({
        role: m.role,
        content: m.parts.map(p => p.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: p.dataUrl.split(',')[1] } } : { type: 'text', text: p.text })
      }))
    })
  });
  j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  return j.content.map(c => c.text || '').join('');
}
function extractJSON(t) {
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('AI nie zwróciło danych');
  return JSON.parse(t.slice(a, b + 1));
}
function imgBlock(dataUrl) { return { type: 'image', dataUrl }; }

const ANALYZE_SYSTEM = `Jesteś modułem rozpoznawania treści w polskiej aplikacji do codziennego życia. Dostajesz tekst, zawartość strony i/lub zdjęcie. Odpowiadasz WYŁĄCZNIE poprawnym JSON-em (bez komentarzy) w formacie:
{"type":"recipe|link|note|plant|event|shopping",
 "recipe":{"title":"","servings":null,"total_min":null,"cook_min":null,"temp_c":null,"yield_text":"","notes":"","groups":[{"name":"","items":["500 g mąki"]}],"steps":["krok 1"],"image_query":"krótka fraza do wyszukania zdjęcia gotowej potrawy","categories":["obiady"]},
 "link":{"title":"","tags":["tag"]},
 "note":{"text":""},
 "plant":{"name":"","water_days":7,"fertilize_days":30,"tip":""},
 "event":{"title":"","date":"YYYY-MM-DD","time":"HH:MM"},
 "shopping":["produkt"]}
Wypełnij tylko pole pasujące do "type". Przepis: zachowaj oryginalne ilości i treść, rozdziel składniki na podgrupy (np. "Kruszonka", "Nadzienie") gdy tekst je wyróżnia, nazwa grupy pusta dla głównych składników. Kroki wykonania jako osobne krótkie pozycje. Czas i temperaturę podaj tylko jeśli wynikają z tekstu. Składniki zapisuj jako \"ilość jednostka nazwa\" (np. \"1 kg buraków\"), nawet gdy źródło ma format \"Nazwa - ilość\". Jeśli podano wydajność niepoliczalną jako porcje (np. \"około 1500 ml barszczu\"), wpisz ją do yield_text, a servings zostaw null. Uwagi autora, wskazówki i przeliczniki (np. pojemność szklanki) wpisz do notes. KATEGORIE przepisu (pole categories, 1-3 pozycje z listy): sniadania, obiady, kolacje, zupy, miesa, ryby, makarony, salatki, przekaski, ciasta, desery, pieczywo, napoje, wege, swieta, przetwory, grill. Kategorii \"bezglutenu\" użyj WYŁĄCZNIE gdy źródło wprost deklaruje, że przepis jest bez glutenu - nigdy jej nie zgaduj. Wszystko po polsku.`;

async function aiAnalyze(text, img) {
  const content = [];
  if (img) content.push(imgBlock(img));
  content.push({ type: 'text', text: 'Dzisiejsza data: ' + today() + '\n\nTreść do rozpoznania:\n' + (text || '(tylko zdjęcie)') });
  const out = await claude({ system: ANALYZE_SYSTEM, messages: [{ role: 'user', content }], max: 3000 });
  return extractJSON(out);
}

/* ---------- parsowanie składników i przepisów ---------- */
const UNIT_RE = 'g|kg|dag|ml|l|szt\\.?|łyżk\\w*|łyżecz\\w*|szklank\\w*|opak\\w*|ząbk\\w*|plast\\w*|pęczek|kostk\\w*|cm|litr\\w*|ziar\\w*|sztuk\\w*|gram\\w*|główk\\w*';
function parseQty(s) {
  s = String(s).replace(',', '.');
  if (s === '½') return 0.5;
  if (/^\d+\/\d+$/.test(s)) { const p = s.split('/'); return p[0] / p[1]; }
  return parseFloat(s);
}
const NUMW = { jedna: '1', jeden: '1', jedno: '1', 'pół': '0,5', dwie: '2', dwa: '2', trzy: '3', cztery: '4', 'pięć': '5' };
/* "buraki 1 kg", "kawałek pora - około 10 cm", "zakwas: jedna szklanka" -> "1 kg buraki" (ilość na początku, skalowanie działa) */
function normIngredient(raw) {
  raw = String(raw).replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
  if (/^(\d|½)/.test(raw)) return raw;
  const m = raw.match(new RegExp('^(.{2,80}?)\\s*[:\\-–—]?\\s+(?:około|ok\\.|po|ca\\.?)?\\s*(\\d+(?:[.,]\\d+)?|\\d+/\\d+|½|jedna|jeden|jedno|pół|dwie|dwa|trzy|cztery|pięć)(?=\\s|$)(?:\\s+(płask\\w*|czubat\\w*|gładk\\w*)(?=\\s))?(?:\\s+(' + UNIT_RE + ')(?=\\s|$|[.,;)]))?(.*)$', 'i'));
  if (!m) return raw;
  const name = m[1].trim().replace(/[:\-–—,]+$/, '').trim();
  if (!name || /^\d/.test(name)) return raw;
  const q = NUMW[m[2].toLowerCase()] || m[2];
  let rest = [m[3], (m[5] || '').trim().replace(/^[,;:.\s-]+|[.\s]+$/g, '')].filter(Boolean).join(', ');
  return q + (m[4] ? ' ' + m[4] : '') + ' ' + name.charAt(0).toLowerCase() + name.slice(1) + (rest ? ' (' + rest + ')' : '');
}
function parseIngredient(raw) {
  raw = normIngredient(String(raw).trim().replace(/^[-•*]\s*/, ''));
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
const SCALE_UNITS = 'g|kg|dag|gram\\p{L}*|ml|l|litr\\p{L}*|łyżk\\p{L}*|łyżecz\\p{L}*|szklank\\p{L}*';
function scaleText(t, f) {
  if (!f || f === 1) return t;
  return String(t).replace(new RegExp('(\\d+(?:[.,]\\d+)?)(\\s*)(' + SCALE_UNITS + ')(?![\\p{L}\\d])', 'giu'),
    (m, n, sp, u) => fmtQ(parseQty(n) * f) + (sp || ' ') + u);
}
function splitInline(s) { return s.split(/\s*,\s*|\s+i\s+(?=\d)/).map(x => x.trim().replace(/[.;]+$/, '')).filter(Boolean); }

function sumMinutes(str) {
  let t = 0, m; const re = /(\d+)\s*(godz\w*|h\b|min\w*)/gi;
  while ((m = re.exec(str))) t += /^(godz|h)/i.test(m[2]) ? +m[1] * 60 : +m[1];
  return t;
}

function parseRecipeText(text) {
  let lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  lines = lines.reduce((o, l, i, a) => { if (o.skip) { o.skip = false; return o; } if (/^(czas przygotowania|czas łączny|liczba porcji|porcje|wydajność)\s*:?$/i.test(l) && a[i + 1]) { o.out.push(l.replace(/:?$/, ':') + ' ' + a[i + 1]); o.skip = true; } else o.out.push(l); return o; }, { out: [], skip: false }).out;
  const isIng = l => (/^(\d+(?:[.,]\d+)?|\d+\/\d+|½)\s*[^\s.)]/.test(l)) || /^(szczypt|pół\s|troch|do smaku|kilka|opakowan)/i.test(l);
  let title = '', mode = 'start', yieldText = '', totalT = null; const notes = [];
  const hasStepsHead = lines.some(l => /^(wykonanie|przygotowanie|sposób przygotowania|instrukcja|kroki)\s*:?$/i.test(l) || /^krok\s*\d/i.test(l));
  const groups = [{ name: '', items: [] }];
  let cur = groups[0];
  const steps = [];
  let idx = 0, krok = false;
  if (lines.length && !isIng(lines[0]) && lines[0].length < 80 && !/[.:]$/.test(lines[0]) && !/^(składniki|wykonanie|przygotowanie)/i.test(lines[0])) { title = lines[0]; idx = 1; }
  for (; idx < lines.length; idx++) {
    const l = lines[idx];
    const tm = l.match(/^czas (?:przygotowania|łączny|całkowity)\s*:?\s*(\d.*)$/i);
    if (tm) { totalT = sumMinutes(tm[1]) || totalT; continue; }
    const ym = l.match(/^(?:liczba porcji|porcje|ilość porcji|wydajność)\s*:?\s*(.+)$/i);
    if (ym) { yieldText = ym[1].trim(); continue; }
    if (/^(składniki|ingredients)\s*:?$/i.test(l)) { mode = 'ing'; continue; }
    if (/^(wykonanie|przygotowanie|sposób przygotowania|instrukcja|kroki|przepis)\s*:?$/i.test(l)) { mode = 'steps'; continue; }
    if (krok && (/\?$/.test(l) || /^(często zadawane|faq|wartości odżywcze|przechowywanie|podobne|zobacz|komentarz)/i.test(l))) break;
    const km = l.match(/^krok\s*\d+\s*[:.\-–]?\s*(.*)$/i);
    if (km) { steps.push(km[1] ? cap1(km[1].replace(/[.\s]+$/, '')) + '.' : ''); krok = true; mode = 'steps'; continue; }
    if (krok && mode === 'steps' && steps.length) { steps[steps.length - 1] = (steps[steps.length - 1] + ' ' + l).trim(); continue; }
    if (mode !== 'steps') {
      const g = l.match(/^([^:\d]{2,40}):\s*(.+)$/);
      if (g && /\d/.test(g[2]) && isIng(splitInline(g[2])[0] || '') && (splitInline(g[2]).length >= 2 || /^na\s/i.test(g[1]) || mode !== 'ing')) {
        cur = { name: cap1(g[1].replace(/^na\s+/i, '').trim()), items: [] };
        groups.push(cur);
        splitInline(g[2]).forEach(x => cur.items.push(parseIngredient(x)));
        continue;
      }
      if (isIng(l) || /^[^\d.]{2,60}\s+[-–—]\s+(\d|½|do smaku|szczypt|pół|troch|kilka)/i.test(l)) { cur.items.push(parseIngredient(l)); continue; }
      if (mode === 'ing' && l.length <= 100 && !/\.\s+\p{Lu}/u.test(l) && !/[.!?]$/.test(l.replace(/\.$/, '')) && (/\s[:\-–—]?\s*(?:około|ok\.|po|ca\.?)?\s*(\d+(?:[.,]\d+)?|½|jedna|jeden|jedno|pół|dwie|dwa|trzy|cztery|pięć)(?=[\s,.;)]|$)/i.test(l) || /^[^.]{2,60}:\s*\S/.test(l))) { cur.items.push(parseIngredient(l)); continue; }
      if (mode === 'ing' && hasStepsHead) { notes.push(l); continue; }
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
  const total = totalT || sumMinutes(all) || null;
  // porcje
  let servings = null;
  const sm = String(text).match(/(?:na|dla)\s+(\d+)\s*(?:porcji|porcje|osób|osoby|sztuk|szt)/i);
  if (yieldText && !/[a-ząćęłńóśźż]{3,}/i.test(yieldText.replace(/porcj\w*|osó\w*|szt\w*/gi, ''))) servings = parseInt(yieldText) || null;
  if (sm) servings = +sm[1];
  else {
    const re = /dziel\w*[^.]*?na\s+(\d+)/gi; const nums = []; let m;
    while ((m = re.exec(all))) nums.push(+m[1]);
    if (nums.length === 2) servings = nums[0] * nums[1];
  }
  return {
    id: uid(), title: title || 'Nowy przepis', servings, total, cook, temp: temp ? +temp : null,
    yieldText: yieldText && !servings ? yieldText : '', notes: notes.join('\n'),
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
    yieldText: a.yield_text || '', notes: a.notes || '',
    image: '', imgs: [], imageQuery: a.image_query || '', source: '', fav: false, ts: Date.now(),
    cats: validRcats(a.categories).filter(k => k !== 'bezglutenu' || GLUTEN_RX.test(JSON.stringify(a)))
  };
}

/* ---------- zdjęcia z internetu (Wikimedia, bez klucza) ---------- */
async function findImages(query) {
  const out = [];
  const add = u => { if (u && !out.includes(u)) out.push(u); };
  try {
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=' +
      encodeURIComponent(query + ' filetype:bitmap') + '&prop=imageinfo&iiprop=url&iiurlwidth=700&format=json&origin=*';
    const j = await (await xfetch(u, null, 9000)).json();
    Object.values((j.query && j.query.pages) || {}).forEach(p => {
      const ii = p.imageinfo && p.imageinfo[0];
      if (ii && /\.(jpe?g|png)$/i.test(ii.url)) add(ii.thumburl || ii.url);
    });
  } catch (e) {}
  try {
    const u = 'https://pl.wikipedia.org/w/api.php?action=query&generator=search&gsrlimit=5&gsrsearch=' + encodeURIComponent(query) +
      '&prop=pageimages&piprop=thumbnail&pithumbsize=700&format=json&origin=*';
    const j = await (await xfetch(u, null, 9000)).json();
    Object.values((j.query && j.query.pages) || {}).forEach(p => add(p.thumbnail && p.thumbnail.source));
  } catch (e) {}
  try {
    const u = 'https://api.openverse.org/v1/images/?page_size=8&category=photograph&q=' + encodeURIComponent(query);
    const j = await (await xfetch(u, null, 9000)).json();
    (j.results || []).forEach(p => add(p.thumbnail || p.url));
  } catch (e) {}
  return out;
}
async function betterImageQuery(title) {
  try {
    const out = await claude({ system: 'Podaj jedną krótką frazę (2-4 słowa, po angielsku) do wyszukiwania zdjęcia gotowej potrawy o podanej nazwie. Odpowiedz samą frazą.', messages: [{ role: 'user', content: title }], max: 40 });
    return String(out).replace(/["\n]/g, ' ').trim().slice(0, 60);
  } catch (e) { return ''; }
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
      let y = Array.isArray(r.recipeYield) ? r.recipeYield.find(v => /[a-ząćęłńóśźż]/i.test(String(v))) || r.recipeYield[0] : r.recipeYield;
      y = decodeHtml(String(y == null ? '' : y)).trim();
      const unitY = /\d\s*(ml|l|litr\w*|g|kg|dag|gram\w*)\b/i.test(y);
      const servN = !unitY && /^\D{0,12}\d+\s*(porcj\w*|osó\w*|szt\w*|sztuk\w*)?$/i.test(y) ? parseInt(y.replace(/\D+/g, '')) : null;
      if (!(r.recipeIngredient || []).length) continue;
      return {
        id: uid(), title: decodeHtml(r.name || 'Przepis'), servings: servN || null, yieldText: servN || !y ? '' : y, notes: decodeHtml(String(r.description || '')).trim().slice(0, 600),
        total: isoMin(r.totalTime), cook: isoMin(r.cookTime), temp: null,
        groups: [{ name: '', items: (r.recipeIngredient || []).map(x => parseIngredient(decodeHtml(String(x)))) }].filter(g => g.items.length),
        steps: ldInstructions(r.recipeInstructions).map(decodeHtml),
        image: typeof img === 'string' ? img : '', imgs: [], source: url, fav: false, ts: Date.now()
      };
    } catch (e) { /* następny blok */ }
  }
  return null;
}
function htmlToLines(html) {
  const t = html.replace(/<(script|style|noscript|nav|footer|header|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|ul|ol)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return decodeHtml(t).split(/\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
function cleanTitle(t) {
  return String(t || '').replace(/\s*[|\-–—]\s*[^|\-–—]{0,30}(\.pl|gotuje|przepisy|kuchnia)[^|\-–—]*$/i, '').trim();
}
function recipeFromPageText(html, title) {
  const all = htmlToLines(html).split('\n');
  const find = re => { for (let i = 0; i < all.length; i++) if (re.test(all[i])) return all[i] + (/:\s*$/.test(all[i]) ? ' ' + (all[i + 1] || '') : ''); return ''; };
  const head = [find(/^czas przygotowania/i), find(/^liczba porcji/i)].filter(Boolean).join('\n');
  const END = /^(Komentarze|Podobne przepisy|Zobacz także|Polecamy|Dodaj komentarz|Często zadawane|FAQ|Wartości odżywcze)/i;
  const cands = [];
  all.forEach((l, i) => {
    if (!/^Składniki/i.test(l) || l.length > 40) return;
    let body = all.slice(i);
    const e = body.findIndex((x, k) => k > 3 && END.test(x)); if (e > 0) body = body.slice(0, e);
    const r = parseRecipeText(cleanTitle(title || 'Przepis') + '\n' + head + '\n' + body.slice(0, 160).join('\n'));
    const n = r.groups.reduce((a, g) => a + g.items.length, 0);
    if (n >= 3 && r.steps.length) cands.push({ r, n });
  });
  const maxN = Math.max(0, ...cands.map(c => c.n));
  const ok = cands.filter(c => c.n >= maxN * 0.8);
  return ok.length ? ok[ok.length - 1].r : null;
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
const plantOwned = p => p.owned !== false;
const ROOMS = ['Salon', 'Sypialnia', 'Kuchnia', 'Łazienka', 'Przedpokój', 'Biuro', 'Pokój dziecka', 'Balkon', 'Ogród'];
const DAYS7 = [['1', 'Pn'], ['2', 'Wt'], ['3', 'Śr'], ['4', 'Cz'], ['5', 'Pt'], ['6', 'So'], ['0', 'Nd']];
const plantDay = () => (S.settings.plantDay === 'off' ? null : S.settings.plantDay == null ? 6 : +S.settings.plantDay);
/* jedno cotygodniowe wydarzenie w kalendarzu zamiast osobnych powiadomień dla każdej rośliny */
function schedulePlant(p) { if (p) { unnotify('pw' + p.id); unnotify('pf' + p.id); } ensurePlantEvent(); }
function ensurePlantEventForce() { const e = S.events.find(x => x.sys === 'plants'); if (e) e.sig = ''; ensurePlantEvent(); }
function ensurePlantEvent() {
  const day = plantDay(), time = S.settings.plantTime || '09:00';
  const on = day != null && S.plants.some(plantOwned);
  let e = S.events.find(x => x.sys === 'plants');
  if (!on) { if (e) { cancelEventNotifs(e.id); S.events = S.events.filter(x => x !== e); save(); } return; }
  const sig = day + '|' + time;
  if (e && e.sig === sig) return;
  if (!e) { e = { id: uid(), sys: 'plants', done: false, kind: 'event', title: 'Rośliny: podlewanie i nawożenie', cat: 'rosliny', date: today(), note: 'Otwórz Rośliny, żeby zobaczyć, co dziś zrobić' }; S.events.push(e); }
  e.rep = { t: 'w', days: [day] }; e.time = time; e.rems = [0]; e.remind = 0; e.sig = sig;
  save(); scheduleEvent(e);
}
function plantsToDo() {
  const k = plantDay() === dateObj(today()).getDay() ? 3 : 0;
  return S.plants.filter(plantOwned).map(p => ({ p, d: plantDue(p) })).filter(x => x.d.water <= k || x.d.fert <= k);
}

/* =====================  WIDOKI  ===================== */
const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  cook: '<path d="M7 14.5a4 4 0 1 1 1.2-7.8 4.5 4.5 0 0 1 7.6 0A4 4 0 1 1 17 14.5V19H7z"/><path d="M7 16.5h10"/>',
  cart: '<circle cx="9" cy="20" r="1.3"/><circle cx="18" cy="20" r="1.3"/><path d="M2.5 3.5h3l2.2 11.2a1.5 1.5 0 0 0 1.5 1.2h8.6a1.5 1.5 0 0 0 1.5-1.1L21 8H6.2"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  cal: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  note: '<path d="M6 3.5h9l4 4V20a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"/><path d="M14.5 3.5V8H19"/><path d="M8.5 12.5h7M8.5 16h5"/>',
  chat: '<path d="M20 12a7.5 7.5 0 0 1-10.9 6.7L4 20l1.4-4.3A7.5 7.5 0 1 1 20 12z"/>',
  leaf: '<path d="M12 21v-8"/><path d="M12 13c0-4-3-6.5-7.5-6.5 0 4 2.5 6.5 7.5 6.5z"/><path d="M12 15c0-3.3 2.4-5.5 6.5-5.5 0 3.5-2.2 5.5-6.5 5.5z"/>',
  drop: '<path d="M12 3.5c3.5 4 6 6.8 6 10a6 6 0 0 1-12 0c0-3.2 2.5-6 6-10z"/>',
  star: '<path d="m12 3.8 2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/>',
  back: '<path d="m14.5 5-7 7 7 7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/>'
};
Object.assign(ICONS, {
  k_praca: "<rect x=\"2\" y=\"7\" width=\"20\" height=\"14\" rx=\"2\"/><path d=\"M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16\"/>",
  k_zdrowie: "<path d=\"M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z\"/><path d=\"M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27\"/>",
  k_leki: "<path d=\"m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z\"/><path d=\"m8.5 8.5 7 7\"/>",
  r_sniadania: "<path d=\"M3 12c0-4 3-8 8-8 4 0 8 3 9 7s-2 9-8 9-9-4-9-8z\"/><circle cx=\"11\" cy=\"12\" r=\"3\"/>",
  r_zupy: "<path d=\"M3 12a9 9 0 0 0 18 0Z\"/><path d=\"M8 3c-1 1.5 1 2.5 0 4M12 3c-1 1.5 1 2.5 0 4M16 3c-1 1.5 1 2.5 0 4\"/>",
  r_obiady: "<path d=\"M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2\"/><path d=\"M7 2v20\"/><path d=\"M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7\"/>",
  r_kolacje: "<path d=\"M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z\"/>",
  r_miesa: "<path d=\"M15.4 15.63a7.875 6 135 1 1 6.23-6.23 4.5 3.43 135 0 0-6.23 6.23\"/><path d=\"m8.29 12.71-2.6 2.6a2.5 2.5 0 1 0-1.65 4.65A2.5 2.5 0 1 0 8.7 18.3l2.59-2.59\"/>",
  r_ryby: "<path d=\"M3 12c3-5 9-6 14-2l4-3v10l-4-3c-5 4-11 3-14-2z\"/><circle cx=\"7.5\" cy=\"11\" r=\".7\"/>",
  r_makarony: "<path d=\"M8 3v8a3 3 0 0 0 6 0V3\"/><path d=\"M11 3v8M11 14v7\"/><path d=\"M17 8c2 0 3 2 3 4s-1 4-3 4\"/>",
  r_salatki: "<path d=\"M3 11h18a9 7 0 0 1-18 0z\"/><path d=\"M8 11c0-4 2-6 5-7 0 4-1 6-5 7z\"/>",
  r_przekaski: "<path d=\"M4 11h16a8 6 0 0 0-16 0z\"/><path d=\"M3 15h18\"/><path d=\"M4 19h16a1 1 0 0 0 1-1v-1H3v1a1 1 0 0 0 1 1z\"/>",
  r_ciasta: "<path d=\"M4 20h16v-6H4z\"/><path d=\"M4 14c0-3 4-4 8-4s8 1 8 4\"/><path d=\"M12 10V7\"/><path d=\"M12 7c-1-1-1-2 0-3 1 1 1 2 0 3z\"/>",
  r_desery: "<path d=\"M6 12h12l-1.5 8.5a1 1 0 0 1-1 .5h-7a1 1 0 0 1-1-.5z\"/><path d=\"M10 13v6M14 13v6\"/><path d=\"M5.5 12a3.5 3.5 0 0 1 2-6.2A4.5 4.5 0 0 1 16.5 5.8a3.5 3.5 0 0 1 2 6.2\"/><circle cx=\"12\" cy=\"3.5\" r=\"1\"/>",
  r_pieczywo: "<path d=\"M12 22V9\"/><path d=\"M12 9c-2.5 0-4-1.5-4-4 2.5 0 4 1.5 4 4z\"/><path d=\"M12 9c2.5 0 4-1.5 4-4-2.5 0-4 1.5-4 4z\"/><path d=\"M12 14c-2.5 0-4-1.5-4-4 2.5 0 4 1.5 4 4z\"/><path d=\"M12 14c2.5 0 4-1.5 4-4-2.5 0-4 1.5-4 4z\"/><path d=\"M12 19c-2.5 0-4-1.5-4-4 2.5 0 4 1.5 4 4z\"/><path d=\"M12 19c2.5 0 4-1.5 4-4-2.5 0-4 1.5-4 4z\"/><path d=\"M12 5V2\"/>",
  r_napoje: "<path d=\"M6 8h12l-1.5 13h-9z\"/><path d=\"M12 8V3l4-1\"/>",
  r_wege: "<path d=\"M5 21c0-10 5-16 16-17 0 11-6 16-16 17z\"/><path d=\"M5 21 14 12\"/>",
  r_swieta: "<polygon points=\"12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9\"/>",
  r_przetwory: "<path d=\"M7 8h10v12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z\"/><path d=\"M8 3h8v5H8z\"/>",
  r_grill: "<path d=\"M12 22c4 0 7-3 7-7 0-3-2-5-3-7-1 2-2 3-3 3 0-4-1-7-4-9 0 5-4 7-4 12 0 4 3 8 7 8z\"/>",
  r_bezglutenu: "<path d=\"M12 22V9\"/><path d=\"M12 9c-2.5 0-4-1.5-4-4 2.5 0 4 1.5 4 4z\"/><path d=\"M12 9c2.5 0 4-1.5 4-4-2.5 0-4 1.5-4 4z\"/><path d=\"M12 14c-2.5 0-4-1.5-4-4 2.5 0 4 1.5 4 4z\"/><path d=\"M12 14c2.5 0 4-1.5 4-4-2.5 0-4 1.5-4 4z\"/><path d=\"M12 19c-2.5 0-4-1.5-4-4 2.5 0 4 1.5 4 4z\"/><path d=\"M12 19c2.5 0 4-1.5 4-4-2.5 0-4 1.5-4 4z\"/><path d=\"M3 3l18 18\"/>",
  p_warzywa: "<path d=\"M2.27 21.7s9.87-3.5 12.73-6.36a4.5 4.5 0 0 0-6.36-6.37C5.77 11.84 2.27 21.7 2.27 21.7z\"/><path d=\"M8.64 14l-2.05-2.04M15.34 15l-2.46-2.46\"/><path d=\"M22 9s-1.33-2-3.5-2C16.86 7 15 9 15 9s1.33 2 3.5 2S22 9 22 9z\"/><path d=\"M15 2s-2 1.33-2 3.5S15 9 15 9s2-1.84 2-3.5C17 3.33 15 2 15 2z\"/>",
  p_owoce: "<path d=\"M12 20.94c1.5 0 2.75 1.06 4 1.06 3 0 6-8 6-12.22A4.91 4.91 0 0 0 17 5c-2.22 0-4 1.44-5 2-1-.56-2.78-2-5-2a4.9 4.9 0 0 0-5 4.78C2 14 5 22 8 22c1.25 0 2.5-1.06 4-1.06z\"/><path d=\"M10 2c1 .5 2 2 2 5\"/>",
  p_nabial: "<path d=\"M8 2h8\"/><path d=\"M9 2v2.789a4 4 0 0 1-.672 2.219l-.656.984A4 4 0 0 0 7 10.212V20a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-9.789a4 4 0 0 0-.672-2.219l-.656-.984A4 4 0 0 1 15 4.788V2\"/><path d=\"M7 15a6.472 6.472 0 0 1 5 0 6.47 6.47 0 0 0 5 0\"/>",
  p_sery: "<path d=\"M3 8l18-4v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/><circle cx=\"9\" cy=\"13\" r=\"1.2\"/><circle cx=\"15\" cy=\"11\" r=\"1\"/>",
  p_wedliny: "<circle cx=\"12\" cy=\"12\" r=\"9\"/><circle cx=\"9\" cy=\"10\" r=\"1\"/><circle cx=\"14.5\" cy=\"9\" r=\"1\"/><circle cx=\"15\" cy=\"14.5\" r=\"1\"/><circle cx=\"9\" cy=\"15\" r=\"1\"/>",
  p_suche: "<path d=\"M6 8h12l-1 13H7z\"/><path d=\"M9 8V5h6v3\"/><path d=\"M9 13h6\"/>",
  p_mrozonki: "<path d=\"M2 12h20M12 2v20M20 16l-4-4 4-4M4 8l4 4-4 4M16 4l-4 4-4-4M8 20l4-4 4 4\"/>",
  p_slodycze: "<path d=\"M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5\"/><path d=\"M8.5 8.5v.01M16 15.5v.01M12 12v.01M11 17v.01M7 14v.01\"/>",
  p_chemia: "<path d=\"M8 3h5v3H8z\"/><path d=\"M6 9h9v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z\"/><path d=\"M15 4h3M15 7h4\"/>",
  p_higiena: "<path d=\"M12 2.7s7 7.1 7 12a7 7 0 0 1-14 0c0-4.9 7-12 7-12z\"/>",
  wallet: "<path d=\"M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1\"/><path d=\"M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4\"/>",
  scan: "<path d=\"M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2\"/><path d=\"M7 12h10\"/>",
  p_przyprawy: "<path d=\"M9 3h6l1 3H8z\"/><path d=\"M8 6v13a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V6\"/><path d=\"M10 11h4M10 15h4\"/>",
  p_konserwy: "<ellipse cx=\"12\" cy=\"6\" rx=\"7\" ry=\"3\"/><path d=\"M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6\"/><path d=\"M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3\"/>",
  p_gotowe: "<path d=\"M12 21 3.5 6.5a17 17 0 0 1 17 0z\"/><circle cx=\"10\" cy=\"9\" r=\"1\"/><circle cx=\"14\" cy=\"11\" r=\"1\"/><circle cx=\"12\" cy=\"14.5\" r=\"1\"/>",
  p_alkohol: "<path d=\"M8 22h8\"/><path d=\"M7 10h10\"/><path d=\"M12 15v7\"/><path d=\"M12 15a5 5 0 0 0 5-5c0-2-.5-4-2-8H9c-1.5 4-2 6-2 8a5 5 0 0 0 5 5z\"/>",
  p_kosmetyki: "<path d=\"M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z\"/><path d=\"M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z\"/>",
  p_apteka: "<path d=\"m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7z\"/><path d=\"m8.5 8.5 7 7\"/>",
  p_dzieci: "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M8 14s1.5 2 4 2 4-2 4-2\"/><path d=\"M9 9h.01M15 9h.01\"/>",
  p_elektronika: "<path d=\"M13 2 4 14h7l-1 8 9-12h-7z\"/>",
  p_papiernicze: "<path d=\"M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z\"/><path d=\"m15 5 4 4\"/>",
  p_odziez: "<path d=\"M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z\"/>",
  p_auto: "<path d=\"M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2\"/><circle cx=\"7\" cy=\"17\" r=\"2\"/><path d=\"M9 17h6\"/><circle cx=\"17\" cy=\"17\" r=\"2\"/>",
  p_rosliny: "<path d=\"M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z\"/><path d=\"M2 21c0-3 1.9-5.5 6-7\"/>",
  k_weterynarz: "<path d=\"M11 2v2\"/><path d=\"M5 2v2\"/><path d=\"M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1\"/><path d=\"M8 15a6 6 0 0 0 12 0v-3\"/><circle cx=\"20\" cy=\"10\" r=\"2\"/>",
  k_groomer: "<circle cx=\"6\" cy=\"6\" r=\"3\"/><circle cx=\"6\" cy=\"18\" r=\"3\"/><path d=\"M20 4 8.12 15.88\"/><path d=\"M14.47 14.48 20 20\"/><path d=\"M8.12 8.12 12 12\"/>",
  k_karmienie: "<path d=\"M3 12h18l-1.6 6.4a2 2 0 0 1-1.94 1.6H6.54a2 2 0 0 1-1.94-1.6z\"/><circle cx=\"8.5\" cy=\"8.5\" r=\"1.3\"/><circle cx=\"12\" cy=\"6.5\" r=\"1.3\"/><circle cx=\"15.5\" cy=\"8.5\" r=\"1.3\"/>",
  k_zwierzeta: "<circle cx=\"11\" cy=\"4\" r=\"2\"/><circle cx=\"18\" cy=\"8\" r=\"2\"/><circle cx=\"20\" cy=\"16\" r=\"2\"/><path d=\"M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z\"/>",
  k_dom: "<path d=\"m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/><polyline points=\"9 22 9 12 15 12 15 22\"/>",
  k_zakupy: "<circle cx=\"8\" cy=\"21\" r=\"1\"/><circle cx=\"19\" cy=\"21\" r=\"1\"/><path d=\"M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12\"/>",
  k_rodzina: "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M22 21v-2a4 4 0 0 0-3-3.87\"/><path d=\"M16 3.13a4 4 0 0 1 0 7.75\"/>",
  k_nauka: "<path d=\"M22 10v6M2 10l10-5 10 5-10 5z\"/><path d=\"M6 12v5c3 3 9 3 12 0v-5\"/>",
  k_sport: "<path d=\"M6.5 6.5v11M17.5 6.5v11M3 9v6M21 9v6M6.5 12h11\"/>",
  k_spotkanie: "<path d=\"M17 8h1a4 4 0 1 1 0 8h-1\"/><path d=\"M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z\"/><path d=\"M6 2v2M10 2v2M14 2v2\"/>",
  k_urodziny: "<rect x=\"3\" y=\"8\" width=\"18\" height=\"4\" rx=\"1\"/><path d=\"M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7\"/><path d=\"M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5\"/>",
  k_podroz: "<path d=\"M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z\"/>",
  k_auto: "<path d=\"M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2\"/><circle cx=\"7\" cy=\"17\" r=\"2\"/><path d=\"M9 17h6\"/><circle cx=\"17\" cy=\"17\" r=\"2\"/>",
  k_finanse: "<path d=\"M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1\"/><path d=\"M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4\"/>",
  k_uroda: "<circle cx=\"6\" cy=\"6\" r=\"3\"/><path d=\"M8.12 8.12 12 12\"/><path d=\"M20 4 8.12 15.88\"/><circle cx=\"6\" cy=\"18\" r=\"3\"/><path d=\"M14.8 14.8 20 20\"/>",
  k_urzedy: "<path d=\"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z\"/><path d=\"M14 2v6h6M16 13H8M16 17H8M10 9H8\"/>",
  k_inne: "<rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\"/><path d=\"M16 2v4M8 2v4M3 10h18\"/>"
});
ICONS.k_rosliny = ICONS.leaf;
Object.assign(ICONS, { p_pieczywo: ICONS.r_pieczywo, p_mieso: ICONS.r_miesa, p_ryby: ICONS.r_ryby, p_napoje: ICONS.r_napoje, p_zwierzeta: ICONS.k_zwierzeta, p_inne: ICONS.cart, p_dom: ICONS.k_dom });
const CATS = [['praca', 'Praca'], ['zdrowie', 'Zdrowie'], ['leki', 'Leki'], ['weterynarz', 'Weterynarz'], ['groomer', 'Fryzjer dla zwierząt'], ['karmienie', 'Karmienie zwierząt'], ['zwierzeta', 'Zwierzęta'], ['rosliny', 'Rośliny'], ['dom', 'Dom'], ['zakupy', 'Zakupy'], ['rodzina', 'Rodzina'], ['nauka', 'Nauka'], ['sport', 'Sport'], ['spotkanie', 'Spotkanie'], ['urodziny', 'Urodziny'], ['podroz', 'Podróż'], ['auto', 'Auto'], ['finanse', 'Finanse'], ['uroda', 'Uroda'], ['urzedy', 'Sprawy'], ['inne', 'Inne']];
const CAT_RULES = [
  ['rosliny', 'podlej|podlew|nawoż|nawoz|storczyk|kwiatk', 'roślina|rośliny|rośliną|rosliny|kwiaty'],
  ['leki', '', 'leki|lek|leków|tabletka|tabletki|tabletek|suplement|suplementy|witaminy|witamina|krople|antybiotyk'],
  ['weterynarz', 'weteryn|(?:gabi|haru)\\s+(?:u\\s+)?(?:szczepieni|lekarz|badani|zastrzyk|kontrol)|szczepienie psa|szczepienie kota|odrobacz|kastracj|sterylizacj', ''],
  ['groomer', 'fryzjer (?:dla )?(?:psa|kota|gabi|haru)|(?:gabi|haru)\\s+(?:u\\s+)?(?:fryzjer|groomer|strzyż|strzyz|kąpiel|kapiel)|groomer|strzyżenie psa|strzyzenie psa|trymowanie|kąpiel psa|kapiel psa|obcinanie pazurów', ''],
  ['karmienie', 'karmieni|nakarm|karma |jedzenie dla|(?:posił|posil|obiad|kolacj|śniadan|sniadan)\\p{L}* (?:dla )?(?:gabi|haru)|(?:gabi|haru)\\s+(?:posił|posil|jedzeni|karm|obiad|kolacj|śniadan|sniadan)', 'miska|miski'],
  ['zwierzeta', 'zwierz|spacer z psem|spacer z', 'pies|psa|psem|kot|kota|kotem|chomik|rybki|gabi|haru'],
  ['zdrowie', 'lekarz|dentyst|szpital|badani|przychodni|ortodont|okulist|fizjoterap|rehabilit|szczepien|poradni|wizyta u|kardiolog|dermatolog|ginekolog|laryngolog', 'usg|krew|kontrola'],
  ['urodziny', 'urodzin|imienin|prezent|święt|wigili|rocznic|ślub|wesel|chrzci|komuni|andrzejk', ''],
  ['podroz', 'podróż|wyjazd|samolot|pociąg|urlop|wakacj|hotel|bilet|lotnisk|wycieczk', 'lot'],
  ['auto', 'samochód|przegląd|opon|warsztat|mechanik|tankow|myjni|ubezpieczenie oc', 'auto|olej|serwis'],
  ['finanse', 'rachunk|opłat|czynsz|podatek|przelew|faktur|kredyt|abonament', 'rata|raty|pit|bank|prąd|gaz'],
  ['uroda', 'fryzjer|kosmetycz|manicure|paznokc|paznokci|masaż|barber|strzyżen|depilac', 'spa'],
  ['urzedy', 'urząd|urzęd|dokument|podanie|wniosek|poczta|notariusz|dowód|paszport|sąd', 'zus'],
  ['nauka', 'szkoł|lekcj|kurs|egzamin|nauk|uczeni|studi|zajęcia|korepet|wykład|angielsk', ''],
  ['sport', 'trening|siłown|bieganie|basen|rower|joga|yoga|fitness|pilates|mecz|tenis|squash|dart|piłk', 'bieg'],
  ['dom', 'sprząt|pranie|wypran|odkurz|naprawa|hydraul|remont|śmieci|ogród|garaż|okna', 'dom'],
  ['zakupy', 'zakup|sklep|paczk|kurier|allegro', ''],
  ['rodzina', 'dzieci|dziecko|rodzic|rodzin|przedszkol|babci|dziadk', 'mama|tata|syn|córka'],
  ['praca', 'praca|pracy|biur|zmiana|dyżur|firma|projekt|klient|prezentacj|zebranie|szef', ''],
  ['spotkanie', 'spotkanie|kawa|kawy|obiad z|kolacj|impreza|randk|znajom|przyjaci|piwo|wyjście', '']
];
function guessCat(title) {
  const t = String(title || '').toLowerCase();
  for (const [k, pre, ex] of CAT_RULES) {
    if (pre && new RegExp('(?<![\\p{L}])(?:' + pre + ')', 'u').test(t)) return k;
    if (ex && new RegExp('(?<![\\p{L}])(?:' + ex + ')(?![\\p{L}])', 'u').test(t)) return k;
  }
  return 'inne';
}
const catOf = e => (e && CATS.some(c => c[0] === e.cat) ? e.cat : guessCat(e && e.title));
const validCat = c => (CATS.some(x => x[0] === c) ? c : '');
const catName = k => (CATS.find(c => c[0] === k) || ['', 'Inne'])[1];
/* ---------- kategorie produktów (zakupy i budżet) ---------- */
const PCATS = [['warzywa', 'Warzywa'], ['owoce', 'Owoce'], ['pieczywo', 'Pieczywo'], ['nabial', 'Nabiał'], ['sery', 'Sery'], ['mieso', 'Mięso'], ['wedliny', 'Wędliny'], ['ryby', 'Ryby'], ['mrozonki', 'Mrożonki'], ['gotowe', 'Gotowe dania'], ['suche', 'Produkty suche'], ['przyprawy', 'Przyprawy i oleje'], ['konserwy', 'Konserwy i słoiki'], ['slodycze', 'Słodycze i przekąski'], ['napoje', 'Napoje'], ['alkohol', 'Alkohol'], ['chemia', 'Chemia domowa'], ['higiena', 'Higiena'], ['kosmetyki', 'Kosmetyki'], ['apteka', 'Apteka i zdrowie'], ['dzieci', 'Dla dzieci'], ['zwierzeta', 'Dla zwierząt'], ['rosliny', 'Rośliny i kwiaty'], ['dom', 'Dom i ogród'], ['elektronika', 'Elektronika'], ['papiernicze', 'Papiernicze i szkoła'], ['odziez', 'Odzież i obuwie'], ['auto', 'Auto'], ['inne', 'Inne']];
const PCAT_RULES = [
  ['zwierzeta', 'karma|karmy|dla psa|dla kota|zwirek|przysmak dla|gabi|haru|smycz|obroz|zabawka dla psa|kosc dla|chrupki dla|saszetk|kuwet|pies|psa |kot |kota '],
  ['dzieci', 'pieluch|chusteczki nawilz|mleko modyf|bebiko|nutrilon|gerber|sloiczek|kaszka|smoczek|dla dzieci|dla niemowl|pampers|huggies|bobas|baby'],
  ['auto', 'paliwo|benzyn|olej silnikow|plyn do chlodnic|plyn do spryskiwaczy|wycieraczk|odswiezacz do auta|myjni|opony|autoszampon|wosk do auta|tankowani|lpg|diesel|adblue|parking|autostrad|akumulator samochod|filtr oleju|filtr powietrza'],
  ['elektronika', 'bateri|akumulator|ladowark|kabel|usb|hdmi|sluchawk|powerbank|pendrive|karta pamieci|mysz kompu|klawiatur|etui na telefon|szklo hartowane|zarowk|przedluzacz|zasilacz|adapter|pilot|router|glosnik|telefon|tablet |laptop|monitor|drukark|toner|tusz do drukark'],
  ['papiernicze', 'zeszyt|dlugopis|olowek|kredk|farbki|piornik|papier ksero|koperta|segregator|teczka|marker|zakreslacz|gumka|temperowk|plastelin|klej w sztyfcie|kalendarz|notes|karteczki|papier a4|blok rysunk|blok techniczny|nozyczki|linijka|zszywk|zszywacz|dziurkacz|spinacze|tasma klejac|brystol|plecak szkoln'],
  ['odziez', 'skarpet|majtki|bielizn|koszulk|t-shirt|spodnie|bluza|kurtka|sweter|czapka|rekawic|szalik|buty|obuwie|kapcie|klapki|tenisowk|sandal|rajstop|pizam|sukienk|spodnic|koszula|kombinezon|stroj kapiel|ubrani|pasek do spodni|legins|dres|podkolan|stopki'],
  ['alkohol', 'piwo|piwa|wino|wina |wodk|whisky|whiskey|rum |gin |likier|nalewk|prosecco|szampan|cydr|koniak|brandy|tequila|aperol|campari|jagermeister|lager|porter|alkohol|pilsner'],
  ['apteka', 'apteka|tabletki na|tabletki przeciw|leki|lek |ibuprom|paracetamol|apap|witamin|suplement|plaster|bandaz|termometr|krople do|aspiryn|probiotyk|masc |magnez|ibuprofen|nurofen|gripex|strepsils|aviomarin|rutinoscorbin|syrop na|zel na|zel przeciw|na kaszel|na bol|na gardlo|rehydrac|elektrolity|test ciazow|maseczk chirurg|rekawiczki jednoraz|woda utleniona|spirytus salicyl'],
  ['kosmetyki', 'krem |krem do|balsam|perfum|lakier do wlosow|tusz do rzes|puder|szminka|zmywacz|plyn micel|podklad|cien do powiek|pomadka|lakier do paznokci|maska do twarzy|serum|tonik do twarzy|kosmetyk|maseczk|farba do wlosow|bronzer|eyeliner|rozswietlacz|woda toaletowa|mgielka|odzywka do rzes|olejek do twarzy|plyn do demakijazu'],
  ['higiena', 'szampon|odzywka do wlosow|mydlo|zel pod prysznic|pasta do zebow|szczoteczk|dezodorant|papier toaletowy|chusteczk|podpask|tampon|wata |watki|patyczki|platki kosmet|golark|maszynk|pianka do golenia|plyn do kapieli|nawilzane|waciki|plyn do plukania|nic dentystyczna|prezerwatyw|zel do mycia|zel do higieny|krem do rak|oliwka|talk|do zebow|ręcznik higien|recznik higien|wkladki|plyn intymny|zel intymny|plyn do ust'],
  ['chemia', 'proszek do prania|plyn do|tabletki do zmywarki|kapsulki do prania|odswiezacz|domestos|ajax|cif |mydlo w plynie|worki na smieci|worki|gabk|scierk|folia|papier do pieczenia|reczniki papierowe|recznik papierowy|odkamieniacz|sol do zmywarki|rekawiczki|zmiekczacz|silan|lenor|vanish|calgon|odplamiacz|srodek czystosci|szczotk|kostka do wc|zel do wc|wc |ludwik|pronto|mop|wiadro|zapalki|swieczk|znicz|przeciw mol|mole|owadobojcz|na muchy|na mrowki|odtluszcz|odrdzew|do kuchni|do lazienki|do okien|do podlog|pranie|zmywar|do prania|torebki|zaparzacz'],
  ['rosliny', 'roza|rozy|roze |rozu|kwiat|bukiet|tulipan|storczyk|orchide|lilia|lilie|chryzantem|stokrot|hiacynt|narcyz|frezj|peoni|hortensj|begoni|pelargoni|fiolek|sukulent|kaktus|paproc|fikus|zamiokulk|sansewier|aloes|skrzydlokwiat|roslin|sadzonk|doniczk|ziemia do|ziemia uniwers|torf|nawoz|odzywk do roslin|substrat|perlit|keramzyt|wieniec|stroik|choink|jemiol|poinsecj|wrzos|bratek|surfini|trawnik|cebulki kwiat'],
  ['dom', 'zarowk|swieca|lampka|ogrod|narzedzi|srubk|gwozdz|tasma|klej|farba|pedzel|zamek|zawias|wieszak|poduszk|koc |przescieradl|recznik|obrus|zaslon|dywan|garnek|patelni|sztucc|talerz|kubek|szklank|noz |deska|pojemnik|termos|butelka|czajnik|toster|odkurzacz|zelazko|suszark|parasol|latark|kosz |pudelko|organizer|lustro|wazon|materac|prescieradlo|pościel|poscie|koldra|mebl|lampa|przybor|kuchenn|wkret|wiertl|mlotek|drabin|kolki'],
  ['sery', 'ser |sera|sery|serow|serek|serka|mozzarell|parmezan|feta|gouda|edam|cheddar|ricott|mascarpone|camembert|brie|oscypek|twarog|twarozek|halloumi|gorgonzol|rokpol|tylzyck|zolty ser|topiony|tarty ser'],
  ['wedliny', 'szynk|kielbas|kabanos|parowk|salami|mortadel|boczek|pasztet|poledwic|wedlin|baleron|kaszank|chorizo|prosciutto|schab pieczony|krakowsk|podwawelsk|mielonk|salceson|sokolk|kiszka|wedzon|bekon|pancett|parmenska'],
  ['mrozonki', 'mrozon|lody|lod |hortex|paluszki rybne|frytki|warzywa na patelni|mrozonk|lodz'],
  ['ryby', 'ryb|losos|dorsz|sledz|tunczyk|makrel|pstrag|krewetk|karp|mintaj|sandacz|panga|owoce morza|sardynk|halibut|tilapi|szprot|kalmar|mule |ostryg|dorad|labraks|anchois|miruna|morszczuk|surimi|kawior'],
  ['mieso', 'mies|kurczak|kurcz|piers|udk|schab|karkow|wieprzow|wolow|indyk|mielon|zeberk|kotlet|stek|lopatk|golonk|watrob|skrzydelk|cielec|kaczk|krolik|rolad|bitk|gulasz|filet|pulpet|flaczki|baranin|jagniec|burger|hamburger|antrykot|szponder|rosol|drob|rostbef|ozorek|serca|zoladki|poledwiczk'],
  ['nabial', 'mlek|masl|smietan|jogurt|kefir|maslank|jaj|margaryn|serwatk|skyr|actimel|danio|pudding|twarozk|mleczn|zott|jogobella|bakoma|piatnica|mlekovita|oatly|alpro|serniczk|deser mleczny|galaretk mlecz|bita smietan|maslo|jajk|jajek|smietank|ayran|maslanka'],
  ['pieczywo', 'chleb|bulk|bagiet|chalk|rogal|drozdzowk|tost|pieczyw|precel|ciabatt|pita|tortill|buleczk|grahamk|paczek|chrupk|wafle ryz|obwarzan|bagietk|rogalik|zakwas|razow|zytni'],
  ['warzywa', 'ziemniak|kartofl|marchew|cebul|czosnek|pomidor|ogorek|ogork|papryk|salat|szpinak|brokul|kalafior|kapust|burak|seler|pietruszk|por |pory|cukini|dyni|rzodkiew|baklazan|kukurydz|fasolk|groszek|szczypior|koper|natk|rukol|jarmuz|pieczark|grzyb|brukselk|batat|imbir|rzepa|warzyw|awokado|bazyli|mieta|kolendr|rzezuch|cykori|szparag|bob |kabaczek|zielenin|boczniak|chrzan swiezy|kiszona kapusta|sałat|mix salat'],
  ['owoce', 'jablk|banan|pomarancz|cytryn|limonk|gruszk|winogron|truskawk|malin|jagod|borowk|wisni|czeresn|brzoskwin|nektaryn|sliwk|arbuz|melon|kiwi|ananas|mango|mandarynk|grejpfrut|owoc|morel|porzeczk|agrest|figi|daktyl|rodzynk|granat|papaja|marakuj|klementynk|jezyn|zurawin|suszone'],
  ['napoje', 'woda|wody|sok |soki|soku|napoj|cola|pepsi|fanta|sprite|herbat|kaw|cappuccino|latte|kakao|lemoniad|oranzad|energet|tonik|mineraln|izotonik|kompot|nektar|red bull|syrop do|smoothie|woda kokos|yerba|matcha|napoj roslin'],
  ['slodycze', 'czekolad|baton|ciastk|ciasto|wafel|zelk|cukierk|lizak|chips|chrupki|paluszk|popcorn|krakers|herbatnik|slodycz|biszkopt|pralin|snickers|mars |oreo|prince|ptasie mleczko|krowk|marcepan|chalwa|budyn|piernik|pierniczk|lukier|posypk|draze|guma do zucia|gumy|mentos|tic tac|haribo|kinder|milka|lindt|wedel|torcik|babeczk|muffin|ptys|sernik|nutell|krem czekolad|chalw|rogaliki|ptasie|batonik|orzech w czekol|kisiel'],
  ['gotowe', 'pizza|zapiekank|hot dog|nachos|sushi|danie gotow|kebab|krokiet|pierogi|nalesnik|golabk|bigos|lasagn|zupa gotow|kanapk|wrap|sandwich|gotow|ravioli|gnocchi|kopytk|knedle|pyzy|placki|zurek|barszcz gotow|zupka|zupa|instant|chinska|ramen'],
  ['konserwy', 'konserw|puszk|sloik|ogorki kiszone|kiszon|marynat|dzem|powidl|konfitur|miod|pasta kanapkowa|fasola w|kukurydza w|groszek konserw|tunczyk w|oliwki|kapary|buraczki|ogorki konserwowe|mus owocowy|pomidory w puszce|ananas w puszce|brzoskwinie w puszce|ciecierzyca w|fasola czerwona|fasola biala|soczewica w|chrzan|musztard|ketchup|mus jablkowy|przecier'],
  ['przyprawy', 'przypraw|pieprz|cynamon|wanili|oregano|majeranek|tymianek|rozmaryn|curry|kurkuma|gozdzik|ziele angielskie|lisc laurowy|kmin|galk|vegeta|maggi|kostk|bulion|sos |sosy|majonez|oliw|olej|ocet|sojowy|tabasco|sriracha|pesto|passata|koncentrat|dressing|sol morska|sol himalaj|papryka mielona|papryka slodka|papryka ostra|chili|czosnek granul|cebula granul|ziola|prowansalskie|szafran|kardamon|anyz|gozdziki|vegeta|gorczyc'],
  ['suche', 'maka|maki|makaron|ryz|kasz|platki|cukier|cukr|sol |soli|bulka tart|drozdze|proszek do pieczenia|soda|zelatyn|musli|granola|nasiona|siemie|chia|ciecierzyc|soczewic|skrobi|panko|orzech|orzeszk|migdal|bakali|kuskus|bulgur|polenta|otreb|wiorki|owsian|spaghetti|penne|nitki|tagliatelle|slonecznik|pestki|sezam|len |mak |mak$|slodzik|ksylitol|erytrol|stewia|maka ziemniacz|mak niebieski|cukier puder|cukier brazow|cukier trzcin|cukier wanil|kisiel|budyn w proszku|mieszanka|kakao w proszku']
];
const pcatName = k => (PCATS.find(c => c[0] === k) || ['inne', 'Inne'])[1];
const validPcat = k => (PCATS.some(c => c[0] === k) ? k : '');
const deacc = t => String(t || '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function guessPcat(text) {
  const t = ' ' + deacc(text).trim() + ' ';
  for (const [k, rx] of PCAT_RULES) if (new RegExp('(?<![\\p{L}])(?:' + rx + ')', 'u').test(t)) return k;
  return 'inne';
}
const pcatOf = x => (x.catSet && validPcat(x.cat)) || (x.cat && x.cat !== 'inne' && validPcat(x.cat)) || guessPcat(x.text || x.name);
const pcatTag = k => '<span class="rtag pc-' + k + '">' + ic('p_' + k, 13, 2.2) + esc(pcatName(k)) + '</span>';
/* pieniądze */
const money = n => (Math.round((+n || 0) * 100) / 100).toFixed(2).replace('.', ',') + ' zł';
const parsePrice = v => { const n = parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.').replace(/[^0-9.\-]/g, '')); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const normName = t => String(t || '').toLowerCase().replace(/[0-9.,]+\s*(g|kg|ml|l|szt|x)\b/g, ' ').replace(/[^a-ząćęłńóśźż ]/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------- kategorie przepisów ---------- */
const RCATS = [['sniadania', 'Śniadania'], ['obiady', 'Obiady'], ['kolacje', 'Kolacje'], ['zupy', 'Zupy'], ['miesa', 'Mięsa'], ['ryby', 'Ryby'], ['makarony', 'Makarony'], ['salatki', 'Sałatki'], ['przekaski', 'Przekąski'], ['ciasta', 'Ciasta'], ['desery', 'Desery'], ['pieczywo', 'Pieczywo'], ['napoje', 'Napoje'], ['wege', 'Wegetariańskie'], ['swieta', 'Święta'], ['przetwory', 'Sosy i przetwory'], ['grill', 'Grill'], ['bezglutenu', 'Bez glutenu']];
const RCAT_RULES = [
  ['sniadania', 'śniadani|owsiank|jajecznic|omlet|nalesnik|naleśnik|granola|jajka na|kanapk|tost|szakszuk|placusz|racuch|gofry|pancake|müsli|musli', ''],
  ['kolacje', 'kolacj', ''],
  ['zupy', 'zup|rosół|rosol|barszcz|krem z|krupnik|żurek|zurek|chłodnik|chlodnik|bulion|gulasz|flaki|ogórkow|pomidorow|grochów|fasolow', ''],
  ['miesa', 'kurczak|schab|kotlet|wieprzow|wołow|wolow|indyk|karkówk|karkowk|mielon|żeberk|zeberk|pieczeń|pieczen|polędwic|poledwic|udko|udka|pierś z|piers z|bitki|rolad|kaczk|golonk|boczek|stek|pulpet|gołąbk|golabk|schabow', ''],
  ['ryby', 'ryb|łosoś|losos|dorsz|pstrąg|pstrag|śledź|sledz|tuńczyk|tunczyk|krewetk|owoce morza|karp|sandacz|halibut|mintaj', ''],
  ['makarony', 'makaron|spaghetti|lasagne|lazanie|penne|tagliatelle|pierogi|kluski|kopytka|gnocchi|ravioli|carbonara|bolognese|ryż|ryz|risotto|knedl|łazank|lazank|naleśniki z', ''],
  ['salatki', 'sałatk|salatk|surówk|surowk|bowl|coleslaw|sałata|salata', ''],
  ['przekaski', 'burger|tortilla|wrap|pizza|zapiekank|hot dog|nachos|frytki|kanapk|przekąsk|przekask|przystawk|tapas|bruschett|quesadill|falafel|kebab|focaccia|nuggets|paluszki|guacamole|hummus|pasta do', ''],
  ['ciasta', 'ciast|sernik|babk|szarlotk|murzynek|brownie|tort|makowiec|piernik|drożdżów|drozdzow|muffin|babeczk|ciastk|focaccia słodk|kruche|pączk|paczk|faworki|keks|biszkopt|beza|pavlova|rogal|struc', 'tarta'],
  ['desery', 'deser|budyń|budyn|krem |mus |lody|panna cotta|tiramisu|galaretk|kisiel|parfait|semifreddo|czekolad|ryż na mleku|jogurtow', ''],
  ['pieczywo', 'chleb|bułk|bulk|bagiet|chałk|chalk|rogalik|zakwas|ciabatta|pita|precel|grzank', ''],
  ['napoje', 'napój|napoj|koktajl|smoothie|kompot|lemoniad|herbat|kawa|latte|sok |shake|drink|nalewk|grzaniec|kakao|mojito|woda smakow', ''],
  ['wege', 'wegetari|wegań|wegan|vegan|bezmięs|bezmies|na bazie roślin', ''],
  ['swieta', 'świąt|swiat|wigili|wielkanoc|bożonarodz|bozonarodz|sylwest|barszcz czerwony z uszk|uszka|pierniki|sernik wiedeński|karp po|śledzie|babka wielkanoc|mazurek|makowiec|piernik', ''],
  ['przetwory', 'sos|dżem|dzem|przetwor|konfitur|marynat|ogórki kiszone|kiszon|ketchup|pesto|dressing|powidła|powidla|chutney|salsa|syrop|zaprawy|majonez|musztard|vinaigrette', ''],
  ['grill', 'grill|grillow|szaszłyk|szaszlyk|kiełbask|kielbask|żeberka z grilla|barbecue|bbq', ''],
]
const rcatName = k => (RCATS.find(c => c[0] === k) || [k, k])[1];
const validRcats = a => [...new Set((Array.isArray(a) ? a : []).map(x => String(x || '').toLowerCase().replace(/[^a-z]/g, '')).filter(k => RCATS.some(c => c[0] === k)))];
const GLUTEN_RX = /bez\s+glutenu|bezglutenow|gluten[\s-]*free|gluten free/i;
function guessRcats(r) {
  const t = String(r.title || '').toLowerCase(), out = [];
  for (const [k, pre] of RCAT_RULES) {
    if (pre && new RegExp('(?<![\\p{L}])(?:' + pre + ')', 'u').test(t)) out.push(k);
    if (out.length >= 2) break;
  }
  if (GLUTEN_RX.test(String(r.title || '') + ' ' + String(r.notes || ''))) out.push('bezglutenu');
  return out;
}
const rcatsOf = r => (Array.isArray(r.cats) ? validRcats(r.cats) : guessRcats(r));
const rcatTag = k => { const c = RCATS.find(x => x[0] === k); return c ? '<span class="rtag rc-' + k + '">' + ic('r_' + k, 13, 2.2) + esc(c[1]) + '</span>' : ''; };

function ic(n, size, sw, fill) {
  return '<svg class="i" width="' + (size || 26) + '" height="' + (size || 26) + '" viewBox="0 0 24 24" fill="' + (fill || 'none') +
    '" stroke="currentColor" stroke-width="' + (sw || 1.9) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[n] || '') + '</svg>';
}
const star = (on, size) => '<span style="color:' + (on ? '#F2B21B' : '#B8ADA4') + '">' + ic('star', size || 24, 1.7, on ? 'currentColor' : 'none') + '</span>';
const rz = n => n === 1 ? 'rzecz' : 'rzeczy';
const fmtTime = m => m >= 60 ? Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : '') : m + ' min';
const BACK_BTN = () => '<button class="ibtn round" data-act="back" aria-label="Wstecz">' + ic('back', 24, 2.2) + '</button>';
const hdr = (title, _back, right) => '<div class="hdr">' + BACK_BTN() + '<h1>' + title + '</h1>' + (right || '') + '</div>';
const tile = (act, icon, color, label, v) => '<button class="tile" data-act="' + act + '"' + (v ? ' data-v="' + v + '"' : '') + '><span class="ico ' + color + '">' + ic(icon, 28) + '</span>' + label + '</button>';

function vStart() {
  const td = today(), now = new Date();
  const ev = S.events.filter(e => occursOn(e, td)).map(e => occ(e, td)).sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
  const pl = S.plants.filter(plantOwned).filter(p => { const d = plantDue(p); return d.water <= 0 || d.fert <= 0; });
  const open = S.shopping.filter(x => !x.done).length;
  const overdue = S.events.filter(e => !e.rep && e.kind === 'task' && !e.done && e.date < td);
  let rows = '', count = 0;
  overdue.forEach(e => { rows += evRow(e, true); count++; });
  ev.filter(e => !e.done).forEach(e => { rows += evRow(e); count++; });
  const doneN = ev.filter(e => e.done).length;
  pl.forEach(p => {
    count++;
    const w = plantDue(p).water <= 0;
    rows += '<div class="prow"><span class="ico sm c-green">' + ic(w ? 'drop' : 'leaf') + '</span><div class="grow"><div class="t">' + esc(p.name) +
      '</div><div class="muted">Rośliny · ' + (w ? 'podlej dziś' : 'nawieź dziś') + '</div></div><button class="btn sm ghost" data-act="' + (w ? 'plantWater' : 'plantFert') + '" data-id="' + p.id + '">' + (w ? 'Podlane' : 'Nawiezione') + '</button></div>';
  });
  if (open) rows += '<div class="prow" data-act="tab" data-v="shopping" style="cursor:pointer"><span class="ico sm c-pink">' + ic('cart') + '</span><div class="grow"><div class="t">' + open + ' ' + rz(open) + ' do kupienia</div><div class="muted">Zakupy</div></div></div>';
  if (!rows) rows = '<div class="muted" style="padding:16px 0">' + (doneN ? 'Wszystko na dziś zrobione - świetnie!' : 'Na dziś pusto - miłego dnia!') + '</div>';
  const sum = count ? 'Masz dziś ' + count + ' ' + rz(count) + ' w planie' : (doneN ? 'Na dziś wszystko zrobione' : 'Na dziś nic nie zaplanowano');
  const dateStr = cap1(now.toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' }));
  return '<div class="hero"><div class="sun">' + ic('sun', 32) + '</div><div class="d">' + esc(dateStr) + '</div><h1>Hej ' + esc(S.settings.name) + '!</h1><div class="s">' + sum + '</div></div>' +
    '<label class="search">' + ic('search', 22, 2) + '<input id="gsearch" placeholder="Szukaj wszędzie…" aria-label="Szukaj wszędzie" data-enter="gsearch"></label>' +
    '<div class="row" style="margin:24px 0 10px"><h2 class="grow" style="margin:0">Plan dnia</h2>' +
    '<button class="btn sm" data-act="newEvent">' + ic('plus', 18, 2.6) + 'Wydarzenie</button>' +
    '<button class="ibtn round" style="width:44px;min-width:44px;min-height:44px" data-act="go" data-v="events" aria-label="Kalendarz">' + ic('cal', 22) + '</button></div>' +
    '<div class="card flush">' + rows + '</div>' +
    '<h2>Szybkie akcje</h2><div class="grid">' +
    (layout() === 'A' ? tile('go', 'chat', 'c-purple', 'Asystent', 'chat') + tile('newNote', 'note', 'c-yellow', 'Notatka') : tile('newNote', 'note', 'c-yellow', 'Notatka') + tile('go', 'link', 'c-blue', 'Linki', 'links')) + tile('go', 'leaf', 'c-green', 'Rośliny', 'plants') + '</div>' +
    '';
}
function evRow(e, late, edit) {
  const cat = catOf(e);
  const lead = '<button class="ecat cat-' + cat + (e.done ? ' ok' : '') + '" data-act="evDone" data-id="' + e.id + '" data-date="' + (e.occDate || '') + '" aria-label="' + (e.done ? 'Cofnij' : 'Oznacz jako zrobione') + '">' + (e.done ? ic('check', 24, 3.2) : ic('k_' + cat, 24, 2)) + '</button>';
  // ekran główny: tylko godzina; szczegóły powtarzania widać w kalendarzu
  const meta = (edit ? [e.time, e.kind === 'task' ? 'zadanie' : 'wydarzenie', e.rep ? '🔁 ' + repLabel(e) : ''] : [e.time, e.kind === 'task' ? 'zadanie' : '']).filter(Boolean).join(' · ');
  return '<div class="prow">' + lead + '<div class="grow ' + (e.done ? 'done' : '') + '"' + (edit ? ' data-act="editEvent" data-id="' + e.id + '"' : '') + '><div class="t">' + esc(e.title) + '</div><div class="muted">' + esc(meta) +
    (late ? ' · <span class=warn>zaległe</span>' : '') + (e.note ? '<br>' + esc(e.note) : '') + '</div></div></div>';
}

/* --- Linki --- */
let linkFilter = 'Wszystkie';
function linkCard(l) {
  const src = sourceOf(l.url);
  const tags = (l.tags || []).map(t => '<span class="chip yellow">' + esc(t) + '</span>').join('');
  const note = l.note ? '<div class="muted" style="margin-top:6px">' + esc(l.note) + '</div>' : '';
  const btns = '<div class="btns"><button class="btn sm" data-act="openLink" data-id="' + l.id + '">Otwórz</button><button class="btn sm ghost" data-act="editLink" data-id="' + l.id + '">Zmień nazwę</button><button class="btn sm red" data-act="delLink" data-id="' + l.id + '">Usuń</button></div>';
  if (l.img) {
    return '<div class="lcard"><div class="limg"><img src="' + esc(l.img) + '" alt="" loading="lazy" onerror="this.parentNode.classList.add(\'ph\',\'blue\');this.remove()"><span class="src">' + esc(src) + '</span></div>' +
      '<div class="lbody"><h3>' + esc(l.title || l.url) + '</h3><div style="margin-top:8px">' + tags + '</div>' + note + btns + '</div></div>';
  }
  return '<div class="card"><div class="row"><span class="thumb sm ph green">' + ic('link', 30) + '</span><div class="grow"><h3>' + esc(l.title || l.url) + '</h3><div class="muted">' + esc(src) + '</div></div></div>' +
    (tags ? '<div style="margin-top:8px">' + tags + '</div>' : '') + note + btns + '</div>';
}
function listLinks(q) {
  q = (q || '').toLowerCase();
  const ls = S.links.filter(l => (linkFilter === 'Wszystkie' || sourceOf(l.url) === linkFilter) &&
    (!q || (l.title + ' ' + l.url + ' ' + (l.tags || []).join(' ') + ' ' + (l.note || '')).toLowerCase().includes(q)));
  if (!ls.length) return '<div class="muted card">Brak zapisanych linków. Użyj „Udostępnij” w innej aplikacji i wybierz Mój Dzień, albo wklej link przyciskiem +.</div>';
  return ls.map(linkCard).join('');
}
function vLinks() {
  const srcs = ['Wszystkie'].concat([...new Set(S.links.map(l => sourceOf(l.url)))].slice(0, 5));
  if (!srcs.includes(linkFilter)) linkFilter = 'Wszystkie';
  const pills = srcs.length > 2 ? '<div class="pills" style="margin:12px 0 4px">' + srcs.map(k => '<button class="chip ' + (linkFilter === k ? 'act' : 'plain') + '" data-act="linkFilter" data-k="' + esc(k) + '">' + esc(k) + '</button>').join('') + '</div>' : '';
  return hdr('Moje linki') + '<div class="muted" style="margin:-8px 0 12px">Wszystko, co zapisane, w jednym miejscu</div>' +
    '<label class="search">' + ic('search', 22, 2) + '<input id="lq" placeholder="Szukaj w linkach…" aria-label="Szukaj w linkach" data-live="links"></label>' + pills + '<div id="list">' + listLinks('') + '</div>';
}

/* --- Przepisy --- */
function metaChips(r, f) {
  const c = [];
  if (r.servings) c.push(['', Math.round(r.servings * f * 10) / 10 + ' porcji']);
  if (r.total) c.push(['blue', fmtTime(r.total)]);
  if (r.yieldText) c.push(['', r.yieldText]);
  const t = [r.temp ? r.temp + '°C' : '', r.cook ? r.cook + ' min' : ''].filter(Boolean).join(' · ');
  if (t) c.push(['yellow', t]);
  return c.map(x => '<span class="chip ' + x[0] + '">' + esc(x[1]) + '</span>').join('');
}
let rcatSel = '';
function listRecipes(q, onlyFav) {
  let res = searchRecipes(q);
  if (onlyFav) res = res.filter(x => x.r.fav);
  if (rcatSel) res = res.filter(x => rcatsOf(x.r).includes(rcatSel));
  if (!res.length) return '<div class="muted card">' + (S.recipes.length ? 'Nic nie pasuje.' : 'Brak przepisów. Wklej tekst, link lub zdjęcie przepisu przyciskiem + - AI zrobi z tego kartę.') + '</div>';
  return res.map(x => {
    const r = x.r, n = r.groups.reduce((a, g) => a + g.items.length, 0);
    const tags = rcatsOf(r).map(rcatTag).join('');
    const have = x.of ? '<span class="chip green">masz ' + x.hit + '/' + x.of + '</span>' : '';
    if (r.image) {
      return '<div class="lcard" data-act="openRecipe" data-id="' + r.id + '"><div class="limg" style="height:170px"><img src="' + esc(r.image) + '" alt="" loading="lazy" onerror="this.parentNode.classList.add(\'ph\');this.remove()"></div>' +
        '<div class="lbody"><div class="row"><h3 class="grow">' + esc(r.title) + '</h3>' + (r.fav ? star(true, 22) : '') + '</div><div style="margin-top:8px">' + metaChips(r, 1) + have + '</div>' + (tags ? '<div class="rtags">' + tags + '</div>' : '') + '</div></div>';
    }
    return '<div class="card tap rcard" data-act="openRecipe" data-id="' + r.id + '"><span class="thumb sm ph">' + ic('cook', 30, 1.6) + '</span><div class="grow"><h3>' + (r.fav ? '<span style="color:#F2B21B">★</span> ' : '') + esc(r.title) +
      '</h3><div class="muted" style="margin-top:4px">' + (r.servings ? r.servings + ' porcji · ' : '') + n + ' składników</div>' + (tags ? '<div class="rtags">' + tags + '</div>' : '') + have + '</div></div>';
  }).join('');
}
let favOnly = false;
function vRecipes() {
  return hdr('Przepisy', false, '<button class="ibtn round" data-act="toggleFav" aria-label="Ulubione">' + star(favOnly, 24) + '</button>') +
    '<label class="search">' + ic('search', 22, 2) + '<input id="rq" placeholder="Szukaj lub: co z jajek i mleka?" aria-label="Szukaj przepisu" data-live="recipes"></label>' +
    rcatBar() + '<div id="list" style="margin-top:10px">' + listRecipes('', favOnly) + '</div>';
}
function rcatBar() {
  const used = new Set(); S.recipes.forEach(r => rcatsOf(r).forEach(k => used.add(k)));
  if (rcatSel && !used.has(rcatSel)) rcatSel = '';
  if (!used.size) return '';
  return '<div class="rbar"><button class="rf' + (rcatSel ? '' : ' sel') + '" data-act="rcatFilter" data-c="">Wszystkie</button>' +
    RCATS.filter(c => used.has(c[0])).map(c => '<button class="rf rc-' + c[0] + (rcatSel === c[0] ? ' sel' : '') + '" data-act="rcatFilter" data-c="' + c[0] + '"><span class="ri">' + ic('r_' + c[0], 17, 2.1) + '</span>' + c[1] + '</button>').join('') + '</div>';
}
function vRecipe(id) {
  const r = S.recipes.find(x => x.id === id);
  if (!r) return hdr('Przepis', true) + '<div class="muted">Nie znaleziono.</div>';
  const seg = [0.5, 1, 2, 3].map(k => '<button class="' + (scale === k ? 'on' : '') + '" data-act="setScale" data-k="' + k + '">×' + String(k).replace('.', ',') + '</button>').join('');
  const hero = '<div class="rhero">' + (r.image ? '<img src="' + esc(r.image) + '" alt="" onerror="this.remove()">' : '<div class="ph" style="height:100%">' + ic('cook', 96, 1.2) + '</div>') +
    '<button class="ibtn round fl" style="left:18px" data-act="back" aria-label="Wstecz">' + ic('back', 24, 2.2) + '</button>' +
    '<button class="ibtn round fl" style="right:18px" data-act="favRecipe" data-id="' + r.id + '" aria-label="Ulubiony">' + star(r.fav, 26) + '</button></div>';
  const groups = r.groups.map(g => (g.name ? '<div style="margin-top:14px"><span class="chip yellow">' + esc(g.name) + '</span></div>' : '') +
    '<div class="card flush" style="margin-top:8px"><ul class="ing">' + g.items.map(i => '<li>' + esc(itemText(i, scale)) + '</li>').join('') + '</ul></div>').join('');
  const steps = r.steps.map((t, i) => '<div class="step"><div class="n">' + (i + 1) + '</div><div>' + esc(scaleText(t, scale)) + '</div></div>').join('');
  return hero + '<div class="rbody"><h1>' + esc(r.title) + '</h1>' + (rcatsOf(r).length ? '<div class="rtags" style="margin-top:10px">' + rcatsOf(r).map(rcatTag).join('') + '</div>' : '') + '<div style="margin-top:12px">' + metaChips(r, scale) + '</div>' +
    (r.source ? '<div class="muted" style="margin-top:6px">Źródło: ' + esc(domainOf(r.source) || r.source) + '</div>' : '') +
    '<button class="btn block" style="margin-top:18px" data-act="toShop" data-id="' + r.id + '">' + ic('cart', 24, 2) + 'Dodaj składniki do zakupów</button>' +
    '<div class="row" style="margin-top:24px"><h2 class="grow" style="margin:0">Składniki</h2><div class="seg">' + seg + '</div></div>' + groups +
    '<h2>Wykonanie</h2>' + steps +
    (r.notes ? '<h2>Notatki</h2><div class="card" style="white-space:pre-wrap">' + esc(r.notes) + '</div>' : '') +
    '<div class="btns" style="margin-top:20px"><button class="btn ghost" data-act="editRecipe" data-id="' + r.id + '">Edytuj</button><button class="btn red" data-act="delRecipe" data-id="' + r.id + '">Usuń</button></div></div>';
}

/* --- Zakupy --- */
function vShopping() {
  const items = S.shopping;
  const todo = items.filter(x => !x.done), done = items.filter(x => x.done);
  const est = todo.reduce((a, x) => a + ((priceInfo(x.text) || {}).est || 0), 0);
  const row = (x, show) => '<div class="prow"><button class="check ' + (x.done ? 'on' : '') + '" data-act="shopTick" data-id="' + x.id + '" aria-label="Kupione">' + (x.done ? ic('check', 18, 3) : '') + '</button>' +
    '<div class="grow ' + (x.done ? 'done' : '') + '" data-act="shopCat" data-id="' + x.id + '"><div class="t">' + (isFav(normName(x.text)) ? '<span style="color:#E8A400">★</span> ' : '') + esc(x.text) + '</div>' + (x.from ? '<div class="muted">' + esc(x.from) + '</div>' : '') + (show ? '<div style="margin-top:4px">' + pcatTag(pcatOf(x)) + '</div>' : '') + '</div>' + (priceInfo(x.text) ? '<div style="font-weight:700;font-size:13px;white-space:nowrap;margin-right:2px;color:var(--acc);background:rgba(238,122,56,.12);padding:4px 9px;border-radius:99px">' + priceInfo(x.text).label + '</div>' : '') +
    '<button class="ibtn round" style="box-shadow:none;background:transparent;color:#B8ADA4" data-act="shopDel" data-id="' + x.id + '" aria-label="Usuń">' + ic('x', 22, 2) + '</button></div>';
  const groups = {}; todo.forEach(x => { const k = pcatOf(x); (groups[k] = groups[k] || []).push(x); });
  const body = PCATS.filter(c => groups[c[0]]).map(c => '<div class="shgrp pc-' + c[0] + '"><span class="ri">' + ic('p_' + c[0], 16, 2.2) + '</span>' + c[1] + ' <span style="opacity:.7">(' + groups[c[0]].length + ')</span></div><div class="card flush" style="margin-top:6px">' + groups[c[0]].map(x => row(x, false)).join('') + '</div>').join('');
  return '<div class="hdr">' + BACK_BTN() + '<div class="grow"><h1>Zakupy</h1><div class="muted" style="margin-top:4px">' + todo.length + ' do kupienia · ' + done.length + ' w koszyku' + (est ? ' · ok. ' + money(est) : '') + '</div></div>' +
    (done.length ? '<button class="ibtn" data-act="shopClear">Usuń kupione</button>' : '') + '</div>' +
    '<div class="row"><label class="search grow" style="margin:0"><input id="newItem" placeholder="Dodaj produkt…" aria-label="Dodaj produkt" data-enter="shopAdd" data-live="shopfav" autocomplete="off"></label>' +
    '<button class="ibtn round" style="background:var(--acc);color:#fff;width:52px;height:52px;box-shadow:0 6px 16px rgba(200,69,26,.3)" data-act="shopAdd" aria-label="Dodaj">' + ic('plus', 26, 2.4) + '</button></div><div id="favSug" class="rbar" style="padding:8px 2px 0"></div>' +
    '<div class="btns" style="margin-top:6px"><button class="btn sm ghost" data-act="favList">⭐ Ulubione (' + favPool().length + ')</button></div>' +
    (body || '<div class="card flush" style="margin-top:16px"><div class="muted" style="padding:16px 0">Lista pusta</div></div>') +
    (done.length ? '<h2 style="color:var(--mut)">W koszyku</h2><div class="card flush">' + done.map(x => row(x, false)).join('') + '</div>' : '');
}

/* ---------- ulubione produkty (z paragonów i z gwiazdki) ---------- */
function favStats() {
  const m = {};
  (S.expenses || []).slice().sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.ts || 0) - (b.ts || 0)).forEach(e => (e.items || []).forEach(it => {
    const n = it.norm || normName(it.name); if (!n) return;
    const r = m[n] || (m[n] = { n: 0 }); r.n++; r.name = it.name; r.price = parsePrice(it.price); r.cat = it.cat; r.last = e.date; r.unit = it.unit || ''; r.unitPrice = it.unitPrice || 0; if (it.type) r.type = it.type;
  }));
  return m;
}
function favPool() {
  const st = favStats(), off = S.favOff || [], out = {};
  (S.favs || []).forEach(f => { const s = st[f.norm]; out[f.norm] = { norm: f.norm, name: f.name || (s && s.name), cat: f.cat || (s && s.cat), price: s ? s.price : f.price, n: s ? s.n : 0, manual: true, size: f.size || '', info: f.info || '', img: f.img || '', img2: f.img2 || '', hint: (s && s.type) || '' }; });
  Object.keys(st).forEach(n => { if (st[n].n >= 3 && !off.includes(n) && !out[n]) out[n] = { norm: n, name: st[n].name, cat: st[n].cat, price: st[n].price, n: st[n].n, hint: st[n].type || '' }; });
  const al = S.favAlias || {}; Object.values(out).forEach(f => { f.hint = (f.hint + ' ' + (al[f.norm] || []).join(' ')).trim(); });
  return Object.values(out).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'pl'));
}
const isFav = norm => favPool().some(f => f.norm === norm);
function favMatch(q) {
  const toks = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (String(q || '').trim().length < 2) return [];
  const have = new Set(S.shopping.filter(x => !x.done).map(x => norm(x.text)));
  return favPool().filter(f => !have.has(norm(f.name)) && toks.every(t => (f.name + ' ' + (f.hint || '')).toLowerCase().includes(t))).slice(0, 6);
}
function favChips(q) {
  return favMatch(q).map(f => '<button type="button" class="rf" style="padding-left:13px" data-act="favAdd" data-n="' + esc(f.norm) + '">⭐ ' + esc(f.name) + (f.price ? ' · ' + money(f.price) : '') + '</button>').join('');
}
function favToggle(name, cat, price) {
  const n = normName(name); if (!n) return false;
  S.favs = S.favs || []; S.favOff = S.favOff || [];
  if (isFav(n)) { S.favs = S.favs.filter(f => f.norm !== n); if (!S.favOff.includes(n)) S.favOff.push(n); save(); return false; }
  S.favOff = S.favOff.filter(x => x !== n); S.favs.push({ id: uid(), name: String(name).trim(), norm: n, cat: validPcat(cat) || guessPcat(name), price: parsePrice(price) }); save(); return true;
}
function priceInfo(t) {
  const n = normName(t); if (!n) return null;
  const st = favStats(); let r = st[n];
  if (!r) { const hit = Object.keys(st).filter(k => st[k].price && k.split(' ').includes(n)); if (hit.length === 1) r = st[hit[0]]; }
  if (r && r.unit === 'kg' && r.unitPrice) return { label: money(r.unitPrice) + '/kg', est: 0 };
  const v = priceFor(t); return v ? { label: money(v), est: v } : null;
}
function priceFor(t) {
  const n = normName(t); if (!n) return 0;
  const st = favStats(); if (st[n] && st[n].price) return st[n].price;
  const f = (S.favs || []).find(x => x.norm === n); if (f && f.price) return f.price;
  const hit = Object.keys(st).filter(k => st[k].price && k.split(' ').includes(n)); // np. "mleko" -> jedyny "mleko"
  return hit.length === 1 ? st[hit[0]].price : 0;
}
function favCatFor(t) { const f = favPool().find(x => norm(x.name) === norm(t)); return f ? f.cat : ''; }

/* --- Budżet --- */
let budMonth = '';
const monthKey = d => String(d).slice(0, 7);
const MONTHS = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień'];
const monthLabel = k => MONTHS[+k.slice(5, 7) - 1] + ' ' + k.slice(0, 4);
const shiftMonth = (k, n) => { const d = new Date(+k.slice(0, 4), +k.slice(5, 7) - 1 + n, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
const expItems = e => (e.items || []).map(it => ({ price: parsePrice(it.price), cat: validPcat(it.cat) || guessPcat(it.name), name: it.name }));
const expTotal = e => expItems(e).reduce((a, it) => a + it.price, 0);
function vBudget() {
  if (!budMonth) budMonth = monthKey(today());
  const B = S.budget || (S.budget = { limit: 0, cats: {} });
  const list = (S.expenses || []).filter(e => monthKey(e.date) === budMonth).sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.ts || 0) - (a.ts || 0));
  const byCat = {}; let spent = 0;
  list.forEach(e => expItems(e).forEach(it => { byCat[it.cat] = (byCat[it.cat] || 0) + it.price; spent += it.price; }));
  const lim = +B.limit || 0, pct = lim ? Math.min(100, spent / lim * 100) : 0, over = lim && spent > lim;
  let html = hdr('Budżet') +
    '<div class="row" style="justify-content:space-between;margin-bottom:10px"><button class="ibtn round" data-act="budMonth" data-n="-1" aria-label="Poprzedni miesiąc">' + ic('back', 22, 2.2) + '</button><h2 style="margin:0">' + monthLabel(budMonth) + '</h2><button class="ibtn round" data-act="budMonth" data-n="1" aria-label="Następny miesiąc" style="transform:rotate(180deg)">' + ic('back', 22, 2.2) + '</button></div>' +
    '<div class="card"><div class="muted">Wydano</div><div style="font-size:30px;font-weight:900;margin:2px 0">' + money(spent) + '</div>' +
    (lim ? '<div class="bar"><i style="width:' + pct + '%;background:' + (over ? '#D4455A' : pct > 80 ? '#E08600' : '#2E8B57') + '"></i></div><div class="' + (over ? 'warn' : 'muted') + '" style="margin-top:6px;font-weight:700">' + (over ? 'Przekroczono o ' + money(spent - lim) : 'Zostało ' + money(lim - spent)) + ' z ' + money(lim) + '</div>' : '<div class="muted">Nie ustawiono limitu miesięcznego</div>') +
    '<div class="btns"><button class="btn sm ghost" data-act="budLimit">Ustaw limity</button></div></div>' +
    '<div class="btns" style="margin:12px 0"><button class="btn" data-act="scanCam">📷 Skanuj paragon</button><button class="btn ghost" data-act="scanGal">🖼 Z galerii</button><button class="btn ghost" data-act="expNew">+ Wydatek</button></div>';
  const cats = PCATS.filter(c => byCat[c[0]] || +(B.cats || {})[c[0]]);
  if (cats.length) html += '<h2>Kategorie</h2><div class="card">' + cats.map(c => {
    const v = byCat[c[0]] || 0, cl = +(B.cats || {})[c[0]] || 0, pc = cl ? Math.min(100, v / cl * 100) : (spent ? v / spent * 100 : 0);
    return '<div style="margin:10px 0"><div class="row"><span class="ri pc-' + c[0] + '" style="display:inline-flex;width:30px;height:30px;border-radius:50%;align-items:center;justify-content:center;background:var(--rb);color:var(--rf)">' + ic('p_' + c[0], 16, 2.2) + '</span><div class="grow"><b>' + c[1] + '</b></div><div class="' + (cl && v > cl ? 'warn' : '') + '" style="font-weight:800">' + money(v) + (cl ? ' <span class="muted" style="font-weight:600">/ ' + money(cl) + '</span>' : '') + '</div></div>' +
      '<div class="bar pc-' + c[0] + '" style="margin-top:6px"><i style="width:' + pc + '%;background:' + (cl && v > cl ? '#D4455A' : 'var(--rf)') + '"></i></div></div>';
  }).join('') + '</div>';
  html += '<h2>Wydatki</h2>' + (list.length ? '<div class="card flush">' + list.map(e => '<div class="prow" data-act="expEdit" data-id="' + e.id + '"><div class="grow"><div class="t">' + esc(e.store || e.title || 'Wydatek') + '</div><div class="muted">' + esc(e.date) + ' · ' + (e.items || []).length + ' poz.' + (e.src === 'receipt' ? ' · paragon' : '') + '</div></div><div style="font-weight:800">' + money(expTotal(e)) + '</div></div>').join('') + '</div>' : '<div class="card muted">Brak wydatków w tym miesiącu. Zeskanuj paragon albo dodaj wydatek ręcznie.</div>');
  return html;
}

/* ---------- wydatki i skaner paragonów ---------- */
let expDraft = null;
function syncExp() {
  if (!expDraft) return;
  expDraft.store = val('xStore'); expDraft.date = val('xDate') || expDraft.date;
  expDraft.items.forEach((it, i) => { const n = $('#xn' + i), p = $('#xp' + i); if (n) it.name = n.value; if (p) it.price = p.value; });
}
function openExpenseEditor(e, keep) {
  expDraft = e;
  const rows = e.items.map((it, i) => { const c = validPcat(it.cat) || guessPcat(it.name);
    return '<div class="xrow"><div class="row" style="gap:8px"><div class="grow"><input id="xn' + i + '" value="' + esc(it.name) + '" placeholder="Produkt" style="margin:4px 0"></div><div style="width:84px"><input id="xp' + i + '" inputmode="decimal" value="' + esc(String(it.price === '' || it.price == null ? '' : String(it.price).replace('.', ','))) + '" placeholder="0,00" style="margin:4px 0;text-align:right"></div>' +
      '<button class="ibtn round" style="box-shadow:none;background:transparent;color:' + (isFav(normName(it.name)) ? '#F2B21B' : '#B8ADA4') + '" data-act="expStar" data-i="' + i + '" aria-label="Ulubione">' + ic('star', 22, 1.7, isFav(normName(it.name)) ? 'currentColor' : 'none') + '</button><button class="ibtn round" style="box-shadow:none;background:transparent;color:#B8ADA4" data-act="expDelRow" data-i="' + i + '" aria-label="Usuń pozycję">' + ic('x', 20, 2) + '</button></div>' +
      (it.unit === 'kg' && it.unitPrice ? '<div class="muted" style="margin:0 0 6px 2px">' + (it.qty ? String(it.qty).replace('.', ',') + ' kg × ' : '') + money(it.unitPrice) + '/kg</div>' : '') + '<div class="rbar" style="padding:0 0 6px">' + PCATS.map(k => '<button type="button" class="rf pc-' + k[0] + (k[0] === c ? ' sel' : '') + '" data-act="expPick" data-i="' + i + '" data-c="' + k[0] + '" style="padding:3px 10px 3px 4px"><span class="ri" style="width:22px;height:22px">' + ic('p_' + k[0], 13, 2.2) + '</span>' + k[1] + '</button>').join('') + '</div></div>'; }).join('');
  const total = e.items.reduce((a, it) => a + parsePrice(it.price), 0);
  sheet('<h1 style="font-size:22px">' + (e.id ? 'Edytuj wydatek' : e.src === 'receipt' ? 'Sprawdź paragon' : 'Nowy wydatek') + '</h1>' +
    (e.src === 'receipt' && !e.id ? '<div class="muted" style="margin-bottom:6px">AI mogło się pomylić - popraw nazwy, ceny i kategorie, a potem zapisz.</div>' : '') +
    '<label>Sklep</label><input id="xStore" value="' + esc(e.store || '') + '" placeholder="np. Biedronka"><label>Data</label><input id="xDate" type="date" value="' + esc(e.date) + '">' +
    '<label>Pozycje</label>' + rows + '<div class="btns"><button class="btn sm ghost" data-act="expAddRow">+ Pozycja</button></div>' +
    '<div style="font-size:18px;font-weight:900;margin:10px 0">Razem: ' + money(total) + '</div>' +
    '<div class="btns foot"><button class="btn" data-act="expSave">Zapisz</button>' + (e.id ? '<button class="btn red" data-act="expDel">Usuń</button>' : '') + '</div>');
  document.querySelectorAll('#panel .rbar .rf.sel').forEach(b => { b.parentNode.scrollLeft = Math.max(0, b.offsetLeft - 60); });
}
async function scanReceipt(cam) {
  if (!hasKey()) { toast('Dodaj klucz AI w Ustawieniach'); return; }
  const img = await pickImage(1800, cam); if (!img) return;
  busy(true, 'Czytam paragon…');
  try {
    const sys = 'Odczytujesz polskie paragony ze zdjęcia. Odpowiedz WYŁĄCZNIE JSON-em: {"store":"nazwa sklepu","date":"RRRR-MM-DD lub null","total":0.0,"items":[{"name":"nazwa produktu po polsku, bez skrótów jeśli to możliwe","type":"ogólny rodzaj produktu jednym słowem, np. serek, jogurt, szynka, mleko","price":0.0,"unit":"kg lub szt","qty":0.0,"unitPrice":0.0,"cat":"klucz kategorii"}]}. "price" to ŁĄCZNA kwota pozycji po rabatach (to, co faktycznie zapłacono za tę pozycję), z kropką jako separatorem - NIGDY cena za kilogram. Dla towarów na wagę (warzywa, owoce, wędliny, ser na wagę) ustaw unit="kg", qty=waga w kg (np. 0.350) i unitPrice=cena za 1 kg z paragonu. Dla towarów na sztuki unit="szt", qty=liczba sztuk, unitPrice=cena sztuki. Jeśli nie ma tych danych, pomiń pola unit/qty/unitPrice. Pomiń linie typu SUMA, PTU, RESZTA, GOTÓWKA, KARTA, numer paragonu i rabaty bez produktu. Kategorie (klucz): ' + PCATS.map(c => c[0] + ' = ' + c[1]).join(', ') + '.';
    const out = await claude({ system: sys, messages: [{ role: 'user', content: [imgBlock(img), { type: 'text', text: 'Odczytaj wszystkie pozycje z paragonu.' }] }], max: 4000 });
    const j = extractJSON(out);
    const items = (j.items || []).filter(it => it && it.name).map(it => ({ name: String(it.name).trim(), price: parsePrice(it.price), cat: validPcat(it.cat) || guessPcat(it.name), type: String(it.type || '').toLowerCase().trim().slice(0, 30), unit: /^kg$/i.test(it.unit || '') ? 'kg' : '', qty: parsePrice(it.qty) || 0, unitPrice: parsePrice(it.unitPrice) || 0 })).map(it => { if (it.unit === 'kg' && it.qty && it.unitPrice) { const calc = Math.round(it.qty * it.unitPrice * 100) / 100; if (!it.price || Math.abs(it.price - calc) > calc * 0.03) it.price = calc; } return it; });
    if (!items.length) throw new Error('nie znalazłem pozycji - zrób ostrzejsze zdjęcie całego paragonu');
    busy(false);
    openExpenseEditor({ id: '', date: /^\d{4}-\d{2}-\d{2}$/.test(j.date || '') ? j.date : today(), store: j.store || '', items, src: 'receipt' });
  } catch (e) { busy(false); toast('Nie udało się: ' + (e.message || e)); }
}

/* --- Więcej --- */

/* --- Ulubione produkty: ekran i dodawanie ze zdjęcia --- */
let favDraft = [];
function favRow(f, cardAct) {
  const a = ' data-act="favCard" data-n="' + esc(f.norm) + '"';
  return '<div class="prow">' + (f.img ? '<img src="' + f.img + '" alt=""' + a + ' style="width:50px;height:50px;border-radius:10px;object-fit:cover;flex:none;background:#fff">' : '') +
    '<div class="grow"' + a + '><div class="t">' + esc(f.name) + (f.size ? ' <span class="muted" style="font-weight:600">· ' + esc(f.size) + '</span>' : '') + '</div><div class="muted">' + pcatName(f.cat) + (f.price ? ' · ost. ' + money(f.price) : '') + (f.n ? ' · kupione ' + f.n + '×' : '') + '</div>' + (f.info ? '<div class="muted" style="margin-top:2px">' + esc(f.info) + '</div>' : '') + '</div>' +
    '<button class="ibtn round" style="box-shadow:none;background:transparent;color:var(--acc)" data-act="favAdd" data-n="' + esc(f.norm) + '" aria-label="Dodaj do zakupów">' + ic('cart', 22, 1.9) + '</button>' +
    '<button class="ibtn round" style="box-shadow:none;background:transparent;color:#F2B21B" data-act="favDel" data-n="' + esc(f.norm) + '" aria-label="Usuń z ulubionych">' + ic('star', 22, 1.7, 'currentColor') + '</button></div>';
}
function vFavs() {
  const pool = favPool();
  return hdr('Ulubione produkty') + '<div class="btns" style="margin:4px 0 10px"><button class="btn" data-act="favScanCam">📷 Dodaj ze zdjęcia</button><button class="btn ghost" data-act="favScanGal">🖼 Z galerii</button><button class="btn ghost" data-act="favNew">+ Ręcznie</button></div>' +
    '<div class="muted" style="margin-bottom:8px">Produkty ze zdjęć, z gwiazdką i kupione z paragonów co najmniej 3 razy. Dodasz je do zakupów przyciskiem z koszykiem.</div>' +
    (pool.length ? '<div class="card flush">' + pool.map(f => favRow(f)).join('') + '</div>' : '<div class="card"><div class="muted">Brak ulubionych. Zrób zdjęcie produktu, a dodam go tutaj.</div></div>');
}
let favFront = '';
const thumbOf = (url, w) => new Promise(res => { const im = new Image(); im.onload = () => { const k = Math.min(1, w / Math.max(im.width, im.height)), c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', 0.7)); }; im.onerror = () => res(''); im.src = url; });
async function favScan(cam) {
  if (!hasKey()) { toast('Dodaj klucz AI w Ustawieniach'); return; }
  const img = await pickImage(1400, cam); if (!img) return;
  favFront = img;
  sheet('<h1 style="font-size:22px">Teraz tył opakowania</h1><div class="muted" style="margin-bottom:10px">Zrób zdjęcie tyłu (skład, waga, producent) - dzięki temu będę mieć pełne dane. Przód już mam ✓</div><div class="btns"><button class="btn" data-act="favBackCam">📷 Zdjęcie tyłu</button><button class="btn ghost" data-act="favBackGal">🖼 Z galerii</button></div><div class="btns"><button class="btn ghost" data-act="favBackSkip">Pomiń - tylko przód</button></div>');
}
async function favBack(cam) {
  const back = await pickImage(1400, cam); if (!back) return;
  closeSheet(); favRun(favFront, back);
}
async function favRun(img, back) {
  busy(true, 'Rozpoznaję produkt…');
  try {
    const sys = 'Rozpoznajesz GŁÓWNY produkt na zdjęciu - ten na pierwszym planie, największy i najbardziej widoczny, na którym skupiony jest aparat. IGNORUJ tło i przedmioty dookoła (monitor, telefon, długopis, słuchawki, biurko itp.) oraz produkty zasłonięte lub częściowo widoczne. Zwróć dokładnie JEDEN produkt, chyba że na zdjęciu wyraźnie jest kilka takich samych ważnych produktów obok siebie (wtedy maks. 3). Odpowiedz WYŁĄCZNIE JSON-em: {"items":[{"name":"marka + nazwa + wariant po polsku, np. Coca-Cola Original Taste","type":"ogólny rodzaj jednym słowem, np. cola","cat":"klucz kategorii","size":"pojemność lub gramatura widoczna na opakowaniu, np. 1,75 l, albo null","info":"krótki opis po polsku (rodzaj, producent, najważniejsze cechy ze składu lub etykiety), np. Napój gazowany, Coca-Cola HBC"}]}. Kategorie (klucz): ' + PCATS.map(c => c[0] + ' = ' + c[1]).join(', ') + '.';
    const out = await claude({ system: sys, messages: [{ role: 'user', content: [imgBlock(img)].concat(back ? [imgBlock(back)] : []).concat([{ type: 'text', text: back ? 'Zdjęcie 1 to przód, zdjęcie 2 to tył tego samego produktu. Jaki to produkt? Weź pojemność/gramaturę, producenta i skład z tyłu.' : 'Jaki jest główny produkt na zdjęciu?' }]) }], max: 700 });
    const j = extractJSON(out);
    favDraft = (j.items || []).filter(it => it && it.name).slice(0, 3).map(it => ({ name: String(it.name).trim(), type: String(it.type || '').toLowerCase().trim().slice(0, 30), cat: validPcat(it.cat) || guessPcat(it.name), size: it.size && it.size !== 'null' ? String(it.size).trim() : '', info: String(it.info || '').trim(), on: true }));
    if (favDraft.length) { const th = await thumbOf(img, 380), th2 = back ? await thumbOf(back, 380) : ''; favDraft.forEach(d => { d.img = th; d.img2 = th2; }); }
    if (favDraft.length) {
      busy(true, 'Szukam informacji o produkcie…');
      try {
        await Promise.all(favDraft.map(async d => {
          const found = await webSearch(d.name + (d.size ? ' ' + d.size : '') + ' produkt pojemność gramatura opis');
          const o2 = await claude({ system: 'Na podstawie wyników wyszukiwania uzupełnij dane produktu. Odpowiedz WYŁĄCZNIE JSON-em: {"size":"najczęstsza pojemność/gramatura tego opakowania, np. 1,75 l","info":"1-2 krótkie zdania po polsku: czym jest produkt, rodzaj, producent, ewentualnie ważna cecha"}. Nie zgaduj - jeśli czegoś nie ma w wynikach, zostaw obecną wartość.', messages: [{ role: 'user', content: 'Produkt: ' + d.name + (d.size ? ' (z opakowania: ' + d.size + ')' : '') + '\nObecny opis: ' + d.info + '\n\nWYNIKI:\n' + String(found).slice(0, 4000) }], max: 300 });
          const r = extractJSON(o2); if (r) { if (r.size && !d.size) d.size = String(r.size).trim(); if (r.info) d.info = String(r.info).trim().slice(0, 220); }
        }));
      } catch (e) { /* bez informacji z internetu zostają dane ze zdjęcia */ }
    }
    busy(false);
    if (!favDraft.length) { toast('Nie rozpoznałem produktu - zrób ostrzejsze zdjęcie opakowania'); return; }
    favDraftSheet();
  } catch (e) { busy(false); toast('Nie udało się: ' + (e.message || e)); }
}
function favDraftSheet() {
  sheet('<h1 style="font-size:22px">Rozpoznane produkty</h1><div class="muted" style="margin-bottom:8px">Popraw nazwę i kategorię, odznacz to, czego nie chcesz.</div>' +
    favDraft.map((d, i) => '<div class="card" style="margin-bottom:8px">' + (d.img ? '<img src="' + d.img + '" alt="" style="height:90px;border-radius:10px;margin-bottom:8px">' : '') + '<div class="row"><button type="button" class="check ' + (d.on ? 'on' : '') + '" data-act="favDraftTick" data-i="' + i + '" aria-label="Dodaj">' + (d.on ? ic('check', 18, 3) : '') + '</button><input class="grow" id="fdn' + i + '" value="' + esc(d.name) + '" aria-label="Nazwa"></div>' +
      '<input id="fds' + i + '" value="' + esc(d.size || '') + '" placeholder="Pojemność / gramatura" style="margin-top:8px" aria-label="Pojemność"><textarea id="fdi' + i + '" rows="2" placeholder="Opis" style="margin-top:8px" aria-label="Opis">' + esc(d.info || '') + '</textarea><select id="fdc' + i + '" style="margin-top:8px">' + PCATS.map(c => '<option value="' + c[0] + '"' + (c[0] === d.cat ? ' selected' : '') + '>' + c[1] + '</option>').join('') + '</select></div>').join('') +
    '<div class="btns foot"><button class="btn" data-act="favDraftSave">⭐ Dodaj do ulubionych</button></div>');
}
function favDraftSync() { favDraft.forEach((d, i) => { const n = $('#fdn' + i), c = $('#fdc' + i), z = $('#fds' + i), f = $('#fdi' + i); if (n) d.name = n.value.trim(); if (c) d.cat = c.value; if (z) d.size = z.value.trim(); if (f) d.info = f.value.trim(); }); }
function favCardSheet(n) {
  const f = favPool().find(x => x.norm === n); if (!f) return;
  const st = favStats()[n] || {};
  sheet((f.img || f.img2 ? '<div class="row" style="gap:8px;margin-bottom:10px">' + [f.img, f.img2].filter(Boolean).map(u => '<img src="' + u + '" alt="" style="flex:1;min-width:0;max-height:210px;object-fit:contain;border-radius:12px;background:#fff">').join('') + '</div>' : '') +
    '<label>Nazwa</label><input id="fcName" value="' + esc(f.name) + '"><label>Pojemność / gramatura</label><input id="fcSize" value="' + esc(f.size || '') + '" placeholder="np. 1,75 l"><label>Opis</label><textarea id="fcInfo" rows="3" placeholder="Opis produktu">' + esc(f.info || '') + '</textarea>' +
    '<label>Kategoria</label><select id="fcCat">' + PCATS.map(c => '<option value="' + c[0] + '"' + (c[0] === f.cat ? ' selected' : '') + '>' + c[1] + '</option>').join('') + '</select>' +
    '<div class="muted" style="margin-top:10px">' + (st.unit === 'kg' && st.unitPrice ? 'Cena: ' + money(st.unitPrice) + '/kg' : f.price ? 'Ostatnia cena: ' + money(f.price) : 'Brak ceny - pojawi się po zeskanowaniu paragonu') + (f.n ? ' · kupione ' + f.n + '×' : '') + (st.last ? ' · ostatnio ' + st.last : '') + '</div>' +
    '<div class="btns foot"><button class="btn" data-act="favCardSave" data-n="' + esc(n) + '">Zapisz</button><button class="btn ghost" data-act="favAdd" data-n="' + esc(n) + '" data-close="1">🛒 Do zakupów</button><button class="btn ghost" data-act="favDel" data-n="' + esc(n) + '" data-close="1">☆ Usuń z ulubionych</button></div>');
}
function vMore() {
  return hdr('Więcej') + '<div class="grid">' +
    tile('go', 'cal', 'c-blue', 'Kalendarz', 'events') + tile('go', 'note', 'c-yellow', 'Notatki', 'notes') + tile('go', 'wallet', 'c-green', 'Budżet', 'budget') + tile('go', 'star', 'c-yellow', 'Ulubione produkty', 'favs') + tile('go', 'gear', 'c-pink', 'Ustawienia', 'settings') + '</div>';
}

/* --- Rośliny --- */
function plantCard(p) {
  const own = plantOwned(p), d = plantDue(p), c = p.care || {};
  const care = [['Światło', c.light], ['Wilgotność', c.hum], ['Temperatura', c.temp], ['Gleba', c.soil], ['Przesadzanie', c.repot]].filter(x => x[1]);
  const tox = c.toxic === 'tak' ? '<details><summary class="warn" style="font-weight:800;cursor:pointer">⚠ Trująca dla psów i kotów</summary>' + (c.toxNote ? '<div class="warn" style="margin-top:6px;font-weight:600">' + esc(c.toxNote) + '</div>' : '<div class="warn" style="margin-top:6px;font-weight:600">Brak szczegółów - sprawdź u weterynarza.</div>') + '</details>' : c.toxic === 'nie' ? '<span class="muted">Bezpieczna dla psów i kotów</span>' : '';
  return '<div class="card" style="position:relative"><button class="pedit" data-act="editPlant" data-id="' + p.id + '">✎ Edytuj</button>' + (p.img ? '<img class="thumb" src="' + p.img + '" alt="">' : '') +
    '<div class="row" style="margin-top:' + (p.img ? 12 : 0) + 'px' + (p.img ? '' : ';padding-right:84px') + '"><span class="ico sm c-green">' + ic('leaf') + '</span><div class="grow"><h3>' + esc(p.name) + '</h3>' +
    (own ? '<div>' + dueLabel(d.water, 'Podlewanie') + (p.fertDays ? ' · ' + dueLabel(d.fert, 'Nawożenie') : '') + '</div>' + (p.spot ? '<div class="muted">📍 ' + esc(p.spot) + '</div>' : '') : '<div class="muted">Na liście zakupów 🛒</div>') +
    '</div></div>' + (tox ? '<div style="margin-top:8px">' + tox + '</div>' : '') +
    (p.note ? '<div class="muted" style="margin-top:8px">' + esc(p.note) + '</div>' : '') +
    (care.length ? '<details style="margin-top:8px"><summary class="muted" style="font-weight:800">Karta pielęgnacji</summary>' + care.map(x => '<div style="margin-top:4px"><b>' + x[0] + ':</b> ' + esc(x[1]) + '</div>').join('') + '</details>' : '') +
    (own ? ((d.water <= 0 || (p.fertDays && d.fert <= 0)) ? '<div class="btns">' + (d.water <= 0 ? '<button class="btn sm" data-act="plantWater" data-id="' + p.id + '">Podlane</button>' : '') + (p.fertDays && d.fert <= 0 ? '<button class="btn sm" data-act="plantFert" data-id="' + p.id + '">Nawiezione</button>' : '') + '</div>' : '') : '<div class="btns"><button class="btn sm" data-act="plantOwn" data-id="' + p.id + '">Mam ją</button></div>') + '</div>';
}
function roomBtns(list) {
  const due = list.map(p => ({ p, d: plantDue(p) })), w = due.filter(x => x.d.water <= 0).map(x => x.p.id), f = due.filter(x => x.p.fertDays && x.d.fert <= 0).map(x => x.p.id);
  return (w.length ? '<button class="btn sm" data-act="plantWaterAll" data-ids="' + w.join(',') + '">Podlej</button>' : '') + (f.length ? '<button class="btn sm" style="margin-left:6px" data-act="plantFertAll" data-ids="' + f.join(',') + '">Nawieź</button>' : '');
}
function vPlants() {
  const own = S.plants.filter(plantOwned), wish = S.plants.filter(p => !plantOwned(p));
  const todo = plantsToDo(), k = plantDay() === dateObj(today()).getDay() ? 3 : 0;
  const wIds = todo.filter(x => x.d.water <= k).map(x => x.p.id), fIds = todo.filter(x => x.p.fertDays && x.d.fert <= k).map(x => x.p.id);
  let html = hdr('Rośliny', true, '<button class="btn sm" data-act="newPlant">+ Roślina</button>');
  if (own.length) {
    const day = plantDay();
    html += '<div class="card"><h3>Podlewanie zbiorcze</h3><div class="muted" style="margin:4px 0 8px">Jedno przypomnienie w tygodniu w Kalendarzu, a tu lista wszystkich roślin do zrobienia.</div>' +
      '<div class="rbar" style="padding:4px 2px">' + DAYS7.map(d => '<button class="rf' + (day != null && +d[0] === day ? ' sel' : '') + '" data-act="plantDaySet" data-d="' + d[0] + '" style="padding-left:13px">' + d[1] + '</button>').join('') + '<button class="rf' + (day == null ? ' sel' : '') + '" data-act="plantDaySet" data-d="off" style="padding-left:13px">Wył.</button></div>' +
      (day != null ? '<label>Godzina przypomnienia</label><input id="pTime" type="time" value="' + esc(S.settings.plantTime || '09:00') + '" data-act="plantTimeSet">' : '') + '</div>';
    html += '<div class="card"><h3>' + (todo.length ? 'Do zrobienia' : 'Wszystko zrobione 🌿') + '</h3>' +
      todo.map(x => '<div class="prow"><div class="grow"><div class="t">' + esc(x.p.name) + '</div><div class="muted">' + [x.d.water <= k ? 'podlać' : '', x.p.fertDays && x.d.fert <= k ? 'nawieźć' : ''].filter(Boolean).join(' i ') + (x.p.room ? ' · ' + esc(x.p.room) : '') + '</div></div></div>').join('') +
      (todo.length ? '<div class="btns">' + (wIds.length ? '<button class="btn sm" data-act="plantWaterAll" data-ids="' + wIds.join(',') + '">Podlej wszystkie (' + wIds.length + ')</button>' : '') + (fIds.length ? '<button class="btn sm ghost" data-act="plantFertAll" data-ids="' + fIds.join(',') + '">Nawieź wszystkie (' + fIds.length + ')</button>' : '') + '</div>' : '') + '</div>';
  }
  const rooms = {}; own.forEach(p => { (rooms[p.room || 'Bez pokoju'] = rooms[p.room || 'Bez pokoju'] || []).push(p); });
  const names = Object.keys(rooms).sort((a, b) => (a === 'Bez pokoju') - (b === 'Bez pokoju') || (ROOMS.indexOf(a) < 0 ? 99 : ROOMS.indexOf(a)) - (ROOMS.indexOf(b) < 0 ? 99 : ROOMS.indexOf(b)) || a.localeCompare(b, 'pl'));
  names.forEach(n => {
    html += '<div class="row" style="margin-top:14px"><h2 class="grow" style="margin:0">' + esc(n) + ' <span class="muted" style="font-size:13px">(' + rooms[n].length + ')</span></h2>' + roomBtns(rooms[n]) + '</div>' + rooms[n].map(plantCard).join('');
  });
  if (wish.length) html += '<h2 style="margin-top:18px">Chcę kupić</h2>' + wish.map(plantCard).join('');
  if (!S.plants.length) html += '<div class="muted card">Brak roślin. Dodaj pierwszą - zrób zdjęcie aparatem i poproś AI o rozpoznanie.</div>';
  return html;
}

/* --- Kalendarz --- */
function vEvents() {
  const td = today(), items = [];
  S.events.forEach(e => {
    if (!e.rep) { if (e.date >= td || (e.kind === 'task' && !e.done)) items.push(occ(e, e.date)); return; }
    for (let k = 0, n = 0; k <= 60 && n < 14; k++) { const d = addDays(td, k); if (occursOn(e, d)) { items.push(occ(e, d)); n++; } }
  });
  items.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  let html = '', last = '';
  items.forEach(e => {
    if (e.date !== last) { html += '<h2>' + (e.date < td ? 'Zaległe' : e.date === td ? 'Dziś' : esc(plShort(e.date))) + '</h2>'; last = e.date; }
    html += '<div class="card flush">' + evRow(e, false, true) + '</div>';
  });
  return hdr('Kalendarz', true, '<button class="btn sm" data-act="newEvent">+ Dodaj</button>') + (html || '<div class="muted card">Brak nadchodzących wydarzeń i zadań.</div>');
}

/* --- Notatki --- */
function vNotes() {
  const ns = [...S.notes].sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0) || b.ts - a.ts);
  return hdr('Notatki', true, '<button class="btn sm" data-act="newNote">+ Notatka</button>') +
    (ns.map(n => '<div class="card tap" data-act="editNote" data-id="' + n.id + '">' + (n.img ? '<img class="thumb" src="' + n.img + '" alt="" style="height:120px">' : '') +
      '<div style="white-space:pre-wrap;margin-top:' + (n.img ? 8 : 0) + 'px">' + (n.pin ? '📌 ' : '') + esc((n.text || '').slice(0, 280)) + '</div>' +
      '<div class="muted" style="margin-top:6px">' + new Date(n.ts).toLocaleDateString('pl-PL') + '</div></div>').join('') || '<div class="muted card">Brak notatek.</div>');
}

/* --- Asystent --- */
let chatBusy = false;
function mdLite(t) { return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>'); }
function chatHtml() {
  if (!S.chat.length && !chatBusy) {
    return '<div class="muted card">Cześć ' + esc(S.settings.name) + '! Zapytaj mnie np. „gdzie zapisałam tamten przepis na rogaliki?”, „co mam dziś w planie?” albo poproś: „dodaj chleb do zakupów”, „zapisz wizytę u lekarza jutro o 10”.' +
      (hasKey() ? '' : '<br><br><span class=warn>Najpierw dodaj klucz AI w Ustawieniach.</span>') + '</div>';
  }
  return S.chat.map((m, mi) => '<div class="bubble ' + (m.role === 'user' ? 'me' : 'ai') + '">' + mdLite(m.text) + '</div>' +
    (m.choices && m.choices.length && mi === S.chat.length - 1 ? '<div class="acts">' + m.choices.map(c => '<button class="chip" style="border:0;cursor:pointer;font:inherit;font-weight:800" data-act="chatChoice" data-t="' + esc(c) + '">' + esc(c) + '</button>').join('') + '</div>' : '') +
    (m.acts && m.acts.length ? '<div class="acts">' + m.acts.map(a => '<span class="chip green">' + ic('check', 14, 3) + esc(a) + '</span>').join('') + '</div>' : '')).join('') +
    (chatBusy ? '<div class="bubble ai typing"><span></span><span></span><span></span></div>' : '');
}
function vChat() {
  return hdr('Asystent', true, '<button class="ibtn" data-act="chatClear">Wyczyść</button>') +
    '<div id="chatList">' + chatHtml() + '</div>' +
    '<div class="chatbar"><button class="btn send ghost" id="micBtn" data-act="chatMic" aria-label="Dyktuj">' + ic('mic', 24, 2.2) + '</button><textarea id="chatIn" rows="1" placeholder="Napisz lub podyktuj…" data-enter="chatSend"></textarea>' +
    '<button class="btn send" data-act="chatSend" aria-label="Wyślij">' + ic('up', 24, 2.4) + '</button></div>';
}
function paintChat() {
  const l = $('#chatList'); if (!l) return;
  l.innerHTML = chatHtml();
  window.scrollTo(0, document.documentElement.scrollHeight);
}

const CHAT_SYSTEM = `Jesteś ciepłym, zwięzłym asystentem osobistym w aplikacji „Mój Dzień”. Odpowiadasz po polsku.
Masz dostęp do danych użytkownika (na końcu). Korzystaj z nich, gdy pytanie dotyczy planów, przepisów, linków, notatek, zakupów czy roślin; gdy czegoś nie ma w danych, powiedz to wprost.

FORMAT ODPOWIEDZI: wyłącznie poprawny JSON, bez żadnego tekstu poza nim:
{"reply":"tekst dla użytkownika","actions":[ ... ],"choices":[]}
("choices" - opcjonalna lista do 5 krótkich opcji do wyboru, które aplikacja pokaże jako przyciski; zwykle pusta)

AKCJE, które aplikacja potrafi wykonać (pole "type"):
- {"type":"shopping_add","items":["chleb","masło"]} - dodaj produkty do listy zakupów
- {"type":"shopping_done","items":["chleb"]} - oznacz produkty jako kupione
- {"type":"recipe_to_shopping","title":"nazwa przepisu z listy PRZEPISY"} - dodaj składniki przepisu do zakupów
- {"type":"event_add","title":"...","date":"YYYY-MM-DD (pierwszy dzień)","time":"HH:MM albo pusty","kind":"event albo task","category":"jedna z kategorii poniżej","note":"","repeat":null albo {"type":"daily|weekly|monthly|yearly","days":[1-7 dla weekly: 1=pon ... 7=niedz],"until":"YYYY-MM-DD albo pusty"},"remind_before":[minuty przed, np. 0,60,120,180,1440]} - dodaj wydarzenie lub zadanie (także cykliczne) do kalendarza
- {"type":"event_edit","title":"tytuł istniejącego wydarzenia","title_new":"","date":"","time":"","repeat":{...},"remind_before":[...]} - zmień istniejące wydarzenie (podaj tylko zmieniane pola; repeat: null = wyłącz powtarzanie)
- {"type":"task_done","title":"..."} - oznacz zadanie jako zrobione
- {"type":"note_add","text":"..."} - zapisz notatkę
- {"type":"plant_watered","name":"..."} - zapisz, że roślina została podlana
- {"type":"web_search","query":"..."} - wyszukaj w internecie (TYLKO gdy użytkownik prosi o sprawdzenie w internecie albo pyta o aktualne fakty, ceny, godziny, wydarzenia). Wtedy w \"reply\" napisz krótko, że szukasz, i nie dawaj innych akcji. Wyniki dostaniesz w następnej wiadomości - wtedy odpowiedz na ich podstawie i podaj źródła, jeśli są.

KATEGORIE wydarzeń (pole category): praca, zdrowie, leki, weterynarz (wizyta u weterynarza), groomer (fryzjer/kąpiel/strzyżenie zwierzęcia), karmienie (TYLKO jedzenie/posiłki/karmienie zwierząt), zwierzeta (inne sprawy zwierząt, np. spacer; Gabi i Haru to psy użytkownika - wizyta u weterynarza lub fryzjera to NIE karmienie), dom, zakupy, rodzina, nauka, sport, spotkanie, urodziny, podroz, auto, finanse, uroda, urzedy, inne. Zawsze wybierz najlepiej pasującą (np. weterynarz -> zwierzeta, lekarz/dentysta -> zdrowie, tabletki -> leki, rachunek -> finanse); gdy nic nie pasuje: inne. O kategorię NIGDY nie pytaj.

ZASADY:
0. ULUBIONE PRODUKTY: gdy użytkownik prosi o dodanie ogólnego produktu (np. „serek”, „jogurt”), a na liście ULUBIONE PRODUKTY pasuje do niego dokładnie jeden - dodaj od razu tę pełną nazwę (shopping_add) i napisz, co dodałeś. Gdy pasuje kilka - NIE dodawaj; zapytaj, który, wymień je w "reply" i wpisz ich pełne nazwy do "choices" (maks. 5). Po wyborze dodaj wybrany produkt. Gdy żaden nie pasuje - dodaj zwykłą nazwę.
1. Gdy użytkownik wyraźnie prosi o dodanie lub zapisanie czegoś albo potwierdza Twoją propozycję („dodaj”, „tak”, „zapisz to”, „ok”), WYKONAJ akcję od razu: wpisz ją do "actions" i krótko potwierdź w "reply".
2. Gdy użytkownik tylko wspomina o potrzebie (np. „szukam chleba”), zaproponuj dodanie i zapytaj, z pustym "actions".
3. NIGDY nie pisz, że coś dodałeś lub zapisałeś, jeśli nie ma odpowiedniej akcji w "actions". Jeśli czegoś nie potrafisz zrobić, powiedz to wprost.
4. Nie powtarzaj akcji, które pojawiły się już w Twoich wcześniejszych odpowiedziach.
5. WYDARZENIA - DOPYTYWANIE. Zanim wykonasz event_add, upewnij się, że znasz: (a) czy wydarzenie się powtarza - zapytaj, jeśli z treści nie wynika wyraźnie, że jest jednorazowe (np. „jutro o 10 wizyta u lekarza” to jednorazowe, nie pytaj; „leki o 11” bez daty lub „codziennie” - pytaj/uwzględnij); gdy się powtarza: jak często (codziennie / co tydzień - w które dni / co miesiąc / co rok) i do kiedy (np. „do końca roku” = 31 grudnia bieżącego roku); (b) przypomnienia - dla CODZIENNEGO zapytaj, czy przypomnieć o czasie, czy 1, 2 lub 3 godziny wcześniej; dla CO TYDZIEŃ zapytaj, czy przypomnieć dzień wcześniej i/lub w dniu wydarzenia 1, 2 lub 3 godziny wcześniej. Przy zwykłym jednorazowym wydarzeniu z godziną nie pytaj o przypomnienie - użyj remind_before [0]. Zadaj wszystkie brakujące pytania w JEDNEJ krótkiej wiadomości i NIE wykonuj event_add, dopóki nie dostaniesz odpowiedzi; odpowiedź „bez przypomnienia” lub „jednorazowo” rozstrzyga. Gdy użytkownik poda wszystko od razu - wykonaj od razu. Jeśli prosi o zmianę istniejącego wydarzenia (np. „ustaw powtarzanie codziennie”), użyj event_edit (i dopytaj o przypomnienia, jeśli ich brak). Nigdy nie mów, że nie umiesz wydarzeń cyklicznych - umiesz.
6. Daty wyliczaj względem dzisiejszej daty z danych. Gdy nie ma nic do zrobienia: "actions":[].

DANE UŻYTKOWNIKA:
`;

async function webSearch(q) {
  const st = aiCfg(), prov = st.provider || 'anthropic';
  try {
    if (prov === 'gemini') {
      const r = await xfetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(st.model) + ':generateContent', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': st.apiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Wyszukaj w internecie i podaj rzetelne, zwięzłe fakty po polsku (z nazwami źródeł): ' + q }] }], tools: [{ google_search: {} }] })
      }, 60000);
      const j = await r.json(); if (!r.ok) throw new Error('search');
      const t = ((j.candidates && j.candidates[0] && j.candidates[0].content.parts) || []).map(p => p.text || '').join('');
      if (t) return t;
    } else if (prov === 'anthropic') {
      const r = await xfetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': st.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: st.model, max_tokens: 1500, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }], messages: [{ role: 'user', content: 'Wyszukaj w internecie i podaj zwięzłe fakty po polsku (z nazwami źródeł): ' + q }] })
      }, 60000);
      const j = await r.json(); if (!r.ok) throw new Error('search');
      const t = (j.content || []).map(c => c.text || '').join('');
      if (t) return t;
    }
  } catch (e) { /* przejdź do wyszukiwarki ogólnej */ }
  const r = await xfetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { headers: { 'Accept-Language': 'pl,en;q=0.8' } }, 15000);
  const h = await r.text(), out = [];
  const re = /class="result__a"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g; let m;
  while ((m = re.exec(h)) && out.length < 6) out.push('- ' + htmlToText(m[1]) + ': ' + htmlToText(m[2]));
  if (!out.length) throw new Error('brak wyników');
  return out.join('\n');
}
let micOn = false, micBtnActive = null;
async function dictateInto(ta, b) {
  const SR = micPlugin();
  if (!SR) { toast('Dyktowanie: użyj ikony mikrofonu na klawiaturze telefonu'); if (ta) ta.focus(); return; }
  try {
    if (micOn) { micOn = false; if (micBtnActive) micBtnActive.classList.remove('rec'); await SR.stop(); return; }
    const av = await SR.available(); if (!av.available) throw new Error('niedostępne');
    const pm = await SR.requestPermissions(); if (pm.speechRecognition && pm.speechRecognition !== 'granted') { toast('Zezwól aplikacji na użycie mikrofonu'); return; }
    micOn = true; micBtnActive = b; b.classList.add('rec'); const base = ta.value ? ta.value.trim() + ' ' : '';
    await SR.removeAllListeners();
    await SR.addListener('partialResults', d => { if (d.matches && d.matches[0]) { ta.value = base + d.matches[0]; ta.dispatchEvent(new Event('input', { bubbles: true })); } });
    await SR.addListener('listeningState', d => { if (d.status === 'stopped') { micOn = false; if (micBtnActive) micBtnActive.classList.remove('rec'); } });
    await SR.start({ language: 'pl-PL', partialResults: true, popup: false });
  } catch (e) { micOn = false; if (b) b.classList.remove('rec'); toast('Dyktowanie niedostępne - użyj mikrofonu na klawiaturze'); }
}
/* mały mikrofon przy każdym polu tekstowym w oknach (odpowiedź głosem zamiast pisania) */
function addMics() {
  document.querySelectorAll('#panel input, #panel textarea').forEach(el => {
    if (el.closest('.mic-wrap')) return;
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    if (el.tagName === 'INPUT' && !['text', 'search'].includes(t)) return;
    if (el.inputMode === 'numeric' || el.inputMode === 'decimal' || el.hidden) return;
    const w = document.createElement('div'); w.className = 'mic-wrap';
    el.parentNode.insertBefore(w, el); w.appendChild(el);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'micbtn'; b.setAttribute('aria-label', 'Dyktuj'); b.dataset.act = 'fieldMic'; b.innerHTML = ic('mic', 20, 2.2); w.appendChild(b);
  });
}
function micPlugin() { const P = window.Capacitor && window.Capacitor.Plugins; return P && P.SpeechRecognition; }

function parseAssistant(out) {
  try {
    const j = extractJSON(out);
    if (j && typeof j.reply === 'string') return { reply: j.reply, actions: Array.isArray(j.actions) ? j.actions : [], choices: Array.isArray(j.choices) ? j.choices.map(String).filter(Boolean).slice(0, 5) : [] };
  } catch (e) { /* zwykły tekst */ }
  return { reply: String(out || '').trim(), actions: [] };
}
function chatHistory() {
  const out = [];
  S.chat.slice(-16).forEach(m => {
    if (m.role !== 'user' && /^Błąd:/.test(m.text)) return;
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = role === 'user' ? m.text : JSON.stringify({ reply: m.text, actions: m.ax || [], choices: m.choices || [] });
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n' + text;
    else out.push({ role, content: text });
  });
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/* --- akcje wykonywane na prośbę asystenta --- */
const norm = t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
function findFuzzy(list, text, get) {
  const q = norm(text); if (!q) return null;
  const hit = list.find(x => norm(get(x)) === q) || list.find(x => norm(get(x)).includes(q)) || list.find(x => norm(get(x)).length > 2 && q.includes(norm(get(x))));
  if (hit) return hit;
  const qt = tokens(q); if (!qt.length) return null;
  let best = null, bs = 0;
  list.forEach(x => { const sc = jaccard(qt, tokens(get(x))); if (sc > bs) { bs = sc; best = x; } });
  return bs >= 0.4 ? best : null;
}
let aiCatBusy = false;
async function aiCatPending() {
  if (aiCatBusy || !hasKey()) return;
  const list = S.shopping.filter(x => !x.done && !x.catSet && !x.aiTried && pcatOf(x) === 'inne');
  if (!list.length) return;
  aiCatBusy = true; list.forEach(x => x.aiTried = true);
  try {
    const keys = PCATS.filter(c => c[0] !== 'inne').map(c => c[0] + '=' + c[1]).join('; ');
    const out = await claude({ system: 'Przypisz każdy produkt z listy zakupów do jednej kategorii. Dostępne kategorie (klucz=nazwa): ' + keys + '. Jeśli nic nie pasuje, użyj "inne". Odpowiedz TYLKO JSON-em: {"items":[{"i":0,"c":"klucz"}]}', messages: [{ role: 'user', content: list.map((x, i) => i + ': ' + x.text).join('\n') }], max: 600 });
    const j = extractJSON(out); const arr = (j && j.items) || [];
    arr.forEach(r => { const x = list[+r.i]; const c = validPcat(r.c); if (x && c) x.cat = c; });
  } catch (e) { /* cicho - zostaje Inne */ }
  aiCatBusy = false; save(); if (route.v === 'shopping') render();
}
function addShopItems(items, from) {
  const added = [];
  items.forEach(t => {
    t = cap1(String(t || '').trim()); if (!t) return;
    if (S.shopping.some(x => !x.done && norm(x.text) === norm(t))) return;
    S.shopping.push({ id: uid(), text: t, done: false, from: from || '', cat: favCatFor(t) || guessPcat(t) }); added.push(t);
    setTimeout(aiCatPending, 300);
  });
  return added;
}
function runActions(actions) {
  const acts = [];
  (Array.isArray(actions) ? actions : []).forEach(a => {
    try {
      switch (a && a.type) {
        case 'shopping_add': {
          const add = addShopItems(a.items || [], '');
          if (add.length) acts.push('Dodano do zakupów: ' + add.join(', '));
          else if ((a.items || []).length) acts.push('Już jest na liście zakupów');
          break;
        }
        case 'shopping_done': {
          const done = [];
          (a.items || []).forEach(t => { const x = findFuzzy(S.shopping.filter(i => !i.done), t, i => i.text); if (x) { x.done = true; done.push(x.text); } });
          if (done.length) acts.push('Kupione: ' + done.join(', '));
          break;
        }
        case 'recipe_to_shopping': {
          const r = findFuzzy(S.recipes, a.title, x => x.title);
          if (r) {
            const add = addShopItems(r.groups.flatMap(g => g.items.map(i => itemText(i, 1))), r.title);
            acts.push(add.length ? 'Składniki „' + r.title + '” dodane do zakupów (' + add.length + ')' : 'Składniki „' + r.title + '” już są na liście');
          } else acts.push('Nie znalazłem przepisu: ' + a.title);
          break;
        }
        case 'event_add': {
          const title = String(a.title || '').trim(); if (!title) break;
          const time = /^\d{1,2}:\d{2}$/.test(a.time || '') ? String(a.time).padStart(5, '0') : '';
          const date0 = /^\d{4}-\d{2}-\d{2}$/.test(a.date || '') ? a.date : today();
          const rems = Array.isArray(a.remind_before) ? normRems(a.remind_before) : (time ? [0] : []);
          const e = { id: uid(), title, date: date0, time, kind: a.kind === 'task' ? 'task' : 'event', note: String(a.note || ''), done: false, rems, remind: rems.length ? rems[0] : -1, rep: normRepeat(a.repeat, date0), cat: validCat(a.category) };
          S.events.push(e); scheduleEvent(e);
          acts.push((e.kind === 'task' ? 'Dodano zadanie: ' : 'Dodano wydarzenie: ') + e.title + ' (' + plShort(e.date) + (e.time ? ', ' + e.time : '') + (e.rep ? ', ' + repLabel(e) : '') + ')');
          break;
        }
        case 'event_edit': {
          const e = findFuzzy(S.events, a.title, x => x.title);
          if (!e) { acts.push('Nie znalazłem wydarzenia: ' + a.title); break; }
          if (a.title_new) e.title = String(a.title_new);
          if (validCat(a.category)) e.cat = a.category;
          if (/^\d{4}-\d{2}-\d{2}$/.test(a.date || '')) e.date = a.date;
          if (/^\d{1,2}:\d{2}$/.test(a.time || '')) e.time = String(a.time).padStart(5, '0');
          if ('repeat' in a) e.rep = normRepeat(a.repeat, e.date);
          if (Array.isArray(a.remind_before)) { e.rems = normRems(a.remind_before); e.remind = e.rems.length ? e.rems[0] : -1; }
          scheduleEvent(e); acts.push('Zmieniono: ' + e.title + (e.rep ? ' (' + repLabel(e) + ')' : ''));
          break;
        }
        case 'task_done': {
          const e = findFuzzy(S.events.filter(x => !isDoneOn(x, today())), a.title, x => x.title);
          if (e) { if (e.rep) { e.doneDates = e.doneDates || []; e.doneDates.push(today()); } else e.done = true; scheduleEvent(e); acts.push('Zrobione: ' + e.title); }
          break;
        }
        case 'note_add': {
          const t = String(a.text || '').trim();
          if (t) { S.notes.unshift({ id: uid(), text: t, img: '', pin: false, ts: Date.now() }); acts.push('Zapisano notatkę'); }
          break;
        }
        case 'plant_watered': {
          const p = findFuzzy(S.plants, a.name, x => x.name);
          if (p) { p.lastWater = today(); schedulePlant(p); acts.push('Podlane: ' + p.name); } else acts.push('Nie znalazłem rośliny: ' + a.name);
          break;
        }
      }
    } catch (e) { /* jedna zła akcja nie psuje reszty */ }
  });
  if (acts.length) save();
  return acts;
}

function buildContext() {
  const td = today();
  const c = [];
  c.push('Dzisiaj: ' + plDate(new Date()) + ' (' + td + '). Użytkownik: ' + S.settings.name + '.');
  c.push('WYDARZENIA/ZADANIA: ' + (S.events.filter(e => e.rep || e.date >= td || (e.kind === 'task' && !e.done)).slice(0, 30).map(e => e.date + ' ' + (e.time || '') + ' ' + e.title + (e.rep ? ' [powtarza się: ' + repLabel(e) + ']' : '') + (evRems(e).length ? ' [przypomnienia min przed: ' + evRems(e).join(',') + ']' : '') + (e.done ? ' [zrobione]' : '')).join('; ') || 'brak'));
  c.push('ULUBIONE PRODUKTY: ' + (favPool().slice(0, 60).map(f => f.name).join('; ') || 'brak'));
  c.push('ZAKUPY: ' + (S.shopping.filter(x => !x.done).map(x => x.text).join('; ') || 'pusto'));
  c.push('PRZEPISY: ' + (S.recipes.map(r => r.title + ' (' + r.groups.flatMap(g => g.items.map(i => i.n || i.raw)).slice(0, 12).join(', ') + ')').join(' | ') || 'brak'));
  c.push('LINKI: ' + (S.links.slice(0, 60).map(l => (l.title || '') + ' <' + l.url + '> ' + (l.tags || []).join(',')).join(' | ') || 'brak'));
  c.push('NOTATKI: ' + (S.notes.slice(0, 40).map(n => (n.text || '').slice(0, 120).replace(/\n/g, ' ')).join(' | ') || 'brak'));
  c.push('ROŚLINY: ' + (S.plants.map(p => p.name + ' (podlewanie co ' + p.waterDays + ' d, ostatnio ' + (p.lastWater || '?') + ')').join('; ') || 'brak'));
  return c.join('\n').slice(0, 14000);
}

/* --- Ustawienia --- */
function vSettings() {
  const st = S.settings, prov = st.provider || 'anthropic';
  const builtIn = APP_CFG.apiKey && !st.apiKey;
  return hdr('Ustawienia', true) + '<div class="card">' +
    (APP_CFG.apiKey ? '<span class="chip green">Klucz AI wbudowany w aplikację' + (builtIn ? ' - jest używany' : ' - zastąpiony Twoim kluczem poniżej') + '</span><p class="muted">Pola poniżej są opcjonalne: wpisz własny klucz tylko wtedy, gdy chcesz zastąpić wbudowany. Wyczyść pole klucza, aby wrócić do wbudowanego.</p>' : '') +
    '<label>Twoje imię (powitanie)</label><input id="sName" value="' + esc(st.name) + '">' +
    '<label>Dostawca AI</label><select id="sProv">' + Object.keys(PROVIDERS).map(k => '<option value="' + k + '" ' + (k === prov ? 'selected' : '') + '>' + esc(PROVIDERS[k].label) + '</option>').join('') + '</select>' +
    '<label>Klucz API</label><input id="sKey" type="password" value="' + esc(st.apiKey) + '" placeholder="wklej klucz">' +
    '<label>Model</label><input id="sModel" value="' + esc(st.model) + '">' +
    '<div id="sBaseWrap" class="' + (prov === 'openai' ? '' : 'hidden') + '"><label>Adres API (kompatybilny z OpenAI)</label><input id="sBase" value="' + esc(st.baseUrl || PROVIDERS.openai.base) + '"></div>' +
    '<button class="btn block" data-act="saveSettings">Zapisz</button>' +
    '<p class="muted">Darmowy start: wybierz „Google Gemini”, wejdź w przeglądarce na aistudio.google.com, zaloguj się kontem Google i utwórz klucz API („Get API key”). Dzienny limit ustala Google. Klucz zapisuje się tylko na tym telefonie. Bez klucza przepisy rozpoznaje prostszy parser lokalny, ale bez zdjęć i asystenta.</p></div>' +
    '<div class="card"><h3>Kopia zapasowa</h3><div class="btns"><button class="btn ghost" data-act="exportData">Skopiuj dane do schowka</button><button class="btn ghost" data-act="importData">Wczytaj z kopii</button><button class="btn ghost" data-act="backups">Kopie automatyczne</button></div></div>' +
    '<div class="card"><h3>Układ strony głównej</h3><div class="muted" style="margin:6px 0 10px">A: Linki w dolnym pasku. B: Asystent w pasku, „+” w rogu. C (domyślny): Asystent jako środkowy przycisk, bez „+” na Starcie.</div><div class="btns">' + ['A', 'B', 'C'].map(l => '<button class="btn ' + (layout() === l ? '' : 'ghost') + '" data-act="setLayout" data-l="' + l + '">' + l + '</button>').join('') + '</div></div>' +
    '<div class="card"><h3>Powiadomienia</h3><div class="muted" style="margin:6px 0 10px">Jeśli przypomnienia spóźniają się albo nie grają: zezwól na dokładne alarmy, a w ustawieniach telefonu (Aplikacje → Mój Dzień → Bateria) wybierz „Bez ograniczeń”. Nie zamykaj aplikacji opcją „wymuś zatrzymanie”.</div><div class="btns"><button class="btn ghost" data-act="notifFix">Zezwól na dokładne alarmy</button><button class="btn ghost" data-act="notifTest">Test dźwięku (za 5 s)</button></div></div>' +
    '<div class="card"><h3>O aplikacji</h3><div class="muted" style="margin-top:6px">' + ((APP_CFG.fallbacks || []).filter(f => f.apiKey).length ? 'Zapasowe AI (gdy skończy się limit): ' + (APP_CFG.fallbacks || []).filter(f => f.apiKey).map(f => esc(f.label)).join(', ') + '<br>' : '') + 'Mój Dzień · wersja <b>' + esc(APP_VERSION) + '</b>' + (APP_DATE ? '<br>zbudowano: ' + esc(APP_DATE) : '') + '</div></div>';
}

/* --- Szukaj wszędzie --- */
function globalSearch(q) {
  q = (q || '').toLowerCase().trim(); if (!q) return [];
  const out = [];
  const has = t => String(t || '').toLowerCase().includes(q);
  S.recipes.forEach(r => { if (has(r.title) || r.groups.some(g => g.items.some(i => has(i.raw)))) out.push({ t: 'Przepis', title: r.title, act: 'openRecipe', id: r.id }); });
  S.links.forEach(l => { if (has(l.title) || has(l.url) || has(l.note) || (l.tags || []).some(has)) out.push({ t: 'Link', title: l.title || l.url, act: 'openLink', id: l.id }); });
  S.notes.forEach(n => { if (has(n.text)) out.push({ t: 'Notatka', title: (n.text || '').slice(0, 80), act: 'editNote', id: n.id }); });
  S.plants.forEach(p => { if (has(p.name)) out.push({ t: 'Roślina', title: p.name, act: 'plantsGo', id: p.id }); });
  S.events.forEach(e => { if (has(e.title)) out.push({ t: 'Wydarzenie', title: e.title + ' (' + e.date + ')', act: 'editEvent', id: e.id }); });
  S.shopping.forEach(x => { if (has(x.text)) out.push({ t: 'Zakupy', title: x.text, act: 'tab', v: 'shopping' }); });
  return out;
}
function vSearch(q) {
  const res = globalSearch(q);
  return hdr('Szukaj', true) + '<label class="search">' + ic('search', 22, 2) + '<input id="gq" value="' + esc(q || '') + '" placeholder="Szukaj…" data-enter="gsearch2"></label>' +
    (q ? (res.map(r => '<div class="card tap" data-act="' + r.act + '" data-id="' + (r.id || '') + '" data-v="' + (r.v || '') + '"><div class="muted">' + r.t + '</div>' + esc(r.title) + '</div>').join('') || '<div class="muted card">Nic nie znaleziono.</div>') : '');
}

const VIEWS = { favs: vFavs, start: vStart, links: vLinks, recipes: vRecipes, recipe: vRecipe, shopping: vShopping, more: vMore, plants: vPlants, events: vEvents, notes: vNotes, budget: vBudget, chat: vChat, settings: vSettings, search: vSearch };

/* =====================  ROUTER  ===================== */
const FAB_VIEWS = ['start', 'links', 'recipes'];
/* układ strony głównej: A (Linki w pasku) / B (Asystent w pasku) / C (Asystent jako środkowy przycisk, bez "+" na Starcie) */
const layout = () => (['A', 'B', 'C'].includes(S.settings.layout) ? S.settings.layout : 'C');
const NAV_ITEMS = { start: ['home', 'Start'], links: ['link', 'Linki'], recipes: ['cook', 'Przepisy'], chat: ['chat', 'Asystent'], shopping: ['cart', 'Zakupy'], more: ['grid', 'Więcej'] };
const NAV_ORDER = { A: ['start', 'links', 'recipes', 'shopping', 'more'], B: ['start', 'recipes', 'chat', 'shopping', 'more'], C: ['start', 'recipes', 'chat', 'shopping', 'more'] };
function buildNav() {
  const nav = $('#nav'), L = layout();
  if (nav.dataset.lay === L) return;
  nav.dataset.lay = L;
  nav.innerHTML = NAV_ORDER[L].map(k => '<button data-act="tab" data-v="' + k + '" data-t="' + k + '"' + (L === 'C' && k === 'chat' ? ' class="center"' : '') + '><span class="ni">' + ic(NAV_ITEMS[k][0], L === 'C' && k === 'chat' ? 28 : 26) + '</span>' + NAV_ITEMS[k][1] + '</button>').join('');
}
function render() {
  buildNav();
  $('#view').innerHTML = VIEWS[route.v](route.p);
  document.body.className = 'v-' + route.v + ' lay-' + layout();
  const m = Object.assign({ start: 'start', links: 'links', recipes: 'recipes', recipe: 'recipes', shopping: 'shopping' }, layout() === 'A' ? {} : { chat: 'chat' })[route.v] || 'more';
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.t === m));
  $('#fab').classList.toggle('hidden', !FAB_VIEWS.includes(route.v) || (layout() === 'C' && route.v === 'start'));
  const sb = document.querySelector('#nav button[data-t=shopping]');
  if (sb) {
    let b = sb.querySelector('.badge');
    if (!b) { b = document.createElement('i'); b.className = 'badge'; sb.appendChild(b); }
    const n = S.shopping.filter(x => !x.done).length;
    b.textContent = n > 99 ? '99+' : String(n);
    b.style.display = n ? '' : 'none';
  }
  if (route.v === 'chat') window.scrollTo(0, document.documentElement.scrollHeight);
}
function go(v, p) {
  if (route.v === v && route.p === p) { render(); return; }
  stack.push(route); route = { v, p }; render(); window.scrollTo(0, 0);
}
function back() { route = stack.pop() || { v: 'start' }; render(); window.scrollTo(0, 0); }
function tab(v) { stack = v === 'start' ? [] : [{ v: 'start' }]; route = { v }; render(); window.scrollTo(0, 0); }
// przycisk Wstecz w Androidzie: zamyka okno, potem wraca o ekran, na Start zamyka aplikację
function backPress() {
  if (!$('#sheet').classList.contains('hidden')) { dismissSheet(); return; }
  if (!$('#busy').classList.contains('hidden')) return;
  if (route.v !== 'start') { back(); return; }
  const ap = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (ap && ap.exitApp) ap.exitApp();
}

/* =====================  DODAWANIE  ===================== */
function openAdd(prefill) {
  pendingImg = null;
  sheet(`<h1 style="font-size:22px">Dodaj do aplikacji</h1>
    <p class="muted">Wklej link, przepis, notatkę, listę zakupów… albo dodaj zdjęcie. AI rozpozna, co to jest, i zapisze we właściwym miejscu.</p>
    <textarea id="addText" placeholder="Wklej tutaj…">${esc(prefill || '')}</textarea>
    <div id="addImgBox"></div>
    <div class="btns foot"><button class="btn ghost" data-act="addCam">📷 Aparat</button><button class="btn ghost" data-act="addPhoto">🖼 Galeria</button><button class="btn" data-act="addGo">Rozpoznaj i zapisz</button></div>`);
  if (prefill) setTimeout(() => handleAdd(prefill, null), 100);
}

async function handleAdd(text, img) {
  text = (text || '').trim();
  if (!text && !img) { toast('Wklej coś albo dodaj zdjęcie'); return; }
  busy(true, 'Analizuję…');
  try {
    const url = (text.match(/https?:\/\/\S+/) || [])[0];
    if (url && !img && text.replace(url, '').trim().length < 200) { await handleUrl(url, text.replace(url, '').trim()); return; }
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

const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const BAD_TITLE = /^(error|facebook$|facebook\s*[-–—|]|log in|log into|zaloguj|instagram$|instagram\s*[-–—|]|just a moment|access denied|attention required|403|404|forbidden|page not found|you must log in|musisz się zalogować)/i;
const SOCIAL_RE = /facebook|fb\.watch|fb\.com|instagram|tiktok/i;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
function ogTag(html, name) {
  const re1 = new RegExp('<meta[^>]+(?:property|name)=["\']' + name + '["\'][^>]*content=["\']([^"\']*)["\']', 'i');
  const re2 = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' + name + '["\']', 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? decodeHtml(m[1]).trim() : '';
}
async function thumbToData(u) {
  try {
    const r = await withTimeout(fetch(u), 12000);
    const b = await r.blob();
    return await fileToDataUrl(b, 500, 0.6);
  } catch (e) { return u; }
}
async function getMeta(url) {
  const meta = { title: '', img: '', desc: '', html: '' };
  const social = SOCIAL_RE.test(domainOf(url));
  try { // oEmbed (YouTube, Vimeo, TikTok…)
    const r = await withTimeout(fetch('https://noembed.com/embed?url=' + encodeURIComponent(url)), 7000);
    const j = await r.json();
    if (j && !j.error) { meta.title = j.title || ''; meta.img = j.thumbnail_url || ''; }
  } catch (e) { /* idziemy dalej */ }
  // znaczniki Open Graph ze strony; dla portali społecznościowych próbujemy kolejno kilku "przeglądarek"
  const uas = social ? ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'Twitterbot/1.0', BROWSER_UA] : [BROWSER_UA];
  for (const ua of uas) {
    try {
      const r = await withTimeout(fetch(url, { headers: { 'User-Agent': ua, 'Accept-Language': 'pl,en;q=0.8', 'Accept': 'text/html,application/xhtml+xml' } }), 12000);
      const t = await r.text();
      if (!meta.html) meta.html = t;
      if (ogTag(t, 'og:image') || ogTag(t, 'og:title')) { meta.html = t; break; }
    } catch (e) { /* próbujemy dalej */ }
  }
  const h = meta.html;
  if (h) {
    const t = ogTag(h, 'og:title') || decodeHtml(((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim());
    if (!meta.title && t) meta.title = t;
    meta.img = meta.img || ogTag(h, 'og:image');
    meta.desc = ogTag(h, 'og:description') || ogTag(h, 'description');
  }
  meta.title = meta.title.replace(/\s+/g, ' ').trim();
  if (BAD_TITLE.test(meta.title)) meta.title = '';
  if (meta.title.length > 140) meta.title = meta.title.slice(0, 137) + '…';
  if (/^(error|log in|zaloguj)/i.test(meta.desc)) meta.desc = '';
  return meta;
}

/* ---------- Substack: wpis z wieloma przepisami ---------- */
const SUBSTACK_RE = /(^|\.)substack\.com$/i;
async function substackPost(url) {
  try {
    const u = new URL(url); let api = '';
    const id = (u.pathname.match(/\/(?:home\/)?post\/p-(\d+)/) || [])[1];
    if (id) api = 'https://substack.com/api/v1/posts/by-id/' + id;
    else { const sl = (u.pathname.match(/^\/p\/([^/?#]+)/) || [])[1]; if (sl) api = u.origin + '/api/v1/posts/' + sl; }
    if (!api) return null;
    const r = await withTimeout(fetch(api, { headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' } }), 15000);
    const j = await r.json(); const p = j && (j.post || j);
    if (!p || !p.body_html) return null;
    return { title: p.title || '', html: p.body_html, img: p.cover_image || '', url: p.canonical_url || url };
  } catch (e) { return null; }
}
const MULTI_SYSTEM = 'Jesteś modułem rozpoznawania przepisów w polskiej aplikacji. Dostajesz tekst wpisu, który może zawierać JEDEN lub WIELE różnych przepisów. Wyodrębnij KAŻDY przepis osobno. Pomiń reklamy, prośby o subskrypcję, komentarze i opisy bez przepisu. Odpowiadasz WYŁĄCZNIE poprawnym JSON-em: {"recipes":[{"title":"","servings":null,"total_min":null,"cook_min":null,"temp_c":null,"yield_text":"","notes":"","groups":[{"name":"","items":["500 g mąki"]}],"steps":["krok 1"],"image_query":"krótka fraza do zdjęcia potrawy","categories":["ciasta"]}]}. ' +
  ANALYZE_SYSTEM.split('Wypełnij tylko pole pasujące do "type". ')[1];
function splitNumbered(lines) {
  const TITLE = /^\d+(?:\/\d+)*\.\s+\S/, END = /^(jeśli chcesz dostawać|zasubskrybuj|udostępnij|\d+ likes?\b|subscribe|dzięki, że tu jesteś)/i;
  const st = []; lines.forEach((l, i) => { if (TITLE.test(l) && l.length < 160) st.push(i); });
  if (st.length < 2) return [];
  const isDash = l => /^[-–•]\s*\S/.test(l);
  const isQty = l => /^[\d½¼¾⅓⅔]/.test(l) && l.length < 60;
  const out = [];
  st.forEach((a, n) => {
    let body = lines.slice(a + 1, n + 1 < st.length ? st[n + 1] : lines.length);
    const e = body.findIndex(x => END.test(x)); if (e >= 0) body = body.slice(0, e);
    let head = lines[a].replace(/^\d+(?:\/\d+)*\.\s*/, '');
    const link = (head.match(/(?:przepisu:\s*)(\S+?)\s*\)/i) || [])[1] || '';
    const yld = (head.match(/\((ok\.[^)]*)\)/i) || [])[1] || '';
    const title = head.replace(/\([^)]*\)?/g, '').replace(/[\s:]+$/, '').trim();
    const groups = []; let cur = { name: '', items: [] }; groups.push(cur); const steps = [];
    for (let i = 0; i < body.length; i++) {
      const l = body[i];
      if (l.startsWith('→')) continue;
      if (isDash(l) || /^-\d/.test(l)) { cur.items.push(parseIngredient(l.replace(/^[-–•]\s*/, ''))); continue; }
      if (/:\s*$/.test(l) && l.length < 60) {
        const nx = body[i + 1] || '';
        if (isDash(nx) || /^-\d/.test(nx) || (isQty(nx) && !/[.!?]$/.test(nx))) {
          cur = { name: l.replace(/^[\*\s–-]+/, '').replace(/^Składniki( na)?\s*/i, '').replace(/^[\s–-]+/, '').replace(/:\s*$/, '').trim(), items: [] }; cur.name = cur.name.charAt(0).toUpperCase() + cur.name.slice(1); groups.push(cur);
          while (isQty(body[i + 1] || '') && !isDash(body[i + 1])) { i++; cur.items.push(parseIngredient(body[i])); }
        }
        continue;
      }
      steps.push(l.replace(/^\*+/, ''));
    }
    const gs = groups.filter(g => g.items.length);
    const t = (steps.join(' ').match(/(\d{2,3})\s*°\s*C/) || [])[1];
    if (gs.reduce((x, g) => x + g.items.length, 0) < 3 || !steps.length) return;
    out.push({ id: uid(), title: title || 'Nowy przepis', servings: null, total: null, cook: null, temp: t ? +t : null, yieldText: yld.replace(/^ok\.\s*/i, 'ok. '), notes: link ? 'Oryginał: ' + link : '', groups: gs, steps, image: '', imgs: [], source: '', fav: false, ts: Date.now() });
  });
  return out;
}
function splitRecipesLocal(lines) {
  const num = splitNumbered(lines); if (num.length >= 2) return num;
  const idx = []; lines.forEach((l, i) => { if (/^Składniki/i.test(l) && l.length < 40) idx.push(i); });
  const starts = idx.map(i => {
    for (let k = i - 1; k >= 0 && k > i - 8; k--) { const l = lines[k]; if (l.length <= 90 && !/[.!?]$/.test(l) && !/^(czas|porcj|liczba|wydajność|dla |na )/i.test(l)) return k; }
    return i;
  });
  const out = [];
  starts.forEach((st, n) => {
    const end = n + 1 < starts.length ? starts[n + 1] : lines.length;
    const r = parseRecipeText(lines.slice(st, end).join('\n'));
    if (r.groups.reduce((a, g) => a + g.items.length, 0) >= 3 && r.steps.length) out.push(r);
  });
  return out;
}
async function handleSubstack(url) {
  const post = await substackPost(url);
  if (!post) return false;
  const lines = htmlToLines(post.html).split('\n').filter(l => !/^(subscribe|subskrybuj|sign in|already a (paid )?subscriber|share|udostępnij|zapisz się|leave a comment|zostaw komentarz)\b/i.test(l));
  let recs = splitNumbered(lines);
  if (recs.length < 2) recs = [];
  if (!recs.length && hasKey()) {
    try {
      const out = await claude({ system: MULTI_SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: 'Tytuł wpisu: ' + post.title + '\n\n' + lines.join('\n').slice(0, 24000) }] }], max: 8000 });
      const j = extractJSON(out);
      recs = (j.recipes || []).filter(a => a && (a.groups || []).length && (a.steps || []).length).map(aiToRecipe);
    } catch (e) { /* spróbujemy lokalnie */ }
  }
  if (!recs.length) recs = splitRecipesLocal(lines);
  if (!recs.length) return false;
  recs.forEach(r => { r.source = post.url; });
  if (recs.length === 1) { if (post.img) recs[0].image = await thumbToData(post.img); openRecipeEditor(recs[0], true); return true; }
  let added = 0;
  recs.forEach(r => { if (!S.recipes.some(x => x.source === r.source && x.title === r.title)) { S.recipes.unshift(r); added++; } });
  save(); closeSheet(); tab('recipes');
  toast('Zapisano przepisów: ' + added + (added < recs.length ? ' (reszta już była)' : ''));
  return true;
}

async function handleUrl(url, extra) {
  extra = extra || '';
  if (SUBSTACK_RE.test(domainOf(url)) && await handleSubstack(url)) return;
  const meta = await getMeta(url);
  const html = meta.html;
  const picture = async () => (meta.img ? await thumbToData(meta.img) : '');
  const rec = html && recipeFromHtml(html, url);
  if (rec) { if (!rec.image) rec.image = await picture(); openRecipeEditor(rec, true); return; }
  if (html && !SOCIAL_RE.test(domainOf(url))) {
    const pr = recipeFromPageText(html, meta.title);
    if (pr) { pr.source = url; pr.image = await picture(); openRecipeEditor(pr, true); return; }
  }
  // opis filmu / posta może zawierać cały przepis
  const text = meta.desc.length >= extra.length ? meta.desc : extra;
  if (text.length > 120 && (SOCIAL_RE.test(domainOf(url)) || !html)) {
    if (hasKey()) {
      try {
        const ai = await aiAnalyze((meta.title ? meta.title + '\n' : '') + text);
        if (ai.type === 'recipe' && ai.recipe) { const r = aiToRecipe(ai.recipe); r.source = url; r.image = await picture(); openRecipeEditor(r, true); return; }
      } catch (e) { /* zapisz jako link */ }
    } else if (looksLikeRecipe(text)) {
      const r = parseRecipeText(text); if (meta.title) r.title = meta.title;
      r.source = url; r.image = await picture(); openRecipeEditor(r, true); return;
    }
  }
  if (hasKey() && html && !SOCIAL_RE.test(domainOf(url))) {
    try {
      const ai = await aiAnalyze('Adres: ' + url + '\nTytuł: ' + meta.title + '\n' + htmlToLines(html).slice(0, 14000));
      if (ai.type === 'recipe' && ai.recipe && (ai.recipe.groups || []).length) { const r = aiToRecipe(ai.recipe); r.source = url; r.image = await picture(); openRecipeEditor(r, true); return; }
      addLink({ url, title: (ai.link && ai.link.title) || meta.title, tags: (ai.link && ai.link.tags) || [], note: extra, img: await picture() });
      return;
    } catch (e) { /* zapisz zwykły link */ }
  }
  const firstLine = extra.split(/\n/)[0].trim();
  const title = meta.title || (firstLine && firstLine.length < 120 ? firstLine : '') || (sourceOf(url) + ' - zapisany link');
  addLink({ url, title, tags: [], note: extra && extra !== title ? extra.slice(0, 300) : '', img: await picture() });
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
  S.links.unshift({ id: uid(), url: o.url, title: o.title, img: o.img || '', tags: o.tags || [], note: o.note || '', ts: Date.now() });
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
  if (!Array.isArray(draft.cats)) draft.cats = guessRcats(draft);
  sheet(`<h1 style="font-size:22px">${isNew ? 'Sprawdź przepis' : 'Edytuj przepis'}</h1>
    ${isNew ? '<p class="muted">AI/parser rozpoznał przepis. Popraw, jeśli coś się nie zgadza, i zapisz.</p>' : ''}
    <div id="rimg" class="rimg"></div>
    <div class="btns"><button class="btn sm ghost" data-act="imgNext">🔄 Inne zdjęcie z internetu</button><button class="btn sm ghost" data-act="imgOwn">📷 Własne</button><button class="btn sm red" data-act="imgNone">Bez zdjęcia</button></div>
    <label>Nazwa</label><input id="rTitle" value="${esc(draft.title)}">
    <div class="cols3"><div><label>Porcje</label><input id="rServ" inputmode="numeric" value="${draft.servings || ''}"></div>
    <div><label>Temp. °C</label><input id="rTemp" inputmode="numeric" value="${draft.temp || ''}"></div>
    <div><label>Pieczenie min</label><input id="rCook" inputmode="numeric" value="${draft.cook || ''}"></div></div>
    <label>Czas łączny (min)</label><input id="rTotal" inputmode="numeric" value="${draft.total || ''}">
    <label>Wydajność (np. około 1500 ml barszczu)</label><input id="rYield" value="${esc(draft.yieldText || '')}">
    <label>Kategorie <span class="muted">(dotknij, żeby dodać lub odznaczyć)</span></label><div class="rpick" id="rPick">${rpickHtml()}</div>
    <label>Składniki (podgrupy zaczynaj od „# Nazwa”)</label><textarea id="rIng" style="min-height:170px">${esc(ingToText(draft.groups))}</textarea>
    <label>Notatki</label><textarea id="rNotes" style="min-height:90px">${esc(draft.notes || '')}</textarea>
    <label>Wykonanie (jeden krok w linii)</label><textarea id="rSteps" style="min-height:170px">${esc(draft.steps.join('\n'))}</textarea>
    <div class="btns foot"><button class="btn" data-act="saveRecipe">Zapisz przepis</button></div>`);
  paintRecipeImg();
  saveDraftSoon();
  if (!draft.image) loadDraftImages();
}
function rpickHtml() {
  const on = (draft && draft.cats) || [];
  return RCATS.map(c => '<button type="button" class="rf rc-' + c[0] + (on.includes(c[0]) ? ' sel' : '') + '" data-act="rcatToggle" data-c="' + c[0] + '"><span class="ri">' + ic('r_' + c[0], 17, 2.1) + '</span>' + c[1] + '</button>').join('');
}
function paintRecipeImg() {
  const b = $('#rimg'); if (!b) return;
  b.innerHTML = draft.image ? `<img class="thumb" src="${esc(draft.image)}" alt="" onerror="this.style.display='none'">` : '<div class="muted card">Szukam zdjęcia w internecie…</div>';
}
async function loadDraftImages() {
  const q = draft.imageQuery || draft.title;
  let imgs = await findImages(q);
  if (imgs.length < 3 && hasKey() && draft) { const bq = await betterImageQuery(draft.title); if (bq) (await findImages(bq)).forEach(u => { if (!imgs.includes(u)) imgs.push(u); }); }
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
  draft.yieldText = val('rYield'); draft.notes = $('#rNotes').value.trim();
  draft.groups = textToGroups($('#rIng').value);
  draft.steps = $('#rSteps').value.split(/\n/).map(s => s.trim()).filter(Boolean);
}
function saveDraftRecipe() {
  readDraftFields();
  const dup = findDuplicate(draft);
  if (dup && !confirm('Podobny przepis już istnieje: „' + dup.title + '”. Zapisać mimo to?')) return;
  const r = Object.assign({}, draft); delete r._new; delete r._i; delete r.imgs; delete r.imageQuery;
  const i = S.recipes.findIndex(x => x.id === r.id);
  const prev = i >= 0 ? S.recipes[i] : null;
  if (i >= 0) S.recipes[i] = r; else S.recipes.unshift(r);
  let ok = save(), note = 'Zapisano w „Przepisy”';
  if (!ok && r.image) { r.image = ''; ok = save(); note = 'Zapisano bez zdjęcia (brak miejsca w pamięci)'; }
  if (!ok) { if (prev) S.recipes[i] = prev; else S.recipes.shift(); toast('Nie udało się zapisać - szkic został, spróbuj ponownie'); return; }
  draft = null; clearDraft(); closeSheet(); toast(note);
  if (route.v === 'recipe') render(); else tab('recipes');
}

/* =====================  EDYTORY: roślina / wydarzenie / notatka / link  ===================== */
let plantDraftImg = '';
function openPlantEditor(p) {
  p = p || {}; plantDraftImg = p.img || ''; const c = p.care || {}, own = plantOwned(p);
  sheet(`<h1 style="font-size:22px">${p.id ? 'Edytuj roślinę' : 'Nowa roślina'}</h1>
    <div id="pImg">${plantDraftImg ? `<img class="thumb" src="${plantDraftImg}" alt="">` : ''}</div>
    <div class="btns"><button class="btn sm ghost" data-act="plantCam">📷 Aparat</button><button class="btn sm ghost" data-act="plantPhoto">🖼 Z galerii</button><button class="btn sm ghost" data-act="plantAI">🤖 Rozpoznaj (AI)</button></div>
    <input type="hidden" id="pId" value="${p.id || ''}">
    <label>Nazwa</label><input id="pName" value="${esc(p.name || '')}">
    <label>Czy masz tę roślinę w domu?</label><input type="hidden" id="pOwned" value="${own ? '1' : '0'}">
    <div class="seg" id="pOwnSeg"><button type="button" class="${own ? 'on' : ''}" data-act="plantOwned" data-o="1">Mam ją</button><button type="button" class="${own ? '' : 'on'}" data-act="plantOwned" data-o="0">Chcę kupić</button></div>
    <div id="pOwnBox" class="${own ? '' : 'hidden'}">
      <label>Pokój <span class="muted">(wybierz, wpisz lub podyktuj)</span></label>
      <div class="rbar" style="padding:2px">${ROOMS.map(r => `<button type="button" class="rf" style="padding-left:13px" data-act="pickRoom" data-r="${r}">${r}</button>`).join('')}</div>
      <input id="pRoom" value="${esc(p.room || '')}" placeholder="np. Sypialnia">
      <label>Miejsce w pokoju</label><input id="pSpot" value="${esc(p.spot || '')}" placeholder="np. parapet, regał przy oknie">
      <div class="cols2"><div><label>Podlewanie co (dni)</label><input id="pWater" inputmode="numeric" placeholder="7" value="${p.waterDays || ''}"></div>
      <div><label>Nawożenie co (dni)</label><input id="pFert" inputmode="numeric" placeholder="30" value="${p.fertDays == null ? '' : p.fertDays}"></div></div>
      <label>Karta pielęgnacji</label>
      <div class="btns"><button type="button" class="btn sm ghost" data-act="plantAI" data-care="1">🤖 Uzupełnij kartę (AI)</button></div>
      <label>Światło</label><input id="pLight" value="${esc(c.light || '')}">
      <label>Wilgotność</label><input id="pHum" value="${esc(c.hum || '')}">
      <label>Temperatura</label><input id="pTemp" value="${esc(c.temp || '')}">
      <label>Gleba</label><input id="pSoil" value="${esc(c.soil || '')}">
      <label>Przesadzanie</label><input id="pRepot" value="${esc(c.repot || '')}">
    </div>
    <label>Trująca dla psów i kotów?</label><select id="pToxic"><option value="">nie wiem</option><option value="tak" ${c.toxic === 'tak' ? 'selected' : ''}>tak, trująca</option><option value="nie" ${c.toxic === 'nie' ? 'selected' : ''}>nie, bezpieczna</option></select>
    <input id="pToxNote" value="${esc(c.toxNote || '')}" placeholder="uwagi, np. szkodliwy sok">
    <label>Notatka</label><textarea id="pNote" style="min-height:70px">${esc(p.note || '')}</textarea>
    <div class="btns foot"><button class="btn" data-act="savePlant">Zapisz</button>${p.id ? `<button class="btn red" data-act="delPlant" data-id="${p.id}">Usuń</button>` : ''}</div>`);
  addMics();
}
function openEventEditor(e, isNew) {
  e = e || { kind: 'event', date: today() };
  sheet(`<h1 style="font-size:22px">${e.id ? 'Edytuj' : 'Nowe wydarzenie / zadanie'}</h1>
    <input type="hidden" id="eId" value="${e.id || ''}">
    <label>Tytuł</label><input id="eTitle" value="${esc(e.title || '')}">
    <div class="cols2"><div><label>Data</label><input id="eDate" type="date" value="${esc(e.date || today())}"></div>
    <div><label>Godzina</label><input id="eTime" type="time" value="${esc(e.time || '')}"></div></div>
    <label>Kategoria <span class="muted" id="eCatName">${e.cat ? esc(catName(e.cat)) : 'automatycznie po tytule'}</span></label><input type="hidden" id="eCat" value="${esc(e.cat || '')}">
    <div class="catgrid"><button type="button" class="catpick auto${e.cat ? '' : ' sel'}" data-act="pickCat" data-c="">Auto</button>${CATS.map(c => `<button type="button" class="catpick cat-${c[0]}${e.cat === c[0] ? ' sel' : ''}" data-act="pickCat" data-c="${c[0]}" aria-label="${c[1]}">${ic('k_' + c[0], 22, 2)}</button>`).join('')}</div>
    <label>Rodzaj</label><select id="eKind"><option value="event" ${e.kind !== 'task' ? 'selected' : ''}>Wydarzenie</option><option value="task" ${e.kind === 'task' ? 'selected' : ''}>Zadanie</option></select>
    <label>Powtarzaj</label><select id="ePrep">${[['', 'nie powtarzaj'], ['d', 'codziennie'], ['w', 'co tydzień'], ['m', 'co miesiąc'], ['y', 'co rok']].map(o => `<option value="${o[0]}" ${(e.rep ? e.rep.t : '') === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>
    <div id="eRepBox" style="display:${e.rep ? 'block' : 'none'}">
      <div id="eDaysBox" style="display:${e.rep && e.rep.t === 'w' ? 'block' : 'none'}"><label>Dni tygodnia</label><div class="remrow">${[1, 2, 3, 4, 5, 6, 0].map(i => `<label class="chipcb"><input type="checkbox" class="eday" value="${i}" ${e.rep && e.rep.days && e.rep.days.includes(i) ? 'checked' : ''}>${DOW_PL[i]}</label>`).join('')}</div></div>
      <label>Powtarzaj do (puste = bez końca)</label><input id="eUntil" type="date" value="${esc((e.rep && e.rep.until) || '')}">
    </div>
    <label>Przypomnienia (możesz zaznaczyć kilka)</label><div class="remrow">${[[0, 'o czasie'], [10, '10 min'], [30, '30 min'], [60, '1 godz.'], [120, '2 godz.'], [180, '3 godz.'], [1440, 'dzień wcześniej']].map(o => `<label class="chipcb"><input type="checkbox" class="erem" value="${o[0]}" ${evRems(e).includes(o[0]) ? 'checked' : ''}>${o[1]}</label>`).join('')}</div>
    <label>Notatka</label><input id="eNote" value="${esc(e.note || '')}">
    <div class="btns foot"><button class="btn" data-act="saveEvent">Zapisz</button>${e.id ? `<button class="btn red" data-act="delEvent" data-id="${e.id}">Usuń</button>` : ''}</div>`);
}
/* --- wydarzenia cykliczne --- */
const DOW_PL = ['nd', 'pn', 'wt', 'śr', 'cz', 'pt', 'sb'];
const dateObj = d => new Date(d + 'T12:00:00');
function evRems(e) { if (Array.isArray(e.rems)) return e.rems; return (e.remind != null && e.remind >= 0) ? [e.remind] : []; }
function occursOn(e, d) {
  if (!e.rep) return e.date === d;
  if (d < e.date || (e.rep.until && d > e.rep.until) || (e.skip || []).includes(d)) return false;
  const a = dateObj(e.date), b = dateObj(d), t = e.rep.t;
  if (t === 'd') return true;
  if (t === 'w') { const days = (e.rep.days && e.rep.days.length) ? e.rep.days : [a.getDay()]; return days.includes(b.getDay()); }
  if (t === 'm') { const last = new Date(b.getFullYear(), b.getMonth() + 1, 0).getDate(); return a.getDate() === b.getDate() || (a.getDate() > last && b.getDate() === last); }
  if (t === 'y') return a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return false;
}
const isDoneOn = (e, d) => e.rep ? (e.doneDates || []).includes(d) : !!e.done;
function occ(e, d) { return Object.assign({}, e, { occDate: d, date: d, done: isDoneOn(e, d) }); }
function repLabel(e) {
  if (!e.rep) return '';
  const t = e.rep.t;
  let s = t === 'd' ? 'codziennie' : t === 'm' ? 'co miesiąc' : t === 'y' ? 'co rok'
    : 'co tydzień' + ((e.rep.days && e.rep.days.length) ? ' (' + e.rep.days.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(i => DOW_PL[i]).join(', ') + ')' : '');
  return s + (e.rep.until ? ' do ' + plShort(e.rep.until) : '');
}
function normRepeat(r, startDate) {
  if (!r || typeof r !== 'object') return null;
  const t = ({ daily: 'd', weekly: 'w', monthly: 'm', yearly: 'y', d: 'd', w: 'w', m: 'm', y: 'y' })[String(r.type || r.t || '').toLowerCase()];
  if (!t) return null;
  const out = { t };
  if (t === 'w') {
    const days = (Array.isArray(r.days) ? r.days : []).map(n => parseInt(n)).filter(n => n >= 1 && n <= 7).map(n => n % 7);
    out.days = days.length ? Array.from(new Set(days)) : [dateObj(startDate || today()).getDay()];
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(r.until || '')) out.until = r.until;
  return out;
}
function normRems(a) { return Array.from(new Set((Array.isArray(a) ? a : []).map(n => parseInt(n)).filter(n => n >= 0 && n <= 10080))).sort((x, y) => x - y); }
function remText(min) { return min === 0 ? '' : min >= 1440 && min % 1440 === 0 ? (min === 1440 ? 'jutro' : 'za ' + min / 1440 + ' dni') : min >= 60 && min % 60 === 0 ? 'za ' + min / 60 + ' godz.' : 'za ' + min + ' min'; }
async function cancelEventNotifs(id) {
  const p = LN(); const ids = (S.nids && S.nids[id]) || [];
  if (p && ids.length) { try { await p.cancel({ notifications: ids.map(i => ({ id: i })) }); } catch (e) {} }
  if (S.nids) delete S.nids[id];
  unnotify('ev' + id);
}
async function scheduleEvent(e) {
  await cancelEventNotifs(e.id);
  const p = LN(), rems = evRems(e);
  if (!p || !rems.length) return;
  const now = new Date(), td = today(), list = [];
  const horizon = e.rep ? (e.rep.t === 'd' ? 21 : e.rep.t === 'w' ? 70 : 400) : 0;
  const first = e.rep ? td : e.date;
  for (let k = 0; k <= horizon + 1 && list.length < 120; k++) {
    const d = e.rep ? addDays(first, k) : e.date;
    if (k > 0 && !e.rep) break;
    if (!occursOn(e, d) || isDoneOn(e, d)) continue;
    rems.forEach(min => {
      const at = new Date(d + 'T' + (e.time || '09:00') + ':00'); at.setMinutes(at.getMinutes() - min);
      if (at > now) list.push({ id: nid('ev' + e.id + '|' + d + '|' + min), title: e.kind === 'task' ? 'Zadanie' : 'Wydarzenie', body: e.title + (min ? ' - ' + remText(min) : ''), channelId: 'mojdzien_alerts_v2', sound: 'mojdzien_cowbell.wav', smallIcon: 'ic_stat_mojdzien', largeIcon: 'ic_notif_large', iconColor: '#EE7A38', schedule: { at, allowWhileIdle: true } });
    });
  }
  if (!list.length) return;
  try {
    const perm = await p.requestPermissions(); if (perm.display !== 'granted') return;
    await ensureChannel(p);
    await p.schedule({ notifications: list });
    S.nids = S.nids || {}; S.nids[e.id] = list.map(n => n.id); save();
  } catch (err) { /* brak zgody / brak natywnego środowiska */ }
}
function openNoteEditor(n) {
  n = n || {};
  sheet(`<h1 style="font-size:22px">${n.id ? 'Notatka' : 'Nowa notatka'}</h1>
    <input type="hidden" id="nId" value="${n.id || ''}">
    <textarea id="nText" style="min-height:200px" placeholder="Pisz…">${esc(n.text || '')}</textarea>
    <div class="btns foot"><button class="btn" data-act="saveNote">Zapisz</button>${n.id ? `<button class="btn ghost" data-act="pinNote" data-id="${n.id}">${n.pin ? 'Odepnij' : '📌 Przypnij'}</button><button class="btn red" data-act="delNote" data-id="${n.id}">Usuń</button>` : ''}</div>`);
}
function openLinkEditor(l) {
  sheet(`<h1 style="font-size:22px">Edytuj link</h1>
    <input type="hidden" id="lId" value="${l.id}">
    <label>Tytuł</label><input id="lTitle" value="${esc(l.title || '')}">
    <label>Adres</label><input id="lUrl" value="${esc(l.url || '')}">
    <label>Tagi (po przecinku)</label><input id="lTags" value="${esc((l.tags || []).join(', '))}">
    <label>Notatka</label><input id="lNote" value="${esc(l.note || '')}">
    <div class="btns foot"><button class="btn" data-act="saveLink">Zapisz</button></div>`);
}

/* =====================  AKCJE (delegacja kliknięć)  ===================== */
const byId = (arr, id) => arr.find(x => x.id === id);
const A = {
  tab: (d) => tab(d.v),
  go: (d) => go(d.v),
  back: () => back(),
  plantsGo: () => go('plants'),
  add: () => openAdd(''),
  closeSheet: () => { draft = null; clearDraft(); closeSheet(); },
  addCam: async () => {
    const img = await pickImage(1200, true); if (!img) return;
    pendingImg = img; $('#addImgBox').innerHTML = `<img class="thumb" src="${img}" alt="" style="height:140px;margin-bottom:8px">`;
  },
  addPhoto: async () => {
    const img = await pickImage(1200); if (!img) return;
    pendingImg = img; $('#addImgBox').innerHTML = `<img class="thumb" src="${img}" alt="" style="height:140px;margin-bottom:8px">`;
  },
  addGo: () => handleAdd(val('addText'), pendingImg),
  gsearch: () => { const q = val('gsearch'); go('search', q); },
  gsearch2: () => { route.p = val('gq'); render(); },

  /* linki */
  linkFilter: (d) => { linkFilter = d.k; render(); },
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
  notifFix: async () => {
    const p = LN(); if (!p) { toast('Dostępne w zainstalowanej aplikacji'); return; }
    try {
      const perm = await p.requestPermissions();
      if (perm.display !== 'granted') { toast('Włącz powiadomienia dla aplikacji w ustawieniach telefonu'); return; }
      let ex = 'granted';
      try { ex = (await p.checkExactNotificationSetting()).exact_alarm; } catch (e) {}
      if (ex === 'granted') { toast('Dokładne alarmy są włączone'); return; }
      toast('Włącz „Alarmy i przypomnienia” dla aplikacji');
      await p.changeExactNotificationSetting();
    } catch (e) { toast('Nie udało się sprawdzić ustawień'); }
  },
  notifTest: async () => {
    const p = LN(); if (!p) { toast('Dostępne w zainstalowanej aplikacji'); return; }
    try {
      const perm = await p.requestPermissions(); if (perm.display !== 'granted') { toast('Włącz powiadomienia dla aplikacji w ustawieniach telefonu'); return; }
      await ensureChannel(p);
      await p.schedule({ notifications: [{ id: 2147000001, title: 'Test', body: 'Tak brzmi powiadomienie', channelId: 'mojdzien_alerts_v2', sound: 'mojdzien_cowbell.wav', smallIcon: 'ic_stat_mojdzien', largeIcon: 'ic_notif_large', iconColor: '#EE7A38', schedule: { at: new Date(Date.now() + 5000), allowWhileIdle: true } }] });
      toast('Za 5 sekund przyjdzie test - możesz zablokować ekran');
    } catch (e) { toast('Nie udało się wysłać testu'); }
  },
  setLayout: (d) => { S.settings.layout = d.l; save(); render(); },
  rcatFilter: (d) => { rcatSel = d.c || ''; render(); },
  rcatToggle: (d) => {
    if (!draft) return;
    const a = draft.cats || (draft.cats = []), i = a.indexOf(d.c);
    if (i >= 0) a.splice(i, 1); else a.push(d.c);
    $('#rPick').innerHTML = rpickHtml(); saveDraftSoon();
  },
  openRecipe: (d) => { scale = 1; go('recipe', d.id); },
  setScale: (d) => { scale = parseFloat(d.k); render(); },
  favRecipe: (d) => { const r = byId(S.recipes, d.id); r.fav = !r.fav; save(); render(); },
  editRecipe: (d) => openRecipeEditor(byId(S.recipes, d.id), false),
  delRecipe: (d) => { if (confirm('Usunąć przepis?')) { S.recipes = S.recipes.filter(r => r.id !== d.id); save(); back(); } },
  saveRecipe: () => saveDraftRecipe(),
  backups: async () => {
    const l = await listBackups();
    sheet('<h1 style="font-size:22px">Kopie automatyczne</h1><p class="muted">Telefon sam zapisuje kopię raz dziennie (ostatnie 7 dni). Wybierz dzień, aby przywrócić dane z tamtego dnia.</p>' +
      (l.length ? l.map(k => '<button class="btn ghost block" style="margin:6px 0" data-act="restoreBackup" data-k="' + k + '">' + esc(k.slice(7)) + '</button>').join('') : '<div class="muted card">Brak kopii - pojawi się po pierwszym zapisie danych.</div>'));
  },
  restoreBackup: async d => {
    if (!confirm('Przywrócić dane z ' + d.k.slice(7) + '? Obecne dane zostaną zastąpione.')) return;
    try {
      const o = JSON.parse(await idbGet(d.k));
      S = Object.assign(JSON.parse(JSON.stringify(DEF)), o, { settings: Object.assign({}, DEF.settings, o.settings || {}) });
      save(); closeSheet(); render(); toast('Przywrócono dane z ' + d.k.slice(7));
    } catch (e) { toast('Nie udało się przywrócić kopii'); }
  },
  imgNext: () => { if (!draft) return; if (!draft.imgs.length) { loadDraftImages(); return; } draft._i = ((draft._i || 0) + 1) % draft.imgs.length; draft.image = draft.imgs[draft._i]; paintRecipeImg(); },
  imgOwn: async () => { saveDraftSoon(); const i = await pickImage(900); if (i && draft) { draft.image = i; paintRecipeImg(); saveDraftSoon(); } },
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
  shopAdd: () => { const t = val('newItem'); if (!t) return; S.shopping.push({ id: uid(), text: t, done: false, from: '', cat: favCatFor(t) || guessPcat(t) }); save(); render(); setTimeout(aiCatPending, 300); const e = $('#newItem'); if (e) e.focus(); },
  shopTick: (d) => { const x = byId(S.shopping, d.id); x.done = !x.done; save(); render(); },
  shopCat: (d) => {
    const x = byId(S.shopping, d.id); if (!x) return; const cur = pcatOf(x);
    sheet('<h1 style="font-size:20px">' + esc(x.text) + '</h1><div class="muted" style="margin-bottom:8px">Wybierz kategorię</div><div class="rbar" style="flex-wrap:wrap;overflow:visible">' +
      PCATS.map(c => '<button type="button" class="rf pc-' + c[0] + (c[0] === cur ? ' sel' : '') + '" data-act="shopCatSet" data-id="' + x.id + '" data-c="' + c[0] + '"><span class="ri">' + ic('p_' + c[0], 17, 2.1) + '</span>' + c[1] + '</button>').join('') + '</div>' +
      '<div class="btns foot"><button class="btn ghost" data-act="shopFav" data-id="' + x.id + '">' + (isFav(normName(x.text)) ? '★ Usuń z ulubionych' : '☆ Dodaj do ulubionych') + '</button></div>');
  },
  favAdd: (d) => {
    if (d.close) closeSheet();
    const f = favPool().find(x => x.norm === d.n); if (!f) return;
    const q = ($('#newItem') && $('#newItem').value || '').trim().toLowerCase();
    if (q.length >= 2 && !f.name.toLowerCase().includes(q)) { S.favAlias = S.favAlias || {}; const a = S.favAlias[f.norm] = S.favAlias[f.norm] || []; if (!a.includes(q)) a.push(q); }
    S.shopping.push({ id: uid(), text: f.name, done: false, from: '', cat: f.cat || guessPcat(f.name) }); save();
    if (route.v === 'shopping') render(); else toast('Dodano: ' + f.name);
    const e = $('#newItem'); if (e) e.focus();
  },
  favBackCam: () => favBack(true),
  favBackGal: () => favBack(false),
  favBackSkip: () => { closeSheet(); favRun(favFront, null); },
  favScanCam: () => favScan(true),
  favScanGal: () => favScan(false),
  favDraftTick: (d) => { favDraftSync(); favDraft[+d.i].on = !favDraft[+d.i].on; favDraftSheet(); },
  favDraftSave: () => {
    favDraftSync(); let n = 0;
    favDraft.filter(d => d.on && d.name).forEach(d => {
      const k = normName(d.name); if (!k) return;
      S.favOff = (S.favOff || []).filter(x => x !== k);
      if (!(S.favs || (S.favs = [])).some(f => f.norm === k)) S.favs.push({ id: uid(), name: d.name, norm: k, cat: validPcat(d.cat) || guessPcat(d.name), price: 0, size: d.size || '', info: d.info || '', img: d.img || '', img2: d.img2 || '' });
      else { const f0 = S.favs.find(f => f.norm === k); if (d.img) { f0.img = d.img; f0.img2 = d.img2 || ''; } if (d.size) f0.size = d.size; if (d.info) f0.info = d.info; }
      if (d.type) { const al = S.favAlias || (S.favAlias = {}); al[k] = Array.from(new Set((al[k] || []).concat([d.type]))); }
      n++;
    });
    favDraft = []; save(); closeSheet(); toast(n ? 'Dodano do ulubionych: ' + n + ' ⭐' : 'Nic nie dodano'); render();
  },
  favNew: () => sheet('<h1 style="font-size:22px">Nowy ulubiony produkt</h1><label>Marka i nazwa</label><input id="fnName" placeholder="np. Alpro jagodowe" autocomplete="off"><div class="btns foot"><button class="btn" data-act="favNewSave">⭐ Dodaj</button></div>'),
  favNewSave: () => { const t = val('fnName'); if (!t) { toast('Wpisz nazwę'); return; } const k = normName(t); if (!isFav(k)) favToggle(t, guessPcat(t), ''); closeSheet(); render(); },
  favCard: (d) => favCardSheet(d.n),
  favCardSave: (d) => {
    const f = favPool().find(x => x.norm === d.n); if (!f) return;
    const name = val('fcName') || f.name; S.favs = S.favs || [];
    let r = S.favs.find(x => x.norm === d.n); if (!r) { r = { id: uid(), norm: d.n, price: f.price || 0 }; S.favs.push(r); }
    S.favOff = (S.favOff || []).filter(x => x !== d.n);
    r.name = name; r.size = val('fcSize'); r.info = val('fcInfo'); r.cat = validPcat(val('fcCat')) || f.cat; if (f.img && !r.img) { r.img = f.img; r.img2 = f.img2 || ''; }
    save(); closeSheet(); toast('Zapisano'); render();
  },
  favList: () => {
    const pool = favPool();
    sheet('<h1 style="font-size:22px">Ulubione produkty</h1><div class="muted" style="margin-bottom:8px">Produkty z gwiazdką oraz kupione z paragonów co najmniej 3 razy. Dodasz je do listy przyciskiem z koszykiem.</div>' +
      (pool.length ? pool.map(f => favRow(f)).join('') : '<div class="muted card">Brak ulubionych. Oznacz gwiazdką produkty na ekranie sprawdzania paragonu.</div>'));
  },
  favDel: (d) => { if (d.close) closeSheet(); const f = favPool().find(x => x.norm === d.n); if (f) { S.favs = (S.favs || []).filter(x => x.norm !== d.n); S.favOff = S.favOff || []; if (!S.favOff.includes(d.n)) S.favOff.push(d.n); save(); } if (route.v === 'favs') render(); else A.favList(); if (route.v === 'shopping') render(); },
  expStar: (d) => { syncExp(); const it = expDraft.items[+d.i]; if (!String(it.name).trim()) { toast('Najpierw wpisz nazwę produktu'); return; } const on = favToggle(it.name, it.cat, it.price); toast(on ? 'Dodano do ulubionych ⭐' : 'Usunięto z ulubionych'); openExpenseEditor(expDraft, true); },
  shopFav: (d) => { const x = byId(S.shopping, d.id); if (!x) return; const on = favToggle(x.text, pcatOf(x), ''); toast(on ? 'Dodano do ulubionych ⭐' : 'Usunięto z ulubionych'); closeSheet(); render(); },
  chatChoice: (d) => { const ta = $('#chatIn'); if (ta) { ta.value = 'dodaj ' + d.t; A.chatSend(); } },
  shopCatSet: (d) => { const x = byId(S.shopping, d.id); if (x) { x.cat = d.c; x.catSet = true; save(); } closeSheet(); render(); },
  budMonth: (d) => { budMonth = shiftMonth(budMonth || monthKey(today()), +d.n); render(); },
  budLimit: () => {
    const B = S.budget || (S.budget = { limit: 0, cats: {} });
    sheet('<h1 style="font-size:22px">Limity miesięczne</h1><label>Limit ogólny (zł)</label><input id="bLim" inputmode="decimal" value="' + (B.limit || '') + '" placeholder="np. 3000">' +
      '<div class="muted" style="margin:4px 0 8px">Limity kategorii są opcjonalne</div>' + PCATS.map(c => '<div class="row"><span class="ri pc-' + c[0] + '" style="display:inline-flex;flex:none;width:34px;height:34px;border-radius:50%;align-items:center;justify-content:center;background:var(--rb);color:var(--rf)">' + ic('p_' + c[0], 17, 2.2) + '</span><div class="grow"><input id="bc_' + c[0] + '" inputmode="decimal" placeholder="' + c[1] + '" value="' + ((B.cats || {})[c[0]] || '') + '" style="margin:4px 0"></div></div>').join('') +
      '<div class="btns foot"><button class="btn" data-act="budLimitSave">Zapisz</button></div>');
  },
  budLimitSave: () => {
    const B = S.budget || (S.budget = { limit: 0, cats: {} }); B.limit = parsePrice(val('bLim')); B.cats = {};
    PCATS.forEach(c => { const v = parsePrice(val('bc_' + c[0])); if (v > 0) B.cats[c[0]] = v; });
    save(); closeSheet(); render();
  },
  scanCam: () => scanReceipt(true),
  scanGal: () => scanReceipt(false),
  expNew: () => openExpenseEditor({ id: '', date: today(), store: '', items: [{ name: '', price: '', cat: '' }], src: 'manual' }),
  expEdit: (d) => { const e = byId(S.expenses, d.id); if (e) openExpenseEditor(JSON.parse(JSON.stringify(e))); },
  expAddRow: () => { syncExp(); expDraft.items.push({ name: '', price: '', cat: '' }); openExpenseEditor(expDraft, true); },
  expDelRow: (d) => { syncExp(); expDraft.items.splice(+d.i, 1); if (!expDraft.items.length) expDraft.items.push({ name: '', price: '', cat: '' }); openExpenseEditor(expDraft, true); },
  expSave: () => {
    syncExp(); const e = expDraft;
    e.items = e.items.filter(it => String(it.name).trim() || parsePrice(it.price));
    if (!e.items.length) { toast('Dodaj choć jedną pozycję'); return; }
    e.items = e.items.map(it => ({ name: String(it.name).trim() || 'Pozycja', price: parsePrice(it.price), cat: validPcat(it.cat) || guessPcat(it.name), norm: normName(it.name), type: it.type || '', unit: it.unit || '', qty: it.qty || 0, unitPrice: it.unitPrice || 0 }));
    e.total = e.items.reduce((a, it) => a + it.price, 0);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) e.date = today();
    if (e.id) { const i = S.expenses.findIndex(x => x.id === e.id); if (i >= 0) S.expenses[i] = e; else S.expenses.unshift(e); }
    else { e.id = uid(); e.ts = Date.now(); S.expenses.unshift(e); }
    budMonth = monthKey(e.date); expDraft = null; save(); closeSheet(); go('budget'); render(); toast('Zapisano ' + money(e.total));
  },
  expDel: () => { if (!expDraft || !expDraft.id || !confirm('Usunąć ten wydatek?')) return; S.expenses = S.expenses.filter(x => x.id !== expDraft.id); expDraft = null; save(); closeSheet(); render(); },
  expPick: (d) => { syncExp(); expDraft.items[+d.i].cat = d.c; openExpenseEditor(expDraft, true); },

  shopDel: (d) => { S.shopping = S.shopping.filter(x => x.id !== d.id); save(); render(); },
  shopClear: () => { S.shopping = S.shopping.filter(x => !x.done); save(); render(); },

  /* rośliny */
  newPlant: () => openPlantEditor(),
  editPlant: (d) => openPlantEditor(byId(S.plants, d.id)),
  plantCam: async () => { const i = await pickImage(800, true); if (i) { plantDraftImg = i; $('#pImg').innerHTML = `<img class="thumb" src="${i}" alt="">`; } },
  plantPhoto: async () => { const i = await pickImage(800); if (i) { plantDraftImg = i; $('#pImg').innerHTML = `<img class="thumb" src="${i}" alt="">`; } },
  plantAI: async (d) => {
    const name0 = val('pName');
    if (!plantDraftImg && !name0) { toast('Zrób zdjęcie aparatem albo wpisz nazwę'); return; }
    if (!hasKey()) { toast('Dodaj klucz AI w Ustawieniach'); return; }
    busy(true, 'Rozpoznaję roślinę…');
    try {
      const sys = 'Rozpoznajesz rośliny doniczkowe. Odpowiedz WYŁĄCZNIE JSON-em: {"name":"polska nazwa","water_days":7,"fertilize_days":30,"tip":"krótka wskazówka pielęgnacji","light":"np. jasne, rozproszone","humidity":"np. średnia, zraszać liście","temp":"np. 18-24 °C","soil":"np. przepuszczalna, dla kaktusów","repot":"np. co 2 lata na wiosnę","toxic":"tak|nie|nieznane","toxic_note":"krótko, co szkodzi psom i kotom"}';
      const content = plantDraftImg ? [imgBlock(plantDraftImg), { type: 'text', text: 'Jaka to roślina? Podaj typowe odstępy podlewania i nawożenia oraz kartę pielęgnacji.' + (name0 ? ' Nazwa: ' + name0 : '') }] : [{ type: 'text', text: 'Roślina: ' + name0 + '. Podaj typowe odstępy podlewania i nawożenia oraz kartę pielęgnacji.' }];
      const out = await claude({ system: sys, messages: [{ role: 'user', content }], max: 700 });
      const j = extractJSON(out);
      /* AI uzupełnia tylko puste pola - to, co wpisałeś, zostaje */
      const fill = (id, v) => { const el = $(id); if (el && !String(el.value).trim() && v != null && v !== '') el.value = v; };
      fill('#pName', j.name); fill('#pWater', j.water_days); fill('#pFert', j.fertilize_days); fill('#pNote', j.tip);
      fill('#pLight', j.light); fill('#pHum', j.humidity); fill('#pTemp', j.temp); fill('#pSoil', j.soil); fill('#pRepot', j.repot); fill('#pToxNote', j.toxic_note);
      const tx = $('#pToxic'); if (tx && !tx.value && (j.toxic === 'tak' || j.toxic === 'nie')) tx.value = j.toxic;
      if (!d || !d.care) toast('Rozpoznano. Czy masz tę roślinę w domu? Wybierz niżej.');
    } catch (e) { toast('Błąd: ' + e.message); } finally { busy(false); }
  },
  plantOwned: (d) => {
    $('#pOwned').value = d.o; $('#pOwnBox').classList.toggle('hidden', d.o !== '1');
    document.querySelectorAll('#pOwnSeg button').forEach(b => b.classList.toggle('on', b.dataset.o === d.o));
  },
  pickRoom: (d) => { $('#pRoom').value = d.r; },
  plantOwn: (d) => { const p = byId(S.plants, d.id); p.owned = true; p.lastWater = today(); p.lastFert = today(); save(); schedulePlant(p); openPlantEditor(p); },
  plantWaterAll: (d) => { (d.ids || '').split(',').forEach(id => { const p = byId(S.plants, id); if (p) p.lastWater = today(); }); save(); toast('Podlane 💧'); render(); },
  plantFertAll: (d) => { (d.ids || '').split(',').forEach(id => { const p = byId(S.plants, id); if (p) p.lastFert = today(); }); save(); toast('Nawiezione 🧪'); render(); },
  roomWater: (d) => { let n = 0; S.plants.filter(plantOwned).forEach(p => { if ((p.room || '') === d.room) { p.lastWater = today(); n++; } }); save(); toast('Podlane: ' + n + ' 💧'); render(); },
  plantDaySet: (d) => { S.settings.plantDay = d.d === 'off' ? 'off' : +d.d; save(); ensurePlantEventForce(); render(); },
  plantTimeSet: () => {},
  savePlant: () => {
    const name = val('pName'); if (!name) { toast('Podaj nazwę'); return; }
    let p = byId(S.plants, val('pId'));
    if (!p) { p = { id: uid(), lastWater: today(), lastFert: today() }; S.plants.push(p); }
    const fv = val('pFert').trim();
    p.owned = val('pOwned') !== '0'; p.room = val('pRoom'); p.spot = val('pSpot');
    p.care = { light: val('pLight'), hum: val('pHum'), temp: val('pTemp'), soil: val('pSoil'), repot: val('pRepot'), toxic: val('pToxic'), toxNote: val('pToxNote') };
    p.name = name; p.waterDays = parseInt(val('pWater')) || 7; p.fertDays = fv === '' ? (p.fertDays == null ? 30 : p.fertDays) : (parseInt(fv) || 0); p.note = val('pNote'); p.img = plantDraftImg;
    save(); schedulePlant(p); closeSheet(); if (route.v !== 'plants') go('plants'); else render();
  },
  delPlant: (d) => { if (confirm('Usunąć roślinę?')) { unnotify('pw' + d.id); unnotify('pf' + d.id); S.plants = S.plants.filter(p => p.id !== d.id); save(); closeSheet(); render(); } },
  plantWater: (d) => { const p = byId(S.plants, d.id); p.lastWater = today(); save(); schedulePlant(p); toast('Podlane 💧'); render(); },
  plantFert: (d) => { const p = byId(S.plants, d.id); p.lastFert = today(); save(); schedulePlant(p); toast('Nawiezione 🧪'); render(); },

  /* kalendarz */
  newEvent: () => openEventEditor(),
  pickCat: (d) => {
    $('#eCat').value = d.c || '';
    document.querySelectorAll('.catpick').forEach(b => b.classList.toggle('sel', (b.dataset.c || '') === (d.c || '')));
    $('#eCatName').textContent = d.c ? catName(d.c) : 'automatycznie po tytule';
  },
  editEvent: (d) => { const e = byId(S.events, d.id); if (e && e.sys === 'plants') go('plants'); else openEventEditor(e); },
  saveEvent: () => {
    const title = val('eTitle'); if (!title) { toast('Podaj tytuł'); return; }
    let e = byId(S.events, val('eId'));
    if (!e) { e = { id: uid(), done: false }; S.events.push(e); }
    e.cat = validCat(val('eCat')); e.title = title; e.date = val('eDate') || today(); e.time = val('eTime'); e.kind = val('eKind'); e.note = val('eNote');
    e.rems = normRems([...document.querySelectorAll('.erem:checked')].map(c => c.value)); e.remind = e.rems.length ? e.rems[0] : -1;
    const rt = val('ePrep');
    e.rep = rt ? normRepeat({ t: rt, days: [...document.querySelectorAll('.eday:checked')].map(c => c.value === '0' ? 7 : +c.value), until: val('eUntil') }, e.date) : null;
    if (!e.rep) { delete e.doneDates; }
    save(); scheduleEvent(e); closeSheet(); if (route.v === 'events') render(); else go('events');
  },
  delEvent: (d) => { const e0 = byId(S.events, d.id); if (e0 && e0.rep && !confirm('Usunąć wszystkie powtórzenia tego wydarzenia?')) return; cancelEventNotifs(d.id); S.events = S.events.filter(e => e.id !== d.id); save(); closeSheet(); render(); },
  evDone: (d) => { const e = byId(S.events, d.id); if (e.rep) { const day = d.date || today(); e.doneDates = e.doneDates || []; const i = e.doneDates.indexOf(day); if (i >= 0) e.doneDates.splice(i, 1); else e.doneDates.push(day); } else e.done = !e.done; save(); scheduleEvent(e); render(); },

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
  fieldMic: (d, el) => { const w = el.closest('.mic-wrap'), ta = w && w.querySelector('input,textarea'); if (ta) dictateInto(ta, el); },
  chatMic: async () => {
    const SR = micPlugin(), ta = $('#chatIn'), b = $('#micBtn');
    if (!SR) { toast('Dyktowanie: użyj ikony mikrofonu na klawiaturze telefonu'); if (ta) ta.focus(); return; }
    try {
      if (micOn) { micOn = false; b.classList.remove('rec'); await SR.stop(); return; }
      const av = await SR.available(); if (!av.available) throw new Error('niedostępne');
      const pm = await SR.requestPermissions(); if (pm.speechRecognition && pm.speechRecognition !== 'granted') { toast('Zezwól aplikacji na użycie mikrofonu'); return; }
      micOn = true; b.classList.add('rec'); const base = ta.value ? ta.value.trim() + ' ' : '';
      await SR.removeAllListeners();
      await SR.addListener('partialResults', d => { if (d.matches && d.matches[0]) { ta.value = base + d.matches[0]; ta.dispatchEvent(new Event('input', { bubbles: true })); } });
      await SR.addListener('listeningState', d => { if (d.status === 'stopped') { micOn = false; const bb = $('#micBtn'); if (bb) bb.classList.remove('rec'); } });
      await SR.start({ language: 'pl-PL', partialResults: true, popup: false });
    } catch (e) { micOn = false; if (b) b.classList.remove('rec'); toast('Dyktowanie niedostępne - użyj mikrofonu na klawiaturze'); }
  },
  chatSend: async () => {
    if (chatBusy) return;
    const ta = $('#chatIn'); const t = ta ? ta.value.trim() : ''; if (!t) return;
    if (!hasKey()) { toast('Dodaj klucz AI w Ustawieniach'); return; }
    S.chat.push({ role: 'user', text: t }); save();
    ta.value = ''; ta.style.height = ''; chatBusy = true; paintChat(); ta.focus();
    try {
      const out = await claude({ system: CHAT_SYSTEM + buildContext(), messages: chatHistory(), max: 1500, json: true });
      let p = parseAssistant(out);
      const ws = (p.actions || []).find(a => a && a.type === 'web_search' && a.query);
      if (ws) {
        let found = '';
        try { found = await webSearch(ws.query); } catch (e) { found = 'Wyszukiwanie nie powiodło się: ' + (e.message || e); }
        const hist = chatHistory();
        hist.push({ role: 'assistant', content: JSON.stringify({ reply: p.reply, actions: [ws] }) });
        hist.push({ role: 'user', content: '[WYNIKI WYSZUKIWANIA W INTERNECIE dla „' + ws.query + '”]\n' + String(found).slice(0, 6000) + '\n[KONIEC WYNIKÓW - odpowiedz użytkownikowi na ich podstawie; nie używaj już web_search]' });
        const out2 = await claude({ system: CHAT_SYSTEM + buildContext(), messages: hist, max: 1500, json: true });
        p = parseAssistant(out2); p.actions = (p.actions || []).filter(a => !a || a.type !== 'web_search');
      }
      const acts = runActions(p.actions);
      S.chat.push({ role: 'assistant', text: p.reply || '(brak odpowiedzi)', acts, ax: p.actions, choices: p.choices || [] });
    } catch (e) { S.chat.push({ role: 'assistant', text: 'Błąd: ' + (e.message || e) }); }
    chatBusy = false; save(); paintChat();
  },

  /* ustawienia */
  saveSettings: () => { const st = S.settings; st.name = val('sName') || 'Ania'; st.provider = val('sProv') || 'anthropic'; st.apiKey = val('sKey'); st.model = val('sModel') || PROVIDERS[st.provider].model; st.baseUrl = val('sBase'); save(); toast('Zapisano'); },
  exportData: async () => { try { await navigator.clipboard.writeText(JSON.stringify(S)); toast('Skopiowano - wklej do notatki/maila'); } catch (e) { toast('Nie udało się skopiować'); } },
  importData: () => sheet(`<h1 style="font-size:22px">Wczytaj kopię</h1><p class="muted">Wklej skopiowane dane. Zastąpią obecne.</p><textarea id="impText"></textarea><div class="btns foot"><button class="btn" data-act="doImport">Wczytaj</button></div>`),
  doImport: () => { try { const j = JSON.parse(val('impText')); S = Object.assign(JSON.parse(JSON.stringify(DEF)), j); save(); closeSheet(); tab('start'); toast('Wczytano'); } catch (e) { toast('Niepoprawne dane'); } }
};

function init() {
  S = load();
  window.addEventListener('unhandledrejection', ev => { try { busy(false); toast('Coś poszło nie tak - dane są bezpieczne'); } catch (e) {} });
  window.addEventListener('error', () => { try { busy(false); } catch (e) {} });
  document.addEventListener('click', ev => {
    if (ev.target.id === 'sheet') { dismissSheet(); return; }
    const t = ev.target.closest('[data-act]');
    if (!t) return;
    const f = A[t.dataset.act]; if (f) f(t.dataset, t, ev);
  });
  document.addEventListener('input', ev => {
    const live = ev.target.dataset && ev.target.dataset.live;
    if (live === 'shopfav') { const f = $('#favSug'); if (f) f.innerHTML = favChips(ev.target.value); }
    if (live === 'links') $('#list').innerHTML = listLinks(ev.target.value);
    if (live === 'recipes') $('#list').innerHTML = listRecipes(ev.target.value, favOnly);
    if (draft && ev.target.closest && ev.target.closest('#panel')) { clearTimeout(saveDraftSoon._t); saveDraftSoon._t = setTimeout(saveDraftSoon, 600); }
    if (ev.target.id === 'ePrep') { const v = ev.target.value; $('#eRepBox').style.display = v ? 'block' : 'none'; $('#eDaysBox').style.display = v === 'w' ? 'block' : 'none'; }
    if (ev.target.id === 'chatIn') { ev.target.style.height = 'auto'; ev.target.style.height = Math.min(ev.target.scrollHeight, 120) + 'px'; }
  });
  document.addEventListener('keydown', ev => {
    const en = ev.target.dataset && ev.target.dataset.enter;
    if (en && ev.key === 'Enter' && !(ev.shiftKey && en === 'chatSend')) { ev.preventDefault(); A[en](); }
  });
  document.querySelectorAll('.ni').forEach(e => { e.innerHTML = ic(e.dataset.i, +e.dataset.s || 26); });
  document.addEventListener('change', ev => {
    if (ev.target.id === 'pTime' && ev.target.value) { S.settings.plantTime = ev.target.value; save(); ensurePlantEventForce(); toast('Godzina zapisana'); }
    if (ev.target.id === 'sProv') {
      const p = PROVIDERS[ev.target.value];
      $('#sModel').value = p.model; $('#sBase').value = p.base || '';
      $('#sBaseWrap').classList.toggle('hidden', ev.target.value !== 'openai');
    }
  });
  try {
    const ap = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (ap && ap.addListener) ap.addListener('backButton', backPress);
  } catch (e) { /* bez natywnego Wstecz działa strzałka w aplikacji */ }
  window.addEventListener('resize', () => { if (route.v === 'chat') window.scrollTo(0, document.documentElement.scrollHeight); });
  window.onShared = () => { const t = window.__shared; window.__shared = null; if (t) { render(); openAdd(t); } };
  render();
  if (window.__shared) window.onShared();
  // przypomnienia o roślinach po starcie (np. po restarcie telefonu)
  S.plants.forEach(p => { unnotify('pw' + p.id); unnotify('pf' + p.id); });
  ensurePlantEvent();
  if (S.settings.notifV !== 3) { S.events.filter(e => !e.done).forEach(e => scheduleEvent(e)); S.settings.notifV = 3; save(); }
  else S.events.filter(e => e.rep).forEach(e => scheduleEvent(e));
  try { window.Capacitor.Plugins.App.addListener('resume', () => { S.events.filter(e => e.rep).forEach(e => scheduleEvent(e)); render(); }); } catch (e) {}
  recoverFromIdb();
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (d && d.title && !window.__shared) { openRecipeEditor(d, !!d._new); toast('Przywrócono niedokończony przepis'); }
  } catch (e) {}
}

if (typeof document !== 'undefined') init();
if (typeof module !== 'undefined') module.exports = { parseRecipeText, parseIngredient, itemText, looksLikeRecipe, scaleText };
