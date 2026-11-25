// HS300 decision model -- JavaScript port of hs300/model.py
//
// Must stay byte-for-byte equivalent in RESULTS with the Python reference;
// cloudflare/hs300-parity.mjs verifies every signal and trade step.
//
// Design rules (v2.5, mirrors model.py):
//   * historical percentile pools exclude the current observation;
//   * per-window PE ladder & ERP gate apply symmetric percentile hysteresis;
//   * output exposure is discrete on a fixed grid;
//   * signal at close of day t, filled at close of day t+1;
//   * equity and cash are tracked separately with calendar-day ETF fee & cash yield.

import modelConfig from "../../hs300/config.json" with { type: "json" };

export const DEFAULT_CONFIG = modelConfig;

// --------------------------------------------------------------------------- //
// allocation rules -- must match model.py exactly
// --------------------------------------------------------------------------- //
export function ladderExposure(pePct, ladder) {
  for (const { min_pct, exposure } of ladder) {
    if (pePct >= min_pct) return exposure;
  }
  return ladder[ladder.length - 1].exposure;
}

export function ladderWithHysteresis(pePct, ladder, prevExposure = null, hysteresisPp = 0) {
  const raw = ladderExposure(pePct, ladder);
  if (prevExposure === null || prevExposure === undefined || !(hysteresisPp > 0) || Math.abs(raw - prevExposure) <= 1e-12) {
    return raw;
  }
  if (raw > prevExposure) {
    const shifted = ladder.map(({ min_pct, exposure }) => ({
      min_pct: min_pct > 0 ? Math.max(0, min_pct - hysteresisPp) : 0,
      exposure,
    }));
    return Math.max(prevExposure, ladderExposure(pePct, shifted));
  }
  const shifted = ladder.map(({ min_pct, exposure }) => ({
    min_pct: min_pct > 0 ? Math.min(100, min_pct + hysteresisPp) : 0,
    exposure,
  }));
  return Math.min(prevExposure, ladderExposure(pePct, shifted));
}

export function erpGate(erpPct, lo, hi) {
  return Math.max(0, Math.min(1, (erpPct - lo) / (hi - lo)));
}

export function erpGateWithHysteresis(erpPct, lo, hi, prevGate = null, hysteresisPp = 0) {
  const raw = erpGate(erpPct, lo, hi);
  if (prevGate === null || prevGate === undefined || !(hysteresisPp > 0) || Math.abs(raw - prevGate) <= 1e-12) {
    return raw;
  }
  if (raw > prevGate) return Math.max(prevGate, erpGate(erpPct - hysteresisPp, lo, hi));
  return Math.min(prevGate, erpGate(erpPct + hysteresisPp, lo, hi));
}

export function quantizeDown(value, grid) {
  if (grid <= 0) return value;
  const steps = Math.floor(value / grid + 1e-9);
  return Math.min(1, Math.max(0, steps * grid));
}

export function targetExposureStateful(pePct, erpPct, cfg = DEFAULT_CONFIG, prevState = null) {
  if (![pePct, erpPct].every(Number.isFinite)) throw new Error("invalid percentile");
  const hPe = cfg.allocation.hysteresis?.pe_percentile_pp || 0;
  const hErp = cfg.allocation.hysteresis?.erp_percentile_pp || 0;
  const lad = ladderWithHysteresis(pePct, cfg.allocation.pe_ladder, prevState?.pe_cap ?? null, hPe);
  const gate = erpGateWithHysteresis(erpPct, cfg.allocation.erp_gate.lo, cfg.allocation.erp_gate.hi, prevState?.erp_cap ?? null, hErp);
  return { exposure: quantizeDown(Math.min(lad, gate), cfg.allocation.grid), pe_cap: lad, erp_cap: gate };
}

export function targetExposure(pePct, erpPct, cfg = DEFAULT_CONFIG) {
  return targetExposureStateful(pePct, erpPct, cfg, null).exposure;
}

export function percentileOfHistory(history, current) {
  if (!history.length) throw new Error("empty history");
  if (!Number.isFinite(current)) throw new Error("invalid percentile input");
  let below = 0;
  for (const x of history) if (x <= current) below += 1;
  return (100 * below) / history.length;
}

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

export function windowTargets(peHist, erpHist, peNow, erpNow, cfg = DEFAULT_CONFIG, prevStates = null) {
  const perWindow = {};
  const nextStates = {};
  const values = [];
  for (const spec of cfg.indicators.percentile_windows) {
    const pp = windowPercentile(peHist, peNow, spec);
    const ep = windowPercentile(erpHist, erpNow, spec);
    if (pp === null || ep === null) {
      perWindow[spec.name] = {
        label: spec.label || spec.name,
        pePercentile: null, erpPercentile: null, exposure: null, peCap: null, erpCap: null,
      };
      nextStates[spec.name] = prevStates?.[spec.name] ?? null;
      continue;
    }
    const st = targetExposureStateful(pp, ep, cfg, prevStates?.[spec.name] ?? null);
    values.push(st.exposure);
    nextStates[spec.name] = { pe_cap: st.pe_cap, erp_cap: st.erp_cap };
    perWindow[spec.name] = {
      label: spec.label || spec.name,
      pePercentile: +pp.toFixed(4),
      erpPercentile: +ep.toFixed(4),
      exposure: st.exposure,
      peCap: st.pe_cap,
      erpCap: +st.erp_cap.toFixed(6),
    };
  }
  const grid = cfg.allocation.grid;
  const tol = (cfg.allocation.tolerance_steps || 0) * grid;
  const span = values.length ? Math.max(...values) - Math.min(...values) : null;
  const within = values.length === cfg.indicators.percentile_windows.length && values.length > 0 && span <= tol + 1e-9;
  const chosen = within
    ? (cfg.allocation.tolerance_rule === "conservative" ? Math.min(...values) : values[0])
    : HOLD;
  return {
    windows: perWindow,
    agreed: within,
    span,
    tolerance: tol,
    vote: values.length ? Math.min(...values) : null,
    min_exposure: values.length ? Math.min(...values) : null,
    max_exposure: values.length ? Math.max(...values) : null,
    consensus_exposure: chosen,
    next_state: nextStates,
  };
}

