# 🧛 vampire

**Long the night. Short the day.**

A small, dependency-free (Node 24) engine for **auction-execution strategies** on Alpaca. It holds a leveraged long ETF
overnight and, optionally, an inverse ETF during the day, gated by a moving average of a signal index. Every order is a
market-on-open (`opg`) or market-on-close (`cls`) order, so every fill can be checked against the official auction price.

```
  close ──────── night: long ────────▶ open ──────── day: short (optional) ────────▶ close
   ▲  cls BUY  night ETF                 ▲  opg SELL night ETF / opg BUY day ETF        ▲  cls SELL day ETF
   │  (only if the signal index is above its moving average)                            │
   └──────────────────────────── reconcile: real fills vs the backtest twin ────────────┘
```

- ✅ 41 tests: scheduling (normal, half day, holiday), order planning, idempotency, sizing caps, reconciliation, guard
- 🧪 **Backtest twin**: every day, the same rules are re-run on official prices and compared to the real fills
- 🛑 Kill switch · 105% book cap · auction orders only · explicit `dry → paper → live` gates
- 🔒 Public engine, private strategy: real parameters live in a separate repo, enforced by a pre-push guard

The example config is a plain 1x SPY + 200-day SMA strategy. Real parameters live in a separate private repo that the
engine loads from `PRIVATE_DIR` (default `../vampire-private`, falling back to `examples/`).

## What it does
- **Phases** (all times ET, derived from the Alpaca calendar, never hard-coded; half days shift automatically):
  - `morning` (~09:20, opg cutoff 09:28): sell the night ETF at the open, buy the day ETF at the open if the leg is on.
  - `afternoon` (~15:45, cls cutoff 15:50): sell the day ETF at the close, buy the night ETF at the close if the leg is on.
    The signal uses the latest price as a stand-in for the not-yet-official close; the decision price is logged.
  - `reconcile-open` / `reconcile-close` (~+30 min): fills vs the official auction price (bp), the **backtest twin**
    (same rules on official prices, same starting equity), expected vs actual daily return, a reason code
    (`missed_auction`, `partial_fill`, `signal_flip`, `rounding`, `fee`, `unknown`), a JSONL log and a summary JSON.
- **Safety**: kill-switch file, book never above 105% of equity, idempotent phases (position + open orders are netted;
  deterministic client order ids), only `opg`/`cls` market orders (anything else is refused in code), explicit
  `dry | paper | live` per account (live also needs `confirmLive` in config and `VAMPIRE_CONFIRM_LIVE=yes`),
  no trading when the calendar/API is unhealthy, an alert on every failure.
- **Whole shares only**: auction orders are never fractional.

## Use
```
node bin/vampire.js simulate --date 2026-11-16      # full dry run, prints planned orders, needs no keys
node bin/vampire.js preflight                       # keys, account type, buying power, symbols, calendar, data feed
node bin/vampire.js run morning                     # a phase (cron calls this); also: afternoon, reconcile-open, reconcile-close
npm test                                            # unit tests (scheduling, planning, idempotency, reconciliation, guard, backtest math)
python3 backtest/backtest.py --tickers SPY --leverage 1 --ma 200 --day-short 1 --start 2005-01-01   # needs yfinance, pandas
```
Config shape: see `examples/config.json`. Keys come from environment variables named in each account
(`keyEnv` / `secretEnv`), loaded from `<PRIVATE_DIR>/.env`.

## Backtest CLI
`backtest/backtest.py` : tickers (each an equal-weight leg and its own signal), leverage, MA length, day-short size, an
optional holding-cost drag, start/end; outputs CAGR, max drawdown, rolling-window positivity and the recent windows.

## Public/private split
`scripts/public-guard.sh` is the pre-push hook (`scripts/install-hooks.sh`) and CI step: it blocks private tickers,
private MA settings, private paths, keys, `.env`, data/log files and anything over 1 MB.

Paper/hypothetical results only; not investment advice.
