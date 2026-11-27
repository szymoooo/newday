// Testy automatyczne "Mój Dzień" - uruchamiane przy każdym budowaniu (npm test).
// Każdy test startuje czystą aplikację w przeglądarce, z udawanym AI i bez dostępu do internetu.
const assert = require('assert');
const { open, gemini, site, chain, PNG, KEY, CORS } = require('./harness');

const tests = [];
const T = (name, fn) => tests.push([name, fn]);
const ev = (page, fn, arg) => page.evaluate(fn, arg);
const today = () => new Date().toISOString().slice(0, 10);

/* ---------- start i nawigacja ---------- */
T('Aplikacja startuje bez błędów, układ C jest domyślny', async () => {
  const { browser, page, errs } = await open({ settings: { name: 'Ala' } });
  try {
    assert.ok(await ev(page, () => document.body.className.includes('lay-C')), 'brak układu C');
    assert.ok(await ev(page, () => document.querySelectorAll('nav button').length >= 5), 'brak dolnego paska');
    assert.deepStrictEqual(errs, []);
  } finally { await browser.close(); }
});

T('Wszystkie ekrany otwierają się bez błędów', async () => {
  const { browser, page, errs } = await open({ settings: { name: 'Ala' } });
  try {
    for (const v of ['start', 'links', 'recipes', 'shopping', 'plants', 'events', 'notes', 'budget', 'favs', 'chat', 'more', 'settings']) {
      await ev(page, v => go(v), v);
      const len = await ev(page, () => document.body.innerText.length);
      assert.ok(len > 20, 'pusty ekran: ' + v);
    }
    assert.deepStrictEqual(errs, []);
  } finally { await browser.close(); }
});

T('Ustawienia: wersja widoczna tylko tutaj, zmiana układu działa', async () => {
  const { browser, page, errs } = await open({ settings: { name: 'Ala' } });
  try {
    await ev(page, () => go('settings'));
    assert.ok(/wersja/i.test(await ev(page, () => document.body.innerText)), 'brak wersji w ustawieniach');
    await ev(page, () => A.setLayout({ l: 'A' }));
    assert.ok(await ev(page, () => document.body.className.includes('lay-A')));
    assert.deepStrictEqual(errs, []);
  } finally { await browser.close(); }
});

T('Dane zostają po przeładowaniu', async () => {
  const { browser, page } = await open({ settings: { name: 'Ala' } });
  try {
    await ev(page, () => { S.notes.unshift({ id: 'n1', text: 'Test trwałości', pin: false, ts: Date.now() }); save(); });
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(500);
    assert.strictEqual(await ev(page, () => S.notes.some(n => n.text === 'Test trwałości')), true);
  } finally { await browser.close(); }
});

/* ---------- kategorie ---------- */
T('Kategorie produktów: rozpoznawanie odmian i nowe kategorie', async () => {
  const { browser, page } = await open({ settings: { name: 'Ala' } });
  try {
    const cases = { 'kilo cukru': 'suche', 'cukierki': 'slodycze', 'płyn do naczyń': 'chemia', 'tabletki do zmywarki': 'chemia', 'karma dla Gabi': 'zwierzeta', 'papier toaletowy': 'higiena', 'mleko 2%': 'nabial', 'ser żółty': 'sery', 'szynka': 'wedliny', 'paliwo': 'auto', 'róża': 'rosliny', 'bukiet kwiatów': 'rosliny', 'baterie AA': 'elektronika', 'piwo': 'alkohol', 'jabłka': 'owoce', 'pomidory': 'warzywa', 'chleb': 'pieczywo', 'kurczak': 'mieso', 'proszek do prania': 'chemia', 'coś dziwnego': 'inne' };
    for (const [t, k] of Object.entries(cases)) assert.strictEqual(await ev(page, t => guessPcat(t), t), k, t);
  } finally { await browser.close(); }
});

T('Kategorie wydarzeń: weterynarz i fryzjer mają własne ikony', async () => {
  const { browser, page } = await open({ settings: { name: 'Ala' } });
  try {
    assert.strictEqual(await ev(page, () => guessCat('Gabi weterynarz')), 'weterynarz');
    assert.strictEqual(await ev(page, () => guessCat('Haru groomer')), 'groomer');
  } finally { await browser.close(); }
});

