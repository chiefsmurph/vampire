// Built-in NYSE calendar (holiday + early-close rules). Used ONLY as the DRY-mode fallback when no
// Alpaca keys exist yet; paper/live always use Alpaca's calendar API.
import { addDays, isWeekend } from './time.js';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const dow = (date) => new Date(date + 'T12:00:00Z').getUTCDay();
function nthWeekday(y, m, wd, n) { // n>0: nth; n=-1: last
  if (n > 0) { let d = 1; while (dow(ymd(y, m, d)) !== wd) d++; return ymd(y, m, d + 7 * (n - 1)); }
  let d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  while (dow(ymd(y, m, d)) !== wd) d--;
  return ymd(y, m, d);
}
function easter(y) { // anonymous Gregorian algorithm
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(y, month, day);
}
// A fixed-date holiday: Saturday -> NOT observed (NYSE rule for New Year), Sunday -> Monday, Saturday -> Friday otherwise.
function observed(y, m, d, { satObserved = true } = {}) {
  const date = ymd(y, m, d), w = dow(date);
  if (w === 6) return satObserved ? addDays(date, -1) : null;
  if (w === 0) return addDays(date, 1);
  return date;
}

export function holidays(y) {
  const set = new Set();
  const add = (x) => x && set.add(x);
  add(observed(y, 1, 1, { satObserved: false }));
  add(nthWeekday(y, 1, 1, 3));
  add(nthWeekday(y, 2, 1, 3));
  add(addDays(easter(y), -2));
  add(nthWeekday(y, 5, 1, -1));
  add(observed(y, 6, 19));
  add(observed(y, 7, 4));
  add(nthWeekday(y, 9, 1, 1));
  add(nthWeekday(y, 11, 4, 4));
  add(observed(y, 12, 25));
  return set;
}

export function earlyCloses(y) {
  const set = new Set();
  set.add(addDays(nthWeekday(y, 11, 4, 4), 1)); // day after Thanksgiving
  const hol = holidays(y);
  for (const [m, d] of [[7, 3], [12, 24]]) {
    const date = ymd(y, m, d), w = dow(date);
    if (w >= 1 && w <= 5 && !hol.has(date)) set.add(date);
  }
  return set;
}

/** Same shape as Alpaca's /v2/calendar rows for the trading days in [from, to]. */
export function builtinCalendar(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (isWeekend(d)) continue;
    const y = Number(d.slice(0, 4));
    if (holidays(y).has(d)) continue;
    out.push({ date: d, open: '09:30', close: earlyCloses(y).has(d) ? '13:00' : '16:00' });
  }
  return out;
}
