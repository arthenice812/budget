import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

const { parseTask } = worker._internal;
// 2026-09-30 — среда
const NOW = { date: '2026-09-30', time: '12:00' };
const p = s => parseTask(s, NOW);

test('разбор сроков', () => {
  assert.deepEqual(p('Отчёт для Маши до пятницы'), { title: 'Отчёт для Маши', due: { date: '2026-10-02', time: null }, high: false, repeat: null, ambig: null });
  assert.deepEqual(p('Позвонить врачу завтра 10:00').due, { date: '2026-10-01', time: '10:00' });
  assert.equal(p('Позвонить врачу завтра 10:00').title, 'Позвонить врачу');
  assert.deepEqual(p('оплатить налог 25.10').due, { date: '2026-10-25', time: null });
  assert.equal(p('оплатить налог 25.10').title, 'Оплатить налог');
  assert.equal(p('подарок 5.03').due.date, '2027-03-05'); // прошедшая дата → следующий год
  assert.equal(p('встреча 12 октября в 15:30').due.date, '2026-10-12');
  assert.equal(p('встреча 12 октября в 15:30').due.time, '15:30');
  assert.equal(p('встреча 12 октября в 15:30').title, 'Встреча');
  assert.equal(p('продлить домен через 2 недели').due.date, '2026-10-14');
  assert.equal(p('продлить домен через месяц').due.date, '2026-10-30');
  assert.equal(p('созвон в среду').due.date, '2026-10-07'); // сегодня среда → следующая
  assert.equal(p('созвон в пн').due.date, '2026-10-05');
  assert.equal(p('созвон в следующую пятницу').due.date, '2026-10-09');
  assert.equal(p('созвон в 18:00').due.date, '2026-09-30'); // время ещё не прошло → сегодня
  assert.equal(p('созвон в 9:00').due.date, '2026-10-01'); // прошло → завтра
  assert.equal(p('купить 3 марки').due, null);
  assert.equal(p('купить 3 марки').title, 'Купить 3 марки');
  assert.equal(p('просто задача').due, null);
});

test('важность', () => {
  assert.equal(p('сдать отчёт !!').high, true);
  assert.equal(p('сдать отчёт !!').title, 'Сдать отчёт');
  assert.equal(p('срочно сдать отчёт').high, true);
  assert.equal(p('сдать отчёт!').high, false);
});

test('только дата → пустой заголовок (перенос срока ответом)', () => {
  assert.equal(p('завтра 15:00').title, '');
  assert.deepEqual(p('завтра 15:00').due, { date: '2026-10-01', time: '15:00' });
  assert.equal(p('в понедельник').title, '');
});

// ── Сквозной сценарий ──

function makeEnv() {
  const rows = new Map();
  const DB = {
    prepare(sql) {
      let args = [];
      const api = {
        bind: (...a) => { args = a; return api; },
        run: async () => { if (sql.startsWith('INSERT')) rows.set(args[0], args[1]); return {}; },
        first: async () => rows.has(args[0]) ? { v: rows.get(args[0]) } : null,
        all: async () => ({ results: [...rows.keys()].filter(k => k.startsWith('u:')).map(k => ({ k })) }),
      };
      return api;
    },
  };
  return { env: { DB, BOT_TOKEN: 'x', WEBHOOK_SECRET: 's', TIMEZONE: 'Europe/Moscow', _clock: () => new Date('2026-09-30T09:00:00Z') }, rows };
}

function mockTelegram() {
  const calls = [];
  let msgId = 100;
  globalThis.fetch = async (url, init) => {
    const method = url.split('/').pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    const result = method === 'sendMessage' ? { message_id: ++msgId } : true;
    return { json: async () => ({ ok: true, result }) };
  };
  return calls;
}

let upd = 1;
const chat = { id: 42, type: 'private' };
const from = { id: 42 };
const text = (t, extra = {}) => ({ update_id: upd++, message: { message_id: 1000 + upd, chat, from, text: t, ...extra } });

