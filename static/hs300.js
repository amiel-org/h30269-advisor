// HS300 decision desk front end.
//
// Performs NO model maths: every number comes from /api/hs300/dashboard, which
// is produced by the same hs300-model.js the backtest uses.

const $ = (s) => document.querySelector(s);
const pct = (v, d = 1) => (v === null || v === undefined ? '--' : `${Number(v).toFixed(d)}%`);
const num = (v, d = 2) => (v === null || v === undefined ? '--' : Number(v).toFixed(d));
const lvl = (v) => (v === null || v === undefined ? '--' : Number(v).toFixed(0));
const ymd = (s) => (s && s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s);

function showError(m) { const e = $('#errorBanner'); e.textContent = m; e.style.display = 'block'; }
function clearError() { $('#errorBanner').style.display = 'none'; }

const ORDER = ['full', '10y', '5y'];
const WNAME = { full: '全历史', '10y': '近10年', '5y': '近5年' };
const WPLAIN = { full: '全部历史（2011年至今）', '10y': '最近 10 年', '5y': '最近 5 年' };

// ---------- 数据时效 ----------
// Official decisions use settled daily observations. A dated quote is shown
// separately and must never be presented as a confirmed trade signal.
function renderFreshness(d) {
  const el = $('#freshBanner');
  const pxDay = ymd(d.price_asof || d.as_of);
  const i = d.intraday;
  el.style.display = 'block';
  if (d.quality?.analysis_available && !d.quality.actionable) {
    el.className = 'hs-fresh';
    el.textContent = `分析依据：${pxDay} 已确认收盘，国债日期 ${ymd(d.bond?.as_of)}。` +
      (d.quality.status === 'awaiting_close' ? '当天完整日线尚未取得，等待官方发布；下方保留上一收盘日分析，暂不生成新交易动作。' :
        '本次数据源核验未完成，下方保留上一收盘日分析，暂不生成新交易动作。') +
      (d.refresh_pending ? ' 正在后台核验，完成后页面会自动更新。' : ' 可稍后点击刷新核验。');
  } else if (d.refresh_status === 'stale' || !d.quality?.actionable) {
    el.className = 'hs-fresh';
    el.textContent = `数据暂不可用于交易判断。最近收盘：${pxDay}；${(d.quality?.blockers || []).join('；')}`;
  } else if (i) {
    el.className = 'hs-fresh ok';
    const chg = (i.change_pct === null || i.change_pct === undefined) ? ''
      : '（' + (i.change_pct > 0 ? '+' : '') + num(i.change_pct, 2) + '%）';
    el.innerHTML =
      '<b>' + (d.live ? '盘中报价' : '最近报价') + '（' + ymd(i.date) + ' ' + (i.time || '') + '）</b>：沪深300 <b>' + lvl(i.level) + '</b>' + chg +
      '。盘中报价仅供观察，<b>不参与正式买卖信号或连续收盘确认</b>。<br>' +
      '<span style="opacity:.85">下方分位与目标仓位依据 ' + pxDay + ' 已发布收盘数据；国债日期 ' + ymd(d.bond?.as_of) + '。</span>';
  } else {
    el.className = 'hs-fresh ok';
    el.innerHTML = '已收盘数据：<b>' + pxDay + '</b>（最近一个已收盘交易日）。' +
      '国债日期 ' + ymd(d.bond?.as_of) + '。刷新可重新获取报价；正式信号等待新收盘数据。';
  }
}

// ---------- 结论 ----------
function renderVerdict(d) {
  const hero = $('#hero');
  const c = d.consensus || {};
  if (!d.quality?.actionable) {
    hero.classList.add('wait');
    const reference = d.quality?.analysis_available;
    $('#verdict').textContent = reference
      ? (d.quality.status === 'awaiting_close' ? '等待新收盘数据' : '保留上次收盘分析') : '暂停交易提示';
    const last = c.agreed && typeof c.exposure === 'number'
      ? `三窗口目标 ${(c.exposure * 100).toFixed(1)}%` : '三窗口目标不一致，模型暂不调仓';
    $('#verdictSay').textContent = reference
      ? `${ymd(d.price_asof)} 收盘分析：${last}。新数据核验完成前不新增交易动作。`
      : (d.quality?.blockers || ['数据未通过时效检查']).join('；');
  } else if (c.agreed && typeof c.exposure === 'number') {
    hero.classList.remove('wait');
    $('#verdict').textContent = `目标仓位 ${(c.exposure * 100).toFixed(1)}%`;
    const ex = d.execution || {};
    $('#verdictSay').innerHTML =
      `三个时间窗口目标一致，已连续 ${ex.confirmed_closes || 0} 个收盘日。<br>` +
      `买入需 ${ex.buy_required} 日确认，卖出需 ${ex.sell_required} 日确认；满足后次一交易日收盘最多调整 12.5 个百分点。<br>` +
      `这是策略资金池的目标，尚未结合你的实际仓位，不能直接等同本次买卖比例。`;
  } else {
    hero.classList.add('wait');
    $('#verdict').textContent = '模型暂不调仓';
    const w = d.windows || {};
    const parts = ORDER.filter((k) => w[k]).map((k) => `${WNAME[k]} ${pct(w[k].pe_percentile)}`);
    const gap = (d.consensus && d.consensus.span !== undefined && d.consensus.span !== null)
      ? `（三种看法相差 ${(d.consensus.span / 0.125).toFixed(0)} 档）` : '';
    $('#verdictSay').innerHTML =
      `三个时间窗口看法<b>不一致</b>${gap}：${parts.join(' · ')}。<br>` +
      `按已冻结的规则保持现有仓位，等待三窗口目标一致。分歧本身不能证明市场没有投资机会。`;
  }
}

