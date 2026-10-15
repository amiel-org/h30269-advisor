"""Browser regression for real rendering, refresh failures and recovery.

Usage: python tests/hs300_browser_smoke.py [base_url]
Requires a running Worker and the locally installed Playwright/Chrome.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://127.0.0.1:8793"
OUT = Path(__file__).resolve().parent.parent / "output" / "playwright"
OUT.mkdir(parents=True, exist_ok=True)


def main():
    checks = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        def wait_ready():
            try:
                page.wait_for_function("!document.querySelector('#refreshButton').disabled && /数据更新|参考 /.test(document.querySelector('#asOfText').textContent)", timeout=40000)
            except Exception:
                page.screenshot(path=str(OUT / "hs300-failed-check.png"), full_page=True)
                print("FAILED STATE", page.evaluate("({status:document.querySelector('#asOfText').textContent,error:document.querySelector('#errorBanner').textContent,verdict:document.querySelector('#verdict').textContent})"), flush=True)
                raise
        page.goto(BASE + "/hs300", wait_until="networkidle", timeout=45000)
        wait_ready()
        button = page.get_by_role("button", name="刷新", exact=True)
        assert button.is_enabled()
        assert page.locator("#verdict").inner_text() != "--"
        assert not page.get_by_role("alert").is_visible()
        assert any(text in page.locator("#verdict").inner_text() for text in ("模型暂不调仓", "目标仓位", "等待新收盘数据", "保留上次收盘分析"))
        checks.append("initial page executes, renders and enables refresh")
        button.click()
        wait_ready()
        checks.append("manual refresh succeeds")
        page.screenshot(path=str(OUT / "hs300-fixed-desktop.png"), full_page=True)
        healthy = page.evaluate("async () => (await fetch('/api/hs300/dashboard')).json()")
        healthy["data"]["refresh_pending"] = False

        endpoint = "**/api/hs300/refresh"
        # Transient HTTP failures recover via a bounded GET before the error
        # state is shown. Both attempts failing retain the dated reference.
        page.route(endpoint, lambda route: route.fulfill(status=503, content_type="application/json", body="{}"))
        page.route("**/api/hs300/dashboard", lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(healthy)))
        button.click()
        wait_ready()
        assert not page.get_by_role("alert").is_visible()
        checks.append("one transient HTTP 503 automatically recovers by reading the dashboard")
        page.unroute("**/api/hs300/dashboard")
        page.route("**/api/hs300/dashboard", lambda route: route.fulfill(status=503, content_type="application/json", body="{}"))
        button.click()
        page.wait_for_function("document.querySelector('#errorBanner').textContent.includes('503')")
        assert button.is_enabled()
        assert page.locator("#verdict").inner_text() == "保留上次收盘分析"
        assert "历史参考" in page.locator("#actions").inner_text()
        checks.append("persistent HTTP failure preserves dated analysis and blocks new actions")
        page.unroute(endpoint)
        page.unroute("**/api/hs300/dashboard")

        page.route(endpoint, lambda route: route.fulfill(status=200, content_type="application/json", body="not-json"))
        button.click()
        page.wait_for_function("document.querySelector('#asOfText').textContent.includes('刷新失败')")
        assert button.is_enabled()
        checks.append("malformed JSON shown as error, no infinite spinner")
        page.unroute(endpoint)

        page.route(endpoint, lambda route: route.fulfill(status=200, content_type="application/json", body='{"ok":true,"data":{}}'))
        button.click()
        page.wait_for_function("document.querySelector('#errorBanner').textContent.includes('结构异常')")
        assert button.is_enabled()
        checks.append("wrong response schema rejected")
        page.unroute(endpoint)

        page.evaluate("window.HS300_REQUEST_TIMEOUT_MS = 200")
        # Simulate a fetch implementation that honours AbortSignal but never
        # receives a response. This avoids leaving an intercepted request alive
        # after the application has cancelled it in Playwright's own router.
        page.evaluate("""() => {
          window.__hs300SavedFetch = window.fetch;
          window.fetch = (url, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {once:true});
          });
        }""")
        button.click()
        page.wait_for_function("document.querySelector('#errorBanner').textContent.includes('加载超时')")
        assert button.is_enabled()
        checks.append("hung fetch cancelled; timeout visible; retry available")
        page.evaluate("window.fetch = window.__hs300SavedFetch; delete window.__hs300SavedFetch")
        page.unroute(endpoint)
        page.evaluate("delete window.HS300_REQUEST_TIMEOUT_MS")

        button.click()
        wait_ready()
        assert not page.get_by_role("alert").is_visible()
        assert page.locator("#verdict").inner_text() != "暂停交易提示"
        checks.append("retry recovers after all injected failures")

        response = json.loads(json.dumps(healthy))
        response["data"]["refresh_status"] = "stale"
        response["data"]["refresh_pending"] = False
        response["data"]["refresh_error"] = "injected source outage"
        response["data"]["quality"] = {"actionable": False, "blockers": ["旧快照"]}
        page.route(endpoint, lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(response)))
        button.click()
        page.wait_for_function("document.querySelector('#asOfText').textContent.includes('旧快照')")
        assert page.locator("#verdict").inner_text() == "暂停交易提示"
        assert "暂停" in page.locator("#actions").inner_text()
        checks.append("stale fallback visibly labelled and all observation lines paused")
        page.unroute(endpoint)
        button.click()
        wait_ready()

        # Reproduce the user's after-close screenshot: the previous confirmed
        # day remains analyzable while today's publication is awaited.
        reference = json.loads(json.dumps(response))
        reference["data"]["refresh_status"] = "fresh"
        reference["data"]["refresh_error"] = None
        reference["data"]["refresh_pending"] = False
        reference["data"]["quality"] = {"actionable": False, "analysis_available": True, "status": "awaiting_close", "blockers": []}
        page.route(endpoint, lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(reference)))
        button.click()
        wait_ready()
        assert page.locator("#verdict").inner_text() == "等待新收盘数据"
        assert "历史参考" in page.locator("#actions").inner_text()
        assert "条件估算点位" in page.locator("#actions").inner_text()
        assert not page.get_by_role("alert").is_visible()
        checks.append("unpublished close retains dated reference and observation lines without a red outage banner")
        page.unroute(endpoint)
        reference["data"]["refresh_status"] = "reference"
        reference["data"]["refresh_error"] = "数据源响应超时，稍后会重新核验"
        reference["data"]["quality"]["status"] = "source_unavailable"
        page.route(endpoint, lambda route: route.fulfill(status=200, content_type="application/json", body=json.dumps(reference)))
        button.click()
        wait_ready()
        assert page.locator("#verdict").inner_text() == "保留上次收盘分析"
        assert "核验未完成" in page.locator("#freshBanner").inner_text()
        assert not page.get_by_role("alert").is_visible()
        checks.append("source timeout retains analysis with clear restriction; no raw aborted error")
        page.unroute(endpoint)
        button.click()
        wait_ready()

        page.set_viewport_size({"width": 390, "height": 844})
        page.screenshot(path=str(OUT / "hs300-fixed-mobile.png"), full_page=True)
        assert not errors, errors
        checks.append("desktop/mobile render without JavaScript exceptions")
        browser.close()
    (OUT / "browser-checks.json").write_text(json.dumps({"base": BASE, "checks": checks}, ensure_ascii=False, indent=2), encoding="utf-8")
    for line in checks:
        print("PASS", line)


if __name__ == "__main__":
    main()
