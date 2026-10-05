// Рабочий график: у каждого свои время плана, сверки, напоминаний и выходные
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { fakeTelegram, makeEnv, person, tasksOf } from './helpers.mjs';

const { handleUpdate, runCron } = worker._internal;
const kb = c => JSON.stringify(c.body.reply_markup || {});

test('первый запуск: бот спрашивает график кнопками и показывает, что получилось', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(1500, 'Рина');
  await handleUpdate(env, me.text('/start'), 'https://bot.example');
  const ask = calls.find(c => /Настроим твой рабочий график/.test(c.body.text || ''));
  assert.ok(ask, 'спросил график');
  assert.match(kb(ask), /S:f:1000/);
  await handleUpdate(env, me.tap('S:f:1000', 40), 'https://bot.example');
  const ends = [...calls].reverse().find(c => c.method === 'editMessageText' && c.body.message_id === 40);
  assert.match(ends.body.text, /Начало — <b>10:00<\/b>/);
  assert.match(kb(ends), /S:t:1900/);
  assert.doesNotMatch(kb(ends), /S:t:1[0-5]00/, 'конец не раньше начала + 6 часов');
  await handleUpdate(env, me.tap('S:t:1900', 40), 'https://bot.example');
  await handleUpdate(env, me.tap('S:w:1', 40), 'https://bot.example');
  const done = [...calls].reverse().find(c => c.method === 'editMessageText' && c.body.message_id === 40);
  assert.match(done.body.text, /График сохранён/);
  assert.match(done.body.text, /10:00–19:00, пн–пт/);
  assert.match(done.body.text, /план дня — 10:00/);
  assert.match(done.body.text, /«на сегодня» без времени — 13:00 и 18:00/);
  assert.match(done.body.text, /«Не отстану» — с 10:00 до 19:00/);
  assert.match(done.body.text, /вечерняя сверка — 18:30/);
  assert.match(done.body.text, /в выходные и праздники не беспокою/);

  // второй раз сам не спрашивает
  calls.length = 0;
  await handleUpdate(env, me.text('Задача'), 'https://bot.example');
  assert.ok(!calls.some(c => /Настроим твой рабочий график/.test(c.body.text || '')));
  // справка показывает свои времена
  calls.length = 0;
  await handleUpdate(env, me.tap('h:day', 41), 'https://bot.example');
  const help = calls.find(c => /План дня и напоминания/.test(c.body.text || ''));
  assert.match(help.body.text, /Твой график: 10:00–19:00, пн–пт/);
  assert.match(help.body.text, /10:00 — план на день/);
  assert.match(help.body.text, /18:30 — вечерняя сверка/);
  assert.match(help.body.text, /с 10:00 до 19:00/);
});

test('«⏭ Потом» — работает по общему расписанию; уже знакомого человека спрашивает один раз', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(1501, 'Анна');
  await handleUpdate(env, me.text('Отчёт завтра'), 'https://bot.example'); // без /start — как старый пользователь
  assert.equal(calls.filter(c => /Настроим твой рабочий график/.test(c.body.text || '')).length, 1, 'спросил один раз');
  await handleUpdate(env, me.tap('S:later', 50), 'https://bot.example');
  assert.ok(calls.some(c => /Пока работаю по общему расписанию/.test(c.body.text || '')));
  calls.length = 0;
  await handleUpdate(env, me.text('Ещё задача'), 'https://bot.example');
  assert.ok(!calls.some(c => /Настроим твой рабочий график/.test(c.body.text || '')), 'больше не пристаёт');
  await handleUpdate(env, me.text('/status'), 'https://bot.example');
  assert.ok(calls.some(c => /График не настроен[\s\S]*план дня — 09:00[\s\S]*сверка — 20:00/.test(c.body.text || '')));
});

test('словами: «график 9:30-18:30 без выходных», ошибки — понятным текстом', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(1502, 'Рина');
  await handleUpdate(env, me.text('/start'), 'https://bot.example');
  calls.length = 0;
  await handleUpdate(env, me.text('график 9:30-18:30 без выходных'), 'https://bot.example');
  assert.ok(calls.some(c => /График сохранён[\s\S]*09:30–18:30, без выходных[\s\S]*сверка — 18:00/.test(c.body.text || '')));
  await handleUpdate(env, me.text('мой график 8-17'), 'https://bot.example');
  assert.ok(calls.some(c => /08:00–17:00, пн–пт/.test(c.body.text || '')));
  calls.length = 0;
  await handleUpdate(env, me.text('график 18-17'), 'https://bot.example');
  assert.ok(calls.some(c => /Не понял время/.test(c.body.text || '')));
  await handleUpdate(env, me.text('/schedule 10:00-19:00'), 'https://bot.example');
  assert.ok(calls.some(c => /10:00–19:00/.test(c.body.text || '')));
  assert.equal((await tasksOf(env)).length, 0, 'ни одна фраза про график не стала задачей');
});

