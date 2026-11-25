// Verify that the JS dual-asset portfolio engine produces the exact same
// summary metrics and trade steps as Python portfolio/model.py.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PORTFOLIO_CONFIG, runPortfolioBacktest } from "./lib/portfolio-model.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const parity = JSON.parse(readFileSync(join(root, "portfolio/reports/parity_expected.json"), "utf8"));

const actual = runPortfolioBacktest(parity.records, PORTFOLIO_CONFIG);

assert.equal(actual.trades.length, parity.expected_trades.length, "portfolio trade count mismatch");
for (let i = 0; i < actual.trades.length; i += 1) {
  assert.deepEqual(actual.trades[i], parity.expected_trades[i], `trade #${i} mismatch`);
}

for (const seg of ["full", "pre_2022", "post_2022"]) {
  for (const field of ["cagr_calendar_pct", "max_drawdown_pct", "sharpe", "calmar", "end_nav"]) {
    const a = actual.summary[seg][field];
    const e = parity.expected_summary[seg][field];
    assert.ok(Math.abs(a - e) < 1e-4, `${seg}.${field} mismatch: js=${a} py=${e}`);
  }
}

console.log(
  `portfolio parity OK | days=${parity.records.length} trades=${actual.trades.length} `
  + `CAGR=${actual.summary.full.cagr_calendar_pct}% MaxDD=${actual.summary.full.max_drawdown_pct}% `
  + `ExSharpe=${actual.summary.full.sharpe} Calmar=${actual.summary.full.calmar}`,
);
