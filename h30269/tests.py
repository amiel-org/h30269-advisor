#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Verification suite for H30269 V3.2 model and reproducible backtest engine."""
from __future__ import annotations

import datetime as dt
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import advisor
from backtest import load_config, load_dataset, simulate_h30269

CFG = load_config()


def _iso_date(compact: str) -> str:
    return f"{compact[:4]}-{compact[4:6]}-{compact[6:8]}"


class TestH30269V32Model(unittest.TestCase):
    def test_implied_dividend_yield_matches_official_range(self):
        rows = load_dataset()
        p_rows = [{"date": _iso_date(r["date"]), "close": r["p_tgt"]} for r in rows]
        tr_rows = [{"date": _iso_date(r["date"]), "close": r["tr_tgt"]} for r in rows]
        implied = advisor.implied_dividend_yield(p_rows, tr_rows)
        self.assertIsNotNone(implied)
        # Official Danjuan CSIH30269 yield in Oct-Nov 2026 is ~4.37%-4.38%
        self.assertGreater(implied["value"], 3.8)
        self.assertLess(implied["value"], 5.0)

    def test_provisional_tr_bridge_scales_intraday_bar(self):
        p_rows = [
            {"date": "2026-11-24", "close": 100.0, "pe": 7.8},
            {"date": "2026-11-25", "close": 102.0, "pe": 7.956},
        ]
        tr_rows = [{"date": "2026-11-24", "close": 200.0, "pe": 7.8}]
        bridged = advisor._bridge_provisional_tr(p_rows, tr_rows)
        self.assertEqual(len(bridged), 2)
        self.assertEqual(bridged[-1]["date"], "2026-11-25")
        self.assertAlmostEqual(bridged[-1]["close"], 204.0, places=6)

    def test_beta_r2_shrinkage_anchors_low_r2_short_window(self):
        # Construct 1250 days where first 760 days have beta=0.5 (high R2),
        # and last 490 days have near-zero R2 noise with huge raw beta spike.
        tgt = [{"date": "2020-01-01", "close": 100.0}]
        bm = [{"date": "2020-01-01", "close": 100.0}]
        tv, bv = 100.0, 100.0
        for i in range(1, 1250):
            b_ret = 0.01 if (i % 2 == 0) else -0.0099
            if i < 760:
                t_ret = 0.5 * b_ret
            else:
                # Orthogonal large swing + tiny correlation -> very low R2
                ortho = 0.025 if ((i // 2) % 2 == 0) else -0.024
                t_ret = 1.1 * b_ret * 0.1 + ortho
            tv *= 1.0 + t_ret
            bv *= 1.0 + b_ret
            d = (dt.date(2020, 1, 1) + dt.timedelta(days=i)).isoformat()
            tgt.append({"date": d, "close": tv})
            bm.append({"date": d, "close": bv})

        windows = advisor._evaluate_multi_window_beta(tgt, bm, 1249, -0.02, 0.04, CFG)
        self.assertLess(windows["2y"]["r2"], 0.15)
        self.assertLess(windows["2y"]["shrinkage_weight"], 1.0)
        # Effective beta is pulled toward 5y anchor
        dist_shrunk = abs(windows["2y"]["beta"] - windows["5y"]["beta"])
        dist_raw = abs(windows["2y"]["raw_beta"] - windows["5y"]["beta"])
        self.assertLessEqual(dist_shrunk, dist_raw + 1e-12)

    def test_reduce_confirmation_requires_all_overheat_gates(self):
        # 5y adjusted spread >= 7%, but target 40d return is NEGATIVE (-2% while benchmark is -15%):
        # consecutive_closes MUST stay 0!
        tgt = []
        bm = []
        tv, bv = 100.0, 100.0
        for i in range(1250):
            b_ret = -0.004 if i >= 1205 else (0.005 if i % 2 == 0 else -0.0049)
            t_ret = -0.0005 if i >= 1205 else 0.5 * b_ret
            tv *= 1.0 + t_ret
            bv *= 1.0 + b_ret
            d = (dt.date(2020, 1, 1) + dt.timedelta(days=i)).isoformat()
            tgt.append({"date": d, "close": tv})
            bm.append({"date": d, "close": bv})
        conf = advisor.compute_reduce_confirmation(tgt, bm, "历史收盘", CFG)
        self.assertEqual(conf["consecutive_closes"], 0)
        self.assertFalse(conf["confirmed"])

    def test_pe_valuation_gate_blocks_high_percentile_non_extreme_buys(self):
        base_metrics = {
            "relative_zone": "买入",
            "beta_adjusted_spread_pct": -2.5,
            "target_40d_return_pct": -1.0,
            "bond_support": "股债有支撑",
            "momentum": "中性",
            "distance_ma250_pct": 2.0,
            "pe": 7.85,
            "pe_percentile": 82.0,
            "beta_consensus": {"consistent": True, "robust_buy": True, "robust_overheat": False},
            "reduce_confirmation": {"required_closes": 2, "confirmed_closes": 0, "confirmed": False, "intraday_excluded": False},
        }
        blocked = advisor.evaluate_rules(base_metrics, {"blockers": [], "warnings": []}, CFG)
        self.assertEqual(blocked["action_code"], "valuation_high_watch")
        self.assertEqual(blocked["execution"]["pct"], 0)

        # Extreme dislocation (强买 <= -8%) still executes 20% tranche
        extreme = {**base_metrics, "relative_zone": "强买", "beta_adjusted_spread_pct": -8.5}
        allowed = advisor.evaluate_rules(extreme, {"blockers": [], "warnings": []}, CFG)
        self.assertEqual(allowed["action_code"], "buy_tranche")
        self.assertEqual(allowed["execution"]["pct"], 20)

    def test_data_quality_blocks_missing_or_stale_fundamentals(self):
        today = dt.date(2026, 11, 25)
        m = {"trade_date": "2026-11-24", "beta_source": "rolling-full", "beta_consensus": {"consistent": True}}
        missing_div = advisor.SourceValue(value=None, as_of=None, source="err", source_url="", status="missing")
        fresh_bond = advisor.SourceValue(value=1.80, as_of="2026-11-24", source="ok", source_url="", status="live")
        q1 = advisor.data_quality(m, missing_div, fresh_bond, CFG, [], ref_date=today)
        self.assertTrue(any("股息率" in b for b in q1["blockers"]))

        stale_bond = advisor.SourceValue(value=1.80, as_of="2026-06-25", source="old", source_url="", status="cache")
        fresh_div = advisor.SourceValue(value=4.38, as_of="2026-11-24", source="ok", source_url="", status="live")
        q2 = advisor.data_quality(m, fresh_div, stale_bond, CFG, [], ref_date=today)
        self.assertTrue(any("10年国债" in b for b in q2["blockers"]))

    def test_backtest_prefix_invariance_no_lookahead(self):
        rows = load_dataset()
        full = simulate_h30269(rows, CFG, mode="v3_2", init_core=0.50, start_idx=1215)
        cut = 2400
        sub = simulate_h30269(rows[:cut], CFG, mode="v3_2", init_core=0.50, start_idx=1215)
        self.assertEqual(sub["curve"], full["curve"][: len(sub["curve"])])
        cutoff_date = rows[cut - 1]["date"]
        self.assertEqual(
            sub["trades"],
            [t for t in full["trades"] if t["date"] <= cutoff_date],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
