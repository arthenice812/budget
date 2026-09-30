// ─────────────────────────────────────────────────────────────
//  Бот-планировщик задач для Telegram (Cloudflare Worker)
//  Исходник: src/bot.js + src/app.html → сборка `npm run build` → worker.js
//  Хранилище: Cloudflare D1 (привязка DB). Напоминания: Cron Trigger.
//  Голосовые: Workers AI (привязка AI, необязательно).
//  Переменные: BOT_TOKEN, WEBHOOK_SECRET, TIMEZONE, ALLOWED_USERS,
//              MORNING_AT, EVENING_AT, WEEKLY_AT — см. README.md
// ─────────────────────────────────────────────────────────────

const APP_HTML = '__APP_HTML__';

const WD_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

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
  // «в 10 утра», «в 7 вечера», «к 15 часам» — часто так говорят в голосовых
  timeWords: new RegExp(`${B}(?:в|к|до|на)\\s+(\\d{1,2})(?:\\s+час(?:а|ов|ам)?(?:\\s+(утра|дня|вечера|ночи))?|\\s+(утра|дня|вечера|ночи))${E}`, 'iu'),
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
  if (!time) take(RE.timeWords, m => {
    let h = +m[1];
    const part = (m[2] || m[3] || '').toLowerCase();
    if (h > 23) return false;
    if ((part === 'дня' || part === 'вечера') && h < 12) h += 12;
    if (part === 'ночи' && h === 12) h = 0;
    time = `${pad(h)}:00`;
  });

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

  let title = s.replace(/\s+/g, ' ').replace(/^[\s,.;:—–-]+|[\s,.;:—–-]+$/gu, '').trim();
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


function setDue(t, due) {
  t.due = due;
  t.rem = {};
}

// ── Форматирование ──

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const short = (s, n = 28) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

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

const nameOf = (ctx, id) => (ctx.users.get(id) || {}).name || 'кто-то';
const projName = (ctx, id) => (ctx.projects.get(id) || {}).name;

function checkProgress(t) {
  const c = t.checklist || [];
  return c.length ? `☑${c.filter(x => x.done).length}/${c.length}` : '';
}

function taskLine(ctx, t, uid, bucket) {
  const now = ctx.now;
  let due = '';
  if (t.due) due = (bucket === 'today' || bucket === 'tomorrow') ? (t.due.time || '') : fmtDue(t.due, now);
  let s = `${t.high ? '🔥 ' : '• '}${esc(t.title)}`;
  if (t.project && projName(ctx, t.project)) s += ` <i>#${esc(projName(ctx, t.project))}</i>`;
  if (due) s += ` <i>· ${due}</i>`;
  if (t.assignee !== uid) s += ` → ${esc(nameOf(ctx, t.assignee))}`;
  else if (t.owner !== uid) s += ` <i>(от ${esc(nameOf(ctx, t.owner))})</i>`;
  if (t.repeat) s += ' 🔁';
  const cp = checkProgress(t);
  if (cp) s += ' ' + cp;
  if ((t.notes || []).length) s += ' 📝';
  return s + `  /t${t.id}`;
}

function renderGroups(ctx, tasks, uid, only) {
  const out = [];
  for (const [key, label] of BUCKETS) {
    if (only && !only.includes(key)) continue;
    const items = sortTasks(tasks.filter(t => bucketOf(t, ctx.now) === key));
    if (!items.length) continue;
    out.push(`<b>${label}</b>\n` + items.map(t => taskLine(ctx, t, uid, key)).join('\n'));
  }
  return out.join('\n\n');
}

function clip(text, max = 4000) {
  return text.length <= max ? text : text.slice(0, max - 30).replace(/\n[^\n]*$/, '') + '\n\n… полный список: /list';
}

function focusIds(user, now) {
  const f = user.data.focus;
  return f && f.date === now.date ? f.ids : [];
}

function renderDash(ctx, user, mine, delegated) {
  const now = ctx.now;
  const head = `📌 <b>Мои задачи</b> — ${mine.length}  <i>(обновлено ${fmtDate(now.date, now)} ${now.time})</i>`;
  const parts = [];
  const fIds = focusIds(user, now);
  const focus = mine.filter(t => fIds.includes(t.id));
  if (focus.length) parts.push('<b>⭐ Главное сегодня</b>\n' + focus.map(t => taskLine(ctx, t, user.id, bucketOf(t, now))).join('\n'));
  const rest = renderGroups(ctx, mine.filter(t => !fIds.includes(t.id)), user.id);
  if (rest) parts.push(rest);
  if (delegated.length) {
    parts.push('<b>📤 Поручено другим</b>\n' + sortTasks(delegated).map(t => taskLine(ctx, t, user.id, 'later')).join('\n'));
  }
  if (!parts.length) return head + '\n\nВсё сделано 🎉 Напиши новую задачу, когда появится.';
  return clip(head + '\n\n' + parts.join('\n\n'));
}

function isShared(ctx, t) {
  if (t.assignee !== t.owner) return true;
  const p = t.project && ctx.projects.get(t.project);
  return !!(p && p.members.size > 1);
}

function renderCard(ctx, t) {
  const now = ctx.now;
  let s = `${t.done ? '✅' : t.high ? '🔥' : '📌'} <b>${esc(t.title)}</b>  <code>#${t.id}</code>\n`;
  const meta = [];
  if (t.project && projName(ctx, t.project)) meta.push('📁 ' + esc(projName(ctx, t.project)));
  if (t.assignee !== t.owner) meta.push(`👤 ${esc(nameOf(ctx, t.assignee))} · от ${esc(nameOf(ctx, t.owner))}`);
  if (meta.length) s += meta.join(' · ') + '\n';
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
  if (t.remindAt && !t.done) s += `🔔 напомню ${fmtDue(t.remindAt, now)}\n`;
  const cl = t.checklist || [];
  if (cl.length) {
    s += `\n<b>Чек-лист ${checkProgress(t).slice(1)}</b>\n` +
      cl.map((c, i) => `${c.done ? '☑' : '☐'} ${i + 1}. ${c.done ? '<s>' + esc(c.text) + '</s>' : esc(c.text)}`).join('\n') + '\n';
  }
  if ((t.notes || []).length) {
    const shared = isShared(ctx, t);
    s += '\n📝 <b>Подробности:</b>\n' + t.notes.map(n =>
      '— ' + esc(n.text) + (shared && n.by ? ` <i>(${esc(nameOf(ctx, n.by))})</i>` : '')).join('\n') + '\n';
  }
  if (!t.done) s += '\n<i>↩️ Ответь на это сообщение — допишу подробности (строки с «-» станут чек-листом). Ответь датой — перенесу срок.</i>';
  return clip(s);
}

function canAssign(ctx, t) {
  const p = t.project && ctx.projects.get(t.project);
  return !!(p && p.members.size > 1);
}

