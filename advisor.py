#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""H30269 red-dividend low-volatility V3.2 decision assistant.

Uses H20269 / H00985 total-return series for 40-day relative return, R²-shrunk
multi-window Beta, and MA250 confirmation (eliminating dividend-season price
drops), while preserving H30269 OHLC candlesticks, CSI rolling PE valuation
gating, and unified ChinaBond / Eastmoney 10Y yields. It never places orders.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
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
CHINABOND_URL = "https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery"
EM_BOND_URL = (
    "https://datacenter-web.eastmoney.com/api/data/v1/get"
    "?reportName=RPTA_WEB_TREASURYYIELD&columns=ALL&pageSize=50&pageNumber=1"
    "&sortColumns=SOLAR_DATE&sortTypes=-1"
)
DANJUAN_URL = "https://danjuanfunds.com/djapi/index_eva/detail/CSIH30269"


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
                "AppleWebKit/537.36 Chrome/126 Safari/537.36"
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
        return response.json()
    except Exception as exc:
        raise DataError(f"接口未返回JSON: {url}: {exc}") from exc


def _normalize_csi_rows(items: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: dict[str, dict[str, Any]] = {}
    for item in items:
        raw_date = str(item.get("tradeDate") or "")
        close = item.get("close")
        if len(raw_date) != 8 or close in (None, 0):
            continue
        day = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}"
        c_val = float(close)
        o_val = float(item.get("open") or c_val)
        h_val = float(item.get("high") or c_val)
        l_val = float(item.get("low") or c_val)
        raw_pe = item.get("peg")
        pe_val = float(raw_pe) if raw_pe not in (None, 0, "", "-") and float(raw_pe) > 0 else None
        rows[day] = {
            "date": day,
            "open": o_val,
            "high": max(o_val, h_val, l_val, c_val),
            "low": min(o_val, h_val, l_val, c_val),
            "close": c_val,
            "pe": pe_val,
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
    detail_url = f"https://www.csindex.com.cn/zh-CN/indices/index-detail/{code}"
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
        try:
            quote_url = f"{CSI_BASE}/perf/index-perf-oneday"
            quote_payload = _get_json(
                session,
                quote_url,
                params={"indexCode": code},
                referer=detail_url,
            )
            data = quote_payload.get("data") or {}
            header = data.get("intraDayHeader") or {}
            perf_list = data.get("intraDayPerfList") or []
            raw_date = str(header.get("tradeDate") or "")
            current = header.get("current")
            if len(raw_date) == 10:
                quote_day = raw_date
            elif len(raw_date) == 8:
                quote_day = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}"
            else:
                quote_day = ""
            trade_time = str(header.get("tradeTime") or "")
            if quote_day and current not in (None, 0) and float(current) > 0:
                cur_val = float(current)
                open_val = float(header.get("openToday") or cur_val)
                highs = [float(r["high"]) for r in perf_list if r.get("high") not in (None, 0) and float(r["high"]) > 0]
                lows = [float(r["low"]) for r in perf_list if r.get("low") not in (None, 0) and float(r["low"]) > 0]
                high_val = max([*highs, open_val, cur_val])
                low_val = min([*lows, open_val, cur_val])
                prev_rows = [r for r in rows if r["date"] < quote_day]
                prev_row = prev_rows[-1] if prev_rows else None
                scaled_pe = (
                    prev_row["pe"] * (cur_val / prev_row["close"])
                    if prev_row and prev_row.get("pe") and prev_row["close"] > 0
                    else None
                )
                by_date = {row["date"]: dict(row) for row in rows}
                if quote_day in by_date:
                    existing = by_date[quote_day]
                    existing["close"] = cur_val
                    existing["high"] = max(existing["high"], high_val, cur_val)
                    existing["low"] = min(existing["low"], low_val, cur_val)
                    if not existing.get("pe") and scaled_pe:
                        existing["pe"] = scaled_pe
                else:
                    by_date[quote_day] = {
                        "date": quote_day,
                        "open": open_val,
                        "high": high_val,
                        "low": low_val,
                        "close": cur_val,
                        "pe": scaled_pe,
                    }
                rows = [by_date[key] for key in sorted(by_date)]
                quote_status = "收盘后" if trade_time >= "15:05:00" else "盘中"
        except Exception:
            pass

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
    *,
    use_intraday: bool | None = None,
) -> tuple[SeriesBundle, str | None]:
    intraday = config["use_intraday"] if use_intraday is None else use_intraday
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
            intraday,
        )
        return bundle, None
    except Exception as exc:
        bundle = load_cached_series(code, config["cache_max_age_days"])
        return bundle, f"{code} 在线抓取失败，使用缓存：{exc}"


