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
  const soon = calls.find(c => /Через час/.test(c.body.text || ''));
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
  assert.match(texts, /лежат без срока больше двух недель[\s\S]*Позвонить в банк/);
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
  assert.equal(keys.length, 11);

  for (const key of keys) {
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
