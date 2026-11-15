// Full DRY simulation of one session (both phases, every account) in a throwaway store. Submits nothing.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPhase } from './engine.js';
import { makeCtx } from './context.js';
import { Store } from './store.js';
import { etInstant } from './time.js';
import { addDays } from './time.js';

export async function simulate({ dir, date, equity = 100000, env = process.env }) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'vampire-sim-')));
  const alerts = [];
  const ctx = makeCtx({ dir, env, store, alert: async (s, b) => alerts.push({ s, b }) });
  for (const a of Object.values(ctx.cfg.accounts)) a.mode = 'dry'; // never touch a broker
  ctx.cfg.dryEquity = equity;
  const realData = ctx.data;
  // The sim date may be in the future: "latest price" = last close before that date, so the run is deterministic.
  ctx.data = {
    dailyBars: (s, a, b) => realData.dailyBars(s, a, b),
    latestPrice: async (s) => { const bars = (await realData.dailyBars(s, addDays(date, -10), date)).filter((x) => x.date < date); const l = bars.at(-1); return { price: l.c, at: l.date, source: `sim:last-close ${l.date}` }; },
  };
  const results = [];
  for (const phase of ['morning', 'afternoon']) {
    ctx.now = () => etInstant(date, phase === 'morning' ? '09:20' : '15:45');
    for (const name of Object.keys(ctx.cfg.accounts)) results.push(await runPhase(ctx, name, phase));
  }
  return { results, alerts, cfg: ctx.cfg };
}

export function formatSimulation({ results, alerts }, date, equity) {
  const lines = [`VAMPIRE dry simulation for ${date}, equity $${equity.toLocaleString()} per account (flat book at the start)`];
  for (const r of results) {
    lines.push('', `== ${r.account} (${r.variant}) ${r.phase} status=${r.status}${r.reason ? ' ' + r.reason : ''}${r.error ? ' ERROR ' + r.error : ''}`);
    for (const [leg, f] of Object.entries(r.flags || {})) lines.push(`   leg ${leg}: ${f.signal} ${f.on ? 'ON ' : 'OFF'} price ${f.price?.toFixed(2)} vs SMA ${f.sma?.toFixed(2)} (${f.priceSource}, last close ${f.lastCloseDate})`);
    for (const o of r.orders) lines.push(`   ${o.side.toUpperCase().padEnd(4)} ${String(o.qty).padStart(6)} ${o.symbol.padEnd(5)} tif=${o.tif}  ref ${o.ref?.toFixed(2)}  ~$${Math.round(o.qty * o.ref).toLocaleString()}`);
    if (!r.orders.length && r.status === 'ok') lines.push('   (no orders)');
  }
  if (alerts.length) lines.push('', 'ALERTS RAISED:', ...alerts.map((a) => ` - ${a.s}: ${a.b}`));
  return lines.join('\n');
}
