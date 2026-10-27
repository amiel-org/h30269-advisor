import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, HOLD, buildSignals, metrics, runBacktest, windowTargets } from "./lib/hs300-model.js";
import { SETTLED_KEY, alignSeries, buildHs300Result, fetchIntraday, fetchTencentQuote, resultFromSettled } from "./lib/hs300-data.js";
import { conditionalLevels, confirmationState, signalDetail } from "./lib/hs300-decision.js";
import { DASH_KEY, getHs300Dashboard } from "./lib/hs300-dashboard.js";
import { buildPriceChart, liveAnalysis, quoteQuality } from "./lib/hs300-live.js";
import { calculatePosition } from "../static/hs300-position.js";

const raw = JSON.parse(readFileSync(new URL("../raw_data.json", import.meta.url), "utf8"));
const series = alignSeries(raw.price, raw.total_return, raw.bond10y);
const settled = { series, settled_price: raw.price.find((r) => r.date === series.dates.at(-1)).close,
  bond_last: raw.bond10y[series.dates.at(-1)], bond_date: series.dates.at(-1), price_rows: raw.price.slice(-900) };
const now = new Date("2026-10-15T06:00:00Z");
const memoryEnv = (initial = []) => {
  const values = new Map(initial);
  return { H30269_KV: { async get(k) { return values.get(k) ?? null; },
    async put(k, v) { values.set(k, v); } }, values };
};

const positionFixture = () => ({ execution: { step_size: .125, deadband: .05 }, analysis: {
  quality: { available: true, can_decide: true }, consensus: { agreed: false, exposure: "HOLD" },
  windows: { full: { exposure: .375 }, "10y": { exposure: .875 }, "5y": { exposure: .375 } },
} });

test("disagreement still calculates entered holdings and every scenario in cash", () => {
  const data = positionFixture(), copy = structuredClone(data);
  const r = calculatePosition(data, '50', '100000');
  assert.equal(r.valid, true); assert.equal(r.agreed, false); assert.equal(r.canAct, false);
  assert.equal(r.holdings, 50000); assert.equal(r.cash, 50000);
  assert.equal(r.overall.move, 0); assert.equal(r.overall.after, .5);
  assert.deepEqual(r.rows.map((w) => w.moveAmount), [-12500, 12500, -12500]);
  assert.deepEqual(r.rows.map((w) => w.after), [.375, .625, .375]);
  assert.deepEqual(r.rows.map((w) => w.targetAmount), [37500, 87500, 37500]);
  assert.deepEqual(data, copy);
});

test("closed market leaves arithmetic usable but flags an agreed plan as a simulation", () => {
  const data = positionFixture();data.analysis.quality.can_decide = false;
  data.analysis.consensus = { agreed: true, exposure: .625 };
  for (const w of Object.values(data.analysis.windows)) w.exposure = .625;
  const r = calculatePosition(data,'25','100000',{mode:'intraday'});
  assert.equal(r.valid,true);assert.equal(r.canAct,false);
  assert.equal(r.overall.move,.125);assert.equal(r.overall.moveAmount,12500);
  assert.equal(r.overall.after,.375);
});

test("intraday execution requires the same confirmed target and direction confirmation", () => {
  const d=positionFixture();d.analysis.consensus={agreed:true,exposure:.25};
  for(const w of Object.values(d.analysis.windows))w.exposure=.25;
  d.execution={...d.execution,target:.25,buy_confirmed:true,sell_confirmed:false,confirmed_closes:1,sell_required:2};
  const blocked=calculatePosition(d,'50','100000');
  assert.equal(blocked.overall.move,-.125);assert.equal(blocked.canAct,false);
  assert.match(blocked.reasons.join('；'),/卖出收盘确认不足/);
  d.execution.sell_confirmed=true;d.execution.confirmed_closes=2;
  assert.equal(calculatePosition(d,'50','100000').canAct,true);
  d.execution.target=.375;
  const mismatch=calculatePosition(d,'50','100000');
  assert.equal(mismatch.targetMatches,false);assert.equal(mismatch.canAct,false);
});

