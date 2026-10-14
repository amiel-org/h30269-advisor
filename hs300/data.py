# -*- coding: utf-8 -*-
"""Load the frozen snapshot into an aligned Series (no network, no clock)."""
from __future__ import annotations

import bisect
import datetime as dt
import json
from pathlib import Path

from model import Series

SNAPSHOT = Path(__file__).resolve().parent.parent / "raw_data.json"


def _weekend(compact: str) -> bool:
    d = dt.datetime.strptime(compact, "%Y%m%d").date()
    return d.weekday() >= 5


def align(snapshot=None, *, drop_weekends: bool = True,
          drop_missing_pe: bool = True) -> Series:
    """Align 000300 PE with H00300 total return and the 10Y bond series.

    Bond values are forward-filled from the past only (bisect on sorted keys),
    which is the only look-ahead-safe way to use a lower-frequency series.
    """
    src = Path(snapshot) if snapshot else SNAPSHOT
    bundle = json.loads(src.read_text(encoding="utf-8"))
    bond = bundle["bond10y"]
    bond_keys = sorted(bond)
    tr_map = {r["date"]: r["close"] for r in bundle["total_return"]}

    dates, tr, pe, spread = [], [], [], []
    for row in bundle["price"]:
        d = row["date"]
        if drop_weekends and _weekend(d):
            continue
        if drop_missing_pe and not row.get("pe"):
            continue
        if d not in tr_map:
            continue
        idx = bisect.bisect_right(bond_keys, d) - 1
        if idx < 0:
            continue
        y = bond[bond_keys[idx]]
        pe_value = float(row["pe"])
        dates.append(d)
        tr.append(float(tr_map[d]))
        pe.append(pe_value)
        spread.append(100.0 / pe_value - y)
    return Series(dates=dates, tr=tr, pe=pe, spread=spread)


if __name__ == "__main__":
    s = align()
    print(f"aligned {len(s)} rows: {s.dates[0]} -> {s.dates[-1]}")
