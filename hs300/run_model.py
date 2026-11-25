# -*- coding: utf-8 -*-
"""Run the frozen HS300 model over the snapshot and emit results + parity ground truth."""
from __future__ import annotations

import copy
from dataclasses import asdict
import json
import sys
from pathlib import Path

from data import align
from model import (Account, Config, HOLD, build_signal_detail, interval_returns,
                   metrics, percentile_of_history, run_backtest, _calendar_days)

HERE = Path(__file__).resolve().parent
OUT = HERE / "reports"
OUT.mkdir(exist_ok=True)


def buy_hold(series, start_idx, cfg: Config):
    nav = 1.0
    curve = [(series.dates[start_idx], 1.0)]
    for i in range(start_idx + 1, len(series)):
        cd = _calendar_days(series.dates[i - 1], series.dates[i])
        eq_ret, _ = interval_returns(series.tr[i - 1], series.tr[i], cd, cfg)
        nav *= 1.0 + eq_ret
        curve.append((series.dates[i], nav))
    return curve


def fixed_weight(series, start_idx, w, rebalance, cfg: Config):
    account = Account()
    account.rebalance_to(w, cfg.fee)
    curve = [(series.dates[start_idx], 1.0)]
    for i in range(start_idx + 1, len(series)):
        cd = _calendar_days(series.dates[i - 1], series.dates[i])
        eq_ret, cash_ret = interval_returns(series.tr[i - 1], series.tr[i], cd, cfg)
        account.grow(eq_ret, cash_ret)
        if rebalance:
            account.rebalance_to(w, cfg.fee)
        curve.append((series.dates[i], account.nav))
    return curve


def current_signal(series, details):
    pe_pct = percentile_of_history(series.pe[:-1], series.pe[-1])
    erp_pct = percentile_of_history(series.spread[:-1], series.spread[-1])
    detail = details[-1]
    return {
        "date": series.dates[-1], "total_return_level": series.tr[-1],
        "pe": series.pe[-1], "spread_pct": round(series.spread[-1], 4),
        "pe_percentile": round(pe_pct, 2), "erp_percentile": round(erp_pct, 2),
        "target_exposure": detail["consensus_exposure"],
        "consensus": detail["consensus_exposure"],
        "agreed": detail["agreed"], "windows": detail["windows"],
    }


def main():
    cfg = Config.load()
    series = align()
    details = build_signal_detail(series, cfg)
    signals = [row["consensus_exposure"] if row is not None else None for row in details]
    first = next(i for i, s in enumerate(signals) if s is not None)

    live = run_backtest(series, cfg, signals, lag=1)
    same = run_backtest(series, cfg, signals, lag=0)

    # Zero-cash / zero-ETF-fee sensitivity reference
    raw_zero = copy.deepcopy(cfg.raw)
    raw_zero["execution"]["cash_yield_annual"] = 0.0
    raw_zero["execution"]["etf_fee_annual"] = 0.0
    raw_zero["execution"]["risk_free_annual"] = 0.0
    cfg_zero = Config(raw_zero)
    zero_run = run_backtest(series, cfg_zero, signals, lag=1)

    avg_w = round(sum(live.exposures) / len(live.exposures), 3)
    rf = cfg.risk_free_annual

    live_metrics = metrics(live.curve, risk_free_annual=rf)
    cs = current_signal(series, details)

    results = {
        "config_version": cfg.version, "rows": len(series),
        "window": [series.dates[first], series.dates[-1]],
        "model_next_close": {**live_metrics, "trades": len(live.steps),
                             "turnover": round(live.turnover, 4), "avg_exposure": avg_w},
        "model_zero_cash_zero_fee": {**metrics(zero_run.curve, risk_free_annual=0.0),
                                     "trades": len(zero_run.steps),
                                     "turnover": round(zero_run.turnover, 4)},
        "variant_same_close_optimistic": {**metrics(same.curve, risk_free_annual=rf), "trades": len(same.steps),
                                          "avg_exposure": round(sum(same.exposures) / len(same.exposures), 3)},
        "benchmark_buy_hold": metrics(buy_hold(series, first, cfg), risk_free_annual=rf),
        "benchmark_matched_hold": metrics(fixed_weight(series, first, avg_w, False, cfg), risk_free_annual=rf),
        "benchmark_matched_rebalanced": metrics(fixed_weight(series, first, avg_w, True, cfg), risk_free_annual=rf),
        "current_signal": cs,
    }
    (OUT / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    parity = {
        "config_version": cfg.version,
        "signals": [round(s, 12) if isinstance(s, float) else s for s in signals],
        "metrics": live_metrics,
        "trades": len(live.steps),
        "turnover": live.turnover,
        "steps": [asdict(st) for st in live.steps],
        "hold_days": sum(1 for s in signals if s == HOLD),
        "current": {
            "date": cs["date"],
            "pe": cs["pe"],
            "windows": {
                k: {
                    "label": v["label"],
                    "pe_percentile": v["pe_percentile"],
                    "erp_percentile": v["erp_percentile"],
                    "exposure": v["exposure"],
                }
                for k, v in cs["windows"].items()
            },
            "agreed": cs["agreed"],
            "consensus": cs["consensus"],
        },
    }
    (OUT / "parity_expected.json").write_text(json.dumps(parity, ensure_ascii=False), encoding="utf-8")

    def line(tag, d):
        if not d:
            print(f"{tag}: (empty)"); return
        print(f"{tag:<32} CAGR(cal)={d['cagr_calendar_pct']:>6.2f}%  MaxDD={d['max_drawdown_pct']:>7.2f}%  Sharpe={d['sharpe']:>5.3f}")

    print(f"window {series.dates[first]} -> {series.dates[-1]}  rows={len(series)}  version={cfg.version}")
    line("model v2.5 (realistic net)", results["model_next_close"])
    line("model v2.5 (0% cash / 0% fee)", results["model_zero_cash_zero_fee"])
    line("buy & hold (net 0.20% fee)", results["benchmark_buy_hold"])
    line(f"hold @ {avg_w}", results["benchmark_matched_hold"])
    line(f"rebalanced @ {avg_w}", results["benchmark_matched_rebalanced"])
    print(f"\ncurrent {cs['date']}: PE={cs['pe']:.2f} PE_pct={cs['pe_percentile']:.1f}% ERP_pct={cs['erp_percentile']:.1f}% -> target={cs['target_exposure']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
