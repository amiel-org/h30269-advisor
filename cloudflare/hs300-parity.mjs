// HS300 parity test: JavaScript engine must reproduce the Python reference.
//
// Ground truth = the JSON that the Python model itself produced
// (hs300/reports/parity_expected.json).  If JS and Python ever disagree, this
// test fails, which is exactly how a silent rule fork gets caught.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSignals, metrics, runBacktest } from "./lib/hs300-model.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

const snapshot = read("raw_data.json");
const expected = read("hs300/reports/parity_expected.json");

// ---- rebuild the aligned series exactly like hs300/data.py ---- //
function align(bundle) {
  const bond = bundle.bond10y;
  const bondKeys = Object.keys(bond).sort();
  const trMap = new Map(bundle.total_return.map((r) => [r.date, r.close]));
  const dates = [], tr = [], pe = [], spread = [];
  for (const row of bundle.price) {
    const d = row.date;
    const dow = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`).getUTCDay();
    if (dow === 0 || dow === 6) continue;              // weekends dropped
    if (row.pe === null || row.pe === undefined) continue;
    if (!trMap.has(d)) continue;
    let lo = 0, hi = bondKeys.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (bondKeys[mid] <= d) lo = mid + 1; else hi = mid; }
    const key = bondKeys[lo - 1];
    if (key === undefined) continue;
    const p = Number(row.pe);
    dates.push(d); tr.push(Number(trMap.get(d))); pe.push(p);
    spread.push(100 / p - bond[key]);
  }
  return { dates, tr, pe, spread };
}

const series = align(snapshot);

// ---- 1. signals must match the Python-produced series ---- //
const rawSignals = buildSignals(series);
const signals = rawSignals.map((s) => (typeof s === "number" ? +s.toFixed(12) : s));
assert.equal(signals.length, expected.signals.length, "signal length");
let mismatches = 0;
for (let i = 0; i < signals.length; i += 1) {
  const a = signals[i], b = expected.signals[i];
  if (a === null && b === null) continue;
  if (b === "HOLD" || a === "HOLD") {
    if (a !== b) {
      if (mismatches < 5) console.error(`HOLD mismatch at ${i} (${series.dates[i]}): js=${a} py=${b}`);
      mismatches += 1;
    }
    continue;
  }
  if (a === null || b === null || Math.abs(a - b) > 1e-9) {
    if (mismatches < 5) console.error(`signal mismatch at ${i} (${series.dates[i]}): js=${a} py=${b}`);
    mismatches += 1;
  }
}
assert.equal(mismatches, 0, `${mismatches} signal mismatches`);

// HOLD-day count must also agree
const jsHold = rawSignals.filter((s) => s === "HOLD").length;
assert.equal(jsHold, expected.hold_days, `HOLD days js=${jsHold} py=${expected.hold_days}`);

// ---- 2. backtest metrics must match ---- //
const run = runBacktest(series, undefined, null, 1);
const m = metrics(run.curve);
const exp = expected.metrics;
// Python emits snake_case; map each metric to its reference key.
const metricMap = [
  ["cagrCalendarPct", "cagr_calendar_pct"],
  ["maxDrawdownPct", "max_drawdown_pct"],
  ["sharpe", "sharpe"],
  ["endNav", "end_nav"],
];
for (const [jsKey, pyKey] of metricMap) {
  assert.ok(Math.abs(m[jsKey] - exp[pyKey]) < 5e-3,
    `${jsKey}: js=${m[jsKey]} py=${exp[pyKey]}`);
}
assert.equal(run.steps.length, expected.trades, `trade count js=${run.steps.length} py=${expected.trades}`);

// ---- 3. current signal must match ---- //
const last = series.dates.length - 1;
assert.equal(rawSignals[last], expected.current.consensus,
  `current consensus js=${rawSignals[last]} py=${expected.current.consensus}`);

console.log(`parity OK  | signals=${signals.length}  trades=${run.steps.length}  ` +
            `HOLD=${jsHold}  CAGR=${m.cagrCalendarPct}%  MaxDD=${m.maxDrawdownPct}%  ` +
            `Sharpe=${m.sharpe}  consensus=${rawSignals[last]}`);
