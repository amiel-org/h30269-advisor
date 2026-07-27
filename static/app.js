const state = {
  payload: null,
  position: "普通仓位",
  range: 132,
  relativeRange: 66,
  chartMode: "candles",
  priceChart: null,
  priceResizeObserver: null,
  relativeChart: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function number(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return Number(value).toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function percent(value, digits = 2) {
  if (value === null || value === undefined) return "--";
  const prefix = Number(value) > 0 ? "+" : "";
  return `${prefix}${number(value, digits)}%`;
}

function rate(value, digits = 2) {
  if (value === null || value === undefined) return "--";
  return `${number(value, digits)}%`;
}

function adjustedSpread(metrics) {
  return metrics.beta_adjusted_spread_pct ?? metrics.relative_spread_pct;
}

function rawSpread(metrics) {
  return metrics.raw_relative_spread_pct ?? metrics.relative_spread_pct;
}

function betaWindow(metrics, label) {
  return metrics.beta_windows?.[label] || null;
}

function decisionTone(evaluation) {
  const code = evaluation?.action_code || "";
  if (code.startsWith("buy_")) return "buy";
  if (code.startsWith("reduce_tactical_") || code === "reduce_core_review") return "sell";
  if (["overheat_watch", "overheat_protected", "reduce_ready", "pause_add"].includes(code)) return "warn";
  if (code === "hold") return "hold";
  const text = evaluation?.decision || String(evaluation || "");
  if (/买入|加仓|强买/.test(text)) return "buy";
  if (/过热|等待减仓/.test(text)) return "warn";
  if (/减仓|强卖|卖出/.test(text)) return "sell";
  if (/持有/.test(text)) return "hold";
  return "wait";
}

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = value;
}

function setDecisionText(value) {
  const node = $("#decisionText");
  if (!node) return;
  const parts = String(value).split(/[，,]/).map((part) => part.trim()).filter(Boolean);
  node.replaceChildren(...parts.map((part) => {
    const line = document.createElement("span");
    line.textContent = part;
    return line;
  }));
}

function yearPosition(distance) {
  if (distance <= -8) return "深左侧";
  if (distance < -2) return "年线下方";
  if (distance <= 2) return "年线附近";
  if (distance < 8) return "年线上方";
  return "高位区";
}

function normalizeConfirmation(metrics) {
  return metrics.reduce_confirmation || {
    required_closes: 2,
    confirmed_closes: 0,
    confirmed: false,
    intraday_excluded: metrics.quote_status === "盘中",
    recent_closes: [],
  };
}

function normalizeExecution(evaluation) {
  return evaluation.execution || {
    scope: "无",
    pct: 0,
    planned_pct: 0,
    core_action: "不动",
    timing: "等待刷新",
  };
}

function renderMovingAverages(metrics) {
  [20, 30, 60, 120, 250].forEach((period) => {
    const value = metrics[`ma${period}`];
    const distance = value ? ((metrics.close / value) - 1) * 100 : null;
    const above = distance !== null && distance >= 0;
    setText(`#ma${period}Value`, number(value));
    const stateNode = $(`#ma${period}State`);
    if (!stateNode) return;
    stateNode.textContent = distance === null
      ? "--"
      : `${above ? "高于" : "低于"} ${number(Math.abs(distance))}%`;
    stateNode.className = above ? "above" : "below";
  });
}

function gateMarkup(gates) {
  return gates.map((gate) => `
    <div class="gate-row ${gate.state}">
      <i data-lucide="${gate.state === "done" ? "circle-check" : gate.state === "blocked" ? "circle-x" : "circle-dashed"}"></i>
      <div><strong>${gate.label}</strong><span>${gate.detail}</span></div>
    </div>
  `).join("");
}

function renderGates(metrics, evaluation) {
  const confirmation = normalizeConfirmation(metrics);
  const execution = normalizeExecution(evaluation);
  const adjusted = adjustedSpread(metrics);
  const robustOverheat = Boolean(metrics.beta_consensus?.robust_overheat);
  const absoluteGain = metrics.target_40d_return_pct >= 5;
  const positionGate = metrics.distance_ma250_pct >= 0;
  const gates = [
    {
      label: "多窗口调整差 ≥ 7%",
      detail: `${percent(adjusted)} · ${robustOverheat ? "2/3/5年均确认" : metrics.beta_consensus?.consistent ? "窗口一致，尚未到7%" : "窗口分歧"}`,
      state: robustOverheat ? "done" : "waiting",
    },
    {
      label: "红利自身40日 ≥ 5%",
      detail: `${percent(metrics.target_40d_return_pct)} · ${absoluteGain ? "绝对涨幅已确认" : "尚未涨过头"}`,
      state: absoluteGain ? "done" : robustOverheat ? "blocked" : "waiting",
    },
    {
      label: "站上 MA250",
      detail: `${percent(metrics.distance_ma250_pct)} · ${positionGate ? "位置确认通过" : "年线下方保护"}`,
      state: positionGate ? "done" : robustOverheat ? "blocked" : "waiting",
    },
    {
      label: `连续 ${confirmation.required_closes} 个收盘 / 战术仓`,
      detail: execution.pct > 0
        ? `${confirmation.confirmed_closes}/${confirmation.required_closes} · 本次减 ${execution.pct}%`
        : `${confirmation.confirmed_closes}/${confirmation.required_closes} · 当前不执行`,
      state: execution.pct > 0 ? "done" : confirmation.confirmed ? "blocked" : "waiting",
    },
  ];
  $("#gateRows").innerHTML = gateMarkup(gates);
}

function chainMarkup(nodes) {
  return nodes.map((node, index) => `
    <div class="chain-node ${node.state}">
      <i data-lucide="${node.icon}"></i>
      <div><strong>${node.label}</strong><span>${node.detail}</span></div>
    </div>
    ${index < nodes.length - 1 ? '<i class="chain-arrow" data-lucide="arrow-right"></i>' : ""}
  `).join("");
}

function renderDecisionChains(metrics, evaluation) {
  const confirmation = normalizeConfirmation(metrics);
  const execution = normalizeExecution(evaluation);
  const adjusted = adjustedSpread(metrics);
  const relativeLow = adjusted <= -1 && Boolean(metrics.beta_consensus?.robust_buy);
  const supportGood = ["股债强支撑", "股债有支撑"].includes(metrics.bond_support);
  const buyActive = String(evaluation.action_code || "").startsWith("buy_");
  const overheat = adjusted >= 7 && Boolean(metrics.beta_consensus?.robust_overheat);
  const absoluteAndMa = metrics.target_40d_return_pct >= 5 && metrics.distance_ma250_pct >= 0;

  $("#buyChain").innerHTML = chainMarkup([
    { label: "多窗口低估", detail: `调整差 ≤ -1% · 当前 ${percent(adjusted)}`, state: relativeLow ? "done" : "waiting", icon: "git-compare-arrows" },
    { label: "股债支撑", detail: metrics.bond_support, state: supportGood ? "done" : "blocked", icon: "scale" },
    { label: "分批执行", detail: buyActive ? `计划仓位 ${execution.pct}%` : "等待主信号", state: buyActive ? "action" : "waiting", icon: "layers-3" },
  ]);

  $("#reduceChain").innerHTML = chainMarkup([
    { label: "Beta过热", detail: `多窗口 ≥ 7% · 当前 ${percent(adjusted)}`, state: overheat ? "done" : "waiting", icon: "triangle-alert" },
    { label: "自身涨幅 + 年线", detail: absoluteAndMa ? "两项均确认" : `${percent(metrics.target_40d_return_pct)} / ${percent(metrics.distance_ma250_pct)}`, state: absoluteAndMa ? "done" : overheat ? "blocked" : "waiting", icon: "scan-line" },
    { label: `${confirmation.required_closes}日收盘确认`, detail: `${confirmation.confirmed_closes}/${confirmation.required_closes}`, state: confirmation.confirmed ? "done" : "waiting", icon: "calendar-check-2" },
    { label: "战术仓动作", detail: execution.pct > 0 ? `减 ${execution.pct}%` : execution.planned_pct > 0 ? `确认后减 ${execution.planned_pct}%` : "当前不执行", state: execution.pct > 0 ? "action" : "waiting", icon: "crosshair" },
  ]);
}

function renderBetaAudit(metrics) {
  ["2y", "3y", "5y"].forEach((label) => {
    const item = betaWindow(metrics, label);
    setText(`#beta${label}Value`, item ? number(item.beta, 3) : "--");
    setText(
      `#beta${label}Adjusted`,
      item ? `调整后 ${percent(item.adjusted_spread_pct)}` : "样本不足",
    );
  });
  setText("#betaConsensus", metrics.beta_consensus?.status || "--");
  const low = metrics.beta_band_low_pct;
  const high = metrics.beta_band_high_pct;
  setText(
    "#betaBand",
    low === null || low === undefined || high === null || high === undefined
      ? "样本不足"
      : `调整区间 ${percent(low)} ~ ${percent(high)}`,
  );
}

function renderSummary(payload) {
  const result = payload.result;
  const metrics = result.metrics;
  const evaluation = result.evaluation;
  const sources = result.sources;
  const confirmation = normalizeConfirmation(metrics);
  const execution = normalizeExecution(evaluation);
  const tone = decisionTone(evaluation);

  $("#signalPanel").className = `action-rail tone-${tone}`;
  document.body.dataset.tone = tone;
  setText("#signalStateText", evaluation.decision);
  setDecisionText(evaluation.decision);
  setText("#decisionReason", evaluation.reason);
  setText("#confidenceBadge", `置信度 ${result.quality.confidence}`);
  setText("#quoteStatus", sources.target.quote_status);
  setText("#positionAdvice", result.position_advice[state.position]);
  setText("#topCoreAction", execution.core_action || "不动");
  setText("#topTiming", execution.timing || "继续观察");
  setText("#topRelative", percent(adjustedSpread(metrics)));
  setText("#topConfirm", `${confirmation.confirmed_closes} / ${confirmation.required_closes}`);

  setText("#targetReturnInline", percent(metrics.target_40d_return_pct));
  setText("#benchmarkReturnInline", percent(metrics.benchmark_40d_return_pct));
  setText("#relativeValue", percent(adjustedSpread(metrics)));
  setText("#relativeZone", metrics.relative_zone);
  setText("#betaValue", number(metrics.beta, 3));
  setText("#betaState", metrics.beta_consensus?.status || metrics.beta_window || "--");
  setText("#yearDistance", percent(metrics.distance_ma250_pct));
  setText("#yearPosition", yearPosition(metrics.distance_ma250_pct));
  setText("#bondSpreadValue", percent(metrics.equity_bond_spread_pct));
  setText("#bondSupport", metrics.bond_support.replace("股债", ""));
  setText("#bondYieldValue", rate(metrics.bond10_pct, 4));
  setText("#bondDateInline", sources.bond.as_of || "--");

  setText("#closeValue", number(metrics.close));
  setText("#closeDate", `${metrics.trade_date} · ${sources.target.quote_status}`);
  setText("#targetReturnValue", percent(metrics.target_40d_return_pct));
  setText("#benchmarkReturnValue", percent(metrics.benchmark_40d_return_pct));
  setText("#rawGap", percent(rawSpread(metrics)));
  setText("#currentGap", percent(adjustedSpread(metrics)));
  setText("#relativeBaseDate", `40日窗口 ${metrics.target_40d_base_date} → ${metrics.trade_date}`);
  setText("#dividendYieldValue", rate(metrics.dividend_yield_pct));
  setText("#bondYieldDetail", rate(metrics.bond10_pct, 4));
  setText("#bondSpreadDetail", percent(metrics.equity_bond_spread_pct));
  setText("#equityBondMultiple", `股债倍数 ${number(metrics.equity_bond_multiple)}x · ${metrics.bond_support}`);
  setText("#qualityBadge", `数据完整 · 置信度 ${result.quality.confidence}`);
  setText("#generatedAtText", `生成 ${result.generated_at.replace("T", " ")}`);
  setText("#asOfText", `${metrics.trade_date} ${sources.target.quote_status}`);
  $("#marketDot").className = "state-dot live";

  setText("#confirmationCount", `${confirmation.confirmed_closes} / ${confirmation.required_closes}`);
  setText("#confirmationLabel", confirmation.confirmed ? "已确认" : confirmation.intraday_excluded ? "盘中不计入" : "等待收盘");
  const dots = Array.from({ length: confirmation.required_closes }, (_, index) => `
    <i class="${index < confirmation.confirmed_closes ? "done" : ""}">${index + 1}</i>
  `).join("");
  $("#confirmationDots").innerHTML = dots;
  $("#confirmationProgress").style.width = `${Math.min(100, confirmation.confirmed_closes / confirmation.required_closes * 100)}%`;

  let firstAction = "当前无动作";
  if (execution.pct > 0) firstAction = `${execution.scope}减 ${execution.pct}%`;
  else if (evaluation.action_code === "reduce_ready") firstAction = `收盘复核后减 ${execution.planned_pct}%`;
  else if (execution.planned_pct > 0 && adjustedSpread(metrics) >= 7) firstAction = `确认后战术仓减 ${execution.planned_pct}%`;
  else if (String(evaluation.action_code || "").startsWith("buy_")) firstAction = `计划仓位加 ${execution.pct}%`;
  setText("#firstActionText", firstAction);

  renderMovingAverages(metrics);
  renderBetaAudit(metrics);
  renderGates(metrics, evaluation);
  renderDecisionChains(metrics, evaluation);
  renderSources(result);
}

function sourceItem(label, value, source, date, status, url) {
  const statusClass = status === "live" ? "live" : "cache";
  const statusText = status === "live" ? "最新" : status === "cache" ? "缓存" : status;
  return `<div class="source-row">
    <div><span>${label}</span><strong>${value}</strong></div>
    <p>${source}</p>
    <span class="source-date">${date || "--"}</span>
    <span class="source-status ${statusClass}">${statusText}</span>
    <a href="${url}" target="_blank" rel="noopener noreferrer" title="打开${label}数据来源" aria-label="打开${label}数据来源"><i data-lucide="external-link"></i></a>
  </div>`;
}

function renderSources(result) {
  const m = result.metrics;
  const s = result.sources;
  $("#sourceRows").innerHTML = [
    sourceItem("红利低波 H30269", number(m.close), s.target.source, m.trade_date, s.target.cache_status, s.target.source_url),
    sourceItem("中证全指 000985", number(m.benchmark_close), s.benchmark.source, m.trade_date, s.benchmark.cache_status, s.benchmark.source_url),
    sourceItem("股息率", rate(m.dividend_yield_pct), s.dividend.source, s.dividend.as_of, s.dividend.status, s.dividend.source_url),
    sourceItem("10年国债收益率", rate(m.bond10_pct, 4), s.bond.source, s.bond.as_of, s.bond.status, s.bond.source_url),
  ].join("");
}

function chartSlice(chart, range) {
  const start = Math.max(0, chart.dates.length - range);
  const result = {};
  Object.keys(chart).forEach((key) => { result[key] = chart[key].slice(start); });
  return result;
}

function chartTimeKey(time) {
  if (typeof time === "string") return time;
  if (typeof time === "number") return new Date(time * 1000).toISOString().slice(0, 10);
  if (time && typeof time === "object") {
    const month = String(time.month).padStart(2, "0");
    const day = String(time.day).padStart(2, "0");
    return `${time.year}-${month}-${day}`;
  }
  return "";
}

function setOhlcReadout(candle, previousClose) {
  if (!candle) return;
  const reference = previousClose || candle.open;
  const change = reference ? ((candle.close / reference) - 1) * 100 : 0;
  setText("#openValue", number(candle.open));
  setText("#highValue", number(candle.high));
  setText("#lowValue", number(candle.low));
  setText("#ohlcCloseValue", number(candle.close));
  setText("#changeValue", percent(change));
  const changeNode = $("#changeValue");
  if (changeNode) changeNode.className = change >= 0 ? "up" : "down";
}

function lightweightLineData(dates, values) {
  return dates
    .map((time, index) => ({ time, value: values[index] }))
    .filter((item) => item.value !== null && item.value !== undefined);
}

function renderPriceChart(data) {
  const container = $("#priceChart");
  if (!container || !window.LightweightCharts) return;
  if (state.priceResizeObserver) state.priceResizeObserver.disconnect();
  if (state.priceChart) state.priceChart.remove();
  container.innerHTML = "";

  const mobile = window.innerWidth <= 620;
  const chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight,
    layout: {
      background: { type: LightweightCharts.ColorType.Solid, color: "transparent" },
      textColor: "#7b858c",
      fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", Arial, sans-serif',
      fontSize: 10,
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: "rgba(77, 88, 94, 0.07)" },
      horzLines: { color: "rgba(77, 88, 94, 0.10)" },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: "rgba(48, 59, 65, 0.4)", width: 1, labelBackgroundColor: "#121619" },
      horzLine: { color: "rgba(48, 59, 65, 0.3)", width: 1, labelBackgroundColor: "#121619" },
    },
    rightPriceScale: {
      borderColor: "rgba(102, 112, 118, 0.2)",
      scaleMargins: { top: 0.08, bottom: 0.1 },
    },
    timeScale: {
      borderColor: "rgba(102, 112, 118, 0.2)",
      timeVisible: false,
      rightOffset: mobile ? 2 : 5,
      barSpacing: mobile ? 5 : 7,
      minBarSpacing: 3,
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    localization: { locale: "zh-CN", priceFormatter: (price) => number(price) },
  });

  let primarySeries;
  if (state.chartMode === "line") {
    primarySeries = chart.addLineSeries({
      color: "#e83238",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 3,
    });
    primarySeries.setData(lightweightLineData(data.dates, data.close));
  } else {
    primarySeries = chart.addCandlestickSeries({
      upColor: "#e83238",
      downColor: "#07805d",
      borderUpColor: "#e83238",
      borderDownColor: "#07805d",
      wickUpColor: "#e83238",
      wickDownColor: "#07805d",
      priceLineVisible: false,
      lastValueVisible: true,
    });
    primarySeries.setData(data.candles);
  }

  [
    { values: data.ma20, color: "#5d7ce2", width: 1 },
    { values: data.ma60, color: "#e28831", width: 1 },
    { values: data.ma250, color: "#15a38b", width: 2 },
  ].forEach((definition) => {
    const series = chart.addLineSeries({
      color: definition.color,
      lineWidth: definition.width,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    series.setData(lightweightLineData(data.dates, definition.values));
  });

  const candleIndex = new Map(data.candles.map((candle, index) => [candle.time, index]));
  const latestIndex = data.candles.length - 1;
  setOhlcReadout(data.candles[latestIndex], data.candles[latestIndex - 1]?.close);
  chart.subscribeCrosshairMove((param) => {
    const index = candleIndex.get(chartTimeKey(param.time));
    if (index === undefined) {
      setOhlcReadout(data.candles[latestIndex], data.candles[latestIndex - 1]?.close);
      return;
    }
    setOhlcReadout(data.candles[index], data.candles[index - 1]?.close);
  });

  chart.timeScale().fitContent();
  state.priceChart = chart;
  state.priceResizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (entry) chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
  });
  state.priceResizeObserver.observe(container);
}

