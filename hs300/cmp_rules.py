"""Compare consensus rules for practicality AND robustness."""
import statistics as st
from collections import Counter
from data import align
from model import Account, Config, metrics, target_exposure, window_percentile

s = align(); n = len(s); cfg = Config.load()

per = []; ph = []; sh = []
for i in range(n):
    if len(ph) < 700:
        per.append(None)
    else:
        v = []
        for spec in cfg.windows:
            pp = window_percentile(ph, s.pe[i], spec)
            ep = window_percentile(sh, s.spread[i], spec)
            v.append(None if pp is None or ep is None else target_exposure(pp, ep, cfg))
        per.append(v)
    ph.append(s.pe[i]); sh.append(s.spread[i])

first = next(i for i, v in enumerate(per) if v)

def build(mode):
    out = []
    for v in per:
        if not v or None in v:
            out.append(None); continue
        if mode == "strict0":
            out.append(v[0] if len(set(v)) == 1 else "HOLD")
        elif mode == "tol1_conservative":       # gap<=1 step -> weakest; else HOLD
            out.append(min(v) if max(v)-min(v) <= 0.125+1e-9 else "HOLD")
        elif mode == "tol1_median":
            out.append(st.median(v) if max(v)-min(v) <= 0.125+1e-9 else "HOLD")
        elif mode == "majority":                # 2 of 3
            c = Counter(v); top, cnt = c.most_common(1)[0]
            out.append(top if cnt >= 2 else "HOLD")
        elif mode == "median_all":
            out.append(st.median(v))
        elif mode == "two_window":              # full + 10y only
            a, b = v[0], v[1]
            out.append(a if a == b else "HOLD")
    return out

def run(sig, start):
    a = Account(); curve = [(s.dates[start], 1.0)]; t = None; stk = 0; trades = 0
    for i in range(start+1, n):
        a.grow(s.tr[i]/s.tr[i-1]-1)
        d = sig[i-1]
        if d == "HOLD" or d is None: t, stk = None, 0
        elif d == t: stk += 1
        else: t, stk = d, 1
        if t is not None:
            gap = t - a.weight; need = 2 if gap < 0 else 1
            if stk >= need and abs(gap) > 0.05+1e-9:
                step = 0.125 if gap > 0 else -0.125
                tgt = max(0.0, min(1.0, a.weight + (step if abs(gap) > 0.125 else gap)))
                a.rebalance_to(tgt, 0.0005); trades += 1
        curve.append((s.dates[i], a.nav))
    return metrics(curve), trades

base = [(s.dates[first], 1.0)] + [(s.dates[i], s.tr[i]/s.tr[first]) for i in range(first+1, n)]
bm = metrics(base)
print("buy&hold: CAGR={:.2f}% MaxDD={:.2f}% Sharpe={:.2f}".format(
    bm["cagr_calendar_pct"], bm["max_drawdown_pct"], bm["sharpe"]))
print()
print("{:20}{:>9}{:>10}{:>8}{:>8}{:>9}".format("rule", "CAGR", "MaxDD", "Sharpe", "trades", "exec%"))
for mode in ("strict0","tol1_conservative","tol1_median","majority","median_all","two_window"):
    sig = build(mode); m, tr = run(sig, first)
    act = sum(1 for x in sig[first:] if x not in ("HOLD", None))
    print("{:20}{:>8.2f}%{:>9.2f}%{:>8.2f}{:>8}{:>8.0f}%".format(
        mode, m["cagr_calendar_pct"], m["max_drawdown_pct"], m["sharpe"], tr, 100*act/(n-first)))

print()
print("multi-start robustness (CAGR):")
starts = [next(i for i,r in enumerate(s.dates) if r >= d) for d in
          ("20150105","20160104","20170103","20180102","20190102","20200102","20210104","20220104")]
print("{:20}".format("rule"), "".join("{:>7}".format(x[2:4]+"/"+x[4:6]) for x in
      ["201501","201601","201701","201801","201901","202001","202101","202201"]))
for mode in ("strict0","tol1_conservative","majority","median_all","two_window"):
    sig = build(mode); row = []
    for st0 in starts:
        if st0 <= first: row.append(None); continue
        m, _ = run(sig, max(st0, first))
        row.append(m["cagr_calendar_pct"])
    print("{:20}".format(mode), "".join("{:>7}".format("n/a" if v is None else "{:.2f}".format(v)) for v in row))
