// Phase runner: calendar gate -> kill switch -> signals -> plan -> (dry-log | submit) -> log. Idempotent per (account, date, phase).
import { existsSync } from 'node:fs';
import { checkWindow, normalizeRow } from './calendar.js';
import { assertModeAllowed } from './config.js';
import { builtinCalendar } from './nyse.js';
import { legSignal } from './signal.js';
import { clientId, planPhase, SafetyError } from './plan.js';
import { addDays, etParts } from './time.js';

const ORDER_PHASES = ['morning', 'afternoon'];
const PHASE_RANK = { morning: 0, afternoon: 1 };

export const stateFile = (acct) => `state-${acct}.json`;
export const loadState = (store, acct) => store.readJson(stateFile(acct), null) || { phases: {}, ledger: [], dry: {}, twin: null, alerts: {} };

/** Calendar row for `date` (null = closed). Alpaca when a broker exists; built-in NYSE rules only in dry mode (warned). */
export async function getCalendarRow(ctx, broker, mode, date) {
  if (broker) {
    const rows = await broker.calendar(date, date);
    if (!Array.isArray(rows)) throw new Error('calendar API returned a non-array');
    return rows.length && rows[0].date === date ? normalizeRow(rows[0]) : null;
  }
  if (mode !== 'dry') throw new Error('no broker for calendar in non-dry mode');
  ctx.warn?.('using built-in NYSE calendar (no Alpaca keys)');
  const r = builtinCalendar(date, date)[0];
  return r || null;
}

async function alertOnce(ctx, state, key, subject, body) {
  if (state.alerts[key]) return;
  state.alerts[key] = new Date().toISOString();
  await ctx.alert(subject, body);
}

/** Mark dry-ledger orders from earlier phases as filled so the virtual book reflects them. */
export function applyLedger(state, date, phase) {
  const pos = (state.dry.positions ||= {});
  for (const o of state.ledger) {
    if (o.applied) continue;
    if (o.date < date || (o.date === date && PHASE_RANK[o.phase] < PHASE_RANK[phase])) {
      pos[o.symbol] = (pos[o.symbol] || 0) + (o.side === 'buy' ? o.qty : -o.qty);
      o.applied = true;
    }
  }
  return pos;
}

export async function loadFlags(ctx, cfg, date, phase) {
  const flags = {}, prices = {};
  const start = addDays(date, -Math.ceil(cfg.maLength * 1.6 + 15));
  for (const leg of cfg.legs) {
    const bars = (await ctx.data.dailyBars(leg.signal, start, date)).filter((b) => b.date < date);
    if (!bars.length) throw new Error(`no bars for ${leg.signal}`);
    const last = bars.at(-1).date;
    if (last < addDays(date, -5)) throw new Error(`${leg.signal} bars are stale (last ${last})`);
    let live = null;
    if (phase === 'afternoon') {
      live = await ctx.data.latestPrice(leg.signal);
      if (!(live.price > 0)) throw new Error(`bad latest price for ${leg.signal}`);
    }
    const sig = legSignal(bars.map((b) => b.c), cfg.maLength, live?.price ?? null);
    flags[leg.name] = { ...sig, signal: leg.signal, lastClose: bars.at(-1).c, lastCloseDate: last, priceSource: live?.source ?? 'prior-close' };
    for (const sym of [leg.night, leg.day].filter(Boolean)) {
      if (prices[sym]) continue;
      if (phase === 'afternoon' && sym === leg.night) prices[sym] = (await ctx.data.latestPrice(sym)).price;
      else prices[sym] = (await ctx.data.dailyBars(sym, addDays(date, -10), date)).filter((b) => b.date < date).at(-1)?.c;
      if (!(prices[sym] > 0)) throw new Error(`no reference price for ${sym}`);
    }
  }
  return { flags, prices };
}

function openQueued(orders) {
  const q = {};
  for (const o of orders) {
    if (!['new', 'accepted', 'pending_new', 'partially_filled', 'accepted_for_bidding', 'held', 'pending_replace'].includes(o.status)) continue;
    const rem = Number(o.qty) - Number(o.filled_qty || 0);
    q[o.symbol] = (q[o.symbol] || 0) + (o.side === 'buy' ? rem : -rem);
  }
  return q;
}

