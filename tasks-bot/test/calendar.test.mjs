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

test('кнопки в сообщении «Календарь подключён» открывают встречу', async () => {
  const { calls, env, me } = await connected();
  const ok = calls.find(c => /Календарь подключён/.test(c.body.text || ''));
  const btns = (ok.body.reply_markup?.inline_keyboard || []).flat().filter(b => /^M:p:/.test(b.callback_data || ''));
  assert.ok(btns.length > 0, 'есть кнопки встреч');
  for (const b of btns) assert.doesNotMatch(b.callback_data, /undefined/);
  calls.length = 0;
  await handleUpdate(env, me.tap(btns[0].callback_data, 700));
  assert.ok(calls.some(c => /Что подготовить/.test(c.body.text || '')), 'спросили, что подготовить');
  assert.ok(!calls.some(c => /Не нашёл эту встречу/.test(c.body.text || '')));
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

// ── Уже записанная задача → к встрече ──
const kbOf = c => JSON.stringify(c.body.reply_markup || {});
const lastEdit = (calls, id) => [...calls].reverse().find(c => c.method === 'editMessageText' && c.body.message_id === id);

test('с карточки: ☰ Ещё → 🗓 К встрече → выбрать встречу; срок до начала; задача в напоминании и после встречи', async () => {
  const { calls, env, me, ev } = await connected();
  const bank = ev.find(e => e.title.startsWith('Созвон'));
  await handleUpdate(env, me.text('Подготовить слайды'));
  await handleUpdate(env, me.text('Распечатать договор 5 октября'));
  const [slides, contract] = await tasksOf(env);

  await handleUpdate(env, me.tap(`a:${slides.id}:more`, 800));
  assert.match(kbOf(lastEdit(calls, 800)), new RegExp(`a:${slides.id}:meet`), 'в «Ещё» есть «К встрече»');
  await handleUpdate(env, me.tap(`a:${slides.id}:meet`, 800));
  const pick = lastEdit(calls, 800);
  assert.match(kbOf(pick), new RegExp(`a:${slides.id}:mt${bank.h}`), 'встреча с банком в списке');
  assert.match(kbOf(pick), /Созвон с банком/);
  assert.doesNotMatch(kbOf(pick), /ДР Ивана.*ДР Ивана/);
  await handleUpdate(env, me.tap(`a:${slides.id}:mt${bank.h}`, 800));
  let t = (await tasksOf(env))[0];
  assert.equal(t.meeting.h, bank.h);
  assert.deepEqual(t.due, { date: '2026-10-01', time: '15:00' }, 'срока не было → до начала встречи');
  assert.match(lastEdit(calls, 800).body.text, /к встрече «Созвон с банком, по кредиту»/);
  assert.match(kbOf(lastEdit(calls, 800)), /a:\d+:more/, 'карточка вернулась к обычному виду');

  // договор: срок 5.10 позже встречи 1.10 → подтягивается к встрече
  await handleUpdate(env, me.tap(`a:${contract.id}:mt${bank.h}`, 801));
  assert.deepEqual((await tasksOf(env))[1].due, { date: '2026-10-01', time: '15:00' });

  // в «📅 Встречи» видно, что к встрече есть задачи
  calls.length = 0;
  await handleUpdate(env, me.text('📅 Встречи'));
  assert.match(calls.find(c => /Встречи на 7 дней/.test(c.body.text || '')).body.text, /Созвон с банком[\s\S]*📎 Подготовить слайды/);

  // напоминание за 15 минут — с задачами и кнопками
  calls.length = 0;
  await runCron(env, at('2026-10-01T11:47:00Z'));
  const rem = calls.find(c => /Через 13 мин: Созвон с банком/.test(c.body.text || ''));
  assert.match(rem.body.text, /Задачи к встрече[\s\S]*Подготовить слайды[\s\S]*Распечатать договор/);
  assert.match(kbOf(rem), new RegExp(`M:o:${slides.id}`));

  // после встречи — напоминаем отметить
  await handleUpdate(env, me.tap(`a:${slides.id}:done`, 800));
  calls.length = 0;
  await runCron(env, at('2026-10-01T13:05:00Z'));
  const after = calls.find(c => /Созвон с банком.*закончилась/.test(c.body.text || ''));
  assert.ok(after, 'после встречи с задачами — спрашиваем об итогах');
  assert.match(after.body.text, /не забудь отметить сделанные[\s\S]*Распечатать договор/);
  assert.doesNotMatch(after.body.text, /Подготовить слайды/, 'сделанную не показываем');

  // отвязать
  await handleUpdate(env, me.tap(`a:${contract.id}:meet`, 801));
  assert.match(kbOf(lastEdit(calls, 801)), new RegExp(`a:${contract.id}:unmeet`));
  await handleUpdate(env, me.tap(`a:${contract.id}:unmeet`, 801));
  assert.equal((await tasksOf(env))[1].meeting, undefined);
  globalThis.__ics = {};
});

test('со встречи: 📝 → «📎 Добавить уже записанную задачу» → выбрать задачу; срок раньше встречи не трогаем', async () => {
  const { calls, env, me, ev } = await connected();
  const bank = ev.find(e => e.title.startsWith('Созвон'));
  await handleUpdate(env, me.text('Собрать справки сегодня в 18:00'));
  await handleUpdate(env, me.text('Купить хлеб'));
  const [docs] = await tasksOf(env);
  await handleUpdate(env, me.tap(`M:p:${bank.h}`, 900));
  const ask = calls.find(c => /Что подготовить к встрече/.test(c.body.text || ''));
  assert.match(kbOf(ask), new RegExp(`M:t:${bank.h}`));
  await handleUpdate(env, me.tap(`M:t:${bank.h}`, 900));
  const list = lastEdit(calls, 900);
  assert.match(list.body.text, /Какую задачу добавить к встрече/);
  assert.match(kbOf(list), new RegExp(`M:l:${bank.h}:${docs.id}`));
  assert.match(kbOf(list), /Купить хлеб/);
  await handleUpdate(env, me.tap(`M:l:${bank.h}:${docs.id}`, 900));
  assert.match(lastEdit(calls, 900).body.text, /К встрече «Созвон с банком, по кредиту»/);
  const t = (await tasksOf(env))[0];
  assert.equal(t.meeting.h, bank.h);
  assert.deepEqual(t.due, { date: '2026-09-30', time: '18:00' }, 'срок раньше встречи — оставили');
  // бот больше не ждёт текст подготовки: следующее сообщение — обычная задача
  await handleUpdate(env, me.text('Позвонить маме'));
  assert.equal((await tasksOf(env)).length, 3);
  assert.equal((await tasksOf(env))[2].title, 'Позвонить маме');
  // уже привязанную второй раз не предлагаем
  await handleUpdate(env, me.tap(`M:t:${bank.h}`, 901));
  assert.doesNotMatch(kbOf(lastEdit(calls, 901)), new RegExp(`M:l:${bank.h}:${docs.id}`));
  globalThis.__ics = {};
});

test('регулярная задача к регулярной встрече переезжает к следующей встрече', async () => {
  const { env, me, ev } = await connected();
  const plan = ev.find(e => e.start === '2026-10-05 10:00');
  const next = ev.find(e => e.start === '2026-10-19 11:30'); // 12.10 исключена, 19.10 перенесена
  await handleUpdate(env, me.text('Отчёт к планёрке каждый понедельник'));
  const [t0] = await tasksOf(env);
  await handleUpdate(env, me.tap(`a:${t0.id}:mt${plan.h}`, 1));
  assert.equal((await tasksOf(env))[0].meeting.h, plan.h);
  await handleUpdate(env, me.tap(`a:${t0.id}:done`, 1));
  const t = (await tasksOf(env))[0];
  assert.equal(t.meeting.h, next.h, 'привязана к следующей планёрке');
  assert.equal(t.meeting.title, 'Планёрка');
  globalThis.__ics = {};
});

test('общая встреча у двоих: в напоминании каждого — только свои задачи', async () => {
  const { calls, env, me, ev } = await connected();
  const boss = person(601, 'Анна');
  await handleUpdate(env, boss.text('/start'));
  await handleUpdate(env, boss.text(URL_ICS)); // тот же календарь → те же встречи
  const bank = ev.find(e => e.title.startsWith('Созвон'));
  await handleUpdate(env, me.text('Мой секретный вопрос'));
  const [t] = await tasksOf(env);
  await handleUpdate(env, me.tap(`a:${t.id}:mt${bank.h}`, 1));
  calls.length = 0;
  await runCron(env, at('2026-10-01T11:47:00Z'));
  const toBoss = calls.find(c => c.body.chat_id === boss.id && /Созвон с банком/.test(c.body.text || ''));
  const toMe = calls.find(c => c.body.chat_id === me.id && /Созвон с банком/.test(c.body.text || ''));
  assert.ok(toBoss && toMe);
  assert.match(toMe.body.text, /Мой секретный вопрос/);
  assert.doesNotMatch(toBoss.body.text, /Мой секретный вопрос/, 'чужая задача не попадает Анне');
  globalThis.__ics = {};
});

test('без календаря «🗓 К встрече» подсказывает, как подключить', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(602, 'Рина');
  await handleUpdate(env, me.text('/start'));
  await handleUpdate(env, me.text('Задача'));
  const [t] = await tasksOf(env);
  calls.length = 0;
  await handleUpdate(env, me.tap(`a:${t.id}:meet`, 5));
  assert.ok(calls.some(c => c.method === 'answerCallbackQuery' && /подключи календарь/.test(c.body.text || '')));
  assert.equal((await tasksOf(env))[0].meeting, undefined);
});
