// Личные настройки: всё кнопками, у каждого своё
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { fakeTelegram, makeEnv, person, tasksOf } from './helpers.mjs';

const { handleUpdate, runCron } = worker._internal;
const kb = c => JSON.stringify(c.body.reply_markup || {});
const lastEdit = (calls, id) => [...calls].reverse().find(c => c.method === 'editMessageText' && c.body.message_id === id);

test('меню настроек: кнопками из «Помощи», подменю с ✓, переключатели, «← Все настройки»', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(1700, 'Рина');
  await handleUpdate(env, me.text('/start'));
  const help = calls.find(c => /Я — твой список задач/.test(c.body.text || ''));
  assert.match(kb(help), /⚙️ Мои настройки[^}]*O:menu/);
  await handleUpdate(env, me.tap('O:menu', 50));
  let v = lastEdit(calls, 50);
  for (const re of [/График: общий/, /Тихие часы: нет/, /Отпуск: нет/, /☀️ План ✅/, /🌙 Сверка ✅/, /📊 Итоги ✅/,
    /«На сегодня»: два раза/, /До срока: 1 час/, /Не отстану: каждые полчаса/,
    /Встречи: за час, за 15 мин и в начале/, /Номер: в конце/, /Регулярные: отдельно/]) assert.match(kb(v), re);
  assert.match(v.body.text, /Когда я тебе пишу[\s\S]*Что присылать[\s\S]*Напоминания[\s\S]*Как выглядит список/, 'инструкция по группам');
  // переключатель
  await handleUpdate(env, me.tap('O:m', 50));
  v = lastEdit(calls, 50);
  assert.match(kb(v), /☀️ План 🚫/);
  assert.ok(calls.some(c => c.method === 'answerCallbackQuery' && /План дня: 🚫 не присылаю/.test(c.body.text || '')));
  // подменю с отметкой текущего
  await handleUpdate(env, me.tap('O:l', 50));
  v = lastEdit(calls, 50);
  assert.match(kb(v), /✓ за 1 час/);
  assert.match(kb(v), /O:l:30/);
  assert.match(kb(v), /← Все настройки/);
  await handleUpdate(env, me.tap('O:l:30', 50));
  assert.match(kb(lastEdit(calls, 50)), /До срока: 30 мин/);
  await handleUpdate(env, me.tap('O:c', 50));
  assert.match(lastEdit(calls, 50).body.text, /Календарь пока не подключён/);
  await handleUpdate(env, me.tap('O:c:0', 50));
  assert.match(kb(lastEdit(calls, 50)), /Встречи: только в начале/);
  await handleUpdate(env, me.tap('O:g:60', 50));
  await handleUpdate(env, me.tap('O:d:1', 50));
  await handleUpdate(env, me.tap('O:r', 50));
  assert.match(kb(lastEdit(calls, 50)), /✓ Отдельным блоком/);
  await handleUpdate(env, me.tap('O:r:1', 50));
  v = lastEdit(calls, 50);
  assert.match(kb(v), /Не отстану: каждый час/);
  assert.match(kb(v), /«На сегодня»: один раз/);
  assert.match(kb(v), /Регулярные: вместе/);
  await handleUpdate(env, me.text('Витамины каждый день в 9:00'));
  await handleUpdate(env, me.text('Отчёт завтра'));
  const dash = [...calls].reverse().find(c => /📌 <b>Мои задачи<\/b>/.test(c.body.text || '')).body.text;
  assert.doesNotMatch(dash, /━━/, 'по настройке — регулярные вместе с разовыми');
  assert.match(dash, /🔜 Завтра[\s\S]*Витамины[\s\S]*Отчёт|🔜 Завтра[\s\S]*Отчёт[\s\S]*Витамины/);
  // вернуть по умолчанию — настройки не копятся мусором
  for (const d of ['O:m', 'O:r:0', 'O:l:60', 'O:c:60,15,0', 'O:g:30', 'O:d:2']) await handleUpdate(env, me.tap(d, 50));
  const row = await env.DB.prepare('SELECT data FROM users WHERE id = ?').bind(me.id).first();
  assert.ok(!JSON.parse(row.data).prefs, 'всё по умолчанию — prefs пустые');
  // чужое значение не принимаем
  calls.length = 0;
  await handleUpdate(env, me.tap('O:l:5000', 50));
  assert.ok(calls.some(c => c.method === 'answerCallbackQuery' && /Такой настройки нет/.test(c.body.text || '')));
  // справка показывает, что выключено
  await handleUpdate(env, me.tap('O:w', 50));
  calls.length = 0;
  await handleUpdate(env, me.tap('h:day', 51));
  assert.match(calls.find(c => /План дня и напоминания/.test(c.body.text || '')).body.text, /Итоги недели \(выключены в \/settings\)/);
});

