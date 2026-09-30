// ─────────────────────────────────────────────────────────────
//  Бот-планировщик задач для Telegram (Cloudflare Worker, один файл)
//  Хранилище: Cloudflare D1 (привязка DB). Напоминания: Cron Trigger.
//  Переменные: BOT_TOKEN, WEBHOOK_SECRET, TIMEZONE, ALLOWED_USERS,
//              MORNING_AT, EVENING_AT — см. README.md
// ─────────────────────────────────────────────────────────────

const WD_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MAX_DONE_KEPT = 100;
const MAX_MSG_IDS = 20;

// ── Даты: всё храним в «местном» времени как строки YYYY-MM-DD и HH:MM ──

const dateFromYmd = s => new Date(s + 'T00:00:00Z');
const ymd = d => d.toISOString().slice(0, 10);
function addDays(s, n) { const d = dateFromYmd(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
function addMonths(s, n) {
  const d = dateFromYmd(s), day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return ymd(d);
}
const weekday = s => dateFromYmd(s).getUTCDay();
const daysBetween = (a, b) => Math.round((dateFromYmd(b) - dateFromYmd(a)) / 864e5);
const stamp = (date, time) => Date.parse(`${date}T${time || '23:59'}:00Z`);
const pad = n => String(n).padStart(2, '0');

function localNow(tz, at = new Date()) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function validDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const s = `${y}-${pad(m)}-${pad(d)}`;
  return ymd(dateFromYmd(s)) === s ? s : null;
}

// ── Разбор текста задачи: срок, время, важность ──

const B = '(?<![\\p{L}\\d])';
const E = '(?![\\p{L}\\d])';
const PREP = '(?:(?:до|к|ко|в|во|на)\\s+)?';
const WEEKDAYS = [ // индекс = getUTCDay()
  'воскресень[еяю]|вс', 'понедельник[ау]?|пн', 'вторник[ау]?|вт', 'сред[аыу]|ср',
  'четверг[ау]?|чт', 'пятниц[аыу]|пт', 'суббот[аыу]|сб',
];
const MONTHS_RE = [
  'янв(?:аря|арь)?', 'фев(?:раля|раль)?', 'мар(?:та|т)?', 'апр(?:еля|ель)?', 'ма[йя]', 'июн[яь]?',
  'июл[яь]?', 'авг(?:уста|уст)?', 'сен(?:тября|тябрь)?', 'окт(?:ября|ябрь)?', 'ноя(?:бря|брь)?', 'дек(?:абря|абрь)?',
];
// дни недели для повторов, включая «по понедельникам»
const WD_REP = [
  'воскресень(?:ям|е|я|ю)|вс', 'понедельник(?:ам|а|у)?|пн', 'вторник(?:ам|а|у)?|вт', 'сред(?:ам|а|ы|у)|ср',
  'четверг(?:ам|а|у)?|чт', 'пятниц(?:ам|а|ы|у)|пт', 'суббот(?:ам|а|ы|у)|сб',
];
const WD_ANY = `(?:${WD_REP.join('|')})`;
const WD_ONE = WD_REP.map(w => new RegExp(`${B}(?:${w})${E}`, 'iu'));
const RE = {
  everyWd: new RegExp(`${B}(?:кажд(?:ый|ую|ое)|по)\\s+${WD_ANY}(?:\\s*(?:,|и)\\s*${WD_ANY})*${E}`, 'iu'),
  workdays: new RegExp(`${B}(?:по\\s+будн(?:ям|им\\s+дням)|каждый\\s+будний\\s+день)${E}`, 'iu'),
  weekends: new RegExp(`${B}(?:по\\s+выходным|каждые\\s+выходные)${E}`, 'iu'),
  every: new RegExp(`${B}(?:кажд(?:ый|ую|ое|ые|ого)\\s+(?:(\\d+)\\s+)?(день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)|(ежедневно|еженедельно|ежемесячно|ежегодно))${E}`, 'iu'),
  dayNum: new RegExp(`${B}(?:кажд(?:ое|ого)\\s+)?(\\d{1,2})(?:-?(?:е|го|ое|ого))?\\s+числ[оа]${E}`, 'iu'),
  time: new RegExp(`${B}(?:(?:в|к|до|на)\\s+)?([01]?\\d|2[0-3]):([0-5]\\d)${E}`, 'iu'),
  numDate: new RegExp(`${B}${PREP}(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{4}|\\d{2}))?${E}`, 'iu'),
  nameDate: new RegExp(`${B}${PREP}(\\d{1,2})\\s+(?:${MONTHS_RE.map(m => `(${m})`).join('|')})\\.?${E}`, 'iu'),
  rel: new RegExp(`${B}${PREP}(сегодня|завтра|послезавтра)${E}`, 'iu'),
  after: new RegExp(`${B}через\\s+(?:(\\d+)\\s+)?(день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев)${E}`, 'iu'),
  weekday: new RegExp(`${B}${PREP}(?:(эт[уотй]|следующ\\p{L}*)\\s+)?(?:${WEEKDAYS.map(w => `(${w})`).join('|')})${E}`, 'iu'),
  bang: /(^|\s)!{1,3}(?=\s|$)|!{2,}/u,
  urgent: new RegExp(`${B}(срочно|важно|asap)${E}`, 'iu'),
};

function parseTask(input, now) {
  let s = ' ' + input + ' ';
  let date = null, time = null, high = false, repeat = null, md = null;
  const take = (re, fn) => {
    const m = s.match(re);
    if (!m || fn(m) === false) return;
    s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
  };

  take(RE.time, m => { time = `${pad(+m[1])}:${m[2]}`; });

  // Повторы: «каждый понедельник», «по будням», «каждые 2 недели», «ежемесячно», «каждое 10 число»
  take(RE.workdays, () => { repeat = { unit: 'week', n: 1, wd: [1, 2, 3, 4, 5] }; });
  if (!repeat) take(RE.weekends, () => { repeat = { unit: 'week', n: 1, wd: [6, 0] }; });
  if (!repeat) take(RE.everyWd, m => {
    const wd = [1, 2, 3, 4, 5, 6, 0].filter(i => WD_ONE[i].test(m[0]));
    repeat = { unit: 'week', n: 1, wd };
  });
  if (!repeat) take(RE.every, m => {
    const w = (m[2] || m[3]).toLowerCase();
    const unit = /^(д|ежедн)/.test(w) ? 'day' : /^(н|еженед)/.test(w) ? 'week' : /^(м|ежемес)/.test(w) ? 'month' : 'year';
    repeat = { unit, n: m[1] ? Math.max(1, +m[1]) : 1 };
  });
  take(RE.dayNum, m => {
    const d = +m[1];
    if (d < 1 || d > 31) return false;
    md = d;
    if (!repeat && /^\s*кажд/i.test(m[0])) repeat = { unit: 'month', n: 1 };
  });
  if (repeat && repeat.unit !== 'month') md = null; // «каждую неделю 10 числа» — число игнорируем
  if (md && !repeat) date = monthDayOnOrAfter(now.date, md); // «10 числа» — ближайшее 10-е

  take(RE.numDate, m => {
    const d = +m[1], mo = +m[2];
    let y = m[3] ? +m[3] : +now.date.slice(0, 4);
    if (y < 100) y += 2000;
    let v = validDate(y, mo, d);
    if (!v) return false;
    if (!m[3] && v < now.date) v = validDate(y + 1, mo, d) || v;
    date = v;
  });

  if (!date) take(RE.nameDate, m => {
    const mo = m.slice(2).findIndex(Boolean) + 1;
    const y = +now.date.slice(0, 4);
    let v = validDate(y, mo, +m[1]);
    if (!v) return false;
    if (v < now.date) v = validDate(y + 1, mo, +m[1]) || v;
    date = v;
  });

  if (!date) take(RE.rel, m => {
    date = addDays(now.date, { 'сегодня': 0, 'завтра': 1, 'послезавтра': 2 }[m[1].toLowerCase()]);
  });

  if (!date) take(RE.after, m => {
    const n = m[1] ? +m[1] : 1, unit = m[2].toLowerCase();
    if (unit.startsWith('д')) date = addDays(now.date, n);
    else if (unit.startsWith('н')) date = addDays(now.date, 7 * n);
    else date = addMonths(now.date, n);
  });

  if (!date) take(RE.weekday, m => {
    const wd = m.slice(2).findIndex(Boolean);
    const today = weekday(now.date);
    let diff = (wd - today + 7) % 7 || 7; // ближайший такой день, не сегодня
    if (m[1] && /^след/i.test(m[1])) {
      const daysToSunday = (7 - today) % 7;
      if (diff <= daysToSunday) diff += 7; // «в следующую пятницу» — на следующей неделе
    }
    date = addDays(now.date, diff);
  });

  if (RE.bang.test(s)) { high = true; s = s.replace(new RegExp(RE.bang.source, 'gu'), ' '); }
  if (RE.urgent.test(s)) high = true;

  if (repeat) {
    if (repeat.unit === 'month') repeat.md = md || (date ? +date.slice(8) : +now.date.slice(8));
    if (!date) date = firstOccurrence(repeat, now, time);
  }
  if (time && !date) date = time > now.time ? now.date : addDays(now.date, 1);

  let title = s.replace(/\s+/g, ' ').replace(/^[\s,.;:—–-]+|[\s,;:—–-]+$/gu, '').trim();
  if (title) title = title[0].toUpperCase() + title.slice(1);
  return { title, due: date ? { date, time } : null, high, repeat };
}

// ── Повторы ──

function withMonthDay(s, md) { // тот же месяц, число md (или последнее число месяца)
  const [y, m] = s.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(Math.min(md, last))}`;
}

function monthDayOnOrAfter(today, md) {
  const d = withMonthDay(today, md);
  return d >= today ? d : withMonthDay(addMonths(today.slice(0, 8) + '01', 1), md);
}

function nextOccurrence(rep, from) {
  if (rep.wd && rep.wd.length) {
    let d = addDays(from, 1);
    while (!rep.wd.includes(weekday(d))) d = addDays(d, 1);
    return d;
  }
  if (rep.unit === 'day') return addDays(from, rep.n);
  if (rep.unit === 'week') return addDays(from, 7 * rep.n);
  if (rep.unit === 'month') return withMonthDay(addMonths(from.slice(0, 8) + '01', rep.n), rep.md || +from.slice(8));
  return addMonths(from, 12 * rep.n);
}

function firstOccurrence(rep, now, time) {
  let d = now.date;
  if (rep.wd && rep.wd.length) while (!rep.wd.includes(weekday(d))) d = addDays(d, 1);
  else if (rep.unit === 'month') d = monthDayOnOrAfter(now.date, rep.md);
  if (d === now.date && time && time <= now.time) d = nextOccurrence(rep, d); // сегодня время уже прошло
  return d;
}

// Следующий срок после выполнения: строго в будущем, пропущенные разы не копятся
function advanceRepeat(t, now) {
  let d = nextOccurrence(t.repeat, t.due ? t.due.date : now.date);
  while (d <= now.date) d = nextOccurrence(t.repeat, d);
  setDue(t, { date: d, time: t.due ? t.due.time : null });
}

const WD_PLURAL = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
function fmtRepeat(rep) {
  if (!rep) return '';
  if (rep.wd && rep.wd.length) {
    const k = [...rep.wd].sort().join('');
    if (k === '12345') return 'по будням';
    if (k === '06') return 'по выходным';
    return 'по ' + [1, 2, 3, 4, 5, 6, 0].filter(i => rep.wd.includes(i)).map(i => WD_PLURAL[i]).join(', ');
  }
  const n = rep.n || 1;
  if (rep.unit === 'day') return n === 1 ? 'каждый день' : `каждые ${n} дн.`;
  if (rep.unit === 'week') return n === 1 ? 'каждую неделю' : `каждые ${n} нед.`;
  if (rep.unit === 'month') return (n === 1 ? 'каждый месяц' : `каждые ${n} мес.`) + `, ${rep.md} числа`;
  return n === 1 ? 'каждый год' : `каждые ${n} г.`;
}

// ── Форматирование ──

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fmtDate(dateStr, now) {
  const diff = daysBetween(now.date, dateStr);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  if (diff === -1) return 'вчера';
  const d = dateFromYmd(dateStr);
  const base = `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
  const year = d.getUTCFullYear() !== +now.date.slice(0, 4) ? ' ' + d.getUTCFullYear() : '';
  if (diff > 1 && diff < 7) return `${WD_SHORT[d.getUTCDay()]}, ${base}`;
  return base + year;
}
const fmtDue = (due, now) => due ? fmtDate(due.date, now) + (due.time ? ' ' + due.time : '') : 'без срока';

