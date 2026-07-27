# -*- coding: utf-8 -*-
import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import advisor


CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))


def metrics(**changes):
    base = {
        "relative_zone": "持有",
        "relative_spread_pct": 2.0,
        "beta_adjusted_spread_pct": 2.0,
        "raw_relative_spread_pct": 8.0,
        "target_40d_return_pct": 1.0,
        "bond_support": "股债强支撑",
        "momentum": "中性",
        "distance_ma250_pct": 0.0,
        "beta_consensus": {
            "consistent": True,
            "robust_buy": False,
            "robust_overheat": False,
            "status": "窗口一致",
        },
        "reduce_confirmation": {
            "required_closes": 2,
            "confirmed_closes": 0,
            "consecutive_closes": 0,
            "confirmed": False,
            "core_required_closes": 5,
            "core_confirmed": False,
            "intraday_excluded": False,
        },
    }
    base.update(changes)
    return base


def overheat_metrics(**changes):
    base = metrics(
        relative_zone="相对过热",
        relative_spread_pct=8.0,
        beta_adjusted_spread_pct=8.0,
        target_40d_return_pct=6.0,
        distance_ma250_pct=2.0,
        beta_consensus={
            "consistent": True,
            "robust_buy": False,
            "robust_overheat": True,
            "status": "窗口一致",
        },
    )
    base.update(changes)
    return base


