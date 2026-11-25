#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Reproducible historical backtest for H30269 V3.2 vs V3.1 and passive benchmarks.

Design guarantees:
  * Signals are evaluated strictly at close of day t-1 and filled at close of day t (lag=1).
  * Historical PE percentile pools exclude the current observation (no look-ahead).
  * Bond 10Y yields are forward-filled strictly from past dates (<= trade_date).
  * Trailing 365-calendar-day implied dividend yield is computed strictly from <= trade_date.
  * Portfolio equity always compounds at true H20269 total return net of annual ETF fee (0.20%),
    and uninvested cash earns annual cash yield (1.80%), with 5bp one-way trade commission.
"""
from __future__ import annotations

import bisect
import datetime as dt
import json
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent


def load_config() -> dict[str, Any]:
    return json.loads((ROOT / "config.json").read_text(encoding="utf-8-sig"))


def load_dataset() -> list[dict[str, Any]]:
    raw = json.loads((HERE / "raw_data.json").read_text(encoding="utf-8"))
    hs_raw = json.loads((ROOT / "raw_data.json").read_text(encoding="utf-8"))
    bond = {**hs_raw["bond10y"], **(raw.get("bond_recent") or {})}
    bond_keys = sorted(bond)

    p_tgt = {r["date"]: r for r in raw["H30269"]}
    tr_tgt = {r["date"]: r for r in raw["H20269"]}
    p_bm = {r["date"]: r for r in raw["000985"]}
    tr_bm = {r["date"]: r for r in raw["H00985"]}

    common = sorted(set(p_tgt) & set(tr_tgt) & set(p_bm) & set(tr_bm))
    start_dt = dt.datetime.strptime(common[0], "%Y%m%d").date()
    daily_divs: list[tuple[dt.date, float]] = []
    prev_p: float | None = None
    prev_tr: float | None = None
    rows: list[dict[str, Any]] = []

    for d in common:
        dt_obj = dt.datetime.strptime(d, "%Y%m%d").date()
        if dt_obj.weekday() >= 5:
            continue
        idx = bisect.bisect_right(bond_keys, d) - 1
        if idx < 0:
            continue
        if (dt_obj - dt.datetime.strptime(bond_keys[idx], "%Y%m%d").date()).days > 16:
            continue
        b_val = float(bond[bond_keys[idx]])
        p_now = float(p_tgt[d]["close"])
        tr_now = float(tr_tgt[d]["close"])
        if prev_p is not None and prev_tr is not None:
            diff = (tr_now / prev_tr - 1.0) - (p_now / prev_p - 1.0)
            daily_divs.append((dt_obj, max(0.0, prev_p * diff)))
        prev_p, prev_tr = p_now, tr_now

        cutoff = dt_obj - dt.timedelta(days=365)
        ttm_div = (
            sum(pts for d_div, pts in daily_divs if d_div > cutoff)
            if (dt_obj - start_dt).days >= 365
            else None
        )
        implied_dy = (ttm_div / p_now * 100.0) if ttm_div is not None and ttm_div > 0 else None

        rows.append(
            {
                "date": d,
                "p_tgt": p_now,
                "tr_tgt": tr_now,
                "p_bm": float(p_bm[d]["close"]),
                "tr_bm": float(tr_bm[d]["close"]),
                "pe": p_tgt[d].get("pe") or tr_tgt[d].get("pe"),
                "dy": implied_dy,
                "bond": b_val,
            }
        )
    return rows


def ols_beta(tgt_rets: list[float], bm_rets: list[float], fallback: float = 0.4) -> tuple[float, float]:
    n = len(tgt_rets)
    mt = sum(tgt_rets) / n
    mb = sum(bm_rets) / n
    cov = sum((t - mt) * (b - mb) for t, b in zip(tgt_rets, bm_rets))
    vb = sum((b - mb) ** 2 for b in bm_rets)
    vt = sum((t - mt) ** 2 for t in tgt_rets)
    if vb <= 0 or vt <= 0:
        return fallback, 0.0
    beta = cov / vb
    r2 = (cov ** 2) / (vb * vt)
    return beta, r2


def pct_of_history(hist: list[float], val: float) -> float:
    return 100.0 * sum(1 for x in hist if x <= val) / len(hist)


def simulate_h30269(
    rows: list[dict[str, Any]],
    cfg: dict[str, Any],
    *,
    mode: str = "v3_2",
    init_core: float = 0.50,
    start_idx: int = 1215,
    fee: float = 0.0005,
    cash_annual: float = 0.018,
    etf_fee_annual: float = 0.002,
    rf_annual: float = 0.018,
) -> dict[str, Any]:
    is_v32 = mode == "v3_2"
    n = len(rows)
    tgt_sig = [r["tr_tgt"] if is_v32 else r["p_tgt"] for r in rows]
    bm_sig = [r["tr_bm"] if is_v32 else r["p_bm"] for r in rows]

    tgt_ret1 = [0.0] + [tgt_sig[i] / tgt_sig[i - 1] - 1.0 for i in range(1, n)]
    bm_ret1 = [0.0] + [bm_sig[i] / bm_sig[i - 1] - 1.0 for i in range(1, n)]

    core_eq = init_core
    tac_eq = 0.0
    cash = 1.0 - init_core - (init_core * fee if init_core > 0 else 0.0)

    curve: list[tuple[str, float]] = [(rows[start_idx]["date"], core_eq + tac_eq + cash)]
    exposures: list[float] = [(core_eq + tac_eq) / (core_eq + tac_eq + cash)]
    trades: list[dict[str, Any]] = []
    turnover = 0.0

    pe_hist = [float(rows[k]["pe"]) for k in range(start_idx) if rows[k]["pe"] is not None]

    rel_cfg = cfg["thresholds"]["relative"]
    bond_cfg = cfg["thresholds"]["bond"]
    val_cfg = cfg["thresholds"]["valuation_gate"]
    sell_cfg = cfg["thresholds"]["sell_confirmation"]
    ex_cfg = cfg["execution"]

    r2_ref = float(cfg["beta"]["shrinkage_r2_ref"]) if is_v32 else 0.0
    fallback_beta = float(cfg["beta"]["fallback"])
    win_defs = [
        (label, int(spec["trading_days"]))
        for label, spec in cfg["beta"]["windows"].items()
    ]
    neutral_spread = float(bond_cfg["neutral_spread_min"]) if is_v32 else 1.0
    neutral_mult = float(bond_cfg["neutral_multiple_min"]) if is_v32 else 1.5
    cooldown = int(ex_cfg["cooldown_trading_days"]) if is_v32 else 1
    heavy_cap = float(ex_cfg["heavy_position_pct"]) / 100.0
    core_cap = float(ex_cfg["core_cap_pct"]) / 100.0
    tac_cap = float(ex_cfg["tactical_cap_pct"]) / 100.0
    core_floor = float(ex_cfg["core_floor_pct"]) / 100.0
    reduce_step = float(ex_cfg["reduce_pct"]) / 100.0

    overheat_streak = 0
    last_buy_i = -9999
    last_sell_i = -9999
    may_july_buys = 0

    for i in range(start_idx + 1, n):
        # 1. Compound interval (i-1, i] on real H20269 total return + cash yield
        d0 = dt.datetime.strptime(rows[i - 1]["date"], "%Y%m%d").date()
        d1 = dt.datetime.strptime(rows[i]["date"], "%Y%m%d").date()
        cal_days = max(1, (d1 - d0).days)
        eq_ret = (rows[i]["tr_tgt"] / rows[i - 1]["tr_tgt"]) * ((1.0 - etf_fee_annual) ** (cal_days / 365.25)) - 1.0
        cash_ret = (1.0 + cash_annual) ** (cal_days / 365.25) - 1.0
        core_eq *= 1.0 + eq_ret
        tac_eq *= 1.0 + eq_ret
        cash *= 1.0 + cash_ret
        nav = core_eq + tac_eq + cash

        # 2. Evaluate signal known at close of i-1 (filled at close of i)
        s_idx = i - 1
        r_prev = rows[s_idx]
        t40 = tgt_sig[s_idx] / tgt_sig[s_idx - 40] - 1.0
        b40 = bm_sig[s_idx] / bm_sig[s_idx - 40] - 1.0

        betas: dict[str, float] = {}
        r2s: dict[str, float] = {}
        for nm, wlen in win_defs:
            b_val, r2_val = ols_beta(
                tgt_ret1[s_idx - wlen + 1 : s_idx + 1],
                bm_ret1[s_idx - wlen + 1 : s_idx + 1],
                fallback_beta,
            )
            betas[nm] = b_val
            r2s[nm] = r2_val

        adj: dict[str, float] = {}
        for nm, _ in win_defs:
            b_eff = betas[nm]
            if r2_ref > 0 and nm != "5y":
                lam = min(1.0, max(0.0, r2s[nm] / r2_ref))
                b_eff = lam * betas[nm] + (1.0 - lam) * betas["5y"]
            adj[nm] = (t40 - b_eff * b40) * 100.0

        primary_adj = adj["5y"]
        ma250 = sum(tgt_sig[s_idx - 249 : s_idx + 1]) / 250.0
        dist_ma250 = (tgt_sig[s_idx] / ma250 - 1.0) * 100.0

        dy = float(r_prev["dy"]) if r_prev["dy"] is not None else 4.5
        bond_y = float(r_prev["bond"])
        eb_spread = dy - bond_y
        eb_mult = dy / bond_y if bond_y > 0 else 0.0
        if eb_spread >= float(bond_cfg["strong_spread_min"]) or eb_mult >= float(bond_cfg["strong_multiple_min"]):
            support = "股债强支撑"
        elif eb_spread >= float(bond_cfg["support_spread_min"]) or eb_mult >= float(bond_cfg["support_multiple_min"]):
            support = "股债有支撑"
        elif eb_spread >= neutral_spread or eb_mult >= neutral_mult:
            support = "中性"
        else:
            support = "股债弱支撑"

        pe_pct = (
            pct_of_history(pe_hist, float(r_prev["pe"]))
            if (r_prev["pe"] is not None and len(pe_hist) >= int(val_cfg["min_observations"]))
            else None
        )
        if r_prev["pe"] is not None:
            pe_hist.append(float(r_prev["pe"]))

        robust_buy = all(v <= float(rel_cfg["buy_max"]) for v in adj.values())
        robust_overheat = all(v >= float(rel_cfg["strong_sell_min"]) for v in adj.values())

        if is_v32:
            day_overheat_ok = (
                robust_overheat
                and (t40 * 100.0 >= float(sell_cfg["target_40d_return_min"]))
                and (dist_ma250 >= float(sell_cfg["ma250_distance_min"]))
            )
        else:
            day_overheat_ok = adj["5y"] >= float(rel_cfg["strong_sell_min"])
        overheat_streak = (overheat_streak + 1) if day_overheat_ok else 0

        w_total = (core_eq + tac_eq) / nav
        w_tac = tac_eq / nav
        w_core = core_eq / nav

        move_frac = 0.0
        kind: str | None = None

        if primary_adj <= float(rel_cfg["buy_max"]) and robust_buy:
            support_ok = support in {"股债强支撑", "股债有支撑", "中性"}
            if is_v32 and pe_pct is not None:
                if pe_pct >= float(val_cfg["high_pe_percentile"]) and primary_adj > float(rel_cfg["strong_buy_max"]):
                    support_ok = False
            if support_ok and (i - last_buy_i >= cooldown):
                if is_v32:
                    if primary_adj <= float(rel_cfg["strong_buy_max"]):
                        req = float(ex_cfg["strong_buy_tranche_pct"]) / 100.0
                    elif primary_adj <= float(rel_cfg["add_max"]):
                        req = float(ex_cfg["add_tranche_pct"]) / 100.0
                    else:
                        req = float(ex_cfg["buy_tranche_pct"]) / 100.0
                else:
                    req = 0.20
                if w_total < heavy_cap - 1e-9:
                    avail = min(req, heavy_cap - w_total, 1.0 - w_total)
                    tac_add = min(avail, max(0.0, tac_cap - w_tac))
                    core_add = min(avail - tac_add, max(0.0, core_cap - w_core))
                    move_frac = tac_add + core_add
                    if move_frac > 0.005:
                        kind = "buy"

        elif (
            primary_adj >= float(rel_cfg["strong_sell_min"])
            and robust_overheat
            and (t40 * 100.0 >= float(sell_cfg["target_40d_return_min"]))
            and (dist_ma250 >= float(sell_cfg["ma250_distance_min"]))
            and overheat_streak >= int(cfg["confirmation"]["tactical_overheat_closes"])
        ):
            if i - last_sell_i >= cooldown:
                val_weak = support in {"中性", "股债弱支撑"} or (
                    is_v32 and pe_pct is not None and pe_pct >= float(val_cfg["core_review_pe_percentile"])
                )
                core_overheat = (
                    overheat_streak >= int(cfg["confirmation"]["core_overheat_closes"])
                    and dist_ma250 >= float(sell_cfg["core_ma250_distance_min"])
                    and val_weak
                )
                if is_v32:
                    if core_overheat:
                        tac_cut = min(reduce_step, w_tac)
                        core_cut = min(reduce_step - tac_cut, max(0.0, w_core - core_floor))
                        move_frac = -(tac_cut + core_cut)
                    else:
                        move_frac = -min(reduce_step, w_tac)
                else:
                    move_frac = -min(w_total * 0.05, w_tac)
                if move_frac < -0.005:
                    kind = "sell"

        if kind == "buy":
            target_total = w_total + move_frac
            notional = (target_total * nav - (core_eq + tac_eq)) / (1.0 + fee * target_total)
            comm = abs(notional) * fee
            new_nav = nav - comm
            tac_room = max(0.0, tac_cap * new_nav - tac_eq)
            to_tac = min(notional, tac_room)
            tac_eq += to_tac
            core_eq += notional - to_tac
            cash -= notional + comm
            turnover += abs(notional) / nav
            last_buy_i = i
            if int(rows[i]["date"][4:6]) in (5, 6, 7):
                may_july_buys += 1
            trades.append(
                {
                    "date": rows[i]["date"],
                    "kind": "buy",
                    "weight_before": round(w_total, 4),
                    "weight_after": round((core_eq + tac_eq) / new_nav, 4),
                    "signal_spread_pct": round(primary_adj, 4),
                }
            )
        elif kind == "sell":
            target_total = max(0.0, w_total + move_frac)
            notional = (target_total * nav - (core_eq + tac_eq)) / (1.0 - fee * target_total)
            comm = abs(notional) * fee
            sell_amt = -notional
            from_tac = min(sell_amt, tac_eq)
            tac_eq -= from_tac
            core_eq -= sell_amt - from_tac
            cash += sell_amt - comm
            turnover += sell_amt / nav
            last_sell_i = i
            post_nav = core_eq + tac_eq + cash
            trades.append(
                {
                    "date": rows[i]["date"],
                    "kind": "sell",
                    "weight_before": round(w_total, 4),
                    "weight_after": round((core_eq + tac_eq) / post_nav, 4),
                    "signal_spread_pct": round(primary_adj, 4),
                }
            )

        post_nav = core_eq + tac_eq + cash
        exposures.append((core_eq + tac_eq) / post_nav)
        curve.append((rows[i]["date"], post_nav))

    return {
        "curve": curve,
        "trades": trades,
        "exposures": exposures,
        "summary": summarize(curve, trades, exposures, turnover, may_july_buys, rf_annual),
    }


def summarize(
    curve: list[tuple[str, float]],
    trades: list[dict[str, Any]],
    exposures: list[float],
    turnover: float,
    may_july_buys: int,
    rf_annual: float = 0.018,
) -> dict[str, Any]:
    def segment(c: list[tuple[str, float]]) -> dict[str, Any]:
        vals = [v for _, v in c]
        d0 = dt.datetime.strptime(c[0][0], "%Y%m%d").date()
        d1 = dt.datetime.strptime(c[-1][0], "%Y%m%d").date()
        yrs = (d1 - d0).days / 365.25
        pk, mdd = vals[0], 0.0
        for v in vals:
            pk = max(pk, v)
            mdd = min(mdd, v / pk - 1.0)
        rf_d = (1.0 + rf_annual) ** (1.0 / 252.0) - 1.0
        rets = [vals[k] / vals[k - 1] - 1.0 for k in range(1, len(vals))]
        ex_rets = [r - rf_d for r in rets]
        m = sum(ex_rets) / len(ex_rets)
        sd = (sum((r - m) ** 2 for r in ex_rets) / len(ex_rets)) ** 0.5
        raw_m = sum(rets) / len(rets)
        raw_sd = (sum((r - raw_m) ** 2 for r in rets) / len(rets)) ** 0.5
        cagr = ((vals[-1] / vals[0]) ** (1.0 / yrs) - 1.0) * 100.0
        return {
            "start": c[0][0],
            "end": c[-1][0],
            "cagr_calendar_pct": round(cagr, 4),
            "max_drawdown_pct": round(mdd * 100.0, 4),
            "sharpe": round((m / sd) * (252 ** 0.5), 4) if sd > 0 else 0.0,
            "sharpe_zero_rf": round((raw_m / raw_sd) * (252 ** 0.5), 4) if raw_sd > 0 else 0.0,
            "end_nav": round(vals[-1], 6),
        }

    sp = next(i for i, (d, _) in enumerate(curve) if d >= "20220101")
    buys = sum(1 for t in trades if t["kind"] == "buy")
    sells = sum(1 for t in trades if t["kind"] == "sell")
    return {
        "full": segment(curve),
        "pre_2022": segment(curve[: sp + 1]),
        "post_2022": segment(curve[sp:]),
        "buys": buys,
        "sells": sells,
        "trades": len(trades),
        "may_july_ex_div_buys": may_july_buys,
        "avg_exposure_pct": round(sum(exposures) / len(exposures) * 100.0, 2),
        "turnover": round(turnover, 4),
    }


def passive_benchmarks(rows: list[dict[str, Any]], start_idx: int = 1215) -> dict[str, Any]:
    bh_curve = [(rows[start_idx]["date"], 1.0)]
    f70_eq, f70_cash = 0.70, 0.30 - 0.70 * 0.0005
    f70_curve = [(rows[start_idx]["date"], f70_eq + f70_cash)]
    for i in range(start_idx + 1, len(rows)):
        d0 = dt.datetime.strptime(rows[i - 1]["date"], "%Y%m%d").date()
        d1 = dt.datetime.strptime(rows[i]["date"], "%Y%m%d").date()
        cd = max(1, (d1 - d0).days)
        eq_r = (rows[i]["tr_tgt"] / rows[i - 1]["tr_tgt"]) * ((1.0 - 0.002) ** (cd / 365.25)) - 1.0
        ca_r = (1.018 ** (cd / 365.25)) - 1.0
        bh_curve.append((rows[i]["date"], bh_curve[-1][1] * (1.0 + eq_r)))
        f70_eq *= 1.0 + eq_r
        f70_cash *= 1.0 + ca_r
        f70_curve.append((rows[i]["date"], f70_eq + f70_cash))
    return {
        "buy_hold_100_h20269_net": summarize(bh_curve, [], [1.0] * len(bh_curve), 0.0, 0),
        "static_70_30_drift": summarize(f70_curve, [], [0.70] * len(f70_curve), 0.0, 0),
    }


def main() -> None:
    cfg = load_config()
    rows = load_dataset()
    start_idx = 1215
    benchmarks = passive_benchmarks(rows, start_idx=start_idx)
    v31_core50 = simulate_h30269(rows, cfg, mode="v3_1", init_core=0.50, start_idx=start_idx)["summary"]
    v32_core50 = simulate_h30269(rows, cfg, mode="v3_2", init_core=0.50, start_idx=start_idx)["summary"]
    v31_core0 = simulate_h30269(rows, cfg, mode="v3_1", init_core=0.0, start_idx=start_idx)["summary"]
    v32_core0 = simulate_h30269(rows, cfg, mode="v3_2", init_core=0.0, start_idx=start_idx)["summary"]

    report = {
        "model_version": cfg["model_version"],
        "sample": {
            "raw_start": rows[0]["date"],
            "backtest_start": rows[start_idx]["date"],
            "end": rows[-1]["date"],
            "trading_days": len(rows) - start_idx,
        },
        "accounting": {
            "equity_return_index": "H20269",
            "etf_fee_annual": 0.002,
            "cash_yield_annual": 0.018,
            "risk_free_annual": 0.018,
            "fee_one_way": 0.0005,
        },
        "starting_core_50pct": {
            "v3_1_legacy": v31_core50,
            "v3_2_upgraded": v32_core50,
        },
        "starting_cash_0pct": {
            "v3_1_legacy": v31_core0,
            "v3_2_upgraded": v32_core0,
        },
        "benchmarks": benchmarks,
    }
    out_dir = HERE / "reports"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "results.json"
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"H30269 Backtest ({rows[start_idx]['date']} -> {rows[-1]['date']}, {len(rows) - start_idx} days)")
    for label, s in [
        ("V3.1 Legacy (init 50% core)", v31_core50),
        ("V3.2 Upgraded (init 50% core)", v32_core50),
        ("V3.1 Legacy (init 0% cash)", v31_core0),
        ("V3.2 Upgraded (init 0% cash)", v32_core0),
        ("100% H20269 Buy&Hold (net)", benchmarks["buy_hold_100_h20269_net"]),
    ]:
        f = s["full"]
        print(
            f"  {label:<32} | CAGR={f['cagr_calendar_pct']:>6.2f}%  MDD={f['max_drawdown_pct']:>7.2f}%  "
            f"ExSharpe={f['sharpe']:>6.3f}  Buy={s['buys']:>2} (May-Jul:{s['may_july_ex_div_buys']:>2})  Sell={s['sells']:>2}"
        )


if __name__ == "__main__":
    main()
