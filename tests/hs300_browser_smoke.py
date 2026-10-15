"""Real-browser checks for the HS300 live-analysis terminal.
Run against a running Worker: python tests/hs300_browser_smoke.py [base_url]
"""
import copy
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright
BASE=sys.argv[1].rstrip('/') if len(sys.argv)>1 else 'http://127.0.0.1:8793'
OUT=Path(__file__).resolve().parent.parent/'output'/'playwright'
OUT.mkdir(parents=True,exist_ok=True)

def main():
 checks=[]
 with sync_playwright() as pw:
  browser=pw.chromium.launch(channel='chrome',headless=True)
  page=browser.new_page(viewport={'width':1440,'height':1000})
  errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  def ready():
   page.wait_for_function("!document.querySelector('#refreshButton').disabled && document.querySelector('#priceChart').dataset.bars && !document.querySelector('#errorBanner').textContent",timeout=45000)
  page.goto(BASE+'/hs300',wait_until='networkidle',timeout=45000)
  ready()
  button=page.get_by_role('button',name='刷新',exact=True)
  if page.locator('#autoButton').get_attribute('aria-pressed')=='true':page.locator('#autoButton').click()
  assert int(page.locator('#priceChart').get_attribute('data-bars'))>260
  assert page.locator('#priceChart canvas').count()>0
  assert page.locator('#verdict').inner_text()!='正在分析'
  checks.append('real K-line canvas, MA250 history and current quote analysis render')
  button.click();ready()
  checks.append('manual refresh succeeds without waiting for official new daily bar')
  page.screenshot(path=str(OUT/'hs300-live-desktop.png'),full_page=True)
  page.get_by_role('button',name='3月',exact=True).click()
  page.get_by_role('button',name='收盘',exact=True).click()
  assert page.locator('#priceChart').get_attribute('data-mode')=='line'
  page.get_by_role('button',name='分时',exact=True).click()
  assert page.locator('#priceChart').get_attribute('data-mode')=='intraday'
  page.get_by_role('button',name='K线',exact=True).click()
  checks.append('K-line, close line, intraday view and date ranges switch without exceptions')
  healthy=page.evaluate("async()=>(await fetch('/api/hs300/dashboard')).json()")
  assert healthy['data'].get('analysis')
  healthy['data']['refresh_pending']=False
  endpoint='**/api/hs300/refresh'
  # Reproduce the user's exact confusion: disagreement and a closed market
  # must still show useful arithmetic, without inventing a unified target.
  compare=copy.deepcopy(healthy)
  a=compare['data']['analysis']
  a['quality']={'available':True,'can_decide':False,'reason':'已收盘'}
  a['quote_quality']={'available':True,'can_decide':False,'status':'after_close'}
  a['consensus']={'agreed':False,'exposure':'HOLD','span':.5}
  for key,target,pe,erp in [('full',.375,50.5,81.8),('10y',.875,39.6,86.6),('5y',.375,58.4,73.3)]:
   a['windows'][key].update(exposure=target,pe_percentile=pe,erp_percentile=erp)
  page.route(endpoint,lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps(compare)))
  button.click();ready()
  page.locator('#positionInput').fill('50')
  page.locator('#budgetInput').fill('100000')
  page.get_by_role('button',name='测算我的仓位').click()
  assert '现仓 50.0%' in page.locator('#positionAdvice').inner_text()
  assert '保持 50.0%' in page.locator('#overallPlan').inner_text()
  assert '0 个百分点' in page.locator('#overallPlan').inner_text()
  ten=page.locator('#scenarioRows tr[data-window="10y"]').inner_text()
  assert '87.5%' in ten and '37.5' in ten and '12.5' in ten and '12,500.00' in ten
  assert '增加' in ten
  full=page.locator('#scenarioRows tr[data-window="full"]').inner_text()
  assert '减少' in full and '37.5%' in full and '12,500.00' in full
  assert '50,000.00' in page.locator('#positionSummary').inner_text()
  page.locator('#budgetInput').fill('200000')
  assert '100,000.00' in page.locator('#positionSummary').inner_text()
  assert '25,000.00' in page.locator('#scenarioRows tr[data-window="10y"]').inner_text()
  page.locator('#budgetInput').fill('')
  assert '填写金额后显示' in page.locator('#scenarioRows').inner_text()
  assert page.locator('#scenarioRows tr').count()==3
  page.locator('#budgetInput').fill('100000')
  assert '不是让你持有10年' in page.locator('.hs-window-intro').inner_text()
  assert '股债利差历史位置 86.6%' in page.locator('#windows').inner_text()
  assert '单窗口参考仓位 87.5%' in page.locator('#windows').inner_text()
  page.locator('#windows details').nth(1).locator('summary').click()
  assert 'ERP闸门' in page.locator('#windows details').nth(1).inner_text()
  page.locator('#positionInput').fill('0')
  assert '现仓 0.0%' in page.locator('#overallPlan').inner_text()
  page.locator('#positionInput').fill('101')
  assert page.locator('#calculatorResults').is_hidden()
  page.locator('#positionInput').fill('50')
  assert not page.locator('#calculatorResults').is_hidden()
  page.screenshot(path=str(OUT/'hs300-position-desktop.png'),full_page=True)
  checks.append('disagreement and closed market still show holdings, zero overall action and separately labelled window scenarios in yuan')
  checks.append('window labels explain comparison period, PE rank, ERP rank and single-window reference exposure')
  checks.append('visible calculate button scrolls to results; input changes recalculate; zero valid and out-of-range input rejected')
  page.unroute(endpoint)
  page.route(endpoint,lambda route:route.fulfill(status=503,content_type='application/json',body='{}'))
  page.route('**/api/hs300/dashboard',lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps(healthy)))
  button.click();ready()
  checks.append('temporary 503 recovers through a bounded dashboard read')
  page.unroute('**/api/hs300/dashboard')
  page.route('**/api/hs300/dashboard',lambda route:route.fulfill(status=503,content_type='application/json',body='{}'))
  button.click()
  page.wait_for_function("document.querySelector('#errorBanner').textContent.includes('503')")
  assert button.is_enabled()
  assert page.locator('#priceChart canvas').count()>0
  assert '上次报价' in page.locator('#freshBanner').inner_text()
  checks.append('persistent connection failure preserves analysis and chart; marks quote offline')
  page.unroute(endpoint);page.unroute('**/api/hs300/dashboard')
  page.locator('#positionInput').fill('25')
  test=copy.deepcopy(healthy)
  a=test['data']['analysis']
  a['price']=3800;a['pe']=11.7;a['time']='14:00:00'
  a['quality']={'available':True,'can_decide':True,'reason':'按当前报价即时测算'}
  a['quote_quality']={'available':True,'can_decide':True,'status':'trading'}
  a['consensus']={'agreed':True,'exposure':0.625,'span':0}
  for row in a['windows'].values():row['exposure']=0.625
  page.route(endpoint,lambda route:route.fulfill(status=200,content_type='application/json',body=json.dumps(test)))
  button.click();ready()
  assert '3,800' in page.locator('#topPrice').inner_text()
  assert '62.5%' in page.locator('#targetExposure').inner_text()
  assert '增加' in page.locator('#positionAdvice').inner_text()
  assert '12.5' in page.locator('#positionAdvice').inner_text()
  checks.append('changed current quote updates analysis immediately; actual position gives bounded buy step')
  page.locator('#positionInput').fill('100')
  assert '减少' in page.locator('#positionAdvice').inner_text()
  checks.append('position changes instantly recompute direction and one-step amount')
  a['quality']['can_decide']=False;a['quote_quality']['status']='delayed'
  button.click();ready()
  assert '延迟' in page.locator('#quoteBadge').inner_text()
  assert '不把情景转换成交易动作' in page.locator('#positionAdvice').inner_text()
  assert '12,500.00' in page.locator('#scenarioRows').inner_text()
  checks.append('stale quote retains current valuation but blocks an executable amount')
  page.unroute(endpoint)
  page.route(endpoint,lambda route:route.fulfill(status=200,content_type='application/json',body='not-json'))
  button.click()
  page.wait_for_function("!document.querySelector('#errorBanner').hidden")
  assert button.is_enabled()
  checks.append('malformed JSON restores the button and dated previous analysis')
  page.unroute(endpoint)
  button.click();ready()
  assert not page.locator('#errorBanner').is_visible()
  checks.append('subsequent real refresh recovers after injected failures')
  page.get_by_role('button',name='6月',exact=True).click()
  page.screenshot(path=str(OUT/'hs300-live-desktop.png'),full_page=True)
  page.set_viewport_size({'width':390,'height':844})
  page.wait_for_timeout(300)
  assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+2')
  assert page.locator('#priceChart').bounding_box()['height']>=300
  page.locator('#positionInput').fill('50')
  page.get_by_role('button',name='测算我的仓位').click()
  assert page.locator('#scenarioRows tr').count()==3
  page.screenshot(path=str(OUT/'hs300-live-mobile.png'),full_page=True)
  assert not errors,errors
  checks.append('mobile view fits viewport and chart; no page JavaScript errors')
  browser.close()
 (OUT/'browser-checks.json').write_text(json.dumps({'base':BASE,'checks':checks},ensure_ascii=False,indent=2),encoding='utf-8')
 for c in checks:print('PASS',c)
if __name__=='__main__':main()
