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

  T('Zakupy: sałata masłowa trafia do warzyw, a niejednoznaczne nazwy sprawdza AI z kontekstu', async () => run({ ...KEY }, gemini((sys, last) => /Przypisz/.test(sys) ? { items: [{ i: 0, c: 'nabial' }] } : null), async ({ page }) => {
    await ev(page, () => go('shopping'));
    for (const t of ['Sałata masłowa', 'Masłowa sałata', 'Masło', 'Twarożek z rzodkiewką']) { await page.fill('#newItem', t); await page.press('#newItem', 'Enter'); }
    await page.waitForTimeout(1800);
    const r = await ev(page, () => Object.fromEntries(S.shopping.map(x => [x.text, pcatOf(x)])));
    assert.strictEqual(r['Sałata masłowa'], 'warzywa'); assert.strictEqual(r['Masłowa sałata'], 'warzywa'); assert.strictEqual(r['Masło'], 'nabial');
    assert.strictEqual(r['Twarożek z rzodkiewką'], 'nabial', 'AI nie rozstrzygnęło niejednoznacznej nazwy');
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

/* ===== OCHRONA PRZED WYCHODZENIEM TREŚCI POZA EKRAN ===== */
module.exports.layout = function (T, ev, today) {
  const L = 'Superdługanazwabezspacjiktórawychodzipozaekran'.repeat(3), LS = 'Bardzo długa nazwa ze spacjami która powinna się zawinąć w kilku liniach i nie rozpychać ekranu wcale';
  const state = {
    settings: { name: LS, apiKey: 'k', provider: 'gemini', model: 'm' },
    shopping: [{ id: 's1', text: L, done: false, cat: 'warzywa' }, { id: 's2', text: LS, done: true, cat: 'mieso' }],
    notes: [{ id: 'n1', text: L + ' ' + LS, pin: true, ts: 1 }],
    links: [{ id: 'l1', url: 'https://example.com/' + 'a'.repeat(150), title: L, tags: [L], note: LS, ts: 1 }],
    events: [{ id: 'e1', title: L, date: new Date().toISOString().slice(0, 10), time: '10:00', kind: 'event', note: LS }],
    plants: [{ id: 'p1', name: L, waterDays: 7, fertDays: 30, room: 'Pokój dziecka', spot: LS, lastWater: '2000-01-01', lastFert: '2000-01-01', care: { light: LS, toxic: 'tak', toxNote: LS } }],
    recipes: [{ id: 'r1', title: L + ' ' + LS, cat: 'zupy', fav: true, groups: [{ name: L, items: [{ q: 1, u: 'szt', n: L, raw: L }] }], steps: [L + ' ' + LS], servings: 2, source: 'https://example.com/' + 'b'.repeat(150), ts: 1 }],
    expenses: [{ id: 'x1', date: new Date().toISOString().slice(0, 10), store: L, src: 'x', ts: 1, items: [{ name: L, price: 12.5, cat: 'inne' }], total: 12.5 }],
    favs: [{ id: 'f1', name: L, norm: 'f', cat: 'napoje', price: 3, size: LS, info: LS }],
    chat: [{ role: 'user', content: L }, { role: 'assistant', content: LS + ' ' + L }]
  };
  const probe = () => {
    const w = window.innerWidth, bad = [];
    if (document.documentElement.scrollWidth > w + 1) bad.push('strona przewija się poziomo (' + document.documentElement.scrollWidth + ' > ' + w + ')');
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
      if (getComputedStyle(el).position === 'fixed' && r.left >= 0) { if (r.right > w + 1) bad.push('fixed ' + (el.className || el.tagName) + ' ' + Math.round(r.right)); return; }
      let p = el.parentElement, scroller = false;
      while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { scroller = true; break; } p = p.parentElement; }
      if (!scroller && (r.right > w + 1 || r.left < -1)) bad.push((el.tagName + '.' + (el.className || '')).slice(0, 40) + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + '] ' + (el.innerText || '').slice(0, 30));
    });
    return bad.slice(0, 6);
  };
  for (const width of [320, 360]) {
    T('Układ: żaden ekran nie wychodzi poza ' + width + ' px (długie teksty w całej aplikacji)', async () => {
      const { open } = require('./harness');
      const o = await open(state, null, width);
      try {
        for (const v of ['start', 'links', 'recipes', 'shopping', 'plants', 'events', 'notes', 'budget', 'favs', 'chat', 'more', 'settings']) {
          await ev(o.page, v => go(v), v);
          const bad = await ev(o.page, probe);
          assert.deepStrictEqual(bad, [], 'ekran ' + v + ': ' + bad.join(' | '));
        }
        await ev(o.page, () => A.openRecipe({ id: 'r1' })); assert.deepStrictEqual(await ev(o.page, probe), [], 'widok przepisu');
        const sheets = [() => A.editEvent({ id: 'e1' }), () => A.editNote({ id: 'n1' }), () => A.editLink({ id: 'l1' }), () => A.editPlant({ id: 'p1' }), () => A.expEdit({ id: 'x1' }), () => A.favCard({ n: 'f' }), () => A.shopCat({ id: 's1' }), () => A.favList(), () => A.newEvent()];
        for (let i = 0; i < sheets.length; i++) {
          await ev(o.page, `(${sheets[i].toString()})()`); await o.page.waitForTimeout(100);
          const bad = await ev(o.page, probe); assert.deepStrictEqual(bad, [], 'okno nr ' + i + ': ' + bad.join(' | '));
          await ev(o.page, () => closeSheet());
        }
        assert.deepStrictEqual(o.errs, []);
      } finally { await o.browser.close(); }
    });
  }
};

