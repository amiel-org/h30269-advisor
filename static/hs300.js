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

// ---------- 数据时效（回答"刷新还是昨天的"）----------
function renderFreshness(d) {
  const el = $('#freshBanner');
  const pxDay = ymd(d.price_asof || d.as_of);
  const i = d.intraday;
  el.style.display = 'block';
  if (i) {
    el.className = 'hs-fresh';
    const chg = (i.change_pct === null || i.change_pct === undefined) ? '' :
      `（${i.change_pct > 0 ? '+' : ''}${num(i.change_pct, 2)}%）`;
    el.innerHTML =
      `<b>今天（${ymd(i.date)}）还在盘中</b>：沪深300 现报 <b>${lvl(i.level)}</b>${chg} · ${i.time || ''}<br>` +
      `估值指标（PE、分位）用的是最近一个<b>已收盘</b>交易日 <b>${pxDay}</b> 的数据。` +
      `今天的收盘数据要等 <b>15:30 之后</b>才生成，所以结论仍是 ${pxDay} 的——这是正常的，不是没刷新。`;
  } else {
    el.className = 'hs-fresh ok';
    el.innerHTML = `数据基准：<b>${pxDay}</b>（最近一个已收盘交易日）。周末与节假日不开盘，不会有新数据。`;
  }
}

// ---------- 结论 ----------
function renderVerdict(d) {
  const hero = $('#hero');
  const c = d.consensus || {};
  if (c.agreed && typeof c.exposure === 'number') {
    hero.classList.remove('wait');
    $('#verdict').textContent = `持有 ${(c.exposure * 100).toFixed(1)}%`;
    $('#verdictSay').innerHTML =
      `三个时间窗口看法<b>一致</b>，沪深300 目标仓位 <b>${(c.exposure * 100).toFixed(1)}%</b>。`;
  } else {
    hero.classList.add('wait');
    $('#verdict').textContent = '什么都不用做';
    const w = d.windows || {};
    const parts = ORDER.filter((k) => w[k]).map((k) => `${WNAME[k]} ${pct(w[k].pe_percentile)}`);
    const gap = (d.consensus && d.consensus.span !== undefined && d.consensus.span !== null)
      ? `（三种看法相差 ${(d.consensus.span / 0.125).toFixed(0)} 档）` : '';
    $('#verdictSay').innerHTML =
      `三个时间窗口看法<b>不一致</b>${gap}：${parts.join(' · ')}。<br>` +
      `分歧通常出现在估值不上不下的中间地带，此时动手没有优势，所以<b>保持现在的仓位不动</b>，等看法统一。`;
  }
}

// ---------- 动作清单：下一买点 / 下一卖点 ----------
// Uses `boundaries`: each row is a PE-percentile boundary with the price level at
// which the ladder target changes.
function renderActions(d) {
  const host = $('#actions');
  host.innerHTML = '';
  const cur = d.pe_percentile;
  const priceNow = d.price_index && d.price_index.level;
  const bounds = d.boundaries || [];

  const row = (cls, tag, head, sub) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="tag ${cls}">${tag}</span>` +
                   `<span class="body">${head}` +
                   (sub ? `<div style="color:#6b7280;font-size:13px;margin-top:4px">${sub}</div>` : '') +
                   `</span>`;
    return li;
  };
  const levelsOf = (b) => ORDER.filter((k) => b.levels && b.levels[k] !== null && b.levels[k] !== undefined)
    .map((k) => `${WNAME[k]} ≤ ${lvl(b.levels[k])}`).join(' 或 ');

  // next buy: the highest boundary strictly BELOW current percentile
  const buys = bounds.filter((b) => b.pct < cur).sort((a, b) => b.pct - a.pct);
  // next sell: the lowest boundary strictly ABOVE current percentile
  const sells = bounds.filter((b) => b.pct > cur).sort((a, b) => a.pct - b.pct);

  if (buys.length) {
    const b = buys[0];
    host.appendChild(row('buy', `加仓到 ${(b.target_below * 100).toFixed(1)}%`,
      `<b>沪深300 跌到这些点位时</b>`, levelsOf(b)));
  } else {
    host.appendChild(row('hold', '已是底档', '没有更低的加仓线了。', ''));
  }

  if (sells.length) {
    const b = sells[0];
    host.appendChild(row('sell', `减仓到 ${(b.target_above * 100).toFixed(1)}%`,
      `<b>沪深300 涨到这些点位时</b>`, levelsOf(b)));
  } else {
    host.appendChild(row('hold', '暂无减仓线', '还没进入减仓区间。', ''));
  }

  host.appendChild(row('now', '当前位置',
    `沪深300 现在 <b>${lvl(priceNow)}</b>，PE 历史分位 <b>${pct(cur)}</b>`, ''));
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
      `<div class="e">建议仓位 ${expo}</div>`;
    host.appendChild(div);
  }
}

// ---------- 阶梯表 ----------
function renderLadder(d) {
  const tbody = $('#ladder tbody');
  tbody.innerHTML = '';
  const cur = d.pe_percentile;
  const bounds = d.boundaries || [];
  // bands derived for DISPLAY ONLY from the boundary rows (no model maths)
  const rows = [
    { lo: 70, hi: 100, target: 0.0 },
    { lo: 60, hi: 70, target: 0.125 },
    { lo: 50, hi: 60, target: 0.375 },
    { lo: 40, hi: 50, target: 0.625 },
    { lo: 30, hi: 40, target: 0.875 },
    { lo: 0, hi: 30, target: 1.0 },
  ];
  for (const r of rows) {
    // the 0-30% band has no boundary row (no lower edge), so its cells are blank
    const b = bounds.find((x) => x.pct === r.lo);
    const tr = document.createElement('tr');
    if (cur >= r.lo && cur < r.hi) tr.className = 'cur';
    const label = r.target === 0 ? '很贵 → 空仓'
      : (r.target === 1 ? '很便宜 → 满仓' : `PE分位 ${r.lo}%–${r.hi}%`);
    const cells = ORDER.map((k) => `<td class="num">${b && b.levels ? lvl(b.levels[k]) : '--'}</td>`).join('');
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

  $('#disclosure').innerHTML = (d.disclosures || []).join('<br>');
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
