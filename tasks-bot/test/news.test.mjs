// Рассылка новости всем: только администратор, предпросмотр, подтверждение, частями, в рабочие часы, отчёт
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { fakeTelegram, makeEnv, person, tasksOf } from './helpers.mjs';

const { handleUpdate, runCron } = worker._internal;

test('новость всем: не-админу — подсказка; админу — предпросмотр, кнопка, отправка частями, отчёт', async () => {
  const calls = fakeTelegram();
  let now = new Date('2026-10-01T06:00:00Z'); // чт 09:00 МСК
  const env = makeEnv({ ADMIN_IDS: '1800', _clock: () => now });
  const admin = person(1800, 'Рина');
  const team = Array.from({ length: 60 }, (_, i) => person(1801 + i, 'Коллега ' + i));
  for (const p of [admin, ...team]) { await handleUpdate(env, p.text('/start')); await handleUpdate(env, p.tap('S:later', 1)); }
  // одна в отпуске, один с графиком до 18 (вечером уже нерабочее время), один заблокировал бота
  await handleUpdate(env, team[0].text('я в отпуске до 2.10'));
  globalThis.__blocked = new Set([team[1].id]);

  // не-администратор
  calls.length = 0;
  await handleUpdate(env, team[2].text('/news'));
  assert.ok(calls.some(c => /делает администратор[\s\S]*ADMIN_IDS[\s\S]*1803/.test(c.body.text || '')));

  // админ: /news → текст → предпросмотр
  calls.length = 0;
  await handleUpdate(env, admin.text('/news'));
  assert.ok(calls.some(c => /Новость для всех/.test(c.body.text || '')));
  const news = admin.text('Привет! Мы добавили ⚙️ настройки: тихие часы, отпуск и своё время напоминаний.');
  await handleUpdate(env, news);
  const copy = calls.find(c => c.method === 'copyMessage');
  assert.equal(copy.body.chat_id, admin.id, 'предпросмотр — себе');
  assert.match(JSON.stringify(copy.body.reply_markup), /O:menu/, 'в новости про настройки — кнопка сама');
  const ask = calls.find(c => /Так новость увидят все/.test(c.body.text || ''));
  assert.match(ask.body.text, /получателей: 60/);
  assert.equal((await tasksOf(env)).length, 0, 'новость не стала задачей');
  // убрать кнопку и вернуть
  await handleUpdate(env, admin.tap('N:btn', 77));
  assert.match(JSON.stringify([...calls].reverse().find(c => c.method === 'editMessageText').body.reply_markup), /➕ Кнопка/);
  await handleUpdate(env, admin.tap('N:btn', 77));

  // отправить: часть — сразу (лимит одного запуска), остальное — проверками по расписанию
  calls.length = 0;
  await handleUpdate(env, admin.tap('N:send', 77));
  const first = calls.filter(c => c.method === 'copyMessage').length;
  assert.ok(first > 10 && first < 45, `сразу ушло ${first}`);
  for (let i = 0; i < 4; i++) { now = new Date(now.getTime() + 5 * 60e3); await runCron(env, now); }
  const got = new Set(calls.filter(c => c.method === 'copyMessage').map(c => c.body.chat_id));
  assert.equal(got.size, 58, `все, кроме отпускницы и заблокировавшего: лишние ${[...got].filter(id => [team[0].id, team[1].id, admin.id].includes(id))}`);
  assert.ok(!got.has(team[0].id), 'в отпуске — не сейчас');
  assert.ok(!got.has(admin.id), 'себе второй раз не шлём');
  assert.ok(calls.filter(c => c.method === 'copyMessage').every(c => c.body.from_chat_id === admin.id && c.body.message_id === news.message.message_id && /O:menu/.test(JSON.stringify(c.body.reply_markup))));
  const rep = calls.filter(c => c.body.chat_id === admin.id && /Новость разослана/.test(c.body.text || ''));
  assert.equal(rep.length, 1, 'отчёт — один раз');
  assert.match(rep[0].body.text, /Доставлено: 58[\s\S]*Заблокировали бота: 1[\s\S]*Ещё 1 чел\./);
  // повторно никому не уходит; отпускница получает после отпуска, в рабочее время
  calls.length = 0;
  now = new Date('2026-10-02T21:00:00Z'); await runCron(env, now); // 00:00 сб — ночь
  assert.equal(calls.filter(c => c.method === 'copyMessage').length, 0);
  now = new Date('2026-10-03T06:00:00Z'); await runCron(env, now); // сб 09:00
  assert.deepEqual(calls.filter(c => c.method === 'copyMessage').map(c => c.body.chat_id), [team[0].id]);
  now = new Date('2026-10-03T06:05:00Z'); await runCron(env, now);
  assert.equal(calls.filter(c => c.method === 'copyMessage').length, 1, 'больше никому');
  globalThis.__blocked = null;
});

test('новость: отмена и «другой текст»; фото с подписью', async () => {
  const calls = fakeTelegram();
  const env = makeEnv({ ADMIN_IDS: '1900' });
  const admin = person(1900, 'Рина'), anna = person(1901, 'Анна');
  for (const p of [admin, anna]) await handleUpdate(env, p.text('/start'));
  await handleUpdate(env, admin.text('/news'));
  await handleUpdate(env, admin.tap('N:x', 5));
  calls.length = 0;
  await handleUpdate(env, admin.text('Обычная задача завтра'));
  assert.equal((await tasksOf(env)).length, 1, 'после отмены — обычная задача');
  await handleUpdate(env, admin.text('/news'));
  await handleUpdate(env, admin.text('Черновик'));
  await handleUpdate(env, admin.tap('N:redo', 6));
  const photo = admin.text('');
  delete photo.message.text;
  Object.assign(photo.message, { message_id: 4242, photo: [{ file_id: 'ph1', file_unique_id: 'u1', width: 10, height: 10 }], caption: 'Новая доска!' });
  calls.length = 0;
  await handleUpdate(env, photo);
  assert.ok(calls.some(c => c.method === 'copyMessage' && c.body.message_id === 4242));
  assert.equal((await tasksOf(env)).length, 1, 'фото-новость не стала задачей');
  calls.length = 0;
  await handleUpdate(env, admin.tap('N:send', 7));
  assert.deepEqual(calls.filter(c => c.method === 'copyMessage').map(c => [c.body.chat_id, c.body.message_id]), [[anna.id, 4242]]);
  assert.ok(calls.some(c => /Новость разослана[\s\S]*Доставлено: 1/.test(c.body.text || '')));
});