def implied_dividend_yield(
    price_rows: list[dict[str, Any]], tr_rows: list[dict[str, Any]]
) -> dict[str, Any] | None:
    if len(price_rows) < 240 or len(price_rows) != len(tr_rows):
        return None
    end_dt = date.fromisoformat(price_rows[-1]["date"])
    start_dt = date.fromisoformat(price_rows[0]["date"])
    if (end_dt - start_dt).days < 350:
        return None
    cutoff = end_dt - timedelta(days=365)
    div_points = 0.0
    for i in range(1, len(price_rows)):
        row_dt = date.fromisoformat(price_rows[i]["date"])
        if row_dt <= cutoff:
            continue
        prev_p = float(price_rows[i - 1]["close"])
        curr_p = float(price_rows[i]["close"])
        prev_tr = float(tr_rows[i - 1]["close"])
        curr_tr = float(tr_rows[i]["close"])
        if prev_p > 0 and prev_tr > 0:
            diff = (curr_tr / prev_tr - 1.0) - (curr_p / prev_p - 1.0)
            if diff > 0:
                div_points += prev_p * diff
    latest_p = float(price_rows[-1]["close"])
    if latest_p <= 0 or div_points <= 0:
        return None
    return {
        "value": (div_points / latest_p) * 100.0,
        "as_of": price_rows[-1]["date"],
    }


