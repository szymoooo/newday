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
function sheet(html) { $('#panel').innerHTML = html; $('#sheet').classList.remove('hidden'); }
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
function pickImage(max) {
  return new Promise(res => {
    const inp = $('#filePick');
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
function schedulePlant(p) {
  const d = plantDue(p);
  const at = days => { const x = new Date(addDays(today(), days) + 'T09:00:00'); return x; };
  notify('pw' + p.id, 'Podlewanie 🌿', 'Podlej: ' + p.name, at(Math.max(d.water, 0)));
  if (p.fertDays) notify('pf' + p.id, 'Nawożenie 🌿', 'Nawieź: ' + p.name, at(Math.max(d.fert, 0)));
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
const CATS = [['praca', 'Praca'], ['zdrowie', 'Zdrowie'], ['leki', 'Leki'], ['weterynarz', 'Weterynarz'], ['groomer', 'Fryzjer dla zwierząt'], ['karmienie', 'Karmienie zwierząt'], ['zwierzeta', 'Zwierzęta'], ['dom', 'Dom'], ['zakupy', 'Zakupy'], ['rodzina', 'Rodzina'], ['nauka', 'Nauka'], ['sport', 'Sport'], ['spotkanie', 'Spotkanie'], ['urodziny', 'Urodziny'], ['podroz', 'Podróż'], ['auto', 'Auto'], ['finanse', 'Finanse'], ['uroda', 'Uroda'], ['urzedy', 'Sprawy'], ['inne', 'Inne']];
const CAT_RULES = [
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
  const pl = S.plants.filter(p => { const d = plantDue(p); return d.water <= 0 || d.fert <= 0; });
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
  const row = x => '<div class="prow"><button class="check ' + (x.done ? 'on' : '') + '" data-act="shopTick" data-id="' + x.id + '" aria-label="Kupione">' + (x.done ? ic('check', 18, 3) : '') + '</button>' +
    '<div class="grow ' + (x.done ? 'done' : '') + '"><div class="t">' + esc(x.text) + '</div>' + (x.from ? '<div class="muted">' + esc(x.from) + '</div>' : '') + '</div>' +
    '<button class="ibtn round" style="box-shadow:none;background:transparent;color:#B8ADA4" data-act="shopDel" data-id="' + x.id + '" aria-label="Usuń">' + ic('x', 22, 2) + '</button></div>';
  return '<div class="hdr">' + BACK_BTN() + '<div class="grow"><h1>Zakupy</h1><div class="muted" style="margin-top:4px">' + todo.length + ' do kupienia · ' + done.length + ' w koszyku</div></div>' +
    (done.length ? '<button class="ibtn" data-act="shopClear">Usuń kupione</button>' : '') + '</div>' +
    '<div class="row"><label class="search grow" style="margin:0"><input id="newItem" placeholder="Dodaj produkt…" aria-label="Dodaj produkt" data-enter="shopAdd"></label>' +
    '<button class="ibtn round" style="background:var(--acc);color:#fff;width:52px;height:52px;box-shadow:0 6px 16px rgba(200,69,26,.3)" data-act="shopAdd" aria-label="Dodaj">' + ic('plus', 26, 2.4) + '</button></div>' +
    '<div class="card flush" style="margin-top:16px">' + (todo.map(row).join('') || '<div class="muted" style="padding:16px 0">Lista pusta</div>') + '</div>' +
    (done.length ? '<h2 style="color:var(--mut)">W koszyku</h2><div class="card flush">' + done.map(row).join('') + '</div>' : '');
}

/* --- Więcej --- */
function vMore() {
  return hdr('Więcej') + '<div class="grid">' +
    tile('go', 'cal', 'c-blue', 'Kalendarz', 'events') + tile('go', 'note', 'c-yellow', 'Notatki', 'notes') + tile('go', 'gear', 'c-pink', 'Ustawienia', 'settings') + '</div>';
}

/* --- Rośliny --- */
function vPlants() {
  const cards = S.plants.map(p => {
    const d = plantDue(p);
    return '<div class="card">' + (p.img ? '<img class="thumb" src="' + p.img + '" alt="">' : '') +
      '<div class="row" style="margin-top:' + (p.img ? 12 : 0) + 'px"><span class="ico sm c-green">' + ic('leaf') + '</span><div class="grow"><h3>' + esc(p.name) + '</h3><div>' + dueLabel(d.water, 'Podlewanie') + (p.fertDays ? ' · ' + dueLabel(d.fert, 'Nawożenie') : '') + '</div></div></div>' +
      (p.note ? '<div class="muted" style="margin-top:8px">' + esc(p.note) + '</div>' : '') +
      '<div class="btns"><button class="btn sm" data-act="plantWater" data-id="' + p.id + '">Podlane</button>' +
      (p.fertDays ? '<button class="btn sm ghost" data-act="plantFert" data-id="' + p.id + '">Nawiezione</button>' : '') +
      '<button class="btn sm ghost" data-act="editPlant" data-id="' + p.id + '">Edytuj</button></div></div>';
  }).join('') || '<div class="muted card">Brak roślin. Dodaj pierwszą - możesz zrobić zdjęcie i poprosić AI o rozpoznanie.</div>';
  return hdr('Rośliny', true, '<button class="btn sm" data-act="newPlant">+ Roślina</button>') + cards;
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
  return S.chat.map(m => '<div class="bubble ' + (m.role === 'user' ? 'me' : 'ai') + '">' + mdLite(m.text) + '</div>' +
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
{"reply":"tekst dla użytkownika","actions":[ ... ]}

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
let micOn = false;
function micPlugin() { const P = window.Capacitor && window.Capacitor.Plugins; return P && P.SpeechRecognition; }

function parseAssistant(out) {
  try {
    const j = extractJSON(out);
    if (j && typeof j.reply === 'string') return { reply: j.reply, actions: Array.isArray(j.actions) ? j.actions : [] };
  } catch (e) { /* zwykły tekst */ }
  return { reply: String(out || '').trim(), actions: [] };
}
function chatHistory() {
  const out = [];
  S.chat.slice(-16).forEach(m => {
    if (m.role !== 'user' && /^Błąd:/.test(m.text)) return;
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = role === 'user' ? m.text : JSON.stringify({ reply: m.text, actions: m.ax || [] });
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
function addShopItems(items, from) {
  const added = [];
  items.forEach(t => {
    t = cap1(String(t || '').trim()); if (!t) return;
    if (S.shopping.some(x => !x.done && norm(x.text) === norm(t))) return;
    S.shopping.push({ id: uid(), text: t, done: false, from: from || '' }); added.push(t);
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

const VIEWS = { start: vStart, links: vLinks, recipes: vRecipes, recipe: vRecipe, shopping: vShopping, more: vMore, plants: vPlants, events: vEvents, notes: vNotes, chat: vChat, settings: vSettings, search: vSearch };

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
    <div class="btns foot"><button class="btn ghost" data-act="addPhoto">📷 Zdjęcie</button><button class="btn" data-act="addGo">Rozpoznaj i zapisz</button></div>`);
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
  p = p || {}; plantDraftImg = p.img || '';
  sheet(`<h1 style="font-size:22px">${p.id ? 'Edytuj roślinę' : 'Nowa roślina'}</h1>
    <div id="pImg">${plantDraftImg ? `<img class="thumb" src="${plantDraftImg}" alt="">` : ''}</div>
    <div class="btns"><button class="btn sm ghost" data-act="plantPhoto">📷 Zdjęcie</button><button class="btn sm ghost" data-act="plantAI">🤖 Rozpoznaj (AI)</button></div>
    <input type="hidden" id="pId" value="${p.id || ''}">
    <label>Nazwa</label><input id="pName" value="${esc(p.name || '')}">
    <div class="cols2"><div><label>Podlewanie co (dni)</label><input id="pWater" inputmode="numeric" value="${p.waterDays || 7}"></div>
    <div><label>Nawożenie co (dni)</label><input id="pFert" inputmode="numeric" placeholder="0 = brak" value="${p.fertDays == null ? 30 : p.fertDays}"></div></div>
    <label>Notatka</label><textarea id="pNote" style="min-height:70px">${esc(p.note || '')}</textarea>
    <div class="btns foot"><button class="btn" data-act="savePlant">Zapisz</button>${p.id ? `<button class="btn red" data-act="delPlant" data-id="${p.id}">Usuń</button>` : ''}</div>`);
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
  pickCat: (d) => {
    $('#eCat').value = d.c || '';
    document.querySelectorAll('.catpick').forEach(b => b.classList.toggle('sel', (b.dataset.c || '') === (d.c || '')));
    $('#eCatName').textContent = d.c ? catName(d.c) : 'automatycznie po tytule';
  },
  editEvent: (d) => openEventEditor(byId(S.events, d.id)),
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
      S.chat.push({ role: 'assistant', text: p.reply || '(brak odpowiedzi)', acts, ax: p.actions });
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
  S.plants.forEach(schedulePlant);
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