test("settled review uses official windows without requiring an intraday quote", () => {
  const d=positionFixture();d.analysis.quality.can_decide=false;
  d.windows=structuredClone(d.analysis.windows);d.consensus={agreed:true,exposure:.375};
  for(const w of Object.values(d.windows))w.exposure=.375;
  d.quality={analysis_available:true,actionable:true};
  d.execution={...d.execution,target:.375,buy_confirmed:true,sell_confirmed:true};
  const r=calculatePosition(d,'50','100000');
  assert.equal(r.mode,'settled_review');assert.equal(r.canAct,true);assert.equal(r.overall.move,-.125);
});

test("zero and full positions are valid; missing or invalid inputs never get silently coerced", () => {
  const d=positionFixture();
  assert.equal(calculatePosition(d,'0','').holdings,null);
  assert.equal(calculatePosition(d,'0','100000').holdings,0);
  assert.equal(calculatePosition(d,'100','100000').cash,0);
  for (const p of ['', ' ', '-1','101','NaN']) assert.equal(calculatePosition(d,p,'').valid,false,p);
  for (const b of ['0','-1','Infinity','abc']) assert.equal(calculatePosition(d,'50',b).valid,false,b);
});

test("position scenarios respect the deadband and clamp the single step", () => {
  const d=positionFixture();
  const same=calculatePosition(d,'37.5','');assert.equal(same.rows[0].move,0);
  const edge=calculatePosition(d,'42.5','');assert.equal(edge.rows[0].move,0);
  const empty=calculatePosition(d,'0','100000');assert.ok(empty.rows.every((r)=>r.move<=.125));
  const full=calculatePosition(d,'100','100000');assert.ok(full.rows.every((r)=>r.move>=-.125));
});

test("missing window data cannot produce an agreed portfolio plan", () => {
  const d=positionFixture();d.analysis.consensus={agreed:true,exposure:.375};delete d.analysis.windows['10y'];
  const r=calculatePosition(d,'50','100000');assert.equal(r.agreed,false);assert.equal(r.canAct,false);assert.equal(r.rows[1].target,undefined);
});

test("all configured windows must be populated before consensus", () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.indicators.percentile_windows[0].min_obs = 1;
  const detail = windowTargets([10], [5], 10, 5, cfg);
  assert.equal(detail.agreed, false);
  assert.equal(detail.consensus_exposure, HOLD);
});

test("nonfinite inputs cannot silently turn into a position", () => {
  assert.throws(() => windowTargets([10], [5], NaN, 5, {
    ...DEFAULT_CONFIG, indicators: { percentile_windows: [{ name: "x", min_obs: 1 }] },
  }), /invalid percentile/);
});

test("metrics use NAV ratios and actual return intervals", () => {
  const a = metrics([["20250101", 1], ["20260101", 2]]);
  const b = metrics([["20250101", 5], ["20260101", 10]]);
  assert.equal(a.cagrCalendarPct, b.cagrCalendarPct);
  assert.equal(a.cagr252Pct, b.cagr252Pct);
  assert.equal(metrics([["20250101", 1]]).cagr252Pct, null);
});

test("alignment rejects stale bond carry and invalid PE", () => {
  assert.throws(() => alignSeries([{ date: "20261014", close: 100, pe: 10 }],
    [{ date: "20261014", close: 100 }], { "20260901": 2 }), /7天/);
  assert.throws(() => alignSeries([{ date: "20261014", close: 100, pe: 0 }],
    [{ date: "20261014", close: 100 }], { "20261014": 2 }), /PE/);
});

test("alignment sorts and deduplicates without changing ranks", () => {
  const prices = raw.price.filter((r) => r.pe).slice(-100);
  const a = alignSeries(prices, raw.total_return, raw.bond10y);
  const b = alignSeries([...prices].reverse().concat(prices[0]), raw.total_return, raw.bond10y);
  assert.deepEqual(a, b);
});

