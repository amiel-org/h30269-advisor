// HS300 decision model v2.0 -- JavaScript port of hs300/model.py
//
// This is a deliberate re-implementation for the Worker runtime.  It must stay
// byte-for-byte equivalent in RESULTS with the Python reference; that is what
// cloudflare/hs300-parity.mjs verifies against the frozen snapshot.
//
// Design rules (mirrors model.py):
//   * every input used for a decision excludes the current observation;
//   * output exposure is discrete on a fixed grid;
//   * signal at close of day t, filled at close of day t+1;
//   * equity and cash are tracked separately; fees hit NAV.

export const DEFAULT_CONFIG = {
  version: "v2.0",
  allocation: {
    grid: 0.125,
    pe_ladder: [
      { min_pct: 70, exposure: 0.0 },
      { min_pct: 60, exposure: 0.125 },
      { min_pct: 50, exposure: 0.375 },
      { min_pct: 40, exposure: 0.625 },
      { min_pct: 30, exposure: 0.875 },
      { min_pct: 0, exposure: 1.0 },
    ],
    erp_gate: { lo: 30, hi: 70 },
    tolerance_steps: 0,
    tolerance_rule: "conservative",
  },
  indicators: {
    pe_percentile: { min_obs: 700 },
    erp_percentile: { min_obs: 700 },
    // Consensus windows: each computes its own exposure; all must agree.
    percentile_windows: [
      { name: "full", label: "全历史", mode: "expanding", min_obs: 700 },
      { name: "10y", label: "近10年", mode: "rolling", days: 2440, min_obs: 700 },
      { name: "5y", label: "近5年", mode: "rolling", days: 1220, min_obs: 700 },
    ],
  },
  execution: {
    deadband: 0.05,
    fee_one_way: 0.0005,
    cash_yield: 0.0,
    step_size: 0.125,
    buy_confirm_closes: 1,
    sell_confirm_closes: 2,
  },
};

// --------------------------------------------------------------------------- //
// allocation rules -- must match model.py exactly
// --------------------------------------------------------------------------- //
export function ladderExposure(pePct, ladder) {
  for (const { min_pct, exposure } of ladder) {
    if (pePct >= min_pct) return exposure;
  }
  return ladder[ladder.length - 1].exposure;
}

export function erpGate(erpPct, lo, hi) {
  return Math.max(0, Math.min(1, (erpPct - lo) / (hi - lo)));
}

export function quantizeDown(value, grid) {
  if (grid <= 0) return value;
  const steps = Math.floor(value / grid + 1e-9);
  return Math.min(1, Math.max(0, steps * grid));
}

export function targetExposure(pePct, erpPct, cfg = DEFAULT_CONFIG) {
  const lad = ladderExposure(pePct, cfg.allocation.pe_ladder);
  const gate = erpGate(erpPct, cfg.allocation.erp_gate.lo, cfg.allocation.erp_gate.hi);
  return quantizeDown(Math.min(lad, gate), cfg.allocation.grid);
}

export function percentileOfHistory(history, current) {
  if (!history.length) throw new Error("empty history");
  let below = 0;
  for (const x of history) if (x <= current) below += 1;
  return (100 * below) / history.length;
}

// Sentinel: windows disagree -> keep the current position untouched.
export const HOLD = "HOLD";

export function windowSlice(history, spec) {
  if (spec.mode === "rolling" && spec.days > 0) return history.slice(-spec.days);
  return history;
}

export function windowPercentile(history, current, spec) {
  const pool = windowSlice(history, spec);
  const need = spec.min_obs || 1;
  if (pool.length < need) return null;
  return percentileOfHistory(pool, current);
}

