// Pure browser + Node shared position calculator for the unified family equity pool
// (HS300 v2.5 + H30269 V3.2 + Cash buffer = 100% of total equity pool).

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function cleanZero(value) {
  return Math.abs(value) < 1e-9 ? 0 : value;
}

export function calculatePortfolioPosition(data, hs300PctText, h30269PctText, budgetText = "") {
  const hsRaw = String(hs300PctText ?? "").trim();
  const divRaw = String(h30269PctText ?? "").trim();
  if (!hsRaw || !divRaw) {
    return { valid: false, reason: "请填写当前沪深300与红利低波各占家庭权益总资金池的百分比（例如 25 和 35）。" };
  }
  const hsPct = Number(hsRaw);
  const divPct = Number(divRaw);
  if (!Number.isFinite(hsPct) || !Number.isFinite(divPct) || hsPct < 0 || divPct < 0 || hsPct > 100 || divPct > 100) {
    return { valid: false, reason: "持仓比例请输入 0–100 之间的有效数字。" };
  }
  if (hsPct + divPct > 100 + 1e-6) {
    return { valid: false, reason: `两项持仓之和（${(hsPct + divPct).toFixed(1)}%）不能超过 100%，请以同一权益总资金池为分母。` };
  }
  const budgetRaw = String(budgetText ?? "").trim();
  const capital = budgetRaw ? Number(budgetRaw) : null;
  if (budgetRaw && (!Number.isFinite(capital) || capital <= 0)) {
    return { valid: false, reason: "总权益资金池金额需大于 0，或留空只看比例。" };
  }

  const cfg = data?.config || {
    base_weights: { hs300: 0.5, h30269: 0.5 },
    max_sleeve_weights: { hs300: 0.65, h30269: 0.7 },
    max_total_equity: 0.9,
    min_cash_buffer: 0.1,
    spillover_ratio: 0.5,
    valuation_taper: {
      hs300_pe_full_pct: 45,
      hs300_pe_zero_pct: 65,
      hs300_min_standalone_exposure: 0.25,
      hs300_overheat_pe_pct: 70,
      h30269_pe_full_pct: 70,
      h30269_pe_zero_pct: 85,
      h30269_overheat_spread_pct: 5,
      h30269_heavy_line: 0.8,
      h30269_core_floor: 0.45,
    },
    rebalance: { deadband: 0.05, max_step: 0.1, cooldown_trading_days: 5, no_cliff_sell: true },
  };
  const hs = data?.sleeves?.hs300 || {};
  const div = data?.sleeves?.h30269 || {};
  const baseHs = cfg.base_weights.hs300;
  const baseDiv = cfg.base_weights.h30269;
  const maxHs = cfg.max_sleeve_weights.hs300;
  const maxDiv = cfg.max_sleeve_weights.h30269;
  const maxTotal = cfg.max_total_equity;
  const spillover = cfg.spillover_ratio;
  const vt = cfg.valuation_taper;
  const deadband = cfg.rebalance.deadband;
  const maxStep = cfg.rebalance.max_step;

  const curHs = hsPct / 100;
  const curDiv = divPct / 100;
  const curCash = Math.max(0, 1 - curHs - curDiv);

  // Compute smooth spillover factors using the user's real idle budget on each side
  const hsStandalone = hs.agreed && Number.isFinite(hs.consensus_exposure)
    ? hs.consensus_exposure
    : clamp(curHs / Math.max(1e-9, baseHs), 0, 1);
  const divStandalone = clamp(curDiv / Math.max(1e-9, baseDiv), 0, 1);
  const idleHs = Math.max(0, baseHs - curHs);
  const idleDiv = Math.max(0, baseDiv - curDiv);

  const divFactor = (div.overheat || div.blocked || (Number.isFinite(div.beta_adjusted_spread_pct) && div.beta_adjusted_spread_pct >= vt.h30269_overheat_spread_pct))
    ? 0
    : !Number.isFinite(div.pe_percentile)
      ? 0.5
      : clamp((vt.h30269_pe_zero_pct - div.pe_percentile) / Math.max(1e-9, vt.h30269_pe_zero_pct - vt.h30269_pe_full_pct), 0, 1);

  const hsFactor = (!hs.available || hsStandalone < vt.hs300_min_standalone_exposure - 1e-12)
    ? 0
    : !Number.isFinite(hs.pe_percentile)
      ? 0.5
      : clamp((vt.hs300_pe_zero_pct - hs.pe_percentile) / Math.max(1e-9, vt.hs300_pe_zero_pct - vt.hs300_pe_full_pct), 0, 1);

  const effHsBudget = Math.min(maxHs, baseHs + spillover * hsFactor * idleDiv);
  const effDivBudget = Math.min(maxDiv, baseDiv + spillover * divFactor * idleHs);

  // ---- 1. HS300 sleeve decision in total pool ----
  let targetHs = curHs;
  let moveHs = 0;
  let hsReason = "";
  let hsCanAct = false;
  let hsBandWarning = null;

  if (!hs.available) {
    hsReason = "沪深300行情基准暂不可用，维持现仓。";
  } else if (hs.agreed && Number.isFinite(hs.consensus_exposure)) {
    targetHs = Math.min(maxHs, effHsBudget * hs.consensus_exposure);
    const gapHs = targetHs - curHs;
    if (Math.abs(gapHs) <= deadband + 1e-9) {
      moveHs = 0;
      hsReason = `沪深300三窗口一致（目标占总池 ${(targetHs * 100).toFixed(1)}%），与现仓差在 5.0% 死区内，维持不动。`;
    } else {
      const dir = gapHs > 0 ? "buy" : "sell";
      const ex = hs.execution || {};
      const confirmed = dir === "buy" ? ex.buy_confirmed !== false : ex.sell_confirmed !== false;
      moveHs = Math.sign(gapHs) * Math.min(Math.abs(gapHs), maxStep);
      hsCanAct = Boolean(hs.can_decide && confirmed);
      hsReason = hsCanAct
        ? `沪深300三窗口一致（单策略 ${(hs.consensus_exposure * 100).toFixed(1)}% × 有效预算 ${(effHsBudget * 100).toFixed(1)}%），本次${moveHs > 0 ? "加仓" : "减仓"} ${(Math.abs(moveHs) * 100).toFixed(1)} 个百分点。`
        : `沪深300方向${moveHs > 0 ? "偏多" : "偏空"}（试算${moveHs > 0 ? "+" : "-"}${(Math.abs(moveHs) * 100).toFixed(1)} 个百分点），但${!confirmed ? "收盘确认不足" : "当前非可执行盘中/复核窗口"}，仅作预演。`;
    }
  } else {
    if (Number.isFinite(hs.window_max) && curHs > effHsBudget * hs.window_max + deadband + 1e-9) {
      hsBandWarning = `提示：沪深300三窗口参考上限折合总池最高 ${(effHsBudget * hs.window_max * 100).toFixed(1)}%，当前持仓偏重。`;
    }
    if (curHs > maxHs + deadband + 1e-9) {
      targetHs = maxHs;
      moveHs = -Math.min(curHs - maxHs, maxStep);
      hsCanAct = Boolean(hs.can_decide);
      hsReason = `沪深300现仓超过单资产硬上限 ${(maxHs * 100).toFixed(0)}%，按风控先减 ${(Math.abs(moveHs) * 100).toFixed(1)} 个百分点。`;
    } else {
      hsReason = `沪深300三窗口分歧（HOLD），维持现仓不动。${hsBandWarning ? " " + hsBandWarning : ""}`;
    }
  }

  // ---- 2. H30269 sleeve decision in total pool ----
  let targetDiv = curDiv;
  let moveDiv = 0;
  let divReason = "";
  let divCanAct = false;
  const hCode = String(div.action_code || "hold");
  const divCapInPool = Math.min(maxDiv, effDivBudget * vt.h30269_heavy_line);
  const divCoreFloorInPool = baseDiv * vt.h30269_core_floor;

  if (div.blocked) {
    divReason = `红利低波数据受限（${(div.blockers || []).join("；")}），暂停自动调仓。`;
  } else if (hCode.startsWith("buy_")) {
    const reqAdd = (Number(div.execution?.pct || 12) / 100) * effDivBudget;
    targetDiv = Math.min(divCapInPool, curDiv + reqAdd);
    if (curDiv >= divCapInPool - 1e-9) {
      moveDiv = 0;
      divReason = `红利低波触发买入信号，但现仓已达当前有效预算重仓上限（${(divCapInPool * 100).toFixed(1)}%），不追买。`;
    } else {
      const addStep = Math.min(reqAdd, divCapInPool - curDiv, maxStep);
      if (addStep < 0.02 - 1e-9) {
        moveDiv = 0;
        divReason = `红利低波距离有效预算上限仅剩 ${(addStep * 100).toFixed(1)} 个百分点，暂不产生碎单。`;
      } else {
        moveDiv = addStep;
        divCanAct = Boolean(div.confirmed);
        divReason = `红利低波触发${div.decision}（有效预算 ${(effDivBudget * 100).toFixed(1)}%，补位系数 ${(divFactor * 100).toFixed(0)}%），本次加仓 ${(moveDiv * 100).toFixed(1)} 个百分点（建议同向间隔≥5日）。`;
      }
    }
  } else if (hCode === "reduce_core_review") {
    const reqCut = (Number(div.execution?.pct || 10) / 100) * effDivBudget;
    const availCut = Math.max(0, curDiv - divCoreFloorInPool);
    moveDiv = -Math.min(reqCut, availCut, maxStep);
    targetDiv = curDiv + moveDiv;
    divCanAct = Boolean(div.confirmed && moveDiv < 0);
    divReason = moveDiv < 0
      ? `红利低波触发核心仓降档复核，本次减仓 ${(Math.abs(moveDiv) * 100).toFixed(1)} 个百分点（保留 ${(divCoreFloorInPool * 100).toFixed(1)}% 总池底仓）。`
      : `红利低波已不高于底仓保护线（${(divCoreFloorInPool * 100).toFixed(1)}%），维持底仓不动。`;
  } else if (hCode.startsWith("reduce_tactical_") || hCode === "reduce_ready") {
    const reqCut = (Number(div.execution?.pct || div.execution?.planned_pct || 10) / 100) * effDivBudget;
    moveDiv = -Math.min(reqCut, curDiv, maxStep);
    targetDiv = curDiv + moveDiv;
    divCanAct = Boolean(div.confirmed && moveDiv < 0);
    divReason = moveDiv < 0
      ? `红利低波触发${div.decision}，建议按有效预算从红利战术仓减 ${(Math.abs(moveDiv) * 100).toFixed(1)} 个百分点（核心仓不动，不超过实际战术仓余额）。`
      : "红利低波当前无持仓可减。";
  } else if (hCode === "valuation_high_watch") {
    divReason = "红利低波 PE 处于高分位区（≥80%），停止补位与追买，现有底仓继续持有吃息（防误杀保护）。";
  } else if (curDiv > maxDiv + deadband + 1e-9) {
    targetDiv = maxDiv;
    moveDiv = -Math.min(curDiv - maxDiv, maxStep);
    divCanAct = true;
    divReason = `红利低波现仓超过单资产硬上限 ${(maxDiv * 100).toFixed(0)}%，按风控先减 ${(Math.abs(moveDiv) * 100).toFixed(1)} 个百分点。`;
  } else {
    divReason = `红利低波当前状态「${div.decision || "持有"}」，维持现有仓位（防误杀保护：估值波动不触发无谓卖出）。`;
  }

  // ---- 3. Total Equity Hard Cap (90%) & 10% Cash Buffer Enforcement ----
  let afterHs = curHs + moveHs;
  let afterDiv = curDiv + moveDiv;
  let capTrimmed = false;

  if (afterHs + afterDiv > maxTotal + 1e-9) {
    capTrimmed = true;
    const excess = afterHs + afterDiv - maxTotal;
    const posTotal = Math.max(0, moveHs) + Math.max(0, moveDiv);
    if (posTotal >= excess - 1e-9 && posTotal > 0) {
      const keepRatio = Math.max(0, (posTotal - excess) / posTotal);
      if (moveHs > 0) moveHs *= keepRatio;
      if (moveDiv > 0) moveDiv *= keepRatio;
      afterHs = curHs + moveHs;
      afterDiv = curDiv + moveDiv;
    } else {
      // Cancel all positive buys first; if still above maxTotal + deadband, trim overweight proportionally
      if (moveHs > 0) moveHs = 0;
      if (moveDiv > 0) moveDiv = 0;
      afterHs = curHs + moveHs;
      afterDiv = curDiv + moveDiv;
      if (afterHs + afterDiv > maxTotal + deadband + 1e-9) {
        const remExcess = Math.min(afterHs + afterDiv - maxTotal, maxStep);
        const totEq = afterHs + afterDiv;
        const cutHs = remExcess * (afterHs / totEq);
        const cutDiv = remExcess * (afterDiv / totEq);
        moveHs -= cutHs;
        moveDiv -= cutDiv;
        afterHs = curHs + moveHs;
        afterDiv = curDiv + moveDiv;
      }
    }
  }

  moveHs = cleanZero(moveHs);
  moveDiv = cleanZero(moveDiv);
  afterHs = clamp(curHs + moveHs, 0, 1);
  afterDiv = clamp(curDiv + moveDiv, 0, 1);
  const afterCash = Math.max(0, 1 - afterHs - afterDiv);
  const netMove = cleanZero(moveHs + moveDiv);

  // ---- 4. Cross-sleeve funding flow guidance ----
  let crossFunded = 0;
  let fundingText = "本次无需跨池划转资金，继续保持双资产与现金缓冲。";
  if ((moveHs > 0 && moveDiv < 0) || (moveHs < 0 && moveDiv > 0)) {
    const buyAmt = moveHs > 0 ? moveHs : moveDiv;
    const sellAmt = Math.abs(moveHs < 0 ? moveHs : moveDiv);
    crossFunded = Math.min(buyAmt, sellAmt);
    const seller = moveHs < 0 ? "沪深300" : "红利低波";
    const buyer = moveHs > 0 ? "沪深300" : "红利低波";
    const cashPart = cleanZero(buyAmt - sellAmt);
    const crossMoney = capital === null ? "" : `（约 ${(capital * crossFunded).toLocaleString("zh-CN", { maximumFractionDigits: 0 })} 元）`;
    fundingText = `跨资产资金对冲：可直接将${seller}减仓回笼的 ${(crossFunded * 100).toFixed(1)}%${crossMoney} 转入${buyer}加仓${cashPart > 0 ? `，差额 ${(cashPart * 100).toFixed(1)}% 由现金池补足` : cashPart < 0 ? `，剩余 ${(Math.abs(cashPart) * 100).toFixed(1)}% 回流现金缓冲池` : ""}。`;
  } else if (netMove > 0) {
    fundingText = `资金来源：从权益预留现金池动用 ${(netMove * 100).toFixed(1)}%${capital === null ? "" : `（约 ${(capital * netMove).toLocaleString("zh-CN", { maximumFractionDigits: 0 })} 元）`}，调整后仍保留 ${(afterCash * 100).toFixed(1)}% 现金缓冲。`;
  } else if (netMove < 0) {
    fundingText = `资金去向：减仓回笼 ${(Math.abs(netMove) * 100).toFixed(1)}%${capital === null ? "" : `（约 ${(capital * Math.abs(netMove)).toLocaleString("zh-CN", { maximumFractionDigits: 0 })} 元）`} 进入权益现金池，现金缓冲升至 ${(afterCash * 100).toFixed(1)}%。`;
  }

  const reasons = [];
  if (capTrimmed) reasons.push(`已触发总权益 ${(maxTotal * 100).toFixed(0)}% 硬封顶（保留 ${(cfg.min_cash_buffer * 100).toFixed(0)}% 现金底线）`);
  if (hsBandWarning) reasons.push(hsBandWarning);

  return {
    valid: true,
    capital,
    current: { hs300: curHs, h30269: curDiv, equity: curHs + curDiv, cash: curCash },
    targets: { hs300: targetHs, h30269: targetDiv },
    moves: { hs300: moveHs, h30269: moveDiv, net: netMove, crossFunded },
    after: { hs300: afterHs, h30269: afterDiv, equity: afterHs + afterDiv, cash: afterCash },
    amounts: capital === null ? null : {
      curHs: capital * curHs,
      curDiv: capital * curDiv,
      curCash: capital * curCash,
      moveHs: capital * moveHs,
      moveDiv: capital * moveDiv,
      afterHs: capital * afterHs,
      afterDiv: capital * afterDiv,
      afterCash: capital * afterCash,
      crossFunded: capital * crossFunded,
    },
    budgets: {
      baseHs, baseDiv, maxHs, maxDiv, maxTotal,
      effHs: effHsBudget, effDiv: effDivBudget,
      idleHs, idleDiv,
    },
    factors: { hs300: hsFactor, h30269: divFactor },
    sleeveReasons: { hs300: hsReason, h30269: divReason },
    hsCanAct,
    divCanAct,
    canAct: (moveHs !== 0 && hsCanAct) || (moveDiv !== 0 && divCanAct),
    capTrimmed,
    fundingText,
    reasons,
  };
}