test('настройки действуют: план/сверка/итоги выкл, «до срока» за 30 мин, «на сегодня» один раз, встречи только в начале, «не отстану» раз в час', async () => {
  const calls = fakeTelegram();
  let now = new Date('2026-09-30T18:00:00Z'); // накануне: в день первого запуска сводок нет
  const env = makeEnv({ _clock: () => now });
  const rina = person(1710, 'Рина'), anna = person(1711, 'Анна');
  for (const p of [rina, anna]) { await handleUpdate(env, p.text('/start')); await handleUpdate(env, p.tap('S:later', 1)); }
  for (const d of ['O:m', 'O:e', 'O:w', 'O:l:30', 'O:d:1', 'O:c:0', 'O:g:60']) await handleUpdate(env, rina.tap(d, 2));
  now = new Date('2026-10-01T03:00:00Z'); // чт 06:00 МСК
  for (const p of [rina, anna]) {
    await handleUpdate(env, p.text('Позвонить в банк сегодня в 15:00'));
    await handleUpdate(env, p.text('Сверка сегодня'));
    const t = (await tasksOf(env)).filter(x => x.assignee === p.id).pop();
    await handleUpdate(env, p.tap(`a:${t.id}:nag`, 3));
  }
  // встреча в календаре у обеих в 16:00
  const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:p-1', 'SUMMARY:Планёрка',
    'DTSTART;TZID=Europe/Moscow:20261001T160000', 'DTEND;TZID=Europe/Moscow:20261001T163000', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  const url = 'https://calendar.yandex.ru/export/ics.xml?private_token=s1';
  globalThis.__ics = { [url]: ICS };
  for (const p of [rina, anna]) await handleUpdate(env, p.text(url));
  const log = { rina: [], anna: [] };
  for (let ms = now.getTime(); ms <= Date.parse('2026-10-04T20:00:00Z'); ms += 5 * 60e3) {
    now = new Date(ms);
    calls.length = 0;
    await runCron(env, now);
    const msk = new Date(ms + 3 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
    for (const c of calls.filter(c => c.method === 'sendMessage')) {
      const who = c.body.chat_id === rina.id ? 'rina' : c.body.chat_id === anna.id ? 'anna' : null;
      const t = c.body.text || '';
      const kind = /Доброе утро/.test(t) ? 'утро' : /Вечерняя сверка/.test(t) ? 'вечер' : /Итоги недели/.test(t) ? 'неделя'
        : /До срока 30 мин/.test(t) ? 'за 30' : /До срока 1 час/.test(t) ? 'за час' : /Сегодня срок/.test(t) ? 'сегодня'
        : /Не отстану/.test(t) ? 'не отстану' : /^🔔 <b>.*Планёрка/.test(t) ? (/Начинается сейчас/.test(t) ? 'встреча сейчас' : 'встреча заранее') : null;
      if (who && kind) log[who].push(`${msk} ${kind}`);
    }
  }
  const of = (who, kind, day = '10-01') => log[who].filter(x => x.startsWith(day) && x.endsWith(' ' + kind)).map(x => x.slice(6, 11));
  // Анна — всё по умолчанию
  assert.deepEqual(of('anna', 'утро'), ['09:00']);
  assert.deepEqual(of('anna', 'вечер'), ['20:00']);
  assert.deepEqual(of('anna', 'неделя', '10-04'), ['19:00']);
  assert.deepEqual(of('anna', 'за час'), ['14:00']);
  assert.deepEqual(of('anna', 'сегодня'), ['12:00', '17:00']);
  assert.deepEqual(of('anna', 'встреча заранее'), ['15:00', '15:45']);
  assert.deepEqual(of('anna', 'встреча сейчас'), ['16:00']);
  // Рина — по своим настройкам
  assert.deepEqual(of('rina', 'утро'), []);
  assert.deepEqual(of('rina', 'вечер'), []);
  assert.deepEqual(of('rina', 'неделя', '10-04'), []);
  assert.deepEqual(of('rina', 'за час'), []);
  assert.deepEqual(of('rina', 'за 30'), ['14:30']);
  assert.deepEqual(of('rina', 'сегодня'), ['12:00']);
  assert.deepEqual(of('rina', 'встреча заранее'), []);
  assert.deepEqual(of('rina', 'встреча сейчас'), ['16:00']);
  const gaps = list => list.slice(1).map((t, i) => (+t.slice(0, 2) * 60 + +t.slice(3)) - (+list[i].slice(0, 2) * 60 + +list[i].slice(3)));
  const rn = of('rina', 'не отстану'), an = of('anna', 'не отстану');
  assert.ok(rn.length >= 2 && gaps(rn).every(g => g >= 60), `Рина — не чаще раза в час: ${rn}`);
  assert.ok(an.length >= 2 && gaps(an).some(g => g < 60), `Анна — каждые полчаса: ${an}`);
  globalThis.__ics = {};
});

test('«✏️ Своё»: за 10 минут до срока, встречи «30, 5», «не отстану» раз в 45 мин; непонятное — переспрашивает', async () => {
  const calls = fakeTelegram();
  let now = new Date('2026-09-30T18:00:00Z');
  const env = makeEnv({ _clock: () => now });
  const me = person(1720, 'Рина');
  await handleUpdate(env, me.text('/start'));
  await handleUpdate(env, me.tap('S:later', 1));
  await handleUpdate(env, me.tap('O:l', 60));
  assert.match(kb(lastEdit(calls, 60)), /✏️ Своё…[^}]*O:l:x/);
  calls.length = 0;
  await handleUpdate(env, me.tap('O:l:x', 60));
  assert.ok(calls.some(c => /За сколько напоминать до срока/.test(c.body.text || '')));
  calls.length = 0;
  await handleUpdate(env, me.text('ну где-то так'));
  assert.ok(calls.some(c => /Не понял/.test(c.body.text || '')));
  await handleUpdate(env, me.text('10 минут'));
  assert.ok(calls.some(c => /Сохранено/.test(c.body.text || '') && /До срока: 10 мин/.test(kb(c))));
  await handleUpdate(env, me.tap('O:l', 61));
  assert.match(kb(lastEdit(calls, 61)), /✓ ✏️ Своё: за 10 мин/);
  await handleUpdate(env, me.tap('O:c:x', 61));
  await handleUpdate(env, me.text('30, 5'));
  await handleUpdate(env, me.tap('O:g:x', 61));
  await handleUpdate(env, me.text('45 мин'));
  await handleUpdate(env, me.tap('O:menu', 62));
  const v = kb(lastEdit(calls, 62));
  assert.match(v, /Встречи: за 30 мин, за 5 мин и в начале/);
  assert.match(v, /Не отстану: каждые 45 мин/);
  assert.equal((await tasksOf(env)).length, 0, 'ответы на настройки не стали задачами');

  // действует: «До срока 10 мин» в 14:50, встреча — в 15:30, 15:55, 16:00
  now = new Date('2026-10-01T03:00:00Z');
  await handleUpdate(env, me.text('Позвонить в банк сегодня в 15:00'));
  const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:p-2', 'SUMMARY:Планёрка',
    'DTSTART;TZID=Europe/Moscow:20261001T160000', 'DTEND;TZID=Europe/Moscow:20261001T163000', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  const url = 'https://calendar.yandex.ru/export/ics.xml?private_token=s2';
  globalThis.__ics = { [url]: ICS };
  await handleUpdate(env, me.text(url));
  const got = [];
  for (let ms = now.getTime(); ms <= Date.parse('2026-10-01T14:00:00Z'); ms += 5 * 60e3) {
    now = new Date(ms); calls.length = 0;
    await runCron(env, now);
    const msk = new Date(ms + 3 * 3600e3).toISOString().slice(11, 16);
    for (const c of calls.filter(c => c.method === 'sendMessage')) {
      if (/До срока 10 мин/.test(c.body.text)) got.push(`${msk} за 10`);
      if (/^🔔 <b>.*Планёрка/.test(c.body.text)) got.push(`${msk} встреча`);
    }
  }
  assert.deepEqual(got, ['14:50 за 10', '15:30 встреча', '15:55 встреча', '16:00 встреча']);
  globalThis.__ics = {};
});