function commonChartOptions() {
  const mobile = window.innerWidth <= 760;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 350 },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#111518",
        titleColor: "#ffffff",
        bodyColor: "#e6ebed",
        padding: 11,
        cornerRadius: 4,
        displayColors: true,
        callbacks: { label: (context) => `${context.dataset.label}: ${number(context.parsed.y)}` },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          color: "#7a848b",
          maxTicksLimit: mobile ? 4 : 7,
          maxRotation: 0,
          font: { size: 10 },
          callback(value) {
            const label = this.getLabelForValue(value);
            return mobile && label.length >= 10 ? label.slice(5) : label;
          },
        },
        border: { color: "#dfe3e2" },
      },
      y: {
        position: "right",
        grid: { color: "rgba(105, 117, 122, 0.12)" },
        ticks: { color: "#7a848b", font: { size: 10 }, callback: (value) => `${value}%` },
        border: { display: false },
      },
    },
  };
}

function renderCharts(chart) {
  const data = chartSlice(chart, state.range);
  const relative = chartSlice(chart, state.relativeRange);
  renderPriceChart(data);

  const relativeOptions = commonChartOptions();
  relativeOptions.plugins.tooltip.callbacks.label = (context) => `${context.dataset.label}: ${percent(context.parsed.y)}`;
  relativeOptions.plugins.tooltip.callbacks.footer = (items) => {
    const values = Object.fromEntries(items.map((item) => [item.dataset.label, item.parsed.y]));
    if (values["红利低波40日收益"] === undefined || values["中证全指40日收益"] === undefined) return "";
    const raw = values["红利低波40日收益"] - values["中证全指40日收益"];
    const adjusted = values["Beta调整后40日差"];
    return adjusted === undefined
      ? `原始差值: ${percent(raw)}`
      : `原始差值 ${percent(raw)} · Beta调整后 ${percent(adjusted)}`;
  };
  relativeOptions.scales.x.ticks.maxTicksLimit = 4;
  relativeOptions.scales.x.ticks.callback = function relativeDateTick(value) {
    const label = this.getLabelForValue(value);
    return label.length >= 10 ? label.slice(5) : label;
  };
  const relativeData = {
    labels: relative.dates,
    datasets: [
      {
        label: "红利低波40日收益",
        data: relative.targetReturn40,
        borderColor: "#e83238",
        backgroundColor: "rgba(232, 50, 56, 0.07)",
        fill: { target: 1, above: "rgba(232, 50, 56, 0.07)", below: "rgba(56, 111, 214, 0.06)" },
        borderWidth: 2.5,
        pointRadius: 0,
        tension: 0.16,
      },
      {
        label: "中证全指40日收益",
        data: relative.benchmarkReturn40,
        borderColor: "#386fd6",
        backgroundColor: "transparent",
        borderWidth: 2.1,
        pointRadius: 0,
        tension: 0.16,
      },
      {
        label: "Beta调整后40日差",
        data: relative.betaAdjusted40 || relative.relative40,
        borderColor: "#16836c",
        backgroundColor: "transparent",
        borderWidth: 1.8,
        borderDash: [5, 4],
        pointRadius: 0,
        tension: 0.16,
      },
    ],
  };
  if (state.relativeChart) state.relativeChart.destroy();
  state.relativeChart = new Chart($("#relativeChart"), { type: "line", data: relativeData, options: relativeOptions });
}