/* ---------- przepisy ---------- */
const BLOG = '<html><head><title>Zupa pomidorowa - blog</title><meta property="og:title" content="Zupa pomidorowa"></head><body><nav>Menu</nav><h1>Zupa pomidorowa</h1><p>Pyszna zupa na każdą okazję, robiona od lat w moim domu. Naprawdę warto ją przygotować.</p><p>Mój dziadek zawsze mówił, że najlepsza jest z własnych pomidorów.</p><h2>Składniki</h2><ul><li>1 kg pomidorów</li><li>1 cebula</li><li>500 ml bulionu</li></ul><h2>Przygotowanie</h2><p>Pokrój cebulę i podsmaż. Dodaj pomidory i bulion. Gotuj 20 minut. Zblenduj.</p></body></html>';

T('Przepis z linku (strona z przepisem, bez AI) otwiera edytor, nie zwykły link', async () => {
  const { browser, page, errs } = await open({ settings: { name: 'Ala' } }, chain(site('blog.example.com', BLOG)));
  try {
    await ev(page, () => handleUrl('https://blog.example.com/zupa'));
    await page.waitForTimeout(800);
    assert.strictEqual(await ev(page, () => S.links.length), 0, 'zapisał się jako link');
    assert.ok(/przepis/i.test(await ev(page, () => document.querySelector('#panel h1').textContent)), 'brak edytora przepisu');
    const vals = await ev(page, () => [...document.querySelectorAll('#panel input,#panel textarea')].map(e => e.value).join('|').toLowerCase());
    assert.ok(vals.includes('pomidor') && vals.includes('cebul'), 'brak składników w edytorze');
    assert.deepStrictEqual(errs, []);
  } finally { await browser.close(); }
});

T('Przepis z linku z JSON-LD (schema.org Recipe)', async () => {
  const ld = '<html><head><title>Ciasto</title><script type="application/ld+json">{"@context":"https://schema.org","@type":"Recipe","name":"Ciasto marchewkowe","recipeYield":"8","recipeIngredient":["3 marchewki","200 g mąki","2 jajka"],"recipeInstructions":[{"@type":"HowToStep","text":"Zetrzyj marchew."},{"@type":"HowToStep","text":"Wymieszaj i piecz 45 min."}]}</script></head><body>x</body></html>';
  const { browser, page } = await open({ settings: { name: 'Ala' } }, chain(site('ld.example.com', ld)));
  try {
    await ev(page, () => handleUrl('https://ld.example.com/ciasto'));
    await page.waitForTimeout(600);
    const txt = await ev(page, () => document.querySelector('#panel').innerText + [...document.querySelectorAll('#panel input,#panel textarea')].map(e => e.value).join('|'));
    assert.ok(txt.includes('Ciasto marchewkowe') && txt.includes('marchew'), 'nie wczytał przepisu z JSON-LD');
  } finally { await browser.close(); }
});

T('Przepis z linku: AI czyta stronę bez znaczników', async () => {
  const messy = '<html><head><title>Mój blog</title></head><body><div><p>Wczoraj zrobiłam coś pysznego!</p><p>Wzięłam pół kilo twarogu, trzy jajka i cukier, wymieszałam wszystko razem i upiekłam w piekarniku przez godzinę.</p><p>Wyszło cudownie, polecam wszystkim którzy lubią sernik.</p></div></body></html>';
  const ai = { type: 'recipe', recipe: { title: 'Sernik babci', servings: 8, groups: [{ name: '', items: ['500 g twarogu', '3 jajka', 'cukier'] }], steps: ['Wymieszaj.', 'Piecz godzinę.'] } };
  const { browser, page } = await open(KEY, chain(site('messy.example.com', messy), gemini(() => ai)));
  try {
    await ev(page, () => handleUrl('https://messy.example.com/sernik'));
    await page.waitForTimeout(1000);
    const txt = await ev(page, () => [...document.querySelectorAll('#panel input,#panel textarea')].map(e => e.value).join('|'));
    assert.ok(txt.includes('Sernik babci'), 'AI nie zbudowało przepisu: ' + txt.slice(0, 120));
  } finally { await browser.close(); }
});

