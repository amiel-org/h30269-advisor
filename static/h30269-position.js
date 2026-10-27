// H30269 position arithmetic. All percentages use the independent strategy budget.
// Core and tactical caps are a baseline (70/30), not a claim of optimal allocation.
export function calculateH30269Position(result, currentText, tacticalText, budgetText = '') {
  const currentPct = Number(String(currentText ?? '').trim());
  const tacticalPct = Number(String(tacticalText ?? '').trim());
  if (String(currentText ?? '').trim() === '' || String(tacticalText ?? '').trim() === '') {
    return { valid: false, reason: '请填写当前总仓位和其中的战术仓比例。' };
  }
  if (!Number.isFinite(currentPct) || currentPct < 0 || currentPct > 100 ||
      !Number.isFinite(tacticalPct) || tacticalPct < 0 || tacticalPct > currentPct) {
    return { valid: false, reason: '仓位需为0–100，且战术仓不能大于总仓位。' };
  }
  const budget = String(budgetText ?? '').trim();
  const capital = budget ? Number(budget) : null;
  if (budget && (!Number.isFinite(capital) || capital <= 0)) {
    return { valid: false, reason: '资金池金额需大于0，或留空只看比例。' };
  }
  const evaluation = result?.evaluation || {};
  const execution = evaluation.execution || {};
  const code = evaluation.action_code || '';
  const current = currentPct / 100;
  const tactical = tacticalPct / 100;
  const core = current - tactical;
  const tacticalCap = .30;
  const coreCap = .70;
  const heavyLine = .80;
  let move = 0;
  let tacticalAfter = tactical;
  let reason = '当前信号不要求调仓，保持现有核心仓和战术仓。';
  let direction = 'hold';
  if (code.startsWith('buy_')) {
    direction = 'buy';
    if (current >= heavyLine) {
      reason = '当前已达到80%重仓线，不追买；保留后续加仓空间。';
    } else {
      const requested = Math.min(Number(execution.pct || 0) / 100, heavyLine - current, 1 - current);
      const tacticalMove = Math.min(requested, Math.max(0, tacticalCap - tactical));
      tacticalAfter = tactical + tacticalMove;
      move = Math.min(requested, tacticalMove + Math.max(0, coreCap - core));
      reason = move > 0
        ? `估值与股债条件通过，本次增加${(move * 100).toFixed(1)}个百分点；先补战术仓，再补核心仓。`
        : '核心仓70%和战术仓30%的配置上限均已达到，不再新增。';
    }
  } else if (code === 'reduce_ready' || code.startsWith('reduce_tactical_') || code === 'reduce_core_review') {
    direction = 'sell';
    const requested = current * Number(execution.pct || execution.planned_pct || 0) / 100;
    move = -Math.min(requested, tactical);
    tacticalAfter = tactical + move;
    reason = move < 0
      ? `过热条件已确认，本次只减战术仓${(Math.abs(move) * 100).toFixed(1)}个百分点，核心仓不因本动作变化。`
      : '当前没有可减的战术仓；核心仓只进入复核，不由本规则自动卖出。';
  }
  const after = current + move;
  if (Object.is(move, -0)) move = 0;
  const intraday = result?.sources?.target?.quote_status === '盘中';
  const blocked = Boolean(result?.quality?.blockers?.length);
  const signalReady = Boolean(evaluation.confirmed) && !blocked;
  const canExecute = signalReady && intraday && move !== 0;
  return {
    valid: true, current, tactical, core, capital, direction, move, after, tacticalAfter,
    coreAfter: after - tacticalAfter, reason, canExecute,
    reviewRequired: code === 'reduce_ready',
    reviewReady: signalReady && !intraday,
    moveAmount: capital === null ? null : capital * move,
    afterAmount: capital === null ? null : capital * after,
    tacticalCap, coreCap, heavyLine,
  };
}
