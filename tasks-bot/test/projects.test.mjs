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
  const t3 = (await tasksOf(env))[2];
  assert.equal(t3.title, 'Купить билеты', '«Важно:» — это пометка, а не проект');
  assert.equal(t3.project, null);
  assert.equal(t3.high, true);
});

test('проект кнопками: «📁 Проекты» → «➕ Создать» → название → позвать', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(70, 'Рина', 'rina');

  // /start присылает постоянные кнопки внизу
  await handleUpdate(env, me.text('/start'));
  assert.ok(calls.some(c => c.body.reply_markup && c.body.reply_markup.keyboard && JSON.stringify(c.body.reply_markup).includes('📁 Проекты')));

  // кнопка «📁 Проекты» без проектов — предлагает создать
  calls.length = 0;
  await handleUpdate(env, me.text('📁 Проекты'));
  assert.match(JSON.stringify(calls[0].body.reply_markup), /P:new/);

  await handleUpdate(env, me.tap('P:new', 600));
  assert.ok(calls.some(c => /Как назвать проект/.test(c.body.text || '')));
  calls.length = 0;
  await handleUpdate(env, me.text('Работа'));
  const created = calls.find(c => /Проект «<b>Работа<\/b>» создан/.test(c.body.text || ''));
  assert.ok(created, 'проект создан');
  assert.match(JSON.stringify(created.body.reply_markup), /t\.me\/share\/url\?url=https%3A%2F%2Ft\.me%2Fmy_tasks_bot%3Fstart%3Djoin_/);
  assert.equal((await tasksOf(env)).length, 0, '«Работа» не стала задачей');

  // карточка: «📁 Проект» → «➕ Новый проект» → название → задача переезжает
  await handleUpdate(env, me.text('Купить плитку'));
  const t = (await tasksOf(env))[0];
  calls.length = 0;
  await handleUpdate(env, me.tap(`a:${t.id}:proj`, 601));
  assert.match(JSON.stringify(calls.find(c => c.method === 'editMessageText').body.reply_markup), /pnew/);
  await handleUpdate(env, me.tap(`a:${t.id}:pnew`, 601));
  await handleUpdate(env, me.text('Ремонт'));
  const proj = (await env.DB.prepare("SELECT id FROM projects WHERE name = 'Ремонт'").first());
  assert.equal((await tasksOf(env))[0].project, proj.id);

  // словами
  await handleUpdate(env, me.text('создай проект Дача'));
  assert.ok(await env.DB.prepare("SELECT id FROM projects WHERE name = 'Дача'").first());
  assert.equal((await tasksOf(env)).length, 1);

  // «👥 Позвать» из списка проектов
  calls.length = 0;
  await handleUpdate(env, me.tap('P:i1', 602));
  assert.match(calls.texts()[0], /Приглашение в проект «Работа»/);
});

test('удаление проекта: кнопкой и словами, задачи оставить или удалить', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const boss = person(80, 'Анна', 'anna');
  const me = person(81, 'Рина', 'rina');
  await handleUpdate(env, me.text('создай проект Тест'));
  const code = (await env.DB.prepare('SELECT code FROM projects').first()).code;
  await handleUpdate(env, boss.text('/start join_' + code));
  await handleUpdate(env, me.text('Тест: задача раз'));
  await handleUpdate(env, me.text('Тест: задача два'));

  // открыть проект → есть кнопка удаления
  calls.length = 0;
  await handleUpdate(env, me.tap('P:v1', 1100));
  assert.match(JSON.stringify(calls.find(c => c.method === 'sendMessage').body.reply_markup), /P:d1/);
  // участник видит «выйти», а не «удалить»
  calls.length = 0;
  await handleUpdate(env, boss.tap('P:v1', 1101));
  assert.match(JSON.stringify(calls.find(c => c.method === 'sendMessage').body.reply_markup), /P:l1/);
  await handleUpdate(env, boss.tap('P:k1', 1101));
  assert.ok(await env.DB.prepare('SELECT id FROM projects WHERE id = 1').first(), 'не автор — не удаляет');

  // удалить, задачи оставить
  calls.length = 0;
  await handleUpdate(env, me.text('удали проект Тест'));
  assert.ok(calls.some(c => /Удалить проект «Тест»/.test(c.body.text || '')));
  await handleUpdate(env, me.tap('P:k1', 1102));
  assert.equal(await env.DB.prepare('SELECT id FROM projects WHERE id = 1').first(), null);
  const ts = await tasksOf(env);
  assert.equal(ts.length, 2);
  assert.ok(ts.every(t => t.project === null), 'задачи стали личными');
  assert.ok(calls.to(80).some(c => /удалил\(а\) проект «Тест»/.test(c.body.text)));

  // удалить вместе с задачами
  await handleUpdate(env, me.text('создай проект Дача'));
  await handleUpdate(env, me.text('Дача: покрасить забор'));
  const pid = (await env.DB.prepare("SELECT id FROM projects WHERE name = 'Дача'").first()).id;
  await handleUpdate(env, me.tap(`P:x${pid}`, 1103));
  assert.equal((await tasksOf(env)).length, 2, 'задача проекта удалена');
});

