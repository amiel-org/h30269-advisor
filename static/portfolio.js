import { calculatePortfolioPosition } from "/static/portfolio-position.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const num = (v, d = 2) => Number.isFinite(Number(v))
  ? Number(v).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d })
  : "--";
const pct = (v, d = 1) => Number.isFinite(Number(v)) ? `${num(v, d)}%` : "--";
const signedPct = (v, d = 1) => Number.isFinite(Number(v)) ? `${Number(v) > 0 ? "+" : ""}${num(v, d)}%` : "--";
const money = (v) => Number.isFinite(Number(v)) ? `${num(v, 0)} 元` : "--";

let lastData = null;
let busy = false;
let inputMode = "amount"; // default: direct RMB amount entry (much easier than mental %)

try {
  const savedMode = localStorage.getItem("portfolio.inputMode");
  if (savedMode === "percent" || savedMode === "amount") inputMode = savedMode;
  for (const [id, key] of [
    ["pfHsInput", "portfolio.hs300"],
    ["pfDivInput", "portfolio.h30269"],
    ["pfBudgetInput", "portfolio.budget"],
    ["pfHsAmtInput", "portfolio.hs300Amt"],
    ["pfDivAmtInput", "portfolio.h30269Amt"],
    ["pfCashAmtInput", "portfolio.cashAmt"],
  ]) {
    const saved = localStorage.getItem(key);
    if (saved !== null) $(`#${id}`).value = saved;
  }
  // If user previously only saved percentages (from older version), switch to percent mode automatically
  const hasAmt = $("#pfHsAmtInput").value || $("#pfDivAmtInput").value || $("#pfCashAmtInput").value;
  const hasPct = $("#pfHsInput").value || $("#pfDivInput").value;
  if (!hasAmt && hasPct && !savedMode) inputMode = "percent";
} catch {}

function applyInputMode(mode) {
  inputMode = mode;
  try { localStorage.setItem("portfolio.inputMode", mode); } catch {}
  $$("[data-input-mode]").forEach((btn) => btn.classList.toggle("active", btn.dataset.inputMode === mode));
  $("#amountInputs").hidden = mode !== "amount";
  $("#percentInputs").hidden = mode !== "percent";
}

function showError(msg) {
  $("#errorBanner").hidden = false;
  $("#errorBanner").textContent = msg;
}

function setSegment(selector, ratio) {
  const el = $(selector);
  if (!el) return;
  const p = Math.max(0, Math.min(100, ratio * 100));
  el.style.width = `${p}%`;
  el.textContent = p >= 11 ? `${p.toFixed(0)}%` : "";
}

function resolveInputs() {
  if (inputMode === "percent") {
    return {
      hsPct: $("#pfHsInput").value,
      divPct: $("#pfDivInput").value,
      budget: $("#pfBudgetInput").value,
    };
  }
  const hsRaw = $("#pfHsAmtInput").value.trim();
  const divRaw = $("#pfDivAmtInput").value.trim();
  const cashRaw = $("#pfCashAmtInput").value.trim();
  if (!hsRaw && !divRaw && !cashRaw) {
    return { hsPct: "", divPct: "", budget: "" };
  }
  const hsAmt = hsRaw ? Number(hsRaw) : 0;
  const divAmt = divRaw ? Number(divRaw) : 0;
  const cashAmt = cashRaw ? Number(cashRaw) : 0;
  if (![hsAmt, divAmt, cashAmt].every((v) => Number.isFinite(v) && v >= 0)) {
    return { hsPct: "-1", divPct: "0", budget: "" };
  }
  const total = hsAmt + divAmt + cashAmt;
  if (!(total > 0)) {
    return { hsPct: "", divPct: "", budget: "", emptyZero: true };
  }
  return {
    hsPct: ((hsAmt / total) * 100).toFixed(4),
    divPct: ((divAmt / total) * 100).toFixed(4),
    budget: String(total),
  };
}

