import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { fakeTelegram, makeEnv, person, tasksOf, lastCardMsg } from './helpers.mjs';

const { handleUpdate, runCron } = worker._internal;
const at = (iso) => new Date(iso);

test('личная задача: чек-лист, подробности, перенос, готово, закреплённый список', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(1, 'Рина', 'rina');

  await handleUpdate(env, me.text('Подготовить презентацию до пятницы !!\nслайды про Q3\n- цифры продаж\n- план'));
  let [t] = await tasksOf(env);
  assert.equal(t.title, 'Подготовить презентацию');
  assert.equal(t.high, true);
  assert.equal(t.notes[0].text, 'слайды про Q3');
  assert.deepEqual(t.checklist.map(c => c.text), ['цифры продаж', 'план']);
  assert.ok(calls.some(c => c.method === 'pinChatMessage'), 'список закреплён');

  const card = await lastCardMsg(env, 1, t.id);
  await handleUpdate(env, me.reply(card, 'Маша пришлёт цифры в четверг\n- согласовать с Олегом'));
  [t] = await tasksOf(env);
  assert.equal(t.notes.at(-1).text, 'Маша пришлёт цифры в четверг');
  assert.equal(t.checklist.length, 3);

  await handleUpdate(env, me.reply(card, 'завтра 15:00'));
  [t] = await tasksOf(env);
  assert.deepEqual(t.due, { date: '2026-10-01', time: '15:00' });

  await handleUpdate(env, me.tap(`a:${t.id}:ck0`, card));
  [t] = await tasksOf(env);
  assert.equal(t.checklist[0].done, true);

  calls.length = 0;
  await handleUpdate(env, me.text('/list'));
  assert.match(calls.texts().join('\n'), /Подготовить презентацию.*☑1\/3/);

  await handleUpdate(env, me.tap(`a:${t.id}:done`, card));
  [t] = await tasksOf(env);
  assert.equal(t.done, true);
});

test('регулярные: готово переносит, пропуск, ответ «каждую пятницу»', async () => {
  fakeTelegram();
  const env = makeEnv();
  const me = person(2, 'Рина');
  await handleUpdate(env, me.text('Оплатить интернет каждое 10 число'));
  let [t] = await tasksOf(env);
  assert.equal(t.due.date, '2026-10-10');
  await handleUpdate(env, me.tap(`a:${t.id}:done`));
  [t] = await tasksOf(env);
  assert.equal(t.done, false);
  assert.equal(t.due.date, '2026-11-10');
  assert.deepEqual(t.history, ['2026-09-30']);
  await handleUpdate(env, me.tap(`a:${t.id}:skip`));
  [t] = await tasksOf(env);
  assert.equal(t.due.date, '2026-12-10');

  await handleUpdate(env, me.text('Отчёт'));
  const o = (await tasksOf(env))[1];
  await handleUpdate(env, me.reply(await lastCardMsg(env, 2, o.id), 'каждую пятницу'));
  assert.deepEqual((await tasksOf(env))[1].repeat.wd, [5]);
  await handleUpdate(env, me.reply(await lastCardMsg(env, 2, o.id), 'не повторять'));
  assert.equal((await tasksOf(env))[1].repeat, undefined);
});

test('напоминания: за час, в срок, «отложить»', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(3, 'Рина');
  await handleUpdate(env, me.text('Созвон с банком 12.10 15:00'));
  calls.length = 0;
  await runCron(env, at('2026-10-12T11:05:00Z')); // 14:05 МСК
  const soon = calls.find(c => /До срока 1 час/.test(c.body.text || ''));
  assert.ok(soon);
  assert.match(JSON.stringify(soon.body.reply_markup), /s1h/, 'на напоминании есть кнопки «отложить»');

  const [t] = await tasksOf(env);
  await handleUpdate(env, me.tap(`a:${t.id}:s1h`, 555, soon.body.reply_markup));
  const [t2] = await tasksOf(env);
  assert.deepEqual(t2.remindAt, { date: '2026-09-30', time: '13:00' }); // «сейчас» в тестах — 30.09 12:00

  calls.length = 0;
  await runCron(env, at('2026-10-12T12:00:00Z')); // 15:00 МСК: срок + отложенное
  assert.ok(calls.some(c => /Время пришло/.test(c.body.text || '')));
  assert.ok(calls.some(c => /Напоминаю/.test(c.body.text || '')));
  assert.equal((await tasksOf(env))[0].remindAt, undefined);
});

test('утро: план, выбор 3 главных, старые задачи; вечер: сверка по главным', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(4, 'Рина');
  for (const s of ['Отчёт сегодня', 'Позвонить в банк', 'Купить подарок', 'Разобрать почту', 'Записаться к врачу']) {
    await handleUpdate(env, me.text(s));
  }
  // одна задача «залежалась»: создана 20 дней назад
  env.DB.raw.exec(`UPDATE tasks SET data = json_set(data, '$.createdAt', '2026-09-10') WHERE id = 2`);

  calls.length = 0;
  await runCron(env, at('2026-10-01T06:05:00Z')); // 09:05 МСК
  const texts = calls.texts().join('\n---\n');
  assert.match(texts, /Доброе утро/);
  assert.match(texts, /Выбери до 3 главных/);
  assert.match(texts, /Лежит без срока больше двух недель[\s\S]*Позвонить в банк/);
  const staleCards = calls.filter(c => c.method === 'sendMessage' && /:wk"/.test(JSON.stringify(c.body.reply_markup || '')));
  assert.equal(staleCards.length, 1, 'спрашиваем только о залежавшейся');

  env._clock = () => at('2026-10-01T07:00:00Z');
  for (const id of [1, 3, 4, 5]) await handleUpdate(env, me.tap(`f:${id}`));
  const u = await env.DB.prepare('SELECT data FROM users WHERE id = 4').first();
  assert.deepEqual(JSON.parse(u.data).focus, { date: '2026-10-01', ids: [1, 3, 4] }, 'больше трёх не выбрать');
  assert.ok(calls.some(c => c.method === 'editMessageText' && /Главное сегодня/.test(c.body.text)), 'в закреплённом списке есть блок главного');

  await handleUpdate(env, me.tap('a:1:done'));
  calls.length = 0;
  await runCron(env, at('2026-10-01T17:05:00Z')); // 20:05 МСК
  const ev = calls.find(c => /Вечерняя сверка/.test(c.body.text || ''));
  assert.ok(ev);
  assert.match(ev.body.text, /✅ Отчёт/);
  assert.match(ev.body.text, /⬜ Купить подарок/);
  assert.match(JSON.stringify(ev.body.reply_markup), /e:3:tom/);

  env._clock = () => at('2026-10-01T17:10:00Z');
  await handleUpdate(env, me.tap('e:3:tom', 777));
  assert.equal((await tasksOf(env))[2].due.date, '2026-10-02');

  // «ещё актуально» на залежавшейся
  await handleUpdate(env, me.tap('a:2:ok'));
  assert.equal((await tasksOf(env))[1].reviewedAt, '2026-10-01');
});

test('итоги недели в воскресенье', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(5, 'Рина');
  await handleUpdate(env, me.text('Сдать отчёт'));
  await handleUpdate(env, me.tap('a:1:done'));
  await handleUpdate(env, me.text('Планёрка в понедельник'));
  calls.length = 0;
  await runCron(env, at('2026-10-04T16:05:00Z')); // вс 19:05 МСК
  const w = calls.find(c => /Итоги недели/.test(c.body.text || ''));
  assert.ok(w);
  assert.match(w.body.text, /Сделано: <b>1<\/b>[\s\S]*Сдать отчёт/);
  assert.match(w.body.text, /На следующей неделе[\s\S]*Планёрка/);
});

test('голосовое → задача', async () => {
  const calls = fakeTelegram();
  const env = makeEnv({ AI: { run: async (model, input) => { assert.equal(input.language, 'ru'); return { text: 'Напомни позвонить маме завтра в 10 утра.' }; } } });
  const me = person(6, 'Рина');
  await handleUpdate(env, me.voice());
  const [t] = await tasksOf(env);
  assert.equal(t.title, 'Позвонить маме');
  assert.deepEqual(t.due, { date: '2026-10-01', time: '10:00' });
  assert.ok(calls.texts().some(s => s.includes('🎙')));

  const env2 = makeEnv();
  const c2 = fakeTelegram();
  await handleUpdate(env2, me.voice());
  assert.match(c2.texts()[0], /Workers AI/);
});

