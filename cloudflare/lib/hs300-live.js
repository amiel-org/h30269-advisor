import { DEFAULT_CONFIG, erpGate, ladderExposure, percentileOfHistory, windowTargets } from "./hs300-model.js";
import { conditionalLevels, dataQuality } from "./hs300-decision.js";

const isoDay = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const cnDate = (now) => new Date(now.getTime() + 8 * 3600000);

export function quoteQuality(quote, now = new Date()) {
  if (!quote || !(quote.level > 0) || !/^\d{8}$/.test(quote.date || "")) return { available: false, can_decide: false, status: "missing", reason: "暂未取得最新报价" };
  const cn = cnDate(now), today = cn.toISOString().slice(0, 10).replaceAll("-", "");
  const stamp = Date.parse(`${isoDay(quote.date)}T${(quote.time || "").length === 5 ? quote.time + ':00' : quote.time}+08:00`);
  const age = (now.getTime() - stamp) / 1000;
  if (!Number.isFinite(age) || age < -120 || quote.date > today) return { available: false, can_decide: false, status: "invalid", reason: "行情时间异常，暂不生成动作" };
  const weekday = cn.getUTCDay() >= 1 && cn.getUTCDay() <= 5;
  const minute = cn.getUTCHours() * 60 + cn.getUTCMinutes();
  const trading = weekday && ((minute >= 570 && minute < 690) || (minute >= 780 && minute < 900));
  if (quote.date !== today) return { available: true, can_decide: false, status: "previous_session", age_seconds: Math.max(0, age), reason: "上一交易日报价，等待今日开盘更新" };
  if (trading && age > 180) return { available: true, can_decide: false, status: "delayed", age_seconds: age, reason: "报价超过3分钟未更新，显示延迟测算" };
  if (trading) return { available: true, can_decide: true, status: "trading", age_seconds: Math.max(0, age), reason: "按当前报价即时测算" };
  return { available: true, can_decide: false, status: minute >= 900 ? "after_close" : minute >= 690 ? "lunch_break" : "before_open",
    age_seconds: Math.max(0, age), reason: minute >= 900 ? "已收盘，按最近报价继续分析" : minute >= 690 ? "午间休市，按上午最新报价分析" : "尚未开盘，按最近报价分析" };
}

