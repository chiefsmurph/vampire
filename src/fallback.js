// Fallback phases: when an auction order (opg/cls) expired, was cancelled/rejected or part-filled, send the unfilled remainder
// through a normal order. Auction orders stay the primary path; this only runs after they have demonstrably failed.
//   fallback-open : 09:32 ET -> regular-hours MARKET, tif day, for the opg remainder
//   fallback-close: 16:01 ET -> extended-hours LIMIT (tif day) for the cls remainder; buy at ask+0.3%, sell at bid-0.3%
import { existsSync } from 'node:fs';
import { assertModeAllowed } from './config.js';
import { getCalendarRow, loadState, stateFile } from './engine.js';
import { addMinutes, etInstant, etParts } from './time.js';

export const FALLBACKS = {
  'fallback-open': { source: 'morning', tif: 'opg', kind: 'open-market', leg: 'fallback-open', tag: 'fbopen' },
  'fallback-close': { source: 'afternoon', tif: 'cls', kind: 'ah-limit', leg: 'fallback-ah', tag: 'fbclose' },
};
export const FALLBACK_TAGS = Object.values(FALLBACKS).map((f) => f.tag);
const PENDING = ['new', 'accepted', 'pending_new', 'partially_filled', 'accepted_for_bidding', 'held', 'pending_replace', 'pending_cancel', 'replaced'];
const DEAD = ['expired', 'canceled', 'cancelled', 'rejected', 'done_for_day', 'stopped', 'suspended'];
const LIMIT_PAD = 0.003, LAST_PAD = 0.005;
const c2 = (x) => Math.round(x * 100 + 1e-7) / 100;

/** Limit price: buy ask*(1+0.3%) (no ask: last*(1+0.5%)); sell bid*(1-0.3%) (no bid: last*(1-0.5%)); rounded to cents. */
export function fallbackLimit(side, quote, last) {
  const sgn = side === 'buy' ? 1 : -1;
  const ref = side === 'buy' ? quote?.ask : quote?.bid;
  if (ref > 0) return c2(ref * (1 + sgn * LIMIT_PAD));
  if (last > 0) return c2(last * (1 + sgn * LAST_PAD));
  return null;
}

export const fallbackClientId = (acct, date, tag, symbol, side) => `vamp-${acct}-${date}-${tag}-${symbol}-${side}`;

/** Which auction orders the engine submitted that day (from runs log), deduped by client id. */
function submittedAuctionOrders(ctx, accountName, date, sourcePhase) {
  const seen = new Map();
  for (const r of ctx.store.readJsonl(`runs-${accountName}.jsonl`)) {
    if (r.date !== date || r.phase !== sourcePhase) continue;
    for (const o of r.orders || []) if (['submitted', 'duplicate-ignored'].includes(o.status) && o.clientId) seen.set(o.clientId, o);
  }
  return [...seen.values()];
}

