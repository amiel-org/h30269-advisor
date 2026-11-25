# -*- coding: utf-8 -*-
"""HS300 decision model -- Python reference using the shared config.json.

Design rules (v2.5, see config.json):
  * a signal uses the published daily observation, compared with a historical
    pool strictly preceding it (percentiles exclude the current observation);
  * per-window PE ladder and ERP gate apply symmetric percentile hysteresis
    to suppress boundary whipsaws without look-ahead;
  * the model emits a DISCRETE target exposure on a fixed grid;
  * signals are produced at day t close and filled at day t+1 close;
  * the account is tracked as equity + cash, pro-rating ETF annual drag and
    money-market cash yield over actual calendar days;
  * fees are charged on the actual traded notional and netted from NAV.

Nothing in this module may import network code.  It is pure and unit-testable.
"""
from __future__ import annotations

import datetime as dt
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = HERE / "config.json"


# --------------------------------------------------------------------------- #
# configuration
# --------------------------------------------------------------------------- #
class Config:
    def __init__(self, raw: dict):
        self.raw = raw
        self.version = raw["version"]
        self.pe_min_obs = int(raw["indicators"]["pe_percentile"]["min_obs"])
        self.erp_min_obs = int(raw["indicators"]["erp_percentile"]["min_obs"])
        alloc = raw["allocation"]
        self.tolerance_steps = int(alloc.get("tolerance_steps") or 0)
        self.tolerance_rule = alloc.get("tolerance_rule") or "conservative"
        self.windows = raw["indicators"].get("percentile_windows") or [
            {"name": "full", "label": "全历史", "mode": "expanding", "min_obs": 700}
        ]
        self.ladder = [(float(x["min_pct"]), float(x["exposure"]))
                       for x in alloc["pe_ladder"]]
        gate = alloc["erp_gate"]
        self.gate_lo, self.gate_hi = float(gate["lo"]), float(gate["hi"])
        self.grid = float(alloc["grid"])
        hyst = alloc.get("hysteresis") or {}
        self.pe_hysteresis = float(hyst.get("pe_percentile_pp") or 0.0)
        self.erp_hysteresis = float(hyst.get("erp_percentile_pp") or 0.0)
        ex = raw["execution"]
        self.deadband = float(ex["deadband"])
        self.fee = float(ex["fee_one_way"])
        self.cash_yield = float(ex.get("cash_yield") or 0.0)
        self.cash_yield_annual = float(ex.get("cash_yield_annual") or 0.0)
        self.etf_fee_annual = float(ex.get("etf_fee_annual") or 0.0)
        self.risk_free_annual = float(ex.get("risk_free_annual") or 0.0)
        self.step = float(ex["step_size"])
        self.buy_confirm = int(ex["buy_confirm_closes"])
        self.sell_confirm = int(ex["sell_confirm_closes"])

    @classmethod
    def load(cls, path=None) -> "Config":
        p = Path(path) if path else DEFAULT_CONFIG
        return cls(json.loads(p.read_text(encoding="utf-8")))


# --------------------------------------------------------------------------- #
# allocation rules
# --------------------------------------------------------------------------- #
def ladder_exposure(pe_pct: float, ladder: Sequence[tuple[float, float]]) -> float:
    """Largest exposure whose threshold the PE percentile still clears."""
    for min_pct, exposure in ladder:
        if pe_pct >= min_pct:
            return exposure
    return ladder[-1][1]


def ladder_with_hysteresis(pe_pct: float, ladder: Sequence[tuple[float, float]],
                           prev_exposure: float | None = None,
                           hysteresis_pp: float = 0.0) -> float:
    """Apply symmetric percentile hysteresis around PE ladder boundaries."""
    raw = ladder_exposure(pe_pct, ladder)
    if prev_exposure is None or hysteresis_pp <= 0.0 or abs(raw - prev_exposure) <= 1e-12:
        return raw
    if raw > prev_exposure:
        shifted = [(max(0.0, th - hysteresis_pp) if th > 0 else 0.0, exp)
                   for th, exp in ladder]
        return max(prev_exposure, ladder_exposure(pe_pct, shifted))
    shifted = [(min(100.0, th + hysteresis_pp) if th > 0 else 0.0, exp)
               for th, exp in ladder]
    return min(prev_exposure, ladder_exposure(pe_pct, shifted))


def erp_gate(erp_pct: float, lo: float, hi: float) -> float:
    """Continuous risk cap from the ERP percentile (high = cheap = generous)."""
    return max(0.0, min(1.0, (erp_pct - lo) / (hi - lo)))


