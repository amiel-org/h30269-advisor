import assert from "node:assert/strict";
import test from "node:test";
import { flowPresentation, refreshEtfFlows, getEtfFlows } from "./lib/hs300-etf-flows.js";

const memoryEnv = () => {
  const values = new Map();
  return { H30269_KV: { async get(k) { return values.get(k) ?? null; }, async put(k, v) { values.set(k, v); } }, values };
};

test("ETF flow changes require complete session gaps and separate ratio from shares", () => {
  const history = Array.from({ length: 21 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, ratio_pct: 1 + i * .01, total_shares: 100 + i }));
  const current = { date: "2026-10-22", ratio_pct: 1.22, total_shares: 121 };
  const first = flowPresentation({ date: "2026-10-01", ratio_pct: 1, total_shares: 100 }, []);
  assert.equal(first.ratio_change_5d_pp, null);
  assert.equal(first.shares_change_20d_pct, null);
  const result = flowPresentation(current, history);
  assert.equal(result.ratio_change_5d_pp, .06);
  assert.equal(result.ratio_change_20d_pp, .21);
  assert.ok(Math.abs(result.shares_change_5d_pct - 5 / 116 * 100) < .001);
  assert.ok(Math.abs(result.shares_change_20d_pct - 20 / 101 * 100) < .001);
});

test("live snapshot computes real ratio and repeated refresh cannot duplicate a day", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    const index = String(url).includes("1.000300");
    return new Response(JSON.stringify({ data: index ? { f117: 4000000 } : { f84: 100, f116: 250, f124: 1793238000 } }));
  };
  const env = memoryEnv();
  const result = await refreshEtfFlows(env);
  assert.equal(result.total_shares, 400);
  assert.equal(result.total_market_value, 1000);
  assert.equal(result.ratio_pct, .025);
  assert.equal(result.sample_days, 1);
  assert.equal(result.ratio_change_5d_pp, null);
  await refreshEtfFlows(env);
  assert.equal(JSON.parse(env.values.get("hs300:etf-flows:history:v1")).length, 1);
});

test("upstream failure degrades independently instead of blocking valuation", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { throw new Error("offline"); };
  const result = await getEtfFlows(memoryEnv(), { force: true });
  assert.equal(result.status, "unavailable");
  assert.match(result.warning, /不影响估值/);
});

test("missing float market cap fails closed instead of using total market cap", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => new Response(JSON.stringify({ data: String(url).includes("1.000300")
    ? { f116: 4000000 } : { f84: 100, f116: 250, f124: 1793238000 } }));
  const result = await getEtfFlows(memoryEnv(), { force: true });
  assert.equal(result.status, "unavailable");
  assert.equal(result.ratio_pct, undefined);
});

test("Tencent fallback preserves real shares and float market cap units", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url) => {
    if (String(url).includes("eastmoney")) return new Response("blocked", { status: 502 });
    const fields = (n, index) => Array.from({ length: 77 }, (_, i) => i === 3 ? "4" : i === 30 ? "20261029104534" : i === 44 ? String(index ? 484751.83 : 1496.21) : i === 72 ? "36377587700" : "").join("~");
    const codes = ["sh510300", "sh510330", "sz159919", "sh510310", "sh000300"];
    return new Response(codes.map((c, i) => `v_${c}="${fields(c, i === 4)}";`).join("\n"));
  };
  const result = await refreshEtfFlows(memoryEnv());
  assert.equal(result.source, "腾讯公开行情（备用）");
  assert.equal(result.index_float_market_value, 48475183000000);
  assert.equal(result.total_shares, 4 * 36377587700);
  assert.ok(result.ratio_pct > 0);
});
