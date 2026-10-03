import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { fakeTelegram, makeEnv, person, tasksOf } from './helpers.mjs';

const { handleUpdate, runCron } = worker._internal;
const at = iso => new Date(iso);
const URL_ICS = 'https://calendar.yandex.ru/export/ics.xml?private_token=secret123&tz_id=Europe/Moscow';

// Яндекс-подобный экспорт. «Сегодня» в тестах — ср 30.09.2026, 12:00 МСК
const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Yandex LLC//Yandex Calendar//EN',
  'BEGIN:VEVENT', 'UID:plan-1@yandex.ru', 'SUMMARY:Планёрка', 'DTSTART;TZID=Europe/Moscow:20260105T100000',
  'DTEND;TZID=Europe/Moscow:20260105T103000', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=Europe/Moscow:20261012T100000',
  'LOCATION:https://telemost.yandex.ru/j/123', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:plan-1@yandex.ru', 'RECURRENCE-ID;TZID=Europe/Moscow:20261019T100000', 'SUMMARY:Планёрка (перенос)',
  'DTSTART;TZID=Europe/Moscow:20261019T113000', 'DTEND;TZID=Europe/Moscow:20261019T120000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:bank-2', 'SUMMARY:Созвон с банком\\, по кредиту', 'DTSTART:20261001T120000Z', 'DTEND:20261001T130000Z',
  'DESCRIPTION:Ссылка на встречу: https://zoom.us/j/999\\nПароль 1', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:month-3', 'SUMMARY:Совет директоров', 'DTSTART;TZID=Europe/Moscow:20260101T150000', 'DURATION:PT2H',
  'RRULE:FREQ=MONTHLY;BYDAY=1TH', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:bday-4', 'SUMMARY:ДР Ивана', 'DTSTART;VALUE=DATE:20261002', 'DTEND;VALUE=DATE:20261003', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:cancel-5', 'SUMMARY:Отменённая', 'STATUS:CANCELLED', 'DTSTART:20261001T080000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:old-6', 'SUMMARY:Старая разовая', 'DTSTART:20200101T080000Z', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

async function connected() {
  const calls = fakeTelegram();
  globalThis.__ics = { [URL_ICS]: ICS };
  const env = makeEnv();
  const me = person(600, 'Рина');
  await handleUpdate(env, me.text('/start'));
  calls.length = 0;
  await handleUpdate(env, me.text(URL_ICS));
  const ev = (await env.DB.prepare('SELECT * FROM events ORDER BY start').all()).results;
  return { calls, env, me, ev };
}

test('подключение: ссылка удаляется из чата, встречи разобраны правильно', async () => {
  const { calls, ev } = await connected();
  assert.ok(calls.some(c => c.method === 'deleteMessage'), 'сообщение со ссылкой удалено');
  const ok = calls.find(c => /Календарь подключён/.test(c.body.text || ''));
  assert.ok(ok);
  const list = ev.map(e => `${e.start} ${e.title}`);
  assert.ok(list.includes('2026-10-01 15:00 Созвон с банком, по кредиту'), 'UTC → МСК, экранирование');
  assert.ok(list.includes('2026-10-01 15:00 Совет директоров'), 'первый четверг месяца');
  assert.ok(list.includes('2026-10-05 10:00 Планёрка'), 'еженедельная');
  assert.ok(!list.some(x => x.startsWith('2026-10-12')), 'исключённая дата');
  assert.ok(list.includes('2026-10-19 11:30 Планёрка (перенос)'), 'перенесённая');
  assert.ok(!list.includes('2026-10-19 10:00 Планёрка'), 'исходное время перенесённой убрано');
  assert.ok(list.includes('2026-10-02 ДР Ивана'), 'весь день');
  assert.ok(!list.some(x => /Отменённая|Старая/.test(x)));
  const bank = ev.find(e => e.title.startsWith('Созвон'));
  assert.equal(bank.link, 'https://zoom.us/j/999');
  assert.equal(bank.end, '2026-10-01 16:00');
  globalThis.__ics = {};
});