test('справка: меню разделов, примеры копируются, переходы', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(7, 'Рина Иванова', 'rina_k');
  await handleUpdate(env, me.text('/help'));
  const menu = calls.find(c => c.method === 'sendMessage' && /Я — твой список задач/.test(c.body.text));
  assert.ok(menu);
  assert.match(menu.body.text, /<code>Проверить бота завтра в 10:00<\/code>/);
  const keys = menu.body.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  assert.equal(keys.length, 13);
  assert.ok(keys.includes('O:menu'), 'из справки — в настройки');

  for (const key of keys.filter(k => k.startsWith('h:'))) {
    calls.length = 0;
    await handleUpdate(env, me.tap(key, 555));
    const ed = calls.find(c => c.method === 'editMessageText');
    assert.ok(ed, key);
    const text = ed.body.text;
    assert.ok(text.length < 4000, `${key}: ${text.length} символов`);
    for (const tag of ['b', 'i', 'code']) {
      assert.equal((text.match(new RegExp(`<${tag}>`, 'g')) || []).length, (text.match(new RegExp(`</${tag}>`, 'g')) || []).length, `${key}: <${tag}>`);
    }
    assert.match(JSON.stringify(ed.body.reply_markup), /h:menu/);
  }
  // в разделе про проекты — пример с username самого человека
  calls.length = 0;
  await handleUpdate(env, me.tap('h:projects', 555));
  assert.match(calls.find(c => c.method === 'editMessageText').body.text, /Работа: @rina_k подготовить отчёт/);
  calls.length = 0;
  await handleUpdate(env, me.tap('h:menu', 555));
  assert.match(calls.find(c => c.method === 'editMessageText').body.text, /Я — твой список задач/);
});

test('повтор: каждые 2 недели по чт, последний день месяца, первый понедельник', async () => {
  fakeTelegram();
  const env = makeEnv();
  const me = person(8, 'Рина');
  await handleUpdate(env, me.text('Созвон каждые 2 недели по четвергам'));
  await handleUpdate(env, me.text('Табель в последний день месяца'));
  await handleUpdate(env, me.text('Планёрка каждый первый понедельник месяца'));
  let ts = await tasksOf(env);
  assert.equal(ts[0].due.date, '2026-10-01');
  env._clock = () => at('2026-10-01T09:00:00Z');
  await handleUpdate(env, me.tap('a:1:done'));
  assert.equal((await tasksOf(env))[0].due.date, '2026-10-15', 'через две недели, снова четверг');
  env._clock = () => at('2026-09-30T09:00:00Z');
  await handleUpdate(env, me.tap('a:2:done'));
  assert.equal((await tasksOf(env))[1].due.date, '2026-10-31');
  await handleUpdate(env, me.tap('a:2:done'));
  assert.equal((await tasksOf(env))[1].due.date, '2026-11-30', 'последний день ноября');
  await handleUpdate(env, me.tap('a:3:done'));
  assert.equal((await tasksOf(env))[2].due.date, '2026-11-02', 'первый понедельник ноября');
});

test('словами: удали / готово / перенеси, выбор при нескольких, восстановление', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(9, 'Рина');
  for (const s of ['Позвонить маме насчёт дачи', 'Позвонить в банк', 'Отчёт для Анны', 'Купить подарок']) await handleUpdate(env, me.text(s));

  // однозначно — удаляем сразу, с кнопкой «восстановить»
  calls.length = 0;
  await handleUpdate(env, me.text('удали задачу позвонить маме'));
  assert.equal((await tasksOf(env)).length, 3);
  const del = calls.find(c => /Удалено/.test(c.body.text || ''));
  assert.match(JSON.stringify(del.body.reply_markup), /r:1/);
  await handleUpdate(env, me.tap('r:1', 999));
  assert.equal((await tasksOf(env)).length, 4, 'восстановлена');
  assert.equal((await tasksOf(env)).find(t => t.id === 1).title, 'Позвонить маме насчёт дачи');

  // несколько похожих — выбор кнопками
  calls.length = 0;
  await handleUpdate(env, me.text('Отмени позвонить'));
  const pick = calls.find(c => /несколько похожих/.test(c.body.text || ''));
  assert.ok(pick);
  assert.equal(pick.body.reply_markup.inline_keyboard.length, 3); // 2 задачи + «отмена»
  await handleUpdate(env, me.tap('k:2', 998));
  assert.ok(!(await tasksOf(env)).some(t => t.id === 2));

  // готово
  await handleUpdate(env, me.text('Сделала отчёт'));
  assert.equal((await tasksOf(env)).find(t => t.id === 3).done, true);

  // перенеси
  await handleUpdate(env, me.text('перенеси подарок на пятницу 18:00'));
  assert.deepEqual((await tasksOf(env)).find(t => t.id === 4).due, { date: '2026-10-02', time: '18:00' });

  // ответ на карточку одним словом
  const card = await lastCardMsg(env, 9, 4);
  await handleUpdate(env, me.reply(card, 'готово'));
  assert.equal((await tasksOf(env)).find(t => t.id === 4).done, true);

  // не нашли — предлагаем создать как новую задачу
  calls.length = 0;
  await handleUpdate(env, me.text('Отмени подписку на кино'));
  assert.ok(calls.some(c => /Не нашёл задачу/.test(c.body.text || '')));
  await handleUpdate(env, me.tap('k:new', 997));
  assert.ok((await tasksOf(env)).some(t => t.title === 'Отмени подписку на кино'));

  // обычные задачи со словами «удалить», «готовое» не путаем с командами
  await handleUpdate(env, me.text('Удалить старые файлы с диска'));
  await handleUpdate(env, me.text('Готовое платье забрать из ателье'));
  const titles = (await tasksOf(env)).map(t => t.title);
  assert.ok(titles.includes('Удалить старые файлы с диска'));
  assert.ok(titles.includes('Готовое платье забрать из ателье'));
});

test('напоминание о задаче на сегодня без времени, /status, предупреждение без Cron', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(11, 'Рина');
  env._clock = () => at('2026-09-30T06:00:00Z'); // 9:00 МСК
  await handleUpdate(env, me.text('Оплатить квитанцию сегодня'));
  assert.ok(calls.texts().some(s => /Напоминания сейчас не приходят/.test(s)), 'предупреждаем, что Cron ещё не работал');

  calls.length = 0;
  await handleUpdate(env, me.text('/status'));
  assert.match(calls.texts()[0], /не работают/);

  calls.length = 0;
  await runCron(env, at('2026-09-30T08:00:00Z')); // 11:00 — рано
  assert.ok(!calls.some(c => /Сегодня срок/.test(c.body.text || '')));
  await runCron(env, at('2026-09-30T09:05:00Z')); // 12:05
  assert.ok(calls.some(c => /Сегодня срок[\s\S]*Оплатить квитанцию/.test(c.body.text || '')));
  calls.length = 0;
  await runCron(env, at('2026-09-30T09:10:00Z'));
  assert.ok(!calls.some(c => /Сегодня срок/.test(c.body.text || '')), 'второй раз в 12 не шлём');
  await runCron(env, at('2026-09-30T14:05:00Z')); // 17:05
  assert.ok(calls.some(c => /Сегодня срок/.test(c.body.text || '')));

  // задача на сегодня, созданная в 16:00, не звенит «12:00» задним числом, но звенит в 17:00
  env._clock = () => at('2026-09-30T13:00:00Z');
  await handleUpdate(env, me.text('Забрать посылку сегодня'));
  assert.ok(!calls.texts().some(s => /Напоминания сейчас не приходят/.test(s) && /Забрать посылку/.test(s)), 'Cron уже работает — без предупреждения');
  calls.length = 0;
  await runCron(env, at('2026-09-30T13:05:00Z'));
  assert.ok(!calls.some(c => /Сегодня срок[\s\S]*Забрать посылку/.test(c.body.text || '')));
  await runCron(env, at('2026-09-30T14:05:00Z'));
  assert.ok(calls.some(c => /Сегодня срок[\s\S]*Забрать посылку/.test(c.body.text || '')));

  // «через 30 минут» — без «через час», но в срок
  env._clock = () => at('2026-09-30T14:10:00Z');
  await handleUpdate(env, me.text('Проверить духовку через 30 минут'));
  calls.length = 0;
  await runCron(env, at('2026-09-30T14:15:00Z'));
  assert.ok(!calls.some(c => /Через час/.test(c.body.text || '')));
  await runCron(env, at('2026-09-30T14:40:00Z'));
  assert.ok(calls.some(c => /Время пришло[\s\S]*Проверить духовку/.test(c.body.text || '')));

  env._clock = () => at('2026-09-30T14:41:00Z');
  calls.length = 0;
  await handleUpdate(env, me.text('/status'));
  assert.match(calls.texts()[0], /✅ работают/);
});

