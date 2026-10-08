// ─────────────────────────────────────────────────────────────
//  Бот-планировщик задач для Telegram (Cloudflare Worker)
//  Исходник: src/bot.js + src/app.html → сборка `npm run build` → worker.js
//  Хранилище: Cloudflare D1 (привязка DB). Напоминания: Cron Trigger.
//  Голосовые: Workers AI (привязка AI, необязательно).
//  Переменные: BOT_TOKEN, WEBHOOK_SECRET, TIMEZONE, ALLOWED_USERS,
//              MORNING_AT, EVENING_AT, WEEKLY_AT — см. README.md
// ─────────────────────────────────────────────────────────────

const APP_HTML = '__APP_HTML__';
const BUILD = '__BUILD__';

const WD_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

// ── Даты: всё храним в «местном» времени как строки YYYY-MM-DD и HH:MM ──

const dateFromYmd = s => new Date(s + 'T00:00:00Z');
const ymd = d => d.toISOString().slice(0, 10);
function addDays(s, n) { const d = dateFromYmd(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
const diffDays = (a, b) => Math.round((dateFromYmd(b) - dateFromYmd(a)) / 864e5);
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

// Создать Intl.DateTimeFormat дорого — держим по одному на часовой пояс
const FMT = new Map();
function fmtFor(tz) {
  let f = FMT.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    FMT.set(tz, f);
  }
  return f;
}

function localNow(tz, at = new Date()) {
  const p = {};
  for (const x of fmtFor(tz).formatToParts(at)) p[x.type] = x.value;
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
const NUM = '(\\d+|два|две|три|четыре|пять|шесть)';
const NUM_WORDS = { 'два': 2, 'две': 2, 'три': 3, 'четыре': 4, 'пять': 5, 'шесть': 6 };
const toNum = s => (s ? (NUM_WORDS[s.toLowerCase()] || +s || 1) : 1);
const ORD_RE = '(перв|втор|трет|четв[её]рт|последн)\\p{L}*';
const ORD_NUM = s => { s = s.toLowerCase(); return s.startsWith('перв') ? 1 : s.startsWith('втор') ? 2 : s.startsWith('трет') ? 3 : s.startsWith('четв') ? 4 : -1; };
const RE = {
  everyWd: new RegExp(`${B}(?:кажд(?:ый|ую|ое)|по)\\s+${WD_ANY}(?:\\s*(?:,|и)\\s*${WD_ANY})*${E}`, 'iu'),
  workdays: new RegExp(`${B}(?:по\\s+будн(?:ям|им\\s+дням)|каждый\\s+будний\\s+день)${E}`, 'iu'),
  weekends: new RegExp(`${B}(?:по\\s+выходным|каждые\\s+выходные)${E}`, 'iu'),
  // «каждые 2 недели», «раз в две недели», «каждый месяц», «ежедневно»
  every: new RegExp(`${B}(?:(?:кажд(?:ый|ую|ое|ые|ого)|раз\\s+в)\\s+(?:${NUM}\\s+)?(день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)|(ежедневно|еженедельно|ежемесячно|ежегодно))${E}`, 'iu'),
  everyOther: new RegExp(`${B}кажд\\p{L}*\\s+втор\\p{L}*\\s+недел\\p{L}*${E}`, 'iu'),
  // «каждый первый понедельник месяца», «в последнюю пятницу каждого месяца», «каждый второй четверг»
  nthWd: new RegExp(`${B}(?:кажд\\p{L}*\\s+|в\\s+)?${ORD_RE}\\s+(${WD_ANY})(?:\\s+(?:каждого\\s+)?месяца)?${E}`, 'iu'),
  // «первый рабочий день месяца», «в последний рабочий день каждого месяца»
  workDay: new RegExp(`${B}(?:(?:кажд\\p{L}*|в)\\s+)?(перв|последн)\\p{L}*\\s+рабоч\\p{L}*\\s+(?:день|дня)(?:\\s+(?:каждого\\s+)?месяца)?${E}`, 'iu'),
  // «ежемесячная задача», «ежедневный отчёт» — слово остаётся в названии
  everyAdj: new RegExp(`${B}(ежедневн|еженедельн|ежемесячн|ежегодн)(?:ая|ый|ое|ые|ой|ую|ого|ых|ым)${E}`, 'iu'),
  // «каждый последний день месяца», «последнего числа каждого месяца», «каждое первое число»
  edgeDay: new RegExp(`${B}(?:(?:кажд\\p{L}*|в)\\s+)?(перв|последн)\\p{L}*(?:\\s+(?:день|дня|число|числа))?(?:\\s+(?:каждого\\s+)?месяца)?${E}`, 'iu'),
  dayNum: new RegExp(`${B}(?:кажд(?:ое|ого)\\s+)?(\\d{1,2})(?:-?(?:е|го|ое|ого))?\\s+числ[оа]${E}`, 'iu'),
  // «через 30 минут», «через 2 часа», «через час», «через полчаса»
  afterTime: new RegExp(`${B}через\\s+(?:(\\d+)\\s+)?(минут[уы]?|мин|час(?:а|ов)?|полчаса)${E}`, 'iu'),
  // «в 10 утра», «в 7 вечера», «к 15 часам» — часто так говорят в голосовых
  timeWords: new RegExp(`${B}(?:в|к|до|на)\\s+(\\d{1,2})(?:\\s+час(?:а|ов|ам)?(?:\\s+(утра|дня|вечера|ночи))?|\\s+(утра|дня|вечера|ночи))${E}`, 'iu'),
  time: new RegExp(`${B}(?:(?:в|к|до|на)\\s+)?([01]?\\d|2[0-3]):([0-5]\\d)${E}`, 'iu'),
  // «в 10 часов 30 минут»
  hourMin: new RegExp(`${B}(?:в|к|до|на)\\s+(\\d{1,2})\\s+час\\p{L}*\\s+(\\d{1,2})\\s+мин\\p{L}*(?:\\s+(утра|дня|вечера|ночи))?${E}`, 'iu'),
  // «позвонить в 18», «планёрка в 10, потом…» — час без минут в конце фразы или перед «с/у/и…»
  bareHour: new RegExp(`${B}(?:в|к)\\s+(\\d{1,2})(?=\\s*(?:[,;!?)]|\\.(?!\\d)|$|\\s(?:с|со|у|и|на|по|для|про|около|возле|перед|после|—|-)\\s))`, 'iu'),
  // «утром», «вечером», «в полдень», «к обеду»
  dayPart: new RegExp(`${B}(утром|дн[её]м|вечером|к\\s+полудню|в\\s+полдень|к\\s+обеду|в\\s+обед|после\\s+обеда)${E}`, 'iu'),
  // «на следующей неделе», «в конце недели», «в конце месяца», «в начале следующего месяца»
  period: new RegExp(`${B}(?:(на\\s+следующей\\s+неделе|на\\s+этой\\s+неделе|до\\s+конца\\s+недели|в\\s+конце\\s+(?:этой\\s+)?недели|к\\s+концу\\s+недели)|(в\\s+конце\\s+(?:этого\\s+)?месяца|до\\s+конца\\s+месяца|к\\s+концу\\s+месяца)|(в\\s+следующем\\s+месяце|в\\s+начале\\s+(?:следующего\\s+)?месяца))${E}`, 'iu'),
  // несуществующие дата и время — предупредим, а не промолчим
  badTime: new RegExp(`${B}(?:(?:в|к|до|на)\\s+)?(2[4-9]|[3-9]\\d):(\\d{2})${E}|${B}(?:(?:в|к|до|на)\\s+)?([01]?\\d|2[0-3]):([6-9]\\d)${E}`, 'iu'),
  remindLead: /^(?:напомни(?:те|ть)?|не\s+забыть|не\s+забудь)(?:\s+мне)?(?:\s*[,:—–-])?\s+(?=\S)/iu,
  numDate: new RegExp(`${B}${PREP}(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{4}|\\d{2}))?${E}`, 'iu'),
  nameDate: new RegExp(`${B}${PREP}(\\d{1,2})\\s+(?:${MONTHS_RE.map(m => `(${m})`).join('|')})\\.?${E}`, 'iu'),
  rel: new RegExp(`${B}${PREP}(сегодня|завтра|послезавтра)${E}`, 'iu'),
  after: new RegExp(`${B}через\\s+(?:${NUM}\\s+)?(день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев)${E}`, 'iu'),
  weekday: new RegExp(`${B}${PREP}(?:(эт[уотй]|следующ\\p{L}*)\\s+)?(?:${WEEKDAYS.map(w => `(${w})`).join('|')})${E}`, 'iu'),
  startAt: new RegExp(`${B}(?:начать|начни|начну|приступить|приступлю)\\s+`, 'iu'),
  bang: /(^|\s)!{1,3}(?=\s|$)|!{2,}/u,
  urgent: new RegExp(`${B}(срочно|важно|asap)${E}`, 'iu'),
};

// сообщение — это только несуществующая дата, без самой задачи
const onlyBadDate = p => {
  if (!p.bad) return false;
  const rest = p.title.toLowerCase().replace(p.bad.toLowerCase(), '').replace(/[^\p{L}\d]+/gu, ' ').trim();
  return !rest || /^(?:в|к|до|на|во|ко)$/u.test(rest);
};
const badDateText = bad => `🤔 «${esc(bad)}» — такой даты или времени не бывает. Проверь число и напиши ещё раз.`;

const wdIndex = text => [0, 1, 2, 3, 4, 5, 6].find(i => WD_ONE[i].test(text));

function parseTask(input, now, opts = {}) {
  let s = ' ' + input + ' ';
  let date = null, time = null, high = false, repeat = null, md = null, start = null, fromWeekday = false;
  const take = (re, fn) => {
    const m = s.match(re);
    if (!m || fn(m) === false) return;
    s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
  };

  // «начать в среду», «начну завтра», «приступить 12.10» — дата начала (дедлайн — отдельно)
  if (!opts.noStart) {
    const km = s.match(RE.startAt);
    if (km) {
      // после «начать» берём самую длинную цепочку слов, которая целиком — дата: «в среду», «12 октября»
      const after = s.slice(km.index + km[0].length);
      const words = after.split(/(\s+)/);
      // дата может идти не сразу: «начать отчёт в понедельник, сдать в пятницу» — ищем в пределах части до запятой
      const clause = words.findIndex(w => /[,;]$|^(?:сдать|сдача|дедлайн|срок)$/iu.test(w));
      const maxSkip = Math.min(8, clause < 0 ? words.length - 1 : clause);
      for (let skip = 0; skip <= maxSkip && !start; skip += 2) {
        for (let n = Math.min(9, words.length - skip); n >= 1; n -= 1) {
          const cand = words.slice(skip, skip + n).join('');
          if (!cand.trim()) continue;
          const p2 = parseTask(cand.replace(/[,;]+$/, ''), now, { noStart: true });
          if (!p2.title && p2.due && !p2.repeat) {
            start = { date: p2.due.date, time: null };
            const kept = words.slice(0, skip).join('');
            s = s.slice(0, km.index) + ' ' + kept + ' ' + after.slice(kept.length + cand.length).replace(/^\s*[,;]/, ' ');
            break;
          }
        }
      }
    }
  }

  take(RE.afterTime, m => {
    const u = m[2].toLowerCase();
    const mins = u === 'полчаса' ? 30 : u.startsWith('час') ? 60 * (m[1] ? +m[1] : 1) : (m[1] ? +m[1] : 1);
    const r = fromStamp(stamp(now.date, now.time) + mins * 60e3);
    date = r.date; time = r.time;
  });
  if (!time) take(RE.time, m => { time = `${pad(+m[1])}:${m[2]}`; });

  // Время через точку: «10.30», «в 9.45». «10.11» может быть и датой — тогда решаем по контексту или спрашиваем
  let ambig = null;
  if (!time) {
    const re = new RegExp(`${B}((?:в|к|до|на)\\s+)?(\\d{1,2})\\.(\\d{2})(?!\\.\\d|[\\p{L}\\d])`, 'giu');
    let m;
    while ((m = re.exec(s))) {
      const prep = (m[1] || '').trim().toLowerCase();
      const h = +m[2], mi = +m[3];
      if (h > 23 || mi > 59) continue; // «25.10» — точно дата
      const canDate = !!validDate(2024, mi, h); // 2024 — високосный, чтобы 29.02 тоже считалось датой
      const rest = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
      const otherDate = [RE.rel, RE.weekday, RE.nameDate, RE.after, RE.numDate, RE.dayNum, RE.everyWd, RE.every, RE.workdays, RE.weekends]
        .some(r => r.test(rest));
      let asTime;
      if (!canDate || prep === 'в' || otherDate) asTime = true; // «10.30», «в 10.11», «завтра 10.11»
      else if (prep === 'к' || prep === 'до') asTime = false; // «до 10.11» — скорее дата
      else { asTime = false; ambig = { raw: `${m[2]}.${m[3]}`, time: `${pad(h)}:${m[3]}` }; }
      if (asTime) { time = `${pad(h)}:${m[3]}`; s = rest; }
      break;
    }
  }
  // час без «утра/вечера»: «в 2 часа», «в 18», «к 5» — днём так говорят о 14:00, 18:00, 17:00
  let loose = false;
  const hourOf = (h, part) => {
    if ((part === 'дня' || part === 'вечера') && h < 12) return h + 12;
    if (part === 'ночи' && h === 12) return 0;
    if (!part) { loose = true; if (h >= 1 && h <= 6) return h + 12; }
    return h;
  };
  if (!time) take(RE.hourMin, m => {
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return false;
    time = `${pad(hourOf(h, (m[3] || '').toLowerCase()))}:${pad(mi)}`;
  });
  if (!time) take(RE.timeWords, m => {
    const h = +m[1];
    if (h > 23) return false;
    time = `${pad(hourOf(h, (m[2] || m[3] || '').toLowerCase()))}:00`;
  });
  if (!time) take(RE.bareHour, m => {
    const h = +m[1];
    if (h > 23) return false;
    time = `${pad(hourOf(h, ''))}:00`;
  });
  if (!time) take(RE.dayPart, m => {
    const w = m[1].toLowerCase();
    time = w === 'утром' ? '09:00' : w === 'вечером' ? '19:00' : /полд/.test(w) ? '12:00' : /после/.test(w) ? '14:00' : '13:00';
  });
  // такого времени не бывает: «в 25:00», «в 10:75»
  let bad = null;
  if (!time) { const bm = s.match(RE.badTime); if (bm) bad = bm[0].trim(); }

  // Повторы
  take(RE.workdays, () => { repeat = { unit: 'week', n: 1, wd: [1, 2, 3, 4, 5] }; });
  if (!repeat) take(RE.weekends, () => { repeat = { unit: 'week', n: 1, wd: [6, 0] }; });
  if (!repeat) take(RE.workDay, m => {
    if (!/^\s*кажд/i.test(m[0]) && !/месяц/i.test(m[0]) && !RE.everyAdj.test(s)) return false;
    repeat = { unit: 'month', n: 1, wday: m[1].toLowerCase().startsWith('перв') ? 1 : -1 };
  });
  if (!repeat) take(RE.nthWd, m => {
    const every = /^\s*кажд/i.test(m[0]), month = /месяц/i.test(m[0]);
    if (!every && !month) return false; // «во второй четверг» без «каждый/месяца» — не повтор
    const nth = ORD_NUM(m[1]), wd = wdIndex(m[2]);
    if (wd === undefined) return false;
    if (nth === 2 && !month) repeat = { unit: 'week', n: 2, wd: [wd] }; // «каждый второй четверг»
    else repeat = { unit: 'month', n: 1, nth, nwd: wd };
  });
  if (!repeat) take(RE.edgeDay, m => {
    if (!/^\s*кажд/i.test(m[0]) && !/месяц/i.test(m[0])) return false; // «последний звонок» — не повтор
    repeat = { unit: 'month', n: 1 };
    md = m[1].toLowerCase().startsWith('перв') ? 1 : 31;
    if (md === 31) repeat.last = true;
  });
  if (!repeat) take(RE.everyOther, () => { repeat = { unit: 'week', n: 2 }; });
  take(RE.every, m => {
    const w = (m[2] || m[3]).toLowerCase();
    const unit = /^(д|ежедн)/.test(w) ? 'day' : /^(н|еженед)/.test(w) ? 'week' : /^(м|ежемес)/.test(w) ? 'month' : 'year';
    const n = Math.max(1, toNum(m[1]));
    if (!repeat) repeat = { unit, n };
    else if (repeat.unit === unit) repeat.n = n; // «по будням каждые 2 недели»
    else if (!(repeat.unit === 'month' && unit === 'month')) return false;
  });
  take(RE.everyWd, m => {
    const wd = [1, 2, 3, 4, 5, 6, 0].filter(i => WD_ONE[i].test(m[0]));
    if (!repeat) repeat = { unit: 'week', n: 1, wd };
    else if (repeat.unit === 'week' && !repeat.wd) repeat.wd = wd; // «каждые 2 недели по четвергам»
    else return false;
  });
  // «раз в две недели в четверг» — день недели уточняет повтор, а не разовую дату
  if (repeat && repeat.unit === 'week' && !repeat.wd) take(RE.weekday, m => { repeat.wd = [m.slice(2).findIndex(Boolean)]; });

  take(RE.dayNum, m => {
    const d = +m[1];
    if (d < 1 || d > 31) return false;
    md = d;
    if (!repeat && /^\s*кажд/i.test(m[0])) repeat = { unit: 'month', n: 1 };
  });
  if (repeat && (repeat.unit !== 'month' || repeat.nth || repeat.wday)) md = repeat.last ? 31 : null;
  if (md && !repeat) date = monthDayOnOrAfter(now.date, md); // «10 числа» — ближайшее 10-е

  if (!date) take(RE.numDate, m => {
    const d = +m[1], mo = +m[2];
    let y = m[3] ? +m[3] : +now.date.slice(0, 4);
    if (y < 100) y += 2000;
    let v = validDate(y, mo, d);
    if (!v) { if (mo <= 12 && d <= 31 && d > 0 && mo > 0) bad = bad || m[0].trim(); return false; }
    if (!m[3] && v < now.date) v = validDate(y + 1, mo, d) || v;
    date = v;
  });

  if (!date) take(RE.nameDate, m => {
    const mo = m.slice(2).findIndex(Boolean) + 1;
    const y = +now.date.slice(0, 4);
    let v = validDate(y, mo, +m[1]);
    if (!v) { bad = bad || m[0].trim(); return false; }
    if (v < now.date) v = validDate(y + 1, mo, +m[1]) || v;
    date = v;
  });

  if (!date) take(RE.rel, m => {
    date = addDays(now.date, { 'сегодня': 0, 'завтра': 1, 'послезавтра': 2 }[m[1].toLowerCase()]);
  });

  if (!date) take(RE.after, m => {
    const n = toNum(m[1]), unit = m[2].toLowerCase();
    if (unit.startsWith('д')) date = addDays(now.date, n);
    else if (unit.startsWith('н')) date = addDays(now.date, 7 * n);
    else date = addMonths(now.date, n);
  });

  if (!date) take(RE.period, m => {
    const today = weekday(now.date);
    if (m[1] && /следующ/i.test(m[1])) date = addDays(now.date, (8 - today) % 7 || 7); // понедельник следующей недели
    else if (m[1]) date = addDays(now.date, today >= 1 && today <= 5 ? 5 - today : today === 6 ? 1 : 0); // пятница (в выходные — воскресенье)
    else if (m[2]) date = withMonthDay(now.date, 31); // последний день месяца
    else date = addMonths(withMonthDay(now.date, 1), 1); // 1-е число следующего месяца
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
    fromWeekday = true;
  });

  if (!repeat) {
    const adj = s.match(RE.everyAdj);
    if (adj) {
      const w = adj[1].toLowerCase();
      repeat = { unit: w.startsWith('ежедн') ? 'day' : w.startsWith('еженед') ? 'week' : w.startsWith('ежемес') ? 'month' : 'year', n: 1 };
      if (repeat.unit === 'week') repeat.wd = [weekday(date || now.date)];
    }
  }

  if (RE.bang.test(s)) { high = true; s = s.replace(new RegExp(RE.bang.source, 'gu'), ' '); }
  if (RE.urgent.test(s)) high = true;

  if (repeat) {
    if (repeat.unit === 'month' && !repeat.nth && !repeat.wday) repeat.md = md || (date ? +date.slice(8) : +now.date.slice(8));
    if (!date) date = firstOccurrence(repeat, now, time);
  }
  // «сегодня в 9», сказанное в полдень, — это 21:00 (утро уже прошло); без «сегодня» — завтра в 9
  if (loose && !repeat && date === now.date && time <= now.time && +time.slice(0, 2) < 12) {
    const pm = `${pad(+time.slice(0, 2) + 12)}${time.slice(2)}`;
    if (pm > now.time) time = pm;
  }
  if (time && !date) date = time > now.time ? now.date : addDays(now.date, 1);

  let title = s.replace(/\s+/g, ' ').replace(/^[\s,.;:—–-]+|[\s,.;:—–-]+$/gu, '').trim();
  title = title.replace(RE.remindLead, '').replace(/^(?:важно|срочно)\s*[:—–-]\s*(?=\S)/iu, '');
  if (title) title = title[0].toUpperCase() + title.slice(1);
  if (start) title = title.replace(/[\s,;]*(?:сдать|дедлайн|срок)[\s:]*$/iu, '').replace(/^(?:дедлайн|срок)[\s:]+/iu, '').trim();
  const out = { title, due: date ? { date, time } : null, high, repeat, ambig: ambig && date && !time ? ambig : null };
  if (start) {
    // «начать в понедельник, сдать в пятницу» — пятница после начала, а не перед ним
    if (out.due && fromWeekday && out.due.date < start.date) out.due.date = addDays(out.due.date, 7 * Math.ceil(diffDays(out.due.date, start.date) / 7));
    out.start = start;
  }
  if (bad && !(date && time)) out.bad = bad.replace(/^(?:до|ко|к|во|в|на)\s+/iu, '');
  return out;
}

function fromStamp(ms) {
  const iso = new Date(ms).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
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

// n-й день недели месяца (nth = 1..4, или -1 — последний)
function nthWeekdayOf(dayInMonth, nth, wd) {
  const first = dayInMonth.slice(0, 8) + '01';
  if (nth > 0) {
    let d = first;
    while (weekday(d) !== wd) d = addDays(d, 1);
    return addDays(d, 7 * (nth - 1));
  }
  let d = withMonthDay(first, 31);
  while (weekday(d) !== wd) d = addDays(d, -1);
  return d;
}

const weekStart = s => addDays(s, -((weekday(s) + 6) % 7));

// Производственный календарь РФ по годам: строка из '0' (рабочий) и '1' (выходной/праздник) на каждый день.
// Загружается с isdayoff.ru раз в день и хранится в базе; без него рабочие дни = пн–пт.
const CAL = new Map();
function isWorkDay(d) {
  const y = +d.slice(0, 4);
  const cal = CAL.get(y);
  if (cal) {
    const c = cal[daysBetween(`${y}-01-01`, d)];
    if (c === '1') return false;
    if (c !== undefined) return true;
  }
  const w = weekday(d);
  return w !== 0 && w !== 6;
}

// первый (w = 1) или последний (w = -1) рабочий день месяца — с учётом праздников, если календарь загружен
function workDayOf(dayInMonth, w) {
  let d = w > 0 ? dayInMonth.slice(0, 8) + '01' : withMonthDay(dayInMonth, 31);
  for (let i = 0; i < 31 && !isWorkDay(d); i++) d = addDays(d, w > 0 ? 1 : -1);
  return d;
}

function nextOccurrence(rep, from) {
  if (rep.unit === 'month' && rep.wday) return workDayOf(addMonths(from.slice(0, 8) + '01', rep.n || 1), rep.wday);
  if (rep.unit === 'month' && rep.nth) return nthWeekdayOf(addMonths(from.slice(0, 8) + '01', rep.n || 1), rep.nth, rep.nwd);
  if (rep.wd && rep.wd.length) {
    let d = addDays(from, 1);
    while (!rep.wd.includes(weekday(d))) d = addDays(d, 1);
    // «каждые 2 недели по чт»: перешли на новую неделю — пропускаем лишние недели
    if ((rep.n || 1) > 1 && weekStart(d) !== weekStart(from)) d = addDays(d, 7 * (rep.n - 1));
    return d;
  }
  if (rep.unit === 'day') return addDays(from, rep.n);
  if (rep.unit === 'week') return addDays(from, 7 * rep.n);
  if (rep.unit === 'month') return withMonthDay(addMonths(from.slice(0, 8) + '01', rep.n), rep.md || +from.slice(8));
  return addMonths(from, 12 * rep.n);
}

// Первый подходящий день не раньше base (по умолчанию — сегодня)
function firstOccurrence(rep, now, time, base = now.date) {
  let d = base;
  if (rep.unit === 'month' && rep.wday) {
    d = workDayOf(base, rep.wday);
    if (d < base) d = workDayOf(addMonths(base.slice(0, 8) + '01', 1), rep.wday);
  } else if (rep.unit === 'month' && rep.nth) {
    d = nthWeekdayOf(base, rep.nth, rep.nwd);
    if (d < base) d = nthWeekdayOf(addMonths(base.slice(0, 8) + '01', 1), rep.nth, rep.nwd);
  } else if (rep.wd && rep.wd.length) while (!rep.wd.includes(weekday(d))) d = addDays(d, 1);
  else if (rep.unit === 'month') d = monthDayOnOrAfter(base, rep.md);
  while (d < now.date) d = nextOccurrence(rep, d); // «каждый год 1 октября», если дата уже прошла
  if (d === now.date && time && time <= now.time) d = nextOccurrence(rep, d); // сегодня время уже прошло
  return d;
}

// Следующий срок после выполнения: строго в будущем, пропущенные разы не копятся.
// Если повтор ограничен датой «до» и она прошла — задача завершается (возвращает true).
function advanceRepeat(t, now) {
  let d = nextOccurrence(t.repeat, t.due ? t.due.date : now.date);
  while (d <= now.date) d = nextOccurrence(t.repeat, d);
  if (t.repeat.until && d > t.repeat.until) {
    t.done = true; t.doneAt = now.date;
    return true;
  }
  const lead = t.start && t.due ? daysBetween(t.start.date, t.due.date) : null;
  setDue(t, { date: d, time: t.due ? t.due.time : null });
  if (lead !== null) t.start = { date: addDays(d, -lead), time: null }; // «начать за 2 дня до» — сохраняем отступ
  return false;
}

// Повтор из формы на доске: проверяем всё, что пришло
function sanitizeRepeat(r) {
  if (!r || typeof r !== 'object') return null;
  const n = Math.min(99, Math.max(1, parseInt(r.n, 10) || 1));
  let rep;
  if (r.unit === 'day') rep = { unit: 'day', n };
  else if (r.unit === 'week') {
    const wd = [...new Set((Array.isArray(r.wd) ? r.wd : []).map(Number).filter(x => x >= 0 && x <= 6))];
    if (!wd.length) return null;
    rep = { unit: 'week', n, wd };
  } else if (r.unit === 'month') {
    if (r.wday) {
      if (![1, -1].includes(+r.wday)) return null;
      rep = { unit: 'month', n, wday: +r.wday };
    } else if (r.nth) {
      const nth = +r.nth, nwd = +r.nwd;
      if (![1, 2, 3, 4, -1].includes(nth) || !(nwd >= 0 && nwd <= 6)) return null;
      rep = { unit: 'month', n, nth, nwd };
    } else if (r.last) rep = { unit: 'month', n, md: 31, last: true };
    else {
      const md = +r.md;
      if (!(md >= 1 && md <= 31)) return null;
      rep = { unit: 'month', n, md };
    }
  } else if (r.unit === 'year') rep = { unit: 'year', n };
  else return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(r.until || '')) rep.until = r.until;
  return rep;
}

// Поставить повтор и подвинуть срок на ближайший подходящий день (не раньше текущего срока)
function applyRepeat(t, rep, now) {
  t.repeat = rep;
  t.history = t.history || [];
  const time = t.due ? t.due.time : null;
  const base = t.due && t.due.date > now.date ? t.due.date : (rep.unit === 'year' && t.due ? t.due.date : now.date);
  setDue(t, { date: firstOccurrence(rep, now, time, base), time });
}

// Готовые варианты повтора от даты задачи (для кнопок в чате)
function repeatPreset(code, t, now) {
  const base = t.due ? t.due.date : now.date;
  const wd = weekday(base), md = +base.slice(8);
  switch (code) {
    case 'd1': return { unit: 'day', n: 1 };
    case 'wd': return { unit: 'week', n: 1, wd: [1, 2, 3, 4, 5] };
    case 'w1': return { unit: 'week', n: 1, wd: [wd] };
    case 'w2': return { unit: 'week', n: 2, wd: [wd] };
    case 'm': return { unit: 'month', n: 1, md };
    case 'y': return { unit: 'year', n: 1 };
    case 'wd1': return { unit: 'month', n: 1, wday: 1 };
    case 'wdl': return { unit: 'month', n: 1, wday: -1 };
    default: return null;
  }
}

const WD_PLURAL = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const WD_ACC = ['воскресенье', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу'];
const WD_GENDER = [2, 0, 0, 1, 0, 1, 1]; // м / ж / ср — для «первый понедельник», «первую среду», «первое воскресенье»
const ORD_WORDS = {
  1: ['первый', 'первую', 'первое'], 2: ['второй', 'вторую', 'второе'], 3: ['третий', 'третью', 'третье'],
  4: ['четвёртый', 'четвёртую', 'четвёртое'], '-1': ['последний', 'последнюю', 'последнее'],
};
const fmtUntil = s => `${s.slice(8)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
function fmtRepeat(rep) {
  if (!rep) return '';
  return fmtRepeatBase(rep) + (rep.until ? `, до ${fmtUntil(rep.until)}` : '');
}
function fmtRepeatBase(rep) {
  const n = rep.n || 1;
  if (rep.unit === 'month' && rep.wday) {
    return (n === 1 ? 'каждый месяц' : `каждые ${n} мес.`) + `, в ${rep.wday > 0 ? 'первый' : 'последний'} рабочий день`;
  }
  if (rep.unit === 'month' && rep.nth) {
    return (n === 1 ? 'каждый месяц' : `каждые ${n} мес.`) + `, в ${ORD_WORDS[rep.nth][WD_GENDER[rep.nwd]]} ${WD_ACC[rep.nwd]}`;
  }
  if (rep.wd && rep.wd.length) {
    const k = [...rep.wd].sort().join('');
    const days = k === '12345' ? 'по будням' : k === '06' ? 'по выходным'
      : 'по ' + [1, 2, 3, 4, 5, 6, 0].filter(i => rep.wd.includes(i)).map(i => WD_PLURAL[i]).join(', ');
    return n > 1 ? `раз в ${n} нед. ${days}` : days;
  }
  if (rep.unit === 'day') return n === 1 ? 'каждый день' : `каждые ${n} дн.`;
  if (rep.unit === 'week') return n === 1 ? 'каждую неделю' : `каждые ${n} нед.`;
  if (rep.unit === 'month') return (n === 1 ? 'каждый месяц' : `каждые ${n} мес.`) + (rep.last ? ', в последний день' : `, ${rep.md} числа`);
  return n === 1 ? 'каждый год' : `каждые ${n} г.`;
}




function setDue(t, due) {
  t.due = due;
  t.rem = {};
  delete t.ambig;
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
// точная дата для отпуска: «пт, 2 окт» (а не «завтра» — чтобы было ясно, по какой день)
const fmtDay = (dateStr, now) => { const d = dateFromYmd(dateStr); return `${WD_SHORT[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}${d.getUTCFullYear() !== +now.date.slice(0, 4) ? ' ' + d.getUTCFullYear() : ''}`; };
const fmtDue = (due, now) => due ? fmtDate(due.date, now) + (due.time ? ' ' + due.time : '') : 'без срока';

function isOverdue(t, now) {
  if (!t.due) return false;
  return t.due.time ? stamp(t.due.date, t.due.time) < stamp(now.date, now.time) : t.due.date < now.date;
}

const STATUS = { todo: '📥 К выполнению', doing: '🔨 В работе', review: '👀 На проверке' };
const STATUS_ICON = { doing: '🔨', review: '👀' };
// «Не отстану»: важные задачи — по умолчанию, остальные — по кнопке
const isNagOn = t => t.nag === true || (t.nag !== false && !!t.high);

function bucketOf(t, now) {
  if (t.waiting && !t.done) return 'waiting'; // ждём другого человека — отдельно, не «горит»
  if (!t.due && !t.start) return 'nodate';
  if (isOverdue(t, now)) return 'overdue';
  // есть дата начала — задача «всплывает» в день начала и висит в «Сегодня» до дедлайна
  if (t.start && t.start.date > now.date) {
    const ds = daysBetween(now.date, t.start.date);
    return ds === 1 ? 'tomorrow' : ds <= 7 ? 'week' : 'later';
  }
  if (t.start) return 'today';
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
  ['waiting', '⏳ Жду ответа'],
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

// Номер задачи (/t12) — в конце строки или, по личной настройке, сразу после значка в начале
const idFirst = (ctx, uid) => { const u = ctx.users.get(uid); return !!(u && u.data.idFirst); };
function withId(ctx, uid, line, id) {
  return idFirst(ctx, uid) ? line.replace(/^(\S+ )/u, `$1/t${id} `) : line + `  /t${id}`;
}

function taskLine(ctx, t, uid, bucket) {
  const now = ctx.now;
  let due = '';
  if (t.due) due = (bucket === 'today' || bucket === 'tomorrow') && !t.start ? (t.due.time || '') : fmtDue(t.due, now);
  if (t.start && t.start.date > now.date) due = `с ${fmtDate(t.start.date, now)}` + (t.due ? `, дедлайн ${fmtDue(t.due, now)}` : '');
  else if (t.start && t.due) due = `дедлайн ${fmtDue(t.due, now)}`;
  let s = `${t.high ? '🔥 ' : '• '}${t.project && STATUS_ICON[t.status] ? STATUS_ICON[t.status] + ' ' : ''}${esc(t.title)}`;
  if (t.project && projName(ctx, t.project)) s += ` <i>#${esc(projName(ctx, t.project))}</i>`;
  if (due) s += ` <i>· ${due}</i>`;
  if (t.group) s += ` 👥 ${t.group.kids.filter(k => k.done).length}/${t.group.kids.length}`;
  else if (t.assignee !== uid) s += ` → ${esc(nameOf(ctx, t.assignee))}`;
  else if (t.owner !== uid) s += ` <i>(от ${esc(nameOf(ctx, t.owner))})</i>`;
  if (t.repeat) s += ' 🔁';
  const cp = checkProgress(t);
  if (cp) s += ' ' + cp;
  if ((t.notes || []).length) s += ' 📝';
  if ((t.files || []).length) s += ' 📎';
  return withId(ctx, uid, s, t.id);
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

// Разовые и регулярные — отдельно: регулярные не теряются среди разовых, а разовые не тонут в ежедневных
function renderSplit(ctx, tasks, uid) {
  if (prefsOf(ctx.users.get(uid)).mix) return renderGroups(ctx, tasks, uid); // по настройке — всё вместе, по датам
  const once = tasks.filter(t => !t.repeat), reg = tasks.filter(t => t.repeat);
  const out = [];
  if (once.length) out.push((reg.length ? '<b>━━ 📌 Разовые ━━</b>\n\n' : '') + renderGroups(ctx, once, uid));
  if (reg.length) out.push(`<b>━━ 🔁 Регулярные — ${reg.length} ━━</b>\n` + sortRegular(reg).map(t => regularLine(ctx, t, uid)).join('\n'));
  return out.join('\n\n');
}
const REG_MARK = { overdue: '🔴 ', today: '📍 ', waiting: '⏳ ' };
function sortRegular(list) {
  const key = t => (t.due ? t.due.date + (t.due.time || '99:99') : '9999');
  return [...list].sort((a, b) => key(a).localeCompare(key(b)) || (b.high - a.high) || a.id - b.id);
}
function regularLine(ctx, t, uid) {
  const b = bucketOf(t, ctx.now);
  let s = (REG_MARK[b] || (t.high ? '🔥 ' : '• ')) + esc(t.title);
  if (t.project && projName(ctx, t.project)) s += ` <i>#${esc(projName(ctx, t.project))}</i>`;
  s += ` <i>· ${t.due ? fmtDue(t.due, ctx.now) : 'без срока'} · ${fmtRepeatBase(t.repeat)}</i>`;
  if (t.group) s += ` 👥 ${t.group.kids.filter(k => k.done).length}/${t.group.kids.length}`;
  else if (t.assignee !== uid) s += ` → ${esc(nameOf(ctx, t.assignee))}`;
  else if (t.owner !== uid) s += ` <i>(от ${esc(nameOf(ctx, t.owner))})</i>`;
  const cp = checkProgress(t);
  if (cp) s += ' ' + cp;
  return withId(ctx, uid, s, t.id);
}

function clip(text, max = 4000) {
  return text.length <= max ? text : text.slice(0, max - 30).replace(/\n[^\n]*$/, '') + '\n\n… полный список: /list';
}

function focusIds(user, now) {
  const f = user.data.focus;
  return f && f.date === now.date ? f.ids : [];
}

function renderDash(ctx, user, mine, delegated, doneToday = 0) {
  const now = ctx.now;
  const head = `📌 <b>Мои задачи</b> — ${mine.length}  <i>(обновлено ${fmtDate(now.date, now)} ${now.time})</i>`;
  const parts = [];
  const fIds = focusIds(user, now);
  const focus = mine.filter(t => fIds.includes(t.id));
  if (focus.length) parts.push('<b>⭐ Главное сегодня</b>\n' + focus.map(t => taskLine(ctx, t, user.id, bucketOf(t, now))).join('\n'));
  const rest = renderSplit(ctx, mine.filter(t => !fIds.includes(t.id)), user.id);
  if (rest) parts.push(rest);
  if (delegated.length) {
    parts.push('<b>📤 Поручено другим</b>\n' + sortTasks(delegated).map(t => taskLine(ctx, t, user.id, 'later')).join('\n'));
  }
  const doneLine = doneToday ? `\n\n<i>✅ Сделано сегодня: ${doneToday} · все выполненные — /done</i>` : '';
  if (!parts.length) return head + '\n\nВсё сделано 🎉 Напиши новую задачу, когда появится.' + doneLine;
  return clip(head + '\n\n' + parts.join('\n\n') + doneLine);
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
  if (t.parent) meta.push('👥 общая задача');
  if (meta.length) s += meta.join(' · ') + '\n';
  if (t.group) s += groupLine(ctx, t) + '\n';
  if (t.project && !t.done) s += `🏷 ${STATUS[t.status] || STATUS.todo}\n`;
  if (t.done) s += `<i>Выполнено ${t.doneAt ? fmtDate(t.doneAt, now) : ''}</i>\n`;
  else {
    if (t.start) s += `▶️ начать: ${fmtDue(t.start, now)}\n`;
    s += `📅 ${t.start ? 'дедлайн: ' : ''}${fmtDue(t.due, now)}`;
    if (isOverdue(t, now)) s += ' — <b>просрочено!</b>';
    s += '\n';
  }
  if (t.meeting) s += `🗓 к встрече «${esc(t.meeting.title)}» — ${fmtDue(t.meeting.start, now)}\n`;
  if (t.waiting && !t.done) s += `⏳ жду ответа с ${fmtDate(t.waiting.since, now)} — спрошу ${fmtDate(t.waiting.check, now)}\n`;
  if (t.repeat) {
    s += `🔁 ${fmtRepeat(t.repeat)}`;
    const cnt = (t.history || []).length;
    if (cnt) s += ` · выполнено раз: ${cnt}`;
    if (t.lastDone) s += `\n✅ последний раз отмечено ${fmtDate(t.lastDone.date, now)}`;
    s += '\n';
  }
  if (t.remindAt && !t.done) s += `🔔 напомню ${fmtDue(t.remindAt, now)}\n`;
  if (t.ambig && !t.done) s += `❓ «${esc(t.ambig.raw)}» — это дата или время? Выбери кнопкой ниже.\n`;
  if (isNagOn(t) && !t.done && t.due) s += `🔔 не отстану: буду напоминать ${nagWord(ctx.users.get(t.assignee), ctx.env)}, пока не сделаешь\n`;
  if ((t.files || []).length) s += `📎 файлов: ${t.files.length} — «☰ Ещё» → «📎 Файлы»\n`;
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
  if (!t.done) s += '\n<i>↩️ Ответь на карточку — допишу детали или перенесу срок</i>';
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
    const rows = [...(p ? p.members : [])].map(id => [b(`${id === t.assignee ? '✔️' : '👤'} ${nameOf(ctx, id)}${id === uid ? ' (я)' : ''}`, 'as' + id)]);
    if (t.owner === uid && p && p.members.size > 2) rows.push([b('👥 Нескольким…', 'grp')]);
    rows.push([b('← Назад', 'card')]);
    return { inline_keyboard: rows };
  }
  if (mode === 'grp') {
    const p = ctx.projects.get(t.project);
    const u = ctx.users.get(uid);
    const sel = new Set((u && u.data.grpSel && u.data.grpSel.id === t.id) ? u.data.grpSel.ids : []);
    const rows = [...(p ? p.members : [])].filter(id => id !== t.owner).map(id => [b(`${sel.has(id) ? '☑' : '☐'} ${nameOf(ctx, id)}`, 'gp' + id)]);
    rows.push([b('☑ Всем', 'gpall'), b(`✅ Поставить (${sel.size})`, 'gpok')]);
    rows.push([b('← Назад', 'card')]);
    return { inline_keyboard: rows };
  }
  if (mode === 'repeat') {
    const base = t.due ? t.due.date : ctx.now.date;
    const d = dateFromYmd(base);
    const wdName = WD_PLURAL[d.getUTCDay()];
    const rows = [
      [b('Каждый день', 'r_d1'), b('По будням', 'r_wd')],
      [b(`Каждую неделю (${wdName})`, 'r_w1'), b(`Раз в 2 недели (${wdName})`, 'r_w2')],
      [b(`Каждый месяц (${d.getUTCDate()} числа)`, 'r_m'), b(`Каждый год (${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]})`, 'r_y')],
      [b('1-й рабочий день месяца', 'r_wd1'), b('Последний рабочий день', 'r_wdl')],
    ];
    if (ctx.origin) rows.push([{ text: '⚙️ Настроить подробно', web_app: { url: `${ctx.origin}/app?t=${t.id}&r=1` } }]);
    rows.push([...(t.repeat ? [b('🔁✖ Не повторять', 'norep')] : []), b('← Назад', 'card')]);
    return { inline_keyboard: rows };
  }
  if (mode === 'notes') {
    const rows = noteLines(t).slice(0, 12).map(l => [b(`✖ ${short(l.text, 36)}`, `nd${l.i}_${l.j}_${lineKey(l)}`)]);
    (t.checklist || []).slice(0, 12 - rows.length).forEach((c, i) => rows.push([b(`✖ ☐ ${short(c.text, 34)}`, `cd${i}_${hashKey(c.text).slice(0, 4)}`)]));
    const all = [];
    if ((t.notes || []).length) all.push(b('🗑 Все подробности', 'nclr'));
    if ((t.checklist || []).length) all.push(b('🗑 Весь чек-лист', 'cclr'));
    if (all.length) rows.push(all);
    rows.push([b('← Назад', 'more')]);
    return { inline_keyboard: rows };
  }
  if (mode === 'meet') {
    const rows = (ctx.meetList || []).map(e => [b(`${t.meeting && t.meeting.h === e.h ? '✔️' : '🗓'} ${fmtMeetingWhen(e, ctx.now)} · ${short(e.title, 24)}`, 'mt' + e.h)]);
    if (t.meeting) rows.push([b('✖ Не привязывать к встрече', 'unmeet')]);
    rows.push([b('← Назад', 'more')]);
    return { inline_keyboard: rows };
  }
  if (mode === 'project') {
    const rows = myProjects(ctx, uid).map(p => [b(`${p.id === t.project ? '✔️' : '📁'} ${p.name}`, 'pj' + p.id)]);
    rows.push([b('➕ Новый проект', 'pnew')]);
    if (t.project) rows.push([b('Убрать из проекта (личная)', 'pj0')]);
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
  if (mode === 'due') {
    return {
      inline_keyboard: [
        [b('Сегодня', 'today'), b('Завтра', 'tom'), b('+неделя', 'week')],
        [b('✏️ Своя дата', 'dueask'), t.repeat ? b('⏭ Пропустить раз', 'skip') : b('Без срока', 'none')],
        [b(t.start ? '▶️ Начать ✓' : '▶️ Начать…', 'start'), b(t.repeat ? '🔁 Повтор ✓' : '🔁 Повтор', 'rp')],
        [b('← Назад', 'card')],
      ],
    };
  }
  if (mode === 'more') {
    const r1 = [b(t.repeat ? '🔁 Повтор ✓' : '🔁 Повтор', 'rp')];
    if (t.owner === uid) r1.push(b('📁 Проект', 'proj'));
    if (canAssign(ctx, t) && !t.parent) r1.push(b(t.group ? `👥 Кому (${t.group.kids.length})` : '👤 Кому', 'assign'));
    const r2 = [b(t.high ? '⬇️ Не важно' : '🔥 Важно', 'hi'), b(isNagOn(t) ? '🔕 Не отставать' : '🔔 Не отстану', 'nag'),
      b(t.waiting ? '⏳ Уже не жду' : '⏳ Жду ответа', t.waiting ? 'wx' : 'wait')];
    const r3 = [b(t.meeting ? '🗓 Встреча ✓' : '🗓 К встрече', 'meet')];
    if (!t.parent) r3.push(b('✏️ Название', 'edti'));
    r3.push(b('✏️ Подробности', 'edtx'));
    if (t.project) r3.push(b('🏷 Статус', 'status'));
    if ((t.files || []).length) r3.push(b(`📎 Файлы (${t.files.length})`, 'files'));
    if (t.owner === uid) r3.push(b('🗑 Удалить', 'del'));
    const rows = [r1, r2, r3.slice(0, 3), r3.slice(3)].filter(r => r.length);
    if (t.repeat && t.lastDone) rows.push([b(`↩️ Отменить отметку «Готово» (${fmtDate(t.lastDone.date, ctx.now)})`, 'rundo')]);
    const u = ctx.users.get(uid);
    if (u && u.data.undoDetails && u.data.undoDetails.id === t.id) rows.push([b('↩️ Вернуть удалённые подробности', 'nrest')]);
    rows.push([b('← Назад', 'card')]);
    return { inline_keyboard: rows };
  }
  if (mode === 'wait') {
    return {
      inline_keyboard: [
        [b('Спросить завтра', 'w1'), b('Через 3 дня', 'w3'), b('Через неделю', 'w7')],
        [b('✏️ Свой день', 'wask'), b('← Назад', 'card')],
      ],
    };
  }
  if (mode === 'start') {
    return {
      inline_keyboard: [
        [b('▶️ Сегодня', 'st0'), b('▶️ Завтра', 'st1'), b('✏️ Своя дата', 'stask')],
        [...(t.start ? [b('Без даты начала', 'stx')] : []), b('← Назад', 'card')],
      ],
    };
  }
  if (mode === 'status') {
    const cur = t.status || 'todo';
    const sb = (k, label) => b((cur === k ? '✔️ ' : '') + label, 's_' + k);
    return { inline_keyboard: [[sb('todo', '📥 К выполнению'), sb('doing', '🔨 В работе')], [sb('review', '👀 На проверке'), b('✅ Готово', 'done')], [b('← Назад', 'card')]] };
  }
  if (mode === 'check') {
    const rows = (t.checklist || []).slice(0, 10).map((c, i) => [b(`${c.done ? '☑' : '☐'} ${short(c.text, 34)}`, 'ck' + i)]);
    rows.push([b('← Назад', 'card')]);
    return { inline_keyboard: rows };
  }
  const rows = [];
  if (t.ambig && t.due) {
    rows.push([b(`📅 Дата: ${fmtDate(t.due.date, ctx.now)}`, 'altok'), b(`🕐 Время: ${t.ambig.time}`, 'alt')]);
  }
  const projects = t.owner === uid ? myProjects(ctx, uid) : [];
  if (mode === 'new' && !t.project && projects.length) {
    // сразу после создания — положить в проект одним нажатием
    const top = projects.slice(-3).reverse();
    rows.push(top.map(p => b('📁 ' + short(p.name, 18), 'pj' + p.id)));
  }
  const proj = t.project && ctx.projects.get(t.project);
  if (mode === 'new' && proj && proj.members.size > 1 && t.assignee === uid && !t.group) {
    // задача в общем проекте — сразу выбрать, кому
    rows.push([...proj.members].filter(id => id !== uid).slice(0, 3).map(id => b('👤 ' + short(nameOf(ctx, id), 16), 'as' + id)));
    if (proj.members.size > 2) rows.push([b('👥 Нескольким…', 'grp')]);
  }
  // Под карточкой — одна строка. Остальное прячется в «📅 Срок» и «☰ Ещё»
  const cl = t.checklist || [];
  const main = [b('✅ Готово', 'done')];
  if (mode === 'snooze') main.push(b('🔔 +1 час', 's1h'), b('🔔 Завтра', 'smo'));
  else main.push(b('📅 Срок', 'due'));
  if (cl.length) main.push(b(`☑ ${cl.filter(c => c.done).length}/${cl.length}`, 'check'));
  main.push(b('☰ Ещё', 'more'));
  // только что отметили регулярную — даём отменить одним нажатием
  if (t.repeat && t.lastDone && t.lastDone.date === ctx.now.date) rows.push([b('↩️ Отменить «Готово»', 'rundo')]);
  rows.push(main);
  return { inline_keyboard: rows };
}

// ── Telegram API ──

async function tg(env, method, body) {
  for (let attempt = 0; ; attempt++) {
    if (env._use) env._use.tg++;
    let j;
    try {
      const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      j = await r.json().catch(() => ({ ok: false, description: 'bad json' }));
    } catch (e) {
      j = { ok: false, description: 'network: ' + (e && e.message) };
    }
    // слишком часто — Telegram просит подождать; ждём один раз, если недолго
    const wait = j.parameters && j.parameters.retry_after;
    if (!j.ok && j.error_code === 429 && attempt === 0 && wait && wait <= 3) {
      await new Promise(res => setTimeout(res, wait * 1000));
      continue;
    }
    // человек заблокировал бота — запомним, чтобы не тратить на него запросы
    if (!j.ok && j.error_code === 403 && env._use && body && body.chat_id) env._use.blocked.add(body.chat_id);
    if (!j.ok && !/not modified/.test(j.description || '')) console.log('TG', method, j.description);
    return j;
  }
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
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
  'CREATE TABLE IF NOT EXISTS events (user_id INTEGER NOT NULL, h TEXT NOT NULL, uid TEXT, start TEXT NOT NULL, end TEXT, title TEXT, link TEXT, loc TEXT, recur INTEGER, PRIMARY KEY (user_id, h))',
  'CREATE INDEX IF NOT EXISTS events_start ON events (user_id, start)',
  // проверка каждые 5 минут читает только открытые задачи и встречи на сегодня, а не всю историю
  'CREATE INDEX IF NOT EXISTS tasks_open ON tasks (done) WHERE done = 0',
  'CREATE INDEX IF NOT EXISTS events_when ON events (start)',
  'CREATE TABLE IF NOT EXISTS msgs (chat_id INTEGER NOT NULL, msg_id INTEGER NOT NULL, task_id INTEGER NOT NULL, at TEXT, PRIMARY KEY (chat_id, msg_id))',
];

const readyDbs = new WeakSet();
async function ensureDb(env) {
  const raw = env.DB._raw || env.DB;
  if (readyDbs.has(raw)) return;
  try {
    await env.DB.batch(SCHEMA.map(q => env.DB.prepare(q)));
  } catch (e) {
    // одна команда не прошла (например, база не поддерживает какой-то индекс) — пробуем по одной:
    // таблицы обязательны, а без лишнего индекса бот просто будет чуть медленнее, но не замолчит
    console.error('schema batch', e && e.message);
    for (const q of SCHEMA) {
      try { await env.DB.prepare(q).run(); } catch (e2) {
        if (/^\s*CREATE TABLE/i.test(q)) throw e2;
        console.error('schema skip', q.slice(0, 60), e2 && e2.message);
      }
    }
  }
  readyDbs.add(raw);
}

// На один запуск воркера: считаем обращения к базе и к Telegram.
// Бесплатный Cloudflare разрешает ~50 тех и других за запуск — проверка по расписанию держится в этих рамках.
function wrapEnv(env) {
  if (env._use) return env;
  const use = { tg: 0, db: 0, blocked: new Set() };
  const raw = env.DB;
  const wrapStmt = st => {
    const w = {
      _raw: st,
      bind: (...a) => wrapStmt(st.bind(...a)),
      run: () => { use.db++; return st.run(); },
      first: (...a) => { use.db++; return st.first(...a); },
      all: () => { use.db++; return st.all(); },
    };
    return w;
  };
  const w = Object.create(env);
  w._use = use;
  w.DB = raw ? {
    _raw: raw,
    prepare: q => wrapStmt(raw.prepare(q)),
    batch: list => { use.db++; return raw.batch(list.map(x => x._raw || x)); },
  } : raw;
  return w;
}

const LIMIT = { tg: 40, db: 40 }; // с запасом до 50
const room = (env, tg, db) => !env._use || (env._use.tg + tg <= LIMIT.tg && env._use.db + db <= LIMIT.db);

async function makeCtx(env, at) {
  await ensureDb(env);
  const [u, p, m, cal] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM users'),
    env.DB.prepare('SELECT * FROM projects'),
    env.DB.prepare('SELECT * FROM members'),
    env.DB.prepare("SELECT k, v FROM meta WHERE k LIKE 'cal:%'"),
  ]);
  for (const r of cal.results) CAL.set(+r.k.slice(4), r.v);
  const users = new Map(u.results.map(r => [r.id, withSnapshot({ id: r.id, name: r.name, username: r.username, data: JSON.parse(r.data), dirty: false }, r.data)]));
  const projects = new Map(p.results.map(r => [r.id, { id: r.id, name: r.name, owner: r.owner_id, code: r.code, members: new Set() }]));
  for (const r of m.results) if (projects.has(r.project_id)) projects.get(r.project_id).members.add(r.user_id);
  return {
    env, users, projects, now: localNow(tz(env), at),
    dash: new Set(), outbox: [], origin: null, preloaded: null,
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
  withSnapshot(user, JSON.stringify(user.data));
  ctx.users.set(user.id, user);
  return user;
}

// Снимок того, что лежало в базе, — чтобы при сохранении писать только изменённые поля.
// Так бот и расписание, работающие одновременно, не затирают изменения друг друга.
const SNAP = Symbol('snapshot');
// Снимок разбирается, только когда объект действительно сохраняют: в проверке по расписанию
// читаются все открытые задачи, а меняются единицы — так экономим процессор (10 мс на запуск)
function withSnapshot(obj, json) {
  let cache;
  Object.defineProperty(obj, SNAP, {
    get() { if (cache === undefined) cache = typeof json === 'function' ? json() : JSON.parse(json); return cache; },
    set(v) { cache = v; },
    enumerable: false, configurable: true,
  });
  return obj;
}

// SQL-выражение, которое меняет в JSON-колонке только отличающиеся ключи
function jsonPatch(col, before, after) {
  const args = [];
  let expr = col;
  const removed = Object.keys(before || {}).filter(k => !(k in after));
  if (removed.length) { expr = `json_remove(${expr}, ${removed.map(() => '?').join(', ')})`; args.push(...removed.map(k => '$.' + k)); }
  const changed = Object.keys(after).filter(k => !before || JSON.stringify(after[k]) !== JSON.stringify(before[k]));
  if (changed.length) {
    expr = `json_set(${expr}, ${changed.map(() => '?, json(?)').join(', ')})`;
    for (const k of changed) args.push('$.' + k, JSON.stringify(after[k]));
  }
  return { expr, args, empty: !removed.length && !changed.length };
}

async function saveUsers(ctx, only = null) {
  const dirty = [...ctx.users.values()].filter(u => u.dirty && (!only || only.includes(u.id)));
  if (!dirty.length) return;
  const stmts = [];
  for (const u of dirty) {
    const data = JSON.parse(JSON.stringify(u.data));
    const pt = jsonPatch('data', u[SNAP], data);
    stmts.push(DB(ctx).prepare(`UPDATE users SET name = ?, username = ?, data = ${pt.expr} WHERE id = ?`)
      .bind(u.name, u.username, ...pt.args, u.id));
    u[SNAP] = data;
  }
  await DB(ctx).batch(stmts);
  for (const u of dirty) u.dirty = false;
}

const TASK_COLS = ['id', 'owner', 'project', 'assignee', 'done', 'doneAt'];
function rowToTask(r) {
  const t = { ...JSON.parse(r.data), id: r.id, owner: r.owner_id, project: r.project_id, assignee: r.assignee_id, done: !!r.done, doneAt: r.done_at };
  const cols = taskCols(t);
  return withSnapshot(t, () => ({ data: JSON.parse(r.data), cols }));
}
const taskCols = t => ({ owner_id: t.owner, project_id: t.project ?? null, assignee_id: t.assignee, done: t.done ? 1 : 0, done_at: t.doneAt ?? null });
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

// ── Выполненные задачи: список с датой завершения и очистка ──
// скрытые человеком из своего списка выполненных (задачи, которые ему поставили другие)
const hiddenFor = (t, uid) => !!t['hid' + uid];
async function myDoneTasks(ctx, uid, limit = 40) {
  const rows = await queryTasks(ctx, 'done = 1 AND (assignee_id = ? OR owner_id = ?) ORDER BY done_at DESC, id DESC LIMIT ?', uid, uid, limit + 20);
  return rows.filter(t => !hiddenFor(t, uid) && visibleTo(t, uid)).slice(0, limit);
}
// строки «выполнено», сгруппированные по дню завершения
function renderDoneList(ctx, uid, done) {
  let s = '', day = null;
  for (const t of done) {
    const d = t.doneAt || '';
    if (d !== day) { day = d; s += `\n<b>${d ? '✅ ' + fmtDate(d, ctx.now) : '✅ Раньше'}</b>\n`; }
    const who = t.assignee !== uid ? ` <i>· ${esc(nameOf(ctx, t.assignee))}</i>` : t.owner !== uid ? ` <i>· от ${esc(nameOf(ctx, t.owner))}</i>` : '';
    s += withId(ctx, uid, `• <s>${esc(t.title)}</s>${who}`, t.id) + '\n';
  }
  return s;
}
// Очистить выполненное: свои задачи удаляем, поставленные другими — только скрываем из своего списка
async function clearDone(ctx, uid) {
  const own = await DB(ctx).prepare('SELECT count(*) AS n FROM tasks WHERE done = 1 AND owner_id = ?').bind(uid).first();
  const theirs = await DB(ctx).prepare('SELECT count(*) AS n FROM tasks WHERE done = 1 AND assignee_id = ? AND owner_id != ?').bind(uid, uid).first();
  await DB(ctx).batch([
    DB(ctx).prepare('DELETE FROM msgs WHERE task_id IN (SELECT id FROM tasks WHERE done = 1 AND owner_id = ?)').bind(uid),
    DB(ctx).prepare('DELETE FROM tasks WHERE done = 1 AND owner_id = ?').bind(uid),
    DB(ctx).prepare('UPDATE tasks SET data = json_set(data, ?, 1) WHERE done = 1 AND assignee_id = ? AND owner_id != ?').bind('$.hid' + uid, uid, uid),
  ]);
  ctx.dash.add(uid);
  return (own ? own.n : 0) + (theirs ? theirs.n : 0);
}
const CLEAR_ASK = { inline_keyboard: [[{ text: '🧹 Да, очистить', callback_data: 'X:ok' }, { text: 'Отмена', callback_data: 'X:no' }]] };

async function insertTask(ctx, t) {
  const r = await DB(ctx).prepare('INSERT INTO tasks (owner_id, project_id, assignee_id, done, done_at, data) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(t.owner, t.project ?? null, t.assignee, t.done ? 1 : 0, t.doneAt ?? null, taskData(t)).first();
  t.id = r.id;
  withSnapshot(t, JSON.stringify({ data: JSON.parse(taskData(t)), cols: taskCols(t) }));
  return t;
}

// Пишем только то, что поменялось: одновременные изменения (кнопка в чате, доска, расписание) не затирают друг друга
async function saveTask(ctx, t) {
  const snap = t[SNAP];
  const data = JSON.parse(taskData(t));
  const cols = taskCols(t);
  if (!snap) {
    await DB(ctx).prepare('UPDATE tasks SET owner_id = ?, project_id = ?, assignee_id = ?, done = ?, done_at = ?, data = ? WHERE id = ?')
      .bind(cols.owner_id, cols.project_id, cols.assignee_id, cols.done, cols.done_at, JSON.stringify(data), t.id).run();
  } else {
    const pt = jsonPatch('data', snap.data, data);
    const changedCols = Object.keys(cols).filter(k => cols[k] !== snap.cols[k]);
    if (pt.empty && !changedCols.length) return;
    const sets = [`data = ${pt.expr}`, ...changedCols.map(k => `${k} = ?`)];
    await DB(ctx).prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...pt.args, ...changedCols.map(k => cols[k]), t.id).run();
  }
  const before = snap && snap.data;
  withSnapshot(t, JSON.stringify({ data, cols }));
  if (t.group && before) await syncKids(ctx, t, before);
}

async function deleteTask(ctx, t) {
  await DB(ctx).batch([
    DB(ctx).prepare('DELETE FROM tasks WHERE id = ?').bind(t.id),
    DB(ctx).prepare('DELETE FROM msgs WHERE task_id = ?').bind(t.id),
  ]);
}

// ── Задача на нескольких человек ──
// У автора — одна «общая» задача (group.kids: [{uid, id, done}]) с прогрессом; у каждого исполнителя — своя копия
// (parent = id общей) со своими напоминаниями и «Готово». Копия видна только своему исполнителю.
const isKidHidden = (t, uid) => !!t.parent && t.assignee !== uid;
// кто что видит: копию — только её исполнитель; общую — все, кроме тех, у кого есть своя копия (чтобы не было дублей)
const visibleTo = (t, uid) => !isKidHidden(t, uid) && !(t.group && t.owner !== uid && t.group.kids.some(k => k.uid === uid));
const kidDone = (parent, kid) => kid.done || !!(parent.repeat && kid.due && parent.due && kid.due.date > parent.due.date);
function groupLine(ctx, t) {
  const kids = (t.group && t.group.kids) || [];
  const n = kids.filter(k => k.done).length;
  return `👥 ${kids.map(k => `${esc(nameOf(ctx, k.uid))} ${k.done ? '✅' : '⏳'}`).join(' · ')} — ${n}/${kids.length}`;
}
async function kidsOf(ctx, parent) {
  const ids = ((parent.group && parent.group.kids) || []).map(k => k.id);
  return ids.length ? queryTasks(ctx, `id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
}
// Поставить задачу t нескольким людям. Возвращает текст ошибки или null
async function makeGroup(ctx, t, uids, actorId) {
  const p = t.project && ctx.projects.get(t.project);
  if (!p) return 'Поставить нескольким можно задачу в общем проекте';
  if (t.owner !== actorId) return 'Ставить задачу нескольким может только её автор';
  const want = new Set(uids.filter(id => id !== t.owner && p.members.has(id)));
  if (t.assignee !== t.owner && !t.group) want.add(t.assignee); // уже была поручена одному — он остаётся
  const kids = (t.group && t.group.kids) || [];
  if (!want.size && !kids.length) return 'Выбери хотя бы одного человека';
  const actor = esc(nameOf(ctx, actorId));
  // убранные из группы — их копии удаляем
  for (const k of kids.filter(k => !want.has(k.uid))) {
    const kid = await getTask(ctx, k.id);
    if (kid) { await deleteTask(ctx, kid); touch(ctx, kid); if (!kid.done) await send(ctx.env, k.uid, `↩️ <b>${actor}</b> снял(а) с тебя задачу «${esc(kid.title)}»`); }
  }
  const keep = kids.filter(k => want.has(k.uid));
  for (const uid of want) {
    if (keep.some(k => k.uid === uid)) continue;
    const kid = {
      title: t.title, notes: JSON.parse(JSON.stringify(t.notes || [])), checklist: (t.checklist || []).map(c => ({ text: c.text, done: false })),
      due: t.due || null, high: !!t.high, createdAt: ctx.now.date, rem: { at: stamp(ctx.now.date, ctx.now.time) },
      owner: t.owner, assignee: uid, project: t.project, done: false, doneAt: null, parent: t.id,
    };
    if (t.start) kid.start = t.start;
    if (t.repeat) { kid.repeat = t.repeat; kid.history = []; }
    if (t.files) kid.files = t.files;
    await insertTask(ctx, kid);
    keep.push({ uid, id: kid.id, done: false });
    ctx.outbox.push({ to: uid, t: kid, prefix: `📨 <b>Новая задача от ${actor}</b> <i>(общая — на ${want.size} чел.)</i>\n\n` });
  }
  t.group = { kids: keep };
  t.assignee = t.owner;
  if (!keep.length) delete t.group;
  await saveTask(ctx, t); touch(ctx, t);
  return null;
}
// Копия отмечена / возвращена — обновить прогресс у автора; все сделали — закрыть общую
async function groupSync(ctx, kid, actorId, act) {
  const parent = await getTask(ctx, kid.parent);
  if (!parent || !parent.group) return;
  const kids = await kidsOf(ctx, parent);
  parent.group.kids = parent.group.kids.map(k => { const x = kids.find(y => y.id === k.id); return { ...k, done: x ? kidDone(parent, x) : true }; });
  const n = parent.group.kids.filter(k => k.done).length, total = parent.group.kids.length;
  const who = esc(nameOf(ctx, actorId));
  if (act === 'done' && n === total) {
    if (parent.repeat) {
      advanceRepeat(parent, ctx.now);
      parent.group.kids = parent.group.kids.map(k => ({ ...k, done: false }));
      await send(ctx.env, parent.owner, `🎉 Все сделали «<b>${esc(parent.title)}</b>». Следующий раз: ${fmtDue(parent.due, ctx.now)}`);
    } else {
      parent.done = true; parent.doneAt = ctx.now.date;
      await send(ctx.env, parent.owner, `🎉 Все сделали «<b>${esc(parent.title)}</b>» (${total}/${total}) — задача закрыта`);
    }
  } else if (act === 'done') {
    if (actorId !== parent.owner) await send(ctx.env, parent.owner, `✅ <b>${who}</b> сделал(а) «${esc(parent.title)}» (${n}/${total})`);
  } else if (parent.done) {
    parent.done = false; parent.doneAt = null; // кто-то вернул свою копию в работу
  }
  await saveTask(ctx, parent); touch(ctx, parent);
}
// Правка общей задачи доходит до копий: название, срок, начало, важность, новые подробности и пункты
async function syncKids(ctx, parent, before) {
  const keys = ['title', 'due', 'start', 'high'].filter(k => JSON.stringify(parent[k] ?? null) !== JSON.stringify(before[k] ?? null));
  const bn = before.notes || [], bc = before.checklist || [];
  const newNotes = (parent.notes || []).length > bn.length ? parent.notes.slice(bn.length) : [];
  const newItems = (parent.checklist || []).length > bc.length ? parent.checklist.slice(bc.length) : [];
  if (!keys.length && !newNotes.length && !newItems.length) return;
  for (const kid of await kidsOf(ctx, parent)) {
    if (kid.done) continue;
    const was = JSON.stringify([kid.title, kid.due, kid.start, kid.high]);
    for (const k of keys) {
      if (k === 'due') { if (JSON.stringify(kid.due) !== JSON.stringify(parent.due || null)) setDue(kid, parent.due || null); }
      else if (parent[k] === undefined || parent[k] === null) delete kid[k]; else kid[k] = parent[k];
    }
    if (newNotes.length) kid.notes = [...(kid.notes || []), ...newNotes];
    if (newItems.length) kid.checklist = [...(kid.checklist || []), ...newItems.map(c => ({ text: c.text, done: false }))];
    const changed = was !== JSON.stringify([kid.title, kid.due, kid.start, kid.high]) || newNotes.length || newItems.length;
    if (!changed) continue; // у копии уже то же самое (например, сама перешла на следующий раз)
    await saveTask(ctx, kid); touch(ctx, kid);
    if (changed) {
      ctx.outbox.push({ to: kid.assignee, t: kid, prefix: `✏️ <b>${esc(nameOf(ctx, parent.owner))}</b> изменил(а) общую задачу\n\n` });
    }
  }
}

async function rememberMsg(ctx, chatId, msgId, taskId) {
  await DB(ctx).prepare('INSERT OR REPLACE INTO msgs (chat_id, msg_id, task_id, at) VALUES (?, ?, ?, ?)')
    .bind(chatId, msgId, taskId, ctx.now.date).run();
}

async function taskByMsg(ctx, chatId, msgId) {
  const r = await DB(ctx).prepare('SELECT task_id FROM msgs WHERE chat_id = ? AND msg_id = ?').bind(chatId, msgId).first();
  return r ? getTask(ctx, r.task_id) : null;
}

// Почему кнопка задачи больше не работает — понятными словами, а не «не найдена»
const lostTask = t => (t ? 'Эта задача тебе больше не доступна: её передали другому или убрали из проекта.' : 'Этой задачи больше нет — её удалили.');

function canAccess(ctx, t, uid) {
  if (t.owner === uid || t.assignee === uid) return true;
  const p = t.project && ctx.projects.get(t.project);
  return !!(p && p.members.has(uid));
}

const myOpenTasks = async (ctx, uid) => (await queryTasks(ctx, 'done = 0 AND (assignee_id = ? OR owner_id = ?)', uid, uid)).filter(t => visibleTo(t, uid));

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

// Переименовать проект (только создатель). Возвращает текст ошибки или null
async function renameProject(ctx, uid, p, rawName) {
  const name = String(rawName || '').replace(/^[#«"\s]+|[»".\s]+$/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (p.owner !== uid) return `Переименовать проект может только его создатель — ${nameOf(ctx, p.owner)}.`;
  if (!name) return 'Название пустое 🙂';
  if (name === p.name) return null;
  const same = myProjects(ctx, uid).find(x => x.id !== p.id && x.name.toLowerCase() === name.toLowerCase());
  if (same) return `Проект «${name}» у тебя уже есть — выбери другое название.`;
  const old = p.name;
  await DB(ctx).prepare('UPDATE projects SET name = ? WHERE id = ?').bind(name, p.id).run();
  p.name = name;
  for (const id of p.members) {
    ctx.dash.add(id);
    if (id !== uid) await send(ctx.env, id, `✏️ <b>${esc(nameOf(ctx, uid))}</b> переименовал(а) проект «${esc(old)}» → «<b>${esc(name)}</b>»`);
  }
  return null;
}
async function renameProjectFlow(ctx, user, p, rawName) {
  const err = await renameProject(ctx, user.id, p, rawName);
  if (err) return send(ctx.env, user.id, esc(err));
  return send(ctx.env, user.id, `✏️ Проект теперь называется «<b>${esc(p.name)}</b>»`, { reply_markup: { inline_keyboard: [[{ text: '📋 Задачи проекта', callback_data: `P:v${p.id}` }]] } });
}
async function askProjectRename(ctx, user, p) {
  if (p.owner !== user.id) return send(ctx.env, user.id, `Переименовать проект может только его создатель — ${esc(nameOf(ctx, p.owner))}.`);
  user.data.awaiting = { kind: 'prename', pid: p.id, at: realNowMs(ctx.env) }; user.dirty = true;
  return send(ctx.env, user.id, `✏️ Как назвать проект «<b>${esc(p.name)}</b>»? Напиши новое название одним сообщением.`,
    { reply_markup: { inline_keyboard: [[{ text: '✖ Отмена', callback_data: 'P:cancel' }]] } });
}

async function joinProject(ctx, p, uid) {
  await DB(ctx).prepare('INSERT OR IGNORE INTO members (project_id, user_id) VALUES (?, ?)').bind(p.id, uid).run();
  p.members.add(uid);
}

// Удалить проект целиком (только автор). keepTasks — задачи остаются у исполнителей как личные
async function deleteProject(ctx, p, keepTasks) {
  const tasks = await queryTasks(ctx, 'project_id = ?', p.id);
  for (const t of tasks) touch(ctx, t);
  const st = [];
  if (keepTasks) st.push(DB(ctx).prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').bind(p.id));
  else {
    st.push(DB(ctx).prepare('DELETE FROM msgs WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)').bind(p.id));
    st.push(DB(ctx).prepare('DELETE FROM tasks WHERE project_id = ?').bind(p.id));
  }
  st.push(DB(ctx).prepare('DELETE FROM members WHERE project_id = ?').bind(p.id));
  st.push(DB(ctx).prepare('DELETE FROM projects WHERE id = ?').bind(p.id));
  await DB(ctx).batch(st);
  ctx.projects.delete(p.id);
  return tasks.length;
}

function projectKeyboard(p, uid) {
  const rows = [[{ text: '👥 Позвать людей', callback_data: `P:i${p.id}` }]];
  if (p.owner === uid) rows.push([{ text: '✏️ Переименовать', callback_data: `P:r${p.id}` }, { text: '🗑 Удалить проект', callback_data: `P:d${p.id}` }]);
  else rows.push([{ text: '🚪 Выйти из проекта', callback_data: `P:l${p.id}` }]);
  return { inline_keyboard: rows };
}

async function askDeleteProject(ctx, user, p) {
  if (p.owner !== user.id) {
    return send(ctx.env, user.id, `Удалить проект «${esc(p.name)}» может только его создатель — ${esc(nameOf(ctx, p.owner))}. Можно выйти из него.`,
      { reply_markup: { inline_keyboard: [[{ text: '🚪 Выйти из проекта', callback_data: `P:l${p.id}` }]] } });
  }
  const open = await queryTasks(ctx, 'project_id = ? AND done = 0', p.id);
  const others = [...p.members].filter(id => id !== user.id).map(id => esc(nameOf(ctx, id)));
  return send(ctx.env, user.id, `🗑 <b>Удалить проект «${esc(p.name)}»?</b>\n\nОткрытых задач в нём: ${open.length}.` +
    (others.length ? `\nУчастники (${others.join(', ')}) больше не увидят проект — я им сообщу.` : ''), {
    reply_markup: { inline_keyboard: [
      ...(open.length ? [[{ text: '📋 Удалить, задачи оставить (станут личными)', callback_data: `P:k${p.id}` }]] : []),
      [{ text: open.length ? '🗑 Удалить вместе с задачами' : '🗑 Да, удалить', callback_data: `P:x${p.id}` }],
      [{ text: 'Отмена', callback_data: 'P:no' }],
    ] },
  });
}

async function leaveProject(ctx, p, uid) {
  await DB(ctx).prepare('DELETE FROM members WHERE project_id = ? AND user_id = ?').bind(p.id, uid).run();
  p.members.delete(uid);
  const others = [...p.members];
  // мои задачи в проекте, поставленные другими, возвращаем их авторам
  const mine = await queryTasks(ctx, 'project_id = ? AND assignee_id = ? AND done = 0', p.id, uid);
  for (const t of mine) {
    if (t.parent) {
      // копия общей задачи — просто убираем человека из общей
      const parent = await getTask(ctx, t.parent);
      await deleteTask(ctx, t);
      if (parent && parent.group) {
        parent.group.kids = parent.group.kids.filter(k => k.id !== t.id);
        if (!parent.group.kids.length) delete parent.group;
        await saveTask(ctx, parent); ctx.dash.add(parent.owner);
      }
      continue;
    }
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

async function refreshDash(ctx, uid, preloaded = null) {
  const user = ctx.users.get(uid);
  if (!user || user.data.blocked) return;
  const all = preloaded ? preloaded.filter(t => !t.done && (t.assignee === uid || t.owner === uid)) : await myOpenTasks(ctx, uid);
  const mine = all.filter(t => t.assignee === uid);
  const delegated = all.filter(t => t.assignee !== uid);
  const dn = await DB(ctx).prepare('SELECT count(*) AS n FROM tasks WHERE done = 1 AND assignee_id = ? AND done_at = ?').bind(uid, ctx.now.date).first();
  const text = renderDash(ctx, user, mine, delegated, dn ? dn.n : 0);
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
    try { await refreshDash(ctx, uid, ctx.preloaded || null); } catch (e) { console.error('dash', e && e.stack); }
  }
  ctx.dash.clear();
  if (ctx.env._use) {
    for (const id of ctx.env._use.blocked) {
      const u = ctx.users.get(id);
      if (u && !u.data.blocked) { u.data.blocked = true; u.dirty = true; }
    }
  }
  await saveUsers(ctx);
}

// ── Создание задачи из текста ──

const HASHTAG = /(?<![\p{L}\d_&/])#([\p{L}\d_]+)/u;
const MENTION = /(?<![\p{L}\d_@.])@([\p{L}\d_]+)/u;
// «Напомни …», «Добавь задачу …», «Задача: …» — вступление, не часть названия («Задача по отчёту» — часть)
const LEAD_IN = /^\s*(?:(?:напомни(?:ть)?(?:\s+мне)?|добавь(?:\s+задачу)?|запиши|надо|нужно)[\s,:—-]+|задача\s*[:—-]\s*)/iu;
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

async function createFromText(ctx, user, text, { from = null, prefix = '', project: projectHint = null, files = null, silent = false } = {}) {
  const now = ctx.now;
  const [firstRaw, ...restLines] = text.split('\n');
  let first = firstRaw.replace(LEAD_IN, '');
  let tag = null, mention = null;
  first = first.replace(HASHTAG, (_, n) => { tag = n; return ' '; });
  // «Работа: отчёт до пятницы» — название существующего проекта через двоеточие
  let prefixProject = null;
  if (!tag) {
    const pm = first.match(/^\s*([^:\n]{2,40}?)\s*:\s+(\S.*)$/u);
    if (pm && (prefixProject = findProject(ctx, user.id, pm[1].trim()))) first = pm[2];
  }
  // «@Анна @Петя …» — несколько исполнителей; «всем: …», «@все» — все участники проекта
  const mentions = [];
  let toAll = false;
  first = first.replace(new RegExp(MENTION.source, 'gu'), (_, n) => { if (/^(?:все|всем)$/iu.test(n)) toAll = true; else mentions.push(n); return ' '; });
  first = first.replace(/^\s*(?:всем|для\s+всех)(?![\p{L}\d])[\s,:—–-]*/iu, () => { toAll = true; return ''; });
  mention = !toAll && mentions.length === 1 ? mentions[0] : null;
  const p = parseTask(first, now);
  if (!p.title) return { error: 'Вижу срок, но не вижу, что сделать 🙂 Напиши, например: «Сдать отчёт завтра».' };

  const warn = [];
  let project = prefixProject || projectHint;
  let createdProject = false;
  if (tag) {
    project = findProject(ctx, user.id, tag);
    if (!project) { project = await createProject(ctx, user.id, tag); createdProject = true; }
  }
  let assignee = user.id;
  let groupIds = null;
  if (toAll || mentions.length > 1) {
    const people = [];
    for (const n of mentions) {
      const person = findPerson(ctx, user.id, n, project);
      if (person) people.push(person.id);
      else warn.push(`⚠️ Не нашёл «@${esc(n)}» среди участников ${project ? `проекта «${esc(project.name)}»` : 'твоих проектов'}.`);
    }
    if (!project && people.length) {
      const common = myProjects(ctx, user.id).filter(pr => people.every(id => pr.members.has(id)));
      if (common.length === 1) project = common[0];
    }
    if (!project) warn.push('⚠️ Чтобы поставить задачу нескольким, начни с названия проекта: <code>Отдел: всем …</code>. Задача пока на тебе.');
    else groupIds = toAll ? [...project.members].filter(id => id !== user.id) : people;
  } else if (mention) {
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

  // очень длинная первая строка (пересланный пост) — в название первые ~120 символов, остальное в подробности
  let title = p.title, overflow = '';
  if (title.length > 150) {
    const cut = title.lastIndexOf(' ', 120);
    overflow = title.slice(cut > 60 ? cut : 120).trim();
    title = title.slice(0, cut > 60 ? cut : 120).trim() + '…';
  }
  const details = parseDetails((overflow ? '…' + overflow + '\n' : '') + restLines.join('\n'), user.id, now);
  if (from) details.notes.push({ at: now.date, by: user.id, text: `Переслано от: ${from}` });

  const t = {
    title, notes: details.notes, checklist: details.checklist, due: p.due, high: p.high,
    createdAt: now.date, rem: { at: stamp(now.date, now.time) }, owner: user.id, assignee, project: project ? project.id : null,
    done: false, doneAt: null,
  };
  if (p.repeat) { t.repeat = p.repeat; t.history = []; }
  if (p.ambig) t.ambig = p.ambig;
  if (p.start) t.start = p.start;
  if (files && files.length) t.files = files;
  if (/^(?:жду|ждём|ждем|ожидаю)\s/i.test(title)) t.waiting = { since: now.date, check: addDays(now.date, 3) };
  await insertTask(ctx, t);
  touch(ctx, t);
  if (groupIds && groupIds.length) {
    const err = await makeGroup(ctx, t, groupIds, user.id);
    if (err) warn.push('⚠️ ' + esc(err));
  }

  if (silent) {
    if (assignee !== user.id) ctx.outbox.push({ to: assignee, t, prefix: `📨 <b>Новая задача от ${esc(user.name)}</b>\n\n` });
    return { task: t };
  }
  let head = prefix + (t.group ? `👥 Задача поставлена: <b>${t.group.kids.map(k => esc(nameOf(ctx, k.uid))).join(', ')}</b>`
    : assignee === user.id ? '✅ Задача сохранена' : `📨 Задача поставлена: <b>${esc(nameOf(ctx, assignee))}</b>`);
  if (createdProject) head += `\n📁 Новый проект «${esc(project.name)}» — позвать в него людей: /invite_${project.id}`;
  if (!p.repeat && /(?:^|[^\p{L}])(?:кажд|ежедн|еженед|ежемес|ежегод|раз\s+в\s)/iu.test(first)) {
    warn.push('⚠️ Похоже, задача регулярная, но я не понял, как повторять. Нажми «☰ Ещё» → «🔁 Повтор».');
  }
  if (p.bad) warn.push(`⚠️ «${esc(p.bad)}» — такой даты или времени не бывает, поэтому ${p.due ? 'время' : 'срок'} не поставил. Нажми «📅 Срок» или ответь на эту карточку датой.`);
  warn.push(...awayNote(ctx, t.group ? t.group.kids.map(k => k.uid) : assignee !== user.id ? [assignee] : []));
  if (warn.length) head += '\n' + warn.join('\n');
  if (project && project.members.size > 1 && assignee === user.id && !mention && !t.group) head += '\n👤 Кому поставить? Нажми имя внизу (или «👥 Нескольким») — или оставь на себе.';
  if (p.due && (p.due.time || p.due.date === now.date) && !(await cronHealthy(ctx))) {
    head += '\n\n⚠️ <b>Напоминания сейчас не приходят</b>: не вижу проверок по расписанию. Если бот только что установлен — подожди 5 минут. Иначе включи Cron (шаг 7 инструкции). Проверить: /status';
  }
  const hint = p.due || p.bad ? '' : '\n<i>📅 Срок не указан — нажми «📅 Срок» или ответь датой.</i>';
  const r = await send(ctx.env, user.id, head + '\n\n' + renderCard(ctx, t) + hint, { reply_markup: cardKeyboard(ctx, t, user.id, 'new') });
  if (r.ok) await rememberMsg(ctx, user.id, r.result.message_id, t.id);
  if (assignee !== user.id) ctx.outbox.push({ to: assignee, t, prefix: `📨 <b>Новая задача от ${esc(user.name)}</b>\n\n` });
  return { task: t };
}

// ── Действия над задачей (кнопки в чате и доска) ──


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
    // запоминаем, чтобы случайное «Готово» можно было отменить
    t.lastDone = { due: t.due, date: now.date, checklist: (t.checklist || []).map(c => ({ ...c })) };
    t.history = [...(t.history || []), now.date].slice(-60);
    (t.checklist || []).forEach(c => { c.done = false; });
    delete t.remindAt;
    const finished = advanceRepeat(t, now);
    if (t.meeting) {
      // регулярная задача к регулярной встрече — переезжает к следующей встрече серии
      const nx = t.meeting.uid ? await nextOfSeries(ctx, t.assignee, { uid: t.meeting.uid, start: t.meeting.start }) : null;
      if (nx) t.meeting = { ...t.meeting, h: nx.h, start: nx.start }; else delete t.meeting;
    }
    res.toast = finished ? '✅ Отмечено! Это был последний раз — повтор закончился' : `✅ Отмечено! Следующий раз: ${fmtDue(t.due, now)}`;
    if (!t.parent) notifyOthers(ctx, t, uid, `✅ <b>${actor}</b>: выполнено (регулярная)\n\n`);
  } else if (act === 'rundo' && t.lastDone) {
    const ld = t.lastDone;
    if (t.done) { t.done = false; t.doneAt = null; }
    setDue(t, ld.due);
    t.history = (t.history || []).slice(0, -1);
    if (ld.checklist) t.checklist = ld.checklist;
    delete t.lastDone;
    res.toast = `↩️ Отметка отменена. Срок снова: ${fmtDue(t.due, now)}`;
  } else if (act === 'done') {
    t.done = true; t.doneAt = now.date; delete t.remindAt;
    res.toast = '✅ Готово! Так держать';
    if (!t.parent) notifyOthers(ctx, t, uid, `✅ <b>${actor}</b>: выполнено\n\n`);
  } else if (act === 'undo') {
    t.done = false; t.doneAt = null; res.toast = 'Снова в работе';
    if (!t.parent) notifyOthers(ctx, t, uid, `↩️ <b>${actor}</b> вернул(а) задачу в работу\n\n`);
  } else if (act === 'skip' && t.repeat) {
    res.toast = advanceRepeat(t, now) ? '⏭ Пропущено. Это был последний раз — повтор закончился' : `⏭ Пропущено. Следующий раз: ${fmtDue(t.due, now)}`;
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
    c.done = !c.done; res.toast = c.done ? '☑ Отмечено' : '☐ Снято'; res.mode = 'check';
  } else if (act === 's1h' || act === 'sev' || act === 'smo') {
    const nowMs = stamp(now.date, now.time);
    const sc = schedOf(ctx.env, ctx.users.get(uid));
    const eveningAt = sc.evening && sc.evening !== 'off' ? sc.evening : '19:00';
    const morningAt = sc.morning && sc.morning !== 'off' ? sc.morning : '09:00';
    if (act === 's1h') t.remindAt = fromStamp(nowMs + 3600e3);
    else if (act === 'sev') t.remindAt = now.time < eveningAt ? { date: now.date, time: eveningAt } : fromStamp(nowMs + 2 * 3600e3);
    else t.remindAt = { date: addDays(now.date, 1), time: morningAt };
    res.toast = `🔔 Напомню ${fmtDue(t.remindAt, now)}`;
    res.mode = 'snooze';
  } else if (act === 'alt' && t.ambig) {
    const tm = t.ambig.time;
    setDue(t, { date: tm > now.time ? now.date : addDays(now.date, 1), time: tm });
    res.toast = `🕐 Срок: ${fmtDue(t.due, now)}`;
  } else if (act === 'altok') {
    delete t.ambig; res.toast = `📅 Срок: ${fmtDue(t.due, now)}`;
  } else if (act === 'notes') {
    res.mode = 'notes'; res.changed = false; res.toast = 'Нажми строку, чтобы убрать её';
  } else if (/^nd\d+_\d+_\w+$/.test(act) || /^cd\d+_\w+$/.test(act)) {
    const [i, j, k] = act.slice(2).split('_');
    const isNote = act[0] === 'n';
    const l = isNote ? noteLines(t).find(x => x.i === +i && x.j === +j) : (t.checklist || [])[+i];
    const key = isNote ? k : j;
    // строка могла сдвинуться, если список меняли в другом месте, — сверяем её содержимое
    if (!l || (isNote ? lineKey(l) : hashKey(l.text).slice(0, 4)) !== key) {
      return { ...res, changed: false, mode: 'notes', toast: 'Список уже изменился — вот актуальный' };
    }
    rememberDetails(ctx, uid, t);
    if (isNote) removeNoteLine(t, +i, +j); else t.checklist = t.checklist.filter((_, x) => x !== +i);
    res.mode = noteLines(t).length || (t.checklist || []).length ? 'notes' : 'normal';
    res.toast = `🗑 Убрано: ${short(l.text, 60)}. Вернуть — «↩️» в «☰ Ещё»`;
  } else if (act === 'dclr') {
    rememberDetails(ctx, uid, t);
    t.notes = []; t.checklist = [];
    const u = ctx.users.get(uid);
    if (u && u.data.awaiting && u.data.awaiting.kind === 'details') { delete u.data.awaiting; u.dirty = true; }
    res.toast = '🗑 Подробности и чек-лист очищены. Вернуть — «☰ Ещё» → «↩️»';
  } else if (act === 'nclr' || act === 'cclr') {
    rememberDetails(ctx, uid, t);
    if (act === 'nclr') t.notes = []; else t.checklist = [];
    res.mode = noteLines(t).length || (t.checklist || []).length ? 'notes' : 'normal';
    res.toast = act === 'nclr' ? '🗑 Подробности удалены' : '🗑 Чек-лист удалён';
  } else if (act === 'nrest') {
    const u = ctx.users.get(uid);
    const un = u && u.data.undoDetails;
    if (!un || un.id !== t.id) return { ...res, changed: false, toast: 'Нечего возвращать' };
    t.notes = un.notes; t.checklist = un.checklist;
    delete u.data.undoDetails; u.dirty = true;
    res.toast = '↩️ Вернул как было';
  } else if (act === 'meet') {
    const u = ctx.users.get(uid);
    if (!u || !u.data.cal) return { ...res, changed: false, mode: 'more', toast: 'Сначала подключи календарь: кнопка «📅 Встречи» внизу' };
    const ns = stamp(now.date, now.time);
    ctx.meetList = (await userEvents(ctx, uid, now.date, addDays(now.date, 14)))
      .filter(e => stamp(e.start.date, e.start.time || '23:59') > ns).slice(0, 8);
    res.mode = 'meet'; res.changed = false;
    res.toast = ctx.meetList.length ? 'К какой встрече?' : 'В ближайшие 2 недели встреч нет';
  } else if (/^mt[a-z0-9]+$/.test(act)) {
    const e = await eventByKey(ctx, uid, act.slice(2));
    if (!e) return { ...res, changed: false, toast: 'Не нашёл встречу — открой «🗓 К встрече» ещё раз' };
    res.toast = linkToMeeting(t, e, now);
  } else if (act === 'unmeet') {
    delete t.meeting; res.toast = 'Задача больше не привязана к встрече';
  } else if (act === 'due' || act === 'more' || act === 'check') {
    res.mode = act; res.changed = false;
    if (act === 'due') res.toast = 'Выбери кнопку — или просто напиши дату сообщением: «7 октября 15:00»';
  } else if (act === 'wait') {
    res.mode = 'wait'; res.changed = false; res.toast = 'Когда спросить, пришёл ли ответ?';
  } else if (/^w(1|3|7)$/.test(act)) {
    const n = +act.slice(1);
    t.waiting = { since: (t.waiting && t.waiting.since) || now.date, check: addDays(now.date, n) };
    res.toast = `⏳ Жду ответа. Спрошу ${fmtDate(t.waiting.check, now)}`;
  } else if (act === 'wx') {
    delete t.waiting; res.toast = 'Ответ получен — задача снова в работе';
  } else if (act === 'nag') {
    t.nag = !isNagOn(t);
    res.toast = t.nag ? `🔔 Буду напоминать ${nagWord(ctx.users.get(t.assignee), ctx.env)}, пока не сделаешь` : '🔕 Хорошо, не буду донимать';
  } else if (act === 'start' || act === 'status') {
    res.mode = act; res.changed = false;
    if (act === 'start') res.toast = 'Когда начать? Дедлайн останется прежним';
  } else if (act === 'st0' || act === 'st1') {
    t.start = { date: act === 'st0' ? now.date : addDays(now.date, 1), time: null };
    if (t.due && t.start.date > t.due.date) res.toast = '⚠️ Начало позже дедлайна — проверь даты';
    else res.toast = `▶️ Начать: ${fmtDue(t.start, now)}`;
  } else if (act === 'stx') {
    delete t.start; res.toast = 'Без даты начала';
  } else if (/^s_(todo|doing|review)$/.test(act)) {
    const st = act.slice(2);
    if (st === 'todo') delete t.status; else t.status = st;
    res.toast = STATUS[st];
    notifyOthers(ctx, t, uid, `🏷 <b>${actor}</b>: ${STATUS[st]}\n\n`);
  } else if (act === 'rp') {
    res.mode = 'repeat'; res.changed = false; res.toast = 'Как часто повторять?';
  } else if (/^r_\w+$/.test(act)) {
    const r = repeatPreset(act.slice(2), t, now);
    if (!r) return { ...res, changed: false };
    applyRepeat(t, r, now);
    res.toast = `🔁 ${fmtRepeat(r)} · ближайший раз ${fmtDue(t.due, now)}`;
  } else if (act === 'proj') {
    if (t.owner !== uid) return { ...res, toast: 'Менять проект может только автор задачи', changed: false };
    res.mode = 'project'; res.changed = false; res.toast = 'В какой проект?';
  } else if (/^pj\d+$/.test(act)) {
    if (t.owner !== uid) return { ...res, toast: 'Менять проект может только автор задачи', changed: false };
    if (t.group || t.parent) return { ...res, changed: false, toast: 'Общую задачу нельзя перенести в другой проект' };
    const pid = +act.slice(2);
    const p = pid ? ctx.projects.get(pid) : null;
    if (pid && (!p || !p.members.has(uid))) return { ...res, toast: 'Нет такого проекта', changed: false };
    t.project = p ? p.id : null;
    if (!p || !p.members.has(t.assignee)) {
      ctx.dash.add(t.assignee);
      if (t.assignee !== uid && !t.done) await send(ctx.env, t.assignee, `↩️ <b>${actor}</b> забрал(а) задачу «${esc(t.title)}» — она больше не на тебе.`);
      t.assignee = t.owner;
    }
    if (p && p.members.size > 1) { res.mode = 'assign'; res.toast = `📁 ${p.name} — кому поставить?`; }
    else res.toast = p ? `📁 ${p.name}` : 'Личная задача';
  } else if (act === 'assign') {
    if (t.parent) return { ...res, changed: false, toast: 'Это твоя часть общей задачи — исполнителей меняет автор' };
    res.mode = t.group ? 'grp' : 'assign'; res.changed = false;
    if (t.group) startGroupPick(ctx, t, uid);
  } else if (act === 'grp' || act === 'gpall' || act === 'gpok' || /^gp\d+$/.test(act)) {
    // выбор нескольких исполнителей галочками
    if (t.owner !== uid) return { ...res, changed: false, toast: 'Ставить задачу нескольким может только её автор' };
    const p = t.project && ctx.projects.get(t.project);
    if (!p || p.members.size < 2) return { ...res, changed: false, toast: 'Нужен проект, где есть кто-то кроме тебя' };
    const u = ctx.users.get(uid);
    if (act === 'grp' || !u.data.grpSel || u.data.grpSel.id !== t.id) startGroupPick(ctx, t, uid);
    const sel = new Set(u.data.grpSel.ids);
    if (act === 'gpall') [...p.members].filter(id => id !== uid).forEach(id => sel.add(id));
    else if (/^gp\d+$/.test(act)) { const id = +act.slice(2); if (sel.has(id)) sel.delete(id); else sel.add(id); }
    u.data.grpSel = { id: t.id, ids: [...sel] }; u.dirty = true;
    if (act !== 'gpok') return { ...res, changed: false, mode: 'grp', toast: act === 'grp' ? 'Отметь, кому поставить' : `Выбрано: ${sel.size}` };
    delete u.data.grpSel;
    if (!t.group && sel.size === 1) return applyAction(ctx, t, 'as' + [...sel][0], uid); // один человек — обычное поручение
    const err = await makeGroup(ctx, t, [...sel], uid);
    if (err) return { ...res, changed: false, mode: 'grp', toast: err };
    return { ...res, changed: false, toast: t.group ? `👥 Поставлено: ${t.group.kids.length} чел.` : 'Задача снова только на тебе' };
  } else if (/^as\d+$/.test(act)) {
    if (t.parent) return { ...res, changed: false, toast: 'Это твоя часть общей задачи — исполнителей меняет автор' };
    if (t.group) return { ...res, changed: false, mode: 'grp', toast: 'Задача общая — отметь людей галочками' };
    const to = +act.slice(2);
    const p = ctx.projects.get(t.project);
    if (!p || !p.members.has(to)) return { ...res, toast: 'Этого человека нет в проекте', changed: false };
    if (to !== t.assignee) {
      ctx.dash.add(t.assignee);
      if (t.assignee !== uid && !t.done) await send(ctx.env, t.assignee, `↩️ <b>${actor}</b> передал(а) задачу «${esc(t.title)}» ${to === uid ? 'себе' : esc(nameOf(ctx, to))} — она больше не на тебе.`);
      t.assignee = to; t.rem = {};
      if (to !== uid) ctx.outbox.push({ to, t, prefix: `📨 <b>${actor} поручил(а) тебе задачу</b>\n\n` });
    }
    const aw = awayTill(ctx.users.get(to), ctx.now);
    res.toast = `👤 ${nameOf(ctx, to)}` + (aw && to !== uid ? ` — в отпуске по ${fmtDay(aw, ctx.now)}` : '');
  } else if (act === 'hide' || (act === 'del' && t.done && t.owner !== uid)) {
    // выполненную задачу от другого человека убираем только из своего списка — у автора она остаётся
    if (!t.done) return { ...res, changed: false, toast: 'Убрать из списка можно только выполненную задачу' };
    t['hid' + uid] = 1;
    await saveTask(ctx, t); touch(ctx, t);
    return { ...res, deleted: true, hidden: true, toast: 'Убрано из твоего списка выполненных' };
  } else if (act === 'del') {
    if (t.owner !== uid) return { ...res, toast: 'Удалить может только автор задачи', changed: false };
    res.mode = 'del'; res.changed = false;
  } else if (act === 'delok') {
    if (t.owner !== uid) return { ...res, toast: 'Удалить может только автор задачи', changed: false };
    if (t.group) {
      for (const kid of await kidsOf(ctx, t)) {
        await deleteTask(ctx, kid); touch(ctx, kid);
        if (!kid.done) await send(ctx.env, kid.assignee, `🗑 <b>${actor}</b> удалил(а) общую задачу «${esc(kid.title)}»`);
      }
    }
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
  // общая задача: копия отмечена — прогресс у автора; автор закрыл общую — закрываем у всех
  if (res.changed && t.parent && ['done', 'undo', 'rundo'].includes(act)) await groupSync(ctx, t, uid, act === 'done' ? 'done' : 'undo');
  if (res.changed && t.group && act === 'done' && !t.repeat && t.done) await closeKids(ctx, t, uid);
  return res;
}

function startGroupPick(ctx, t, uid) {
  const u = ctx.users.get(uid);
  const ids = t.group ? t.group.kids.map(k => k.uid) : t.assignee !== t.owner ? [t.assignee] : [];
  u.data.grpSel = { id: t.id, ids }; u.dirty = true;
}
async function closeKids(ctx, t, uid) {
  for (const kid of await kidsOf(ctx, t)) {
    if (kid.done) continue;
    kid.done = true; kid.doneAt = ctx.now.date;
    await saveTask(ctx, kid); touch(ctx, kid);
    await send(ctx.env, kid.assignee, `✅ <b>${esc(nameOf(ctx, uid))}</b> закрыл(а) общую задачу «${esc(kid.title)}» — делать больше не нужно`);
  }
  t.group.kids = t.group.kids.map(k => ({ ...k, done: true }));
  await saveTask(ctx, t);
}

// Новый срок, написанный сообщением («7 октября в 15.00»)
async function applyTypedDue(ctx, user, t, p) {
  const now = ctx.now;
  setDue(t, { date: p.due.date, time: p.due.time || (t.repeat && t.due ? t.due.time : null) });
  if (p.ambig) t.ambig = p.ambig;
  if (t.done && !t.repeat) { t.done = false; t.doneAt = null; }
  await saveTask(ctx, t); touch(ctx, t);
  notifyOthers(ctx, t, user.id, `📅 <b>${esc(user.name)}</b>: срок теперь ${fmtDue(t.due, now)}\n\n`);
  return sendCard(ctx, user.id, t, `📅 Срок перенесён: <b>${fmtDue(t.due, now)}</b>\n\n`);
}

// ── «Жду ответа»: свой день, когда спросить ──
const ASK_RE = /^(?:спроси(?:ть)?|уточни(?:ть)?|напомни(?:ть)?(?:\s+(?:спросить|уточнить))?|проверь|проверить)\s+(.+)$/iu;
// «в четверг», «спросить 12.10», «через 2 недели» → дата; null, если это не только дата
function waitDateOf(text, now) {
  const m = text.trim().match(ASK_RE);
  const p = parseTask(m ? m[1] : text.trim(), now);
  return !p.title && p.due && !p.repeat ? p.due.date : null;
}
function setWaitCheck(t, date, now) {
  t.waiting = { since: (t.waiting && t.waiting.since) || now.date, check: date > now.date ? date : addDays(now.date, 1) };
}
async function askWaitDate(ctx, user, t) {
  user.data.awaiting = { kind: 'wait', taskId: t.id, at: realNowMs(ctx.env) }; user.dirty = true;
  return send(ctx.env, user.id, `⏳ Когда спросить, пришёл ли ответ по «<b>${esc(t.title)}</b>»? Напиши день:\n<code>в четверг</code> · <code>12.10</code> · <code>через 2 недели</code>`);
}

// ── Подробности одним текстом: обычные строки — заметки, «- …» — чек-лист, «- ✓ …» — отмеченный пункт ──
function detailsText(t) {
  const notes = (t.notes || []).map(n => n.text).join('\n');
  const cl = (t.checklist || []).map(c => `- ${c.done ? '✓ ' : ''}${c.text}`).join('\n');
  return [notes, cl].filter(Boolean).join('\n');
}
function setDetailsFromText(t, text, uid, now) {
  const old = t.checklist || [];
  const notes = [], checklist = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(CHECK_LINE);
    if (m) {
      let s = m[1].trim(), done = false;
      const d = s.match(/^(?:✓|✔️?|☑️?|\[x\])\s*(.+)$/iu);
      if (d) { done = true; s = d[1].trim(); } else { const prev = old.find(c => c.text === s); if (prev) done = prev.done; }
      if (s) checklist.push({ text: s.slice(0, 300), done });
    } else if (line.trim()) notes.push(line.trim());
  }
  const joined = notes.join('\n');
  // текст не менялся — оставляем заметки как были (с авторами в общих проектах)
  if (joined !== (t.notes || []).map(n => n.text).join('\n')) t.notes = joined ? [{ at: now.date, by: uid, text: joined.slice(0, 3500) }] : [];
  t.checklist = checklist.slice(0, 50);
}

// ── Название задачи ──
// Общую задачу переименовывает автор — новое название уходит во все копии; копию переименовать нельзя
async function renameTask(ctx, user, t, raw) {
  const title = String(raw || '').replace(/\s+/g, ' ').replace(/^[«"]|[»"]$/gu, '').trim().slice(0, 200);
  if (!title) return { error: 'Название не может быть пустым 🙂' };
  if (t.parent) return { error: 'Это общая задача — название меняет её автор' };
  if (title === t.title) return { same: true };
  const old = t.title;
  t.title = title;
  await saveTask(ctx, t); touch(ctx, t);
  notifyOthers(ctx, t, user.id, `✏️ <b>${esc(user.name)}</b> переименовал(а) задачу «${esc(short(old, 80))}»\n\n`);
  return { old };
}
async function titleReply(ctx, user, t, text) {
  const r = await renameTask(ctx, user, t, text);
  if (r.error) return send(ctx.env, user.id, r.error);
  return sendCard(ctx, user.id, t, r.same ? 'Название то же самое 👌\n\n' : `✏️ Название изменено (было: «${esc(short(r.old, 80))}»)\n\n`);
}
async function askTitleEdit(ctx, user, t) {
  if (t.parent) return send(ctx.env, user.id, 'Это общая задача — название меняет её автор.');
  user.data.awaiting = { kind: 'title', taskId: t.id, at: realNowMs(ctx.env) }; user.dirty = true;
  const rows = [];
  if (t.title.length <= 256) rows.push([{ text: '📋 Скопировать название', copy_text: { text: t.title } }]);
  rows.push([{ text: '✖ Отмена', callback_data: `a:${t.id}:tno` }]);
  return send(ctx.env, user.id, `✏️ <b>Новое название</b> для «${esc(short(t.title, 120))}» — напиши одним сообщением.\n<i>Можно скопировать текущее кнопкой ниже и поправить.</i>`, { reply_markup: { inline_keyboard: rows } });
}
// «название: …», «переименуй в …» ответом на карточку
const RE_TITLE = /^(?:(?:новое\s+)?название(?:\s+задачи)?\s*[:—–-]|переимену\p{L}*(?:\s+задачу)?\s+(?:в|на)\s+|назови(?:\s+задачу)?\s+)\s*(.+)$/iu;

// Редактор подробностей в чате: присылаем текст, его копируют, правят и присылают обратно
async function askDetailsEdit(ctx, user, t) {
  const cur = detailsText(t);
  const b = (text, act) => ({ text, callback_data: `a:${t.id}:${act}` });
  const rows = [];
  if (cur && cur.length <= 256) rows.push([{ text: '📋 Скопировать текст', copy_text: { text: cur } }]);
  if (ctx.origin) rows.push([{ text: '🗂 Изменить на доске', web_app: { url: `${ctx.origin}/app?t=${t.id}` } }]);
  rows.push([...(cur ? [b('🗑 Очистить всё', 'dclr')] : []), b('✖ Отмена', 'dno')]);
  if (cur.length > 3000) {
    return send(ctx.env, user.id, `✏️ Подробности задачи «<b>${esc(t.title)}</b>» слишком длинные, чтобы править их в чате. Открой задачу на доске — там всё редактируется в поле.`, { reply_markup: { inline_keyboard: rows } });
  }
  user.data.awaiting = { kind: 'details', taskId: t.id, at: realNowMs(ctx.env) }; user.dirty = true;
  const how = cur
    ? `Нажми на текст ниже — он скопируется. Вставь в поле ввода, поправь и пришли мне <b>целиком</b> — я заменю им подробности.\n<i>Строки с «-» — чек-лист, «- ✓» — отмеченный пункт.</i>\n\n<pre>${esc(cur)}</pre>`
    : 'Подробностей пока нет — напиши их одним сообщением.\n<i>Строки с «-» станут чек-листом.</i>';
  return send(ctx.env, user.id, `✏️ <b>Подробности: «${esc(short(t.title, 80))}»</b>\n\n${how}`, { reply_markup: { inline_keyboard: rows } });
}

// ── Подробности и чек-лист: убрать целиком или по строке ──
// строки подробностей (одна заметка может быть списком через перенос строки)
function noteLines(t) {
  const out = [];
  (t.notes || []).forEach((n, i) => String(n.text).split('\n').forEach((l, j) => { if (l.trim()) out.push({ i, j, text: l.trim() }); }));
  return out;
}
const lineKey = l => hashKey(l.text).slice(0, 4);
function removeNoteLine(t, i, j) {
  const n = t.notes[i];
  const lines = String(n.text).split('\n');
  lines.splice(j, 1);
  if (lines.some(l => l.trim())) t.notes[i] = { ...n, text: lines.join('\n') };
  else t.notes.splice(i, 1);
}
// перед удалением запоминаем, чтобы можно было вернуть одной кнопкой
function rememberDetails(ctx, uid, t) {
  const u = ctx.users.get(uid);
  // копия, а не ссылка: удаление строки меняет сам список
  if (u) { u.data.undoDetails = JSON.parse(JSON.stringify({ id: t.id, notes: t.notes || [], checklist: t.checklist || [] })); u.dirty = true; }
}
const DETAILS_RE = '(?:детали|подробности|заметки|заметку|описание|комментари[ийя]|примечани[яе])';
const CLEAR_VERB = '(?:убери(?:те)?|удали(?:те)?|очисти(?:те)?|сотри(?:те)?|убрать|удалить|очистить|стереть)';
const RE_CLEAR_NOTES = new RegExp(`^${CLEAR_VERB}(?:\\s+вс[её])?\\s+${DETAILS_RE}[.!]*$`, 'iu');
const RE_CLEAR_CHECK = new RegExp(`^${CLEAR_VERB}(?:\\s+весь)?\\s+(?:чек-?лист|пункты|все\\s+пункты)[.!]*$`, 'iu');
const RE_REMOVE_LINE = new RegExp(`^(?:${CLEAR_VERB}|вычеркни|вычеркнуть)\\s+(?:из\\s+(?:деталей|подробностей|заметок|чек-?листа|списка)\\s+)?[«"]?(.+?)[»"]?[.!]*$`, 'iu');

// Ответ на карточку «убери детали», «удали чек-лист», «убери Альфа Политех». true — обработано
async function editDetailsByText(ctx, user, t, text) {
  const line = text.trim();
  if (line.includes('\n') || line.length > 150) return false;
  const uid = user.id;
  const reply = async (prefix, mode = 'normal') => {
    await saveTask(ctx, t); touch(ctx, t);
    const r = await send(ctx.env, uid, prefix + renderCard(ctx, t), { reply_markup: mode === 'undo'
      ? { inline_keyboard: [[{ text: '↩️ Вернуть как было', callback_data: `a:${t.id}:nrest` }], ...cardKeyboard(ctx, t, uid).inline_keyboard] }
      : cardKeyboard(ctx, t, uid, mode) });
    if (r.ok) await rememberMsg(ctx, uid, r.result.message_id, t.id);
    return true;
  };
  if (RE_CLEAR_NOTES.test(line)) {
    if (!(t.notes || []).length) return reply('Подробностей и так нет 🙂\n\n');
    rememberDetails(ctx, uid, t);
    t.notes = [];
    return reply('🗑 Подробности удалены\n\n', 'undo');
  }
  if (RE_CLEAR_CHECK.test(line)) {
    if (!(t.checklist || []).length) return reply('Чек-листа и так нет 🙂\n\n');
    rememberDetails(ctx, uid, t);
    t.checklist = [];
    return reply('🗑 Чек-лист удалён\n\n', 'undo');
  }
  const m = line.match(RE_REMOVE_LINE);
  if (!m) return false;
  const q = normWord(m[1]).trim();
  if (!q || /^(?:задачу|задача|е[её]|это|эту|его|все|всё)$/u.test(q)) return false;
  const notes = noteLines(t).filter(l => normWord(l.text).includes(q));
  const checks = (t.checklist || []).map((c, i) => ({ i, text: c.text })).filter(c => normWord(c.text).includes(q));
  if (notes.length + checks.length === 0) return false; // не про эту карточку — пусть ищет задачу
  if (notes.length + checks.length > 1) return reply(`Нашёл несколько строк с «${esc(m[1])}» — нажми ту, что убрать 👇\n\n`, 'notes');
  rememberDetails(ctx, uid, t);
  if (notes.length) removeNoteLine(t, notes[0].i, notes[0].j);
  else t.checklist = t.checklist.filter((_, i) => i !== checks[0].i);
  return reply(`🗑 Убрал: «${esc(short((notes[0] || checks[0]).text, 80))}»\n\n`, 'undo');
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
    if (p.ambig) t.ambig = p.ambig;
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

// ── Команды словами: «удали задачу позвонить», «сделала отчёт», «перенеси звонок на завтра» ──

const SEP = '(?:\\s*[:,—–-]\\s*|\\s+|$)';
const INTENTS = [
  ['del', new RegExp(`^(?:удали(?:те)?|отмени(?:те)?|убери(?:те)?|сотри|(?:удалить|отменить|убрать)\\s+задачу)(?:\\s+задачу)?${SEP}(.*)$`, 'isu')],
  ['done', new RegExp(`^(?:готово|сделано|сделал[аи]?|выполнено|выполнил[аи]?|закрой(?:те)?|отметь(?:те)?|(?:закрыть|отметить)\\s+задачу)(?:\\s+задачу)?${SEP}(.*)$`, 'isu')],
  ['move', new RegExp(`^(?:перенеси(?:те)?|сдвинь|передвинь|перенести\\s+задачу)(?:\\s+задачу)?${SEP}(.*)$`, 'isu')],
];

function parseIntent(text) {
  const line = text.trim();
  if (line.includes('\n') || line.length > 200) return null;
  for (const [act, re] of INTENTS) {
    const m = line.match(re);
    if (m) return { act, rest: m[1].replace(/^[«"']|[»"'.!?]+$/gu, '').trim() };
  }
  return null;
}

const normWord = s => s.toLowerCase().replace(/ё/g, 'е');
const STOP = new Set(['задачу', 'задача', 'задачи', 'про', 'для', 'это', 'эту', 'мне', 'что', 'надо', 'нужно', 'все', 'его', 'ее', 'по', 'на', 'в', 'и', 'с', 'к', 'у', 'о']);
function stemsOf(q) {
  return normWord(q).split(/[^\p{L}\d]+/u).filter(w => w && !STOP.has(w))
    .map(w => (w.length <= 4 ? w.slice(0, Math.max(2, w.length - 1)) : w.slice(0, Math.min(5, w.length - 2))));
}

// Ищем задачу по словам: «позвонить маме» найдёт «Позвонить маме насчёт дачи»
function matchTasks(tasks, query) {
  const idm = query.match(/^(?:#|\/t|№\s*)?(\d+)$/);
  if (idm) {
    const t = tasks.find(x => x.id === +idm[1]);
    return { full: t ? [t] : [], partial: [] };
  }
  const stems = stemsOf(query);
  if (!stems.length) return { full: [], partial: [] };
  const scored = tasks.map(t => {
    const words = normWord(t.title).split(/[^\p{L}\d]+/u);
    const hit = stems.filter(st => words.some(w => w.startsWith(st))).length;
    return { t, hit };
  }).filter(x => x.hit > 0);
  return {
    full: sortTasks(scored.filter(x => x.hit === stems.length).map(x => x.t)),
    partial: scored.filter(x => x.hit < stems.length).sort((a, b) => b.hit - a.hit).map(x => x.t),
  };
}

const INTENT_WORDS = {
  del: { ask: 'Какую задачу удалить?', verb: 'удалить' },
  done: { ask: 'Какую задачу отметить выполненной?', verb: 'отметить' },
  move: { ask: 'Какую задачу перенести?', verb: 'перенести' },
};

function pickKeyboard(tasks, withCreate) {
  const rows = tasks.slice(0, 8).map(t => [{ text: `${t.high ? '🔥 ' : ''}${short(t.title, 40)}`, callback_data: `k:${t.id}` }]);
  if (withCreate) rows.push([{ text: '➕ Нет, это новая задача', callback_data: 'k:new' }]);
  rows.push([{ text: '✖ Отмена', callback_data: 'k:no' }]);
  return { inline_keyboard: rows };
}

async function performIntent(ctx, user, act, t, due) {
  const env = ctx.env, uid = user.id, now = ctx.now;
  if (act === 'del') {
    if (t.owner !== uid) {
      return send(env, uid, `Эту задачу поставил(а) ${esc(nameOf(ctx, t.owner))} — удалить её может только автор. Отметить выполненной?`,
        { reply_markup: { inline_keyboard: [[{ text: '✅ Отметить выполненной', callback_data: `a:${t.id}:done` }]] } });
    }
    user.data.trash = { ...t }; user.dirty = true;
    await applyAction(ctx, t, 'delok', uid);
    return send(env, uid, `🗑 Удалено: <s>${esc(t.title)}</s>`,
      { reply_markup: { inline_keyboard: [[{ text: '↩️ Восстановить', callback_data: `r:${t.id}` }]] } });
  }
  if (act === 'done') {
    if (t.done) return send(env, uid, `«${esc(t.title)}» уже выполнена ✅`);
    const res = await applyAction(ctx, t, 'done', uid);
    return send(env, uid, `${res.toast}\n<s>${esc(t.title)}</s>`, {
      reply_markup: { inline_keyboard: [[{ text: '↩️ Ой, не выполнено', callback_data: t.repeat ? `a:${t.id}:rundo` : `a:${t.id}:undo` }]] },
    });
  }
  if (act === 'move') {
    setDue(t, { date: due.date, time: due.time || (t.repeat && t.due ? t.due.time : null) });
    if (t.done) { t.done = false; t.doneAt = null; }
    await saveTask(ctx, t); touch(ctx, t);
    notifyOthers(ctx, t, uid, `📅 <b>${esc(user.name)}</b>: срок теперь ${fmtDue(t.due, now)}\n\n`);
    return sendCard(ctx, uid, t, `📅 Перенесено на <b>${fmtDue(t.due, now)}</b>\n\n`);
  }
}

// true — сообщение было командой и обработано
async function handleIntent(ctx, user, intent, target, fullText) {
  const env = ctx.env, uid = user.id, now = ctx.now;
  const { act } = intent;
  let query = intent.rest;
  let due = null;
  if (act === 'move') {
    const p = parseTask(query, now);
    due = p.due;
    query = p.title.replace(/^(?:на|в|к)$/i, '');
    if (due && /^вс[её](?:\s+несделанное)?$/i.test(query)) {
      const { moved } = await bulkMove(ctx, user, due.date);
      await send(env, uid, moved.length ? bulkReport(ctx, moved, due.date) : 'Переносить нечего — всё сделано 🎉',
        moved.length ? { reply_markup: { inline_keyboard: [[{ text: '↩️ Вернуть как было', callback_data: 'E:undo' }]] } } : {});
      return true;
    }
    if (!due && p.bad) { await send(env, uid, badDateText(p.bad)); return true; }
    if (!due) {
      await send(env, uid, 'На когда перенести? Напиши, например: <code>перенеси звонок маме на завтра</code> или <code>перенеси отчёт на пятницу 15:00</code>');
      return true;
    }
  }
  // ответ на карточку: «удали», «готово», «перенеси на завтра» — про эту задачу
  if (target && !query) { await performIntent(ctx, user, act, target, due); return true; }

  const all = await myOpenTasks(ctx, uid);
  const pool = act === 'del' ? all : all.filter(t => t.assignee === uid || t.owner === uid);
  user.data.pending = { act, due, text: fullText }; user.dirty = true;

  if (!query) {
    if (!pool.length) { await send(env, uid, 'Открытых задач нет 🎉'); return true; }
    await send(env, uid, INTENT_WORDS[act].ask, { reply_markup: pickKeyboard(sortTasks(pool), false) });
    return true;
  }
  const { full, partial } = matchTasks(pool, query);
  if (full.length === 1) { await performIntent(ctx, user, act, full[0], due); return true; }
  if (full.length > 1) {
    await send(env, uid, `Нашёл несколько похожих. ${INTENT_WORDS[act].ask}`, { reply_markup: pickKeyboard(full, false) });
    return true;
  }
  if (partial.length) {
    await send(env, uid, `Точно такой задачи нет. Может, одна из этих?`, { reply_markup: pickKeyboard(partial, true) });
    return true;
  }
  // ничего похожего — возможно, это вообще новая задача («Отменить подписку»)
  await send(env, uid, `Не нашёл задачу «${esc(query)}».`, {
    reply_markup: { inline_keyboard: [[{ text: '➕ Создать такую задачу', callback_data: 'k:new' }], [{ text: '📋 Показать все задачи', callback_data: 'k:list' }]] },
  });
  return true;
}

async function restoreTask(ctx, user, id) {
  const tr = user.data.trash;
  if (!tr || tr.id !== id) return send(ctx.env, user.id, 'Восстановить уже не получится 😕');
  // общая задача возвращается обычной: копии у исполнителей уже удалены, связь не восстановить
  delete tr.group; delete tr.parent;
  await DB(ctx).prepare('INSERT OR IGNORE INTO tasks (id, owner_id, project_id, assignee_id, done, done_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(tr.id, tr.owner, tr.project ?? null, tr.assignee, tr.done ? 1 : 0, tr.doneAt ?? null, taskData(tr)).run();
  delete user.data.trash; user.dirty = true;
  touch(ctx, tr);
  return sendCard(ctx, user.id, tr, '↩️ Восстановлено\n\n');
}

// ── Проекты: кнопки, создание по шагам, приглашение ──

// Постоянные кнопки внизу чата
const KB_VERSION = 6; // увеличить, если меню внизу поменялось, — бот сам пришлёт новое
function mainKeyboard(ctx) {
  // Доска — обычной кнопкой: с кнопки нижнего меню Telegram не сообщает доске, кто её открыл,
  // поэтому бот отвечает сообщением с кнопкой, которая открывает доску правильно
  const board = { text: '🗂 Доска' };
  return {
    keyboard: [
      // две строки по три — меню занимает меньше места; новый проект создаётся в «📁 Проекты»
      [{ text: '📋 Задачи' }, { text: '⭐ Главное' }, { text: '📅 Встречи' }],
      [{ text: '📁 Проекты' }, board, { text: '❓ Помощь' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'Напиши задачу…',
  };
}
const MAIN_BUTTONS = {
  '📋 Задачи': '/list', '⭐ Главное': '/focus',
  // старые подписи — у кого меню ещё прежнее
  '📋 Мои задачи': '/list', '📁 Проекты': '/projects', '⭐ Главное на сегодня': '/focus',
  '➕ Новый проект': '/newproject', '🗂 Доска': '/board', '📅 Встречи': '/meetings', '📅 Сегодня': '/today', '❓ Помощь': '/help',
};

const tagOf = p => p.name.replace(/\s+/g, '_');

async function inviteMarkup(ctx, p) {
  const link = await inviteLink(ctx, p);
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(`Присоединяйся к проекту «${p.name}» — будем ставить друг другу задачи`)}`;
  return { link, keyboard: [{ text: '👥 Позвать людей', url: share }] };
}

async function sendProjects(ctx, user) {
  const uid = user.id;
  const ps = myProjects(ctx, uid);
  const rows = [];
  let s;
  if (!ps.length) {
    s = '📁 <b>Проекты</b>\n\nПроект — это общая папка задач. Например «Работа»: туда можно позвать руководителя и коллег и ставить друг другу задачи. У каждого они появятся в его списке рядом с личными.\n\nПроектов пока нет — создай первый 👇';
  } else {
    const counts = await queryTasks(ctx, `done = 0 AND project_id IN (${ps.map(() => '?').join(',')})`, ...ps.map(p => p.id));
    s = '📁 <b>Твои проекты</b>\n\n' + ps.map(p => projectLine(ctx, p, counts.filter(t => t.project === p.id).length)).join('\n') +
      '\n\n<i>Нажми на проект — увидишь его задачи и кнопки «Позвать людей», «Переименовать» и «Удалить проект».</i>';
    for (const p of ps) {
      rows.push([{ text: `📁 ${short(p.name, 26)}`, callback_data: `P:v${p.id}` }, { text: '👥 Позвать', callback_data: `P:i${p.id}` }]);
    }
  }
  rows.push([{ text: '➕ Создать проект', callback_data: 'P:new' }]);
  return send(ctx.env, uid, s, { reply_markup: { inline_keyboard: rows } });
}

async function askProjectName(ctx, user, taskId = null) {
  user.data.awaiting = { kind: 'pname', taskId, at: realNowMs(ctx.env) };
  user.dirty = true;
  return send(ctx.env, user.id, '📁 <b>Как назвать проект?</b>\n\nНапиши название одним сообщением, например: <code>Работа</code>',
    { reply_markup: { inline_keyboard: [[{ text: '✖ Отмена', callback_data: 'P:cancel' }]] } });
}

async function createProjectFlow(ctx, user, rawName, taskId = null) {
  const uid = user.id;
  const name = rawName.replace(/^[#«"\s]+|[»".\s]+$/gu, '').trim().slice(0, 40);
  if (!name) return send(ctx.env, uid, 'Название пустое 🙂 Напиши, например: <code>Работа</code>');
  let p = findProject(ctx, uid, name);
  const existed = !!p;
  if (!p) p = await createProject(ctx, uid, name);
  if (taskId) {
    const t = await getTask(ctx, taskId);
    if (t && t.owner === uid) {
      t.project = p.id;
      if (!p.members.has(t.assignee)) t.assignee = t.owner;
      await saveTask(ctx, t); touch(ctx, t);
    }
  }
  const inv = await inviteMarkup(ctx, p);
  const s = `📁 Проект «<b>${esc(p.name)}</b>» ${existed ? 'уже есть' : 'создан'}!` + (taskId ? '\nЗадача перенесена в него.' : '') + `

<b>Как добавлять задачи в проект:</b>
• напиши задачу как обычно и нажми под ней <b>📁 ${esc(p.name)}</b>
• или начни с названия: <code>${esc(p.name)}: отчёт до пятницы</code>

<b>Работать вместе:</b> нажми «👥 Позвать людей» и выбери в Telegram, кому отправить приглашение (например, руководителю). Когда человек нажмёт «Старт», я напишу тебе — и под задачами проекта появятся кнопки с его именем.`;
  return send(ctx.env, uid, s, { reply_markup: { inline_keyboard: [inv.keyboard, [{ text: '📋 Задачи проекта', callback_data: `P:v${p.id}` }]] } });
}

async function sendInvite(ctx, user, p) {
  const inv = await inviteMarkup(ctx, p);
  return send(ctx.env, user.id, `🔗 <b>Приглашение в проект «${esc(p.name)}»</b>

Нажми «👥 Позвать людей» и выбери человека — Telegram отправит ему ссылку. Он откроет её и нажмёт «Старт».

Или скопируй ссылку и отправь как удобно:
${inv.link}`, { reply_markup: { inline_keyboard: [inv.keyboard] } });
}

// «создай проект Работа», «новый проект»
const NEW_PROJECT_RE = /^(?:созда(?:й|ть)|нов(?:ый|ая)|добав(?:ь|ить))\s+(?:новый\s+)?проект(?:\s*[:—–-]?\s*(.*))?$/iu;

// ── Календарь (Яндекс и любой другой с экспортом ICS) ──

// Короткий стабильный ключ встречи (для кнопок: данные кнопки ≤ 64 байт)
function hashKey(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

// Смещение часового пояса tz от UTC в минутах для момента utcMs
function tzOffsetMin(tz, utcMs) {
  const p = {};
  for (const x of fmtFor(tz).formatToParts(new Date(utcMs))) p[x.type] = x.value;
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs) / 60e3);
}

// «Настенное» время в поясе tz → момент UTC (мс)
function wallToUtc(date, time, tz) {
  const guess = Date.parse(`${date}T${time}:00Z`);
  let off = tzOffsetMin(tz, guess);
  let utc = guess - off * 60e3;
  const off2 = tzOffsetMin(tz, utc);
  if (off2 !== off) utc = guess - off2 * 60e3;
  return utc;
}

const validTz = tz => { try { fmtFor(tz); return true; } catch { return false; } };

const icsUnescape = s => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

// DTSTART/DTEND → { date, time | null, tz }
function icsWhen(value, params, defTz) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return { date, time: null, tz: defTz, allDay: true };
  const time = `${m[4]}:${m[5]}`;
  if (m[7]) return { date, time, tz: 'UTC' };
  const tz = params.TZID && validTz(params.TZID) ? params.TZID : defTz;
  return { date, time, tz };
}

// Перевести время из пояса события в пояс бота
function toBotTz(w, botTz) {
  if (!w.time) return { date: w.date, time: null };
  if (w.tz === botTz) return { date: w.date, time: w.time };
  const utc = wallToUtc(w.date, w.time, w.tz);
  return localNow(botTz, new Date(utc));
}

const ICS_WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Даты повторяющегося события (RRULE) в диапазоне [fromDate, toDate]
function expandDates(startDate, rule, fromDate, toDate) {
  const out = [];
  const interval = Math.max(1, +(rule.INTERVAL || 1));
  const count = rule.COUNT ? +rule.COUNT : Infinity;
  const until = rule.UNTIL ? `${rule.UNTIL.slice(0, 4)}-${rule.UNTIL.slice(4, 6)}-${rule.UNTIL.slice(6, 8)}` : null;
  const byday = rule.BYDAY ? rule.BYDAY.split(',').filter(Boolean) : null;
  const bymd = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number).filter(Boolean) : null;
  let n = 0;
  // false — дальше не идём
  const push = d => {
    if (d < startDate) return true;
    if (until && d > until) return false;
    n++;
    if (n > count) return false;
    if (d > toDate) return false;
    if (d >= fromDate) out.push(d);
    return true;
  };
  const skipAhead = (span) => (count === Infinity && fromDate > startDate ? Math.max(0, Math.floor(daysBetween(startDate, fromDate) / span) - 1) : 0);
  if (rule.FREQ === 'DAILY') {
    for (let k = skipAhead(interval); k < 5000; k++) {
      const d = addDays(startDate, k * interval);
      if (byday && !byday.some(x => ICS_WD[x.slice(-2)] === weekday(d))) { if (d > toDate) break; continue; }
      if (!push(d)) break;
    }
  } else if (rule.FREQ === 'WEEKLY') {
    const base = weekStart(startDate);
    const days = (byday ? byday.map(x => ICS_WD[x.slice(-2)]) : [weekday(startDate)]).filter(x => x !== undefined)
      .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    outer: for (let k = skipAhead(7 * interval); k < 3000; k++) {
      const ws = addDays(base, 7 * k * interval);
      for (const wd of days) if (!push(addDays(ws, (wd + 6) % 7))) break outer;
    }
  } else if (rule.FREQ === 'MONTHLY') {
    outer: for (let k = 0; k < 1200; k++) {
      const first = addMonths(startDate.slice(0, 8) + '01', k * interval);
      const last = withMonthDay(first, 31);
      let cands = [];
      if (byday && byday.some(x => /^[+-]?\d/.test(x))) {
        for (const x of byday) {
          const ord = parseInt(x, 10), wd = ICS_WD[x.slice(-2)];
          if (wd === undefined || !ord || ord > 4 || ord < -1) continue;
          cands.push(nthWeekdayOf(first, ord, wd));
        }
      } else if (bymd) {
        for (const md of bymd) {
          const day = md > 0 ? md : +last.slice(8) + md + 1;
          if (day >= 1 && day <= +last.slice(8)) cands.push(withMonthDay(first, day));
        }
      } else {
        const day = +startDate.slice(8);
        if (day <= +last.slice(8)) cands.push(withMonthDay(first, day));
      }
      cands = [...new Set(cands)].sort();
      for (const d of cands) if (!push(d)) break outer;
      if (first > toDate) break;
    }
  } else if (rule.FREQ === 'YEARLY') {
    for (let k = 0; k < 200; k++) {
      const d = `${+startDate.slice(0, 4) + k * interval}${startDate.slice(4)}`;
      if (!validDate(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8))) continue;
      if (!push(d)) break;
    }
  } else push(startDate);
  return out;
}

// Разобрать ICS → встречи в поясе бота в диапазоне дат
function parseIcs(text, botTz, fromDate, toDate) {
  const body = text.replace(/\r?\n[ \t]/g, '');
  const chunks = body.split('BEGIN:VEVENT').slice(1).map(c => c.split('END:VEVENT')[0]);
  const fromKey = fromDate.replace(/-/g, '');
  const raw = [];
  for (const chunk of chunks) {
    // быстрый отсев старых разовых встреч — экспорт содержит всю историю
    const ds = chunk.match(/\nDTSTART[^:\n]*:(\d{8})/);
    if (ds && ds[1] < fromKey && !/\nRRULE:/.test(chunk) && !/\nRECURRENCE-ID/.test(chunk)) continue;
    const ev = { exdates: [] };
    for (const line of chunk.split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const [name, ...ps] = line.slice(0, i).split(';');
      const value = line.slice(i + 1);
      const params = Object.fromEntries(ps.map(p => p.split('=')).map(([k, v]) => [k.toUpperCase(), (v || '').replace(/^"|"$/g, '')]));
      const key = name.toUpperCase();
      if (key === 'UID') ev.uid = value.trim();
      else if (key === 'SUMMARY') ev.title = icsUnescape(value).trim();
      else if (key === 'DTSTART') ev.start = icsWhen(value.trim(), params, botTz);
      else if (key === 'DTEND') ev.end = icsWhen(value.trim(), params, botTz);
      else if (key === 'DURATION') ev.duration = value.trim();
      else if (key === 'RRULE') ev.rrule = Object.fromEntries(value.trim().split(';').map(x => x.split('=')));
      else if (key === 'EXDATE') for (const v of value.split(',')) { const w = icsWhen(v.trim(), params, botTz); if (w) ev.exdates.push(w); }
      else if (key === 'RECURRENCE-ID') ev.recurId = icsWhen(value.trim(), params, botTz);
      else if (key === 'STATUS') ev.status = value.trim().toUpperCase();
      else if (key === 'LOCATION') ev.location = icsUnescape(value).trim();
      else if (key === 'URL') ev.url = value.trim();
      else if (key === 'DESCRIPTION') ev.description = icsUnescape(value);
    }
    if (ev.start) raw.push(ev);
  }
  // перенесённые и отменённые экземпляры повторяющихся встреч
  const overridden = new Set();
  for (const ev of raw) if (ev.recurId && ev.uid) overridden.add(`${ev.uid}|${ev.recurId.date} ${ev.recurId.time || ''}`);

  const out = [];
  const durMin = ev => {
    if (ev.end && ev.end.time && ev.start.time) {
      return Math.round((wallToUtc(ev.end.date, ev.end.time, ev.end.tz) - wallToUtc(ev.start.date, ev.start.time, ev.start.tz)) / 60e3);
    }
    const m = (ev.duration || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
    return m ? (+(m[1] || 0)) * 1440 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
  };
  const linkOf = ev => {
    for (const s of [ev.url, ev.location, ev.description]) {
      const m = (s || '').match(/https?:\/\/[^\s"<>\\]+/);
      if (m) return m[0];
    }
    return null;
  };
  for (const ev of raw) {
    if (ev.status === 'CANCELLED') continue;
    const dur = durMin(ev);
    const link = linkOf(ev);
    const loc = ev.location && !/^https?:\/\//.test(ev.location) ? ev.location : null;
    const dates = ev.rrule && !ev.recurId
      ? expandDates(ev.start.date, ev.rrule, addDays(fromDate, -1), addDays(toDate, 1))
      : [ev.start.date];
    const ex = new Set(ev.exdates.map(w => `${w.date} ${w.time || ''}`));
    for (const d of dates) {
      const wall = { date: d, time: ev.start.time, tz: ev.start.tz };
      if (ev.rrule && !ev.recurId) {
        if (ex.has(`${d} ${ev.start.time || ''}`) || ex.has(`${d} `)) continue;
        if (overridden.has(`${ev.uid}|${d} ${ev.start.time || ''}`)) continue;
      }
      const s = toBotTz(wall, botTz);
      if (s.date < fromDate || s.date > toDate) continue;
      let e = null;
      if (s.time) e = fromStamp(stamp(s.date, s.time) + dur * 60e3);
      out.push({
        uid: ev.uid || hashKey(ev.title + d), title: ev.title || 'Без названия', start: s, end: e,
        link, loc, recur: !!(ev.rrule || ev.recurId),
      });
    }
  }
  return out.sort((a, b) => (a.start.date + (a.start.time || '')).localeCompare(b.start.date + (b.start.time || '')));
}

// ── Хранение встреч и работа с ними ──

const evKey = e => hashKey(`${e.uid}|${e.start.date} ${e.start.time || ''}`);
const rowToEvent = r => ({
  h: r.h, uid: r.uid, title: r.title, link: r.link, loc: r.loc, recur: !!r.recur,
  start: { date: r.start.slice(0, 10), time: r.start.slice(11) || null },
  end: r.end ? { date: r.end.slice(0, 10), time: r.end.slice(11) || null } : null,
});
const whenStr = w => `${w.date} ${w.time || ''}`.trim();

async function refreshUserCalendar(ctx, user, at = new Date(realNowMs(ctx.env))) {
  const cal = user.data.cal;
  if (!cal || !cal.url) return { error: 'не подключён' };
  if (ctx.env._use) ctx.env._use.tg++;
  cal.last = at.getTime(); user.dirty = true;
  let text;
  try {
    const r = await fetch(cal.url, { headers: { 'user-agent': 'tasks-bot' } });
    if (r.status && r.status >= 400) throw new Error('HTTP ' + r.status);
    text = await r.text();
  } catch (e) {
    cal.err = String(e && e.message || e);
    return { error: cal.err };
  }
  if (!/BEGIN:VCALENDAR/.test(text || '')) { cal.err = 'по ссылке не календарь'; return { error: cal.err }; }
  const now = ctx.now;
  // 5 недель вперёд: чтобы у встреч раз в 2 недели и раз в месяц была видна «следующая»
  const events = parseIcs(text, tz(ctx.env), addDays(now.date, -1), addDays(now.date, 35));
  delete cal.err;
  cal.count = events.length;
  for (const e of events) e.h = evKey(e);
  // календарь почти всегда тот же — переписываем встречи в базе, только если что-то поменялось
  // (иначе каждые 15 минут уходят сотни записей, а их на бесплатном тарифе 100 000 в сутки)
  const sig = hashKey(events.slice(0, 300).map(e => [e.h, whenStr(e.start), e.end ? whenStr(e.end) : '', e.title, e.link, e.loc, e.recur ? 1 : 0].join('|')).join('\n'));
  if (cal.sig === sig) return { count: events.length, events };
  cal.sig = sig;
  const stmts = [ctx.env.DB.prepare('DELETE FROM events WHERE user_id = ?').bind(user.id)];
  for (const e of events.slice(0, 300)) {
    stmts.push(ctx.env.DB.prepare('INSERT OR REPLACE INTO events (user_id, h, uid, start, end, title, link, loc, recur) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(user.id, evKey(e), e.uid, whenStr(e.start), e.end ? whenStr(e.end) : null, e.title.slice(0, 200), e.link, e.loc, e.recur ? 1 : 0));
  }
  await ctx.env.DB.batch(stmts);
  return { count: events.length, events };
}

async function userEvents(ctx, uid, fromDate, toDate) {
  const { results } = await DB(ctx).prepare('SELECT * FROM events WHERE user_id = ? AND start >= ? AND start <= ? ORDER BY start')
    .bind(uid, fromDate, toDate + ' 99').all();
  return results.map(rowToEvent);
}

async function eventByKey(ctx, uid, h) {
  const r = await DB(ctx).prepare('SELECT * FROM events WHERE user_id = ? AND h = ?').bind(uid, h).first();
  return r ? rowToEvent(r) : null;
}

async function nextOfSeries(ctx, uid, e) {
  const r = await DB(ctx).prepare('SELECT * FROM events WHERE user_id = ? AND uid = ? AND start > ? ORDER BY start LIMIT 1')
    .bind(uid, e.uid, whenStr(e.start)).first();
  return r ? rowToEvent(r) : null;
}

const fmtMeetingWhen = (e, now) => `${fmtDate(e.start.date, now)}${e.start.time ? ' ' + e.start.time : ''}`;
// задача-«подготовка» (создана кнопкой 📝) — в отличие от просто привязанных к встрече задач
const isPrep = t => !!(t.meeting && (t.meeting.prep || /^Подготовить: /.test(t.title)));
// задачи человека, привязанные к этой встрече
const tasksOfMeeting = (open, uid, h) => open.filter(t => t.meeting && t.meeting.h === h && t.assignee === uid && !t.done);

// Привязать задачу к встрече. Срок — до начала встречи, если его не было или он позже
function linkToMeeting(t, e, now) {
  t.meeting = { h: e.h, uid: e.uid, title: e.title, start: e.start };
  const ms = stamp(e.start.date, e.start.time || '00:00');
  const moved = !t.due || stamp(t.due.date, t.due.time || '23:59') > ms;
  if (moved) setDue(t, { date: e.start.date, time: e.start.time || null });
  return `🗓 К встрече «${short(e.title, 60)}» ${fmtMeetingWhen(e, now)}${moved ? ' — срок до её начала' : ''}`;
}

function meetingLine(e, now, preps, withDay = false) {
  const linked = preps.filter(t => t.meeting && t.meeting.h === e.h);
  const when = withDay ? fmtMeetingWhen(e, now) : (e.start.time || 'весь день');
  let s = `• ${when} — ${esc(e.title)}`;
  for (const t of linked.slice(0, 3)) {
    s += isPrep(t) ? ` <i>📝 ${checkProgress(t) || 'подготовка'}</i> /t${t.id}` : `
   <i>📎 ${esc(short(t.title, 40))}</i> /t${t.id}`;
  }
  if (linked.length > 3) s += `
   <i>… и ещё ${linked.length - 3}</i>`;
  return s;
}

// Список встреч с кнопками «подготовить»
function meetingsMessage(ctx, events, preps, title) {
  const now = ctx.now;
  const timed = events.filter(e => e.start.time);
  if (!events.length) return { text: `${title}\n\nВстреч нет 🎉`, keyboard: null };
  let s = title + '\n';
  let day = null;
  for (const e of events) {
    if (e.start.date !== day) { day = e.start.date; s += `\n<b>${fmtDate(day, now)}${daysBetween(now.date, day) > 1 ? '' : ''}</b>\n`; }
    s += meetingLine(e, now, preps) + '\n';
  }
  s += '\n<i>Нажми на встречу — напишешь, что к ней подготовить, или добавишь к ней уже записанную задачу.</i>';
  const rows = [];
  const btns = timed.filter(e => stamp(e.start.date, e.start.time) > stamp(now.date, now.time)).slice(0, 16)
    .map(e => ({ text: `📝 ${WD_SHORT[weekday(e.start.date)]} ${e.start.time} ${short(e.title, 18)}`, callback_data: `M:p:${e.h}` }));
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  return { text: clip(s), keyboard: rows.length ? { inline_keyboard: rows } : null };
}

const CAL_HELP = `📅 <b>Встречи из Яндекс Календаря</b>

Я буду:
• напоминать о встрече за час, за 15 минут и в момент начала (со ссылкой на звонок);
• по понедельникам присылать встречи недели — выбираешь встречу и пишешь, что к ней подготовить, это станет задачей;
• после регулярной встречи спрашивать, что сделать к следующей.

<b>Как подключить (2 минуты, лучше с компьютера):</b>
1. Открой <b>calendar.yandex.ru</b> в браузере.
2. В списке календарей слева наведи курсор на название своего календаря — появится значок ⚙️. Нажми его.
3. В открывшихся настройках перейди на вкладку <b>«Экспорт»</b>.
4. Выбери формат <b>iCal</b> и скопируй ссылку (кнопка «Скопировать» рядом с ней).
5. Пришли эту ссылку мне обычным сообщением — я сразу удалю его из чата, чтобы ссылка не лежала в переписке.

Ссылка iCal есть только у владельца календаря. Если календарей несколько (рабочий и личный) — подключи тот, где встречи.

Я только читаю календарь: ничего в нём не меняю.`;

async function connectCalendar(ctx, user, url, msg) {
  const env = ctx.env, uid = user.id;
  if (msg) await tg(env, 'deleteMessage', { chat_id: uid, message_id: msg.message_id }); // ссылка — как пароль, не храним в чате
  if (!/^https:\/\/\S+$/i.test(url)) return send(env, uid, 'Это не похоже на ссылку календаря. Нужна ссылка, которая начинается с https://');
  user.data.cal = { url, last: 0 }; user.dirty = true;
  const r = await refreshUserCalendar(ctx, user);
  if (r.error) {
    delete user.data.cal;
    return send(env, uid, `😕 Не получилось прочитать календарь: ${esc(r.error)}.\n\nПроверь, что это ссылка из «Экспорт» → iCal, и пришли её ещё раз.`);
  }
  const week = r.events.filter(e => e.start.date <= addDays(ctx.now.date, 7));
  const m = meetingsMessage(ctx, week, [], `✅ <b>Календарь подключён!</b> Встреч на ближайшие 7 дней: ${week.length}.`);
  return send(env, uid, m.text, m.keyboard ? { reply_markup: m.keyboard } : {});
}

async function sendMeetings(ctx, user, days = 7, title = null) {
  const now = ctx.now;
  if (!user.data.cal) return send(ctx.env, user.id, CAL_HELP);
  const evs = await userEvents(ctx, user.id, now.date, addDays(now.date, days));
  const preps = (await myOpenTasks(ctx, user.id)).filter(t => t.meeting);
  const m = meetingsMessage(ctx, evs.filter(e => !e.start.time || stamp(e.start.date, e.start.time) >= stamp(now.date, now.time) - 3600e3), preps,
    title || `📅 <b>Встречи на ${days} дней</b>`);
  const kb = m.keyboard || { inline_keyboard: [] };
  kb.inline_keyboard.push([{ text: '🔄 Обновить календарь', callback_data: 'M:r' }, { text: '🔌 Отключить', callback_data: 'M:off' }]);
  return send(ctx.env, user.id, m.text, { reply_markup: kb });
}

async function askPrep(ctx, user, e) {
  user.data.awaiting = { kind: 'prep', h: e.h, at: realNowMs(ctx.env) }; user.dirty = true;
  return send(ctx.env, user.id, `📝 Что подготовить к встрече «<b>${esc(e.title)}</b>» (${fmtMeetingWhen(e, ctx.now)})?\n\nНапиши одним сообщением, каждый пункт с новой строки:\n<code>- обновить цифры по продажам\n- подготовить вопросы по бюджету</code>`, {
    reply_markup: { inline_keyboard: [[{ text: '📎 Добавить уже записанную задачу', callback_data: `M:t:${e.h}` }], [{ text: '✖ Отмена', callback_data: 'M:x' }]] },
  });
}

// Выбор уже записанной задачи для встречи
async function pickTaskForMeeting(ctx, user, e, msg) {
  const open = (await myOpenTasks(ctx, user.id)).filter(t => !t.done && !(t.meeting && t.meeting.h === e.h));
  const list = sortTasks(open).slice(0, 10);
  const text = list.length
    ? `📎 Какую задачу добавить к встрече «<b>${esc(e.title)}</b>» (${fmtMeetingWhen(e, ctx.now)})?\n\n<i>Срок задачи станет «до начала встречи», если он был позже. В напоминании о встрече я покажу эту задачу.</i>`
    : 'Открытых задач нет — добавлять нечего 🙂';
  const rows = list.map(t => [{ text: `${t.high ? '🔥 ' : ''}${short(t.title, 30)}${t.due ? ' · ' + fmtDue(t.due, ctx.now) : ''}`, callback_data: `M:l:${e.h}:${t.id}` }]);
  rows.push([{ text: '✖ Отмена', callback_data: 'M:x' }]);
  const body = { chat_id: user.id, parse_mode: 'HTML', text, reply_markup: { inline_keyboard: rows } };
  return msg ? tg(ctx.env, 'editMessageText', { ...body, message_id: msg.message_id }) : send(ctx.env, user.id, text, { reply_markup: body.reply_markup });
}

// Подготовка к встрече → задача со сроком до начала и чек-листом
async function savePrep(ctx, user, h, text) {
  const now = ctx.now;
  const e = await eventByKey(ctx, user.id, h);
  if (!e) return send(ctx.env, user.id, 'Не нашёл эту встречу — возможно, она уже прошла или её убрали из календаря.');
  const items = text.split('\n').map(l => l.replace(/^\s*(?:[-–—•*]|\d+[.)]|\[\s?\]|☐)\s*/, '').trim()).filter(Boolean).map(x => ({ text: x, done: false }));
  if (!items.length) return send(ctx.env, user.id, 'Пусто 🙂 Напиши, что подготовить.');
  const open = await myOpenTasks(ctx, user.id);
  let t = open.find(x => x.meeting && x.meeting.h === h && isPrep(x));
  if (t) {
    t.checklist = [...(t.checklist || []), ...items];
    await saveTask(ctx, t); touch(ctx, t);
    return sendCard(ctx, user.id, t, `📝 Добавлено к подготовке: ${items.length}\n\n`);
  }
  t = {
    title: `Подготовить: ${e.title}`.slice(0, 150), notes: [], checklist: items,
    due: { date: e.start.date, time: e.start.time }, high: false, createdAt: now.date,
    rem: { at: stamp(now.date, now.time) }, owner: user.id, assignee: user.id, project: null, done: false, doneAt: null,
    meeting: { h, uid: e.uid, title: e.title, start: e.start, prep: true },
  };
  await insertTask(ctx, t); touch(ctx, t);
  return sendCard(ctx, user.id, t, '📝 Подготовка сохранена — напомню за час до начала встречи\n\n');
}

// После встречи: каждая строка — отдельная задача
async function saveAfter(ctx, user, h, title, text) {
  const lines = text.split('\n').map(l => l.replace(/^\s*(?:[-–—•*]|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, 15);
  const made = [];
  for (const line of lines) {
    const r = await createFromText(ctx, user, line, { silent: true });
    if (r.task) {
      r.task.notes = [...(r.task.notes || []), { at: ctx.now.date, by: user.id, text: `По итогам встречи «${title}»` }];
      await saveTask(ctx, r.task);
      made.push(r.task);
    }
  }
  if (!made.length) return send(ctx.env, user.id, 'Не нашёл задач в сообщении 🙂');
  return send(ctx.env, user.id, `✅ По итогам «${esc(title)}» записано задач: ${made.length}\n\n` +
    made.map(t => withId(ctx, user.id, `• ${esc(t.title)}${t.due ? ` <i>· ${fmtDue(t.due, ctx.now)}</i>` : ''}`, t.id)).join('\n'));
}

// ── Команды ──

// ── Справка: разделы с примерами (нажми на пример — он скопируется) ──

const HELP_ORDER = [
  ['start', '🚀 С чего начать'],
  ['add', '📝 Как записать задачу'],
  ['dates', '📅 Как указать срок'],
  ['details', '🗒 Подробности и чек-лист'],
  ['edit', '✏️ Удалить, отметить, перенести'],
  ['repeat', '🔁 Регулярные задачи'],
  ['day', '☀️ План дня и напоминания'],
  ['meet', '📅 Встречи из календаря'],
  ['projects', '📁 Проекты и руководитель'],
  ['board', '📋 Доска'],
  ['voice', '🎙 Голосовые'],
  ['commands', '⌨️ Все команды'],
];

const HELP_INTRO = `👋 <b>Я — твой список задач.</b>

Пиши мне задачи обычными сообщениями, как в «Избранное». Я запомню сроки, буду держать список наверху чата и сам напомню.

<b>Попробуй прямо сейчас:</b> нажми на серый текст ниже — он скопируется. Вставь его в поле ввода и отправь мне:

<code>Проверить бота завтра в 10:00</code>

Или выбери, о чём рассказать подробнее 👇`;

function helpSection(key, user, env = {}) {
  const sc = schedOf(env, user);
  const first = ((user && user.name) || 'Рина').split(/\s+/)[0];
  const me = user && user.username ? '@' + user.username : '@' + first;
  const S = {
    start: `🚀 <b>С чего начать — 3 шага</b>

<b>1. Запиши задачу.</b> Нажми на пример — он скопируется — и отправь мне:
<code>Проверить бота завтра в 10:00</code>

<b>2. Посмотри, что пришло.</b> Я пришлю <b>карточку задачи</b>. Под ней кнопки:
• <b>✅ Готово</b> — отметить выполненной
• <b>📅 Срок</b> — сегодня / завтра / +неделя / ✏️ своя дата / без срока, там же <b>▶️ Начать…</b> (когда приступить) и <b>🔁 Повтор</b>. После нажатия можно просто написать дату сообщением
• <b>☑ 0/3</b> — чек-лист (есть, только если в задаче есть пункты)
• <b>☰ Ещё</b> — повтор, проект, кому поручить, 🔥 важно, 🔔 не отстану, ⏳ жду ответа, 🏷 статус (в проектах), 📎 файлы, 🗑 удалить
В каждом меню есть «← Назад».

<b>3. Посмотри наверх чата.</b> Там закреплено сообщение «📌 Мои задачи» — это твой список. Он сам обновляется, листать ничего не нужно. Разовые задачи — по датам, регулярные (🔁) — отдельным блоком ниже.

<b>4. Меню внизу чата</b> — всегда под рукой:
📋 Задачи · ⭐ Главное · 📅 Встречи · 📁 Проекты · 🗂 Доска · ❓ Помощь
Если меню спряталось — нажми значок с квадратиками рядом с полем ввода или напиши /menu.

<b>Дальше я сам:</b>
• завтра в 9:00 пришлю план на день, и там будет эта задача;
• в 9:00 напомню «через час срок»;
• в 10:00 — «время пришло».

💡 Главное правило: <b>одно сообщение = одна задача</b>. Пиши как удобно, я сам найду в тексте дату и время.`,

    add: `📝 <b>Как записать задачу</b>

Просто напиши, что нужно сделать. Срок можно указать в любом месте текста.

<code>Купить подарок маме</code>
→ задача без срока, попадёт в «📥 Без срока»

<code>Отправить договор завтра</code>
→ срок: завтра

<code>Позвонить в банк в пятницу в 15:00</code>
→ срок: пятница 15:00, напомню за час и в 15:00

<code>Сдать отчёт 25.10 !!</code>
→ срок 25 октября, <b>!!</b> делает задачу важной 🔥 — она всегда выше остальных

<code>Срочно ответить Олегу</code>
→ слово «срочно» тоже делает задачу важной

<b>Несколько задач сразу?</b> Отправь их отдельными сообщениями — каждое станет своей задачей.

<b>Фото и файлы.</b> Пришли фото, скриншот или документ (можно с подписью) — это станет задачей с вложением. Альбом — одна задача. Файл в ответ на карточку — прикрепится к ней. Открыть: «☰ Ещё» → «📎 Файлы».

<b>Переслать из другого чата.</b> Написали в рабочем чате «сделай до пятницы»? Перешли это сообщение мне — оно станет задачей, а я запомню, от кого оно.

<b>Перенести старое из «Избранного».</b> Открой «Избранное» → зажми сообщение → «Выбрать» → отметь все нужные → «Переслать» → выбери меня.

<b>Передумал(а)?</b> Напиши <code>удали задачу купить подарок</code> — подробнее в разделе «✏️ Удалить, отметить, перенести».`,

    dates: `📅 <b>Как указать срок</b>

Пиши срок словами, как в жизни — прямо в тексте задачи:

<b>День</b>
<code>сегодня</code> · <code>завтра</code> · <code>послезавтра</code>
<code>в понедельник</code> · <code>до пятницы</code> · <code>в следующую среду</code>

<b>Дата</b>
<code>25.10</code> · <code>25.10.2027</code> · <code>12 октября</code> · <code>10 числа</code>

<b>Через сколько</b>
<code>через 3 дня</code> · <code>через 2 недели</code> · <code>через месяц</code>

<b>Неделя и месяц</b>
<code>на следующей неделе</code> (понедельник) · <code>в конце недели</code> (пятница)
<code>в конце месяца</code> · <code>в следующем месяце</code> (1-е число)

<b>Время</b> (можно добавить к любому дню)
<code>в 15:00</code> · <code>15.30</code> · <code>в 9.45</code> · <code>в 18</code> · <code>в 10 часов 30 минут</code>
<code>в 10 утра</code> · <code>в 7 вечера</code> · <code>утром</code> (9:00) · <code>к обеду</code> (13:00) · <code>вечером</code> (19:00)
<code>в 2</code>…<code>в 6</code> без «утра» — это день: <code>в 3</code> = 15:00. Ночью — <code>в 3 ночи</code>.
Через точку тоже можно. Если непонятно, дата это или время (например, <code>10.11</code>), — спрошу кнопками.
Опечатку в дате (<code>31 сентября</code>, <code>25:00</code>) не проглочу — скажу, что такой даты нет.

<b>Когда начать и дедлайн</b> — если задачу нужно начать заранее:
<code>Отчёт начать в среду, сдать в пятницу</code>
<code>Презентация начать завтра дедлайн 10.10</code>
→ в «Сегодня» задача появится в день начала, а дедлайн останется своим.

<b>Примеры целиком:</b>
<code>Записаться к стоматологу через 2 недели</code>
<code>Созвон с Машей в четверг в 11:00</code>
<code>Оплатить садик 10 числа</code>
<code>Выключить духовку в 18:30</code> — только время: сегодня, а если уже прошло — завтра

<b>Как поменять срок потом:</b>
• на карточке нажми <b>«📅 Срок»</b> → Сегодня / Завтра / +неделя — или просто <b>напиши дату сообщением</b>: <code>7 октября 15:00</code>;
• там же есть <b>«✏️ Своя дата»</b>;
• или <b>ответь</b> (reply) на карточку датой: <code>в понедельник в 12:00</code>;
• или словами: <code>перенеси отчёт на пятницу</code>.
Если напишешь только дату — я спрошу, к какой задаче её применить.`,

    details: `🗒 <b>Подробности и чек-лист</b>
(то самое «после собрания докинуть деталей»)

<b>Способ 1 — сразу, одним сообщением.</b>
Первая строка — задача. Следующие строки — подробности. Строки, которые начинаются с «-», станут чек-листом:

<code>Подготовить презентацию до пятницы
Итоги Q3, выступление 10 минут
- собрать цифры продаж
- попросить фото у Маши
- отправить Анне на проверку</code>

→ задача со сроком пятница, подробностями и чек-листом из 3 пунктов. На карточке появится кнопка «☑ 0/3» — нажми её, чтобы отмечать пункты.

<b>Способ 2 — потом, после собрания.</b>
1. Найди карточку задачи: пролистай чат или напиши /list и нажми на номер задачи, например /t5 — я пришлю карточку.
2. <b>Ответь на карточку</b>: на телефоне — смахни сообщение влево или зажми его и нажми «Ответить».
3. Напиши, что обсудили:

<code>Анна сказала: сократить до 7 слайдов
- добавить сравнение с прошлым годом</code>

→ текст добавится в подробности, строка с «-» — в чек-лист.

<b>Ответ датой переносит срок:</b> ответь на карточку <code>в понедельник</code> — и срок станет понедельник.

<b>Изменить название:</b> на карточке «☰ Ещё» → <b>«✏️ Название»</b> и пришли новое. Или ответь на карточку: <code>название: Сверить акты за сентябрь</code>

<b>Изменить подробности:</b> на карточке «☰ Ещё» → <b>«✏️ Подробности»</b>. Я пришлю текст — нажми на него, он скопируется. Вставь в поле ввода, поправь и пришли целиком: подробности заменятся. Передумала — «↩️ Вернуть как было».
На доске подробности и пункты чек-листа правятся прямо в карточке задачи.
Быстро ответом на карточку: <code>убери детали</code> · <code>удали чек-лист</code> · <code>убери Альфа Политех</code> (одна строка).

💡 Отвечать можно и голосовым — я расшифрую и допишу.`,

    edit: `✏️ <b>Удалить, отметить, перенести — словами</b>

Не нужно искать задачу в чате — просто напиши, что сделать. Достаточно пары слов из названия.

<b>Удалить / отменить</b>
<code>удали задачу позвонить маме</code>
<code>отмени созвон с банком</code>
→ если задача одна — удалю сразу (и дам кнопку «↩️ Восстановить»). Если похожих несколько — покажу список, выберешь нужную.

<b>Отметить выполненной</b>
<code>готово отчёт</code>
<code>сделано презентация</code>
<code>сделала звонок врачу</code>

<b>Перенести</b>
<code>перенеси отчёт на пятницу</code>
<code>перенеси звонок маме на завтра в 18:00</code>

<b>Не помнишь название?</b> Напиши просто <code>удали</code> или <code>готово</code> — я покажу список задач кнопками.

<b>Если отвечаешь на карточку задачи</b> — хватит одного слова: <code>готово</code>, <code>удали</code>, <code>перенеси на понедельник</code>.

💡 Можно и голосом: 🎤 «удали задачу про подарок».`,

    repeat: `🔁 <b>Регулярные задачи</b>

<b>Самый простой способ — кнопкой.</b>
1. Напиши задачу со сроком, например <code>Созвон с командой в четверг 11:00</code>
2. На карточке нажми <b>📅 Срок</b> (или <b>☰ Ещё</b>) → <b>🔁 Повтор</b> — появятся варианты:
• Каждый день · По будням
• Каждую неделю (чт) · Раз в 2 недели (чт)
• Каждый месяц (1 числа) · Каждый год
• 1-й рабочий день месяца · Последний рабочий день (с учётом праздников и переносов по производственному календарю)
День недели и число берутся из срока задачи. Нужен другой день — сначала поменяй срок.

<b>Нужно что-то особенное?</b> Там же нажми <b>⚙️ Настроить подробно</b> — откроется форма как в календаре:
• по дням / неделям / месяцам / годам;
• раз в сколько недель и в какие дни (можно отметить несколько: чт и пт);
• для месяца: какого числа, в первый/последний четверг, в последний день или в первый/последний рабочий день;
• «Сколько повторять»: всегда или до определённой даты.
Внизу видно, что получилось.

<b>Можно и текстом</b>, если удобно:
<code>Витамины каждый день в 9:00</code> · <code>Отчёт по пятницам</code> · <code>Аренда каждое 1 число</code> · <code>Отчёт в первый рабочий день месяца</code>

<b>Как работает:</b> нажимаешь ✅ Готово — задача переносится на следующий раз. Пропущенные разы не копятся. «📅 Срок» → «⏭ Пропустить раз» — перенести без отметки. Отменить повтор: ☰ Ещё → 🔁 Повтор → «Не повторять».
<b>Случайно нажато «Готово»?</b> Сразу на карточке будет «↩️ Отменить «Готово»» — вернёт прежний срок. Позже то же самое есть в ☰ Ещё.

Все регулярные задачи: /repeat`,

    day: `☀️ <b>План дня и напоминания</b>

Вот что я присылаю сам, без команд:

${sc.custom ? `🕘 <b>Твой график: ${sc.from}–${sc.to}${sc.workOnly ? ', пн–пт' : ''}.</b> Все времена ниже — по нему${sc.workOnly ? ', в выходные и праздники не беспокою' : ''}. Поменять: /schedule` : '🕘 <b>Настрой свой рабочий график</b> — /schedule, и я подстрою все времена под тебя: план — в начале дня, сверка — перед концом, в выходные не беспокою.'}
⚙️ Что из этого присылать и за сколько напоминать, 🤫 тихие часы (например, обед) и 🏖 отпуск — в <b>/settings</b> (или «❓ Помощь» → «⚙️ Мои настройки»). Отпуск можно и словами: <code>я в отпуске до 20.10</code>.

☀️ <b>${sc.morning === 'off' ? 'План на день (выключен в /settings)' : sc.morning + ' — план на день'}.</b> Что просрочено, что на сегодня, важное без срока. Там же — кнопки <b>«Выбери до 3 главных задач»</b>: нажми на 1–3 задачи и потом «Готово». Они встанут наверх списка с ⭐.

🧹 <b>Утром иногда</b> — одна задача, которая лежит без срока больше двух недель: «Ещё актуально?» Кнопки: сделать на этой неделе / ещё актуально / уже сделано / удалить. Так ничего не теряется внизу.

📍 <b>Задача на сегодня без времени</b> — напомню в ${sc.slots.join(' и ') || '(выключено)'}.

⏰ <b>Если у задачи есть время</b> — напомню за час и в срок. На напоминании есть кнопки <b>🔔 +1 час</b> и <b>🔔 Завтра</b> — если сейчас не до этого, нажми, и я напомню снова.

🌙 <b>${sc.evening === 'off' ? 'Вечерняя сверка (выключена в /settings)' : sc.evening + ' — вечерняя сверка'}.</b> Спрошу про главные задачи дня: ✅ сделано или ⏩ на завтра. Там же кнопка <b>«⏩ Всё несделанное — на завтра»</b> — переносит разом всё, что горело сегодня (с кнопкой «↩️ Вернуть как было»). Словами: <code>перенеси всё на понедельник</code>.

⏳ <b>«Жду ответа»</b> — когда задача стоит, потому что ждёшь кого-то (документы, ответ клиента): «☰ Ещё» → «⏳ Жду ответа» → когда спросить (завтра, через 3 дня, через неделю или «✏️ Свой день»). Можно и словами — ответом на карточку: <code>спросить в четверг</code>. Или просто начни задачу со слова «Жду»: <code>Жду договор от юристов</code>. Такие задачи лежат отдельно и не «горят», а в назначенный день утром я спрошу: «Пришёл ли ответ?» — и дам готовый текст напоминания, чтобы отправить человеку.

📊 <b>${sc.weekly === 'off' ? 'Итоги недели (выключены в /settings)' : `${sc.custom && sc.workOnly ? 'Последний рабочий день недели' : 'Воскресенье'}, ${sc.weekly} — итоги недели`}:</b> что сделано, что зависло, что на следующей неделе.

📌 <b>Закреплённый список</b> наверху чата обновляется после каждого изменения. Если он пропал — /pin.

Посмотреть вручную: /today — просрочено, сегодня и завтра · /focus — выбрать главное · /week — итоги.

🔔 <b>«Не отстану»</b> — для важных 🔥 задач (или любой: «☰ Ещё» → «🔔 Не отстану»): когда срок наступил, напоминаю <b>${nagWord(user, env)}</b> с ${sc.nagFrom} до ${sc.nagTo}, пока не нажмёшь ✅. В сообщении — «⏰ +1 час» и «🔕 сегодня больше не напоминать». Старое напоминание я удаляю, чтобы не копились.

❓ <b>Не приходят напоминания?</b> Напиши /status — я проверю, всё ли включено.`,

    meet: `📅 <b>Встречи из Яндекс Календаря</b>

<b>Подключить (один раз):</b>
1. Открой calendar.yandex.ru в браузере → наведи курсор на свой календарь в списке слева → ⚙️ → вкладка «Экспорт».
2. Формат iCal → «Скопировать» → пришли ссылку мне (сообщение я сразу удалю). Подробно — кнопка «📅 Встречи».

<b>Что дальше делаю сам:</b>
• ☀️ в утреннем плане — «Встречи сегодня»;
• 📅 <b>по понедельникам</b> — встречи недели с кнопками «📝»: нажми на встречу и напиши, что к ней подготовить (пункты с новой строки). Это станет задачей с чек-листом и сроком до начала встречи;
• 📎 <b>уже записанную задачу — к встрече:</b> на карточке задачи «☰ Ещё» → «🗓 К встрече» → выбери встречу. Или наоборот: нажми встречу → «📎 Добавить уже записанную задачу». Срок станет «до начала встречи», если был позже;
• 🔔 за час, за 15 минут и в момент начала встречи — напоминание со ссылкой на звонок, списком подготовки и задачами к встрече;
• 🗒 после регулярной встречи — «Записать задачи по итогам» (каждая строка — отдельная задача, срок можно писать в строке) и «➡️ Подготовить к следующей».

Все встречи на неделю — кнопка <b>«📅 Встречи»</b> внизу. Я только читаю календарь и ничего в нём не меняю.`,

    projects: `📁 <b>Проекты и руководитель</b>

Проект — общая папка задач, например «Работа». В неё можно позвать руководителя и коллег и ставить друг другу задачи.

<b>1. Создать проект</b>
Нажми <b>«📁 Проекты»</b> внизу чата → <b>«➕ Создать проект»</b> → напиши название, например <code>Работа</code>.
(Или просто напиши мне: <code>создай проект Работа</code>)

<b>2. Позвать руководителя</b>
Сразу после создания будет кнопка <b>«👥 Позвать людей»</b>. Нажми её и выбери руководителя в списке чатов — Telegram отправит ему приглашение. Ему нужно открыть ссылку и нажать «Старт». Я напишу тебе, когда приглашение примут.
Позже позвать ещё кого-то: «📁 Проекты» → «👥 Позвать».

<b>3. Положить задачу в проект</b>
Напиши задачу как обычно — под карточкой будет кнопка <b>«📁 Работа»</b>. Одно нажатие — и задача в проекте.
Или начни с названия проекта: <code>Работа: отчёт до пятницы</code>
Переложить потом: ☰ Ещё → «📁 Проект» на карточке.

<b>4. Поставить задачу человеку</b>
Когда задача в проекте, под ней появятся кнопки с именами участников: <b>«👤 Анна»</b>. Нажми — задача у неё, ей придёт уведомление.
Можно и текстом: <code>Работа: ${esc(me)} подготовить отчёт до пятницы</code>

<b>5. Одна задача нескольким</b>
<code>Работа: @Анна @Петя сверить акты</code> или <code>Работа: всем сдать отчёт</code> — или на карточке «👥 Нескольким…» и галочки.
У тебя одна общая задача с прогрессом «👥 1/3», у каждого — своя копия. Кто сделал — тебе приходит «✅ Анна сделал(а) (1/3)», когда все — «🎉 Все сделали». Срок, название и новые подробности меняешь у себя — обновятся у всех. Снять или добавить человека: ☰ Ещё → «👥 Кому». Закрыть или удалить у себя — закроется или удалится у всех.

<b>6. Статусы</b> (как колонки в Асане): на карточке «☰ Ещё» → «🏷 Статус» → 📥 К выполнению / 🔨 В работе / 👀 На проверке / ✅ Готово. Автору приходит уведомление, а проект в «📁 Проекты» разложен по статусам.

<b>7. Дальше всё само</b>
Исполнитель отмечает ✅ или дописывает подробности — автору приходит уведомление. Свои поручения ты видишь в блоке «📤 Поручено другим».

<b>Полезно знать:</b>
• твои личные задачи (вне проектов) никто не видит;
• удалить задачу может только её автор;
• все задачи проекта по людям: «📁 Проекты» → нажми на проект;
• <b>переименовать</b>: «📁 Проекты» → нажми на проект → «✏️ Переименовать» (или напиши <code>переименуй проект Тест в Отдел</code>). Участники получат сообщение;
• <b>удалить проект</b>: «📁 Проекты» → нажми на проект → «🗑 Удалить проект» (или напиши <code>удали проект Тест</code>). Задачи можно оставить — они станут личными. Удалить может только создатель проекта, остальные — «🚪 Выйти».`,

    board: `🗂 <b>Доска</b>

<b>Доска в чате</b> — кнопка «🗂 Доска» внизу. Работает без VPN: вкладки 📍 Сегодня · 🗓 Неделя · 📆 Позже · 📥 Без срока · 📤 Поручено · 📁 Проекты (по статусам), задачи — кнопками, нажми — откроется карточка. Если задач много — листай ◀ ▶.

<b>Большая доска</b> — кнопка «🌐 Большая доска» под доской в чате или «Доска» слева от поля ввода. Это мини-приложение: ему нужен VPN (встроенный прокси Telegram его не пропускает).
Там колонки Просрочено → Сегодня → Завтра → Неделя → Позже → Без срока → Готово, и можно:
• <b>перетащить</b> карточку в другую колонку (зажми её на секунду и тяни) — срок поменяется; в «Готово» — задача закрыта;
• <b>нажать</b> на карточку — откроется всё: название, дата и время, 🔥 важная, ⭐ главное сегодня, проект, кому поручено, чек-лист, подробности;
• <b>«+»</b> внизу — новая задача, пишется так же, как мне в чат;
• <b>фильтры</b> сверху: Мои / Все / Поручено / отдельно по каждому проекту; там же <b>«＋ Проект»</b> — создать проект;
• в карточке задачи — <b>Повтор → Настроить</b>: форма как в календаре.

💡 Чат и доска в чате — на каждый день. Большая доска — чтобы спокойно разобрать всё разом, когда включён VPN.`,

    voice: `🎙 <b>Голосовые</b>

Запиши голосовое, как будто говоришь помощнику:

🎤 «Напомни позвонить маме завтра в 10 утра»
→ задача «Позвонить маме», завтра 10:00

🎤 «Отчёт для Анны до пятницы, срочно»
→ задача со сроком пятница, важная 🔥

🎤 «Оплатить интернет каждое десятое число»

<b>После собрания голосом:</b> ответь голосовым на карточку задачи — я расшифрую и допишу в подробности.

Я показываю, что расслышал: <i>🎙 «…»</i> — если ошибся, нажми ☰ Ещё → 🗑 Удалить и напиши текстом.

💡 Время можно называть как удобно: «в 10 утра», «в 3» (это 15:00), «в 7 вечера», «в 15 часов», «утром», «к обеду».`,

    commands: `⌨️ <b>Все команды</b>
(нажми на команду — она сработает сразу)

<b>Меню внизу чата</b>
📋 Задачи · ⭐ Главное · 📅 Встречи · 📁 Проекты · 🗂 Доска · ❓ Помощь
Пропало меню — /menu (или значок ⌘ / ▦ рядом с полем ввода)

<b>Словами</b> (без слэша)
<code>удали задачу …</code> · <code>готово …</code> · <code>перенеси … на завтра</code>

<b>Задачи</b>
/list — все мои задачи по срокам
/today — просрочено, сегодня и завтра
/done — что уже сделано, с датами; там же «🧹 Очистить выполненное»
/repeat — регулярные задачи
/t5 — открыть задачу №5 (номер есть в каждой строке списка; в начале или в конце — /settings)

<b>День и неделя</b>
/focus — выбрать 3 главные задачи на сегодня
/week — итоги недели
/pin — заново закрепить список наверху
/schedule — мой рабочий график (или <code>график 10-19</code>)
/settings — мои настройки кнопками: график, план дня, сверка, итоги недели, когда напоминать о сроке и встречах, «не отстану», номер задачи, вид регулярных
/status — проверить, работают ли напоминания

<b>Проекты</b>
/projects — мои проекты и кнопка «➕ Создать проект»
/invite — позвать человека в проект
<code>/list название</code> — задачи одного проекта

<b>Встречи</b>
/meetings — встречи на неделю
/calendar — подключить Яндекс Календарь

<b>Прочее</b>
/board — доска в чате
/help — эта справка`,
  };
  return S[key] || null;
}

function helpMenuKeyboard() {
  const rows = [];
  const items = HELP_ORDER;
  rows.push([{ text: items[0][1], callback_data: 'h:' + items[0][0] }, { text: '⚙️ Мои настройки', callback_data: 'O:menu' }]);
  for (let i = 1; i < items.length; i += 2) {
    rows.push(items.slice(i, i + 2).map(([k, title]) => ({ text: title, callback_data: 'h:' + k })));
  }
  return { inline_keyboard: rows };
}

function helpSectionKeyboard(key) {
  const i = HELP_ORDER.findIndex(([k]) => k === key);
  const row = [{ text: '← Все разделы', callback_data: 'h:menu' }];
  const next = HELP_ORDER[i + 1];
  if (next) row.push({ text: `Дальше: ${next[1]} →`, callback_data: 'h:' + next[0] });
  return { inline_keyboard: [row] };
}

const sendHelp = (env, uid) => send(env, uid, HELP_INTRO, { reply_markup: helpMenuKeyboard() });

function projectLine(ctx, p, openCount) {
  const people = [...p.members].map(id => esc(nameOf(ctx, id))).join(', ');
  return `📁 <b>${esc(p.name)}</b> — открытых: ${openCount} · 👥 ${people}  /p${p.id}`;
}

async function renderProject(ctx, uid, p) {
  const tasks = (await queryTasks(ctx, 'project_id = ? AND (done = 0 OR done_at >= ?)', p.id, addDays(ctx.now.date, -7))).filter(t => visibleTo(t, uid));
  const open = tasks.filter(t => !t.done);
  let s = `📁 <b>${esc(p.name)}</b>\n👥 ${[...p.members].map(id => esc(nameOf(ctx, id))).join(', ')}\n`;
  // по статусам — как колонки доски: что в работе, что ждёт проверки, что ещё не начато
  for (const [st, label] of [['doing', '🔨 В работе'], ['review', '👀 На проверке'], ['todo', '📥 К выполнению']]) {
    const list = sortTasks(open.filter(t => (t.status || 'todo') === st));
    if (!list.length) continue;
    s += `\n<b>${label}</b>\n` + list.map(t => taskLine(ctx, t, uid, bucketOf(t, ctx.now)).replace(/^(• |🔥 )(\/t\d+ )?(?:🔨 |👀 )/, '$1$2')).join('\n') + '\n';
  }
  if (!open.length) s += '\nОткрытых задач нет.\n';
  const done = tasks.filter(t => t.done).slice(-5);
  if (done.length) s += '\n<b>✅ Готово за неделю</b>\n' + done.map(t => `• <s>${esc(t.title)}</s> — ${esc(nameOf(ctx, t.assignee))}`).join('\n') + '\n';
  s += `\n<i>Новая задача в проект: <code>${esc(p.name)}: текст задачи</code>. Статус — на карточке: «☰ Ещё» → «🏷 Статус».</i>`;
  return clip(s);
}

// ── Доска прямо в чате (без мини-приложения — работает без VPN) ──

const BOARD_TABS = [['today', '📍 Сегодня'], ['week', '🗓 Неделя'], ['later', '📆 Позже'], ['nodate', '📥 Без срока'], ['waiting', '⏳ Жду'], ['out', '📤 Поручено'], ['done', '✅ Готово']];
const BOARD_PAGE = 8;

async function renderChatBoard(ctx, user, view = 'today', page = 0) {
  const now = ctx.now, uid = user.id;
  const all = await myOpenTasks(ctx, uid);
  const mine = all.filter(t => t.assignee === uid);
  const b = t => bucketOf(t, now);
  const sets = {
    today: mine.filter(t => b(t) === 'overdue' || b(t) === 'today'),
    week: mine.filter(t => b(t) === 'tomorrow' || b(t) === 'week'),
    later: mine.filter(t => b(t) === 'later'),
    nodate: mine.filter(t => b(t) === 'nodate'),
    waiting: mine.filter(t => b(t) === 'waiting'),
    out: all.filter(t => t.assignee !== uid),
    done: await myDoneTasks(ctx, uid, 40),
  };
  let title, list;
  const pm = view.match(/^p(\d+)$/);
  const p = pm && ctx.projects.get(+pm[1]);
  if (p && p.members.has(uid)) {
    const ptasks = (await queryTasks(ctx, 'project_id = ? AND done = 0', p.id)).filter(t => visibleTo(t, uid));
    list = ['doing', 'review', 'todo'].flatMap(st => sortTasks(ptasks.filter(t => (t.status || 'todo') === st)));
    title = `📁 ${esc(p.name)}`;
  } else {
    if (!sets[view]) view = 'today';
    list = sortTasks(sets[view]);
    title = BOARD_TABS.find(([k]) => k === view)[1];
  }
  const pages = Math.max(1, Math.ceil(list.length / BOARD_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(page * BOARD_PAGE, (page + 1) * BOARD_PAGE);
  let text = `🗂 <b>Доска · ${title}</b> — ${list.length}\n`;
  if (!list.length) text += '\nПусто 🎉';
  let lastSt = null;
  slice.forEach((t, i) => {
    if (p && (t.status || 'todo') !== lastSt) { lastSt = t.status || 'todo'; text += `\n<b>${STATUS[lastSt]}</b>\n`; }
    else if (!p && i === 0) text += '\n';
    if (t.done) text += `${page * BOARD_PAGE + i + 1}. <s>${esc(t.title)}</s> <i>· ✅ ${t.doneAt ? fmtDate(t.doneAt, now) : ''}</i>\n`;
    else text += `${page * BOARD_PAGE + i + 1}. ${taskLine(ctx, t, uid, b(t)).replace(/^• /, '').replace(p ? /^(🔥 )?(\/t\d+ )?(?:🔨 |👀 )/ : /$^/, '$1$2')}\n`;
  });
  const rows = [];
  const tab = ([k, label]) => ({ text: `${k === view && !p ? '• ' : ''}${label} ${sets[k].length}`, callback_data: `B:v:${k}:0` });
  rows.push(BOARD_TABS.slice(0, 4).map(tab));
  rows.push(BOARD_TABS.slice(4).map(tab));
  rows.push([{ text: p ? `• 📁 ${short(p.name, 20)}` : '📁 Проекты', callback_data: 'B:pl' }]);
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(slice.slice(i, i + 2).map((t, j) => ({ text: `${page * BOARD_PAGE + i + j + 1}. ${short(t.title, 22)}`, callback_data: `B:o:${t.id}` })));
  }
  if (pages > 1) {
    rows.push([
      { text: '◀', callback_data: `B:v:${view}:${(page - 1 + pages) % pages}` },
      { text: `${page + 1} / ${pages}`, callback_data: 'B:n' },
      { text: '▶', callback_data: `B:v:${view}:${(page + 1) % pages}` },
    ]);
  }
  if (view === 'done' && !p && list.length) rows.push([{ text: '🧹 Очистить выполненное', callback_data: 'X:ask' }]);
  if (ctx.origin) rows.push([{ text: '🌐 Большая доска (нужен VPN)', web_app: { url: ctx.origin + '/app' } }]);
  return { text: clip(text), keyboard: { inline_keyboard: rows } };
}

function projectsPickKeyboard(ctx, uid) {
  const rows = myProjects(ctx, uid).map(p => [{ text: `📁 ${short(p.name, 30)}`, callback_data: `B:v:p${p.id}:0` }]);
  rows.push([{ text: '← Назад', callback_data: 'B:v:today:0' }]);
  return { inline_keyboard: rows };
}

function focusCandidates(ctx, mine) {
  const order = { overdue: 0, today: 1, tomorrow: 3, week: 4, later: 5, nodate: 6 };
  const rank = t => (t.high && !t.due ? 2 : order[bucketOf(t, ctx.now)]);
  return [...mine].filter(t => !t.waiting).sort((a, b) => rank(a) - rank(b) || (b.high - a.high) || a.id - b.id).slice(0, 8);
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
    return send(env, uid, await renderProject(ctx, uid, p), { reply_markup: projectKeyboard(p, uid) });
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
          // сообщаем только создателю проекта: при общей ссылке в чате отдела остальные не получают по сообщению на каждого
          if (p.owner !== uid && ctx.users.has(p.owner)) await send(env, p.owner, `👋 <b>${esc(user.name)}</b> теперь в проекте «${esc(p.name)}» (всего участников: ${p.members.size})`);
        }
        const fresh = !user.data.kbv; // первый раз в боте — пришёл по ссылке, а не через /start
        await send(env, uid, `🤝 Ты в проекте «<b>${esc(p.name)}</b>»!\n\nЗадачи проекта, поставленные тебе, появятся в твоём общем списке рядом с личными.\nНовая задача в проект: напиши задачу и нажми под ней «📁 ${esc(p.name)}» — или <code>${esc(p.name)}: текст задачи</code>\nВесь проект: /p${p.id}` + (fresh ? '' : '\n\nКак пользоваться ботом: /help'), { reply_markup: mainKeyboard(ctx) });
        user.data.kbv = KB_VERSION; user.dirty = true;
        // новичку — то же приветствие, что и по /start, и вопрос о графике
        if (fresh) await sendHelp(env, uid);
        if (!user.data.sched && !user.data.schedAsked) { user.data.schedAsked = 1; await askSchedule(ctx, user); }
        ctx.dash.add(uid);
        return;
      }
      await sendHelp(env, uid);
      await send(env, uid, 'Кнопки внизу — быстрый доступ к задачам и проектам 👇', { reply_markup: mainKeyboard(ctx) });
      user.data.kbv = KB_VERSION; user.dirty = true;
      if (!user.data.sched && !user.data.schedAsked) { user.data.schedAsked = 1; await askSchedule(ctx, user); }
      ctx.dash.add(uid);
      return;
    }
    case '/schedule': {
      const ps = arg && parseSchedule(arg);
      if (ps) { user.data.sched = ps; user.data.schedAsked = 1; user.dirty = true; return send(env, uid, '✅ График сохранён\n\n' + schedSummary(env, user)); }
      if (user.data.sched) await send(env, uid, schedSummary(env, user));
      return askSchedule(ctx, user);
    }
    case '/menu':
      return send(env, uid, 'Кнопки внизу 👇', { reply_markup: mainKeyboard(ctx) });
    case '/settings': {
      const v = settingsView(ctx, user);
      return send(env, uid, v.text, { reply_markup: v.reply_markup });
    }
    case '/help':
      return sendHelp(env, uid);
    case '/list':
    case '/all': {
      if (arg) {
        const p = findProject(ctx, uid, arg);
        if (!p) return send(env, uid, `Проекта «${esc(arg)}» нет. Все проекты: /projects`);
        return send(env, uid, await renderProject(ctx, uid, p), { reply_markup: projectKeyboard(p, uid) });
      }
      if (!all.length) return send(env, uid, 'Задач нет 🎉');
      let s = '📋 <b>Все задачи</b>\n\n' + renderSplit(ctx, mine, uid);
      const del = all.filter(t => t.assignee !== uid);
      if (del.length) s += '\n\n<b>📤 Поручено другим</b>\n' + sortTasks(del).map(t => taskLine(ctx, t, uid, 'later')).join('\n');
      return send(env, uid, clip(s));
    }
    case '/today': {
      const text = renderGroups(ctx, mine, uid, ['overdue', 'today', 'tomorrow']);
      return send(env, uid, text ? clip(text) : 'На сегодня и завтра сроков нет 🎉 Все задачи: /list');
    }
    case '/done': {
      const done = await myDoneTasks(ctx, uid, 40);
      if (!done.length) return send(env, uid, 'Выполненных задач нет.');
      return send(env, uid, clip('✅ <b>Выполнено</b> — по дате завершения\n' + renderDoneList(ctx, uid, done) +
        '\n<i>Открыть задачу — нажми её номер. Вернуть в работу или удалить — на карточке.</i>'), {
        reply_markup: { inline_keyboard: [[{ text: '🧹 Очистить выполненное', callback_data: 'X:ask' }]] },
      });
    }
    case '/repeat': {
      const rep = sortTasks(mine.filter(t => t.repeat));
      return send(env, uid, rep.length
        ? '🔁 <b>Регулярные задачи</b>\n\n' + rep.map(t =>
          withId(ctx, uid, `• ${esc(t.title)} <i>· ${fmtRepeat(t.repeat)}${t.due && t.due.time ? ' в ' + t.due.time : ''}, следующий раз ${fmtDue(t.due, now)}</i>`, t.id)).join('\n')
        : 'Регулярных задач пока нет. Напиши, например: «Оплатить интернет каждое 10 число».');
    }
    case '/focus':
      return sendFocusPicker(ctx, user, mine);
    case '/week':
      return sendWeekly(ctx, user, true);
    case '/morning':
      return sendMorning(ctx, user, mine, true);
    case '/projects':
      return sendProjects(ctx, user);
    case '/newproject': {
      const name = arg.replace(/^#/, '').trim();
      return name ? createProjectFlow(ctx, user, name) : askProjectName(ctx, user);
    }
    case '/invite': {
      const ps = myProjects(ctx, uid);
      const p = arg ? findProject(ctx, uid, arg) : (ps.length === 1 ? ps[0] : null);
      if (p) return sendInvite(ctx, user, p);
      if (!ps.length) return send(env, uid, 'Сначала создай проект — потом позовёшь в него людей.', { reply_markup: { inline_keyboard: [[{ text: '➕ Создать проект', callback_data: 'P:new' }]] } });
      return send(env, uid, 'В какой проект позвать?', { reply_markup: { inline_keyboard: ps.map(x => [{ text: `📁 ${x.name}`, callback_data: `P:i${x.id}` }]) } });
    }
    case '/leave': {
      const p = arg && findProject(ctx, uid, arg);
      if (!p) return send(env, uid, 'Из какого проекта выйти? Посмотри /projects и нажми /leave_номер');
      await leaveProject(ctx, p, uid);
      ctx.dash.add(uid);
      return send(env, uid, `Ты больше не в проекте «${esc(p.name)}».`);
    }
    case '/board': {
      const bd = await renderChatBoard(ctx, user, 'today', 0);
      return send(env, uid, bd.text, { reply_markup: bd.keyboard });
    }
    case '/status':
      return sendStatus(ctx, user);
    case '/calendar':
      if (arg) return connectCalendar(ctx, user, arg, msg);
      return user.data.cal ? sendMeetings(ctx, user) : send(env, uid, CAL_HELP);
    case '/meetings':
      return sendMeetings(ctx, user);
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

// Файл из сообщения: фото, документ, видео, аудио, гифка
function mediaOf(msg) {
  if (msg.photo && msg.photo.length) return { type: 'photo', id: msg.photo[msg.photo.length - 1].file_id, name: 'Фото' };
  if (msg.document) return { type: 'document', id: msg.document.file_id, name: msg.document.file_name || 'Файл' };
  if (msg.video) return { type: 'video', id: msg.video.file_id, name: msg.video.file_name || 'Видео' };
  if (msg.animation) return { type: 'animation', id: msg.animation.file_id, name: 'GIF' };
  if (msg.audio) return { type: 'audio', id: msg.audio.file_id, name: msg.audio.title || msg.audio.file_name || 'Аудио' };
  return null;
}

async function attachFile(ctx, t, f) {
  t.files = [...(t.files || []), f].slice(-10);
  await saveTask(ctx, t); touch(ctx, t);
}

async function handleMessage(ctx, user, msg) {
  const env = ctx.env, uid = user.id;
  let text = (msg.text || msg.caption || '').trim();
  let prefix = '';

  if (msg.text && MAIN_BUTTONS[text]) return handleCommand(ctx, user, MAIN_BUTTONS[text], '', msg);

  if (msg.text && text.startsWith('/')) {
    delete user.data.awaiting;
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
  let target = replyTo && await taskByMsg(ctx, uid, replyTo.message_id);
  if (target && !canAccess(ctx, target, uid)) target = null;

  // файлы: в ответ на карточку — прикрепить; альбом — в одну задачу; иначе — новая задача с файлом
  const file = mediaOf(msg);
  if (file) {
    const lg = user.data.lastGroup;
    if (msg.media_group_id && lg && lg.gid === msg.media_group_id && realNowMs(env) - lg.at < 5 * 60e3) {
      const t = await getTask(ctx, lg.taskId);
      if (t && canAccess(ctx, t, uid)) { await attachFile(ctx, t, file); return; }
    }
    if (target) {
      await attachFile(ctx, target, file);
      if (text) {
        const d = parseDetails(text, uid, ctx.now);
        target.notes = [...(target.notes || []), ...d.notes];
        target.checklist = [...(target.checklist || []), ...d.checklist];
        await saveTask(ctx, target);
      }
      if (msg.media_group_id) { user.data.lastGroup = { gid: msg.media_group_id, taskId: target.id, at: realNowMs(env) }; user.dirty = true; }
      notifyOthers(ctx, target, uid, `📎 <b>${esc(user.name)}</b> приложил(а) файл\n\n`);
      return sendCard(ctx, uid, target, '📎 Файл прикреплён\n\n');
    }
    const r = await createFromText(ctx, user, text || file.name, { from: forwardLabel(msg), prefix, files: [file] });
    if (r.error) return send(env, uid, prefix + r.error);
    if (msg.media_group_id) { user.data.lastGroup = { gid: msg.media_group_id, taskId: r.task.id, at: realNowMs(env) }; user.dirty = true; }
    return;
  }

  const aw = user.data.awaiting;
  // ждём новый текст подробностей (после «✏️ Подробности»)
  // (10 минут и не ответом на другую карточку — чтобы новая задача, написанная позже, не стала подробностями)
  if (aw && aw.kind === 'details' && text && !msg.forward_origin && (!target || target.id === aw.taskId)) {
    delete user.data.awaiting; user.dirty = true;
    const t = realNowMs(env) - (aw.at || 0) < 10 * 60e3 ? await getTask(ctx, aw.taskId) : null;
    if (t && canAccess(ctx, t, uid)) {
      rememberDetails(ctx, uid, t);
      setDetailsFromText(t, text, uid, ctx.now);
      await saveTask(ctx, t); touch(ctx, t);
      notifyOthers(ctx, t, uid, `✏️ <b>${esc(user.name)}</b> изменил(а) подробности\n\n`);
      const r = await send(env, uid, '✏️ Подробности обновлены\n\n' + renderCard(ctx, t), { reply_markup: {
        inline_keyboard: [[{ text: '↩️ Вернуть как было', callback_data: `a:${t.id}:nrest` }], ...cardKeyboard(ctx, t, uid).inline_keyboard] } });
      if (r.ok) await rememberMsg(ctx, uid, r.result.message_id, t.id);
      return;
    }
  }
  // ждём своё значение настройки (после «✏️ Своё»)
  if (aw && aw.kind === 'pref' && text && !msg.forward_origin && !target) {
    if (realNowMs(env) - (aw.at || 0) < 15 * 60e3) {
      const v = customPref(aw.key, text, ctx.now);
      if (v === null || (aw.key !== 'v' && !setPref(user, aw.key, v))) {
        return send(env, uid, '🤔 Не понял. ' + CUSTOM_ASK[aw.key], { reply_markup: { inline_keyboard: [[{ text: '✖ Отмена', callback_data: 'O:menu' }]] } });
      }
      delete user.data.awaiting; user.dirty = true;
      if (aw.key === 'v') setAway(ctx, user, v);
      const view = settingsView(ctx, user);
      return send(env, uid, '✅ Сохранено\n\n' + view.text, { reply_markup: view.reply_markup });
    }
    delete user.data.awaiting; user.dirty = true;
  }
  // ждём новое название (после «✏️ Название»)
  if (aw && aw.kind === 'title' && text && !msg.forward_origin && (!target || target.id === aw.taskId)) {
    delete user.data.awaiting; user.dirty = true;
    const t = realNowMs(env) - (aw.at || 0) < 10 * 60e3 ? await getTask(ctx, aw.taskId) : null;
    if (t && canAccess(ctx, t, uid)) return titleReply(ctx, user, t, text.split('\n')[0]);
  }
  if (target && text && !msg.forward_origin && !text.includes('\n')) {
    const tm = text.trim().match(RE_TITLE);
    if (tm) return titleReply(ctx, user, target, tm[1]);
  }
  // в сообщении только несуществующая дата («31 сентября», «в 25:00») — не создаём из неё задачу, а говорим, что не так
  if (text && !msg.forward_origin && !text.includes('\n')) {
    const pb = parseTask(text, ctx.now);
    if (onlyBadDate(pb)) return send(env, uid, badDateText(pb.bad));
  }
  // ждём дату (после «📅 Срок» или «✏️ Своя дата»)
  if (aw && aw.kind === 'due' && text && !msg.forward_origin && !target) {
    delete user.data.awaiting; user.dirty = true;
    const p = parseTask(text, ctx.now);
    if (!p.title && p.due && realNowMs(env) - (aw.at || 0) < 15 * 60e3) {
      const t = await getTask(ctx, aw.taskId);
      if (t && canAccess(ctx, t, uid)) return applyTypedDue(ctx, user, t, p);
    }
  }
  // ждём день, когда спросить про ответ (после «⏳ Жду ответа» → «✏️ Свой день»)
  if (aw && aw.kind === 'wait' && text && !msg.forward_origin && (!target || target.id === aw.taskId)) {
    const date = waitDateOf(text, ctx.now);
    if (date && realNowMs(env) - (aw.at || 0) < 15 * 60e3) {
      delete user.data.awaiting; user.dirty = true;
      const t = await getTask(ctx, aw.taskId);
      if (t && canAccess(ctx, t, uid)) {
        setWaitCheck(t, date, ctx.now);
        await saveTask(ctx, t); touch(ctx, t);
        return sendCard(ctx, uid, t, `⏳ Жду ответа. Спрошу <b>${fmtDate(t.waiting.check, ctx.now)}</b>\n\n`);
      }
    } else if (realNowMs(env) - (aw.at || 0) >= 15 * 60e3 || !ASK_RE.test(text.trim())) {
      delete user.data.awaiting; user.dirty = true; // написали что-то другое — дальше как обычно
    } else {
      return send(env, uid, 'Не понял день 🙂 Напиши так: <code>в четверг</code>, <code>12.10</code> или <code>через 2 недели</code>');
    }
  }
  // «спросить в четверг» — ответом на карточку или сразу после «⏳ Жду ответа»: это день проверки, а не новая задача
  if (text && !msg.forward_origin && ASK_RE.test(text.trim())) {
    const date = waitDateOf(text, ctx.now);
    const lt = user.data.lastTask;
    const t = date && (target || (lt && realNowMs(env) - lt.at < 30 * 60e3 ? await getTask(ctx, lt.id) : null));
    // «напомни завтра» ответом на обычную карточку — это не «жду ответа»; «спросить/уточнить/проверить» — да
    if (t && canAccess(ctx, t, uid) && !t.done && (t.waiting || (target && /^(?:спроси|уточни|провер)/iu.test(text.trim())))) {
      setWaitCheck(t, date, ctx.now);
      await saveTask(ctx, t); touch(ctx, t);
      return sendCard(ctx, uid, t, `⏳ Жду ответа. Спрошу <b>${fmtDate(t.waiting.check, ctx.now)}</b>\n\n`);
    }
  }
  // ждём дату начала (после «▶️ Начать…» → «✏️ Своя дата»)
  if (aw && aw.kind === 'start' && text && !msg.forward_origin && !target) {
    delete user.data.awaiting; user.dirty = true;
    const p = parseTask(text, ctx.now);
    if (!p.title && p.due && realNowMs(env) - (aw.at || 0) < 15 * 60e3) {
      const t = await getTask(ctx, aw.taskId);
      if (t && canAccess(ctx, t, uid)) {
        t.start = { date: p.due.date, time: null };
        await saveTask(ctx, t); touch(ctx, t);
        return sendCard(ctx, uid, t, `▶️ Начать: <b>${fmtDue(t.start, ctx.now)}</b>\n\n`);
      }
    }
  }
  // только дата без задачи — наверное, хотели перенести последнюю задачу
  if (text && !msg.forward_origin && !target && !text.includes('\n')) {
    const p = parseTask(text, ctx.now);
    const lt = user.data.lastTask;
    if (!p.title && p.due && !p.repeat) {
      const t = lt && realNowMs(env) - lt.at < 60 * 60e3 ? await getTask(ctx, lt.id) : null;
      if (t && canAccess(ctx, t, uid) && !t.done) {
        user.data.pendingDue = { id: t.id, due: p.due, ambig: p.ambig || null }; user.dirty = true;
        return send(env, uid, `Перенести «<b>${esc(t.title)}</b>» на <b>${fmtDue(p.due, ctx.now)}</b>?`, {
          reply_markup: { inline_keyboard: [[{ text: '✅ Да, перенести', callback_data: 'D:y' }, { text: 'Нет', callback_data: 'D:n' }]] },
        });
      }
      return send(env, uid, `Вижу дату — <b>${fmtDue(p.due, ctx.now)}</b>, но не понял, к какой задаче 🙂\n\n• Новая задача: напиши, что сделать, например <code>Сдать отчёт ${esc(text)}</code>\n• Перенести задачу: открой её карточку → «📅 Срок» → напиши дату, или ответь (reply) датой на карточку.`);
    }
  }

  // ждём, что подготовить к встрече / что сделать после неё
  if (aw && (aw.kind === 'prep' || aw.kind === 'after') && text && !msg.forward_origin && !target) {
    delete user.data.awaiting; user.dirty = true;
    if (realNowMs(env) - (aw.at || 0) < 60 * 60e3) {
      return aw.kind === 'prep' ? savePrep(ctx, user, aw.h, text) : saveAfter(ctx, user, aw.h, aw.title || 'встреча', text);
    }
  }
  // прислали ссылку экспорта календаря
  if (text && !target && /^https:\/\/\S*(?:calendar|\.ics|ical)\S*$/i.test(text.trim())) return connectCalendar(ctx, user, text.trim(), msg);

  // ждём название проекта (после «➕ Создать проект»)
  if (aw && aw.kind === 'pname' && text && !msg.forward_origin) {
    delete user.data.awaiting; user.dirty = true;
    if (realNowMs(env) - (aw.at || 0) < 30 * 60e3) return createProjectFlow(ctx, user, text.split('\n')[0], aw.taskId);
  }
  // ждём новое название проекта (после «✏️ Переименовать»)
  if (aw && aw.kind === 'prename' && text && !msg.forward_origin && !target) {
    delete user.data.awaiting; user.dirty = true;
    const p = ctx.projects.get(aw.pid);
    if (p && p.members.has(uid) && realNowMs(env) - (aw.at || 0) < 30 * 60e3) return renameProjectFlow(ctx, user, p, text.split('\n')[0]);
  }
  // «переименуй проект Отдел в Бухгалтерия»
  const rp = text && !msg.forward_origin && !text.includes('\n') && text.match(/^переимен\p{L}*\s+проект\s+[«"]?(.+?)[»"]?\s+(?:в|на)\s+[«"]?(.+?)[»"]?\.?$/iu);
  if (rp) {
    const p = findProject(ctx, uid, rp[1].trim());
    if (!p) return send(env, uid, `Проекта «${esc(rp[1].trim())}» нет. Все проекты — кнопка «📁 Проекты» внизу.`);
    return renameProjectFlow(ctx, user, p, rp[2]);
  }
  const np = text && !msg.forward_origin && text.match(NEW_PROJECT_RE);
  if (np) return np[1] && np[1].trim() ? createProjectFlow(ctx, user, np[1]) : askProjectName(ctx, user);

  // «номера в начале» / «номера в конце», «настройки»
  const nm = text && !msg.forward_origin && !text.includes('\n') && text.trim().match(/^(?:(?:ставь|пиши|показывай|сделай)\s+)?номер(?:а|ы)?(?:\s+задач)?\s+(?:в\s+)?(начал[еао]|спереди|впереди|перед\s+задачей|конц[еау]|сзади|после\s+задачи)[.!]*$/iu);
  if (nm) {
    const on = /^(?:начал|спер|впер|перед)/iu.test(nm[1]);
    setIdFirst(ctx, user, on);
    const v = settingsView(ctx, user);
    return send(env, uid, `✅ Номера задач теперь ${on ? 'в начале' : 'в конце'} строки\n\n` + v.text, { reply_markup: v.reply_markup });
  }
  // «я в отпуске до 20.10», «ухожу в отпуск по пятницу», «вернулась из отпуска»
  const vac = text && !msg.forward_origin && !target && !text.includes('\n') && text.trim().match(/^(?:я\s+)?(?:ухожу\s+|уйду\s+|буду\s+)?в\s+отпуск[еау]?\s+(?:до|по)\s+(.+?)[.!]*$/iu);
  if (vac) {
    const d = customPref('v', vac[1], ctx.now);
    if (!d) return send(env, uid, 'Не понял дату 🙂 Напиши так: <code>я в отпуске до 20.10</code> — или «⚙️ Мои настройки» → «🏖 Отпуск».');
    setAway(ctx, user, d);
    const v = settingsView(ctx, user);
    return send(env, uid, `🏖 Хорошего отдыха! Напоминания на паузе по ${fmtDay(d, ctx.now)} включительно.\n\n` + v.text, { reply_markup: v.reply_markup });
  }
  if (text && !target && user.data.away && /^(?:я\s+)?(?:вернул(?:ся|ась)|вышл[аи]|вышел)\s+(?:из\s+отпуска|на\s+работу)[.!]*$/iu.test(text.trim())) {
    setAway(ctx, user, null);
    return send(env, uid, '👋 С возвращением! Напоминания снова включены. Всё по срокам — /list');
  }
  if (text && /^(?:⚙️\s*)?(?:мои\s+)?настройки[.!]*$/iu.test(text.trim())) {
    const v = settingsView(ctx, user);
    return send(env, uid, v.text, { reply_markup: v.reply_markup });
  }

  // «график 10-19», «мой график 9:30–18:30 без выходных», «мой график»
  const gm = text && !msg.forward_origin && !text.includes('\n') && text.match(/^(?:мой\s+)?(?:рабочий\s+)?график(?:\s+работы)?\s*:?\s*(.*)$/iu);
  if (gm) {
    const ps = gm[1] && parseSchedule(gm[1]);
    if (ps) { user.data.sched = ps; user.data.schedAsked = 1; user.dirty = true; return send(env, uid, '✅ <b>График сохранён</b>\n\n' + schedSummary(env, user)); }
    if (gm[1] && gm[1].trim()) return send(env, uid, 'Не понял время 🙂 Напиши так: <code>график 9-18</code> или <code>график 9:30-18:30 без выходных</code>');
    await send(env, uid, schedSummary(env, user));
    return askSchedule(ctx, user);
  }

  // «удали проект Тест»
  const dp = text && !msg.forward_origin && text.match(/^(?:удали(?:ть)?|убери|убрать)\s+проект\s*[:«"]?\s*(.+?)[»".]?$/iu);
  if (dp) {
    const p = findProject(ctx, uid, dp[1].trim());
    if (!p) return send(env, uid, `Проекта «${esc(dp[1].trim())}» нет. Все проекты — кнопка «📁 Проекты» внизу.`);
    return askDeleteProject(ctx, user, p);
  }

  // ответ на карточку: «убери детали», «удали чек-лист», «убери Альфа Политех»
  if (target && text && !msg.forward_origin && await editDetailsByText(ctx, user, target, text)) return;

  // «удали задачу …», «сделала …», «перенеси … на завтра»
  const intent = text && !msg.forward_origin && parseIntent(text);
  if (intent) {
    if (prefix) await send(env, uid, prefix.trim());
    await handleIntent(ctx, user, intent, target, text);
    return;
  }

  if (target) {
    if (!text) return send(env, uid, 'Пришли подробности текстом или голосом 🙏');
    return applyReply(ctx, user, target, text);
  }

  if (!text) return send(env, uid, 'Я понимаю текст, голосовые, фото и файлы. Напиши задачу словами 🙂');

  const r = await createFromText(ctx, user, text, { from: forwardLabel(msg), prefix });
  if (r.error) return send(env, uid, prefix + r.error);
}

// ── Кнопки ──

async function handleCallback(ctx, user, cq) {
  const env = ctx.env, uid = user.id;
  const data = cq.data || '';
  const msg = cq.message;
  const answer = text => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: text || '' });

  // справка по разделам
  let h = data.match(/^h:(\w+)$/);
  if (h) {
    await answer('');
    if (!msg) return;
    const text = h[1] === 'menu' ? HELP_INTRO : helpSection(h[1], user, env);
    if (!text) return;
    return tg(env, 'editMessageText', {
      chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text,
      reply_markup: h[1] === 'menu' ? helpMenuKeyboard() : helpSectionKeyboard(h[1]),
      link_preview_options: { is_disabled: true },
    });
  }

  // выбор главных задач дня
  let m = data.match(/^f:(\d+|ok)$/);
  if (m) {
    const all = await myOpenTasks(ctx, uid);
    const mine = all.filter(t => t.assignee === uid);
    const f = user.data.focus && user.data.focus.date === ctx.now.date ? user.data.focus : { date: ctx.now.date, ids: [] };
    if (m[1] === 'ok') {
      const chosen = mine.filter(t => f.ids.includes(t.id));
      await answer(chosen.length ? `⭐ Отличный план: ${chosen.length} — наверху списка` : 'Ничего не выбрано — можно позже: /focus');
      if (msg) await tg(env, 'editMessageReplyMarkup', { chat_id: uid, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
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
    if (!t || !canAccess(ctx, t, uid)) return answer(lostTask(t));
    const res = t.done && m[2] === 'done' ? { toast: 'Уже выполнено' } : await applyAction(ctx, t, m[2], uid);
    await answer(res.toast);
    if (msg) {
      const ev = await renderEvening(ctx, user);
      if (ev) await tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text: ev.text, reply_markup: ev.keyboard });
    }
    return;
  }

  // Очистить выполненное: X:ask спросить · X:ok удалить · X:no отмена
  m = data.match(/^X:(ask|ok|no)$/);
  if (m) {
    await answer('');
    const edit = (text, kb) => msg && tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text, ...(kb ? { reply_markup: kb } : {}) });
    if (m[1] === 'no') return edit('Ок, ничего не удаляю 👌');
    if (m[1] === 'ask') {
      const n = (await myDoneTasks(ctx, uid, 1000)).length;
      if (!n) return edit('Выполненных задач нет 🙂');
      return edit(`🧹 Убрать из списка все выполненные задачи (${n})?\n\n<i>Свои удалятся насовсем. Задачи, которые тебе поставили другие, просто пропадут из твоего списка — у их авторов останутся.</i>`, CLEAR_ASK);
    }
    const n = await clearDone(ctx, uid);
    return edit(`🧹 Готово — убрано выполненных задач: ${n}`);
  }

  // Доска в чате: B:v:<вид>:<страница> · B:o:<id> открыть задачу · B:pl проекты · B:n
  m = data.match(/^B:(v|o|pl|n)(?::(\w+))?(?::(\d+))?$/);
  if (m) {
    await answer('');
    if (m[1] === 'n') return;
    if (m[1] === 'o') {
      const t = await getTask(ctx, +m[2]);
      return t && canAccess(ctx, t, uid) ? sendCard(ctx, uid, t) : send(env, uid, lostTask(t));
    }
    if (!msg) return;
    if (m[1] === 'pl') {
      if (!myProjects(ctx, uid).length) return tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Проектов пока нет' });
      return tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text: '🗂 <b>Доска · какой проект открыть?</b>', reply_markup: projectsPickKeyboard(ctx, uid) });
    }
    const bd = await renderChatBoard(ctx, user, m[2] || 'today', +(m[3] || 0));
    return tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text: bd.text, reply_markup: bd.keyboard, link_preview_options: { is_disabled: true } });
  }

  // Настройки: O:menu · O:<раздел> — подменю · O:<ключ>:<значение> · O:<ключ>:x — «✏️ Своё» · O:m|e|w|r — переключить · O:n1|n0 — номер задачи
  m = data.match(/^O:(menu|n[01]|[mewr]|[lcgdnqv](?::([\d,]+|\d{4}-\d{4}|off|x|w))?)$/);
  if (m) {
    const show = async (sub, toast = '') => {
      await answer(toast);
      const v = settingsView(ctx, user, sub);
      return msg ? tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text: v.text, reply_markup: v.reply_markup })
        : send(env, uid, v.text, { reply_markup: v.reply_markup });
    };
    const k = m[1], val = m[2];
    if (k === 'menu') return show(null);
    if (k === 'n1' || k === 'n0') { setIdFirst(ctx, user, k === 'n1'); return show(null, k === 'n1' ? 'Номера — в начале строки' : 'Номера — в конце строки'); }
    if (/^[mewr]$/.test(k)) {
      setPref(user, k, null);
      if (k === 'r') ctx.dash.add(uid);
      return show(null, 'Сохранено');
    }
    if (val === 'x' && CUSTOM_ASK[k[0]]) {
      await answer('');
      user.data.awaiting = { kind: 'pref', key: k[0], msg: msg && msg.message_id, at: realNowMs(env) }; user.dirty = true;
      return send(env, uid, CUSTOM_ASK[k[0]], { reply_markup: { inline_keyboard: [[{ text: '✖ Отмена', callback_data: 'O:menu' }]] } });
    }
    if (k[0] === 'v' && val !== undefined) {
      const now = ctx.now;
      const till = val === 'off' ? null : val === 'w' ? addDays(now.date, (7 - weekday(now.date)) % 7) : /^\d+$/.test(val) ? addDays(now.date, +val - 1) : undefined;
      if (till === undefined) return show(null, 'Такой настройки нет');
      setAway(ctx, user, till);
      return show(null, till ? `🏖 Отпуск по ${fmtDay(till, now)} включительно` : '🔔 С возвращением! Напоминания снова включены');
    }
    if (val !== undefined) {
      if (!setPref(user, k[0], val)) return show(null, 'Такой настройки нет');
      return show(null, 'Сохранено');
    }
    return show(k);
  }

  // График: S:f:<ЧЧММ> начало · S:t:<ЧЧММ> конец · S:w:<1|0> выходные · S:later · S:o открыть
  m = data.match(/^S:(f|t|w|later|o)(?::(\d{1,4}))?$/);
  if (m) {
    await answer('');
    const b = (text, d) => ({ text, callback_data: d });
    const edit = (text, kb) => msg && tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text, ...(kb ? { reply_markup: kb } : {}) });
    user.data.schedAsked = 1; user.dirty = true;
    if (m[1] === 'o') return askSchedule(ctx, user);
    if (m[1] === 'later') return edit('Хорошо 👌 Пока работаю по общему расписанию. Настроить график в любой момент: /schedule');
    const t4 = x => `${x.slice(0, 2)}:${x.slice(2, 4)}`;
    if (m[1] === 'f') {
      const from = t4(m[2].padStart(4, '0'));
      user.data.schedDraft = { from };
      const f = toMin(from);
      const ends = [6, 7, 8, 9, 10, 11].map(h => f + h * 60).filter(x => x <= 23 * 60 + 30).map(hm);
      const rows = [];
      for (let i = 0; i < ends.length; i += 3) rows.push(ends.slice(i, i + 3).map(x => b(x, 'S:t:' + x.replace(':', ''))));
      return edit(`🕘 Начало — <b>${from}</b>.\n\n<b>А во сколько заканчивается рабочий день?</b>`, { inline_keyboard: rows });
    }
    const dr = user.data.schedDraft;
    if (!dr || !dr.from) return askSchedule(ctx, user, msg);
    if (m[1] === 't') {
      dr.to = t4(m[2].padStart(4, '0'));
      return edit(`🕘 График <b>${dr.from}–${dr.to}</b>.\n\n<b>Выходные?</b>`, { inline_keyboard: [
        [b('Пн–Пт, праздники — выходные', 'S:w:1')],
        [b('Работаю и в выходные', 'S:w:0')],
      ] });
    }
    if (!dr.to) return askSchedule(ctx, user, msg);
    user.data.sched = { from: dr.from, to: dr.to, wk: m[2] === '1' };
    delete user.data.schedDraft;
    return edit('✅ <b>График сохранён</b>\n\n' + schedSummary(env, user) + '\n\n<i>Поменять: /schedule или напиши, например, <code>график 10-19</code></i>');
  }

  // Встречи: M:p:<h> подготовить · M:t:<h> выбрать готовую задачу · M:l:<h>:<id> привязать её · M:a:<h> итоги
  // · M:o:<id> открыть задачу · M:r обновить · M:off · M:x
  m = data.match(/^M:(p|a|o|r|off|x|t|l)(?::(\w+))?(?::(\d+))?$/);
  if (m) {
    await answer('');
    const edit = text => msg && tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text });
    if (m[1] === 'x') { delete user.data.awaiting; user.dirty = true; return edit('Ок 👌'); }
    if (m[1] === 'off') {
      delete user.data.cal; user.dirty = true;
      await DB(ctx).prepare('DELETE FROM events WHERE user_id = ?').bind(uid).run();
      return edit('🔌 Календарь отключён. Подключить снова — кнопка «📅 Встречи».');
    }
    if (m[1] === 'r') {
      const r = await refreshUserCalendar(ctx, user);
      if (r.error) return send(env, uid, `😕 Не получилось обновить календарь: ${esc(r.error)}`);
      return sendMeetings(ctx, user);
    }
    if (m[1] === 'o') {
      const t = await getTask(ctx, +m[2]);
      return t && canAccess(ctx, t, uid) ? sendCard(ctx, uid, t) : send(env, uid, lostTask(t));
    }
    const e = await eventByKey(ctx, uid, m[2]);
    if (!e) return send(env, uid, 'Не нашёл эту встречу — возможно, календарь обновился. Открой «📅 Встречи».');
    if (m[1] === 'p') return askPrep(ctx, user, e);
    if (m[1] === 't') { delete user.data.awaiting; user.dirty = true; return pickTaskForMeeting(ctx, user, e, msg); }
    if (m[1] === 'l') {
      const t = await getTask(ctx, +m[3]);
      if (!t || !canAccess(ctx, t, uid)) return send(env, uid, lostTask(t));
      const note = linkToMeeting(t, e, ctx.now);
      await saveTask(ctx, t); touch(ctx, t);
      if (msg) await edit(`✅ ${esc(note)}\n\n• ${esc(t.title)}  /t${t.id}`);
      return;
    }
    user.data.awaiting = { kind: 'after', h: e.h, title: e.title, at: realNowMs(env) }; user.dirty = true;
    return send(env, uid, `🗒 Что сделать по итогам «<b>${esc(e.title)}</b>»?\n\nКаждая строка станет отдельной задачей, срок можно писать прямо в строке:\n<code>- отправить протокол до пятницы\n- созвониться с Олегом завтра в 11:00</code>`, {
      reply_markup: { inline_keyboard: [[{ text: '✖ Отмена', callback_data: 'M:x' }]] },
    });
  }

  // Вечер: E:all — всё несделанное на завтра, E:undo — вернуть
  m = data.match(/^E:(all|undo)$/);
  if (m) {
    if (m[1] === 'undo') {
      const n = await bulkUndo(ctx, user);
      await answer(n ? `↩️ Сроки возвращены: ${n}` : 'Нечего возвращать');
      if (msg) await tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, text: n ? `↩️ Сроки возвращены как были: ${n}` : 'Нечего возвращать' });
      return;
    }
    const date = addDays(ctx.now.date, 1);
    const { moved } = await bulkMove(ctx, user, date);
    await answer(moved.length ? `⏩ Перенесено: ${moved.length}` : 'Переносить нечего — всё сделано 🎉');
    if (msg && moved.length) {
      await tg(env, 'editMessageText', {
        chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text: bulkReport(ctx, moved, date),
        reply_markup: { inline_keyboard: [[{ text: '↩️ Вернуть как было', callback_data: 'E:undo' }]] },
      });
    }
    return;
  }
  // «Жду ответа»: W:<id>:wx (пришёл) | W:<id>:w3 (подождать)
  m = data.match(/^W:(\d+):(wx|w3|wask)$/);
  if (m) {
    const t = await getTask(ctx, +m[1]);
    if (!t || !canAccess(ctx, t, uid)) return answer(lostTask(t));
    if (m[2] === 'wask') { await answer(''); return askWaitDate(ctx, user, t); }
    const res = await applyAction(ctx, t, m[2], uid);
    await answer(res.toast);
    if (msg && msg.reply_markup) {
      const kb = msg.reply_markup.inline_keyboard.filter(r => !r.some(x => x.callback_data && x.callback_data.startsWith(`W:${t.id}:`)));
      await tg(env, 'editMessageReplyMarkup', { chat_id: uid, message_id: msg.message_id, reply_markup: { inline_keyboard: kb } });
    }
    if (m[2] === 'wx') await sendCard(ctx, uid, t, '✅ Ответ получен — задача снова в работе\n\n');
    return;
  }

  // «Не отстану»: n:<id>:done | n:<id>:s1h | n:0:mute
  m = data.match(/^n:(\d+):(done|s1h|mute)$/);
  if (m) {
    if (m[2] === 'mute') {
      user.data.nagMute = ctx.now.date; user.dirty = true;
      await answer('🔕 Сегодня больше не напоминаю');
      if (msg) await tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, text: '🔕 Ок, сегодня больше не напоминаю. Завтра продолжу.' });
      return;
    }
    const t = await getTask(ctx, +m[1]);
    if (!t || !canAccess(ctx, t, uid)) return answer(lostTask(t));
    const res = t.done ? { toast: 'Уже выполнено' } : await applyAction(ctx, t, m[2], uid);
    await answer(res.toast);
    if (msg) {
      const nag = renderNag(ctx, user, await myOpenTasks(ctx, uid), schedOf(env, user).slots);
      if (nag) await tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text: nag.text, reply_markup: nag.keyboard });
      else await tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, text: '✅ Всё, что горело, разобрано — молодец!' });
    }
    return;
  }

  // «Перенести … на …?» — D:y / D:n
  m = data.match(/^D:(y|n)$/);
  if (m) {
    await answer('');
    const pd = user.data.pendingDue;
    delete user.data.pendingDue; user.dirty = true;
    const edit = text => msg && tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text });
    if (m[1] === 'n' || !pd) return edit(m[1] === 'n' ? 'Ок, ничего не меняю 👌' : 'Это меню устарело.');
    const t = await getTask(ctx, pd.id);
    if (!t || !canAccess(ctx, t, uid)) return edit(lostTask(t));
    await edit(`👌 ${esc(t.title)}`);
    return applyTypedDue(ctx, user, t, { due: pd.due, ambig: pd.ambig });
  }

  // проекты: P:new, P:cancel, P:v<id> (задачи), P:i<id> (позвать)
  m = data.match(/^P:(new|cancel|no|[vidkxlr]\d+)$/);
  if (m) {
    await answer('');
    const edit = text => msg && tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text });
    if (m[1] === 'new') return askProjectName(ctx, user);
    if (m[1] === 'cancel') {
      const renaming = user.data.awaiting && user.data.awaiting.kind === 'prename';
      delete user.data.awaiting; user.dirty = true;
      return edit(renaming ? 'Ок, название не меняю 👌' : 'Ок, не создаю 👌');
    }
    if (m[1] === 'no') return edit('Ок, проект остаётся 👌');
    const kind = m[1][0];
    const p = ctx.projects.get(+m[1].slice(1));
    if (!p || !p.members.has(uid)) return send(env, uid, 'Такого проекта нет.');
    if (kind === 'v') return send(env, uid, await renderProject(ctx, uid, p), { reply_markup: projectKeyboard(p, uid) });
    if (kind === 'i') return sendInvite(ctx, user, p);
    if (kind === 'r') return askProjectRename(ctx, user, p);
    if (kind === 'd') return askDeleteProject(ctx, user, p);
    if (kind === 'l') {
      await leaveProject(ctx, p, uid);
      ctx.dash.add(uid);
      return edit(`Ты больше не в проекте «${esc(p.name)}».`);
    }
    // k — удалить, задачи оставить; x — удалить вместе с задачами
    if (p.owner !== uid) return edit('Удалить проект может только его создатель.');
    const others = [...p.members].filter(id => id !== uid);
    const n = await deleteProject(ctx, p, kind === 'k');
    for (const id of others) await send(env, id, `🗑 <b>${esc(user.name)}</b> удалил(а) проект «${esc(p.name)}».` + (kind === 'k' ? ' Задачи из него остались в списках.' : ''));
    return edit(`🗑 Проект «${esc(p.name)}» удалён.` + (n ? (kind === 'k' ? ' Задачи остались и стали личными.' : ` Удалено задач: ${n}.`) : ''));
  }

  // выбор задачи для «удали / сделала / перенеси»
  m = data.match(/^k:(\d+|new|no|list)$/);
  if (m) {
    await answer('');
    const pend = user.data.pending;
    const edit = text => msg && tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text });
    if (m[1] === 'list') return handleCommand(ctx, user, '/list', '', null);
    if (m[1] === 'no') { delete user.data.pending; user.dirty = true; return edit('Ок, ничего не меняю 👌'); }
    if (!pend) return edit('Это меню устарело — напиши ещё раз.');
    delete user.data.pending; user.dirty = true;
    if (m[1] === 'new') {
      await edit('➕ Записываю как новую задачу');
      const r = await createFromText(ctx, user, pend.text, {});
      if (r.error) await send(env, uid, r.error);
      return;
    }
    const t = await getTask(ctx, +m[1]);
    if (!t || !canAccess(ctx, t, uid)) return edit(lostTask(t));
    await edit(`👌 ${esc(t.title)}`);
    return performIntent(ctx, user, pend.act, t, pend.due);
  }
  m = data.match(/^r:(\d+)$/);
  if (m) {
    await answer('');
    if (msg) await tg(env, 'editMessageReplyMarkup', { chat_id: uid, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
    return restoreTask(ctx, user, +m[1]);
  }

  m = data.match(/^a:(\d+):(\w+)$/);
  const t = m && await getTask(ctx, +m[1]);
  if (!t || !canAccess(ctx, t, uid)) return answer(lostTask(t));
  user.data.lastTask = { id: t.id, at: realNowMs(env) }; user.dirty = true;
  if (m[2] === 'due' || m[2] === 'dueask') {
    user.data.awaiting = { kind: 'due', taskId: t.id, at: realNowMs(env) };
  }
  if (m[2] === 'wask') { await answer(''); return askWaitDate(ctx, user, t); }
  if (m[2] === 'stask') {
    user.data.awaiting = { kind: 'start', taskId: t.id, at: realNowMs(env) };
    await answer('');
    return send(env, uid, `▶️ Когда начать «<b>${esc(t.title)}</b>»? Напиши дату, например:\n<code>в среду</code> · <code>завтра</code> · <code>12 октября</code>`);
  }
  if (m[2] === 'files') {
    await answer('');
    for (const f of (t.files || []).slice(0, 10)) {
      const method = { photo: 'sendPhoto', video: 'sendVideo', audio: 'sendAudio' }[f.type] || 'sendDocument';
      const field = { photo: 'photo', video: 'video', audio: 'audio' }[f.type] || 'document';
      await tg(env, method, { chat_id: uid, [field]: f.id, caption: short(`📎 к задаче «${t.title}»`, 200) });
    }
    return;
  }
  if (m[2] === 'edtx') { await answer(''); return askDetailsEdit(ctx, user, t); }
  if (m[2] === 'edti') { await answer(''); return askTitleEdit(ctx, user, t); }
  if (m[2] === 'tno') {
    if (user.data.awaiting && user.data.awaiting.kind === 'title') { delete user.data.awaiting; user.dirty = true; }
    await answer('');
    return msg && tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, text: 'Ок, название не меняю 👌' });
  }
  if (m[2] === 'dno') {
    if (user.data.awaiting && user.data.awaiting.kind === 'details') { delete user.data.awaiting; user.dirty = true; }
    await answer('');
    return msg && tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, text: 'Ок, подробности не меняю 👌' });
  }
  if (m[2] === 'dueask') {
    await answer('');
    return send(env, uid, `✏️ Напиши новый срок для «<b>${esc(t.title)}</b>» одним сообщением, например:\n<code>7 октября 15:00</code> · <code>в пятницу</code> · <code>завтра в 10.30</code> · <code>через 2 недели</code>`);
  }
  if (m[2] === 'pnew') {
    if (t.owner !== uid) return answer('Менять проект может только автор задачи');
    await answer('');
    return askProjectName(ctx, user, t.id);
  }
  const hadSnooze = !!(msg && msg.reply_markup && JSON.stringify(msg.reply_markup).includes(':s1h'));
  const res = await applyAction(ctx, t, m[2], uid);
  await answer(res.toast);
  if (!msg) return;
  if (res.hidden) {
    return tg(env, 'editMessageText', { chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text: `✅ <s>${esc(t.title)}</s> — убрано из списка выполненных` });
  }
  if (res.deleted) {
    user.data.trash = { ...t }; user.dirty = true;
    return tg(env, 'editMessageText', {
      chat_id: uid, message_id: msg.message_id, parse_mode: 'HTML', text: `🗑 <s>${esc(t.title)}</s> — удалено`,
      reply_markup: { inline_keyboard: [[{ text: '↩️ Восстановить', callback_data: `r:${t.id}` }]] },
    });
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
  env = wrapEnv(env);
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
  if (user.data.blocked) { delete user.data.blocked; user.dirty = true; }

  try {
    if (cq) await handleCallback(ctx, user, cq);
    else await handleMessage(ctx, user, msg);
    if (user.data.kbv !== KB_VERSION && origin) {
      // меню внизу чата: присылаем само, без /start
      user.data.kbv = KB_VERSION; user.dirty = true;
      await send(env, user.id, '📌 Меню всегда внизу: задачи, главное, проекты, доска и помощь 👇\n<i>Если пропадёт — нажми значок ⌘ / ▦ рядом с полем ввода.</i>', { reply_markup: mainKeyboard(ctx) });
    }
    if (!user.data.sched && !user.data.schedAsked && origin && msg) {
      // один раз спрашиваем рабочий график: у всех разное начало и конец дня
      user.data.schedAsked = 1; user.dirty = true;
      await askSchedule(ctx, user);
    }
  } catch (e) {
    // что бы ни случилось — человек не остаётся без ответа, а кнопка не «крутится»
    console.error('handle', e && e.stack);
    if (cq) await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: '😕 Не получилось. Попробуй ещё раз' });
    else await send(env, user.id, '😕 Что-то пошло не так, и я не смог это обработать. Попробуй ещё раз — если повторится, напиши /status.');
  }
  await flush(ctx);
}

