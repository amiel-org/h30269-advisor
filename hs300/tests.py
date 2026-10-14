# -*- coding: utf-8 -*-
"""Verification suite for the HS300 v2.0 model.

Covers: allocation boundaries, grid safety, account conservation, prefix
invariance (no look-ahead), earn-then-trade ordering, gradual step execution,
and confirmation gating.
"""
from __future__ import annotations

import unittest

from data import align
from model import (Account, Config, Series, build_signals, ladder_exposure,
                   metrics, percentile_of_history, quantize_down, run_backtest,
                   target_exposure)

CFG = Config.load()


class TestAllocation(unittest.TestCase):
    def test_ladder_boundaries(self):
        lad = CFG.ladder
        cases = [(100, 0.0), (70, 0.0), (69.99, 0.125), (60, 0.125),
                 (59.99, 0.375), (50, 0.375), (49.99, 0.625), (40, 0.625),
                 (39.99, 0.875), (30, 0.875), (29.99, 1.0), (0, 1.0)]
        for pct, expected in cases:
            self.assertAlmostEqual(ladder_exposure(pct, lad), expected, places=9,
                                   msg=f"PE pct {pct}")

    def test_ladder_monotone_decreasing(self):
        # Higher PE percentile = more expensive = exposure must not increase.
        lad = CFG.ladder
        prev = 1.0
        for pct in [i / 10 for i in range(0, 1001)]:
            cur = ladder_exposure(pct, lad)
            self.assertLessEqual(cur, prev + 1e-12)
            prev = cur

    def test_quantize_down_only(self):
        self.assertAlmostEqual(quantize_down(0.36, 0.125), 0.25)
        self.assertAlmostEqual(quantize_down(0.375, 0.125), 0.375)
        self.assertAlmostEqual(quantize_down(0.999, 0.125), 0.875)
        self.assertAlmostEqual(quantize_down(0.0, 0.125), 0.0)
        self.assertAlmostEqual(quantize_down(1.0, 0.125), 1.0)

    def test_target_never_exceeds_gate(self):
        for pe_pct in range(0, 101, 5):
            for erp_pct in range(0, 101, 5):
                t = target_exposure(pe_pct, erp_pct, CFG)
                gate = max(0.0, min(1.0, (erp_pct - CFG.gate_lo) / (CFG.gate_hi - CFG.gate_lo)))
                self.assertLessEqual(t, gate + 1e-12)
                self.assertLessEqual(t, ladder_exposure(pe_pct, CFG.ladder) + 1e-12)
                # discretisation: result sits exactly on the grid
                self.assertAlmostEqual(t / CFG.grid, round(t / CFG.grid), places=6)

    def test_percentile_excludes_current(self):
        self.assertAlmostEqual(percentile_of_history([1, 2, 3], 2), 200 / 3)


class TestAccount(unittest.TestCase):
    def test_post_fee_weight_matches_target(self):
        for start_w in (0.0, 0.3, 0.8, 1.0):
            for target in (0.0, 0.125, 0.375, 1.0):
                a = Account(equity=start_w, cash=1 - start_w)
                a.rebalance_to(target, CFG.fee)
                self.assertAlmostEqual(a.weight, target, places=10)

    def test_fee_reduces_nav_and_cash_stays_positive(self):
        a = Account(equity=0.0, cash=1.0)
        a.rebalance_to(0.5, CFG.fee)
        self.assertLess(a.nav, 1.0)
        # notional is solved so the POST-fee weight is exactly 0.5
        notional = 0.5 / (1 + CFG.fee * 0.5)
        self.assertAlmostEqual(a.nav, 1.0 - notional * CFG.fee, places=12)
        self.assertAlmostEqual(a.weight, 0.5, places=12)
        self.assertGreaterEqual(a.cash, 0.0)

    def test_no_free_lunch_on_full_round_trip(self):
        a = Account(equity=0.0, cash=1.0)
        a.rebalance_to(1.0, CFG.fee)
        a.rebalance_to(0.0, CFG.fee)
        self.assertLess(a.nav, 1.0)


