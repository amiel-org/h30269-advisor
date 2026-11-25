# -*- coding: utf-8 -*-
"""Dual-sleeve unified equity pool allocator (HS300 v2.5 + H30269 V3.2).

Single source of truth mirrored byte-for-byte in cloudflare/lib/portfolio-model.js
and verified by cloudflare/portfolio-parity.mjs.
"""
from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG_PATH = HERE / "config.json"


def load_config(path: Path | None = None) -> dict[str, Any]:
    return json.loads((path or DEFAULT_CONFIG_PATH).read_text(encoding="utf-8-sig"))


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def compute_spillover_factors(
    hs300_pe_pct: float | None,
    hs300_exposure: float,
    h30269_pe_pct: float | None,
    h30269_adj_spread: float | None,
    h30269_overheat: bool,
    cfg: dict[str, Any],
) -> dict[str, float]:
    """Compute smooth [0, 1] idle-cash spillover eligibility factors without binary cliffs."""
    vt = cfg["valuation_taper"]

    # H30269 spillover factor: 0 if overheated/paused; linear taper from 70% to 85% PE pct
    if h30269_overheat or (
        h30269_adj_spread is not None
        and float(h30269_adj_spread) >= float(vt["h30269_overheat_spread_pct"])
    ):
        div_factor = 0.0
    elif h30269_pe_pct is None or not math.isfinite(float(h30269_pe_pct)):
        div_factor = 0.5
    else:
        lo = float(vt["h30269_pe_full_pct"])
        hi = float(vt["h30269_pe_zero_pct"])
        div_factor = _clamp((hi - float(h30269_pe_pct)) / max(1e-9, hi - lo), 0.0, 1.0)

    # HS300 spillover factor: 0 if standalone exposure < 25%; linear taper from 45% to 65% PE pct
    if hs300_exposure < float(vt["hs300_min_standalone_exposure"]) - 1e-12:
        hs_factor = 0.0
    elif hs300_pe_pct is None or not math.isfinite(float(hs300_pe_pct)):
        hs_factor = 0.5
    else:
        lo = float(vt["hs300_pe_full_pct"])
        hi = float(vt["hs300_pe_zero_pct"])
        hs_factor = _clamp((hi - float(hs300_pe_pct)) / max(1e-9, hi - lo), 0.0, 1.0)

    return {"hs300_factor": hs_factor, "h30269_factor": div_factor}


def compute_portfolio_targets(
    hs300_exposure: float,
    h30269_exposure: float,
    hs300_pe_pct: float | None,
    h30269_pe_pct: float | None,
    h30269_adj_spread: float | None,
    h30269_overheat: bool,
    cfg: dict[str, Any],
    *,
    spillover_override: float | None = None,
) -> dict[str, Any]:
    """Map standalone sleeve exposures [0, 1] into unified total-pool target weights."""
    base_hs = float(cfg["base_weights"]["hs300"])
    base_div = float(cfg["base_weights"]["h30269"])
    max_hs = float(cfg["max_sleeve_weights"]["hs300"])
    max_div = float(cfg["max_sleeve_weights"]["h30269"])
    max_total = float(cfg["max_total_equity"])
    spillover = float(cfg["spillover_ratio"]) if spillover_override is None else float(spillover_override)

    w_hs = _clamp(float(hs300_exposure), 0.0, 1.0)
    w_div = _clamp(float(h30269_exposure), 0.0, 1.0)

    idle_hs = base_hs * (1.0 - w_hs)
    idle_div = base_div * (1.0 - w_div)

    factors = compute_spillover_factors(
        hs300_pe_pct, w_hs, h30269_pe_pct, h30269_adj_spread, h30269_overheat, cfg
    )
    eff_hs_budget = min(max_hs, base_hs + spillover * factors["hs300_factor"] * idle_div)
    eff_div_budget = min(max_div, base_div + spillover * factors["h30269_factor"] * idle_hs)

    t_hs = eff_hs_budget * w_hs
    t_div = eff_div_budget * w_div
    raw_total = t_hs + t_div
    capped = raw_total > max_total + 1e-12
    if capped:
        scale = max_total / raw_total
        t_hs *= scale
        t_div *= scale

    total_equity = t_hs + t_div
    cash = max(0.0, 1.0 - total_equity)
    return {
        "hs300_target": t_hs,
        "h30269_target": t_div,
        "total_equity": total_equity,
        "cash_target": cash,
        "base_hs300_target": base_hs * w_hs,
        "base_h30269_target": base_div * w_div,
        "eff_hs300_budget": eff_hs_budget,
        "eff_h30269_budget": eff_div_budget,
        "idle_hs300": idle_hs,
        "idle_h30269": idle_div,
        "hs300_factor": factors["hs300_factor"],
        "h30269_factor": factors["h30269_factor"],
        "capped_by_total": capped,
    }


