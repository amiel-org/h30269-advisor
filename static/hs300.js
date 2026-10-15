// HS300 decision desk front end.
//
// IMPORTANT: this file performs NO model maths.  Every number shown comes from
// /api/hs300/dashboard, computed by the same hs300-model.js the backtest uses.
// The previous version recomputed percentiles from a 500-point chart slice
// here, which silently disagreed with the model (bug fixed 2026-10-15).

const $ = (s) => document.querySelector(s);
const pct = (v, d = 1) => (v === null || v === undefined ? '--' : `${Number(v).toFixed(d)}%`);
const num = (v, d = 2) => (v === null || v === undefined ? '--' : Number(v).toFixed(d));
const lvl = (v) => (v === null || v === undefined ? '--' : Number(v).toFixed(0));

function showError(msg) {
  const el = $('#errorBanner');
  el.textContent = msg;
  el.style.display = 'block';
}
function clearError() { $('#errorBanner').style.display = 'none'; }

const WINDOW_ORDER = ['full', '10y', '5y'];

function renderWindows(d) {
  const host = $('#windows');
  host.innerHTML = '';
  const win = d.windows || {};
  const agreed = d.consensus?.agreed;

  for (const key of WINDOW_ORDER) {
    const w = win[key];
    if (!w) continue;
    const div = document.createElement('div');
    div.className = 'w ' + (agreed ? 'ag' : 'dis');
    const expo = w.exposure === null ? '--' : `${(w.exposure * 100).toFixed(1)}%`;
    div.innerHTML =
      `<div class="n">${w.label}</div>` +
      `<div class="p">${pct(w.pe_percentile)}</div>` +
      `<div class="e">PE分位 · 仓位 ${expo}</div>`;
    host.appendChild(div);
  }

  const verdict = document.createElement('div');
  verdict.className = 'w';
  verdict.style.gridColumn = '1 / -1';
  verdict.innerHTML = agreed
    ? `<div class="n">三窗口一致 <span class="hs-verdict ok">可执行</span></div>` +
      `<div class="e">三个窗口给出同一目标仓位，按目标执行。</div>`
    : `<div class="n">三窗口分歧 <span class="hs-verdict no">保持不动</span></div>` +
      `<div class="e">各窗口结论不一致，本次不给信号，维持当前仓位。</div>`;
  host.appendChild(verdict);
}

function renderLadder(d) {
  const tbody = $('#ladder tbody');
  tbody.innerHTML = '';
  const curPct = d.pe_percentile;
  for (const b of d.bands || []) {
    // the highlighted row is the band the full-history percentile sits in
    const isCur = curPct >= b.lo && curPct < b.hi;
    const tr = document.createElement('tr');
    if (isCur) tr.className = 'cur';
    tr.innerHTML =
      `<td>${b.label}</td><td>${(b.target * 100).toFixed(1)}%</td>` +
      `<td>${num(b.pe.full)}</td><td>${lvl(b.levels.full)}</td>` +
      `<td>${num(b.pe['10y'])}</td><td>${lvl(b.levels['10y'])}</td>` +
      `<td>${num(b.pe['5y'])}</td><td>${lvl(b.levels['5y'])}</td>`;
    tbody.appendChild(tr);
  }
}

function render(d) {
  const cons = d.consensus || {};
  const t = cons.exposure;

  if (cons.agreed && typeof t === 'number') {
    $('#target').textContent = `${(t * 100).toFixed(1)}%`;
    $('#heroSub').textContent = `三窗口一致 · PE分位 ${pct(d.pe_percentile)} · 数据截至 ${d.as_of}`;
  } else {
    $('#target').textContent = '保持不动';
    $('#heroSub').textContent = `三窗口分歧，不给新信号 · 数据截至 ${d.as_of}`;
  }

  $('#px').textContent = lvl(d.price_index?.level);
  $('#pxDate').textContent = d.as_of || '--';
  $('#pe').textContent = num(d.pe);
  $('#pePct').textContent = `全历史分位 ${pct(d.pe_percentile)}`;
  $('#pep').textContent = pct(d.pe_percentile);
  $('#erp').textContent = pct(d.erp);
  $('#erpPct').textContent = `全历史分位 ${pct(d.erp_percentile)}`;

  const bt = d.backtest || {};
  $('#cagr').textContent = pct(bt.cagr_calendar_pct, 2);
  $('#btWindow').textContent = bt.start && bt.end ? `${bt.start} → ${bt.end}` : '--';
  $('#mdd').textContent = pct(bt.max_drawdown_pct, 2);
  $('#sharpe').textContent = num(bt.sharpe, 2);
  $('#avgExp').textContent = bt.avg_exposure !== undefined ? `${(bt.avg_exposure * 100).toFixed(1)}%` : '--';
  $('#trades').textContent = bt.trades !== undefined ? `调仓 ${bt.trades} 次（分歧日不动）` : '';

  renderWindows(d);
  renderLadder(d);
  $('#disclosure').textContent = (d.disclosures || []).join(' ');
}

async function load(force) {
  clearError();
  $('#refreshButton').disabled = true;
  try {
    const url = force ? '/api/hs300/refresh' : '/api/hs300/dashboard';
    const resp = await fetch(url, { method: force ? 'POST' : 'GET', cache: 'no-store' });
    const body = await resp.json();
    if (!body.ok) throw new Error(body.error || `HTTP ${resp.status}`);
    render(body.data);
  } catch (e) {
    showError(`加载失败：${e.message}`);
  } finally {
    $('#refreshButton').disabled = false;
    $('#asOfText').textContent = new Date().toLocaleTimeString('zh-CN');
  }
}

$('#refreshButton').addEventListener('click', () => load(true));
load(false);
if (window.lucide) window.lucide.createIcons();
