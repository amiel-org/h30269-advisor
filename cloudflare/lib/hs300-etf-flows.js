// Head CSI 300 ETF scale / free-float market-cap observation.
// This is a fund-flow proxy, not identified state-fund holdings or a trade signal.
import { kvGet, kvPut } from "./hs300-dashboard.js";

const CACHE_KEY = "hs300:etf-flows:v1";
const HISTORY_KEY = "hs300:etf-flows:history:v1";
const CACHE_MS = 60 * 1000;
const FUNDS = [
  ["1.510300", "510300", "华泰柏瑞"],
  ["1.510330", "510330", "华夏"],
  ["0.159919", "159919", "嘉实"],
  ["1.510310", "510310", "易方达"],
];
const FIELDS = "f57,f58,f43,f84,f85,f116,f117,f124";

async function quote(secid, signal) {
  const url = new URL("https://push2.eastmoney.com/api/qt/stock/get");
  url.searchParams.set("secid", secid);
  url.searchParams.set("fields", FIELDS);
  const response = await fetch(url, { signal, cf: { cacheTtl: 0 }, headers: { "User-Agent": "Mozilla/5.0", Referer: "https://quote.eastmoney.com/" } });
  if (!response.ok) throw new Error(`ETF 数据源 HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload.data) throw new Error("ETF 数据源未返回有效行情");
  // A cache populated with a narrower field list may omit f117. Never
  // substitute total market cap: it would overstate the denominator.
  if (secid === "1.000300" && !validNumber(payload.data.f117)) throw new Error("沪深300流通市值缺失");
  return payload.data;
}

function validNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function gapChange(current, rows, sessions, field) {
  const index = rows.findIndex((row) => row.date === current.date);
  const base = index >= sessions ? rows[index - sessions] : null;
  return base && validNumber(base[field]) && validNumber(current[field])
    ? current[field] - base[field] : null;
}

function pctChange(current, rows, sessions, field) {
  const difference = gapChange(current, rows, sessions, field);
  const index = rows.findIndex((row) => row.date === current.date);
  return difference === null ? null : difference / rows[index - sessions][field] * 100;
}

export function flowPresentation(current, history) {
  const rows = [...history.filter((r) => r.date < current.date), current]
    .filter((r, i, all) => all.findIndex((x) => x.date === r.date) === i)
    .sort((a, b) => a.date.localeCompare(b.date));
  const rounded = (value, digits) => value === null ? null : Number(value.toFixed(digits));
  return {
    ratio_change_5d_pp: rounded(gapChange(current, rows, 5, "ratio_pct"), 4),
    ratio_change_20d_pp: rounded(gapChange(current, rows, 20, "ratio_pct"), 4),
    shares_change_5d_pct: rounded(pctChange(current, rows, 5, "total_shares"), 3),
    shares_change_20d_pct: rounded(pctChange(current, rows, 20, "total_shares"), 3),
    history: rows.slice(-61).map((r) => ({ date: r.date, ratio_pct: r.ratio_pct, total_shares: r.total_shares })),
  };
}

export async function refreshEtfFlows(env, { now = new Date(), signal } = {}) {
  const rows = await Promise.all([...FUNDS.map(([secid]) => quote(secid, signal)), quote("1.000300", signal)]);
  const index = rows.at(-1);
  const funds = rows.slice(0, -1).map((r, i) => ({
    code: FUNDS[i][1], manager: FUNDS[i][2], shares: validNumber(r.f84), market_value: validNumber(r.f116),
  }));
  if (funds.some((r) => !r.shares || !r.market_value) || !validNumber(index.f117)) throw new Error("ETF 份额或指数流通市值不完整");
  const stamps = rows.slice(0, -1).map((r) => Number(r.f124)).filter((n) => n > 0);
  const quoteTime = stamps.length ? new Date(Math.max(...stamps) * 1000) : now;
  const date = new Date(quoteTime.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const totalShares = funds.reduce((sum, r) => sum + r.shares, 0);
  const totalValue = funds.reduce((sum, r) => sum + r.market_value, 0);
  const current = {
    date, ratio_pct: Number((totalValue / index.f117 * 100).toFixed(4)),
    total_shares: totalShares, total_market_value: totalValue, index_float_market_value: index.f117,
  };
  const previous = await kvGet(env, HISTORY_KEY);
  const history = Array.isArray(previous) ? previous.filter((r) => r.date < date) : [];
  history.push(current);
  const trimmed = history.slice(-120);
  await kvPut(env, HISTORY_KEY, trimmed);
  const payload = {
    status: "fresh", as_of: date, quote_time: new Date(quoteTime.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace("T", " "),
    ...current, ...flowPresentation(current, trimmed), funds,
    sample_days: trimmed.length, source: "东方财富公开行情", unit: "人民币元",
    methodology: "四只头部沪深300ETF场内总市值合计 ÷ 沪深300流通市值。ETF市值按行情口径，非定期报告的国家队持仓。",
    limitation: "无法识别实际买家，不覆盖其他ETF、场外基金或直接持股。规模变化同时受份额、价格及分母变化影响；份额变化更适合辅助观察申购赎回。",
    signal_role: "仅作资金背景观察，不参与PE、ERP及买卖决策。",
  };
  await kvPut(env, CACHE_KEY, { cached_at: now.toISOString(), data: payload });
  return payload;
}

export async function getEtfFlows(env, { force = false, now = new Date() } = {}) {
  const cached = await kvGet(env, CACHE_KEY);
  const age = cached?.cached_at ? now - Date.parse(cached.cached_at) : Infinity;
  if (!force && cached?.data && age >= 0 && age < CACHE_MS) return cached.data;
  try {
    return await refreshEtfFlows(env, { now });
  } catch (error) {
    const detail = `本次更新失败：${error?.message || "数据源连接异常"}`;
    if (cached?.data) return { ...cached.data, status: "stale", warning: `${detail}，展示上次快照。` };
    return { status: "unavailable", warning: `${detail}。资金观察暂不可用，不影响估值与仓位分析。`, history: [], funds: [] };
  }
}