test('подготовка к встрече → задача с чек-листом и сроком до начала; напоминание за 15 минут', async () => {
  const { calls, env, me, ev } = await connected();
  const bank = ev.find(e => e.title.startsWith('Созвон'));
  await handleUpdate(env, me.tap(`M:p:${bank.h}`, 700));
  await handleUpdate(env, me.text('- выписка по счёту\n- вопросы по ставке'));
  let [t] = await tasksOf(env);
  assert.equal(t.title, 'Подготовить: Созвон с банком, по кредиту');
  assert.deepEqual(t.due, { date: '2026-10-01', time: '15:00' });
  assert.deepEqual(t.checklist.map(c => c.text), ['выписка по счёту', 'вопросы по ставке']);
  // ещё раз — добавляется к той же задаче
  await handleUpdate(env, me.tap(`M:p:${bank.h}`, 700));
  await handleUpdate(env, me.text('договор'));
  assert.equal((await tasksOf(env)).length, 1);
  assert.equal((await tasksOf(env))[0].checklist.length, 3);

  calls.length = 0;
  await runCron(env, at('2026-10-01T11:47:00Z')); // 14:47 — за 13 минут
  const rem = calls.find(c => /Через 13 мин: Созвон с банком/.test(c.body.text || ''));
  assert.ok(rem, 'напомнили о встрече');
  assert.match(rem.body.text, /zoom\.us[\s\S]*Подготовка[\s\S]*выписка по счёту/);
  calls.length = 0;
  await runCron(env, at('2026-10-01T11:52:00Z'));
  assert.ok(!calls.some(c => /Созвон с банком/.test(c.body.text || '') && /Через/.test(c.body.text || '')), 'второй раз не напоминаем');
  globalThis.__ics = {};
});

test('после регулярной встречи — подготовить к следующей и записать итоги', async () => {
  const { calls, env, me, ev } = await connected();
  calls.length = 0;
  await runCron(env, at('2026-10-05T07:35:00Z')); // пн 10:35 — планёрка закончилась
  const after = calls.find(c => /Встреча «<b>Планёрка<\/b>» закончилась/.test(c.body.text || ''));
  assert.ok(after);
  const kb = JSON.stringify(after.body.reply_markup);
  const next = ev.find(e => e.start === '2026-10-19 11:30');
  assert.match(kb, new RegExp(`M:p:${next.h}`), 'следующая — 19.10 (12.10 исключена)');

  env._clock = () => at('2026-10-05T07:40:00Z');
  await handleUpdate(env, me.tap(`M:p:${next.h}`, 701));
  await handleUpdate(env, me.text('- отчёт по продажам'));
  const plan = ev.find(e => e.start === '2026-10-05 10:00');
  await handleUpdate(env, me.tap(`M:a:${plan.h}`, 702));
  await handleUpdate(env, me.text('- отправить протокол до пятницы\n- созвониться с Олегом завтра в 11:00'));
  const ts = await tasksOf(env);
  assert.equal(ts.length, 3);
  assert.equal(ts[0].title, 'Подготовить: Планёрка (перенос)');
  assert.deepEqual(ts[0].due, { date: '2026-10-19', time: '11:30' });
  assert.equal(ts[1].title, 'Отправить протокол');
  assert.equal(ts[1].due.date, '2026-10-09');
  assert.deepEqual(ts[2].due, { date: '2026-10-06', time: '11:00' });
  assert.ok(ts[2].notes.some(n => /По итогам встречи «Планёрка»/.test(n.text)));
  globalThis.__ics = {};
});

test('понедельник: встречи недели с кнопками; утро — встречи сегодня; «📅 Встречи»', async () => {
  const { calls, env, me } = await connected();
  env.DB.raw.exec(`UPDATE users SET data = json_set(data, '$.lastMorning', '2026-10-04')`);
  calls.length = 0;
  await runCron(env, at('2026-10-05T06:05:00Z')); // пн 09:05
  const morning = calls.find(c => /Доброе утро/.test(c.body.text || ''));
  assert.match(morning.body.text, /Встречи сегодня[\s\S]*10:00 — Планёрка/);
  const week = calls.find(c => /Встречи на этой неделе/.test(c.body.text || ''));
  assert.ok(week, 'список недели');
  assert.match(JSON.stringify(week.body.reply_markup), /📝 пн 10:00 Планёрка/);
  calls.length = 0;
  await handleUpdate(env, me.text('📅 Встречи'));
  assert.match(calls[0].body.text, /Встречи на 7 дней/);
  // отключить
  await handleUpdate(env, me.tap('M:off', 703));
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM events').first()).n, 0);
  globalThis.__ics = {};
});

test('плохая ссылка — понятная ошибка', async () => {
  const calls = fakeTelegram();
  globalThis.__ics = { 'https://calendar.yandex.ru/export/bad.ics': '<html>Not found</html>' };
  const env = makeEnv();
  const me = person(601, 'Рина');
  await handleUpdate(env, me.text('https://calendar.yandex.ru/export/bad.ics'));
  assert.ok(calls.some(c => /Не получилось прочитать календарь/.test(c.body.text || '')));
  globalThis.__ics = {};
});
