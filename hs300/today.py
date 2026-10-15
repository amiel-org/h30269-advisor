# -*- coding: utf-8 -*-
"""Evaluate the frozen snapshot using the same three-window rule as the desk.

Live data and dated quality checks belong to the Worker. This command is an
explicit offline diagnostic; it never invents PE or backfills past bond yields
using a future observation.
"""
from data import align
from model import Config, window_targets

def main():
    series = align()
    detail = window_targets(series.pe[:-1], series.spread[:-1], series.pe[-1], series.spread[-1], Config.load())
    print(f"OFFLINE snapshot date={series.dates[-1]} PE={series.pe[-1]:.4f}")
    for name, row in detail["windows"].items():
        print(f"  {name}: PE_pct={row['pe_percentile']} ERP_pct={row['erp_percentile']} exposure={row['exposure']}")
    print(f"consensus={detail['consensus_exposure']}; agreed={detail['agreed']}")
    print("Historical diagnostic only. Use /hs300 for fresh, dated inputs and close confirmation.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
