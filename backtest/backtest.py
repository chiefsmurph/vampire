#!/usr/bin/env python3
"""Backtest CLI: leveraged night leg + optional inverse day leg, gated by a moving average.

  backtest.py --tickers SPY --leverage 1 --ma 200 --day-short 1 --start 2005-01-01 --end 2026-11-13

Each ticker is one equal-weight leg (rebalanced every session). A leg is "on" when the
signal ticker's close is above its MA. Night (close -> next open) earns leverage x the
overnight return; day (open -> close) earns -day_short x the intraday return. Gate for the
night is the same-day close; gate for the day is the PRIOR close. Synthetic daily-reset
leverage, no costs. Data via yfinance (auto-adjusted)."""
import argparse, json, math, sys
import numpy as np
import pandas as pd


def load(tickers, start, end, ma):
    import yfinance as yf
    pad = (pd.Timestamp(start) - pd.Timedelta(days=int(ma * 1.6) + 10)).strftime("%Y-%m-%d")
    out = {}
    for t in tickers:
        df = yf.download(t, start=pad, end=(pd.Timestamp(end) + pd.Timedelta(days=3)).strftime("%Y-%m-%d"),
                         auto_adjust=True, progress=False)
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        df = df[["Open", "Close"]].dropna()
        out[t] = df
    return out


def simulate(frames, leverage, ma, day_short, start, end, drag_pct=0.0):
    """frames: {ticker: DataFrame[Open, Close]}. Returns (equity Series, details)."""
    idx = None
    for df in frames.values():
        idx = df.index if idx is None else idx.intersection(df.index)
    idx = idx.sort_values()
    n_legs = len(frames)
    night = pd.DataFrame(index=idx)  # return of each night session, indexed by the close date
    day = pd.DataFrame(index=idx)
    for t, df in frames.items():
        df = df.loc[idx]
        flag = (df["Close"] > df["Close"].rolling(ma).mean()).astype(float)
        night_ret = df["Open"].shift(-1) / df["Close"] - 1
        day_ret = df["Close"] / df["Open"] - 1
        night[t] = (leverage * night_ret - drag_pct / 100 / 252) * flag
        day[t] = -day_short * day_ret * flag.shift(1)
    night = night.fillna(0.0)
    day = day.fillna(0.0)
    # sequence: day(t) then night(t) for each date t
    seg = []
    for d in idx:
        seg.append((d, "day", day.loc[d].sum() / n_legs))
        seg.append((d, "night", night.loc[d].sum() / n_legs))
    eq, cur, rows = [], 1.0, []
    for d, kind, r in seg:
        cur *= max(1 + r, 0.0)
        rows.append((d, cur))
    s = pd.Series({d: v for d, v in rows})  # last write per date = end of night session
    s = s[(s.index >= pd.Timestamp(start)) & (s.index <= pd.Timestamp(end))]
    return s / s.iloc[0]


def stats(eq, trading_days=252):
    years = (eq.index[-1] - eq.index[0]).days / 365.25
    cagr = eq.iloc[-1] ** (1 / years) - 1
    dd = (eq / eq.cummax() - 1).min()
    out = {"start": str(eq.index[0].date()), "end": str(eq.index[-1].date()), "years": round(years, 2),
           "cagr_pct": round(cagr * 100, 2), "max_dd_pct": round(dd * 100, 2)}
    pos = {}
    for label, n in (("1m", 21), ("3m", 63), ("6m", 126), ("1y", 252)):
        r = eq.pct_change(n).dropna()
        pos[label] = round(float((r > 0).mean()) * 100, 1) if len(r) else None
    out["rolling_positive_pct"] = pos
    rec = {}
    for label, days in (("14d", 14), ("30d", 30), ("60d", 60), ("90d", 90), ("180d", 180), ("360d", 360)):
        cut = eq.index[-1] - pd.Timedelta(days=days)
        base = eq[eq.index <= cut]
        rec[label] = round(float((eq.iloc[-1] / base.iloc[-1] - 1) * 100), 2) if len(base) else None
    out["recent_windows_pct"] = rec
    return out


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--tickers", required=True, help="comma list; each is an equal-weight leg and its own signal")
    p.add_argument("--leverage", type=float, default=1.0)
    p.add_argument("--ma", type=int, default=200)
    p.add_argument("--day-short", type=float, default=0.0, help="size of the inverse day leg (0 = night only)")
    p.add_argument("--drag-pct", type=float, default=0.0, help="annual cost of holding the levered ETF (fees + financing), %% of the leg, charged per night held")
    p.add_argument("--start", default="2005-01-01")
    p.add_argument("--end", default=pd.Timestamp.today().strftime("%Y-%m-%d"))
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    frames = load(a.tickers.split(","), a.start, a.end, a.ma)
    eq = simulate(frames, a.leverage, a.ma, a.day_short, a.start, a.end, a.drag_pct)
    st = stats(eq)
    if a.json:
        print(json.dumps(st))
    else:
        print(f"{a.tickers} lev={a.leverage} ma={a.ma} dayShort={a.day_short}  {st['start']} -> {st['end']}")
        print(f"CAGR {st['cagr_pct']}%   maxDD {st['max_dd_pct']}%")
        print("rolling windows positive %:", st["rolling_positive_pct"])
        print("recent windows %:", st["recent_windows_pct"])
    return st


if __name__ == "__main__":
    main()