test('кнопка «🗂 Доска» внизу присылает кнопку, открывающую доску', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(82, 'Рина');
  await handleUpdate(env, me.text('/start'), 'https://bot.example');
  const kb = calls.find(c => c.body.reply_markup && c.body.reply_markup.keyboard);
  assert.ok(!JSON.stringify(kb.body.reply_markup).includes('web_app'), 'в нижнем меню нет web_app — там доска не узнаёт пользователя');
  calls.length = 0;
  await handleUpdate(env, me.text('🗂 Доска'), 'https://bot.example');
  assert.match(JSON.stringify(calls[0].body.reply_markup), /"web_app":\{"url":"https:\/\/bot\.example\/app"\}/);
});

test('доска в чате: вкладки, страницы, проект по статусам, открыть задачу', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const me = person(90, 'Рина');
  const boss = person(91, 'Анна');
  for (let i = 1; i <= 10; i++) await handleUpdate(env, me.text(`Задача ${i} сегодня`));
  await handleUpdate(env, me.text('Без срока задача'));
  await handleUpdate(env, me.text('создай проект Работа'));
  const code = (await env.DB.prepare('SELECT code FROM projects').first()).code;
  await handleUpdate(env, boss.text('/start join_' + code));
  await handleUpdate(env, boss.text('Работа: @Рина сверить акты'));
  await handleUpdate(env, boss.text('Работа: @Рина отчёт для банка'));
  await handleUpdate(env, me.tap('a:13:s_doing', 1700));

  calls.length = 0;
  await handleUpdate(env, me.text('🗂 Доска'), 'https://bot.example');
  const bd = calls.find(c => /Доска · 📍 Сегодня/.test(c.body.text || ''));
  assert.ok(bd);
  const kb = JSON.stringify(bd.body.reply_markup);
  assert.match(kb, /• 📍 Сегодня 10/, 'вкладка с числом');
  assert.match(kb, /1 \/ 2/, 'две страницы');
  assert.match(kb, /Большая доска/);

  calls.length = 0;
  await handleUpdate(env, me.tap('B:v:today:1', 1800), 'https://bot.example');
  assert.match(calls.find(c => c.method === 'editMessageText').body.text, /9\. /);
  calls.length = 0;
  await handleUpdate(env, me.tap('B:v:nodate:0', 1800));
  assert.match(calls.find(c => c.method === 'editMessageText').body.text, /Без срока задача/);

  calls.length = 0;
  await handleUpdate(env, me.tap('B:pl', 1800));
  const pid = (await env.DB.prepare('SELECT id FROM projects').first()).id;
  assert.match(JSON.stringify(calls.find(c => c.method === 'editMessageText').body.reply_markup), new RegExp(`B:v:p${pid}:0`));
  calls.length = 0;
  await handleUpdate(env, me.tap(`B:v:p${pid}:0`, 1800));
  const pv = calls.find(c => c.method === 'editMessageText').body.text;
  assert.match(pv, /В работе[\s\S]*отчёт для банка[\s\S]*К выполнению[\s\S]*сверить акты/i);

  calls.length = 0;
  await handleUpdate(env, me.tap('B:o:1', 1800));
  assert.ok(calls.some(c => c.method === 'sendMessage' && /Задача 1/.test(c.body.text)));

  // проект в «📁 Проекты» — тоже по статусам
  calls.length = 0;
  await handleUpdate(env, me.tap(`P:v${pid}`, 1801));
  assert.match(calls.find(c => c.method === 'sendMessage').body.text, /🔨 В работе[\s\S]*📥 К выполнению/);
});