// ── Сводки и напоминания (Cron) ──

const tz = env => env.TIMEZONE || 'Europe/Moscow';
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const inWindow = (nowTime, at) => { const d = toMin(nowTime) - toMin(at); return d >= 0 && d < 180; };

async function sendMorning(ctx, user, mine, manual = false) {
  const now = ctx.now;
  if (!mine.length && !user.data.cal) {
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
  const waitN = mine.filter(t => t.waiting).length;
  if (waitN) s += `\n⏳ <i>Ждёшь ответа по задачам: ${waitN}</i>`;
  if (user.data.cal) {
    const evs = (await userEvents(ctx, user.id, now.date, now.date)).filter(e => e.start.time);
    if (evs.length) s += '\n\n<b>📅 Встречи сегодня</b>\n' + evs.map(e => meetingLine(e, now, mine)).join('\n');
  }
  const cands = focusCandidates(ctx, mine);
  if (cands.length) s += '\n\n⭐ <b>Выбери до 3 главных задач на сегодня</b> — они встанут наверх списка:';
  await send(ctx.env, user.id, clip(s), cands.length ? { reply_markup: focusKeyboard(ctx, user, cands) } : {});
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
  const movable = bulkCandidates(mine, now);
  if (movable.length) keyboard.inline_keyboard.push([{ text: `⏩ Всё несделанное — на завтра (${movable.length})`, callback_data: 'E:all' }]);
  const left = renderGroups(ctx, others, user.id, ['overdue', 'today']);
  const tomorrow = renderGroups(ctx, others, user.id, ['tomorrow']);
  if (left) s += '\nЕщё не закрыто — отметь сделанное или перенеси:\n\n' + left + '\n';
  if (tomorrow) s += '\n' + tomorrow;
  if (!fIds.length && !left && !tomorrow) return null;
  return { text: clip(s), keyboard };
}

// Что можно разом перенести: срок сегодня или раньше, не сделано, не «жду ответа»
function bulkCandidates(mine, now) {
  return mine.filter(t => !t.done && !t.waiting && t.due && t.due.date <= now.date &&
    !(t.repeat && (t.history || []).includes(now.date)));
}

async function bulkMove(ctx, user, date) {
  const now = ctx.now;
  const mine = (await myOpenTasks(ctx, user.id)).filter(t => t.assignee === user.id);
  const list = bulkCandidates(mine, now);
  if (!list.length) return { moved: [] };
  user.data.lastBulk = { at: now.date, items: list.map(t => ({ id: t.id, due: t.due })) }; user.dirty = true;
  for (const t of list) {
    setDue(t, { date, time: t.due.time });
    await saveTask(ctx, t); touch(ctx, t);
    if (t.owner !== user.id) notifyOthers(ctx, t, user.id, `📅 <b>${esc(user.name)}</b>: срок теперь ${fmtDue(t.due, now)}\n\n`);
  }
  return { moved: list };
}

function bulkReport(ctx, moved, date) {
  return `⏩ Перенесено на ${fmtDate(date, ctx.now)}: ${moved.length}\n\n` + moved.slice(0, 15).map(t => `• ${esc(t.title)}`).join('\n') +
    (moved.length > 15 ? '\n…' : '');
}

async function bulkUndo(ctx, user) {
  const lb = user.data.lastBulk;
  if (!lb) return 0;
  let n = 0;
  for (const it of lb.items) {
    const t = await getTask(ctx, it.id);
    if (!t || t.done) continue;
    setDue(t, it.due); await saveTask(ctx, t); touch(ctx, t); n++;
  }
  delete user.data.lastBulk; user.dirty = true;
  return n;
}

// «Жду ответа»: утром спрашиваем по тем, где подошёл срок
async function sendWaitingCheck(ctx, user, mine) {
  const now = ctx.now;
  const due = mine.filter(t => t.waiting && t.waiting.check <= now.date).slice(0, 5);
  if (!due.length) return;
  let s = '⏳ <b>Пришёл ли ответ?</b>\n';
  const rows = [];
  for (const t of due) {
    s += `\n• ${esc(t.title)} <i>— ждёшь с ${fmtDate(t.waiting.since, now)}</i>`;
    rows.push([{ text: `✅ Пришёл: ${short(t.title, 20)}`, callback_data: `W:${t.id}:wx` }, { text: '⏳ +3 дня', callback_data: `W:${t.id}:w3` },
      { text: '✏️ Другой день', callback_data: `W:${t.id}:wask` }]);
    t.waiting.check = addDays(now.date, 1); // не ответил — спрошу завтра снова
    await saveTask(ctx, t);
  }
  s += `\n\nЕсли нужно напомнить человеку — скопируй и отправь:\n<code>Добрый день! Напоминаю про «${esc(due[0].title.replace(/^(?:жду|ждём|ждем|ожидаю)\s+/i, ''))}». Подскажите, пожалуйста, есть новости?</code>`;
  await send(ctx.env, user.id, clip(s), { reply_markup: { inline_keyboard: rows } });
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
  // одна задача в день — чтобы утро не превращалось в поток сообщений
  const t = mine.filter(x => !x.due && !x.repeat && (x.createdAt || now.date) <= border && (!x.reviewedAt || x.reviewedAt <= border))
    .sort((a, b) => a.id - b.id)[0];
  if (!t) return;
  const r = await send(ctx.env, user.id, '🧹 <b>Лежит без срока больше двух недель. Ещё актуально?</b>\n\n' + renderCard(ctx, t), { reply_markup: cardKeyboard(ctx, t, user.id, 'stale') });
  if (r.ok) await rememberMsg(ctx, user.id, r.result.message_id, t.id);
}

// Что сейчас «горит» у человека и включено «Не отстану»
function nagDue(ctx, t, uid, daySlots) {
  const now = ctx.now;
  if (t.done || t.assignee !== uid || !isNagOn(t) || !t.due || t.waiting) return false;
  if (t.remindAt && stamp(now.date, now.time) < stamp(t.remindAt.date, t.remindAt.time)) return false; // отложено
  if (isOverdue(t, now)) return true;
  if (t.due.date !== now.date) return false;
  return t.due.time ? t.due.time <= now.time : now.time >= (daySlots[0] || '12:00');
}

function renderNag(ctx, user, tasks, daySlots) {
  const list = sortTasks(tasks.filter(t => nagDue(ctx, t, user.id, daySlots)));
  if (!list.length) return null;
  const show = list.slice(0, 5);
  let text = '🔔 <b>Не отстану — это ещё не сделано:</b>\n' +
    show.map(t => `• ${esc(t.title)} <i>· ${isOverdue(t, ctx.now) ? 'просрочено, ' : ''}${fmtDue(t.due, ctx.now)}</i>`).join('\n');
  if (list.length > show.length) text += `\n… и ещё ${list.length - show.length}`;
  text += `\n\n<i>Напомню снова ${{ 30: 'через полчаса', 60: 'через час', 120: 'через 2 часа' }[nagMin(ctx.env, user)] || `через ${nagMin(ctx.env, user)} мин`}. Сделано — жми ✅, не сейчас — ⏰.</i>`;
  const rows = show.map(t => [
    { text: `✅ ${short(t.title, 26)}`, callback_data: `n:${t.id}:done` },
    { text: '⏰ +1 час', callback_data: `n:${t.id}:s1h` },
  ]);
  rows.push([{ text: '🔕 Сегодня больше не напоминать', callback_data: 'n:0:mute' }]);
  return { text, keyboard: { inline_keyboard: rows } };
}

// ── Рабочий график: у каждого свой ──
// Из начала и конца рабочего дня получаются все времена: план дня — в начале, «задачи на сегодня» —
// через 3 часа после начала и за час до конца, сверка — за 30 минут до конца, «не отстану» — только в рабочие часы.
const hm = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
// Личные настройки (user.data.prefs): m/e/w = 0 — выключить план дня / сверку / итоги недели;
// day: 1 — «на сегодня» напоминать один раз, 0 — не напоминать; lead — за сколько минут до срока (0 — не надо);
// meet — напоминания о встречах ('60,15,0' | '15,0' | '0' | 'off'); nag — «не отстану» раз в N минут; mix — регулярные вместе с разовыми
const NAG_WORDS = { 30: 'каждые полчаса', 60: 'каждый час', 120: 'каждые 2 часа' };
const nagMin = (env, user) => prefsOf(user).nag || +(env.NAG_EVERY || 30);
const nagWord = (user, env = {}) => NAG_WORDS[nagMin(env, user)] || `каждые ${nagMin(env, user)} мин`;
const leadOf = user => (prefsOf(user).lead ?? 60);
// «45 мин», «1 час», «1 ч 30 мин», «3 часа»
function fmtMinutes(n) {
  if (n < 60 || n % 60 && n < 120) return n < 60 ? `${n} мин` : `1 ч ${n - 60} мин`;
  if (n % 60) return `${Math.floor(n / 60)} ч ${n % 60} мин`;
  const h = n / 60;
  return `${h} ${h % 10 === 1 && h % 100 !== 11 ? 'час' : [2, 3, 4].includes(h % 10) && ![12, 13, 14].includes(h % 100) ? 'часа' : 'часов'}`;
}
const fmtLead = fmtMinutes;
// тихие часы ('13:00-14:00', можно через полночь) и отпуск (последний день) — автоматические сообщения не приходят
function inQuiet(user, time) {
  const q = prefsOf(user).quiet;
  if (!q) return false;
  const [f, t] = q.split('-');
  return f <= t ? time >= f && time < t : time >= f || time < t;
}
const awayTill = (user, now) => (user && user.data && user.data.away && user.data.away >= now.date ? user.data.away : null);
const paused = (user, now) => !!(awayTill(user, now) || inQuiet(user, now.time));
// «Анна в отпуске до 20.10» — тому, кто ставит ей задачу
function awayNote(ctx, uids) {
  const out = uids.map(id => ctx.users.get(id)).filter(u => awayTill(u, ctx.now));
  return out.map(u => `🏖 ${esc(u.name)} в отпуске по ${fmtDay(u.data.away, ctx.now)} включительно — задачу увидит, но напоминаний до возвращения не будет`);
}
// «за 10 мин», «1,5 часа», «2 ч», «90» → минуты
function parseMinutes(text) {
  const t = String(text).toLowerCase().replace(',', '.').trim();
  const h = t.match(/^(?:за\s+|каждые\s+|раз\s+в\s+)?(\d+(?:\.\d+)?)?\s*(?:ч|час|часа|часов)\b(?:\s*(\d+)\s*(?:м|мин|минут[уы]?)?)?/u);
  if (h) return Math.round((h[1] ? +h[1] : 1) * 60 + (h[2] ? +h[2] : 0));
  if (/^(?:за\s+|каждые\s+|раз\s+в\s+)?полчаса/u.test(t)) return 30;
  const m = t.match(/^(?:за\s+|каждые\s+|раз\s+в\s+)?(\d+)\s*(?:м|мин|минут[уы]?)?\.?$/u);
  return m ? +m[1] : null;
}
const prefsOf = user => (user && user.data && user.data.prefs) || {};
function schedOf(env, user) {
  const sc = baseSched(env, user), pr = prefsOf(user);
  if (pr.m === 0) sc.morning = 'off';
  if (pr.e === 0) sc.evening = 'off';
  if (pr.w === 0) sc.weekly = 'off';
  if (pr.day === 0) sc.slots = [];
  else if (pr.day === 1) sc.slots = sc.slots.slice(0, 1);
  return sc;
}
function baseSched(env, user) {
  const s = user && user.data && user.data.sched;
  if (!s) {
    return {
      custom: false, morning: env.MORNING_AT || '09:00', evening: env.EVENING_AT || '20:00', weekly: env.WEEKLY_AT || '19:00',
      slots: dayRemindSlots(env), nagFrom: env.NAG_FROM || '09:00', nagTo: env.NAG_TO || '21:00', workOnly: false,
    };
  }
  const f = toMin(s.from), t = toMin(s.to);
  const evening = hm(Math.max(f + 60, t - 30));
  const slots = [...new Set([hm(Math.min(f + 180, t - 60)), hm(t - 60)])].filter(x => toMin(x) > f).sort();
  return { custom: true, from: s.from, to: s.to, morning: s.from, evening, weekly: evening, slots, nagFrom: s.from, nagTo: s.to, workOnly: !!s.wk };
}
// сегодня этот человек не работает (выходной или праздник по производственному календарю)
const dayOff = (sc, date) => sc.workOnly && !isWorkDay(date);
// итоги недели: у кого график — в последний рабочий день недели; у остальных — в воскресенье
function weeklyToday(sc, date) {
  if (!sc.custom) return weekday(date) === 0;
  if (sc.workOnly) {
    if (!isWorkDay(date)) return false;
    for (let d = addDays(date, 1); weekday(d) !== 1; d = addDays(d, 1)) if (isWorkDay(d)) return false;
    return true;
  }
  return weekday(date) === 0;
}
// ── Личные настройки: всё кнопками, у каждого своё ──
const MEET_OPTS = [['60,15,0', 'за час, за 15 мин и в начале'], ['15,0', 'за 15 мин и в начале'], ['0', 'только в начале'], ['off', 'не напоминать']];
const LEAD_OPTS = [[120, 'за 2 часа'], [60, 'за 1 час'], [30, 'за 30 мин'], [15, 'за 15 мин'], [0, 'не напоминать']];
const NAG_OPTS = [[30, 'каждые полчаса'], [60, 'каждый час'], [120, 'каждые 2 часа']];
const DAY_OPTS = [[2, 'два раза'], [1, 'один раз'], [0, 'не напоминать']];
const QUIET_OPTS = [['1200-1300', '12:00–13:00'], ['1300-1400', '13:00–14:00'], ['1400-1500', '14:00–15:00']];
const leadLabel = n => (n ? `за ${fmtMinutes(n)}` : 'не напоминать');
const nagLabel = n => ({ 30: 'каждые полчаса', 60: 'каждый час' })[n] || `каждые ${fmtMinutes(n)}`;
function meetLabel(v) {
  const preset = MEET_OPTS.find(([x]) => x === v);
  if (preset) return preset[1];
  const ns = v.split(',').map(Number).sort((a, b) => b - a);
  const parts = ns.map(n => (n ? `за ${n === 60 ? 'час' : fmtMinutes(n)}` : 'в начале'));
  return parts.length > 1 ? parts.slice(0, -1).join(', ') + ' и ' + parts.at(-1) : parts[0];
}
const quietLabel = q => (q ? q.replace('-', '–') : 'нет');
// что писать текстом для «✏️ Своё»
const CUSTOM_ASK = {
  l: '⏰ <b>За сколько напоминать до срока?</b> Напиши, например: <code>10</code> · <code>45 мин</code> · <code>1,5 часа</code> · <code>3 часа</code>',
  g: '🔔 <b>Как часто напоминать «не отстану»?</b> Напиши, например: <code>15</code> · <code>45 мин</code> · <code>3 часа</code>',
  c: '📅 <b>За сколько напоминать о встрече?</b> Напиши минуты через запятую, например: <code>10</code> · <code>30, 5</code> · <code>2 часа, 10</code>. В момент начала напомню тоже.',
  q: '🤫 <b>Тихие часы.</b> Напиши время, например: <code>13:30-14:30</code> · <code>13-14</code> · <code>22-8</code> (через полночь)',
  v: '🏖 <b>До какого дня отпуск</b> (включительно)? Напиши, например: <code>20.10</code> · <code>до пятницы</code> · <code>через 2 недели</code>',
};
function settingsView(ctx, user, sub = null) {
  const env = ctx.env, pr = prefsOf(user), now = ctx.now;
  const base = baseSched(env, user);
  const b = (t, d) => ({ text: t, callback_data: d });
  const pick = (opts, cur, key) => opts.map(([v, label]) => [b((String(v) === String(cur) ? '✓ ' : '') + label, `O:${key}:${v}`)]);
  const own = (key, cur, opts) => [b((opts.some(([v]) => String(v) === String(cur)) ? '' : '✓ ') + '✏️ Своё' + (opts.some(([v]) => String(v) === String(cur)) ? '…' : ': ' + cur), `O:${key}:x`)];
  const back = [b('← Все настройки', 'O:menu')];
  const meet = pr.meet || '60,15,0', lead = leadOf(user), nag = nagMin(env, user), day = pr.day ?? 2;
  const first = !!user.data.idFirst;
  const away = awayTill(user, now);
  const label = (opts, v) => (opts.find(([x]) => String(x) === String(v)) || [0, String(v)])[1];
  if (sub === 'l') return { text: '⏰ <b>Напоминание до срока</b>\n\nЗа сколько предупреждать о задаче с точным временем («позвонить в 15:00»)? В сам срок «⏰ Время пришло!» приходит всегда.', reply_markup: { inline_keyboard: [...pick(LEAD_OPTS, lead, 'l'), own('l', leadLabel(lead), LEAD_OPTS.map(([v]) => [leadLabel(v)])), back] } };
  if (sub === 'c') return { text: '📅 <b>Напоминания о встречах</b> из календаря\n\nКогда напоминать о встрече?' + (user.data.cal ? '' : '\n\n<i>Календарь пока не подключён: /calendar</i>'), reply_markup: { inline_keyboard: [...pick(MEET_OPTS, meet, 'c'), own('c', meetLabel(meet), MEET_OPTS.map(([v]) => [meetLabel(v)])), back] } };
  if (sub === 'g') return { text: '🔔 <b>«Не отстану»</b>\n\nКак часто напоминать о важной задаче, пока она не сделана? (только в рабочие часы)', reply_markup: { inline_keyboard: [...pick(NAG_OPTS, nag, 'g'), own('g', nagLabel(nag), NAG_OPTS.map(([v]) => [nagLabel(v)])), back] } };
  if (sub === 'd') return { text: `📍 <b>Задачи «на сегодня» без времени</b>\n\nСколько раз за день напомнить? Два раза — в ${base.slots.join(' и ')}; один раз — в ${base.slots[0] || '—'}.`, reply_markup: { inline_keyboard: [...pick(DAY_OPTS, day, 'd'), back] } };
  if (sub === 'n') return { text: '🔢 <b>Номер задачи в списках</b>\n\nВ начале:\n• /t12 Позвонить в банк <i>· 15:00</i>\n\nВ конце:\n• Позвонить в банк <i>· 15:00</i>  /t12', reply_markup: { inline_keyboard: [[b((first ? '✓ ' : '') + 'В начале', 'O:n1')], [b((first ? '' : '✓ ') + 'В конце', 'O:n0')], back] } };
  if (sub === 'q') {
    const cur = pr.quiet ? pr.quiet.replace(/:/g, '') : null;
    const isPreset = QUIET_OPTS.some(([v]) => v === cur);
    return { text: '🤫 <b>Тихие часы</b>\n\nВ это время я ничего не присылаю сам: ни напоминаний, ни «не отстану», ни встреч. Всё, что выпало на тихие часы, придёт сразу после них. На твои сообщения и кнопки отвечаю как обычно.' + (pr.quiet ? `\n\nСейчас: <b>${quietLabel(pr.quiet)}</b>` : ''),
      reply_markup: { inline_keyboard: [...pick(QUIET_OPTS, cur, 'q'), [b((pr.quiet && !isPreset ? `✓ ✏️ Своё: ${quietLabel(pr.quiet)}` : '✏️ Своё время…'), 'O:q:x')], ...(pr.quiet ? [[b('🔔 Без тихих часов', 'O:q:off')]] : []), back] } };
  }
  if (sub === 'v') {
    return { text: '🏖 <b>Отпуск</b>\n\nЗадачи остаются, а автоматические сообщения — план дня, напоминания, «не отстану», сверка, встречи — на паузе до конца отпуска. Коллеги, которые ставят тебе задачи, увидят, что ты в отпуске. В первый рабочий день после отпуска напишу «С возвращением» и пришлю план.' + (away ? `\n\nСейчас: <b>в отпуске по ${fmtDay(away, now)}</b> включительно` : ''),
      reply_markup: { inline_keyboard: [
        [b('До конца недели', 'O:v:w'), b('На неделю', 'O:v:7')],
        [b('На 2 недели', 'O:v:14'), b('✏️ До даты…', 'O:v:x')],
        ...(away ? [[b('🔔 Закончить отпуск', 'O:v:off')]] : []), back] } };
  }
  const on = v => (v === 0 ? '🚫 выкл' : '✅');
  const sched = base.custom ? `${base.from}–${base.to}${base.workOnly ? ', пн–пт' : ', без выходных'}` : 'общий';
  const text = `⚙️ <b>Мои настройки</b>
Нажми на строку, чтобы поменять. Настройки личные — у коллег всё остаётся, как они выбрали.
${away ? `\n🏖 <b>В отпуске по ${fmtDay(away, now)}</b> включительно — автоматические сообщения на паузе\n` : ''}
🕘 Рабочий график — <b>${sched}</b>
🤫 Тихие часы — ${quietLabel(pr.quiet)}
☀️ План дня — ${pr.m === 0 ? '🚫 выкл' : `✅ в ${base.morning}`}
🌙 Вечерняя сверка — ${pr.e === 0 ? '🚫 выкл' : `✅ в ${base.evening}`}
📊 Итоги недели — ${pr.w === 0 ? '🚫 выкл' : '✅'}
📍 «На сегодня» без времени — ${label(DAY_OPTS, day)}
⏰ До срока — ${leadLabel(lead)}
🔔 «Не отстану» — ${nagLabel(nag)}
📅 Встречи — ${meetLabel(meet)}
🔢 Номер задачи — ${first ? 'в начале' : 'в конце'} строки
🔁 Регулярные в списке — ${pr.mix ? 'вместе с разовыми' : 'отдельным блоком'}`;
  return { text, reply_markup: { inline_keyboard: [
    [b(`🕘 График: ${sched}`, 'S:o')],
    [b(pr.quiet ? `🤫 Тихие ${quietLabel(pr.quiet)}` : '🤫 Тихие часы', 'O:q'), b(away ? `🏖 Отпуск по ${fmtDay(away, now)}` : '🏖 Отпуск', 'O:v')],
    [b(`☀️ План дня ${on(pr.m)}`, 'O:m'), b(`🌙 Сверка ${on(pr.e)}`, 'O:e')],
    [b(`📊 Итоги недели ${on(pr.w)}`, 'O:w'), b('📍 «На сегодня»', 'O:d')],
    [b('⏰ До срока', 'O:l'), b('🔔 Не отстану', 'O:g')],
    [b('📅 Встречи', 'O:c'), b('🔢 Номер задачи', 'O:n')],
    [b(pr.mix ? '🔁 Регулярные отдельно' : '🔁 Регулярные вместе', 'O:r')],
  ] } };
}
// изменить одну настройку; true — если такая есть. Свои значения (минуты, время) проверяются здесь же
function setPref(user, key, val) {
  const pr = user.data.prefs = { ...prefsOf(user) };
  const toggle = k => { if (pr[k] === 0) delete pr[k]; else pr[k] = 0; };
  const num = /^\d{1,4}$/.test(String(val)) ? +val : NaN;
  if (key === 'm' || key === 'e' || key === 'w') toggle(key);
  else if (key === 'r') { if (pr.mix) delete pr.mix; else pr.mix = 1; }
  else if (key === 'l' && num >= 0 && num <= 24 * 60) { if (num === 60) delete pr.lead; else pr.lead = num; }
  else if (key === 'g' && num >= 10 && num <= 8 * 60) { if (num === 30) delete pr.nag; else pr.nag = num; }
  else if (key === 'd' && DAY_OPTS.some(([v]) => String(v) === val)) { if (+val === 2) delete pr.day; else pr.day = +val; }
  else if (key === 'c' && (val === 'off' || /^\d{1,4}(,\d{1,4}){0,3}$/.test(val || ''))) {
    const v = val === 'off' ? 'off' : [...new Set(val.split(',').map(Number).filter(n => n <= 24 * 60))].sort((a, b) => b - a).join(',');
    if (!v) return false;
    if (v === '60,15,0') delete pr.meet; else pr.meet = v;
  } else if (key === 'q' && val === 'off') delete pr.quiet;
  else if (key === 'q' && /^\d{4}-\d{4}$/.test(val || '')) {
    const [f, t] = val.split('-').map(x => `${x.slice(0, 2)}:${x.slice(2)}`);
    if (f === t || f > '23:59' || t > '23:59' || f.slice(3) > '59' || t.slice(3) > '59') return false;
    pr.quiet = `${f}-${t}`;
  } else return false;
  if (!Object.keys(pr).length) delete user.data.prefs;
  user.dirty = true;
  return true;
}
// отпуск: последний день (включительно) или выключить
function setAway(ctx, user, date) {
  if (date) user.data.away = date; else delete user.data.away;
  delete user.data.awayBack;
  user.dirty = true;
}
// текст «✏️ Своё» → значение настройки (или null, если не понял)
function customPref(key, text, now) {
  const t = String(text).trim();
  if (key === 'l' || key === 'g') { const n = parseMinutes(t); return n === null ? null : String(n); }
  if (key === 'c') {
    if (/^(?:только\s+)?в\s+начал/iu.test(t)) return '0';
    const ns = t.split(/\s*(?:,|;|\sи\s)\s*/u).map(parseMinutes);
    if (!ns.length || ns.some(n => n === null)) return null;
    return [...ns, 0].join(',');
  }
  if (key === 'q') {
    const m = t.match(/^(?:с\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*(?:-|–|—|до)\s*(\d{1,2})(?:[:.](\d{2}))?$/u);
    if (!m || +m[1] > 23 || +m[3] > 24) return null;
    const p2 = (h, mm) => String(+h % 24).padStart(2, '0') + (mm || '00');
    return `${p2(m[1], m[2])}-${p2(m[3], m[4])}`;
  }
  if (key === 'v') {
    const d = waitDateOf(t.replace(/^до\s+/iu, ''), now);
    return d && d >= now.date ? d : null;
  }
  return null;
}
function setIdFirst(ctx, user, on) {
  if (on) user.data.idFirst = 1; else delete user.data.idFirst;
  user.dirty = true;
  ctx.dash.add(user.id); // закреплённый список перерисуется в новом виде
}

function schedSummary(env, user) {
  const sc = schedOf(env, user);
  const head = sc.custom
    ? `🕘 <b>Твой график:</b> ${sc.from}–${sc.to}${sc.workOnly ? ', пн–пт (праздники — выходные)' : ', без выходных'}`
    : '🕘 <b>График не настроен</b> — работаю по общему расписанию';
  return `${head}
• ☀️ план дня — ${sc.morning === 'off' ? 'выключен' : sc.morning}
• 📍 про задачи «на сегодня» без времени — ${sc.slots.join(' и ') || 'выкл'}
• 🔔 «Не отстану» — с ${sc.nagFrom} до ${sc.nagTo}
• 🌙 вечерняя сверка — ${sc.evening === 'off' ? 'выключена' : sc.evening}
• 📊 итоги недели — ${sc.weekly === 'off' ? 'выключены' : `${sc.custom && sc.workOnly ? 'в последний рабочий день недели' : 'в воскресенье'}, ${sc.weekly}`}${sc.workOnly ? '\n• 🏖 в выходные и праздники не беспокою' : ''}
${prefsOf(user).quiet ? `• 🤫 тихие часы — ${quietLabel(prefsOf(user).quiet)}, в это время ничего не присылаю\n` : ''}${user && user.data && user.data.away ? `• 🏖 отпуск по ${fmtDay(user.data.away, { date: user.data.away })} — напоминания на паузе\n` : ''}<i>Что из этого присылать — /settings</i>`;
}
async function askSchedule(ctx, user, msg = null) {
  const b = (text, data) => ({ text, callback_data: data });
  const text = '🕘 <b>Настроим твой рабочий график</b>\nПо нему я пришлю план дня утром, сверку перед концом дня и не буду беспокоить в нерабочее время.\n\n<b>Во сколько начинается рабочий день?</b>';
  const kb = { inline_keyboard: [
    ['07:00', '08:00', '09:00'].map(x => b(x, 'S:f:' + x.replace(':', ''))),
    ['10:00', '11:00', '12:00'].map(x => b(x, 'S:f:' + x.replace(':', ''))),
    [b('⏭ Потом', 'S:later')],
  ] };
  if (msg) return tg(ctx.env, 'editMessageText', { chat_id: user.id, message_id: msg.message_id, parse_mode: 'HTML', text, reply_markup: kb });
  return send(ctx.env, user.id, text + '\n<i>Другое время — напиши, например: <code>график 9:30-18:30</code></i>', { reply_markup: kb });
}
// «график 10-19», «/schedule 9:30-18:30», «мой график 8:00–17:00 без выходных»
function parseSchedule(text) {
  const m = text.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(?:-|–|—|до)\s*(\d{1,2})(?:[:.](\d{2}))?/u);
  if (!m) return null;
  const f = +m[1] * 60 + +(m[2] || 0), t = +m[3] * 60 + +(m[4] || 0);
  if (+m[1] > 23 || +m[3] > 24 || +(m[2] || 0) > 59 || +(m[4] || 0) > 59 || t - f < 120) return null;
  return { from: hm(f), to: hm(Math.min(t, 23 * 60 + 59)), wk: !/без\s+выходных|и\s+в\s+выходные|ежедневно|каждый\s+день/iu.test(text) };
}

function dayRemindSlots(env) {
  const v = env.DAY_REMIND_AT || '12:00,17:00';
  if (v === 'off') return [];
  return v.split(/[\s,]+/).filter(x => /^\d{1,2}:\d{2}$/.test(x)).map(x => x.padStart(5, '0')).sort();
}

async function lastCronAt(ctx) {
  const r = await DB(ctx).prepare('SELECT v FROM meta WHERE k = ?').bind('lastCron').first();
  return r ? +r.v : null;
}

const realNowMs = env => (env._clock ? env._clock().getTime() : Date.now());

async function cronHealthy(ctx) {
  const last = await lastCronAt(ctx);
  return !!last && realNowMs(ctx.env) - last < 20 * 60e3;
}

async function sendStatus(ctx, user) {
  const env = ctx.env, now = ctx.now;
  const last = await lastCronAt(ctx);
  const ago = last ? Math.round((realNowMs(env) - last) / 60e3) : null;
  const cron = last === null
    ? '❌ <b>не работают</b> — проверка по расписанию ни разу не запускалась. Включи Cron: Settings → Trigger Events → Cron → <code>*/5 * * * *</code>'
    : ago < 20 ? `✅ работают (последняя проверка ${ago <= 1 ? 'только что' : ago + ' мин назад'})`
      : `❌ <b>остановились</b> — последняя проверка ${ago} мин назад. Проверь Cron (шаг 7 инструкции)`;
  const all = await myOpenTasks(ctx, user.id);
  const mine = all.filter(t => t.assignee === user.id);
  const s = `🩺 <b>Проверка бота</b>

🕐 Время у бота: <b>${fmtDate(now.date, now)} ${now.time}</b> (${esc(tz(env))})
<i>Если не совпадает с твоим — поменяй TIMEZONE в настройках Cloudflare.</i>

⏰ Напоминания: ${cron}

${schedSummary(env, user)}
<i>Поменять график и что присылать: /settings</i>

🎙 Голосовые: ${env.AI ? '✅ подключены' : '❌ не подключены (шаг 5 инструкции)'}
📋 Твоих открытых задач: ${mine.length}
🏷 Версия бота: <code>${BUILD}</code>
<i>Сообщения в старом виде (много кнопок под напоминанием, «Ответь на это сообщение — допишу подробности…») — признак того, что в Cloudflare работает ещё одна, старая копия бота. Её нужно удалить (Workers &amp; Pages).</i>

<i>Проверить напоминания: напиши <code>Тест напоминания через 10 минут</code> — через 10 минут должно прийти сообщение.</i>`;
  return send(env, user.id, s);
}

async function runCron(env, at = new Date()) {
  env = wrapEnv(env);
  const ctx = await makeCtx(env, at);
  const now = ctx.now;
  const ns = stamp(now.date, now.time);
  await DB(ctx).prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind('lastCron', String(at.getTime())).run();
  const open = await queryTasks(ctx, 'done = 0');
  ctx.preloaded = open; // закреплённые списки рисуем из уже загруженных задач — без лишних запросов к базе
  // у каждого свой график: времена напоминаний и выходные
  const scheds = new Map();
  const schedFor = id => { if (!scheds.has(id)) scheds.set(id, schedOf(env, ctx.users.get(id))); return scheds.get(id); };
  const slotsFor = id => { const sc = schedFor(id); return dayOff(sc, now.date) ? [] : sc.slots; };
  const active = id => { const u = ctx.users.get(id); return u && !u.data.blocked; };
  let deferred = 0;

  // 1. напоминания по времени, «отложенные» 🔔 и «сегодня срок»
  for (const t of open) {
    if (!active(t.assignee) || paused(ctx.users.get(t.assignee), now)) continue; // тихие часы и отпуск — придёт после
    const todo = [];
    t.rem = t.rem || {};
    if (t.remindAt && ns >= stamp(t.remindAt.date, t.remindAt.time)) todo.push('remind');
    if (t.due && t.due.time) {
      const ds = stamp(t.due.date, t.due.time);
      // «за час» — только если задачу поставили заранее (не для «через 30 минут») и не для регулярных
      const lead = leadOf(ctx.users.get(t.assignee)); // за сколько минут предупреждать — личная настройка
      const early = !t.rem.at || ds - t.rem.at > lead * 1.5 * 60e3;
      // и только пока до срока ещё ≥ 45 минут: если срок поставили (или перенесли) на «через 40 минут»,
      // «через час» было бы неправдой — тогда придёт только «Время пришло!»
      if (lead > 0 && !t.rem.h1 && !t.repeat && early && ns >= ds - lead * 60e3 && ds - ns >= lead * 0.75 * 60e3) todo.push('h1');
      if (!t.rem.due && ns >= ds) todo.push(ns - ds < 6 * 3600e3 ? 'due' : 'due-silent');
    }
    let dayDue = [];
    const daySlots = slotsFor(t.assignee);
    if (t.due && !t.due.time && t.due.date === now.date && daySlots.length && !t.waiting) {
      dayDue = daySlots.filter(sl => now.time >= sl && !t.rem['d' + sl]);
      if (dayDue.length) todo.push(dayDue.some(sl => !t.rem.at || stamp(now.date, sl) >= t.rem.at - 5 * 60e3) ? 'day' : 'day-silent');
    }
    if (!todo.length) continue;
    const sends = todo.filter(x => !x.endsWith('silent') && x !== 'h1-skip').length;
    if (!room(env, sends + 1, sends + 1)) { deferred++; continue; } // не влезает в лимит — в следующую проверку (через 5 минут)
    try {
      // сначала отмечаем «отправлено» в базе — если что-то упадёт, лучше пропустить одно напоминание, чем слать его каждые 5 минут
      if (todo.includes('remind')) delete t.remindAt;
      if (todo.includes('h1')) t.rem.h1 = 1;
      if (todo.includes('due') || todo.includes('due-silent')) { t.rem.due = 1; t.rem.h1 = 1; }
      dayDue.forEach(sl => { t.rem['d' + sl] = 1; });
      await saveTask(ctx, t);
      if (todo.includes('remind')) await sendCard(ctx, t.assignee, t, '🔔 <b>Напоминаю</b>\n\n', 'snooze');
      if (todo.includes('h1')) {
        const left = Math.round((stamp(t.due.date, t.due.time) - ns) / 60e3);
        const lead = leadOf(ctx.users.get(t.assignee));
        await sendCard(ctx, t.assignee, t, `⏰ <b>До срока ${left >= lead - 5 ? fmtLead(lead) : `${left} мин`}</b>\n\n`, 'snooze');
      }
      if (todo.includes('due')) await sendCard(ctx, t.assignee, t, '⏰ <b>Время пришло!</b>\n\n', 'snooze');
      if (todo.includes('day')) await sendCard(ctx, t.assignee, t, '📍 <b>Сегодня срок</b>\n\n', 'snooze');
    } catch (e) { console.error('remind', t.id, e && e.stack); }
  }

  // 1а. встречи из календаря: обновить, напомнить за час / 15 минут / в начале, спросить после
  try { deferred += await cronCalendar(ctx, at, open); } catch (e) { console.error('calendar', e && e.stack); }

  // 1б. «Не отстану»: каждые полчаса днём — одно сообщение со всем, что горит; прошлое удаляем
  const nagEvery = +(env.NAG_EVERY || 30);
  if (nagEvery > 0) {
    for (const user of ctx.users.values()) {
      const d = user.data;
      const sc = schedFor(user.id);
      if (now.time < sc.nagFrom || now.time >= sc.nagTo || dayOff(sc, now.date) || paused(user, now)) continue; // только в рабочие часы человека
      const every = Math.max(nagEvery, nagMin(env, user));
      if (d.blocked || d.nagMute === now.date || at.getTime() - (d.lastNag || 0) < (every - 1) * 60e3) continue;
      const nag = renderNag(ctx, user, open, sc.slots);
      if (!nag) continue;
      if (!room(env, 2, 1)) { deferred++; break; }
      try {
        d.lastNag = at.getTime(); user.dirty = true;
        if (d.nagMsg) await tg(env, 'deleteMessage', { chat_id: user.id, message_id: d.nagMsg });
        const r = await send(env, user.id, nag.text, { reply_markup: nag.keyboard });
        d.nagMsg = r.ok ? r.result.message_id : null;
      } catch (e) { console.error('nag', user.id, e && e.stack); }
    }
  }

  // 2. сводки по каждому человеку
  for (const user of ctx.users.values()) {
    if (user.data.blocked) continue;
    const d = user.data;
    const sc = schedFor(user.id);
    const off = dayOff(sc, now.date);
    if (paused(user, now)) continue; // отпуск или тихие часы: сводки придут позже (окно — 3 часа) или после отпуска
    const mine = open.filter(t => t.assignee === user.id);
    // отпуск закончился — в первый рабочий день, к началу дня, «С возвращением»
    if (d.away && !off && now.time >= sc.nagFrom && room(env, 1, 1)) {
      const was = d.away;
      delete d.away; user.dirty = true;
      await send(env, user.id, `👋 <b>С возвращением!</b> Отпуск (по ${fmtDay(was, now)}) закончился — напоминания снова включены.\nОткрытых задач: ${mine.length}. Всё по срокам — /list`);
    }
    const jobs = [];
    if (!off && sc.morning !== 'off' && d.lastMorning !== now.date && inWindow(now.time, sc.morning)) jobs.push('morning');
    if (!off && sc.evening !== 'off' && d.lastEvening !== now.date && inWindow(now.time, sc.evening)) jobs.push('evening');
    if (sc.weekly !== 'off' && weeklyToday(sc, now.date) && d.lastWeekly !== now.date && inWindow(now.time, sc.weekly)) jobs.push('weekly');
    if (!jobs.length) continue;
    // утро: до 2 сообщений, вечер и неделя — по одному; плюс запись в базу и обновление списка
    if (!room(env, jobs.length * 2 + 3, jobs.length * 3 + 4)) { deferred++; continue; }
    try {
      if (jobs.includes('morning')) d.lastMorning = now.date;
      if (jobs.includes('evening')) d.lastEvening = now.date;
      if (jobs.includes('weekly')) d.lastWeekly = now.date;
      user.dirty = true;
      await saveUsers(ctx, [user.id]); // сначала запоминаем «отправлено» — чтобы при сбое не прислать сводку повторно
      if (jobs.includes('morning') && await sendMorning(ctx, user, mine)) await sendStaleReview(ctx, user, mine);
      if (jobs.includes('morning')) await sendWaitingCheck(ctx, user, mine);
      // первое рабочее утро недели (обычно понедельник; если он праздник — следующий рабочий день)
      const monday = addDays(now.date, -((weekday(now.date) + 6) % 7));
      if (jobs.includes('morning') && d.cal && d.lastMeetWeek !== monday) {
        d.lastMeetWeek = monday;
        // понедельник: встречи недели с кнопками «подготовить»
        await sendMeetings(ctx, user, 6, '📅 <b>Встречи на этой неделе</b> — к каким нужно что-то подготовить?');
      }
      if (jobs.includes('evening')) await sendEvening(ctx, user);
      if (jobs.includes('weekly')) await sendWeekly(ctx, user);
    } catch (e) { console.error('cron user', user.id, e && e.stack); }
  }

  // 3. раз в день перерисовываем закреплённые списки («завтра» становится «сегодня») — сколько влезет в лимит
  for (const user of ctx.users.values()) {
    if (user.data.blocked || user.data.lastDashDay === now.date || !user.data.dashId) continue;
    if (!room(env, 2 + ctx.dash.size * 2, 2)) { deferred++; break; }
    user.data.lastDashDay = now.date; user.dirty = true;
    ctx.dash.add(user.id);
  }

  // 4. производственный календарь — раз в день, если ещё не загружен
  try { await refreshCalendar(ctx, open); } catch (e) { console.error('calendar', e && e.stack); }

  // 5. уборка раз в неделю: старые выполненные задачи и ссылки на сообщения
  if (weekday(now.date) === 1 && now.time < '00:10' && room(env, 0, 2)) {
    await DB(ctx).batch([
      DB(ctx).prepare('DELETE FROM tasks WHERE done = 1 AND done_at < ?').bind(addDays(now.date, -120)),
      DB(ctx).prepare('DELETE FROM msgs WHERE at < ?').bind(addDays(now.date, -90)),
    ]);
  }
  await flush(ctx);
  if (deferred) console.log(`cron: ${deferred} отложено до следующей проверки (лимит запросов)`);
  return { deferred, used: env._use && { tg: env._use.tg, db: env._use.db } };
}

async function cronCalendar(ctx, at, open) {
  const env = ctx.env, now = ctx.now, ns = stamp(now.date, now.time);
  // за сколько минут напоминать о встрече: за час, за 15 минут и в момент начала
  const stages = String(env.MEET_REMIND || '60,15,0').split(/[\s,]+/).map(Number).filter(n => n >= 0 && n <= 24 * 60).sort((a, b) => b - a);
  const users = [...ctx.users.values()].filter(u => u.data.cal && !u.data.blocked);
  if (!users.length) return 0;
  let deferred = 0;
  for (const u of users) {
    if (at.getTime() - (u.data.cal.last || 0) < 14 * 60e3) continue;
    if (!room(env, 1, 2)) { deferred++; break; }
    await refreshUserCalendar(ctx, u, at);
  }
  const { results } = await DB(ctx).prepare("SELECT * FROM events WHERE start >= ? AND start <= ? AND length(start) > 10")
    .bind(addDays(now.date, -1), addDays(now.date, 1) + ' 02').all(); // и встречи сразу после полуночи — для «за час»
  for (const r of results) {
    const u = ctx.users.get(r.user_id);
    if (!u || !u.data.cal || u.data.blocked) continue;
    const e = rowToEvent(r);
    const sent = u.data.calSent || (u.data.calSent = {});
    const f = sent[e.h] || {};
    const sMs = stamp(e.start.date, e.start.time);
    const eMs = e.end && e.end.time ? stamp(e.end.date, e.end.time) : sMs + 30 * 60e3;
    const preps = tasksOfMeeting(open, u.id, e.h);
    // напоминания: за час, за 15 минут, в момент начала. Шлём только ближайшее к встрече из наступивших —
    // если проверка опоздала, «за час» после «за 15 минут» не придёт
    const um = prefsOf(u).meet; // личная настройка: какие напоминания о встречах присылать
    const ustages = paused(u, now) ? [] : um === 'off' ? [] : um ? um.split(',').map(Number).sort((a, b) => b - a) : stages;
    const stage = ustages.filter(k => ns >= sMs - k * 60e3 && ns < sMs + 5 * 60e3).at(-1);
    if (stage !== undefined && !f['r' + stage]) {
      if (!room(env, 1, 1)) { deferred++; continue; }
      for (const k of ustages) if (k >= stage) f['r' + k] = 1;
      f.d = e.start.date; sent[e.h] = f; u.dirty = true;
      const mins = Math.max(0, Math.round((sMs - ns) / 60e3));
      const when = stage === 0 || mins === 0 ? 'Начинается сейчас' : mins >= 55 ? 'Через час' : `Через ${mins} мин`;
      let s = `🔔 <b>${when}: ${esc(e.title)}</b>\n🕐 ${e.start.time}${e.end && e.end.time ? '–' + e.end.time : ''}`;
      if (e.loc) s += `\n📍 ${esc(e.loc)}`;
      if (e.link) s += `\n🔗 ${esc(e.link)}`;
      const rows = [];
      for (const t of preps.filter(isPrep)) {
        s += `\n\n📝 <b>Подготовка</b> ${checkProgress(t)}\n` + (t.checklist || []).map(c => `${c.done ? '☑' : '☐'} ${esc(c.text)}`).join('\n');
        rows.push([{ text: '📝 Открыть подготовку', callback_data: `M:o:${t.id}` }]);
      }
      const linked = preps.filter(t => !isPrep(t));
      if (linked.length) {
        s += '\n\n📎 <b>Задачи к встрече</b>\n' + linked.map(t => `• ${esc(t.title)}  /t${t.id}`).join('\n');
        for (const t of linked.slice(0, 5)) rows.push([{ text: `📎 ${short(t.title, 40)}`, callback_data: `M:o:${t.id}` }]);
      }
      await send(env, u.id, clip(s), rows.length ? { reply_markup: { inline_keyboard: rows } } : {});
    }
    // после встречи — что сделать по итогам и к следующей (для регулярных и тех, к которым готовились)
    if (!f.a && ns >= eMs && ns < eMs + 90 * 60e3 && (e.recur || preps.length || u.data.cal.after)) {
      if (!room(env, 1, 2)) { deferred++; continue; }
      f.a = 1; f.d = e.start.date; sent[e.h] = f; u.dirty = true;
      const next = e.recur ? await nextOfSeries(ctx, u.id, e) : null;
      const rows = [[{ text: '🗒 Записать задачи по итогам', callback_data: `M:a:${e.h}` }]];
      if (next) rows.push([{ text: `➡️ Подготовить к следующей (${fmtMeetingWhen(next, now)})`, callback_data: `M:p:${next.h}` }]);
      rows.push([{ text: 'Ничего не нужно', callback_data: 'M:x' }]);
      const left = preps.filter(t => !isPrep(t));
      const tail = left.length ? '\n\n📎 К ней были задачи — не забудь отметить сделанные:\n' + left.map(t => `• ${esc(t.title)}  /t${t.id}`).join('\n') : '';
      await send(env, u.id, clip(`🗒 Встреча «<b>${esc(e.title)}</b>» закончилась.${tail}`), { reply_markup: { inline_keyboard: rows } });
    }
  }
  // чистим старые отметки
  for (const u of users) {
    const sent = u.data.calSent;
    if (!sent) continue;
    for (const [k, v] of Object.entries(sent)) if (!v.d || v.d < addDays(now.date, -2)) { delete sent[k]; u.dirty = true; }
  }
  return deferred;
}

// Загрузить производственный календарь (isdayoff.ru) на текущий и следующий год
async function refreshCalendar(ctx, open) {
  const env = ctx.env, now = ctx.now;
  const y = +now.date.slice(0, 4);
  const need = [y, y + 1].filter(yy => !CAL.has(yy));
  if (!need.length || !room(env, need.length, need.length + 2)) return;
  const mark = await DB(ctx).prepare('SELECT v FROM meta WHERE k = ?').bind('calTry').first();
  if (mark && mark.v === now.date) return; // пробуем не чаще раза в день
  await DB(ctx).prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind('calTry', now.date).run();
  let got = false;
  for (const yy of need) {
    if (env._use) env._use.tg++;
    try {
      const r = await fetch(`https://isdayoff.ru/api/getdata?year=${yy}&cc=ru`);
      const txt = (await r.text()).trim();
      if (/^[0-9]{365,366}$/.test(txt)) {
        CAL.set(yy, txt);
        await DB(ctx).prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').bind('cal:' + yy, txt).run();
        got = true;
      }
    } catch (e) { console.log('calendar fetch', yy, e && e.message); }
  }
  if (!got) return;
  // сроки «первый/последний рабочий день», посчитанные без календаря, — поправить
  for (const t of open) {
    if (!t.repeat || !t.repeat.wday || !t.due || t.due.date < now.date) continue;
    const right = workDayOf(t.due.date, t.repeat.wday);
    if (right !== t.due.date && right >= now.date) {
      setDue(t, { date: right, time: t.due.time });
      await saveTask(ctx, t);
      touch(ctx, t);
    }
  }
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
  const since = addDays(ctx.now.date, -30); // выполненное за месяц — с датой завершения
  const pIds = ps.map(p => p.id);
  const where = `(assignee_id = ? OR owner_id = ?${pIds.length ? ` OR project_id IN (${pIds.map(() => '?').join(',')})` : ''}) AND (done = 0 OR done_at >= ?)`;
  const tasks = (await queryTasks(ctx, where, uid, uid, ...pIds, since)).filter(t => !(t.done && hiddenFor(t, uid)) && visibleTo(t, uid));
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
      owner: t.owner, assignee: t.assignee, project: t.project,
      repeat: t.repeat || null, repeatText: t.repeat ? fmtRepeat(t.repeat) : null,
      checklist: t.checklist || [], notes: (t.notes || []).map(n => ({ text: n.text, by: n.by || null, at: n.at })),
      bucket: t.done ? 'done' : bucketOf(t, ctx.now), remindAt: t.remindAt || null, lastDone: t.lastDone ? t.lastDone.date : null,
      start: t.start || null, status: t.status || null, files: (t.files || []).length, nag: isNagOn(t), waiting: t.waiting || null,
      meeting: t.meeting ? { title: t.meeting.title, start: t.meeting.start } : null,
      group: t.group ? t.group.kids.map(k => ({ name: nameOf(ctx, k.uid), done: !!k.done })) : null, shared: !!t.parent,
    })),
  };
}

