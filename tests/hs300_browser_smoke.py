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
        page.goto(BASE + "/hs300", wait_until="networkidle", timeout=45000)
        button = page.get_by_role("button", name="刷新", exact=True)
        assert button.is_enabled()
        assert page.locator("#verdict").inner_text() != "--"
        assert not page.get_by_role("alert").is_visible()
        assert "模型暂不调仓" in page.locator("#verdict").inner_text() or "目标仓位" in page.locator("#verdict").inner_text()
        checks.append("initial page executes, renders and enables refresh")
        button.click()
        page.wait_for_function("document.querySelector('#asOfText').textContent.includes('数据更新')", timeout=40000)
        checks.append("manual refresh succeeds")
        page.screenshot(path=str(OUT / "hs300-fixed-desktop.png"), full_page=True)

        endpoint = "**/api/hs300/refresh"
        page.route(endpoint, lambda route: route.fulfill(status=503, content_type="application/json", body="{}"))
        button.click()
        page.wait_for_function("document.querySelector('#errorBanner').textContent.includes('503')")
        assert button.is_enabled()
        assert page.locator("#verdict").inner_text() == "暂停交易提示"
        checks.append("HTTP failure shown; trading advice paused; button recovers")
        page.unroute(endpoint)

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
        page.wait_for_function("document.querySelector('#asOfText').textContent.includes('数据更新')", timeout=40000)
        assert not page.get_by_role("alert").is_visible()
        assert page.locator("#verdict").inner_text() != "暂停交易提示"
        checks.append("retry recovers after all injected failures")

        response = page.evaluate("async () => (await fetch('/api/hs300/dashboard')).json()")
        response["data"]["refresh_status"] = "stale"
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
        page.wait_for_function("document.querySelector('#asOfText').textContent.includes('数据更新')", timeout=40000)

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