test('одна ссылка-приглашение на весь отдел: заходят все, сообщение о новичке — только создателю', async () => {
  const calls = fakeTelegram();
  const env = makeEnv({ ALLOWED_USERS: '700' });
  const owner = person(700, 'Рина');
  await handleUpdate(env, owner.text('/start'));
  await handleUpdate(env, owner.text('/newproject Отдел'));
  const { code } = await env.DB.prepare('SELECT code FROM projects').first();
  const team = Array.from({ length: 6 }, (_, i) => person(710 + i, 'Коллега ' + i));
  calls.length = 0;
  for (const p of team) await handleUpdate(env, p.text('/start join_' + code));
  const members = (await env.DB.prepare('SELECT user_id FROM members').all()).results.map(r => r.user_id);
  assert.equal(members.length, 7, 'все шестеро вошли по одной ссылке');
  for (const p of team) assert.ok(calls.to(p.id).some(c => /Ты в проекте «<b>Отдел<\/b>»/.test(c.body.text || '')));
  assert.equal(calls.to(owner.id).filter(c => /теперь в проекте/.test(c.body.text || '')).length, 6, 'создателю — по одному о каждом');
  assert.ok(calls.to(owner.id).some(c => /всего участников: 7/.test(c.body.text || '')));
  for (const p of team) assert.ok(!calls.to(p.id).some(c => /теперь в проекте/.test(c.body.text || '')), 'коллеги не получают сообщений о других');
  // без ссылки посторонний не войдёт
  calls.length = 0;
  await handleUpdate(env, person(799, 'Чужой').text('/start'));
  assert.ok(calls.some(c => /Это личный бот/.test(c.body.text || '')));
});