test("intraday quotes cannot change a settled decision or its backtest", () => {
  const a = resultFromSettled(settled, null, { now });
  const b = resultFromSettled(settled, { date: "20261015", level: 9000, time: "14:00" }, { now });
  assert.deepEqual(a.windows, b.windows);
  assert.deepEqual(a.backtest, b.backtest);
  assert.deepEqual(a.execution, b.execution);
  assert.equal(a.pe, b.pe);
  assert.equal(b.price_index.level, settled.settled_price);
  assert.equal(b.intraday.level, 9000);
  assert.notEqual(a.analysis.pe, b.analysis.pe, "current analysis must respond to a changed quote");
  assert.notDeepEqual(a.analysis.windows, b.analysis.windows);
});

test("live quote recomputes PE, ERP and windows without appending it to settled history", () => {
  const copy = structuredClone(settled);
  const quote = { date: "20261015", time: "14:00:00", level: settled.settled_price * .9 };
  const a = liveAnalysis(settled, quote, now);
  assert.equal(a.quality.can_decide, true);
  assert.ok(Math.abs(a.pe - series.pe.at(-1)*.9) < 1e-6);
  assert.equal(a.baseline.sample_count, series.pe.length);
  const expected = windowTargets(series.pe, series.spread, series.pe.at(-1)*.9, 100/(series.pe.at(-1)*.9)-settled.bond_last);
  assert.equal(a.consensus.exposure, expected.consensus_exposure);
  assert.deepEqual(settled, copy);
  assert.deepEqual(liveAnalysis(settled, quote, now), a, "repeated refresh cannot count extra samples");
});

test("same-day quote replaces the final daily observation when ranking", () => {
  const a = liveAnalysis(settled, { date: series.dates.at(-1), time: "14:00:00", level: settled.settled_price }, new Date("2026-10-13T06:00:00Z"));
  assert.equal(a.baseline.sample_count, series.pe.length-1);
  assert.equal(a.windows.full.pe_percentile, signalDetail(series).windows.full.pePercentile);
});

test("current conditional lines satisfy PE and ERP consensus under the SAME live history", () => {
  const a = liveAnalysis(settled, {date:"20261015",time:"14:00:00",level:4166.01}, now);
  for(const kind of ["buy","sell"]){
    const line=a.conditional_levels[kind];if(!line)continue;
    const pe=a.pe*line.level/a.price;
    const detail=windowTargets(series.pe,series.spread,pe,100/pe-a.bond.value);
    assert.equal(detail.agreed,true);assert.equal(detail.consensus_exposure,line.target);
  }
});

test("quote freshness and trading session are distinct from delayed daily publication", () => {
  assert.equal(quoteQuality({date:"20261015",time:"14:00:00",level:4200},now).can_decide,true);
  assert.equal(quoteQuality({date:"20261015",time:"13:30:00",level:4200},now).status,"delayed");
  assert.equal(quoteQuality({date:"20261015",time:"16:00:00",level:4200},new Date("2026-10-15T08:01:00Z")).status,"after_close");
  assert.equal(quoteQuality({date:"20261015",time:"14:05:00",level:4200},now).available,false);
  const a=liveAnalysis(settled,{date:"20261015",time:"16:00:00",level:4000},new Date("2026-10-15T08:01:00Z"));
  assert.equal(a.mode,"quote_estimate");assert.equal(a.price,4000);assert.equal(a.quality.available,true);
  assert.equal(a.quality.can_decide,false);assert.notEqual(a.pe,series.pe.at(-1));
});

test("cached live estimates are rechecked for quote age on every read", async () => {
  const current = new Date();
  const cn = new Date(current.getTime()+8*3600000);
  const day = cn.toISOString().slice(0,10).replaceAll('-','');
  const stamp = new Date(current.getTime()-10*60000+8*3600000).toISOString().slice(11,19);
  const data = resultFromSettled(settled,null,{now});
  data.price_asof=day;data.bond.as_of=day;
  data.analysis={...data.analysis,date:day,time:stamp,mode:'quote_estimate',
    quality:{available:true,can_decide:true},quote_quality:{status:'trading',can_decide:true}};
  const env=memoryEnv([[DASH_KEY,JSON.stringify({cached_at:current.toISOString(),data})]]);
  const response=await getHs300Dashboard(env,false);
  assert.equal(response.analysis.quality.can_decide,false);
});