def classify_regime(
    hs300_pe_pct: float | None,
    h30269_pe_pct: float | None,
    h30269_overheat: bool,
    hs300_exposure: float,
    h30269_exposure: float,
) -> dict[str, str]:
    """Human-readable portfolio regime label for the dashboard."""
    hs_cheap = hs300_pe_pct is not None and hs300_pe_pct <= 45.0 and hs300_exposure >= 0.5
    hs_expensive = hs300_pe_pct is not None and hs300_pe_pct >= 65.0
    div_cheap = (not h30269_overheat) and (h30269_pe_pct is None or h30269_pe_pct < 70.0)
    div_expensive = h30269_overheat or (h30269_pe_pct is not None and h30269_pe_pct >= 80.0)

    if hs_cheap and div_cheap:
        return {
            "code": "dual_offense",
            "title": "双低积极配置",
            "summary": "沪深300与红利低波估值均处于偏低区间，总池可提升至高位（最高90%），保留10%现金底线。",
        }
    if hs_expensive and div_expensive:
        return {
            "code": "dual_defense",
            "title": "双高防守蓄水",
            "summary": "两侧估值均偏贵或过热，停止互相补位，优先守住利润并增加现金蓄水池。",
        }
    if hs_cheap and div_expensive:
        return {
            "code": "hs300_lead",
            "title": "宽基进攻主导",
            "summary": "沪深300更具赔率优势、红利低波偏贵或过热，红利闲置预算向沪深300倾斜补位。",
        }
    if (hs_expensive or hs300_exposure <= 0.25) and div_cheap:
        return {
            "code": "dividend_ballast",
            "title": "红利压舱补位",
            "summary": "沪深300仓位偏低或偏贵，闲置预算按估值系数平滑补位至红利低波吃息增厚收益。",
        }
    return {
        "code": "balanced",
        "title": "均衡互补持有",
        "summary": "双引擎处于中性区间，按50/50基础预算与平滑补位协同运行，仅超5%死区再动仓。",
    }


def run_portfolio_backtest(
    records: list[dict[str, Any]],
    cfg: dict[str, Any],
    *,
    spillover_override: float | None = None,
    no_cliff_override: bool | None = None,
    use_h30269_key: str = "h_exp50",
) -> dict[str, Any]:
    """Strict lag=1 no-lookahead two-sleeve + cash portfolio backtest."""
    if len(records) < 2:
        return {"curve": [], "trades": [], "w300": [], "wdiv": [], "turnover": 0.0, "summary": {}}

    reb = cfg["rebalance"]
    acct = cfg["accounting"]
    vt = cfg["valuation_taper"]
    max_hs = float(cfg["max_sleeve_weights"]["hs300"])
    max_div = float(cfg["max_sleeve_weights"]["h30269"])
    max_total = float(cfg["max_total_equity"])
    deadband = float(reb["deadband"])
    max_step = float(reb["max_step"])
    cooldown = int(reb["cooldown_trading_days"])
    no_cliff = bool(reb["no_cliff_sell"]) if no_cliff_override is None else bool(no_cliff_override)
    fee = float(acct["fee_one_way"])
    etf_fee = float(acct["etf_fee_annual"])
    cash_y = float(acct["cash_yield_annual"])
    rf_annual = float(acct["risk_free_annual"])

    def targets_for(rec: dict[str, Any]) -> dict[str, Any]:
        return compute_portfolio_targets(
            rec["hs_exp"],
            rec[use_h30269_key],
            rec["hs_pe_pct"],
            rec["h_pe_pct"],
            rec["h_adj_5y"],
            rec["h_robust_overheat"],
            cfg,
            spillover_override=spillover_override,
        )

    t0 = targets_for(records[0])
    hs_val = t0["hs300_target"]
    div_val = t0["h30269_target"]
    cash_val = 1.0 - hs_val - div_val - (hs_val + div_val) * fee
    init_nav = hs_val + div_val + cash_val

    curve: list[tuple[str, float]] = [(records[0]["date"], init_nav)]
    w300_list: list[float] = [hs_val / init_nav]
    wdiv_list: list[float] = [div_val / init_nav]
    trades: list[dict[str, Any]] = []
    turnover = hs_val + div_val
    last_trade_300 = -999
    last_trade_div = -999

    for i in range(1, len(records)):
        d0 = dt.datetime.strptime(records[i - 1]["date"], "%Y%m%d").date()
        d1 = dt.datetime.strptime(records[i]["date"], "%Y%m%d").date()
        cd = max(1, (d1 - d0).days)
        drag = (1.0 - etf_fee) ** (cd / 365.25)
        hs_val *= (records[i]["hs_tr"] / records[i - 1]["hs_tr"]) * drag
        div_val *= (records[i]["h_tr"] / records[i - 1]["h_tr"]) * drag
        cash_val *= (1.0 + cash_y) ** (cd / 365.25)
        nav = hs_val + div_val + cash_val

        r_prev = records[i - 1]
        tgt = targets_for(r_prev)
        t300 = tgt["hs300_target"]
        tdiv = tgt["h30269_target"]
        w300 = hs_val / nav
        wdiv = div_val / nav

        eff_t300 = t300
        eff_tdiv = tdiv
        if no_cliff:
            if (
                wdiv > tdiv
                and wdiv <= max_div
                and (not r_prev["h_robust_overheat"])
                and (w300 + wdiv <= max_total + deadband)
            ):
                eff_tdiv = min(wdiv, max(tdiv, min(max_div, r_prev[use_h30269_key] * max_div)))
                if i >= 2 and records[i - 1][use_h30269_key] < records[i - 2][use_h30269_key] - 0.01:
                    eff_tdiv = tdiv
            if (
                w300 > t300
                and w300 <= max_hs
                and r_prev["hs_pe_pct"] < float(vt["hs300_overheat_pe_pct"])
                and (w300 + wdiv <= max_total + deadband)
            ):
                if i >= 2 and records[i - 1]["hs_exp"] >= records[i - 2]["hs_exp"] - 0.01:
                    eff_t300 = w300

        d300 = eff_t300 - w300
        ddiv = eff_tdiv - wdiv

        m300 = d300 if (abs(d300) > deadband + 1e-12 and i - last_trade_300 >= cooldown) else 0.0
        mdiv = ddiv if (abs(ddiv) > deadband + 1e-12 and i - last_trade_div >= cooldown) else 0.0

        if m300 != 0.0:
            m300 = math.copysign(min(abs(m300), max_step), m300)
        if mdiv != 0.0:
            mdiv = math.copysign(min(abs(mdiv), max_step), mdiv)

        if m300 != 0.0 or mdiv != 0.0:
            new_w300 = max(0.0, w300 + m300)
            new_wdiv = max(0.0, wdiv + mdiv)
            if new_w300 + new_wdiv > max_total:
                sc = max_total / (new_w300 + new_wdiv)
                new_w300 *= sc
                new_wdiv *= sc
            n300 = new_w300 * nav - hs_val
            ndiv = new_wdiv * nav - div_val
            comm = (abs(n300) + abs(ndiv)) * fee
            hs_val += n300
            div_val += ndiv
            cash_val -= n300 + ndiv + comm
            step_to = (abs(n300) + abs(ndiv)) / nav
            turnover += step_to
            if abs(n300) / nav > 0.005:
                last_trade_300 = i
            if abs(ndiv) / nav > 0.005:
                last_trade_div = i
            post_nav_t = hs_val + div_val + cash_val
            trades.append(
                {
                    "date": records[i]["date"],
                    "hs300_before": round(w300, 4),
                    "hs300_after": round(hs_val / post_nav_t, 4),
                    "h30269_before": round(wdiv, 4),
                    "h30269_after": round(div_val / post_nav_t, 4),
                }
            )

        post_nav = hs_val + div_val + cash_val
        w300_list.append(hs_val / post_nav)
        wdiv_list.append(div_val / post_nav)
        curve.append((records[i]["date"], post_nav))

    return {
        "curve": curve,
        "trades": trades,
        "w300": w300_list,
        "wdiv": wdiv_list,
        "turnover": turnover,
        "summary": summarize_portfolio(curve, w300_list, wdiv_list, trades, turnover, rf_annual),
    }


