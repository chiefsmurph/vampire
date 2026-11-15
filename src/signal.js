// Moving-average gate.
export function sma(values, n) {
  if (values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i];
  return s / n;
}

/**
 * closes: daily closes UP TO AND INCLUDING the reference close (already filtered to dates before "today"
 * for a morning decision). price: optional live price that stands in for today's not-yet-official close
 * (afternoon decision): it is appended as the latest close, so the SMA contains it.
 */
export function legSignal(closes, ma, price = null) {
  const series = price == null ? closes.slice() : [...closes, price];
  if (series.length < ma) return { on: false, price: series.at(-1) ?? null, sma: null, reason: `need ${ma} closes, have ${series.length}` };
  const m = sma(series, ma), p = series.at(-1);
  return { on: p > m, price: p, sma: m, reason: p > m ? 'above' : 'below' };
}