test("available quote is analyzed even though the official daily close is not published", () => {
  const a=liveAnalysis(settled,{date:'20261015',time:'14:00:00',level:4000},now);
  assert.equal(a.date,'20261015');assert.equal(a.baseline.date,'20261013');
  assert.equal(a.quality.available,true);assert.equal(a.quality.can_decide,true);
  assert.ok(a.conditional_levels.buy||a.conditional_levels.sell);
});

test("future bond values cannot leak into a current quote estimate", () => {
  const s={...settled,latest_bond:{as_of:'20261016',value:100}};
  const a=liveAnalysis(s,{date:'20261015',time:'14:00:00',level:4000},now);
  assert.equal(a.bond.value,settled.bond_last);
  assert.ok(a.erp>0);
});

test("price chart uses real OHLC and never invents candles from return levels", () => {
  const p=raw.price.slice(-400);const quote={date:"20261015",time:"14:00:00",level:4166,open:4145,high:4176,low:4115};
  const chart=buildPriceChart(p,quote,now),bar=chart.bars.at(-1);
  assert.equal(bar.close,4166);assert.equal(bar.open,4145);assert.equal(bar.high,4176);assert.equal(bar.provisional,true);
  assert.equal(bar.candle_valid,true);assert.ok(chart.ma250.at(-1)>0);
  const missing=buildPriceChart([{date:"20261014",close:4200}],null,now);
  assert.equal(missing.bars[0].candle_valid,false);assert.equal(missing.bars[0].open,undefined);
  const invalid=buildPriceChart(p,{...quote,high:null,low:null},now);
  assert.equal(invalid.bars.at(-1).candle_valid,false);
});

test("primary quote derives high and low only from the real intraday feed", async (t) => {
  t.mock.method(globalThis,"fetch",async()=>Response.json({data:{intraDayHeader:{tradeDate:'2026-10-15',tradeTime:'14:00:00',current:4200,openToday:4190,closePre:4210},intraDayPerfList:[{tradeTime:'09:30:00',current:4190,high:4195,low:4180},{tradeTime:'14:00:00',current:4200,high:4220,low:4170}]}}));
  const q=await fetchIntraday('000300');
  assert.equal(q.high,4220);assert.equal(q.low,4170);assert.equal(q.open,4190);assert.equal(q.points.length,2);
});

test("backup quote parser supplies dated price and actual OHLC", async (t) => {
  const a=Array(40).fill('');a[3]='4166.01';a[4]='4217.68';a[5]='4145.95';a[30]='20261015140000';a[32]='-1.23';a[33]='4176.09';a[34]='4115.07';
  t.mock.method(globalThis,'fetch',async()=>new Response(`v_sh000300="${a.join('~')}";`));
  const q=await fetchTencentQuote();
  assert.equal(q.date,'20261015');assert.equal(q.time,'14:00:00');assert.equal(q.level,4166.01);assert.equal(q.high,4176.09);assert.equal(q.source,'腾讯行情（备用）');
});

test("old quote never receives a live label; old daily data pauses decisions", () => {
  const d = resultFromSettled(settled, { date: "20261013", level: 4000 }, { now: new Date("2026-11-10T06:00:00Z") });
  assert.equal(d.live, false);
  assert.equal(d.quality.actionable, false);
  assert.equal(d.conditional_levels, null);
});

test("today's old quote is labelled historical rather than live", () => {
  const d = resultFromSettled(settled, { date: "20261015", level: 4200, time: "09:30:00" }, { now });
  assert.equal(d.live, false);
  assert.equal(d.intraday.level, 4200);
});

test("conditional observation points satisfy ALL windows and the ERP gate", () => {
  const lines = conditionalLevels(series, settled.settled_price, settled.bond_last);
  const current = Object.values(signalDetail(series).windows).map((w) => w.exposure);
  for (const kind of ["buy", "sell"]) {
    const line = lines[kind];
    assert.ok(line, `fixture should have a ${kind} line`);
    const pe = series.pe.at(-1) * line.level / settled.settled_price;
    const detail = windowTargets(series.pe, series.spread, pe, 100 / pe - settled.bond_last);
    assert.equal(detail.agreed, true);
    assert.equal(detail.consensus_exposure, line.target);
    assert.ok(kind === "buy" ? line.level < settled.settled_price && line.target > Math.max(...current)
      : line.level > settled.settled_price && line.target < Math.min(...current));
  }
});

