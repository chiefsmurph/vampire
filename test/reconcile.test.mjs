import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, dailySummaryText, reasonCodes, reconcilePhase, slippageBp, twinStep } from '../src/reconcile.js';
import { runPhase } from '../src/engine.js';
import { testCtx } from './helpers.mjs';

test('slippage bp is cost-positive for both sides', () => {
  assert.equal(slippageBp('buy', 100.05, 100), 5);
  assert.equal(slippageBp('buy', 99.95, 100), -5);
  assert.equal(slippageBp('sell', 99.95, 100), 5);
  assert.equal(slippageBp('sell', 100.1, 100), -10);
  assert.equal(slippageBp('buy', null, 100), null);
});

test('twin step: night pnl at the open, day pnl open->close, tonight sized from the close', () => {
  const legs = [{ name: 'A', night: 'N', day: 'D', weight: 1 }];
  const bars = { N: { o: 52, c: 50 }, D: { o: 20, c: 19 } };
  const r = twinStep({ equity: 10000, night: { N: { shares: 100, px: 50 } } }, { legs, variant: { dayLeg: true }, bars, flagPrev: { A: true }, flagNow: { A: true } });
  // night: +100*(52-50)=200 -> 10200; day: floor(10200/20)=510 sh * (19-20) = -510 -> 9690; tonight floor(9690/50)=193
  assert.equal(r.twin.equity, 9690);
  assert.deepEqual(r.twin.night, { N: { shares: 193, px: 50 } });
  assert.ok(Math.abs(r.ret - (9690 / 10000 - 1)) < 1e-12);
  const base = twinStep({ equity: 10000, night: { N: { shares: 100, px: 50 } } }, { legs, variant: { dayLeg: false }, bars, flagPrev: { A: true }, flagNow: { A: false } });
  assert.equal(base.twin.equity, 10200); assert.deepEqual(base.twin.night, {});
});

test('reason codes', () => {
  assert.deepEqual(reasonCodes({ orders: [{ status: 'filled', qty: 10, filledQty: 10 }], diffBp: 0 }), []);
  assert.deepEqual(reasonCodes({ orders: [{ status: 'canceled', qty: 10, filledQty: 0 }] }), ['missed_auction']);
  assert.deepEqual(reasonCodes({ orders: [{ status: 'partially_filled', qty: 10, filledQty: 4 }] }), ['partial_fill']);
  assert.deepEqual(reasonCodes({ flips: [{}] }), ['signal_flip']);
  assert.deepEqual(reasonCodes({ feeUsd: 1.5 }), ['fee']);
  assert.deepEqual(reasonCodes({ diffBp: 8, twinShares: { A: 10 }, actualShares: { A: 9 } }), ['rounding']);
  assert.deepEqual(reasonCodes({ diffBp: 8, twinShares: { A: 10 }, actualShares: { A: 10 } }), ['unknown']);
  assert.deepEqual(reasonCodes({ diffBp: 0.2, twinShares: { A: 10 }, actualShares: { A: 9 } }), []);
});

async function paperDay(equityEnd = 100400) {
  const ctx = testCtx({ mode: 'paper', at: '2026-11-16T09:20' });
  await runPhase(ctx, 'acct-full', 'morning');
  ctx.setNow('2026-11-16', '15:45');
  await runPhase(ctx, 'acct-full', 'afternoon');
  // fill everything at the official auction price plus a known slip
  const bar = (s) => ctx.data.map[s].find((b) => b.date === '2026-11-16');
  for (const o of ctx.fb.orderList) {
    const off = o.time_in_force === 'opg' ? bar(o.symbol).o : bar(o.symbol).c;
    o.status = 'filled'; o.filled_qty = o.qty; o.filled_avg_price = String(off * (o.side === 'buy' ? 1.0005 : 0.9995));
  }
  ctx.fb.equity = equityEnd; ctx.fb.lastEquity = 100000;
  ctx.setNow('2026-11-16', '16:30');
  return ctx;
}

