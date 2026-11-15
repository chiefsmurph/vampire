import { existsSync } from 'node:fs';
import { Alpaca } from './alpaca.js';
import { readAlertEnv } from './alert.js';
import { addDays, etParts } from './time.js';

/** Returns [{level:'ok'|'warn'|'fail', check, detail}] for every account. Never submits anything. */
export async function preflight(ctx, only = null) {
  const rows = [];
  const add = (level, check, detail) => rows.push({ level, check, detail });
  const { cfg } = ctx;
  add(existsSync(ctx.killFile) ? 'fail' : 'ok', 'kill switch', existsSync(ctx.killFile) ? `PRESENT: ${ctx.killFile}` : 'absent');
  add(ctx.isExample ? 'warn' : 'ok', 'config', `${ctx.file}${ctx.isExample ? ' (EXAMPLE config, not the private one)' : ''}`);
  const ae = readAlertEnv(ctx.env.ALERT_ENV || cfg.alertEnvFile || `${ctx.dir}/alert.env`);
  add((ae.PP_URL && ae.PP_TOKEN) || (ae.AI_NOTIFY_URL && ae.AI_NOTIFY_TOKEN) ? 'ok' : 'warn', 'alert channel', Object.keys(ae).length ? 'alert.env found' : 'no alert env file found: failures would NOT be emailed');
  const variants = Object.values(cfg.accounts).map((a) => a.variant);
  if (new Set(variants).size !== variants.length) add('fail', 'accounts', 'two accounts share one variant (they would collide in paper-<variant>.jsonl)');
  const symbols = [...new Set(cfg.legs.flatMap((l) => [l.night, l.day].filter(Boolean)))];
  for (const [name, a] of Object.entries(cfg.accounts)) {
    if (only && only !== name) continue;
    const pre = `[${name}/${a.variant}/${a.mode}]`;
    const k = ctx.keysFor(a);
    if (!k) { add(a.mode === 'dry' ? 'warn' : 'fail', `${pre} keys`, `${a.keyEnv || '(none)'} / ${a.secretEnv || ''} not set${a.mode === 'dry' ? ' (fine for DRY)' : ''}`); continue; }
    add('ok', `${pre} keys`, 'present');
    const c = new Alpaca({ ...k, mode: a.mode === 'live' ? 'live' : 'paper', feed: cfg.feed || 'sip', fetchImpl: ctx.fetchImpl || fetch, warn: (m) => add('warn', `${pre} feed`, m) });
    try {
      const acc = await c.account();
      add(acc.status === 'ACTIVE' ? 'ok' : 'fail', `${pre} account status`, acc.status);
      add(a.mode === 'paper' ? (String(acc.account_number).startsWith('PA') ? 'ok' : 'fail') : 'warn', `${pre} account type`, `${acc.account_number} (${a.mode === 'paper' ? 'must be a PA paper account' : 'LIVE mode account'})`);
      add(acc.trading_blocked ? 'fail' : 'ok', `${pre} trading blocked`, String(acc.trading_blocked));
      const eq = Number(acc.equity), bp = Number(acc.buying_power);
      add(bp >= eq * 1.05 ? 'ok' : 'warn', `${pre} buying power`, `equity ${eq}, buying power ${bp}, multiplier ${acc.multiplier} (selling the day ETF and buying the night ETF in the same auction window needs bp >= ~1x equity)`);
    } catch (e) { add('fail', `${pre} account`, e.message); continue; }
    for (const s of symbols) {
      try {
        const as = await c.asset(s);
        add(as.tradable ? 'ok' : 'fail', `${pre} ${s}`, `tradable=${as.tradable} fractionable=${as.fractionable} (auction orders use whole shares regardless) status=${as.status}`);
      } catch (e) { add('fail', `${pre} ${s}`, e.message); }
    }
    try {
      const today = etParts(new Date()).date;
      const cal = await c.calendar(today, addDays(today, 10));
      add(Array.isArray(cal) && cal.length ? 'ok' : 'fail', `${pre} calendar`, `${cal.length} trading days in next 10; next ${cal[0]?.date} ${cal[0]?.open}-${cal[0]?.close}`);
    } catch (e) { add('fail', `${pre} calendar`, e.message); }
    try {
      const sig = cfg.legs[0].signal, end = etParts(new Date()).date;
      const bars = await c.dailyBars(sig, addDays(end, -10), end);
      add(c.feed === 'sip' ? 'ok' : 'warn', `${pre} data feed`, `${bars.length} bars of ${sig} via ${c.feed.toUpperCase()}${c.feed === 'iex' ? ' (IEX only: official open/close come from IEX; reconciliation falls back to Yahoo for cross-check)' : ''}`);
    } catch (e) { add('fail', `${pre} data feed`, e.message); }
  }
  return rows;
}
export const preflightOk = (rows) => !rows.some((r) => r.level === 'fail');
