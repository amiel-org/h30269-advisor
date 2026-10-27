import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateH30269Position } from '../static/h30269-position.js';

const fixture = (code = 'buy_tranche', quote = '盘中') => ({
  evaluation: { action_code: code, confirmed: true, execution: { pct: code.startsWith('buy_') ? 20 : 5, planned_pct: 5 } },
  quality: { blockers: [] }, sources: { target: { quote_status: quote } },
});

test('H30269 buys into tactical first and respects the 70/30 caps', () => {
  const first = calculateH30269Position(fixture(), '50', '10', '100000');
  assert.equal(first.move, .2); assert.equal(first.tacticalAfter, .3);
  assert.ok(Math.abs(first.coreAfter - .4) < 1e-12); assert.equal(first.moveAmount, 20000); assert.equal(first.canExecute, true);
  const capped = calculateH30269Position(fixture(), '75', '30', '');
  assert.ok(Math.abs(capped.move - .05) < 1e-12); assert.ok(Math.abs(capped.after - .8) < 1e-12);
  const heavy = calculateH30269Position(fixture(), '85', '30', '');
  assert.equal(heavy.move, 0); assert.equal(heavy.canExecute, false);
});

test('H30269 reduces only tactical holdings and never creates negative tactical exposure', () => {
  const r = calculateH30269Position(fixture('reduce_ready'), '50', '3', '100000');
  assert.equal(r.move, -.025); assert.equal(r.after, .475);
  assert.ok(Math.abs(r.tacticalAfter - .005) < 1e-12); assert.ok(Math.abs(r.coreAfter - .47) < 1e-12); assert.equal(r.moveAmount, -2500); assert.equal(r.canExecute, true);
  const none = calculateH30269Position(fixture('reduce_tactical_5'), '50', '0', '');
  assert.equal(none.move, 0); assert.equal(none.coreAfter, .5); assert.equal(none.canExecute, false);
});

test('H30269 outside continuous trading produces review, not an intraday execution', () => {
  const r = calculateH30269Position(fixture('reduce_tactical_5', '收盘后'), '50', '10', '');
  assert.equal(r.canExecute, false); assert.equal(r.reviewReady, true); assert.equal(r.move, -.025);
});

test('H30269 rejects inconsistent position and budget inputs', () => {
  assert.equal(calculateH30269Position(fixture(), '50', '60', '').valid, false);
  assert.equal(calculateH30269Position(fixture(), '50', '10', '0').valid, false);
  assert.equal(calculateH30269Position(fixture(), '', '10', '').valid, false);
});