function updateHeroUnfilled(data) {
  const hs = data.sleeves?.hs300 || {};
  const div = data.sleeves?.h30269 || {};
  const hsBuy = hs.agreed && hs.consensus_exposure >= 0.5;
  const divBuy = String(div.action_code || "").startsWith("buy_");
  const divSell = String(div.action_code || "").startsWith("reduce_");

  let title = "今天先按兵不动，拿住现金等机会";
  let tone = "wait";
  if (hsBuy && divBuy) {
    title = "双侧均出现低估机会，建议分批加仓";
    tone = "buy";
  } else if (hsBuy) {
    title = "沪深300达成加仓共识，红利低波暂不追买";
    tone = "buy";
  } else if (divBuy) {
    title = "红利低波出现买点，沪深300维持观望";
    tone = "buy";
  } else if (divSell) {
    title = "今天不追买；沪深300不动，红利低波可小幅落袋战术仓";
    tone = "sell";
  }

  $("#actionHero").className = `hero-card tone-${tone}`;
  $("#heroEyebrow").textContent = "今日总池大方向（在右侧填入实际持仓后，会精确算出买卖金额）";
  $("#heroTitle").textContent = title;
  $("#heroSubtitle").textContent = `${data.regime?.title || ""}：${data.regime?.summary || ""}`;

  $("#heroHsAction").textContent = hs.agreed ? `三窗口统一目标 ${pct(hs.consensus_exposure * 100)}` : "暂不调仓（维持现仓）";
  $("#heroHsReason").textContent = hs.agreed ? `PE分位 ${pct(hs.pe_percentile)}，按单次最多 10% 步长靠近目标` : `三窗口存在分歧（${pct((hs.window_min ?? 0) * 100)}~${pct((hs.window_max ?? 0) * 100)}）`;

  $("#heroDivAction").textContent = div.decision || "持有观察";
  $("#heroDivReason").textContent = `全收益40日Beta差 ${signedPct(div.beta_adjusted_spread_pct, 2)} · PE分位 ${pct(div.pe_percentile)}`;

  $("#heroCashAction").textContent = "填入右侧金额后自动计算";
  $("#heroCashReason").textContent = "点击右侧「示例」按钮可 1 秒体验完整操作清单";
  const fb = $("#fundingBox");
  if (fb) {
    fb.className = "pf-funding-strip";
    fb.textContent = "填入右侧持仓后，这里会告诉你资金该从现金池出、还是直接用减仓回笼资金对冲。";
  }
}