function isOverdue(t, now) {
  if (!t.due) return false;
  return t.due.time ? stamp(t.due.date, t.due.time) < stamp(now.date, now.time) : t.due.date < now.date;
}

function bucketOf(t, now) {
  if (!t.due) return 'nodate';
  if (isOverdue(t, now)) return 'overdue';
  const diff = daysBetween(now.date, t.due.date);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff <= 7) return 'week';
  return 'later';
}

const BUCKETS = [
  ['overdue', '🔴 Просрочено'],
  ['today', '📍 Сегодня'],
  ['tomorrow', '🔜 Завтра'],
  ['week', '🗓 Ближайшая неделя'],
  ['later', '📆 Позже'],
  ['nodate', '📥 Без срока'],
];

function sortTasks(list) {
  return [...list].sort((a, b) =>
    (b.high - a.high) ||
    ((a.due ? stamp(a.due.date, a.due.time) : Infinity) - (b.due ? stamp(b.due.date, b.due.time) : Infinity)) ||
    (a.id - b.id));
}

function taskLine(t, now, bucket) {
  let due = '';
  if (t.due) {
    if (bucket === 'today' || bucket === 'tomorrow') due = t.due.time || '';
    else due = fmtDue(t.due, now);
  }
  return `${t.high ? '🔥 ' : '• '}${esc(t.title)}${due ? ` <i>· ${due}</i>` : ''}${t.repeat ? ' 🔁' : ''}${t.notes.length ? ' 📝' : ''}  /t${t.id}`;
}