// ---------- 动作清单：下一买点 / 下一卖点 ----------
// Uses the server's conditional_levels: PE + ERP + all configured windows.
function renderActions(d) {
  const host = $('#actions');
  host.innerHTML = '';

  const row = (cls, tag, head, sub) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="tag ${cls}">${tag}</span>` +
                   `<span class="body">${head}` +
                   (sub ? `<div style="color:#6b7280;font-size:13px;margin-top:4px">${sub}</div>` : '') +
                   `</span>`;
    return li;
  };
  if (!d.quality?.actionable && !d.quality?.analysis_available) {
    host.appendChild(row('hold', '暂停', '数据不可用于交易判断，暂不展示买卖观察线。', ''));
    return;
  }
  const levels = d.conditional_levels || {};
  const reference = !d.quality?.actionable;
  if (reference) host.appendChild(row('hold', '历史参考',
    `${ymd(d.price_asof)} 收盘分析的条件观察线，等待新数据后重新计算。`, '本轮不据此生成交易动作。'));
  for (const [kind, label] of [['buy', '加仓观察'], ['sell', '减仓观察']]) {
    const line = levels[kind];
    host.appendChild(row(kind, label, line
      ? `条件估算点位 <b>${lvl(line.level)}</b>；三窗口目标均为 <b>${(line.target * 100).toFixed(1)}%</b>`
      : '当前假设下没有找到对应观察线。',
      line ? '点位处同时检查了 PE 与 ERP。还须满足收盘确认、真实仓位差和每次一档的限制，越过该价位后需重新计算。' : ''));
  }
  host.appendChild(row('now', '估算前提', levels.assumption || '等待下一次正式收盘后复核。', ''));
}

// ---------- 三窗口 ----------
function renderWindows(d) {
  const host = $('#windows');
  host.innerHTML = '';
  const w = d.windows || {};
  const agreed = d.consensus && d.consensus.agreed;
  for (const k of ORDER) {
    if (!w[k]) continue;
    const div = document.createElement('div');
    div.className = 'w ' + (agreed ? 'ag' : 'dis');
    const expo = w[k].exposure === null ? '--' : `${(w[k].exposure * 100).toFixed(1)}%`;
    div.innerHTML =
      `<div class="n">${WPLAIN[k]}</div>` +
      `<div class="p">${pct(w[k].pe_percentile)}</div>` +
      `<div class="e">ERP 分位 ${pct(w[k].erp_percentile)} · 目标仓位 ${expo}</div>`;
    host.appendChild(div);
  }
}

// ---------- 阶梯表 ----------
// Renders VERBATIM what the server computed.  No band table is hard-coded here:
// if the ladder in config.json changes, this table follows automatically.
function renderLadder(d) {
  const tbody = $('#ladder tbody');
  tbody.innerHTML = '';
  const cur = d.pe_percentile;
  const rows = d.ladder || [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5">数据缺失</td></tr>';
    return;
  }
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const upper = i > 0 ? rows[i - 1].lo : null;
    const isCur = r.lo === null
      ? (cur < (rows[i - 1] ? rows[i - 1].lo : 100))
      : (cur >= r.lo && (upper === null || cur < upper));
    // A band's range is [r.lo, upper).  Labelling it "below r.lo" would be
    // wrong by one band -- that is the NEXT band down.
    const lo = r.lo;
    let label;
    if (r.target === 0) label = `PE分位 ${lo}% 以上（很贵）`;
    else if (r.target === 1) label = `PE分位 ${upper}% 以下（很便宜）`;
    else label = `PE分位 ${lo}%–${upper}%`;
    const cells = ORDER.map((k) => `<td class="num">${lvl(r.levels ? r.levels[k] : null)}</td>`).join('');
    const tr = document.createElement('tr');
    if (isCur) tr.className = 'cur';
    tr.innerHTML = `<td>${label}</td><td class="num">${(r.target * 100).toFixed(1)}%</td>${cells}`;
    tbody.appendChild(tr);
  }
}

function render(d) {
  renderFreshness(d);
  renderVerdict(d);
  renderActions(d);
  renderWindows(d);
  renderLadder(d);

  $('#px').textContent = lvl(d.price_index && d.price_index.level);
  $('#pe').textContent = num(d.pe);
  $('#pep').textContent = pct(d.pe_percentile);
  $('#erp').textContent = pct(d.erp);

  const bt = d.backtest || {};
  $('#cagr').textContent = pct(bt.cagr_calendar_pct, 2);
  $('#mdd').textContent = pct(bt.max_drawdown_pct, 2);
  $('#sharpe').textContent = num(bt.sharpe, 2);
  $('#avgExp').textContent = `${((bt.avg_exposure || 0) * 100).toFixed(1)}% / ${bt.trades} 次`;
  $('#backtestPeriod').textContent = `${ymd(bt.start)} 至 ${ymd(bt.end)}，样本内研究；没有经核实的实盘业绩。`;
  $('#buyHold').textContent = `${pct(bt.buy_hold?.cagrCalendarPct, 2)} / ${pct(bt.buy_hold?.maxDrawdownPct, 2)}`;

  $('#disclosure').innerHTML = (d.disclosures || []).join('<br>');
}

async function load(force) {
  clearTimeout(pollTimer);
  clearError();
  $('#refreshButton').disabled = true;
  $('#refreshButton').textContent = '刷新中…';
  $('#asOfText').textContent = force ? '正在更新数据' : '正在读取数据';
  const request = async (url, method, milliseconds) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), window.HS300_REQUEST_TIMEOUT_MS || milliseconds);
    try {
      const response = await fetch(url, { method, cache: 'no-store', signal: controller.signal });
      if (!response.ok) {
        const error = new Error(`接口返回 HTTP ${response.status}`);
        error.retryable = response.status >= 500;
        throw error;
      }
      return await response.json();
    } finally { clearTimeout(timeout); }
  };
  try {
    const url = force ? '/api/hs300/refresh' : '/api/hs300/dashboard';
    let body;
    try { body = await request(url, force ? 'POST' : 'GET', force ? 15000 : 28000); }
    catch (error) {
      if (!error.retryable && error.name !== 'AbortError' && !(error instanceof TypeError)) throw error;
      $('#asOfText').textContent = '连接波动，正在重试';
      // A retry reads the existing dashboard, allowing its background refresh
      // to finish without launching a second costly manual refresh.
      body = await request('/api/hs300/dashboard', 'GET', 7000);
    }
    if (!body.ok || !body.data || !body.data.consensus || !body.data.windows) throw new Error(body.error || '接口数据结构异常');
    render(body.data);
    lastData = body.data;
    const stamp = body.data.server_time ? new Date(body.data.server_time).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '--';
    const reference = body.data.quality?.analysis_available && !body.data.quality.actionable;
    $('#asOfText').textContent = body.data.refresh_pending ? '后台核验中' : reference
      ? `参考 ${ymd(body.data.price_asof)}` : `${body.data.refresh_status === 'stale' ? '旧快照' : '数据更新'} ${stamp}`;
    if (body.data.refresh_status === 'stale') showError(`本次刷新失败：${body.data.refresh_error}。已显示旧快照，交易提示暂停。`);
    if (body.data.refresh_pending && pollCount < 5) {
      pollCount += 1;
      pollTimer = setTimeout(() => load(false), 3000);
    } else if (!body.data.refresh_pending) pollCount = 0;
  } catch (e) {
    showError(e.name === 'AbortError' ? '加载超时：数据源响应较慢，请点击刷新重试。' : `加载失败：${e.message}`);
    $('#asOfText').textContent = '刷新失败，可重试';
    const day = lastData?.price_asof;
    const stamp = day && Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00+08:00`);
    const age = stamp ? (Date.now() - stamp) / 86400000 : Infinity;
    if (lastData && age >= 0 && age < 5 && lastData.quality?.analysis_available) {
      render({ ...lastData, refresh_pending: false, quality: { ...lastData.quality,
        actionable: false, analysis_available: true, status: 'source_unavailable' } });
    } else {
      $('#verdict').textContent = '暂停交易提示';
      $('#verdictSay').textContent = '本次数据未能完成更新，暂不使用旧画面判断买卖。';
      $('#actions').textContent = '数据未完成更新，观察线暂停。';
    }
  } finally {
    $('#refreshButton').disabled = false;
    $('#refreshButton').textContent = '刷新';
  }
}

let pollTimer = null;
let pollCount = 0;
let lastData = null;
$('#refreshButton').addEventListener('click', () => {
  clearTimeout(pollTimer); pollCount = 0; load(true);
});
load(false);
if (window.lucide) window.lucide.createIcons();
