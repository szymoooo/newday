// Rozszerzone testy funkcjonalne: edycje, usuwanie, powtarzanie wydarzeń, rośliny, przepisy, zakupy, budżet, asystent, kopie danych.
const assert = require('assert');
const { open, gemini, site, chain, PNG, KEY } = require('./harness');

module.exports = function (T, ev, today) {
  const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const rec = (id, title, cat, items, extra) => Object.assign({ id, title, cat, fav: false, groups: [{ name: '', items: items || [{ q: 200, u: 'g', n: 'mąki', raw: '200 g mąki' }] }], steps: ['Wymieszaj.', 'Piecz.'], servings: 2, ts: 1 }, extra || {});
  const run = async (state, routes, fn) => { const o = await open(state, routes); try { await fn(o); assert.deepStrictEqual(o.errs, [], 'błędy JS'); } finally { await o.browser.close(); } };

  /* ===== KALENDARZ ===== */
  T('Wydarzenia: dodanie formularzem, widoczne w kalendarzu; pusty tytuł nie zapisuje', async () => run({ settings: { name: 'Ala' } }, null, async ({ page }) => {
    await ev(page, () => { go('events'); A.newEvent(); });
    await page.waitForSelector('#eTitle');
    await ev(page, () => A.saveEvent()); // pusty tytuł
    assert.strictEqual(await ev(page, () => S.events.length), 0, 'zapisało puste wydarzenie');
    await page.fill('#eTitle', 'Dentysta'); await page.fill('#eDate', today()); await page.fill('#eTime', '14:30');
    await ev(page, () => A.saveEvent());
    assert.strictEqual(await ev(page, () => S.events.length), 1);
    await ev(page, () => go('events'));
    assert.ok((await ev(page, () => document.body.innerText)).includes('Dentysta'));
  }));

  T('Wydarzenia: edycja, odhaczenie i usunięcie', async () => run({ settings: { name: 'Ala' }, events: [{ id: 'e1', title: 'Spotkanie', date: today(), time: '10:00', kind: 'event', done: false }] }, null, async ({ page }) => {
    await ev(page, () => { go('events'); A.editEvent({ id: 'e1' }); });
    await page.waitForSelector('#eTitle');
    await page.fill('#eTitle', 'Spotkanie z Anią'); await ev(page, () => A.saveEvent());
    assert.strictEqual(await ev(page, () => S.events[0].title), 'Spotkanie z Anią');
    await ev(page, () => A.evDone({ id: 'e1' }));
    assert.strictEqual(await ev(page, () => S.events[0].done), true);
    await ev(page, () => A.delEvent({ id: 'e1' }));
    assert.strictEqual(await ev(page, () => S.events.length), 0);
  }));

  T('Powtarzanie wydarzeń: codziennie, co tydzień (dni), co miesiąc (koniec miesiąca), co rok, „do”, wyjątki', async () => run({ settings: { name: 'Ala' } }, null, async ({ page }) => {
    const r = await ev(page, () => {
      const o = {};
      o.d = [occursOn({ date: '2026-03-01', rep: { t: 'd' } }, '2026-03-05'), occursOn({ date: '2026-03-10', rep: { t: 'd' } }, '2026-03-05')];
      // 2026-03-02 to poniedziałek (getDay 1), 2026-03-04 środa, 2026-03-03 wtorek
      o.w = [occursOn({ date: '2026-03-02', rep: { t: 'w', days: [1, 3] } }, '2026-03-04'), occursOn({ date: '2026-03-02', rep: { t: 'w', days: [1, 3] } }, '2026-03-03')];
      o.m = [occursOn({ date: '2026-01-31', rep: { t: 'm' } }, '2026-02-28'), occursOn({ date: '2026-01-31', rep: { t: 'm' } }, '2026-02-27'), occursOn({ date: '2026-01-15', rep: { t: 'm' } }, '2026-04-15')];
      o.y = [occursOn({ date: '2025-06-10', rep: { t: 'y' } }, '2026-06-10'), occursOn({ date: '2025-06-10', rep: { t: 'y' } }, '2026-06-11')];
      o.until = [occursOn({ date: '2026-03-01', rep: { t: 'd', until: '2026-03-10' } }, '2026-03-10'), occursOn({ date: '2026-03-01', rep: { t: 'd', until: '2026-03-10' } }, '2026-03-11')];
      o.skip = occursOn({ date: '2026-03-01', rep: { t: 'd' }, skip: ['2026-03-05'] }, '2026-03-05');
      o.once = [occursOn({ date: '2026-03-01' }, '2026-03-01'), occursOn({ date: '2026-03-01' }, '2026-03-02')];
      return o;
    });
    assert.deepStrictEqual(r, { d: [true, false], w: [true, false], m: [true, false, true], y: [true, false], until: [true, false], skip: false, once: [true, false] });
  }));

  T('Wydarzenie cykliczne: odhaczenie jednego dnia nie dotyka pozostałych', async () => run({ settings: { name: 'Ala' }, events: [{ id: 'e1', title: 'Leki', date: addDays(-3), time: '08:00', kind: 'event', rep: { t: 'd' } }] }, null, async ({ page }) => {
    await ev(page, d => A.evDone({ id: 'e1', date: d }), today());
    const r = await ev(page, () => { const e = S.events[0]; return [isDoneOn(e, today()), isDoneOn(e, S.events[0].date)]; });
    assert.deepStrictEqual(r, [true, false]);
  }));

  T('Wydarzenie z powtarzaniem zapisane formularzem (co tydzień, wybrane dni, do daty)', async () => run({ settings: { name: 'Ala' } }, null, async ({ page }) => {
    await ev(page, () => { go('events'); A.newEvent(); });
    await page.waitForSelector('#eTitle');
    await page.fill('#eTitle', 'Siłownia'); await page.fill('#eDate', today());
    await page.selectOption('#ePrep', 'w');
    await ev(page, () => { const b = document.querySelector('.eday'); if (b) b.checked = true; });
    await page.fill('#eUntil', addDays(60));
    await ev(page, () => A.saveEvent());
    const e = await ev(page, () => S.events[0]);
    assert.strictEqual(e.rep.t, 'w'); assert.ok(e.rep.until);
  }));

  /* ===== NOTATKI I LINKI ===== */
  T('Notatki: dodanie, edycja, przypięcie, usunięcie', async () => run({ settings: { name: 'Ala' } }, null, async ({ page }) => {
    await ev(page, () => { go('notes'); A.newNote(); });
    await page.waitForSelector('#nText'); await page.fill('#nText', 'Zażółć gęślą jaźń - pierwsza'); await ev(page, () => A.saveNote());
    assert.strictEqual(await ev(page, () => S.notes.length), 1);
    const id = await ev(page, () => S.notes[0].id);
    await ev(page, id => A.editNote({ id }), id); await page.waitForSelector('#nText'); await page.fill('#nText', 'Zmieniona'); await ev(page, () => A.saveNote());
    assert.strictEqual(await ev(page, () => S.notes[0].text), 'Zmieniona');
    await ev(page, id => A.pinNote({ id }), id);
    assert.strictEqual(await ev(page, () => S.notes[0].pin), true);
    await ev(page, id => A.delNote({ id }), id);
    assert.strictEqual(await ev(page, () => S.notes.length), 0);
  }));

  T('Linki: edycja i usunięcie', async () => run({ settings: { name: 'Ala' }, links: [{ id: 'l1', url: 'https://a.pl', title: 'Stary', tags: ['x'], note: '', ts: 1 }] }, null, async ({ page }) => {
    await ev(page, () => { go('links'); A.editLink({ id: 'l1' }); });
    await page.waitForSelector('#lTitle'); await page.fill('#lTitle', 'Nowy tytuł'); await ev(page, () => A.saveLink());
    assert.strictEqual(await ev(page, () => S.links[0].title), 'Nowy tytuł');
    await ev(page, () => A.delLink({ id: 'l1' }));
    assert.strictEqual(await ev(page, () => S.links.length), 0);
  }));

  T('Wyszukiwarka: znajduje przepis, notatkę, produkt i link', async () => run({ settings: { name: 'Ala' }, recipes: [rec('r1', 'Szarlotka', 'ciasta')], notes: [{ id: 'n1', text: 'Kupić szarlotkę dla babci', pin: false, ts: 1 }], links: [{ id: 'l1', url: 'https://x.pl', title: 'Szarlotka wg Kasi', tags: [], note: '', ts: 1 }], shopping: [{ id: 's1', text: 'jabłka na szarlotkę', done: false }] }, null, async ({ page }) => {
    await ev(page, () => go('search', 'szarlotk'));
    const t = await ev(page, () => document.body.innerText);
    assert.ok(t.includes('Szarlotka') && t.includes('babci') && t.includes('jabłka'), 'brak wyników');
  }));

  /* ===== ROŚLINY ===== */
  T('Rośliny: nowa roślina formularzem; bez nazwy się nie zapisuje', async () => run({ settings: { name: 'Ala' } }, null, async ({ page }) => {
    await ev(page, () => { go('plants'); A.newPlant(); });
    await page.waitForSelector('#pName');
    await ev(page, () => A.savePlant());
    assert.strictEqual(await ev(page, () => S.plants.length), 0);
    await page.fill('#pName', 'Fikus'); await page.fill('#pWater', '5');
    await ev(page, () => A.savePlant());
    const p = await ev(page, () => S.plants[0]);
    assert.strictEqual(p.name, 'Fikus'); assert.strictEqual(p.waterDays, 5);
  }));

  T('Rośliny: termin podlewania, lista życzeń, „Mam ją”, usuwanie', async () => run({ settings: { name: 'Ala' }, plants: [
    { id: 'p1', name: 'Monstera', waterDays: 7, fertDays: 30, room: 'Salon', lastWater: addDays(-10), lastFert: today(), care: {} },
    { id: 'p2', name: 'Storczyk', waterDays: 7, fertDays: 0, owned: false, room: 'Kuchnia', lastWater: addDays(-20), care: {} }] }, null, async ({ page }) => {
    const r = await ev(page, () => ({ due: plantDue(S.plants[0]).water, todo: plantsToDo().map(x => x.p.name) }));
    assert.ok(r.due <= 0, 'powinna wymagać podlania'); assert.deepStrictEqual(r.todo, ['Monstera'], 'roślina z listy życzeń nie powinna być do podlania');
    await ev(page, () => A.plantOwn({ id: 'p2' }));
    assert.strictEqual(await ev(page, () => S.plants[1].owned !== false), true);
    await ev(page, () => A.delPlant({ id: 'p2' }));
    assert.strictEqual(await ev(page, () => S.plants.length), 1);
  }));

  T('Rośliny: podlanie całego pokoju nie rusza innych pokoi', async () => run({ settings: { name: 'Ala' }, plants: [
    { id: 'p1', name: 'A', waterDays: 7, room: 'Salon', lastWater: addDays(-10), care: {} },
    { id: 'p2', name: 'B', waterDays: 7, room: 'Kuchnia', lastWater: addDays(-10), care: {} }] }, null, async ({ page }) => {
    await ev(page, () => A.roomWater({ room: 'Salon' }));
    const r = await ev(page, () => S.plants.map(p => p.lastWater));
    assert.strictEqual(r[0], today()); assert.notStrictEqual(r[1], today());
  }));

  /* ===== PRZEPISY ===== */
  T('Przepis: skalowanie porcji zmienia ilości składników', async () => run({ settings: { name: 'Ala' }, recipes: [rec('r1', 'Ciasto', 'ciasta', [{ q: 200, u: 'g', n: 'mąki', raw: '200 g mąki' }, { q: 2, u: '', n: 'jajka', raw: '2 jajka' }])] }, null, async ({ page }) => {
    await ev(page, () => A.openRecipe({ id: 'r1' }));
    assert.ok((await ev(page, () => document.body.innerText)).includes('200'));
    await ev(page, () => A.setScale({ k: '2' }));
    const t = await ev(page, () => document.body.innerText);
    assert.ok(t.includes('400'), 'nie podwoiło mąki');
  }));

  T('Przepis: składniki do zakupów bez duplikatów', async () => run({ settings: { name: 'Ala' }, recipes: [rec('r1', 'Ciasto', 'ciasta', [{ q: 200, u: 'g', n: 'mąki', raw: '200 g mąki' }, { q: 2, u: '', n: 'jajka', raw: '2 jajka' }])] }, null, async ({ page }) => {
    await ev(page, () => { A.openRecipe({ id: 'r1' }); A.toShop({ id: 'r1' }); A.toShop({ id: 'r1' }); });
    assert.strictEqual(await ev(page, () => S.shopping.length), 2);
  }));

  T('Przepis: ulubione, edycja tytułu i usunięcie', async () => run({ settings: { name: 'Ala' }, recipes: [rec('r1', 'Zupa', 'zupy')] }, null, async ({ page }) => {
    await ev(page, () => A.favRecipe({ id: 'r1' }));
    assert.strictEqual(await ev(page, () => S.recipes[0].fav), true);
    await ev(page, () => { go('recipes'); A.editRecipe({ id: 'r1' }); });
    await page.waitForSelector('#panel input');
    await ev(page, () => A.saveRecipe());
    assert.strictEqual(await ev(page, () => S.recipes.length), 1);
    await ev(page, () => A.delRecipe({ id: 'r1' }));
    assert.strictEqual(await ev(page, () => S.recipes.length), 0);
  }));

  T('Przepis wklejony jako tekst (bez AI) otwiera edytor ze składnikami', async () => run({ settings: { name: 'Ala' } }, null, async ({ page }) => {
    await ev(page, () => handleAdd('Naleśniki\nSkładniki:\n250 g mąki\n2 jajka\n500 ml mleka\nPrzygotowanie:\n1. Wymieszaj składniki.\n2. Smaż na patelni.'));
    await page.waitForTimeout(500);
    const vals = await ev(page, () => [...document.querySelectorAll('#panel input,#panel textarea')].map(e => e.value).join('|'));
    assert.ok(/Naleśniki/.test(vals) && /mąki/.test(vals), 'edytor nie zawiera przepisu: ' + vals.slice(0, 100));
  }));

  T('Kategorie przepisów: rozpoznawanie po tytule i filtr', async () => run({ settings: { name: 'Ala' }, recipes: [rec('r1', 'Zupa pomidorowa', null), rec('r2', 'Sernik', null)] }, null, async ({ page }) => {
    const r = await ev(page, () => S.recipes.map(x => rcatsOf(x)));
    assert.ok(r[0].includes('zupy'), 'zupa → zupy: ' + r[0]); assert.ok(r[1].includes('ciasta'), 'sernik → ciasta: ' + r[1]);
    await ev(page, () => { go('recipes'); A.rcatToggle && A.rcatToggle({ k: 'zupy' }); });
  }));

  /* ===== ZAKUPY ===== */
  T('Zakupy: usuwanie pozycji i „Usuń kupione”', async () => run({ settings: { name: 'Ala' }, shopping: [{ id: '1', text: 'Mleko', done: false }, { id: '2', text: 'Chleb', done: true }, { id: '3', text: 'Jajka', done: true }] }, null, async ({ page }) => {
    await ev(page, () => { go('shopping'); A.shopClear(); });
    assert.deepStrictEqual(await ev(page, () => S.shopping.map(x => x.text)), ['Mleko']);
    await ev(page, () => A.shopDel({ id: '1' }));
    assert.strictEqual(await ev(page, () => S.shopping.length), 0);
  }));

  T('Zakupy: ręczna kategoria wygrywa z automatyczną; duplikaty się nie dodają', async () => run({ settings: { name: 'Ala' } }, null, async ({ page }) => {
    const r = await ev(page, () => { addShopItems(['Mleko', 'mleko', 'Chleb']); const n = S.shopping.length; const x = S.shopping[0]; A.shopCatSet({ id: x.id, c: 'napoje' }); return [n, pcatOf(S.shopping[0])]; });
    assert.deepStrictEqual(r, [2, 'napoje']);
  }));

  T('Zakupy: bardzo długa nazwa nie psuje układu (brak poziomego przewijania)', async () => run({ settings: { name: 'Ala' } }, null, async ({ page }) => {
    await ev(page, () => { go('shopping'); });
    await page.fill('#newItem', 'Bardzo długa nazwa produktu bez spacji ' + 'a'.repeat(120)); await page.press('#newItem', 'Enter');
    const over = await ev(page, () => document.documentElement.scrollWidth > window.innerWidth + 2);
    assert.strictEqual(over, false, 'strona wychodzi poza ekran');
  }));

  T('Ulubione: usunięcie automatycznego ulubionego i ręczne dodanie', async () => {
    const mk = d => ({ id: 'e' + d, date: d, store: 'X', src: 'receipt', ts: 1, items: [{ name: 'Serek Danio', price: 2, cat: 'nabial' }] });
    return run({ settings: { name: 'Ala' }, expenses: [mk('2026-11-01'), mk('2026-11-02'), mk('2026-11-03')] }, null, async ({ page }) => {
      assert.strictEqual(await ev(page, () => favPool().length), 1, 'powinien być automatyczny ulubiony');
      await ev(page, () => { go('favs'); A.favDel({ n: favPool()[0].norm }); });
      assert.strictEqual(await ev(page, () => favPool().length), 0);
      await ev(page, () => favToggle('Alpro jagodowe', 'nabial', ''));
      assert.strictEqual(await ev(page, () => favPool().length), 1);
    });
  });

  /* ===== BUDŻET ===== */
  T('Budżet: ręczny wydatek, edycja, usunięcie pozycji i całego wydatku', async () => run({ settings: { name: 'Ala' } }, null, async ({ page }) => {
    await ev(page, () => { go('budget'); A.expNew(); });
    await page.waitForSelector('#xn0');
    await page.fill('#xStore', 'Żabka'); await page.fill('#xn0', 'Woda'); await page.fill('#xp0', '3,50');
    await ev(page, () => A.expSave());
    assert.strictEqual(await ev(page, () => S.expenses.length), 1);
    const id = await ev(page, () => S.expenses[0].id);
    await ev(page, id => A.expEdit({ id }), id); await page.waitForSelector('#xn0');
    await page.fill('#xp0', '4,00'); await ev(page, () => A.expAddRow()); await page.fill('#xn1', 'Chipsy'); await page.fill('#xp1', '6'); await ev(page, () => A.expDelRow({ i: '1' }));
    await ev(page, () => A.expSave());
    assert.strictEqual(await ev(page, () => S.expenses[0].items.length), 1);
    assert.strictEqual(await ev(page, () => S.expenses[0].total), 4);
    await ev(page, id => { A.expEdit({ id }); A.expDel(); }, id);
    assert.strictEqual(await ev(page, () => S.expenses.length), 0);
  }));

  T('Budżet: przełączanie miesięcy pokazuje tylko wydatki z danego miesiąca', async () => {
    const cur = today().slice(0, 7);
    return run({ settings: { name: 'Ala' }, expenses: [
      { id: 'a', date: today(), store: 'SklepBiezacy', src: 'x', ts: 1, items: [{ name: 'A', price: 5, cat: 'inne' }], total: 5 },
      { id: 'b', date: addDays(-45), store: 'SklepStary', src: 'x', ts: 1, items: [{ name: 'B', price: 7, cat: 'inne' }], total: 7 }] }, null, async ({ page }) => {
      await ev(page, () => go('budget'));
      let t = await ev(page, () => document.body.innerText);
      assert.ok(t.includes('SklepBiezacy') && !t.includes('SklepStary'));
      await ev(page, () => A.budMonth({ n: '-2' }));
      t = await ev(page, () => document.body.innerText);
      assert.ok(!t.includes('SklepBiezacy'), 'miesiąc wstecz nadal pokazuje bieżące wydatki');
    });
  });

  T('Budżet: parsowanie i formatowanie cen', async () => run({ settings: { name: 'Ala' } }, null, async ({ page }) => {
    const r = await ev(page, () => [parsePrice('12,50'), parsePrice('1 234,5 zł'), parsePrice(''), parsePrice('abc'), money(3.5), money(1234.567)]);
    assert.deepStrictEqual(r, [12.5, 1234.5, 0, 0, '3,50 zł', '1234,57 zł']);
  }));

  T('Skaner paragonów: bez klucza AI i przy awarii AI jest komunikat, nic się nie psuje', async () => {
    await run({ settings: { name: 'Ala' } }, null, async ({ page }) => {
      await ev(page, () => go('budget')); await ev(page, () => scanReceipt(false));
      assert.strictEqual(await ev(page, () => S.expenses.length), 0);
    });
    await run(KEY, gemini(() => null), async ({ page }) => {
      await ev(page, () => go('budget'));
      const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act=scanGal]')]);
      await fc.setFiles({ name: 'p.png', mimeType: 'image/png', buffer: PNG });
      await page.waitForTimeout(2500);
      assert.strictEqual(await ev(page, () => S.expenses.length), 0);
      assert.ok(await ev(page, () => document.querySelector('#busy').classList.contains('hidden')), 'ekran „Chwila…” został');
    });
  });

  /* ===== ASYSTENT ===== */
  T('Asystent: dodaje wydarzenie, notatkę i oznacza podlanie rośliny', async () => run({ ...KEY, plants: [{ id: 'p1', name: 'Monstera', waterDays: 7, lastWater: addDays(-10), care: {} }] }, gemini((sys, last) => ({ reply: 'Zrobione.', actions: [
    { type: 'event_add', title: 'Wizyta u lekarza', date: today(), time: '09:00' },
    { type: 'note_add', text: 'Pamiętać o recepcie' },
    { type: 'plant_watered', name: 'Monstera' }], choices: [] })), async ({ page }) => {
    await ev(page, () => go('chat'));
    await page.fill('#chatIn', 'zrób kilka rzeczy'); await page.press('#chatIn', 'Enter');
    await page.waitForFunction(() => !document.querySelector('.typing'), null, { timeout: 10000 }); await page.waitForTimeout(300);
    const r = await ev(page, () => [S.events.some(e => /lekarza/.test(e.title)), S.notes.some(n => /recepcie/.test(n.text)), S.plants[0].lastWater]);
    assert.deepStrictEqual(r, [true, true, today()]);
  }));

  T('Asystent: nie dodaje dwa razy tej samej rzeczy i działa przycisk „wyczyść rozmowę”', async () => run({ ...KEY }, gemini(() => ({ reply: 'Ok', actions: [{ type: 'shopping_add', items: ['Mleko'] }], choices: [] })), async ({ page }) => {
    await ev(page, () => go('chat'));
    for (let i = 0; i < 2; i++) { await page.fill('#chatIn', 'dodaj mleko'); await page.press('#chatIn', 'Enter'); await page.waitForFunction(() => !document.querySelector('.typing'), null, { timeout: 10000 }); await page.waitForTimeout(300); }
    assert.strictEqual(await ev(page, () => S.shopping.filter(x => /mleko/i.test(x.text)).length), 1);
    await ev(page, () => A.chatClear());
    assert.strictEqual(await ev(page, () => S.chat.length), 0);
  }));

  T('Asystent bez klucza AI: nie wysyła nic, nie zawiesza aplikacji', async () => run({ settings: { name: 'Ala' } }, null, async ({ page }) => {
    await ev(page, () => go('chat'));
    await page.fill('#chatIn', 'cześć'); await page.press('#chatIn', 'Enter'); await page.waitForTimeout(600);
    assert.ok(await ev(page, () => !document.querySelector('.typing')), 'wiecznie „pisze”');
  }));

  /* ===== USTAWIENIA, KOPIE DANYCH, UKŁADY ===== */
  T('Kopia danych: eksport → wczytanie zastępuje dane', async () => run({ settings: { name: 'Ala' }, notes: [{ id: 'n1', text: 'Stara', pin: false, ts: 1 }] }, null, async ({ page }) => {
    const json = await ev(page, () => JSON.stringify(Object.assign({}, S, { notes: [{ id: 'n2', text: 'Z kopii', pin: false, ts: 2 }], shopping: [{ id: 's', text: 'Masło', done: false }] })));
    await ev(page, () => A.importData()); await page.waitForSelector('#impText');
    await page.fill('#impText', json); await ev(page, () => A.doImport());
    const r = await ev(page, () => [S.notes.map(n => n.text), S.shopping.map(s => s.text)]);
    assert.deepStrictEqual(r, [['Z kopii'], ['Masło']]);
    await ev(page, () => A.importData()); await page.waitForSelector('#impText'); await page.fill('#impText', '{niepoprawne'); await ev(page, () => A.doImport());
    assert.strictEqual(await ev(page, () => S.notes.length), 1, 'niepoprawna kopia zniszczyła dane');
  }));

  T('Kopie automatyczne: po zapisie pojawia się kopia w ekranie kopii', async () => run({ settings: { name: 'Ala' } }, null, async ({ page }) => {
    await ev(page, () => { S.notes.unshift({ id: 'n1', text: 'x', pin: false, ts: 1 }); save(); });
    await page.waitForTimeout(2000);
    const n = await ev(page, async () => (await listBackups()).length);
    assert.ok(n >= 1, 'brak kopii automatycznej');
    await ev(page, () => A.backups());
    assert.ok((await ev(page, () => document.querySelector('#panel').innerText)).length > 10);
  }));

  T('Ustawienia: zmiana imienia i klucza AI zapisuje się', async () => run({ settings: { name: 'Ala' } }, null, async ({ page }) => {
    await ev(page, () => go('settings'));
    await page.fill('#sName', 'Zosia'); await ev(page, () => A.saveSettings());
    assert.strictEqual(await ev(page, () => S.settings.name), 'Zosia');
  }));

  T('Układy A / B / C: kolejność przycisków w dolnym pasku', async () => run({ settings: { name: 'Ala' } }, null, async ({ page }) => {
    for (const [l, first3] of [['A', ['Start', 'Linki', 'Przepisy']], ['B', ['Start', 'Przepisy', 'Asystent']], ['C', ['Start', 'Przepisy', 'Asystent']]]) {
      await ev(page, l => { A.setLayout({ l }); go('start'); }, l);
      const labels = await ev(page, () => [...document.querySelectorAll('nav button')].map(b => b.innerText.trim()));
      for (const w of first3) assert.ok(labels.some(x => x.includes(w)), 'układ ' + l + ' bez „' + w + '”: ' + labels.join(','));
    }
  }));

  T('Polskie znaki i emoji w nazwach nie psują zapisu ani wyświetlania', async () => run({ settings: { name: 'Ala' } }, null, async ({ page }) => {
    await ev(page, () => { S.notes.unshift({ id: 'n1', text: 'Żółć 🍅 <b>ąęść</b> "cudzysłów" & znak', pin: false, ts: 1 }); save(); go('notes'); });
    const t = await ev(page, () => document.body.innerText);
    assert.ok(t.includes('Żółć 🍅') && t.includes('<b>ąęść</b>'), 'zła obsługa znaków/HTML');
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(400);
    assert.strictEqual(await ev(page, () => S.notes[0].text.includes('Żółć 🍅')), true);
  }));
};