function updateHeroFilled(plan) {
  const hsM = plan.moves.hs300;
  const divM = plan.moves.h30269;
  const anyMove = hsM !== 0 || divM !== 0;

  let title = "按你的实际持仓：今天保持不动，无需下单";
  let tone = "wait";
  if (anyMove) {
    const parts = [];
    if (hsM > 0) parts.push(`沪深300加仓 ${pct(hsM * 100)}${plan.amounts ? `（约 ${money(plan.amounts.moveHs)}）` : ""}`);
    if (hsM < 0) parts.push(`沪深300减仓 ${pct(Math.abs(hsM) * 100)}${plan.amounts ? `（约 ${money(Math.abs(plan.amounts.moveHs))}）` : ""}`);
    if (divM > 0) parts.push(`红利低波加仓 ${pct(divM * 100)}${plan.amounts ? `（约 ${money(plan.amounts.moveDiv)}）` : ""}`);
    if (divM < 0) parts.push(`红利低波减仓 ${pct(Math.abs(divM) * 100)}${plan.amounts ? `（约 ${money(Math.abs(plan.amounts.moveDiv))}）` : ""}`);
    title = `${plan.canAct ? "今日操作：" : "今日预演（暂不下单）："}${parts.join("；")}`;
    tone = plan.moves.net > 0 ? "buy" : plan.moves.net < 0 ? "sell" : "warn";
  }

  $("#actionHero").className = `hero-card tone-${tone}`;
  $("#heroEyebrow").textContent = plan.capital !== null
    ? `你的今日专属操作清单 · 权益总资金池 ${money(plan.capital)}`
    : "你的今日专属操作清单（按比例测算）";
  $("#heroTitle").textContent = title;
  $("#heroSubtitle").textContent = `当前总权益 ${pct(plan.current.equity * 100)} / 现金 ${pct(plan.current.cash * 100)} → 调整后总权益 ${pct(plan.after.equity * 100)} / 现金 ${pct(plan.after.cash * 100)}`;

  const fmtHero = (m, amt, canAct) => {
    if (m === 0) return "保持不动（0 元）";
    const act = m > 0 ? `买入 +${pct(m * 100)}` : `卖出 ${pct(m * 100)}`;
    const cash = amt !== null ? ` · 约 ${money(Math.abs(amt))}` : "";
    return `${act}${cash}${canAct ? "" : "（预演）"}`;
  };
  $("#heroHsAction").textContent = fmtHero(hsM, plan.amounts ? plan.amounts.moveHs : null, plan.hsCanAct);
  $("#heroHsReason").textContent = plan.sleeveReasons.hs300;
  $("#heroDivAction").textContent = fmtHero(divM, plan.amounts ? plan.amounts.moveDiv : null, plan.divCanAct);
  $("#heroDivReason").textContent = plan.sleeveReasons.h30269;
  $("#heroCashAction").textContent = plan.amounts
    ? `调整后留存 ${pct(plan.after.cash * 100)}（约 ${money(plan.amounts.afterCash)}）`
    : `调整后留存 ${pct(plan.after.cash * 100)}`;
  $("#heroCashReason").textContent = plan.moves.crossFunded > 0
    ? `含跨资产直接对冲 ${pct(plan.moves.crossFunded * 100)}，无需额外掏现金`
    : plan.moves.net === 0 ? "现金比例无变化，安心拿稳底线" : "已自动守住 ≥10% 现金安全垫";
}

