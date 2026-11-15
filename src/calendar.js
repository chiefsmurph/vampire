// Phase scheduling derived from a trading-calendar row, never from fixed clock times.
import { etInstant, addMinutes } from './time.js';

export const PHASES = ['morning', 'afternoon', 'reconcile-open', 'reconcile-close'];

/** Alpaca cutoffs: opg must be in before 09:28 ET, cls before 15:50 ET (close - 10 min; early closes shift with the close). */
export function phaseWindows(row) {
  const open = etInstant(row.date, row.open), close = etInstant(row.date, row.close);
  return {
    morning: { target: addMinutes(open, -10), deadline: addMinutes(open, -2) },
    afternoon: { target: addMinutes(close, -15), deadline: addMinutes(close, -10) },
    'reconcile-open': { target: addMinutes(open, 30), deadline: null },
    'reconcile-close': { target: addMinutes(close, 30), deadline: null },
  };
}

const SLACK_MIN = 2; // cron fires at the target minute; tolerate small clock skew

/** -> { ok, reason } where reason is 'closed' | 'early' | 'late' | 'ok' */
export function checkWindow(phase, now, row) {
  if (!row) return { ok: false, reason: 'closed' };
  const w = phaseWindows(row)[phase];
  if (!w) throw new Error(`unknown phase ${phase}`);
  if (now < addMinutes(w.target, -SLACK_MIN)) return { ok: false, reason: 'early', target: w.target };
  if (w.deadline && now >= w.deadline) return { ok: false, reason: 'late', deadline: w.deadline };
  return { ok: true, reason: 'ok', target: w.target, deadline: w.deadline };
}

export const normalizeRow = (r) => ({ date: r.date, open: (r.open || '09:30').slice(0, 5), close: (r.close || '16:00').slice(0, 5) });
export const isHalfDay = (row) => row.close < '16:00';
