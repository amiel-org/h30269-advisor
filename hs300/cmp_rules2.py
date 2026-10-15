"""Compare aggregation rules for the multi-window model."""
import statistics as st
from data import align
from model import Account, metrics

s = align(); n = len(s)
LAD = [(70,0.0),(60,0.125),(50,0.375),(40,0.625),(30,0.875),(0,1.0)]
lad = lambda p: next(w for t,w in LAD if p >= t)
def pct(h,v): return 100.0*sum(1 for x in h if x <= v)/len(h)
def gate(ep): return max(0.0, min(1.0, (ep-30)/40))

rows=[]; ph=[]; sh=[]
for i in range(n):
    if len(ph) < 700:
        rows.append(None)
    else:
        exps=[]; pps=[]; eps=[]
        for w in (None, 2440, 1220):
            p2 = ph if w is None else ph[-w:]
            s2 = sh if w is None else sh[-w:]
            pp = pct(p2, s.pe[i]); ep = pct(s2, s.spread[i])
            pps.append(pp); eps.append(ep); exps.append(min(lad(pp), gate(ep)))
        rows.append({"exp": exps, "pp": pps, "ep": eps})
    ph.append(s.pe[i]); sh.append(s.spread[i])
first = next(i for i,r in enumerate(rows) if r); N = n - first

def build(mode, tol=None):
    out=[]
    for r in rows:
        if not r: out.append(None); continue
        v=r["exp"]; span=max(v)-min(v)
        if mode=="tol_min":    out.append(min(v) if span <= tol*0.125+1e-9 else "HOLD")
        elif mode=="tol_mean": out.append(round(st.mean(v)/0.125)*0.125 if span <= tol*0.125+1e-9 else "HOLD")
        elif mode=="tol_med":  out.append(st.median(v) if span <= tol*0.125+1e-9 else "HOLD")
        elif mode=="avg_pct":
            out.append(min(lad(st.mean(r["pp"])), gate(st.mean(r["ep"]))))
    return out

def run(sig):
    a=Account(); curve=[(s.dates[first],1.0)]; t=None; stk=0; tr=0; expo=[]
    for i in range(first+1, n):
        a.grow(s.tr[i]/s.tr[i-1]-1)
        d=sig[i-1]
        if d=="HOLD" or d is None: t,stk=None,0
        elif d==t: stk+=1
        else: t,stk=d,1
        if t is not None:
            gap=t-a.weight; need=2 if gap<0 else 1
            if stk>=need and abs(gap)>0.05+1e-9:
                step=0.125 if gap>0 else -0.125
                tgt=max(0.0,min(1.0,a.weight+(step if abs(gap)>0.125 else gap)))
                a.rebalance_to(tgt,0.0005); tr+=1
        curve.append((s.dates[i],a.nav)); expo.append(a.weight)
    return metrics(curve), tr, sum(expo)/len(expo)

base=[(s.dates[first],1.0)]+[(s.dates[i],s.tr[i]/s.tr[first]) for i in range(first+1,n)]
bm=metrics(base)
print("buy&hold: CAGR=%.2f%% MaxDD=%.2f%% Sharpe=%.2f" % (bm["cagr_calendar_pct"], bm["max_drawdown_pct"], bm["sharpe"]))
print()
print("%-18s %8s %9s %8s %7s %7s %7s" % ("rule","CAGR","MaxDD","Sharpe","trades","exec%","avgExp"))
for tol in (0,1,2,3):
    for agg in ("tol_min","tol_mean","tol_med"):
        sig=build(agg,tol); m,tr,ae=run(sig)
        act=sum(1 for x in sig[first:] if x!="HOLD" and x is not None)
        print("%-18s %7.2f%% %8.2f%% %8.2f %7d %6.0f%% %6.1f%%" % (
            "%s tol%d" % (agg[4:], tol), m["cagr_calendar_pct"], m["max_drawdown_pct"],
            m["sharpe"], tr, 100*act/N, ae*100))
sig=build("avg_pct"); m,tr,ae=run(sig)
print("%-18s %7.2f%% %8.2f%% %8.2f %7d %6.0f%% %6.1f%%" % (
    "avg_percentile", m["cagr_calendar_pct"], m["max_drawdown_pct"], m["sharpe"], tr, 100, ae*100))
