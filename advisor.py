#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""H30269 red-dividend low-volatility V3.1 decision assistant.

The program fetches market/fundamental data, validates freshness, computes the
V3.1 signals, and writes Chinese Markdown/JSON reports. It never places orders.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


APP_DIR = (
    Path(sys.executable).resolve().parent
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parent
)
DEFAULT_CONFIG = APP_DIR / "config.json"
CSI_BASE = "https://www.csindex.com.cn/csindex-home"
CHINABOND_URL = (
    "https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery"
)
DANJUAN_URL = (
    "https://danjuanfunds.com/djapi/index_eva/detail/CSIH30269"
)


class DataError(RuntimeError):
    pass


@dataclass
class SourceValue:
    value: float | None
    as_of: str | None
    source: str
    source_url: str
    status: str = "live"


@dataclass
class SeriesBundle:
    code: str
    rows: list[dict[str, Any]]
    source: str
    source_url: str
    fetched_at: str
    quote_status: str
    cache_status: str = "live"


def make_session() -> requests.Session:
    retry = Retry(
        total=3,
        connect=3,
        read=3,
        status=3,
        backoff_factor=0.7,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET"}),
        raise_on_status=False,
    )
    session = requests.Session()
    session.mount("https://", HTTPAdapter(max_retries=retry))
    session.headers.update(
        {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 Chrome/124 Safari/537.36"
            ),
            "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
        }
    )
    return session


def load_config(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def atomic_json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def cache_path(code: str) -> Path:
    return APP_DIR / "cache" / f"{code}.json"


def source_cache_path(name: str) -> Path:
    return APP_DIR / "cache" / f"{name}.json"


def save_source_cache(name: str, value: SourceValue) -> None:
    atomic_json_write(source_cache_path(name), asdict(value))


def load_source_cache(name: str, max_age_days: int) -> SourceValue:
    path = source_cache_path(name)
    if not path.exists():
        raise DataError(f"{name}没有本地缓存")
    value = SourceValue(**json.loads(path.read_text(encoding="utf-8-sig")))
    age = _days_old(value.as_of)
    if age is None or age > max_age_days:
        raise DataError(f"{name}缓存日期过旧：{value.as_of}")
    value.status = "cache"
    value.source = "离线缓存：" + value.source
    return value


def _get_json(
    session: requests.Session,
    url: str,
    *,
    params: dict[str, Any] | None = None,
    referer: str | None = None,
    timeout: float = 30,
) -> dict[str, Any]:
    headers = {"Referer": referer} if referer else None
    response = session.get(url, params=params, headers=headers, timeout=timeout)
    response.raise_for_status()
    try:
        data = response.json()
    except Exception as exc:
        raise DataError(f"接口未返回JSON: {url}: {exc}") from exc
    return data


def _normalize_csi_rows(items: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    for item in items:
        raw_date = str(item.get("tradeDate") or "")
        close = item.get("close")
        if len(raw_date) != 8 or close in (None, 0):
            continue
        day = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}"
        rows[day] = {
            "date": day,
            "open": float(item.get("open") or close),
            "high": float(item.get("high") or close),
            "low": float(item.get("low") or close),
            "close": float(close),
        }
    return [rows[key] for key in sorted(rows)]


def fetch_csi_series(
    session: requests.Session,
    code: str,
    history_days: int,
    use_intraday: bool,
) -> SeriesBundle:
    today = date.today()
    start = today - timedelta(days=history_days)
    history_url = f"{CSI_BASE}/perf/index-perf"
    detail_url = (
        f"https://www.csindex.com.cn/zh-CN/indices/index-detail/{code}"
    )
    payload = _get_json(
        session,
        history_url,
        params={
            "indexCode": code,
            "startDate": start.strftime("%Y%m%d"),
            "endDate": today.strftime("%Y%m%d"),
        },
        referer=detail_url,
    )
    if str(payload.get("code")) != "200":
        raise DataError(f"中证历史行情失败 {code}: {payload.get('msg')}")
    rows = _normalize_csi_rows(payload.get("data") or [])
    if len(rows) < 260:
        raise DataError(f"中证历史行情不足 {code}: 仅{len(rows)}条")

    quote_status = "历史收盘"
    if use_intraday:
        quote_url = f"{CSI_BASE}/perf/index-perf-oneday"
        quote_payload = _get_json(
            session,
            quote_url,
            params={"indexCode": code},
            referer=detail_url,
        )
        header = ((quote_payload.get("data") or {}).get("intraDayHeader") or {})
        raw_date = str(header.get("tradeDate") or "")
        current = header.get("current")
        if len(raw_date) == 10:
            quote_day = raw_date
        elif len(raw_date) == 8:
            quote_day = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}"
        else:
            quote_day = ""
        trade_time = str(header.get("tradeTime") or "")
        if quote_day and current not in (None, 0):
            current_row = {
                "date": quote_day,
                "open": float(header.get("openToday") or current),
                "high": float(header.get("current") or current),
                "low": float(header.get("current") or current),
                "close": float(current),
            }
            by_date = {row["date"]: row for row in rows}
            if quote_day in by_date:
                by_date[quote_day]["close"] = float(current)
            else:
                by_date[quote_day] = current_row
            rows = [by_date[key] for key in sorted(by_date)]
            quote_status = "收盘后" if trade_time >= "15:05:00" else "盘中"

    bundle = SeriesBundle(
        code=code,
        rows=rows,
        source="中证指数有限公司",
        source_url=history_url,
        fetched_at=datetime.now().isoformat(timespec="seconds"),
        quote_status=quote_status,
    )
    atomic_json_write(cache_path(code), asdict(bundle))
    return bundle


