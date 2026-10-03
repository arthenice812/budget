// Доска (мини-приложение) в настоящем браузере: открываем, нажимаем всё подряд, проверяем, что на сервере
// поменялось именно то, что нажали. Нужен Playwright с Chromium; если его нет — тест пропускается.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { fakeTelegram, makeEnv, person, tasksOf } from './helpers.mjs';

const { handleUpdate } = worker._internal;

let chromium = null, sortableJs = '';
try {
  const req = createRequire(execSync('npm root -g').toString().trim() + '/');
  chromium = req('playwright').chromium;
  try { sortableJs = readFileSync(req.resolve('sortablejs/Sortable.min.js'), 'utf8'); } catch {}
} catch {}
const skip = chromium ? false : 'нет Playwright — тест доски в браузере пропущен';

// initData, подписанная так же, как это делает Telegram
function initDataFor(env, user) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'q1', user: JSON.stringify(user) });
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(env.BOT_TOKEN).digest();
  p.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}

// заглушка Telegram.WebApp: только то, чем пользуется доска
const tgStub = initData => `window.Telegram = { WebApp: {
  initData: ${JSON.stringify(initData)}, ready() {}, expand() {},
  BackButton: { show() {}, hide() {}, onClick(f) { window.__back = f; } },
  HapticFeedback: { notificationOccurred() {} },
  showConfirm(text, cb) { window.__confirms = (window.__confirms || 0) + 1; cb(true); },
} };`;

let server, base, browser, env, calls;
const me = person(901, 'Рина', 'rina');
const boss = person(900, 'Анна', 'anna');