test("HOLD resets close confirmation rather than counting repeated refreshes", () => {
  const one = confirmationState([1, 0.5, HOLD, 0.5]);
  assert.equal(one.confirmed_closes, 1);
  assert.equal(one.buy_confirmed, true);
  assert.equal(one.sell_confirmed, false);
  assert.equal(confirmationState([0.5, 0.5]).sell_confirmed, true);
});

test("execution sells only after two targets and fills one day later", () => {
  const fixture = { dates: ["20260105", "20260106", "20260107", "20260108", "20260109", "20260112"],
    tr: [1, 1, 1, 1, 1, 1], pe: [10, 10, 10, 10, 10, 10], spread: [5, 5, 5, 5, 5, 5] };
  const run = runBacktest(fixture, DEFAULT_CONFIG, [1, 1, 0, 0, 0, 0]);
  assert.equal(run.steps.find((s) => s.kind === "buy").date, "20260106");
  assert.equal(run.steps.find((s) => s.kind === "sell").date, "20260109");
  assert.ok(run.steps.every((s) => Math.abs(s.weightAfter - s.weightBefore) <= 0.125 + 1e-10));
});

test("settled warm path uses KV and only the quote endpoint", async (t) => {
  const env = memoryEnv([[SETTLED_KEY, JSON.stringify({ ...settled, cached_at: now.toISOString() })]]);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    return Response.json({ data: { intraDayHeader: { tradeDate: "2026-10-15", tradeTime: "14:00:00", current: 4200 } } });
  });
  const d = await buildHs300Result(env, { now });
  assert.equal(d.history_source, "cache");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /index-perf-oneday/);
});

test("cold path fetches complete pages and warm refresh reuses history", async (t) => {
  const env = memoryEnv();
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = new URL(url); calls.push(u);
    if (u.pathname.endsWith("index-perf-oneday")) return Response.json({ data: {} });
    if (u.pathname.endsWith("index-perf")) return Response.json({ code: 200, data:
      (u.searchParams.get("indexCode") === "000300" ? raw.price : raw.total_return)
        .map((r) => ({ tradeDate: r.date, close: r.close, peg: r.pe })) });
    return Response.json({ success: true, result: { pages: 1, data:
      Object.entries(raw.bond10y).map(([d, v]) => ({ SOLAR_DATE: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, EMM00166466: v })) } });
  });
  const a = await buildHs300Result(env, { now });
  assert.equal(a.history_source, "live");
  assert.ok(env.values.has(SETTLED_KEY));
  const b = await buildHs300Result(env, { now });
  assert.equal(b.history_source, "cache");
  assert.deepEqual(a.windows, b.windows);
  assert.equal(calls.filter((u) => u.pathname.endsWith("index-perf")).length, 2);
});

test("missing bond pages fail closed rather than altering historical ranks", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("index-perf-oneday")) return Response.json({ data: {} });
    if (u.pathname.endsWith("index-perf")) return Response.json({ code: 200, data: [] });
    return Response.json({ success: true, result: { pages: 2,
      data: u.searchParams.get("pageNumber") === "1" ? [{ SOLAR_DATE: "2026-10-14", EMM00166466: 1.65 }] : [] } });
  });
  await assert.rejects(buildHs300Result(memoryEnv(), { now }), /分页缺失/);
});

test("current-day partial daily bars never count as confirmed closes", async (t) => {
  const env = memoryEnv();
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("index-perf-oneday")) return Response.json({ data: {} });
    if (u.pathname.endsWith("index-perf")) return Response.json({ code: 200, data:
      [...(u.searchParams.get("indexCode") === "000300" ? raw.price : raw.total_return)
        .map((r) => ({ tradeDate: r.date, close: r.close, peg: r.pe })),
      { tradeDate: "20261015", close: 99999, peg: 999 }] });
    return Response.json({ success: true, result: { pages: 1, data:
      Object.entries(raw.bond10y).map(([d, v]) => ({ SOLAR_DATE: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, EMM00166466: v })) } });
  });
  const d = await buildHs300Result(env, { now });
  assert.equal(d.as_of, raw.price.at(-1).date);
  assert.equal(d.pe, raw.price.at(-1).pe);
});