def load_cached_series(code: str, max_age_days: int) -> SeriesBundle:
    path = cache_path(code)
    if not path.exists():
        raise DataError(f"{code} 在线抓取失败且没有本地缓存")
    raw = json.loads(path.read_text(encoding="utf-8-sig"))
    fetched_at = datetime.fromisoformat(raw["fetched_at"])
    age = datetime.now() - fetched_at
    if age > timedelta(days=max_age_days):
        raise DataError(
            f"{code} 在线抓取失败，缓存已超过{max_age_days}天，拒绝给出交易动作"
        )
    raw["cache_status"] = "cache"
    return SeriesBundle(**raw)


def get_series(
    session: requests.Session,
    code: str,
    config: dict[str, Any],
    offline: bool,
) -> tuple[SeriesBundle, str | None]:
    if offline:
        return (
            load_cached_series(code, config["cache_max_age_days"]),
            f"{code}使用离线缓存",
        )
    try:
        bundle = fetch_csi_series(
            session,
            code,
            config["history_calendar_days"],
            config["use_intraday"],
        )
        return bundle, None
    except Exception as exc:
        bundle = load_cached_series(code, config["cache_max_age_days"])
        return bundle, f"{code} 在线抓取失败，使用缓存：{exc}"


def fetch_dividend_yield(
    session: requests.Session,
    config: dict[str, Any],
    override: float | None,
) -> SourceValue:
    if override is not None:
        return SourceValue(
            value=override,
            as_of=date.today().isoformat(),
            source="命令行覆盖值",
            source_url="local://override",
            status="override",
        )
    try:
        payload = _get_json(
            session,
            DANJUAN_URL,
            referer="https://danjuanfunds.com/",
            timeout=20,
        )
        data = payload.get("data") or {}
        raw_yield = data.get("yeild")
        if raw_yield in (None, 0):
            raise DataError("蛋卷接口没有返回yeild字段")
        ts = data.get("ts")
        as_of = (
            datetime.fromtimestamp(float(ts) / 1000).date().isoformat()
            if ts
            else None
        )
        result = SourceValue(
            value=float(raw_yield) * 100,
            as_of=as_of,
            source="蛋卷基金公开指数估值接口",
            source_url=DANJUAN_URL,
        )
        save_source_cache("dividend_yield", result)
        return result
    except Exception as exc:
        fallback = config.get("fallbacks", {}).get("dividend_yield", {})
        if not fallback:
            return SourceValue(
                value=None,
                as_of=None,
                source=f"抓取失败：{exc}",
                source_url=DANJUAN_URL,
                status="missing",
            )
        return SourceValue(
            value=float(fallback["value_pct"]),
            as_of=fallback["as_of"],
            source=f"本地带日期备用值；在线失败：{exc}",
            source_url=fallback.get("source_url", "local://config"),
            status="fallback",
        )


def fetch_bond_10y(
    session: requests.Session,
    config: dict[str, Any],
    override: float | None,
) -> SourceValue:
    if override is not None:
        return SourceValue(
            value=override,
            as_of=date.today().isoformat(),
            source="命令行覆盖值",
            source_url="local://override",
            status="override",
        )
    try:
        today = date.today()
        response = session.get(
            CHINABOND_URL,
            params={
                "startDate": (today - timedelta(days=21)).isoformat(),
                "endDate": today.isoformat(),
                "gjqx": "0",
                "qxId": "ycqx",
                "locale": "cn_ZH",
            },
            timeout=30,
        )
        response.raise_for_status()
        soup = BeautifulSoup(response.text.replace("&nbsp", ""), "html.parser")
        values: list[tuple[str, float]] = []
        for row in soup.select("table tr"):
            cells = [cell.get_text(" ", strip=True) for cell in row.find_all(["td", "th"])]
            if len(cells) < 10 or cells[0] != "中债国债收益率曲线":
                continue
            try:
                values.append((cells[1], float(cells[8])))
            except (ValueError, IndexError):
                continue
        if not values:
            raise DataError("中债页面没有解析到10年国债收益率")
        as_of, value = sorted(values, key=lambda item: item[0])[-1]
        result = SourceValue(
            value=value,
            as_of=as_of,
            source="中国债券信息网：中债国债收益率曲线",
            source_url=CHINABOND_URL,
        )
        save_source_cache("bond_10y", result)
        return result
    except Exception as exc:
        fallback = config.get("fallbacks", {}).get("bond_10y", {})
        if not fallback:
            return SourceValue(
                value=None,
                as_of=None,
                source=f"抓取失败：{exc}",
                source_url=CHINABOND_URL,
                status="missing",
            )
        return SourceValue(
            value=float(fallback["value_pct"]),
            as_of=fallback["as_of"],
            source=f"本地带日期备用值；在线失败：{exc}",
            source_url=fallback.get("source_url", "local://config"),
            status="fallback",
        )


def mean(values: list[float]) -> float:
    return sum(values) / len(values)


def relative_zone(relative_pct: float, thresholds: dict[str, float]) -> str:
    if relative_pct <= thresholds["strong_buy_max"]:
        return "强买"
    if relative_pct <= thresholds["add_max"]:
        return "加仓"
    if relative_pct <= thresholds["buy_max"]:
        return "买入"
    if relative_pct < thresholds["hold_min"]:
        return "观察"
    if relative_pct < thresholds["reduce_min"]:
        return "持有"
    if relative_pct < thresholds["strong_sell_min"]:
        return "相对偏热"
    return "相对过热"


