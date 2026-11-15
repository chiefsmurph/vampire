import os, sys, unittest
sys.path.insert(0, os.path.dirname(__file__))
try:
    import numpy as np, pandas as pd
    import backtest as bt
except ImportError:  # pandas not installed: skipped by the node wrapper
    bt = None


@unittest.skipIf(bt is None, "pandas not available")
class BacktestMath(unittest.TestCase):
    def frame(self, n=40, night=0.01, day=-0.005):
        idx = pd.bdate_range("2020-01-01", periods=n)
        o, c, prev = [], [], 100.0
        for _ in idx:
            op = prev * (1 + night); cl = op * (1 + day)
            o.append(op); c.append(cl); prev = cl
        return pd.DataFrame({"Open": o, "Close": c}, index=idx)

    def test_cycle_compounds_exactly(self):
        f = {"X": self.frame()}
        eq = bt.simulate(f, leverage=1, ma=3, day_short=1, start="2020-01-01", end="2021-01-01")
        r = (eq / eq.shift(1)).dropna()
        # once fully on, each session earns night (+1%) then the inverse day leg (+0.5%)
        self.assertAlmostEqual(r.iloc[-5], 1.01 * 1.005, places=9)

    def test_base_has_no_day_leg_and_leverage_scales(self):
        f = {"X": self.frame()}
        eq = bt.simulate(f, leverage=3, ma=3, day_short=0, start="2020-01-01", end="2021-01-01")
        r = (eq / eq.shift(1)).dropna()
        self.assertAlmostEqual(r.iloc[-5], 1.03, places=9)

    def test_gate_off_below_ma_is_cash(self):
        idx = pd.bdate_range("2020-01-01", periods=30)
        c = np.linspace(100, 50, 30)
        f = {"X": pd.DataFrame({"Open": c * 0.99, "Close": c}, index=idx)}
        eq = bt.simulate(f, leverage=3, ma=5, day_short=1, start="2020-01-01", end="2021-01-01")
        self.assertAlmostEqual(eq.iloc[-1], 1.0, places=9)

    def test_two_legs_are_equal_weight(self):
        f = {"A": self.frame(night=0.01, day=0.0), "B": self.frame(night=0.03, day=0.0)}
        eq = bt.simulate(f, leverage=1, ma=3, day_short=0, start="2020-01-01", end="2021-01-01")
        r = (eq / eq.shift(1)).dropna()
        self.assertAlmostEqual(r.iloc[-5], 1.02, places=9)

    def test_drag_reduces_return(self):
        f = {"X": self.frame()}
        a = bt.simulate(f, 1, 3, 0, "2020-01-01", "2021-01-01", 0.0).iloc[-1]
        b = bt.simulate(f, 1, 3, 0, "2020-01-01", "2021-01-01", 5.0).iloc[-1]
        self.assertLess(b, a)

    def test_stats_keys(self):
        f = {"X": self.frame(n=400)}
        eq = bt.simulate(f, 1, 3, 1, "2020-01-01", "2022-01-01")
        st = bt.stats(eq)
        for k in ("cagr_pct", "max_dd_pct", "rolling_positive_pct", "recent_windows_pct"):
            self.assertIn(k, st)


if __name__ == "__main__":
    unittest.main()
