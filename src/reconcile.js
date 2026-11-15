// Reconciliation: fills vs official auction prices (slippage), the backtest twin, expected vs actual daily return.
import { addDays, etParts, etInstant } from './time.js';
import { legSignal } from './signal.js';
import { applyLedger, getCalendarRow, loadState, stateFile } from './engine.js';
import { targetQty } from './plan.js';

const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

/** Cost-positive slippage in bp: buys above / sells below the official auction price are positive. */
export function slippageBp(side, fill, official) {
  if (!(fill > 0) || !(official > 0)) return null;
  return r2(((side === 'buy' ? fill - official : official - fill) / official) * 1e4);
}

/**
 * One step of the backtest twin: same rules, official prices, whole shares.
 * twin = { equity, night: { [symbol]: { shares, px } } }.  bars = { [symbol]: {o, c} } for `date`.
 * flagPrev: leg -> on at the previous official close; flagNow: leg -> on at today's official close.
 */
export function twinStep(twin, { legs, variant, bars, flagPrev, flagNow, dayNotional = 1 }) {
  const e0 = twin.equity;
  let e = e0;
  const detail = { night: {}, day: {}, tonight: {} };
  for (const [sym, p] of Object.entries(twin.night || {})) {
    const pnl = p.shares * (bars[sym].o - p.px);
    e += pnl; detail.night[sym] = { shares: p.shares, pnl: r2(pnl) };
  }
  const afterNight = e;
  for (const leg of legs) {
    if (!(leg.day && variant.dayLeg && flagPrev[leg.name])) continue;
    const b = bars[leg.day];
    const shares = targetQty(afterNight, leg.weight, dayNotional, b.o);
    const pnl = shares * (b.c - b.o);
    e += pnl; detail.day[leg.day] = { shares, pnl: r2(pnl) };
  }
  const night = {};
  for (const leg of legs) {
    if (!flagNow[leg.name]) continue;
    const px = bars[leg.night].c;
    const shares = targetQty(e, leg.weight, 1, px);
    if (shares > 0) { night[leg.night] = { shares, px }; detail.tonight[leg.night] = shares; }
  }
  return { twin: { equity: e, night }, ret: e / e0 - 1, detail };
}

/** Ordered reason codes. Events (missed/partial/flip/fee) always count; rounding/unknown only when the diff is material. */
export function reasonCodes({ orders = [], flips = [], feeUsd = 0, diffBp = 0, twinShares = {}, actualShares = {}, materialBp = 1 }) {
  const reasons = [];
  if (orders.some((o) => ['canceled', 'expired', 'rejected'].includes(o.status) || Number(o.filledQty || 0) === 0)) reasons.push('missed_auction');
  if (orders.some((o) => Number(o.filledQty) > 0 && Number(o.filledQty) < Number(o.qty))) reasons.push('partial_fill');
  if (flips.length) reasons.push('signal_flip');
  if (feeUsd > 0) reasons.push('fee');
  if (Math.abs(diffBp) >= materialBp) {
    const syms = new Set([...Object.keys(twinShares), ...Object.keys(actualShares)]);
    if ([...syms].some((s) => (twinShares[s] || 0) !== (actualShares[s] || 0)) && !reasons.length) reasons.push('rounding');
    if (!reasons.length) reasons.push('unknown');
  }
  return reasons;
}

export function buildSummary(store, cfg, now = new Date()) {
  const sleeves = [];
  for (const [name, v] of Object.entries(cfg.variants)) {
    const rows = store.readJsonl(`paper-${name}.jsonl`).filter((r) => r.type === 'day');
    if (!rows.length) continue;
    const last = rows.at(-1), fills = rows.flatMap((r) => r.fills || []);
    const slips = fills.map((f) => f.slipBp).filter((x) => x != null);
    sleeves.push({
      name: v.label || name, since: rows[0].date,
      ret: last.cumActualPct, twin: last.cumTwinPct, spy: last.cumSpyPct,
      fills: fills.length, slippageBps: slips.length ? r2(slips.reduce((a, b) => a + b, 0) / slips.length) : undefined,
      diffBp: last.cumDiffBp,
      note: last.mode === 'dry' ? 'DRY-RUN: backtest twin only, no orders placed' : `${rows.length} sessions, mode ${last.mode}`,
    });
  }
  return { updated: now.toISOString(), sleeves };
}

