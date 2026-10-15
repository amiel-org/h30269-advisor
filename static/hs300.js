import { initChartControls, renderMarketChart } from '/static/hs300-chart.js';
const $=(s)=>document.querySelector(s);
const num=(v,d=2)=>Number.isFinite(v)?v.toLocaleString('zh-CN',{minimumFractionDigits:d,maximumFractionDigits:d}):'--';
const pct=(v,d=1)=>Number.isFinite(v)?`${num(v,d)}%`:'--';
const ymd=(d)=>d?.length===8?`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`:d||'--';
const ORDER=['full','10y','5y'];
const LABEL={full:'全部历史', '10y':'近10年', '5y':'近5年'};
let lastData=null,busy=false,pollTimer=null,polls=0,auto=true,localOffline=false;
try { const v=localStorage.getItem('hs300.position'); if(v!==null)$('#positionInput').value=v; } catch {}
const showError=(text)=>{$('#errorBanner').hidden=false;$('#errorBanner').textContent=text;};
function quoteLabel(a){return {trading:'盘中即时测算',after_close:'收盘报价测算',lunch_break:'午间报价测算',before_open:'开盘前参考',delayed:'延迟报价测算',previous_session:'上一交易日报价',missing:'正式收盘参考',invalid:'行情时间异常'}[a.quote_quality?.status]||'当前点位测算';}
function renderPosition(){
 if(!lastData)return;
 const a=lastData.analysis,c=a?.consensus||{},input=$('#positionInput');
 const raw=input.value,w=Number(raw)/100;
 if(raw===''||!Number.isFinite(w)||w<0||w>1){$('#positionAdvice').textContent='填入0–100%的实际仓位，计算与你的资金池对应的调整幅度。';return;}
 if(!a.quality?.can_decide||localOffline){$('#positionAdvice').textContent=`${quoteLabel(a)}：可以看当前目标，但本次不生成可执行交易比例。开盘且报价及时后自动重算。`;return;}
 if(!c.agreed||!Number.isFinite(c.exposure)){$('#positionAdvice').textContent='当前三窗口目标仍分歧：按这套规则暂不调仓。你的现仓已记录，目标一致后即时比较。';return;}
 const gap=c.exposure-w,step=lastData.execution?.step_size||.125,deadband=lastData.execution?.deadband||.05;
 if(Math.abs(gap)<=deadband+1e-9){$('#positionAdvice').textContent=`现仓 ${pct(w*100)}，目标 ${pct(c.exposure*100)}，差在5个百分点以内，暂不调整。`;return;}
 const move=Math.min(Math.abs(gap),step),after=w+(gap>0?move:-move);
 $('#positionAdvice').textContent=`盘中试算：可考虑${gap>0?'增加':'减少'} ${num(move*100,1)} 个百分点，仓位 ${pct(w*100)} → ${pct(after*100)}。本日实际执行最多一档；本页不记录成交，不要按多次刷新重复执行。`;
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
 const targets=ORDER.map(k=>`${LABEL[k]} ${pct(a.windows?.[k]?.exposure*100)}`).join(' / ');
 $('#verdictSay').textContent=agreed?`当前点位 ${num(a.price)}，三窗口目标一致。填入你的现仓，可立即比较增减方向。${stale?' 当前为参考测算。':''}`:`当前点位下三个目标分歧：${targets}。按现有规则保持仓位，继续盯下方观察线。`;
 $('#targetExposure').textContent=agreed?pct(c.exposure*100):'窗口分歧';
 $('#targetDetail').textContent=agreed?'目标占沪深300策略资金池的比例':'各窗口目标见下方，不能取平均冒充统一结论';
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
 $('#windows').replaceChildren(...ORDER.map(k=>{const w=a.windows[k],div=document.createElement('div');div.className=`hs-window ${c.agreed?'agreed':''}`;div.innerHTML=`<div class="name">${LABEL[k]}</div><div class="value">${pct(w?.pe_percentile)}</div><div class="detail">PE 分位<br>ERP 分位 ${pct(w?.erp_percentile)}</div><div class="expo">目标 ${pct(w?.exposure*100)}</div>`;return div;}));
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
 lastData=body.data;localOffline=false;render(lastData);$('#asOfText').textContent=body.data.refresh_pending?'更新报价中':`${ymd(lastData.analysis.date)} ${lastData.analysis.time||'收盘'}`;
 if(body.data.refresh_pending&&polls<6){polls++;pollTimer=setTimeout(()=>load(false),2500);}else polls=0;
 }catch(e){showError(e.name==='AbortError'?'加载超时：已保留上次分析，请稍后重试。':`加载失败：${e.message}`);$('#asOfText').textContent='连接失败，可重试';localOffline=true;
 if(lastData){render(lastData);}else{$('#verdict').textContent='数据待恢复';$('#verdictSay').textContent='暂未取得可分析行情，请点击刷新重试。';}
 }finally{busy=false;$('#refreshButton').disabled=false;$('#refreshButton').textContent='刷新';}
}
$('#refreshButton').addEventListener('click',()=>{polls=0;load(true);});
$('#autoButton').addEventListener('click',()=>{auto=!auto;$('#autoButton').textContent=auto?'自动 30秒':'自动已暂停';$('#autoButton').classList.toggle('active',auto);$('#autoButton').setAttribute('aria-pressed',String(auto));});
$('#positionInput').addEventListener('input',()=>{try{localStorage.setItem('hs300.position',$('#positionInput').value);}catch{}renderPosition();});
setInterval(()=>{if(auto&&!document.hidden)load(false);},30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&auto)load(false);});
initChartControls();load(false);if(window.lucide)window.lucide.createIcons();