function cardKeyboard(ctx, t, uid, mode = 'normal') {
  const b = (text, act) => ({ text, callback_data: `a:${t.id}:${act}` });
  if (mode === 'del') return { inline_keyboard: [[b('🗑 Да, удалить', 'delok'), b('Отмена', 'card')]] };
  if (mode === 'assign') {
    const p = ctx.projects.get(t.project);
    const rows = [...(p ? p.members : [])].map(id => [b((id === t.assignee ? '✔️ ' : '') + nameOf(ctx, id), 'as' + id)]);
    rows.push([b('← Назад', 'card')]);
    return { inline_keyboard: rows };
  }
  if (t.done) return { inline_keyboard: [[b('↩️ Вернуть в работу', 'undo'), b('🗑', 'del')]] };
  if (mode === 'stale') {
    return {
      inline_keyboard: [
        [b('📅 Сделать на этой неделе', 'wk'), b('👍 Ещё актуально', 'ok')],
        [b('✅ Уже сделано', 'done'), b('🗑 Удалить', 'del')],
      ],
    };
  }
  const rows = [];
  const cl = (t.checklist || []).slice(0, 12);
  for (let i = 0; i < cl.length; i += 6) {
    rows.push(cl.slice(i, i + 6).map((c, j) => b(`${c.done ? '☑' : '☐'} ${i + j + 1}`, 'ck' + (i + j))));
  }
  if (mode === 'snooze') rows.push([b('🔔 +1 час', 's1h'), b('🔔 Вечером', 'sev'), b('🔔 Завтра утром', 'smo')]);
  if (t.repeat) rows.push([b('Сегодня', 'today'), b('Завтра', 'tom'), b('⏭ Пропустить раз', 'skip')]);
  else rows.push([b('Сегодня', 'today'), b('Завтра', 'tom'), b('+неделя', 'week'), b('Без срока', 'none')]);
  const act = [b(t.high ? '⬇️ Обычная' : '🔥 Важно', 'hi'), b('✅ Готово', 'done')];
  if (canAssign(ctx, t)) act.push(b('👤', 'assign'));
  if (t.repeat) act.push(b('🔁✖', 'norep'));
  act.push(b('🗑', 'del'));
  rows.push(act);
  return { inline_keyboard: rows };
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

let botUsername = null;
async function getBotUsername(env) {
  if (env.BOT_USERNAME) return env.BOT_USERNAME;
  if (!botUsername) {
    const r = await tg(env, 'getMe', {});
    if (r.ok) botUsername = r.result.username;
  }
  return botUsername;
}

// ── Хранилище (D1) ──

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, username TEXT, data TEXT NOT NULL, created TEXT)',
  'CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_id INTEGER NOT NULL, code TEXT, created TEXT)',
  'CREATE TABLE IF NOT EXISTS members (project_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (project_id, user_id))',
  'CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, project_id INTEGER, assignee_id INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, done_at TEXT, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks (assignee_id, done)',
  'CREATE INDEX IF NOT EXISTS tasks_owner ON tasks (owner_id, done)',
  'CREATE INDEX IF NOT EXISTS tasks_project ON tasks (project_id, done)',
  'CREATE TABLE IF NOT EXISTS msgs (chat_id INTEGER NOT NULL, msg_id INTEGER NOT NULL, task_id INTEGER NOT NULL, at TEXT, PRIMARY KEY (chat_id, msg_id))',
];

const readyDbs = new WeakSet();
async function ensureDb(env) {
  if (readyDbs.has(env.DB)) return;
  await env.DB.batch(SCHEMA.map(q => env.DB.prepare(q)));
  readyDbs.add(env.DB);
}

async function makeCtx(env, at) {
  await ensureDb(env);
  const [u, p, m] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM users'),
    env.DB.prepare('SELECT * FROM projects'),
    env.DB.prepare('SELECT * FROM members'),
  ]);
  const users = new Map(u.results.map(r => [r.id, { id: r.id, name: r.name, username: r.username, data: JSON.parse(r.data), dirty: false }]));
  const projects = new Map(p.results.map(r => [r.id, { id: r.id, name: r.name, owner: r.owner_id, code: r.code, members: new Set() }]));
  for (const r of m.results) if (projects.has(r.project_id)) projects.get(r.project_id).members.add(r.user_id);
  return {
    env, users, projects, now: localNow(tz(env), at),
    dash: new Set(), outbox: [], origin: null,
  };
}

const DB = ctx => ctx.env.DB;

async function createUser(ctx, from) {
  const now = ctx.now;
  const user = {
    id: from.id,
    name: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id),
    username: from.username || null,
    // сегодняшние сводки считаем отправленными — чтобы новичку не пришло «доброе утро» ночью
    data: { lastMorning: now.date, lastEvening: now.date, lastWeekly: now.date, lastDashDay: now.date },
    dirty: false,
  };
  await DB(ctx).prepare('INSERT OR IGNORE INTO users (id, name, username, data, created) VALUES (?, ?, ?, ?, ?)')
    .bind(user.id, user.name, user.username, JSON.stringify(user.data), now.date).run();
  ctx.users.set(user.id, user);
  return user;
}

async function saveUsers(ctx) {
  const dirty = [...ctx.users.values()].filter(u => u.dirty);
  if (!dirty.length) return;
  await DB(ctx).batch(dirty.map(u => DB(ctx).prepare('UPDATE users SET name = ?, username = ?, data = ? WHERE id = ?')
    .bind(u.name, u.username, JSON.stringify(u.data), u.id)));
  for (const u of dirty) u.dirty = false;
}

const TASK_COLS = ['id', 'owner', 'project', 'assignee', 'done', 'doneAt'];
function rowToTask(r) {
  return { ...JSON.parse(r.data), id: r.id, owner: r.owner_id, project: r.project_id, assignee: r.assignee_id, done: !!r.done, doneAt: r.done_at };
}
function taskData(t) {
  const d = { ...t };
  for (const k of TASK_COLS) delete d[k];
  return JSON.stringify(d);
}

async function getTask(ctx, id) {
  const r = await DB(ctx).prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  return r ? rowToTask(r) : null;
}

async function queryTasks(ctx, where, ...args) {
  const st = DB(ctx).prepare(`SELECT * FROM tasks WHERE ${where}`);
  const { results } = await (args.length ? st.bind(...args) : st).all();
  return results.map(rowToTask);
}