async function collectFills(ctx, broker, accountName, date, phases) {
  const after = etInstant(date, '00:00').toISOString();
  const orders = (await broker.orders({ status: 'all', after })).filter((o) => (o.client_order_id || '').startsWith(`vamp-${accountName}-${date}-`));
  const fills = [];
  for (const o of orders) {
    const ph = (o.client_order_id.split('-').slice(-3)[0]);
    if (phases && !phases.includes(ph)) continue;
    const bar = await ctx.data.officialBar(o.symbol, date);
    const official = bar ? (o.time_in_force === 'opg' ? bar.o : bar.c) : null;
    const fill = o.filled_avg_price ? Number(o.filled_avg_price) : null;
    fills.push({ symbol: o.symbol, side: o.side, tif: o.time_in_force, qty: Number(o.qty), filledQty: Number(o.filled_qty || 0), status: o.status, fill, official, officialSource: bar?.source ?? null, slipBp: slippageBp(o.side, fill, official) });
  }
  return fills;
}

export async function reconcilePhase(ctx, accountName, phase) {
  const { cfg } = ctx;
  const acct = cfg.accounts[accountName], variant = cfg.variants[acct.variant];
  const now = ctx.now(), date = opts_date(ctx);
  const state = loadState(ctx.store, accountName);
  const broker = ctx.broker(accountName);
  const out = { account: accountName, variant: acct.variant, mode: acct.mode, phase, date, status: 'ok' };
  const save = () => ctx.store.writeJson(stateFile(accountName), state);
  try {
    const row = await getCalendarRow(ctx, broker, acct.mode, date);
    if (!row) return { ...out, status: 'skipped', reason: 'closed' };
    const after = etInstant(date, row.close);
    const afterOpen = etInstant(date, row.open);
    const need = phase === 'reconcile-open' ? new Date(afterOpen.getTime() + 25 * 60000) : new Date(after.getTime() + 25 * 60000);
    if (now < need) return { ...out, status: 'skipped', reason: 'early' };
    if (state.phases[date]?.[phase]?.ok) return { ...out, status: 'skipped', reason: 'already-done' };

    const live = acct.mode !== 'dry';
    const fills = live ? await collectFills(ctx, broker, accountName, date, phase === 'reconcile-open' ? ['morning'] : ['morning', 'afternoon']) : [];
    if (phase === 'reconcile-open') {
      ctx.store.appendJsonl(`fills-${acct.variant}.jsonl`, { type: 'open', date, fills });
      const missed = fills.filter((f) => f.filledQty < f.qty);
      if (missed.length) await ctx.alert(`VAMPIRE open auction problem ${accountName} ${date}`, missed.map((f) => `${f.side} ${f.qty} ${f.symbol}: ${f.status}, filled ${f.filledQty}`).join('\n'));
      (state.phases[date] ||= {})[phase] = { ok: true };
      save();
      return { ...out, fills };
    }

    // ---- reconcile-close: official bars, signals, twin, daily record
    const symbols = [...new Set(cfg.legs.flatMap((l) => [l.night, l.day].filter(Boolean)))];
    const bars = {};
    for (const s of symbols) { const b = await ctx.data.officialBar(s, date); if (!b) throw new Error(`no official bar for ${s} on ${date}`); bars[s] = b; }
    const flagNow = {}, flagPrev = {}, officialFlags = {};
    for (const leg of cfg.legs) {
      const hist = (await ctx.data.dailyBars(leg.signal, addDays(date, -Math.ceil(cfg.maLength * 1.6 + 15)), date)).filter((b) => b.date <= date);
      if (hist.at(-1)?.date !== date) throw new Error(`${leg.signal} official close for ${date} missing`);
      const c = hist.map((b) => b.c);
      flagNow[leg.name] = legSignal(c, cfg.maLength).on;
      flagPrev[leg.name] = legSignal(c.slice(0, -1), cfg.maLength).on;
      officialFlags[leg.name] = { on: flagNow[leg.name], close: c.at(-1) };
    }
    let equityEnd, equityStart;
    if (live) { const a = await broker.account(); equityEnd = Number(a.equity); equityStart = Number(a.last_equity); }
    else { equityStart = state.dry.equity ?? cfg.dryEquity; equityEnd = null; }
    const prior = ctx.store.readJsonl(`paper-${acct.variant}.jsonl`).filter((r) => r.type === 'day');
    if (prior.some((r) => r.date === date)) { (state.phases[date] ||= {})[phase] = { ok: true }; save(); return { ...out, status: 'skipped', reason: 'record-exists' }; }
    const notes = [];
    let twin = state.twin;
    const prevTrading = prior.at(-1)?.date;
    const gap = twin && prevTrading && addDays(prevTrading, 1) < date && !(await adjacentTradingDays(ctx, broker, acct.mode, prevTrading, date));
    if (!twin || gap) {
      if (gap) notes.push(`twin re-seeded from actual equity (missed reconciliation since ${prevTrading})`);
      twin = { equity: live ? equityStart : equityStart, night: {}, startDate: date, startEquity: equityStart, spyStart: null };
      state.start = { date, equity: equityStart, equityActual: live ? equityStart : null };
    }
    const step = twinStep(twin, { legs: cfg.legs, variant, bars, flagPrev, flagNow, dayNotional: cfg.dayNotional });
    const twinNext = { ...twin, ...step.twin };
    const decisions = ctx.store.readJsonl(`decisions-${acct.variant}.jsonl`).filter((d) => d.date === date && d.phase === 'afternoon' && d.account === accountName);
    const decided = decisions.at(-1)?.legs || {};
    const flips = cfg.legs.filter((l) => decided[l.name] && decided[l.name].on !== flagNow[l.name]).map((l) => ({ leg: l.name, decisionPrice: decided[l.name].price, decisionOn: decided[l.name].on, officialClose: officialFlags[l.name].close, officialOn: flagNow[l.name] }));
    for (const f of flips) await ctx.alert(`VAMPIRE signal flip ${accountName} ${date}`, `Leg ${f.leg}: decided ${f.decisionOn ? 'ON' : 'OFF'} at ${f.decisionPrice}, official close ${f.officialClose} says ${f.officialOn ? 'ON' : 'OFF'}.`);

    // SPY reference
    let cumSpyPct = null;
    try {
      const spy = (await ctx.data.dailyBars('SPY', addDays(date, -10), date));
      const base = twinNext.spyStart ?? spy.filter((b) => b.date < date).at(-1)?.c;
      twinNext.spyStart = base;
      const l = spy.find((b) => b.date === date)?.c;
      if (base && l) cumSpyPct = r2((l / base - 1) * 100);
    } catch (e) { notes.push('spy reference unavailable: ' + e.message.slice(0, 60)); }

    let actualRet = null, diffBp = null, reasons = [], feeUsd = 0;
    const twinRet = step.ret;
    const actualShares = {}, twinShares = {};
    for (const f of fills.filter((x) => x.side === 'buy')) actualShares[f.symbol] = (actualShares[f.symbol] || 0) + f.filledQty;
    for (const [s, p] of Object.entries(step.twin.night)) twinShares[s] = p.shares;
    for (const [s, d] of Object.entries(step.detail.day)) twinShares[s] = (twinShares[s] || 0) + d.shares;
    if (live) {
      actualRet = equityEnd / equityStart - 1;
      diffBp = r2((actualRet - twinRet) * 1e4);
      try { feeUsd = (await broker.fees?.(date))?.reduce?.((s, a) => s + Math.abs(Number(a.net_amount || 0)), 0) || 0; } catch { /* fee lookup is best effort */ }
      reasons = reasonCodes({ orders: fills, flips, feeUsd, diffBp, twinShares, actualShares });
    } else {
      reasons = flips.length ? ['signal_flip'] : [];
      state.dry.equity = twinNext.equity;
      applyLedger(state, date, 'afternoon'); // keep the virtual book in step
    }
    const startEq = state.start?.equity ?? equityStart;
    const cumTwinPct = r2((twinNext.equity / twinNext.startEquity - 1) * 100);
    const cumActualPct = live ? r2((equityEnd / (state.start.equityActual ?? startEq) - 1) * 100) : null;
    const prevCumDiff = prior.at(-1)?.cumDiffBp ?? 0;
    const rec = {
      type: 'day', date, account: accountName, variant: acct.variant, mode: acct.mode,
      equityStart: r2(equityStart), equityEnd: r2(equityEnd), twinEquity: r2(twinNext.equity),
      actualRetPct: actualRet == null ? null : r2(actualRet * 100), expectedRetPct: r2(twinRet * 100), diffBp,
      cumActualPct, cumTwinPct, cumSpyPct, cumDiffBp: live ? r2((prevCumDiff || 0) + diffBp) : null,
      reasons, reason: reasons[0] || null, flips, fills, twinDetail: step.detail, flagsOfficial: officialFlags, notes,
    };
    ctx.store.appendJsonl(`paper-${acct.variant}.jsonl`, rec);
    ctx.store.appendJsonl(`fills-${acct.variant}.jsonl`, { type: 'close', date, fills });
    state.twin = { ...twinNext, date };
    (state.phases[date] ||= {})[phase] = { ok: true };
    save();
    ctx.store.writeJson('strategy-overnight-paper.json', buildSummary(ctx.store, cfg, now));
    return { ...out, record: rec };
  } catch (e) {
    await ctx.alert(`VAMPIRE reconcile FAILURE ${accountName} ${date} ${phase}`, String(e.stack || e.message));
    return { ...out, status: 'error', error: e.message };
  }
}