test('повтор кнопками в чате и дата окончания', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(12, 'Рина');
  await handleUpdate(env, me.text('Созвон с командой в пятницу 11:00')); // 02.10
  const card = await lastCardMsg(env, 12, 1);

  calls.length = 0;
  await handleUpdate(env, { ...me.tap('a:1:rp', card) });
  const menu = calls.find(c => c.method === 'editMessageText');
  const kb = JSON.stringify(menu.body.reply_markup);
  assert.match(kb, /Раз в 2 недели \(пт\)/);
  assert.match(kb, /Каждый месяц \(2 числа\)/);

  await handleUpdate(env, me.tap('a:1:r_w2', card));
  let [t] = await tasksOf(env);
  assert.deepEqual(t.repeat, { unit: 'week', n: 2, wd: [5] });
  assert.deepEqual(t.due, { date: '2026-10-02', time: '11:00' });

  // ограничим повтор датой: после последнего раза задача закрывается
  env.DB.raw.exec(`UPDATE tasks SET data = json_set(data, '$.repeat.until', '2026-10-20')`);
  env._clock = () => at('2026-10-02T09:00:00Z');
  await handleUpdate(env, me.tap('a:1:done', card));
  [t] = await tasksOf(env);
  assert.equal(t.due.date, '2026-10-16');
  assert.equal(t.done, false);
  env._clock = () => at('2026-10-16T09:00:00Z');
  calls.length = 0;
  await handleUpdate(env, me.tap('a:1:done', card));
  [t] = await tasksOf(env);
  assert.equal(t.done, true, 'следующий раз был бы 30.10 — позже «до», задача закрыта');
  assert.ok(calls.some(c => c.method === 'answerCallbackQuery' && /последний раз/.test(c.body.text)));
});

test('«10.11» — бот спрашивает: дата или время', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(13, 'Рина');
  await handleUpdate(env, me.text('Отчёт 10.11'));
  const card = calls.find(c => /Задача сохранена/.test(c.body.text || ''));
  assert.match(card.body.text, /«10\.11» — это дата или время/);
  const kb = JSON.stringify(card.body.reply_markup);
  assert.match(kb, /📅 Дата: 10 ноя/);
  assert.match(kb, /🕐 Время: 10:11/);
  await handleUpdate(env, me.tap('a:1:alt', 777));
  let [t] = await tasksOf(env);
  assert.deepEqual(t.due, { date: '2026-10-01', time: '10:11' });
  assert.equal(t.ambig, undefined);

  await handleUpdate(env, me.text('Налоговая 12.10'));
  await handleUpdate(env, me.tap('a:2:altok', 778));
  t = (await tasksOf(env))[1];
  assert.deepEqual(t.due, { date: '2026-10-12', time: null });
  assert.equal(t.ambig, undefined);

  await handleUpdate(env, me.text('Созвон 15.30'));
  t = (await tasksOf(env))[2];
  assert.deepEqual(t.due, { date: '2026-09-30', time: '15:30' });
  assert.equal(t.ambig, undefined, 'без вопроса, это точно время');
});

test('компактная карточка: одна строка кнопок, остальное в подменю', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(14, 'Рина');
  await handleUpdate(env, me.text('Сходить по компаниям сегодня\n- документы\n- ЭДО'));
  const card = calls.find(c => /Задача сохранена/.test(c.body.text || ''));
  const rows = card.body.reply_markup.inline_keyboard;
  assert.equal(rows.length, 1, 'одна строка');
  assert.deepEqual(rows[0].map(x => x.text), ['✅ Готово', '📅 Срок', '☑ 0/2', '☰ Ещё']);

  calls.length = 0;
  await handleUpdate(env, me.tap('a:1:more', 700));
  assert.match(JSON.stringify(calls.find(c => c.method === 'editMessageText').body.reply_markup), /Повтор.*Проект[\s\S]*Важно.*Удалить/);
  calls.length = 0;
  await handleUpdate(env, me.tap('a:1:check', 700));
  await handleUpdate(env, me.tap('a:1:ck1', 700));
  const ed = calls.filter(c => c.method === 'editMessageText' && c.body.message_id === 700).at(-1);
  assert.match(JSON.stringify(ed.body.reply_markup), /☑ ЭДО/, 'остаёмся в чек-листе');

  // напоминание: готово + отложить в одной строке
  calls.length = 0;
  await runCron(env, at('2026-09-30T09:05:00Z'));
  const rem = calls.find(c => /Сегодня срок/.test(c.body.text || ''));
  assert.equal(rem.body.reply_markup.inline_keyboard.length, 1);
  assert.match(JSON.stringify(rem.body.reply_markup), /s1h/);

  // не понял повтор — говорим об этом
  calls.length = 0;
  await handleUpdate(env, me.text('Каждый раз проверять почту'));
  assert.ok(calls.texts().some(s => /не понял, как повторять/.test(s)));
});

test('повтор из меню «Срок», «1-й рабочий день», меню внизу приходит само', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(15, 'Рина');
  await handleUpdate(env, me.text('Отчёт для Новодворского'), 'https://bot.example');
  // меню внизу пришло само, один раз
  const kbMsgs = () => calls.filter(c => c.body.reply_markup && c.body.reply_markup.keyboard);
  assert.equal(kbMsgs().length, 1);
  const kb = kbMsgs()[0].body.reply_markup.keyboard;
  assert.deepEqual(kb.map(r => r.map(b => b.text)), [['📋 Задачи', '⭐ Главное', '📅 Встречи'], ['📁 Проекты', '🗂 Доска', '❓ Помощь']], 'меню — две строки по три');
  await handleUpdate(env, me.text('Ещё задача'), 'https://bot.example');
  assert.equal(kbMsgs().length, 1, 'второй раз не шлём');

  calls.length = 0;
  await handleUpdate(env, me.tap('a:1:due', 800), 'https://bot.example');
  assert.match(JSON.stringify(calls.find(c => c.method === 'editMessageText').body.reply_markup), /a:1:rp/);
  await handleUpdate(env, me.tap('a:1:rp', 800), 'https://bot.example');
  await handleUpdate(env, me.tap('a:1:r_wd1', 800), 'https://bot.example');
  const [t] = await tasksOf(env);
  assert.deepEqual(t.repeat, { unit: 'month', n: 1, wday: 1 });
  assert.equal(t.due.date, '2026-10-01');

  // новый проект — через «📁 Проекты» → «➕ Создать проект»
  calls.length = 0;
  await handleUpdate(env, me.text('📁 Проекты'), 'https://bot.example');
  assert.match(JSON.stringify(calls.map(c => c.body.reply_markup)), /P:new/);
  await handleUpdate(env, me.tap('P:new', 801), 'https://bot.example');
  assert.ok(calls.some(c => /Как назвать проект/.test(c.body.text || '')));
  // каждая кнопка меню работает, и старые подписи (у кого меню ещё прежнее) — тоже
  for (const label of ['📋 Задачи', '⭐ Главное', '📅 Встречи', '🗂 Доска', '❓ Помощь', '📋 Мои задачи', '⭐ Главное на сегодня', '➕ Новый проект']) {
    await handleUpdate(env, me.text('/start'), 'https://bot.example'); // сброс ожиданий
    const before = (await tasksOf(env)).length;
    calls.length = 0;
    await handleUpdate(env, me.text(label), 'https://bot.example');
    assert.ok(calls.some(c => c.method === 'sendMessage'), `«${label}» ответила`);
    assert.equal((await tasksOf(env)).length, before, `«${label}» не стала задачей`);
  }
});

