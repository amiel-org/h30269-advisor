#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Local web dashboard for the H30269 decision assistant."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import socket
import sys
import threading
import webbrowser
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import advisor


APP_DIR = (
    Path(sys.executable).resolve().parent
    if getattr(sys, "frozen", False)
    else Path(__file__).resolve().parent
)
STATIC_DIR = APP_DIR / "static"
REPORT_DIR = APP_DIR / "reports"
REFRESH_LOCK = threading.Lock()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def latest_result() -> dict:
    path = APP_DIR / "latest.json"
    if not path.exists():
        return refresh_result()
    return load_json(path)


def refresh_result() -> dict:
    with REFRESH_LOCK:
        args = argparse.Namespace(
            config=str(advisor.DEFAULT_CONFIG),
            offline=False,
            no_intraday=False,
            dividend_yield=None,
            bond_yield=None,
            json=False,
        )
        result = advisor.run(args)
        advisor.save_reports(result)
        return advisor.round_tree(result)


def rolling(values: list[float], window: int) -> list[float | None]:
    output: list[float | None] = [None] * len(values)
    total = 0.0
    for index, value in enumerate(values):
        total += value
        if index >= window:
            total -= values[index - window]
        if index >= window - 1:
            output[index] = total / window
    return output


def chart_data(limit: int = 270) -> dict:
    config = advisor.load_config(advisor.DEFAULT_CONFIG)
    target = load_json(APP_DIR / "cache" / "H30269.json")["rows"]
    benchmark = load_json(APP_DIR / "cache" / "000985.json")["rows"]
    target_map = {row["date"]: row for row in target}
    benchmark_map = {row["date"]: row for row in benchmark}
    dates = sorted(set(target_map) & set(benchmark_map))
    aligned_target = [target_map[day] for day in dates]
    aligned_benchmark = [benchmark_map[day] for day in dates]
    closes = [float(row["close"]) for row in aligned_target]
    bench = [float(row["close"]) for row in aligned_benchmark]
    candles: list[dict[str, float | str]] = []
    for day in dates:
        row = target_map[day]
        close = float(row["close"])
        open_value = float(row.get("open", close))
        raw_high = float(row.get("high", max(open_value, close)))
        raw_low = float(row.get("low", min(open_value, close)))
        candles.append(
            {
                "time": day,
                "open": open_value,
                "high": max(open_value, raw_high, raw_low, close),
                "low": min(open_value, raw_high, raw_low, close),
                "close": close,
            }
        )
    ma20 = rolling(closes, 20)
    ma60 = rolling(closes, 60)
    ma250 = rolling(closes, 250)
    target_return40: list[float | None] = [None] * len(dates)
    benchmark_return40: list[float | None] = [None] * len(dates)
    raw_relative40: list[float | None] = [None] * len(dates)
    beta_adjusted40: list[float | None] = [None] * len(dates)
    beta_definition = config["beta"]["windows"][config["beta"]["primary_window"]]
    quote_status = "历史收盘"
    try:
        quote_status = load_json(APP_DIR / "latest.json")["metrics"]["quote_status"]
    except Exception:
        pass
    for index in range(40, len(dates)):
        target_return = closes[index] / closes[index - 40] - 1
        benchmark_return = bench[index] / bench[index - 40] - 1
        target_return40[index] = target_return * 100
        benchmark_return40[index] = benchmark_return * 100
        raw_relative40[index] = (target_return - benchmark_return) * 100
        beta_end = index - 1 if index == len(dates) - 1 and quote_status == "盘中" else index
        beta = advisor.estimate_beta(
            aligned_target,
            aligned_benchmark,
            beta_end,
            int(beta_definition["trading_days"]),
            int(beta_definition["minimum_observations"]),
            float(config["beta"]["fallback"]),
        )
        if beta["sufficient"]:
            beta_adjusted40[index] = (
                target_return - beta["beta"] * benchmark_return
            ) * 100
    start = max(0, len(dates) - limit)
    return {
        "dates": dates[start:],
        "candles": candles[start:],
        "close": closes[start:],
        "ma20": ma20[start:],
        "ma60": ma60[start:],
        "ma250": ma250[start:],
        "targetReturn40": target_return40[start:],
        "benchmarkReturn40": benchmark_return40[start:],
        "rawRelative40": raw_relative40[start:],
        "betaAdjusted40": beta_adjusted40[start:],
        "relative40": beta_adjusted40[start:],
    }


def report_history(limit: int = 20) -> list[dict]:
    rows: list[dict] = []
    files = sorted(REPORT_DIR.glob("h30269-*.json"), reverse=True)
    for path in files:
        try:
            data = load_json(path)
            metrics = data["metrics"]
            rows.append(
                {
                    "file": path.name,
                    "generated_at": data.get("generated_at"),
                    "trade_date": metrics.get("trade_date"),
                    "decision": data["evaluation"].get("decision"),
                    "confidence": data["quality"].get("confidence"),
                    "close": metrics.get("close"),
                    "relative_spread_pct": metrics.get(
                        "beta_adjusted_spread_pct",
                        metrics.get("relative_spread_pct"),
                    ),
                    "signal_metric": (
                        "Beta调整"
                        if metrics.get("beta_adjusted_spread_pct") is not None
                        else "V2.2原始"
                    ),
                    "raw_relative_spread_pct": metrics.get(
                        "raw_relative_spread_pct",
                        metrics.get("relative_spread_pct"),
                    ),
                    "beta": metrics.get("beta"),
                    "model_version": data.get("model_version"),
                    "distance_ma250_pct": metrics.get("distance_ma250_pct"),
                    "momentum": metrics.get("momentum"),
                }
            )
        except Exception:
            continue
        if len(rows) >= limit:
            break
    return rows


def dashboard_payload() -> dict:
    return {
        "result": latest_result(),
        "chart": chart_data(),
        "history": report_history(),
        "server_time": datetime.now().isoformat(timespec="seconds"),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "H30269Advisor/1.0"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        body = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header(
            "Cache-Control",
            "public, max-age=86400" if "vendor" in path.parts else "no-cache",
        )
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        try:
            if path in {"/", "/index.html"}:
                self.send_file(STATIC_DIR / "index.html")
            elif path.startswith("/static/"):
                relative = Path(path.removeprefix("/static/"))
                target = (STATIC_DIR / relative).resolve()
                if STATIC_DIR.resolve() not in target.parents:
                    self.send_error(HTTPStatus.FORBIDDEN)
                else:
                    self.send_file(target)
            elif path == "/api/dashboard":
                self.send_json({"ok": True, "data": dashboard_payload()})
            elif path == "/api/health":
                self.send_json({"ok": True, "time": datetime.now().isoformat()})
            elif path == "/favicon.ico":
                self.send_response(HTTPStatus.NO_CONTENT)
                self.end_headers()
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, status=500)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/api/refresh":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            refresh_result()
            self.send_json({"ok": True, "data": dashboard_payload()})
        except Exception as exc:
            self.send_json({"ok": False, "error": str(exc)}, status=500)


def port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex((host, port)) == 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="红利低波本地决策仪表盘")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    url = f"http://{args.host}:{args.port}/"
    if port_in_use(args.host, args.port):
        if args.open:
            webbrowser.open(url)
        print(f"服务已在运行：{url}")
        return 0

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    (APP_DIR / "webapp.pid").write_text(str(os.getpid()), encoding="ascii")
    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    print(f"红利低波决策台已启动：{url}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        (APP_DIR / "webapp.pid").unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
