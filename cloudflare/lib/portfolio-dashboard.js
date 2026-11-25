// Dual-sleeve unified equity pool dashboard assembler for Cloudflare Worker & local server.
import backtestReport from "../../portfolio/reports/results.json" with { type: "json" };
import { PORTFOLIO_CONFIG, classifyRegime, computePortfolioTargets } from "./portfolio-model.js";

export const PORTFOLIO_SERVICE_VERSION = "v1.0.0";

function safeNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function assemblePortfolioDashboard(hs300Data, h30269Payload, now = new Date()) {
  const hsAnalysis = hs300Data?.analysis || {};
  const hsConsensus = hsAnalysis.consensus || hs300Data?.consensus || {};
  const hsWindows = hsAnalysis.windows || hs300Data?.windows || {};
  const hsAgreed = Boolean(hsConsensus.agreed && Number.isFinite(hsConsensus.exposure));
  const hsBacktestLastExp = safeNum(hs300Data?.chart?.exposure?.at(-1), 0.375);
  const hsRefExposure = hsAgreed ? hsConsensus.exposure : hsBacktestLastExp;
  const hsPePct = safeNum(hsWindows.full?.pe_percentile ?? hsAnalysis.pe_percentile ?? hs300Data?.pe_percentile, null);
  const hsErpPct = safeNum(hsWindows.full?.erp_percentile ?? hsAnalysis.erp_percentile ?? hs300Data?.erp_percentile, null);
  const hsAvailable = Boolean(hsAnalysis.quality?.available ?? hs300Data?.quality?.analysis_available);
  const hsCanDecide = Boolean(hsAnalysis.quality?.can_decide || hs300Data?.quality?.actionable);

  const hResult = h30269Payload?.result || h30269Payload || {};
  const hMetrics = hResult.metrics || {};
  const hEval = hResult.evaluation || {};
  const hQuality = hResult.quality || { blockers: [], warnings: [], confidence: "中" };
  const hCode = String(hEval.action_code || "hold");
  const hPePct = safeNum(hMetrics.pe_percentile, null);
  const hAdjSpread = safeNum(hMetrics.beta_adjusted_spread_pct ?? hMetrics.relative_spread_pct, null);
  const hOverheat = Boolean(
    hMetrics.beta_consensus?.robust_overheat
    || ["overheat_watch", "overheat_protected", "reduce_ready", "reduce_core_review", "pause_add"].includes(hCode)
    || hCode.startsWith("reduce_tactical_"),
  );
  const hBlocked = Boolean(hQuality.blockers?.length);

  // Reference standalone exposure for H30269 when no user position is entered yet:
  // core baseline 50%, or 70% when in buy zone and not PE-blocked, or 45% when overheated/reducing.
  let hRefExposure = 0.60;
  if (hCode.startsWith("buy_")) hRefExposure = 0.75;
  else if (hCode === "reduce_core_review") hRefExposure = 0.45;
  else if (hCode.startsWith("reduce_tactical_") || hCode === "reduce_ready") hRefExposure = 0.50;
  else if (hCode === "valuation_high_watch" || hCode === "pause_add") hRefExposure = 0.55;

  const modelTargets = computePortfolioTargets(
    hsRefExposure,
    hRefExposure,
    hsPePct,
    hPePct,
    hAdjSpread,
    hOverheat,
    PORTFOLIO_CONFIG,
  );
  const regime = classifyRegime(hsPePct, hPePct, hOverheat, hsRefExposure, hRefExposure);

  return {
    version: PORTFOLIO_CONFIG.version,
    service_version: PORTFOLIO_SERVICE_VERSION,
    generated_at: new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 19),
    config: PORTFOLIO_CONFIG,
    regime,
    reference_allocation: {
      ...modelTargets,
      hs300_ref_standalone: hsRefExposure,
      h30269_ref_standalone: hRefExposure,
      note: "此为模型参考配比（沪深300取共识目标或最近收盘基准仓位，红利低波取规则参考仓位）；填入你的真实持仓后将按总资金池精确测算调仓动作。",
    },
    sleeves: {
      hs300: {
        name: "沪深300（宽基进攻引擎）",
        model_version: hs300Data?.model_version || "v2.5",
        as_of: hsAnalysis.date || hs300Data?.as_of || null,
        time: hsAnalysis.time || null,
        price: safeNum(hsAnalysis.price ?? hs300Data?.price_index?.level, null),
        pe: safeNum(hsAnalysis.pe ?? hs300Data?.pe, null),
        pe_percentile: hsPePct,
        erp: safeNum(hsAnalysis.erp ?? hs300Data?.erp, null),
        erp_percentile: hsErpPct,
        agreed: hsAgreed,
        consensus_exposure: hsAgreed ? hsConsensus.exposure : "HOLD",
        window_min: safeNum(hsConsensus.min_exposure, null),
        window_max: safeNum(hsConsensus.max_exposure, null),
        windows: hsWindows,
        execution: hs300Data?.execution || {},
        available: hsAvailable,
        can_decide: hsCanDecide,
        quote_status: hsAnalysis.quote_quality?.status || "settled",
        reason: hsAnalysis.quality?.reason || "",
      },
      h30269: {
        name: "红利低波（价值压舱引擎）",
        model_version: hResult.model_version || "V3.2-auto-1.0",
        as_of: hMetrics.trade_date || null,
        close: safeNum(hMetrics.close, null),
        tr_close: safeNum(hMetrics.tr_close, null),
        pe: safeNum(hMetrics.pe, null),
        pe_percentile: hPePct,
        dividend_yield_pct: safeNum(hMetrics.dividend_yield_pct, null),
        bond10_pct: safeNum(hMetrics.bond10_pct, null),
        equity_bond_spread_pct: safeNum(hMetrics.equity_bond_spread_pct, null),
        bond_support: hMetrics.bond_support || "--",
        beta_adjusted_spread_pct: hAdjSpread,
        relative_zone: hMetrics.relative_zone || "--",
        action_code: hCode,
        decision: hEval.decision || "--",
        reason: hEval.reason || "",
        confirmed: Boolean(hEval.confirmed),
        execution: hEval.execution || { pct: 0, planned_pct: 0, scope: "无", core_action: "不动" },
        overheat: hOverheat,
        quote_status: hResult.sources?.target?.quote_status || "历史收盘",
        blocked: hBlocked,
        blockers: hQuality.blockers || [],
        confidence: hQuality.confidence || "中",
      },
    },
    backtest: backtestReport,
    disclosures: [
      "双资产总池以家庭权益类专用总资金池（沪深300 + 红利低波 + 权益预留现金）为 100% 分母，不含日常应急现金或债基。",
      "基础预算按 50% 沪深300 / 50% 红利低波划分；当一侧闲置时，按 50% 补位系数与平滑 PE 估值衰减向另一侧释放额度（沪深300上限 65%，红利低波上限 70%，总权益硬封顶 90%，保留至少 10% 现金缓冲）。",
      "防误杀保护：若某侧仅因估值温和抬升导致补位系数收窄、但该侧主策略并未触发卖出且总仓未超上限，则维持现有持仓，避免无谓摩擦换手。",
      "回测样本期为 2017-12-29 至 2026-10-13（双策略共同历史区间），采用收盘出信号、次日收盘成交，含年化 0.20% ETF 费率、年化 1.80% 现金收益与单边 5bp 佣金。历史表现不保证未来收益。",
    ],
  };
}