test('двое с разными графиками: план, напоминания, сверка, «не отстану», выходные, праздник, итоги недели', async () => {
  const calls = fakeTelegram();
  let now = new Date('2026-09-30T09:00:00Z'); // ср 12:00 МСК
  const env = makeEnv({ _clock: () => now });
  const rina = person(1510, 'Рина'); // 10–19, пн–пт
  const anna = person(1511, 'Анна'); // общее расписание: 9:00 / 12:00, 17:00 / 20:00
  for (const p of [rina, anna]) await handleUpdate(env, p.text('/start'), 'https://bot.example');
  await handleUpdate(env, rina.text('график 10-19'), 'https://bot.example');
  // понедельник 5.10 — праздник по производственному календарю (для проверки)
  const days = Array.from({ length: 365 }, (_, i) => { const d = new Date(Date.UTC(2026, 0, 1 + i)); return d.getUTCDay() % 6 === 0 ? '1' : '0'; });
  days[277] = '1'; // 2026-10-05 — 278-й день года
  env.DB.raw.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('cal:2026', days.join(''));

  const sent = {};
  const log = (who, what) => { (sent[who] = sent[who] || []).push(what); };
  const step = async iso => {
    now = new Date(iso);
    calls.length = 0;
    await runCron(env, now);
    const msk = new Date(now.getTime() + 3 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
    for (const c of calls.filter(c => c.method === 'sendMessage')) {
      const who = c.body.chat_id === rina.id ? 'rina' : c.body.chat_id === anna.id ? 'anna' : null;
      if (!who) continue;
      const t = c.body.text || '';
      const kind = /Доброе утро/.test(t) ? 'утро' : /Вечерняя сверка/.test(t) ? 'вечер' : /Итоги недели/.test(t) ? 'неделя'
        : /Сегодня срок/.test(t) ? 'сегодня' : /Не отстану/.test(t) ? 'не отстану' : null;
      if (kind) log(who, `${msk} ${kind}`);
    }
  };
  // задачи на каждый день: «на сегодня» без времени, важная — чтобы «не отстану» было о чём
  const addTasks = async () => {
    for (const p of [rina, anna]) {
      await handleUpdate(env, p.text('Сверка документов сегодня'), 'https://bot.example');
      const t = (await tasksOf(env)).filter(x => x.assignee === p.id && !x.done).pop();
      await handleUpdate(env, p.tap(`a:${t.id}:nag`, 1), 'https://bot.example');
    }
  };
  for (let ms = Date.parse('2026-10-01T03:00:00Z'); ms <= Date.parse('2026-10-05T20:00:00Z'); ms += 5 * 60e3) {
    if (new Date(ms + 3 * 3600e3).toISOString().slice(11, 16) === '07:00') { now = new Date(ms); await addTasks(); }
    await step(new Date(ms).toISOString());
  }
  const of = (who, day, kind) => (sent[who] || []).filter(x => x.startsWith(day) && x.endsWith(kind)).map(x => x.slice(6, 11));

  // четверг 1.10 — рабочий день у обеих
  assert.deepEqual(of('rina', '10-01', 'утро'), ['10:00']);
  assert.deepEqual(of('anna', '10-01', 'утро'), ['09:00']);
  assert.deepEqual(of('rina', '10-01', 'сегодня'), ['13:00', '18:00']);
  assert.deepEqual(of('anna', '10-01', 'сегодня'), ['12:00', '17:00']);
  assert.deepEqual(of('rina', '10-01', 'вечер'), ['18:30']);
  assert.deepEqual(of('anna', '10-01', 'вечер'), ['20:00']);
  const rinaNag = of('rina', '10-01', 'не отстану');
  assert.ok(rinaNag.length > 0 && rinaNag.every(t => t >= '10:00' && t < '19:00'), `«не отстану» у Рины только в рабочие часы: ${rinaNag}`);
  assert.ok(of('anna', '10-01', 'не отстану').some(t => t >= '19:00'), 'у Анны — по общему расписанию, до 21');

  // пятница 2.10 — у Рины итоги недели в последний рабочий день; у Анны — в воскресенье
  assert.deepEqual(of('rina', '10-02', 'неделя'), ['18:30']);
  assert.deepEqual(of('anna', '10-04', 'неделя'), ['19:00']);
  assert.deepEqual(of('rina', '10-04', 'неделя'), []);

  // суббота и воскресенье — Рину не беспокоим совсем, Анне всё как раньше
  for (const day of ['10-03', '10-04']) {
    assert.deepEqual((sent.rina || []).filter(x => x.startsWith(day) && !x.endsWith('неделя')), [], `Рина ${day}`);
    assert.deepEqual(of('anna', day, 'утро'), ['09:00'], `Анна ${day}`);
  }
  // понедельник 5.10 — праздник: Рине ничего; Анне — как обычно
  assert.deepEqual((sent.rina || []).filter(x => x.startsWith('10-05')), [], 'праздник у Рины');
  assert.deepEqual(of('anna', '10-05', 'утро'), ['09:00']);
});

test('«🔔 Вечером» и «🔔 Завтра утром» — по своему графику', async () => {
  const calls = fakeTelegram();
  const now = new Date('2026-09-30T09:00:00Z'); // 12:00 МСК
  const env = makeEnv({ _clock: () => now });
  const me = person(1520, 'Рина');
  await handleUpdate(env, me.text('/start'));
  await handleUpdate(env, me.text('график 8-17'));
  await handleUpdate(env, me.text('Позвонить'));
  const [t] = await tasksOf(env);
  await handleUpdate(env, me.tap(`a:${t.id}:sev`, 1));
  assert.deepEqual((await tasksOf(env))[0].remindAt, { date: '2026-09-30', time: '16:30' }, 'вечер = время сверки');
  await handleUpdate(env, me.tap(`a:${t.id}:smo`, 1));
  assert.deepEqual((await tasksOf(env))[0].remindAt, { date: '2026-10-01', time: '08:00' }, 'утро = начало дня');
  assert.ok(calls.length);
});
