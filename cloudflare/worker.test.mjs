import assert from "node:assert/strict";
import test from "node:test";

import {
  bondSupport,
  estimateBeta,
  evaluateRules,
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