T('Link niebędący przepisem zapisuje się w Linkach; przy awarii AI jest komunikat', async () => {
  const news = '<html><head><title>Wiadomości dnia</title><meta property="og:title" content="Wiadomości dnia"></head><body><p>Dzisiaj w mieście otwarto nowy most nad rzeką, mieszkańcy są zadowoleni.</p></body></html>';
  const { browser, page } = await open(KEY, chain(site('news.example.com', news), gemini(() => null)));
  try {
    await ev(page, () => handleUrl('https://news.example.com/a'));
    await page.waitForTimeout(1500);
    assert.strictEqual(await ev(page, () => S.links.length), 1);
  } finally { await browser.close(); }
});

T('Substack: wpis z wieloma przepisami zapisuje każdy osobno', async () => {
  const rec = (t, ing) => '<h2>' + t + '</h2><h3>Składniki</h3><ul>' + ing.map(i => '<li>' + i + '</li>').join('') + '</ul><h3>Przygotowanie</h3><ol><li>Wymieszaj składniki.</li><li>Piecz 12 minut.</li></ol>';
  const html = '<p>Cześć! Oto moje ciasteczka.</p>' + rec('Pierniczki', ['300 g mąki', '100 g miodu', '1 jajko']) + rec('Kruche ciastka', ['250 g mąki', '125 g masła', '80 g cukru pudru']) + rec('Makagigi', ['200 g maku', '100 g miodu', '50 g orzechów']);
  const { browser, page } = await open({ settings: { name: 'Ala' } }, async (r, u) => {
    if (u.hostname === 'substack.com') { await r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ post: { title: 'Święta', body_html: html, canonical_url: 'https://x.substack.com/p/s' } }) }); return true; }
    return false;
  });
  try {
    await ev(page, () => handleUrl('https://substack.com/home/post/p-225498298'));
    await page.waitForTimeout(800);
    assert.ok((await ev(page, () => S.recipes.length)) >= 2, 'mniej niż 2 przepisy');
  } finally { await browser.close(); }
});

T('Przepisy: kategorie, filtr i ulubione', async () => {
  const rec = (id, t, cat, fav) => ({ id, title: t, cat, fav, groups: [{ name: '', items: [{ text: 'x', qty: 1, unit: '' }] }], steps: ['a'], servings: 2, ts: 1 });
  const { browser, page, errs } = await open({ settings: { name: 'Ala' }, recipes: [rec('r1', 'Zupa jarzynowa', 'zupy', false), rec('r2', 'Szarlotka', 'ciasta', true)] });
  try {
    await ev(page, () => go('recipes'));
    const txt = await ev(page, () => document.body.innerText);
    assert.ok(txt.includes('Zupa jarzynowa') && txt.includes('Szarlotka'));
    assert.deepStrictEqual(errs, []);
  } finally { await browser.close(); }
});

/* ---------- zakupy, ulubione, budżet ---------- */
T('Zakupy: dodawanie, kategorie, odhaczanie, cena z paragonu, cena za kg', async () => {
  const exp = { id: 'e1', date: today(), store: 'Lidl', src: 'receipt', ts: 1, items: [{ name: 'Budyń', price: 2.98, cat: 'suche' }, { name: 'Pomidor malinowy luzem', price: 41.36, cat: 'warzywa', unit: 'kg', qty: 1.38, unitPrice: 29.99 }] };
  const { browser, page, errs } = await open({ settings: { name: 'Ala' }, expenses: [exp] });
  try {
    await ev(page, () => go('shopping'));
    for (const t of ['Kilo cukru', 'Budyń', 'Pomidor malinowy luzem']) { await page.fill('#newItem', t); await page.press('#newItem', 'Enter'); }
    const txt = await ev(page, () => document.body.innerText);
    assert.ok(txt.includes('Produkty suche'), 'brak grupy Produkty suche');
    assert.ok(txt.includes('2,98 zł'), 'brak ceny z paragonu');
    assert.ok(txt.includes('29,99 zł/kg'), 'brak ceny za kg');
    await page.click('.prow .check');
    assert.ok(await ev(page, () => S.shopping.some(x => x.done)));
    assert.deepStrictEqual(errs, []);
  } finally { await browser.close(); }
});

T('Zakupy: AI kategoryzuje to, czego reguły nie znają', async () => {
  const { browser, page } = await open(KEY, gemini((sys, last) => /Przypisz/.test(sys + last) ? { items: [{ i: 0, c: 'dom' }] } : null));
  try {
    await ev(page, () => go('shopping'));
    await page.fill('#newItem', 'xyzzy dziwactwo'); await page.press('#newItem', 'Enter');
    await page.waitForTimeout(1500);
    assert.strictEqual(await ev(page, () => S.shopping[0].cat), 'dom');
  } finally { await browser.close(); }
});