function renderGroups(tasks, now, only) {
  const out = [];
  for (const [key, label] of BUCKETS) {
    if (only && !only.includes(key)) continue;
    const items = sortTasks(tasks.filter(t => bucketOf(t, now) === key));
    if (!items.length) continue;
    out.push(`<b>${label}</b>\n` + items.map(t => taskLine(t, now, key)).join('\n'));
  }
  return out.join('\n\n');
}

function clip(text, max = 4000) {
  return text.length <= max ? text : text.slice(0, max - 30).replace(/\n[^\n]*$/, '') + '\n\n… полный список: /list';
}

function renderDash(st, now) {
  const open = st.tasks.filter(t => !t.done);
  const head = `📌 <b>Мои задачи</b> — ${open.length}  <i>(обновлено ${fmtDate(now.date, now)} ${now.time})</i>`;
  if (!open.length) return head + '\n\nВсё сделано 🎉 Напиши новую задачу, когда появится.';
  return clip(head + '\n\n' + renderGroups(open, now));
}

function renderCard(t, now) {
  let s = `${t.done ? '✅' : t.high ? '🔥' : '📌'} <b>${esc(t.title)}</b>  <code>#${t.id}</code>\n`;
  if (t.done) s += `<i>Выполнено ${t.doneAt ? fmtDate(t.doneAt, now) : ''}</i>\n`;
  else {
    s += `📅 ${fmtDue(t.due, now)}`;
    if (isOverdue(t, now)) s += ' — <b>просрочено!</b>';
    s += '\n';
  }
  if (t.repeat) {
    s += `🔁 ${fmtRepeat(t.repeat)}`;
    const cnt = (t.history || []).length;
    if (cnt) s += ` · выполнено раз: ${cnt}`;
    s += '\n';
  }
  if (t.notes.length) {
    s += '\n📝 <b>Подробности:</b>\n' + t.notes.map(n => '— ' + esc(n.text)).join('\n') + '\n';
  }
  if (!t.done) s += '\n<i>↩️ Ответь на это сообщение — допишу подробности. Ответь датой («завтра 15:00») — перенесу срок.</i>';
  return clip(s);
}

