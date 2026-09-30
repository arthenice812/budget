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
  assert.equal(keys.length, 10);

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
  assert.match(calls.find(c => c.method === 'editMessageText').body.text, /#работа @rina_k Подготовить отчёт/);
  calls.length = 0;
  await handleUpdate(env, me.tap('h:menu', 555));
  assert.match(calls.find(c => c.method === 'editMessageText').body.text, /Я — твой список задач/);
});