async function insertTask(ctx, t) {
  const r = await DB(ctx).prepare('INSERT INTO tasks (owner_id, project_id, assignee_id, done, done_at, data) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(t.owner, t.project ?? null, t.assignee, t.done ? 1 : 0, t.doneAt ?? null, taskData(t)).first();
  t.id = r.id;
  return t;
}

async function saveTask(ctx, t) {
  await DB(ctx).prepare('UPDATE tasks SET owner_id = ?, project_id = ?, assignee_id = ?, done = ?, done_at = ?, data = ? WHERE id = ?')
    .bind(t.owner, t.project ?? null, t.assignee, t.done ? 1 : 0, t.doneAt ?? null, taskData(t), t.id).run();
}

async function deleteTask(ctx, t) {
  await DB(ctx).batch([
    DB(ctx).prepare('DELETE FROM tasks WHERE id = ?').bind(t.id),
    DB(ctx).prepare('DELETE FROM msgs WHERE task_id = ?').bind(t.id),
  ]);
}

async function rememberMsg(ctx, chatId, msgId, taskId) {
  await DB(ctx).prepare('INSERT OR REPLACE INTO msgs (chat_id, msg_id, task_id, at) VALUES (?, ?, ?, ?)')
    .bind(chatId, msgId, taskId, ctx.now.date).run();
}

async function taskByMsg(ctx, chatId, msgId) {
  const r = await DB(ctx).prepare('SELECT task_id FROM msgs WHERE chat_id = ? AND msg_id = ?').bind(chatId, msgId).first();
  return r ? getTask(ctx, r.task_id) : null;
}

function canAccess(ctx, t, uid) {
  if (t.owner === uid || t.assignee === uid) return true;
  const p = t.project && ctx.projects.get(t.project);
  return !!(p && p.members.has(uid));
}

const myOpenTasks = (ctx, uid) => queryTasks(ctx, 'done = 0 AND (assignee_id = ? OR owner_id = ?)', uid, uid);

// ── Проекты ──

function myProjects(ctx, uid) {
  return [...ctx.projects.values()].filter(p => p.members.has(uid));
}

function findProject(ctx, uid, name) {
  const n = name.toLowerCase().replace(/^#/, '');
  return myProjects(ctx, uid).find(p => p.name.toLowerCase() === n) ||
    (/^\d+$/.test(n) ? myProjects(ctx, uid).find(p => p.id === +n) : null);
}

function randomCode() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return [...a].map(x => 'abcdefghijkmnpqrstuvwxyz23456789'[x % 32]).join('');
}

async function createProject(ctx, uid, name) {
  const code = randomCode();
  const r = await DB(ctx).prepare('INSERT INTO projects (name, owner_id, code, created) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(name, uid, code, ctx.now.date).first();
  await DB(ctx).prepare('INSERT OR IGNORE INTO members (project_id, user_id) VALUES (?, ?)').bind(r.id, uid).run();
  const p = { id: r.id, name, owner: uid, code, members: new Set([uid]) };
  ctx.projects.set(p.id, p);
  return p;
}

async function joinProject(ctx, p, uid) {
  await DB(ctx).prepare('INSERT OR IGNORE INTO members (project_id, user_id) VALUES (?, ?)').bind(p.id, uid).run();
  p.members.add(uid);
}

async function leaveProject(ctx, p, uid) {
  await DB(ctx).prepare('DELETE FROM members WHERE project_id = ? AND user_id = ?').bind(p.id, uid).run();
  p.members.delete(uid);
  const others = [...p.members];
  // мои задачи в проекте, поставленные другими, возвращаем их авторам
  const mine = await queryTasks(ctx, 'project_id = ? AND assignee_id = ? AND done = 0', p.id, uid);
  for (const t of mine) {
    if (t.owner !== uid && p.members.has(t.owner)) { t.assignee = t.owner; await saveTask(ctx, t); ctx.dash.add(t.owner); }
  }
  if (!others.length) {
    // последний участник вышел — проект удаляем, задачи становятся личными
    await DB(ctx).batch([
      DB(ctx).prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').bind(p.id),
      DB(ctx).prepare('DELETE FROM projects WHERE id = ?').bind(p.id),
    ]);
    ctx.projects.delete(p.id);
  } else if (p.owner === uid) {
    p.owner = others[0];
    await DB(ctx).prepare('UPDATE projects SET owner_id = ? WHERE id = ?').bind(p.owner, p.id).run();
  }
}

// Ищем человека по @username или по имени среди тех, с кем есть общий проект
function findPerson(ctx, uid, handle, project) {
  const h = handle.toLowerCase();
  const pool = new Set();
  for (const p of project ? [project] : myProjects(ctx, uid)) for (const m of p.members) pool.add(m);
  for (const id of pool) {
    const u = ctx.users.get(id);
    if (!u) continue;
    if ((u.username || '').toLowerCase() === h) return u;
    if ((u.name || '').toLowerCase().split(/\s+/)[0] === h) return u;
  }
  return null;
}

async function inviteLink(ctx, p) {
  const bot = await getBotUsername(ctx.env);
  return `https://t.me/${bot}?start=join_${p.code}`;
}

// ── Карточки, списки, уведомления ──

async function sendCard(ctx, uid, t, prefix = '', mode = 'normal') {
  const r = await send(ctx.env, uid, prefix + renderCard(ctx, t), { reply_markup: cardKeyboard(ctx, t, uid, mode) });
  if (r.ok) await rememberMsg(ctx, uid, r.result.message_id, t.id);
  return r;
}

// Сообщить второй стороне (автору или исполнителю), кроме того, кто сделал действие
function notifyOthers(ctx, t, actorId, prefix) {
  for (const id of new Set([t.owner, t.assignee])) {
    if (id !== actorId && ctx.users.has(id)) ctx.outbox.push({ to: id, t, prefix });
  }
}

function touch(ctx, t) {
  ctx.dash.add(t.owner);
  ctx.dash.add(t.assignee);
}

async function refreshDash(ctx, uid) {
  const user = ctx.users.get(uid);
  if (!user) return;
  const all = await myOpenTasks(ctx, uid);
  const mine = all.filter(t => t.assignee === uid);
  const delegated = all.filter(t => t.assignee !== uid);
  const text = renderDash(ctx, user, mine, delegated);
  if (user.data.dashId) {
    const r = await tg(ctx.env, 'editMessageText', {
      chat_id: uid, message_id: user.data.dashId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    });
    if (r.ok || /not modified/.test(r.description || '')) return;
  }
  const m = await send(ctx.env, uid, text, { disable_notification: true });
  if (m.ok) {
    user.data.dashId = m.result.message_id;
    user.dirty = true;
    await tg(ctx.env, 'pinChatMessage', { chat_id: uid, message_id: m.result.message_id, disable_notification: true });
  }
}

async function flush(ctx) {
  for (const n of ctx.outbox.splice(0)) {
    try { await sendCard(ctx, n.to, n.t, n.prefix); } catch (e) { console.error('notify', e && e.stack); }
  }
  for (const uid of ctx.dash) {
    try { await refreshDash(ctx, uid); } catch (e) { console.error('dash', e && e.stack); }
  }
  ctx.dash.clear();
  await saveUsers(ctx);
}

// ── Создание задачи из текста ──

const HASHTAG = /(?<![\p{L}\d_&/])#([\p{L}\d_]+)/u;
const MENTION = /(?<![\p{L}\d_@.])@([\p{L}\d_]+)/u;
const LEAD_IN = /^\s*(?:напомни(?:ть)?(?:\s+мне)?|добавь(?:\s+задачу)?|задача|запиши|надо|нужно)[\s,:—-]+/iu;
const CHECK_LINE = /^\s*(?:[-–—•*]|\[\s?\]|☐)\s+(.+)$/u;

function parseDetails(text, by, now) {
  const notes = [], checklist = [], plain = [];
  for (const line of text.split('\n')) {
    const m = line.match(CHECK_LINE);
    if (m) checklist.push({ text: m[1].trim(), done: false });
    else if (line.trim()) plain.push(line.trim());
  }
  if (plain.length) notes.push({ at: now.date, by, text: plain.join('\n') });
  return { notes, checklist };
}

async function createFromText(ctx, user, text, { from = null, prefix = '', project: projectHint = null } = {}) {
  const now = ctx.now;
  const [firstRaw, ...restLines] = text.split('\n');
  let first = firstRaw.replace(LEAD_IN, '');
  let tag = null, mention = null;
  first = first.replace(HASHTAG, (_, n) => { tag = n; return ' '; });
  first = first.replace(MENTION, (_, n) => { mention = n; return ' '; });
  const p = parseTask(first, now);
  if (!p.title) return { error: 'Вижу срок, но не вижу, что сделать 🙂 Напиши, например: «Сдать отчёт завтра».' };

  const warn = [];
  let project = projectHint;
  let createdProject = false;
  if (tag) {
    project = findProject(ctx, user.id, tag);
    if (!project) { project = await createProject(ctx, user.id, tag); createdProject = true; }
  }
  let assignee = user.id;
  if (mention) {
    const person = findPerson(ctx, user.id, mention, project);
    if (person) {
      assignee = person.id;
      if (!project) {
        // поручение без хэштега: берём общий проект, если он один
        const common = myProjects(ctx, user.id).filter(pr => pr.members.has(person.id));
        if (common.length === 1) project = common[0];
      }
    } else {
      warn.push(`⚠️ Не нашёл «@${esc(mention)}» среди участников ${project ? `проекта «${esc(project.name)}»` : 'твоих проектов'}. Задача пока на тебе. Пригласить: /invite`);
    }
  }

  const details = parseDetails(restLines.join('\n'), user.id, now);
  if (from) details.notes.push({ at: now.date, by: user.id, text: `Переслано от: ${from}` });

  const t = {
    title: p.title, notes: details.notes, checklist: details.checklist, due: p.due, high: p.high,
    createdAt: now.date, rem: {}, owner: user.id, assignee, project: project ? project.id : null,
    done: false, doneAt: null,
  };
  if (p.repeat) { t.repeat = p.repeat; t.history = []; }
  await insertTask(ctx, t);
  touch(ctx, t);

  let head = prefix + (assignee === user.id ? '✅ Задача сохранена' : `📨 Задача поставлена: <b>${esc(nameOf(ctx, assignee))}</b>`);
  if (createdProject) head += `\n📁 Новый проект «${esc(project.name)}» — позвать в него людей: /invite_${project.id}`;
  if (warn.length) head += '\n' + warn.join('\n');
  const hint = p.due ? '' : '\n\n<i>Срок не указан — выбери кнопкой или ответь датой.</i>';
  const r = await send(ctx.env, user.id, head + '\n\n' + renderCard(ctx, t) + hint, { reply_markup: cardKeyboard(ctx, t, user.id) });
  if (r.ok) await rememberMsg(ctx, user.id, r.result.message_id, t.id);
  if (assignee !== user.id) ctx.outbox.push({ to: assignee, t, prefix: `📨 <b>Новая задача от ${esc(user.name)}</b>\n\n` });
  return { task: t };
}

// ── Действия над задачей (кнопки в чате и доска) ──

function fromStamp(ms) {
  const iso = new Date(ms).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function comingFriday(today) {
  const diff = (5 - weekday(today) + 7) % 7;
  return addDays(today, diff); // в пятницу — сегодня, в выходные — следующая пятница
}

async function applyAction(ctx, t, act, uid) {
  const now = ctx.now;
  const actor = esc(nameOf(ctx, uid));
  const keepTime = t.repeat && t.due ? t.due.time : null; // у регулярных время «привязано» (таблетки в 9:00)
  const res = { toast: '', mode: 'normal', changed: true, deleted: false };
  const dueNote = () => notifyOthers(ctx, t, uid, `📅 <b>${actor}</b>: срок теперь ${fmtDue(t.due, now)}\n\n`);

  if (act === 'done' && t.repeat && !t.done) {
    t.history = [...(t.history || []), now.date].slice(-60);
    (t.checklist || []).forEach(c => { c.done = false; });
    delete t.remindAt;
    advanceRepeat(t, now);
    res.toast = `✅ Отмечено! Следующий раз: ${fmtDue(t.due, now)}`;
    notifyOthers(ctx, t, uid, `✅ <b>${actor}</b>: выполнено (регулярная)\n\n`);
  } else if (act === 'done') {
    t.done = true; t.doneAt = now.date; delete t.remindAt;
    res.toast = '✅ Готово! Так держать';
    notifyOthers(ctx, t, uid, `✅ <b>${actor}</b>: выполнено\n\n`);
  } else if (act === 'undo') {
    t.done = false; t.doneAt = null; res.toast = 'Снова в работе';
    notifyOthers(ctx, t, uid, `↩️ <b>${actor}</b> вернул(а) задачу в работу\n\n`);
  } else if (act === 'skip' && t.repeat) {
    advanceRepeat(t, now); res.toast = `⏭ Пропущено. Следующий раз: ${fmtDue(t.due, now)}`;
  } else if (act === 'norep') {
    delete t.repeat; res.toast = 'Больше не повторяется';
  } else if (act === 'today') {
    setDue(t, { date: now.date, time: keepTime }); res.toast = 'Срок: сегодня'; dueNote();
  } else if (act === 'tom') {
    setDue(t, { date: addDays(now.date, 1), time: keepTime }); res.toast = 'Срок: завтра'; dueNote();
  } else if (act === 'week') {
    setDue(t, { date: addDays(now.date, 7), time: null }); res.toast = 'Срок: через неделю'; dueNote();
  } else if (act === 'wk') {
    setDue(t, { date: comingFriday(now.date), time: null }); t.reviewedAt = now.date;
    res.toast = `Срок: ${fmtDue(t.due, now)}`; dueNote();
  } else if (act === 'none') {
    setDue(t, null); res.toast = 'Без срока';
  } else if (act === 'ok') {
    t.reviewedAt = now.date; res.toast = '👍 Хорошо, спрошу снова через пару недель';
  } else if (act === 'hi') {
    t.high = !t.high; res.toast = t.high ? '🔥 Важная' : 'Обычная';
  } else if (/^ck\d+$/.test(act)) {
    const c = (t.checklist || [])[+act.slice(2)];
    if (!c) return { ...res, changed: false };
    c.done = !c.done; res.toast = c.done ? '☑ Отмечено' : '☐ Снято';
  } else if (act === 's1h' || act === 'sev' || act === 'smo') {
    const nowMs = stamp(now.date, now.time);
    const eveningAt = ctx.env.EVENING_AT && ctx.env.EVENING_AT !== 'off' ? ctx.env.EVENING_AT : '19:00';
    const morningAt = ctx.env.MORNING_AT && ctx.env.MORNING_AT !== 'off' ? ctx.env.MORNING_AT : '09:00';
    if (act === 's1h') t.remindAt = fromStamp(nowMs + 3600e3);
    else if (act === 'sev') t.remindAt = now.time < eveningAt ? { date: now.date, time: eveningAt } : fromStamp(nowMs + 2 * 3600e3);
    else t.remindAt = { date: addDays(now.date, 1), time: morningAt };
    res.toast = `🔔 Напомню ${fmtDue(t.remindAt, now)}`;
    res.mode = 'snooze';
  } else if (act === 'assign') {
    res.mode = 'assign'; res.changed = false;
  } else if (/^as\d+$/.test(act)) {
    const to = +act.slice(2);
    const p = ctx.projects.get(t.project);
    if (!p || !p.members.has(to)) return { ...res, toast: 'Этого человека нет в проекте', changed: false };
    if (to !== t.assignee) {
      ctx.dash.add(t.assignee);
      t.assignee = to; t.rem = {};
      if (to !== uid) ctx.outbox.push({ to, t, prefix: `📨 <b>${actor} поручил(а) тебе задачу</b>\n\n` });
    }
    res.toast = `👤 ${nameOf(ctx, to)}`;
  } else if (act === 'del') {
    if (t.owner !== uid) return { ...res, toast: 'Удалить может только автор задачи', changed: false };
    res.mode = 'del'; res.changed = false;
  } else if (act === 'delok') {
    if (t.owner !== uid) return { ...res, toast: 'Удалить может только автор задачи', changed: false };
    await deleteTask(ctx, t);
    touch(ctx, t);
    if (t.assignee !== uid && !t.done) {
      await send(ctx.env, t.assignee, `🗑 <b>${actor}</b> удалил(а) задачу «${esc(t.title)}»`);
    }
    return { ...res, deleted: true, toast: 'Удалено' };
  } else {
    res.changed = false; // 'card' — просто перерисовать
  }
  if (res.changed) { await saveTask(ctx, t); touch(ctx, t); }
  return res;
}

async function applyReply(ctx, user, t, text) {
  const now = ctx.now;
  const p = parseTask(text, now);
  const actor = esc(user.name);
  if (/^(не повторять|без повтора|убрать повтор)$/i.test(text.trim()) && t.repeat) {
    delete t.repeat;
    await saveTask(ctx, t); touch(ctx, t);
    return sendCard(ctx, user.id, t, '🔁✖ Больше не повторяется\n\n');
  }
  if (!p.title && (p.due || p.repeat) && !text.includes('\n')) {
    if (p.repeat) { t.repeat = p.repeat; t.history = t.history || []; }
    setDue(t, p.due);
    if (t.done) { t.done = false; t.doneAt = null; }
    await saveTask(ctx, t); touch(ctx, t);
    notifyOthers(ctx, t, user.id, `📅 <b>${actor}</b>: срок теперь ${fmtDue(t.due, now)}\n\n`);
    return sendCard(ctx, user.id, t, p.repeat
      ? `🔁 Теперь повторяется: <b>${fmtRepeat(p.repeat)}</b>\n\n`
      : `📅 Срок перенесён: <b>${fmtDue(p.due, now)}</b>\n\n`);
  }
  const d = parseDetails(text, user.id, now);
  t.notes = [...(t.notes || []), ...d.notes];
  t.checklist = [...(t.checklist || []), ...d.checklist];
  await saveTask(ctx, t); touch(ctx, t);
  notifyOthers(ctx, t, user.id, `💬 <b>${actor}</b> дописал(а) подробности\n\n`);
  const what = d.checklist.length && !d.notes.length ? `☑ Добавлено в чек-лист: ${d.checklist.length}` : '📝 Добавлено в подробности';
  return sendCard(ctx, user.id, t, what + '\n\n');
}

// ── Команды ──

const HELP = `👋 Я помогу ничего не забыть.

<b>Задача</b> — просто напиши её, срок прямо в тексте:
• <i>Отчёт для Маши до пятницы</i>
• <i>Позвонить врачу завтра в 10 утра</i>
• <i>Оплатить налог 25.10</i>
<b>!!</b> или «срочно» — важная 🔥. Строки ниже первой — подробности, строки с «-» — чек-лист.
🎙 Можно голосовым.

<b>Регулярные</b> 🔁 <i>каждый день в 9:00 · по вторникам и четвергам · по будням · каждое 10 число · каждые 3 дня</i>

<b>После собрания</b> — ответь (reply) на карточку задачи: текст допишется в подробности. Ответь датой — перенесу срок.

<b>Проекты</b> 📁 — хэштег: <i>#маркетинг Баннер до пт</i>
Позвать руководителя или коллегу: /invite — пришлю ссылку.
Поручить: <i>#маркетинг @Рина Отчёт до пт</i>

<b>Команды</b>
/list — все задачи · /list маркетинг — один проект
/today — просрочено, сегодня, завтра
/focus — выбрать 3 главные задачи дня
/projects — проекты · /repeat — регулярные
/done — выполненные · /week — итоги недели
/board — доска задач 📋 · /pin — закрепить список

📌 Закреплённое сообщение — всегда актуальный список.
☀️ Утром — план дня, 🌙 вечером — сверка, 📊 в воскресенье — итоги недели.`;

function projectLine(ctx, p, openCount) {
  const people = [...p.members].map(id => esc(nameOf(ctx, id))).join(', ');
  return `📁 <b>${esc(p.name)}</b> — открытых: ${openCount} · 👥 ${people}  /p${p.id}`;
}

async function renderProject(ctx, uid, p) {
  const tasks = await queryTasks(ctx, 'project_id = ? AND (done = 0 OR done_at >= ?)', p.id, addDays(ctx.now.date, -7));
  const open = tasks.filter(t => !t.done);
  let s = `📁 <b>${esc(p.name)}</b>\n👥 ${[...p.members].map(id => esc(nameOf(ctx, id))).join(', ')}\n`;
  const people = [...new Set([uid, ...p.members])];
  for (const id of people) {
    const list = sortTasks(open.filter(t => t.assignee === id));
    if (!list.length) continue;
    s += `\n<b>👤 ${id === uid ? 'Мои' : esc(nameOf(ctx, id))}</b>\n` + list.map(t => taskLine(ctx, t, id, bucketOf(t, ctx.now))).join('\n') + '\n';
  }
  if (!open.length) s += '\nОткрытых задач нет.\n';
  const done = tasks.filter(t => t.done).slice(-5);
  if (done.length) s += '\n<b>✅ За неделю</b>\n' + done.map(t => `• <s>${esc(t.title)}</s> — ${esc(nameOf(ctx, t.assignee))}`).join('\n') + '\n';
  s += `\n<i>Новая задача: #${esc(p.name.replace(/\s+/g, '_'))} текст · позвать людей /invite_${p.id} · выйти /leave_${p.id}</i>`;
  return clip(s);
}

function focusCandidates(ctx, mine) {
  const order = { overdue: 0, today: 1, tomorrow: 3, week: 4, later: 5, nodate: 6 };
  const rank = t => (t.high && !t.due ? 2 : order[bucketOf(t, ctx.now)]);
  return [...mine].sort((a, b) => rank(a) - rank(b) || (b.high - a.high) || a.id - b.id).slice(0, 8);
}

function focusKeyboard(ctx, user, cands) {
  const sel = focusIds(user, ctx.now);
  const rows = cands.map(t => [{ text: `${sel.includes(t.id) ? '⭐' : '☆'} ${short(t.title, 34)}`, callback_data: `f:${t.id}` }]);
  rows.push([{ text: '✔️ Готово', callback_data: 'f:ok' }]);
  return { inline_keyboard: rows };
}

async function sendFocusPicker(ctx, user, mine) {
  const cands = focusCandidates(ctx, mine);
  if (!cands.length) return send(ctx.env, user.id, 'Задач нет — выбирать не из чего 🎉');
  return send(ctx.env, user.id,
    '⭐ <b>Выбери до 3 главных задач на сегодня</b>\nОни будут наверху списка, а вечером я спрошу именно о них.',
    { reply_markup: focusKeyboard(ctx, user, cands) });
}

async function handleCommand(ctx, user, cmd, arg, msg) {
  const env = ctx.env, uid = user.id, now = ctx.now;
  let m;
  if ((m = cmd.match(/^\/t_?(\d+)$/)) || (cmd === '/t' && (m = arg.match(/^(\d+)$/)))) {
    const t = await getTask(ctx, +m[1]);
    if (!t || !canAccess(ctx, t, uid)) return send(env, uid, `Задачи #${m[1]} нет.`);
    return sendCard(ctx, uid, t);
  }
  if ((m = cmd.match(/^\/p_?(\d+)$/))) {
    const p = ctx.projects.get(+m[1]);
    if (!p || !p.members.has(uid)) return send(env, uid, 'Такого проекта нет.');
    return send(env, uid, await renderProject(ctx, uid, p));
  }
  if ((m = cmd.match(/^\/(invite|leave)_(\d+)$/))) { cmd = '/' + m[1]; arg = m[2]; }

  const all = await myOpenTasks(ctx, uid);
  const mine = all.filter(t => t.assignee === uid);

  switch (cmd) {
    case '/start': {
      const code = (arg.match(/^join_(\w+)$/) || [])[1];
      if (code) {
        const p = [...ctx.projects.values()].find(x => x.code === code);
        if (!p) return send(env, uid, 'Ссылка-приглашение устарела или неверная 🤷');
        if (!p.members.has(uid)) {
          await joinProject(ctx, p, uid);
          for (const id of p.members) if (id !== uid) await send(env, id, `👋 <b>${esc(user.name)}</b> теперь в проекте «${esc(p.name)}»`);
        }
        await send(env, uid, `🤝 Ты в проекте «<b>${esc(p.name)}</b>»!\n\nЗадачи проекта, поставленные тебе, появятся в твоём общем списке рядом с личными.\nНовая задача в проект: <i>#${esc(p.name.replace(/\s+/g, '_'))} текст задачи</i>\nВесь проект: /p${p.id}\n\nКак пользоваться ботом: /help`);
        ctx.dash.add(uid);
        return;
      }
      await send(env, uid, HELP);
      ctx.dash.add(uid);
      return;
    }
    case '/help':
      return send(env, uid, HELP);
    case '/list':
    case '/all': {
      if (arg) {
        const p = findProject(ctx, uid, arg);
        if (!p) return send(env, uid, `Проекта «${esc(arg)}» нет. Все проекты: /projects`);
        return send(env, uid, await renderProject(ctx, uid, p));
      }
      if (!all.length) return send(env, uid, 'Задач нет 🎉');
      let s = '📋 <b>Все задачи</b>\n\n' + renderGroups(ctx, mine, uid);
      const del = all.filter(t => t.assignee !== uid);
      if (del.length) s += '\n\n<b>📤 Поручено другим</b>\n' + sortTasks(del).map(t => taskLine(ctx, t, uid, 'later')).join('\n');
      return send(env, uid, clip(s));
    }
    case '/today': {
      const text = renderGroups(ctx, mine, uid, ['overdue', 'today', 'tomorrow']);
      return send(env, uid, text ? clip(text) : 'На сегодня и завтра сроков нет 🎉 Все задачи: /list');
    }
    case '/done': {
      const done = await queryTasks(ctx, 'done = 1 AND assignee_id = ? ORDER BY done_at DESC, id DESC LIMIT 15', uid);
      return send(env, uid, done.length
        ? '✅ <b>Недавно выполнено</b>\n\n' + done.map(t => `• <s>${esc(t.title)}</s>  /t${t.id}`).join('\n')
        : 'Пока ничего не выполнено.');
    }
    case '/repeat': {
      const rep = sortTasks(mine.filter(t => t.repeat));
      return send(env, uid, rep.length
        ? '🔁 <b>Регулярные задачи</b>\n\n' + rep.map(t =>
          `• ${esc(t.title)} <i>· ${fmtRepeat(t.repeat)}${t.due && t.due.time ? ' в ' + t.due.time : ''}, следующий раз ${fmtDue(t.due, now)}</i>  /t${t.id}`).join('\n')
        : 'Регулярных задач пока нет. Напиши, например: «Оплатить интернет каждое 10 число».');
    }
    case '/focus':
      return sendFocusPicker(ctx, user, mine);
    case '/week':
      return sendWeekly(ctx, user, true);
    case '/morning':
      return sendMorning(ctx, user, mine, true);
    case '/projects': {
      const ps = myProjects(ctx, uid);
      if (!ps.length) {
        return send(env, uid, '📁 Проектов пока нет.\n\nСоздать: /newproject Название\nИли просто поставь хэштег в задаче: <i>#ремонт Выбрать плитку</i>\n\nВ проект можно позвать руководителя или коллег — задачи, которые вам ставят друг другу, будут у каждого в своём списке.');
      }
      const counts = await queryTasks(ctx, `done = 0 AND project_id IN (${ps.map(() => '?').join(',')})`, ...ps.map(p => p.id));
      return send(env, uid, '<b>Твои проекты</b>\n\n' + ps.map(p => projectLine(ctx, p, counts.filter(t => t.project === p.id).length)).join('\n') +
        '\n\n<i>Новый: /newproject Название · позвать людей: /invite</i>');
    }
    case '/newproject': {
      const name = arg.replace(/^#/, '').trim();
      if (!name) return send(env, uid, 'Напиши название: /newproject Маркетинг');
      if (findProject(ctx, uid, name)) return send(env, uid, 'Такой проект уже есть: /projects');
      const p = await createProject(ctx, uid, name);
      return send(env, uid, `📁 Проект «<b>${esc(p.name)}</b>» создан.\n\nЗадача в проект: <i>#${esc(p.name.replace(/\s+/g, '_'))} текст задачи</i>\nПозвать людей: /invite_${p.id}`);
    }
    case '/invite': {
      const ps = myProjects(ctx, uid);
      let p = arg ? findProject(ctx, uid, arg) : (ps.length === 1 ? ps[0] : null);
      if (!p && !arg && !ps.length) {
        return send(env, uid, 'Сначала создай проект: /newproject Название — потом пришлю ссылку-приглашение.');
      }
      if (!p) return send(env, uid, 'В какой проект позвать?\n\n' + ps.map(x => `📁 ${esc(x.name)} — /invite_${x.id}`).join('\n'));
      const link = await inviteLink(ctx, p);
      return send(env, uid, `🔗 Приглашение в проект «<b>${esc(p.name)}</b>»\n\nПерешли это сообщение человеку — пусть откроет ссылку и нажмёт «Старт»:\n${link}\n\nПосле этого можно ставить друг другу задачи: <i>#${esc(p.name.replace(/\s+/g, '_'))} @имя что сделать до пт</i>`);
    }
    case '/leave': {
      const p = arg && findProject(ctx, uid, arg);
      if (!p) return send(env, uid, 'Из какого проекта выйти? Посмотри /projects и нажми /leave_номер');
      await leaveProject(ctx, p, uid);
      ctx.dash.add(uid);
      return send(env, uid, `Ты больше не в проекте «${esc(p.name)}».`);
    }
    case '/board': {
      if (!ctx.origin) return send(env, uid, 'Доска доступна через кнопку меню внизу слева.');
      return send(env, uid, '📋 Доска задач: колонки по срокам, перетаскивание, фильтр по проектам.', {
        reply_markup: { inline_keyboard: [[{ text: '📋 Открыть доску', web_app: { url: ctx.origin + '/app' } }]] },
      });
    }
    case '/pin':
      user.data.dashId = null; user.dirty = true;
      ctx.dash.add(uid);
      return;
    default:
      return send(env, uid, 'Не знаю такой команды. Подсказка: /help');
  }
}

// ── Сообщения ──

function forwardLabel(msg) {
  const o = msg.forward_origin;
  if (!o) return null;
  if (o.type === 'user') return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ');
  if (o.type === 'hidden_user') return o.sender_user_name;
  if (o.type === 'chat') return o.sender_chat.title;
  if (o.type === 'channel') return o.chat.title;
  return null;
}

async function transcribe(ctx, fileId) {
  const env = ctx.env;
  if (!env.AI) return { error: '🎙 Чтобы я понимал голосовые, подключи Workers AI (см. README, шаг «Голосовые»). А пока напиши текстом 🙏' };
  const f = await tg(env, 'getFile', { file_id: fileId });
  if (!f.ok) return { error: 'Не получилось скачать голосовое 😕' };
  const r = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${f.result.file_path}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  try {
    const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio: btoa(bin), language: 'ru' });
    const text = (out && out.text || '').trim();
    return text ? { text } : { error: 'Не разобрал слов в голосовом 🤔 Попробуй ещё раз.' };
  } catch (e) {
    console.error('whisper', e && e.stack);
    return { error: 'Распознавание голоса сейчас не сработало 😕 Напиши текстом.' };
  }
}

async function handleMessage(ctx, user, msg) {
  const env = ctx.env, uid = user.id;
  let text = (msg.text || msg.caption || '').trim();
  let prefix = '';

  if (msg.text && text.startsWith('/')) {
    const [raw, ...rest] = text.split(/\s+/);
    return handleCommand(ctx, user, raw.replace(/@\w+$/, '').toLowerCase(), rest.join(' ').trim(), msg);
  }

  const voice = msg.voice || msg.audio || msg.video_note;
  if (voice && !text) {
    const r = await transcribe(ctx, voice.file_id);
    if (r.error) return send(env, uid, r.error);
    text = r.text;
    prefix = `🎙 <i>«${esc(text)}»</i>\n\n`;
  }

  const replyTo = msg.reply_to_message;
  const target = replyTo && await taskByMsg(ctx, uid, replyTo.message_id);
  if (target && canAccess(ctx, target, uid)) {
    if (!text) return send(env, uid, 'Пришли подробности текстом или голосом 🙏');
    return applyReply(ctx, user, target, text);
  }

  if (!text) return send(env, uid, 'Я понимаю текст, голосовые и подписи к фото/файлам. Напиши задачу словами 🙂');

  const r = await createFromText(ctx, user, text, { from: forwardLabel(msg), prefix });
  if (r.error) return send(env, uid, prefix + r.error);
}

// ── Кнопки ──

async function handleCallback(ctx, user, cq) {
  const env = ctx.env, uid = user.id;
  const data = cq.data || '';
  const msg = cq.message;
  const answer = text => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: text || '' });

  // выбор главных задач дня
  let m = data.match(/^f:(\d+|ok)$/);
  if (m) {
    const all = await myOpenTasks(ctx, uid);
    const mine = all.filter(t => t.assignee === uid);
    const f = user.data.focus && user.data.focus.date === ctx.now.date ? user.data.focus : { date: ctx.now.date, ids: [] };
    if (m[1] === 'ok') {
      const chosen = mine.filter(t => f.ids.includes(t.id));
      await answer(chosen.length ? '⭐ Отличный план!' : '');
      if (msg) {
        await tg(env, 'editMessageText', {
          chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML',
          text: chosen.length
            ? '⭐ <b>Главное на сегодня</b>\n' + chosen.map((t, i) => `${i + 1}. ${esc(t.title)}  /t${t.id}`).join('\n')
            : 'Главные задачи не выбраны. Выбрать: /focus',
        });
      }
      return;
    }
    const id = +m[1];
    if (f.ids.includes(id)) f.ids = f.ids.filter(x => x !== id);
    else if (f.ids.length >= 3) return answer('Не больше трёх — иначе это уже не главное 🙂');
    else f.ids.push(id);
    user.data.focus = f; user.dirty = true;
    ctx.dash.add(uid);
    await answer(f.ids.includes(id) ? '⭐' : '');
    if (msg) await tg(env, 'editMessageReplyMarkup', { chat_id: uid, message_id: msg.message_id, reply_markup: focusKeyboard(ctx, user, focusCandidates(ctx, mine)) });
    return;
  }

  // вечерняя сверка: e:<id>:done|tom
  m = data.match(/^e:(\d+):(done|tom)$/);
  if (m) {
    const t = await getTask(ctx, +m[1]);
    if (!t || !canAccess(ctx, t, uid)) return answer('Задача не найдена');
    const res = t.done && m[2] === 'done' ? { toast: 'Уже выполнено' } : await applyAction(ctx, t, m[2], uid);
    await answer(res.toast);
    if (msg) {
      const ev = await renderEvening(ctx, user);
      if (ev) await tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text: ev.text, reply_markup: ev.keyboard });
    }
    return;
  }

  m = data.match(/^a:(\d+):(\w+)$/);
  const t = m && await getTask(ctx, +m[1]);
  if (!t || !canAccess(ctx, t, uid)) return answer('Задача не найдена');
  const hadSnooze = !!(msg && msg.reply_markup && JSON.stringify(msg.reply_markup).includes(':s1h'));
  const res = await applyAction(ctx, t, m[2], uid);
  await answer(res.toast);
  if (!msg) return;
  if (res.deleted) {
    return tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text: `🗑 <s>${esc(t.title)}</s> — удалено` });
  }
  const mode = res.mode !== 'normal' ? res.mode : hadSnooze && !t.done ? 'snooze' : 'normal';
  await rememberMsg(ctx, uid, msg.message_id, t.id);
  await tg(env, 'editMessageText', {
    chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML',
    text: renderCard(ctx, t), reply_markup: cardKeyboard(ctx, t, uid, mode), link_preview_options: { is_disabled: true },
  });
}