test('регулярная: случайное «Готово» можно отменить', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(16, 'Рина');
  env._clock = () => at('2026-11-02T09:00:00Z'); // пн, 2 ноября — первый рабочий день
  await handleUpdate(env, me.text('Отчёт в первый рабочий день месяца\n- реестр\n- мотивация'));
  let [t] = await tasksOf(env);
  assert.equal(t.due.date, '2026-11-02');
  await handleUpdate(env, me.tap('a:1:ck0', 900));
  calls.length = 0;
  await handleUpdate(env, me.tap('a:1:done', 900));
  [t] = await tasksOf(env);
  assert.equal(t.due.date, '2026-12-01');
  const ed = calls.find(c => c.method === 'editMessageText' && c.body.message_id === 900);
  assert.match(JSON.stringify(ed.body.reply_markup), /a:1:rundo/, 'кнопка отмены сразу на карточке');
  assert.match(ed.body.text, /последний раз отмечено сегодня/);
  await handleUpdate(env, me.tap('a:1:rundo', 900));
  [t] = await tasksOf(env);
  assert.equal(t.due.date, '2026-11-02');
  assert.equal((t.history || []).length, 0);
  assert.equal(t.checklist[0].done, true, 'чек-лист вернулся как был');
  assert.equal(t.lastDone, undefined);
});

test('новый срок сообщением: после «📅 Срок», «✏️ Своя дата», просто дата', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(17, 'Рина');
  await handleUpdate(env, me.text('С Настей рассылку - сделать папки в четверг'));
  await handleUpdate(env, me.text('Позвонить в банк'));

  // нажала «📅 Срок» и просто написала дату
  await handleUpdate(env, me.tap('a:1:due', 1000));
  await handleUpdate(env, me.text('7 октября в 15.00'));
  let ts = await tasksOf(env);
  assert.deepEqual(ts[0].due, { date: '2026-10-07', time: '15:00' });
  assert.equal(ts.length, 2, 'новая задача не создалась');

  // «✏️ Своя дата»
  calls.length = 0;
  await handleUpdate(env, me.tap('a:2:dueask', 1001));
  assert.ok(calls.some(c => /Напиши новый срок для «<b>Позвонить в банк/.test(c.body.text || '')));
  await handleUpdate(env, me.text('завтра в 10.30'));
  assert.deepEqual((await tasksOf(env))[1].due, { date: '2026-10-01', time: '10:30' });

  // просто дата без меню — спросим, к какой задаче
  calls.length = 0;
  await handleUpdate(env, me.text('в пятницу'));
  const ask = calls.find(c => /Перенести «<b>Позвонить в банк<\/b>» на/.test(c.body.text || ''));
  assert.ok(ask, 'предлагаем последнюю задачу');
  await handleUpdate(env, me.tap('D:y', 1002));
  assert.equal((await tasksOf(env))[1].due.date, '2026-10-02');

  // обычная задача после меню срока — создаётся как задача
  await handleUpdate(env, me.tap('a:1:due', 1000));
  await handleUpdate(env, me.text('Купить корм коту'));
  assert.equal((await tasksOf(env)).length, 3);
});

test('файлы: фото с подписью, альбом в одну задачу, файл ответом на карточку, отправка файлов', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(18, 'Рина');
  const photo = id => ({ photo: [{ file_id: id + '-small' }, { file_id: id }] });
  await handleUpdate(env, me.text(undefined, { ...photo('p1'), caption: 'Чек за такси — сдать в бухгалтерию до пятницы' }));
  let [t] = await tasksOf(env);
  assert.equal(t.title, 'Чек за такси — сдать в бухгалтерию');
  assert.deepEqual(t.files, [{ type: 'photo', id: 'p1', name: 'Фото' }]);

  // альбом из трёх фото — одна задача
  for (const id of ['a1', 'a2', 'a3']) await handleUpdate(env, me.text(undefined, { ...photo(id), media_group_id: 'g1', caption: id === 'a1' ? 'Фото с объекта' : undefined }));
  const ts = await tasksOf(env);
  assert.equal(ts.length, 2);
  assert.equal(ts[1].files.length, 3);

  // документ ответом на карточку
  await handleUpdate(env, me.reply(await lastCardMsg(env, 18, 1), undefined));
  await handleUpdate(env, { ...me.reply(await lastCardMsg(env, 18, 1), undefined), message: { ...me.reply(await lastCardMsg(env, 18, 1), undefined).message, document: { file_id: 'd1', file_name: 'Акт.pdf' } } });
  t = (await tasksOf(env))[0];
  assert.equal(t.files.length, 2);
  assert.equal(t.files[1].name, 'Акт.pdf');

  // ☰ Ещё → 📎 Файлы — бот присылает их
  calls.length = 0;
  await handleUpdate(env, me.tap('a:1:files', 1500));
  assert.deepEqual(calls.map(c => c.method).filter(m => m !== 'answerCallbackQuery'), ['sendPhoto', 'sendDocument']);

  // документ без подписи — название из имени файла
  await handleUpdate(env, me.text(undefined, { document: { file_id: 'd2', file_name: 'Договор аренды.docx' } }));
  assert.equal((await tasksOf(env))[2].title, 'Договор аренды.docx');
});

test('«не отстану», дата начала и статус — кнопками', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(19, 'Рина');
  const boss = person(20, 'Анна');
  await handleUpdate(env, me.text('Отчёт до пятницы'));
  await handleUpdate(env, me.tap('a:1:nag', 1600));
  let [t] = await tasksOf(env);
  assert.equal(t.nag, true);
  await handleUpdate(env, me.tap('a:1:st1', 1600));
  [t] = await tasksOf(env);
  assert.deepEqual(t.start, { date: '2026-10-01', time: null });
  const card = calls.filter(c => c.method === 'editMessageText' && c.body.message_id === 1600).at(-1);
  assert.match(card.body.text, /▶️ начать: завтра[\s\S]*дедлайн: пт/);
  assert.match(card.body.text, /не отстану/);

  // статус в проекте + уведомление автору
  await handleUpdate(env, me.text('создай проект Работа'));
  const code = (await env.DB.prepare('SELECT code FROM projects').first()).code;
  await handleUpdate(env, boss.text('/start join_' + code));
  await handleUpdate(env, boss.text('Работа: @Рина сверить акты'));
  calls.length = 0;
  await handleUpdate(env, me.tap('a:2:s_review', 1601));
  t = (await tasksOf(env))[1];
  assert.equal(t.status, 'review');
  assert.ok(calls.to(20).some(c => /На проверке/.test(c.body.text)), 'автор узнал');
});

test('«не отстану»: каждые полчаса, прошлое сообщение удаляется, кнопки работают', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(21, 'Рина');
  env._clock = () => at('2026-09-30T05:00:00Z'); // 8:00
  await handleUpdate(env, me.text('Позвонить в налоговую сегодня в 10:00 !!'));
  await handleUpdate(env, me.text('Обычная задача сегодня в 10:00'));
  calls.length = 0;
  await runCron(env, at('2026-09-30T07:05:00Z')); // 10:05
  const nags = () => calls.filter(c => /Не отстану — это ещё не сделано/.test(c.body.text || ''));
  assert.equal(nags().length, 1);
  assert.match(nags()[0].body.text, /Позвонить в налоговую/);
  assert.doesNotMatch(nags()[0].body.text, /Обычная задача/, 'обычные — без «не отстану»');
  await runCron(env, at('2026-09-30T07:20:00Z'));
  assert.equal(nags().length, 1, 'раньше получаса — не шлём');
  await runCron(env, at('2026-09-30T07:35:00Z'));
  assert.equal(nags().length, 2);
  assert.ok(calls.some(c => c.method === 'deleteMessage'), 'прошлое удалили');

  // ⏰ +1 час — пауза; ✅ — задача закрыта
  const msgId = 9999;
  env._clock = () => at('2026-09-30T07:36:00Z');
  await handleUpdate(env, me.tap('n:1:s1h', msgId));
  await runCron(env, at('2026-09-30T08:10:00Z'));
  assert.equal(nags().length, 2, 'отложено — молчим');
  env._clock = () => at('2026-09-30T08:40:00Z');
  calls.length = 0;
  await handleUpdate(env, me.tap('n:1:done', msgId));
  assert.equal((await tasksOf(env))[0].done, true);
  assert.ok(calls.some(c => c.method === 'editMessageText' && /молодец/.test(c.body.text)));

  // 🔕 на сегодня
  await handleUpdate(env, me.text('Сдать отчёт сегодня !!'));
  await handleUpdate(env, me.tap('n:0:mute', msgId));
  calls.length = 0;
  await runCron(env, at('2026-09-30T10:00:00Z'));
  assert.equal(nags().length, 0);
});

