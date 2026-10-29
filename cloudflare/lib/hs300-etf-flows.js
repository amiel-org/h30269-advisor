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

async function tencentQuotes(secids, signal) {
  const codes = secids.map((s) => `${s.startsWith("0.") ? "sz" : "sh"}${s.slice(2)}`);
  const response = await fetch(`https://qt.gtimg.cn/q=${codes.join(",")}`, { signal, headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" } });
  if (!response.ok) throw new Error(`腾讯行情 HTTP ${response.status}`);
  const text = await response.text();
  return codes.map((code) => {
    const body = text.match(new RegExp(`v_${code}="([^"]+)"`))?.[1]?.split("~");
    if (!body || !validNumber(body[3])) throw new Error(`腾讯行情缺少 ${code}`);
    const isIndex = code === "sh000300";
    return { f43: validNumber(body[3]), f84: validNumber(body[72]), f116: validNumber(body[44]) * 1e8,
      f117: isIndex ? validNumber(body[44]) * 1e8 : null,
      f124: Math.floor(Date.parse(`${body[30].replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, "$1-$2-$3T$4:$5:$6+08:00")}`) / 1000) };
  });
}

async function quote(secid, signal) {
  let lastError;
  for (const host of ["push2.eastmoney.com", "push2delay.eastmoney.com"]) {
    const url = new URL(`https://${host}/api/qt/stock/get`);
    url.searchParams.set("secid", secid);
    url.searchParams.set("fields", FIELDS);
    url.searchParams.set("_", String(Date.now()));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(url, { signal: controller.signal, cf: { cacheTtl: 0 }, headers: { "User-Agent": "Mozilla/5.0", Referer: "https://quote.eastmoney.com/" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload.data) throw new Error("未返回有效行情");
      // A cache populated with a narrower field list may omit f117. Never
      // substitute total market cap: it would overstate the denominator.
      if (secid === "1.000300" && !validNumber(payload.data.f117)) throw new Error("沪深300流通市值缺失");
      return payload.data;
    } catch (error) {
      lastError = new Error(`${host}: ${controller.signal.aborted ? "响应超时" : error.message}`);
    } finally { clearTimeout(timer); }
  }
  throw lastError;
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

const SHARE_FLAT_PCT = 0.1;
const RATIO_FLAT_PP = 0.01;
const INDEX_FLAT_PCT = 0.1;

// Convert the three arrows into one readable state. Valuation remains the
// decision authority; this result can only support or caution an action.
export function interpretFlow({ shares, ratio, index, window }) {
  const sf = SHARE_FLAT_PCT, rf = RATIO_FLAT_PP, inf = INDEX_FLAT_PCT;
  const label = window === 20 ? "近20日" : "近5日";
  const base = { window, label, tone: "neutral", title: "信号分化", action: "不据此单独买卖" };
  if (shares > sf && ratio > rf && index < -inf) return { ...base, tone: "positive", title: "逆势承接",
    action: "若主模型允许分批买入，可作为辅助支持；不追高、不一次满仓。" };
  if (shares > sf && ratio > rf && index > inf) return { ...base, tone: "caution", title: "上涨吸金",
    action: "有新增资金但并非托底证据，避免追高，等待回调承接。" };
  if (shares > sf && ratio > rf) return { ...base, tone: "positive", title: "资金增强",
    action: "份额与占比同步增加；若估值允许，可作为分批加仓支持。" };
  if (shares > sf) return { ...base, title: "有新钱进场",
    action: "份额增加但占比未同步上升，不能据此判断托底增强。" };
  if (shares < -sf && ratio < -rf && index > inf) return { ...base, tone: "warning", title: "反弹赎回",
    action: "有资金借上涨撤离，可作为逢高减仓的辅助警示。" };
  if (shares < -sf && ratio < -rf && index < -inf) return { ...base, tone: "warning", title: "资金撤离",
    action: "份额和占比同步下降，承接减弱；主模型未允许前不要逆势加仓。" };
  if (shares < -sf) return { ...base, warning: true, title: "资金减弱",
    action: "有净赎回但占比未同步下降，不能单独判断资金撤退。" };
  if (ratio > rf) return { ...base, tone: "caution", title: "价格推升",
    action: "份额变化不大而占比上升，主要更像价格或分母变化，不算托底买入。" };
  if (ratio < -rf) return { ...base, title: "占比回落",
    action: "份额变化不大而占比下降，不能直接判断资金撤退。" };
  return { ...base, title: "中性持平", action: "三项变化都很小，继续观察。" };
}

export function flowPresentation(current, history) {
  const rows = [...history.filter((r) => r.date < current.date), current]
    .filter((r, i, all) => all.findIndex((x) => x.date === r.date) === i)
    .sort((a, b) => a.date.localeCompare(b.date));
  const rounded = (value, digits) => value === null ? null : Number(value.toFixed(digits));
  const result = {
    ratio_change_5d_pp: rounded(gapChange(current, rows, 5, "ratio_pct"), 4),
    ratio_change_20d_pp: rounded(gapChange(current, rows, 20, "ratio_pct"), 4),
    shares_change_5d_pct: rounded(pctChange(current, rows, 5, "total_shares"), 3),
    shares_change_20d_pct: rounded(pctChange(current, rows, 20, "total_shares"), 3),
    index_change_5d_pct: rounded(pctChange(current, rows, 5, "index_level"), 3),
    index_change_20d_pct: rounded(pctChange(current, rows, 20, "index_level"), 3),
    history: rows.slice(-61).map((r) => ({ date: r.date, ratio_pct: r.ratio_pct, total_shares: r.total_shares, index_level: r.index_level })),
  };
  const window = result.shares_change_20d_pct !== null && result.index_change_20d_pct !== null ? 20
    : result.shares_change_5d_pct !== null && result.index_change_5d_pct !== null ? 5 : null;
  result.interpretation = window ? interpretFlow({
    window, shares: result[`shares_change_${window}d_pct`], ratio: result[`ratio_change_${window}d_pp`],
    index: result[`index_change_${window}d_pct`],
  }) : { window: null, label: "样本积累中", tone: "wait", title: "暂不下结论",
    action: `还需 ${rows.length < 6 ? 6 - rows.length : 21 - rows.length} 个交易日快照；系统自动积累，无需每天打开。` };
  return result;
}

export async function refreshEtfFlows(env, { now = new Date(), signal } = {}) {
  const secids = [...FUNDS.map(([secid]) => secid), "1.000300"];
  let rows;
  let source = "东方财富公开行情";
  try {
    rows = await Promise.all(secids.map((secid) => quote(secid, signal)));
  } catch {
    rows = await tencentQuotes(secids, signal);
    source = "腾讯公开行情（备用）";
  }
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
  const rawIndexLevel = validNumber(index.f43);
  // Eastmoney quotes the index in 0.01-point units; Tencent uses points.
  const indexLevel = rawIndexLevel && source === "东方财富公开行情" ? rawIndexLevel / 100 : rawIndexLevel;
  const current = {
    date, ratio_pct: Number((totalValue / index.f117 * 100).toFixed(4)),
    total_shares: totalShares, total_market_value: totalValue, index_float_market_value: index.f117,
    index_level: indexLevel,
  };
  const previous = await kvGet(env, HISTORY_KEY);
  const history = Array.isArray(previous) ? previous.filter((r) => r.date < date) : [];
  history.push(current);
  const trimmed = history.slice(-120);
  await kvPut(env, HISTORY_KEY, trimmed);
  const payload = {
    status: "fresh", as_of: date, quote_time: new Date(quoteTime.getTime() + 8 * 3600000).toISOString().slice(0, 19).replace("T", " "),
    ...current, ...flowPresentation(current, trimmed), funds,
    sample_days: trimmed.length, source, unit: "人民币元",
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