test('переименовать проект: кнопкой и словами; только создатель; участники узнают; задачи остаются в проекте', async () => {
  const calls = fakeTelegram();
  const env = makeEnv();
  const owner = person(720, 'Рина'), colleague = person(721, 'Анна');
  await handleUpdate(env, owner.text('/start'));
  await handleUpdate(env, owner.text('/newproject Тест'));
  await handleUpdate(env, owner.text('/newproject Дом'));
  const p = await env.DB.prepare("SELECT id, code FROM projects WHERE name = 'Тест'").first();
  await handleUpdate(env, colleague.text('/start join_' + p.code));
  await handleUpdate(env, owner.text('Тест: @Анна сверить акты'));

  // кнопкой: проект → «✏️ Переименовать» → название
  calls.length = 0;
  await handleUpdate(env, owner.tap(`P:v${p.id}`, 30));
  assert.match(JSON.stringify(calls.find(c => c.body.reply_markup && /P:r/.test(JSON.stringify(c.body.reply_markup))).body.reply_markup), new RegExp(`P:r${p.id}`));
  await handleUpdate(env, owner.tap(`P:r${p.id}`, 31));
  assert.ok(calls.some(c => /Как назвать проект «<b>Тест<\/b>»/.test(c.body.text || '')));
  calls.length = 0;
  await handleUpdate(env, owner.text('Отдел'));
  assert.equal((await env.DB.prepare('SELECT name FROM projects WHERE id = ?').bind(p.id).first()).name, 'Отдел');
  assert.ok(calls.to(owner.id).some(c => /Проект теперь называется «<b>Отдел<\/b>»/.test(c.body.text || '')));
  assert.ok(calls.to(colleague.id).some(c => /Рина<\/b> переименовал\(а\) проект «Тест» → «<b>Отдел<\/b>»/.test(c.body.text || '')));
  assert.equal((await tasksOf(env)).length, 1, 'название не стало задачей');
  assert.equal((await tasksOf(env))[0].project, p.id, 'задача осталась в проекте');
  // новое название работает в «Отдел: …»
  await handleUpdate(env, owner.text('Отдел: подготовить отчёт'));
  assert.equal((await tasksOf(env))[1].project, p.id);

  // словами
  await handleUpdate(env, owner.text('переименуй проект Отдел в «Бухгалтерия»'));
  assert.equal((await env.DB.prepare('SELECT name FROM projects WHERE id = ?').bind(p.id).first()).name, 'Бухгалтерия');
  // занятое название и чужой проект
  calls.length = 0;
  await handleUpdate(env, owner.text('переименуй проект Бухгалтерия в Дом'));
  assert.ok(calls.some(c => /Проект «Дом» у тебя уже есть/.test(c.body.text || '')));
  await handleUpdate(env, colleague.text('переименуй проект Бухгалтерия в Мой'));
  assert.ok(calls.to(colleague.id).some(c => /может только его создатель — Рина/.test(c.body.text || '')));
  assert.equal((await env.DB.prepare('SELECT name FROM projects WHERE id = ?').bind(p.id).first()).name, 'Бухгалтерия');
  // отмена
  await handleUpdate(env, owner.tap(`P:r${p.id}`, 32));
  calls.length = 0;
  await handleUpdate(env, owner.tap('P:cancel', 33));
  assert.ok(calls.some(c => /название не меняю/.test(c.body.text || '')));
});

// ── Одна задача на несколько человек ──
async function team() {
  const calls = fakeTelegram();
  let now = new Date('2026-09-30T09:00:00Z');
  const env = makeEnv({ _clock: () => now });
  const owner = person(730, 'Рина'), anna = person(731, 'Анна'), petya = person(732, 'Петя'), masha = person(733, 'Маша');
  await handleUpdate(env, owner.text('/start'));
  await handleUpdate(env, owner.text('/newproject Отдел'));
  const { id: pid, code } = await env.DB.prepare('SELECT id, code FROM projects').first();
  for (const p of [anna, petya, masha]) await handleUpdate(env, p.text('/start join_' + code));
  const all = async () => (await env.DB.prepare('SELECT * FROM tasks ORDER BY id').all()).results.map(r => ({ ...JSON.parse(r.data), id: r.id, owner: r.owner_id, assignee: r.assignee_id, done: !!r.done }));
  return { calls, env, owner, anna, petya, masha, pid, all, setNow: d => { now = d; } };
}