class TestLookAhead(unittest.TestCase):
    def test_prefix_invariance(self):
        """Truncating the future must not change past signals."""
        series = align()
        full = build_signals(series, CFG)
        for cut in (701, 1000, 1500, 2500):
            head = Series(dates=series.dates[:cut], tr=series.tr[:cut],
                          pe=series.pe[:cut], spread=series.spread[:cut])
            self.assertEqual(build_signals(head, CFG), full[:cut])

    def test_future_price_change_does_not_move_past_signals(self):
        series = align()
        full = build_signals(series, CFG)
        mutated = Series(dates=list(series.dates), tr=list(series.tr),
                         pe=list(series.pe), spread=list(series.spread))
        mutated.tr[-1] *= 3.0
        mutated.pe[-1] *= 3.0
        self.assertEqual(build_signals(mutated, CFG)[:-1], full[:-1])

    def test_no_trade_earns_same_day_return(self):
        """A jump on the first eligible day must NOT be captured: position is 0."""
        dates = ["20200101", "20200102", "20200103", "20200106"]
        tr = [1.0, 2.0, 2.0, 2.0]          # +100% jump on day 1
        pe = [10.0, 10.0, 10.0, 10.0]
        spread = [5.0, 5.0, 5.0, 5.0]
        series = Series(dates=dates, tr=tr, pe=pe, spread=spread)
        signals = [0.0, 1.0, 1.0, 1.0]     # cheap signal only known from day 1
        r = run_backtest(series, CFG, signals=signals, lag=0)
        # Interval (0,1] is earned with weight 0, so the doubling is NOT captured.
        # NAV may only drop by the small entry fee, never approach 2.0.
        self.assertLess(r.curve[1][1], 1.001)
        self.assertGreater(r.curve[1][1], 0.999)

    def test_earn_then_trade_ordering(self):
        series = align()
        signals = build_signals(series, CFG)
        first = next(i for i, s in enumerate(signals) if s is not None)
        r = run_backtest(series, CFG, signals=signals, lag=1)
        self.assertEqual(r.exposures[0], 0.0)
        self.assertGreaterEqual(r.steps[0].date, series.dates[first + 1])


class TestExecution(unittest.TestCase):
    def test_gradual_steps_one_grid_per_day(self):
        series = align()
        signals = [1.0] * len(series)          # force full target immediately
        r = run_backtest(series, CFG, signals=signals, lag=0)
        for st in r.steps[:6]:
            self.assertLessEqual(st.weight_after - st.weight_before, CFG.step + 1e-9)

    def test_deadband_blocks_small_moves(self):
        series = align()
        target = 0.375
        signals = [target] * len(series)
        r = run_backtest(series, CFG, signals=signals, lag=0)
        for st in r.steps[1:]:
            self.assertGreater(abs(st.target - st.weight_before), CFG.deadband)

    def test_sell_confirmation_is_slower_than_buy(self):
        self.assertGreaterEqual(CFG.sell_confirm, CFG.buy_confirm)

    def test_metrics_on_empty(self):
        self.assertEqual(metrics([]), {})

    def test_metrics_drawdown_is_from_peak(self):
        curve = [("20200101", 1.0), ("20200102", 1.5), ("20200103", 1.2)]
        m = metrics(curve)
        self.assertAlmostEqual(m["max_drawdown_pct"], (1.2 / 1.5 - 1) * 100, places=4)


class TestEndToEnd(unittest.TestCase):
    def test_run_produces_curve(self):
        series = align()
        signals = build_signals(series, CFG)
        r = run_backtest(series, CFG, signals=signals, lag=1)
        self.assertGreater(len(r.curve), 2000)
        self.assertGreater(len(r.steps), 10)
        self.assertGreater(r.turnover, 0.0)
        m = metrics(r.curve)
        self.assertLess(m["max_drawdown_pct"], 0.0)
        self.assertGreater(m["end_nav"], 0.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