function cardKeyboard(t, confirmDelete = false) {
  const b = (text, act) => ({ text, callback_data: `a:${t.id}:${act}` });
  if (confirmDelete) return { inline_keyboard: [[b('🗑 Да, удалить', 'delok'), b('Отмена', 'card')]] };
  if (t.done) return { inline_keyboard: [[b('↩️ Вернуть в работу', 'undo'), b('🗑', 'del')]] };
  if (t.repeat) return {
    inline_keyboard: [
      [b('Сегодня', 'today'), b('Завтра', 'tom'), b('⏭ Пропустить раз', 'skip')],
      [b(t.high ? '⬇️ Обычная' : '🔥 Важно', 'hi'), b('✅ Готово', 'done'), b('🔁✖', 'norep'), b('🗑', 'del')],
    ],
  };
  return {
    inline_keyboard: [
      [b('Сегодня', 'today'), b('Завтра', 'tom'), b('+неделя', 'week'), b('Без срока', 'none')],
      [b(t.high ? '⬇️ Обычная' : '🔥 Важно', 'hi'), b('✅ Готово', 'done'), b('🗑', 'del')],
    ],
  };
}

// ── Telegram API ──

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false, description: 'bad json' }));
  if (!j.ok && !/not modified/.test(j.description || '')) console.log('TG', method, j.description);
  return j;
}

const send = (env, chatId, text, extra = {}) =>
  tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });

// ── Хранилище (D1): один JSON на чат ──

let dbReady = false;
async function ensureDb(env) {
  if (dbReady) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS store (k TEXT PRIMARY KEY, v TEXT NOT NULL)').run();
  dbReady = true;
}

async function loadState(env, chatId, now) {
  await ensureDb(env);
  const row = await env.DB.prepare('SELECT v FROM store WHERE k = ?').bind('u:' + chatId).first();
  if (row) return JSON.parse(row.v);
  // Новый пользователь: сегодняшние сводки считаем уже отправленными, чтобы не прислать «доброе утро» ночью
  return { chatId, nextId: 1, tasks: [], dashId: null, lastUpdateId: 0, lastMorning: now.date, lastEvening: now.date };
}

