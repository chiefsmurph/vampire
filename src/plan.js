// Pure order planning. No I/O: everything it needs is passed in, so it is trivially testable.
export class SafetyError extends Error {}

export const TIF = { morning: 'opg', afternoon: 'cls' };

export function targetQty(equity, weight, notionalMult, price) {
  if (!(price > 0) || !(equity > 0)) return 0;
  return Math.max(0, Math.floor((equity * weight * notionalMult) / price));
}

/**
 * phase 'morning'  : night ETF -> 0 (opg sell); day ETF -> target if the variant holds a day leg and the leg is on (opg buy)
 * phase 'afternoon': day ETF -> 0 (cls sell);  night ETF -> target if the leg is on (cls buy)
 * Orders are the DELTA between the wanted holding and (position + queued orders), so re-running a phase is a no-op.
 *
 * legs: [{ name, night, day, weight }]; flags: { [leg.name]: { on } }; prices: { [symbol]: ref price }
 * positions / queued: { [symbol]: signed qty }
 */
export function planPhase({ phase, legs, variant, equity, positions = {}, queued = {}, prices, flags, maxTargetPct = 1.05, dayNotional = 1 }) {
  const tif = TIF[phase];
  if (!tif) throw new Error(`planPhase: bad phase ${phase}`);
  const wants = {};
  const notes = [];
  for (const leg of legs) {
    const on = !!flags[leg.name]?.on;
    const w = leg.weight;
    if (phase === 'morning') {
      wants[leg.night] = 0;
      if (leg.day) wants[leg.day] = variant.dayLeg && on ? targetQty(equity, w, dayNotional, prices[leg.day]) : 0;
    } else {
      if (leg.day) wants[leg.day] = 0;
      wants[leg.night] = on ? targetQty(equity, w, 1, prices[leg.night]) : 0;
    }
  }
  // Variants that never hold the day ETF still liquidate one if it is somehow held.
  const orders = [];
  for (const [symbol, want] of Object.entries(wants)) {
    const have = (positions[symbol] || 0) + (queued[symbol] || 0);
    const delta = want - have;
    if (delta === 0) { if (want === 0 && have === 0) continue; notes.push(`${symbol}: already at target ${want}`); continue; }
    orders.push({ symbol, side: delta > 0 ? 'buy' : 'sell', qty: Math.abs(delta), tif });
    if (want === 0 && delta > 0) throw new SafetyError(`${symbol}: negative position ${have}`);
  }
  for (const o of orders) if (o.side === 'buy' && o.qty === 0) throw new SafetyError('zero-qty buy');
  // Sanity: the book AFTER this phase must not exceed maxTargetPct of equity.
  let notional = 0;
  for (const [symbol, want] of Object.entries(wants)) notional += want * (prices[symbol] || 0);
  const targetPct = equity > 0 ? notional / equity : 0;
  if (targetPct > maxTargetPct) throw new SafetyError(`target book ${(targetPct * 100).toFixed(1)}% of equity exceeds ${(maxTargetPct * 100).toFixed(0)}%`);
  for (const [symbol, want] of Object.entries(wants)) if (want * (prices[symbol] || 0) > equity * maxTargetPct) throw new SafetyError(`${symbol} alone exceeds the cap`);
  return { orders, notes, targetPct, wants };
}

export const clientId = (account, date, phase, symbol, side) => `vamp-${account}-${date}-${phase}-${symbol}-${side}`;