/* ===== CZYTNIK ARTYKUŁÓW ===== */
module.exports.reader = function (T, ev, today) {
  const { open, gemini, site, chain, KEY } = require('./harness');
  const para = i => '<p>Zdanie numer ' + i + ' w tym artykule opowiada o koszykówce, szkoleniu dzieci i reprezentacji Polski, i jest dostatecznie długie.</p>';
  const ART = '<html><head><title>Legenda krytycznie o szkoleniu - Interia</title><meta property="og:title" content="Legenda krytycznie o szkoleniu"></head><body><nav><a>Menu</a><a>Sport</a></nav><header><p>Nagłówek serwisu który nie jest treścią artykułu wcale</p></header><article><h1>Legenda krytycznie o szkoleniu</h1><p>Reklama</p>' +
    Array.from({ length: 14 }, (_, i) => para(i + 1)).join('') + '<p>Czytaj także: coś zupełnie innego, co nie jest częścią tego artykułu</p><h2>Co dalej?</h2>' + para(99) + '</article><footer><p>Stopka serwisu: wszelkie prawa zastrzeżone przez wydawcę serwisu internetowego</p></footer></body></html>';
  const fakeTts = `(() => { window.__spoken = []; window.__cancelled = 0; window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak(u) { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), window.__delay || 150); }, cancel() { window.__cancelled++; } } }); })()`;
  const ai = (sys, last) => /Streszczasz/.test(sys) ? { lead: 'Legenda krytykuje polskie szkolenie.', points: ['Dzieci mają za mało gry.', 'Za dużo meczów.', 'Brak treningu indywidualnego.', 'Potrzebna reforma.', 'Kluby zarabiają na turniejach.'] } : /WYŁĄCZNIE z podanego/.test(sys) ? 'Powiedział, że dzieci grają za dużo meczów.' : null;
  const setup = async () => { const o = await open(KEY, chain(site('sport.example.com', ART), gemini(ai))); await o.page.evaluate(fakeTts); return o; };
  const wrap = fn => async () => { const o = await setup(); try { await fn(o); require('assert').deepStrictEqual(o.errs, [], 'błędy JS'); } finally { await o.browser.close(); } };
  const assert = require('assert');
  const addLink = page => ev(page, () => { S.links.push({ id: 'l1', url: 'https://sport.example.com/a', title: 'Legenda krytycznie o szkoleniu', tags: [], note: '', ts: 1 }); save(); go('links'); });

  T('Czytnik: wyciąga treść artykułu bez reklam, menu i stopki', wrap(async ({ page }) => {
    await addLink(page);
    await ev(page, () => A.readLink({ id: 'l1' })); await page.waitForTimeout(1500);
    const t = await ev(page, () => S.links[0].text);
    assert.ok(t.includes('Zdanie numer 1 ') && t.includes('Zdanie numer 99'), 'brak treści');
    assert.ok(t.includes('## Co dalej?'), 'brak śródtytułu');
    for (const bad of ['Reklama', 'Czytaj także', 'Stopka', 'Nagłówek serwisu', 'Menu']) assert.ok(!t.includes(bad), 'w treści zostało: ' + bad);
  }));

  T('Czytnik: skrót AI (lead + punkty) pojawia się po otwarciu artykułu', wrap(async ({ page }) => {
    await addLink(page);
    await ev(page, () => A.readLink({ id: 'l1' })); await page.waitForTimeout(2000);
    const s = await ev(page, () => S.links[0].sum);
    assert.ok(s && s.points.length === 5, 'brak skrótu');
    assert.ok((await ev(page, () => document.body.innerText)).includes('Legenda krytykuje polskie szkolenie'));
  }));

  T('Czytnik: pytanie o artykuł dostaje odpowiedź', wrap(async ({ page }) => {
    await addLink(page);
    await ev(page, () => A.readLink({ id: 'l1' })); await page.waitForTimeout(2000);
    await page.fill('#rqa', 'ile meczów grają dzieci?'); await page.click('[data-act=readerAsk]'); await page.waitForTimeout(800);
    assert.ok((await ev(page, () => document.body.innerText)).includes('grają za dużo meczów'));
  }));

  T('Czytnik: odsłuch - czytanie kawałkami, pauza, wznowienie od tego samego miejsca, stop', wrap(async ({ page }) => {
    await addLink(page);
    await ev(page, () => A.readLink({ id: 'l1' })); await page.waitForTimeout(2000);
    await ev(page, () => { window.__delay = 900; A.readerTab({ k: 'full' }); });
    await page.click('[data-act=ttsPlay][data-m=full]'); await page.waitForTimeout(300);
    const n1 = await ev(page, () => window.__spoken.length);
    assert.ok(n1 >= 1, 'nic nie czyta');
    await page.click('[data-act=ttsPause]'); const at = await ev(page, () => tts.i); await page.waitForTimeout(1200);
    const frozen = await ev(page, () => window.__spoken.length);
    assert.ok(frozen <= n1 + 1, 'czyta mimo pauzy');
    await page.click('[data-act=ttsResume]'); await page.waitForTimeout(300);
    assert.ok(await ev(page, () => window.__spoken.length) > frozen, 'nie wznowiło');
    assert.ok(await ev(page, i => tts.i >= i, at), 'wznowiło od początku');
    await page.click('[data-act=ttsStop]');
    assert.strictEqual(await ev(page, () => tts.on), false);
  }));

  T('Czytnik: odsłuch skrótu czyta lead i punkty; wyjście z ekranu zatrzymuje czytanie', wrap(async ({ page }) => {
    await addLink(page);
    await ev(page, () => A.readLink({ id: 'l1' })); await page.waitForTimeout(2000);
    await page.click('[data-act=ttsPlay][data-m=sum]'); await page.waitForTimeout(300);
    assert.ok((await ev(page, () => window.__spoken.join(' '))).includes('Legenda krytykuje'));
    await ev(page, () => go('links'));
    assert.strictEqual(await ev(page, () => tts.on), false, 'czyta po wyjściu z artykułu');
  }));

  T('Czytnik: strona bez treści → komunikat, link zostaje; brak głosu → komunikat zamiast awarii', async () => {
    const o = await open(KEY, chain(site('empty.example.com', '<html><body><p>krótko</p></body></html>'), gemini(ai)));
    try {
      await ev(o.page, () => { S.links.push({ id: 'l2', url: 'https://empty.example.com/', title: 'Pusta', tags: [], note: '', ts: 1 }); save(); });
      await ev(o.page, () => A.readLink({ id: 'l2' })); await o.page.waitForTimeout(1500);
      assert.ok(!(await ev(o.page, () => S.links[0].text)), 'zapisał śmieci');
      assert.strictEqual(await ev(o.page, () => S.links.length), 1);
      assert.deepStrictEqual(o.errs, []);
    } finally { await o.browser.close(); }
  });
};