async function saveState(env, st) {
  const done = st.tasks.filter(t => t.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
  if (done.length > MAX_DONE_KEPT) {
    const drop = new Set(done.slice(MAX_DONE_KEPT).map(t => t.id));
    st.tasks = st.tasks.filter(t => !drop.has(t.id));
  }
  await env.DB.prepare('INSERT INTO store (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
    .bind('u:' + st.chatId, JSON.stringify(st)).run();
}

// ── Логика задач ──

function addMsgId(t, id) {
  t.msgIds = [...(t.msgIds || []).filter(x => x !== id), id].slice(-MAX_MSG_IDS);
}

function findTaskByMsg(st, msgId) {
  return st.tasks.find(t => (t.msgIds || []).includes(msgId));
}

async function sendCard(env, st, t, now, prefix = '') {
  const r = await send(env, st.chatId, prefix + renderCard(t, now), { reply_markup: cardKeyboard(t) });
  if (r.ok) addMsgId(t, r.result.message_id);
  return r;
}

async function refreshDash(env, st, now) {
  const text = renderDash(st, now);
  if (st.dashId) {
    const r = await tg(env, 'editMessageText', {
      chat_id: st.chatId, message_id: st.dashId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    });
    if (r.ok || /not modified/.test(r.description || '')) return;
  }
  const m = await send(env, st.chatId, text, { disable_notification: true });
  if (m.ok) {
    st.dashId = m.result.message_id;
    await tg(env, 'pinChatMessage', { chat_id: st.chatId, message_id: st.dashId, disable_notification: true });
  }
}

function setDue(t, due) {
  t.due = due;
  t.rem = {};
}

const HELP = `👋 Я помогу ничего не забыть.

<b>Как добавить задачу</b>
Просто напиши её. Срок можно указать прямо в тексте:
• <i>Отчёт для Маши до пятницы</i>
• <i>Позвонить врачу завтра 10:00</i>
• <i>Оплатить налог 25.10</i>
• <i>Продлить домен через 2 недели</i>
Добавь <b>!!</b> или слово «срочно» — задача станет важной 🔥
Всё, что после первой строки, попадёт в подробности.

<b>Регулярные задачи</b> 🔁
• <i>Выпить витамины каждый день в 9:00</i>
• <i>Отчёт по продажам каждый понедельник</i>
• <i>Планёрка по вторникам и четвергам 11:00</i>
• <i>Оплатить интернет каждое 10 число</i>
• <i>Полить цветы каждые 3 дня</i> · <i>Зарядка по будням</i> · <i>ежегодно</i>
Нажмёшь ✅ — задача сама перенесётся на следующий раз.
Ответь на карточку «каждую пятницу» — сделаю задачу регулярной, «не повторять» — отменю.

<b>После собрания</b>
Ответь (reply) на сообщение с задачей — текст добавится в подробности.
Ответь датой («в понедельник», «завтра 15:00») — перенесу срок.

<b>Пересылка</b>
Перешли сюда любое сообщение (например, из «Избранного») — оно станет задачей.

<b>Команды</b>
/list — все задачи по срокам
/today — просрочено, сегодня и завтра
/done — выполненные
/repeat — регулярные задачи
/t12 — открыть задачу №12
/pin — заново закрепить список

📌 Закреплённое сообщение наверху чата — всегда актуальный список.
☀️ Утром пришлю план на день, 🌙 вечером — что осталось и что завтра.
⏰ Если у задачи есть время — напомню за час и в срок.`;

async function handleCommand(env, st, cmd, arg, now) {
  const chatId = st.chatId;
  const open = st.tasks.filter(t => !t.done);
  const tm = cmd.match(/^\/t_?(\d+)$/) || (cmd === '/t' && arg.match(/^(\d+)$/));
  if (tm) {
    const t = st.tasks.find(x => x.id === +tm[1]);
    if (!t) return send(env, chatId, `Задачи #${tm[1]} нет.`);
    return sendCard(env, st, t, now);
  }
  switch (cmd) {
    case '/start':
    case '/help':
      await send(env, chatId, HELP + `\n\n<i>Твой Telegram ID: <code>${chatId}</code></i>`);
      return refreshDash(env, st, now);
    case '/list':
    case '/all':
      return send(env, chatId, open.length ? clip('📋 <b>Все задачи</b>\n\n' + renderGroups(open, now)) : 'Задач нет 🎉');
    case '/today': {
      const text = renderGroups(open, now, ['overdue', 'today', 'tomorrow']);
      return send(env, chatId, text ? clip(text) : 'На сегодня и завтра сроков нет 🎉 Все задачи: /list');
    }
    case '/done': {
      const done = st.tasks.filter(t => t.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || '')).slice(0, 15);
      return send(env, chatId, done.length
        ? '✅ <b>Недавно выполнено</b>\n\n' + done.map(t => `• <s>${esc(t.title)}</s>  /t${t.id}`).join('\n')
        : 'Пока ничего не выполнено.');
    }
    case '/repeat': {
      const rep = sortTasks(open.filter(t => t.repeat));
      return send(env, chatId, rep.length
        ? '🔁 <b>Регулярные задачи</b>\n\n' + rep.map(t =>
          `• ${esc(t.title)} <i>· ${fmtRepeat(t.repeat)}${t.due && t.due.time ? ' в ' + t.due.time : ''}, следующий раз ${fmtDue(t.due, now)}</i>  /t${t.id}`).join('\n')
        : 'Регулярных задач пока нет. Напиши, например: «Оплатить интернет каждое 10 число».');
    }
    case '/pin':
      st.dashId = null;
      return refreshDash(env, st, now);
    case '/morning':
      return sendMorning(env, st, now, true);
    default:
      return send(env, chatId, 'Не знаю такой команды. Подсказка: /help');
  }
}

function forwardLabel(msg) {
  const o = msg.forward_origin;
  if (!o) return null;
  if (o.type === 'user') return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ');
  if (o.type === 'hidden_user') return o.sender_user_name;
  if (o.type === 'chat') return o.sender_chat.title;
  if (o.type === 'channel') return o.chat.title;
  return null;
}

async function handleMessage(env, st, msg, now) {
  const text = (msg.text || msg.caption || '').trim();
  const chatId = st.chatId;

  if (msg.text && text.startsWith('/')) {
    const [raw, ...rest] = text.split(/\s+/);
    return { cmd: raw.replace(/@\w+$/, '').toLowerCase(), arg: rest.join(' ') };
  }

  // Ответ на сообщение с задачей → подробности или перенос срока
  const replyTo = msg.reply_to_message;
  const target = replyTo && findTaskByMsg(st, replyTo.message_id);
  if (target) {
    if (!text) { await send(env, chatId, 'Пришли подробности текстом 🙏'); return; }
    const p = parseTask(text, now);
    if (/^(не повторять|без повтора|убрать повтор)$/i.test(text) && target.repeat) {
      delete target.repeat;
      await sendCard(env, st, target, now, '🔁✖ Больше не повторяется\n\n');
    } else if (!p.title && (p.due || p.repeat)) {
      if (p.repeat) target.repeat = p.repeat;
      setDue(target, p.due);
      if (target.done) { target.done = false; target.doneAt = null; }
      await sendCard(env, st, target, now, p.repeat
        ? `🔁 Теперь повторяется: <b>${fmtRepeat(p.repeat)}</b>\n\n`
        : `📅 Срок перенесён: <b>${fmtDue(p.due, now)}</b>\n\n`);
    } else {
      target.notes.push({ at: now.date, text });
      await sendCard(env, st, target, now, '📝 Добавлено в подробности\n\n');
    }
    return { changed: true };
  }

  if (!text) {
    await send(env, chatId, 'Я понимаю только текст (или подпись к фото/файлу). Напиши задачу словами 🙂');
    return;
  }

  const [first, ...restLines] = text.split('\n');
  const p = parseTask(first, now);
  const from = forwardLabel(msg);
  let title = p.title;
  if (!title) {
    await send(env, chatId, 'Вижу срок, но не вижу, что сделать 🙂 Напиши, например: «Сдать отчёт завтра».');
    return;
  }
  const notes = [];
  const rest = restLines.join('\n').trim();
  if (rest) notes.push({ at: now.date, text: rest });
  if (from) notes.push({ at: now.date, text: `Переслано от: ${from}` });

  const t = {
    id: st.nextId++, title, notes, due: p.due, high: p.high,
    done: false, doneAt: null, createdAt: now.date, msgIds: [], rem: {},
  };
  if (p.repeat) { t.repeat = p.repeat; t.history = []; }
  st.tasks.push(t);
  const hint = p.due ? '' : '\n\n<i>Срок не указан — выбери кнопкой или ответь датой.</i>';
  const r = await send(env, chatId, '✅ Задача сохранена\n\n' + renderCard(t, now) + hint, { reply_markup: cardKeyboard(t) });
  if (r.ok) addMsgId(t, r.result.message_id);
  return { changed: true };
}

async function handleCallback(env, st, cq, now) {
  const m = (cq.data || '').match(/^a:(\d+):(\w+)$/);
  const t = m && st.tasks.find(x => x.id === +m[1]);
  if (!t) return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Задача не найдена' });
  const act = m[2];
  let toast = '', confirmDelete = false, deleted = false;
  const keepTime = t.repeat && t.due ? t.due.time : null; // у повторяющихся время обычно «привязано» (таблетки в 9:00)

  if (act === 'done' && t.repeat && !t.done) {
    t.history = [...(t.history || []), now.date].slice(-60);
    advanceRepeat(t, now);
    toast = `✅ Отмечено! Следующий раз: ${fmtDue(t.due, now)}`;
  } else if (act === 'skip' && t.repeat) {
    advanceRepeat(t, now);
    toast = `⏭ Пропущено. Следующий раз: ${fmtDue(t.due, now)}`;
  } else if (act === 'norep') {
    delete t.repeat;
    toast = 'Больше не повторяется';
  } else switch (act) {
    case 'today': setDue(t, { date: now.date, time: keepTime }); toast = 'Срок: сегодня'; break;
    case 'tom': setDue(t, { date: addDays(now.date, 1), time: keepTime }); toast = 'Срок: завтра'; break;
    case 'week': setDue(t, { date: addDays(now.date, 7), time: null }); toast = 'Срок: через неделю'; break;
    case 'none': setDue(t, null); toast = 'Без срока'; break;
    case 'hi': t.high = !t.high; toast = t.high ? '🔥 Важная' : 'Обычная'; break;
    case 'done': t.done = true; t.doneAt = now.date; toast = '✅ Готово! Так держать'; break;
    case 'undo': t.done = false; t.doneAt = null; toast = 'Снова в работе'; break;
    case 'del': confirmDelete = true; break;
    case 'delok': st.tasks = st.tasks.filter(x => x !== t); deleted = true; toast = 'Удалено'; break;
    case 'card': break;
  }

  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: toast });
  const msg = cq.message;
  if (msg) {
    if (deleted) {
      await tg(env, 'editMessageText', {
        chat_id: st.chatId, message_id: msg.message_id, parse_mode: 'HTML',
        text: `🗑 <s>${esc(t.title)}</s> — удалено`,
      });
    } else {
      addMsgId(t, msg.message_id);
      await tg(env, 'editMessageText', {
        chat_id: st.chatId, message_id: msg.message_id, parse_mode: 'HTML',
        text: renderCard(t, now), reply_markup: cardKeyboard(t, confirmDelete),
        link_preview_options: { is_disabled: true },
      });
    }
  }
  return { changed: !confirmDelete && act !== 'card' };
}