def estimate_beta(
    target_rows: list[dict[str, Any]],
    benchmark_rows: list[dict[str, Any]],
    end_index: int,
    window: int,
    minimum_observations: int,
    fallback: float,
) -> dict[str, Any]:
    """Estimate rolling daily beta and expose the uncertainty around it."""
    start = max(1, end_index - window + 1)
    target_returns: list[float] = []
    benchmark_returns: list[float] = []
    for index in range(start, end_index + 1):
        target_returns.append(
            float(target_rows[index]["close"])
            / float(target_rows[index - 1]["close"])
            - 1
        )
        benchmark_returns.append(
            float(benchmark_rows[index]["close"])
            / float(benchmark_rows[index - 1]["close"])
            - 1
        )

    observations = len(target_returns)
    if observations < minimum_observations:
        return {
            "beta": fallback,
            "observations": observations,
            "window": window,
            "source": "fallback-insufficient",
            "sufficient": False,
            "correlation": None,
            "r2": None,
            "standard_error": None,
            "ci95_low": None,
            "ci95_high": None,
        }

    target_mean = mean(target_returns)
    benchmark_mean = mean(benchmark_returns)
    covariance = sum(
        (target_return - target_mean) * (benchmark_return - benchmark_mean)
        for target_return, benchmark_return in zip(
            target_returns, benchmark_returns
        )
    )
    benchmark_variance = sum(
        (benchmark_return - benchmark_mean) ** 2
        for benchmark_return in benchmark_returns
    )
    target_variance = sum(
        (target_return - target_mean) ** 2
        for target_return in target_returns
    )
    if benchmark_variance == 0:
        return {
            "beta": fallback,
            "observations": observations,
            "window": window,
            "source": "fallback-zero-variance",
            "sufficient": False,
            "correlation": None,
            "r2": None,
            "standard_error": None,
            "ci95_low": None,
            "ci95_high": None,
        }

    beta = covariance / benchmark_variance
    alpha = target_mean - beta * benchmark_mean
    residual_sum = sum(
        (
            target_return
            - alpha
            - beta * benchmark_return
        )
        ** 2
        for target_return, benchmark_return in zip(
            target_returns, benchmark_returns
        )
    )
    correlation = (
        covariance / math.sqrt(benchmark_variance * target_variance)
        if target_variance > 0
        else None
    )
    standard_error = (
        math.sqrt(
            residual_sum
            / max(1, observations - 2)
            / benchmark_variance
        )
        if observations > 2
        else None
    )
    return {
        "beta": beta,
        "observations": observations,
        "window": window,
        "source": "rolling-full" if observations >= window else "rolling-partial",
        "sufficient": True,
        "correlation": correlation,
        "r2": correlation**2 if correlation is not None else None,
        "standard_error": standard_error,
        "ci95_low": beta - 1.96 * standard_error if standard_error is not None else None,
        "ci95_high": beta + 1.96 * standard_error if standard_error is not None else None,
    }


def signal_group(relative_pct: float, thresholds: dict[str, float]) -> str:
    if relative_pct <= thresholds["buy_max"]:
        return "buy"
    if relative_pct < thresholds["reduce_min"]:
        return "hold"
    if relative_pct < thresholds["strong_sell_min"]:
        return "pause_add"
    return "overheat"


def compute_beta_snapshot(
    target_rows: list[dict[str, Any]],
    benchmark_rows: list[dict[str, Any]],
    target_return40: float,
    benchmark_return40: float,
    quote_status: str,
    config: dict[str, Any],
) -> dict[str, Any]:
    beta_config = config["beta"]
    thresholds = config["thresholds"]["relative"]
    completed_end = len(target_rows) - (2 if quote_status == "盘中" else 1)
    windows: dict[str, dict[str, Any]] = {}
    for label, definition in beta_config["windows"].items():
        estimate = estimate_beta(
            target_rows,
            benchmark_rows,
            completed_end,
            int(definition["trading_days"]),
            int(definition["minimum_observations"]),
            float(beta_config["fallback"]),
        )
        adjusted = target_return40 - estimate["beta"] * benchmark_return40
        windows[label] = {
            **estimate,
            "adjusted_spread_pct": adjusted * 100,
            "zone": relative_zone(adjusted * 100, thresholds),
            "group": signal_group(adjusted * 100, thresholds),
        }

    primary_label = str(beta_config["primary_window"])
    primary = windows[primary_label]
    if not primary["sufficient"]:
        usable = [
            (label, value)
            for label, value in windows.items()
            if value["sufficient"]
        ]
        if usable:
            primary_label, primary = usable[-1]

    usable_windows = [value for value in windows.values() if value["sufficient"]]
    adjusted_values = [value["adjusted_spread_pct"] for value in usable_windows]
    groups = {value["group"] for value in usable_windows}
    consensus = len(usable_windows) >= 2 and len(groups) == 1
    robust_buy = bool(usable_windows) and all(
        value <= thresholds["buy_max"] for value in adjusted_values
    )
    robust_overheat = bool(usable_windows) and all(
        value >= thresholds["strong_sell_min"] for value in adjusted_values
    )
    if not usable_windows:
        reliability = "样本不足"
    elif consensus:
        reliability = "窗口一致"
    else:
        reliability = "窗口分歧"

    return {
        "primary_window": primary_label,
        "primary": primary,
        "windows": windows,
        "band_low_pct": min(adjusted_values) if adjusted_values else None,
        "band_high_pct": max(adjusted_values) if adjusted_values else None,
        "beta_low": min(value["beta"] for value in usable_windows)
        if usable_windows
        else None,
        "beta_high": max(value["beta"] for value in usable_windows)
        if usable_windows
        else None,
        "consensus": consensus,
        "robust_buy": robust_buy,
        "robust_overheat": robust_overheat,
        "reliability": reliability,
        "note": "Beta只校正市场敏感度，不单独触发交易",
    }


