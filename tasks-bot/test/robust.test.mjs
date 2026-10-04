// Надёжность: гонки, лимиты Cloudflare, ошибки, все кнопки подряд
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { fakeTelegram, fakeD1, makeEnv, person, tasksOf, lastCardMsg, errors } from './helpers.mjs';

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
  let now = new Date('2026-09-30T09:00:00Z');
  const env = makeEnv({ _clock: () => now });
  const boss = person(500, 'Анна', 'anna');
  const me = person(501, 'Рина', 'rina');
  await handleUpdate(env, me.text('/start'), 'https://bot.example');
  await handleUpdate(env, me.text('создай проект Работа'), 'https://bot.example');
  const code = (await env.DB.prepare('SELECT code FROM projects').first()).code;
  await handleUpdate(env, boss.text('/start join_' + code), 'https://bot.example');
  const ICS_URL = 'https://calendar.yandex.ru/export/ics.xml?private_token=t';
  globalThis.__ics = { [ICS_URL]: ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Планёрка <важная> & срочная', 'DTSTART;TZID=Europe/Moscow:20260105T100000',
    'DTEND;TZID=Europe/Moscow:20260105T103000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TH', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') };
  await handleUpdate(env, me.text(ICS_URL), 'https://bot.example');
  await handleUpdate(env, me.text(undefined, { photo: [{ file_id: 'ph' }], caption: 'Фото чека' }), 'https://bot.example');
  const texts = [
    'Отчёт начать завтра дедлайн в пятницу',
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

  await handleUpdate(env, me.text('Позвонить маме завтра в 9:30'), 'https://bot.example');

  // собираем кнопки из всех сообщений — каждую нажимает тот, кому она пришла.
  // Свежая кнопка не должна отвечать «не нашёл / устарело»: это значит, что она ведёт в никуда.
  const people = { [me.id]: me, [boss.id]: boss };
  // Рина владеет всеми задачами — у неё ни одна свежая кнопка не может «потеряться».
  // Анна может законно потерять доступ, когда Рина забирает задачу обратно, — тогда бот объясняет это словами.
  const DEAD = /не найден|Не нашёл эту встречу|меню устарело|Ссылка-приглашение устарела|Этой задачи больше нет/i;
  const DEAD_OWNER = /больше не доступна/;
  const seen = new Set();
  const danger = /delok|^P:[xk]|^P:l|^r:|^M:off/;
  const collect = () => {
    const out = [];
    for (const c of calls) {
      const kb = c.body.reply_markup && c.body.reply_markup.inline_keyboard;
      const who = people[c.body.chat_id];
      if (!kb || !who) continue;
      const msg = c.body.message_id || (c.result && c.result.message_id) || 777;
      for (const row of kb) for (const b of row) {
        const key = who.id + '|' + b.callback_data;
        if (b.callback_data && !seen.has(key)) out.push({ key, data: b.callback_data, msg, who, from: (c.body.text || '').slice(0, 60) });
      }
    }
    return out;
  };
  const press = async (x, checkDead) => {
    if (seen.has(x.key)) return;
    seen.add(x.key);
    const before = calls.length;
    await handleUpdate(env, x.who.tap(x.data, x.msg), 'https://bot.example');
    if (!checkDead) return;
    const reply = calls.slice(before).find(c => DEAD.test(c.body.text || '') || (x.who === me && DEAD_OWNER.test(c.body.text || '')));
    assert.ok(!reply, `кнопка «${x.data}» из сообщения «${x.from}» ведёт в никуда: ${reply && reply.body.text}`);
  };
  const crawl = async () => {
    for (let round = 0; round < 8; round++) {
      const batch = collect().filter(x => !danger.test(x.data));
      if (!batch.length) break;
      for (const x of batch) await press(x, true);
    }
  };
  await crawl();
  // Сообщения по расписанию тоже несут кнопки: напоминания, сводки, встречи, закрытие дня, «не отстану».
  // Часы идут вперёд, и кнопки нажимаются сразу после прихода — как это делает человек.
  for (const iso of ['2026-10-01T05:05:00Z', '2026-10-01T06:05:00Z', '2026-10-01T06:20:00Z', '2026-10-01T06:47:00Z', '2026-10-01T07:35:00Z',
    '2026-10-01T09:05:00Z', '2026-10-01T15:05:00Z', '2026-10-01T17:05:00Z', '2026-10-04T16:05:00Z', '2026-10-05T05:05:00Z']) {
    now = at(iso);
    await runCron(env, now);
    await crawl();
  }
  for (const x of collect()) await press(x, false);
  // и команды / кнопки меню
  for (const s of ['/meetings', '/calendar', '📅 Встречи', '/list', '/today', '/done', '/repeat', '/focus', '/week', '/projects', '/invite', '/status', '/pin', '/board', '/help',
    '📋 Мои задачи', '⭐ Главное на сегодня', '📁 Проекты', '🗂 Доска', '❓ Помощь', 'удали', 'готово', 'перенеси', 'в пятницу', '10.11']) {
    await handleUpdate(env, me.text(s), 'https://bot.example');
  }
  for (const iso of ['2026-10-06T06:05:00Z', '2026-10-06T17:05:00Z']) { now = at(iso); await runCron(env, now); }
  assert.ok(seen.size > 90, `нажато кнопок: ${seen.size}`);
  globalThis.__ics = {};
});