test('тихие часы 13–14: ничего не приходит, всё — сразу после; отпуск: тишина, коллеге — пометка, потом «С возвращением»', async () => {
  const calls = fakeTelegram();
  let now = new Date('2026-09-30T18:00:00Z');
  const env = makeEnv({ _clock: () => now });
  const rina = person(1730, 'Рина'), anna = person(1731, 'Анна');
  for (const p of [rina, anna]) { await handleUpdate(env, p.text('/start')); await handleUpdate(env, p.tap('S:later', 1)); }
  await handleUpdate(env, rina.text('/newproject Отдел'));
  const { code } = await env.DB.prepare('SELECT code FROM projects').first();
  await handleUpdate(env, anna.text('/start join_' + code));
  // Рина — тихие часы своим временем; Анна — отпуск кнопкой и датой
  await handleUpdate(env, rina.tap('O:q', 70));
  assert.match(kb(lastEdit(calls, 70)), /O:q:1300-1400/);
  await handleUpdate(env, rina.tap('O:q:x', 70));
  await handleUpdate(env, rina.text('13-14'));
  assert.ok(calls.some(c => /Тихие часы: 13:00–14:00/.test(kb(c))));
  now = new Date('2026-10-01T03:00:00Z'); // чт 06:00
  await handleUpdate(env, anna.tap('O:v:x', 71));
  await handleUpdate(env, anna.text('до 2.10'));
  assert.ok(calls.some(c => /Сейчас отпуск по пт, 2 окт<\/b> включительно/.test(c.body.text || '')), 'отпуск включён');
  // Рина ставит Анне задачу — видит пометку
  calls.length = 0;
  await handleUpdate(env, rina.text('Отдел: @Анна сверить акты сегодня в 13:30'));
  assert.ok(calls.to(rina.id).some(c => /🏖 Анна в отпуске по пт, 2 окт включительно/.test(c.body.text || '')));
  await handleUpdate(env, rina.text('Перезвонить сегодня в 13:30'));
  await handleUpdate(env, rina.text('Сверка сегодня'));

  const log = { rina: [], anna: [] };
  for (let ms = now.getTime(); ms <= Date.parse('2026-10-03T08:00:00Z'); ms += 5 * 60e3) {
    now = new Date(ms); calls.length = 0;
    await runCron(env, now);
    const msk = new Date(ms + 3 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
    for (const c of calls.filter(c => c.method === 'sendMessage')) {
      const who = c.body.chat_id === rina.id ? 'rina' : c.body.chat_id === anna.id ? 'anna' : null;
      if (who) log[who].push(`${msk} ${(c.body.text || '').split('\n')[0].replace(/<[^>]+>/g, '').slice(0, 30)}`);
    }
  }
  const rina13 = log.rina.filter(x => x.startsWith('10-01 13:') );
  assert.deepEqual(rina13, [], `в тихие часы — ничего: ${rina13}`);
  assert.ok(log.rina.some(x => x.startsWith('10-01 14:00') && /Время пришло/.test(x)), 'срок в 13:30 — сразу после тихих часов');
  assert.ok(log.rina.some(x => x.startsWith('10-01 12:00') && /Сегодня срок/.test(x)));
  assert.deepEqual(log.anna.filter(x => x < '10-03'), [], `в отпуске Анне ничего: ${log.anna}`);
  assert.ok(log.anna.some(x => x.startsWith('10-03 09:00') && /С возвращением/.test(x)), log.anna.join(' | '));
  assert.ok(log.anna.some(x => x.startsWith('10-03 09:00') && /Доброе утро/.test(x)), 'и план дня');
  // в настройках отпуск уже выключен
  calls.length = 0;
  await handleUpdate(env, anna.text('/settings'));
  assert.doesNotMatch(calls.find(c => /Мои настройки/.test(c.body.text || '')).body.text, /Сейчас отпуск/);

  // словами
  await handleUpdate(env, anna.text('я в отпуске до 20.10'));
  assert.ok(calls.some(c => /Хорошего отдыха! Напоминания на паузе по вт, 20 окт включительно/.test(c.body.text || '')));
  await handleUpdate(env, anna.text('вернулась из отпуска'));
  assert.ok(calls.some(c => /С возвращением! Напоминания снова включены/.test(c.body.text || '')));
  assert.equal((await tasksOf(env)).filter(t => t.assignee === anna.id).length, 1, 'фразы про отпуск не стали задачами');
});

test('значки групп и проектов: готовые и свои, видны только себе, «вернуть как было»', async () => {
  const calls = fakeTelegram();
  const now = new Date('2026-09-30T09:00:00Z');
  const env = makeEnv({ _clock: () => now });
  const rina = person(1740, 'Рина'), anna = person(1741, 'Анна');
  for (const p of [rina, anna]) await handleUpdate(env, p.text('/start'));
  await handleUpdate(env, rina.text('/newproject Отдел'));
  await handleUpdate(env, rina.text('/newproject Дом'));
  const ps = (await env.DB.prepare('SELECT id, name, code FROM projects ORDER BY id').all()).results;
  await handleUpdate(env, anna.text('/start join_' + ps[0].code));
  await handleUpdate(env, rina.text('Отдел: сверить акты сегодня в 10:00'));
  await handleUpdate(env, rina.text('Дом: купить лампу завтра'));
  await handleUpdate(env, rina.text('Витамины каждый день в 9:00'));
  await handleUpdate(env, rina.text('Отдел: @Анна отчёт сегодня'));
  const dashOf = who => [...calls].reverse().find(c => c.body.chat_id === who.id && /📌 <b>Мои задачи<\/b>/.test(c.body.text || '')).body.text;
  assert.match(dashOf(rina), /🔴 Просрочено[\s\S]*<i>#Отдел<\/i>/);

  // группы: из готовых и свой эмодзи
  await handleUpdate(env, rina.tap('O:menu', 80));
  assert.match(kb(lastEdit(calls, 80)), /🎨 Значки и названия групп[^}]*O:i"/);
  await handleUpdate(env, rina.tap('O:i', 80));
  assert.match(kb(lastEdit(calls, 80)), /🔴 Просрочено[^}]*O:i:overdue/);
  await handleUpdate(env, rina.tap('O:i:overdue', 80));
  assert.match(kb(lastEdit(calls, 80)), /✓🔴/);
  await handleUpdate(env, rina.tap('O:i:overdue:1', 80)); // 🔥
  await handleUpdate(env, rina.tap('O:i:repeat:x', 80));
  calls.length = 0;
  await handleUpdate(env, rina.text('привет'));
  assert.ok(calls.some(c => /Нужен эмодзи/.test(c.body.text || '')), 'буквы — не значок');
  await handleUpdate(env, rina.text('🦄'));
  assert.ok(calls.some(c => /Теперь «Регулярные» — 🦄/.test(c.body.text || '')));
  // проекты: раскрасить все и свой
  await handleUpdate(env, rina.tap('O:j', 81));
  assert.match(kb(lastEdit(calls, 81)), /# Отдел[\s\S]*# Дом[\s\S]*O:j:auto/);
  await handleUpdate(env, rina.tap('O:j:auto', 81));
  assert.match(kb(lastEdit(calls, 81)), /🟥 Отдел[\s\S]*🟧 Дом/);
  await handleUpdate(env, rina.tap(`O:j:${ps[1].id}:x`, 81));
  await handleUpdate(env, rina.text('🏡'));
  const d = dashOf(rina);
  assert.match(d, /🔥 Просрочено[\s\S]*Сверить акты 🟥<i>Отдел<\/i>/);
  assert.match(d, /Купить лампу 🏡<i>Дом<\/i>/);
  assert.match(d, /━━ 🦄 Регулярные — 1 ━━/);
  assert.match(d, /Отчёт 🟥<i>Отдел<\/i>[^\n]*→ Анна/, 'поручено другим — тоже со значком');
  assert.equal((await tasksOf(env)).length, 4, 'эмодзи не стали задачами');
  // своё название группы
  await handleUpdate(env, rina.tap('O:i:overdue', 83));
  assert.match(kb(lastEdit(calls, 83)), /✏️ Своё название…[^}]*O:i:overdue:n/);
  await handleUpdate(env, rina.tap('O:i:overdue:n', 83));
  calls.length = 0;
  await handleUpdate(env, rina.text('очень длинное название которое никак не влезает в строку'));
  assert.ok(calls.some(c => /не длиннее 30 символов/.test(c.body.text || '')));
  await handleUpdate(env, rina.text('ПРОЕБАНО <b>'));
  assert.ok(calls.some(c => /Теперь группа называется «ПРОЕБАНО &lt;b&gt;»/.test(c.body.text || '')));
  await handleUpdate(env, rina.tap('O:i:once:n', 83));
  await handleUpdate(env, rina.text('Одноразовые'));
  const d2 = dashOf(rina);
  assert.match(d2, /<b>🔥 ПРОЕБАНО &lt;b&gt;<\/b>/, 'название экранировано');
  assert.match(d2, /━━ 📌 Одноразовые ━━/);
  await handleUpdate(env, rina.tap('O:i:once:N', 83));
  assert.match(dashOf(rina), /━━ 📌 Разовые ━━/, 'название как было');
  assert.equal((await tasksOf(env)).length, 4, 'названия не стали задачами');
  // у Анны — всё стандартное
  await handleUpdate(env, anna.text('Позвонить сегодня в 10:00'));
  assert.match(dashOf(anna), /🔴 Просрочено/);
  assert.match(dashOf(anna), /<i>#Отдел<\/i>/);
  // вернуть как было
  await handleUpdate(env, rina.tap('O:i:overdue:d', 82));
  await handleUpdate(env, rina.tap('O:i:reset', 82));
  await handleUpdate(env, rina.tap('O:j:reset', 82));
  const row = await env.DB.prepare('SELECT data FROM users WHERE id = ?').bind(rina.id).first();
  assert.ok(!JSON.parse(row.data).prefs, 'всё стандартное — prefs пустые');
  assert.match(dashOf(rina), /🔴 Просрочено[\s\S]*<i>#Отдел<\/i>/);
  assert.doesNotMatch(dashOf(rina), /ПРОЕБАНО/, 'сброс возвращает и названия');
});
