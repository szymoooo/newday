// Wspólny kod testów: serwuje www/ pod http://localhost/ i odcina resztę internetu
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'www');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

// Tworzy aplikację w czystej przeglądarce. state = zawartość localStorage (obiekt), routes = zewnętrzne adresy
async function open(state, routes) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('BŁĄD JS: ' + e.message));
  page.on('dialog', d => d.accept());
  await ctx.route('**/*', async r => {
    const u = new URL(r.request().url());
    if (u.hostname === 'localhost') {
      const f = path.join(ROOT, u.pathname === '/' ? 'index.html' : u.pathname);
      if (fs.existsSync(f)) return r.fulfill({ status: 200, contentType: MIME[path.extname(f)] || 'text/plain', body: fs.readFileSync(f) });
      return r.fulfill({ status: 404, body: '' });
    }
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS, body: '' });
    if (routes && (await routes(r, u))) return;
    return r.abort();
  });
  if (state) await page.addInitScript(s => { if (!localStorage.getItem('mojdzien.v1')) localStorage.setItem('mojdzien.v1', JSON.stringify(s)); }, state);
  await page.goto('http://localhost/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  return { browser, ctx, page, errs };
}

// Odpowiedzi udawanego AI (Gemini): fn(tekst promptu, treść żądania) -> obiekt JSON
const gemini = fn => async (r, u) => {
  if (!u.hostname.includes('generativelanguage')) return false;
  const raw = r.request().postData() || '';
  let sys = '', last = '';
  try { const j = JSON.parse(raw); sys = ((j.systemInstruction || j.system_instruction || {}).parts || []).map(p => p.text).join(''); last = (j.contents || []).slice(-1)[0].parts.map(p => p.text || '').join(' '); } catch (e) { /* ignoruj */ }
  let out; try { out = fn(sys, last, raw); } catch (e) { out = null; }
  if (out === null || out === undefined) { await r.fulfill({ status: 500, headers: CORS, contentType: 'application/json', body: '{"error":{"message":"mock"}}' }); return true; }
  await r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: typeof out === 'string' ? out : JSON.stringify(out) }] } }] }) });
  return true;
};
const site = (host, html) => async (r, u) => {
  if (u.hostname !== host) return false;
  await r.fulfill({ status: 200, headers: CORS, contentType: 'text/html; charset=utf-8', body: html }); return true;
};
const chain = (...hs) => async (r, u) => { for (const h of hs) if (await h(r, u)) return true; if (u.hostname.includes('noembed')) { await r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{"error":"x"}' }); return true; } return false; };
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const KEY = { settings: { name: 'Test', apiKey: 'test-key', provider: 'gemini', model: 'test-model' } };
module.exports = { open, gemini, site, chain, PNG, KEY, CORS };
