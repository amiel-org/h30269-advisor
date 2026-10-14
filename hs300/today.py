# -*- coding: utf-8 -*-
"""Append TODAY's close (if the official feed has it) and re-evaluate.

Distinguishes clearly between:
  * confirmed official daily bars,
  * a provisional appended bar (today, PE derived from the level change),
so a decision is never made on a silently stale or silently estimated input.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import requests

from data import align, SNAPSHOT
from model import (Config, Series, ladder_exposure, percentile_of_history,
                   target_exposure)

CFG = Config.load()
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
HDR = {"User-Agent": UA, "Referer": "https://www.csindex.com.cn/zh-CN/indices/index-detail/000300"}


def fetch_csi(code, start, end):
    r = requests.get("https://www.csindex.com.cn/csindex-home/perf/index-perf",
                     params={"indexCode": code, "startDate": start, "endDate": end},
                     headers=HDR, timeout=25)
    r.raise_for_status()
    return r.json().get("data") or []


def fetch_bond_latest():
    r = requests.get("https://datacenter-web.eastmoney.com/api/data/v1/get",
                     params={"reportName": "RPTA_WEB_TREASURYYIELD", "columns": "ALL",
                             "pageSize": 5, "pageNumber": 1,
                             "sortColumns": "SOLAR_DATE", "sortTypes": -1},
                     headers={"User-Agent": UA}, timeout=25)
    r.raise_for_status()
    for row in (r.json().get("result") or {}).get("data") or []:
        v = row.get("EMM00166466")
        if v:
            return row["SOLAR_DATE"][:10].replace("-", ""), float(v)
    return None, None


def main() -> int:
    series = align()
    bundle = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    last_date = series.dates[-1]

    rows_000300 = fetch_csi("000300", "20261001", "20261031")
    rows_tr = fetch_csi("H00300", "20261001", "20261031")
    tr_by_date = {r["tradeDate"]: float(r["close"]) for r in rows_tr if r.get("close")}
    px_by_date = {r["tradeDate"]: float(r["close"]) for r in rows_000300 if r.get("close")}
    pe_by_date = {r["tradeDate"]: (float(r["peg"]) if r.get("peg") else None) for r in rows_000300}

    new_dates = sorted(d for d in tr_by_date if d > last_date)
    print(f"frozen snapshot last = {last_date}")
    print(f"newer official bars  = {new_dates if new_dates else '(none)'}")

    if not new_dates:
        print("No new official bar; evaluating on the frozen snapshot.")
    else:
        bond_date, bond_val = fetch_bond_latest()
        print(f"latest bond {bond_date} = {bond_val}")
        for d in new_dates:
            pe = pe_by_date.get(d)
            src = "official"
            if pe is None:
                # derive PE from the level change relative to the last known PE
                pe = series.pe[-1] * (tr_by_date[d] / series.tr[-1])
                src = "derived from level change"
            y = bond_val if bond_val is not None else series.spread[-1] + series.pe[-1] ** 0
            spread = 100.0 / pe - (bond_val if bond_val is not None else (100.0 / series.pe[-1] - series.spread[-1]))
            series.dates.append(d)
            series.tr.append(tr_by_date[d])
            series.pe.append(pe)
            series.spread.append(spread)
            print(f"  appended {d}: PE={pe:.4f} ({src})  H00300={tr_by_date[d]:.2f}")

    last = len(series) - 1
    pe_pct = percentile_of_history(series.pe[:last], series.pe[last])
    erp_pct = percentile_of_history(series.spread[:last], series.spread[last])
    target = target_exposure(pe_pct, erp_pct, CFG)
    ladder_val = ladder_exposure(pe_pct, CFG.ladder)

    px_now = px_by_date.get(series.dates[last])
    if px_now is None:
        px_now = bundle["price"][-1]["close"] * (series.tr[last] / series.tr[-2])

    print()
    print("=" * 76)
    print(f"EVALUATION at {series.dates[last]}")
    print("=" * 76)
    print(f"  000300 (price)   = {px_now:.2f}")
    print(f"  H00300 (total)   = {series.tr[last]:.2f}")
    print(f"  PE               = {series.pe[last]:.2f}   PE分位 = {pe_pct:.1f}%")
    print(f"  ERP              = {series.spread[last]:.2f}%   ERP分位 = {erp_pct:.1f}%")
    print(f"  ladder exposure  = {ladder_val:.1%}")
    print(f"  >>> TARGET       = {target:.1%}")
    print()
    print("  NOTE: this is a model target exposure for the STRATEGY BUDGET,")
    print("        not an instruction to buy that share of total household assets,")
    print("        and not a same-day fill price.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
