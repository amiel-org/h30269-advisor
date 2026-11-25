import assert from "node:assert/strict";
import test from "node:test";
import { PORTFOLIO_CONFIG, classifyRegime, computePortfolioTargets, computeSpilloverFactors } from "./lib/portfolio-model.js";
import { assemblePortfolioDashboard } from "./lib/portfolio-dashboard.js";
import { calculatePortfolioPosition } from "../static/portfolio-position.js";

function sampleDashboard(overrides = {}) {
  return {
    config: PORTFOLIO_CONFIG,
    sleeves: {
      hs300: {
        available: true,
        can_decide: true,
        agreed: true,
        consensus_exposure: 0.75,
        pe_percentile: 35,
        erp_percentile: 82,
        window_min: 0.75,
        window_max: 0.75,
        execution: { buy_confirmed: true, sell_confirmed: true },
        ...(overrides.hs300 || {}),
      },
      h30269: {
        blocked: false,
        blockers: [],
        confirmed: true,
        action_code: "hold",
        decision: "持有",
        pe_percentile: 55,
        beta_adjusted_spread_pct: 1.2,
        overheat: false,
        execution: { pct: 0, planned_pct: 0 },
        ...(overrides.h30269 || {}),
      },
    },
  };
}

test("spillover factors decay smoothly with PE percentile and block on overheat", () => {
  const cheap = computeSpilloverFactors(40, 0.75, 60, 0, false);
  assert.equal(cheap.hs300_factor, 1);
  assert.equal(cheap.h30269_factor, 1);

  const mid = computeSpilloverFactors(55, 0.75, 77.5, 0, false);
  assert.ok(Math.abs(mid.hs300_factor - 0.5) < 1e-9);
  assert.ok(Math.abs(mid.h30269_factor - 0.5) < 1e-9);

  const expensive = computeSpilloverFactors(70, 0.75, 90, 0, false);
  assert.equal(expensive.hs300_factor, 0);
  assert.equal(expensive.h30269_factor, 0);

  const overheated = computeSpilloverFactors(40, 0.75, 50, 6.0, false);
  assert.equal(overheated.h30269_factor, 0);
});

test("computePortfolioTargets enforces sleeve caps and 90% total equity cap", () => {
  const dualMax = computePortfolioTargets(1.0, 1.0, 20, 30, -4, false);
  assert.ok(dualMax.total_equity <= 0.9 + 1e-9);
  assert.ok(dualMax.cash_target >= 0.1 - 1e-9);
  assert.equal(dualMax.capped_by_total, true);

  const divSpill = computePortfolioTargets(0.0, 0.8, 75, 50, 0, false);
  // idle HS300 = 0.50 -> +0.25 spillover budget -> effDiv = 0.70 (clamped at max_div=0.70) -> 0.70 * 0.80 = 0.56
  assert.ok(Math.abs(divSpill.eff_h30269_budget - 0.70) < 1e-9);
  assert.ok(Math.abs(divSpill.h30269_target - 0.56) < 1e-9);
});

test("position calculator rejects invalid inputs or sums above 100%", () => {
  const data = sampleDashboard();
  assert.equal(calculatePortfolioPosition(data, "", "30", "").valid, false);
  assert.equal(calculatePortfolioPosition(data, "60", "50", "").valid, false);
  assert.equal(calculatePortfolioPosition(data, "-5", "30", "").valid, false);
  assert.equal(calculatePortfolioPosition(data, "25", "35", "0").valid, false);
});

test("position calculator computes cross-sleeve funding when one sleeve trims and the other buys", () => {
  const data = sampleDashboard({
    hs300: { agreed: true, consensus_exposure: 0.75, pe_percentile: 35, can_decide: true },
    h30269: { action_code: "reduce_tactical_10", decision: "战术仓减10%", confirmed: true, overheat: true, execution: { pct: 10, planned_pct: 10 } },
  });
  const plan = calculatePortfolioPosition(data, "15", "45", "500000");
  assert.equal(plan.valid, true);
  assert.ok(plan.moves.hs300 > 0);
  assert.ok(plan.moves.h30269 < 0);
  assert.ok(plan.moves.crossFunded > 0);
  assert.match(plan.fundingText, /跨资产资金对冲/);
  assert.ok(plan.after.equity <= 0.9 + 1e-9);
  assert.ok(plan.after.cash >= 0.1 - 1e-9);
});

