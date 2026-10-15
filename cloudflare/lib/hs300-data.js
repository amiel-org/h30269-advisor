// HS300 data fetching for Cloudflare Workers.
//
// Live sources (all public, no key):
//   * csindex.com.cn  index-perf        -> 000300 price (OHLC + rolling PE)
//   * csindex.com.cn  index-perf        -> H00300 total return
//   * eastmoney       RPTA_WEB_TREASURYYIELD -> 10Y China government yield
//
// The bond series is forward-filled from PAST observations only.
import { buildSignalDetail, buildSignals, ladderExposure, metrics,
         percentileOfHistory, runBacktest } from "./hs300-model.js";

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

  const [priceRows, trRows, bond] = await Promise.all([
    fetchCsiSeries("000300", start, end),
    fetchCsiSeries("H00300", start, end),
    fetchBond10y(),
  ]);

  const series = alignSeries(priceRows, trRows, bond);
  if (series.dates.length < 750) throw new Error(`insufficient history: ${series.dates.length}`);

  const signals = buildSignals(series);
  const run = runBacktest(series, undefined, signals, 1);
  const m = metrics(run.curve);

  const last = series.dates.length - 1;
  const peHist = series.pe.slice(0, last);
  const erpHist = series.spread.slice(0, last);
  const peNow = series.pe[last];
  const erpNow = series.spread[last];

  // ---- per-window view + consensus (the model's actual decision) ---- //
  const detail = buildSignalDetail(series).at(-1);
  const windows = {};
  for (const [key, w] of Object.entries(detail.windows)) {
    windows[key] = {
      label: w.label,
      pe_percentile: w.pePercentile,
      erp_percentile: w.erpPercentile,
      exposure: w.exposure,
    };
  }
  const pePct = percentileOfHistory(peHist, peNow);
  const erpPct = percentileOfHistory(erpHist, erpNow);

  const priceNow = priceRows.length ? priceRows[priceRows.length - 1].close : null;

  // ---- band table computed SERVER-SIDE (front end must not recompute) ---- //
  // One row per ladder band.  `boundary_pe` / `boundary_index` are the levels a
  // window crosses at the band's LOWER edge, i.e. the point at which the target
  // changes.  The bottom band has no lower edge, so those values are null.
  const bands = [];
  for (const [lo, hi] of [[70, 100], [60, 70], [50, 60], [40, 50], [30, 40], [0, 30]]) {
    const target = ladderExposure(lo === 0 ? 0 : lo, LADDER_FOR_BANDS);
    const row = {
      label: lo === 0 ? "< 30%" : (hi >= 100 ? "≥ 70%" : `${lo}% ~ ${hi}%`),
      lo, hi, target,
      pe: {}, levels: {},
    };
    if (lo > 0) {
      for (const spec of WINDOW_SPECS_FOR_BANDS) {
        const pool = spec.mode === "rolling" && spec.days > 0 ? peHist.slice(-spec.days) : peHist;
        const qv = quantile(pool, lo);
        row.pe[spec.name] = qv === null ? null : +qv.toFixed(4);
        row.levels[spec.name] = (qv === null || !priceNow) ? null : +(priceNow * qv / peNow).toFixed(1);
      }
    } else {
      for (const spec of WINDOW_SPECS_FOR_BANDS) {
        row.pe[spec.name] = null;
        row.levels[spec.name] = null;
      }
    }
    bands.push(row);
  }

  return {
    as_of: series.dates[last],
    price_index: { code: "000300", level: priceNow },
    total_return_index: { code: "H00300", level: series.tr[last] },
    pe: peNow,
    pe_percentile: +pePct.toFixed(2),
    erp: +erpNow.toFixed(4),
    erp_percentile: +erpPct.toFixed(2),
    windows,
    consensus: { agreed: detail.agreed, exposure: detail.consensus_exposure, vote: detail.vote },
    target_exposure: detail.consensus_exposure,
    bands,
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