function renderCalculator() {
  if (!lastData) return;
  const resolved = resolveInputs();
  const badge = $("#planBadge");
  if (resolved.emptyZero) {
    $("#calcResults").hidden = true;
    if ($("#planBreakdownCard")) $("#planBreakdownCard").hidden = true;
    $("#calcMessage").textContent = "三项金额合计需大于 0；如果还没建仓，只在「可用现金」里填入准备投入的总金额即可。";
    badge.className = "pf-pill";
    badge.textContent = "等待填写";
    updateHeroUnfilled(lastData);
    return;
  }
  const plan = calculatePortfolioPosition(lastData, resolved.hsPct, resolved.divPct, resolved.budget);
  if (!plan.valid) {
    $("#calcResults").hidden = true;
    if ($("#planBreakdownCard")) $("#planBreakdownCard").hidden = true;
    $("#calcMessage").textContent = inputMode === "amount"
      ? "只填专门投这两只指数的钱与现金（没有持仓的格子可填 0 或留空），或点上方「示例」一键体验。"
      : plan.reason;
    badge.className = "pf-pill";
    badge.textContent = "等待填写";
    updateHeroUnfilled(lastData);
    return;
  }

  $("#calcResults").hidden = false;
  if ($("#planBreakdownCard")) $("#planBreakdownCard").hidden = false;
  $("#calcMessage").textContent = plan.reasons.length
    ? plan.reasons.join("；")
    : "已按 50/50 基础预算 + 50% 平滑补位 + 5% 死区实时测算；单次单侧最多调整 10 个百分点。";

  const hasMove = plan.moves.hs300 !== 0 || plan.moves.h30269 !== 0;
  badge.className = `pf-pill ${plan.canAct ? (plan.moves.net >= 0 ? "buy" : "sell") : hasMove ? "warn" : ""}`;
  badge.textContent = plan.canAct ? "可执行方案" : hasMove ? "预演参考" : "维持现仓";

  updateHeroFilled(plan);

  if ($("#kpiNetMove")) {
    $("#kpiNetMove").textContent = plan.moves.net === 0
      ? "净变动 0%（不动）"
      : `${plan.moves.net > 0 ? "净投入 +" : "净回笼 -"}${pct(Math.abs(plan.moves.net) * 100)}`;
  }

  $("#curMixText").textContent = `300 ${pct(plan.current.hs300 * 100)} · 红利 ${pct(plan.current.h30269 * 100)} · 现金 ${pct(plan.current.cash * 100)}`;
  $("#afterMixText").textContent = `300 ${pct(plan.after.hs300 * 100)} · 红利 ${pct(plan.after.h30269 * 100)} · 现金 ${pct(plan.after.cash * 100)}`;
  setSegment("#curBarHs", plan.current.hs300);
  setSegment("#curBarDiv", plan.current.h30269);
  setSegment("#curBarCash", plan.current.cash);
  setSegment("#afterBarHs", plan.after.hs300);
  setSegment("#afterBarDiv", plan.after.h30269);
  setSegment("#afterBarCash", plan.after.cash);

  const funding = $("#fundingBox");
  if (funding) {
    funding.textContent = plan.fundingText;
    funding.className = `pf-funding-strip${plan.moves.crossFunded > 0 ? " highlight" : ""}`;
  }

  const moveChip = (m, canAct) => {
    const span = document.createElement("span");
    if (m === 0) {
      span.className = "pf-move-chip hold";
      span.textContent = "维持不动";
      return span;
    }
    span.className = `pf-move-chip ${m > 0 ? "buy" : "sell"}`;
    const base = m > 0 ? `加仓 +${pct(m * 100)}` : `减仓 ${pct(m * 100)}`;
    span.textContent = canAct ? base : `${base}（预演）`;
    return span;
  };
  const fmtMoneyMove = (amt) => {
    if (plan.amounts === null) return "未填金额";
    if (Math.abs(amt) < 1) return "0 元";
    return `${amt > 0 ? "买入约 " : "卖出约 "}${money(Math.abs(amt))}`;
  };

  const rows = [
    {
      name: "沪深300（宽基进攻）",
      cur: pct(plan.current.hs300 * 100),
      budget: pct(plan.budgets.effHs * 100),
      moveNode: moveChip(plan.moves.hs300, plan.hsCanAct),
      after: pct(plan.after.hs300 * 100),
      amt: fmtMoneyMove(plan.amounts?.moveHs),
    },
    {
      name: "红利低波（价值压舱）",
      cur: pct(plan.current.h30269 * 100),
      budget: pct(plan.budgets.effDiv * 100),
      moveNode: moveChip(plan.moves.h30269, plan.divCanAct),
      after: pct(plan.after.h30269 * 100),
      amt: fmtMoneyMove(plan.amounts?.moveDiv),
    },
    {
      name: "权益预留现金",
      cur: pct(plan.current.cash * 100),
      budget: "底线 ≥10.0%",
      moveText: plan.moves.net === 0 ? "无变动" : plan.moves.net > 0 ? `动用 ${pct(plan.moves.net * 100)}` : `回笼 +${pct(Math.abs(plan.moves.net) * 100)}`,
      after: pct(plan.after.cash * 100),
      amt: plan.amounts === null ? "未填金额" : `剩余约 ${money(plan.amounts.afterCash)}`,
    },
  ];
  $("#planRows").replaceChildren(...rows.map((r) => {
    const tr = document.createElement("tr");
    const cells = [r.name, r.cur, r.budget, null, r.after, r.amt];
    cells.forEach((val, idx) => {
      const td = document.createElement("td");
      if (idx === 3) {
        if (r.moveNode) td.append(r.moveNode);
        else td.textContent = r.moveText;
      } else {
        td.textContent = val;
      }
      tr.append(td);
    });
    return tr;
  }));
  $("#sleeveDetailNotes").textContent = `① ${plan.sleeveReasons.hs300}  ② ${plan.sleeveReasons.h30269}`;
}

function fmtTradeFreq(trades, years) {
  if (!Number.isFinite(trades)) return "--";
  if (trades === 0) return "0 次（买入持有）";
  const perYear = trades / Math.max(1, years);
  return `约 ${num(perYear, 1)} 次/年（共 ${trades} 次）`;
}