test("no-cliff protection never force-sells H30269 merely because PE entered high percentile", () => {
  const data = sampleDashboard({
    hs300: { agreed: false, consensus_exposure: "HOLD", pe_percentile: 56 },
    h30269: { action_code: "valuation_high_watch", decision: "观察，绝对估值偏高", pe_percentile: 82, overheat: false },
  });
  const plan = calculatePortfolioPosition(data, "25", "45", "100000");
  assert.equal(plan.valid, true);
  assert.equal(plan.moves.h30269, 0);
  assert.equal(plan.moves.hs300, 0);
  assert.match(plan.sleeveReasons.h30269, /防误杀/);
});

test("total equity hard cap trims buys so cash never drops below 10%", () => {
  const data = sampleDashboard({
    hs300: { agreed: true, consensus_exposure: 1.0, pe_percentile: 25, can_decide: true },
    h30269: { action_code: "buy_tranche", decision: "分批买入（16%）", confirmed: true, pe_percentile: 40, execution: { pct: 16 } },
  });
  const plan = calculatePortfolioPosition(data, "40", "46", "200000");
  assert.equal(plan.valid, true);
  assert.equal(plan.capTrimmed, true);
  assert.ok(plan.after.equity <= 0.9 + 1e-9);
  assert.ok(plan.after.cash >= 0.1 - 1e-9);
});

test("assemblePortfolioDashboard combines live HS300 and H30269 payloads cleanly", () => {
  const hs300Mock = {
    model_version: "v2.5",
    as_of: "20261124",
    pe: 13.1,
    pe_percentile: 56,
    erp: 5.9,
    erp_percentile: 76,
    chart: { exposure: [0.375] },
    analysis: {
      date: "20261124",
      price: 4200,
      pe: 13.1,
      pe_percentile: 56,
      erp: 5.9,
      erp_percentile: 76,
      consensus: { agreed: false, exposure: "HOLD", min_exposure: 0.125, max_exposure: 0.625 },
      windows: { full: { pe_percentile: 56, erp_percentile: 76, exposure: 0.375 } },
      quality: { available: true, can_decide: false, reason: "已收盘" },
    },
    execution: { buy_confirmed: false, sell_confirmed: false },
  };
  const h30269Mock = {
    result: {
      model_version: "V3.2-auto-1.0",
      metrics: {
        trade_date: "2026-11-24",
        close: 12000,
        tr_close: 24000,
        pe: 7.85,
        pe_percentile: 79.9,
        beta_adjusted_spread_pct: 11.87,
        relative_zone: "相对过热",
        bond_support: "股债强支撑",
        beta_consensus: { robust_overheat: true },
      },
      evaluation: {
        action_code: "reduce_tactical_10",
        decision: "战术仓减10%",
        reason: "连续2日确认",
        confirmed: true,
        execution: { pct: 10, planned_pct: 10, scope: "战术仓", core_action: "不动" },
      },
      quality: { blockers: [], warnings: [], confidence: "高" },
      sources: { target: { quote_status: "历史收盘" } },
    },
  };
  const assembled = assemblePortfolioDashboard(hs300Mock, h30269Mock, new Date("2026-11-25T06:00:00Z"));
  assert.equal(assembled.version, "v1.0");
  assert.equal(assembled.sleeves.h30269.overheat, true);
  assert.equal(assembled.reference_allocation.h30269_factor, 0);
  assert.equal(classifyRegime(35, 85, true, 0.75, 0.5).code, "hs300_lead");
});
