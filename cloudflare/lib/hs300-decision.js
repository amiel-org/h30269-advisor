import { DEFAULT_CONFIG, HOLD, ladderExposure, targetExposure, windowTargets } from "./hs300-model.js";

export function signalDetail(series, cfg = DEFAULT_CONFIG) {
  const i = series.dates.length - 1;
  return windowTargets(series.pe.slice(0, i), series.spread.slice(0, i), series.pe[i], series.spread[i], cfg);
}

export function confirmationState(signals, cfg = DEFAULT_CONFIG) {
  const target = signals.at(-1);
  let closes = 0;
  if (typeof target === "number") {
    for (let i = signals.length - 1; i >= 0 && signals[i] === target; i -= 1) closes += 1;
  }
  return {
    target: typeof target === "number" ? target : null,
    confirmed_closes: closes,
    buy_required: cfg.execution.buy_confirm_closes,
    sell_required: cfg.execution.sell_confirm_closes,
    buy_confirmed: closes >= cfg.execution.buy_confirm_closes,
    sell_confirmed: closes >= cfg.execution.sell_confirm_closes,
    step_size: cfg.execution.step_size,
    deadband: cfg.execution.deadband,
    timing: cfg.execution.timing,
    actual_position_known: false,
  };
}

function upperBound(pool, value) {
  let lo = 0, hi = pool.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pool[mid] <= value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Conditional NEXT-close scenarios, including today's settled observation in
// the historical pool. Earnings and the dated bond yield are held constant.
// Every PE/ERP rank discontinuity is scanned, so no coarse price grid can miss
// a narrow interval in which all windows agree.
export function conditionalLevels(series, price, bond, cfg = DEFAULT_CONFIG, context = {}) {
  if (!(price > 0) || !Number.isFinite(bond)) return { buy: null, sell: null, reason: "missing inputs" };
  const currentPe = context.peNow ?? series.pe.at(-1);
  const peHistory = context.peHist ?? series.pe;
  const erpHistory = context.erpHist ?? series.spread;
  const factor = price / currentPe;
  const pools = cfg.indicators.percentile_windows.map((spec) => {
    const count = spec.mode === "rolling" ? spec.days : peHistory.length;
    return { spec, pe: peHistory.slice(-count).sort((a, b) => a - b),
      erp: erpHistory.slice(-count).sort((a, b) => a - b) };
  });
  const evaluatePe = (pe) => {
    const targets = pools.map(({ spec, pe: ph, erp: eh }) => {
      if (ph.length < (spec.min_obs || 1) || eh.length < (spec.min_obs || 1)) return null;
      return targetExposure(100 * upperBound(ph, pe) / ph.length,
        100 * upperBound(eh, 100 / pe - bond) / eh.length, cfg);
    });
    if (targets.some((v) => v === null)) return HOLD;
    return Math.max(...targets) - Math.min(...targets) <= 1e-9 ? targets[0] : HOLD;
  };
  const detail = context.detail ?? signalDetail(series, cfg);
  const todayTargets = Object.values(detail.windows).map((w) => w.exposure).filter(Number.isFinite);
  if (todayTargets.length !== pools.length) return { buy: null, sell: null, reason: "insufficient windows" };
  const currentMin = Math.min(...todayTargets), currentMax = Math.max(...todayTargets);
  const events = new Set([currentPe]);
  for (const pool of pools) {
    for (const value of pool.pe) events.add(value);
    for (const value of pool.erp) if (value + bond > 0) events.add(100 / (value + bond));
  }
  const sorted = [...events].filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  // Use whole index points for readable lines and verify the rounded point
  // with the actual rule. A boundary itself can belong to the opposite band.
  const find = (direction) => {
    const candidates = sorted.filter((v) => direction === "buy" ? v <= currentPe : v >= currentPe);
    if (direction === "buy") candidates.reverse();
    for (const pe of candidates) {
      const level = direction === "buy" ? Math.floor(pe * factor - 1e-6) : Math.ceil(pe * factor + 1e-6);
      if (!(level > 0) || (direction === "buy" ? level >= price : level <= price)) continue;
      const exposure = evaluatePe(level / factor);
      if (typeof exposure !== "number") continue;
      if (direction === "buy" ? exposure <= currentMax : exposure >= currentMin) continue;
      return { level, target: exposure, all_windows_agree: true };
    }
    return null;
  };
  return {
    buy: find("buy"), sell: find("sell"),
    reference_min: currentMin, reference_max: currentMax,
    assumption: context.assumption ?? "仅估算下一收盘日：保持盈利、10年国债收益率不变，并把本次收盘纳入历史。实际数据更新后须重新确认；不等于限价单。",
  };
}

export function valuationTable(series, price, cfg = DEFAULT_CONFIG) {
  const peHist = series.pe.slice(0, -1);
  const peNow = series.pe.at(-1);
  const boundaries = [];
  for (const band of cfg.allocation.pe_ladder.filter((b) => b.min_pct > 0)) {
    const row = { pct: band.min_pct, target_above: band.exposure,
      target_below: ladderExposure(band.min_pct - 1e-9, cfg.allocation.pe_ladder), levels: {}, pe: {} };
    for (const spec of cfg.indicators.percentile_windows) {
      const pool = (spec.mode === "rolling" ? peHist.slice(-spec.days) : peHist).slice().sort((a, b) => a - b);
      // ECDF uses <=, so ceil(p*N)-1 is the FIRST observation attaining p%.
      const value = pool[Math.max(0, Math.ceil(band.min_pct * pool.length / 100) - 1)];
      row.pe[spec.name] = value ?? null;
      row.levels[spec.name] = Number.isFinite(value) ? +(price * value / peNow).toFixed(1) : null;
    }
    boundaries.push(row);
  }
  const ladder = cfg.allocation.pe_ladder.map((band) => ({
    lo: band.min_pct || null, target: band.exposure,
    levels: boundaries.find((r) => r.pct === band.min_pct)?.levels || {},
    pe: boundaries.find((r) => r.pct === band.min_pct)?.pe || {},
  }));
  return { boundaries, ladder };
}

export function dataQuality(series, bondDate, now = new Date()) {
  const latest = series.dates.at(-1);
  const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10).replaceAll("-", "");
  const parse = (s) => typeof s === "string" && /^\d{8}$/.test(s)
    ? Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`) : NaN;
  const age = (s) => Math.floor((parse(today) - parse(s)) / 86400000);
  const blockers = [];
  // Weekends are tolerated; long exchange holidays require a fresh official
  // daily bar before actionable advice resumes. Never silently assume open.
  if (!Number.isFinite(age(latest)) || age(latest) < 0 || age(latest) > 4) blockers.push("指数收盘数据超过4个日历日或日期异常，暂停交易提示");
  if (!Number.isFinite(age(bondDate)) || age(bondDate) < 0 || age(bondDate) > 7) blockers.push("国债收益率超过7个日历日或日期异常，暂停交易提示");
  return { actionable: blockers.length === 0, blockers, price_date: latest, bond_date: bondDate,
    price_age_days: latest ? age(latest) : null, bond_age_days: bondDate ? age(bondDate) : null };
}

export function dashboardQuality(data, now = new Date(), sourceWarning = null) {
  const base = dataQuality({ dates: [data.price_asof] }, data.bond?.as_of, now);
  const cn = new Date(now.getTime() + 8 * 3600000);
  const today = cn.toISOString().slice(0, 10).replaceAll("-", "");
  const weekday = cn.getUTCDay() > 0 && cn.getUTCDay() < 6;
  // This is a publication check, not an exchange-calendar claim. A holiday or
  // a delayed feed both mean: no new close is available; do not fabricate one.
  const awaiting = weekday && cn.getUTCHours() * 60 + cn.getUTCMinutes() >= 15 * 60 + 10 && data.price_asof < today;
  const blockers = [...base.blockers];
  if (awaiting) blockers.push("新收盘日线尚未取得，等待官方发布；上一收盘日分析仅供参考");
  if (sourceWarning) blockers.push("数据源本次核验未完成，上一收盘日分析仅供参考");
  return { ...base, actionable: blockers.length === 0, analysis_available: base.actionable,
    blockers, status: !base.actionable ? "expired" : sourceWarning ? "source_unavailable" : awaiting ? "awaiting_close" : "ready" };
}
