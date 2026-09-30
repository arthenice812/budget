import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

const { parseTask, handleUpdate, runCron } = worker._internal;
// 2026-09-30 — среда
const NOW = { date: '2026-09-30', time: '12:00' };
const p = s => parseTask(s, NOW);

test('разбор сроков', () => {
  assert.deepEqual(p('Отчёт для Маши до пятницы'), { title: 'Отчёт для Маши', due: { date: '2026-10-02', time: null }, high: false });
  assert.deepEqual(p('Позвонить врачу завтра 10:00').due, { date: '2026-10-01', time: '10:00' });
  assert.equal(p('Позвонить врачу завтра 10:00').title, 'Позвонить врачу');
  assert.deepEqual(p('оплатить налог 25.10').due, { date: '2026-10-25', time: null });
  assert.equal(p('оплатить налог 25.10').title, 'Оплатить налог');
  assert.equal(p('подарок 5.03').due.date, '2027-03-05'); // прошедшая дата → следующий год
  assert.equal(p('встреча 12 октября в 15:30').due.date, '2026-10-12');
  assert.equal(p('встреча 12 октября в 15:30').due.time, '15:30');
  assert.equal(p('встреча 12 октября в 15:30').title, 'Встреча');
  assert.equal(p('продлить домен через 2 недели').due.date, '2026-10-14');
  assert.equal(p('продлить домен через месяц').due.date, '2026-10-30');
  assert.equal(p('созвон в среду').due.date, '2026-10-07'); // сегодня среда → следующая
  assert.equal(p('созвон в пн').due.date, '2026-10-05');
  assert.equal(p('созвон в следующую пятницу').due.date, '2026-10-09');
  assert.equal(p('созвон в 18:00').due.date, '2026-09-30'); // время ещё не прошло → сегодня
  assert.equal(p('созвон в 9:00').due.date, '2026-10-01'); // прошло → завтра
  assert.equal(p('купить 3 марки').due, null);
  assert.equal(p('купить 3 марки').title, 'Купить 3 марки');
  assert.equal(p('просто задача').due, null);
});

test('важность', () => {
  assert.equal(p('сдать отчёт !!').high, true);
  assert.equal(p('сдать отчёт !!').title, 'Сдать отчёт');
  assert.equal(p('срочно сдать отчёт').high, true);
  assert.equal(p('сдать отчёт!').high, false);
});

test('только дата → пустой заголовок (перенос срока ответом)', () => {
  assert.equal(p('завтра 15:00').title, '');
  assert.deepEqual(p('завтра 15:00').due, { date: '2026-10-01', time: '15:00' });
  assert.equal(p('в понедельник').title, '');
});

// ── Сквозной сценарий ──

function makeEnv() {
  const rows = new Map();
  const DB = {
    prepare(sql) {
      let args = [];
      const api = {
        bind: (...a) => { args = a; return api; },
        run: async () => { if (sql.startsWith('INSERT')) rows.set(args[0], args[1]); return {}; },
        first: async () => rows.has(args[0]) ? { v: rows.get(args[0]) } : null,
        all: async () => ({ results: [...rows.keys()].filter(k => k.startsWith('u:')).map(k => ({ k })) }),
      };
      return api;
    },
  };
  return { env: { DB, BOT_TOKEN: 'x', WEBHOOK_SECRET: 's', TIMEZONE: 'Europe/Moscow', _clock: () => new Date('2026-09-30T09:00:00Z') }, rows };
}

function mockTelegram() {
  const calls = [];
  let msgId = 100;
  globalThis.fetch = async (url, init) => {
    const method = url.split('/').pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    const result = method === 'sendMessage' ? { message_id: ++msgId } : true;
    return { json: async () => ({ ok: true, result }) };
  };
  return calls;
}

let upd = 1;
const chat = { id: 42, type: 'private' };
const from = { id: 42 };
const text = (t, extra = {}) => ({ update_id: upd++, message: { message_id: 1000 + upd, chat, from, text: t, ...extra } });