// --------------------------------------------------------------------------- //
// signal series
// --------------------------------------------------------------------------- //
export function buildSignalDetail(series, cfg = DEFAULT_CONFIG) {
  const minPe = cfg.indicators.pe_percentile.min_obs;
  const minErp = cfg.indicators.erp_percentile.min_obs;
  const out = [];
  const peHist = [];
  const erpHist = [];
  let winState = null;
  for (let i = 0; i < series.dates.length; i += 1) {
    if (peHist.length < minPe || erpHist.length < minErp) {
      out.push(null);
    } else {
      const info = windowTargets(peHist, erpHist, series.pe[i], series.spread[i], cfg, winState);
      info.prev_state = winState;
      winState = info.next_state;
      out.push(info);
    }
    peHist.push(series.pe[i]);
    erpHist.push(series.spread[i]);
  }
  return out;
}

export function buildSignals(series, cfg = DEFAULT_CONFIG) {
  return buildSignalDetail(series, cfg).map((row) => (row ? row.consensus_exposure : null));
}

export function windowStateAt(series, endExclusive, cfg = DEFAULT_CONFIG) {
  const minPe = cfg.indicators.pe_percentile.min_obs;
  const minErp = cfg.indicators.erp_percentile.min_obs;
  const peHist = [];
  const erpHist = [];
  let winState = null;
  const limit = Math.min(Math.max(0, endExclusive), series.dates.length);
  for (let i = 0; i < limit; i += 1) {
    if (peHist.length >= minPe && erpHist.length >= minErp) {
      winState = windowTargets(peHist, erpHist, series.pe[i], series.spread[i], cfg, winState).next_state;
    }
    peHist.push(series.pe[i]);
    erpHist.push(series.spread[i]);
  }
  return winState;
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

function calendarDays(d0Compact, d1Compact) {
  const t0 = Date.parse(`${d0Compact.slice(0, 4)}-${d0Compact.slice(4, 6)}-${d0Compact.slice(6, 8)}T00:00:00Z`);
  const t1 = Date.parse(`${d1Compact.slice(0, 4)}-${d1Compact.slice(4, 6)}-${d1Compact.slice(6, 8)}T00:00:00Z`);
  return Math.max(1, Math.round((t1 - t0) / 86400000));
}

export function intervalReturns(trPrev, trCurr, calDays, cfg = DEFAULT_CONFIG) {
  const rawEq = trCurr / trPrev - 1;
  const etfFee = cfg.execution.etf_fee_annual || 0;
  const etfDrag = etfFee > 0 ? (1 - etfFee) ** (calDays / 365.25) : 1;
  const netEq = (1 + rawEq) * etfDrag - 1;
  const cashAnnual = cfg.execution.cash_yield_annual || 0;
  const cashRet = cashAnnual > 0
    ? ((1 + cashAnnual) ** (calDays / 365.25) - 1)
    : (cfg.execution.cash_yield || 0);
  return { eqRet: netEq, cashRet };
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
    const calDays = calendarDays(series.dates[i - 1], series.dates[i]);
    const { eqRet, cashRet } = intervalReturns(series.tr[i - 1], series.tr[i], calDays, cfg);
    acct.equity *= 1 + eqRet;
    acct.cash *= 1 + cashRet;

    // (2) confirmation on the target known at close of day i
    const src = i - lag;
    let desired = src >= first ? sig[src] : null;
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
export function metrics(curve, periodsPerYear = 252, riskFreeAnnual = 0) {
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
  const rfDaily = riskFreeAnnual > 0 ? ((1 + riskFreeAnnual) ** (1 / periodsPerYear) - 1) : 0;
  const exRets = rets.map((r) => r - rfDaily);
  const mean = exRets.length ? exRets.reduce((a, b) => a + b, 0) / exRets.length : 0;
  const sd = exRets.length ? Math.sqrt(exRets.reduce((a, r) => a + (r - mean) ** 2, 0) / exRets.length) : 0;
  const rawMean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const rawSd = rets.length ? Math.sqrt(rets.reduce((a, r) => a + (r - rawMean) ** 2, 0) / rets.length) : 0;
  return {
    start: curve[0][0], end: curve[curve.length - 1][0],
    yearsCalendar: +years.toFixed(4),
    cagrCalendarPct: years > 0 ? +(((values[values.length - 1] / values[0]) ** (1 / years) - 1) * 100).toFixed(4) : null,
    cagr252Pct: rets.length ? +(((values[values.length - 1] / values[0]) ** (periodsPerYear / rets.length) - 1) * 100).toFixed(4) : null,
    maxDrawdownPct: +(mdd * 100).toFixed(4),
    sharpe: sd > 0 ? +((mean / sd) * Math.sqrt(periodsPerYear)).toFixed(4) : null,
    sharpeZeroRf: rawSd > 0 ? +((rawMean / rawSd) * Math.sqrt(periodsPerYear)).toFixed(4) : null,
    endNav: +values[values.length - 1].toFixed(6),
    days: values.length,
  };
}