test('разбор регулярных задач', () => {
  // сегодня 2026-09-30, среда, 12:00
  let r = p('Выпить витамины каждый день в 9:00');
  assert.equal(r.title, 'Выпить витамины');
  assert.deepEqual(r.repeat, { unit: 'day', n: 1 });
  assert.deepEqual(r.due, { date: '2026-10-01', time: '09:00' }); // 9:00 сегодня прошло
  r = p('Отчёт по продажам каждый понедельник');
  assert.equal(r.title, 'Отчёт по продажам');
  assert.deepEqual(r.repeat.wd, [1]);
  assert.equal(r.due.date, '2026-10-05');
  r = p('Планёрка по вторникам и четвергам 11:00');
  assert.equal(r.title, 'Планёрка');
  assert.deepEqual(r.repeat.wd, [2, 4]);
  assert.deepEqual(r.due, { date: '2026-10-01', time: '11:00' });
  r = p('Оплатить интернет каждое 10 число');
  assert.equal(r.title, 'Оплатить интернет');
  assert.deepEqual(r.repeat, { unit: 'month', n: 1, md: 10 });
  assert.equal(r.due.date, '2026-10-10');
  r = p('Аренда 30 числа каждого месяца');
  assert.equal(r.title, 'Аренда');
  assert.equal(r.repeat.md, 30);
  assert.equal(r.due.date, '2026-09-30');
  assert.equal(p('Полить цветы каждые 3 дня').repeat.n, 3);
  assert.deepEqual(p('Зарядка по будням').repeat.wd, [1, 2, 3, 4, 5]);
  assert.equal(p('Зарядка по будням').due.date, '2026-09-30');
  assert.equal(p('Уборка по выходным').due.date, '2026-10-03');
  assert.equal(p('Проверить почту ежедневно').repeat.unit, 'day');
  assert.equal(p('Сдать показания 20 числа').repeat, null); // разово — ближайшее 20-е
  assert.equal(p('Сдать показания 20 числа').due.date, '2026-10-20');
  assert.equal(p('в понедельник').repeat, null);
  assert.equal(p('каждую пятницу').title, '');
});

test('время словами (для голосовых)', () => {
  assert.deepEqual(p('позвонить маме завтра в 10 утра').due, { date: '2026-10-01', time: '10:00' });
  assert.equal(p('позвонить маме завтра в 10 утра').title, 'Позвонить маме');
  assert.equal(p('созвон в 7 вечера').due.time, '19:00');
  assert.equal(p('встреча в пятницу в 15 часов').due.time, '15:00');
  assert.equal(p('обед в 3 дня').due.time, '15:00');
  assert.equal(p('в 3 местах поправить').due, null);
  assert.equal(p('Купить молоко.').title, 'Купить молоко');
});

test('сложные повторы', () => {
  // 30.09.2026 — среда
  let r = p('Созвон с командой каждые 2 недели по четвергам');
  assert.equal(r.title, 'Созвон с командой');
  assert.deepEqual(r.repeat, { unit: 'week', n: 2, wd: [4] });
  assert.equal(r.due.date, '2026-10-01');
  r = p('Отчёт раз в две недели в пятницу');
  assert.equal(r.title, 'Отчёт');
  assert.deepEqual(r.repeat, { unit: 'week', n: 2, wd: [5] });
  assert.equal(r.due.date, '2026-10-02');
  assert.deepEqual(p('Бэклог каждый второй четверг').repeat, { unit: 'week', n: 2, wd: [4] });

  r = p('Сдать табель в последний день месяца');
  assert.equal(r.title, 'Сдать табель');
  assert.equal(r.repeat.last, true);
  assert.equal(r.due.date, '2026-09-30');
  assert.equal(p('Табель каждый последний день месяца').repeat.last, true);
  r = p('Оплатить аренду каждое первое число');
  assert.equal(r.title, 'Оплатить аренду');
  assert.equal(r.repeat.md, 1);
  assert.equal(r.due.date, '2026-10-01');
  assert.equal(p('Аренда первого числа каждого месяца').repeat.md, 1);

  r = p('Планёрка каждый первый понедельник месяца');
  assert.equal(r.title, 'Планёрка');
  assert.deepEqual(r.repeat, { unit: 'month', n: 1, nth: 1, nwd: 1 });
  assert.equal(r.due.date, '2026-10-05');
  r = p('Ретро в последнюю пятницу каждого месяца');
  assert.equal(r.title, 'Ретро');
  assert.equal(r.due.date, '2026-10-30');

  assert.equal(p('Последний звонок клиенту').repeat, null); // не повтор
  assert.equal(p('Первый день в офисе').repeat, null);
});

test('через N минут / часов', () => {
  assert.deepEqual(p('Проверить духовку через 30 минут').due, { date: '2026-09-30', time: '12:30' });
  assert.equal(p('Проверить духовку через 30 минут').title, 'Проверить духовку');
  assert.deepEqual(p('Позвонить через 2 часа').due, { date: '2026-09-30', time: '14:00' });
  assert.deepEqual(p('Выпить воды через полчаса').due, { date: '2026-09-30', time: '12:30' });
  assert.equal(p('Отпуск через две недели').due.date, '2026-10-14');
});