test("refresh failure identifies stale fallback and blocks transaction advice", async () => {
  const d = resultFromSettled(settled, null, { now });
  const env = memoryEnv([[DASH_KEY, JSON.stringify({ cached_at: new Date().toISOString(), data: d })]]);
  const fallback = await getHs300Dashboard(env, true, { builder: async () => { throw new Error("upstream unavailable"); } });
  assert.equal(fallback.refresh_status, "reference");
  assert.match(fallback.refresh_error, /upstream/);
  assert.equal(fallback.quality.actionable, false);
});

function mockIncremental(t, { price = raw.price, total = raw.total_return, fail = false } = {}) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = new URL(url); calls.push(u);
    if (u.pathname.endsWith("index-perf-oneday")) return Response.json({ data: {} });
    if (fail) { const error = new Error("The operation was aborted"); error.name = "AbortError"; throw error; }
    if (u.pathname.endsWith("index-perf")) {
      assert.ok(u.searchParams.get("startDate") >= "20260901", "warm update must not request full history");
      const rows = u.searchParams.get("indexCode") === "000300" ? price : total;
      return Response.json({ code: 200, data: rows.filter((r) => r.date >= u.searchParams.get("startDate"))
        .map((r) => ({ tradeDate: r.date, close: r.close, peg: r.pe })) });
    }
    assert.equal(u.searchParams.get("pageNumber"), "1", "warm update must not download old bond pages");
    return Response.json({ success: true, result: { pages: 20, data:
      [...Object.entries(raw.bond10y).filter(([d]) => d >= "20260901"), ["20261015", 1.65]]
        .map(([d, v]) => ({ SOLAR_DATE: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, EMM00166466: v })) } });
  });
  return calls;
}

test("after-close refresh preserves history while official new daily bars are unpublished", async (t) => {
  const env = memoryEnv([["hs300:settled:v3", JSON.stringify({ ...settled, cached_at: now.toISOString() })]]);
  const calls = mockIncremental(t);
  const afternoon = new Date("2026-10-15T08:00:00Z");
  const a = await buildHs300Result(env, { now: afternoon });
  assert.equal(a.history_source, "incremental");
  assert.equal(a.as_of, settled.series.dates.at(-1));
  assert.equal(a.quality.status, "awaiting_close");
  assert.equal(a.quality.actionable, false);
  assert.equal(a.quality.analysis_available, true);
  assert.ok(a.conditional_levels.buy);
  assert.equal(a.source_warning, null);
  const saved = JSON.parse(env.values.get(SETTLED_KEY));
  assert.deepEqual(saved.series.dates, series.dates, "unchanged official dates preserve complete history");
  assert.deepEqual(saved.series.pe, series.pe);
  assert.deepEqual(saved.series.tr, series.tr);
  assert.ok(saved.series.spread.every((v, i) => Math.abs(v - series.spread[i]) < 1e-12));
  const before = calls.length;
  const b = await buildHs300Result(env, { now: afternoon });
  assert.ok(calls.length - before <= 2, "ordinary repeated reads fetch only quote sources");
  assert.deepEqual(a.windows, b.windows);
});

test("incremental update appends a newly published close without duplicating or dropping history", async (t) => {
  const env = memoryEnv([[SETTLED_KEY, JSON.stringify({ ...settled, cached_at: now.toISOString() })]]);
  mockIncremental(t, {
    price: [...raw.price, { date: "20261014", close: 4217.68, pe: 12.99 }, { date: "20261015", close: 4165, pe: 12.83 }],
    total: [...raw.total_return, { date: "20261014", close: 6338.35 }, { date: "20261015", close: 6260 }],
  });
  const result = await buildHs300Result(env, { now: new Date("2026-10-15T08:00:00Z"), forceCheck: true });
  assert.equal(result.as_of, "20261015");
  assert.equal(result.quality.actionable, true);
  const saved = JSON.parse(env.values.get(SETTLED_KEY));
  assert.equal(saved.series.dates.length, series.dates.length + 2);
  assert.equal(new Set(saved.series.dates).size, saved.series.dates.length);
  assert.deepEqual(saved.series.pe.slice(0, -12), series.pe.slice(0, -10));
});

