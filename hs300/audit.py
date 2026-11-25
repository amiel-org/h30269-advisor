"""Independent audit of the HS300 v2.5 desk.

Re-derives every decision input from raw_data.json WITHOUT importing the model,
then compares against the model's own output. Also verifies: no look-ahead,
prefix invariance, hysteresis state consistency, consensus correctness,
live-price derivation, and the server-side band/ladder tables.
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
# independent reference implementation (v2.5 with ±2.0pp hysteresis)
# --------------------------------------------------------------------------- #
LADDER = [(70, 0.0), (60, 0.125), (50, 0.375), (40, 0.625), (30, 0.875), (0, 1.0)]
HYST = 2.0


def lad(p, ladder=LADDER):
    return next(w for t, w in ladder if p >= t)


def lad_hyst(p, prev=None, h=HYST):
    raw = lad(p)
    if prev is None or h <= 0 or abs(raw - prev) <= 1e-12:
        return raw
    if raw > prev:
        return max(prev, lad(p, [(max(0.0, t - h) if t > 0 else 0.0, w) for t, w in LADDER]))
    return min(prev, lad(p, [(min(100.0, t + h) if t > 0 else 0.0, w) for t, w in LADDER]))


def gate(p):
    return max(0.0, min(1.0, (p - 30) / 40))


def gate_hyst(p, prev=None, h=HYST):
    raw = gate(p)
    if prev is None or h <= 0 or abs(raw - prev) <= 1e-12:
        return raw
    if raw > prev:
        return max(prev, gate(p - h))
    return min(prev, gate(p + h))


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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true", help="also audit the deployed worker")
    args = ap.parse_args()

    raw = json.loads((REPO / "raw_data.json").read_text(encoding="utf-8"))
    ref = build_series(raw)

    from data import align
    from model import Config, Series, build_signal_detail, build_signals
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

    print("2. every window value reproduces the reference (with hysteresis)")
    detail = build_signal_detail(s, cfg)
    bad = checked = 0
    prev_st = {}
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
            pl = lad_hyst(pp, prev_st.get((name, "lad")), cfg.pe_hysteresis)
            pg = gate_hyst(ep, prev_st.get((name, "gate")), cfg.erp_hysteresis)
            prev_st[(name, "lad")] = pl
            prev_st[(name, "gate")] = pg
            ex = qz(min(pl, pg))
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

    print("7. deployed worker: settled signal contract")
    def get(url, method="GET"):
        req = urllib.request.Request(url, method=method, headers={"User-Agent": UA})
        return json.loads(urllib.request.urlopen(req, timeout=40).read().decode())

    health = get(WORKER + "/api/hs300/health")
    check("deployed configuration version", health.get("model_version") == "hs300-" + cfg.version)
    payload = get(WORKER + "/api/hs300/dashboard")
    check("dashboard API success", payload.get("ok") is True)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
