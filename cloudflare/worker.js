import config from "../config.json" with { type: "json" };
import { getHs300Dashboard, refreshHs300, SERVICE_VERSION as hs300ServiceVersion } from "./lib/hs300-dashboard.js";
import { DEFAULT_CONFIG as hs300Config } from "./lib/hs300-model.js";
import { getEtfFlows, refreshEtfFlows } from "./lib/hs300-etf-flows.js";
import { assemblePortfolioDashboard, PORTFOLIO_SERVICE_VERSION } from "./lib/portfolio-dashboard.js";

const CSI_BASE = "https://www.csindex.com.cn/csindex-home";
const DANJUAN_URL = "https://danjuanfunds.com/djapi/index_eva/detail/CSIH30269";
const CHINABOND_URL = "https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery";
const EM_BOND_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_TREASURYYIELD&columns=ALL&pageSize=50&pageNumber=1&sortColumns=SOLAR_DATE&sortTypes=-1";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36";
const DASHBOARD_CACHE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function shiftedChinaDate(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000);
}

export function chinaDate(date = new Date()) {
  return shiftedChinaDate(date).toISOString().slice(0, 10);
}

export function chinaIso(date = new Date()) {
  return shiftedChinaDate(date).toISOString().slice(0, 19);
}

function compactDate(value) {
  return value.replaceAll("-", "");
}

function dateMinusDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function daysOld(value, now = new Date()) {
  if (!value) return null;
  const datePart = String(value).slice(0, 10);
  const parsed = Date.parse(`${datePart}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;
  const today = Date.parse(`${chinaDate(now)}T00:00:00Z`);
  return Math.floor((today - parsed) / DAY_MS);
}

async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}: ${url}`);
      if (![429, 500, 502, 503, 504].includes(response.status)) throw lastError;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw lastError || new Error(`请求失败：${url}`);
}

async function fetchJson(url, { referer } = {}) {
  const headers = {
    Accept: "application/json,text/html;q=0.9,*/*;q=0.8",
    "User-Agent": USER_AGENT,
  };
  if (referer) headers.Referer = referer;
  const response = await fetchWithRetry(url, { headers });
  return response.json();
}