T('Ulubione: podpowiedzi przy wpisywaniu i dodanie z ulubionych (3+ zakupów)', async () => {
  const mk = (d, p) => ({ id: 'e' + d, date: d, store: 'X', src: 'receipt', ts: 1, items: [{ name: 'Zott Jogobella malinowa', price: p, cat: 'nabial', type: 'jogurt' }] });
  const { browser, page } = await open({ settings: { name: 'Ala' }, expenses: [mk('2026-11-01', 2.79), mk('2026-11-08', 2.89), mk('2026-11-15', 2.99)] });
  try {
    await ev(page, () => go('shopping'));
    await page.fill('#newItem', 'jogo');
    assert.ok((await ev(page, () => document.querySelector('#favSug').textContent)).includes('Jogobella'));
    await page.click('#favSug [data-act=favAdd]');
    assert.strictEqual(await ev(page, () => S.shopping.length), 1);
  } finally { await browser.close(); }
});

T('Skaner paragonów: odczyt, edytor, ceny za kg, zapis i budżet', async () => {
  const receipt = { store: 'Lidl', date: '2026-11-24', total: 25, items: [{ name: 'Mleko UHT 3,2%', price: 3.49, cat: 'nabial' }, { name: 'Pomidor malinowy', price: 29.99, unit: 'kg', qty: 0.5, unitPrice: 29.99, cat: 'warzywa' }, { name: 'Szynka', price: 10.92, cat: 'wedliny' }] };
  const { browser, page, errs } = await open(KEY, gemini(() => receipt));
  try {
    await ev(page, () => go('budget'));
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act=scanGal]')]);
    await fc.setFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForSelector('#xn0', { timeout: 10000 });
    assert.strictEqual(await ev(page, () => document.querySelector('#xp1').value), '15', 'cena za kg nie została przeliczona na kwotę pozycji');
    await ev(page, () => A.expSave());
    const e = await ev(page, () => S.expenses[0]);
    assert.strictEqual(e.store, 'Lidl'); assert.strictEqual(e.items.length, 3); assert.strictEqual(e.items[1].unit, 'kg');
    assert.deepStrictEqual(errs, []);
  } finally { await browser.close(); }
});

T('Budżet: limity i widok miesiąca', async () => {
  const { browser, page, errs } = await open({ settings: { name: 'Ala' }, expenses: [{ id: 'e1', date: today(), store: 'Biedronka', src: 'receipt', ts: 1, items: [{ name: 'Mleko', price: 3.4, cat: 'nabial' }], total: 3.4 }] });
  try {
    await ev(page, () => go('budget'));
    await ev(page, () => { A.budLimit(); document.querySelector('#bLim').value = '2500'; A.budLimitSave(); });
    assert.strictEqual(await ev(page, () => S.budget.limit), 2500);
    assert.ok((await ev(page, () => document.body.innerText)).includes('Biedronka'));
    assert.deepStrictEqual(errs, []);
  } finally { await browser.close(); }
});

