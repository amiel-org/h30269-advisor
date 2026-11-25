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

for (const [id, key] of [["pfHsInput", "portfolio.hs300"], ["pfDivInput", "portfolio.h30269"], ["pfBudgetInput", "portfolio.budget"]]) {
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) $(`#${id}`).value = saved;
  } catch {}
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

function renderCalculator() {
  if (!lastData) return;
  const plan = calculatePortfolioPosition(
    lastData,
    $("#pfHsInput").value,
    $("#pfDivInput").value,
    $("#pfBudgetInput").value,
  );
  const badge = $("#planBadge");
  if (!plan.valid) {
    $("#calcResults").hidden = true;
    $("#calcMessage").textContent = plan.reason;
    badge.className = "pf-pill";
    badge.textContent = "等待填写";
    return;
  }
  $("#calcResults").hidden = false;
  $("#calcMessage").textContent = plan.reasons.length
    ? plan.reasons.join("；")
    : "已按 50/50 基础预算 + 50% 平滑估值补位 + 5% 死区完成测算；单次单侧最多调整 10 个百分点。";

  const hasMove = plan.moves.hs300 !== 0 || plan.moves.h30269 !== 0;
  badge.className = `pf-pill ${plan.canAct ? (plan.moves.net >= 0 ? "buy" : "sell") : hasMove ? "warn" : ""}`;
  badge.textContent = plan.canAct ? "可执行方案" : hasMove ? "预演参考" : "维持现仓";

  $("#kpiCurEq").textContent = `${pct(plan.current.equity * 100)} / 现 ${pct(plan.current.cash * 100)}`;
  $("#kpiCurAmt").textContent = plan.amounts
    ? `权益 ${money(plan.amounts.curHs + plan.amounts.curDiv)} · 现金 ${money(plan.amounts.curCash)}`
    : "留空金额时仅展示比例";
  $("#kpiAfterEq").textContent = `${pct(plan.after.equity * 100)} / 现 ${pct(plan.after.cash * 100)}`;
  $("#kpiAfterAmt").textContent = plan.amounts
    ? `权益 ${money(plan.amounts.afterHs + plan.amounts.afterDiv)} · 现金 ${money(plan.amounts.afterCash)}`
    : "总权益上限 90%，现金底线 ≥10%";
  $("#kpiNetMove").textContent = plan.moves.net === 0
    ? "0.0 个百分点"
    : `${plan.moves.net > 0 ? "净投入 +" : "净回笼 -"}${pct(Math.abs(plan.moves.net) * 100)}`;
  $("#kpiCrossNote").textContent = plan.moves.crossFunded > 0
    ? `含跨资产直接对冲 ${pct(plan.moves.crossFunded * 100)}`
    : plan.moves.net === 0 ? "双侧均在死区或保护区内" : "单向现金池划转";

  $("#curMixText").textContent = `沪深300 ${pct(plan.current.hs300 * 100)} · 红利低波 ${pct(plan.current.h30269 * 100)} · 现金 ${pct(plan.current.cash * 100)}`;
  $("#afterMixText").textContent = `沪深300 ${pct(plan.after.hs300 * 100)} · 红利低波 ${pct(plan.after.h30269 * 100)} · 现金 ${pct(plan.after.cash * 100)}`;
  setSegment("#curBarHs", plan.current.hs300);
  setSegment("#curBarDiv", plan.current.h30269);
  setSegment("#curBarCash", plan.current.cash);
  setSegment("#afterBarHs", plan.after.hs300);
  setSegment("#afterBarDiv", plan.after.h30269);
  setSegment("#afterBarCash", plan.after.cash);

  const funding = $("#fundingBox");
  funding.textContent = plan.fundingText;
  funding.className = `pf-funding${plan.moves.crossFunded > 0 ? " highlight" : ""}`;

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

function renderBacktest(bt) {
  if (!bt?.sample) return;
  const s = bt.sample;
  $("#corrStrip").innerHTML = [
    `<span>双指数日收益相关性：<strong>${num(s.daily_return_correlation, 3)}</strong></span>`,
    `<span>双策略独立仓位相关性：<strong>${num(s.standalone_exposure_correlation, 3)}</strong>（牛熊高度互补）</span>`,
    `<span>样本区间：<strong>${s.start} → ${s.end}</strong>（${s.trading_days} 个交易日）</span>`,
  ].join("");

  const silo50Cagr = bt.siloed_50_50_core50?.full?.cagr_calendar_pct ?? null;
  const silo00Cagr = bt.siloed_50_50_cash0?.full?.cagr_calendar_pct ?? null;

  const list = [
    ["★ 统一总资金池 v1.0（初始50%红利底仓）", bt.unified_v1_core50, true, silo50Cagr],
    ["分池独立 50/50（不共享现金对照）", bt.siloed_50_50_core50, false, null],
    ["★ 统一总资金池 v1.0（初始0%纯现金起步）", bt.unified_v1_cash0, true, silo00Cagr],
    ["分池独立 50/50（初始0%纯现金起步）", bt.siloed_50_50_cash0, false, null],
    ["单策略：沪深300 v2.5（100%单池）", bt.standalone_hs300_v25, false, null],
    ["单策略：红利低波 V3.2（100%单池）", bt.standalone_h30269_v32, false, null],
    ["被动基准：50/50 静态再平衡（5%阈值）", bt.passive_50_50_rebalanced, false, null],
    ["被动基准：100% 沪深300全收益", bt.passive_100_hs300, false, null],
    ["被动基准：100% 红利低波全收益", bt.passive_100_h30269, false, null],
  ].filter(([, row]) => Boolean(row?.full));

  $("#backtestRows").replaceChildren(...list.map(([label, row, featured, baseCagr]) => {
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
      `${row.trades} 次`,
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
  $("#topTotalEq").textContent = `${pct((ref.total_equity ?? 0) * 100)} / 现 ${pct((ref.cash_target ?? 0) * 100)}`;
  $("#topHsBudget").textContent = `${pct((ref.eff_hs300_budget ?? 0.5) * 100)}（上限 65%）`;
  $("#topDivBudget").textContent = `${pct((ref.eff_h30269_budget ?? 0.5) * 100)}（上限 70%）`;

  const banner = $("#regimeBanner");
  banner.className = `pf-regime-banner ${reg.code === "dual_defense" ? "tone-defense" : reg.code === "dual_offense" ? "tone-offense" : ""}`;
  $("#regimeSummary").innerHTML = `<strong>${reg.title || ""}：</strong>${reg.summary || ""}`;
  $("#regimeMeta").textContent = `双引擎同步于 ${(data.generated_at || "").replace("T", " ")}`;

  $("#hsMetricPe").textContent = `${num(hs.price, 1)} / ${pct(hs.pe_percentile)}`;
  $("#hsMetricTarget").textContent = hs.agreed ? pct(hs.consensus_exposure * 100) : "分歧（HOLD）";
  $("#hsMetricErp").textContent = `${pct(hs.erp, 2)} / ${pct(hs.erp_percentile)}`;
  $("#hsMetricStatus").textContent = hs.available ? (hs.can_decide ? "可执行" : "收盘参考") : "数据待恢复";
  $("#hsMetricFactor").textContent = pct((ref.hs300_factor ?? 0) * 100, 0);
  $("#hsFactorBar").style.width = `${(ref.hs300_factor ?? 0) * 100}%`;
  $("#hsSleeveNote").textContent = hs.available
    ? `基准日 ${hs.as_of || "--"} ${hs.time || ""} · ${hs.reason || "历史基准已通过校验"}。`
    : `数据暂不可用：${hs.reason || "请稍后刷新"}。`;

  $("#divMetricSpread").textContent = `${signedPct(div.beta_adjusted_spread_pct, 2)}（${div.relative_zone || "--"}）`;
  $("#divMetricDecision").textContent = div.decision || "--";
  $("#divMetricVal").textContent = `${pct(div.pe_percentile)} / ${div.bond_support || "--"}`;
  $("#divMetricYield").textContent = `${pct(div.dividend_yield_pct, 2)} / ${pct(div.bond10_pct, 2)}`;
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
for (const [id, key] of [["pfHsInput", "portfolio.hs300"], ["pfDivInput", "portfolio.h30269"], ["pfBudgetInput", "portfolio.budget"]]) {
  $(`#${id}`).addEventListener("input", () => {
    try { localStorage.setItem(key, $(`#${id}`).value); } catch {}
    renderCalculator();
  });
}

$$(".pf-preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const [hsVal, divVal] = String(btn.dataset.preset || ",").split(",");
    $("#pfHsInput").value = hsVal;
    $("#pfDivInput").value = divVal;
    try {
      localStorage.setItem("portfolio.hs300", hsVal);
      localStorage.setItem("portfolio.h30269", divVal);
    } catch {}
    renderCalculator();
  });
});

load(false);
if (window.lucide) lucide.createIcons();