def erp_gate_with_hysteresis(erp_pct: float, lo: float, hi: float,
                             prev_gate: float | None = None,
                             hysteresis_pp: float = 0.0) -> float:
    raw = erp_gate(erp_pct, lo, hi)
    if prev_gate is None or hysteresis_pp <= 0.0 or abs(raw - prev_gate) <= 1e-12:
        return raw
    if raw > prev_gate:
        return max(prev_gate, erp_gate(erp_pct - hysteresis_pp, lo, hi))
    return min(prev_gate, erp_gate(erp_pct + hysteresis_pp, lo, hi))


def quantize_down(value: float, grid: float) -> float:
    """Round DOWN to the grid so the result can never exceed the gate."""
    if grid <= 0:
        return value
    steps = int(value / grid + 1e-9)
    return min(1.0, max(0.0, steps * grid))


def target_exposure_stateful(pe_pct: float, erp_pct: float, cfg: "Config",
                             prev_state: dict | None = None) -> dict:
    if not all(math.isfinite(x) for x in (pe_pct, erp_pct)):
        raise ValueError("invalid percentile")
    prev_lad = prev_state.get("pe_cap") if prev_state else None
    prev_gate = prev_state.get("erp_cap") if prev_state else None
    lad = ladder_with_hysteresis(pe_pct, cfg.ladder, prev_lad, cfg.pe_hysteresis)
    gate = erp_gate_with_hysteresis(erp_pct, cfg.gate_lo, cfg.gate_hi, prev_gate, cfg.erp_hysteresis)
    expo = quantize_down(min(lad, gate), cfg.grid)
    return {"exposure": expo, "pe_cap": lad, "erp_cap": gate}


def target_exposure(pe_pct: float, erp_pct: float, cfg: "Config") -> float:
    return target_exposure_stateful(pe_pct, erp_pct, cfg, None)["exposure"]


def percentile_of_history(history: Sequence[float], current: float) -> float:
    """Percentile of `current` inside `history` (history must exclude current)."""
    if not history:
        raise ValueError("empty history")
    if not math.isfinite(current):
        raise ValueError("invalid percentile input")
    return 100.0 * sum(x <= current for x in history) / len(history)


# Sentinel meaning "windows disagree -> keep the current position".
HOLD = "HOLD"


def window_slice(history: Sequence[float], spec: dict) -> Sequence[float]:
    """Return the sub-history a window spec refers to (still excluding today)."""
    if spec.get("mode") == "rolling":
        days = int(spec.get("days") or 0)
        return history[-days:] if days > 0 else history
    return history


def window_percentile(history: Sequence[float], current: float, spec: dict) -> float | None:
    pool = window_slice(history, spec)
    need = int(spec.get("min_obs") or 1)
    if len(pool) < need:
        return None
    return percentile_of_history(pool, current)


def window_targets(pe_hist: Sequence[float], erp_hist: Sequence[float],
                   pe_now: float, erp_now: float, cfg: "Config",
                   prev_states: dict | None = None) -> dict:
    """Per-window exposure plus consensus metadata. History excludes today."""
    per_window: dict = {}
    next_states: dict = {}
    values: list[float] = []
    for spec in cfg.windows:
        name = spec["name"]
        pp = window_percentile(pe_hist, pe_now, spec)
        ep = window_percentile(erp_hist, erp_now, spec)
        if pp is None or ep is None:
            per_window[name] = {
                "label": spec.get("label", name),
                "pe_percentile": None, "erp_percentile": None,
                "exposure": None, "pe_cap": None, "erp_cap": None,
            }
            next_states[name] = prev_states.get(name) if prev_states else None
            continue
        st = target_exposure_stateful(pp, ep, cfg, prev_states.get(name) if prev_states else None)
        expo = st["exposure"]
        values.append(expo)
        next_states[name] = {"pe_cap": st["pe_cap"], "erp_cap": st["erp_cap"]}
        per_window[name] = {
            "label": spec.get("label", name),
            "pe_percentile": round(pp, 4),
            "erp_percentile": round(ep, 4),
            "exposure": expo,
            "pe_cap": st["pe_cap"],
            "erp_cap": round(st["erp_cap"], 6),
        }
    tol = cfg.tolerance_steps * cfg.grid
    span = (max(values) - min(values)) if values else None
    within = len(values) == len(cfg.windows) and bool(values) and span <= tol + 1e-9
    if within:
        chosen = min(values) if cfg.tolerance_rule == "conservative" else values[0]
    else:
        chosen = HOLD
    return {
        "windows": per_window,
        "agreed": within,
        "span": span,
        "tolerance": tol,
        "vote": min(values) if values else None,
        "min_exposure": min(values) if values else None,
        "max_exposure": max(values) if values else None,
        "consensus_exposure": chosen,
        "next_state": next_states,
    }