T('Ulubione ze zdjęcia (przód + tył): tylko główny produkt, nie wpada do zakupów, karta produktu', async () => {
  const ai = (sys, last) => /Na podstawie/.test(sys) ? { size: '1,75 l', info: 'Napój gazowany.' } : { items: [{ name: 'Coca-Cola Original Taste', type: 'cola', cat: 'napoje', size: '1,75 l', info: 'Napój gazowany' }] };
  const { browser, page, errs } = await open(KEY, gemini(ai));
  try {
    await ev(page, () => go('favs'));
    await ev(page, () => { pickImage = async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='; });
    await ev(page, () => A.favScanCam());
    await page.waitForSelector('[data-act=favBackCam]');
    await page.click('[data-act=favBackCam]');
    await page.waitForSelector('#fdn0', { timeout: 10000 });
    await page.click('[data-act=favDraftSave]'); await page.waitForTimeout(300);
    assert.strictEqual(await ev(page, () => S.favs.length), 1);
    assert.strictEqual(await ev(page, () => S.shopping.length), 0, 'produkt trafił od razu do zakupów');
    await page.click('.prow [data-act=favCard]'); await page.waitForSelector('#fcName');
    assert.strictEqual(await ev(page, () => document.querySelector('#fcSize').value), '1,75 l');
    await page.click('[data-act=favAdd][data-close]'); await page.waitForTimeout(200);
    assert.strictEqual(await ev(page, () => S.shopping.length), 1);
    assert.deepStrictEqual(errs, []);
  } finally { await browser.close(); }
});

/* ---------- rośliny, kalendarz, notatki, linki, asystent ---------- */
T('Rośliny: dodanie, podlanie, jedno zbiorcze powiadomienie', async () => {
  const { browser, page, errs } = await open({ settings: { name: 'Ala' } });
  try {
    await ev(page, () => { S.plants.push({ id: 'p1', name: 'Monstera', waterDays: 7, fertDays: 30, own: true, spot: 'Salon', lastWater: '2000-01-01', lastFert: '2000-01-01', care: {} }); save(); go('plants'); });
    assert.ok((await ev(page, () => document.body.innerText)).includes('Monstera'));
    const due = await ev(page, () => plantsToDo().length);
    assert.ok(due >= 1, 'roślina nie jest do podlania');
    await ev(page, () => { A.plantWater({ id: 'p1' }); A.plantFert({ id: 'p1' }); });
    assert.strictEqual(await ev(page, () => plantsToDo().length), 0);
    assert.deepStrictEqual(errs, []);
  } finally { await browser.close(); }
});

T('Kalendarz i notatki: dodawanie i wyświetlanie', async () => {
  const { browser, page, errs } = await open({ settings: { name: 'Ala' } });
  try {
    await ev(page, () => { S.events.push({ id: 'ev1', title: 'Gabi weterynarz', date: new Date().toISOString().slice(0, 10), time: '10:00', kind: 'event', cat: guessCat('Gabi weterynarz') }); S.notes.unshift({ id: 'n1', text: 'Kupić prezent', pin: false, ts: Date.now() }); save(); go('events'); });
    assert.ok((await ev(page, () => document.body.innerText)).includes('Gabi weterynarz'));
    await ev(page, () => go('notes'));
    assert.ok((await ev(page, () => document.body.innerText)).includes('Kupić prezent'));
    assert.deepStrictEqual(errs, []);
  } finally { await browser.close(); }
});

T('Linki: zwykły link zapisuje się i wyświetla (bez AI)', async () => {
  const { browser, page, errs } = await open({ settings: { name: 'Ala' } }, chain(site('news.example.com', '<html><head><title>Artykuł</title></head><body>x</body></html>')));
  try {
    await ev(page, () => handleUrl('https://news.example.com/a'));
    await page.waitForTimeout(800);
    await ev(page, () => go('links'));
    assert.ok((await ev(page, () => document.body.innerText)).includes('Artykuł'));
    assert.deepStrictEqual(errs, []);
  } finally { await browser.close(); }
});

T('Asystent: odpowiedź i akcja dodania do zakupów', async () => {
  const { browser, page, errs } = await open(KEY, gemini(() => ({ reply: 'Dodane!', actions: [{ type: 'shopping_add', items: ['Mleko'] }], choices: [] })));
  try {
    await ev(page, () => go('chat'));
    await page.fill('#chatIn', 'dodaj mleko do zakupów'); await page.press('#chatIn', 'Enter');
    await page.waitForFunction(() => !document.querySelector('.typing'), null, { timeout: 10000 });
    await page.waitForTimeout(300);
    assert.ok(await ev(page, () => S.shopping.some(x => /mleko/i.test(x.text))), 'asystent nie dodał do zakupów');
    assert.deepStrictEqual(errs, []);
  } finally { await browser.close(); }
});

require('./more')(T, ev, today);
require('./more').layout(T, ev, today);
require('./more').reader(T, ev, today);
require('./more').share(T, ev, today);

(async () => {
  const only = process.argv[2];
  let fail = 0;
  for (const [name, fn] of tests) {
    if (only && !name.toLowerCase().includes(only.toLowerCase())) continue;
    const t0 = Date.now();
    try { await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('przekroczono czas 60 s')), 60000))]); console.log('  ✔ ' + name + ' (' + (Date.now() - t0) + ' ms)'); }
    catch (e) { fail++; console.log('  ✘ ' + name + '\n      ' + String(e.message || e).split('\n')[0]); }
  }
  console.log('\n' + (fail ? fail + ' test(ów) NIE przeszło' : 'Wszystkie testy przeszły'));
  process.exit(fail ? 1 : 0);
})();
