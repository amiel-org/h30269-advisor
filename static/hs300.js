// HS300 decision desk front-end.  Reads /api/hs300/dashboard and renders it.
const BANDS = [
  { lo: 70, hi: 100, target: 0.0 },
  { lo: 60, hi: 70, target: 0.125 },
  { lo: 50, hi: 60, target: 0.375 },
  { lo: 40, hi: 50, target: 0.625 },
  { lo: 30, hi: 40, target: 0.875 },
  { lo: 0, hi: 30, target: 1.0 },
];

const $ = (s) => document.querySelector(s);
const pct = (v, d = 1) => (v === null || v === undefined ? '--' : `${Number(v).toFixed(d)}%`);
const num = (v, d = 2) => (v === null || v === undefined ? '--' : Number(v).toFixed(d));

let lastPrice = null;
let currentPe = null;
let peHistory = null;

function showError(msg) {
  const el = $('#errorBanner');
  el.textContent = msg;
  el.style.display = 'block';
}
function clearError() { $('#errorBanner').style.display = 'none'; }

// PE -> index level, holding earnings constant (same mapping the model uses)
function indexAtPe(targetPe) {
  if (!lastPrice || !currentPe || !targetPe) return null;
  return (lastPrice * targetPe / currentPe);
}
function percentilePe(p) {
  if (!peHistory || !peHistory.length) return null;
  const s = [...peHistory].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * s.length)));
  return s[idx];
}

function renderLadder(d) {
  const cur = d.pe_percentile;
  lastPrice = d.price_index?.level ?? null;
  currentPe = d.pe;
  const tbody = $('#ladder tbody');
  tbody.innerHTML = '';
  for (const b of BANDS) {
    const hiLabel = b.hi >= 100 ? '' : `${b.hi}%`;
    const range = hiLabel ? `[${b.lo}%, ${hiLabel})` : `≥ ${b.lo}%`;
    const isCur = cur >= b.lo && cur < b.hi;
    const loPe = b.lo > 0 ? percentilePe(b.lo) : percentilePe(1);
    const lvl = indexAtPe(loPe);
    const tr = document.createElement('tr');
    if (isCur) tr.className = 'cur';
    tr.innerHTML = `<td>${range}</td><td>${(b.target * 100).toFixed(1)}%</td>` +
                   `<td>${loPe ? num(loPe) : '--'}</td><td>${lvl ? lvl.toFixed(0) : '--'}</td>`;
    tbody.appendChild(tr);
  }
}

function render(d) {
  const t = d.target_exposure;
  $('#target').textContent = `${(t * 100).toFixed(1)}%`;
  $('#heroSub').textContent =
    `PE分位 ${pct(d.pe_percentile)} · ERP分位 ${pct(d.erp_percentile)} · 数据截至 ${d.as_of}`;

  $('#px').textContent = d.price_index?.level ? Number(d.price_index.level).toFixed(2) : '--';
  $('#pxDate').textContent = d.as_of || '--';
  $('#pe').textContent = num(d.pe);
  $('#pePct').textContent = `历史分位 ${pct(d.pe_percentile)}`;
  $('#pep').textContent = pct(d.pe_percentile);
  $('#erp').textContent = pct(d.erp);
  $('#erpPct').textContent = `历史分位 ${pct(d.erp_percentile)}`;

  const bt = d.backtest || {};
  $('#cagr').textContent = pct(bt.cagr_calendar_pct, 2);
  $('#btWindow').textContent = bt.start && bt.end ? `${bt.start} → ${bt.end}` : '--';
  $('#mdd').textContent = pct(bt.max_drawdown_pct, 2);
  $('#sharpe').textContent = num(bt.sharpe, 2);
  $('#avgExp').textContent = bt.avg_exposure !== undefined ? `${(bt.avg_exposure * 100).toFixed(1)}%` : '--';
  $('#trades').textContent = bt.trades !== undefined ? `调仓 ${bt.trades} 次` : '';

  renderLadder(d);

  const notes = (d.disclosures || []).join(' ');
  $('#disclosure').textContent = notes;

  lastPrice = d.price_index?.level ?? lastPrice;
  currentPe = d.pe ?? currentPe;
}

async function load(force) {
  clearError();
  $('#refreshButton').disabled = true;
  try {
    const url = force ? '/api/hs300/refresh' : '/api/hs300/dashboard';
    const resp = await fetch(url, { method: force ? 'POST' : 'GET', cache: 'no-store' });
    const body = await resp.json();
    if (!body.ok) throw new Error(body.error || `HTTP ${resp.status}`);
    if (force) { lastPrice = null; currentPe = null; }
    // fetch the full PE history once so the ladder can show index levels
    try {
      const c = await fetch('/api/hs300/dashboard', { cache: 'no-store' }).then((r) => r.json());
      peHistory = c?.data?.chart?.pe || null;
    } catch { /* ladder still renders without index levels */ }
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
