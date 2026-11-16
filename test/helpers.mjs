import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx } from '../src/context.js';
import { ROOT } from '../src/config.js';
import { builtinCalendar } from '../src/nyse.js';
import { Store } from '../src/store.js';
import { addDays, etInstant, isWeekend } from '../src/time.js';

export const EXAMPLES = join(ROOT, 'examples');

/** Weekday bars 2025-01-01..2026-12-31 with a deterministic gentle uptrend (or downtrend if slope<0). */
export function series(start = 100, slope = 0.15, { o = -0.2, wobble = 0.5 } = {}) {
  const bars = []; let px = start, i = 0;
  for (let d = '2025-01-01'; d <= '2026-12-31'; d = addDays(d, 1)) {
    if (isWeekend(d)) continue;
    px += slope + (i % 2 ? wobble : -wobble) * 0.1; i++;
    bars.push({ date: d, o: +(px + o).toFixed(2), h: px + 1, l: px - 1, c: +px.toFixed(2), v: 1e6 });
  }
  return bars;
}

export class FakeData {
  constructor(map, live = {}) { this.map = map; this.live = live; this.calls = []; }
  async dailyBars(s, a, b) { this.calls.push(['bars', s]); if (!this.map[s]) throw new Error('no bars ' + s); return this.map[s].filter((x) => x.date >= a && x.date <= b); }
  async latestPrice(s) { if (this.live[s] != null) return { price: this.live[s], source: 'fake-live' }; const l = this.map[s].filter((x) => x.date < this.today).at(-1); return { price: l.c, source: 'fake-last' }; }
  async officialBar(s, d) { const b = this.map[s].find((x) => x.date === d); return b ? { ...b, source: 'fake' } : null; }
}

export class FakeBroker {
  constructor({ equity = 100000, positions = [], calendarFn = builtinCalendar } = {}) { Object.assign(this, { equity, posList: positions, orderList: [], calendarFn, submits: [], healthy: true, fillMap: {} }); }
  async account() { return { status: 'ACTIVE', trading_blocked: false, equity: String(this.equity), last_equity: String(this.lastEquity ?? this.equity), buying_power: String(this.equity * 2), account_number: 'PA123' }; }
  async positions() { return this.posList; }
  async orders() { return this.orderList; }
  async calendar(a, b) { if (!this.healthy) throw new Error('calendar down'); return this.calendarFn(a, b); }
  async submit(o) {
    if (this.failSubmit) throw new Error('rejected by broker');
    this.submits.push(o);
    const rec = { id: 'o' + this.submits.length, client_order_id: o.clientId, symbol: o.symbol, side: o.side, qty: String(o.qty), filled_qty: '0', status: 'new', time_in_force: o.tif };
    this.orderList.push(rec);
    return rec;
  }
  async latestQuote(sym) { return this.quotes?.[sym] ?? { bid: 99.5, ask: 100 }; }
  async latestPrice(sym) { return { price: this.lasts?.[sym] ?? 100 }; }
  async submitFallback(o) {
    if (this.failFallback) throw new Error('fallback rejected');
    this.fallbacks = [...(this.fallbacks || []), o];
    const rec = { id: 'f' + this.fallbacks.length, client_order_id: o.clientId, symbol: o.symbol, side: o.side, qty: String(o.qty), filled_qty: '0', status: 'new', time_in_force: 'day' };
    this.orderList.push(rec);
    return rec;
  }
}

export function testCtx({ mode = 'dry', at = '2026-11-16T09:20', slope = 0.15, data, broker } = {}) {
  const [date, hhmm] = at.split('T');
  const store = new Store(mkdtempSync(join(tmpdir(), 'vamp-test-')));
  const alerts = [];
  const ctx = makeCtx({ dir: EXAMPLES, store, env: {}, alert: async (s, b) => alerts.push({ s, b }), warn: () => {} });
  ctx.now = () => etInstant(date, hhmm);
  ctx.alerts = alerts;
  const map = { SPY: series(500, slope), SH: series(30, -slope / 20, { o: 0.02, wobble: 0.01 }) };
  ctx.data = data || new FakeData(map);
  ctx.data.today = date;
  ctx.fb = broker || new FakeBroker();
  ctx.broker = () => ctx.fb;
  for (const a of Object.values(ctx.cfg.accounts)) a.mode = mode;
  ctx.setNow = (d, h) => { ctx.now = () => etInstant(d, h); ctx.data.today = d; };
  return ctx;
}