function renderBacktest(bt) {
  if (!bt?.sample) return;
  const s = bt.sample;
  const d0 = Date.parse(`${s.start.slice(0, 4)}-${s.start.slice(4, 6)}-${s.start.slice(6, 8)}T00:00:00Z`);
  const d1 = Date.parse(`${s.end.slice(0, 4)}-${s.end.slice(4, 6)}-${s.end.slice(6, 8)}T00:00:00Z`);
  const years = (d1 - d0) / (365.25 * 86400000);

  $("#corrStrip").innerHTML = [
    `<span>回测跨度：<strong>${num(years, 1)} 年</strong>（${s.start} → ${s.end}）</span>`,
    `<span>两套策略仓位相关性：<strong>${num(s.standalone_exposure_correlation, 3)}</strong>（牛熊天然互补）</span>`,
    `<span>两指数日收益相关性：<strong>${num(s.daily_return_correlation, 3)}</strong></span>`,
  ].join("");

  const silo50Cagr = bt.siloed_50_50_core50?.full?.cagr_calendar_pct ?? null;
  const silo00Cagr = bt.siloed_50_50_cash0?.full?.cagr_calendar_pct ?? null;

  // 1. Clean 4-row primary summary table (concise labels -> zero horizontal overflow!)
  const coreList = [
    ["★ 统一总资金池 v1.0（推荐）", bt.unified_v1_core50, true, silo50Cagr],
    ["分池各管各的（50/50 不互通）", bt.siloed_50_50_core50, false, null],
    ["只用沪深300单策略", bt.standalone_hs300_v25, false, null],
    ["只用红利低波单策略", bt.standalone_h30269_v32, false, null],
  ].filter(([, row]) => Boolean(row?.full));

  $("#coreBacktestRows").replaceChildren(...coreList.map(([label, row, featured, baseCagr]) => {
    const tr = document.createElement("tr");
    if (featured) tr.className = "featured";
    const delta = baseCagr !== null ? row.full.cagr_calendar_pct - baseCagr : null;
    const cells = [
      label,
      pct(row.full.cagr_calendar_pct, 2),
      pct(row.full.max_drawdown_pct, 2),
      `${num(row.full.calmar, 2)} / ${num(row.full.sharpe, 2)}`,
      `${pct(row.pre_2022.cagr_calendar_pct, 2)} / ${pct(row.post_2022.cagr_calendar_pct, 2)}`,
      fmtTradeFreq(row.trades, years),
    ];
    cells.forEach((text, idx) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (idx === 1 && delta !== null && delta > 0) {
        const tag = document.createElement("span");
        tag.className = "pf-delta-tag";
        tag.textContent = `比分池 +${num(delta, 2)}%/年`;
        td.append(tag);
      }
      tr.append(td);
    });
    return tr;
  }));

  // 2. Full 9-row table tucked neatly inside collapsible details
  const fullList = [
    ["★ 统一总资金池 v1.0（初始50%红利底仓）", bt.unified_v1_core50, true, silo50Cagr],
    ["分池独立 50/50（初始50%红利底仓对照）", bt.siloed_50_50_core50, false, null],
    ["★ 统一总资金池 v1.0（初始0%纯现金起步）", bt.unified_v1_cash0, true, silo00Cagr],
    ["分池独立 50/50（初始0%纯现金起步对照）", bt.siloed_50_50_cash0, false, null],
    ["单策略：沪深300 v2.5（100%单池）", bt.standalone_hs300_v25, false, null],
    ["单策略：红利低波 V3.2（100%单池）", bt.standalone_h30269_v32, false, null],
    ["被动基准：50/50 静态再平衡（5%阈值）", bt.passive_50_50_rebalanced, false, null],
    ["被动基准：100% 沪深300全收益", bt.passive_100_hs300, false, null],
    ["被动基准：100% 红利低波全收益", bt.passive_100_h30269, false, null],
  ].filter(([, row]) => Boolean(row?.full));

  $("#fullBacktestRows").replaceChildren(...fullList.map(([label, row, featured, baseCagr]) => {
    const tr = document.createElement("tr");
    if (featured) tr.className = "featured";
    const delta = baseCagr !== null ? row.full.cagr_calendar_pct - baseCagr : null;
    const cells = [
      label,
      pct(row.full.cagr_calendar_pct, 2),
      pct(row.full.max_drawdown_pct, 2),
      num(row.full.sharpe, 3),
      num(row.full.calmar, 2),
      `${pct(row.pre_2022.cagr_calendar_pct, 2)} / ${pct(row.post_2022.cagr_calendar_pct, 2)}`,
      `${num(row.avg_hs300_pct, 1)} / ${num(row.avg_h30269_pct, 1)} / ${num(row.avg_total_equity_pct, 1)}%`,
      fmtTradeFreq(row.trades, years),
    ];
    cells.forEach((text, idx) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (idx === 1 && delta !== null && delta > 0) {
        const tag = document.createElement("span");
        tag.className = "pf-delta-tag";
        tag.textContent = `+${num(delta, 2)}pp`;
        td.append(tag);
      }
      tr.append(td);
    });
    return tr;
  }));
}