test('общая задача словами: одна у автора с прогрессом, у каждого своя копия; «все сделали» закрывает', async () => {
  const { calls, env, owner, anna, petya, all } = await team();
  calls.length = 0;
  await handleUpdate(env, owner.text('Отдел: @Анна @Петя сверить акты до пятницы'));
  let ts = await all();
  assert.equal(ts.length, 3, 'общая + 2 копии');
  const parent = ts.find(t => t.group);
  assert.deepEqual(parent.group.kids.map(k => k.uid).sort(), [anna.id, petya.id].sort());
  assert.ok(calls.to(owner.id).some(c => /👥 Задача поставлена: <b>Анна, Петя<\/b>/.test(c.body.text || '')));
  for (const p of [anna, petya]) assert.ok(calls.to(p.id).some(c => /Новая задача от Рина<\/b> <i>\(общая — на 2 чел\.\)<\/i>[\s\S]*Сверить акты[\s\S]*👥 общая задача/.test(c.body.text || '')));

  // у автора в списке — одна строка с прогрессом; у Анны — только её копия
  calls.length = 0;
  await handleUpdate(env, owner.text('/list'));
  const list = calls.find(c => /Все задачи/.test(c.body.text || '')).body.text;
  assert.equal((list.match(/Сверить акты/g) || []).length, 1);
  assert.match(list, /Сверить акты.*👥 0\/2/);
  await handleUpdate(env, anna.text('/list'));
  assert.equal((calls.to(anna.id).at(-1).body.text.match(/Сверить акты/g) || []).length, 1);

  // Анна сделала → автору «1/2»; Петя сделал → «все сделали», общая закрыта
  const kidA = ts.find(t => t.parent && t.assignee === anna.id), kidP = ts.find(t => t.parent && t.assignee === petya.id);
  calls.length = 0;
  await handleUpdate(env, anna.tap(`a:${kidA.id}:done`, 5));
  assert.ok(calls.to(owner.id).some(c => /Анна<\/b> сделал\(а\) «Сверить акты» \(1\/2\)/.test(c.body.text || '')));
  assert.match(JSON.stringify((await all()).find(t => t.group).group), /"done":true/);
  await handleUpdate(env, petya.tap(`a:${kidP.id}:done`, 5));
  assert.ok(calls.to(owner.id).some(c => /🎉 Все сделали «<b>Сверить акты<\/b>» \(2\/2\)/.test(c.body.text || '')));
  assert.equal((await all()).find(t => t.group).done, true);
  // Петя вернул в работу — общая снова открыта
  await handleUpdate(env, petya.tap(`a:${kidP.id}:undo`, 5));
  assert.equal((await all()).find(t => t.group).done, false);
});

test('общая задача: «всем», галочками, правка у автора доходит до всех, снять человека, закрыть и удалить', async () => {
  const { calls, env, owner, anna, petya, masha, all } = await team();
  await handleUpdate(env, owner.text('Отдел: всем подготовить отчёт к пятнице'));
  let parent = (await all()).find(t => t.group);
  assert.equal(parent.group.kids.length, 3, 'всем трём');

  // срок и подробности у автора → у всех копий, с уведомлением
  calls.length = 0;
  await handleUpdate(env, owner.tap(`a:${parent.id}:tom`, 9));
  await handleUpdate(env, owner.reply(await lastCardMsg(env, owner.id, parent.id), 'шаблон в общей папке\n- заполнить таблицу'));
  for (const kid of (await all()).filter(t => t.parent)) {
    assert.equal(kid.due.date, '2026-10-01', 'срок обновился у копии');
    assert.ok(kid.notes.some(n => n.text === 'шаблон в общей папке'));
    assert.deepEqual(kid.checklist.map(c => c.text), ['заполнить таблицу']);
  }
  assert.ok(calls.to(masha.id).some(c => /Рина<\/b> изменил\(а\) общую задачу/.test(c.body.text || '')));

  // галочками: снять Машу
  await handleUpdate(env, owner.tap(`a:${parent.id}:more`, 9));
  await handleUpdate(env, owner.tap(`a:${parent.id}:assign`, 9));
  const pick = [...calls].reverse().find(c => c.method === 'editMessageText' && c.body.message_id === 9);
  assert.match(JSON.stringify(pick.body.reply_markup), /☑ Маша/);
  await handleUpdate(env, owner.tap(`a:${parent.id}:gp${masha.id}`, 9));
  calls.length = 0;
  await handleUpdate(env, owner.tap(`a:${parent.id}:gpok`, 9));
  assert.ok(calls.to(masha.id).some(c => /Рина<\/b> снял\(а\) с тебя задачу/.test(c.body.text || '')));
  parent = (await all()).find(t => t.group);
  assert.equal(parent.group.kids.length, 2);
  assert.equal((await all()).filter(t => t.parent).length, 2, 'копия Маши удалена');

  // копию нельзя переназначить
  const kidA = (await all()).find(t => t.parent && t.assignee === anna.id);
  calls.length = 0;
  await handleUpdate(env, anna.tap(`a:${kidA.id}:as${petya.id}`, 3));
  assert.ok(calls.some(c => c.method === 'answerCallbackQuery' && /исполнителей меняет автор/.test(c.body.text || '')));

  // автор закрыл общую — закрыта у всех
  calls.length = 0;
  await handleUpdate(env, owner.tap(`a:${parent.id}:done`, 9));
  assert.ok((await all()).filter(t => t.parent).every(t => t.done));
  assert.ok(calls.to(petya.id).some(c => /закрыл\(а\) общую задачу/.test(c.body.text || '')));

  // новая общая галочками с карточки и удаление
  await handleUpdate(env, owner.text('Отдел: проверить договоры'));
  const t2 = (await all()).at(-1);
  await handleUpdate(env, owner.tap(`a:${t2.id}:grp`, 10));
  await handleUpdate(env, owner.tap(`a:${t2.id}:gp${anna.id}`, 10));
  await handleUpdate(env, owner.tap(`a:${t2.id}:gp${masha.id}`, 10));
  await handleUpdate(env, owner.tap(`a:${t2.id}:gpok`, 10));
  assert.equal((await all()).filter(t => t.parent === t2.id).length, 2);
  calls.length = 0;
  await handleUpdate(env, owner.tap(`a:${t2.id}:delok`, 10));
  assert.equal((await all()).filter(t => t.parent === t2.id || t.id === t2.id).length, 0, 'удалены у всех');
  assert.ok(calls.to(masha.id).some(c => /удалил\(а\) общую задачу/.test(c.body.text || '')));
  // «↩️ Восстановить» — возвращается обычной задачей автора, без «висящих» копий
  await handleUpdate(env, owner.tap(`r:${t2.id}`, 10));
  const back = (await all()).find(t => t.id === t2.id);
  assert.ok(back && !back.group && !back.parent, 'восстановлена обычной');
  assert.ok(calls.to(owner.id).some(c => /Восстановлено/.test(c.body.text || '')));
  // один человек галочкой — обычное поручение
  await handleUpdate(env, owner.text('Отдел: позвонить юристу'));
  const t3 = (await all()).at(-1);
  await handleUpdate(env, owner.tap(`a:${t3.id}:grp`, 11));
  await handleUpdate(env, owner.tap(`a:${t3.id}:gp${petya.id}`, 11));
  await handleUpdate(env, owner.tap(`a:${t3.id}:gpok`, 11));
  const t3b = (await all()).find(t => t.id === t3.id);
  assert.equal(t3b.assignee, petya.id);
  assert.ok(!t3b.group);
});

