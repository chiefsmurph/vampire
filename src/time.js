// US/Eastern wall-clock helpers with no dependencies (Intl handles DST).
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function etParts(d) {
  const p = {};
  for (const x of fmt.formatToParts(d)) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** The UTC instant at which the ET wall clock reads `date` `hhmm`. */
export function etInstant(date, hhmm) {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, m] = hhmm.split(':').map(Number);
  const want = Date.UTC(y, mo - 1, d, h, m);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = etParts(new Date(guess));
    const [py, pmo, pd] = p.date.split('-').map(Number);
    const got = Date.UTC(py, pmo - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
    guess += want - got;
  }
  return new Date(guess);
}

export const addMinutes = (d, n) => new Date(d.getTime() + n * 60000);
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const isWeekend = (date) => [0, 6].includes(new Date(date + 'T12:00:00Z').getUTCDay());
