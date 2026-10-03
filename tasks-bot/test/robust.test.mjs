// Надёжность: гонки, лимиты Cloudflare, ошибки, все кнопки подряд
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { fakeTelegram, makeEnv, person, tasksOf, lastCardMsg, errors } from './helpers.mjs';

const { handleUpdate, runCron } = worker._internal;
const at = iso => new Date(iso);

test('расписание и кнопка одновременно: «Готово» не откатывается, выбор главного не теряется', async () => {
  fakeTelegram();
  const env = makeEnv();
  const me = person(200, 'Рина');
  await handleUpdate(env, me.text('Созвон 12.10 15:00'));
  await handleUpdate(env, me.text('Отчёт завтра'));

  // расписание загрузило задачи и «повисло» на отправке — в это время человек жмёт «Готово» и выбирает главное
  const realFetch = globalThis.fetch;
  let release;
  const gate = new Promise(r => { release = r; });
  let held = false;
  globalThis.fetch = async (url, init) => {
    if (!held && /sendMessage/.test(url) && /Через час/.test(init.body)) { held = true; await gate; }
    return realFetch(url, init);
  };
  const cron = runCron(env, at('2026-10-12T11:05:00Z')); // 14:05 — «через час срок»
  await new Promise(r => setTimeout(r, 20));
  env._clock = () => at('2026-10-12T11:06:00Z');
  await handleUpdate(env, me.tap('a:1:done', await lastCardMsg(env, 200, 1)));
  await handleUpdate(env, me.tap('f:2'));
  release();
  await cron;
  globalThis.fetch = realFetch;

  const [t1] = await tasksOf(env);
  assert.equal(t1.done, true, '«Готово» не откатилось');
  const u = JSON.parse((await env.DB.prepare('SELECT data FROM users WHERE id = 200').first()).data);
  assert.deepEqual(u.focus.ids, [2], 'выбор главного сохранился');
});

test('много людей — утро не упирается в лимит Cloudflare и не шлётся дважды', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const people = Array.from({ length: 25 }, (_, i) => person(300 + i, 'Коллега' + i));
  for (const p of people) {
    await handleUpdate(env, p.text('/start'));
    await handleUpdate(env, p.text('Отчёт сегодня'));
    await handleUpdate(env, p.text('Позвонить в банк'));
  }
  env.DB.raw.exec(`UPDATE tasks SET data = json_set(data, '$.createdAt', '2026-09-01')`); // и залежавшиеся тоже
  calls.length = 0;
  const morning = () => calls.filter(c => /Доброе утро/.test(c.body.text || '')).length;
  let runs = 0, used;
  for (let min = 5; min <= 120 && morning() < 25; min += 5) {
    const r = await runCron(env, new Date(Date.parse('2026-10-01T06:00:00Z') + min * 60e3));
    used = r.used; runs++;
    assert.ok(r.used.tg <= 50 && r.used.db <= 50, `лимит соблюдён: ${JSON.stringify(r.used)}`);
  }
  assert.equal(morning(), 25, 'утро пришло каждому');
  assert.ok(runs > 1, 'разнесено на несколько проверок');
  const before = morning();
  await runCron(env, at('2026-10-01T08:30:00Z'));
  assert.equal(morning(), before, 'повторно не шлём');
  assert.ok(used);
});

test('ошибка внутри — человек получает ответ, кнопка не «крутится»', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(400, 'Рина');
  await handleUpdate(env, me.text('Задача'));
  const realPrepare = env.DB.prepare;
  env.DB.prepare = q => { if (/FROM msgs/.test(q)) throw new Error('боевая ошибка базы (expected-in-test)'); return realPrepare(q); };
  calls.length = 0;
  await handleUpdate(env, me.reply(1001, 'подробности'));
  assert.ok(calls.some(c => /Что-то пошло не так/.test(c.body.text || '')));
  env.DB.prepare = q => { if (/SELECT \* FROM tasks WHERE id/.test(q)) throw new Error('боевая ошибка базы (expected-in-test)'); return realPrepare(q); };
  calls.length = 0;
  await handleUpdate(env, me.tap('a:1:done'));
  assert.ok(calls.some(c => c.method === 'answerCallbackQuery' && /Не получилось/.test(c.body.text)));
  env.DB.prepare = realPrepare;
  // ошибки этого теста ожидаемые — убираем их из общего списка
  for (let i = errors.length - 1; i >= 0; i--) if (errors[i].includes('expected-in-test')) errors.splice(i, 1);
});

test('длинный пересланный пост: короткое название, остальное в подробностях', async () => {
  fakeTelegram();
  const env = makeEnv();
  const me = person(401, 'Рина');
  const long = 'Коллеги, напоминаю, что до конца недели нужно ' + 'сдать отчёты по проектам, заполнить таблицу загрузки и согласовать планы '.repeat(4);
  await handleUpdate(env, me.text(long, { forward_origin: { type: 'user', sender_user: { first_name: 'Анна' } } }));
  const [t] = await tasksOf(env);
  assert.ok(t.title.length <= 125, `название ${t.title.length} символов`);
  assert.ok(t.notes.some(n => n.text.startsWith('…')), 'хвост в подробностях');
});

test('удаление кнопкой — можно восстановить', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(402, 'Рина');
  await handleUpdate(env, me.text('Задача для удаления'));
  calls.length = 0;
  await handleUpdate(env, me.tap('a:1:delok', 900));
  const ed = calls.find(c => c.method === 'editMessageText' && c.body.message_id === 900);
  assert.match(JSON.stringify(ed.body.reply_markup), /r:1/);
  await handleUpdate(env, me.tap('r:1', 900));
  assert.equal((await tasksOf(env)).length, 1);
});