async function adjacentTradingDays(ctx, broker, mode, a, b) {
  // true when no trading day lies strictly between a and b
  for (let d = addDays(a, 1); d < b; d = addDays(d, 1)) if (await getCalendarRow(ctx, broker, mode, d)) return false;
  return true;
}
const opts_date = (ctx) => ctx.dateOverride || etParts(ctx.now()).date;

export function dailySummaryText(results) {
  const lines = [];
  for (const r of results) {
    const rec = r.record;
    if (!rec) { lines.push(`${r.account}: ${r.status}${r.reason ? ' (' + r.reason + ')' : ''}${r.error ? ' ' + r.error : ''}`); continue; }
    lines.push(`${rec.variant} (${rec.mode}) ${rec.date}`,
      `  equity ${rec.equityEnd ?? 'n/a'}  actual ${rec.actualRetPct ?? 'n/a'}%  expected(twin) ${rec.expectedRetPct}%  diff ${rec.diffBp ?? 'n/a'} bp  reason ${rec.reason ?? '-'}`,
      `  cumulative: actual ${rec.cumActualPct ?? 'n/a'}%  twin ${rec.cumTwinPct}%  SPY ${rec.cumSpyPct ?? 'n/a'}%`);
    for (const f of rec.fills) lines.push(`  ${f.side} ${f.filledQty}/${f.qty} ${f.symbol} ${f.tif} fill ${f.fill} vs official ${f.official} (${f.officialSource}) slip ${f.slipBp} bp`);
    for (const f of rec.flips) lines.push(`  SIGNAL FLIP leg ${f.leg}: decided ${f.decisionOn ? 'on' : 'off'} @${f.decisionPrice}, official close ${f.officialClose} -> ${f.officialOn ? 'on' : 'off'}`);
    for (const n of rec.notes) lines.push(`  note: ${n}`);
  }
  return lines.join('\n');
}