export function windowTargets(peHist, erpHist, peNow, erpNow, cfg = DEFAULT_CONFIG) {
  const perWindow = {};
  const values = [];
  for (const spec of cfg.indicators.percentile_windows) {
    const pp = windowPercentile(peHist, peNow, spec);
    const ep = windowPercentile(erpHist, erpNow, spec);
    if (pp === null || ep === null) {
      perWindow[spec.name] = { label: spec.label || spec.name, pePercentile: null, erpPercentile: null, exposure: null };
      continue;
    }
    const expo = targetExposure(pp, ep, cfg);
    values.push(expo);
    perWindow[spec.name] = {
      label: spec.label || spec.name,
      pePercentile: +pp.toFixed(4),
      erpPercentile: +ep.toFixed(4),
      exposure: expo,
    };
  }
  // Tolerance rule: require agreement within `tolerance_steps` grid steps and
  // take the conservative end of the cluster (three windows rarely coincide
  // exactly outside extremes).
  const grid = cfg.allocation.grid;
  const tol = (cfg.allocation.tolerance_steps || 0) * grid;
  const span = values.length ? Math.max(...values) - Math.min(...values) : null;
  const within = values.length > 0 && span <= tol + 1e-9;
  const chosen = within
    ? (cfg.allocation.tolerance_rule === "conservative" ? Math.min(...values) : values[0])
    : HOLD;
  return {
    windows: perWindow,
    agreed: within,
    span,
    tolerance: tol,
    vote: values.length ? Math.min(...values) : null,
    consensus_exposure: chosen,
  };
}

// --------------------------------------------------------------------------- //
// signal series
// --------------------------------------------------------------------------- //
export function buildSignals(series, cfg = DEFAULT_CONFIG) {
  const minPe = cfg.indicators.pe_percentile.min_obs;
  const minErp = cfg.indicators.erp_percentile.min_obs;
  const out = [];
  const peHist = [];
  const erpHist = [];
  for (let i = 0; i < series.dates.length; i += 1) {
    if (peHist.length < minPe || erpHist.length < minErp) {
      out.push(null);
    } else {
      const info = windowTargets(peHist, erpHist, series.pe[i], series.spread[i], cfg);
      out.push(info.consensus_exposure);
    }
    peHist.push(series.pe[i]);
    erpHist.push(series.spread[i]);
  }
  return out;
}