// ── Вход для обновлений Telegram ──

function isAllowed(env, ctx, from, joinCode) {
  if (ctx.users.has(from.id)) return true;
  const allowed = (env.ALLOWED_USERS || '').split(/[\s,]+/).filter(Boolean);
  if (!allowed.length || allowed.includes(String(from.id))) return true;
  return !!(joinCode && [...ctx.projects.values()].some(p => p.code === joinCode));
}

async function handleUpdate(env, upd, origin = null) {
  const msg = upd.message;
  const cq = upd.callback_query;
  const chat = msg ? msg.chat : cq && cq.message && cq.message.chat;
  const from = msg ? msg.from : cq && cq.from;
  if (!chat || chat.type !== 'private' || !from) return;

  const ctx = await makeCtx(env, env._clock ? env._clock() : undefined);
  ctx.origin = origin;
  const joinCode = msg && ((msg.text || '').match(/^\/start\s+join_(\w+)/) || [])[1];
  if (!isAllowed(env, ctx, from, joinCode)) {
    if (msg) await send(env, chat.id, `Это личный бот. Твой ID: <code>${from.id}</code>`);
    return;
  }
  let user = ctx.users.get(from.id) || await createUser(ctx, from);
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || user.name;
  if (name !== user.name || (from.username || null) !== user.username) {
    user.name = name; user.username = from.username || null; user.dirty = true;
  }
  if (upd.update_id <= (user.data.lastUpdateId || 0)) return; // повтор от Telegram
  user.data.lastUpdateId = upd.update_id; user.dirty = true;

  if (cq) await handleCallback(ctx, user, cq);
  else await handleMessage(ctx, user, msg);
  await flush(ctx);
}

