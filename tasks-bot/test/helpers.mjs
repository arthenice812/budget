import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import assert from 'node:assert/strict';

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

// ── Строгая проверка того, что бот шлёт в Telegram (как это делает сам Telegram) ──
export const violations = [];
const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler', 'span']);
export function checkHtml(text) {
  const problems = [];
  const stack = [];
  const re = /<\/?([a-z-]+)(\s[^>]*)?>|&(#\d+|amp|lt|gt|quot);|[<>&]/g;
  let m;
  while ((m = re.exec(text))) {
    const tok = m[0];
    if (tok === '<' || tok === '>' || tok === '&') { problems.push(`голый символ «${tok}» в позиции ${m.index}`); continue; }
    if (tok[0] === '&') continue;
    const name = m[1];
    if (!ALLOWED_TAGS.has(name)) { problems.push(`тег <${name}> не поддерживается`); continue; }
    if (tok[1] === '/') {
      if (stack.pop() !== name) problems.push(`закрывающий </${name}> не на месте`);
    } else stack.push(name);
  }
  if (stack.length) problems.push(`не закрыты: ${stack.join(', ')}`);
  return problems;
}
const plainLen = text => text.replace(/<[^>]+>/g, '').replace(/&(#\d+|amp|lt|gt|quot);/g, 'x').length;
function validate(method, body) {
  const bad = msg => violations.push(`${method}: ${msg} :: ${String(body.text || '').slice(0, 80)}`);
  if ((method === 'sendMessage' || method === 'editMessageText') && typeof body.text === 'string') {
    if (!body.text.trim()) bad('пустой текст');
    if (body.parse_mode === 'HTML') for (const p of checkHtml(body.text)) bad(p);
    if (plainLen(body.text) > 4096) bad(`текст длиннее 4096 (${plainLen(body.text)})`);
  }
  if (method === 'answerCallbackQuery' && (body.text || '').length > 200) bad(`подсказка длиннее 200 (${body.text.length})`);
  // следы программной ошибки, которые пользователь увидел бы как мусор или нерабочую кнопку
  const JUNK = /undefined|NaN|\bnull\b|\[object |Invalid Date/;
  for (const k of ['text', 'caption']) if (typeof body[k] === 'string' && JUNK.test(body[k])) bad(`мусор в тексте: ${body[k].match(JUNK)[0]}`);
  for (const kbName of ['inline_keyboard', 'keyboard']) {
    for (const row of (body.reply_markup && body.reply_markup[kbName]) || []) for (const b of row) {
      const t = typeof b === 'string' ? b : b.text;
      if (JUNK.test(String(t))) bad(`мусор в тексте кнопки: ${t}`);
      if (b.callback_data !== undefined && (typeof b.callback_data !== 'string' || JUNK.test(b.callback_data))) bad(`мусор в callback_data: ${b.callback_data}`);
      if (b.url !== undefined && (typeof b.url !== 'string' || JUNK.test(b.url))) bad(`мусор в ссылке: ${b.url}`);
      if (b.web_app && JUNK.test(String(b.web_app.url))) bad(`мусор в ссылке приложения: ${b.web_app.url}`);
    }
  }
  const kb = body.reply_markup && body.reply_markup.inline_keyboard;
  if (kb) {
    let n = 0;
    for (const row of kb) for (const b of row) {
      n++;
      if (!b.text) bad('кнопка без текста');
      if (b.callback_data !== undefined && Buffer.byteLength(b.callback_data) > 64) bad(`callback_data длиннее 64 байт: ${b.callback_data}`);
      if (b.callback_data === undefined && !b.url && !b.web_app) bad('кнопка без действия');
    }
    if (n > 100) bad('больше 100 кнопок');
  }
}

// Ошибки, которые бот записал в лог, — тоже провал
export const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); origError(...a); };
// после всех тестов файла: ни одного нарушения правил Telegram и ни одной ошибки в логе
after(() => {
  assert.deepEqual(violations, [], 'бот отправил в Telegram то, что Telegram отверг бы');
  assert.deepEqual(errors.filter(e => !e.includes('ExperimentalWarning')), [], 'в логе есть ошибки');
});

// Поддельный Telegram: записывает вызовы, выдаёт message_id
export function fakeTelegram() {
  const calls = [];
  let msgId = 100;
  globalThis.fetch = async (url, init) => {
    if (url.includes('/file/bot')) return { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    if (url.includes('isdayoff.ru')) return { text: async () => (globalThis.__calendar || '') };
    if (globalThis.__ics && globalThis.__ics[url] !== undefined) return { status: 200, text: async () => globalThis.__ics[url] };
    const method = url.split('/').pop();
    const body = init && init.body ? JSON.parse(init.body) : {};
    validate(method, body);
    const call = { method, body };
    calls.push(call);
    let result = true;
    if (method === 'sendMessage' || method === 'sendPhoto' || method === 'sendDocument') result = { message_id: ++msgId };
    call.result = result;
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