function normalizeCsiRows(items) {
  const rows = new Map();
  for (const item of items || []) {
    const rawDate = String(item.tradeDate || "");
    const close = Number(item.close);
    if (rawDate.length !== 8 || !Number.isFinite(close) || close === 0) continue;
    const day = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6)}`;
    const open = Number(item.open || close);
    const rawHigh = Number(item.high || close);
    const rawLow = Number(item.low || close);
    const rawPe = Number(item.peg);
    rows.set(day, {
      date: day,
      open,
      high: Math.max(open, rawHigh, rawLow, close),
      low: Math.min(open, rawHigh, rawLow, close),
      close,
      pe: Number.isFinite(rawPe) && rawPe > 0 ? rawPe : null,
    });
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchCsiSeries(code, now = new Date(), { includeIntraday = Boolean(config.use_intraday) } = {}) {
  const today = chinaDate(now);
  const start = dateMinusDays(today, Number(config.history_calendar_days));
  const historyUrl = new URL(`${CSI_BASE}/perf/index-perf`);
  historyUrl.search = new URLSearchParams({
    indexCode: code,
    startDate: compactDate(start),
    endDate: compactDate(today),
  });
  const detailUrl = `https://www.csindex.com.cn/zh-CN/indices/index-detail/${code}`;
  const payload = await fetchJson(historyUrl, { referer: detailUrl });
  if (String(payload.code) !== "200") {
    throw new Error(`中证历史行情失败 ${code}: ${payload.msg || "未知错误"}`);
  }
  let rows = normalizeCsiRows(payload.data);
  if (rows.length < 260) throw new Error(`中证历史行情不足 ${code}: 仅${rows.length}条`);

  let quoteStatus = "历史收盘";
  if (includeIntraday) {
    try {
      const quoteUrl = new URL(`${CSI_BASE}/perf/index-perf-oneday`);
      quoteUrl.search = new URLSearchParams({ indexCode: code });
      const quotePayload = await fetchJson(quoteUrl, { referer: detailUrl });
      const header = quotePayload?.data?.intraDayHeader || {};
      const perfList = quotePayload?.data?.intraDayPerfList || [];
      const rawDate = String(header.tradeDate || "");
      const current = Number(header.current);
      const quoteDay = rawDate.length === 10
        ? rawDate
        : rawDate.length === 8
          ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6)}`
          : "";
      if (quoteDay && Number.isFinite(current) && current > 0) {
        const highs = perfList.map((r) => Number(r.high)).filter((v) => Number.isFinite(v) && v > 0);
        const lows = perfList.map((r) => Number(r.low)).filter((v) => Number.isFinite(v) && v > 0);
        const openVal = Number(header.openToday || current);
        const highVal = highs.length ? Math.max(...highs, openVal, current) : Math.max(openVal, current);
        const lowVal = lows.length ? Math.min(...lows, openVal, current) : Math.min(openVal, current);
        const byDate = new Map(rows.map((row) => [row.date, { ...row }]));
        const prevRow = rows.filter((r) => r.date < quoteDay).at(-1);
        const scaledPe = prevRow?.pe && prevRow.close > 0 ? prevRow.pe * (current / prevRow.close) : null;
        if (byDate.has(quoteDay)) {
          const existing = byDate.get(quoteDay);
          existing.close = current;
          existing.high = Math.max(existing.high, highVal, current);
          existing.low = Math.min(existing.low, lowVal, current);
          if (!existing.pe && scaledPe) existing.pe = scaledPe;
        } else {
          byDate.set(quoteDay, {
            date: quoteDay,
            open: openVal,
            high: highVal,
            low: lowVal,
            close: current,
            pe: scaledPe,
          });
        }
        rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
        quoteStatus = String(header.tradeTime || "") >= "15:05:00" ? "收盘后" : "盘中";
      }
    } catch {
      // Intraday endpoint failure leaves official daily series intact.
    }
  }

  return {
    code,
    rows,
    source: "中证指数有限公司",
    source_url: historyUrl.origin + historyUrl.pathname,
    fetched_at: chinaIso(now),
    quote_status: quoteStatus,
    cache_status: "live",
  };
}

async function kvGet(env, key) {
  if (!env?.H30269_KV) return null;
  try {
    return await env.H30269_KV.get(key, { type: "json" });
  } catch {
    return null;
  }
}

async function kvPut(env, key, value) {
  if (!env?.H30269_KV) return;
  await env.H30269_KV.put(key, JSON.stringify(value));
}

async function getSeries(env, code, now = new Date(), { includeIntraday = Boolean(config.use_intraday) } = {}) {
  try {
    const live = await fetchCsiSeries(code, now, { includeIntraday });
    await kvPut(env, `series:${code}`, live);
    return { bundle: live, warning: null };
  } catch (error) {
    const cached = await kvGet(env, `series:${code}`);
    const age = cached?.fetched_at
      ? (now.getTime() - Date.parse(`${cached.fetched_at}+08:00`)) / DAY_MS
      : Number.POSITIVE_INFINITY;
    if (!cached || age > Number(config.cache_max_age_days)) throw error;
    return {
      bundle: { ...cached, cache_status: "cache" },
      warning: `${code} 在线抓取失败，使用云端缓存：${error.message}`,
    };
  }
}

async function cachedSource(env, key) {
  const value = await kvGet(env, `source:${key}`);
  if (!value || daysOld(value.as_of) > Number(config.max_fundamental_age_days)) return null;
  return { ...value, source: `云端缓存：${value.source}`, status: "cache" };
}

export function impliedDividendYield(priceRows, trRows) {
  if (!priceRows?.length || !trRows?.length || priceRows.length !== trRows.length || priceRows.length < 240) {
    return null;
  }
  const endDate = Date.parse(`${priceRows.at(-1).date}T00:00:00Z`);
  const startDate = Date.parse(`${priceRows[0].date}T00:00:00Z`);
  if (!Number.isFinite(endDate) || !Number.isFinite(startDate) || (endDate - startDate) < 350 * DAY_MS) {
    return null;
  }
  const cutoff = endDate - 365 * DAY_MS;
  let divPoints = 0;
  for (let i = 1; i < priceRows.length; i += 1) {
    const rowTime = Date.parse(`${priceRows[i].date}T00:00:00Z`);
    if (rowTime <= cutoff) continue;
    const prevP = Number(priceRows[i - 1].close);
    const currP = Number(priceRows[i].close);
    const prevTr = Number(trRows[i - 1].close);
    const currTr = Number(trRows[i].close);
    if (prevP > 0 && prevTr > 0) {
      const diff = (currTr / prevTr - 1) - (currP / prevP - 1);
      if (diff > 0) divPoints += prevP * diff;
    }
  }
  const latestPrice = Number(priceRows.at(-1).close);
  if (!(latestPrice > 0) || !(divPoints > 0)) return null;
  return {
    value: (divPoints / latestPrice) * 100,
    as_of: priceRows.at(-1).date,
  };
}

export async function fetchDividendYield(env, now = new Date(), { implied = null } = {}) {
  try {
    const payload = await fetchJson(DANJUAN_URL, { referer: "https://danjuanfunds.com/" });
    const rawYield = Number(payload?.data?.yeild);
    if (!Number.isFinite(rawYield) || rawYield <= 0) throw new Error("蛋卷接口没有返回yeild字段");
    const ts = Number(payload?.data?.ts);
    const result = {
      value: rawYield * 100,
      as_of: Number.isFinite(ts) && ts > 0 ? chinaDate(new Date(ts)) : null,
      source: "蛋卷基金公开指数估值接口",
      source_url: DANJUAN_URL,
      status: "live",
    };
    await kvPut(env, "source:dividend_yield", result);
    return result;
  } catch (error) {
    if (implied && Number.isFinite(implied.value) && implied.value > 0) {
      const fallbackLive = {
        value: implied.value,
        as_of: implied.as_of,
        source: "中证全收益/价格指数推算TTM股息率",
        source_url: `${CSI_BASE}/perf/index-perf`,
        status: "live-implied",
      };
      await kvPut(env, "source:dividend_yield", fallbackLive);
      return fallbackLive;
    }
    const cached = await cachedSource(env, "dividend_yield");
    if (cached) return cached;
    return { value: null, as_of: null, source: `抓取失败：${error.message}`, source_url: DANJUAN_URL, status: "missing" };
  }
}

function decodeCell(value) {
  return value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;?/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseBond10y(html) {
  const values = [];
  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((match) => decodeCell(match[1]));
    if (cells.length < 10 || cells[0] !== "中债国债收益率曲线") continue;
    const value = Number(cells[8]);
    if (Number.isFinite(value)) values.push([cells[1], value]);
  }
  values.sort((a, b) => a[0].localeCompare(b[0]));
  if (!values.length) throw new Error("中债页面没有解析到10年国债收益率");
  return { as_of: values.at(-1)[0], value: values.at(-1)[1] };
}

export async function fetchBond10y(env, now = new Date()) {
  try {
    const today = chinaDate(now);
    const url = new URL(CHINABOND_URL);
    url.search = new URLSearchParams({
      startDate: dateMinusDays(today, 21),
      endDate: today,
      gjqx: "0",
      qxId: "ycqx",
      locale: "cn_ZH",
    });
    const response = await fetchWithRetry(url, { headers: { "User-Agent": USER_AGENT } });
    const parsed = parseBond10y(await response.text());
    const result = {
      value: parsed.value,
      as_of: parsed.as_of,
      source: "中国债券信息网：中债国债收益率曲线",
      source_url: CHINABOND_URL,
      status: "live",
    };
    await kvPut(env, "source:bond_10y", result);
    return result;
  } catch (primaryError) {
    try {
      const emPayload = await fetchJson(EM_BOND_URL);
      const rows = (emPayload?.result?.data || [])
        .map((r) => [String(r.SOLAR_DATE || "").slice(0, 10), Number(r.EMM00166466)])
        .filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(v) && v > 0)
        .sort((a, b) => a[0].localeCompare(b[0]));
      if (!rows.length) throw new Error("东财国债数据为空");
      const latest = rows.at(-1);
      const result = {
        value: latest[1],
        as_of: latest[0],
        source: "东方财富中债10年期国债收益率（备用直连）",
        source_url: "https://datacenter-web.eastmoney.com/",
        status: "live",
      };
      await kvPut(env, "source:bond_10y", result);
      return result;
    } catch (backupError) {
      const cached = await cachedSource(env, "bond_10y");
      if (cached) return cached;
      return {
        value: null,
        as_of: null,
        source: `抓取失败：${primaryError.message}；备用失败：${backupError.message}`,
        source_url: CHINABOND_URL,
        status: "missing",
      };
    }
  }
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function relativeZone(relativePct, thresholds = config.thresholds.relative) {
  if (relativePct <= thresholds.strong_buy_max) return "强买";
  if (relativePct <= thresholds.add_max) return "加仓";
  if (relativePct <= thresholds.buy_max) return "买入";
  if (relativePct < thresholds.hold_min) return "观察";
  if (relativePct < thresholds.reduce_min) return "持有";
  if (relativePct < thresholds.strong_sell_min) return "相对偏热";
  return "相对过热";
}

function signalGroup(relativePct, thresholds = config.thresholds.relative) {
  if (relativePct <= thresholds.buy_max) return "buy";
  if (relativePct < thresholds.reduce_min) return "hold";
  if (relativePct < thresholds.strong_sell_min) return "pause_add";
  return "overheat";
}

export function estimateBeta(targetRows, benchmarkRows, endIndex, window, minimumObservations, fallback) {
  const start = Math.max(1, endIndex - window + 1);
  const targetReturns = [];
  const benchmarkReturns = [];
  for (let index = start; index <= endIndex; index += 1) {
    targetReturns.push(Number(targetRows[index].close) / Number(targetRows[index - 1].close) - 1);
    benchmarkReturns.push(Number(benchmarkRows[index].close) / Number(benchmarkRows[index - 1].close) - 1);
  }
  const observations = targetReturns.length;
  const unavailable = (source) => ({
    beta: fallback,
    observations,
    window,
    source,
    sufficient: false,
    correlation: null,
    r2: null,
    standard_error: null,
    ci95_low: null,
    ci95_high: null,
  });
  if (observations < minimumObservations) return unavailable("fallback-insufficient");

  const targetMean = mean(targetReturns);
  const benchmarkMean = mean(benchmarkReturns);
  let covariance = 0;
  let benchmarkVariance = 0;
  let targetVariance = 0;
  for (let index = 0; index < observations; index += 1) {
    const targetDelta = targetReturns[index] - targetMean;
    const benchmarkDelta = benchmarkReturns[index] - benchmarkMean;
    covariance += targetDelta * benchmarkDelta;
    benchmarkVariance += benchmarkDelta ** 2;
    targetVariance += targetDelta ** 2;
  }
  if (benchmarkVariance === 0) return unavailable("fallback-zero-variance");
  const beta = covariance / benchmarkVariance;
  const alpha = targetMean - beta * benchmarkMean;
  let residualSum = 0;
  for (let index = 0; index < observations; index += 1) {
    residualSum += (targetReturns[index] - alpha - beta * benchmarkReturns[index]) ** 2;
  }
  const correlation = targetVariance > 0 ? covariance / Math.sqrt(benchmarkVariance * targetVariance) : null;
  const standardError = observations > 2
    ? Math.sqrt(residualSum / Math.max(1, observations - 2) / benchmarkVariance)
    : null;
  return {
    beta,
    observations,
    window,
    source: observations >= window ? "rolling-full" : "rolling-partial",
    sufficient: true,
    correlation,
    r2: correlation === null ? null : correlation ** 2,
    standard_error: standardError,
    ci95_low: standardError === null ? null : beta - 1.96 * standardError,
    ci95_high: standardError === null ? null : beta + 1.96 * standardError,
  };
}

function evaluateMultiWindowBeta(targetRows, benchmarkRows, endIndex, targetReturn40, benchmarkReturn40) {
  const betaConfig = config.beta;
  const thresholds = config.thresholds.relative;
  const r2Ref = Number(betaConfig.shrinkage_r2_ref || 0);
  const rawWindows = {};
  for (const [label, definition] of Object.entries(betaConfig.windows)) {
    rawWindows[label] = estimateBeta(
      targetRows,
      benchmarkRows,
      endIndex,
      Number(definition.trading_days),
      Number(definition.minimum_observations),
      Number(betaConfig.fallback),
    );
  }
  const primaryLabel = String(betaConfig.primary_window);
  const anchor = rawWindows[primaryLabel];
  const windows = {};
  for (const [label, estimate] of Object.entries(rawWindows)) {
    let effectiveBeta = estimate.beta;
    let shrinkWeight = 1;
    if (
      estimate.sufficient
      && anchor?.sufficient
      && label !== primaryLabel
      && r2Ref > 0
      && estimate.r2 !== null
    ) {
      shrinkWeight = Math.min(1, Math.max(0, estimate.r2 / r2Ref));
      effectiveBeta = shrinkWeight * estimate.beta + (1 - shrinkWeight) * anchor.beta;
    }
    const adjusted = targetReturn40 - effectiveBeta * benchmarkReturn40;
    windows[label] = {
      ...estimate,
      raw_beta: estimate.beta,
      beta: effectiveBeta,
      shrinkage_weight: shrinkWeight,
      adjusted_spread_pct: adjusted * 100,
      zone: relativeZone(adjusted * 100, thresholds),
      group: signalGroup(adjusted * 100, thresholds),
    };
  }
  return windows;
}

function computeBetaSnapshot(targetRows, benchmarkRows, targetReturn40, benchmarkReturn40, quoteStatus) {
  const betaConfig = config.beta;
  const thresholds = config.thresholds.relative;
  const completedEnd = targetRows.length - (quoteStatus === "盘中" ? 2 : 1);
  const windows = evaluateMultiWindowBeta(targetRows, benchmarkRows, completedEnd, targetReturn40, benchmarkReturn40);

  let primaryWindow = String(betaConfig.primary_window);
  let primary = windows[primaryWindow];
  if (!primary.sufficient) {
    const usable = Object.entries(windows).filter(([, value]) => value.sufficient);
    if (usable.length) [primaryWindow, primary] = usable.at(-1);
  }
  const usableWindows = Object.values(windows).filter((value) => value.sufficient);
  const adjustedValues = usableWindows.map((value) => value.adjusted_spread_pct);
  const groups = new Set(usableWindows.map((value) => value.group));
  const consensus = usableWindows.length >= 2 && groups.size === 1;
  const robustBuy = usableWindows.length > 0 && adjustedValues.every((value) => value <= thresholds.buy_max);
  const robustOverheat = usableWindows.length > 0 && adjustedValues.every((value) => value >= thresholds.strong_sell_min);
  return {
    primary_window: primaryWindow,
    primary,
    windows,
    band_low_pct: adjustedValues.length ? Math.min(...adjustedValues) : null,
    band_high_pct: adjustedValues.length ? Math.max(...adjustedValues) : null,
    beta_low: usableWindows.length ? Math.min(...usableWindows.map((value) => value.beta)) : null,
    beta_high: usableWindows.length ? Math.max(...usableWindows.map((value) => value.beta)) : null,
    consensus,
    robust_buy: robustBuy,
    robust_overheat: robustOverheat,
    reliability: usableWindows.length === 0 ? "样本不足" : consensus ? "窗口一致" : "窗口分歧",
    note: "Beta经R²稳健收缩校正市场敏感度，不单独触发交易",
  };
}

function computeReduceConfirmation(targetRows, benchmarkRows, quoteStatus) {
  const required = Number(config.confirmation.tactical_overheat_closes);
  const coreRequired = Number(config.confirmation.core_overheat_closes);
  const threshold = Number(config.thresholds.relative.strong_sell_min);
  const sellCfg = config.thresholds.sell_confirmation;
  const minRet40 = Number(sellCfg.target_40d_return_min);
  const minMa250Dist = Number(sellCfg.ma250_distance_min);
  const intradayExcluded = quoteStatus === "盘中";
  const completedEnd = targetRows.length - (intradayExcluded ? 2 : 1);
  const primaryWindow = String(config.beta.primary_window);
  if (completedEnd < 250) {
    return {
      threshold_pct: threshold,
      required_closes: required,
      confirmed_closes: 0,
      consecutive_closes: 0,
      confirmed: false,
      core_required_closes: coreRequired,
      core_confirmed: false,
      intraday_excluded: intradayExcluded,
      latest_completed_date: null,
      recent_closes: [],
    };
  }
  const closes = targetRows.map((r) => Number(r.close));
  const cache = new Map();
  const stateAt = (index) => {
    if (cache.has(index)) return cache.get(index);
    const targetReturn = closes[index] / closes[index - 40] - 1;
    const benchmarkReturn = Number(benchmarkRows[index].close) / Number(benchmarkRows[index - 40].close) - 1;
    const windows = evaluateMultiWindowBeta(targetRows, benchmarkRows, index, targetReturn, benchmarkReturn);
    const usable = Object.values(windows).filter((w) => w.sufficient);
    const robustOverheat = usable.length > 0 && usable.every((w) => w.adjusted_spread_pct >= threshold);
    const ma250 = mean(closes.slice(index - 249, index + 1));
    const distMa250 = (closes[index] / ma250 - 1) * 100;
    const primary = windows[primaryWindow];
    const passed = robustOverheat
      && (targetReturn * 100 >= minRet40)
      && (distMa250 >= minMa250Dist);
    const value = {
      adjusted_spread_pct: primary.adjusted_spread_pct,
      beta: primary.beta,
      sufficient: primary.sufficient,
      passed,
    };
    cache.set(index, value);
    return value;
  };
  let consecutive = 0;
  for (let index = completedEnd; index >= 250; index -= 1) {
    if (!stateAt(index).passed) break;
    consecutive += 1;
  }
  const recentCloses = [];
  for (let index = Math.max(250, completedEnd - coreRequired + 1); index <= completedEnd; index += 1) {
    const item = stateAt(index);
    recentCloses.push({
      date: targetRows[index].date,
      beta_adjusted_spread_pct: item.adjusted_spread_pct,
      beta: item.beta,
      passed: item.passed,
    });
  }
  return {
    threshold_pct: threshold,
    required_closes: required,
    confirmed_closes: Math.min(consecutive, required),
    consecutive_closes: consecutive,
    confirmed: consecutive >= required,
    core_required_closes: coreRequired,
    core_confirmed: consecutive >= coreRequired,
    intraday_excluded: intradayExcluded,
    latest_completed_date: targetRows[completedEnd].date,
    recent_closes: recentCloses,
  };
}

export function bondSupport(dividendYield, bondYield, thresholds = config.thresholds.bond) {
  if (dividendYield === null || dividendYield === undefined || bondYield === null || bondYield === undefined || bondYield === 0) {
    return ["数据缺失", null, null];
  }
  const spread = dividendYield - bondYield;
  const multiple = dividendYield / bondYield;
  let label;
  if (spread >= thresholds.strong_spread_min || multiple >= thresholds.strong_multiple_min) label = "股债强支撑";
  else if (spread >= thresholds.support_spread_min || multiple >= thresholds.support_multiple_min) label = "股债有支撑";
  else if (spread >= thresholds.neutral_spread_min || multiple >= thresholds.neutral_multiple_min) label = "中性";
  else label = "股债弱支撑";
  return [label, spread, multiple];
}

function bridgeProvisionalTr(priceRows, trRows) {
  if (!trRows?.length || !priceRows?.length) return priceRows;
  const trMap = new Map(trRows.map((row) => [row.date, { ...row }]));
  const lastPrice = priceRows.at(-1);
  const prevPrice = priceRows.length >= 2 ? priceRows.at(-2) : null;
  if (lastPrice && prevPrice && prevPrice.close > 0 && trMap.has(prevPrice.date)) {
    const prevTr = trMap.get(prevPrice.date);
    const scaledClose = prevTr.close * (lastPrice.close / prevPrice.close);
    if (!trMap.has(lastPrice.date)) {
      trMap.set(lastPrice.date, {
        date: lastPrice.date,
        open: scaledClose,
        high: scaledClose,
        low: scaledClose,
        close: scaledClose,
        pe: lastPrice.pe ?? prevTr.pe ?? null,
      });
    }
  }
  return [...trMap.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function alignSeries(target, benchmark, targetTr = null, benchmarkTr = null) {
  const trTargetBundle = targetTr?.rows?.length ? { ...targetTr, rows: bridgeProvisionalTr(target.rows, targetTr.rows) } : target;
  const trBenchBundle = benchmarkTr?.rows?.length ? { ...benchmarkTr, rows: bridgeProvisionalTr(benchmark.rows, benchmarkTr.rows) } : benchmark;

  const targetMap = new Map(target.rows.map((row) => [row.date, row]));
  const benchmarkMap = new Map(benchmark.rows.map((row) => [row.date, row]));
  const trTargetMap = new Map(trTargetBundle.rows.map((row) => [row.date, row]));
  const trBenchMap = new Map(trBenchBundle.rows.map((row) => [row.date, row]));

  const common = [...targetMap.keys()]
    .filter((day) => benchmarkMap.has(day) && trTargetMap.has(day) && trBenchMap.has(day))
    .sort();
  if (common.length < 260) throw new Error(`指数共同交易日不足：${common.length}`);
  const warnings = [];
  if (target.rows.at(-1).date !== benchmark.rows.at(-1).date) {
    warnings.push(`两条指数最新日期不一致，已统一使用最近共同交易日 ${common.at(-1)}`);
  }
  return {
    targetRows: common.map((day) => targetMap.get(day)),
    benchmarkRows: common.map((day) => benchmarkMap.get(day)),
    trTargetRows: common.map((day) => trTargetMap.get(day)),
    trBenchmarkRows: common.map((day) => trBenchMap.get(day)),
    usingTotalReturn: Boolean(targetTr?.rows?.length && benchmarkTr?.rows?.length),
    warnings,
  };
}

function computePeValuation(priceRows, trRows) {
  const minObs = Number(config.thresholds.valuation_gate?.min_observations || 500);
  const peSeries = priceRows.map((row, idx) => row.pe ?? trRows?.[idx]?.pe ?? null);
  const peNow = peSeries.at(-1) ?? null;
  const history = peSeries.slice(0, -1).filter((v) => Number.isFinite(v) && v > 0);
  if (!(peNow > 0) || history.length < minObs) {
    return { pe: peNow, pe_percentile: null, pe_observations: history.length };
  }
  let below = 0;
  for (const x of history) if (x <= peNow) below += 1;
  return {
    pe: peNow,
    pe_percentile: (100 * below) / history.length,
    pe_observations: history.length,
  };
}

export function computeMetrics(targetRows, benchmarkRows, dividend, bond, quoteStatus = "历史收盘", trTargetRows = null, trBenchmarkRows = null) {
  const sigTarget = trTargetRows?.length === targetRows.length ? trTargetRows : targetRows;
  const sigBench = trBenchmarkRows?.length === benchmarkRows.length ? trBenchmarkRows : benchmarkRows;

  const priceClose = targetRows.map((row) => Number(row.close));
  const benchPriceClose = benchmarkRows.map((row) => Number(row.close));
  const sigTargetClose = sigTarget.map((row) => Number(row.close));
  const sigBenchClose = sigBench.map((row) => Number(row.close));

  const now = priceClose.at(-1);
  const benchmarkNow = benchPriceClose.at(-1);
  const trNow = sigTargetClose.at(-1);
  const trBenchNow = sigBenchClose.at(-1);

  const targetReturn40 = trNow / sigTargetClose.at(-41) - 1;
  const benchmarkReturn40 = trBenchNow / sigBenchClose.at(-41) - 1;
  const rawRelative = targetReturn40 - benchmarkReturn40;
  const betaSnapshot = computeBetaSnapshot(sigTarget, sigBench, targetReturn40, benchmarkReturn40, quoteStatus);
  const primary = betaSnapshot.primary;

  const movingAverage = {};
  for (const window of [20, 30, 60, 120, 250]) movingAverage[window] = mean(priceClose.slice(-window));
  const trMa20 = mean(sigTargetClose.slice(-20));
  const trMa250 = mean(sigTargetClose.slice(-250));

  const ret20 = trNow / sigTargetClose.at(-21) - 1;
  const aboveMa20 = trNow > trMa20;
  const momentum = aboveMa20 && ret20 > 0 ? "转强" : !aboveMa20 && ret20 < 0 ? "转弱" : "中性";
  const distanceMa250 = trNow / trMa250 - 1;
  const priceDistanceMa250 = now / movingAverage[250] - 1;
  const [support, spread, multiple] = bondSupport(dividend.value, bond.value);
  const peInfo = computePeValuation(targetRows, sigTarget);

  return {
    trade_date: targetRows.at(-1).date,
    close: now,
    benchmark_close: benchmarkNow,
    tr_close: trNow,
    benchmark_tr_close: trBenchNow,
    signal_return_basis: sigTarget === targetRows ? "price" : "total_return",
    target_40d_base_date: sigTarget.at(-41).date,
    benchmark_40d_base_date: sigBench.at(-41).date,
    target_40d_return_pct: targetReturn40 * 100,
    benchmark_40d_return_pct: benchmarkReturn40 * 100,
    raw_relative_spread_pct: rawRelative * 100,
    relative_spread_pct: primary.adjusted_spread_pct,
    beta_adjusted_spread_pct: primary.adjusted_spread_pct,
    primary_signal_metric: "beta_adjusted_spread_pct",
    relative_zone: relativeZone(primary.adjusted_spread_pct),
    beta: primary.beta,
    beta_window: betaSnapshot.primary_window,
    beta_observations: primary.observations,
    beta_source: primary.source,
    beta_correlation: primary.correlation,
    beta_r2: primary.r2,
    beta_ci95_low: primary.ci95_low,
    beta_ci95_high: primary.ci95_high,
    beta_windows: betaSnapshot.windows,
    beta_band_low_pct: betaSnapshot.band_low_pct,
    beta_band_high_pct: betaSnapshot.band_high_pct,
    beta_low: betaSnapshot.beta_low,
    beta_high: betaSnapshot.beta_high,
    beta_consensus: {
      consistent: betaSnapshot.consensus,
      robust_buy: betaSnapshot.robust_buy,
      robust_overheat: betaSnapshot.robust_overheat,
      status: betaSnapshot.reliability,
      note: betaSnapshot.note,
    },
    quote_status: quoteStatus,
    reduce_confirmation: computeReduceConfirmation(sigTarget, sigBench, quoteStatus),
    ma20: movingAverage[20],
    ma30: movingAverage[30],
    ma60: movingAverage[60],
    ma120: movingAverage[120],
    ma250: movingAverage[250],
    tr_ma250: trMa250,
    ret20_pct: ret20 * 100,
    above_ma20: aboveMa20,
    momentum,
    distance_ma250_pct: distanceMa250 * 100,
    price_distance_ma250_pct: priceDistanceMa250 * 100,
    pe: peInfo.pe,
    pe_percentile: peInfo.pe_percentile,
    pe_observations: peInfo.pe_observations,
    dividend_yield_pct: dividend.value,
    bond10_pct: bond.value,
    equity_bond_spread_pct: spread,
    equity_bond_multiple: multiple,
    bond_support: support,
  };
}

export function dataQuality(metrics, dividend, bond, warnings = [], now = new Date()) {
  const blockers = [];
  const qualityWarnings = [...warnings];
  const marketAge = daysOld(metrics.trade_date, now);
  if (marketAge === null || marketAge > Number(config.max_market_age_days)) {
    blockers.push("行情日期过旧，拒绝给出买卖动作");
  }
  for (const [name, value] of [["股息率", dividend], ["10年国债", bond]]) {
    const age = daysOld(value.as_of, now);
    if (value.value === null || value.value === undefined || value.status === "missing" || value.status === "fallback") {
      blockers.push(`${name}缺失或仅剩静态旧值，拒绝给出自动买卖动作`);
    } else if (age === null || age > Number(config.max_fundamental_age_days)) {
      blockers.push(`${name}数据超过${config.max_fundamental_age_days}天未更新（${value.as_of}），暂停自动交易动作`);
    }
  }
  if (String(metrics.beta_source || "").startsWith("fallback")) qualityWarnings.push("Beta历史样本不足，已使用保守回退值，禁止卖出确认");
  if (metrics.beta_consensus && !metrics.beta_consensus.consistent) qualityWarnings.push("2年、3年、5年Beta窗口结论不一致，动作降级为观察");
  return {
    confidence: blockers.length ? "低" : qualityWarnings.length ? "中" : "高",
    blockers,
    warnings: qualityWarnings,
  };
}

function ruleResult(actionCode, decision, reason, options = {}) {
  const pct = options.pct || 0;
  return {
    action_code: actionCode,
    decision,
    reason,
    confirmed: Boolean(options.confirmed),
    execution: {
      scope: options.scope || "无",
      pct,
      planned_pct: options.planned_pct || pct,
      core_action: options.core_action || "不动",
      timing: options.timing || "立即",
    },
  };
}

function buyTrancheForZone(zone) {
  const ex = config.execution;
  if (zone === "强买") return Number(ex.strong_buy_tranche_pct || ex.buy_tranche_pct);
  if (zone === "加仓") return Number(ex.add_tranche_pct || ex.buy_tranche_pct);
  return Number(ex.buy_tranche_pct);
}

export function evaluateRules(metrics, quality) {
  if (quality.blockers.length) return ruleResult("data_blocked", "暂停行动", quality.blockers.join("；"), { confirmed: false, timing: "数据恢复后重算" });
  const zone = metrics.relative_zone;
  const support = metrics.bond_support;
  const momentum = metrics.momentum;
  const consensus = metrics.beta_consensus || {};
  const adjusted = Number(metrics.beta_adjusted_spread_pct);
  const sell = config.thresholds.sell_confirmation;
  const valGate = config.thresholds.valuation_gate || {};
  const highPePct = Number(valGate.high_pe_percentile || 80);
  const corePePct = Number(valGate.core_review_pe_percentile || 75);
  const pePct = metrics.pe_percentile ?? null;
  const aboveYear = metrics.distance_ma250_pct >= Number(sell.ma250_distance_min);
  const highAboveYear = metrics.distance_ma250_pct >= Number(sell.core_ma250_distance_min);
  const absoluteGain = metrics.target_40d_return_pct >= Number(sell.target_40d_return_min);
  const supportOk = new Set(["股债强支撑", "股债有支撑", "中性"]).has(support);
  const buyPct = buyTrancheForZone(zone);

  if (new Set(["强买", "加仓", "买入"]).has(zone)) {
    if (!consensus.robust_buy) return ruleResult("beta_window_conflict", "观察，等待Beta窗口一致", "5年主信号进入买入区，但2年、3年、5年校正结果未全部确认低估", { confirmed: false, timing: "等待多窗口一致" });
    if (!supportOk) return ruleResult("buy_watch", "观察", `主信号为${zone}，但股债确认不足（${support}）`, { confirmed: false, timing: "等待股债支撑恢复" });
    if (zone !== "强买" && pePct !== null && pePct >= highPePct) {
      return ruleResult("valuation_high_watch", "观察，绝对估值偏高", `相对差进入${zone}区，但红利低波PE位于历史${pePct.toFixed(1)}%高分位，防止高位追买`, { confirmed: false, timing: "等待PE分位回落至80%以下或极端强买" });
    }
    const action = momentum === "转强" ? `分批买入（${buyPct}%），可加快执行` : momentum === "转弱" ? `左侧分批买入（${buyPct}%），不满仓` : `分批买入（${buyPct}%）`;
    const timingReason = momentum === "转强" ? "短期趋势已确认转强" : momentum === "转弱" ? "短期趋势未确认，两次加仓建议间隔至少5个交易日" : "短期趋势中性，两次加仓建议间隔至少5个交易日";
    return ruleResult(momentum === "转强" ? "buy_accelerate" : "buy_tranche", action, `主信号${zone}，${support}；${timingReason}`, { confirmed: true, scope: "计划仓位", pct: buyPct, core_action: "按计划分批" });
  }
  if (zone === "观察") return ruleResult("observe", "观察", "Beta调整后全收益相对差接近零，没有明显相对便宜或过热", { confirmed: true, timing: "等待主信号" });
  if (zone === "持有") return ruleResult("hold", "持有", "Beta调整后全收益相对差仍在持有区，不追涨也不减仓", { confirmed: true, timing: "继续观察" });
  if (zone === "相对偏热") return ruleResult("pause_add", "持有，暂停新增", `Beta调整后40日全收益差为${adjusted.toFixed(2)}%，只触发暂停加仓，不构成卖点`, { confirmed: true, scope: "战术仓", timing: "等待差值回落或卖出条件完整确认" });
  if (zone === "相对过热") {
    const confirmation = metrics.reduce_confirmation;
    const required = Number(confirmation.required_closes);
    const confirmedCloses = Number(confirmation.confirmed_closes);
    const intraday = Boolean(confirmation.intraday_excluded);
    const reducePct = Number(config.execution.reduce_pct);
    if (!consensus.robust_overheat) return ruleResult("beta_window_conflict", "持有，Beta窗口分歧", "5年主信号进入相对过热区，但2年、3年、5年结果未全部达到7%，不执行卖出", { confirmed: false, scope: "战术仓", timing: "等待多窗口一致" });
    if (!absoluteGain) return ruleResult("overheat_protected", "持有，暂停新增", `相对差已过热，但红利全收益40日仅${metrics.target_40d_return_pct.toFixed(2)}%，未达到5%绝对涨幅确认`, { confirmed: false, scope: "战术仓", planned_pct: reducePct, timing: "等待红利自身涨幅确认" });
    if (!aboveYear) return ruleResult("overheat_protected", "持有，年线下方保护", `相对差已过热，但全收益仍低于MA250 ${Math.abs(metrics.distance_ma250_pct).toFixed(2)}%，不执行卖出`, { confirmed: false, scope: "战术仓", planned_pct: reducePct, timing: "等待站上MA250" });
    if (!confirmation.confirmed) {
      const note = intraday ? "；当前盘中值不计入确认" : "";
      return ruleResult("overheat_watch", "过热预警，等待收盘确认", `Beta调整后差值、绝对涨幅和MA250均已达标，但仅连续${confirmedCloses}/${required}个收盘日完整达标${note}`, { confirmed: false, scope: "战术仓", planned_pct: reducePct, timing: "停止新增，等待收盘确认" });
    }
    if (intraday) return ruleResult("reduce_ready", "盘中可减战术仓，收盘再复核", "此前的正式收盘确认已完成，当前盘中过热条件仍满足；可减战术仓，收盘后独立复核，刷新不重复执行", { confirmed: true, scope: "战术仓", pct: reducePct, planned_pct: reducePct, timing: "盘中条件执行，收盘复核" });
    const valuationWeak = new Set(["中性", "股债弱支撑"]).has(support) || (pePct !== null && pePct >= corePePct);
    const coreConfirmed = Boolean(confirmation.core_confirmed) && highAboveYear && valuationWeak;
    if (coreConfirmed) return ruleResult("reduce_core_review", `核心仓降档复核，本次减${reducePct}%`, "相对过热连续5个收盘日，全收益高于MA250至少10%，且估值或股债性价比进入偏贵区", { confirmed: true, scope: "核心仓复核 + 战术仓", pct: reducePct, core_action: "降档复核（保留45%底仓）", timing: "分批执行，核心仓保留底仓" });
    return ruleResult(`reduce_tactical_${reducePct}`, `战术仓减${reducePct}%`, `Beta调整后过热已连续${required}个收盘完整确认，且红利全收益40日涨幅和MA250位置均达标`, { confirmed: true, scope: "战术仓", pct: reducePct, core_action: "不动", timing: "分批执行" });
  }
  throw new Error(`未知信号区间：${zone}`);
}

export function positionAdvice(evaluation) {
  const actionCode = evaluation.action_code;
  const execution = evaluation.execution;
  const pct = Number(execution.pct || config.execution.buy_tranche_pct);
  let noPosition;
  let normal;
  let heavy;
  if (new Set(["buy_tranche", "buy_accelerate"]).has(actionCode)) {
    noPosition = `按策略资金池先建约${pct}%一档，两次加仓间隔至少5个交易日，不一次满仓。`;
    normal = `可增加约${pct}%策略资金池仓位；短期趋势未确认时放慢节奏。`;
    heavy = "已达80%重仓线不追买；保留后续极端位置缓冲空间。";
  } else if (actionCode === "valuation_high_watch") {
    noPosition = "红利PE处于历史高分位区，不因短期跑输大盘追高建仓。";
    normal = "暂停加仓；持有现有底仓吃息，等待估值分位回落。";
    heavy = "不加仓；密切关注是否触发过热止盈信号。";
  } else if (actionCode === "reduce_core_review") {
    noPosition = "不追入，等待下一轮低估信号。";
    normal = `先减战术仓，不足部分可降核心仓（合计最多${pct}个百分点，核心仓保留至少45%底仓）。`;
    heavy = `分批减仓约${pct}个百分点（先战术仓后核心仓，保留45%底仓），避免一次性清仓。`;
  } else if (actionCode.startsWith("reduce_tactical_")) {
    noPosition = "不追入，等待下一轮相对低估信号。";
    normal = `只处理战术仓：按资金池减约${execution.pct}个百分点；核心仓不动。`;
    heavy = `战术仓先减约${execution.pct}个百分点；核心仓不动，不一次清仓。`;
  } else if (actionCode === "reduce_ready") {
    noPosition = "不追入，等待下一轮相对低估信号。";
    normal = `此前收盘确认已完成，盘中条件仍满足时可减战术仓约${execution.planned_pct}个百分点，核心仓不动；收盘后复核。`;
    heavy = `停止加仓；盘中只处理战术仓约${execution.planned_pct}个百分点，核心仓不动；收盘后复核。`;
  } else if (new Set(["overheat_watch", "overheat_protected", "pause_add"]).has(actionCode)) {
    noPosition = "停止追入，等待Beta调整后差值回落或下一轮低估信号。";
    normal = "停止新增，当前不减仓；核心仓不动，等待全部条件确认。";
    heavy = "停止加仓；只监控战术仓卖出条件，核心仓暂不处理。";
  } else if (actionCode === "beta_window_conflict") {
    noPosition = "Beta窗口结论不一致，不追入。";
    normal = "保持现有仓位，等2年、3年、5年窗口重新一致。";
    heavy = "不加仓也不因单一Beta减仓，等待多窗口确认。";
  } else if (actionCode === "hold") {
    noPosition = "不追，等Beta调整后全收益差进入买入区且股债支撑与估值合理。";
    normal = "继续持有底仓吃息，不新增大仓。";
    heavy = "持有但停止加仓，预留后续调整空间。";
  } else if (new Set(["observe", "buy_watch"]).has(actionCode)) {
    noPosition = "等待，不追；设置下一触发条件后再行动。";
    normal = "持有观察，不因单独跌破60日线卖出。";
    heavy = "不加仓；若未来进入确认减仓区，再分档降低仓位。";
  } else {
    noPosition = normal = heavy = "确认数据不足或过期，暂停行动，待数据恢复后重算。";
  }
  return { 无仓: noPosition, 普通仓位: normal, 重仓: heavy };
}

export function roundTree(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 10000) / 10000;
  if (Array.isArray(value)) return value.map(roundTree);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundTree(item)]));
  return value;
}

function rolling(values, window) {
  const output = Array(values.length).fill(null);
  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    total += values[index];
    if (index >= window) total -= values[index - window];
    if (index >= window - 1) output[index] = total / window;
  }
  return output;
}

export function chartData(targetRows, benchmarkRows, quoteStatus, limit = 270, trTargetRows = null, trBenchmarkRows = null) {
  const sigTarget = trTargetRows?.length === targetRows.length ? trTargetRows : targetRows;
  const sigBench = trBenchmarkRows?.length === benchmarkRows.length ? trBenchmarkRows : benchmarkRows;

  const dates = targetRows.map((r) => r.date);
  const priceCloses = targetRows.map((row) => Number(row.close));
  const sigCloses = sigTarget.map((row) => Number(row.close));
  const sigBenchCloses = sigBench.map((row) => Number(row.close));

  const candles = targetRows.map((row) => {
    const close = Number(row.close);
    const open = Number(row.open || close);
    const rawHigh = Number(row.high || Math.max(open, close));
    const rawLow = Number(row.low || Math.min(open, close));
    return { time: row.date, open, high: Math.max(open, rawHigh, rawLow, close), low: Math.min(open, rawHigh, rawLow, close), close };
  });

  const targetReturn40 = Array(dates.length).fill(null);
  const benchmarkReturn40 = Array(dates.length).fill(null);
  const rawRelative40 = Array(dates.length).fill(null);
  const betaAdjusted40 = Array(dates.length).fill(null);
  const definition = config.beta.windows[config.beta.primary_window];
  for (let index = 40; index < dates.length; index += 1) {
    const targetReturn = sigCloses[index] / sigCloses[index - 40] - 1;
    const benchmarkReturn = sigBenchCloses[index] / sigBenchCloses[index - 40] - 1;
    targetReturn40[index] = targetReturn * 100;
    benchmarkReturn40[index] = benchmarkReturn * 100;
    rawRelative40[index] = (targetReturn - benchmarkReturn) * 100;
    const betaEnd = index === dates.length - 1 && quoteStatus === "盘中" ? index - 1 : index;
    const beta = estimateBeta(sigTarget, sigBench, betaEnd, Number(definition.trading_days), Number(definition.minimum_observations), Number(config.beta.fallback));
    if (beta.sufficient) betaAdjusted40[index] = (targetReturn - beta.beta * benchmarkReturn) * 100;
  }
  const start = Math.max(0, dates.length - limit);
  return {
    dates: dates.slice(start),
    candles: candles.slice(start),
    close: priceCloses.slice(start),
    ma20: rolling(priceCloses, 20).slice(start),
    ma60: rolling(priceCloses, 60).slice(start),
    ma250: rolling(priceCloses, 250).slice(start),
    targetReturn40: targetReturn40.slice(start),
    benchmarkReturn40: benchmarkReturn40.slice(start),
    rawRelative40: rawRelative40.slice(start),
    betaAdjusted40: betaAdjusted40.slice(start),
    relative40: betaAdjusted40.slice(start),
  };
}

function stripRows(bundle) {
  if (!bundle) return null;
  const { rows, ...source } = bundle;
  return source;
}

export function buildResult(target, benchmark, dividend, bond, warnings = [], now = new Date(), options = {}) {
  const aligned = alignSeries(target, benchmark, options.targetTr || null, options.benchmarkTr || null);
  const allWarnings = [...warnings, ...aligned.warnings];
  const metrics = computeMetrics(
    aligned.targetRows,
    aligned.benchmarkRows,
    dividend,
    bond,
    target.quote_status,
    aligned.trTargetRows,
    aligned.trBenchmarkRows,
  );
  const quality = dataQuality(metrics, dividend, bond, allWarnings, now);
  const evaluation = evaluateRules(metrics, quality);
  const sources = {
    target: stripRows(target),
    benchmark: stripRows(benchmark),
    dividend,
    bond,
  };
  if (options.targetTr) sources.target_total_return = stripRows(options.targetTr);
  if (options.benchmarkTr) sources.benchmark_total_return = stripRows(options.benchmarkTr);
  const result = {
    generated_at: chinaIso(now),
    model_version: config.model_version,
    metrics,
    quality,
    evaluation,
    position_advice: positionAdvice(evaluation),
    sources,
  };
  return { result, aligned };
}

function historyRow(result) {
  const metrics = result.metrics;
  return {
    file: null,
    generated_at: result.generated_at,
    trade_date: metrics.trade_date,
    decision: result.evaluation.decision,
    confidence: result.quality.confidence,
    close: metrics.close,
    relative_spread_pct: metrics.beta_adjusted_spread_pct,
    signal_metric: metrics.signal_return_basis === "total_return" ? "全收益Beta调整" : "Beta调整",
    raw_relative_spread_pct: metrics.raw_relative_spread_pct,
    beta: metrics.beta,
    model_version: result.model_version,
    distance_ma250_pct: metrics.distance_ma250_pct,
    momentum: metrics.momentum,
  };
}

async function loadHistory(env) {
  const history = await kvGet(env, "dashboard:history");
  return Array.isArray(history) ? history : [];
}

async function saveHistory(env, result) {
  const history = await loadHistory(env);
  const row = roundTree(historyRow(result));
  const deduped = history.filter((item) => item.generated_at !== row.generated_at);
  const updated = [row, ...deduped].slice(0, 20);
  await kvPut(env, "dashboard:history", updated);
  return updated;
}

export async function refreshDashboard(env, { recordHistory = true, now = new Date() } = {}) {
  const trCode = config.total_return_code || "H20269";
  const bmTrCode = config.benchmark_total_return_code || "H00985";
  const [targetState, benchmarkState, targetTrState, benchmarkTrState, bond] = await Promise.all([
    getSeries(env, config.index_code, now, { includeIntraday: Boolean(config.use_intraday) }),
    getSeries(env, config.benchmark_code, now, { includeIntraday: Boolean(config.use_intraday) }),
    getSeries(env, trCode, now, { includeIntraday: false }),
    getSeries(env, bmTrCode, now, { includeIntraday: false }),
    fetchBond10y(env, now),
  ]);
  const preliminaryAlign = alignSeries(targetState.bundle, benchmarkState.bundle, targetTrState.bundle, benchmarkTrState.bundle);
  const implied = impliedDividendYield(preliminaryAlign.targetRows, preliminaryAlign.trTargetRows);
  const dividend = await fetchDividendYield(env, now, { implied });

  const warnings = [
    targetState.warning,
    benchmarkState.warning,
    targetTrState.warning,
    benchmarkTrState.warning,
  ].filter(Boolean);
  const { result, aligned } = buildResult(
    targetState.bundle,
    benchmarkState.bundle,
    dividend,
    bond,
    warnings,
    now,
    { targetTr: targetTrState.bundle, benchmarkTr: benchmarkTrState.bundle },
  );
  const roundedResult = roundTree(result);
  const history = recordHistory ? await saveHistory(env, roundedResult) : await loadHistory(env);
  const payload = {
    result: roundedResult,
    chart: roundTree(chartData(aligned.targetRows, aligned.benchmarkRows, targetState.bundle.quote_status, 270, aligned.trTargetRows, aligned.trBenchmarkRows)),
    history,
    server_time: chinaIso(now),
  };
  await kvPut(env, "dashboard:latest", { cached_at: now.toISOString(), data: payload });
  return payload;
}

async function dashboard(env, force = false) {
  const cached = await kvGet(env, "dashboard:latest");
  const age = cached?.cached_at ? Date.now() - Date.parse(cached.cached_at) : Number.POSITIVE_INFINITY;
  const sameModel = cached?.data?.result?.model_version === config.model_version;
  if (!force && sameModel && cached?.data && age < DASHBOARD_CACHE_MS) return cached.data;
  try {
    return await refreshDashboard(env, { recordHistory: force });
  } catch (error) {
    if (sameModel && cached?.data) return cached.data;
    throw error;
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === "/api/health" && request.method === "GET") {
    return jsonResponse({ ok: true, time: chinaIso(), model_version: config.model_version, runtime: "cloudflare-worker" });
  }
  if (url.pathname === "/api/dashboard" && request.method === "GET") {
    return jsonResponse({ ok: true, data: await dashboard(env, false) });
  }
  if (url.pathname === "/api/refresh" && request.method === "POST") {
    return jsonResponse({ ok: true, data: await dashboard(env, true) });
  }
  // ---- HS300 decision desk ---- //
  if (url.pathname === "/api/hs300/health" && request.method === "GET") {
    return jsonResponse({ ok: true, time: chinaIso(), model_version: `hs300-${hs300Config.version}`, service_version: hs300ServiceVersion, runtime: "cloudflare-worker" });
  }
  if (url.pathname === "/api/hs300/dashboard" && request.method === "GET") {
    return jsonResponse({ ok: true, data: await getHs300Dashboard(env, false, { ctx }) });
  }
  if (url.pathname === "/api/hs300/refresh" && request.method === "POST") {
    return jsonResponse({ ok: true, data: await getHs300Dashboard(env, true) });
  }
  if (url.pathname === "/api/hs300/etf-flows" && request.method === "GET") {
    return jsonResponse({ ok: true, data: await getEtfFlows(env, { force: url.searchParams.get("refresh") === "1" }) });
  }
  // ---- Dual-sleeve unified equity pool ---- //
  if (url.pathname === "/api/portfolio/health" && request.method === "GET") {
    return jsonResponse({ ok: true, time: chinaIso(), service_version: PORTFOLIO_SERVICE_VERSION, runtime: "cloudflare-worker" });
  }
  if (url.pathname === "/api/portfolio/dashboard" && request.method === "GET") {
    const [h30269Data, hs300Data] = await Promise.all([
      dashboard(env, false),
      getHs300Dashboard(env, false, { ctx }),
    ]);
    return jsonResponse({ ok: true, data: assemblePortfolioDashboard(hs300Data, h30269Data) });
  }
  if (url.pathname === "/api/portfolio/refresh" && request.method === "POST") {
    const [h30269Data, hs300Data] = await Promise.all([
      dashboard(env, true),
      getHs300Dashboard(env, true),
    ]);
    return jsonResponse({ ok: true, data: assemblePortfolioDashboard(hs300Data, h30269Data) });
  }
  if (url.pathname.startsWith("/api/")) return jsonResponse({ ok: false, error: "接口不存在" }, 404);
  if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      return jsonResponse({ ok: false, error: error?.message || String(error) }, 500);
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(refreshDashboard(env, { recordHistory: true }));
    ctx.waitUntil(refreshHs300(env, { recordHistory: true }));
    ctx.waitUntil(refreshEtfFlows(env).catch(() => null));
  },
};
