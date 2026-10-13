import math

import numpy as np
from scipy.interpolate import PchipInterpolator


def _clean(rates, quals):
    pts = sorted((q, r) for r, q in zip(rates, quals) if r and r > 0 and q is not None and not math.isnan(q))
    out = []
    for q, r in pts:
        if out and (q <= out[-1][0] + 1e-9 or r <= out[-1][1]):
            continue
        out.append((q, r))
    return out


def bd_rate(ref_rates, ref_quals, test_rates, test_quals, min_points: int = 3) -> float | None:
    ref = _clean(ref_rates, ref_quals)
    test = _clean(test_rates, test_quals)
    if len(ref) < min_points or len(test) < min_points:
        return None
    rq = np.array([p[0] for p in ref])
    rr = np.log10(np.array([p[1] for p in ref]))
    tq = np.array([p[0] for p in test])
    tr = np.log10(np.array([p[1] for p in test]))
    lo = max(rq.min(), tq.min())
    hi = min(rq.max(), tq.max())
    if hi - lo < 1e-6 * max(1.0, abs(hi)):
        return None
    f_ref = PchipInterpolator(rq, rr)
    f_test = PchipInterpolator(tq, tr)
    xs = np.linspace(lo, hi, 256)
    avg_diff = np.trapezoid(f_test(xs) - f_ref(xs), xs) / (hi - lo)
    return float((10.0 ** avg_diff - 1.0) * 100.0)


def overlap_fraction(ref_quals, test_quals) -> float:
    a = [q for q in ref_quals if q is not None]
    b = [q for q in test_quals if q is not None]
    if not a or not b:
        return 0.0
    lo, hi = max(min(a), min(b)), min(max(a), max(b))
    span = max(max(a), max(b)) - min(min(a), min(b))
    return max(0.0, hi - lo) / span if span > 0 else 0.0


def bd_quality(ref_rates, ref_quals, test_rates, test_quals) -> float | None:
    ref = _clean(ref_rates, ref_quals)
    test = _clean(test_rates, test_quals)
    if len(ref) < 3 or len(test) < 3:
        return None
    rr = np.log10([p[1] for p in ref])
    rq = np.array([p[0] for p in ref])
    tr = np.log10([p[1] for p in test])
    tq = np.array([p[0] for p in test])
    o_r = np.argsort(rr)
    o_t = np.argsort(tr)
    lo = max(rr.min(), tr.min())
    hi = min(rr.max(), tr.max())
    if hi <= lo:
        return None
    f_ref = PchipInterpolator(rr[o_r], rq[o_r])
    f_test = PchipInterpolator(tr[o_t], tq[o_t])
    xs = np.linspace(lo, hi, 256)
    return float(np.trapezoid(f_test(xs) - f_ref(xs), xs) / (hi - lo))