def compute_reduce_confirmation(
    target_rows: list[dict[str, Any]],
    benchmark_rows: list[dict[str, Any]],
    quote_status: str,
    config: dict[str, Any],
) -> dict[str, Any]:
    """Count completed closes whose 5y-beta-adjusted spread is over 7%."""
    required = int(config["confirmation"]["tactical_overheat_closes"])
    core_required = int(config["confirmation"]["core_overheat_closes"])
    threshold = float(config["thresholds"]["relative"]["strong_sell_min"])
    intraday_excluded = quote_status == "盘中"
    completed_end = len(target_rows) - (2 if intraday_excluded else 1)
    primary_label = str(config["beta"]["primary_window"])
    beta_definition = config["beta"]["windows"][primary_label]

    if completed_end < 40:
        return {
            "threshold_pct": threshold,
            "required_closes": required,
            "confirmed_closes": 0,
            "consecutive_closes": 0,
            "confirmed": False,
            "core_required_closes": core_required,
            "core_confirmed": False,
            "intraday_excluded": intraday_excluded,
            "latest_completed_date": None,
            "recent_closes": [],
        }

    cache: dict[int, dict[str, Any]] = {}

    def spread_at(index: int) -> dict[str, Any]:
        if index in cache:
            return cache[index]
        target_return = (
            float(target_rows[index]["close"])
            / float(target_rows[index - 40]["close"])
            - 1
        )
        benchmark_return = (
            float(benchmark_rows[index]["close"])
            / float(benchmark_rows[index - 40]["close"])
            - 1
        )
        beta = estimate_beta(
            target_rows,
            benchmark_rows,
            index,
            int(beta_definition["trading_days"]),
            int(beta_definition["minimum_observations"]),
            float(config["beta"]["fallback"]),
        )
        adjusted = (target_return - beta["beta"] * benchmark_return) * 100
        cache[index] = {
            "adjusted_spread_pct": adjusted,
            "beta": beta["beta"],
            "sufficient": beta["sufficient"],
            "passed": beta["sufficient"] and adjusted >= threshold,
        }
        return cache[index]

    consecutive = 0
    for index in range(completed_end, 39, -1):
        if not spread_at(index)["passed"]:
            break
        consecutive += 1

    recent_start = max(40, completed_end - core_required + 1)
    recent_closes = [
        {
            "date": target_rows[index]["date"],
            "beta_adjusted_spread_pct": spread_at(index)["adjusted_spread_pct"],
            "beta": spread_at(index)["beta"],
            "passed": spread_at(index)["passed"],
        }
        for index in range(recent_start, completed_end + 1)
    ]
    return {
        "threshold_pct": threshold,
        "required_closes": required,
        "confirmed_closes": min(consecutive, required),
        "consecutive_closes": consecutive,
        "confirmed": consecutive >= required,
        "core_required_closes": core_required,
        "core_confirmed": consecutive >= core_required,
        "intraday_excluded": intraday_excluded,
        "latest_completed_date": target_rows[completed_end]["date"],
        "recent_closes": recent_closes,
    }


def bond_support(
    dividend_yield: float | None,
    bond_yield: float | None,
    thresholds: dict[str, float],
) -> tuple[str, float | None, float | None]:
    if dividend_yield is None or bond_yield in (None, 0):
        return "数据缺失", None, None
    spread = dividend_yield - bond_yield
    multiple = dividend_yield / bond_yield
    if (
        spread >= thresholds["strong_spread_min"]
        or multiple >= thresholds["strong_multiple_min"]
    ):
        label = "股债强支撑"
    elif (
        spread >= thresholds["support_spread_min"]
        or multiple >= thresholds["support_multiple_min"]
    ):
        label = "股债有支撑"
    elif (
        spread >= thresholds["neutral_spread_min"]
        or multiple >= thresholds["neutral_multiple_min"]
    ):
        label = "中性"
    else:
        label = "股债弱支撑"
    return label, spread, multiple