// ── Сводки и напоминания (Cron) ──

const tz = env => env.TIMEZONE || 'Europe/Moscow';
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const inWindow = (nowTime, at) => { const d = toMin(nowTime) - toMin(at); return d >= 0 && d < 180; };

async function sendMorning(ctx, user, mine, manual = false) {
  const now = ctx.now;
  if (!mine.length) {
    if (manual) await send(ctx.env, user.id, 'Задач нет 🎉');
    return false;
  }
  const main = renderGroups(ctx, mine, user.id, ['overdue', 'today']);
  const hot = sortTasks(mine.filter(t => t.high && !t.due));
  const tomorrow = mine.filter(t => bucketOf(t, now) === 'tomorrow').length;
  let s = '☀️ <b>Доброе утро! План на сегодня</b>\n\n';
  s += main || 'Сегодня дедлайнов нет 👌';
  if (hot.length) s += '\n\n<b>🔥 Важные без срока</b>\n' + hot.map(t => taskLine(ctx, t, user.id, 'nodate')).join('\n');
  s += `\n\n<i>Завтра: ${tomorrow || 'ничего'} · всего открытых: ${mine.length} · /list</i>`;
  await send(ctx.env, user.id, clip(s));
  return true;
}

async function renderEvening(ctx, user) {
  const now = ctx.now;
  const all = await myOpenTasks(ctx, user.id);
  const mine = all.filter(t => t.assignee === user.id);
  const fIds = focusIds(user, now);
  const keyboard = { inline_keyboard: [] };
  let s = '🌙 <b>Вечерняя сверка</b>\n';
  if (fIds.length) {
    const focus = await queryTasks(ctx, `id IN (${fIds.map(() => '?').join(',')})`, ...fIds);
    s += '\n<b>⭐ Главное сегодня</b>\n' + focus.map(t => `${t.done || (t.repeat && (t.history || []).includes(now.date)) ? '✅' : '⬜'} ${esc(t.title)}`).join('\n') + '\n';
    for (const t of focus) {
      if (t.done || (t.repeat && (t.history || []).includes(now.date))) continue;
      keyboard.inline_keyboard.push([
        { text: `✅ ${short(t.title, 24)}`, callback_data: `e:${t.id}:done` },
        { text: '⏩ На завтра', callback_data: `e:${t.id}:tom` },
      ]);
    }
    if (!keyboard.inline_keyboard.length) s += '\nВсё главное сделано — ты молодец 💪\n';
  }
  const others = mine.filter(t => !fIds.includes(t.id));
  const left = renderGroups(ctx, others, user.id, ['overdue', 'today']);
  const tomorrow = renderGroups(ctx, others, user.id, ['tomorrow']);
  if (left) s += '\nЕщё не закрыто — отметь сделанное или перенеси:\n\n' + left + '\n';
  if (tomorrow) s += '\n' + tomorrow;
  if (!fIds.length && !left && !tomorrow) return null;
  return { text: clip(s), keyboard };
}