export async function runPhase(ctx, accountName, phase, opts = {}) {
  const { cfg } = ctx;
  const acct = cfg.accounts[accountName];
  if (!acct) throw new Error(`unknown account ${accountName}`);
  if (!ORDER_PHASES.includes(phase)) throw new Error(`runPhase handles ${ORDER_PHASES.join('/')}; got ${phase}`);
  const variant = cfg.variants[acct.variant];
  const now = ctx.now(), today = etParts(now).date;
  const state = loadState(ctx.store, accountName);
  const tag = `[${accountName}/${acct.variant}/${acct.mode}] ${phase} ${today}`;
  const out = { account: accountName, variant: acct.variant, mode: acct.mode, phase, date: today, at: now.toISOString(), orders: [], notes: [], status: 'ok' };
  const finish = (status, extra = {}) => { Object.assign(out, { status }, extra); ctx.store.appendJsonl(`runs-${accountName}.jsonl`, out); ctx.store.writeJson(stateFile(accountName), state); return out; };
  const fail = async (kind, err) => {
    out.error = String(err.message || err);
    await alertOnce(ctx, state, `${today}:${phase}:${kind}`, `VAMPIRE FAILURE ${tag}: ${kind}`, `${out.error}\n\nNo further orders were placed by this run. Re-running the phase is safe (idempotent).`);
    return finish('error', { kind });
  };

  try { assertModeAllowed(acct, { env: ctx.env, confirmLiveFlag: opts.confirmLive }); } catch (e) { return fail('mode', e); }
  const broker = ctx.broker(accountName);
  let row;
  try { row = await getCalendarRow(ctx, broker, acct.mode, today); } catch (e) { return fail('calendar-unhealthy', e); }
  const win = checkWindow(phase, now, row);
  if (!win.ok && !opts.force) {
    if (win.reason === 'late' && !state.phases[today]?.[phase]?.ok) return fail('missed-window', new Error(`cutoff passed at ${win.deadline.toISOString()}; nothing submitted`));
    return finish('skipped', { reason: win.reason });
  }
  if (state.phases[today]?.[phase]?.ok && !opts.force) return finish('skipped', { reason: 'already-done' });
  if (existsSync(ctx.killFile)) return fail('kill-switch', new Error(`kill switch file present (${ctx.killFile}); no orders placed`));

  try {
    const { flags, prices } = await loadFlags(ctx, cfg, today, phase);
    out.flags = flags; out.prices = prices;
    let equity, positions, queued = {};
    if (acct.mode === 'dry') {
      positions = applyLedger(state, today, phase);
      equity = state.dry.equity ?? cfg.dryEquity;
      for (const o of state.ledger) if (o.date === today && o.phase === phase && !o.applied) queued[o.symbol] = (queued[o.symbol] || 0) + (o.side === 'buy' ? o.qty : -o.qty);
    } else {
      const a = await broker.account();
      if (a.trading_blocked || a.account_blocked || a.status !== 'ACTIVE') throw new Error(`account not tradable: status=${a.status} blocked=${a.trading_blocked}`);
      equity = Number(a.equity);
      positions = Object.fromEntries((await broker.positions()).map((p) => [p.symbol, p.qty]));
      queued = openQueued(await broker.orders({ status: 'open' }));
    }
    out.equity = equity; out.positions = positions;
    const plan = planPhase({ phase, legs: cfg.legs, variant, equity, positions, queued, prices, flags, maxTargetPct: cfg.maxTargetPct, dayNotional: cfg.dayNotional });
    out.notes.push(...plan.notes); out.targetPct = plan.targetPct;
    let failed = 0;
    for (const o of plan.orders) {
      const id = clientId(accountName, today, phase, o.symbol, o.side);
      const rec = { ...o, clientId: id, ref: prices[o.symbol] };
      if (acct.mode === 'dry') {
        state.ledger.push({ id, date: today, phase, symbol: o.symbol, side: o.side, tif: o.tif, qty: o.qty, ref: rec.ref, applied: false });
        rec.status = 'dry-would-place';
      } else {
        try { const r = await broker.submit({ ...o, clientId: id }); rec.status = r.duplicate ? 'duplicate-ignored' : 'submitted'; rec.orderId = r.id; }
        catch (e) { rec.status = 'failed'; rec.error = e.message; failed++; }
      }
      out.orders.push(rec);
    }
    // Decisions are kept for reconciliation (signal-flip detection).
    ctx.store.appendJsonl(`decisions-${acct.variant}.jsonl`, { date: today, phase, account: accountName, at: out.at, legs: flags });
    if (failed) { await alertOnce(ctx, state, `${today}:${phase}:submit`, `VAMPIRE ORDER FAILURE ${tag}`, out.orders.filter((o) => o.status === 'failed').map((o) => `${o.side} ${o.qty} ${o.symbol} ${o.tif}: ${o.error}`).join('\n')); return finish('error', { kind: 'submit' }); }
    (state.phases[today] ||= {})[phase] = { ok: true, at: out.at, orders: out.orders.length };
    return finish('ok');
  } catch (e) {
    return fail(e instanceof SafetyError ? 'safety' : 'run', e);
  }
}
