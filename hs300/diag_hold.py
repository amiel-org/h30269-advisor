"""HOLD semantics comparison for the multi-window consensus model."""
from data import align
from model import (HOLD, Account, Config, metrics, target_exposure,
                   window_percentile)

cfg = Config.load()
s = align()
n = len(s)

# Pre-compute the raw consensus series (HOLD where windows disagree).
raw = []
pe_hist, erp_hist = [], []
for i in range(n):
    if i < 700:
        raw.append(None)
    else:
        vals = []
        for spec in cfg.windows:
            pp = window_percentile(pe_hist, s.pe[i], spec)
            ep = window_percentile(erp_hist, s.spread[i], spec)
            vals.append(None if (pp is None or ep is None) else target_exposure(pp, ep, cfg))
        if any(v is None for v in vals):
            raw.append(None)
        elif len(set(vals)) == 1:
            raw.append(vals[0])
        else:
            raw.append(HOLD)
    pe_hist.append(s.pe[i])
    erp_hist.append(s.spread[i])

first = next(i for i, x in enumerate(raw) if x is not None)


def simulate(series_of_targets, lag=1, band=0.05, fee=0.0005):
    acct = Account()
    curve = [(s.dates[first], 1.0)]
    prev_t, streak = None, 0
    for i in range(first + 1, n):
        acct.grow(s.tr[i] / s.tr[i - 1] - 1)
        d = series_of_targets[i - lag]
        if d is None:
            prev_t, streak = None, 0
        elif d == prev_t:
            streak += 1
        else:
            prev_t, streak = d, 1
        if prev_t is not None:
            gap = prev_t - acct.weight
            need = cfg.sell_confirm if gap < 0 else cfg.buy_confirm
            if streak >= need and abs(gap) > band + 1e-9:
                step = cfg.step if gap > 0 else -cfg.step
                tgt = max(0.0, min(1.0, acct.weight + (step if abs(gap) > cfg.step else gap)))
                acct.rebalance_to(tgt, fee)
        curve.append((s.dates[i], acct.nav))
    return curve


def apply_hold(mode):
    """Turn the raw series into an effective target series per HOLD policy."""
    out = []
    last = None
    for x in raw:
        if x == HOLD:
            if mode == "hold":      # keep last target, i.e. do nothing
                out.append(last)
            else:                    # reset / skip
                out.append(None)
        else:
            out.append(x)
            if x is not None:
                last = x
    return out


base = [(s.dates[first], 1.0)] + [(s.dates[i], s.tr[i] / s.tr[first]) for i in range(first + 1, n)]
bm = metrics(base)

print("=" * 80)
print("HOLD semantics (same consensus framework)")
print("=" * 80)
print("  {:12}{:>10}{:>11}{:>10}".format("policy", "CAGR", "MaxDD", "Sharpe"))
m_hold = metrics(simulate(apply_hold("hold")))
print("  {:12}{:>9.2f}%{:>10.2f}%{:>10.2f}".format("hold", m_hold["cagr_calendar_pct"],
                                                    m_hold["max_drawdown_pct"], m_hold["sharpe"]))
m_reset = metrics(simulate(apply_hold("reset")))
print("  {:12}{:>9.2f}%{:>10.2f}%{:>10.2f}".format("flat(cash)", m_reset["cagr_calendar_pct"],
                                                     m_reset["max_drawdown_pct"], m_reset["sharpe"]))
print("  {:12}{:>9.2f}%{:>10.2f}%{:>10.2f}".format("buy&hold", bm["cagr_calendar_pct"],
                                                    bm["max_drawdown_pct"], bm["sharpe"]))

# single full-history reference
single = []
pe_hist, erp_hist = [], []
for i in range(n):
    if i < 700:
        single.append(None)
    else:
        spec = cfg.windows[0]
        pp = window_percentile(pe_hist, s.pe[i], spec)
        ep = window_percentile(erp_hist, s.spread[i], spec)
        single.append(target_exposure(pp, ep, cfg))
    pe_hist.append(s.pe[i])
    erp_hist.append(s.spread[i])
m_single = metrics(simulate(single))
print()
print("  {:12}{:>9.2f}%{:>10.2f}%{:>10.2f}".format("single-full", m_single["cagr_calendar_pct"],
                                                     m_single["max_drawdown_pct"], m_single["sharpe"]))

print()
print("  HOLD 天数 =", sum(1 for x in raw if x == HOLD), "/", n - first)
