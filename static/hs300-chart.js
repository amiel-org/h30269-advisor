let chart, primary, resize, mode = 'candles', range = 132, payload;
let priceLines = [];
const $ = (s) => document.querySelector(s);
const fmt = (v) => Number.isFinite(v) ? v.toFixed(2) : '--';

export function renderMarketChart(data, { reset = false } = {}) {
  payload = data;
  const L = window.LightweightCharts, box = $('#priceChart');
  if (!L || !box) throw new Error('K线图表库未能加载，请刷新页面');
  const oldRange = !reset && chart?.timeScale().getVisibleLogicalRange();
  if (resize) resize.disconnect();
  if (chart) chart.remove();
  box.replaceChildren();
  chart = L.createChart(box, {
    width: box.clientWidth, height: box.clientHeight,
    layout: { background: { type: L.ColorType.Solid, color: '#ffffff' }, textColor: '#7b858c', fontSize: 10, fontFamily: 'Microsoft YaHei, Arial' },
    grid: { vertLines: { color: '#f1f3f2' }, horzLines: { color: '#e9eeeb' } },
    rightPriceScale: { borderColor: '#dce2df', scaleMargins: { top: .12, bottom: .12 } },
    timeScale: { borderColor: '#dce2df', timeVisible: mode === 'intraday', secondsVisible: false, rightOffset: 7, barSpacing: 6 },
    crosshair: { mode: L.CrosshairMode.Normal },
    localization: { locale: 'zh-CN', priceFormatter: fmt },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
  });
  const pc = data.price_chart || {}, allBars = pc.bars || [];
  $('#chartEmpty').hidden = allBars.length > 0 || (pc.intraday || []).length > 0;
  const readout = (bar, previous) => {
    for (const [selector, field] of [['#openValue', 'open'], ['#highValue', 'high'], ['#lowValue', 'low'], ['#ohlcCloseValue', 'close']]) $(selector).textContent = fmt(bar?.[field]);
    const change = previous > 0 && bar?.close > 0 ? (bar.close / previous - 1) * 100 : data.analysis?.change_pct;
    $('#changeValue').textContent = Number.isFinite(change) ? `${change > 0 ? '+' : ''}${change.toFixed(2)}%` : '--';
    $('#changeValue').className = change >= 0 ? 'up' : 'down';
  };
  const last = allBars.at(-1);
  readout(last, allBars.at(-2)?.close);
  if (mode === 'intraday') {
    chart.applyOptions({ localization: { timeFormatter: (t) => new Date(t * 1000).toLocaleTimeString('zh-CN', {timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit'}) },
      timeScale: { tickMarkFormatter: (t) => typeof t === 'number' ? new Date(t*1000).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'}) : '' } });
    const a = data.analysis || {};
    const points = (pc.intraday || []).map((p) => ({ time: Math.floor(Date.parse(`${a.date?.slice(0,4)}-${a.date?.slice(4,6)}-${a.date?.slice(6,8)}T${p.time}+08:00`) / 1000), value: p.value }));
    const unique = [...new Map(points.filter((p) => Number.isFinite(p.time) && p.value > 0).map((p) => [p.time, p])).values()].sort((a,b) => a.time-b.time);
    primary = chart.addAreaSeries({ lineColor: '#386fd6', topColor: '#386fd61e', bottomColor: '#386fd600', lineWidth: 2, priceLineVisible: true });
    primary.setData(unique);
    $('#chartEmpty').hidden = unique.length > 0;
    $('#chartEmpty').textContent = '当前报价源未提供分时轨迹，可切换日K查看。';
    if (a.previous_close > 0) primary.createPriceLine({ price: a.previous_close, color: '#a1aaa5', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '昨收' });
    $('#chartNotice').textContent = '当日真实分时轨迹 · 鼠标查看具体时点';
    chart.timeScale().fitContent();
  } else {
    const lines = allBars.map((b) => ({ time: b.time, value: b.close }));
    if (mode === 'candles') {
      primary = chart.addCandlestickSeries({ upColor: '#e83238', downColor: '#07805d', borderUpColor: '#e83238', borderDownColor: '#07805d', wickUpColor: '#e83238', wickDownColor: '#07805d', priceLineVisible: true });
      primary.setData(allBars.map((b) => b.candle_valid ? { time:b.time, open:b.open, high:b.high, low:b.low, close:b.close } : {time:b.time}));
      const closeLine = chart.addLineSeries({ color: '#a0b2bc', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      closeLine.setData(lines);
    } else {
      primary = chart.addLineSeries({ color: '#386fd6', lineWidth: 2, priceLineVisible: true }); primary.setData(lines);
    }
    for (const [key,color,width] of [['ma20','#5d7ce2',1],['ma60','#e28831',1],['ma250','#15a38b',2]]) {
      const s=chart.addLineSeries({color,lineWidth:width,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false});
      s.setData(allBars.map((b,i)=>({time:b.time,value:pc[key]?.[i]})).filter((p)=>Number.isFinite(p.value)));
    }
    const byTime=new Map(allBars.map((b,i)=>[b.time,i]));
    chart.subscribeCrosshairMove((p)=>{
      const time=typeof p.time==='string'?p.time:p.time?`${p.time.year}-${String(p.time.month).padStart(2,'0')}-${String(p.time.day).padStart(2,'0')}`:null;
      const i=byTime.get(time);
      readout(i===undefined?last:allBars[i],i===undefined?allBars.at(-2)?.close:allBars[i-1]?.close);
    });
    if (oldRange) chart.timeScale().setVisibleLogicalRange(oldRange);
    else chart.timeScale().setVisibleLogicalRange({from:Math.max(0,allBars.length-range),to:allBars.length+6});
    $('#chartNotice').textContent=last?.provisional?'最后一根为当日动态K线，未计作收盘确认':allBars.some((b)=>!b.candle_valid)?'缺少OHLC的历史日期仅显示收盘线':'真实日K · 缩放拖动 · 十字光标';
  }
  priceLines=[];
  const levels=data.analysis?.conditional_levels;
  // Distant valuation lines would flatten all candles. Draw nearby lines on
  // the main scale; distant levels remain explicitly visible in the rail.
  const center=data.analysis?.price;
  for(const [key,color,title] of [['buy','#cf3842','加仓观察'],['sell','#07805d','减仓观察']]){
    const value=levels?.[key]?.level;
    if(value>0&&center>0&&Math.abs(value/center-1)<.15) priceLines.push(primary.createPriceLine({price:value,color,lineWidth:1,lineStyle:2,axisLabelVisible:true,title}));
  }
  $('#maRuler').replaceChildren(...[20,30,60,120,250].map((period)=>{
    const value=pc[`ma${period}`]?.at(-1),diff=value>0&&center>0?(center/value-1)*100:null;
    const div=document.createElement('div');div.className='ma-item';
    div.innerHTML=`<span>MA${period}</span><strong>${fmt(value)}</strong><em class="${diff>=0?'above':'below'}">${diff===null?'--':`${diff>=0?'+':''}${diff.toFixed(1)}%`}</em>`;return div;
  }));
  resize=new ResizeObserver(()=>chart.applyOptions({width:box.clientWidth,height:box.clientHeight}));resize.observe(box);
  box.dataset.bars=String(allBars.length);box.dataset.mode=mode;box.dataset.provisional=String(Boolean(last?.provisional));
}

export function initChartControls(){
  document.querySelectorAll('[data-mode]').forEach((button)=>button.addEventListener('click',()=>{
    mode=button.dataset.mode;document.querySelectorAll('[data-mode]').forEach((b)=>b.classList.toggle('active',b===button));
    if(payload)renderMarketChart(payload,{reset:true});
  }));
  document.querySelectorAll('[data-range]').forEach((button)=>button.addEventListener('click',()=>{
    range=Number(button.dataset.range);document.querySelectorAll('[data-range]').forEach((b)=>b.classList.toggle('active',b===button));
    if(mode==='intraday'){mode='candles';document.querySelectorAll('[data-mode]').forEach((b)=>b.classList.toggle('active',b.dataset.mode===mode));}
    if(payload)renderMarketChart(payload,{reset:true});
  }));
}
