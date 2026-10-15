// Pure arithmetic shared by the browser calculator and regression checks.
// Scenario rows explain each window; they never override consensus.
export function calculatePosition(data, positionText, budgetText = '') {
  const position = String(positionText ?? '').trim();
  const budget = String(budgetText ?? '').trim();
  if (!position) return { valid: false, reason: '先填写当前仓位，例如50表示资金池中已有50%买了沪深300。' };
  const currentPct = Number(position);
  if (!Number.isFinite(currentPct) || currentPct < 0 || currentPct > 100) {
    return { valid: false, reason: '当前仓位请输入0–100之间的数字；0表示空仓，100表示满仓。' };
  }
  const capital = budget ? Number(budget) : null;
  if (budget && (!Number.isFinite(capital) || capital <= 0)) {
    return { valid: false, reason: '策略资金池金额请输入大于0的数字，或者留空只看仓位比例。' };
  }
  const analysis = data?.analysis;
  if (!analysis) return { valid: false, reason: '正在获取行情，数据返回后自动计算。' };
  const current = currentPct / 100;
  const step = data.execution?.step_size ?? .125;
  const deadband = data.execution?.deadband ?? .05;
  const plan = (target) => {
    if (!Number.isFinite(target) || target < 0 || target > 1) return null;
    const gap = target - current;
    const move = Math.abs(gap) > deadband + 1e-9 ? Math.sign(gap) * Math.min(Math.abs(gap), step) : 0;
    return { target, gap, move, after: current + move,
      targetAmount: capital === null ? null : capital * target,
      gapAmount: capital === null ? null : capital * gap,
      moveAmount: capital === null ? null : capital * move,
      afterAmount: capital === null ? null : capital * (current + move) };
  };
  const keys = ['full', '10y', '5y'];
  const rows = keys.map((key) => ({ key, ...plan(analysis.windows?.[key]?.exposure) }));
  const values = keys.map((key) => analysis.windows?.[key]?.exposure);
  const consensus = analysis.consensus;
  const agreed = Boolean(consensus?.agreed && Number.isFinite(consensus.exposure) &&
    values.every((v) => Number.isFinite(v) && Math.abs(v - consensus.exposure) < 1e-9));
  const overall = agreed ? plan(consensus.exposure) : { target: null, gap: null, move: 0,
    after: current, targetAmount: null, gapAmount: null, moveAmount: capital === null ? null : 0,
    afterAmount: capital === null ? null : capital * current };
  return { valid: true, current, capital, agreed, overall, rows,
    holdings: capital === null ? null : capital * current,
    cash: capital === null ? null : capital * (1 - current),
    canAct: Boolean(agreed && analysis.quality?.can_decide && analysis.quality?.available),
    analysisAvailable: Boolean(analysis.quality?.available),
    step, deadband };
}
