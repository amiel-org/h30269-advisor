// HS300 data fetching for Cloudflare Workers.
//
// Live sources (all public, no key):
//   * csindex.com.cn  index-perf        -> 000300 price (OHLC + rolling PE)
//   * csindex.com.cn  index-perf        -> H00300 total return
//   * eastmoney       RPTA_WEB_TREASURYYIELD -> 10Y China government yield
//
// The bond series is forward-filled from PAST observations only.
import { DEFAULT_CONFIG, buildSignals, metrics, percentileOfHistory, runBacktest } from "./hs300-model.js";
import { conditionalLevels, confirmationState, dataQuality, signalDetail, valuationTable } from "./hs300-decision.js";

const CSI_PERF = "https://www.csindex.com.cn/csindex-home/perf/index-perf";
const EM_DATA = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";

async function fetchJson(url, { referer, timeoutMs = 12000, retries = 1, signal } = {}) {
  const headers = { "User-Agent": UA };
  if (referer) headers.Referer = referer;
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const resp = await fetch(url, { headers, signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
      return await resp.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * attempt));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  throw lastError;
}

function num(v) {
  if (v === null || v === undefined || v === "" || v === "-") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function fetchCsiSeries(code, startDate, endDate, timeoutMs = 18000, signal) {
  const url = new URL(CSI_PERF);
  url.searchParams.set("indexCode", code);
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  const payload = await fetchJson(url.toString(), {
    referer: `https://www.csindex.com.cn/zh-CN/indices/index-detail/${code}`,
    timeoutMs,
    retries: 1, signal,
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
export async function fetchIntraday(code, signal) {
  const url = new URL("https://www.csindex.com.cn/csindex-home/perf/index-perf-oneday");
  url.searchParams.set("indexCode", code);
  try {
    const payload = await fetchJson(url.toString(), {
      referer: `https://www.csindex.com.cn/zh-CN/indices/index-detail/${code}`,
      retries: 1, timeoutMs: 5000, signal,
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

export async function fetchBond10y(signal) {
  const first = await fetchJson(bondPageUrl(1), { signal });
  const pages = Number(first.result?.pages);
  if (!first.success || !Number.isInteger(pages) || pages < 1 || pages > 100) throw new Error("国债分页元数据异常");
  const required = Math.min(pages, 20);
  const rest = await Promise.all(Array.from({ length: required - 1 }, (_, i) =>
    fetchJson(bondPageUrl(i + 2), { signal })));
  const out = {};
  for (const payload of [first, ...rest]) {
    if (!payload.success || !Array.isArray(payload.result?.data) || !payload.result.data.length) {
      throw new Error("国债历史分页缺失，拒绝使用残缺历史");
    }
    for (const row of payload.result.data) {
      const value = num(row.EMM00166466);
      const date = String(row.SOLAR_DATE).slice(0, 10).replaceAll("-", "");
      if (value !== null && value > 0 && /^\d{8}$/.test(date)) out[date] = value;
    }
  }
  if (Object.keys(out).sort()[0] > "20110601") throw new Error("国债历史未覆盖PE历史起点");
  return out;
}

const dayStamp = (s) => Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
function validDate(d) { return /^\d{8}$/.test(d) && Number.isFinite(dayStamp(d)) && compact(new Date(dayStamp(d))) === d; }

export function alignSeries(priceRows, trRows, bond) {
  const trMap = new Map(trRows.map((r) => [r.date, r.close]));
  const bondKeys = Object.keys(bond).filter(validDate).sort();
  const dates = [], tr = [], pe = [], spread = [];
  const prices = new Map();
  for (const row of priceRows) {
    if (!validDate(row.date)) throw new Error("指数日期格式异常");
    if (prices.has(row.date) && JSON.stringify(prices.get(row.date)) !== JSON.stringify(row)) throw new Error("指数存在冲突重复行");
    prices.set(row.date, row);
  }
  for (const row of [...prices.values()].sort((a, b) => a.date.localeCompare(b.date))) {
    const d = row.date;
    const dow = new Date(dayStamp(d)).getUTCDay();
    if (dow === 0 || dow === 6 || row.pe === null || row.pe === undefined || !trMap.has(d)) continue;
    if (![row.pe, row.close, trMap.get(d)].every((v) => Number.isFinite(v) && v > 0)) throw new Error("指数或PE数值异常");
    let lo = 0, hi = bondKeys.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (bondKeys[mid] <= d) lo = mid + 1; else hi = mid; }
    const key = bondKeys[lo - 1];
    if (!key) continue;
    if ((dayStamp(d) - dayStamp(key)) / 86400000 > 7) throw new Error(`国债历史在 ${d} 缺失超过7天`);
    if (!Number.isFinite(bond[key]) || bond[key] <= 0) throw new Error("国债数值异常");
    dates.push(d); tr.push(trMap.get(d)); pe.push(row.pe); spread.push(100 / row.pe - bond[key]);
  }
  return { dates, tr, pe, spread };
}

export function compact(d) { return d.toISOString().slice(0, 10).replaceAll("-", ""); }
export const SETTLED_KEY = "hs300:settled:v3";
const SETTLED_MAX_AGE_MS = 12 * 3600000;

function chinaNow(now) { return new Date(now.getTime() + 8 * 3600000); }
async function readSettled(env, now) {
  try {
    const raw = await env?.H30269_KV?.get(SETTLED_KEY);
    const cached = raw ? JSON.parse(raw) : null;
    const age = now.getTime() - Date.parse(cached?.cached_at);
    if (!cached || !Number.isFinite(age) || age < 0 || age > SETTLED_MAX_AGE_MS) return null;
    const s = cached.series;
    if (!s || s.dates.length < 750 || ![s.pe, s.tr, s.spread].every((v) => Array.isArray(v) && v.length === s.dates.length && v.every(Number.isFinite))) return null;
    if (!s.dates.every((d, i) => validDate(d) && (i === 0 || d > s.dates[i - 1])) ||
      !s.pe.every((v) => v > 0) || !s.tr.every((v) => v > 0)) return null;
    if (!(cached.settled_price > 0) || !(cached.bond_last > 0) || !validDate(cached.bond_date || "")) return null;
    const cn = chinaNow(now);
    if (cn.getUTCDay() > 0 && cn.getUTCDay() < 6 && cn.getUTCHours() * 60 + cn.getUTCMinutes() >= 15 * 60 + 10 && s.dates.at(-1) < compact(cn)) return null;
    return cached;
  } catch { return null; }
}

async function writeSettled(env, value) {
  try { await env?.H30269_KV?.put(SETTLED_KEY, JSON.stringify(value)); } catch { /* best effort */ }
}

export async function buildHs300Result(env = null, { now = new Date(), signal } = {}) {
  const cn = chinaNow(now), end = compact(cn);
  // Fetch the quote and daily history concurrently, with a shared cancellation
  // signal. Fixed history start keeps the expanding window stable over time.
  const quotePromise = fetchIntraday("000300", signal);
  let settled = await readSettled(env, now);
  let historySource = "cache";
  if (!settled) {
    const [priceRaw, trRaw, bondRaw] = await Promise.all([
      fetchCsiSeries("000300", "20100101", end, 18000, signal),
      fetchCsiSeries("H00300", "20100101", end, 18000, signal),
      fetchBond10y(signal),
    ]);
    const complete = (r) => r.date < end || (r.date === end && cn.getUTCHours() * 60 + cn.getUTCMinutes() >= 15 * 60 + 10);
    const priceRows = priceRaw.filter(complete), trRows = trRaw.filter(complete);
    const bond = Object.fromEntries(Object.entries(bondRaw).filter(([d]) => d <= end));
    const series = alignSeries(priceRows, trRows, bond);
    if (series.dates.length < 750) throw new Error(`历史不足: ${series.dates.length}`);
    const last = series.dates.at(-1);
    const bondDate = Object.keys(bond).sort().filter((d) => d <= last).at(-1);
    settled = { series, settled_price: priceRows.find((r) => r.date === last)?.close,
      bond_last: bond[bondDate], bond_date: bondDate, cached_at: now.toISOString() };
    await writeSettled(env, settled);
    historySource = "live";
  }
  const quote = await quotePromise;
  return resultFromSettled(settled, quote, { now, historySource });
}

export function resultFromSettled(settled, quote = null, { now = new Date(), historySource = "cache" } = {}) {
  const series = settled.series;
  const last = series.dates.length - 1;
  const signals = buildSignals(series);
  const run = runBacktest(series, undefined, signals, 1);
  const m = metrics(run.curve);
  const cur = signalDetail(series);
  const windows = {};
  for (const [key, w] of Object.entries(cur.windows)) {
    windows[key] = { label: w.label, pe_percentile: w.pePercentile, erp_percentile: w.erpPercentile, exposure: w.exposure };
  }
  const today = compact(chinaNow(now));
  const intraday = quote && quote.date === today && quote.date >= series.dates[last] && quote.level > 0 ? quote : null;
  const cn = chinaNow(now), minute = cn.getUTCHours() * 60 + cn.getUTCMinutes();
  const quoteTime = intraday?.time?.match(/(\d{1,2}):(\d{2})/);
  const quoteAge = quoteTime ? minute - (Number(quoteTime[1]) * 60 + Number(quoteTime[2])) : Infinity;
  const marketSession = (minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900);
  const live = Boolean(intraday && marketSession && quoteAge >= 0 && quoteAge <= 15);
  const quality = dataQuality(series, settled.bond_date, now);
  const first = series.dates.indexOf(m.start);
  const buyHold = series.dates.slice(first).map((d, i) => [d, series.tr[first + i] / series.tr[first]]);
  const table = valuationTable(series, settled.settled_price);
  const conditional = quality.actionable ? conditionalLevels(series, settled.settled_price, settled.bond_last) : null;
  const average = run.exposures.reduce((a, b) => a + b, 0) / run.exposures.length;
  // A fixed INITIAL allocation drifts over time; it is a budget comparison,
  // not a volatility-matched benchmark (average exposure is known ex post).
  const matched = buyHold.map(([d, nav]) => [d, 1 - average + average * nav]);
  return {
    model_version: DEFAULT_CONFIG.version,
    as_of: series.dates[last], price_asof: series.dates[last],
    quote_status: live ? "盘中报价仅供观察" : "已收盘数据",
    history_source: historySource, live, intraday,
    price_index: { code: "000300", level: settled.settled_price },
    total_return_index: { code: "H00300", level: series.tr[last] },
    pe: +series.pe[last].toFixed(4),
    pe_percentile: +percentileOfHistory(series.pe.slice(0, -1), series.pe[last]).toFixed(2),
    erp: +series.spread[last].toFixed(4),
    erp_percentile: +percentileOfHistory(series.spread.slice(0, -1), series.spread[last]).toFixed(2),
    bond: { value: settled.bond_last, as_of: settled.bond_date }, quality,
    windows, consensus: { agreed: cur.agreed, exposure: cur.consensus_exposure, vote: cur.vote, span: cur.span },
    target_exposure: cur.consensus_exposure, execution: confirmationState(signals),
    ...table, conditional_levels: conditional,
    backtest: { cagr_calendar_pct: m.cagrCalendarPct, max_drawdown_pct: m.maxDrawdownPct,
      sharpe: m.sharpe, trades: run.steps.length, avg_exposure: +average.toFixed(4),
      start: m.start, end: m.end, buy_hold: metrics(buyHold), budget_comparison: metrics(matched) },
    chart: { dates: series.dates.slice(-500), price: series.tr.slice(-500), pe: series.pe.slice(-500), exposure: run.exposures.slice(-500) },
    disclosures: [
      "仓位以沪深300策略专用资金池为分母，不是家庭总资产；本页面未读取你的真实持仓。",
      "正式信号仅使用已发布的收盘数据，盘中报价不参与确认。买入1次收盘确认、卖出2次连续收盘确认，次一交易日收盘执行，每次最多调整12.5个百分点，5个百分点以内不调仓。",
      "三窗口均有足够历史且目标一致才给目标仓位；分歧仅表示模型不调仓，不能据此断言市场没有投资优势。",
      "研究参数在同一历史样本中选择，没有干净样本外验证，也没有经核实的实盘业绩。历史回测不代表未来收益。",
      "回测使用全收益指数，交易单边费用5bp，现金收益0；未扣基金管理费、跟踪误差和额外冲击成本。夏普按252日、无风险收益0估算。",
      "等初始预算比较中的比例来自事后平均仓位，不是波动率匹配，也不是可提前获得的最优比例。最大回撤不代表未来亏损上限。",
    ],
  };
}
