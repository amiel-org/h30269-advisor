"""Does a price exist at which all three windows agree on the same target?

Each window maps price -> implied PE -> its own percentile -> target.  Because
the windows have different historical PE distributions, the price ranges for a
given target may not overlap, in which case "consensus" can never fire.
"""
from data import align

s = align()
n = len(s)
pe_now = s.pe[-1]
px_now = 4217.68

WINDOWS = {
    "full": [s.pe[i] for i in range(n - 1)],
    "10y": [s.pe[i] for i in range(max(0, n - 1 - 2440), n - 1)],
    "5y": [s.pe[i] for i in range(max(0, n - 1 - 1220), n - 1)],
}
LAD = [(70, 0.0), (60, 0.125), (50, 0.375), (40, 0.625), (30, 0.875), (0, 1.0)]
lad = lambda p: next(w for t, w in LAD if p >= t)


def targets_at(price):
    implied = pe_now * price / px_now
    return {name: lad(100.0 * sum(1 for x in h if x <= implied) / len(h))
            for name, h in WINDOWS.items()}


print("scan price from {:.0f} to {:.0f} looking for three-way agreement".format(px_now*0.70, px_now*1.20))
zones = []
run = None
for i in range(3001):
    price = px_now * 0.70 + (px_now * 0.50) * i / 3000
    t = targets_at(price)
    vals = set(t.values())
    if len(vals) == 1:
        v = vals.pop()
        if run is None or run[2] != v:
            zones.append([price, price, v]); run = zones[-1]
        else:
            run[1] = price
    else:
        run = None

print()
if zones:
    for z in zones:
        print("  price {:.0f} .. {:.0f} -> target {:.1f}%".format(z[0], z[1], z[2]*100))
else:
    print("  NONE: no price in this range makes the three windows agree")

print()
print("at current price {:.0f}:".format(px_now))
for k, v in targets_at(px_now).items():
    print("   {} -> {:.1f}%".format(k, v*100))
