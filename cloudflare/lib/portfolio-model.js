// Dual-sleeve unified equity pool allocator (HS300 v2.5 + H30269 V3.2).
// Mirrors portfolio/model.py byte-for-byte; verified by cloudflare/portfolio-parity.mjs.
import portfolioConfig from "../../portfolio/config.json" with { type: "json" };

export const PORTFOLIO_CONFIG = portfolioConfig;

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

export function computeSpilloverFactors(
  hs300PePct,
  hs300Exposure,
  h30269PePct,
  h30269AdjSpread,
  h30269Overheat,
  cfg = PORTFOLIO_CONFIG,
) {
  const vt = cfg.valuation_taper;
  let divFactor;
  if (h30269Overheat || (Number.isFinite(h30269AdjSpread) && h30269AdjSpread >= vt.h30269_overheat_spread_pct)) {
    divFactor = 0;
  } else if (!Number.isFinite(h30269PePct)) {
    divFactor = 0.5;
  } else {
    divFactor = clamp((vt.h30269_pe_zero_pct - h30269PePct) / Math.max(1e-9, vt.h30269_pe_zero_pct - vt.h30269_pe_full_pct), 0, 1);
  }

  let hsFactor;
  if (hs300Exposure < vt.hs300_min_standalone_exposure - 1e-12) {
    hsFactor = 0;
  } else if (!Number.isFinite(hs300PePct)) {
    hsFactor = 0.5;
  } else {
    hsFactor = clamp((vt.hs300_pe_zero_pct - hs300PePct) / Math.max(1e-9, vt.hs300_pe_zero_pct - vt.hs300_pe_full_pct), 0, 1);
  }
  return { hs300_factor: hsFactor, h30269_factor: divFactor };
}

export function computePortfolioTargets(
  hs300Exposure,
  h30269Exposure,
  hs300PePct,
  h30269PePct,
  h30269AdjSpread,
  h30269Overheat,
  cfg = PORTFOLIO_CONFIG,
  { spilloverOverride = null } = {},
) {
  const baseHs = cfg.base_weights.hs300;
  const baseDiv = cfg.base_weights.h30269;
  const maxHs = cfg.max_sleeve_weights.hs300;
  const maxDiv = cfg.max_sleeve_weights.h30269;
  const maxTotal = cfg.max_total_equity;
  const spillover = spilloverOverride === null ? cfg.spillover_ratio : spilloverOverride;

  const wHs = clamp(Number(hs300Exposure), 0, 1);
  const wDiv = clamp(Number(h30269Exposure), 0, 1);
  const idleHs = baseHs * (1 - wHs);
  const idleDiv = baseDiv * (1 - wDiv);

  const factors = computeSpilloverFactors(hs300PePct, wHs, h30269PePct, h30269AdjSpread, Boolean(h30269Overheat), cfg);
  const effHsBudget = Math.min(maxHs, baseHs + spillover * factors.hs300_factor * idleDiv);
  const effDivBudget = Math.min(maxDiv, baseDiv + spillover * factors.h30269_factor * idleHs);

  let tHs = effHsBudget * wHs;
  let tDiv = effDivBudget * wDiv;
  const rawTotal = tHs + tDiv;
  const capped = rawTotal > maxTotal + 1e-12;
  if (capped) {
    const scale = maxTotal / rawTotal;
    tHs *= scale;
    tDiv *= scale;
  }
  const totalEquity = tHs + tDiv;
  return {
    hs300_target: tHs,
    h30269_target: tDiv,
    total_equity: totalEquity,
    cash_target: Math.max(0, 1 - totalEquity),
    base_hs300_target: baseHs * wHs,
    base_h30269_target: baseDiv * wDiv,
    eff_hs300_budget: effHsBudget,
    eff_h30269_budget: effDivBudget,
    idle_hs300: idleHs,
    idle_h30269: idleDiv,
    hs300_factor: factors.hs300_factor,
    h30269_factor: factors.h30269_factor,
    capped_by_total: capped,
  };
}

export function classifyRegime(hs300PePct, h30269PePct, h30269Overheat, hs300Exposure, h30269Exposure) {
  const hsCheap = Number.isFinite(hs300PePct) && hs300PePct <= 45 && hs300Exposure >= 0.5;
  const hsExpensive = Number.isFinite(hs300PePct) && hs300PePct >= 65;
  const divCheap = !h30269Overheat && (!Number.isFinite(h30269PePct) || h30269PePct < 70);
  const divExpensive = h30269Overheat || (Number.isFinite(h30269PePct) && h30269PePct >= 80);

  if (hsCheap && divCheap) {
    return {
      code: "dual_offense",
      title: "双低积极配置",
      summary: "沪深300与红利低波估值均处于偏低区间，总池可提升至高位（最高90%），保留10%现金底线。",
    };
  }
  if (hsExpensive && divExpensive) {
    return {
      code: "dual_defense",
      title: "双高防守蓄水",
      summary: "两侧估值均偏贵或过热，停止互相补位，优先守住利润并增加现金蓄水池。",
    };
  }
  if (hsCheap && divExpensive) {
    return {
      code: "hs300_lead",
      title: "宽基进攻主导",
      summary: "沪深300更具赔率优势、红利低波偏贵或过热，红利闲置预算向沪深300倾斜补位。",
    };
  }
  if ((hsExpensive || hs300Exposure <= 0.25) && divCheap) {
    return {
      code: "dividend_ballast",
      title: "红利压舱补位",
      summary: "沪深300仓位偏低或偏贵，闲置预算按估值系数平滑补位至红利低波吃息增厚收益。",
    };
  }
  return {
    code: "balanced",
    title: "均衡互补持有",
    summary: "双引擎处于中性区间，按50/50基础预算与平滑补位协同运行，仅超5%死区再动仓。",
  };
}

