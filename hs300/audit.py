"""Independent audit of the HS300 desk.

Re-derives every decision input from raw_data.json WITHOUT importing the model,
then compares against the model's own output.  Also verifies: no look-ahead,
prefix invariance, consensus correctness, live-price derivation, and the
server-side band/ladder tables.

Run:  python hs300/audit.py            (offline checks only)
      python hs300/audit.py --live     (also checks the deployed worker)
"""
from __future__ import annotations

import argparse
import bisect
import copy
import datetime as dt
import json
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(HERE))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "Chrome/126 Safari/537.36")
WORKER = "https://h30269-hs300.anyongliang027.workers.dev"

failures = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"   {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(label)


# --------------------------------------------------------------------------- #
# independent reference implementation
# --------------------------------------------------------------------------- #
LADDER = [(70, 0.0), (60, 0.125), (50, 0.375), (40, 0.625), (30, 0.875), (0, 1.0)]


def lad(p):
    return next(w for t, w in LADDER if p >= t)


def gate(p):
    return max(0.0, min(1.0, (p - 30) / 40))


def qz(v, g=0.125):
    return min(1.0, max(0.0, int(v / g + 1e-9) * g))


def pctf(h, v):
    return 100.0 * sum(1 for x in h if x <= v) / len(h)


def roll(h, d):
    return h[-d:] if d > 0 else h


WINDOWS = [("full", 0, 700), ("10y", 2440, 700), ("5y", 1220, 700)]


def build_series(raw):
    bk = sorted(raw["bond10y"])
    trmap = {r["date"]: r["close"] for r in raw["total_return"]}
    out = []
    for r in raw["price"]:
        d = r["date"]
        if dt.datetime.strptime(d, "%Y%m%d").date().weekday() >= 5:
            continue
        if not r.get("pe") or d not in trmap:
            continue
        i = bisect.bisect_right(bk, d) - 1
        if i < 0:
            continue
        out.append({"date": d, "pe": float(r["pe"]), "tr": trmap[d],
                    "spread": 100.0 / float(r["pe"]) - raw["bond10y"][bk[i]]})
    return out


# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="also audit the deployed worker")
    args = ap.parse_args()

    raw = json.loads((REPO / "raw_data.json").read_text(encoding="utf-8"))
    ref = build_series(raw)

    from data import align
    from model import (Config, Series, build_signal_detail, build_signals,
                       target_exposure, window_percentile)
    cfg = Config.load()
    s = align()

    print("1. aligned series vs independent rebuild")
    check("row count", len(s) == len(ref), f"{len(s)} vs {len(ref)}")
    pe_ok = tr_ok = sp_ok = date_ok = True
    for i, a in enumerate(ref[:len(s)]):
        date_ok &= a["date"] == s.dates[i]
        pe_ok &= abs(a["pe"] - s.pe[i]) < 1e-12
        tr_ok &= abs(a["tr"] - s.tr[i]) < 1e-9
        sp_ok &= abs(a["spread"] - s.spread[i]) < 1e-9
    check("dates", date_ok)
    check("pe", pe_ok)
    check("total return", tr_ok)
    check("spread", sp_ok)

    print("2. every window value reproduces the reference")
    detail = build_signal_detail(s, cfg)
    bad = checked = 0
    for i, row in enumerate(detail):
        if row is None:
            continue
        for name, days, minobs in WINDOWS:
            w = row["windows"][name]
            ph = roll(s.pe[:i], days)
            sh = roll(s.spread[:i], days)
            if len(ph) < minobs or len(sh) < minobs:
                if w["pe_percentile"] is not None:
                    bad += 1
                continue
            pp = pctf(ph, s.pe[i])
            ep = pctf(sh, s.spread[i])
            ex = qz(min(lad(pp), gate(ep)))
            checked += 1
            if abs(w["pe_percentile"] - pp) > 5e-4 or abs(w["exposure"] - ex) > 1e-12:
                bad += 1
    check("window recomputation", bad == 0, f"{checked} values, {bad} bad")

    print("3. consensus rule")
    bad = 0
    holds = total = 0
    for row in detail:
        if row is None:
            continue
        vals = [row["windows"][n]["exposure"] for n, _, _ in WINDOWS
                if row["windows"][n]["exposure"] is not None]
        if not vals:
            continue
        total += 1
        agree = len(set(vals)) == 1
        if agree != row["agreed"]:
            bad += 1
        elif agree and abs(row["consensus_exposure"] - vals[0]) > 1e-12:
            bad += 1
        elif not agree and row["consensus_exposure"] != "HOLD":
            bad += 1
        if not agree:
            holds += 1
    check("consensus matches strict rule", bad == 0, f"{bad} mismatches")
    print(f"       ({holds}/{total} days are HOLD = {100*holds/max(1,total):.1f}%)")

    print("4. no look-ahead")
    s2 = copy.deepcopy(s)
    s2.pe[-1] *= 3.0
    s2.spread[-1] *= 3.0
    s2.tr[-1] *= 2.0
    d2 = build_signal_detail(s2, cfg)
    moved = 0
    for i in range(len(s) - 1):
        a, b = detail[i], d2[i]
        if (a is None) != (b is None):
            moved += 1
        elif a is not None and a["consensus_exposure"] != b["consensus_exposure"]:
            moved += 1
    check("mutating the last bar moves no past signal", moved == 0, f"{moved} moved")

    print("5. prefix invariance")
    full = build_signals(s, cfg)
    head_s = Series(dates=s.dates[:2000], tr=s.tr[:2000], pe=s.pe[:2000], spread=s.spread[:2000])
    check("truncating the future changes nothing",
          build_signals(head_s, cfg) == full[:2000])

    print("6. ladder / target monotonicity")
    mono = all(qz(min(lad(p), 1.0)) >= qz(min(lad(p + 5), 1.0)) for p in range(0, 100))
    check("target is non-increasing in PE percentile", mono)

    if not args.live:
        print()
        print("offline audit complete:", "ALL PASS" if not failures else f"{len(failures)} FAILED")
        return 1 if failures else 0

    # ------------------------------------------------------------------ #
    print("7. deployed worker: live price derivation")
    def get(url, method="GET"):
        r = urllib.request.Request(url, method=method,
                                   headers={"User-Agent": UA,
                                            "Referer": "https://www.csindex.com.cn/"})
        return json.loads(urllib.request.urlopen(r, timeout=240).read().decode())

    HDR = {"User-Agent": UA,
           "Referer": "https://www.csindex.com.cn/zh-CN/indices/index-detail/000300"}

    def csi(url):
        return json.loads(urllib.request.urlopen(
            urllib.request.Request(url, headers=HDR), timeout=30).read().decode())

    daily = csi("https://www.csindex.com.cn/csindex-home/perf/index-perf"
                "?indexCode=000300&startDate=20260901&endDate=20261231")["data"]
    trd = csi("https://www.csindex.com.cn/csindex-home/perf/index-perf"
              "?indexCode=H00300&startDate=20260901&endDate=20261231")["data"]
    live = csi("https://www.csindex.com.cn/csindex-home/perf/index-perf-oneday"
               "?indexCode=000300")["data"].get("intraDayHeader") or {}

    settled_date = str(daily[-1]["tradeDate"])
    settled_px = float(daily[-1]["close"])
    settled_pe = float(daily[-1]["peg"])
    tr_settled = float(trd[-1]["close"])
    live_px = float(live.get("current") or 0)
    live_date = str(live.get("tradeDate") or "").replace("-", "")

    api = get(WORKER + "/api/hs300/dashboard")["data"]
    if live_px <= 0 or live_date <= settled_date:
        print("       (market closed; checking settled fallback)")
        check("worker falls back to the settled close",
              api["live"] is False and api["price_asof"] == settled_date)
    else:
        ratio = live_px / settled_px
        check("as_of == live date", api["as_of"] == live_date,
              f"{api['as_of']} vs {live_date}")
        check("price_asof == settled date", api["price_asof"] == settled_date)
        check("live flag", api["live"] is True)
        i = api["intraday"] or {}
        check("ratio matches 000300 move", abs(i.get("ratio", 0) - ratio) < 1e-6)
        check("H00300 scaled correctly",
              abs(i.get("tr_level", 0) - tr_settled * ratio) < 0.05)
        check("PE scaled correctly",
              abs(api["pe"] - settled_pe * ratio) < 1e-4)
        check("price shown is the live price",
              abs(api["price_index"]["level"] - live_px) < 1e-6)
        check("total_return_index == scaled level",
              abs(api["total_return_index"]["level"] - i.get("tr_level", 0)) < 0.05)

    print("8. deployed worker: ladder table is server-side and monotone")
    rows = api.get("ladder") or []
    check("ladder present", len(rows) == 6, f"got {len(rows)}")
    if len(rows) == 6:
        check("targets rise as bands get cheaper",
              all(rows[i]["target"] < rows[i + 1]["target"] for i in range(5)))
        check("top band is empty", rows[0]["target"] == 0.0)
        check("bottom band is full", rows[-1]["target"] == 1.0)
        ok = True
        for name, _, _ in WINDOWS:
            for i in range(len(rows) - 1):
                a, b = rows[i]["levels"].get(name), rows[i + 1]["levels"].get(name)
                if a is None or b is None:
                    continue
                if b > a + 1e-6:
                    ok = False
        check("price levels fall as bands get cheaper", ok)

    print("9. deployed worker: buy/sell triggers point the right way")
    bnd = api.get("boundaries") or []
    cur = api["pe_percentile"]
    buys = sorted([b for b in bnd if b["pct"] < cur], key=lambda z: -z["pct"])
    sells = sorted([b for b in bnd if b["pct"] > cur], key=lambda z: z["pct"])
    idx = next((i for i, r in enumerate(rows)
                if r["lo"] is not None and cur >= r["lo"]), None)
    if buys and idx is not None:
        check("next buy raises the target", buys[0]["target_below"] > rows[idx]["target"])
        check("full-history buy line is below the current price",
              buys[0]["levels"]["full"] < api["price_index"]["level"])
    if sells and idx is not None:
        check("next sell lowers the target", sells[0]["target_above"] < rows[idx]["target"])
        check("full-history sell line is above the current price",
              sells[0]["levels"]["full"] > api["price_index"]["level"])

    # Cross-window divergence is INFORMATION, not an error: a window that finds
    # the market cheap legitimately has its buy line above the current price.
    # Report it so it is visible rather than asserted away.
    if buys:
        above = [k for k, v in buys[0]["levels"].items()
                 if v is not None and v >= api["price_index"]["level"]]
        print(f"       (buy line already above spot in window(s): {above or 'none'}"
              f" -- normal when that window judges the market cheap)")
    if sells:
        below = [k for k, v in sells[0]["levels"].items()
                 if v is not None and v <= api["price_index"]["level"]]
        print(f"       (sell line already below spot in window(s): {below or 'none'}"
              f" -- normal when that window judges the market expensive)")

    print()
    print("full audit complete:", "ALL PASS" if not failures else f"{len(failures)} FAILED")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
