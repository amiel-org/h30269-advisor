import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, HOLD, buildSignals, metrics, runBacktest, windowTargets } from "./lib/hs300-model.js";
import { SETTLED_KEY, alignSeries, buildHs300Result, resultFromSettled } from "./lib/hs300-data.js";
import { conditionalLevels, confirmationState, signalDetail } from "./lib/hs300-decision.js";
import { DASH_KEY, getHs300Dashboard } from "./lib/hs300-dashboard.js";

const raw = JSON.parse(readFileSync(new URL("../raw_data.json", import.meta.url), "utf8"));
const series = alignSeries(raw.price, raw.total_return, raw.bond10y);
const settled = { series, settled_price: raw.price.find((r) => r.date === series.dates.at(-1)).close,
  bond_last: raw.bond10y[series.dates.at(-1)], bond_date: series.dates.at(-1) };
const now = new Date("2026-10-15T06:00:00Z");
const memoryEnv = (initial = []) => {
  const values = new Map(initial);
  return { H30269_KV: { async get(k) { return values.get(k) ?? null; },
    async put(k, v) { values.set(k, v); } }, values };
};

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
    return Response.json({ data: { intraDayHeader: { tradeDate: "2026-10-15", current: 4200 } } });
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
  assert.equal(calls.length - before, 1, "ordinary repeated reads fetch at most the quote");
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
  assert.equal(calls.length - before, 1);
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