async function boardEdit(ctx, user, t, body) {
  const uid = user.id, now = ctx.now;
  const actor = esc(user.name);
  if (typeof body.title === 'string' && body.title.trim() && body.title.trim() !== t.title) {
    if (t.parent) return 'Это общая задача — название меняет её автор';
    const old = t.title;
    t.title = body.title.trim().replace(/\s+/g, ' ').slice(0, 200);
    notifyOthers(ctx, t, uid, `✏️ <b>${actor}</b> переименовал(а) задачу «${esc(short(old, 80))}»\n\n`);
  }
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
  if ('repeat' in body) {
    if (body.repeat === null) delete t.repeat;
    else {
      const r = sanitizeRepeat(body.repeat);
      if (!r) return 'Не получилось сохранить повтор — проверь настройки';
      applyRepeat(t, r, now);
      if (t.done) { t.done = false; t.doneAt = null; }
      notifyOthers(ctx, t, uid, `🔁 <b>${actor}</b>: теперь повторяется ${fmtRepeat(r)}\n\n`);
    }
  }
  if (typeof body.checkAdd === 'string' && body.checkAdd.trim()) {
    t.checklist = [...(t.checklist || []), { text: body.checkAdd.trim(), done: false }];
  }
  // правка на доске: подробности целиком, пункт чек-листа, удаление пункта
  if (typeof body.notesText === 'string') {
    const joined = body.notesText.split('\n').map(l => l.trim()).filter(Boolean).join('\n').slice(0, 3500);
    if (joined !== (t.notes || []).map(n => n.text).join('\n')) {
      t.notes = joined ? [{ at: now.date, by: uid, text: joined }] : [];
      notifyOthers(ctx, t, uid, `✏️ <b>${actor}</b> изменил(а) подробности\n\n`);
    }
  }
  if (body.checkEdit && Number.isInteger(body.checkEdit.i) && typeof body.checkEdit.text === 'string') {
    const c = (t.checklist || [])[body.checkEdit.i];
    const txt = body.checkEdit.text.trim().slice(0, 300);
    if (c && txt) t.checklist = t.checklist.map((x, i) => (i === body.checkEdit.i ? { ...x, text: txt } : x));
  }
  if (Number.isInteger(body.checkDel) && (t.checklist || [])[body.checkDel]) {
    t.checklist = t.checklist.filter((_, i) => i !== body.checkDel);
  }
  await saveTask(ctx, t);
  touch(ctx, t);
  return null;
}