function renderHistory(history) {
  setText("#historyCount", `${history.length} 条记录`);
  $("#historyRows").innerHTML = history.map((row) => {
    const tone = decisionTone({ decision: row.decision });
    const generated = row.generated_at ? row.generated_at.replace("T", " ") : "--";
    return `<tr>
      <td>${generated}</td><td>${row.trade_date || "--"}</td>
      <td><span class="decision-chip ${tone}">${row.decision}</span></td>
      <td class="history-metric">${percent(row.relative_spread_pct)}<small>${row.signal_metric || "旧版原始"}</small></td><td>${percent(row.distance_ma250_pct)}</td>
      <td>${row.momentum || "--"}</td><td>${row.confidence || "--"}</td>
    </tr>`;
  }).join("");
}

function render(payload) {
  state.payload = payload;
  renderSummary(payload);
  renderCharts(payload.chart);
  renderHistory(payload.history);
  $("#loadingOverlay").classList.add("hidden");
  if (window.lucide) lucide.createIcons();
}

function showError(message) {
  $("#errorBanner").hidden = false;
  setText("#errorText", message);
  $("#marketDot").className = "state-dot error";
}

function clearError() {
  $("#errorBanner").hidden = true;
}

function showToast(text) {
  const toast = $("#toast");
  toast.textContent = text;
  toast.hidden = false;
  window.setTimeout(() => { toast.hidden = true; }, 2800);
}

