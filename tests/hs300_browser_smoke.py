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
  assert '不生成可执行' in page.locator('#positionAdvice').inner_text()
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
  page.screenshot(path=str(OUT/'hs300-live-mobile.png'),full_page=True)
  assert not errors,errors
  checks.append('mobile view fits viewport and chart; no page JavaScript errors')
  browser.close()
 (OUT/'browser-checks.json').write_text(json.dumps({'base':BASE,'checks':checks},ensure_ascii=False,indent=2),encoding='utf-8')
 for c in checks:print('PASS',c)
if __name__=='__main__':main()