test('вступления: «Напомни…», «Задача: …» убираются, «Задача по отчёту» — нет', async () => {
  fakeTelegram();
  const env = makeEnv();
  const me = person(22, 'Рина');
  for (const s of ['Напомни позвонить маме', 'Задача: сверить акты', 'Задача по отчёту для банка', 'Задача 1 сегодня', 'Нужно купить корм']) await handleUpdate(env, me.text(s));
  assert.deepEqual((await tasksOf(env)).map(t => t.title), ['Позвонить маме', 'Сверить акты', 'Задача по отчёту для банка', 'Задача 1', 'Купить корм']);
});

test('вечер: «всё несделанное — на завтра» и возврат; словами «перенеси всё на понедельник»', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(23, 'Рина');
  env._clock = () => at('2026-09-30T05:00:00Z');
  await handleUpdate(env, me.text('Отчёт сегодня'));
  await handleUpdate(env, me.text('Звонок сегодня в 15:00'));
  await handleUpdate(env, me.text('Старое 28.09.2026'));
  await handleUpdate(env, me.text('Жду документы от бухгалтерии сегодня'));
  await handleUpdate(env, me.text('Без срока'));
  env.DB.raw.exec(`UPDATE users SET data = json_set(data, '$.lastEvening', '2026-09-29')`);
  calls.length = 0;
  await runCron(env, at('2026-09-30T17:05:00Z')); // 20:05
  const ev = calls.find(c => /Вечерняя сверка/.test(c.body.text || ''));
  assert.match(JSON.stringify(ev.body.reply_markup), /Всё несделанное — на завтра \(3\)/, 'ожидание и без срока не трогаем');
  env._clock = () => at('2026-09-30T17:06:00Z');
  calls.length = 0;
  await handleUpdate(env, me.tap('E:all', 3000));
  let ts = await tasksOf(env);
  assert.deepEqual(ts.slice(0, 3).map(t => t.due), [{ date: '2026-10-01', time: null }, { date: '2026-10-01', time: '15:00' }, { date: '2026-10-01', time: null }]);
  assert.equal(ts[3].due.date, '2026-09-30', 'жду ответа — не перенесли');
  assert.match(calls.find(c => c.method === 'editMessageText' && c.body.message_id === 3000).body.text, /Перенесено на завтра: 3/);
  await handleUpdate(env, me.tap('E:undo', 3000));
  ts = await tasksOf(env);
  assert.equal(ts[2].due.date, '2026-09-28', 'вернули как было');

  await handleUpdate(env, me.text('перенеси всё на понедельник'));
  ts = await tasksOf(env);
  assert.ok(ts.slice(0, 3).every(t => t.due.date === '2026-10-05'));
});

test('«жду ответа»: кнопкой и словом «Жду …», утром спрашиваю, «пришёл» возвращает в работу', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(24, 'Рина');
  await handleUpdate(env, me.text('Жду договор от юристов'));
  await handleUpdate(env, me.text('Согласовать смету'));
  let ts = await tasksOf(env);
  assert.deepEqual(ts[0].waiting, { since: '2026-09-30', check: '2026-10-03' });
  await handleUpdate(env, me.tap('a:2:wait', 3100));
  await handleUpdate(env, me.tap('a:2:w1', 3100));
  ts = await tasksOf(env);
  assert.equal(ts[1].waiting.check, '2026-10-01');

  // в закреплённом списке — отдельная группа
  calls.length = 0;
  await handleUpdate(env, me.text('/list'));
  assert.match(calls.texts()[0], /⏳ Жду ответа[\s\S]*Жду договор[\s\S]*Согласовать смету/);

  // 1 октября утром — спрашиваю только про смету
  env.DB.raw.exec(`UPDATE users SET data = json_set(data, '$.lastMorning', '2026-09-30')`);
  calls.length = 0;
  await runCron(env, at('2026-10-01T06:05:00Z'));
  const ask = calls.find(c => /Пришёл ли ответ/.test(c.body.text || ''));
  assert.ok(ask);
  assert.match(ask.body.text, /Согласовать смету/);
  assert.doesNotMatch(ask.body.text, /договор/);
  assert.match(ask.body.text, /<code>Добрый день! Напоминаю про/);
  calls.length = 0;
  await handleUpdate(env, me.tap('W:2:wx', 3200));
  ts = await tasksOf(env);
  assert.equal(ts[1].waiting, undefined);
  assert.ok(calls.some(c => /Ответ получен/.test(c.body.text || '')));
});

test('несуществующая дата: бот объясняет, а не создаёт задачу «31 сентября»', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(990, 'Рина');
  await handleUpdate(env, me.text('/start'));
  calls.length = 0;
  await handleUpdate(env, me.text('31 сентября'));
  assert.ok(calls.some(c => /«31 сентября» — такой даты или времени не бывает/.test(c.body.text || '')));
  assert.equal((await tasksOf(env)).length, 0, 'задачу не создали');
  await handleUpdate(env, me.text('Отчёт 31 сентября'));
  assert.ok(calls.some(c => /⚠️ «31 сентября» — такой даты или времени не бывает, поэтому срок не поставил/.test(c.body.text || '')));
  const [t] = await tasksOf(env);
  assert.equal(t.due, null);
  // «📅 Срок» → «своя дата» → опечатка: бот просит исправить и ждёт дальше
  await handleUpdate(env, me.tap(`a:${t.id}:dueask`, 1));
  await handleUpdate(env, me.text('30 февраля'));
  assert.equal((await tasksOf(env)).length, 1, 'опечатка не стала новой задачей');
  await handleUpdate(env, me.text('5 октября'));
  assert.equal((await tasksOf(env))[0].due.date, '2026-10-05');
  calls.length = 0;
  await handleUpdate(env, me.text('перенеси отчёт на 31 сентября'));
  assert.ok(calls.some(c => /такой даты или времени не бывает/.test(c.body.text || '')));
});

