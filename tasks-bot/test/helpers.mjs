import { DatabaseSync } from 'node:sqlite';

// Минимальная замена Cloudflare D1 поверх SQLite
export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql) => {
    let args = [];
    const api = {
      bind: (...a) => { args = a; return api; },
      run: async () => { db.prepare(sql).run(...args); return { success: true }; },
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      _exec: () => /^\s*(select|insert.*returning)/is.test(sql)
        ? { results: db.prepare(sql).all(...args) }
        : (db.prepare(sql).run(...args), { results: [] }),
    };
    return api;
  };
  return {
    prepare: stmt,
    batch: async (list) => list.map(s => s._exec()),
    raw: db,
  };
}

// Поддельный Telegram: записывает вызовы, выдаёт message_id
export function fakeTelegram() {
  const calls = [];
  let msgId = 100;
  globalThis.fetch = async (url, init) => {
    if (url.includes('/file/bot')) return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    const method = url.split('/').pop();
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ method, body });
    let result = true;
    if (method === 'sendMessage') result = { message_id: ++msgId };
    if (method === 'getMe') result = { username: 'my_tasks_bot' };
    if (method === 'getFile') result = { file_path: 'voice/1.oga' };
    return { json: async () => ({ ok: true, result }) };
  };
  calls.texts = () => calls.filter(c => c.body && c.body.text).map(c => c.body.text);
  calls.to = (id) => calls.filter(c => c.method === 'sendMessage' && c.body.chat_id === id);
  return calls;
}

export const CLOCK = new Date('2026-09-30T09:00:00Z'); // среда, 12:00 МСК

export function makeEnv(extra = {}) {
  return { DB: fakeD1(), BOT_TOKEN: '123:abc', WEBHOOK_SECRET: 's', TIMEZONE: 'Europe/Moscow', _clock: () => CLOCK, ...extra };
}

// Конструктор апдейтов от конкретного человека
let updateId = 1;
export function person(id, first_name, username) {
  const from = { id, first_name, username };
  const chat = { id, type: 'private' };
  let mid = 1000;
  return {
    id,
    text: (text, extra = {}) => ({ update_id: updateId++, message: { message_id: ++mid, chat, from, text, ...extra } }),
    reply: (msgId, text) => ({ update_id: updateId++, message: { message_id: ++mid, chat, from, text, reply_to_message: { message_id: msgId } } }),
    voice: () => ({ update_id: updateId++, message: { message_id: ++mid, chat, from, voice: { file_id: 'v1' } } }),
    tap: (data, msgId = 1, markup) => ({ update_id: updateId++, callback_query: { id: 'q', from, data, message: { message_id: msgId, chat, reply_markup: markup } } }),
  };
}

export async function tasksOf(env) {
  return (await env.DB.prepare('SELECT * FROM tasks ORDER BY id').all()).results.map(r => ({
    ...JSON.parse(r.data), id: r.id, owner: r.owner_id, project: r.project_id, assignee: r.assignee_id, done: !!r.done, doneAt: r.done_at,
  }));
}

export async function lastCardMsg(env, chatId, taskId) {
  const r = await env.DB.prepare('SELECT msg_id FROM msgs WHERE chat_id = ? AND task_id = ? ORDER BY msg_id DESC').bind(chatId, taskId).first();
  return r && r.msg_id;
}
