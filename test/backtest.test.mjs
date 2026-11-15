import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const py = process.env.VAMPIRE_PYTHON || 'python3';
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'backtest');

test('backtest math (python unittest on synthetic data; skipped without pandas)', () => {
  const have = spawnSync(py, ['-c', 'import pandas, numpy'], { encoding: 'utf8' });
  if (have.status !== 0) return test.skip?.('pandas not installed') ?? undefined;
  const r = spawnSync(py, [join(dir, 'test_backtest.py')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
