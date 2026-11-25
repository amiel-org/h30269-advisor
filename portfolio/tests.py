#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Verification suite for the dual-asset unified portfolio allocator (HS300 + H30269)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from portfolio.backtest import build_aligned_records
from portfolio.model import (
    compute_portfolio_targets,
    compute_spillover_factors,
    load_config,
    run_portfolio_backtest,
)

CFG = load_config()


class TestPortfolioAllocator(unittest.TestCase):
    def test_spillover_taper_is_continuous_without_cliffs(self):
        # Smooth monotonic decay for H30269 from PE pct 70% to 85%
        prev = 1.0
        for pe in range(60, 91):
            fac = compute_spillover_factors(50.0, 0.5, float(pe), 0.0, False, CFG)["h30269_factor"]
            self.assertLessEqual(fac, prev + 1e-12)
            self.assertGreaterEqual(fac, 0.0)
            prev = fac
        self.assertAlmostEqual(
            compute_spillover_factors(50.0, 0.5, 70.0, 0.0, False, CFG)["h30269_factor"], 1.0
        )
        self.assertAlmostEqual(
            compute_spillover_factors(50.0, 0.5, 85.0, 0.0, False, CFG)["h30269_factor"], 0.0
        )
        # Overheated H30269 immediately blocks spillover expansion
        self.assertEqual(
            compute_spillover_factors(50.0, 0.5, 50.0, 6.0, False, CFG)["h30269_factor"], 0.0
        )

    def test_caps_and_cash_cushion_always_respected(self):
        for w300 in (0.0, 0.25, 0.5, 0.75, 1.0):
            for wdiv in (0.0, 0.4, 0.7, 0.8, 1.0):
                for pe300 in (20.0, 50.0, 80.0):
                    for pediv in (30.0, 75.0, 90.0):
                        t = compute_portfolio_targets(w300, wdiv, pe300, pediv, 0.0, False, CFG)
                        self.assertLessEqual(t["hs300_target"], CFG["max_sleeve_weights"]["hs300"] + 1e-9)
                        self.assertLessEqual(t["h30269_target"], CFG["max_sleeve_weights"]["h30269"] + 1e-9)
                        self.assertLessEqual(t["total_equity"], CFG["max_total_equity"] + 1e-9)
                        self.assertGreaterEqual(t["cash_target"], CFG["min_cash_buffer"] - 1e-9)

    def test_idle_hs300_spills_into_cheap_h30269_but_not_expensive_h30269(self):
        cheap_div = compute_portfolio_targets(0.0, 0.8, 75.0, 50.0, 0.0, False, CFG)
        expensive_div = compute_portfolio_targets(0.0, 0.8, 75.0, 88.0, 0.0, False, CFG)
        self.assertGreater(cheap_div["h30269_target"], 0.40)  # > 50% * 0.80 = 40%
        self.assertAlmostEqual(expensive_div["h30269_target"], 0.40, places=9)

    def test_backtest_prefix_invariance_no_lookahead(self):
        records, _ = build_aligned_records()
        full = run_portfolio_backtest(records, CFG)
        cut = 1200
        sub = run_portfolio_backtest(records[:cut], CFG)
        self.assertEqual(sub["curve"], full["curve"][: len(sub["curve"])])
        cutoff_date = records[cut - 1]["date"]
        self.assertEqual(sub["trades"], [t for t in full["trades"] if t["date"] <= cutoff_date])


if __name__ == "__main__":
    unittest.main(verbosity=2)
