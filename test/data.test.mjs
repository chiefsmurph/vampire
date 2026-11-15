import test from 'node:test';
import assert from 'node:assert/strict';
import { Data, yahooBars } from '../src/data.js';

const ok = (body) => async () => ({ ok: true, json: async () => body });

test('yahoo bars: dates are ET session dates; days with no data give an empty list, not a crash', async () => {
  const t = Date.UTC(2026, 10, 13, 14, 30) / 1000; // 09:30 ET
  const r = await yahooBars('X', '2026-11-13', '2026-11-14', ok({ chart: { result: [{ meta: { regularMarketPrice: 5 }, timestamp: [t], indicators: { quote: [{ open: [1], high: [2], low: [0.5], close: [1.5], volume: [10] }] } }] } }));
  assert.deepEqual(r.bars.map((b) => [b.date, b.o, b.c]), [['2026-11-13', 1, 1.5]]);
  const none = await yahooBars('X', '2026-11-16', '2026-11-17', ok({ chart: { result: [{ meta: {}, indicators: { quote: [{}] } }] } }));
  assert.deepEqual(none.bars, []);
});

test('Data falls back to yahoo when the alpaca client fails, and warns once', async () => {
  const warns = [];
  const alpaca = { feed: 'iex', dailyBars: async () => { throw new Error('403'); } };
  const t = Date.UTC(2026, 10, 13, 14, 30) / 1000;
  const d = new Data({ alpaca, warn: (m) => warns.push(m), fetchImpl: ok({ chart: { result: [{ meta: {}, timestamp: [t], indicators: { quote: [{ open: [1], high: [1], low: [1], close: [2], volume: [1] }] } }] } }) });
  assert.equal((await d.officialBar('X', '2026-11-13')).source, 'yahoo');
  await d.officialBar('X', '2026-11-13');
  assert.equal(warns.length, 1);
});
