// Minimal Alpaca REST adapter (Node fetch, no SDK). Trading + market data.
// Auction orders: market + time_in_force 'opg' (market-on-open) or 'cls' (market-on-close). Whole shares only:
// Alpaca accepts fractional/notional quantities for DAY orders only, so planPhase always emits integer qty.
const URLS = { paper: 'https://paper-api.alpaca.markets', live: 'https://api.alpaca.markets', data: 'https://data.alpaca.markets' };

export class AlpacaError extends Error {
  constructor(msg, status, body) { super(msg); this.status = status; this.body = body; }
}

export class Alpaca {
  constructor({ key, secret, mode = 'paper', feed = 'sip', fetchImpl = fetch, warn = () => {} }) {
    if (!key || !secret) throw new Error('Alpaca keys missing');
    Object.assign(this, { key, secret, mode, feed, fetchImpl, warn });
    this.base = mode === 'live' ? URLS.live : URLS.paper;
  }
  async #req(base, path, { method = 'GET', body, query } = {}) {
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null)).toString() : '';
    const res = await this.fetchImpl(base + path + qs, {
      method, signal: AbortSignal.timeout(20000),
      headers: { 'APCA-API-KEY-ID': this.key, 'APCA-API-SECRET-KEY': this.secret, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) throw new AlpacaError(`Alpaca ${method} ${path} -> ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`, res.status, json);
    return json;
  }
  account() { return this.#req(this.base, '/v2/account'); }
  positions() { return this.#req(this.base, '/v2/positions').then((r) => r.map((p) => ({ symbol: p.symbol, qty: Number(p.qty) }))); }
  orders({ status = 'all', after, limit = 500 } = {}) { return this.#req(this.base, '/v2/orders', { query: { status, after, limit, direction: 'asc' } }); }
  asset(symbol) { return this.#req(this.base, `/v2/assets/${symbol}`); }
  fees(date) { return this.#req(this.base, '/v2/account/activities/FEE', { query: { date } }); }
  calendar(start, end) { return this.#req(this.base, '/v2/calendar', { query: { start, end } }); }
  async submit({ symbol, qty, side, tif, clientId }) {
    if (!Number.isInteger(qty) || qty < 1) throw new Error(`auction orders need whole shares, got ${qty}`);
    if (!['opg', 'cls'].includes(tif)) throw new Error(`refusing non-auction tif ${tif}`); // never market/limit outside the auctions
    try {
      return await this.#req(this.base, '/v2/orders', { method: 'POST', body: { symbol, qty: String(qty), side, type: 'market', time_in_force: tif, client_order_id: clientId } });
    } catch (e) {
      if (e.status === 422 && /client_order_id/i.test(e.message)) return { duplicate: true, client_order_id: clientId };
      throw e;
    }
  }
  /** Daily bars [{date,o,h,l,c,v}] (split-adjusted). Downgrades SIP -> IEX on 403 and warns. */
  async dailyBars(symbol, start, end) {
    const out = []; let token;
    for (let i = 0; i < 20; i++) {
      let r;
      try {
        r = await this.#req(URLS.data, `/v2/stocks/${symbol}/bars`, { query: { timeframe: '1Day', start, end, adjustment: 'split', feed: this.feed, limit: 10000, page_token: token } });
      } catch (e) {
        if (e.status === 403 && this.feed === 'sip') { this.warn('SIP feed not permitted for these keys; falling back to IEX (quotes are IEX-only)'); this.feed = 'iex'; i--; continue; }
        throw e;
      }
      for (const b of r.bars || []) out.push({ date: b.t.slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      token = r.next_page_token; if (!token) break;
    }
    return out;
  }
  async latestPrice(symbol) {
    for (;;) {
      try {
        const r = await this.#req(URLS.data, `/v2/stocks/${symbol}/trades/latest`, { query: { feed: this.feed } });
        return { price: r.trade.p, at: r.trade.t, source: `alpaca-${this.feed}` };
      } catch (e) {
        if (e.status === 403 && this.feed === 'sip') { this.warn('SIP feed not permitted; using IEX'); this.feed = 'iex'; continue; }
        throw e;
      }
    }
  }
}