function calendarDays(d0Compact, d1Compact) {
  const t0 = Date.parse(`${d0Compact.slice(0, 4)}-${d0Compact.slice(4, 6)}-${d0Compact.slice(6, 8)}T00:00:00Z`);
  const t1 = Date.parse(`${d1Compact.slice(0, 4)}-${d1Compact.slice(4, 6)}-${d1Compact.slice(6, 8)}T00:00:00Z`);
  return Math.max(1, Math.round((t1 - t0) / 86400000));
}

function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function summarizePortfolio(curve, w300List, wdivList, trades, turnover, rfAnnual = 0.018) {
  const segment = (c) => {
    const vals = c.map(([, v]) => v);
    const d0 = Date.parse(`${c[0][0].slice(0, 4)}-${c[0][0].slice(4, 6)}-${c[0][0].slice(6, 8)}T00:00:00Z`);
    const d1 = Date.parse(`${c.at(-1)[0].slice(0, 4)}-${c.at(-1)[0].slice(4, 6)}-${c.at(-1)[0].slice(6, 8)}T00:00:00Z`);
    const yrs = (d1 - d0) / (365.25 * 86400000);
    let pk = vals[0];
    let mdd = 0;
    for (const v of vals) {
      pk = Math.max(pk, v);
      mdd = Math.min(mdd, v / pk - 1);
    }
    const rfD = (1 + rfAnnual) ** (1 / 252) - 1;
    const rets = [];
    for (let k = 1; k < vals.length; k += 1) rets.push(vals[k] / vals[k - 1] - 1);
    const ex = rets.map((r) => r - rfD);
    const m = ex.reduce((a, b) => a + b, 0) / ex.length;
    const sd = Math.sqrt(ex.reduce((a, r) => a + (r - m) ** 2, 0) / ex.length);
    const rawM = rets.reduce((a, b) => a + b, 0) / rets.length;
    const rawSd = Math.sqrt(rets.reduce((a, r) => a + (r - rawM) ** 2, 0) / rets.length);
    const cagr = ((vals.at(-1) / vals[0]) ** (1 / yrs) - 1) * 100;
    const calmar = mdd < 0 ? (cagr / 100) / Math.abs(mdd) : 0;
    return {
      start: c[0][0],
      end: c.at(-1)[0],
      cagr_calendar_pct: roundTo(cagr, 4),
      max_drawdown_pct: roundTo(mdd * 100, 4),
      sharpe: sd > 0 ? roundTo((m / sd) * Math.sqrt(252), 4) : 0,
      sharpe_zero_rf: rawSd > 0 ? roundTo((rawM / rawSd) * Math.sqrt(252), 4) : 0,
      calmar: roundTo(calmar, 4),
      end_nav: roundTo(vals.at(-1), 6),
    };
  };
  let sp = curve.findIndex(([d]) => d >= "20220101");
  if (sp < 0) sp = Math.floor(curve.length / 2);
  const avgHs = (w300List.reduce((a, b) => a + b, 0) / w300List.length) * 100;
  const avgDiv = (wdivList.reduce((a, b) => a + b, 0) / wdivList.length) * 100;
  return {
    full: segment(curve),
    pre_2022: segment(curve.slice(0, sp + 1)),
    post_2022: segment(curve.slice(sp)),
    avg_hs300_pct: roundTo(avgHs, 2),
    avg_h30269_pct: roundTo(avgDiv, 2),
    avg_total_equity_pct: roundTo(avgHs + avgDiv, 2),
    trades: trades.length,
    turnover: roundTo(turnover, 4),
  };
}