// ── Подробности: убрать целиком или по строке (ответом на карточку и кнопками) ──
test('ответ на карточку «убери детали», «убери <строку>», «удали чек-лист» и «↩️ Вернуть»', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(995, 'Рина');
  await handleUpdate(env, me.text('/start'));
  await handleUpdate(env, me.text('Проверка документов по нашим компаниям в последний рабочий день месяца'));
  const [t0] = await tasksOf(env);
  const card = await lastCardMsg(env, me.id, t0.id);
  await handleUpdate(env, me.reply(card, 'Опен Сервис СПБ ООО\nИП Довбенко Леонид Сергеевич\nАльфа Политех ООО (Open Service)\nГЕТ Ит, ООО'));
  await handleUpdate(env, me.reply(card, '- сверить акты\n- подписать'));
  let t = (await tasksOf(env))[0];
  assert.equal(t.notes.length, 1);
  assert.equal(t.checklist.length, 2);

  // одна строка
  calls.length = 0;
  await handleUpdate(env, me.reply(card, 'убери Альфа Политех'));
  t = (await tasksOf(env))[0];
  assert.doesNotMatch(t.notes[0].text, /Альфа/);
  assert.match(t.notes[0].text, /Довбенко[\s\S]*ГЕТ Ит/);
  assert.ok(calls.some(c => /🗑 Убрал: «Альфа Политех ООО \(Open Service\)»/.test(c.body.text || '')));
  assert.ok(!calls.some(c => /Не нашёл задачу/.test(c.body.text || '')), 'не ищет задачу «Альфа Политех»');

  // несколько совпадений — показывает строки кнопками
  calls.length = 0;
  await handleUpdate(env, me.reply(card, 'убери ООО'));
  const pick = calls.find(c => /Нашёл несколько строк с «ООО»/.test(c.body.text || ''));
  assert.ok(pick);
  assert.match(JSON.stringify(pick.body.reply_markup), /✖ Опен Сервис СПБ ООО/);
  assert.equal((await tasksOf(env))[0].notes[0].text.split('\n').length, 3, 'ничего не удалено без выбора');

  // все подробности — и вернуть
  calls.length = 0;
  await handleUpdate(env, me.reply(card, 'убери детали'));
  assert.deepEqual((await tasksOf(env))[0].notes, []);
  const done = calls.find(c => /🗑 Подробности удалены/.test(c.body.text || ''));
  assert.ok(done);
  assert.match(JSON.stringify(done.body.reply_markup), new RegExp(`a:${t0.id}:nrest`));
  await handleUpdate(env, me.tap(`a:${t0.id}:nrest`, 777));
  assert.match((await tasksOf(env))[0].notes[0].text, /Довбенко/, 'вернулись');

  // чек-лист
  await handleUpdate(env, me.reply(card, 'удали чек-лист'));
  assert.deepEqual((await tasksOf(env))[0].checklist, []);
  // повтор и срок не пострадали
  t = (await tasksOf(env))[0];
  assert.ok(t.repeat);
  assert.equal(t.title, 'Проверка документов по нашим компаниям');

  // «убери отчёт», если в карточке такой строки нет, — это про другую задачу
  calls.length = 0;
  await handleUpdate(env, me.reply(card, 'убери отчёт'));
  assert.ok(calls.some(c => /Не нашёл задачу «отчёт»/.test(c.body.text || '')));
  // «удали» без слов по-прежнему удаляет саму задачу (с кнопкой «Восстановить»)
  calls.length = 0;
  await handleUpdate(env, me.reply(card, 'удали'));
  assert.ok(calls.some(c => /🗑 Удалено/.test(c.body.text || '') && /Восстановить/.test(JSON.stringify(c.body.reply_markup || {}))));
});

test('«✏️ Подробности»: бот присылает текст, его правят и присылают целиком — подробности заменяются', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(996, 'Рина');
  await handleUpdate(env, me.text('/start'), 'https://bot.example');
  await handleUpdate(env, me.text('Проверка документов\nОпен Сервис СПБ ООО\nАльфа Политех ООО\n- сверить акты\n- подписать'), 'https://bot.example');
  const [t0] = await tasksOf(env);
  await handleUpdate(env, me.tap(`a:${t0.id}:ck0`, 50), 'https://bot.example'); // «сверить акты» отмечен
  await handleUpdate(env, me.tap(`a:${t0.id}:more`, 50), 'https://bot.example');
  const more = [...calls].reverse().find(c => c.method === 'editMessageText' && c.body.message_id === 50);
  assert.match(JSON.stringify(more.body.reply_markup), new RegExp(`a:${t0.id}:edtx`), 'в «Ещё» есть «✏️ Подробности»');

  calls.length = 0;
  await handleUpdate(env, me.tap(`a:${t0.id}:edtx`, 50), 'https://bot.example');
  const ed = calls.find(c => /✏️ <b>Подробности: «Проверка документов»<\/b>/.test(c.body.text || ''));
  assert.ok(ed, 'прислал редактор');
  assert.match(ed.body.text, /<pre>Опен Сервис СПБ ООО\nАльфа Политех ООО\n- ✓ сверить акты\n- подписать<\/pre>/);
  const kb = ed.body.reply_markup.inline_keyboard.flat();
  assert.ok(kb.some(b => b.copy_text && /Альфа Политех/.test(b.copy_text.text)), 'кнопка «Скопировать»');
  assert.ok(kb.some(b => b.web_app && /\/app\?t=/.test(b.web_app.url)), 'кнопка «Изменить на доске»');

  // прислала исправленный текст: убрала строку, добавила пункт
  calls.length = 0;
  await handleUpdate(env, me.text('Опен Сервис СПБ ООО\nГЕТ Ит, ООО\n- ✓ сверить акты\n- подписать\n- отправить'), 'https://bot.example');
  let t = (await tasksOf(env))[0];
  assert.equal(t.notes.length, 1);
  assert.equal(t.notes[0].text, 'Опен Сервис СПБ ООО\nГЕТ Ит, ООО');
  assert.deepEqual(t.checklist, [{ text: 'сверить акты', done: true }, { text: 'подписать', done: false }, { text: 'отправить', done: false }]);
  assert.equal(t.title, 'Проверка документов', 'название не тронуто');
  assert.equal((await tasksOf(env)).length, 1, 'новая задача не создалась');
  const upd = calls.find(c => /✏️ Подробности обновлены/.test(c.body.text || ''));
  assert.ok(upd);
  assert.match(JSON.stringify(upd.body.reply_markup), new RegExp(`a:${t0.id}:nrest`));
  // вернуть как было
  await handleUpdate(env, me.tap(`a:${t0.id}:nrest`, 60), 'https://bot.example');
  t = (await tasksOf(env))[0];
  assert.equal(t.notes[0].text, 'Опен Сервис СПБ ООО\nАльфа Политех ООО');
  assert.equal(t.checklist.length, 2);

  // отмена: следующее сообщение — обычная новая задача
  await handleUpdate(env, me.tap(`a:${t0.id}:edtx`, 50), 'https://bot.example');
  await handleUpdate(env, me.tap(`a:${t0.id}:dno`, 51), 'https://bot.example');
  await handleUpdate(env, me.text('Позвонить маме'), 'https://bot.example');
  assert.equal((await tasksOf(env)).length, 2);
  assert.equal((await tasksOf(env))[0].notes[0].text, 'Опен Сервис СПБ ООО\nАльфа Политех ООО', 'подробности не тронуты');

  // «очистить всё»
  await handleUpdate(env, me.tap(`a:${t0.id}:edtx`, 50), 'https://bot.example');
  await handleUpdate(env, me.tap(`a:${t0.id}:dclr`, 52), 'https://bot.example');
  t = (await tasksOf(env))[0];
  assert.deepEqual([t.notes, t.checklist], [[], []]);
  await handleUpdate(env, me.text('Купить хлеб'), 'https://bot.example');
  assert.equal((await tasksOf(env)).length, 3, 'после очистки бот не ждёт текст подробностей');

  // пустые подробности: просит написать, а ответ становится подробностями
  calls.length = 0;
  await handleUpdate(env, me.tap(`a:${t0.id}:edtx`, 50), 'https://bot.example');
  assert.ok(calls.some(c => /Подробностей пока нет/.test(c.body.text || '')));
  await handleUpdate(env, me.text('договор у Пети'), 'https://bot.example');
  assert.equal((await tasksOf(env))[0].notes[0].text, 'договор у Пети');
});

test('«✏️ Подробности» забыли: через 10 минут новое сообщение — снова обычная задача', async () => {
  fakeTelegram();
  let now = new Date('2026-09-30T09:00:00Z');
  const env = makeEnv({ _clock: () => now });
  const me = person(997, 'Рина');
  await handleUpdate(env, me.text('/start'));
  await handleUpdate(env, me.text('Отчёт\nстарые подробности'));
  const [t0] = await tasksOf(env);
  await handleUpdate(env, me.tap(`a:${t0.id}:edtx`, 50));
  now = new Date('2026-09-30T09:15:00Z');
  await handleUpdate(env, me.text('Позвонить в банк'));
  const ts = await tasksOf(env);
  assert.equal(ts.length, 2, 'создалась новая задача');
  assert.equal(ts[0].notes[0].text, 'старые подробности', 'подробности отчёта не тронуты');
});

