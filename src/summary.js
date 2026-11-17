// Daily summary: moving-average status per leg, what each account did, P&L, tomorrow's outlook.
// Generic: every symbol/leg/account comes from the config. Writes the Owl paper JSON and emails the text.
import { legSignal, sma } from './signal.js';
import { addDays, etParts } from './time.js';

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const fmtDate = (d) => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
const fmtDow = (d) => `${DOW[new Date(d + 'T12:00:00Z').getUTCDay()]} ${fmtDate(d)}`;
const sgn = (x, dp = 2) => (x == null ? 'n/a' : `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(dp)}`);
const usd = (x) => (x == null ? 'n/a' : `${x < 0 ? '-' : ''}$${Math.abs(Math.round(x)).toLocaleString('en-US')}`);
const susd = (x) => (x == null ? 'n/a' : `${x < 0 ? '-' : '+'}$${Math.abs(Math.round(x)).toLocaleString('en-US')}`);

/** Status of one leg as of bars[idx] (inclusive): close, SMA, gap, on/off, streak, flip level for the next close. */
export function legStatus(bars, ma, idx = bars.length - 1) {
  const closes = bars.slice(0, idx + 1).map((b) => b.c);
  const sig = legSignal(closes, ma);
  if (sig.sma == null) return null;
  const close = closes.at(-1);
  let streak = 0, since = bars[idx].date;
  for (let i = idx; i >= ma - 1; i--) {
    const on = bars[i].c > sma(closes.slice(0, i + 1), ma);
    if (on !== sig.on) break;
    streak++; since = bars[i].date;
  }
  const flipLevel = closes.slice(-(ma - 1)).reduce((a, b) => a + b, 0) / (ma - 1); // next close must be above this to be ON
  return { close, sma: sig.sma, gapPct: (close / sig.sma - 1) * 100, on: sig.on, streak, since, flipLevel, flipPct: (flipLevel / close - 1) * 100, streakTruncated: streak > 0 && since === bars[ma - 1].date };
}

function describeFill(f) {
  const kind = f.fallback ? 'FALLBACK' : f.tif === 'opg' ? 'open auction' : f.tif === 'cls' ? 'close auction' : f.tif;
  const px = f.fill != null ? ` @${f.fill}${f.slipBp != null ? ` (${sgn(f.slipBp, 1)}bp)` : ''}` : '';
  return `${f.side} ${f.filledQty}/${f.qty} ${f.symbol} ${kind}${px}${f.filledQty < f.qty ? ` [${f.status}]` : ''}`;
}

