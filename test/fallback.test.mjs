import test from 'node:test';
import assert from 'node:assert/strict';
import { runFallback, fallbackLimit } from '../src/fallback.js';
import { runPhase } from '../src/engine.js';
import { reconcilePhase, reasonCodes } from '../src/reconcile.js';
import { Alpaca } from '../src/alpaca.js';
import { FakeBroker, testCtx } from './helpers.mjs';

/** Paper ctx with one recorded auction order (as the engine would log it) sitting at the broker with the given state. */
function setup({ at, source = 'afternoon', tif = 'cls', status = 'expired', filled = 0, qty = 50, side = 'buy', date = at.split('T')[0] } = {}) {
  const ctx = testCtx({ mode: 'paper', at });
  const clientId = `vamp-acct-full-${date}-${source}-SPY-${side}`;
  ctx.fb.orderList.push({ id: 'a1', client_order_id: clientId, symbol: 'SPY', side, qty: String(qty), filled_qty: String(filled), status, time_in_force: tif });
  ctx.store.appendJsonl('runs-acct-full.jsonl', { account: 'acct-full', date, phase: source, status: 'ok', orders: [{ symbol: 'SPY', side, qty, tif, clientId, orderId: 'a1', status: 'submitted' }] });
  return ctx;
}
const lines = (ctx, f) => ctx.store.readJsonl(f);

test('limit price math: buy ask+0.3%, sell bid-0.3%, last-trade +/-0.5% fallback, cents', () => {
  assert.equal(fallbackLimit('buy', { ask: 100, bid: 99 }, 98), 100.3);
  assert.equal(fallbackLimit('buy', { ask: 123.45 }, null), 123.82); // 123.8204 -> .82
  assert.equal(fallbackLimit('buy', { ask: 0 }, 200), 201);
  assert.equal(fallbackLimit('buy', null, 50.1), 50.35); // 50.3505 -> 50.35
  assert.equal(fallbackLimit('sell', { bid: 100, ask: 101 }, 1), 99.7);
  assert.equal(fallbackLimit('sell', {}, 100), 99.5);
  assert.equal(fallbackLimit('buy', null, null), null);
});

test('fallback-close: expired cls order -> AH limit for the full remainder, labelled and alerted', async () => {
  const ctx = setup({ at: '2026-11-16T16:01' });
  const r = await runFallback(ctx, 'acct-full', 'fallback-close');
  assert.equal(r.status, 'ok');
  assert.equal(ctx.fb.fallbacks.length, 1);
  const o = ctx.fb.fallbacks[0];
  assert.deepEqual([o.symbol, o.qty, o.side, o.kind, o.limitPrice], ['SPY', 50, 'buy', 'ah-limit', 100.3]);
  assert.equal(o.clientId, 'vamp-acct-full-2026-11-16-fbclose-SPY-buy');
  const d = lines(ctx, 'decisions-full.jsonl').find((x) => x.phase === 'fallback-close');
  assert.equal(d.leg, 'fallback-ah'); assert.equal(d.reason, 'auction_expired');
  assert.ok(lines(ctx, 'fills-full.jsonl').some((x) => x.type === 'fallback-close' && x.leg === 'fallback-ah'));
  assert.equal(ctx.alerts.length, 1); assert.match(ctx.alerts[0].b, /buy 50 SPY ah-limit @100.3/);
  assert.equal(ctx.fb.submits.length, 0); // never through the auction path
});

test('partial fill -> only the remainder; sell mirrors with bid-0.3%', async () => {
  const ctx = setup({ at: '2026-11-16T16:01', status: 'canceled', filled: 20, qty: 50, side: 'sell' });
  await runFallback(ctx, 'acct-full', 'fallback-close');
  const o = ctx.fb.fallbacks[0];
  assert.deepEqual([o.qty, o.side, o.limitPrice], [30, 'sell', 99.2]); // 99.5 * .997 = 99.2015
});

test('filled auction order -> nothing', async () => {
  const ctx = setup({ at: '2026-11-16T16:01', status: 'filled', filled: 50 });
  await runFallback(ctx, 'acct-full', 'fallback-close');
  assert.equal(ctx.fb.fallbacks, undefined); assert.equal(ctx.alerts.length, 0);
});

test('auction still pending -> nothing, and a later run can still act once it expires', async () => {
  const ctx = setup({ at: '2026-11-16T16:01', status: 'accepted' });
  const r = await runFallback(ctx, 'acct-full', 'fallback-close');
  assert.equal(ctx.fb.fallbacks, undefined); assert.match(r.notes.join(), /still accepted/);
  ctx.fb.orderList.find((o) => o.id === 'a1').status = 'expired';
  await runFallback(ctx, 'acct-full', 'fallback-close');
  assert.equal(ctx.fb.fallbacks.length, 1);
});

test('second run same day does nothing (state flag, and broker-side client id check)', async () => {
  const ctx = setup({ at: '2026-11-16T16:01' });
  await runFallback(ctx, 'acct-full', 'fallback-close');
  const again = await runFallback(ctx, 'acct-full', 'fallback-close');
  assert.equal(again.reason, 'already-done'); assert.equal(ctx.fb.fallbacks.length, 1);
  // even with state wiped, the existing fb order at the broker blocks a double buy
  ctx.store.writeJson('state-acct-full.json', { phases: {}, ledger: [], dry: {}, twin: null, alerts: {} });
  await runFallback(ctx, 'acct-full', 'fallback-close');
  assert.equal(ctx.fb.fallbacks.length, 1);
});