export function runPortfolioBacktest(
  records,
  cfg = PORTFOLIO_CONFIG,
  { spilloverOverride = null, noCliffOverride = null, useH30269Key = "h_exp50" } = {},
) {
  if (!records?.length || records.length < 2) {
    return { curve: [], trades: [], w300: [], wdiv: [], turnover: 0, summary: {} };
  }
  const reb = cfg.rebalance;
  const acct = cfg.accounting;
  const vt = cfg.valuation_taper;
  const maxHs = cfg.max_sleeve_weights.hs300;
  const maxDiv = cfg.max_sleeve_weights.h30269;
  const maxTotal = cfg.max_total_equity;
  const deadband = reb.deadband;
  const maxStep = reb.max_step;
  const cooldown = reb.cooldown_trading_days;
  const noCliff = noCliffOverride === null ? Boolean(reb.no_cliff_sell) : Boolean(noCliffOverride);
  const fee = acct.fee_one_way;
  const etfFee = acct.etf_fee_annual;
  const cashY = acct.cash_yield_annual;
  const rfAnnual = acct.risk_free_annual;

  const targetsFor = (rec) => computePortfolioTargets(
    rec.hs_exp,
    rec[useH30269Key],
    rec.hs_pe_pct,
    rec.h_pe_pct,
    rec.h_adj_5y,
    rec.h_robust_overheat,
    cfg,
    { spilloverOverride },
  );

  const t0 = targetsFor(records[0]);
  let hsVal = t0.hs300_target;
  let divVal = t0.h30269_target;
  let cashVal = 1 - hsVal - divVal - (hsVal + divVal) * fee;
  const initNav = hsVal + divVal + cashVal;

  const curve = [[records[0].date, initNav]];
  const w300List = [hsVal / initNav];
  const wdivList = [divVal / initNav];
  const trades = [];
  let turnover = hsVal + divVal;
  let lastTrade300 = -999;
  let lastTradeDiv = -999;

  for (let i = 1; i < records.length; i += 1) {
    const cd = calendarDays(records[i - 1].date, records[i].date);
    const drag = (1 - etfFee) ** (cd / 365.25);
    hsVal *= (records[i].hs_tr / records[i - 1].hs_tr) * drag;
    divVal *= (records[i].h_tr / records[i - 1].h_tr) * drag;
    cashVal *= (1 + cashY) ** (cd / 365.25);
    const nav = hsVal + divVal + cashVal;

    const rPrev = records[i - 1];
    const tgt = targetsFor(rPrev);
    const t300 = tgt.hs300_target;
    const tdiv = tgt.h30269_target;
    const w300 = hsVal / nav;
    const wdiv = divVal / nav;

    let effT300 = t300;
    let effTdiv = tdiv;
    if (noCliff) {
      if (wdiv > tdiv && wdiv <= maxDiv && !rPrev.h_robust_overheat && w300 + wdiv <= maxTotal + deadband) {
        effTdiv = Math.min(wdiv, Math.max(tdiv, Math.min(maxDiv, rPrev[useH30269Key] * maxDiv)));
        if (i >= 2 && records[i - 1][useH30269Key] < records[i - 2][useH30269Key] - 0.01) {
          effTdiv = tdiv;
        }
      }
      if (w300 > t300 && w300 <= maxHs && rPrev.hs_pe_pct < vt.hs300_overheat_pe_pct && w300 + wdiv <= maxTotal + deadband) {
        if (i >= 2 && records[i - 1].hs_exp >= records[i - 2].hs_exp - 0.01) {
          effT300 = w300;
        }
      }
    }

    const d300 = effT300 - w300;
    const ddiv = effTdiv - wdiv;
    let m300 = Math.abs(d300) > deadband + 1e-12 && i - lastTrade300 >= cooldown ? d300 : 0;
    let mdiv = Math.abs(ddiv) > deadband + 1e-12 && i - lastTradeDiv >= cooldown ? ddiv : 0;

    if (m300 !== 0) m300 = Math.sign(m300) * Math.min(Math.abs(m300), maxStep);
    if (mdiv !== 0) mdiv = Math.sign(mdiv) * Math.min(Math.abs(mdiv), maxStep);

    if (m300 !== 0 || mdiv !== 0) {
      let newW300 = Math.max(0, w300 + m300);
      let newWdiv = Math.max(0, wdiv + mdiv);
      if (newW300 + newWdiv > maxTotal) {
        const sc = maxTotal / (newW300 + newWdiv);
        newW300 *= sc;
        newWdiv *= sc;
      }
      const n300 = newW300 * nav - hsVal;
      const ndiv = newWdiv * nav - divVal;
      const comm = (Math.abs(n300) + Math.abs(ndiv)) * fee;
      hsVal += n300;
      divVal += ndiv;
      cashVal -= n300 + ndiv + comm;
      turnover += (Math.abs(n300) + Math.abs(ndiv)) / nav;
      if (Math.abs(n300) / nav > 0.005) lastTrade300 = i;
      if (Math.abs(ndiv) / nav > 0.005) lastTradeDiv = i;
      const postNavT = hsVal + divVal + cashVal;
      trades.push({
        date: records[i].date,
        hs300_before: roundTo(w300, 4),
        hs300_after: roundTo(hsVal / postNavT, 4),
        h30269_before: roundTo(wdiv, 4),
        h30269_after: roundTo(divVal / postNavT, 4),
      });
    }

    const postNav = hsVal + divVal + cashVal;
    w300List.push(hsVal / postNav);
    wdivList.push(divVal / postNav);
    curve.push([records[i].date, postNav]);
  }

  return {
    curve,
    trades,
    w300: w300List,
    wdiv: wdivList,
    turnover,
    summary: summarizePortfolio(curve, w300List, wdivList, trades, turnover, rfAnnual),
  };
}