test('заблокировал бота — расписание его пропускает, написал снова — снова получает', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(403, 'Рина');
  await handleUpdate(env, me.text('/start'));
  await handleUpdate(env, me.text('Отчёт сегодня'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (/api\.telegram\.org/.test(url) && JSON.parse(init.body).chat_id === 403) {
      return { json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }) };
    }
    return realFetch(url, init);
  };
  await runCron(env, at('2026-10-01T06:05:00Z'));
  let u = JSON.parse((await env.DB.prepare('SELECT data FROM users WHERE id = 403').first()).data);
  assert.equal(u.blocked, true);
  globalThis.fetch = realFetch;
  calls.length = 0;
  await runCron(env, at('2026-10-01T09:05:00Z'));
  assert.ok(!calls.some(c => c.body.chat_id === 403), 'не тратим запросы');
  await handleUpdate(env, me.text('я вернулась'));
  u = JSON.parse((await env.DB.prepare('SELECT data FROM users WHERE id = 403').first()).data);
  assert.equal(u.blocked, undefined);
});

test('производственный календарь: первый рабочий день января — после каникул', async () => {
  fakeTelegram();
  const env = makeEnv();
  const me = person(404, 'Рина');
  // 2027: 1–8 января выходные, 9–10 — суббота и воскресенье
  const days = Array.from({ length: 365 }, (_, i) => {
    const d = new Date(Date.UTC(2027, 0, 1 + i));
    const wd = d.getUTCDay();
    return (i < 8 || wd === 0 || wd === 6) ? '1' : '0';
  }).join('');
  globalThis.__calendar = days;
  env._clock = () => at('2026-12-15T09:00:00Z');
  await handleUpdate(env, me.text('Отчёт в первый рабочий день месяца'));
  let [t] = await tasksOf(env);
  assert.equal(t.due.date, '2027-01-01', 'без календаря — 1 января');
  // расписание загружает календарь и поправляет срок
  globalThis.__calendar = days; // 2026 вернёт то же — для теста неважно
  await runCron(env, at('2026-12-15T09:05:00Z'));
  [t] = await tasksOf(env);
  assert.equal(t.due.date, '2027-01-11', 'с календарём — 11 января');
  globalThis.__calendar = '';
});

// ── Все кнопки подряд: ни одна не ломается и не шлёт в Telegram недопустимое ──
test('нажимаем все кнопки во всех меню', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const boss = person(500, 'Анна', 'anna');
  const me = person(501, 'Рина', 'rina');
  await handleUpdate(env, me.text('/start'), 'https://bot.example');
  await handleUpdate(env, me.text('создай проект Работа'), 'https://bot.example');
  const code = (await env.DB.prepare('SELECT code FROM projects').first()).code;
  await handleUpdate(env, boss.text('/start join_' + code), 'https://bot.example');
  const texts = [
    'Обычная задача',
    'Срочно сдать отчёт <важный> & «большой» завтра в 10:00 !!\nподробности <b>не тег</b>\n- пункт & один\n- пункт <два>',
    'Витамины каждый день в 9:00',
    'Отчёт в первый рабочий день месяца',
    'Отчёт 10.11',
    'Работа: задача в проект',
    '#работа @anna поручение руководителю до пятницы',
    'Созвон через 30 минут',
  ];
  for (const s of texts) await handleUpdate(env, me.text(s), 'https://bot.example');

  // собираем все кнопки из всех сообщений и нажимаем каждую по разу (опасные — в конце)
  const seen = new Set();
  const danger = /delok|^P:[xk]|^P:l|^r:/;
  const collect = () => {
    const out = [];
    for (const c of calls) {
      const kb = c.body.reply_markup && c.body.reply_markup.inline_keyboard;
      if (!kb) continue;
      for (const row of kb) for (const b of row) if (b.callback_data && !seen.has(b.callback_data)) out.push({ data: b.callback_data, msg: c.body.message_id || 777 });
    }
    return out;
  };
  for (let round = 0; round < 6; round++) {
    const batch = collect().filter(x => !danger.test(x.data));
    if (!batch.length) break;
    for (const x of batch) {
      if (seen.has(x.data)) continue;
      seen.add(x.data);
      await handleUpdate(env, me.tap(x.data, x.msg), 'https://bot.example');
    }
  }
  for (const x of collect()) {
    if (seen.has(x.data)) continue;
    seen.add(x.data);
    await handleUpdate(env, me.tap(x.data, x.msg), 'https://bot.example');
  }
  // и команды / кнопки меню
  for (const s of ['/list', '/today', '/done', '/repeat', '/focus', '/week', '/projects', '/invite', '/status', '/pin', '/board', '/help',
    '📋 Мои задачи', '⭐ Главное на сегодня', '📁 Проекты', '🗂 Доска', '❓ Помощь', 'удали', 'готово', 'перенеси', 'в пятницу', '10.11']) {
    await handleUpdate(env, me.text(s), 'https://bot.example');
  }
  // и расписание на всякий случай через сутки
  for (const iso of ['2026-10-01T06:05:00Z', '2026-10-01T09:05:00Z', '2026-10-01T17:05:00Z', '2026-10-04T16:05:00Z']) await runCron(env, at(iso));
  assert.ok(seen.size > 60, `нажато кнопок: ${seen.size}`);
});
