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
  for (const re of [/Рабочий график — <b>общий<\/b>/, /План дня — ✅ в 09:00/, /Вечерняя сверка — ✅ в 20:00/, /Итоги недели — ✅/,
    /«На сегодня» без времени — два раза/, /До срока — за 1 час/, /«Не отстану» — каждые полчаса/,
    /Встречи — за час, за 15 мин и в начале/, /Номер задачи — в конце строки/, /Регулярные в списке — отдельным блоком/]) assert.match(v.body.text, re);
  // переключатель
  await handleUpdate(env, me.tap('O:m', 50));
  v = lastEdit(calls, 50);
  assert.match(v.body.text, /План дня — 🚫 выкл/);
  assert.match(kb(v), /План дня 🚫 выкл/);
  // подменю с отметкой текущего
  await handleUpdate(env, me.tap('O:l', 50));
  v = lastEdit(calls, 50);
  assert.match(kb(v), /✓ за 1 час/);
  assert.match(kb(v), /O:l:30/);
  assert.match(kb(v), /← Все настройки/);
  await handleUpdate(env, me.tap('O:l:30', 50));
  assert.match(lastEdit(calls, 50).body.text, /До срока — за 30 мин/);
  await handleUpdate(env, me.tap('O:c', 50));
  assert.match(lastEdit(calls, 50).body.text, /Календарь пока не подключён/);
  await handleUpdate(env, me.tap('O:c:0', 50));
  assert.match(lastEdit(calls, 50).body.text, /Встречи — только в начале/);
  await handleUpdate(env, me.tap('O:g:60', 50));
  await handleUpdate(env, me.tap('O:d:1', 50));
  await handleUpdate(env, me.tap('O:r', 50));
  v = lastEdit(calls, 50);
  assert.match(v.body.text, /«Не отстану» — каждый час/);
  assert.match(v.body.text, /«На сегодня» без времени — один раз/);
  assert.match(v.body.text, /Регулярные в списке — вместе с разовыми/);
  await handleUpdate(env, me.text('Витамины каждый день в 9:00'));
  await handleUpdate(env, me.text('Отчёт завтра'));
  const dash = [...calls].reverse().find(c => /📌 <b>Мои задачи<\/b>/.test(c.body.text || '')).body.text;
  assert.doesNotMatch(dash, /━━/, 'по настройке — регулярные вместе с разовыми');
  assert.match(dash, /🔜 Завтра[\s\S]*Витамины[\s\S]*Отчёт|🔜 Завтра[\s\S]*Отчёт[\s\S]*Витамины/);
  // вернуть по умолчанию — настройки не копятся мусором
  for (const d of ['O:m', 'O:r', 'O:l:60', 'O:c:60,15,0', 'O:g:30', 'O:d:2']) await handleUpdate(env, me.tap(d, 50));
  const row = await env.DB.prepare('SELECT data FROM users WHERE id = ?').bind(me.id).first();
  assert.ok(!JSON.parse(row.data).prefs, 'всё по умолчанию — prefs пустые');
  // чужое значение не принимаем
  calls.length = 0;
  await handleUpdate(env, me.tap('O:l:7', 50));
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