async function handleUpdate(env, upd) {
  const msg = upd.message;
  const cq = upd.callback_query;
  const chat = msg ? msg.chat : cq && cq.message && cq.message.chat;
  const user = msg ? msg.from : cq && cq.from;
  if (!chat || chat.type !== 'private' || !user) return;

  const allowed = (env.ALLOWED_USERS || '').split(/[\s,]+/).filter(Boolean);
  if (allowed.length && !allowed.includes(String(user.id))) {
    if (msg) await send(env, chat.id, `Это личный бот. Твой ID: <code>${user.id}</code>`);
    return;
  }

  const now = localNow(tz(env), env._clock ? env._clock() : undefined);
  const st = await loadState(env, chat.id, now);
  if (upd.update_id <= st.lastUpdateId) return; // повтор от Telegram
  st.lastUpdateId = upd.update_id;

  let res;
  if (cq) res = await handleCallback(env, st, cq, now);
  else {
    res = await handleMessage(env, st, msg, now);
    if (res && res.cmd) { await handleCommand(env, st, res.cmd, res.arg, now); res = { changed: true }; }
  }
  if (res && res.changed) await refreshDash(env, st, now);
  await saveState(env, st);
}

// ── Сводки и напоминания (Cron) ──

const tz = env => env.TIMEZONE || 'Europe/Moscow';
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const inWindow = (nowTime, at) => { const d = toMin(nowTime) - toMin(at); return d >= 0 && d < 180; };