test('half day: gated on the 13:00 close (13:01 runs, 12:59 early, 16:01 not early but still within window? no: late)', async () => {
  const at = '2026-11-27T13:01';
  const ctx = setup({ at });
  ctx.setNow('2026-11-27', '12:59');
  assert.equal((await runFallback(ctx, 'acct-full', 'fallback-close')).reason, 'early');
  ctx.setNow('2026-11-27', '13:01');
  assert.equal((await runFallback(ctx, 'acct-full', 'fallback-close')).status, 'ok');
  assert.equal(ctx.fb.fallbacks.length, 1);
  const full = setup({ at: '2026-11-16T15:59' });
  assert.equal((await runFallback(full, 'acct-full', 'fallback-close')).reason, 'early');
});

test('closed day and late window are skipped', async () => {
  const ctx = setup({ at: '2026-11-15T16:01', date: '2026-11-15' }); // Sunday
  assert.equal((await runFallback(ctx, 'acct-full', 'fallback-close')).reason, 'closed');
  const late = setup({ at: '2026-11-16T19:30' });
  assert.equal((await runFallback(late, 'acct-full', 'fallback-close')).reason, 'late');
});

test('fallback-open: expired opg -> regular-hours market remainder; early before 9:31', async () => {
  const ctx = setup({ at: '2026-11-16T09:30', source: 'morning', tif: 'opg', filled: 10, qty: 40 });
  assert.equal((await runFallback(ctx, 'acct-full', 'fallback-open')).reason, 'early');
  ctx.setNow('2026-11-16', '09:32');
  await runFallback(ctx, 'acct-full', 'fallback-open');
  const o = ctx.fb.fallbacks[0];
  assert.deepEqual([o.qty, o.kind, o.limitPrice, o.clientId], [30, 'open-market', undefined, 'vamp-acct-full-2026-11-16-fbopen-SPY-buy']);
  assert.equal(lines(ctx, 'decisions-full.jsonl').at(-1).leg, 'fallback-open');
  await runFallback(ctx, 'acct-full', 'fallback-open');
  assert.equal(ctx.fb.fallbacks.length, 1);
});

test('dry accounts and kill switch send nothing; live needs confirm gates', async () => {
  const dry = testCtx({ mode: 'dry', at: '2026-11-16T16:01' });
  assert.equal((await runFallback(dry, 'acct-full', 'fallback-close')).reason, 'dry');
  const live = setup({ at: '2026-11-16T16:01' });
  live.cfg.accounts['acct-full'].mode = 'live';
  const r = await runFallback(live, 'acct-full', 'fallback-close');
  assert.equal(r.kind, 'mode'); assert.equal(live.fb.fallbacks, undefined);
  live.cfg.accounts['acct-full'].confirmLive = true;
  assert.equal((await runFallback(live, 'acct-full', 'fallback-close', { confirmLive: true })).status, 'ok');
});

test('submit failure alerts, is not marked complete, retries next run', async () => {
  const ctx = setup({ at: '2026-11-16T16:01' });
  ctx.fb.failFallback = true;
  assert.equal((await runFallback(ctx, 'acct-full', 'fallback-close')).status, 'error');
  ctx.fb.failFallback = false;
  assert.equal((await runFallback(ctx, 'acct-full', 'fallback-close')).status, 'ok');
  assert.equal(ctx.fb.fallbacks.length, 1);
});

test('reconcile: fallback fills are tagged, not flagged as missed; open alert notes the fallback', async () => {
  const ctx = setup({ at: '2026-11-16T09:32', source: 'morning', tif: 'opg', qty: 40 });
  await runFallback(ctx, 'acct-full', 'fallback-open');
  const f = ctx.fb.orderList.find((o) => o.id === 'f1'); f.status = 'filled'; f.filled_qty = '40'; f.filled_avg_price = '100.1';
  ctx.setNow('2026-11-16', '10:05');
  const r = await reconcilePhase(ctx, 'acct-full', 'reconcile-open');
  assert.equal(r.status, 'ok');
  assert.ok(r.fills.some((x) => x.fallback && x.leg === 'fallback-open' && x.filledQty === 40));
  const al = ctx.alerts.find((a) => /open auction problem/.test(a.s));
  assert.match(al.b, /fallback sent: 40\/40 filled/);
  const codes = reasonCodes({ orders: [{ status: 'expired', filledQty: 0, qty: 40 }, { fallback: true, status: 'filled', filledQty: 40, qty: 40 }] });
  assert.deepEqual(codes, ['missed_auction', 'fallback_used']);
});

test('alpaca guard: submit() still refuses non-auction tif; submitFallback builds only the two allowed shapes', async () => {
  const sent = [];
  const a = new Alpaca({ key: 'k', secret: 's', fetchImpl: async (u, i) => { sent.push(JSON.parse(i.body)); return { ok: true, text: async () => '{"id":"x"}' }; } });
  await assert.rejects(() => a.submit({ symbol: 'SPY', qty: 1, side: 'buy', tif: 'day', clientId: 'c' }), /non-auction/);
  await a.submitFallback({ symbol: 'SPY', qty: 5, side: 'buy', kind: 'ah-limit', limitPrice: 100.3, clientId: 'c1' });
  await a.submitFallback({ symbol: 'SPY', qty: 5, side: 'buy', kind: 'open-market', clientId: 'c2' });
  assert.deepEqual([sent[0].type, sent[0].time_in_force, sent[0].extended_hours, sent[0].limit_price], ['limit', 'day', true, '100.30']);
  assert.deepEqual([sent[1].type, sent[1].time_in_force, sent[1].extended_hours], ['market', 'day', undefined]);
  await assert.rejects(() => a.submitFallback({ symbol: 'SPY', qty: 5, side: 'buy', kind: 'ah-limit', clientId: 'c3' }), /limitPrice/);
  await assert.rejects(() => a.submitFallback({ symbol: 'SPY', qty: 5, side: 'buy', kind: 'cls', clientId: 'c4' }), /unknown fallback/);
});
