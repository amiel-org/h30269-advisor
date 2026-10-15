// HS300 data fetching for Cloudflare Workers.
//
// Live sources (all public, no key):
//   * csindex.com.cn  index-perf        -> 000300 price (OHLC + rolling PE)
//   * csindex.com.cn  index-perf        -> H00300 total return
//   * eastmoney       RPTA_WEB_TREASURYYIELD -> 10Y China government yield
//
// The bond series is forward-filled from PAST observations only.
import { buildSignals, ladderExposure, metrics, percentileOfHistory,
         runBacktest, windowTargets } from "./hs300-model.js";

const CSI_PERF = "https://www.csindex.com.cn/csindex-home/perf/index-perf";
const EM_DATA = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";

async function fetchJson(url, { referer, timeoutMs = 25000, retries = 3 } = {}) {
  const headers = { "User-Agent": UA };
  if (referer) headers.Referer = referer;
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { headers, signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
      return await resp.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function num(v) {
  if (v === null || v === undefined || v === "" || v === "-") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function fetchCsiSeries(code, startDate, endDate) {
  const url = new URL(CSI_PERF);
  url.searchParams.set("indexCode", code);
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  const payload = await fetchJson(url.toString(), {
    referer: `https://www.csindex.com.cn/zh-CN/indices/index-detail/${code}`,
  });
  if (String(payload.code) !== "200") throw new Error(`csindex ${code}: ${payload.msg}`);
  const rows = [];
  for (const item of payload.data || []) {
    const close = num(item.close);
    if (close === null) continue;
    rows.push({
      date: String(item.tradeDate), close,
      pe: num(item.peg),
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

function bondPageUrl(page) {
  const url = new URL(EM_DATA);
  const params = {
    reportName: "RPTA_WEB_TREASURYYIELD", columns: "ALL",
    pageSize: "500", pageNumber: String(page),
    sortColumns: "SOLAR_DATE", sortTypes: "-1",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

// Live intraday quote for the price index.  PRESENTATION ONLY -- the model
// deliberately never uses an unsettled intraday price for a signal.
export async function fetchIntraday(code) {
  const url = new URL("https://www.csindex.com.cn/csindex-home/perf/index-perf-oneday");
  url.searchParams.set("indexCode", code);
  try {
    const payload = await fetchJson(url.toString(), {
      referer: `https://www.csindex.com.cn/zh-CN/indices/index-detail/${code}`,
      retries: 1,
    });
    const h = (payload.data || {}).intraDayHeader || {};
    const raw = String(h.tradeDate || "");
    const date = raw.length === 10 ? raw.replace(/-/g, "") : (raw.length === 8 ? raw : "");
    const level = num(h.current);
    if (!date || level === null || level <= 0) return null;
    return {
      date,
      time: String(h.tradeTime || ""),
      level,
      change_pct: num(h.changePct),
      open: num(h.openToday),
    };
  } catch {
    return null;
  }
}

export async function fetchBond10y() {
  // Newest-first, 500 rows/page, ~20 pages back to 2002.  A single page covers
  // only ~2 years and would silently drop every older price row, so we must
  // paginate.  Pages are fetched CONCURRENTLY: serial fetching of 20 pages was
  // slow enough to hit the request timeout on a cold cache.
  const pages = 20;
  const results = await Promise.all(
    Array.from({ length: pages }, (_, i) =>
      fetchJson(bondPageUrl(i + 1), { retries: 2 }).catch(() => null)),
  );
  const out = {};
  for (const payload of results) {
    if (!payload) continue;
    const data = (payload.result || {}).data || [];
    for (const row of data) {
      const v = num(row.EMM00166466);
      if (v === null) continue;
      out[String(row.SOLAR_DATE).slice(0, 10).replace(/-/g, "")] = v;
    }
  }
  return out;
}

// ---- align into the series shape the model expects ---- //
export function alignSeries(priceRows, trRows, bond) {
  const trMap = new Map(trRows.map((r) => [r.date, r.close]));
  const bondKeys = Object.keys(bond).sort();
  const dates = [], tr = [], pe = [], spread = [];
  for (const row of priceRows) {
    const d = row.date;
    // reject weekends (synthetic/carried rows from the API boundary)
    const dow = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (row.pe === null) continue;
    if (!trMap.has(d)) continue;
    let lo = 0, hi = bondKeys.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (bondKeys[mid] <= d) lo = mid + 1; else hi = mid; }
    const key = bondKeys[lo - 1];
    if (key === undefined) continue;
    dates.push(d); tr.push(Number(trMap.get(d))); pe.push(row.pe);
    spread.push(100 / row.pe - bond[key]);
  }
  return { dates, tr, pe, spread };
}

export function compact(d) { return d.toISOString().slice(0, 10).replace(/-/g, ""); }

export async function buildHs300Result() {
  const today = new Date();
  const end = compact(today);
  // PE history on csindex starts 2011-06; fetch a bit earlier so the expanding
  // window has its full population and the backtest covers the whole period.
  const startDate = new Date(today.getTime() - 5800 * 86400000);
  const start = compact(startDate);

  const [priceRows, trRows, bond, intradayRaw] = await Promise.all([
    fetchCsiSeries("000300", start, end),
    fetchCsiSeries("H00300", start, end),
    fetchBond10y(),
    fetchIntraday("000300"),
  ]);

  const series = alignSeries(priceRows, trRows, bond);
  if (series.dates.length < 750) throw new Error(`insufficient history: ${series.dates.length}`);

  const signals = buildSignals(series);
  const run = runBacktest(series, undefined, signals, 1);
  const m = metrics(run.curve);

  const settledLast = series.dates.length - 1;

  // ---- merge the LIVE intraday quote as a provisional bar ----
  // The model runs on H00300 (total return) because that compounds for real,
  // but csindex only publishes an intraday feed for the price index 000300.
  // We therefore scale H00300 and PE by the 000300 move: intraday dividend
  // accrual is a few basis points and cannot move a 12.5% ladder step.
  let liveSeries = series;
  let quoteStatus = "\u6536\u76d8\u540e";
  let intraday = null;
  let liveNote = null;
  try {
    const nextDate = intradayRaw ? intradayRaw.date : null;
    if (nextDate && nextDate > series.dates[settledLast]) {
      const closeByDate = new Map(priceRows.map((r) => [r.date, r.close]));
      const basePx = closeByDate.get(series.dates[settledLast]);
      if (basePx) {
        const ratio = intradayRaw.level / basePx;
        const bondKeys = Object.keys(bond).sort();
        const yLive = bond[bondKeys[bondKeys.length - 1]];
        const trLive = series.tr[settledLast] * ratio;
        const peLive = series.pe[settledLast] * ratio;
        liveSeries = {
          dates: [...series.dates, nextDate],
          tr: [...series.tr, trLive],
          pe: [...series.pe, peLive],
          spread: [...series.spread, 100 / peLive - yLive],
        };
        quoteStatus = "\u76d8\u4e2d";
        intraday = { ...intradayRaw, ratio: +ratio.toFixed(6),
                     tr_level: +trLive.toFixed(2), pe_live: +peLive.toFixed(4),
                     bond_10y: yLive };
        liveNote = `\u76d8\u4e2d\u4f30\u503c\uff1a\u6309 000300 \u5b9e\u65f6\u4ef7\u6309\u6bd4\u4f8b\u63a8\u7b97 H00300 \u4e0e PE\uff08\u6bd4\u4f8b ${ratio.toFixed(4)}\uff09\u3002`;
      }
    }
  } catch (e) {
    liveSeries = series; quoteStatus = "\u6536\u76d8\u540e"; intraday = null;
    liveNote = `\u76d8\u4e2d\u6570\u636e\u63a5\u5165\u5931\u8d25\uff0c\u5df2\u56de\u9000\u5230\u6700\u540e\u6536\u76d8\u65e5\uff1a${e.message}`;
  }

  const liveLast = liveSeries.dates.length - 1;
  const peHist = liveSeries.pe.slice(0, liveLast);
  const erpHist = liveSeries.spread.slice(0, liveLast);
  const peNow = liveSeries.pe[liveLast];
  const erpNow = liveSeries.spread[liveLast];

  const cur = windowTargets(peHist, erpHist, peNow, erpNow);
  const windows = {};
  for (const [key, w] of Object.entries(cur.windows)) {
    windows[key] = {
      label: w.label,
      pe_percentile: w.pePercentile,
      erp_percentile: w.erpPercentile,
      exposure: w.exposure,
    };
  }
  const pePct = percentileOfHistory(peHist, peNow);
  const erpPct = percentileOfHistory(erpHist, erpNow);

  const priceNow = intraday ? intraday.level
    : (priceRows.length ? priceRows[priceRows.length - 1].close : null);

  // ---- boundary table computed SERVER-SIDE (front end must not recompute) ----
  const pools = {};
  for (const spec of WINDOW_SPECS_FOR_BANDS) {
    const src = spec.mode === "rolling" && spec.days > 0 ? peHist.slice(-spec.days) : peHist;
    pools[spec.name] = [...src].sort((a, b) => a - b);
  }
  const boundaries = [];
  for (const pctBoundary of [70, 60, 50, 40, 30]) {
    const row = { pct: pctBoundary, levels: {}, pe: {}, target_below: null, target_above: null };
    for (const spec of WINDOW_SPECS_FOR_BANDS) {
      const pool = pools[spec.name];
      const qv = pool.length ? quantile(pool, pctBoundary) : null;
      row.pe[spec.name] = qv === null ? null : +qv.toFixed(4);
      row.levels[spec.name] = (qv === null || !priceNow) ? null : +(priceNow * qv / peNow).toFixed(1);
    }
    row.target_below = ladderExposure(pctBoundary - 0.001, LADDER_FOR_BANDS);
    row.target_above = ladderExposure(pctBoundary, LADDER_FOR_BANDS);
    boundaries.push(row);
  }

  const priceAsOf = series.dates[settledLast];
  const live = quoteStatus === "\u76d8\u4e2d";

  return {
    as_of: liveSeries.dates[liveLast],
    price_asof: priceAsOf,
    quote_status: quoteStatus,
    live,
    live_note: liveNote,
    intraday,
    price_index: { code: "000300", level: priceNow },
    total_return_index: { code: "H00300", level: liveSeries.tr[liveLast] },
    pe: +peNow.toFixed(4),
    pe_percentile: +pePct.toFixed(2),
    erp: +erpNow.toFixed(4),
    erp_percentile: +erpPct.toFixed(2),
    windows,
    consensus: { agreed: cur.agreed, exposure: cur.consensus_exposure,
                 vote: cur.vote, span: cur.span },
    target_exposure: cur.consensus_exposure,
    boundaries,
    backtest: {
      cagr_calendar_pct: m.cagrCalendarPct,
      max_drawdown_pct: m.maxDrawdownPct,
      sharpe: m.sharpe,
      trades: run.steps.length,
      avg_exposure: +(run.exposures.reduce((a, b) => a + b, 0) / run.exposures.length).toFixed(4),
      start: m.start, end: m.end,
    },
    chart: {
      dates: series.dates.slice(-500),
      price: series.tr.slice(-500),
      pe: series.pe.slice(-500),
      exposure: run.exposures.slice(-500),
    },
    disclosures: [
      "策略预算口径：仓位是划给沪深300策略资金池的比例，不是家庭总资产比例。",
      "多窗口一致口径：全历史 / 近10年 / 近5年 三窗口结论一致才给信号，分歧时保持仓位不动。",
      "样本内研究：参数在历史区间内确定，非干净样本外，无实盘业绩。",
      "最大回撤自净值高点计算，不代表本金亏损上限。",
    ],
  };
}

// ---- band-table helpers (server-side only) ---- //
const LADDER_FOR_BANDS = [
  { min_pct: 70, exposure: 0.0 },
  { min_pct: 60, exposure: 0.125 },
  { min_pct: 50, exposure: 0.375 },
  { min_pct: 40, exposure: 0.625 },
  { min_pct: 30, exposure: 0.875 },
  { min_pct: 0, exposure: 1.0 },
];

const WINDOW_SPECS_FOR_BANDS = [
  { name: "full", mode: "expanding" },
  { name: "10y", mode: "rolling", days: 2440 },
  { name: "5y", mode: "rolling", days: 1220 },
];

function quantile(pool, pct) {
  if (!pool || !pool.length) return null;
  const s = [...pool].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor((pct / 100) * s.length)));
  return s[idx];
}