test('время через точку', () => {
  // 30.09.2026, 12:00
  assert.deepEqual(p('Созвон 15.30').due, { date: '2026-09-30', time: '15:30' });
  assert.equal(p('Созвон 15.30').title, 'Созвон');
  assert.deepEqual(p('Созвон в 9.45').due, { date: '2026-10-01', time: '09:45' }); // 9:45 уже прошло
  assert.deepEqual(p('Созвон завтра 10.25').due, { date: '2026-10-01', time: '10:25' });
  assert.deepEqual(p('Совещание в пятницу 15.00').due, { date: '2026-10-02', time: '15:00' });
  assert.deepEqual(p('Врач 25.10 10.30').due, { date: '2026-10-25', time: '10:30' });
  assert.deepEqual(p('Врач 10.30 25.10').due, { date: '2026-10-25', time: '10:30' });
  assert.deepEqual(p('Созвон в 10.11').due, { date: '2026-10-01', time: '10:11' }); // «в» — время
  assert.deepEqual(p('Витамины каждый день 9.00').due, { date: '2026-10-01', time: '09:00' });
  // однозначные даты не трогаем
  assert.deepEqual(p('Налог 25.10').due, { date: '2026-10-25', time: null });
  assert.deepEqual(p('Отпуск 10.11.2026').due, { date: '2026-11-10', time: null });
  assert.deepEqual(p('Сдать до 10.11').due, { date: '2026-11-10', time: null });
  // неоднозначно — дата, но с вопросом
  const r = p('Отчёт 10.11');
  assert.deepEqual(r.due, { date: '2026-11-10', time: null });
  assert.deepEqual(r.ambig, { raw: '10.11', time: '10:11' });
  assert.equal(r.title, 'Отчёт');
  assert.equal(p('Отчёт 25.10').ambig, null);
});

test('рабочий день месяца и «ежемесячная»', () => {
  // 30.09.2026 — среда
  let r = p('Ежемесячная задача первый рабочий день месяца создавать отчет для новодворского');
  assert.deepEqual(r.repeat, { unit: 'month', n: 1, wday: 1 });
  assert.equal(r.due.date, '2026-10-01'); // чт, 1 октября
  assert.equal(r.title, 'Ежемесячная задача создавать отчет для новодворского');
  r = p('Табель в последний рабочий день месяца');
  assert.equal(r.due.date, '2026-09-30');
  assert.equal(r.title, 'Табель');
  assert.equal(p('Отчёт каждый первый рабочий день').repeat.wday, 1);
  assert.equal(p('Ежедневная планёрка в 10:00').repeat.unit, 'day');
  assert.equal(p('Ежедневная планёрка в 10:00').title, 'Ежедневная планёрка');
  assert.equal(p('Первый рабочий день у Пети').repeat, null);
});

test('дата начала и дедлайн', () => {
  // 30.09.2026 — среда
  let r = p('Отчёт начать в пятницу, сдать 10.10');
  assert.equal(r.title, 'Отчёт');
  assert.deepEqual(r.start, { date: '2026-10-02', time: null });
  assert.equal(r.due.date, '2026-10-10');
  r = p('Презентация начать завтра дедлайн в пятницу');
  assert.equal(r.title, 'Презентация');
  assert.deepEqual(r.start, { date: '2026-10-01', time: null });
  assert.equal(r.due.date, '2026-10-02');
  r = p('Начать ремонт');
  assert.equal(r.start, undefined, '«начать» без даты — обычный текст');
  assert.equal(r.title, 'Начать ремонт');
});

