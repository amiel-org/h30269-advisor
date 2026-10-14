// HS300 data fetching for Cloudflare Workers.
//
// Live sources (all public, no key):
//   * csindex.com.cn  index-perf        -> 000300 price (OHLC + rolling PE)
//   * csindex.com.cn  index-perf        -> H00300 total return
//   * eastmoney       RPTA_WEB_TREASURYYIELD -> 10Y China government yield
//
// The bond series is forward-filled from PAST observations only.
import { buildSignals, runBacktest, metrics, targetExposure, percentileOfHistory } from "./hs300-model.js";

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
  const pePct = percentileOfHistory(series.pe.slice(0, last), series.pe[last]);
  const erpPct = percentileOfHistory(series.spread.slice(0, last), series.spread[last]);
  const target = targetExposure(pePct, erpPct);

  // last price-index close for display (user watches 000300)
  const priceNow = priceRows.length ? priceRows[priceRows.length - 1].close : null;

  return {
    as_of: series.dates[last],
    price_index: { code: "000300", level: priceNow },
    total_return_index: { code: "H00300", level: series.tr[last] },
    pe: series.pe[last],
    pe_percentile: +pePct.toFixed(2),
    erp: +(series.spread[last]).toFixed(4),
    erp_percentile: +erpPct.toFixed(2),
    target_exposure: target,
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
      "样本内研究：参数在历史区间内确定，非干净样本外，无实盘业绩。",
      "最大回撤自净值高点计算，不代表本金亏损上限。",
    ],
  };
}