export async function runFallback(ctx, accountName, phase, opts = {}) {
  const spec = FALLBACKS[phase];
  if (!spec) throw new Error(`unknown fallback phase ${phase}`);
  const { cfg } = ctx;
  const acct = cfg.accounts[accountName];
  if (!acct) throw new Error(`unknown account ${accountName}`);
  const now = ctx.now(), today = etParts(now).date;
  const state = loadState(ctx.store, accountName);
  const out = { account: accountName, variant: acct.variant, mode: acct.mode, phase, date: today, at: now.toISOString(), orders: [], notes: [], status: 'ok' };
  const save = () => ctx.store.writeJson(stateFile(accountName), state);
  const finish = (status, extra = {}) => { Object.assign(out, { status }, extra); if (out.orders.length || status === 'error') ctx.store.appendJsonl(`runs-${accountName}.jsonl`, out); save(); return out; };
  const tag = `[${accountName}/${acct.variant}/${acct.mode}] ${phase} ${today}`;

  if (acct.mode === 'dry') return { ...out, status: 'skipped', reason: 'dry' };
  try { assertModeAllowed(acct, { env: ctx.env, confirmLiveFlag: opts.confirmLive }); }
  catch (e) { out.error = e.message; return finish('error', { kind: 'mode' }); }
  if (existsSync(ctx.killFile)) { out.error = 'kill switch present'; return finish('error', { kind: 'kill-switch' }); }
  const broker = ctx.broker(accountName);
  try {
    const row = await getCalendarRow(ctx, broker, acct.mode, today);
    if (!row) return { ...out, status: 'skipped', reason: 'closed' };
    const open = etInstant(today, row.open), close = etInstant(today, row.close);
    const [from, until] = phase === 'fallback-open' ? [addMinutes(open, 1), addMinutes(open, 90)] : [close, addMinutes(close, 180)];
    if (now < from) return { ...out, status: 'skipped', reason: 'early' };
    if (now >= until) return { ...out, status: 'skipped', reason: 'late' };
    const done = (state.fallbacks ||= {})[today] ||= {};
    if (done[phase]?.complete) return { ...out, status: 'skipped', reason: 'already-done' };

    const submitted = submittedAuctionOrders(ctx, accountName, today, spec.source);
    if (!submitted.length) { out.notes.push('no auction orders recorded today'); done[phase] = { complete: true, at: out.at, sent: 0 }; return finish('skipped', { reason: 'no-auction-orders' }); }
    const live = await broker.orders({ status: 'all', after: etInstant(today, '00:00').toISOString() });
    const sent = (done.sent ||= {});
    let pending = 0, failed = 0;
    for (const a of submitted) {
      const o = live.find((x) => (a.orderId && x.id === a.orderId) || x.client_order_id === a.clientId);
      if (!o) { out.notes.push(`order ${a.clientId} not found at broker; skipped`); continue; }
      if (PENDING.includes(o.status)) { pending++; out.notes.push(`${o.symbol} ${o.side}: auction still ${o.status}`); continue; }
      const remainder = Math.floor(Number(o.qty) - Number(o.filled_qty || 0));
      const fbId = fallbackClientId(accountName, today, spec.tag, o.symbol, o.side);
      if (o.status === 'filled' || remainder < 1) continue;
      if (!DEAD.includes(o.status)) { out.notes.push(`${o.symbol}: unexpected status ${o.status}; skipped`); continue; }
      if (sent[fbId] || live.some((x) => x.client_order_id === fbId)) { out.notes.push(`${o.symbol}: fallback already sent`); continue; }
      const rec = { symbol: o.symbol, side: o.side, qty: remainder, auctionQty: Number(o.qty), auctionFilled: Number(o.filled_qty || 0), auctionStatus: o.status, clientId: fbId, kind: spec.kind, leg: spec.leg, reason: 'auction_expired' };
      try {
        let limitPrice;
        if (spec.kind === 'ah-limit') {
          let quote = null, last = null;
          try { quote = await broker.latestQuote(o.symbol); } catch (e) { out.notes.push(`${o.symbol}: quote failed ${e.message.slice(0, 60)}`); }
          if (!(o.side === 'buy' ? quote?.ask > 0 : quote?.bid > 0)) { try { last = (await broker.latestPrice(o.symbol)).price; } catch { /* handled below */ } }
          limitPrice = fallbackLimit(o.side, quote, last);
          if (!limitPrice) throw new Error('no quote or last trade for limit price');
          Object.assign(rec, { limitPrice, bid: quote?.bid ?? null, ask: quote?.ask ?? null, last });
        }
        const r = await broker.submitFallback({ symbol: o.symbol, qty: remainder, side: o.side, kind: spec.kind, limitPrice, clientId: fbId });
        rec.status = r.duplicate ? 'duplicate-ignored' : 'submitted'; rec.orderId = r.id;
        sent[fbId] = { at: out.at, qty: remainder, orderId: r.id };
      } catch (e) { rec.status = 'failed'; rec.error = e.message; failed++; }
      out.orders.push(rec);
    }
    for (const rec of out.orders) ctx.store.appendJsonl(`decisions-${acct.variant}.jsonl`, { date: today, phase, account: accountName, at: out.at, leg: spec.leg, reason: 'auction_expired', ...rec });
    if (out.orders.length) ctx.store.appendJsonl(`fills-${acct.variant}.jsonl`, { type: phase, date: today, account: accountName, leg: spec.leg, reason: 'auction_expired', sent: out.orders });
    if (out.orders.length) await ctx.alert(`VAMPIRE fallback ${tag}`, out.orders.map((r) => `${r.side} ${r.qty} ${r.symbol} ${r.kind}${r.limitPrice ? ' @' + r.limitPrice : ''}: ${r.status}${r.error ? ' ' + r.error : ''} (auction ${r.auctionStatus}, filled ${r.auctionFilled}/${r.auctionQty})`).join('\n'));
    if (!pending && !failed) done[phase] = { complete: true, at: out.at, sent: out.orders.length };
    return finish(failed ? 'error' : 'ok', failed ? { kind: 'submit' } : {});
  } catch (e) {
    out.error = e.message;
    await ctx.alert(`VAMPIRE fallback FAILURE ${tag}`, String(e.stack || e.message));
    return finish('error', { kind: 'run' });
  }
}
