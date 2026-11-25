#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate reproducible dual-asset portfolio backtest report and JS parity baseline."""
from __future__ import annotations

import datetime as dt
import json
import math
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
for p in (ROOT, ROOT / "hs300", ROOT / "h30269"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import data as hs_data
import model as hs_model
import backtest as h_bt
from portfolio.model import load_config, run_portfolio_backtest, summarize_portfolio


def build_aligned_records() -> tuple[list[dict[str, Any]], dict[str, float]]:
    hs_cfg = hs_model.Config.load()
    hs_series = hs_data.align()
    hs_details = hs_model.build_signal_detail(hs_series, hs_cfg)
    hs_signals = [d["consensus_exposure"] if d else None for d in hs_details]
    hs_run = hs_model.run_backtest(hs_series, hs_cfg, signals=hs_signals, lag=1)

    hs_tr_map = dict(zip(hs_series.dates, hs_series.tr))
    hs_det_map = dict(zip(hs_series.dates, hs_details))
    hs_exp_map = {d: w for (d, _), w in zip(hs_run.curve, hs_run.exposures)}

    h_cfg = h_bt.load_config()
    h_rows = h_bt.load_dataset()
    h_start = 1215
    h_run50 = h_bt.simulate_h30269(h_rows, h_cfg, mode="v3_2", init_core=0.50, start_idx=h_start)
    h_run00 = h_bt.simulate_h30269(h_rows, h_cfg, mode="v3_2", init_core=0.0, start_idx=h_start)

    h_tr_map = {r["date"]: r["tr_tgt"] for r in h_rows}
    h_exp50_map = {d: w for (d, _), w in zip(h_run50["curve"], h_run50["exposures"])}
    h_exp00_map = {d: w for (d, _), w in zip(h_run00["curve"], h_run00["exposures"])}

    n = len(h_rows)
    tgt_sig = [r["tr_tgt"] for r in h_rows]
    bm_sig = [r["tr_bm"] for r in h_rows]
    tgt_ret1 = [0.0] + [tgt_sig[i] / tgt_sig[i - 1] - 1.0 for i in range(1, n)]
    bm_ret1 = [0.0] + [bm_sig[i] / bm_sig[i - 1] - 1.0 for i in range(1, n)]
    pe_hist = [float(h_rows[k]["pe"]) for k in range(h_start) if h_rows[k]["pe"] is not None]
    win_defs = [(lbl, int(spec["trading_days"])) for lbl, spec in h_cfg["beta"]["windows"].items()]
    r2_ref = float(h_cfg["beta"]["shrinkage_r2_ref"])

    h_feat_map: dict[str, dict[str, Any]] = {}
    for i in range(h_start, n):
        r = h_rows[i]
        t40 = tgt_sig[i] / tgt_sig[i - 40] - 1.0
        b40 = bm_sig[i] / bm_sig[i - 40] - 1.0
        betas, r2s = {}, {}
        for nm, wlen in win_defs:
            b_val, r2_val = h_bt.ols_beta(tgt_ret1[i - wlen + 1 : i + 1], bm_ret1[i - wlen + 1 : i + 1], 0.4)
            betas[nm], r2s[nm] = b_val, r2_val
        adj = {}
        for nm, _ in win_defs:
            b_eff = betas[nm]
            if nm != "5y":
                lam = min(1.0, max(0.0, r2s[nm] / r2_ref))
                b_eff = lam * betas[nm] + (1.0 - lam) * betas["5y"]
            adj[nm] = (t40 - b_eff * b40) * 100.0
        pe_pct = h_bt.pct_of_history(pe_hist, float(r["pe"])) if (r["pe"] and len(pe_hist) >= 500) else 50.0
        if r["pe"] is not None:
            pe_hist.append(float(r["pe"]))
        h_feat_map[r["date"]] = {
            "adj_5y": round(adj["5y"], 6),
            "robust_overheat": all(v >= 7.0 for v in adj.values()),
            "pe_pct": round(pe_pct, 4),
        }

    common = sorted(set(hs_exp_map) & set(h_exp50_map) & set(hs_tr_map) & set(h_tr_map))
    records: list[dict[str, Any]] = []
    for d in common:
        det = hs_det_map[d]
        hs_pe_pct = det["windows"]["full"]["pe_percentile"] if det else 50.0
        feat = h_feat_map[d]
        records.append(
            {
                "date": d,
                "hs_tr": round(float(hs_tr_map[d]), 4),
                "h_tr": round(float(h_tr_map[d]), 4),
                "hs_exp": round(float(hs_exp_map[d]), 6),
                "hs_pe_pct": round(float(hs_pe_pct), 4),
                "h_exp50": round(float(h_exp50_map[d]), 6),
                "h_exp00": round(float(h_exp00_map[d]), 6),
                "h_pe_pct": feat["pe_pct"],
                "h_adj_5y": feat["adj_5y"],
                "h_robust_overheat": feat["robust_overheat"],
            }
        )

    # Return & exposure correlations
    r300 = [records[i]["hs_tr"] / records[i - 1]["hs_tr"] - 1.0 for i in range(1, len(records))]
    rdiv = [records[i]["h_tr"] / records[i - 1]["h_tr"] - 1.0 for i in range(1, len(records))]
    e300 = [r["hs_exp"] for r in records]
    ediv = [r["h_exp50"] for r in records]

    def corr(xs: list[float], ys: list[float]) -> float:
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        num = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
        den = math.sqrt(sum((a - mx) ** 2 for a in xs) * sum((b - my) ** 2 for b in ys))
        return round(num / den, 4) if den > 0 else 0.0

    stats = {
        "daily_return_correlation": corr(r300, rdiv),
        "standalone_exposure_correlation": corr(e300, ediv),
    }
    return records, stats


def simulate_static(records: list[dict[str, Any]], w_hs: float, w_div: float, cfg: dict[str, Any], deadband: float = 0.05) -> dict[str, Any]:
    acct = cfg["accounting"]
    fee = float(acct["fee_one_way"])
    etf_fee = float(acct["etf_fee_annual"])
    cash_y = float(acct["cash_yield_annual"])
    rf = float(acct["risk_free_annual"])

    hs_v = w_hs
    div_v = w_div
    cash_v = 1.0 - w_hs - w_div - (w_hs + w_div) * fee
    curve = [(records[0]["date"], hs_v + div_v + cash_v)]
    w300s = [hs_v / curve[0][1]]
    wdivs = [div_v / curve[0][1]]
    trades = []
    to = w_hs + w_div

    for i in range(1, len(records)):
        d0 = dt.datetime.strptime(records[i - 1]["date"], "%Y%m%d").date()
        d1 = dt.datetime.strptime(records[i]["date"], "%Y%m%d").date()
        cd = max(1, (d1 - d0).days)
        drag = (1.0 - etf_fee) ** (cd / 365.25)
        hs_v *= (records[i]["hs_tr"] / records[i - 1]["hs_tr"]) * drag
        div_v *= (records[i]["h_tr"] / records[i - 1]["h_tr"]) * drag
        cash_v *= (1.0 + cash_y) ** (cd / 365.25)
        nav = hs_v + div_v + cash_v
        if w_hs > 0 and w_div > 0 and (abs(hs_v / nav - w_hs) > deadband or abs(div_v / nav - w_div) > deadband):
            n1 = w_hs * nav - hs_v
            n2 = w_div * nav - div_v
            comm = (abs(n1) + abs(n2)) * fee
            hs_v += n1
            div_v += n2
            cash_v -= n1 + n2 + comm
            to += (abs(n1) + abs(n2)) / nav
            trades.append({"date": records[i]["date"]})
        post_nav = hs_v + div_v + cash_v
        w300s.append(hs_v / post_nav)
        wdivs.append(div_v / post_nav)
        curve.append((records[i]["date"], post_nav))
    return summarize_portfolio(curve, w300s, wdivs, trades, to, rf)


def main() -> None:
    cfg = load_config()
    records, corr_stats = build_aligned_records()

    unified_50 = run_portfolio_backtest(records, cfg, use_h30269_key="h_exp50")
    siloed_50 = run_portfolio_backtest(records, cfg, spillover_override=0.0, no_cliff_override=False, use_h30269_key="h_exp50")
    unified_00 = run_portfolio_backtest(records, cfg, use_h30269_key="h_exp00")
    siloed_00 = run_portfolio_backtest(records, cfg, spillover_override=0.0, no_cliff_override=False, use_h30269_key="h_exp00")

    # Standalone single-sleeve comparisons on exact same overlapping window
    standalone_hs_cfg = {**cfg, "base_weights": {"hs300": 1.0, "h30269": 0.0}, "max_sleeve_weights": {"hs300": 1.0, "h30269": 0.0}, "max_total_equity": 1.0, "rebalance": {**cfg["rebalance"], "deadband": 0.005, "max_step": 1.0, "cooldown_trading_days": 1}}
    standalone_div_cfg = {**cfg, "base_weights": {"hs300": 0.0, "h30269": 1.0}, "max_sleeve_weights": {"hs300": 0.0, "h30269": 1.0}, "max_total_equity": 1.0, "rebalance": {**cfg["rebalance"], "deadband": 0.005, "max_step": 1.0, "cooldown_trading_days": 1}}
    standalone_hs = run_portfolio_backtest(records, standalone_hs_cfg, spillover_override=0.0, no_cliff_override=False)["summary"]
    standalone_div = run_portfolio_backtest(records, standalone_div_cfg, spillover_override=0.0, no_cliff_override=False)["summary"]

    passive_50_50 = simulate_static(records, 0.50, 0.50, cfg, deadband=0.05)
    passive_hs300 = simulate_static(records, 1.0, 0.0, cfg)
    passive_h30269 = simulate_static(records, 0.0, 1.0, cfg)

    report = {
        "version": cfg["version"],
        "sample": {
            "start": records[0]["date"],
            "end": records[-1]["date"],
            "trading_days": len(records),
            **corr_stats,
        },
        "accounting": cfg["accounting"],
        "unified_v1_core50": unified_50["summary"],
        "siloed_50_50_core50": siloed_50["summary"],
        "unified_v1_cash0": unified_00["summary"],
        "siloed_50_50_cash0": siloed_00["summary"],
        "standalone_hs300_v25": standalone_hs,
        "standalone_h30269_v32": standalone_div,
        "passive_50_50_rebalanced": passive_50_50,
        "passive_100_hs300": passive_hs300,
        "passive_100_h30269": passive_h30269,
    }

    out_dir = HERE / "reports"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    # Save compact parity baseline (every record + expected unified_50 trades & summary)
    parity = {
        "version": cfg["version"],
        "records": records,
        "expected_summary": unified_50["summary"],
        "expected_trades": unified_50["trades"],
    }
    (out_dir / "parity_expected.json").write_text(
        json.dumps(parity, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    print(
        f"Portfolio Backtest ({records[0]['date']} -> {records[-1]['date']}, {len(records)} days | "
        f"RetCorr={corr_stats['daily_return_correlation']}, ExpCorr={corr_stats['standalone_exposure_correlation']})"
    )
    for label, s in [
        ("Unified Pool v1.0 (init 50% div)", unified_50["summary"]),
        ("Siloed 50/50 (init 50% div)", siloed_50["summary"]),
        ("Unified Pool v1.0 (init 0% cash)", unified_00["summary"]),
        ("Siloed 50/50 (init 0% cash)", siloed_00["summary"]),
        ("Standalone HS300 v2.5 (100%)", standalone_hs),
        ("Standalone H30269 V3.2 (100%)", standalone_div),
        ("Passive 50/50 Rebalanced", passive_50_50),
    ]:
        f = s["full"]
        print(
            f"  {label:<34} | CAGR={f['cagr_calendar_pct']:>5.2f}%  MDD={f['max_drawdown_pct']:>6.2f}%  "
            f"ExShp={f['sharpe']:>5.3f}  Calmar={f['calmar']:>4.2f}  AvgEq={s['avg_total_equity_pct']:>4.1f}%  Trd={s['trades']:>3}"
        )


if __name__ == "__main__":
    main()
