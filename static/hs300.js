import { initChartControls, renderMarketChart } from '/static/hs300-chart.js';
import { calculatePosition } from '/static/hs300-position.js';
const $=(s)=>document.querySelector(s);
const num=(v,d=2)=>Number.isFinite(v)?v.toLocaleString('zh-CN',{minimumFractionDigits:d,maximumFractionDigits:d}):'--';
const pct=(v,d=1)=>Number.isFinite(v)?`${num(v,d)}%`:'--';
const ymd=(d)=>d?.length===8?`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`:d||'--';
const ORDER=['full','10y','5y'];
const LABEL={full:'全部历史', '10y':'近10年', '5y':'近5年'};
let lastData=null,busy=false,pollTimer=null,polls=0,auto=true,localOffline=false;
const signed=(v,d=2)=>Number.isFinite(v)?`${v>0?'+':''}${num(v,d)}`:'--';
function renderEtfFlows(data){
 $('#flowsAsOf').textContent=data.as_of?`${ymd(data.as_of)} · ${data.status==='fresh'?'已更新':'参考快照'}`:'暂不可用';
 $('#flowRatio').textContent=pct(data.ratio_pct,3);
 $('#flowValue').textContent=Number.isFinite(data.total_market_value)?`四只ETF合计 ${num(data.total_market_value/1e8,0)} 亿元`:'--';
 for(const [days,suffix]of[[5,'5'],[20,'20']]){
  const ratio=data[`ratio_change_${days}d_pp`],shares=data[`shares_change_${days}d_pct`];
  $(`#flowRatio${suffix}`).textContent=Number.isFinite(ratio)?`${signed(ratio,3)} 个百分点`:'样本积累中';
  $(`#flowShares${suffix}`).textContent=Number.isFinite(shares)?`四只ETF总份额 ${signed(shares,2)}%`:`需至少 ${days+1} 个交易快照`;
 }
 const rows=data.history||[];
 $('#flowSparkline').innerHTML=rows.length>1?`<svg viewBox="0 0 800 90" preserveAspectRatio="none" aria-hidden="true"><polyline points="${rows.map((r,i)=>`${i/(rows.length-1)*800},${80-(r.ratio_pct/Math.max(...rows.map(x=>x.ratio_pct)))*65}`).join(' ')}"/></svg><span>系统已留存 ${rows.length} 个交易快照 · 仅展示占比相对走势</span>`:'';
 $('#flowNotice').textContent=data.warning||(rows.length<6?'历史从本次启用开始积累；当前占比可用，5日/20日变化将在样本足够后自动出现。':'规模与份额分开观察；不把规模上升直接解释为托底买入。');
}
async function loadEtfFlows(force=false){try{const body=await request(`/api/hs300/etf-flows${force?'?refresh=1':''}`,'GET',10000);renderEtfFlows(body.data||{});}catch{renderEtfFlows({status:'unavailable',warning:'资金观察暂时连接失败，不影响上方估值与仓位分析。'});}}
try { for(const [id,key]of[['positionInput','hs300.position'],['budgetInput','hs300.budget']]){const value=localStorage.getItem(key);if(value!==null)$('#'+id).value=value;} } catch {}
const showError=(text)=>{$('#errorBanner').hidden=false;$('#errorBanner').textContent=text;};
function quoteLabel(a){return {trading:'盘中即时测算',after_close:'收盘报价测算',lunch_break:'午间报价测算',before_open:'开盘前参考',delayed:'延迟报价测算',previous_session:'上一交易日报价',missing:'正式收盘参考',invalid:'行情时间异常'}[a.quote_quality?.status]||'当前点位测算';}
const money=(value)=>Number.isFinite(value)?`${num(value,2)} 元`:'未填资金池';
const pp=(value)=>`${num(Math.abs(value)*100,1)} 个百分点`;
function renderPosition(){
 const result=calculatePosition(lastData,$('#positionInput').value,$('#budgetInput').value);
 const box=$('#calculatorResults');
 if(!result.valid){box.hidden=true;$('#positionAdvice').textContent=result.reason;$('#calculatorMessage').textContent=result.reason;return;}
 box.hidden=false;
 const a=result.analysis,c=result.overall,capital=result.capital;
 const currentText=`现仓 ${pct(result.current*100)}`;
 const stage=localOffline?'当前连接中断':result.mode==='settled_review'?'正式收盘复核':quoteLabel(a);
 $('#calculatorMessage').textContent=`已计算：${currentText}；${capital===null?'未填写资金池金额，先展示比例。':`资金池 ${money(capital)}。`} ${stage}，下列情景仍可查看。`;
 $('#positionSummary').replaceChildren(...[
  ['你已持有',`${pct(result.current*100)}${capital===null?'':` / ${money(result.holdings)}`}`],
  ['剩余现金',`${pct((1-result.current)*100)}${capital===null?'':` / ${money(result.cash)}`}`],
  ['整体规则本次调整',`${result.agreed?c.move>0?'增加 '+pp(c.move):c.move<0?'减少 '+pp(c.move):'0 个百分点':'0 个百分点'}${!result.canAct||localOffline?' · 仅试算':''}`],
 ].map(([label,value])=>{const div=document.createElement('div');const span=document.createElement('span');span.textContent=label;const strong=document.createElement('strong');strong.textContent=value;div.append(span,strong);return div;}));
 let conclusion;
 if(!result.analysisAvailable){conclusion=`${currentText}。行情基准未通过有效性检查，下面只保留已有数字的条件试算，不生成交易动作。`;}
 else if(!result.agreed){conclusion=`${currentText} → 保持 ${pct(result.current*100)}，本次调整 0 个百分点${capital===null?'':`（0.00 元）`}。原因是三个窗口没有统一目标，并不是没有完成计算。`;
 }else if(c.move===0){conclusion=`${currentText}，统一目标 ${pct(c.target*100)}；相差 ${pp(c.gap)}，在 ${pp(result.deadband)}死区以内，本次不调整${capital===null?'':`（0.00 元）`}。`;
 }else{conclusion=`${currentText}，统一目标 ${pct(c.target*100)}，总差额为${c.gap>0?'还差':'多出'} ${pp(c.gap)}。假设下一次只走一档：${c.move>0?'增加':'减少'} ${pp(c.move)}${capital===null?'':`（${money(Math.abs(c.moveAmount))}）`}，仓位变为 ${pct(c.after*100)}。`;
 }
 if(!result.canAct||localOffline)conclusion+=` ${result.agreed?'这是试算结果，':'下方分窗口只是比较。'}${localOffline?'连接未恢复':result.reasons.join('；')||stage}，当前不把情景转换成交易动作。`;
 else if(c.move!==0)conclusion+=result.mode==='intraday'?' 这是盘中条件执行方案，收盘后还需复核；实际成交后请更新仓位。':' 这是正式收盘复核方案，请在下一可交易时段执行，不要重复下单。';
 $('#positionAdvice').textContent=conclusion;$('#overallPlan').textContent=conclusion;
 $('#scenarioRows').replaceChildren(...result.rows.map((row)=>{
  const tr=document.createElement('tr');tr.dataset.window=row.key;
  const moveText=!Number.isFinite(row.target)?'历史不足':row.move===0?`保持 ${pct(result.current*100)}（差在死区内）`:`${row.move>0?'增加':'减少'} ${pp(row.move)} → ${pct(row.after*100)}`;
  const cells=[LABEL[row.key],Number.isFinite(row.target)?pct(row.target*100):'--',Number.isFinite(row.gap)?Math.abs(row.gap)<1e-9?'正好相同':`${row.gap>0?'还差':'多出'} ${pp(row.gap)}`:'--',moveText,capital===null?'填写金额后显示':!Number.isFinite(row.moveAmount)?'--':row.move===0?'0.00 元':`${row.move>0?'买入约':'卖出约'} ${money(Math.abs(row.moveAmount))}`];
  cells.forEach(text=>{const td=document.createElement('td');td.textContent=text;tr.append(td);});return tr;
 }));
 $('#scenarioNote').textContent=`参考仓位是最终方向，每次试算最多 ${pp(result.step)}，仓位差不超过 ${pp(result.deadband)}则不调整。金额按资金池市值粗算，未扣费用、未按ETF交易单位取整；不能把三个情景一起执行。`;
}
function renderWindows(a){
 $('#windows').replaceChildren(...ORDER.map(key=>{
  const w=a.windows[key]||{},div=document.createElement('div');div.className=`hs-window ${a.consensus?.agreed?'agreed':''}`;
  const add=(className,text)=>{const node=document.createElement('div');node.className=className;node.textContent=text;div.append(node);return node;};
  add('name',key==='full'?'全部可用历史':key==='10y'?'按最近约10年比较':'按最近约5年比较');
  add('sample',w.history_start?`${ymd(w.history_start)} — ${ymd(w.history_end)} · ${w.sample_count}条日线`:key==='full'?'全部可用历史日线':key==='10y'?'最近2440条日线；不足时用已有样本':'最近1220条日线；不足时用已有样本');
  add('metric-label','PE历史位置');add('value',pct(w.pe_percentile));
  add('rank-explain',Number.isFinite(w.pe_percentile)?`当前PE比约 ${num(w.pe_percentile,1)}% 的历史记录高`:'PE历史不足');
  const erp=add('erp-explain','');
  const strong=document.createElement('strong');strong.textContent=`股债利差历史位置 ${pct(w.erp_percentile)}`;erp.append(strong);
  const plain=document.createElement('span');plain.textContent=Number.isFinite(w.erp_percentile)?`当前利差高于约 ${num(w.erp_percentile,1)}% 的历史记录；越高，盈利收益率相对国债越有吸引力。`:'股债利差历史不足';erp.append(plain);
  add('expo',`单窗口参考仓位 ${pct(Number.isFinite(w.exposure)?w.exposure*100:null)}`);
  add('budget-example',Number.isFinite(w.exposure)?`若资金池10万元，参考持仓 ${num(w.exposure*100000,0)} 元`:'无法计算参考持仓');
  const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='这个仓位怎么算';details.append(summary);
  const p=document.createElement('p');p.textContent=Number.isFinite(w.pe_cap)&&Number.isFinite(w.erp_cap)?`PE阶梯允许 ${pct(w.pe_cap*100)}，ERP闸门允许 ${pct(w.erp_cap*100)}；取较小值，再向下落到12.5个百分点的档位，得到 ${pct(w.exposure*100)}。`:'先按PE历史位置确定仓位上限，再经过股债利差闸门，并向下取整至12.5个百分点档位。';details.append(p);div.append(details);
  return div;
 }));
}