test('«за час»: «До срока 1 час» (не «через час срок», которое читается как «час сорок»); пишет правду о том, сколько осталось; если срок поставили впритык — только «Время пришло»', async () => {
  const calls = fakeTelegram();
  let now = new Date('2026-09-30T08:00:00Z'); // 11:00 МСК
  const env = makeEnv({ _clock: () => now });
  const me = person(998, 'Рина');
  const run = async iso => { now = new Date(iso); calls.length = 0; await runCron(env, now); return calls.map(c => c.body.text || '').join('\n'); };
  await handleUpdate(env, me.text('/start'));
  await handleUpdate(env, me.text('Созвон сегодня в 13:00'));
  await handleUpdate(env, me.text('Отчёт'));
  const [, report] = await tasksOf(env);

  // обычный случай: поставили заранее → за час «До срока 1 час»
  assert.match(await run('2026-09-30T09:01:00Z'), /До срока 1 час[\s\S]*Созвон/); // 12:01

  // перенесли срок на «через 40 минут» в 12:20 — «через час» не шлём
  now = new Date('2026-09-30T09:20:00Z');
  await handleUpdate(env, me.reply(await lastCardMsg(env, me.id, report.id), 'сегодня в 13:00'));
  assert.deepEqual((await tasksOf(env))[1].due, { date: '2026-09-30', time: '13:00' });
  const t1 = await run('2026-09-30T09:25:00Z');
  assert.doesNotMatch(t1, /До срока 1 час[\s\S]*Отчёт/);
  assert.doesNotMatch(t1, /До срока \d+ мин/);
  assert.match(await run('2026-09-30T10:00:00Z'), /Время пришло[\s\S]*Отчёт/); // 13:00 — пришло

  // проверка задержалась (лимиты) — пишет, сколько на самом деле осталось
  now = new Date('2026-09-30T10:00:00Z');
  await handleUpdate(env, me.text('Позвонить в банк сегодня в 15:00'));
  assert.match(await run('2026-09-30T11:10:00Z'), /До срока 50 мин[\s\S]*Позвонить в банк/); // 14:10
});

test('«Жду ответа»: свой день кнопкой, «спросить в четверг» словами — без лишней задачи «Спросить»', async () => {
  const calls = fakeTelegram();
  let now = new Date('2026-09-30T09:00:00Z'); // ср 12:00
  const env = makeEnv({ _clock: () => now });
  const me = person(999, 'Рина');
  await handleUpdate(env, me.text('/start'));
  await handleUpdate(env, me.text('Получить ответ от Вики как отразить в ведомости деньги по клоду'));
  const [t0] = await tasksOf(env);

  // кнопками: ☰ Ещё → ⏳ Жду ответа → ✏️ Свой день → «в пятницу на следующей неделе»
  await handleUpdate(env, me.tap(`a:${t0.id}:wait`, 50));
  const waitKb = [...calls].reverse().find(c => c.method === 'editMessageText' && c.body.message_id === 50);
  assert.match(JSON.stringify(waitKb.body.reply_markup), new RegExp(`a:${t0.id}:wask`), 'есть «✏️ Свой день»');
  await handleUpdate(env, me.tap(`a:${t0.id}:wask`, 50));
  assert.ok(calls.some(c => /Когда спросить, пришёл ли ответ/.test(c.body.text || '')));
  calls.length = 0;
  await handleUpdate(env, me.text('12.10'));
  let t = (await tasksOf(env))[0];
  assert.deepEqual(t.waiting, { since: '2026-09-30', check: '2026-10-12' });
  assert.ok(calls.some(c => /Жду ответа\. Спрошу <b>12 окт<\/b>/.test(c.body.text || '')));
  assert.equal((await tasksOf(env)).length, 1);

  // как на скриншоте: «Жду ответа» → «через неделю», а потом отдельным сообщением «спросить в четверг»
  await handleUpdate(env, me.tap(`a:${t0.id}:w7`, 50));
  await handleUpdate(env, me.text('спросить в четверг'));
  t = (await tasksOf(env))[0];
  assert.equal(t.waiting.check, '2026-10-01', 'четверг');
  assert.equal((await tasksOf(env)).length, 1, 'задача «Спросить» не создалась');

  // ответом на карточку
  const card = await lastCardMsg(env, me.id, t0.id);
  await handleUpdate(env, me.reply(card, 'уточнить через 2 недели'));
  assert.equal((await tasksOf(env))[0].waiting.check, '2026-10-14');

  // утром «Пришёл ли ответ?» → «✏️ Другой день»
  now = new Date('2026-10-14T06:05:00Z');
  env.DB.raw.exec(`UPDATE users SET data = json_set(data, '$.lastMorning', '2026-10-13')`);
  calls.length = 0;
  await runCron(env, now);
  const q = calls.find(c => /Пришёл ли ответ/.test(c.body.text || ''));
  assert.ok(q);
  assert.match(JSON.stringify(q.body.reply_markup), new RegExp(`W:${t0.id}:wask`));
  await handleUpdate(env, me.tap(`W:${t0.id}:wask`, 60));
  await handleUpdate(env, me.text('в понедельник'));
  assert.equal((await tasksOf(env))[0].waiting.check, '2026-10-19');

  // обычные фразы не перехватываются
  await handleUpdate(env, me.text('напомни завтра позвонить маме'));
  const all = await tasksOf(env);
  assert.equal(all.length, 2);
  assert.equal(all[1].title, 'Позвонить маме');
  assert.equal(all[1].waiting, undefined);
  // «напомни завтра» ответом на обычную карточку — переносит срок, а не «жду ответа»
  await handleUpdate(env, me.reply(await lastCardMsg(env, me.id, all[1].id), 'напомни в пятницу'));
  assert.equal((await tasksOf(env))[1].waiting, undefined);
});