async function sendMorning(env, st, now, manual = false) {
  const open = st.tasks.filter(t => !t.done);
  if (!open.length) {
    if (manual) await send(env, st.chatId, 'Задач нет 🎉');
    return;
  }
  const main = renderGroups(open, now, ['overdue', 'today']);
  const hot = sortTasks(open.filter(t => t.high && !t.due));
  const tomorrow = open.filter(t => bucketOf(t, now) === 'tomorrow').length;
  let s = '☀️ <b>Доброе утро! План на сегодня</b>\n\n';
  s += main || 'Сегодня дедлайнов нет 👌';
  if (hot.length) s += '\n\n<b>🔥 Важные без срока</b>\n' + hot.map(t => taskLine(t, now, 'nodate')).join('\n');
  s += `\n\n<i>Завтра: ${tomorrow || 'ничего'} · всего открытых: ${open.length} · /list</i>`;
  await send(env, st.chatId, clip(s));
}

async function sendEvening(env, st, now) {
  const open = st.tasks.filter(t => !t.done);
  const left = renderGroups(open, now, ['overdue', 'today']);
  const tomorrow = renderGroups(open, now, ['tomorrow']);
  if (!left && !tomorrow) return;
  let s = '🌙 <b>Вечерняя сверка</b>\n';
  if (left) s += '\nЕщё не закрыто — отметь сделанное или перенеси:\n\n' + left + '\n';
  if (tomorrow) s += '\n' + tomorrow;
  await send(env, st.chatId, clip(s));
}