// Сейчас среда 30.09, 12:00
test('час без минут: «в 18», «к 5», «в 2 часа» — как говорят днём', () => {
  const due = s => { const r = p(s); return r.due && `${r.due.date} ${r.due.time}`; };
  assert.equal(due('позвонить маме в 18'), '2026-09-30 18:00');
  assert.equal(p('позвонить маме в 18').title, 'Позвонить маме');
  assert.equal(due('сдать 1 ноября в 12'), '2026-11-01 12:00');
  assert.equal(p('сдать 1 ноября в 12').title, 'Сдать');
  assert.equal(due('Позвонить в 2 часа'), '2026-09-30 14:00'); // не 2 ночи
  assert.equal(due('Позвонить в 2 часа ночи'), '2026-10-01 02:00');
  assert.equal(due('отчёт к 5'), '2026-09-30 17:00');
  assert.equal(due('встреча в 10 с Петей'), '2026-10-01 10:00'); // 10 утра уже прошло → завтра
  assert.equal(p('встреча в 10 с Петей').title, 'Встреча с Петей');
  assert.equal(due('отчёт сегодня в 9'), '2026-09-30 21:00'); // «сегодня», а утро прошло → вечер
  assert.equal(due('завтра в 10'), '2026-10-01 10:00');
  assert.equal(p('завтра в 10').title, '');
  assert.equal(due('отчёт в 10 часов 30 минут'), '2026-10-01 10:30');
  assert.equal(p('отчёт в 10 часов 30 минут').title, 'Отчёт');
  const rep = p('Каждый понедельник планёрка в 10');
  assert.deepEqual([rep.title, rep.due.time, rep.repeat.wd], ['Планёрка', '10:00', [1]]);
  // числа, которые не время
  assert.equal(p('Купить 2 литра молока').due, null);
  assert.equal(p('раз в 2 недели созвон').repeat.n, 2);
  assert.equal(p('живу в 5 корпусе').due, null);
  assert.equal(due('отчёт к 05.10'), '2026-10-05 null');
  assert.equal(p('отчёт к 05.10').title, 'Отчёт');
});

test('утром, вечером, к обеду; на следующей неделе, в конце месяца', () => {
  const due = s => { const r = p(s); return r.due && `${r.due.date} ${r.due.time}`; };
  assert.equal(due('Позвонить маме завтра утром'), '2026-10-01 09:00');
  assert.equal(p('Позвонить маме завтра утром').title, 'Позвонить маме');
  assert.equal(due('Позвонить маме вечером'), '2026-09-30 19:00');
  assert.equal(due('отчёт к обеду'), '2026-09-30 13:00');
  assert.equal(due('отчёт после обеда'), '2026-09-30 14:00');
  assert.equal(due('отчёт в полдень'), '2026-10-01 12:00'); // 12:00 уже наступило
  assert.equal(due('отчёт утром'), '2026-10-01 09:00');
  assert.equal(due('отчёт на следующей неделе'), '2026-10-05 null'); // понедельник
  assert.equal(due('отчёт в конце недели'), '2026-10-02 null'); // пятница
  assert.equal(due('отчёт до конца недели'), '2026-10-02 null');
  assert.equal(due('отчёт в конце месяца'), '2026-09-30 null');
  assert.equal(due('отчёт в следующем месяце'), '2026-10-01 null');
  assert.equal(p('отчёт на следующей неделе').title, 'Отчёт');
  assert.equal(parseTask('отчёт в конце недели', { date: '2026-10-03', time: '12:00' }).due.date, '2026-10-04'); // суббота → воскресенье
  assert.equal(parseTask('отчёт на следующей неделе', { date: '2026-10-05', time: '12:00' }).due.date, '2026-10-12'); // в понедельник → через неделю
});

test('«напомни…», «важно:», начало и сдача в одной фразе', () => {
  assert.equal(p('напомни завтра позвонить').title, 'Позвонить');
  assert.equal(p('Напомнить в 15:00 выпить таблетку').title, 'Выпить таблетку');
  assert.equal(p('не забыть купить хлеб').title, 'Купить хлеб');
  assert.equal(p('Напомнить').title, 'Напомнить');
  const v = p('важно: отчёт завтра');
  assert.deepEqual([v.title, v.high], ['Отчёт', true]);
  const s = p('начать отчёт в понедельник, сдать в пятницу');
  assert.equal(s.title, 'Отчёт');
  assert.deepEqual(s.start, { date: '2026-10-05', time: null });
  assert.equal(s.due.date, '2026-10-09', 'пятница после начала');
});

test('несуществующие дата и время — помечаются, а не теряются молча', () => {
  assert.equal(p('отчёт 31 сентября').bad, '31 сентября');
  assert.equal(p('отчёт 30 февраля').bad, '30 февраля');
  assert.equal(p('отчёт 31.09').bad, '31.09');
  assert.equal(p('отчёт в 25:00').bad, '25:00');
  assert.equal(p('отчёт завтра в 24:30').due.date, '2026-10-01');
  assert.equal(p('отчёт завтра в 24:30').bad, '24:30');
  assert.equal(p('отчёт 29.02.2028').bad, undefined); // високосный — есть такая дата
  assert.equal(p('отчёт 30.09').bad, undefined);
  assert.equal(p('купить 3 марки').bad, undefined);
});