test('выполненное: дата завершения в /done и на доске в чате, «Сделано сегодня», очистка — чужие задачи у автора остаются', async () => {
  const calls = fakeTelegram();
  let now = new Date('2026-09-29T09:00:00Z'); // вт
  const env = makeEnv({ _clock: () => now });
  const me = person(1601, 'Рина'), boss = person(1600, 'Анна');
  const say = (who, t) => handleUpdate(env, who.text(t), 'https://bot.example');
  await say(boss, '/start');
  await say(boss, '/newproject Отдел');
  const { code } = await env.DB.prepare('SELECT code FROM projects').first();
  await say(me, '/start join_' + code);
  await say(me, 'Старый отчёт');
  await say(me, 'Позвонить в банк');
  await say(me, 'Купить бумагу');
  await say(boss, 'Отдел: @Рина сверить акты');
  const ts = await tasksOf(env);
  const id = title => ts.find(t => t.title === title).id;
  await handleUpdate(env, me.tap(`a:${id('Старый отчёт')}:done`, 1), 'https://bot.example'); // во вторник
  now = new Date('2026-09-30T09:00:00Z'); // ср
  await handleUpdate(env, me.tap(`a:${id('Позвонить в банк')}:done`, 1), 'https://bot.example');
  await handleUpdate(env, me.tap(`a:${id('Сверить акты')}:done`, 1), 'https://bot.example');

  // /done — по дням, с датой
  calls.length = 0;
  await say(me, '/done');
  const d = calls.find(c => /Выполнено<\/b> — по дате завершения/.test(c.body.text || ''));
  assert.match(d.body.text, /✅ сегодня<\/b>\n• <s>Сверить акты<\/s> <i>· от Анна<\/i>[\s\S]*Позвонить в банк[\s\S]*✅ вчера[\s\S]*Старый отчёт/);
  assert.doesNotMatch(d.body.text, /Купить бумагу/);
  assert.match(JSON.stringify(d.body.reply_markup), /X:ask/);

  // доска в чате: вкладка «✅ Готово» с датами
  calls.length = 0;
  await say(me, '🗂 Доска');
  const board = calls.find(c => /Доска · /.test(c.body.text || ''));
  assert.match(JSON.stringify(board.body.reply_markup), /✅ Готово 3/);
  await handleUpdate(env, me.tap('B:v:done:0', 70), 'https://bot.example');
  const doneTab = [...calls].reverse().find(c => c.method === 'editMessageText' && c.body.message_id === 70);
  assert.match(doneTab.body.text, /Доска · ✅ Готово<\/b> — 3/);
  assert.match(doneTab.body.text, /<s>Старый отчёт<\/s> <i>· ✅ вчера<\/i>/);
  assert.match(JSON.stringify(doneTab.body.reply_markup), /🧹 Очистить выполненное/);

  // закреплённый список: «Сделано сегодня: 2»
  const dash = [...calls, ...calls].reverse().find(c => /📌 <b>Мои задачи<\/b>/.test(c.body.text || ''));
  await say(me, 'Новая задача');
  const dash2 = [...calls].reverse().find(c => /📌 <b>Мои задачи<\/b>/.test(c.body.text || ''));
  assert.match((dash2 || dash).body.text, /Сделано сегодня: 2/);

  // очистка: спросит, потом свои удалит, задачу Анны только скроет у меня
  calls.length = 0;
  await handleUpdate(env, me.tap('X:ask', 71), 'https://bot.example');
  assert.ok(calls.some(c => /Убрать из списка все выполненные задачи \(3\)/.test(c.body.text || '')));
  await handleUpdate(env, me.tap('X:ok', 71), 'https://bot.example');
  assert.ok(calls.some(c => /убрано выполненных задач: 3/.test(c.body.text || '')));
  const left = await tasksOf(env);
  assert.ok(!left.some(t => t.title === 'Старый отчёт' || t.title === 'Позвонить в банк'), 'свои удалены');
  assert.ok(left.some(t => t.title === 'Сверить акты'), 'задача Анны осталась у неё');
  assert.ok(left.some(t => t.title === 'Купить бумагу' && !t.done), 'открытые не тронуты');
  calls.length = 0;
  await say(me, '/done');
  assert.ok(calls.some(c => /Выполненных задач нет/.test(c.body.text || '')));
  calls.length = 0;
  await say(boss, '/done');
  assert.ok(calls.some(c => /Сверить акты[\s\S]*Рина/.test(c.body.text || '')), 'у Анны в выполненных осталось');

  // одну чужую выполненную — кнопкой 🗑 на карточке: убирается только из моего списка
  await say(boss, 'Отдел: @Рина подписать договор');
  const t2 = (await tasksOf(env)).find(t => t.title === 'Подписать договор');
  await handleUpdate(env, me.tap(`a:${t2.id}:done`, 80), 'https://bot.example');
  calls.length = 0;
  await handleUpdate(env, me.tap(`a:${t2.id}:del`, 80), 'https://bot.example');
  assert.ok(calls.some(c => /убрано из списка выполненных/.test(c.body.text || '')));
  assert.ok((await tasksOf(env)).some(t => t.id === t2.id), 'у автора осталась');
  calls.length = 0;
  await say(me, '/done');
  assert.ok(calls.some(c => /Выполненных задач нет/.test(c.body.text || '')));
});

test('закреплённый список и /list: разовые и регулярные — отдельными блоками', async () => {
  const calls = fakeTelegram();
  const now = new Date('2026-09-30T09:00:00Z'); // ср 12:00 МСК
  const env = makeEnv({ _clock: () => now });
  const me = person(1600, 'Рина');
  await handleUpdate(env, me.text('/start'));
  for (const t of ['Позвонить в банк сегодня в 15:00', 'Витамины каждый день в 9:00', 'Отчёт завтра', 'Планёрка каждый понедельник в 10:00', 'Купить бумагу'])
    await handleUpdate(env, me.text(t));
  const dash = [...calls].reverse().find(c => /📌 <b>Мои задачи<\/b>/.test(c.body.text || '')).body.text;
  assert.match(dash, /━━ 📌 Разовые ━━[\s\S]*📍 Сегодня[\s\S]*Позвонить в банк[\s\S]*🔜 Завтра[\s\S]*Отчёт[\s\S]*Без срока[\s\S]*Купить бумагу[\s\S]*━━ 🔁 Регулярные — 2 ━━/);
  const reg = dash.split('Регулярные')[1];
  assert.match(reg, /• Витамины <i>· завтра 09:00 · каждый день<\/i>[\s\S]*• Планёрка <i>· пн[^<]*10:00 · по пн<\/i>/);
  assert.doesNotMatch(dash.split('Регулярные')[0], /Витамины|Планёрка/, 'регулярные не смешаны с разовыми');
  calls.length = 0;
  await handleUpdate(env, me.text('/list'));
  assert.match(calls.find(c => /Все задачи/.test(c.body.text || '')).body.text, /Разовые[\s\S]*Регулярные — 2/);
  // только разовые — без заголовков-разделителей
  const env2 = makeEnv({ _clock: () => now });
  const you = person(1601, 'Анна');
  await handleUpdate(env2, you.text('/start'));
  calls.length = 0;
  await handleUpdate(env2, you.text('Отчёт завтра'));
  const d2 = [...calls].reverse().find(c => /📌 <b>Мои задачи<\/b>/.test(c.body.text || '')).body.text;
  assert.doesNotMatch(d2, /━━/);
});

test('номер задачи в начале или в конце строки — личная настройка', async () => {
  const calls = fakeTelegram();
  const now = new Date('2026-09-30T09:00:00Z');
  const env = makeEnv({ _clock: () => now });
  const rina = person(1610, 'Рина'), anna = person(1611, 'Анна');
  for (const p of [rina, anna]) await handleUpdate(env, p.text('/start'));
  await handleUpdate(env, rina.text('Позвонить в банк сегодня в 15:00'));
  await handleUpdate(env, rina.text('Витамины каждый день в 9:00'));
  const dashOf = who => [...calls].reverse().find(c => c.body.chat_id === who.id && /📌 <b>Мои задачи<\/b>/.test(c.body.text || '')).body.text;
  assert.match(dashOf(rina), /• Позвонить в банк <i>· 15:00<\/i>  \/t1/, 'по умолчанию — в конце');

  // кнопкой в /settings
  calls.length = 0;
  await handleUpdate(env, rina.text('/settings'));
  const st = calls.find(c => /Мои настройки/.test(c.body.text || ''));
  assert.match(st.body.text, /Номер задачи — в конце строки/);
  assert.match(JSON.stringify(st.body.reply_markup), /O:n"/);
  await handleUpdate(env, rina.tap('O:n', 90));
  let ed = [...calls].reverse().find(c => c.method === 'editMessageText' && c.body.message_id === 90);
  assert.match(JSON.stringify(ed.body.reply_markup), /✓ В конце/);
  await handleUpdate(env, rina.tap('O:n1', 90));
  ed = [...calls].reverse().find(c => c.method === 'editMessageText' && c.body.message_id === 90);
  assert.match(ed.body.text, /Номер задачи — в начале строки/);
  assert.match(dashOf(rina), /• \/t1 Позвонить в банк <i>· 15:00<\/i>/, 'закреплённый список перерисован');
  assert.match(dashOf(rina), /• \/t2 Витамины <i>· завтра 09:00 · каждый день<\/i>/);
  calls.length = 0;
  await handleUpdate(env, rina.text('/list'));
  assert.match(calls.find(c => /Все задачи/.test(c.body.text || '')).body.text, /• \/t1 Позвонить в банк/);
  await handleUpdate(env, rina.text('/repeat'));
  assert.match(calls.find(c => /Регулярные задачи<\/b>/.test(c.body.text || '')).body.text, /• \/t2 Витамины/);

  // у Анны — по-прежнему в конце
  await handleUpdate(env, anna.text('Отчёт завтра'));
  assert.match(dashOf(anna), /• Отчёт  \/t3/);

  // словами — обратно
  calls.length = 0;
  await handleUpdate(env, rina.text('номера в конце'));
  assert.ok(calls.some(c => /Номера задач теперь в конце строки/.test(c.body.text || '')));
  assert.match(dashOf(rina), /• Позвонить в банк <i>· 15:00<\/i>  \/t1/);
  await handleUpdate(env, rina.text('номер в начале'));
  assert.match(dashOf(rina), /• \/t1 Позвонить/);
  assert.equal((await tasksOf(env)).length, 3, 'фразы про номера не стали задачами');
});
