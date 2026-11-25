import assert from "node:assert/strict";
import test from "node:test";

import {
  bondSupport,
  dataQuality,
  estimateBeta,
  evaluateRules,
  impliedDividendYield,
  parseBond10y,
  relativeZone,
} from "./worker.js";

test("relative zone boundaries match the Python model", () => {
  assert.equal(relativeZone(-8), "强买");
  assert.equal(relativeZone(-5), "加仓");
  assert.equal(relativeZone(-1), "买入");
  assert.equal(relativeZone(-0.1), "观察");
  assert.equal(relativeZone(4.99), "持有");
  assert.equal(relativeZone(5), "相对偏热");
  assert.equal(relativeZone(7), "相对过热");
});

test("rolling beta matches a synthetic half-beta series", () => {
  const target = [{ close: 100 }];
  const benchmark = [{ close: 100 }];
  let targetValue = 100;
  let benchmarkValue = 100;
  for (let index = 0; index < 900; index += 1) {
    const marketReturn = ((index % 11) - 5) / 1000;
    benchmarkValue *= 1 + marketReturn;
    targetValue *= 1 + 0.5 * marketReturn;
    target.push({ close: targetValue });
    benchmark.push({ close: benchmarkValue });
  }
  const estimate = estimateBeta(target, benchmark, 900, 800, 500, 0.4);
  assert.equal(estimate.sufficient, true);
  assert.ok(Math.abs(estimate.beta - 0.5) < 0.001);
});

test("bond support uses spread or multiple", () => {
  assert.equal(bondSupport(4.3, 1.7)[0], "股债强支撑");
});

test("ChinaBond HTML parser selects the newest 10-year value", () => {
  const html = `
    <table>
      <tr><td>中债国债收益率曲线</td><td>2026-08-01</td><td>1</td><td>1</td><td>1</td><td>1</td><td>1</td><td>1</td><td>1.72</td><td>2</td></tr>
      <tr><td>中债国债收益率曲线</td><td>2026-08-06</td><td>1</td><td>1</td><td>1</td><td>1</td><td>1</td><td>1</td><td>1.68</td><td>2</td></tr>
    </table>`;
  assert.deepEqual(parseBond10y(html), { as_of: "2026-08-06", value: 1.68 });
});

function metrics(changes = {}) {
  return {
    relative_zone: "持有",
    beta_adjusted_spread_pct: 2,
    raw_relative_spread_pct: 8,
    target_40d_return_pct: 1,
    bond_support: "股债强支撑",
    momentum: "中性",
    distance_ma250_pct: 0,
    beta_consensus: { consistent: true, robust_buy: false, robust_overheat: false, status: "窗口一致" },
    reduce_confirmation: {
      required_closes: 2,
      confirmed_closes: 0,
      consecutive_closes: 0,
      confirmed: false,
      core_required_closes: 5,
      core_confirmed: false,
      intraday_excluded: false,
    },
    ...changes,
  };
}

test("five to seven percent only pauses additions", () => {
  const result = evaluateRules(metrics({ relative_zone: "相对偏热", beta_adjusted_spread_pct: 6 }), { blockers: [], warnings: [] });
  assert.equal(result.action_code, "pause_add");
  assert.equal(result.execution.pct, 0);
});

test("relative overheat without absolute gain cannot sell", () => {
  const result = evaluateRules(metrics({
    relative_zone: "相对过热",
    beta_adjusted_spread_pct: 8,
    beta_consensus: { consistent: true, robust_buy: false, robust_overheat: true, status: "窗口一致" },
    target_40d_return_pct: -1,
    distance_ma250_pct: 2,
  }), { blockers: [], warnings: [] });
  assert.equal(result.action_code, "overheat_protected");
  assert.equal(result.execution.pct, 0);
});

test("V3.2 PE valuation gate blocks high-percentile regular buys while preserving extreme strong_buy", () => {
  const blocked = evaluateRules(metrics({
    relative_zone: "买入",
    beta_adjusted_spread_pct: -2.2,
    pe: 7.9,
    pe_percentile: 81.5,
    beta_consensus: { consistent: true, robust_buy: true, robust_overheat: false, status: "窗口一致" },
  }), { blockers: [], warnings: [] });
  assert.equal(blocked.action_code, "valuation_high_watch");
  assert.equal(blocked.execution.pct, 0);

  const normalBuy = evaluateRules(metrics({
    relative_zone: "买入",
    beta_adjusted_spread_pct: -2.2,
    pe: 6.5,
    pe_percentile: 45.0,
    beta_consensus: { consistent: true, robust_buy: true, robust_overheat: false, status: "窗口一致" },
  }), { blockers: [], warnings: [] });
  assert.equal(normalBuy.action_code, "buy_tranche");
  assert.equal(normalBuy.execution.pct, 12);

  const addBuy = evaluateRules(metrics({
    relative_zone: "加仓",
    beta_adjusted_spread_pct: -5.5,
    pe: 6.5,
    pe_percentile: 45.0,
    beta_consensus: { consistent: true, robust_buy: true, robust_overheat: false, status: "窗口一致" },
  }), { blockers: [], warnings: [] });
  assert.equal(addBuy.execution.pct, 16);

  const strongBuy = evaluateRules(metrics({
    relative_zone: "强买",
    beta_adjusted_spread_pct: -8.5,
    pe: 7.9,
    pe_percentile: 85.0,
    beta_consensus: { consistent: true, robust_buy: true, robust_overheat: false, status: "窗口一致" },
  }), { blockers: [], warnings: [] });
  assert.equal(strongBuy.action_code, "buy_tranche");
  assert.equal(strongBuy.execution.pct, 20);
});

test("V3.2 dataQuality blocks missing, fallback or expired fundamentals", () => {
  const now = new Date("2026-11-25T06:00:00Z");
  const q = dataQuality(
    { trade_date: "2026-11-24", beta_source: "rolling-full", beta_consensus: { consistent: true } },
    { value: null, as_of: null, status: "missing" },
    { value: 1.80, as_of: "2026-06-25", status: "cache" },
    [],
    now,
  );
  assert.equal(q.confidence, "低");
  assert.equal(q.blockers.length, 2);
});

test("V3.2 impliedDividendYield recovers TTM dividend yield from total-return vs price index", () => {
  const priceRows = [];
  const trRows = [];
  let p = 100;
  let tr = 200;
  for (let i = 0; i < 400; i += 1) {
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
    if (i === 300) {
      // 4.5% dividend paid out: price drops 4.5% ex-div while total return holds steady
      p *= 1 - 0.045;
    }
    priceRows.push({ date: d, close: p });
    trRows.push({ date: d, close: tr });
  }
  const implied = impliedDividendYield(priceRows, trRows);
  assert.ok(implied);
  assert.ok(Math.abs(implied.value - (4.5 / 95.5) * 100) < 0.05);
});
