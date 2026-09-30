import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../worker.js';
import { fakeTelegram, makeEnv, person, tasksOf, lastCardMsg } from './helpers.mjs';

const { handleUpdate, handleApi } = worker._internal;

test('общий проект: руководитель ставит задачу, исполнитель отмечает', async () => {
  const calls = fakeTelegram();
  const env = makeEnv({ ALLOWED_USERS: '10' }); // бот личный, но по приглашению войти можно
  const boss = person(10, 'Анна', 'anna_boss');
  const me = person(20, 'Рина', 'rina');
  const stranger = person(30, 'Незнакомец');

  await handleUpdate(env, boss.text('/start'));
  await handleUpdate(env, boss.text('/newproject Маркетинг'));
  calls.length = 0;
  await handleUpdate(env, boss.text('/invite'));
  const link = calls.texts()[0].match(/https:\/\/t\.me\/my_tasks_bot\?start=join_(\w+)/);
  assert.ok(link, 'пришла ссылка-приглашение');

  await handleUpdate(env, stranger.text('привет'));
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM users').first()).n, 1, 'чужих не пускаем');

  calls.length = 0;
  await handleUpdate(env, me.text('/start join_' + link[1]));
  assert.ok(calls.to(20).some(c => /Ты в проекте «<b>Маркетинг/.test(c.body.text)));
  assert.ok(calls.to(10).some(c => /Рина<\/b> теперь в проекте/.test(c.body.text)));

  // руководитель ставит задачу
  calls.length = 0;
  await handleUpdate(env, boss.text('#маркетинг @rina Подготовить отчёт до пятницы'));
  let [t] = await tasksOf(env);
  assert.equal(t.title, 'Подготовить отчёт');
  assert.equal(t.owner, 10);
  assert.equal(t.assignee, 20);
  assert.ok(t.project);
  assert.ok(calls.to(20).some(c => /Новая задача от Анна/.test(c.body.text)), 'исполнителю пришла карточка');
  assert.ok(calls.to(10).some(c => /Задача поставлена: <b>Рина/.test(c.body.text)));

  // у исполнителя в списке — с пометкой «от Анна», у руководителя — в «Поручено другим»
  calls.length = 0;
  await handleUpdate(env, me.text('/list'));
  assert.match(calls.texts()[0], /Подготовить отчёт.*#Маркетинг.*\(от Анна\)/);
  await handleUpdate(env, boss.text('/list'));
  assert.match(calls.to(10).at(-1).body.text, /Поручено другим[\s\S]*Подготовить отчёт.*→ Рина/);

  // исполнитель дописывает подробности → руководителю уведомление
  calls.length = 0;
  const myCard = await lastCardMsg(env, 20, t.id);
  await handleUpdate(env, me.reply(myCard, 'Нужны данные от финансов'));
  assert.ok(calls.to(10).some(c => /Рина<\/b> дописал\(а\) подробности[\s\S]*Нужны данные от финансов/.test(c.body.text)));

  // и отмечает «готово» → руководителю уведомление
  calls.length = 0;
  await handleUpdate(env, me.tap(`a:${t.id}:done`, myCard));
  [t] = await tasksOf(env);
  assert.equal(t.done, true);
  assert.ok(calls.to(10).some(c => /Рина<\/b>: выполнено/.test(c.body.text)));

  // удалить чужую задачу нельзя
  await handleUpdate(env, boss.text('#маркетинг @Рина Второе задание'));
  const t2 = (await tasksOf(env))[1];
  calls.length = 0;
  await handleUpdate(env, me.tap(`a:${t2.id}:delok`));
  assert.equal((await tasksOf(env)).length, 2);
  assert.ok(calls.some(c => c.method === 'answerCallbackQuery' && /только автор/.test(c.body.text)));

  // переназначение кнопкой
  await handleUpdate(env, me.tap(`a:${t2.id}:as10`));
  assert.equal((await tasksOf(env))[1].assignee, 10);

  // личные задачи исполнителя руководителю не видны
  await handleUpdate(env, me.text('Личное: купить корм коту'));
  calls.length = 0;
  const personal = (await tasksOf(env))[2];
  await handleUpdate(env, boss.text('/t' + personal.id));
  assert.match(calls.texts()[0], /нет/);

  // проект и выход из него
  calls.length = 0;
  await handleUpdate(env, me.text('/projects'));
  assert.match(calls.texts()[0], /Маркетинг.*Анна, Рина|Маркетинг.*Рина, Анна/);
});

test('хэштег создаёт личный проект, /list проект', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(40, 'Рина');
  await handleUpdate(env, me.text('#ремонт Выбрать плитку до субботы'));
  assert.match(calls.texts().join('\n'), /Новый проект «ремонт»/);
  await handleUpdate(env, me.text('#Ремонт Вызвать мастера'));
  const ts = await tasksOf(env);
  assert.equal(ts[0].project, ts[1].project, 'регистр хэштега не важен');
  calls.length = 0;
  await handleUpdate(env, me.text('/list ремонт'));
  assert.match(calls.texts()[0], /Выбрать плитку[\s\S]*Вызвать мастера/);
});

function signInitData(token, user) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'q1', user: JSON.stringify(user) });
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