before(async () => {
  if (skip) return;
  calls = fakeTelegram();
  env = makeEnv();
  const say = (who, text) => handleUpdate(env, who.text(text), base);
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await worker.fetch(new Request(base + req.url, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : body }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;

  await say(boss, '/start');
  await say(boss, '/newproject Работа');
  const code = (await env.DB.prepare('SELECT code FROM projects').first()).code;
  await say(me, '/start join_' + code);
  for (const t of ['Просроченная задача завтра', 'Сдать отчёт <важный> & «большой» сегодня в 18:00 !!\n- пункт один\n- пункт два',
    'Купить билеты завтра', 'Отчёт в пятницу', 'Подумать о планах', 'Витамины каждый день в 9:00', 'Жду ответа от Пети по договору',
    'Отчёт за квартал 30 ноября', 'Работа: @Анна согласовать бюджет завтра']) await say(me, t);
  await say(boss, 'Работа: @Рина сверить акты сегодня');
  // просрочку словами не поставить — сдвигаем срок в прошлое напрямую
  await env.DB.prepare("UPDATE tasks SET data = json_set(data, '$.due', json('{\"date\":\"2026-09-28\",\"time\":null}')) WHERE json_extract(data, '$.title') = 'Просроченная задача'").run();
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  if (server) server.close();
});

// Открывает доску; собирает ошибки страницы и «мусор» в тексте
async function open(path = '/app', user = { id: me.id, first_name: 'Рина', username: 'rina' }) {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const problems = [];
  page.on('pageerror', e => problems.push('ошибка JS: ' + e.message));
  // считаем запросы к серверу, чтобы дождаться ответа на каждое нажатие
  page.net = { pending: 0, done: 0, seen: 0 };
  page.on('request', r => { if (r.url().endsWith('/api')) page.net.pending++; });
  page.on('requestfinished', r => { if (r.url().endsWith('/api')) { page.net.pending--; page.net.done++; } });
  page.on('requestfailed', r => { if (r.url().endsWith('/api')) { page.net.pending--; problems.push('запрос не прошёл: ' + r.failure().errorText); } });
  page.on('console', m => { if (m.type() === 'error') problems.push('console.error: ' + m.text()); });
  await page.route('https://telegram.org/**', r => r.fulfill({ contentType: 'application/javascript', body: tgStub(user ? initDataFor(env, user) : '') }));
  await page.route('https://cdnjs.cloudflare.com/**', r => r.fulfill({ contentType: 'application/javascript', body: sortableJs }));
  await page.goto(base + path);
  if (user) { await page.waitForSelector('.card'); await page.waitForTimeout(30); page.net.seen = page.net.done; }
  const check = async (where) => {
    const text = await page.evaluate(() => document.body.innerText);
    const junk = text.match(/undefined|NaN|\bnull\b|\[object |Invalid Date|Ошибка сервера|Нет связи/);
    if (junk) problems.push(`${where}: на экране «${junk[0]}»`);
    assert.deepEqual(problems, [], where);
  };
  return { page, check };
}
const task = async title => (await tasksOf(env)).find(t => t.title === title);
// ждём, пока на нажатие ответит сервер и доска перерисуется
async function settle(page) {
  for (let i = 0; i < 300 && (page.net.pending > 0 || page.net.done === page.net.seen); i++) await page.waitForTimeout(10);
  assert.ok(page.net.done > page.net.seen, 'нажатие не отправило запрос на сервер');
  await page.waitForTimeout(30);
  page.net.seen = page.net.done;
}
const cardOf = (page, title) => page.locator('.card', { hasText: title }).first();

test('доска открывается, все колонки и фильтры без ошибок', { skip }, async () => {
  const { page, check } = await open();
  const cols = await page.locator('.col h2').allInnerTexts();
  for (const c of ['Просрочено', 'Сегодня', 'Завтра', 'Неделя', 'Позже', 'Жду ответа', 'Без срока', 'Готово']) {
    assert.ok(cols.some(x => x.includes(c)), `колонка ${c}`);
  }
  await check('доска');
  // карточки стоят в правильных колонках
  const colOf = async title => page.locator('.col', { has: page.locator('.card', { hasText: title }) }).locator('h2').first().innerText();
  assert.match(await colOf('Просроченная'), /Просрочено/);
  assert.match(await colOf('Сдать отчёт'), /Сегодня/);
  assert.match(await colOf('Купить билеты'), /Завтра/);
  assert.match(await colOf('Жду ответа от Пети'), /Жду ответа/);
  assert.match(await colOf('Подумать о планах'), /Без срока/);
  assert.match(await colOf('Отчёт за квартал'), /Позже/);
  // название с <, &, « » показано как есть, без HTML-мусора
  assert.ok(await page.getByText('Сдать отчёт <важный> & «большой»').count());
  for (const chip of await page.locator('.chip').allInnerTexts()) {
    if (chip.includes('Проект') && chip.includes('＋')) continue;
    await page.locator('.chip', { hasText: chip }).first().click();
    await check('фильтр ' + chip);
  }
  // поручено Анне — видно в «Поручено», в «Мои» нет
  await page.locator('.chip', { hasText: 'Поручено' }).click();
  assert.ok(await cardOf(page, 'согласовать бюджет').count());
  await page.locator('.chip', { hasText: 'Мои' }).click();
  assert.equal(await cardOf(page, 'согласовать бюджет').count(), 0);
  await page.close();
});

test('каждая карточка открывается и закрывается', { skip }, async () => {
  const { page, check } = await open();
  await page.locator('.chip', { hasText: 'Все' }).click();
  const n = await page.locator('.card').count();
  assert.ok(n >= 9, `карточек ${n}`);
  for (let i = 0; i < n; i++) {
    await page.locator('.card').nth(i).click();
    await page.waitForSelector('.open #sheet');
    await check('карточка №' + (i + 1));
    await page.locator('#sheet .close').click();
    assert.equal(await page.locator('#sheetWrap.open').count(), 0, 'закрылась');
  }
  await page.close();
});

test('карточка: срок, кнопки сроков, важность, главное, чек-лист, заметка, проект, исполнитель', { skip }, async () => {
  const { page, check } = await open();
  await cardOf(page, 'Купить билеты').click();
  // дата и время полями
  await page.locator('#sheet input[type=date]').first().fill('2026-10-07');
  await page.locator('#sheet input[type=date]').first().dispatchEvent('change');
  await settle(page);
  assert.deepEqual((await task('Купить билеты')).due, { date: '2026-10-07', time: null });
  await page.locator('#sheet input[type=time]').fill('14:30');
  await page.locator('#sheet input[type=time]').dispatchEvent('change');
  await settle(page);
  assert.deepEqual((await task('Купить билеты')).due, { date: '2026-10-07', time: '14:30' });
  // быстрые кнопки сроков
  for (const [btn, date] of [['Сегодня', '2026-09-30'], ['Завтра', '2026-10-01'], ['Без срока', null]]) {
    await page.locator('#sheet button', { hasText: btn }).first().click();
    await settle(page);
    const t = await task('Купить билеты');
    assert.equal(t.due ? t.due.date : null, date, btn);
  }
  // важность и «главное»
  await page.locator('#sheet label', { hasText: 'Важная' }).click();
  await settle(page);
  assert.equal((await task('Купить билеты')).high, true);
  await page.locator('#sheet label', { hasText: 'Главное сегодня' }).click();
  await settle(page);
  const focus = JSON.parse((await env.DB.prepare('SELECT data FROM users WHERE id = ?').bind(me.id).first()).data).focus;
  assert.ok(focus.ids.includes((await task('Купить билеты')).id), 'в главном');
  // чек-лист: добавить пункт Enter'ом и отметить
  const ci = page.locator('#sheet input[placeholder*="чек-листа"]');
  await ci.fill('взять паспорт');
  await ci.press('Enter');
  await settle(page);
  assert.deepEqual((await task('Купить билеты')).checklist.map(c => c.text), ['взять паспорт']);
  await page.locator('#sheet label.check', { hasText: 'взять паспорт' }).click();
  await settle(page);
  assert.equal((await task('Купить билеты')).checklist[0].done, true);
  // заметка
  await page.locator('#sheet textarea[placeholder*="Что обсудили"]').fill('рейс утром');
  await page.locator('#sheet button', { hasText: 'Добавить' }).click();
  await settle(page);
  assert.ok((await task('Купить билеты')).notes.some(n => n.text === 'рейс утром'));
  // название
  await page.locator('#sheet .title-in').fill('Купить билеты в Казань');
  await page.locator('#sheet .title-in').dispatchEvent('change');
  await settle(page);
  assert.ok(await task('Купить билеты в Казань'), 'переименована');
  // проект → исполнитель
  const pid = (await env.DB.prepare('SELECT id FROM projects').first()).id;
  await page.locator('#sheet select').first().selectOption(String(pid));
  await settle(page);
  assert.equal((await task('Купить билеты в Казань')).project, pid);
  await page.locator('#sheet select').nth(1).selectOption(String(boss.id));
  await settle(page);
  assert.equal((await task('Купить билеты в Казань')).assignee, boss.id);
  assert.ok(calls.some(c => c.body.chat_id === boss.id && /поручил\(а\) тебе задачу/.test(c.body.text || '')), 'Анне пришло уведомление');
  await check('после всех правок');
  await page.close();
});

test('повтор: каждый вариант в редакторе и сохранение', { skip }, async () => {
  const { page, check } = await open();
  const report = () => page.locator('.card').filter({ has: page.locator('.t', { hasText: /^Отчёт$/ }) });
  await report().click();
  await page.locator('#sheet button', { hasText: 'Настроить' }).click();
  const box = page.locator('#sheet .rep-box');
  const kind = box.locator('select').first();
  const summary = () => box.locator('.rep-sum').innerText();
  // перебираем все виды и все варианты внутри — в «Что получилось» не должно быть мусора
  for (const k of ['day', 'week', 'month', 'year']) {
    await kind.selectOption(k);
    const opts = box.locator('input[type=radio], button.wd');
    for (let i = 0; i < await opts.count(); i++) {
      await opts.nth(i).click();
      await check(`повтор ${k}, вариант ${i + 1}: ${await summary()}`);
    }
  }
  const save = async () => { await box.locator('button', { hasText: 'Сохранить' }).click(); await settle(page); };
  const reopen = async () => { await page.locator('#sheet button', { hasText: /Настроить|Изменить/ }).click(); };
  const rep = async () => (await task('Отчёт')).repeat;

  // каждые 2 недели по четвергам до конца года (срок — пятница: включаем Чт, выключаем Пт)
  await box.locator('button', { hasText: 'Отмена' }).click();
  await reopen();
  await kind.selectOption('week');
  await box.locator('input.num').fill('2');
  await box.locator('button.wd', { hasText: 'Чт' }).click();
  await box.locator('button.wd', { hasText: 'Пт' }).click();
  await box.locator('label.opt', { hasText: 'До' }).click();
  await box.locator('input[type=date]').fill('2026-12-31');
  await box.locator('input[type=date]').dispatchEvent('change');
  assert.match(await summary(), /2.*нед[\s\S]*чт[\s\S]*31\.12\.2026/i);
  await save();
  assert.deepEqual(await rep(), { unit: 'week', n: 2, wd: [4], until: '2026-12-31' });
  assert.match(await page.locator('#sheet .rep-line').innerText(), /🔁/);

  // в последний день месяца, затем первый рабочий день
  await reopen();
  await kind.selectOption('month');
  assert.equal(await box.locator('input.num').inputValue(), '2', 'число «раз в N» сохраняется при смене вида, как в календаре');
  await box.locator('input.num').fill('1');
  await box.locator('label.opt', { hasText: 'Всегда' }).click();
  await box.locator('label.opt', { hasText: 'последний день месяца' }).click();
  await save();
  assert.deepEqual(await rep(), { unit: 'month', n: 1, md: 31, last: true });
  await reopen();
  await box.locator('label.opt', { hasText: 'первый рабочий день' }).click();
  await save();
  assert.deepEqual(await rep(), { unit: 'month', n: 1, wday: 1 });

  // каждый рабочий день
  await reopen();
  await kind.selectOption('day');
  await box.locator('label.opt', { hasText: 'рабочий день' }).click();
  await save();
  assert.deepEqual(await rep(), { unit: 'week', n: 1, wd: [1, 2, 3, 4, 5] });

  // выключить повтор
  await reopen();
  await kind.selectOption('none');
  await save();
  assert.ok(!(await rep()), 'повтор выключен');
  await check('после всех сохранений');
  await page.close();
});

test('новая задача и новый проект с доски', { skip }, async () => {
  const { page, check } = await open();
  await page.locator('#fab').click();
  await page.locator('#sheet textarea').fill('Позвонить в банк завтра в 11:00');
  await page.locator('#sheet button', { hasText: 'Создать' }).click();
  await settle(page);
  assert.deepEqual((await task('Позвонить в банк')).due, { date: '2026-10-01', time: '11:00' });
  assert.ok(await cardOf(page, 'Позвонить в банк').count(), 'появилась на доске');
  await page.locator('.chip', { hasText: '＋ Проект' }).click();
  await page.locator('#sheet input').fill('Дом');
  await page.locator('#sheet button', { hasText: 'Создать' }).click();
  await settle(page);
  assert.ok(await env.DB.prepare('SELECT id FROM projects WHERE name = ?').bind('Дом').first(), 'проект создан');
  assert.ok(await page.locator('.chip.on', { hasText: 'Дом' }).count(), 'фильтр переключился на проект');
  await check('после создания');
  await page.close();
});

test('готово, вернуть, удалить', { skip }, async () => {
  const { page, check } = await open();
  await cardOf(page, 'Подумать о планах').click();
  await page.locator('#sheet button', { hasText: '✅ Готово' }).click();
  await settle(page);
  assert.equal((await task('Подумать о планах')).done, true);
  const done = page.locator('.col', { hasText: 'Готово' }).locator('.card', { hasText: 'Подумать о планах' });
  assert.ok(await done.count(), 'в колонке «Готово»');
  await done.click();
  await page.locator('#sheet button', { hasText: 'Вернуть' }).click();
  await settle(page);
  assert.equal((await task('Подумать о планах')).done, false);
  await page.locator('#sheet button', { hasText: 'Удалить' }).click();
  await settle(page);
  assert.equal(await task('Подумать о планах'), undefined, 'удалена');
  assert.equal(await cardOf(page, 'Подумать о планах').count(), 0);
  // чужую задачу удалить нельзя — кнопки нет
  await page.locator('.chip', { hasText: 'Мои' }).click();
  await cardOf(page, 'Сверить акты').click();
  assert.equal(await page.locator('#sheet button', { hasText: 'Удалить' }).count(), 0);
  await check('после удаления');
  await page.close();
});

test('перетаскивание между колонками', { skip: skip || (!sortableJs && 'нет SortableJS') }, async () => {
  const { page, check } = await open();
  const drag = async (title, col) => {
    const from = cardOf(page, title);
    const to = page.locator(`.list[data-col="${col}"]`);
    const a = await from.boundingBox(), b = await to.boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + a.width / 2 + 5, a.y + a.height / 2 + 5, { steps: 3 });
    await to.scrollIntoViewIfNeeded();
    const b2 = await to.boundingBox();
    await page.mouse.move(b2.x + b2.width / 2, b2.y + 10, { steps: 20 });
    await page.waitForTimeout(100);
    await page.mouse.move(b2.x + b2.width / 2, b2.y + 12, { steps: 2 });
    await page.waitForTimeout(100);
    await page.mouse.up();
    await settle(page);
  };
  await page.setViewportSize({ width: 2400, height: 900 }); // все колонки на экране
  await drag('Отчёт за квартал', 'tomorrow');
  assert.equal((await task('Отчёт за квартал')).due.date, '2026-10-01');
  await drag('Отчёт за квартал', 'done');
  assert.equal((await task('Отчёт за квартал')).done, true);
  await check('после перетаскивания');
  await page.close();
});

test('открытие задачи по ссылке из чата (?t=…&r=1) — сразу редактор повтора', { skip }, async () => {
  const t = await task('Витамины');
  const { page, check } = await open(`/app?t=${t.id}&r=1`);
  await page.waitForSelector('.open #sheet');
  assert.equal(await page.locator('#sheet .title-in').inputValue(), 'Витамины');
  assert.ok(await page.locator('#sheet .rep-box').count(), 'редактор повтора открыт');
  await check('по ссылке');
  await page.close();
});

test('без Telegram — понятная подсказка, а не пустой экран', { skip }, async () => {
  const { page, check } = await open('/app', null);
  await page.waitForSelector('.center');
  assert.match(await page.locator('.center').innerText(), /Открой доску из бота/);
  await check('без initData');
  await page.close();
});