// Same walk as buildSignals but keeps each window's numbers for the UI.
export function buildSignalDetail(series, cfg = DEFAULT_CONFIG) {
  const minPe = cfg.indicators.pe_percentile.min_obs;
  const minErp = cfg.indicators.erp_percentile.min_obs;
  const out = [];
  const peHist = [];
  const erpHist = [];
  for (let i = 0; i < series.dates.length; i += 1) {
    if (peHist.length < minPe || erpHist.length < minErp) {
      out.push(null);
    } else {
      out.push(windowTargets(peHist, erpHist, series.pe[i], series.spread[i], cfg));
    }
    peHist.push(series.pe[i]);
    erpHist.push(series.spread[i]);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// account arithmetic
// --------------------------------------------------------------------------- //
export function accountWeight(acct) {
  const nav = acct.equity + acct.cash;
  return nav ? acct.equity / nav : 0;
}

export function rebalanceTo(acct, target, fee) {
  const nav = acct.equity + acct.cash;
  if (nav <= 0) return { notional: 0, tradedFraction: 0 };
  let notional;
  if (target * nav >= acct.equity) {
    notional = (target * nav - acct.equity) / (1 + fee * target);
  } else {
    notional = (target * nav - acct.equity) / (1 - fee * target);
  }
  const commission = Math.abs(notional) * fee;
  acct.equity += notional;
  acct.cash -= notional + commission;
  if (acct.cash < -1e-9 || acct.equity < -1e-9) throw new Error("account went negative");
  return { notional, tradedFraction: Math.abs(notional) / nav };
}

// --------------------------------------------------------------------------- //
// execution state machine
// --------------------------------------------------------------------------- //
export function runBacktest(series, cfg = DEFAULT_CONFIG, signals = null, lag = 1) {
  const sig = signals || buildSignals(series, cfg);
  const n = series.dates.length;
  let first = -1;
  for (let i = 0; i < n; i += 1) if (sig[i] !== null) { first = i; break; }
  const empty = { curve: [], steps: [], exposures: [], turnover: 0, blockedDays: 0 };
  if (first < 0 || first + 1 >= n) return empty;

  const acct = { equity: 0, cash: 1 };
  const curve = [[series.dates[first], 1]];
  const exposures = [0];
  const steps = [];
  let turnover = 0;
  let blockedDays = 0;
  let prevTarget = null;
  let streak = 0;

  for (let i = first + 1; i < n; i += 1) {
    // (1) earn the interval (i-1, i] with the weight held entering it
    const ret = series.tr[i] / series.tr[i - 1] - 1;
    acct.equity *= 1 + ret;
    acct.cash *= 1 + cfg.execution.cash_yield;

    // (2) confirmation on the target known at close of day i
    const src = i - lag;
    let desired = src >= first ? sig[src] : null;
    // HOLD = windows disagree -> take no action at all; the position stays put
    // and no confirmation streak is carried over.
    if (desired === HOLD) desired = null;
    if (desired === null || desired === undefined) {
      prevTarget = null; streak = 0;
    } else if (desired === prevTarget) {
      streak += 1;
    } else {
      prevTarget = desired; streak = 1;
    }

    // (3) fill at close of day i
    if (prevTarget !== null) {
      const gap = prevTarget - accountWeight(acct);
      const needed = gap < 0 ? cfg.execution.sell_confirm_closes : cfg.execution.buy_confirm_closes;
      if (streak >= needed && Math.abs(gap) > cfg.execution.deadband + 1e-9) {
        const navBefore = acct.equity + acct.cash;
        const wBefore = accountWeight(acct);
        const move = gap > 0 ? cfg.execution.step_size : -cfg.execution.step_size;
        let intend = wBefore + (Math.abs(gap) > cfg.execution.step_size ? move : gap);
        intend = Math.min(1, Math.max(0, intend));
        const { tradedFraction } = rebalanceTo(acct, intend, cfg.execution.fee_one_way);
        turnover += tradedFraction;
        steps.push({
          date: series.dates[i], navBefore, weightBefore: wBefore,
          intendAfter: intend, weightAfter: accountWeight(acct),
          tradedFraction, target: prevTarget, streak,
          kind: intend > wBefore ? "buy" : "sell",
        });
      } else if (streak >= needed) {
        blockedDays += 1;
      }
    }

    exposures.push(accountWeight(acct));
    curve.push([series.dates[i], acct.equity + acct.cash]);
  }
  return { curve, steps, exposures, turnover, blockedDays };
}

// --------------------------------------------------------------------------- //
// metrics
// --------------------------------------------------------------------------- //
export function metrics(curve, periodsPerYear = 252) {
  if (!curve.length) return {};
  const values = curve.map(([, v]) => v);
  const d0 = new Date(`${curve[0][0].slice(0, 4)}-${curve[0][0].slice(4, 6)}-${curve[0][0].slice(6, 8)}`);
  const d1 = new Date(`${curve[curve.length - 1][0].slice(0, 4)}-${curve[curve.length - 1][0].slice(4, 6)}-${curve[curve.length - 1][0].slice(6, 8)}`);
  const years = (d1 - d0) / (365.25 * 24 * 3600 * 1000);
  let peak = values[0];
  let mdd = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    mdd = Math.min(mdd, v / peak - 1);
  }
  const rets = [];
  for (let i = 1; i < values.length; i += 1) rets.push(values[i] / values[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / rets.length);
  return {
    start: curve[0][0], end: curve[curve.length - 1][0],
    yearsCalendar: +years.toFixed(4),
    cagrCalendarPct: years > 0 ? +((values[values.length - 1] ** (1 / years) - 1) * 100).toFixed(4) : null,
    cagr252Pct: +((values[values.length - 1] ** (periodsPerYear / values.length) - 1) * 100).toFixed(4),
    maxDrawdownPct: +(mdd * 100).toFixed(4),
    sharpe: sd > 0 ? +((mean / sd) * Math.sqrt(periodsPerYear)).toFixed(4) : null,
    endNav: +values[values.length - 1].toFixed(6),
    days: values.length,
  };
}