# --------------------------------------------------------------------------- #
# account arithmetic
# --------------------------------------------------------------------------- #
@dataclass
class Account:
    equity: float = 0.0
    cash: float = 1.0

    @property
    def nav(self) -> float:
        return self.equity + self.cash

    @property
    def weight(self) -> float:
        return self.equity / self.nav if self.nav else 0.0

    def rebalance_to(self, target: float, fee: float) -> tuple[float, float]:
        """Trade so the POST-fee weight equals `target`."""
        nav = self.nav
        if nav <= 0:
            return 0.0, 0.0
        if target * nav >= self.equity:
            notional = (target * nav - self.equity) / (1 + fee * target)
        else:
            notional = (target * nav - self.equity) / (1 - fee * target)
        commission = abs(notional) * fee
        self.equity += notional
        self.cash -= notional + commission
        if self.cash < -1e-9 or self.equity < -1e-9:
            raise AssertionError("account went negative")
        return notional, abs(notional) / nav

    def grow(self, asset_return: float, cash_return: float = 0.0) -> None:
        self.equity *= 1.0 + asset_return
        self.cash *= 1.0 + cash_return


# --------------------------------------------------------------------------- #
# aligned series + signals
# --------------------------------------------------------------------------- #
@dataclass
class Series:
    dates: list[str]
    tr: list[float]      # total-return index level
    pe: list[float]
    spread: list[float]  # 100/PE - bond_yield_pct

    def __len__(self) -> int:
        return len(self.dates)


def build_signal_detail(series: Series, cfg: "Config") -> list:
    """Walk the series without look-ahead, tracking per-window hysteresis state."""
    out = []
    pe_hist, erp_hist = [], []
    win_state: dict | None = None
    for i in range(len(series)):
        if len(pe_hist) < cfg.pe_min_obs or len(erp_hist) < cfg.erp_min_obs:
            out.append(None)
        else:
            info = window_targets(pe_hist, erp_hist, series.pe[i], series.spread[i], cfg, win_state)
            info["prev_state"] = win_state
            win_state = info["next_state"]
            out.append(info)
        pe_hist.append(series.pe[i])
        erp_hist.append(series.spread[i])
    return out


def build_signals(series: Series, cfg: "Config") -> list:
    """Consensus signal series: an exposure when all windows agree, else HOLD."""
    return [row["consensus_exposure"] if row is not None else None
            for row in build_signal_detail(series, cfg)]


def window_state_at(series: Series, end_exclusive: int, cfg: "Config") -> dict | None:
    """Return the per-window hysteresis state entering index `end_exclusive`."""
    pe_hist, erp_hist = [], []
    win_state: dict | None = None
    limit = min(max(0, end_exclusive), len(series))
    for i in range(limit):
        if len(pe_hist) >= cfg.pe_min_obs and len(erp_hist) >= cfg.erp_min_obs:
            info = window_targets(pe_hist, erp_hist, series.pe[i], series.spread[i], cfg, win_state)
            win_state = info["next_state"]
        pe_hist.append(series.pe[i])
        erp_hist.append(series.spread[i])
    return win_state


# --------------------------------------------------------------------------- #
# execution state machine
# --------------------------------------------------------------------------- #
@dataclass
class Step:
    date: str
    nav_before: float
    weight_before: float
    intend_after: float
    weight_after: float
    traded_fraction: float
    target: float
    streak: int
    kind: str


@dataclass
class RunResult:
    curve: list = field(default_factory=list)
    steps: list = field(default_factory=list)
    exposures: list = field(default_factory=list)
    turnover: float = 0.0
    blocked_days: int = 0


def _calendar_days(d0_compact: str, d1_compact: str) -> int:
    d0 = dt.datetime.strptime(d0_compact, "%Y%m%d").date()
    d1 = dt.datetime.strptime(d1_compact, "%Y%m%d").date()
    return max(1, (d1 - d0).days)


def interval_returns(tr_prev: float, tr_curr: float, cal_days: int, cfg: "Config") -> tuple[float, float]:
    raw_eq = tr_curr / tr_prev - 1.0
    etf_drag = (1.0 - cfg.etf_fee_annual) ** (cal_days / 365.25) if cfg.etf_fee_annual > 0 else 1.0
    net_eq = (1.0 + raw_eq) * etf_drag - 1.0
    if cfg.cash_yield_annual > 0:
        cash_ret = (1.0 + cfg.cash_yield_annual) ** (cal_days / 365.25) - 1.0
    else:
        cash_ret = cfg.cash_yield
    return net_eq, cash_ret