test('общая повторяющаяся: когда все сделали — следующий раз; вышедший из проекта убирается из общей', async () => {
  const { calls, env, owner, anna, petya, masha, all, pid } = await team();
  await handleUpdate(env, owner.text('Отдел: всем отчёт каждую пятницу'));
  let parent = (await all()).find(t => t.group);
  assert.deepEqual(parent.due, { date: '2026-10-02', time: null });
  const kids = (await all()).filter(t => t.parent);
  assert.ok(kids.every(k => k.repeat && k.due.date === '2026-10-02'));
  // Маша вышла из проекта — её копия исчезла из общей
  await handleUpdate(env, masha.tap(`P:l${pid}`, 1));
  parent = (await all()).find(t => t.group);
  assert.equal(parent.group.kids.length, 2);
  calls.length = 0;
  for (const p of [anna, petya]) {
    const k = (await all()).find(t => t.parent && t.assignee === p.id);
    await handleUpdate(env, p.tap(`a:${k.id}:done`, 2));
  }
  assert.ok(calls.to(owner.id).some(c => /🎉 Все сделали «<b>Отчёт<\/b>»\. Следующий раз: 9 окт/.test(c.body.text || '')));
  parent = (await all()).find(t => t.group);
  assert.equal(parent.due.date, '2026-10-09');
  assert.ok(parent.group.kids.every(k => !k.done), 'новый круг');
  assert.ok(!calls.some(c => /изменил\(а\) общую задачу/.test(c.body.text || '')), 'копии сами перешли на следующий раз — лишних сообщений нет');
  assert.ok(!calls.to(owner.id).some(c => /: выполнено/.test(c.body.text || '')), 'автору только прогресс, без дублей');
});
