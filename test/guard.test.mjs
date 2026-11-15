import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan } from '../scripts/guard.mjs';

// Sensitive strings are assembled at runtime so this file itself stays clean.
const tick = ['TQ', 'QQ'].join(''), tick2 = ['R', 'WM'].join('');
const ma = ['maLength: 2', '50'].join('');
function repo(files) {
  const d = mkdtempSync(join(tmpdir(), 'guard-'));
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), c); }
  return [d, Object.keys(files)];
}
const rules = (files) => scan(...repo(files)).map((x) => x.rule);

test('clean example config passes', () => {
  assert.deepEqual(rules({ 'examples/config.json': '{"maLength": 200, "signal": "SPY", "night": "SPY", "day": "SH"}' }), []);
});
test('private tickers are blocked by hash, wherever they appear', () => {
  assert.deepEqual(rules({ 'src/x.js': `const t = '${tick}';` }), ['private-ticker']);
  assert.deepEqual(rules({ 'examples/c.json': `{"day":"${tick2}"}` }), ['private-ticker']);
  assert.deepEqual(rules({ 'src/x.js': "const t = 'zzzz lowercase is not a ticker token';" }), []);
});
test('the private MA length is blocked as config', () => {
  assert.ok(rules({ 'examples/c.json': `{"${ma.replace(': ', '": ')}}` }).includes('ma-config'));
  assert.ok(rules({ 'README.md': `run --ma ${['2', '50'].join('')}` }).includes('ma-flag'));
});
test('private paths, keys, env files and data are blocked', () => {
  assert.ok(rules({ 'a.js': `const p = '/${'Users'}/someone/code';` }).includes('private-path'));
  assert.ok(rules({ 'a.js': `const p = '/${'root'}/somewhere/x';` }).includes('private-path'));
  assert.ok(rules({ 'a.js': `const k = 'PK${'ABCDEFGHIJ0123456789'.slice(0, 18)}';` }).includes('alpaca-key'));
  assert.ok(rules({ 'a.js': `ALPACA_SECRET=${'x'.repeat(40)}` }).includes('key-assignment'));
  assert.ok(rules({ '.env': 'A=1' }).includes('forbidden-path'));
  assert.ok(rules({ 'data/paper-full.jsonl': '{}' }).includes('forbidden-path'));
});
test('extra plaintext denylist terms (from the private dir) are blocked', () => {
  const [d, f] = repo({ 'README.md': 'Alice Example was here' });
  assert.equal(scan(d, f, { extraTerms: ['alice example'] }).length, 1);
});
