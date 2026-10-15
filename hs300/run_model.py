# -*- coding: utf-8 -*-
"""Run the frozen model over the snapshot and emit machine-readable results."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from data import align
from model import (Account, Config, build_signals, metrics, percentile_of_history,
                   run_backtest, window_targets)

HERE = Path(__file__).resolve().parent
OUT = HERE / "reports"
OUT.mkdir(exist_ok=True)


def buy_hold(series, start_idx):
    base = series.tr[start_idx]
    return [(series.dates[start_idx], 1.0)] + [
        (series.dates[i], series.tr[i] / base) for i in range(start_idx + 1, len(series))]


def fixed_weight(series, start_idx, w, rebalance, fee):
    account = Account()
    account.rebalance_to(w, fee)
    # Use a pre-entry baseline so initial commission is reflected in NAV.
    curve = [(series.dates[start_idx], 1.0)]
    for i in range(start_idx + 1, len(series)):
        account.grow(series.tr[i] / series.tr[i - 1] - 1.0)
        if rebalance:
            account.rebalance_to(w, fee)
        curve.append((series.dates[i], account.nav))
    return curve


def current_signal(series, cfg):
    pe_pct = percentile_of_history(series.pe[:-1], series.pe[-1])
    erp_pct = percentile_of_history(series.spread[:-1], series.spread[-1])
    detail = window_targets(series.pe[:-1], series.spread[:-1], series.pe[-1], series.spread[-1], cfg)
    return {
        "date": series.dates[-1], "total_return_level": series.tr[-1],
        "pe": series.pe[-1], "spread_pct": round(series.spread[-1], 4),
        "pe_percentile": round(pe_pct, 2), "erp_percentile": round(erp_pct, 2),
        "target_exposure": detail["consensus_exposure"],
        "agreed": detail["agreed"], "windows": detail["windows"],
    }


def main():
    cfg = Config.load()
    series = align()
    signals = build_signals(series, cfg)
    first = next(i for i, s in enumerate(signals) if s is not None)

    live = run_backtest(series, cfg, signals, lag=1)
    same = run_backtest(series, cfg, signals, lag=0)
    avg_w = round(sum(live.exposures) / len(live.exposures), 3)

    results = {
        "config_version": cfg.version, "rows": len(series),
        "window": [series.dates[first], series.dates[-1]],
        "model_next_close": {**metrics(live.curve), "trades": len(live.steps),
                             "turnover": round(live.turnover, 4), "avg_exposure": avg_w},
        "variant_same_close_optimistic": {**metrics(same.curve), "trades": len(same.steps),
                                          "avg_exposure": round(sum(same.exposures) / len(same.exposures), 3)},
        "benchmark_buy_hold": metrics(buy_hold(series, first)),
        "benchmark_matched_hold": metrics(fixed_weight(series, first, avg_w, False, cfg.fee)),
        "benchmark_matched_rebalanced": metrics(fixed_weight(series, first, avg_w, True, cfg.fee)),
        "current_signal": current_signal(series, cfg),
    }
    (OUT / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    def line(tag, d):
        if not d:
            print(f"{tag}: (empty)"); return
        print(f"{tag:<30} CAGR(cal)={d['cagr_calendar_pct']:>6.2f}%  MaxDD={d['max_drawdown_pct']:>7.2f}%  Sharpe={d['sharpe']:>5.2f}")

    print(f"window {series.dates[first]} -> {series.dates[-1]}  rows={len(series)}")
    line("model (next-close fill)", results["model_next_close"])
    line("same-close (optimistic)", results["variant_same_close_optimistic"])
    line("buy & hold (100%)", results["benchmark_buy_hold"])
    line(f"hold @ {avg_w}", results["benchmark_matched_hold"])
    line(f"rebalanced @ {avg_w}", results["benchmark_matched_rebalanced"])
    cs = results["current_signal"]
    print(f"\ncurrent {cs['date']}: PE={cs['pe']:.2f} PE_pct={cs['pe_percentile']:.1f}% ERP_pct={cs['erp_percentile']:.1f}% -> target={cs['target_exposure']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