// ── Неделя жизни: расписание каждые 5 минут, на каждую пришедшую кнопку нажимают сразу ──
// Так проверяются кнопки напоминаний, «Не отстану», «Жду ответа», встреч, сводок и закрытия дня —
// в том виде и в тот момент, когда их получает человек.
test('неделя по расписанию: все кнопки из всех сообщений работают', async () => {
  const calls = fakeTelegram();
  let now = new Date('2026-09-30T19:00:00Z'); // среда, 22:00 МСК
  const env = makeEnv({ _clock: () => now });
  const me = person(701, 'Рина', 'rina');
  const boss = person(700, 'Анна', 'anna');
  const say = (who, text) => handleUpdate(env, who.text(text), 'https://bot.example');
  await say(boss, '/start');
  await say(boss, '/newproject Работа');
  const code = (await env.DB.prepare('SELECT code FROM projects').first()).code;
  await say(me, '/start join_' + code);
  const ICS_URL = 'https://calendar.yandex.ru/export/ics.xml?private_token=two-days';
  globalThis.__ics = { [ICS_URL]: ['BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:plan', 'SUMMARY:Планёрка', 'DTSTART;TZID=Europe/Moscow:20260105T100000', 'DTEND;TZID=Europe/Moscow:20260105T103000', 'RRULE:FREQ=DAILY', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:bank', 'SUMMARY:Созвон с банком', 'DTSTART:20261001T130000Z', 'DTEND:20261001T140000Z', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n') };
  await say(me, ICS_URL);
  const addDay = async () => {
    for (const t of ['Позвонить маме сегодня в 15:00', 'Отчёт сегодня', 'Оплатить счёт завтра в 11:00', 'Жду ответа от Пети по договору',
      'Купить хлеб', 'Витамины каждый день в 9:00', 'Разобрать почту сегодня']) await say(me, t);
    await say(boss, 'Работа: @Рина сверить акты сегодня');
    const nagT = (await tasksOf(env)).filter(t => !t.done && t.title === 'Разобрать почту').pop();
    await handleUpdate(env, me.tap(`a:${nagT.id}:nag`, 1), 'https://bot.example');
  };

  const people = { [me.id]: me, [boss.id]: boss };
  const DEAD = /не найден|Не нашёл эту встречу|меню устарело|Ссылка-приглашение устарела|Этой задачи больше нет/i;
  // днём человек откладывает и переносит, но не закрывает задачи — иначе к вечеру нечего «закрывать»
  const finishing = /:done$|:wx$|^E:all$|^D:y$|:nag$/;
  const danger = /delok|^P:[xk]|^P:l|^r:|^M:off/;
  const seen = new Set();
  const prefixes = new Set();
  let scanned = 0;
  const pending = [];
  const collect = () => {
    for (; scanned < calls.length; scanned++) {
      const c = calls[scanned];
      const kb = c.body.reply_markup && c.body.reply_markup.inline_keyboard;
      const who = people[c.body.chat_id];
      if (!kb || !who) continue;
      const msg = c.body.message_id || (c.result && c.result.message_id) || 777;
      for (const row of kb) for (const b of row) {
        if (!b.callback_data) continue;
        prefixes.add(b.callback_data.split(':')[0]);
        const key = who.id + '|' + b.callback_data;
        if (!seen.has(key)) pending.push({ key, data: b.callback_data, msg, who, from: (c.body.text || '').slice(0, 60) });
      }
    }
    return pending.filter(x => !seen.has(x.key));
  };
  const crawl = async (skip) => {
    for (let round = 0; round < 6; round++) {
      const batch = collect().filter(x => !danger.test(x.data) && !(skip && skip.test(x.data)));
      if (!batch.length) break;
      for (const x of batch) {
        if (seen.has(x.key)) continue;
        seen.add(x.key);
        const before = calls.length;
        await handleUpdate(env, x.who.tap(x.data, x.msg), 'https://bot.example');
        // «больше не доступна» законно, только если задачу забрал её автор; автору — никогда
        const tid = (x.data.match(/^\w:(\d+):/) || [])[1];
        const row = tid && await env.DB.prepare('SELECT owner_id FROM tasks WHERE id = ?').bind(+tid).first();
        const bad = calls.slice(before).find(c => DEAD.test(c.body.text || '') || (row && row.owner_id === x.who.id && /больше не доступна/.test(c.body.text || '')));
        assert.ok(!bad, `${now.toISOString()}: кнопка «${x.data}» из «${x.from}» ведёт в никуда: ${bad && bad.body.text}`);
      }
    }
  };

  const end = new Date('2026-10-08T20:00:00Z').getTime();
  for (let ms = now.getTime(); ms <= end; ms += 5 * 60e3) {
    now = new Date(ms);
    const msk = new Date(ms + 3 * 3600e3).toISOString().slice(11, 16);
    if (msk === '07:00') await addDay();
    if (msk === '12:25') { // горит прямо сейчас и «не отстану» — придёт в этом же запуске
      await say(me, 'Перезвонить в банк сегодня в 12:00');
      const t = (await tasksOf(env)).filter(x => !x.done && x.title === 'Перезвонить в банк').pop();
      await handleUpdate(env, me.tap(`a:${t.id}:nag`, 1), 'https://bot.example');
    }
    await runCron(env, now);
    // вечером закрываем день — тогда и нажимаем «готово» / «всё на завтра»
    await crawl(msk >= '20:00' ? null : finishing);
  }
  await crawl(null);
  for (const x of collect()) {
    if (seen.has(x.key)) continue;
    seen.add(x.key);
    await handleUpdate(env, x.who.tap(x.data, x.msg), 'https://bot.example');
  }
  for (const p of ['a', 'e', 'M', 'n', 'W', 'E', 'h', 'f']) assert.ok(prefixes.has(p), `кнопки «${p}:» ни разу не пришли — сценарий их не проверил`);
  for (const re of [/\|a:\d+:meet$/, /\|a:\d+:mt[a-z0-9]+$/, /\|M:t:/, /\|M:l:/]) assert.ok([...seen].some(k => re.test(k)), `не нажата ни одна кнопка ${re}`);
  assert.ok(seen.size > 150, `нажато кнопок: ${seen.size}`);
  globalThis.__ics = {};
});