function render(data) {
  lastData = data;
  const ref = data.reference_allocation || {};
  const hs = data.sleeves?.hs300 || {};
  const div = data.sleeves?.h30269 || {};
  const reg = data.regime || {};

  $("#asOfText").textContent = `${div.as_of || hs.as_of || "--"} · 组合 ${data.version}`;
  $("#topRegime").textContent = reg.title || "--";
  if ($("#topTotalEq")) $("#topTotalEq").textContent = `${pct((ref.total_equity ?? 0) * 100)} / 现 ${pct((ref.cash_target ?? 0) * 100)}`;
  if ($("#topHsBudget")) $("#topHsBudget").textContent = `${pct((ref.eff_hs300_budget ?? 0.5) * 100)}（上限 65%）`;
  if ($("#topDivBudget")) $("#topDivBudget").textContent = `${pct((ref.eff_h30269_budget ?? 0.5) * 100)}（上限 70%）`;
  $("#regimeMeta").textContent = `双引擎同步于 ${(data.generated_at || "").replace("T", " ")}`;

  $("#hsMetricPe").textContent = `${num(hs.price, 1)} / ${pct(hs.pe_percentile)}`;
  $("#hsMetricTarget").textContent = hs.agreed ? pct(hs.consensus_exposure * 100) : "分歧（HOLD）";
  $("#hsMetricErp").textContent = `${pct(hs.erp, 2)} / ${pct(hs.erp_percentile)}`;
  if ($("#hsMetricStatus")) $("#hsMetricStatus").textContent = hs.available ? (hs.can_decide ? "可执行" : "收盘参考") : "数据待恢复";
  $("#hsMetricFactor").textContent = pct((ref.hs300_factor ?? 0) * 100, 0);
  $("#hsFactorBar").style.width = `${(ref.hs300_factor ?? 0) * 100}%`;
  $("#hsSleeveNote").textContent = hs.available
    ? `基准日 ${hs.as_of || "--"} ${hs.time || ""} · ${hs.reason || "历史基准已通过校验"}。`
    : `数据暂不可用：${hs.reason || "请稍后刷新"}。`;

  $("#divMetricSpread").textContent = `${signedPct(div.beta_adjusted_spread_pct, 2)}（${div.relative_zone || "--"}）`;
  $("#divMetricDecision").textContent = div.decision || "--";
  $("#divMetricVal").textContent = `${pct(div.pe_percentile)} / ${div.bond_support || "--"}`;
  if ($("#divMetricYield")) $("#divMetricYield").textContent = `${pct(div.dividend_yield_pct, 2)} / ${pct(div.bond10_pct, 2)}`;
  $("#divMetricFactor").textContent = pct((ref.h30269_factor ?? 0) * 100, 0);
  $("#divFactorBar").style.width = `${(ref.h30269_factor ?? 0) * 100}%`;
  $("#divSleeveNote").textContent = div.blocked
    ? `数据阻断：${(div.blockers || []).join("；")}`
    : `交易日 ${div.as_of || "--"} · ${div.reason || ""}`;

  renderBacktest(data.backtest);
  $("#disclosuresText").textContent = (data.disclosures || []).join(" ");
  renderCalculator();
  if (window.lucide) lucide.createIcons();
}