async function cronUser(env, key, at) {
  const now = localNow(tz(env), at);
  const row = await env.DB.prepare('SELECT v FROM store WHERE k = ?').bind(key).first();
  if (!row) return;
  const st = JSON.parse(row.v);
  const ns = stamp(now.date, now.time);
  let changed = false;

  for (const t of st.tasks) {
    if (t.done || !t.due || !t.due.time) continue;
    t.rem = t.rem || {};
    const ds = stamp(t.due.date, t.due.time);
    if (!t.rem.h1 && !t.repeat && ns >= ds - 3600e3 && ns < ds) { // у регулярных — только в срок, без «через час»
      await sendCard(env, st, t, now, '⏰ <b>Через час срок</b>\n\n');
      t.rem.h1 = 1; changed = true;
    }
    if (!t.rem.due && ns >= ds) {
      if (ns - ds < 6 * 3600e3) await sendCard(env, st, t, now, '⏰ <b>Время пришло!</b>\n\n');
      t.rem.due = 1; t.rem.h1 = 1; changed = true;
    }
  }

  const morningAt = env.MORNING_AT || '09:00';
  if (morningAt !== 'off' && st.lastMorning !== now.date && inWindow(now.time, morningAt)) {
    st.lastMorning = now.date;
    await sendMorning(env, st, now);
    changed = true;
  }
  const eveningAt = env.EVENING_AT || '20:00';
  if (eveningAt !== 'off' && st.lastEvening !== now.date && inWindow(now.time, eveningAt)) {
    st.lastEvening = now.date;
    await sendEvening(env, st, now);
    changed = true;
  }
  // Раз в день перерисовываем закреплённый список: «завтра» становится «сегодня» и т.д.
  if (st.lastDashDay !== now.date) { st.lastDashDay = now.date; changed = true; }

  if (changed) {
    await refreshDash(env, st, now);
    await saveState(env, st);
  }
}

async function runCron(env, at = new Date()) {
  await ensureDb(env);
  const { results } = await env.DB.prepare("SELECT k FROM store WHERE k LIKE 'u:%'").all();
  for (const r of results) {
    try { await cronUser(env, r.k, at); } catch (e) { console.error('cron', r.k, e && e.stack); }
  }
}

// ── Точки входа ──

async function setup(env, origin) {
  const hook = await tg(env, 'setWebhook', {
    url: origin + '/webhook',
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    max_connections: 1, // по одному обновлению за раз — без гонок при записи
  });
  const cmds = await tg(env, 'setMyCommands', {
    commands: [
      { command: 'list', description: 'Все задачи по срокам' },
      { command: 'today', description: 'Просрочено, сегодня, завтра' },
      { command: 'done', description: 'Выполненные' },
      { command: 'repeat', description: 'Регулярные задачи' },
      { command: 'pin', description: 'Закрепить список заново' },
      { command: 'help', description: 'Как пользоваться' },
    ],
  });
  await ensureDb(env);
  return { webhook: hook, commands: cmds, db: 'ok' };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || !env.DB) {
      return new Response('Не настроено: нужны BOT_TOKEN, WEBHOOK_SECRET и привязка D1 с именем DB', { status: 500 });
    }
    if (url.pathname === '/setup') {
      if (url.searchParams.get('secret') !== env.WEBHOOK_SECRET) return new Response('Неверный secret', { status: 403 });
      const res = await setup(env, url.origin);
      return new Response(JSON.stringify(res, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const upd = await request.json();
      try { await handleUpdate(env, upd); } catch (e) { console.error('update', e && e.stack); }
      return new Response('ok');
    }
    return new Response('Бот задач работает ✅');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env, new Date(event.scheduledTime)));
  },

  // для тестов
  _internal: { parseTask, localNow, renderDash, renderCard, handleUpdate, runCron, fmtDue },
};