def run_backtest(series: Series, cfg: "Config", signals=None, lag: int = 1) -> RunResult:
    """Signal at close of day t is FILLED at the close of day t+lag."""
    sig = signals if signals is not None else build_signals(series, cfg)
    n = len(series)
    first = next((i for i, s in enumerate(sig) if s is not None), None)
    if first is None or first + 1 >= n:
        return RunResult()

    account = Account()
    result = RunResult(curve=[(series.dates[first], 1.0)], exposures=[0.0])
    prev_target, streak = None, 0

    for i in range(first + 1, n):
        # ---- (1) earn the interval (i-1, i] with the weight held entering it ---- #
        cal_days = _calendar_days(series.dates[i - 1], series.dates[i])
        eq_ret, cash_ret = interval_returns(series.tr[i - 1], series.tr[i], cal_days, cfg)
        account.grow(eq_ret, cash_ret)

        # ---- (2) confirmation counting on the target known at close of day i ---- #
        src = i - lag
        desired = sig[src] if src >= first else None
        if desired == HOLD:
            desired = None
        if desired is None:
            prev_target, streak = None, 0
        elif desired == prev_target:
            streak += 1
        else:
            prev_target, streak = desired, 1

        # ---- (3) fill at close of day i (affects interval (i, i+1]) ---- #
        if prev_target is not None:
            gap = prev_target - account.weight
            needed = cfg.sell_confirm if gap < 0 else cfg.buy_confirm
            if streak >= needed and abs(gap) > cfg.deadband + 1e-9:
                nav_before = account.nav
                weight_before = account.weight
                move = cfg.step if gap > 0 else -cfg.step
                intend = weight_before + (move if abs(gap) > cfg.step else gap)
                intend = max(0.0, min(1.0, intend))
                _, traded = account.rebalance_to(intend, cfg.fee)
                result.turnover += traded
                result.steps.append(Step(
                    date=series.dates[i], nav_before=nav_before,
                    weight_before=weight_before, intend_after=intend,
                    weight_after=account.weight, traded_fraction=traded,
                    target=prev_target, streak=streak,
                    kind="buy" if intend > weight_before else "sell",
                ))
            elif streak >= needed:
                result.blocked_days += 1

        result.exposures.append(account.weight)
        result.curve.append((series.dates[i], account.nav))
    return result


# --------------------------------------------------------------------------- #
# metrics
# --------------------------------------------------------------------------- #
def metrics(curve: Sequence[tuple[str, float]], periods_per_year: int = 252,
            risk_free_annual: float = 0.0) -> dict:
    if not curve:
        return {}
    values = [v for _, v in curve]
    d0 = dt.datetime.strptime(curve[0][0], "%Y%m%d").date()
    d1 = dt.datetime.strptime(curve[-1][0], "%Y%m%d").date()
    years = (d1 - d0).days / 365.25
    peak, mdd = values[0], 0.0
    for v in values:
        peak = max(peak, v)
        mdd = min(mdd, v / peak - 1.0)
    rets = [values[i] / values[i - 1] - 1.0 for i in range(1, len(values))]
    rf_daily = (1.0 + risk_free_annual) ** (1.0 / periods_per_year) - 1.0 if risk_free_annual > 0 else 0.0
    ex_rets = [r - rf_daily for r in rets]
    mean = sum(ex_rets) / len(ex_rets) if ex_rets else 0.0
    sd = (sum((r - mean) ** 2 for r in ex_rets) / len(ex_rets)) ** 0.5 if ex_rets else 0.0
    raw_mean = sum(rets) / len(rets) if rets else 0.0
    raw_sd = (sum((r - raw_mean) ** 2 for r in rets) / len(rets)) ** 0.5 if rets else 0.0
    return {
        "start": curve[0][0], "end": curve[-1][0],
        "years_calendar": round(years, 4),
        "cagr_calendar_pct": round(((values[-1] / values[0]) ** (1 / years) - 1) * 100, 4) if years > 0 else None,
        "cagr_252_pct": round(((values[-1] / values[0]) ** (periods_per_year / len(rets)) - 1) * 100, 4) if rets else None,
        "max_drawdown_pct": round(mdd * 100, 4),
        "sharpe": round(mean / sd * (periods_per_year ** 0.5), 4) if sd > 0 else None,
        "sharpe_zero_rf": round(raw_mean / raw_sd * (periods_per_year ** 0.5), 4) if raw_sd > 0 else None,
        "end_nav": round(values[-1], 6),
        "days": len(values),
    }
