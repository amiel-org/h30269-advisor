"""Regenerate the parity baseline consumed by cloudflare/hs300-parity.mjs.

Run this after ANY change to model.py / config.json so the JS side is checked
against the refreshed Python truth.
"""
import json
from pathlib import Path

from data import align
from model import (HOLD, Config, build_signal_detail, build_signals, metrics,
                   run_backtest)

cfg = Config.load()
series = align()
signals = build_signals(series, cfg)
run = run_backtest(series, cfg, signals, lag=1)
detail = build_signal_detail(series, cfg)
last = len(series) - 1

payload = {
    "signals": [None if x is None else (x if isinstance(x, str) else round(x, 12))
                for x in signals],
    "metrics": metrics(run.curve),
    "trades": len(run.steps),
    "turnover": round(run.turnover, 6),
    "hold_days": sum(1 for x in signals if x == HOLD),
    "current": {
        "date": series.dates[last],
        "pe": series.pe[last],
        "windows": detail[last]["windows"],
        "agreed": detail[last]["agreed"],
        "consensus": detail[last]["consensus_exposure"],
    },
}
out = Path(__file__).resolve().parent / "reports" / "parity_expected.json"
out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

print(f"wrote {out.name}")
print(f"  signals={len(payload['signals'])}  trades={payload['trades']}  HOLD={payload['hold_days']}")
print(f"  CAGR={payload['metrics']['cagr_calendar_pct']}%  "
      f"MaxDD={payload['metrics']['max_drawdown_pct']}%")
print(f"  consensus={payload['current']['consensus']}")
for name, w in payload["current"]["windows"].items():
    print(f"    {name:<5} PE分位={w['pe_percentile']}  仓位={w['exposure']}")