test("long-lived validated history survives slow upstream and repeated failures back off", async (t) => {
  const env = memoryEnv([[SETTLED_KEY, JSON.stringify({ ...settled, cached_at: "2026-10-13T01:00:00Z" })]]);
  const calls = mockIncremental(t, { fail: true });
  const afternoon = new Date("2026-10-15T08:00:00Z");
  const a = await buildHs300Result(env, { now: afternoon });
  assert.equal(a.as_of, settled.series.dates.at(-1));
  assert.equal(a.quality.analysis_available, true);
  assert.equal(a.quality.actionable, false);
  assert.equal(a.quality.status, "source_unavailable", "after-close source outage must not masquerade as a normal publication delay");
  assert.match(a.source_warning, /超时/);
  assert.ok(!a.source_warning.includes("aborted"));
  const before = calls.length;
  const b = await buildHs300Result(env, { now: afternoon });
  assert.ok(calls.length - before <= 2);
  assert.equal(b.quality.actionable, false, "cached failed check cannot turn actionable on next read");
});

test("existing dashboard returns immediately while stale check runs in the background", async () => {
  const data = resultFromSettled(settled, null, { now });
  const env = memoryEnv([[DASH_KEY, JSON.stringify({ cached_at: "2026-10-13T01:00:00Z", data })]]);
  let release;
  const built = new Promise((resolve) => { release = resolve; });
  const tasks = [];
  const response = await getHs300Dashboard(env, false, { builder: async () => built,
    ctx: { waitUntil(p) { tasks.push(p); } } });
  assert.equal(response.refresh_pending, true);
  assert.equal(response.as_of, data.as_of);
  assert.equal(tasks.length, 1);
  release(data);
  await tasks[0];
  assert.equal(JSON.parse(env.values.get(DASH_KEY)).data.refresh_status, "fresh");
});

test("failed background check is dated and does not restart on the next GET", async () => {
  const data = resultFromSettled(settled, null, { now });
  const env = memoryEnv([[DASH_KEY, JSON.stringify({ cached_at: "2026-10-13T01:00:00Z", data })]]);
  const tasks = [];
  let calls = 0;
  const options = { builder: async () => { calls += 1; throw new Error("timeout"); }, ctx: { waitUntil(p) { tasks.push(p); } } };
  await getHs300Dashboard(env, false, options);
  await tasks[0];
  const again = await getHs300Dashboard(env, false, options);
  assert.equal(calls, 1);
  assert.equal(again.refresh_pending, false);
  assert.equal(again.refresh_status, "reference");
  assert.equal(again.quality.actionable, false);
});

test("incremental feed gaps cannot delete a previously confirmed observation", async (t) => {
  const env = memoryEnv([[SETTLED_KEY, JSON.stringify({ ...settled, cached_at: now.toISOString() })]]);
  const missing = series.dates.at(-3);
  mockIncremental(t, { price: raw.price.filter((r) => r.date !== missing) });
  const d = await buildHs300Result(env, { now: new Date("2026-10-15T08:00:00Z") });
  assert.equal(d.history_source, "cache-fallback");
  assert.match(d.source_warning, /缺口/);
  assert.deepEqual(JSON.parse(env.values.get(SETTLED_KEY)).series.dates, series.dates);
});

test("hung refresh terminates with or without a saved dashboard", async () => {
  const env = memoryEnv();
  await assert.rejects(getHs300Dashboard(env, true, {
    timeoutMs: 10, builder: async () => new Promise(() => {}),
  }), /超时/);
});

test("concurrent refreshes share one build and save current history", async () => {
  const env = memoryEnv();
  let calls = 0;
  const builder = async () => {
    calls += 1; await new Promise((r) => setTimeout(r, 10));
    return { model_version: DEFAULT_CONFIG.version, as_of: "20261014", price_index: { level: 4200 } };
  };
  const [a, b] = await Promise.all([getHs300Dashboard(env, true, { builder }), getHs300Dashboard(env, true, { builder })]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal(a.history.at(-1).as_of, "20261014");
});