def fetch_dividend_yield(
    session: requests.Session,
    config: dict[str, Any],
    override: float | None,
    *,
    implied: dict[str, Any] | None = None,
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
        if raw_yield in (None, 0) or float(raw_yield) <= 0:
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
        if implied and implied.get("value") and float(implied["value"]) > 0:
            fallback_live = SourceValue(
                value=float(implied["value"]),
                as_of=str(implied["as_of"]),
                source="中证全收益/价格指数推算TTM股息率",
                source_url=f"{CSI_BASE}/perf/index-perf",
                status="live-implied",
            )
            save_source_cache("dividend_yield", fallback_live)
            return fallback_live
        try:
            return load_source_cache("dividend_yield", int(config["max_fundamental_age_days"]))
        except Exception:
            return SourceValue(
                value=None,
                as_of=None,
                source=f"抓取失败：{exc}",
                source_url=DANJUAN_URL,
                status="missing",
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
    except Exception as primary_exc:
        try:
            em_payload = _get_json(session, EM_BOND_URL, timeout=20)
            rows = []
            for r in (em_payload.get("result") or {}).get("data") or []:
                d_str = str(r.get("SOLAR_DATE") or "")[:10]
                v_raw = r.get("EMM00166466")
                if len(d_str) == 10 and v_raw is not None and float(v_raw) > 0:
                    rows.append((d_str, float(v_raw)))
            if not rows:
                raise DataError("东财国债数据为空")
            as_of, value = sorted(rows, key=lambda item: item[0])[-1]
            result = SourceValue(
                value=value,
                as_of=as_of,
                source="东方财富中债10年期国债收益率（备用直连）",
                source_url="https://datacenter-web.eastmoney.com/",
                status="live",
            )
            save_source_cache("bond_10y", result)
            return result
        except Exception as backup_exc:
            try:
                return load_source_cache("bond_10y", int(config["max_fundamental_age_days"]))
            except Exception:
                return SourceValue(
                    value=None,
                    as_of=None,
                    source=f"抓取失败：{primary_exc}；备用失败：{backup_exc}",
                    source_url=CHINABOND_URL,
                    status="missing",
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


def signal_group(relative_pct: float, thresholds: dict[str, float]) -> str:
    if relative_pct <= thresholds["buy_max"]:
        return "buy"
    if relative_pct < thresholds["reduce_min"]:
        return "hold"
    if relative_pct < thresholds["strong_sell_min"]:
        return "pause_add"
    return "overheat"


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
        (target_return - alpha - beta * benchmark_return) ** 2
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
        math.sqrt(residual_sum / max(1, observations - 2) / benchmark_variance)
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


def _evaluate_multi_window_beta(
    target_rows: list[dict[str, Any]],
    benchmark_rows: list[dict[str, Any]],
    end_index: int,
    target_return40: float,
    benchmark_return40: float,
    config: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    beta_config = config["beta"]
    thresholds = config["thresholds"]["relative"]
    r2_ref = float(beta_config.get("shrinkage_r2_ref") or 0.0)
    raw_windows: dict[str, dict[str, Any]] = {}
    for label, definition in beta_config["windows"].items():
        raw_windows[label] = estimate_beta(
            target_rows,
            benchmark_rows,
            end_index,
            int(definition["trading_days"]),
            int(definition["minimum_observations"]),
            float(beta_config["fallback"]),
        )
    primary_label = str(beta_config["primary_window"])
    anchor = raw_windows[primary_label]
    windows: dict[str, dict[str, Any]] = {}
    for label, est in raw_windows.items():
        effective_beta = est["beta"]
        shrink_weight = 1.0
        if (
            est["sufficient"]
            and anchor["sufficient"]
            and label != primary_label
            and r2_ref > 0.0
            and est["r2"] is not None
        ):
            shrink_weight = min(1.0, max(0.0, float(est["r2"]) / r2_ref))
            effective_beta = shrink_weight * est["beta"] + (1.0 - shrink_weight) * anchor["beta"]
        adjusted = target_return40 - effective_beta * benchmark_return40
        windows[label] = {
            **est,
            "raw_beta": est["beta"],
            "beta": effective_beta,
            "shrinkage_weight": shrink_weight,
            "adjusted_spread_pct": adjusted * 100,
            "zone": relative_zone(adjusted * 100, thresholds),
            "group": signal_group(adjusted * 100, thresholds),
        }
    return windows


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
    windows = _evaluate_multi_window_beta(
        target_rows, benchmark_rows, completed_end, target_return40, benchmark_return40, config
    )

    primary_label = str(beta_config["primary_window"])
    primary = windows[primary_label]
    if not primary["sufficient"]:
        usable = [(label, value) for label, value in windows.items() if value["sufficient"]]
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
    reliability = "样本不足" if not usable_windows else ("窗口一致" if consensus else "窗口分歧")

    return {
        "primary_window": primary_label,
        "primary": primary,
        "windows": windows,
        "band_low_pct": min(adjusted_values) if adjusted_values else None,
        "band_high_pct": max(adjusted_values) if adjusted_values else None,
        "beta_low": min(value["beta"] for value in usable_windows) if usable_windows else None,
        "beta_high": max(value["beta"] for value in usable_windows) if usable_windows else None,
        "consensus": consensus,
        "robust_buy": robust_buy,
        "robust_overheat": robust_overheat,
        "reliability": reliability,
        "note": "Beta经R²稳健收缩校正市场敏感度，不单独触发交易",
    }


def compute_reduce_confirmation(
    target_rows: list[dict[str, Any]],
    benchmark_rows: list[dict[str, Any]],
    quote_status: str,
    config: dict[str, Any],
) -> dict[str, Any]:
    """Count completed closes passing ALL overheat gates (multi-window, 40d gain, MA250)."""
    required = int(config["confirmation"]["tactical_overheat_closes"])
    core_required = int(config["confirmation"]["core_overheat_closes"])
    threshold = float(config["thresholds"]["relative"]["strong_sell_min"])
    sell_cfg = config["thresholds"]["sell_confirmation"]
    min_ret40 = float(sell_cfg["target_40d_return_min"])
    min_ma250_dist = float(sell_cfg["ma250_distance_min"])
    intraday_excluded = quote_status == "盘中"
    completed_end = len(target_rows) - (2 if intraday_excluded else 1)
    primary_label = str(config["beta"]["primary_window"])

    if completed_end < 250:
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

    closes = [float(r["close"]) for r in target_rows]
    cache: dict[int, dict[str, Any]] = {}

    def state_at(index: int) -> dict[str, Any]:
        if index in cache:
            return cache[index]
        target_return = closes[index] / closes[index - 40] - 1
        benchmark_return = (
            float(benchmark_rows[index]["close"])
            / float(benchmark_rows[index - 40]["close"])
            - 1
        )
        windows = _evaluate_multi_window_beta(
            target_rows, benchmark_rows, index, target_return, benchmark_return, config
        )
        usable = [w for w in windows.values() if w["sufficient"]]
        robust_overheat = bool(usable) and all(
            w["adjusted_spread_pct"] >= threshold for w in usable
        )
        ma250 = mean(closes[index - 249 : index + 1])
        dist_ma250 = (closes[index] / ma250 - 1) * 100
        primary = windows[primary_label]
        passed = (
            robust_overheat
            and (target_return * 100 >= min_ret40)
            and (dist_ma250 >= min_ma250_dist)
        )
        cache[index] = {
            "adjusted_spread_pct": primary["adjusted_spread_pct"],
            "beta": primary["beta"],
            "sufficient": primary["sufficient"],
            "passed": passed,
        }
        return cache[index]

    consecutive = 0
    for index in range(completed_end, 249, -1):
        if not state_at(index)["passed"]:
            break
        consecutive += 1

    recent_start = max(250, completed_end - core_required + 1)
    recent_closes = [
        {
            "date": target_rows[index]["date"],
            "beta_adjusted_spread_pct": state_at(index)["adjusted_spread_pct"],
            "beta": state_at(index)["beta"],
            "passed": state_at(index)["passed"],
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


def _bridge_provisional_tr(
    price_rows: list[dict[str, Any]], tr_rows: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    if not tr_rows or not price_rows:
        return price_rows
    tr_map = {row["date"]: dict(row) for row in tr_rows}
    last_p = price_rows[-1]
    prev_p = price_rows[-2] if len(price_rows) >= 2 else None
    if (
        last_p
        and prev_p
        and float(prev_p["close"]) > 0
        and prev_p["date"] in tr_map
        and last_p["date"] not in tr_map
    ):
        prev_tr = tr_map[prev_p["date"]]
        scaled_close = float(prev_tr["close"]) * (float(last_p["close"]) / float(prev_p["close"]))
        tr_map[last_p["date"]] = {
            "date": last_p["date"],
            "open": scaled_close,
            "high": scaled_close,
            "low": scaled_close,
            "close": scaled_close,
            "pe": last_p.get("pe") or prev_tr.get("pe"),
        }
    return [tr_map[k] for k in sorted(tr_map)]


def align_series(
    target: SeriesBundle,
    benchmark: SeriesBundle,
    target_tr: SeriesBundle | None = None,
    benchmark_tr: SeriesBundle | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    tr_target_rows_raw = (
        _bridge_provisional_tr(target.rows, target_tr.rows)
        if target_tr and target_tr.rows
        else target.rows
    )
    tr_bench_rows_raw = (
        _bridge_provisional_tr(benchmark.rows, benchmark_tr.rows)
        if benchmark_tr and benchmark_tr.rows
        else benchmark.rows
    )
    target_map = {row["date"]: row for row in target.rows}
    benchmark_map = {row["date"]: row for row in benchmark.rows}
    tr_target_map = {row["date"]: row for row in tr_target_rows_raw}
    tr_bench_map = {row["date"]: row for row in tr_bench_rows_raw}
    common = sorted(set(target_map) & set(benchmark_map) & set(tr_target_map) & set(tr_bench_map))
    warnings: list[str] = []
    if len(common) < 260:
        raise DataError(f"指数共同交易日不足：{len(common)}")
    if target.rows[-1]["date"] != benchmark.rows[-1]["date"]:
        warnings.append("两条指数最新日期不一致，已统一使用最近共同交易日 " + common[-1])
    return (
        [target_map[day] for day in common],
        [benchmark_map[day] for day in common],
        [tr_target_map[day] for day in common],
        [tr_bench_map[day] for day in common],
        warnings,
    )


def _compute_pe_valuation(
    price_rows: list[dict[str, Any]],
    tr_rows: list[dict[str, Any]],
    config: dict[str, Any],
) -> dict[str, Any]:
    min_obs = int((config["thresholds"].get("valuation_gate") or {}).get("min_observations", 500))
    pe_series = [
        row.get("pe") if row.get("pe") is not None else tr_rows[idx].get("pe")
        for idx, row in enumerate(price_rows)
    ]
    pe_now = pe_series[-1] if pe_series else None
    history = [float(v) for v in pe_series[:-1] if v is not None and float(v) > 0]
    if pe_now is None or float(pe_now) <= 0 or len(history) < min_obs:
        return {"pe": pe_now, "pe_percentile": None, "pe_observations": len(history)}
    below = sum(1 for x in history if x <= float(pe_now))
    return {
        "pe": float(pe_now),
        "pe_percentile": (100.0 * below) / len(history),
        "pe_observations": len(history),
    }


def compute_metrics(
    target_rows: list[dict[str, Any]],
    benchmark_rows: list[dict[str, Any]],
    dividend: SourceValue,
    bond: SourceValue,
    config: dict[str, Any],
    quote_status: str = "历史收盘",
    tr_target_rows: list[dict[str, Any]] | None = None,
    tr_benchmark_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    sig_target = tr_target_rows if tr_target_rows and len(tr_target_rows) == len(target_rows) else target_rows
    sig_bench = tr_benchmark_rows if tr_benchmark_rows and len(tr_benchmark_rows) == len(benchmark_rows) else benchmark_rows

    price_close = [float(row["close"]) for row in target_rows]
    bench_price_close = [float(row["close"]) for row in benchmark_rows]
    sig_target_close = [float(row["close"]) for row in sig_target]
    sig_bench_close = [float(row["close"]) for row in sig_bench]

    now = price_close[-1]
    benchmark_now = bench_price_close[-1]
    tr_now = sig_target_close[-1]
    tr_bench_now = sig_bench_close[-1]

    target_ret40 = tr_now / sig_target_close[-41] - 1
    benchmark_ret40 = tr_bench_now / sig_bench_close[-41] - 1
    raw_relative = target_ret40 - benchmark_ret40
    beta_snapshot = compute_beta_snapshot(
        sig_target, sig_bench, target_ret40, benchmark_ret40, quote_status, config
    )
    primary_beta = beta_snapshot["primary"]
    adjusted_relative_pct = primary_beta["adjusted_spread_pct"]

    ma = {str(n): mean(price_close[-n:]) for n in (20, 30, 60, 120, 250)}
    tr_ma20 = mean(sig_target_close[-20:])
    tr_ma250 = mean(sig_target_close[-250:])

    ret20 = tr_now / sig_target_close[-21] - 1
    above_ma20 = tr_now > tr_ma20
    if above_ma20 and ret20 > 0:
        momentum = "转强"
    elif (not above_ma20) and ret20 < 0:
        momentum = "转弱"
    else:
        momentum = "中性"
    distance_ma250 = tr_now / tr_ma250 - 1
    price_distance_ma250 = now / ma["250"] - 1
    support, equity_bond_spread, equity_bond_multiple = bond_support(
        dividend.value,
        bond.value,
        config["thresholds"]["bond"],
    )
    confirmation = compute_reduce_confirmation(
        sig_target, sig_bench, quote_status, config
    )
    pe_info = _compute_pe_valuation(target_rows, sig_target, config)

    return {
        "trade_date": target_rows[-1]["date"],
        "close": now,
        "benchmark_close": benchmark_now,
        "tr_close": tr_now,
        "benchmark_tr_close": tr_bench_now,
        "signal_return_basis": "price" if sig_target is target_rows else "total_return",
        "target_40d_base_date": sig_target[-41]["date"],
        "benchmark_40d_base_date": sig_bench[-41]["date"],
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
        "tr_ma250": tr_ma250,
        "ret20_pct": ret20 * 100,
        "above_ma20": above_ma20,
        "momentum": momentum,
        "distance_ma250_pct": distance_ma250 * 100,
        "price_distance_ma250_pct": price_distance_ma250 * 100,
        "pe": pe_info["pe"],
        "pe_percentile": pe_info["pe_percentile"],
        "pe_observations": pe_info["pe_observations"],
        "dividend_yield_pct": dividend.value,
        "bond10_pct": bond.value,
        "equity_bond_spread_pct": equity_bond_spread,
        "equity_bond_multiple": equity_bond_multiple,
        "bond_support": support,
    }


def _days_old(raw: str | None, ref_date: date | None = None) -> int | None:
    if not raw:
        return None
    try:
        base = ref_date or date.today()
        return (base - date.fromisoformat(raw[:10])).days
    except ValueError:
        return None


def data_quality(
    metrics: dict[str, Any],
    dividend: SourceValue,
    bond: SourceValue,
    config: dict[str, Any],
    warnings: list[str],
    ref_date: date | None = None,
) -> dict[str, Any]:
    blockers: list[str] = []
    quality_warnings = list(warnings)
    market_age = _days_old(metrics["trade_date"], ref_date)
    if market_age is None or market_age > config["max_market_age_days"]:
        blockers.append("行情日期过旧，拒绝给出买卖动作")
    for name, value in (("股息率", dividend), ("10年国债", bond)):
        age = _days_old(value.as_of, ref_date)
        if value.value is None or value.status in {"missing", "fallback"}:
            blockers.append(f"{name}缺失或仅剩静态旧值，拒绝给出自动买卖动作")
        elif age is None or age > config["max_fundamental_age_days"]:
            blockers.append(
                f"{name}数据超过{config['max_fundamental_age_days']}天未更新（{value.as_of}），暂停自动交易动作"
            )
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


def _buy_tranche_for_zone(zone: str, config: dict[str, Any]) -> int:
    ex = config["execution"]
    if zone == "强买":
        return int(ex.get("strong_buy_tranche_pct") or ex["buy_tranche_pct"])
    if zone == "加仓":
        return int(ex.get("add_tranche_pct") or ex["buy_tranche_pct"])
    return int(ex["buy_tranche_pct"])


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
    val_gate = config["thresholds"].get("valuation_gate") or {}
    high_pe_pct = float(val_gate.get("high_pe_percentile", 80.0))
    core_pe_pct = float(val_gate.get("core_review_pe_percentile", 75.0))
    pe_pct = metrics.get("pe_percentile")

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
    buy_pct = _buy_tranche_for_zone(zone, config)

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
        if zone != "强买" and pe_pct is not None and float(pe_pct) >= high_pe_pct:
            return result(
                "valuation_high_watch",
                "观察，绝对估值偏高",
                f"相对差进入{zone}区，但红利低波PE位于历史{float(pe_pct):.1f}%高分位，防止高位追买",
                confirmed=False,
                timing="等待PE分位回落至80%以下或极端强买",
            )
        if momentum == "转强":
            action = f"分批买入（{buy_pct}%），可加快执行"
            timing_reason = "短期趋势已确认转强"
            action_code = "buy_accelerate"
        elif momentum == "转弱":
            action = f"左侧分批买入（{buy_pct}%），不满仓"
            timing_reason = "短期趋势未确认，两次加仓建议间隔至少5个交易日"
            action_code = "buy_tranche"
        else:
            action = f"分批买入（{buy_pct}%）"
            timing_reason = "短期趋势中性，两次加仓建议间隔至少5个交易日"
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
            "Beta调整后全收益相对差接近零，没有明显相对便宜或过热",
            confirmed=True,
            timing="等待主信号",
        )
    if zone == "持有":
        return result(
            "hold",
            "持有",
            "Beta调整后全收益相对差仍在持有区，不追涨也不减仓",
            confirmed=True,
            timing="继续观察",
        )
    if zone == "相对偏热":
        return result(
            "pause_add",
            "持有，暂停新增",
            f"Beta调整后40日全收益差为{adjusted_spread:.2f}%，只触发暂停加仓，不构成卖点",
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
                f"相对差已过热，但红利全收益40日仅{metrics['target_40d_return_pct']:.2f}%，未达到5%绝对涨幅确认",
                confirmed=False,
                scope="战术仓",
                planned_pct=reduce_pct,
                timing="等待红利自身涨幅确认",
            )
        if not above_year:
            return result(
                "overheat_protected",
                "持有，年线下方保护",
                f"相对差已过热，但全收益仍低于MA250 {abs(metrics['distance_ma250_pct']):.2f}%，不执行卖出",
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
                f"Beta调整后差值、绝对涨幅和MA250均已达标，但仅连续{confirmed_closes}/{required_closes}个收盘日完整达标{intraday_note}",
                confirmed=False,
                scope="战术仓",
                planned_pct=reduce_pct,
                timing="停止新增，等待收盘确认",
            )
        if intraday:
            return result(
                "reduce_ready",
                "盘中可减战术仓，收盘再复核",
                "此前的正式收盘确认已完成，当前盘中过热条件仍满足；可减战术仓，收盘后独立复核，刷新不重复执行",
                confirmed=True,
                scope="战术仓",
                pct=reduce_pct,
                planned_pct=reduce_pct,
                timing="盘中条件执行，收盘复核",
            )
        valuation_weak = support in {"中性", "股债弱支撑"} or (
            pe_pct is not None and float(pe_pct) >= core_pe_pct
        )
        core_confirmed = (
            bool(confirmation.get("core_confirmed"))
            and high_above_year
            and valuation_weak
        )
        if core_confirmed:
            return result(
                "reduce_core_review",
                f"核心仓降档复核，本次减{reduce_pct}%",
                "相对过热连续5个收盘日，全收益高于MA250至少10%，且估值或股债性价比进入偏贵区",
                confirmed=True,
                scope="核心仓复核 + 战术仓",
                pct=reduce_pct,
                core_action="降档复核（保留45%底仓）",
                timing="分批执行，核心仓保留底仓",
            )
        return result(
            f"reduce_tactical_{reduce_pct}",
            f"战术仓减{reduce_pct}%",
            f"Beta调整后过热已连续{required_closes}个收盘完整确认，且红利全收益40日涨幅和MA250位置均达标",
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
    pct = int(execution.get("pct") or config["execution"]["buy_tranche_pct"])
    if action_code in {"buy_tranche", "buy_accelerate"}:
        no_position = f"按策略资金池先建约{pct}%一档，两次加仓间隔至少5个交易日，不一次满仓。"
        normal = f"可增加约{pct}%策略资金池仓位；短期趋势未确认时放慢节奏。"
        heavy = "已达80%重仓线不追买；保留后续极端位置缓冲空间。"
    elif action_code == "valuation_high_watch":
        no_position = "红利PE处于历史高分位区，不因短期跑输大盘追高建仓。"
        normal = "暂停加仓；持有现有底仓吃息，等待估值分位回落。"
        heavy = "不加仓；密切关注是否触发过热止盈信号。"
    elif action_code == "reduce_core_review":
        no_position = "不追入，等待下一轮低估信号。"
        normal = f"先减战术仓，不足部分可降核心仓（合计最多{pct}个百分点，核心仓保留至少45%底仓）。"
        heavy = f"分批减仓约{pct}个百分点（先战术仓后核心仓，保留45%底仓），避免一次性清仓。"
    elif action_code.startswith("reduce_tactical_"):
        reduce_pct = int(execution["pct"])
        no_position = "不追入，等待下一轮相对低估信号。"
        normal = f"只处理战术仓：按资金池减约{reduce_pct}个百分点；核心仓不动。"
        heavy = f"战术仓先减约{reduce_pct}个百分点；核心仓不动，不一次清仓。"
    elif action_code == "reduce_ready":
        planned_pct = int(execution["planned_pct"])
        no_position = "不追入，等待下一轮相对低估信号。"
        normal = f"此前收盘确认已完成，盘中条件仍满足时可减战术仓约{planned_pct}个百分点，核心仓不动；收盘后复核。"
        heavy = f"停止加仓；盘中只处理战术仓约{planned_pct}个百分点，核心仓不动；收盘后复核。"
    elif action_code in {"overheat_watch", "overheat_protected", "pause_add"}:
        no_position = "停止追入，等待Beta调整后差值回落或下一轮低估信号。"
        normal = "停止新增，当前不减仓；核心仓不动，等待全部条件确认。"
        heavy = "停止加仓；只监控战术仓卖出条件，核心仓暂不处理。"
    elif action_code == "beta_window_conflict":
        no_position = "Beta窗口结论不一致，不追入。"
        normal = "保持现有仓位，等2年、3年、5年窗口重新一致。"
        heavy = "不加仓也不因单一Beta减仓，等待多窗口确认。"
    elif action_code == "hold":
        no_position = "不追，等Beta调整后全收益差进入买入区且股债支撑与估值合理。"
        normal = "继续持有底仓吃息，不新增大仓。"
        heavy = "持有但停止加仓，预留后续调整空间。"
    elif action_code in {"observe", "buy_watch"}:
        no_position = "等待，不追；设置下一触发条件后再行动。"
        normal = "持有观察，不因单独跌破60日线卖出。"
        heavy = "不加仓；若未来进入确认减仓区，再分档降低仓位。"
    else:
        no_position = normal = heavy = "确认数据不足或过期，暂停行动，待数据恢复后重算。"
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
        f"# 红利低波 V3.2 自动判定（{m['trade_date']}）",
        "",
        f"## 结论：{evaluation['decision']}",
        "",
        f"- 原因：{evaluation['reason']}",
        f"- 动作代码：{evaluation['action_code']}",
        f"- 收益信号口径：{m.get('signal_return_basis', 'total_return')}（全收益消除分红假摔）",
        f"- 战术仓收盘确认：{confirmation['confirmed_closes']}/{confirmation['required_closes']}（盘中行{'不计入' if confirmation['intraday_excluded'] else '已计入'}）",
        f"- 核心仓连续过热：{min(confirmation['consecutive_closes'], confirmation['core_required_closes'])}/{confirmation['core_required_closes']}",
        f"- 执行范围：{execution['scope']}；本次 {execution['pct']} 个百分点；核心仓 {execution['core_action']}",
        f"- 数据置信度：{q['confidence']}",
        f"- 行情状态：{result['sources']['target']['quote_status']}",
        "",
        "## 核心指标",
        "",
        "| 指标 | 数值 |",
        "|---|---:|",
        f"| H30269价格点位 | {m['close']:.2f} |",
        f"| H20269全收益点位 | {m['tr_close']:.2f} |",
        f"| 中证全指000985 | {m['benchmark_close']:.2f} |",
        f"| 红利低波40日全收益 | {m['target_40d_return_pct']:.2f}% |",
        f"| 中证全指40日全收益 | {m['benchmark_40d_return_pct']:.2f}% |",
        f"| 原始40日全收益差 | {m['raw_relative_spread_pct']:.2f}%（仅观察） |",
        f"| Beta调整后40日差 | {m['beta_adjusted_spread_pct']:.2f}%（{m['relative_zone']}） |",
        f"| {m['beta_window']} Beta | {m['beta']:.4f}，R² {m['beta_r2']:.2%} |"
        if m["beta_r2"] is not None
        else f"| {m['beta_window']} Beta | {m['beta']:.4f} |",
        f"| 多窗口调整区间 | {m['beta_band_low_pct']:.2f}% ~ {m['beta_band_high_pct']:.2f}%（{m['beta_consensus']['status']}） |"
        if m["beta_band_low_pct"] is not None
        else "| 多窗口调整区间 | 样本不足 |",
        f"| 滚动PE / 历史分位 | {m['pe']:.2f} / {m['pe_percentile']:.1f}% |"
        if m.get("pe") and m.get("pe_percentile") is not None
        else "| 滚动PE / 历史分位 | 样本积累中 |",
        f"| 全收益距离MA250 | {m['distance_ma250_pct']:.2f}% |",
        f"| 价格距离MA250 | {m['price_distance_ma250_pct']:.2f}% |",
        f"| 20日全收益 | {m['ret20_pct']:.2f}% |",
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

    tr_code = config.get("total_return_code", "H20269")
    bm_tr_code = config.get("benchmark_total_return_code", "H00985")
    target_tr, warning = get_series(
        session, tr_code, config, args.offline, use_intraday=False
    )
    if warning:
        warnings.append(warning)
    benchmark_tr, warning = get_series(
        session, bm_tr_code, config, args.offline, use_intraday=False
    )
    if warning:
        warnings.append(warning)

    target_rows, benchmark_rows, tr_target_rows, tr_benchmark_rows, align_warnings = align_series(
        target, benchmark, target_tr, benchmark_tr
    )
    warnings.extend(align_warnings)

    implied = implied_dividend_yield(target_rows, tr_target_rows)
    if args.offline and args.dividend_yield is None:
        try:
            dividend = load_source_cache(
                "dividend_yield", int(config["max_fundamental_age_days"])
            )
        except Exception:
            dividend = fetch_dividend_yield(session, config, None, implied=implied)
    else:
        dividend = fetch_dividend_yield(
            session, config, args.dividend_yield, implied=implied
        )
    if args.offline and args.bond_yield is None:
        bond = load_source_cache("bond_10y", int(config["max_fundamental_age_days"]))
    else:
        bond = fetch_bond_10y(session, config, args.bond_yield)

    metrics = compute_metrics(
        target_rows,
        benchmark_rows,
        dividend,
        bond,
        config,
        target.quote_status,
        tr_target_rows,
        tr_benchmark_rows,
    )
    quality = data_quality(metrics, dividend, bond, config, warnings)
    evaluation = evaluate_rules(metrics, quality, config)
    sources = {
        "target": asdict(target),
        "benchmark": asdict(benchmark),
        "dividend": asdict(dividend),
        "bond": asdict(bond),
        "target_total_return": asdict(target_tr),
        "benchmark_total_return": asdict(benchmark_tr),
    }
    for key in ("target", "benchmark", "target_total_return", "benchmark_total_return"):
        sources[key].pop("rows", None)
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "model_version": config["model_version"],
        "metrics": metrics,
        "quality": quality,
        "evaluation": evaluation,
        "position_advice": position_advice(evaluation, metrics, config),
        "sources": sources,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="自动抓取数据并输出红利低波H30269 V3.2买卖建议"
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
        print(f"红利低波 V3.2：{result['evaluation']['decision']}")
        print(f"交易日：{metrics['trade_date']}  置信度：{result['quality']['confidence']}")
        print(f"原因：{result['evaluation']['reason']}")
        pe_txt = f" | PE分位 {metrics['pe_percentile']:.1f}%" if metrics.get("pe_percentile") is not None else ""
        print(
            f"全收益Beta调整差 {metrics['beta_adjusted_spread_pct']:.2f}% | "
            f"全收益MA250偏离 {metrics['distance_ma250_pct']:.2f}%{pe_txt} | "
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