class RuleTests(unittest.TestCase):
    def test_relative_zone_boundaries(self):
        thresholds = CONFIG["thresholds"]["relative"]
        self.assertEqual(advisor.relative_zone(-8.0, thresholds), "强买")
        self.assertEqual(advisor.relative_zone(-5.0, thresholds), "加仓")
        self.assertEqual(advisor.relative_zone(-1.0, thresholds), "买入")
        self.assertEqual(advisor.relative_zone(-0.1, thresholds), "观察")
        self.assertEqual(advisor.relative_zone(4.99, thresholds), "持有")
        self.assertEqual(advisor.relative_zone(5.0, thresholds), "相对偏热")
        self.assertEqual(advisor.relative_zone(7.0, thresholds), "相对过热")

    def test_estimate_beta_matches_synthetic_half_beta(self):
        target = [{"close": 100.0}]
        benchmark = [{"close": 100.0}]
        target_value = 100.0
        benchmark_value = 100.0
        for index in range(900):
            market_return = ((index % 11) - 5) / 1000
            benchmark_value *= 1 + market_return
            target_value *= 1 + 0.5 * market_return
            target.append({"close": target_value})
            benchmark.append({"close": benchmark_value})
        estimate = advisor.estimate_beta(
            target, benchmark, 900, 800, 500, 0.4
        )
        self.assertTrue(estimate["sufficient"])
        self.assertAlmostEqual(estimate["beta"], 0.5, places=3)

    def test_bond_support_uses_spread_or_multiple(self):
        thresholds = CONFIG["thresholds"]["bond"]
        support, _, _ = advisor.bond_support(4.3, 1.7, thresholds)
        self.assertEqual(support, "股债强支撑")

    def test_buy_requires_beta_consensus_and_bond_confirmation(self):
        quality = {"blockers": [], "warnings": []}
        result = advisor.evaluate_rules(
            metrics(
                relative_zone="强买",
                beta_adjusted_spread_pct=-9.0,
                beta_consensus={
                    "consistent": True,
                    "robust_buy": True,
                    "robust_overheat": False,
                    "status": "窗口一致",
                },
                bond_support="股债弱支撑",
            ),
            quality,
            CONFIG,
        )
        self.assertEqual(result["action_code"], "buy_watch")

    def test_beta_window_conflict_blocks_buy(self):
        quality = {"blockers": [], "warnings": []}
        result = advisor.evaluate_rules(
            metrics(
                relative_zone="买入",
                beta_adjusted_spread_pct=-2.0,
                beta_consensus={
                    "consistent": False,
                    "robust_buy": False,
                    "robust_overheat": False,
                    "status": "窗口分歧",
                },
            ),
            quality,
            CONFIG,
        )
        self.assertEqual(result["action_code"], "beta_window_conflict")

    def test_intraday_bar_is_excluded_from_close_confirmation(self):
        target = [
            {"date": f"d{index}", "close": 100.0}
            for index in range(900)
        ]
        benchmark = copy.deepcopy(target)
        target[-1]["close"] = 110.0
        confirmation = advisor.compute_reduce_confirmation(
            target, benchmark, "盘中", CONFIG
        )
        self.assertEqual(confirmation["confirmed_closes"], 0)
        self.assertTrue(confirmation["intraday_excluded"])

    def test_one_close_only_warns(self):
        quality = {"blockers": [], "warnings": []}
        result = advisor.evaluate_rules(
            overheat_metrics(
                reduce_confirmation={
                    "required_closes": 2,
                    "confirmed_closes": 1,
                    "consecutive_closes": 1,
                    "confirmed": False,
                    "core_required_closes": 5,
                    "core_confirmed": False,
                    "intraday_excluded": False,
                }
            ),
            quality,
            CONFIG,
        )
        self.assertEqual(result["action_code"], "overheat_watch")
        self.assertEqual(result["execution"]["pct"], 0)

    def test_raw_relative_overheat_below_ma250_never_reduces(self):
        quality = {"blockers": [], "warnings": []}
        result = advisor.evaluate_rules(
            overheat_metrics(
                raw_relative_spread_pct=12.0,
                distance_ma250_pct=-4.0,
                reduce_confirmation={
                    "required_closes": 2,
                    "confirmed_closes": 2,
                    "consecutive_closes": 3,
                    "confirmed": True,
                    "core_required_closes": 5,
                    "core_confirmed": False,
                    "intraday_excluded": False,
                },
            ),
            quality,
            CONFIG,
        )
        self.assertEqual(result["action_code"], "overheat_protected")
        self.assertEqual(result["execution"]["pct"], 0)

    def test_relative_overheat_without_absolute_gain_never_reduces(self):
        quality = {"blockers": [], "warnings": []}
        result = advisor.evaluate_rules(
            overheat_metrics(target_40d_return_pct=-1.0), quality, CONFIG
        )
        self.assertEqual(result["action_code"], "overheat_protected")
        self.assertEqual(result["execution"]["pct"], 0)

    def test_beta_window_conflict_blocks_sell(self):
        quality = {"blockers": [], "warnings": []}
        result = advisor.evaluate_rules(
            overheat_metrics(
                beta_consensus={
                    "consistent": False,
                    "robust_buy": False,
                    "robust_overheat": False,
                    "status": "窗口分歧",
                }
            ),
            quality,
            CONFIG,
        )
        self.assertEqual(result["action_code"], "beta_window_conflict")

    def test_tactical_sell_requires_all_confirmations(self):
        quality = {"blockers": [], "warnings": []}
        result = advisor.evaluate_rules(
            overheat_metrics(
                reduce_confirmation={
                    "required_closes": 2,
                    "confirmed_closes": 2,
                    "consecutive_closes": 2,
                    "confirmed": True,
                    "core_required_closes": 5,
                    "core_confirmed": False,
                    "intraday_excluded": False,
                }
            ),
            quality,
            CONFIG,
        )
        self.assertEqual(result["action_code"], "reduce_tactical_5")
        self.assertEqual(result["execution"]["pct"], 5)
        self.assertEqual(result["execution"]["core_action"], "不动")

    def test_core_review_requires_five_closes_ten_percent_and_weak_value(self):
        quality = {"blockers": [], "warnings": []}
        result = advisor.evaluate_rules(
            overheat_metrics(
                distance_ma250_pct=11.0,
                bond_support="中性",
                reduce_confirmation={
                    "required_closes": 2,
                    "confirmed_closes": 2,
                    "consecutive_closes": 5,
                    "confirmed": True,
                    "core_required_closes": 5,
                    "core_confirmed": True,
                    "intraday_excluded": False,
                },
            ),
            quality,
            CONFIG,
        )
        self.assertEqual(result["action_code"], "reduce_core_review")
        self.assertEqual(result["execution"]["core_action"], "降档复核")

    def test_confirmed_signal_still_does_not_reduce_intraday(self):
        quality = {"blockers": [], "warnings": []}
        result = advisor.evaluate_rules(
            overheat_metrics(
                reduce_confirmation={
                    "required_closes": 2,
                    "confirmed_closes": 2,
                    "consecutive_closes": 2,
                    "confirmed": True,
                    "core_required_closes": 5,
                    "core_confirmed": False,
                    "intraday_excluded": True,
                }
            ),
            quality,
            CONFIG,
        )
        self.assertEqual(result["action_code"], "reduce_ready")
        self.assertEqual(result["execution"]["pct"], 0)

    def test_five_to_seven_only_pauses_additions(self):
        quality = {"blockers": [], "warnings": []}
        result = advisor.evaluate_rules(
            metrics(
                relative_zone="相对偏热",
                beta_adjusted_spread_pct=6.0,
            ),
            quality,
            CONFIG,
        )
        self.assertEqual(result["action_code"], "pause_add")
        self.assertEqual(result["execution"]["pct"], 0)

    def test_data_blocker_stops_action(self):
        quality = {"blockers": ["行情过旧"], "warnings": []}
        result = advisor.evaluate_rules(metrics(relative_zone="强买"), quality, CONFIG)
        self.assertEqual(result["decision"], "暂停行动")


if __name__ == "__main__":
    unittest.main()