async function sendEvening(ctx, user) {
  const ev = await renderEvening(ctx, user);
  if (ev) await send(ctx.env, user.id, ev.text, { reply_markup: ev.keyboard });
}

async function sendWeekly(ctx, user, manual = false) {
  const now = ctx.now, uid = user.id;
  const from = addDays(now.date, -6);
  const done = await queryTasks(ctx, 'done = 1 AND assignee_id = ? AND done_at >= ?', uid, from);
  const all = await myOpenTasks(ctx, uid);
  const mine = all.filter(t => t.assignee === uid);
  const repeats = mine.filter(t => t.repeat).reduce((n, t) => n + (t.history || []).filter(d => d >= from).length, 0);
  const next = sortTasks(mine.filter(t => t.due && !isOverdue(t, now) && daysBetween(now.date, t.due.date) <= 7 && !t.repeat));
  const overdue = sortTasks(mine.filter(t => isOverdue(t, now)));
  const nodate = mine.filter(t => !t.due).length;
  if (!manual && !done.length && !repeats && !mine.length) return;
  let s = '📊 <b>Итоги недели</b>\n\n';
  s += done.length || repeats
    ? `✅ Сделано: <b>${done.length}</b>${repeats ? ` + регулярных отметок: ${repeats}` : ''}\n` + done.slice(0, 15).map(t => `• ${esc(t.title)}`).join('\n') + (done.length > 15 ? '\n…' : '') + '\n'
    : 'На этой неделе отметок «готово» не было. Новая неделя — новый шанс 🙂\n';
  if (overdue.length) s += '\n<b>⚠️ Хвосты</b> — перенеси или закрой:\n' + overdue.map(t => taskLine(ctx, t, uid, 'overdue')).join('\n') + '\n';
  if (next.length) s += '\n<b>🗓 На следующей неделе</b>\n' + next.map(t => taskLine(ctx, t, uid, 'week')).join('\n') + '\n';
  if (nodate) s += `\n📥 Без срока: ${nodate} — может, что-то из них запланировать? /list`;
  await send(ctx.env, uid, clip(s));
}