async function load(force = false) {
  if (busy) return;
  busy = true;
  $("#refreshButton").disabled = true;
  $("#refreshButton").textContent = "刷新中…";
  $("#errorBanner").hidden = true;
  try {
    const resp = await fetch(force ? "/api/portfolio/refresh" : "/api/portfolio/dashboard", {
      method: force ? "POST" : "GET",
      cache: "no-store",
    });
    const body = await resp.json();
    if (!resp.ok || !body.ok) throw new Error(body.error || `HTTP ${resp.status}`);
    render(body.data);
  } catch (err) {
    showError(`双资产组合数据加载失败：${err.message}`);
  } finally {
    busy = false;
    $("#refreshButton").disabled = false;
    $("#refreshButton").textContent = "刷新双引擎";
  }
}

$("#refreshButton").addEventListener("click", () => load(true));

$$("[data-input-mode]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetMode = btn.dataset.inputMode;
    if (targetMode === inputMode) return;
    // Sync values across modes when switching so user never loses typed numbers
    if (targetMode === "percent") {
      const r = resolveInputs();
      if (r.hsPct && r.divPct && Number(r.hsPct) >= 0) {
        $("#pfHsInput").value = Number(r.hsPct).toFixed(1);
        $("#pfDivInput").value = Number(r.divPct).toFixed(1);
        if (r.budget) $("#pfBudgetInput").value = r.budget;
      }
    } else {
      const cap = Number($("#pfBudgetInput").value);
      const hp = Number($("#pfHsInput").value);
      const dp = Number($("#pfDivInput").value);
      if (cap > 0 && Number.isFinite(hp) && Number.isFinite(dp) && hp + dp <= 100) {
        $("#pfHsAmtInput").value = String(Math.round((cap * hp) / 100));
        $("#pfDivAmtInput").value = String(Math.round((cap * dp) / 100));
        $("#pfCashAmtInput").value = String(Math.max(0, Math.round((cap * (100 - hp - dp)) / 100)));
      }
    }
    applyInputMode(targetMode);
    renderCalculator();
  });
});

for (const [id, key] of [
  ["pfHsInput", "portfolio.hs300"],
  ["pfDivInput", "portfolio.h30269"],
  ["pfBudgetInput", "portfolio.budget"],
  ["pfHsAmtInput", "portfolio.hs300Amt"],
  ["pfDivAmtInput", "portfolio.h30269Amt"],
  ["pfCashAmtInput", "portfolio.cashAmt"],
]) {
  $(`#${id}`).addEventListener("input", () => {
    try { localStorage.setItem(key, $(`#${id}`).value); } catch {}
    renderCalculator();
  });
}

$$(".pf-preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const [hA, dA, cA] = String(btn.dataset.presetAmt || ",,").split(",");
    const [hP, dP, bP] = String(btn.dataset.presetPct || ",,").split(",");
    $("#pfHsAmtInput").value = hA;
    $("#pfDivAmtInput").value = dA;
    $("#pfCashAmtInput").value = cA;
    $("#pfHsInput").value = hP;
    $("#pfDivInput").value = dP;
    $("#pfBudgetInput").value = bP;
    try {
      localStorage.setItem("portfolio.hs300Amt", hA);
      localStorage.setItem("portfolio.h30269Amt", dA);
      localStorage.setItem("portfolio.cashAmt", cA);
      localStorage.setItem("portfolio.hs300", hP);
      localStorage.setItem("portfolio.h30269", dP);
      localStorage.setItem("portfolio.budget", bP);
    } catch {}
    renderCalculator();
  });
});

applyInputMode(inputMode);
load(false);
if (window.lucide) lucide.createIcons();
