import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPhase } from '../src/engine.js';
import { FakeBroker, testCtx } from './helpers.mjs';

const fmt = (r) => r.orders.map((o) => `${o.side} ${o.qty} ${o.symbol} ${o.tif}`);

test('dry morning, flat book: base places nothing, full would buy the day ETF with opg', async () => {
  const ctx = testCtx({ mode: 'dry' });
  const b = await runPhase(ctx, 'acct-base', 'morning');
  const f = await runPhase(ctx, 'acct-full', 'morning');
  assert.equal(b.status, 'ok'); assert.deepEqual(fmt(b), []);
  assert.equal(f.orders.length, 1);
  assert.equal(f.orders[0].symbol, 'SH'); assert.equal(f.orders[0].tif, 'opg'); assert.equal(f.orders[0].status, 'dry-would-place');
  assert.equal(ctx.fb.submits.length, 0);
});

test('dry run is idempotent: re-run skips, even when forced', async () => {
  const ctx = testCtx({ mode: 'dry' });
  const a = await runPhase(ctx, 'acct-full', 'morning');
  const again = await runPhase(ctx, 'acct-full', 'morning');
  const forced = await runPhase(ctx, 'acct-full', 'morning', { force: true });
  assert.equal(a.orders.length, 1); assert.equal(again.reason, 'already-done'); assert.equal(forced.orders.length, 0);
});

test('dry two-day cycle: afternoon sells day ETF + buys night ETF; next morning sells the night ETF', async () => {
  const ctx = testCtx({ mode: 'dry' });
  await runPhase(ctx, 'acct-full', 'morning');
  ctx.setNow('2026-11-16', '15:45');
  const aft = await runPhase(ctx, 'acct-full', 'afternoon');
  assert.deepEqual(fmt(aft).map((s) => s.replace(/ \d+ /, ' N ')), ['sell N SH cls', 'buy N SPY cls']);
  assert.ok(aft.flags.A.on);
  ctx.setNow('2026-11-17', '09:20');
  const m2 = await runPhase(ctx, 'acct-full', 'morning');
  assert.deepEqual(fmt(m2).map((s) => s.replace(/ \d+ /, ' N ')), ['sell N SPY opg', 'buy N SH opg']);
});

test('downtrend: leg off -> cash, no orders', async () => {
  const ctx = testCtx({ mode: 'dry', at: '2026-11-16T15:45', slope: -0.15 });
  const r = await runPhase(ctx, 'acct-base', 'afternoon');
  assert.equal(r.flags.A.on, false); assert.equal(r.orders.length, 0);
});

test('paper mode submits only opg/cls market orders and a re-run never doubles them', async () => {
  const ctx = testCtx({ mode: 'paper', at: '2026-11-16T15:45' });
  const r = await runPhase(ctx, 'acct-base', 'afternoon');
  assert.equal(r.status, 'ok');
  assert.equal(ctx.fb.submits.length, 1);
  const s = ctx.fb.submits[0];
  assert.deepEqual([s.symbol, s.side, s.tif], ['SPY', 'buy', 'cls']);
  assert.match(s.clientId, /^vamp-acct-base-2026-11-16-afternoon-SPY-buy$/);
  assert.ok(Number.isInteger(s.qty));
  const forced = await runPhase(ctx, 'acct-base', 'afternoon', { force: true });
  assert.equal(forced.orders.length, 0); assert.equal(ctx.fb.submits.length, 1);
});

test('a retry after a failed submit places the orders (not marked done)', async () => {
  const ctx = testCtx({ mode: 'paper', at: '2026-11-16T15:45' });
  ctx.fb.failSubmit = true;
  const bad = await runPhase(ctx, 'acct-base', 'afternoon');
  assert.equal(bad.status, 'error'); assert.equal(ctx.alerts.length, 1); assert.match(ctx.alerts[0].s, /ORDER FAILURE/);
  ctx.fb.failSubmit = false; ctx.setNow('2026-11-16', '15:47');
  const ok = await runPhase(ctx, 'acct-base', 'afternoon');
  assert.equal(ok.status, 'ok'); assert.equal(ctx.fb.submits.length, 1);
});

test('kill switch blocks orders and alerts', async () => {
  const ctx = testCtx({ mode: 'paper', at: '2026-11-16T15:45' });
  ctx.killFile = join(mkdtempSync(join(tmpdir(), 'k-')), 'KILL'); writeFileSync(ctx.killFile, '');
  const r = await runPhase(ctx, 'acct-base', 'afternoon');
  assert.equal(r.kind, 'kill-switch'); assert.equal(ctx.fb.submits.length, 0); assert.equal(ctx.alerts.length, 1);
});

test('unhealthy calendar API: no trading, alert', async () => {
  const ctx = testCtx({ mode: 'paper', at: '2026-11-16T15:45', broker: Object.assign(new FakeBroker(), { healthy: false }) });
  const r = await runPhase(ctx, 'acct-base', 'afternoon');
  assert.equal(r.kind, 'calendar-unhealthy'); assert.equal(ctx.fb.submits.length, 0); assert.match(ctx.alerts[0].s, /calendar-unhealthy/);
});

test('holiday: silently skipped, no alert, no orders', async () => {
  const ctx = testCtx({ mode: 'paper', at: '2026-11-26T09:20' });
  const r = await runPhase(ctx, 'acct-full', 'morning');
  assert.equal(r.status, 'skipped'); assert.equal(r.reason, 'closed'); assert.equal(ctx.alerts.length, 0);
});

test('half day: the 15:45 cron is late (silent if already done, loud if not); 12:45 runs', async () => {
  const ctx = testCtx({ mode: 'paper', at: '2026-11-27T15:45' });
  const late = await runPhase(ctx, 'acct-base', 'afternoon');
  assert.equal(late.kind, 'missed-window'); assert.equal(ctx.alerts.length, 1);
  const ctx2 = testCtx({ mode: 'paper', at: '2026-11-27T12:45' });
  const ok = await runPhase(ctx2, 'acct-base', 'afternoon');
  assert.equal(ok.status, 'ok'); assert.equal(ctx2.fb.submits.length, 1);
  ctx2.setNow('2026-11-27', '15:45');
  const quiet = await runPhase(ctx2, 'acct-base', 'afternoon');
  assert.equal(quiet.status, 'skipped'); assert.equal(ctx2.alerts.length, 0);
});

test('live mode needs the explicit confirm flag', async () => {
  const ctx = testCtx({ mode: 'live', at: '2026-11-16T15:45' });
  const r = await runPhase(ctx, 'acct-base', 'afternoon');
  assert.equal(r.kind, 'mode'); assert.equal(ctx.fb.submits.length, 0);
  ctx.cfg.accounts['acct-base'].confirmLive = true;
  assert.equal((await runPhase(ctx, 'acct-base', 'afternoon')).kind, 'mode'); // config alone is not enough
  const ok = await runPhase(ctx, 'acct-base', 'afternoon', { confirmLive: true });
  assert.equal(ok.status, 'ok'); assert.equal(ctx.fb.submits.length, 1);
});

test('stale market data aborts the run with an alert', async () => {
  const ctx = testCtx({ mode: 'dry', at: '2027-03-01T09:20' });
  const r = await runPhase(ctx, 'acct-base', 'morning');
  assert.equal(r.status, 'error'); assert.match(r.error, /stale|no bars|no reference/i); assert.equal(ctx.alerts.length, 1);
});
