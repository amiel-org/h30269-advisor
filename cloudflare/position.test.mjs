import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateH30269Position } from '../static/h30269-position.js';

const fixture = (code = 'buy_tranche', quote = '盘中', pct = undefined) => {
  const defaultPct = code.startsWith('buy_') ? 16 : code.startsWith('reduce_') ? 10 : 0;
  const step = pct ?? defaultPct;
  return {
    evaluation: { action_code: code, confirmed: code !== 'valuation_high_watch', execution: { pct: step, planned_pct: step || 10 } },
    quality: { blockers: [] }, sources: { target: { quote_status: quote } },
  };
};

test('H30269 V3.2 buys into tactical first and respects 70/30 and 80% heavy caps', () => {
  const first = calculateH30269Position(fixture('buy_tranche', '盘中', 16), '50', '10', '100000');
  assert.ok(Math.abs(first.move - .16) < 1e-12);
  assert.ok(Math.abs(first.tacticalAfter - .26) < 1e-12);
  assert.ok(Math.abs(first.coreAfter - .40) < 1e-12);
  assert.equal(first.moveAmount, 16000);
  assert.equal(first.canExecute, true);

  const capped = calculateH30269Position(fixture('buy_tranche', '盘中', 20), '75', '30', '');
  assert.ok(Math.abs(capped.move - .05) < 1e-12);
  assert.ok(Math.abs(capped.after - .80) < 1e-12);

  const heavy = calculateH30269Position(fixture('buy_tranche', '盘中', 20), '85', '30', '');
  assert.equal(heavy.move, 0);
  assert.equal(heavy.canExecute, false);
});

test('H30269 V3.2 tactical reduction trims 10 budget percentage points capped at tactical holdings', () => {
  const fullTac = calculateH30269Position(fixture('reduce_ready'), '50', '15', '100000');
  assert.ok(Math.abs(fullTac.move + .10) < 1e-12);
  assert.ok(Math.abs(fullTac.after - .40) < 1e-12);
  assert.ok(Math.abs(fullTac.tacticalAfter - .05) < 1e-12);
  assert.ok(Math.abs(fullTac.coreAfter - .35) < 1e-12);
  assert.equal(fullTac.moveAmount, -10000);
  assert.equal(fullTac.canExecute, true);

  const partialTac = calculateH30269Position(fixture('reduce_ready'), '50', '3', '100000');
  assert.ok(Math.abs(partialTac.move + .03) < 1e-12);
  assert.ok(Math.abs(partialTac.tacticalAfter) < 1e-12);
  assert.ok(Math.abs(partialTac.coreAfter - .47) < 1e-12);

  const none = calculateH30269Position(fixture('reduce_tactical_10'), '50', '0', '');
  assert.equal(none.move, 0);
  assert.equal(none.coreAfter, .5);
  assert.equal(none.canExecute, false);
});

test('H30269 V3.2 reduce_core_review trims tactical first then core down to 45% floor', () => {
  const review = calculateH30269Position(fixture('reduce_core_review', '收盘后', 10), '55', '4', '100000');
  assert.ok(Math.abs(review.move + .10) < 1e-12);
  assert.ok(Math.abs(review.tacticalAfter) < 1e-12);
  assert.ok(Math.abs(review.coreAfter - .45) < 1e-12);
  assert.equal(review.reviewReady, true);
  assert.equal(review.canExecute, false);

  const nearFloor = calculateH30269Position(fixture('reduce_core_review', '收盘后', 10), '46', '0', '');
  assert.ok(Math.abs(nearFloor.move + .01) < 1e-12);
  assert.ok(Math.abs(nearFloor.coreAfter - .45) < 1e-12);
});

test('H30269 V3.2 valuation_high_watch blocks chase buying and outside trading produces review', () => {
  const highPe = calculateH30269Position(fixture('valuation_high_watch', '盘中', 0), '50', '10', '100000');
  assert.equal(highPe.move, 0);
  assert.equal(highPe.canExecute, false);
  assert.match(highPe.reason, /高分位/);

  const afterClose = calculateH30269Position(fixture('reduce_tactical_10', '收盘后', 10), '50', '10', '');
  assert.equal(afterClose.canExecute, false);
  assert.equal(afterClose.reviewReady, true);
  assert.ok(Math.abs(afterClose.move + .10) < 1e-12);
});

test('H30269 rejects inconsistent position and budget inputs', () => {
  assert.equal(calculateH30269Position(fixture(), '50', '60', '').valid, false);
  assert.equal(calculateH30269Position(fixture(), '50', '10', '0').valid, false);
  assert.equal(calculateH30269Position(fixture(), '', '10', '').valid, false);
});