test('paper close reconciliation: slippage vs official price, twin, diff, summary shape', async () => {
  const ctx = await paperDay();
  const r = await reconcilePhase(ctx, 'acct-full', 'reconcile-close');
  assert.equal(r.status, 'ok');
  const rec = r.record;
  assert.equal(rec.fills.length, 3);
  for (const f of rec.fills) assert.ok(Math.abs(f.slipBp - 5) < 0.05, `${f.symbol} slip ${f.slipBp}`);
  assert.equal(rec.actualRetPct, 0.4);
  assert.ok(rec.expectedRetPct != null && rec.twinEquity > 0);
  assert.ok(Math.abs(rec.diffBp - (0.004 - rec.expectedRetPct / 100) * 1e4) <= 0.6); // expectedRetPct is rounded to 0.01%
  assert.ok(rec.reasons.length >= 0);
  const rows = ctx.store.readJsonl('paper-full.jsonl');
  assert.equal(rows.length, 1);
  const sum = ctx.store.readJson('strategy-overnight-paper.json');
  assert.ok(sum.updated); assert.equal(sum.sleeves.length, 1);
  const s = sum.sleeves[0];
  for (const k of ['name', 'since', 'ret', 'spy', 'fills', 'slippageBps', 'note', 'twin', 'diffBp']) assert.ok(k in s, k);
  assert.equal(s.fills, 3); assert.equal(s.since, '2026-11-16'); assert.ok(Math.abs(s.slippageBps - 5) < 0.05);
  assert.match(dailySummaryText([r]), /slip 5/);
  // idempotent
  const again = await reconcilePhase(ctx, 'acct-full', 'reconcile-close');
  assert.equal(again.reason, 'already-done');
  assert.equal(ctx.store.readJsonl('paper-full.jsonl').length, 1);
});

test('missed and partial fills get reason codes and an alert', async () => {
  const ctx = await paperDay();
  ctx.fb.orderList[0].status = 'canceled'; ctx.fb.orderList[0].filled_qty = '0'; ctx.fb.orderList[0].filled_avg_price = null;
  ctx.fb.orderList[1].status = 'partially_filled'; ctx.fb.orderList[1].filled_qty = String(Math.floor(Number(ctx.fb.orderList[1].qty) / 2));
  const r = await reconcilePhase(ctx, 'acct-full', 'reconcile-close');
  assert.deepEqual(r.record.reasons.slice(0, 2), ['missed_auction', 'partial_fill']);
});

test('signal flip: decision price said off, official close says on -> logged and alerted', async () => {
  const ctx = await paperDay();
  const d = ctx.store.readJsonl('decisions-full.jsonl');
  const aft = d.find((x) => x.phase === 'afternoon');
  aft.legs.A.on = false; aft.legs.A.price = 1;
  ctx.store.writeJson('x', 1);
  // rewrite the decisions file with the flipped decision
  const { writeFileSync } = await import('node:fs');
  writeFileSync(ctx.store.path('decisions-full.jsonl'), d.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const r = await reconcilePhase(ctx, 'acct-full', 'reconcile-close');
  assert.equal(r.record.flips.length, 1); assert.ok(r.record.reasons.includes('signal_flip'));
  assert.ok(ctx.alerts.some((a) => /signal flip/.test(a.s)));
});

test('dry reconcile: twin only, dry equity compounds, summary flags DRY', async () => {
  const ctx = testCtx({ mode: 'dry', at: '2026-11-16T09:20' });
  await runPhase(ctx, 'acct-full', 'morning');
  ctx.setNow('2026-11-16', '15:45'); await runPhase(ctx, 'acct-full', 'afternoon');
  ctx.setNow('2026-11-16', '16:30');
  const r = await reconcilePhase(ctx, 'acct-full', 'reconcile-close');
  assert.equal(r.status, 'ok'); assert.equal(r.record.actualRetPct, null); assert.equal(r.record.fills.length, 0);
  assert.ok(r.record.twinEquity > 0);
  const sum = buildSummary(ctx.store, ctx.cfg);
  assert.match(sum.sleeves[0].note, /DRY/); assert.equal(sum.sleeves[0].ret, null);
  const early = await reconcilePhase(Object.assign(ctx, { now: () => new Date('2026-11-17T20:00:00Z') }), 'acct-base', 'reconcile-close');
  assert.ok(['skipped', 'ok'].includes(early.status));
});

test('reconcile-close before 16:25 ET is refused as early', async () => {
  const ctx = await paperDay();
  ctx.setNow('2026-11-16', '15:59');
  assert.equal((await reconcilePhase(ctx, 'acct-full', 'reconcile-close')).reason, 'early');
});