async function sendStaleReview(ctx, user, mine) {
  const now = ctx.now;
  const border = addDays(now.date, -14);
  const stale = mine.filter(t => !t.due && !t.repeat && (t.createdAt || now.date) <= border && (!t.reviewedAt || t.reviewedAt <= border))
    .sort((a, b) => a.id - b.id).slice(0, 3);
  if (!stale.length) return;
  await send(ctx.env, user.id, '🧹 <b>Эти задачи лежат без срока больше двух недель.</b> Ещё актуальны?');
  for (const t of stale) {
    const r = await send(ctx.env, user.id, renderCard(ctx, t), { reply_markup: cardKeyboard(ctx, t, user.id, 'stale') });
    if (r.ok) await rememberMsg(ctx, user.id, r.result.message_id, t.id);
  }
}

async function runCron(env, at = new Date()) {
  const ctx = await makeCtx(env, at);
  const now = ctx.now;
  const ns = stamp(now.date, now.time);
  const open = await queryTasks(ctx, 'done = 0');

  // 1. напоминания по времени и «отложенные» 🔔
  for (const t of open) {
    if (!ctx.users.has(t.assignee)) continue;
    let changed = false;
    try {
      if (t.remindAt && ns >= stamp(t.remindAt.date, t.remindAt.time)) {
        delete t.remindAt;
        await sendCard(ctx, t.assignee, t, '🔔 <b>Напоминаю</b>\n\n', 'snooze');
        changed = true;
      }
      if (t.due && t.due.time) {
        t.rem = t.rem || {};
        const ds = stamp(t.due.date, t.due.time);
        if (!t.rem.h1 && !t.repeat && ns >= ds - 3600e3 && ns < ds) { // у регулярных — только в срок
          await sendCard(ctx, t.assignee, t, '⏰ <b>Через час срок</b>\n\n', 'snooze');
          t.rem.h1 = 1; changed = true;
        }
        if (!t.rem.due && ns >= ds) {
          if (ns - ds < 6 * 3600e3) await sendCard(ctx, t.assignee, t, '⏰ <b>Время пришло!</b>\n\n', 'snooze');
          t.rem.due = 1; t.rem.h1 = 1; changed = true;
        }
      }
      if (changed) await saveTask(ctx, t);
    } catch (e) { console.error('remind', t.id, e && e.stack); }
  }

  // 2. сводки по каждому человеку
  const morningAt = env.MORNING_AT || '09:00';
  const eveningAt = env.EVENING_AT || '20:00';
  const weeklyAt = env.WEEKLY_AT || '19:00';
  for (const user of ctx.users.values()) {
    try {
      const d = user.data;
      const mine = open.filter(t => t.assignee === user.id);
      if (morningAt !== 'off' && d.lastMorning !== now.date && inWindow(now.time, morningAt)) {
        d.lastMorning = now.date; user.dirty = true;
        if (await sendMorning(ctx, user, mine)) {
          await sendFocusPicker(ctx, user, mine);
          await sendStaleReview(ctx, user, mine);
        }
      }
      if (eveningAt !== 'off' && d.lastEvening !== now.date && inWindow(now.time, eveningAt)) {
        d.lastEvening = now.date; user.dirty = true;
        await sendEvening(ctx, user);
      }
      if (weeklyAt !== 'off' && weekday(now.date) === 0 && d.lastWeekly !== now.date && inWindow(now.time, weeklyAt)) {
        d.lastWeekly = now.date; user.dirty = true;
        await sendWeekly(ctx, user);
      }
      // раз в день перерисовываем закреплённый список: «завтра» становится «сегодня»
      if (d.lastDashDay !== now.date) { d.lastDashDay = now.date; user.dirty = true; ctx.dash.add(user.id); }
    } catch (e) { console.error('cron user', user.id, e && e.stack); }
  }

  // 3. уборка раз в неделю: старые выполненные задачи и ссылки на сообщения
  if (weekday(now.date) === 1 && now.time < '00:10') {
    await DB(ctx).batch([
      DB(ctx).prepare('DELETE FROM tasks WHERE done = 1 AND done_at < ?').bind(addDays(now.date, -120)),
      DB(ctx).prepare('DELETE FROM msgs WHERE at < ?').bind(addDays(now.date, -90)),
    ]);
  }
  await flush(ctx);
}