def align_series(
    target: SeriesBundle, benchmark: SeriesBundle
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    target_map = {row["date"]: row for row in target.rows}
    benchmark_map = {row["date"]: row for row in benchmark.rows}
    common = sorted(set(target_map) & set(benchmark_map))
    warnings: list[str] = []
    if len(common) < 260:
        raise DataError(f"两条指数共同交易日不足：{len(common)}")
    if target.rows[-1]["date"] != benchmark.rows[-1]["date"]:
        warnings.append(
            "两条指数最新日期不一致，已统一使用最近共同交易日 " + common[-1]
        )
    return (
        [target_map[day] for day in common],
        [benchmark_map[day] for day in common],
        warnings,
    )


def compute_metrics(
    target_rows: list[dict[str, Any]],
    benchmark_rows: list[dict[str, Any]],
    dividend: SourceValue,
    bond: SourceValue,
    config: dict[str, Any],
    quote_status: str = "历史收盘",
) -> dict[str, Any]:
    target_close = [float(row["close"]) for row in target_rows]
    benchmark_close = [float(row["close"]) for row in benchmark_rows]
    now = target_close[-1]
    benchmark_now = benchmark_close[-1]
    target_ret40 = now / target_close[-41] - 1
    benchmark_ret40 = benchmark_now / benchmark_close[-41] - 1
    raw_relative = target_ret40 - benchmark_ret40
    beta_snapshot = compute_beta_snapshot(
        target_rows,
        benchmark_rows,
        target_ret40,
        benchmark_ret40,
        quote_status,
        config,
    )
    primary_beta = beta_snapshot["primary"]
    adjusted_relative_pct = primary_beta["adjusted_spread_pct"]
    ma = {str(n): mean(target_close[-n:]) for n in (20, 30, 60, 120, 250)}
    ret20 = now / target_close[-21] - 1
    above_ma20 = now > ma["20"]
    if above_ma20 and ret20 > 0:
        momentum = "转强"
    elif (not above_ma20) and ret20 < 0:
        momentum = "转弱"
    else:
        momentum = "中性"
    distance_ma250 = now / ma["250"] - 1
    support, equity_bond_spread, equity_bond_multiple = bond_support(
        dividend.value,
        bond.value,
        config["thresholds"]["bond"],
    )
    confirmation = compute_reduce_confirmation(
        target_rows, benchmark_rows, quote_status, config
    )
    return {
        "trade_date": target_rows[-1]["date"],
        "close": now,
        "benchmark_close": benchmark_now,
        "target_40d_base_date": target_rows[-41]["date"],
        "benchmark_40d_base_date": benchmark_rows[-41]["date"],
        "target_40d_return_pct": target_ret40 * 100,
        "benchmark_40d_return_pct": benchmark_ret40 * 100,
        "raw_relative_spread_pct": raw_relative * 100,
        "relative_spread_pct": adjusted_relative_pct,
        "beta_adjusted_spread_pct": adjusted_relative_pct,
        "primary_signal_metric": "beta_adjusted_spread_pct",
        "relative_zone": relative_zone(
            adjusted_relative_pct, config["thresholds"]["relative"]
        ),
        "beta": primary_beta["beta"],
        "beta_window": beta_snapshot["primary_window"],
        "beta_observations": primary_beta["observations"],
        "beta_source": primary_beta["source"],
        "beta_correlation": primary_beta["correlation"],
        "beta_r2": primary_beta["r2"],
        "beta_ci95_low": primary_beta["ci95_low"],
        "beta_ci95_high": primary_beta["ci95_high"],
        "beta_windows": beta_snapshot["windows"],
        "beta_band_low_pct": beta_snapshot["band_low_pct"],
        "beta_band_high_pct": beta_snapshot["band_high_pct"],
        "beta_low": beta_snapshot["beta_low"],
        "beta_high": beta_snapshot["beta_high"],
        "beta_consensus": {
            "consistent": beta_snapshot["consensus"],
            "robust_buy": beta_snapshot["robust_buy"],
            "robust_overheat": beta_snapshot["robust_overheat"],
            "status": beta_snapshot["reliability"],
            "note": beta_snapshot["note"],
        },
        "quote_status": quote_status,
        "reduce_confirmation": confirmation,
        "ma20": ma["20"],
        "ma30": ma["30"],
        "ma60": ma["60"],
        "ma120": ma["120"],
        "ma250": ma["250"],
        "ret20_pct": ret20 * 100,
        "above_ma20": above_ma20,
        "momentum": momentum,
        "distance_ma250_pct": distance_ma250 * 100,
        "dividend_yield_pct": dividend.value,
        "bond10_pct": bond.value,
        "equity_bond_spread_pct": equity_bond_spread,
        "equity_bond_multiple": equity_bond_multiple,
        "bond_support": support,
    }


def _days_old(raw: str | None) -> int | None:
    if not raw:
        return None
    try:
        return (date.today() - date.fromisoformat(raw)).days
    except ValueError:
        return None


def data_quality(
    metrics: dict[str, Any],
    dividend: SourceValue,
    bond: SourceValue,
    config: dict[str, Any],
    warnings: list[str],
) -> dict[str, Any]:
    blockers: list[str] = []
    quality_warnings = list(warnings)
    market_age = _days_old(metrics["trade_date"])
    if market_age is None or market_age > config["max_market_age_days"]:
        blockers.append("行情日期过旧，拒绝给出买卖动作")
    for name, value in (("股息率", dividend), ("10年国债", bond)):
        age = _days_old(value.as_of)
        if value.value is None:
            quality_warnings.append(f"{name}缺失，股债确认降级")
        elif age is None or age > config["max_fundamental_age_days"]:
            quality_warnings.append(f"{name}数据日期偏旧：{value.as_of}")
    if str(metrics.get("beta_source", "")).startswith("fallback"):
        quality_warnings.append("Beta历史样本不足，已使用保守回退值，禁止卖出确认")
    beta_consensus = metrics.get("beta_consensus") or {}
    if beta_consensus and not beta_consensus.get("consistent", False):
        quality_warnings.append("2年、3年、5年Beta窗口结论不一致，动作降级为观察")
    confidence = "低" if blockers else ("中" if quality_warnings else "高")
    return {
        "confidence": confidence,
        "blockers": blockers,
        "warnings": quality_warnings,
    }


def evaluate_rules(
    metrics: dict[str, Any],
    quality: dict[str, Any],
    config: dict[str, Any],
) -> dict[str, Any]:
    def result(
        action_code: str,
        decision: str,
        reason: str,
        *,
        confirmed: bool,
        scope: str = "无",
        pct: int = 0,
        planned_pct: int = 0,
        core_action: str = "不动",
        timing: str = "立即",
    ) -> dict[str, Any]:
        return {
            "action_code": action_code,
            "decision": decision,
            "reason": reason,
            "confirmed": confirmed,
            "execution": {
                "scope": scope,
                "pct": pct,
                "planned_pct": planned_pct or pct,
                "core_action": core_action,
                "timing": timing,
            },
        }

    if quality["blockers"]:
        return result(
            "data_blocked",
            "暂停行动",
            "；".join(quality["blockers"]),
            confirmed=False,
            timing="数据恢复后重算",
        )

    zone = metrics["relative_zone"]
    support = metrics["bond_support"]
    momentum = metrics["momentum"]
    beta_consensus = metrics.get("beta_consensus") or {}
    adjusted_spread = float(metrics["beta_adjusted_spread_pct"])
    sell_thresholds = config["thresholds"]["sell_confirmation"]
    above_year = (
        metrics["distance_ma250_pct"]
        >= float(sell_thresholds["ma250_distance_min"])
    )
    high_above_year = (
        metrics["distance_ma250_pct"]
        >= float(sell_thresholds["core_ma250_distance_min"])
    )
    absolute_gain_confirmed = (
        metrics["target_40d_return_pct"]
        >= float(sell_thresholds["target_40d_return_min"])
    )
    support_ok = support in {"股债强支撑", "股债有支撑", "中性"}
    buy_pct = int(config["execution"]["buy_tranche_pct"])

    if zone in {"强买", "加仓", "买入"}:
        if not beta_consensus.get("robust_buy", False):
            return result(
                "beta_window_conflict",
                "观察，等待Beta窗口一致",
                "5年主信号进入买入区，但2年、3年、5年校正结果未全部确认低估",
                confirmed=False,
                timing="等待多窗口一致",
            )
        if not support_ok:
            return result(
                "buy_watch",
                "观察",
                f"主信号为{zone}，但股债确认不足（{support}）",
                confirmed=False,
                timing="等待股债支撑恢复",
            )
        if momentum == "转强":
            action = "分批买入，可加快执行"
            timing_reason = "短期趋势已确认转强"
            action_code = "buy_accelerate"
        elif momentum == "转弱":
            action = "左侧分批买入，不满仓"
            timing_reason = "短期趋势未确认，只控制买入速度"
            action_code = "buy_tranche"
        else:
            action = "分批买入"
            timing_reason = "短期趋势中性"
            action_code = "buy_tranche"
        return result(
            action_code,
            action,
            f"主信号{zone}，{support}；{timing_reason}",
            confirmed=True,
            scope="计划仓位",
            pct=buy_pct,
            core_action="按计划分批",
        )

    if zone == "观察":
        return result(
            "observe",
            "观察",
            "Beta调整后相对收益接近零，没有明显相对便宜或过热",
            confirmed=True,
            timing="等待主信号",
        )
    if zone == "持有":
        return result(
            "hold",
            "持有",
            "Beta调整后相对收益仍在持有区，不追涨也不减仓",
            confirmed=True,
            timing="继续观察",
        )
    if zone == "相对偏热":
        return result(
            "pause_add",
            "持有，暂停新增",
            f"Beta调整后40日差为{adjusted_spread:.2f}%，只触发暂停加仓，不构成卖点",
            confirmed=True,
            scope="战术仓",
            timing="等待差值回落或卖出条件完整确认",
        )
    if zone == "相对过热":
        confirmation = metrics["reduce_confirmation"]
        confirmed_closes = int(confirmation["confirmed_closes"])
        required_closes = int(confirmation["required_closes"])
        intraday = bool(confirmation["intraday_excluded"])
        reduce_pct = int(config["execution"]["reduce_pct"])

        if not beta_consensus.get("robust_overheat", False):
            return result(
                "beta_window_conflict",
                "持有，Beta窗口分歧",
                "5年主信号进入相对过热区，但2年、3年、5年结果未全部达到7%，不执行卖出",
                confirmed=False,
                scope="战术仓",
                timing="等待多窗口一致",
            )
        if not absolute_gain_confirmed:
            return result(
                "overheat_protected",
                "持有，暂停新增",
                f"相对差已过热，但红利自身40日仅{metrics['target_40d_return_pct']:.2f}%，未达到5%绝对涨幅确认",
                confirmed=False,
                scope="战术仓",
                planned_pct=reduce_pct,
                timing="等待红利自身涨幅确认",
            )
        if not above_year:
            return result(
                "overheat_protected",
                "持有，年线下方保护",
                f"相对差已过热，但仍低于MA250 {abs(metrics['distance_ma250_pct']):.2f}%，不执行卖出",
                confirmed=False,
                scope="战术仓",
                planned_pct=reduce_pct,
                timing="等待站上MA250",
            )

        if not confirmation["confirmed"]:
            intraday_note = "；当前盘中值不计入确认" if intraday else ""
            return result(
                "overheat_watch",
                "过热预警，等待收盘确认",
                f"Beta调整后差值、绝对涨幅和MA250均已达标，但仅连续{confirmed_closes}/{required_closes}个收盘日过热{intraday_note}",
                confirmed=False,
                scope="战术仓",
                planned_pct=reduce_pct,
                timing="停止新增，等待收盘确认",
            )
        if intraday:
            return result(
                "reduce_ready",
                "减仓条件已确认，等待收盘",
                "战术仓条件已全部确认；当前仍是盘中，只提示，等待当日收盘复核",
                confirmed=True,
                scope="战术仓",
                planned_pct=reduce_pct,
                timing="收盘复核后执行",
            )
        core_confirmed = (
            bool(confirmation.get("core_confirmed"))
            and high_above_year
            and support in {"中性", "股债弱支撑"}
        )
        if core_confirmed:
            return result(
                "reduce_core_review",
                "核心仓降档复核，战术仓减5%",
                "相对过热连续5个收盘日，红利高于MA250至少10%，且股债性价比已降至中性或偏弱",
                confirmed=True,
                scope="核心仓复核 + 战术仓",
                pct=reduce_pct,
                core_action="降档复核",
                timing="分批执行，核心仓不一次清空",
            )
        return result(
            f"reduce_tactical_{reduce_pct}",
            f"战术仓减{reduce_pct}%",
            f"Beta调整后过热已连续{required_closes}个收盘确认，且红利自身40日涨幅和MA250位置均达标",
            confirmed=True,
            scope="战术仓",
            pct=reduce_pct,
            core_action="不动",
            timing="分批执行",
        )
    raise AssertionError(zone)


def position_advice(
    evaluation: dict[str, Any],
    metrics: dict[str, Any],
    config: dict[str, Any],
) -> dict[str, str]:
    action_code = evaluation["action_code"]
    execution = evaluation["execution"]
    buy_pct = int(config["execution"]["buy_tranche_pct"])
    if action_code in {"buy_tranche", "buy_accelerate"}:
        no_position = f"按计划仓位先建约{buy_pct}%一档，分批完成，不一次满仓。"
        normal = f"可增加约{buy_pct}%计划仓位；短期趋势未确认时放慢。"
        heavy = "重仓不追买；等站稳MA20且20日收益转正再评估。"
    elif action_code == "reduce_core_review":
        no_position = "不追入，等待下一轮相对低估信号。"
        normal = "先减战术仓约5%；核心仓只进入降档复核，不一次清空。"
        heavy = "战术仓先减约5%；核心仓分档复核，避免一次性大幅卖出。"
    elif action_code.startswith("reduce_tactical_"):
        reduce_pct = int(execution["pct"])
        no_position = "不追入，等待下一轮相对低估信号。"
        normal = f"只处理战术仓：减约{reduce_pct}%持仓；核心仓不动。"
        heavy = f"战术仓先减约{reduce_pct}%；核心仓不动，不一次清仓。"
    elif action_code == "reduce_ready":
        planned_pct = int(execution["planned_pct"])
        no_position = "不追入，等待下一轮相对低估信号。"
        normal = f"盘中不执行；收盘复核后，战术仓计划减约{planned_pct}%，核心仓不动。"
        heavy = f"停止加仓；收盘复核后只处理战术仓约{planned_pct}%，核心仓不动。"
    elif action_code in {"overheat_watch", "overheat_protected", "pause_add"}:
        no_position = "停止追入，等待Beta调整后差值回落或下一轮低估信号。"
        normal = "停止新增，当前不减仓；核心仓不动，等待全部条件确认。"
        heavy = "停止加仓；只监控战术仓卖出条件，核心仓暂不处理。"
    elif action_code == "beta_window_conflict":
        no_position = "Beta窗口结论不一致，不追入。"
        normal = "保持现有仓位，等2年、3年、5年窗口重新一致。"
        heavy = "不加仓也不因单一Beta减仓，等待多窗口确认。"
    elif action_code == "hold":
        no_position = "不追，等Beta调整后差进入买入区且股债支撑仍在。"
        normal = "继续持有，不新增大仓。"
        heavy = "持有但停止加仓，预留后续调整空间。"
    elif action_code in {"observe", "buy_watch"}:
        no_position = "等待，不追；设置下一触发条件后再行动。"
        normal = "持有观察，不因单独跌破60日线卖出。"
        heavy = "不加仓；若未来进入确认减仓区，再分档降低仓位。"
    else:
        no_position = normal = heavy = "数据不足，暂停行动，待数据恢复后重算。"
    return {"无仓": no_position, "普通仓位": normal, "重仓": heavy}


def round_tree(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 4)
    if isinstance(value, list):
        return [round_tree(item) for item in value]
    if isinstance(value, dict):
        return {key: round_tree(item) for key, item in value.items()}
    return value


def render_markdown(result: dict[str, Any]) -> str:
    m = result["metrics"]
    q = result["quality"]
    advice = result["position_advice"]
    evaluation = result["evaluation"]
    confirmation = m["reduce_confirmation"]
    execution = evaluation["execution"]
    lines = [
        f"# 红利低波 V3.1 自动判定（{m['trade_date']}）",
        "",
        f"## 结论：{evaluation['decision']}",
        "",
        f"- 原因：{evaluation['reason']}",
        f"- 动作代码：{evaluation['action_code']}",
        f"- 战术仓收盘确认：{confirmation['confirmed_closes']}/{confirmation['required_closes']}（盘中行{'不计入' if confirmation['intraday_excluded'] else '已计入'}）",
        f"- 核心仓连续过热：{min(confirmation['consecutive_closes'], confirmation['core_required_closes'])}/{confirmation['core_required_closes']}",
        f"- 执行范围：{execution['scope']}；本次 {execution['pct']}%；核心仓 {execution['core_action']}",
        f"- 数据置信度：{q['confidence']}",
        f"- 行情状态：{result['sources']['target']['quote_status']}",
        "",
        "## 核心指标",
        "",
        "| 指标 | 数值 |",
        "|---|---:|",
        f"| H30269点位 | {m['close']:.2f} |",
        f"| 中证全指000985 | {m['benchmark_close']:.2f} |",
        f"| 红利低波40日收益 | {m['target_40d_return_pct']:.2f}% |",
        f"| 中证全指40日收益 | {m['benchmark_40d_return_pct']:.2f}% |",
        f"| 原始40日收益差 | {m['raw_relative_spread_pct']:.2f}%（仅观察） |",
        f"| Beta调整后40日差 | {m['beta_adjusted_spread_pct']:.2f}%（{m['relative_zone']}） |",
        f"| {m['beta_window']} Beta | {m['beta']:.4f}，R² {m['beta_r2']:.2%} |"
        if m["beta_r2"] is not None
        else f"| {m['beta_window']} Beta | {m['beta']:.4f} |",
        f"| 多窗口调整区间 | {m['beta_band_low_pct']:.2f}% ~ {m['beta_band_high_pct']:.2f}%（{m['beta_consensus']['status']}） |"
        if m["beta_band_low_pct"] is not None
        else "| 多窗口调整区间 | 样本不足 |",
        f"| MA20 | {m['ma20']:.2f} |",
        f"| MA60 | {m['ma60']:.2f} |",
        f"| MA250 | {m['ma250']:.2f} |",
        f"| 距离MA250 | {m['distance_ma250_pct']:.2f}% |",
        f"| 20日收益 | {m['ret20_pct']:.2f}% |",
        f"| 短期趋势状态 | {m['momentum']} |",
        f"| 股息率 | {m['dividend_yield_pct']:.2f}% |"
        if m["dividend_yield_pct"] is not None
        else "| 股息率 | 缺失 |",
        f"| 10年国债 | {m['bond10_pct']:.4f}% |"
        if m["bond10_pct"] is not None
        else "| 10年国债 | 缺失 |",
        f"| 股债利差 | {m['equity_bond_spread_pct']:.2f}% |"
        if m["equity_bond_spread_pct"] is not None
        else "| 股债利差 | 缺失 |",
        f"| 股债确认 | {m['bond_support']} |",
        "",
        "## 执行建议",
        "",
        f"- 无仓：{advice['无仓']}",
        f"- 普通仓位：{advice['普通仓位']}",
        f"- 重仓：{advice['重仓']}",
        "",
        "## 数据质量",
        "",
    ]
    if q["blockers"]:
        lines.extend(f"- 阻断：{item}" for item in q["blockers"])
    if q["warnings"]:
        lines.extend(f"- 提醒：{item}" for item in q["warnings"])
    if not q["blockers"] and not q["warnings"]:
        lines.append("- 行情与确认数据均通过新鲜度检查。")
    lines.extend(
        [
            "",
            "## 数据来源",
            "",
            f"- 指数行情：{result['sources']['target']['source']}，{result['sources']['target']['source_url']}",
            f"- 股息率：{result['sources']['dividend']['source']}，日期 {result['sources']['dividend']['as_of']}",
            f"- 国债收益率：{result['sources']['bond']['source']}，日期 {result['sources']['bond']['as_of']}",
            "",
            "> 本程序只生成规则化分析建议，不自动交易，也不保证未来收益。",
            "",
        ]
    )
    return "\n".join(lines)


def save_reports(result: dict[str, Any]) -> tuple[Path, Path]:
    report_dir = APP_DIR / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    json_path = report_dir / f"h30269-{stamp}.json"
    md_path = report_dir / f"h30269-{stamp}.md"
    atomic_json_write(json_path, round_tree(result))
    md_path.write_text(render_markdown(result), encoding="utf-8")
    (APP_DIR / "latest.json").write_text(
        json.dumps(round_tree(result), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (APP_DIR / "latest.md").write_text(render_markdown(result), encoding="utf-8")
    return md_path, json_path


def run(args: argparse.Namespace) -> dict[str, Any]:
    config = load_config(Path(args.config))
    if args.no_intraday:
        config["use_intraday"] = False
    session = make_session()
    warnings: list[str] = []
    target, warning = get_series(
        session, config["index_code"], config, args.offline
    )
    if warning:
        warnings.append(warning)
    benchmark, warning = get_series(
        session, config["benchmark_code"], config, args.offline
    )
    if warning:
        warnings.append(warning)
    target_rows, benchmark_rows, align_warnings = align_series(target, benchmark)
    warnings.extend(align_warnings)

    if args.offline and args.dividend_yield is None:
        dividend = load_source_cache(
            "dividend_yield", config["max_fundamental_age_days"]
        )
    else:
        dividend = fetch_dividend_yield(session, config, args.dividend_yield)
    if args.offline and args.bond_yield is None:
        bond = load_source_cache("bond_10y", config["max_fundamental_age_days"])
    else:
        bond = fetch_bond_10y(session, config, args.bond_yield)
    metrics = compute_metrics(
        target_rows, benchmark_rows, dividend, bond, config, target.quote_status
    )
    quality = data_quality(metrics, dividend, bond, config, warnings)
    evaluation = evaluate_rules(metrics, quality, config)
    result = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "model_version": config["model_version"],
        "metrics": metrics,
        "quality": quality,
        "evaluation": evaluation,
        "position_advice": position_advice(evaluation, metrics, config),
        "sources": {
            "target": asdict(target),
            "benchmark": asdict(benchmark),
            "dividend": asdict(dividend),
            "bond": asdict(bond),
        },
    }
    # Reports do not need thousands of historical rows in the source section.
    result["sources"]["target"].pop("rows", None)
    result["sources"]["benchmark"].pop("rows", None)
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="自动抓取数据并输出红利低波H30269 V3.1买卖建议"
    )
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--offline", action="store_true", help="只用本地缓存")
    parser.add_argument("--no-intraday", action="store_true", help="只用已发布日线")
    parser.add_argument("--dividend-yield", type=float, help="手工覆盖股息率(%%)")
    parser.add_argument("--bond-yield", type=float, help="手工覆盖10年国债收益率(%%)")
    parser.add_argument("--json", action="store_true", help="控制台输出完整JSON")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = run(args)
        md_path, json_path = save_reports(result)
    except Exception as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(round_tree(result), ensure_ascii=False, indent=2))
    else:
        metrics = result["metrics"]
        print("=" * 60)
        print(f"红利低波 V3.1：{result['evaluation']['decision']}")
        print(f"交易日：{metrics['trade_date']}  置信度：{result['quality']['confidence']}")
        print(f"原因：{result['evaluation']['reason']}")
        print(
            f"Beta调整后差 {metrics['beta_adjusted_spread_pct']:.2f}% | "
            f"MA250偏离 {metrics['distance_ma250_pct']:.2f}% | "
            f"动量 {metrics['momentum']} | {metrics['bond_support']}"
        )
        print("-" * 60)
        for position, advice in result["position_advice"].items():
            print(f"{position}：{advice}")
        for warning in result["quality"]["warnings"]:
            print(f"提醒：{warning}")
        print(f"报告：{md_path}")
        print(f"数据：{json_path}")
        print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