export function liveAnalysis(settled, quote, now = new Date()) {
  const series = settled.series, baseDate = series.dates.at(-1);
  const q = quoteQuality(quote, now);
  if (q.available && quote.date < baseDate) {
    q.available = false; q.can_decide = false; q.status = "previous_session";
    q.reason = "报价早于当前官方日线，继续显示较新的收盘基准";
  }
  const history = dataQuality(series, settled.bond_date, now);
  const usable = q.available && quote.date >= baseDate && history.actionable;
  const price = usable ? quote.level : settled.settled_price;
  const date = usable ? quote.date : baseDate;
  // A quote for the same day REPLACES that observation for comparison; a later
  // quote uses every earlier daily bar. Repeated refreshes never add samples.
  let length = series.dates.findIndex((d) => d >= date);
  if (length < 0) length = series.dates.length;
  const peHist = series.pe.slice(0, length), erpHist = series.spread.slice(0, length);
  const ratio = price / settled.settled_price;
  const pe = series.pe.at(-1) * ratio;
  const candidate = settled.latest_bond;
  const bond = usable && candidate?.as_of <= date && candidate.value > 0 ? candidate : { value: settled.bond_last, as_of: settled.bond_date };
  const erp = 100 / pe - bond.value;
  const detail = windowTargets(peHist, erpHist, pe, erp);
  const windows = Object.fromEntries(Object.entries(detail.windows).map(([k, w]) => {
    const spec = DEFAULT_CONFIG.indicators.percentile_windows.find((s) => s.name === k);
    const count = spec.mode === 'rolling' ? Math.min(spec.days, length) : length;
    return [k, {
    label: w.label, pe_percentile: w.pePercentile, erp_percentile: w.erpPercentile, exposure: w.exposure,
    sample_count: count, history_start: series.dates[length - count], history_end: series.dates[length - 1],
    pe_cap: w.pePercentile === null ? null : ladderExposure(w.pePercentile, DEFAULT_CONFIG.allocation.pe_ladder),
    erp_cap: w.erpPercentile === null ? null : erpGate(w.erpPercentile, DEFAULT_CONFIG.allocation.erp_gate.lo, DEFAULT_CONFIG.allocation.erp_gate.hi),
  }]; }));
  const canDecide = usable && q.can_decide;
  const lines = history.actionable ? conditionalLevels(series, price, bond.value, DEFAULT_CONFIG, {
    peNow: pe, peHist, erpHist, detail,
    assumption: "按当前点位、最近官方PE所对应的盈利与最新已发布国债收益率估算。盈利、成分或利率更新后观察线重算；刷新不会计作收盘确认。",
  }) : null;
  return {
    mode: usable ? "quote_estimate" : "settled_reference", date, time: usable ? quote.time : null,
    price, previous_close: usable ? quote.previous_close ?? null : null,
    change_pct: usable ? quote.change_pct ?? null : null,
    source: usable ? quote.source || "中证指数" : "中证指数已发布日线",
    quote_quality: q, quality: { available: history.actionable, can_decide: canDecide,
      reason: !history.actionable ? history.blockers.join("；") : !usable ? q.reason : q.reason },
    pe: +pe.toFixed(6), pe_percentile: +percentileOfHistory(peHist, pe).toFixed(4),
    erp: +erp.toFixed(6), erp_percentile: +percentileOfHistory(erpHist, erp).toFixed(4),
    bond, windows, consensus: { agreed: detail.agreed, exposure: detail.consensus_exposure, span: detail.span },
    conditional_levels: lines,
    baseline: { date: baseDate, price: settled.settled_price, pe: series.pe.at(-1), sample_count: peHist.length },
    estimated: usable && (date !== baseDate || Math.abs(ratio - 1) > 1e-12),
    assumptions: "PE按最新指数点位/基准收盘点位同比例估算，暂以基准盈利和成分不变；ERP使用带日期国债数据。盘中辅助方案未通过独立盘中回测。",
  };
}

export function buildPriceChart(priceRows = [], quote = null, now = new Date()) {
  const rows = new Map();
  for (const r of priceRows) {
    if (!/^\d{8}$/.test(r.date || "") || !(r.close > 0)) continue;
    const dow = new Date(`${isoDay(r.date)}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const c = { time: isoDay(r.date), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, provisional: false };
    const valid = [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v) && v > 0) && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close);
    rows.set(c.time, { ...c, candle_valid: valid });
  }
  const q = quoteQuality(quote, now);
  if (q.available && quote.date >= ([...rows.keys()].sort().at(-1)?.replaceAll("-", "") || "")) {
    const old = rows.get(isoDay(quote.date));
    // Intraday extrema must come from a real quote/feed; never fabricate OHLC
    // from a previous close or a total-return index.
    if (!old || quote.level !== old.close) {
      const open = quote.open, high = quote.high, low = quote.low;
      rows.set(isoDay(quote.date), { time: isoDay(quote.date), open, high, low, close: quote.level,
        volume: quote.volume, provisional: true,
        candle_valid: [open, high, low].every((v) => Number.isFinite(v) && v > 0) && high >= Math.max(open, quote.level) && low <= Math.min(open, quote.level) });
    }
  }
  const bars = [...rows.values()].sort((a, b) => a.time.localeCompare(b.time)).slice(-900);
  const closes = bars.map((r) => r.close);
  const moving = (period) => closes.map((_, i) => i + 1 < period ? null : closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  return { bars, ma20: moving(20), ma30: moving(30), ma60: moving(60), ma120: moving(120), ma250: moving(250),
    intraday: quote?.points || [], source: "000300价格指数真实行情；未取得OHLC的日期仅显示收盘线", price_index: "000300" };
}