function render(data){
 if(!data.analysis)throw new Error('盘中分析尚在升级，请稍后刷新');
 const a=data.analysis,c=a.consensus||{},available=a.quality?.available,stale=!a.quality?.can_decide;
 const agreed=c.agreed&&Number.isFinite(c.exposure);
 const title=!available?'数据待恢复':agreed?`目标 ${pct(c.exposure*100)}`:'暂不调仓';
 $('#verdict').textContent=title;$('#topVerdict').textContent=title;
 $('#analysisMode').textContent=quoteLabel(a);
 $('#quoteBadge').textContent=localOffline?'连接中断':a.quote_quality?.status==='trading'?'行情及时':a.quote_quality?.status==='delayed'?'行情延迟':'最近报价';
 $('#hero').className=`action-rail ${agreed&&c.exposure>=.625?'tone-buy':agreed&&c.exposure<=.125?'tone-sell':'tone-hold'}`;
 const targets=ORDER.map(k=>`${LABEL[k]}参考仓位 ${pct(Number.isFinite(a.windows?.[k]?.exposure)?a.windows[k].exposure*100:null)}`).join(' / ');
 $('#verdictSay').textContent=agreed?`当前点位 ${num(a.price)}，三窗口目标一致。填入你的现仓，可立即比较增减方向。${stale?' 当前为参考测算。':''}`:`三段历史算出的参考仓位不同：${targets}。当前没有统一目标；填写仓位后，可看保持不动的整体结果和各窗口情景。`;
 $('#targetExposure').textContent=agreed?pct(c.exposure*100):'不触发调仓';
 $('#targetDetail').textContent=agreed?'目标占沪深300策略资金池的比例':'三个窗口没有共同目标；现仓保持不动，下面仍可试算';
 $('#topPrice').textContent=num(a.price);$('#topPe').textContent=`${num(a.pe)} / ${pct(a.pe_percentile)}`;$('#topErp').textContent=pct(a.erp,2);
 $('#topQuoteTime').textContent=`${ymd(a.date)} ${a.time||'日线'}`;
 $('#closeValue').textContent=num(a.price);$('#closeValue').className=a.change_pct>=0?'up':'down';$('#closeDate').textContent=`${ymd(a.date)} ${a.time||''} · ${a.source}`;
 $('#priceLabel').textContent=a.mode==='quote_estimate'?'当前报价':'收盘基准';
 const fresh=$('#freshBanner');fresh.className=`hs-fresh${stale||data.source_warning||localOffline?' warning':''}`;
 fresh.textContent=`${quoteLabel(a)} · ${ymd(a.date)} ${a.time||''} · ${a.source}。PE ${num(a.pe)}、ERP ${pct(a.erp,2)}、三窗口目标均按该点位计算。盈利基准 ${ymd(a.baseline.date)}；国债 ${ymd(a.bond.as_of)}。`+(data.source_warning?' 历史基准核验暂不可用，当前结果带此限制。':'')+(a.quote_quality?.status==='delayed'?' 报价已延迟，暂停新增动作。':'')+(localOffline?' 连接暂未恢复，当前为上次报价分析。':'');
 $('#settledSummary').textContent=`${ymd(data.price_asof)} · ${num(data.price_index?.level)} · PE ${num(data.pe)}`;
 const ex=data.execution||{};$('#confirmationText').textContent=`原收盘策略：同目标已确认 ${ex.confirmed_closes||0} 次收盘。盘中刷新不增加确认次数。`;
 $('#px').textContent=num(a.price);$('#pe').textContent=num(a.pe);$('#pep').textContent=pct(a.pe_percentile);$('#erp').textContent=pct(a.erp,2);
 $('#basePx').textContent=num(data.price_index?.level);$('#basePe').textContent=num(data.pe);$('#basePep').textContent=pct(data.pe_percentile);$('#baseErp').textContent=pct(data.erp,2);
 $('#valuationNote').textContent=a.assumptions;
 renderWindows(a);
 const actions=$('#actions');actions.replaceChildren();
 for(const [kind,label]of[['buy','加仓观察'],['sell','减仓观察']]){
  const line=a.conditional_levels?.[kind],li=document.createElement('li');
  const distance=line?.level>0?(line.level/a.price-1)*100:null;
  li.innerHTML=`<span class="tag ${kind}">${label}</span><span class="body">${line?`<b>${num(line.level,0)}</b> 距当前 ${distance>0?'+':''}${pct(distance,2)}<small>该点位三窗口目标 ${pct(line.target*100)}；每次最多12.5个百分点，需结合真实仓位。</small>`:'当前假设下暂无对应的统一观察线。'}</span>`;actions.append(li);
 }
 const note=document.createElement('li');note.innerHTML='<span class="tag">测算假设</span><span class="body"></span>';note.querySelector('.body').textContent=a.conditional_levels?.assumption||'等待足够的数据，暂不生成观察线。';actions.append(note);
 const rows=data.ladder||[];$('#ladder tbody').replaceChildren(...rows.map((r,i)=>{const hi=rows[i-1]?.lo??100,lo=r.lo??0,tr=document.createElement('tr');if(a.pe_percentile>=lo&&a.pe_percentile<(i===0?101:hi))tr.className='current';tr.innerHTML=`<td>${r.lo===null?`低于${hi}%`:i===0?`≥${lo}%`:`${lo}–${hi}%`}</td><td>${pct(r.target*100)}</td>${ORDER.map(k=>`<td>${num(r.levels?.[k],0)}</td>`).join('')}`;return tr;}));
 const bt=data.backtest||{};$('#cagr').textContent=pct(bt.cagr_calendar_pct,2);$('#mdd').textContent=pct(bt.max_drawdown_pct,2);$('#sharpe').textContent=num(bt.sharpe);$('#avgExp').textContent=`${pct(bt.avg_exposure*100)} / ${bt.trades??'--'} 次`;$('#buyHold').textContent=`${pct(bt.buy_hold?.cagrCalendarPct,2)} / ${pct(bt.buy_hold?.maxDrawdownPct,2)}`;
 $('#backtestPeriod').textContent=`${ymd(bt.start)} 至 ${ymd(bt.end)}。这是收盘规则的样本内结果，盘中辅助方案没有独立盘中验证或实盘业绩。`;
 $('#disclosure').textContent=(data.disclosures||[]).join(' ');
 renderMarketChart(data);renderPosition();if(window.lucide)window.lucide.createIcons();
}
async function request(url,method,ms){const c=new AbortController(),timer=setTimeout(()=>c.abort(),window.HS300_REQUEST_TIMEOUT_MS||ms);try{const r=await fetch(url,{method,cache:'no-store',signal:c.signal});if(!r.ok){const e=new Error(`接口返回 HTTP ${r.status}`);e.retryable=r.status>=500;throw e;}return await r.json();}finally{clearTimeout(timer);}}
async function load(force=false){
 if(busy)return;busy=true;clearTimeout(pollTimer);$('#refreshButton').disabled=true;$('#refreshButton').textContent='刷新中…';$('#errorBanner').hidden=true;$('#errorBanner').textContent='';
 try{let body;try{body=await request(force?'/api/hs300/refresh':'/api/hs300/dashboard',force?'POST':'GET',force?16000:28000);}catch(e){if(!e.retryable&&e.name!=='AbortError'&&!(e instanceof TypeError))throw e;body=await request('/api/hs300/dashboard','GET',7000);}
 if(!body.ok||!body.data?.analysis||!body.data?.consensus)throw new Error(body.error||'接口数据结构异常');
 lastData=body.data;localOffline=false;render(lastData);loadEtfFlows(force);$('#asOfText').textContent=body.data.refresh_pending?'更新报价中':`${ymd(lastData.analysis.date)} ${lastData.analysis.time||'收盘'}`;
 if(body.data.refresh_pending&&polls<6){polls++;pollTimer=setTimeout(()=>load(false),2500);}else polls=0;
 }catch(e){showError(e.name==='AbortError'?'加载超时：已保留上次分析，请稍后重试。':`加载失败：${e.message}`);$('#asOfText').textContent='连接失败，可重试';localOffline=true;
 if(lastData){render(lastData);}else{$('#verdict').textContent='数据待恢复';$('#verdictSay').textContent='暂未取得可分析行情，请点击刷新重试。';}
 }finally{busy=false;$('#refreshButton').disabled=false;$('#refreshButton').textContent='刷新';}
}
$('#refreshButton').addEventListener('click',()=>{polls=0;load(true);});
$('#autoButton').addEventListener('click',()=>{auto=!auto;$('#autoButton').textContent=auto?'自动 30秒':'自动已暂停';$('#autoButton').classList.toggle('active',auto);$('#autoButton').setAttribute('aria-pressed',String(auto));});
for(const [id,key]of[['positionInput','hs300.position'],['budgetInput','hs300.budget']])$('#'+id).addEventListener('input',()=>{try{localStorage.setItem(key,$('#'+id).value);}catch{}renderPosition();});
$('#calculateButton').addEventListener('click',()=>{renderPosition();$('#positionCalculator').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});});
setInterval(()=>{if(auto&&!document.hidden)load(false);},30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&auto)load(false);});
initChartControls();load(false);if(window.lucide)window.lucide.createIcons();