// ── Доска (Telegram Mini App) ──

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function verifyInitData(env, initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const enc = new TextEncoder();
  const k1 = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', k1, enc.encode(env.BOT_TOKEN));
  const k2 = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  if (hex(await crypto.subtle.sign('HMAC', k2, enc.encode(dcs))) !== hash) return null;
  if (Date.now() / 1000 - +params.get('auth_date') > 7 * 86400) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

async function boardState(ctx, uid) {
  const ps = myProjects(ctx, uid);
  const since = addDays(ctx.now.date, -7);
  const pIds = ps.map(p => p.id);
  const where = `(assignee_id = ? OR owner_id = ?${pIds.length ? ` OR project_id IN (${pIds.map(() => '?').join(',')})` : ''}) AND (done = 0 OR done_at >= ?)`;
  const tasks = await queryTasks(ctx, where, uid, uid, ...pIds, since);
  const people = new Set([uid]);
  for (const p of ps) for (const m of p.members) people.add(m);
  for (const t of tasks) { people.add(t.owner); people.add(t.assignee); }
  return {
    me: uid,
    now: ctx.now,
    focus: focusIds(ctx.users.get(uid), ctx.now),
    projects: ps.map(p => ({ id: p.id, name: p.name, owner: p.owner, members: [...p.members] })),
    users: Object.fromEntries([...people].map(id => [id, nameOf(ctx, id)])),
    tasks: tasks.map(t => ({
      id: t.id, title: t.title, due: t.due || null, high: !!t.high, done: t.done, doneAt: t.doneAt,
      owner: t.owner, assignee: t.assignee, project: t.project, repeat: t.repeat ? fmtRepeat(t.repeat) : null,
      checklist: t.checklist || [], notes: (t.notes || []).map(n => ({ text: n.text, by: n.by || null, at: n.at })),
      bucket: t.done ? 'done' : bucketOf(t, ctx.now), remindAt: t.remindAt || null,
    })),
  };
}

async function boardEdit(ctx, user, t, body) {
  const uid = user.id, now = ctx.now;
  const actor = esc(user.name);
  if (typeof body.title === 'string' && body.title.trim()) t.title = body.title.trim().slice(0, 300);
  if ('due' in body) {
    const d = body.due;
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) {
      setDue(t, { date: d.date, time: /^\d{2}:\d{2}$/.test(d.time || '') ? d.time : null });
    } else setDue(t, null);
    notifyOthers(ctx, t, uid, `📅 <b>${actor}</b>: срок теперь ${fmtDue(t.due, now)}\n\n`);
  }
  if ('project' in body) {
    const p = body.project ? ctx.projects.get(+body.project) : null;
    if (body.project && (!p || !p.members.has(uid))) return 'Нет доступа к проекту';
    if (t.owner !== uid && t.project !== (p ? p.id : null)) return 'Переносить между проектами может только автор';
    t.project = p ? p.id : null;
    if (!p || !p.members.has(t.assignee)) { ctx.dash.add(t.assignee); t.assignee = t.owner; }
  }
  if (typeof body.note === 'string' && body.note.trim()) {
    const d = parseDetails(body.note.trim(), uid, now);
    t.notes = [...(t.notes || []), ...d.notes];
    t.checklist = [...(t.checklist || []), ...d.checklist];
    notifyOthers(ctx, t, uid, `💬 <b>${actor}</b> дописал(а) подробности\n\n`);
  }
  if (typeof body.checkAdd === 'string' && body.checkAdd.trim()) {
    t.checklist = [...(t.checklist || []), { text: body.checkAdd.trim(), done: false }];
  }
  await saveTask(ctx, t);
  touch(ctx, t);
  return null;
}

async function handleApi(request, env) {
  const body = await request.json().catch(() => ({}));
  const tgUser = await verifyInitData(env, body.initData);
  if (!tgUser) return json({ error: 'Открой доску из Telegram' }, 401);
  const ctx = await makeCtx(env, env._clock ? env._clock() : undefined);
  const user = ctx.users.get(tgUser.id);
  if (!user) return json({ error: 'Сначала напиши боту /start' }, 403);
  let error = null;

  if (body.op === 'create') {
    const project = body.project ? ctx.projects.get(+body.project) : null;
    if (project && !project.members.has(user.id)) error = 'Нет доступа к проекту';
    else {
      const r = await createFromText(ctx, user, String(body.text || '').trim(), { project });
      if (r.error) error = 'Напиши, что сделать';
    }
  } else if (body.op === 'act' || body.op === 'edit') {
    const t = await getTask(ctx, +body.id);
    if (!t || !canAccess(ctx, t, user.id)) error = 'Задача не найдена';
    else if (body.op === 'act') {
      const act = String(body.act || '');
      if (!/^(done|undo|skip|norep|today|tom|week|none|hi|ck\d+|s1h|sev|smo|as\d+|delok)$/.test(act)) error = 'Неизвестное действие';
      else {
        const res = await applyAction(ctx, t, act, user.id);
        if (!res.changed && !res.deleted && res.toast) error = res.toast;
      }
    } else error = await boardEdit(ctx, user, t, body);
  } else if (body.op === 'focus') {
    const ids = (body.ids || []).map(Number).slice(0, 3);
    user.data.focus = { date: ctx.now.date, ids }; user.dirty = true; ctx.dash.add(user.id);
  }
  await flush(ctx);
  return json({ error, state: await boardState(ctx, user.id) });
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

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
      { command: 'focus', description: '3 главные задачи дня' },
      { command: 'board', description: 'Доска задач' },
      { command: 'projects', description: 'Проекты и совместная работа' },
      { command: 'invite', description: 'Позвать человека в проект' },
      { command: 'repeat', description: 'Регулярные задачи' },
      { command: 'done', description: 'Выполненные' },
      { command: 'week', description: 'Итоги недели' },
      { command: 'help', description: 'Как пользоваться' },
    ],
  });
  const menu = await tg(env, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Доска', web_app: { url: origin + '/app' } },
  });
  await ensureDb(env);
  return { webhook: hook, commands: cmds, menu, db: 'ok', voice: env.AI ? 'ok' : 'Workers AI не подключён — голосовые не будут распознаваться' };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.BOT_TOKEN || !env.WEBHOOK_SECRET || !env.DB) {
      return new Response('Не настроено: нужны BOT_TOKEN, WEBHOOK_SECRET и привязка D1 с именем DB', { status: 500 });
    }
    if (url.pathname === '/setup') {
      if (url.searchParams.get('secret') !== env.WEBHOOK_SECRET) return new Response('Неверный secret', { status: 403 });
      return json(await setup(env, url.origin));
    }
    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const upd = await request.json();
      try { await handleUpdate(env, upd, url.origin); } catch (e) { console.error('update', e && e.stack); }
      return new Response('ok');
    }
    if (url.pathname === '/app') {
      return new Response(APP_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/api' && request.method === 'POST') {
      try { return await handleApi(request, env); } catch (e) {
        console.error('api', e && e.stack);
        return json({ error: 'Ошибка сервера' }, 500);
      }
    }
    return new Response('Бот задач работает ✅');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env, new Date(event.scheduledTime)));
  },

  // для тестов
  _internal: { parseTask, localNow, handleUpdate, runCron, handleApi, verifyInitData, fmtDue },
};