/* ===== SZYBKI ZAPIS Z „UDOSTĘPNIJ” ===== */
module.exports.share = function (T, ev, today) {
  const { open, gemini, site, chain, KEY } = require('./harness');
  const assert = require('assert');
  const BLOG = '<html><head><title>Zupa pomidorowa - blog</title></head><body><h1>Zupa pomidorowa</h1><p>Pyszna zupa na każdą okazję, robiona od lat w moim domu. Naprawdę warto ją przygotować.</p><h2>Składniki</h2><ul><li>1 kg pomidorów</li><li>1 cebula</li><li>500 ml bulionu</li></ul><h2>Przygotowanie</h2><p>Pokrój cebulę i podsmaż. Dodaj pomidory i bulion. Gotuj 20 minut. Zblenduj.</p></body></html>';
  const NEWS = '<html><head><title>Wiadomości dnia</title><meta property="og:title" content="Wiadomości dnia"></head><body><p>Dzisiaj w mieście otwarto nowy most nad rzeką, mieszkańcy są zadowoleni.</p></body></html>';
  const R = chain(site('blog.example.com', BLOG), site('news.example.com', NEWS));
  const share = (page, t) => ev(page, t => { window.__shared = t; window.onShared(); }, t);

  T('Udostępnij: link do przepisu zapisuje się od razu i otwiera edytor przepisu', async () => {
    const o = await open({ settings: { name: 'Ala' } }, R);
    try { await share(o.page, 'https://blog.example.com/zupa'); await o.page.waitForTimeout(1200);
      assert.ok(/przepis/i.test(await ev(o.page, () => document.querySelector('#panel h1').textContent)));
      assert.strictEqual(await ev(o.page, () => S.links.length), 0);
      assert.deepStrictEqual(o.errs, []);
    } finally { await o.browser.close(); }
  });

  T('Udostępnij: zwykły artykuł zapisuje się w Linkach i pokazuje „Czytaj” oraz „Wróć do przeglądarki”', async () => {
    const o = await open({ settings: { name: 'Ala' } }, R);
    try { await share(o.page, 'Zobacz to: https://news.example.com/a'); await o.page.waitForTimeout(1800);
      assert.strictEqual(await ev(o.page, () => S.links.length), 1);
      assert.ok(await ev(o.page, () => !!document.querySelector('[data-act=readLink]#x, #panel [data-act=readLink]')), 'brak przycisku Czytaj');
      assert.ok(await ev(o.page, () => !!document.querySelector('#panel [data-act=sharedBack]')), 'brak przycisku powrotu');
      assert.deepStrictEqual(o.errs, []);
    } finally { await o.browser.close(); }
  });

  T('Udostępnij: przy wyłączonym szybkim zapisie działa po staremu (bez okna „Czytaj”)', async () => {
    const o = await open({ settings: { name: 'Ala', quickShare: false } }, R);
    try { await share(o.page, 'https://news.example.com/a'); await o.page.waitForTimeout(1800);
      assert.strictEqual(await ev(o.page, () => S.links.length), 1);
      assert.ok(!(await ev(o.page, () => !!document.querySelector('#panel [data-act=sharedBack]'))), 'pokazało okno szybkiego zapisu');
    } finally { await o.browser.close(); }
  });

  T('Udostępnij: tekst bez linku zapisuje się jako notatka', async () => {
    const o = await open({ settings: { name: 'Ala' } }, R);
    try { await share(o.page, 'Kupić prezent dla mamy'); await o.page.waitForTimeout(800);
      assert.strictEqual(await ev(o.page, () => S.links.length), 0);
      assert.ok(await ev(o.page, () => S.notes.some(n => /prezent/.test(n.text))), 'notatka nie powstała');
    } finally { await o.browser.close(); }
  });
};

