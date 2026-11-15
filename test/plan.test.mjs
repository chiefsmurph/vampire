import test from 'node:test';
import assert from 'node:assert/strict';
import { planPhase, SafetyError, targetQty } from '../src/plan.js';
import { legSignal, sma } from '../src/signal.js';

const legs = [{ name: 'A', night: 'NIGHT', day: 'DAY', weight: 0.5 }, { name: 'B', night: 'N2', day: 'D2', weight: 0.5 }];
const prices = { NIGHT: 80, DAY: 40, N2: 25, D2: 20 };
const on = { A: { on: true }, B: { on: true } };
const base = { dayLeg: false }, full = { dayLeg: true };
const by = (r, s) => r.orders.find((o) => o.symbol === s);

test('sizing: 50% of equity / reference price, whole shares rounded down', () => {
  assert.equal(targetQty(100000, 0.5, 1, 80), 625);
  assert.equal(targetQty(100000, 0.5, 1, 33.33), 1500); // 1500.15 -> 1500
  assert.equal(targetQty(100000, 0.5, 1, 99999), 0);
  assert.equal(targetQty(0, 0.5, 1, 10), 0);
});

test('afternoon, both on, flat book: cls BUY night ETFs only (base and full)', () => {
  for (const v of [base, full]) {
    const r = planPhase({ phase: 'afternoon', legs, variant: v, equity: 100000, prices, flags: on });
    assert.deepEqual(r.orders.map((o) => [o.symbol, o.side, o.tif, o.qty]), [['NIGHT', 'buy', 'cls', 625], ['N2', 'buy', 'cls', 2000]]);
  }
});

test('morning: base sells night and never buys the day ETF; full buys day ETF with opg', () => {
  const positions = { NIGHT: 625, N2: 2000 };
  const b = planPhase({ phase: 'morning', legs, variant: base, equity: 100000, positions, prices, flags: on });
  assert.deepEqual(b.orders.map((o) => [o.symbol, o.side, o.tif, o.qty]), [['NIGHT', 'sell', 'opg', 625], ['N2', 'sell', 'opg', 2000]]);
  const f = planPhase({ phase: 'morning', legs, variant: full, equity: 100000, positions, prices, flags: on });
  assert.equal(by(f, 'DAY').side, 'buy'); assert.equal(by(f, 'DAY').tif, 'opg'); assert.equal(by(f, 'DAY').qty, 1250);
  assert.equal(by(f, 'D2').qty, 2500);
  assert.equal(by(f, 'NIGHT').side, 'sell');
});

test('afternoon: full sells the day ETF with cls and buys night ETF; leg off -> cash', () => {
  const r = planPhase({ phase: 'afternoon', legs, variant: full, equity: 100000, positions: { DAY: 1250, D2: 2500 }, prices, flags: { A: { on: false }, B: { on: true } } });
  assert.deepEqual(r.orders.map((o) => `${o.side} ${o.qty} ${o.symbol} ${o.tif}`).sort(), ['buy 2000 N2 cls', 'sell 1250 DAY cls', 'sell 2500 D2 cls']);
});

test('off leg with nothing held produces no orders', () => {
  const r = planPhase({ phase: 'morning', legs, variant: full, equity: 100000, prices, flags: { A: { on: false }, B: { on: false } } });
  assert.equal(r.orders.length, 0);
});

test('idempotency: queued orders and positions are netted, re-plan is a no-op', () => {
  const args = { phase: 'afternoon', legs, variant: full, equity: 100000, prices, flags: on };
  const first = planPhase(args);
  const queued = {}; for (const o of first.orders) queued[o.symbol] = o.side === 'buy' ? o.qty : -o.qty;
  assert.equal(planPhase({ ...args, queued }).orders.length, 0);
  const partial = planPhase({ ...args, queued: { NIGHT: 600 } });
  assert.deepEqual(by(partial, 'NIGHT'), { symbol: 'NIGHT', side: 'buy', qty: 25, tif: 'cls' });
  assert.equal(planPhase({ ...args, positions: { NIGHT: 625, N2: 2000 } }).orders.length, 0);
});

test('safety: book above 105% of equity is refused', () => {
  const bad = [{ name: 'A', night: 'NIGHT', day: 'DAY', weight: 1.2 }];
  assert.throws(() => planPhase({ phase: 'afternoon', legs: bad, variant: base, equity: 100000, prices, flags: { A: { on: true } } }), SafetyError);
  assert.doesNotThrow(() => planPhase({ phase: 'afternoon', legs, variant: base, equity: 100000, prices, flags: on }));
});

test('sma + legSignal: decision price stands in for today\'s close', () => {
  const closes = Array.from({ length: 10 }, (_, i) => 100 + i); // 100..109
  assert.equal(sma(closes, 5), 107);
  assert.equal(legSignal(closes, 5).on, true);          // 109 > 107
  assert.equal(legSignal(closes, 5, 100).on, false);    // price 100, sma(103..108,100)=...below
  assert.equal(legSignal(closes, 5, 110).sma, 108); // last five of ...109,110
  assert.equal(legSignal(closes, 50).on, false);         // not enough history: stay in cash
});