test('создание, подробности, перенос, готово, сводка', async () => {
  const calls = mockTelegram();
  const { env, rows } = makeEnv();

  await handleUpdate(env, text('Подготовить презентацию до пятницы !!\nслайды про Q3'));
  let st = JSON.parse(rows.get('u:42'));
  assert.equal(st.tasks.length, 1);
  const t = st.tasks[0];
  assert.equal(t.title, 'Подготовить презентацию');
  assert.equal(t.high, true);
  assert.equal(t.notes[0].text, 'слайды про Q3');
  assert.ok(st.dashId, 'закреплённый список создан');
  assert.ok(calls.some(c => c.method === 'pinChatMessage'));
  const cardMsg = t.msgIds[0];

  // ответ на карточку → подробности
  await handleUpdate(env, text('Маша пришлёт цифры в четверг', { reply_to_message: { message_id: cardMsg } }));
  st = JSON.parse(rows.get('u:42'));
  assert.equal(st.tasks.length, 1);
  assert.equal(st.tasks[0].notes.at(-1).text, 'Маша пришлёт цифры в четверг');

  // ответ датой → перенос
  await handleUpdate(env, text('завтра 15:00', { reply_to_message: { message_id: cardMsg } }));
  st = JSON.parse(rows.get('u:42'));
  assert.equal(st.tasks[0].due.time, '15:00');

  // повтор того же update_id игнорируется
  const dup = text('дубль'); upd--; dup.update_id = upd - 1;
  await handleUpdate(env, dup);
  assert.equal(JSON.parse(rows.get('u:42')).tasks.length, 1);
  upd++;

  // список и карточка по команде
  calls.length = 0;
  await handleUpdate(env, text('/list'));
  assert.match(calls.find(c => c.method === 'sendMessage').body.text, /Подготовить презентацию/);
  await handleUpdate(env, text('/t1'));
  if (process.env.SHOW) for (const c of calls) console.log('\n=== ' + c.method + '\n' + (c.body.text || ''));

  // кнопка «Готово»
  calls.length = 0;
  await handleUpdate(env, { update_id: upd++, callback_query: { id: 'q', from, data: 'a:1:done', message: { message_id: cardMsg, chat } } });
  st = JSON.parse(rows.get('u:42'));
  assert.equal(st.tasks[0].done, true);
  assert.ok(calls.some(c => c.method === 'editMessageText' && c.body.message_id === st.dashId));

  // утренняя сводка по крону (9:05 МСК = 6:05 UTC)
  await handleUpdate(env, text('Оплатить налог сегодня'));
  calls.length = 0;
  await runCron(env, new Date('2026-10-01T06:05:00Z'));
  const morning = calls.find(c => c.method === 'sendMessage' && /Доброе утро/.test(c.body.text));
  assert.ok(morning, 'утренняя сводка отправлена');
  assert.match(morning.body.text, /Просрочено[\s\S]*Оплатить налог/);
  calls.length = 0;
  await runCron(env, new Date('2026-10-01T06:10:00Z'));
  assert.ok(!calls.some(c => /Доброе утро/.test(c.body.text || '')), 'второй раз не шлём');
});

test('напоминание за час и в срок', async () => {
  const calls = mockTelegram();
  const { env } = makeEnv();
  await handleUpdate(env, text('Созвон с банком 12.10 15:00'));
  calls.length = 0;
  await runCron(env, new Date('2026-10-12T11:05:00Z')); // 14:05 МСК
  assert.ok(calls.some(c => /Через час/.test(c.body.text || '')));
  calls.length = 0;
  await runCron(env, new Date('2026-10-12T11:10:00Z'));
  assert.ok(!calls.some(c => /Через час/.test(c.body.text || '')));
  await runCron(env, new Date('2026-10-12T12:00:00Z')); // 15:00 МСК
  assert.ok(calls.some(c => /Время пришло/.test(c.body.text || '')));
});

test('чужие пользователи не проходят', async () => {
  const calls = mockTelegram();
  const { env, rows } = makeEnv();
  env.ALLOWED_USERS = '7';
  await handleUpdate(env, text('задача'));
  assert.equal(rows.size, 0);
  assert.match(calls[0].body.text, /личный бот/);
});
