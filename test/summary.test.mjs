import test from 'node:test';
import assert from 'node:assert/strict';
import { legStatus, buildDailySummary, runSummary } from '../src/summary.js';
import { runPhase } from '../src/engine.js';
import { reconcilePhase } from '../src/reconcile.js';
import { testCtx } from './helpers.mjs';

const mk = (closes) => closes.map((c, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, c }));

test('legStatus: gap, streak, flip level', () => {
  // ma=3: closes 10,10,10,12,12 -> ON since idx 3
  const b = mk([10, 10, 10, 12, 12]);
  const s = legStatus(b, 3);
  assert.equal(s.on, true); assert.equal(s.streak, 2); assert.equal(s.since, '2026-01-04');
  assert.ok(Math.abs(s.sma - 34 / 3) < 1e-9);
  assert.equal(s.flipLevel, 12); // mean of last (ma-1)=2 closes: next close must exceed this to be ON
  const d = legStatus(mk([10, 10, 10, 12, 12, 9]), 3);
  assert.equal(d.on, false); assert.equal(d.streak, 1); assert.ok(d.flipPct > 0);
  assert.equal(legStatus(mk([1, 2]), 3), null);
});

test('daily summary: needs finished records, writes JSON, emails once', async () => {
  const ctx = testCtx({ mode: 'paper', at: '2026-11-16T09:20' });
  assert.equal(await buildDailySummary(ctx, '2026-11-16'), null);
  for (const a of ['acct-base', 'acct-full']) await runPhase(ctx, a, 'morning');
  ctx.setNow('2026-11-16', '15:45');
  for (const a of ['acct-base', 'acct-full']) await runPhase(ctx, a, 'afternoon');
  ctx.fb.equity = 100400; ctx.fb.lastEquity = 100000;
  ctx.setNow('2026-11-16', '16:30');
  assert.equal(await buildDailySummary(ctx, '2026-11-16'), null);
  for (const a of ['acct-base', 'acct-full']) await reconcilePhase(ctx, a, 'reconcile-close');
  ctx.alerts.length = 0;
  const r = await runSummary(ctx, { date: '2026-11-16' });
  assert.equal(r.status, 'ok');
  assert.match(r.subject, /^Vampire daily - Nov 16:/);
  assert.match(r.text, /-day MA/); assert.match(r.text, /Tomorrow:/);
  assert.equal(ctx.alerts.length, 1);
  const j = ctx.store.readJson('strategy-overnight-paper.json');
  assert.ok(j.legs.length && j.history.length === 1 && j.sleeves.length === 2);
  assert.equal((await runSummary(ctx, { date: '2026-11-16' })).reason, 'already-sent');
  assert.equal(ctx.alerts.length, 1);
});