export async function buildDailySummary(ctx, date) {
  const { cfg, store } = ctx;
  const ma = cfg.maLength;
  const start = addDays(date, -(ma * 2 + 60));
  const legs = [];
  const barsByLeg = {};
  for (const leg of cfg.legs) {
    const bars = (await ctx.data.dailyBars(leg.signal, start, date)).filter((b) => b.date <= date);
    if (bars.at(-1)?.date !== date) throw new Error(`${leg.signal} close for ${date} missing`);
    barsByLeg[leg.name] = bars;
    const st = legStatus(bars, ma);
    if (!st) throw new Error(`${leg.signal}: not enough history for ${ma}-day SMA`);
    legs.push({ name: leg.name, symbol: leg.signal, ...st });
  }
  // per-variant day records up to `date`
  const variants = Object.entries(cfg.variants).map(([key, v]) => ({
    key, label: v.label || key,
    rows: store.readJsonl(`paper-${key}.jsonl`).filter((r) => r.type === 'day' && r.date <= date),
  }));
  const rec = (vk) => variants.find((v) => v.key === vk).rows.find((r) => r.date === date);
  if (!variants.every((v) => rec(v.key))) return null; // reconcile-close not finished for every variant
  const dates = [...new Set(variants.flatMap((v) => v.rows.map((r) => r.date)))].sort();
  const stat = (v, row) => {
    const first = v.rows[0];
    const eq0 = first.equityStart, eq = row.equityEnd;
    return { equity: eq, dayPnl: r2(row.equityEnd - row.equityStart), dayPct: row.actualRetPct, cumPnl: r2(eq - eq0), cumPct: r2((eq / eq0 - 1) * 100) };
  };
  const history = dates.map((d) => {
    const lg = {};
    for (const leg of cfg.legs) {
      const bars = barsByLeg[leg.name], i = bars.findIndex((b) => b.date === d);
      const s = i >= 0 ? legStatus(bars, ma, i) : null;
      lg[leg.name] = s ? { on: s.on, gapPct: r2(s.gapPct), close: s.close } : null;
    }
    const acc = {};
    for (const v of variants) { const row = v.rows.find((r) => r.date === d); if (row) acc[v.key] = stat(v, row); }
    return { date: d, legs: lg, accounts: acc };
  });
  const today = history.at(-1);
  const [vA, vB] = variants;
  const diff = variants.length === 2 ? { dayPnl: r2(today.accounts[vB.key].dayPnl - today.accounts[vA.key].dayPnl), cumPnl: r2(today.accounts[vB.key].cumPnl - today.accounts[vA.key].cumPnl) } : null;

  // ---- text
  const onNames = legs.filter((l) => l.on), n = legs.length;
  const allOff = onNames.length === 0, allOn = onNames.length === n;
  const headline = allOff ? `${n === 2 ? 'both' : 'all'} OFF, cash` : allOn ? `${n === 2 ? 'both' : 'all'} ON` : legs.map((l) => `${l.symbol} ${l.on ? 'ON' : 'OFF'}`).join(' · ');
  const subject = `Vampire daily - ${fmtDate(date)}: ${headline}`;
  const L = [];
  L.push(`Vampire daily - ${fmtDow(date)} (paper)`, `Tonight: ${allOff ? 'cash in every account' : onNames.map((l) => l.symbol).join(' + ') + ' signal ON, long overnight'}`, '');
  L.push(`${ma}-day MA`);
  for (const l of legs) {
    L.push(`${l.symbol} ${l.close.toFixed(2)} vs SMA ${l.sma.toFixed(2)}  ${sgn(l.gapPct)}%  ${l.on ? 'ON' : 'OFF'}`,
      `  ${l.streak}${l.streakTruncated ? '+' : ''} trading day${l.streak === 1 ? '' : 's'} ${l.on ? 'ON' : 'OFF'}, since ${fmtDate(l.since)}`,
      l.on ? `  flips OFF below ${l.flipLevel.toFixed(2)} (${sgn(l.flipPct)}%)` : `  flips ON above ${l.flipLevel.toFixed(2)} (${sgn(l.flipPct)}%)`);
  }
  L.push('', 'P&L (day / since start)');
  for (const v of variants) { const s = today.accounts[v.key]; L.push(`${v.label}: ${usd(s.equity)}  day ${susd(s.dayPnl)} (${sgn(s.dayPct)}%)  total ${susd(s.cumPnl)} (${sgn(s.cumPct)}%)`); }
  if (diff && variants.length === 2) L.push(`${vB.key} - ${vA.key}: day ${susd(diff.dayPnl)}  total ${susd(diff.cumPnl)}`);
  L.push('', 'What they did');
  for (const v of variants) {
    const r = rec(v.key), runs = store.readJsonl(`runs-${r.account}.jsonl`).filter((x) => x.date === date && x.status !== 'skipped');
    const fills = r.fills || [];
    L.push(`${v.label}:`);
    if (!fills.length) L.push('  no fills');
    for (const f of fills) L.push('  ' + describeFill(f));
    const errs = runs.filter((x) => x.status === 'error');
    for (const e of errs) L.push(`  ERROR ${e.phase}: ${e.error || e.kind}`);
    if ((r.reasons || []).length) L.push(`  vs backtest twin ${sgn(r.diffBp, 1)}bp: ${r.reasons.join(', ')}`);
  }
  const bits = legs.map((l) => `${l.symbol} ${l.on ? 'ON' : 'OFF'} (${sgn(l.gapPct)}%, ${l.streak}d)`).join(' · ');
  const need = legs.filter((l) => !l.on).map((l) => `${l.symbol} closes above ${l.flipLevel.toFixed(2)}`);
  const risk = legs.filter((l) => l.on).map((l) => `${l.symbol} closes below ${l.flipLevel.toFixed(2)}`);
  L.push('', `Tomorrow: ${bits} -> ` + (allOff ? `all accounts stay in cash unless ${need.join(' or ')}` : `${need.length ? 'turns ON if ' + need.join(' or ') + '; ' : ''}${risk.length ? 'turns OFF if ' + risk.join(' or ') : ''}`) + ' (decided at the 15:45 ET check).');
  const text = L.join('\n');

  const json = {
    asOf: date, updated: ctx.now().toISOString(), maLength: ma, headline,
    legs: legs.map((l) => ({ name: l.name, symbol: l.symbol, close: r2(l.close), sma: r2(l.sma), gapPct: r2(l.gapPct), on: l.on, streakDays: l.streak, since: l.since, flipLevel: r2(l.flipLevel), flipPct: r2(l.flipPct) })),
    variants: variants.map((v) => ({ key: v.key, label: v.label })),
    history, cumulative: { ...today.accounts, diffPnl: diff?.cumPnl ?? null },
  };
  return { subject, text, json };
}

/** Phase `summary`: idempotent. Skips (quietly) when there is no finished record for the date. */
export async function runSummary(ctx, { date = etParts(ctx.now()).date, force = false, email = true } = {}) {
  const state = ctx.store.readJson('summary-state.json', { sent: {} });
  if (state.sent[date] && !force) return { status: 'skipped', reason: 'already-sent', date };
  const s = await buildDailySummary(ctx, date).catch(async (e) => { await ctx.alert(`VAMPIRE summary FAILURE ${date}`, String(e.stack || e.message)); return { error: e }; });
  if (s?.error) return { status: 'error', error: s.error.message, date };
  if (!s) return { status: 'skipped', reason: 'no-record', date };
  const prev = ctx.store.readJson('strategy-overnight-paper.json', {});
  ctx.store.writeJson('strategy-overnight-paper.json', { ...prev, ...s.json });
  if (email) {
    const r = await ctx.alert(s.subject, s.text);
    if (r?.sent === false) return { status: 'error', error: 'email not sent', date, ...s };
    state.sent[date] = new Date().toISOString();
    ctx.store.writeJson('summary-state.json', state);
  }
  return { status: 'ok', date, ...s };
}