const call = (env, body) => handleApi(new Request('https://bot.example/api', { method: 'POST', body: JSON.stringify(body) }), env).then(r => r.json());

test('доска: авторизация, состояние, перенос, создание', async () => {
  fakeTelegram();
  const env = makeEnv();
  const me = person(50, 'Рина');
  await handleUpdate(env, me.text('Отчёт завтра'));

  assert.equal((await call(env, { op: 'state', initData: 'hash=bad&user=%7B%22id%22%3A50%7D' })).error, 'Открой доску из Telegram');

  const initData = signInitData(env.BOT_TOKEN, { id: 50, first_name: 'Рина' });
  let r = await call(env, { op: 'state', initData });
  assert.equal(r.error, null);
  assert.equal(r.state.tasks[0].bucket, 'tomorrow');

  r = await call(env, { op: 'edit', id: 1, due: null, initData });
  assert.equal(r.state.tasks[0].bucket, 'nodate');

  r = await call(env, { op: 'edit', id: 1, note: 'детали\n- шаг 1', checkAdd: 'шаг 2', initData });
  assert.equal(r.state.tasks[0].notes[0].text, 'детали');
  assert.deepEqual(r.state.tasks[0].checklist.map(c => c.text), ['шаг 1', 'шаг 2']);

  r = await call(env, { op: 'create', text: 'Витамины каждый день в 9:00', initData });
  assert.equal(r.state.tasks.length, 2);
  assert.equal(r.state.tasks[1].repeatText, 'каждый день');

  // повтор из формы: «раз в 2 недели по чт и пт, до …»
  r = await call(env, { op: 'edit', id: 1, repeat: { unit: 'week', n: 2, wd: [4, 5], until: '2027-01-01' }, initData });
  assert.equal(r.error, null);
  assert.deepEqual(r.state.tasks[0].repeat, { unit: 'week', n: 2, wd: [4, 5], until: '2027-01-01' });
  assert.equal(r.state.tasks[0].repeatText, 'раз в 2 нед. по чт, пт, до 01.01.2027');
  r = await call(env, { op: 'edit', id: 1, repeat: { unit: 'week', n: 1, wd: [] }, initData });
  assert.match(r.error, /повтор/);
  r = await call(env, { op: 'edit', id: 1, repeat: { unit: 'month', n: 1, nth: 1, nwd: 4 }, initData });
  assert.equal(r.state.tasks[0].repeatText, 'каждый месяц, в первый четверг');
  r = await call(env, { op: 'edit', id: 1, repeat: null, initData });
  assert.equal(r.state.tasks[0].repeat, null);

  r = await call(env, { op: 'act', id: 1, act: 'done', initData });
  assert.equal(r.state.tasks.find(t => t.id === 1).bucket, 'done');

  const other = signInitData(env.BOT_TOKEN, { id: 99, first_name: 'Чужой' });
  assert.match((await call(env, { op: 'state', initData: other })).error, /start/);
});

test('проект кнопкой и через двоеточие, выбор исполнителя кнопкой', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const boss = person(60, 'Анна', 'anna');
  const me = person(61, 'Рина', 'rina');
  await handleUpdate(env, boss.text('/newproject Работа'));
  const code = (await env.DB.prepare('SELECT code FROM projects').first()).code;
  await handleUpdate(env, me.text('/start join_' + code));

  // задача без проекта — на карточке кнопка «📁 Работа»
  calls.length = 0;
  await handleUpdate(env, boss.text('Подготовить отчёт до пятницы'));
  const card = calls.find(c => /Задача сохранена/.test(c.body.text || ''));
  assert.match(JSON.stringify(card.body.reply_markup), /📁 Работа/);
  const [t] = await tasksOf(env);
  calls.length = 0;
  await handleUpdate(env, boss.tap(`a:${t.id}:pj1`, 500));
  let t1 = (await tasksOf(env))[0];
  assert.equal(t1.project, 1);
  // сразу предлагаем выбрать, кому
  const ed = calls.find(c => c.method === 'editMessageText');
  assert.match(JSON.stringify(ed.body.reply_markup), /Рина/);
  calls.length = 0;
  await handleUpdate(env, boss.tap(`a:${t.id}:as61`, 500));
  assert.equal((await tasksOf(env))[0].assignee, 61);
  assert.ok(calls.to(61).some(c => /поручил\(а\) тебе задачу/.test(c.body.text)));

  // «Работа: …» — сразу в проект, и кнопки с именами
  calls.length = 0;
  await handleUpdate(env, boss.text('Работа: согласовать бюджет завтра'));
  const t2 = (await tasksOf(env))[1];
  assert.equal(t2.title, 'Согласовать бюджет');
  assert.equal(t2.project, 1);
  const c2 = calls.find(c => /Кому поставить/.test(c.body.text || ''));
  assert.ok(c2);
  assert.match(JSON.stringify(c2.body.reply_markup), new RegExp(`a:${t2.id}:as61`));

  // двоеточие без такого проекта — обычная задача
  await handleUpdate(env, boss.text('Важно: купить билеты'));
  assert.equal((await tasksOf(env))[2].title, 'Важно: купить билеты');
});
