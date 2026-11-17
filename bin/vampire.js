#!/usr/bin/env node
import { makeCtx } from '../src/context.js';
import { runPhase } from '../src/engine.js';
import { runFallback } from '../src/fallback.js';
import { reconcilePhase } from '../src/reconcile.js';
import { preflight, preflightOk } from '../src/preflight.js';
import { formatSimulation, simulate } from '../src/simulate.js';
import { runSummary } from '../src/summary.js';
import { etParts } from '../src/time.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const USAGE = `vampire <command>
  run <morning|afternoon|reconcile-open|reconcile-close|fallback-open|fallback-close> [--account NAME] [--now ISO] [--force] [--confirm-live]
  run summary [--date YYYY-MM-DD] [--force] [--no-email]   daily summary email + dashboard JSON (idempotent)
  simulate [--date YYYY-MM-DD] [--equity 100000]     full dry run, prints the planned orders
  preflight [--account NAME]                         verify keys, account, symbols, calendar, feed
  status                                             per-account mode, last runs
env: PRIVATE_DIR (default ../vampire-private, else examples/)`;

async function main() {
  if (!cmd || cmd === '-h' || cmd === '--help') return console.log(USAGE);
  if (cmd === 'simulate') {
    const date = opt('date', etParts(new Date(Date.now() + 86400e3)).date), equity = Number(opt('equity', 100000));
    console.log(formatSimulation(await simulate({ dir: process.env.PRIVATE_DIR, date, equity }), date, equity));
    return;
  }
  const nowOpt = opt('now');
  const ctx = makeCtx({ dir: process.env.PRIVATE_DIR, now: nowOpt ? () => new Date(nowOpt) : () => new Date() });
  if (cmd === 'preflight') {
    const rows = await preflight(ctx, opt('account'));
    for (const r of rows) console.log(`${{ ok: 'OK  ', warn: 'WARN', fail: 'FAIL' }[r.level]}  ${r.check}: ${r.detail}`);
    process.exit(preflightOk(rows) ? 0 : 1);
  }
  if (cmd === 'status') {
    for (const [n, a] of Object.entries(ctx.cfg.accounts)) {
      const runs = ctx.store.readJsonl(`runs-${n}.jsonl`);
      console.log(`${n}: variant=${a.variant} mode=${a.mode} lastRun=${runs.at(-1) ? `${runs.at(-1).date} ${runs.at(-1).phase} ${runs.at(-1).status}` : 'never'}`);
    }
    return;
  }
  if (cmd === 'run') {
    const phase = argv[1];
    if (phase === 'summary') {
      const r = await runSummary(ctx, { date: opt('date', etParts(ctx.now()).date), force: flag('force'), email: !flag('no-email') });
      console.log(JSON.stringify({ phase, status: r.status, reason: r.reason, error: r.error, date: r.date }));
      if (flag('print') && r.text) console.log(r.text);
      process.exit(r.status === 'error' ? 2 : 0);
    }
    const names = opt('account') ? [opt('account')] : Object.keys(ctx.cfg.accounts);
    const results = [];
    for (const n of names) {
      const r = phase.startsWith('reconcile') ? await reconcilePhase(ctx, n, phase) : phase.startsWith('fallback') ? await runFallback(ctx, n, phase, { confirmLive: flag('confirm-live') }) : await runPhase(ctx, n, phase, { force: flag('force'), confirmLive: flag('confirm-live') });
      results.push(r);
      console.log(JSON.stringify({ account: n, phase, status: r.status, reason: r.reason, kind: r.kind, error: r.error, orders: r.orders?.map((o) => `${o.side} ${o.qty} ${o.symbol} ${o.tif} ${o.status}`) }));
    }
    process.exit(results.some((r) => r.status === 'error') ? 2 : 0);
  }
  console.log(USAGE); process.exit(1);
}
main().catch((e) => { console.error(e.stack || e); process.exit(1); });