async function loadDashboard() {
  clearError();
  const response = await fetch("/api/dashboard", { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || "读取失败");
  render(payload.data);
}

async function refreshDashboard() {
  const button = $("#refreshButton");
  button.disabled = true;
  button.classList.add("spinning");
  clearError();
  try {
    const response = await fetch("/api/refresh", { method: "POST" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || "刷新失败");
    render(payload.data);
    showToast("最新数据已刷新");
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
    button.classList.remove("spinning");
    if (window.lucide) lucide.createIcons();
  }
}

function bindEvents() {
  $("#refreshButton").addEventListener("click", refreshDashboard);

  $$(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".tab").forEach((node) => node.classList.toggle("active", node === button));
      const isOverview = button.dataset.tab === "overview";
      $("#overviewView").classList.toggle("active", isOverview);
      $("#historyView").classList.toggle("active", !isOverview);
    });
  });

  $$('[data-position]').forEach((button) => {
    button.addEventListener("click", () => {
      state.position = button.dataset.position;
      $$('[data-position]').forEach((node) => node.classList.toggle("active", node === button));
      if (state.payload) setText("#positionAdvice", state.payload.result.position_advice[state.position]);
    });
  });

  $$('[data-range]').forEach((button) => {
    button.addEventListener("click", () => {
      state.range = Number(button.dataset.range);
      $$('[data-range]').forEach((node) => node.classList.toggle("active", node === button));
      if (state.payload) renderCharts(state.payload.chart);
    });
  });

  $$('[data-chart-mode]').forEach((button) => {
    button.addEventListener("click", () => {
      state.chartMode = button.dataset.chartMode;
      $$('[data-chart-mode]').forEach((node) => node.classList.toggle("active", node === button));
      if (state.payload) renderCharts(state.payload.chart);
    });
  });

  $$('[data-relative-range]').forEach((button) => {
    button.addEventListener("click", () => {
      state.relativeRange = Number(button.dataset.relativeRange);
      $$('[data-relative-range]').forEach((node) => node.classList.toggle("active", node === button));
      if (state.payload) renderCharts(state.payload.chart);
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  if (window.lucide) lucide.createIcons();
  bindEvents();
  try {
    await loadDashboard();
  } catch (error) {
    $("#loadingOverlay").classList.add("hidden");
    showError(error.message);
  }
});