async function handleApi(request, env) {
  env = wrapEnv(env);
  const body = await request.json().catch(() => ({}));
  const tgUser = await verifyInitData(env, body.initData);
  if (!tgUser) return json({ error: 'Открой доску из Telegram' }, 401);
  const ctx = await makeCtx(env, env._clock ? env._clock() : undefined);
  const user = ctx.users.get(tgUser.id);
  if (!user) return json({ error: 'Сначала напиши боту /start' }, 403);
  let error = null, projectId = null;

  if (body.op === 'create') {
    const project = body.project ? ctx.projects.get(+body.project) : null;
    if (project && !project.members.has(user.id)) error = 'Нет доступа к проекту';
    else {
      const r = await createFromText(ctx, user, String(body.text || '').trim(), { project });
      if (r.error) error = 'Напиши, что сделать';
    }
  } else if (body.op === 'act' || body.op === 'edit') {
    const t = await getTask(ctx, +body.id);
    if (!t || !canAccess(ctx, t, user.id)) error = lostTask(t);
    else if (body.op === 'act') {
      const act = String(body.act || '');
      if (!/^(done|undo|skip|norep|today|tom|week|none|hi|ck\d+|s1h|sev|smo|as\d+|delok|rundo|nag|st0|st1|stx|s_todo|s_doing|s_review|w1|w3|w7|wx|hide)$/.test(act)) error = 'Неизвестное действие';
      else {
        const res = await applyAction(ctx, t, act, user.id);
        if (!res.changed && !res.deleted && res.toast) error = res.toast;
      }
    } else error = await boardEdit(ctx, user, t, body);
  } else if (body.op === 'newproject') {
    const name = String(body.name || '').replace(/^#/, '').trim().slice(0, 40);
    if (!name) error = 'Напиши название проекта';
    else {
      const p = findProject(ctx, user.id, name) || await createProject(ctx, user.id, name);
      projectId = p.id;
    }
  } else if (body.op === 'renameProject') {
    const p = ctx.projects.get(+body.project);
    if (!p || !p.members.has(user.id)) error = 'Нет такого проекта';
    else {
      error = await renameProject(ctx, user.id, p, body.name);
      projectId = p.id;
    }
  } else if (body.op === 'clearDone') {
    const n = await clearDone(ctx, user.id);
    await flush(ctx);
    return json({ cleared: n, state: await boardState(ctx, user.id) });
  } else if (body.op === 'focus') {
    const ids = (body.ids || []).map(Number).slice(0, 3);
    user.data.focus = { date: ctx.now.date, ids }; user.dirty = true; ctx.dash.add(user.id);
  }
  await flush(ctx);
  return json({ error, project: projectId, state: await boardState(ctx, user.id) });
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

// ── Точки входа ──

async function setup(env, origin) {
  env = wrapEnv(env);
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
      { command: 'meetings', description: 'Встречи из календаря' },
      { command: 'calendar', description: 'Подключить Яндекс Календарь' },
      { command: 'schedule', description: 'Мой рабочий график' },
      { command: 'settings', description: 'Мои настройки: график, напоминания, вид списка' },
      { command: 'status', description: 'Проверить, работают ли напоминания' },
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