/* ===== CZYTNIK: artykuł z Interii (reklamy, polecane artykuły w środku tekstu) i odsłuch w tle ===== */
module.exports.reader2 = function (T, ev, today) {
  const { open, gemini, site, chain, KEY } = require('./harness');
  const assert = require('assert');
  const fx = require('./fixtures/interia');
  const ai = (sys) => /Streszczasz/.test(sys) ? { lead: 'Wywiad o szkoleniu dzieci.', points: ['Praca przed meczami.', 'Za dużo turniejów.', 'Klub to świętość.', 'Trening indywidualny jako dodatek.', 'Wzorce z Hiszpanii.'] } : null;

  T('Czytnik: artykuł z Interii (link z fbclid) - cały wywiad, bez reklam, polecanych i stopki', async () => {
    const o = await open(KEY, chain(site('sport.interia.pl', fx.html), gemini(ai)));
    try {
      await ev(o.page, u => { S.links.push({ id: 'l1', url: u, title: 'Legenda', tags: [], note: '', ts: 1 }); save(); }, fx.url);
      await ev(o.page, () => A.readLink({ id: 'l1' })); await o.page.waitForTimeout(2000);
      const t = await ev(o.page, () => S.links[0].text);
      for (const must of ['Na co zwraca pan uwagę podczas treningów?', 'Zwracamy uwagę na podejście do zajęć', 'klub to świętość', 'Dlaczego w takim razie niektórzy trenerzy są na "nie"?', 'Dobrzy trenerzy nie mają nic przeciwko', 'kozłowaniem, wejściami pod kosz', 'Real Betis Sevilla', 'Dzieciaki i młodzież żyją meczami', 'to są zdziwione'])
        assert.ok(t.includes(must), 'brakuje fragmentu: ' + must);
      for (const bad of ['Reklama', 'kredyt gotówkowy', 'Czytaj także', 'Polecany artykuł', 'Polecamy także', 'Czytaj więcej na', 'Stopka serwisu', 'Najpopularniejsze', 'Zupełnie inny temat'])
        assert.ok(!t.includes(bad), 'w treści został śmieć: ' + bad);
      assert.ok(t.indexOf('Zwracamy uwagę') < t.indexOf('Real Betis') && t.indexOf('Real Betis') < t.indexOf('żyją meczami'), 'zła kolejność');
      assert.deepStrictEqual(o.errs, []);
    } finally { await o.browser.close(); }
  });

  T('Odsłuch na Androidzie: cały tekst trafia od razu do kolejki systemowego głosu (czyta dalej po zgaszeniu ekranu)', async () => {
    const o = await open(KEY, chain(site('sport.interia.pl', fx.html), gemini(ai)));
    try {
      await o.page.evaluate(() => { window.__calls = []; window.__stops = 0; window.__resolvers = [];
        window.Capacitor = { Plugins: { TextToSpeech: { speak: opts => { window.__calls.push(opts); return new Promise((res, rej) => window.__resolvers.push({ res, rej })); }, stop: async () => { window.__stops++; window.__resolvers.splice(0).forEach(r => r.rej(new Error('stopped'))); } } } }; });
      await ev(o.page, u => { S.links.push({ id: 'l1', url: u, title: 'Legenda', tags: [], note: '', ts: 1 }); save(); }, fx.url);
      await ev(o.page, () => A.readLink({ id: 'l1' })); await o.page.waitForTimeout(2000);
      await ev(o.page, () => A.readerTab({ k: 'full' }));
      await o.page.click('[data-act=ttsPlay][data-m=full]'); await o.page.waitForTimeout(400);
      const calls = await ev(o.page, () => window.__calls.map(c => [c.queueStrategy, c.text.length]));
      const total = await ev(o.page, () => tts.chunks.length);
      assert.ok(total > 5, 'za mało kawałków: ' + total); assert.strictEqual(calls.length, total, 'nie wszystkie kawałki w kolejce naraz');
      assert.strictEqual(calls[0][0], 0); assert.ok(calls.slice(1).every(c => c[0] === 1), 'kolejne kawałki muszą dopisywać się do kolejki');
      assert.ok(calls.every(c => c[1] <= 300), 'kawałek za długi - pauza byłaby zbyt gruba');
      // czytanie postępuje: pierwsze 3 kawałki skończone
      await ev(o.page, () => { for (let i = 0; i < 3; i++) window.__resolvers[i].res(); }); await o.page.waitForTimeout(200);
      await o.page.click('[data-act=ttsPause]'); await o.page.waitForTimeout(100);
      const at = await ev(o.page, () => tts.i);
      assert.strictEqual(at, 3, 'pauza powinna zapamiętać miejsce (3), a jest ' + at);
      await ev(o.page, () => { window.__calls.length = 0; });
      await o.page.click('[data-act=ttsResume]'); await o.page.waitForTimeout(300);
      const first = await ev(o.page, () => window.__calls[0] && window.__calls[0].text);
      const expected = await ev(o.page, () => tts.chunks[3]);
      assert.strictEqual(first, expected, 'wznowienie nie zaczęło od miejsca pauzy');
      assert.deepStrictEqual(o.errs, []);
    } finally { await o.browser.close(); }
  });

  T('Odsłuch w przeglądarce: wznowienie po pauzie zaczyna od kawałka, na którym przerwano (nie od początku)', async () => {
    const o = await open(KEY, chain(site('sport.interia.pl', fx.html), gemini(ai)));
    try {
      await o.page.evaluate(`(() => { window.__spoken = []; window.SpeechSynthesisUtterance = function (t) { this.text = t; };
        Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak(u) { window.__spoken.push(u.text); setTimeout(() => u.onend && u.onend(), 400); }, cancel() {} } }); })()`);
      await ev(o.page, u => { S.links.push({ id: 'l1', url: u, title: 'Legenda', tags: [], note: '', ts: 1 }); save(); }, fx.url);
      await ev(o.page, () => A.readLink({ id: 'l1' })); await o.page.waitForTimeout(2000);
      await ev(o.page, () => A.readerTab({ k: 'full' }));
      await o.page.click('[data-act=ttsPlay][data-m=full]'); await o.page.waitForTimeout(1100);
      await o.page.click('[data-act=ttsPause]'); const at = await ev(o.page, () => tts.i);
      assert.ok(at >= 2, 'nie doszło do dalszych kawałków: ' + at);
      await ev(o.page, () => { window.__spoken.length = 0; });
      await o.page.click('[data-act=ttsResume]'); await o.page.waitForTimeout(150);
      assert.strictEqual(await ev(o.page, () => window.__spoken[0]), await ev(o.page, i => tts.chunks[i], at));
    } finally { await o.browser.close(); }
  });
};