def summarize_portfolio(
    curve: list[tuple[str, float]],
    w300_list: list[float],
    wdiv_list: list[float],
    trades: list[dict[str, Any]],
    turnover: float,
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
        ex = [r - rf_d for r in rets]
        m = sum(ex) / len(ex)
        sd = (sum((r - m) ** 2 for r in ex) / len(ex)) ** 0.5
        raw_m = sum(rets) / len(rets)
        raw_sd = (sum((r - raw_m) ** 2 for r in rets) / len(rets)) ** 0.5
        cagr = ((vals[-1] / vals[0]) ** (1.0 / yrs) - 1.0) * 100.0
        calmar = (cagr / 100.0) / abs(mdd) if mdd < 0 else 0.0
        return {
            "start": c[0][0],
            "end": c[-1][0],
            "cagr_calendar_pct": round(cagr, 4),
            "max_drawdown_pct": round(mdd * 100.0, 4),
            "sharpe": round((m / sd) * (252 ** 0.5), 4) if sd > 0 else 0.0,
            "sharpe_zero_rf": round((raw_m / raw_sd) * (252 ** 0.5), 4) if raw_sd > 0 else 0.0,
            "calmar": round(calmar, 4),
            "end_nav": round(vals[-1], 6),
        }

    sp = next((i for i, (d, _) in enumerate(curve) if d >= "20220101"), len(curve) // 2)
    avg_hs = sum(w300_list) / len(w300_list) * 100.0
    avg_div = sum(wdiv_list) / len(wdiv_list) * 100.0
    return {
        "full": segment(curve),
        "pre_2022": segment(curve[: sp + 1]),
        "post_2022": segment(curve[sp:]),
        "avg_hs300_pct": round(avg_hs, 2),
        "avg_h30269_pct": round(avg_div, 2),
        "avg_total_equity_pct": round(avg_hs + avg_div, 2),
        "trades": len(trades),
        "turnover": round(turnover, 4),
    }
