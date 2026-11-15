// Market-data facade: Alpaca when a client is available, Yahoo chart API as the fallback (and the only source for
// keyless DRY runs). Official open/close for reconciliation prefer Alpaca bars, with Yahoo as a cross-check fallback.
import { etParts } from './time.js';

export async function yahooBars(symbol, start, end, fetchImpl = fetch) {
  const p1 = Math.floor(new Date(start + 'T00:00:00Z').getTime() / 1000) - 86400;
  const p2 = Math.floor(new Date(end + 'T00:00:00Z').getTime() / 1000) + 2 * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplit`;
  const res = await fetchImpl(url, { headers: { 'user-agent': 'Mozilla/5.0 (vampire)' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`yahoo ${symbol} -> ${res.status}`);
  const j = await res.json();
  const r = j.chart?.result?.[0];
  if (!r) throw new Error(`yahoo ${symbol}: no result`);
  const q = r.indicators?.quote?.[0] || {};
  const bars = [];
  (r.timestamp || []).forEach((t, i) => {
    if (q.close[i] == null || q.open[i] == null) return;
    bars.push({ date: etParts(new Date(t * 1000)).date, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] });
  });
  return { bars, last: r.meta.regularMarketPrice, lastAt: r.meta.regularMarketTime };
}

export class Data {
  constructor({ alpaca = null, fetchImpl = fetch, warn = () => {} } = {}) { Object.assign(this, { alpaca, fetchImpl, warn }); this.warned = new Set(); }
  #warnOnce(m) { if (!this.warned.has(m)) { this.warned.add(m); this.warn(m); } }
  async dailyBars(symbol, start, end) {
    if (this.alpaca) {
      try { const b = await this.alpaca.dailyBars(symbol, start, end); if (b.length) return b; } catch (e) { this.#warnOnce(`alpaca bars failed (${e.message.slice(0, 90)}), using yahoo`); }
    } else this.#warnOnce('no Alpaca client: market data from Yahoo');
    return (await yahooBars(symbol, start, end, this.fetchImpl)).bars;
  }
  async latestPrice(symbol) {
    if (this.alpaca) {
      try { return await this.alpaca.latestPrice(symbol); } catch (e) { this.#warnOnce(`alpaca latest failed (${e.message.slice(0, 90)}), using yahoo`); }
    }
    const y = await yahooBars(symbol, etParts(new Date(Date.now() - 7 * 86400e3)).date, etParts(new Date()).date, this.fetchImpl);
    return { price: y.last, at: new Date(y.lastAt * 1000).toISOString(), source: 'yahoo' };
  }
  /** Official open/close for one date. Alpaca first; Yahoo if Alpaca has no bar. */
  async officialBar(symbol, date) {
    const next = new Date(date + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
    const end = next.toISOString().slice(0, 10);
    const pick = (bars) => bars.find((b) => b.date === date);
    if (this.alpaca) {
      try { const b = pick(await this.alpaca.dailyBars(symbol, date, end)); if (b) return { ...b, source: 'alpaca-' + this.alpaca.feed }; } catch (e) { this.#warnOnce(`alpaca official bar failed: ${e.message.slice(0, 90)}`); }
    }
    const b = pick((await yahooBars(symbol, date, end, this.fetchImpl)).bars);
    return b ? { ...b, source: 'yahoo' } : null;
  }
}