// ── Нагрузка на базу: на бесплатном D1 — 5 млн прочитанных и 100 тыс. записанных строк в сутки ──
// Сутки жизни троих людей с годом истории и календарём. Если правка снова начнёт переписывать календарь
// каждые 15 минут или читать всю историю задач каждые 5 минут — этот тест упадёт.
test('нагрузка: сутки работы укладываются в бесплатный тариф с большим запасом', async () => {
  fakeTelegram();
  const stats = { read: 0, written: 0, scans: {} };
  let now = new Date('2026-09-30T06:00:00Z');
  const env = makeEnv({ DB: fakeD1(stats), _clock: () => now });
  const ICS = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:d', 'SUMMARY:Планёрка', 'DTSTART;TZID=Europe/Moscow:20260105T100000', 'DURATION:PT1H',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'DTSTAMP:20261001T000000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const people = [0, 1, 2].map(i => person(1100 + i, 'Человек ' + i));
  globalThis.__ics = {};
  for (const [i, p] of people.entries()) {
    await handleUpdate(env, p.text('/start'));
    const url = `https://calendar.yandex.ru/export/ics.xml?private_token=load${i}`;
    globalThis.__ics[url] = ICS;
    await handleUpdate(env, p.text(url));
    for (let k = 0; k < 20; k++) await handleUpdate(env, p.text(`Задача ${k} ${['завтра', 'в пятницу', '', 'каждый понедельник'][k % 4]}`));
    env.DB.raw.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 1000)
      INSERT INTO tasks (owner_id, project_id, assignee_id, done, done_at, data) SELECT ${p.id}, NULL, ${p.id}, 1, '2026-01-01', '{"title":"старая","notes":[],"checklist":[]}' FROM n`);
  }
  const start = now.getTime();
  for (let k = 0; k < 288 * 2; k++) {
    now = new Date(start + k * 5 * 60e3);
    if (k === 288) { stats.read = 0; stats.written = 0; stats.scans = {}; stats.writes = {}; } // считаем вторые сутки
    await runCron(env, now);
    if (k % 12 === 3) for (const p of people) {
      await handleUpdate(env, p.text('Новая задача завтра в 10'));
      const t = await env.DB.prepare('SELECT id FROM tasks WHERE assignee_id = ? AND done = 0 ORDER BY id DESC LIMIT 1').bind(p.id).first();
      await handleUpdate(env, p.tap(`a:${t.id}:done`, 5));
    }
  }
  const perPerson = { read: stats.read / people.length, written: stats.written / people.length };
  assert.ok(!stats.scans.tasks, `проверка по расписанию читает всю таблицу задач: ${JSON.stringify(stats.scans)}`);
  assert.ok(!stats.scans.events, `проверка по расписанию читает всю таблицу встреч: ${JSON.stringify(stats.scans)}`);
  assert.ok(perPerson.written < 2000, `записей на человека в сутки: ${Math.round(perPerson.written)} ${JSON.stringify(stats.writes)}`);
  assert.ok(perPerson.read < 40000, `прочитано строк на человека в сутки: ${Math.round(perPerson.read)}`);
  // раз в сутки окно встреч сдвигается на день — одна перезапись в сутки нормальна, а каждые 15 минут — нет
  assert.ok((stats.writes.events || 0) / people.length < 400, `календарь переписывается без изменений: ${stats.writes.events}`);
  globalThis.__ics = {};
});

test('календарь: без изменений в базу не пишем, изменения доходят сразу', async () => {
  fakeTelegram();
  const stats = { read: 0, written: 0, scans: {} };
  let now = new Date('2026-09-30T09:00:00Z');
  const env = makeEnv({ DB: fakeD1(stats), _clock: () => now });
  const me = person(1200, 'Рина');
  const url = 'https://calendar.yandex.ru/export/ics.xml?private_token=chg';
  const ev = (uid, sum, start) => ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${sum}`, `DTSTART;TZID=Europe/Moscow:${start}`, 'DURATION:PT1H', 'END:VEVENT'];
  globalThis.__ics = { [url]: ['BEGIN:VCALENDAR', ...ev('a', 'Созвон', '20261001T100000'), 'END:VCALENDAR'].join('\r\n') };
  await handleUpdate(env, me.text('/start'));
  await handleUpdate(env, me.text(url));
  const titles = async () => (await env.DB.prepare('SELECT title FROM events ORDER BY start').all()).results.map(r => r.title);
  assert.deepEqual(await titles(), ['Созвон']);
  stats.writes = {};
  now = new Date('2026-09-30T09:20:00Z');
  await runCron(env, now);
  assert.ok(!stats.writes.events, 'календарь не менялся — встречи не переписаны');
  globalThis.__ics[url] = ['BEGIN:VCALENDAR', ...ev('a', 'Созвон (перенесли)', '20261001T110000'), ...ev('b', 'Новая встреча', '20261002T120000'), 'END:VCALENDAR'].join('\r\n');
  now = new Date('2026-09-30T09:40:00Z');
  await runCron(env, now);
  assert.deepEqual(await titles(), ['Созвон (перенесли)', 'Новая встреча']);
  // и кнопка «🔄 Обновить календарь» тоже видит изменения
  globalThis.__ics[url] = ['BEGIN:VCALENDAR', ...ev('b', 'Новая встреча', '20261002T120000'), 'END:VCALENDAR'].join('\r\n');
  await handleUpdate(env, me.tap('M:r', 1));
  assert.deepEqual(await titles(), ['Новая встреча']);
  globalThis.__ics = {};
});

test('база не приняла индекс — бот всё равно отвечает и присылает меню', async () => {
  const calls = fakeTelegram();
  const db = fakeD1();
  // Cloudflare D1 мог бы отвергнуть частичный индекс — имитируем это
  const prepare = db.prepare;
  db.prepare = sql => {
    if (/WHERE done = 0\s*$/.test(sql) && /CREATE INDEX/.test(sql)) return { bind() { return this; }, run: async () => { throw new Error('unsupported'); }, _exec() { throw new Error('unsupported'); } };
    return prepare(sql);
  };
  const env = makeEnv({ DB: db });
  const me = person(1300, 'Рина');
  const origError = errors.length;
  await handleUpdate(env, me.text('/start'), 'https://bot.example');
  await handleUpdate(env, me.text('Позвонить маме завтра'), 'https://bot.example');
  assert.equal((await tasksOf(env)).length, 1, 'задача сохранилась');
  assert.ok(calls.some(c => c.body.reply_markup && c.body.reply_markup.keyboard), 'нижнее меню пришло');
  assert.ok(errors.slice(origError).some(e => /schema/.test(e)), 'в лог записано, что индекс пропущен');
  errors.length = origError; // это ожидаемая запись в лог, а не ошибка теста
});
