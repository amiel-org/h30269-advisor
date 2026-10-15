# -*- coding: utf-8 -*-
"""HS300 decision model -- Python reference using the shared config.json.

Design rules (frozen, see config.json):
  * a signal uses the published daily observation, compared with a historical
    pool strictly preceding it (percentiles exclude the current observation);
  * the model emits a DISCRETE target exposure on a fixed grid;
  * signals are produced at day t close and filled at day t+1 close;
  * the account is tracked as equity + cash, so no-trade drift is realistic;
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
                       for x in raw["allocation"]["pe_ladder"]]
        gate = raw["allocation"]["erp_gate"]
        self.gate_lo, self.gate_hi = float(gate["lo"]), float(gate["hi"])
        self.grid = float(raw["allocation"]["grid"])
        ex = raw["execution"]
        self.deadband = float(ex["deadband"])
        self.fee = float(ex["fee_one_way"])
        self.cash_yield = float(ex["cash_yield"])
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


def erp_gate(erp_pct: float, lo: float, hi: float) -> float:
    """Continuous risk cap from the ERP percentile (high = cheap = generous)."""
    return max(0.0, min(1.0, (erp_pct - lo) / (hi - lo)))


def quantize_down(value: float, grid: float) -> float:
    """Round DOWN to the grid so the result can never exceed the gate."""
    if grid <= 0:
        return value
    steps = int(value / grid + 1e-9)
    return min(1.0, max(0.0, steps * grid))


def target_exposure(pe_pct: float, erp_pct: float, cfg: "Config") -> float:
    if not all(math.isfinite(x) for x in (pe_pct, erp_pct)):
        raise ValueError("invalid percentile")
    lad = ladder_exposure(pe_pct, cfg.ladder)
    gate = erp_gate(erp_pct, cfg.gate_lo, cfg.gate_hi)
    return quantize_down(min(lad, gate), cfg.grid)


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
                   pe_now: float, erp_now: float, cfg: "Config") -> dict:
    """Per-window exposure plus a consensus flag.  History excludes today."""
    per_window: dict = {}
    values: list[float] = []
    for spec in cfg.windows:
        pp = window_percentile(pe_hist, pe_now, spec)
        ep = window_percentile(erp_hist, erp_now, spec)
        if pp is None or ep is None:
            per_window[spec["name"]] = {
                "label": spec.get("label", spec["name"]),
                "pe_percentile": None, "erp_percentile": None, "exposure": None,
            }
            continue
        expo = target_exposure(pp, ep, cfg)
        values.append(expo)
        per_window[spec["name"]] = {
            "label": spec.get("label", spec["name"]),
            "pe_percentile": round(pp, 4),
            "erp_percentile": round(ep, 4),
            "exposure": expo,
        }
    # Tolerance rule: the three windows are rarely exactly equal in normal
    # markets (they only coincide at the extremes).  We therefore accept a
    # spread of up to `tolerance_steps` grid steps while still requiring
    # agreement, and take the CONSERVATIVE end of that cluster.
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
        "consensus_exposure": chosen,
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
        """Trade so the POST-fee weight equals `target`.

        Returns (signed_notional, traded_fraction_of_nav).
        """
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

    def grow(self, asset_return: float, cash_yield: float = 0.0) -> None:
        self.equity *= 1.0 + asset_return
        self.cash *= 1.0 + cash_yield


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


def build_signals(series: Series, cfg: "Config") -> list:
    """Consensus signal series: an exposure when all windows agree, else HOLD."""
    out = []
    pe_hist, erp_hist = [], []
    for i in range(len(series)):
        if len(pe_hist) < cfg.pe_min_obs or len(erp_hist) < cfg.erp_min_obs:
            out.append(None)
        else:
            info = window_targets(pe_hist, erp_hist, series.pe[i], series.spread[i], cfg)
            out.append(info["consensus_exposure"])
        pe_hist.append(series.pe[i])
        erp_hist.append(series.spread[i])
    return out


def build_signal_detail(series: Series, cfg: "Config") -> list:
    """Same as build_signals but keeps each window's numbers for the UI."""
    out = []
    pe_hist, erp_hist = [], []
    for i in range(len(series)):
        if len(pe_hist) < cfg.pe_min_obs or len(erp_hist) < cfg.erp_min_obs:
            out.append(None)
        else:
            out.append(window_targets(pe_hist, erp_hist, series.pe[i], series.spread[i], cfg))
        pe_hist.append(series.pe[i])
        erp_hist.append(series.spread[i])
    return out


# --------------------------------------------------------------------------- #
# execution state machine
# --------------------------------------------------------------------------- #
@dataclass
class Step:
    date: str
    nav_before: float
    weight_before: float
    intend_after: float   # pre-fee intended post-trade weight
    weight_after: float   # actual post-fee weight
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


def run_backtest(series: Series, cfg: "Config", signals=None, lag: int = 1) -> RunResult:
    """Signal at close of day t is FILLED at the close of day t+lag.

    Ordering matters: the return of interval (i-1, i] is earned with the weight
    that was already held entering day i; only then do we trade at day i's close.
    This makes it impossible for a freshly traded position to earn the return
    that had already elapsed before the fill.

        lag=1  realistic  : signal at t close -> fill at t+1 close
        lag=0  optimistic : signal at t close -> fill at t close (sensitivity only)
    """
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
        account.grow(series.tr[i] / series.tr[i - 1] - 1.0, cfg.cash_yield)

        # ---- (2) confirmation counting on the target known at close of day i ---- #
        src = i - lag
        desired = sig[src] if src >= first else None
        if desired == HOLD:
            # Windows disagree -> take no action at all.  The position is left
            # exactly where it is; no confirmation streak is carried over, so a
            # later agreement must confirm from scratch.
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
def metrics(curve: Sequence[tuple[str, float]], periods_per_year: int = 252) -> dict:
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
    mean = sum(rets) / len(rets) if rets else 0.0
    sd = (sum((r - mean) ** 2 for r in rets) / len(rets)) ** 0.5 if rets else 0.0
    return {
        "start": curve[0][0], "end": curve[-1][0],
        "years_calendar": round(years, 4),
        "cagr_calendar_pct": round(((values[-1] / values[0]) ** (1 / years) - 1) * 100, 4) if years > 0 else None,
        "cagr_252_pct": round(((values[-1] / values[0]) ** (periods_per_year / len(rets)) - 1) * 100, 4) if rets else None,
        "max_drawdown_pct": round(mdd * 100, 4),
        "sharpe": round(mean / sd * (periods_per_year ** 0.5), 4) if sd > 0 else None,
        "end_nav": round(values[-1], 6),
        "days": len(values),
    }
