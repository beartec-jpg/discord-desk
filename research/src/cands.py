"""Candidate generators: (1) brain-trader v4 swing-stop fixed-RR setups (mechanical part only; ML P(target) gate NOT replayable here),
(2) Discord-desk mechanical stand-in."""
import numpy as np, pandas as pd, numba, itertools
from lib import *
from signals import SYM, Sig
SWING = {"k3m1": (3, 1.0), "k5m15": (5, 1.5)}; BUFFER_ATR = 0.1; MAX_STOP = 0.06; MAX_COST_R = 0.25; RRS = (1.5, 2.0); MGMT = ("none", "be", "partial")
CAND_EVERY = {"15m": 4, "1h": 2, "4h": 1}; TIMEOUT_V4 = 7 * 96

def regime_arrays():
    """BTC regime as in v2/v4: BTC 1h close vs EMA720 (bull/bear) x 168h realised vol vs median (expanding, prior data only). 0 bear-calm 1 bear-vol 2 bull-calm 3 bull-vol."""
    b = resample(load15("BTCUSDT"), "1h"); c = b.c; ema = c.ewm(span=720, adjust=False).mean(); v = np.log(c).diff().rolling(168).std()
    med = v.expanding(min_periods=720).median().shift(1)
    reg = ((c > ema).astype(int) * 2 + (v > med).astype(int)).where(med.notna() & (np.arange(len(c)) > 720), -1)
    return b.ts.values + 3_600_000, reg.values

def v4_candidates(sym, tf, swing_key):
    m15 = load15(SYM[sym]); b = resample(m15, tf); k, m = SWING[swing_key]; a = atr(b).values
    pv = pivots(b, k, m); sh, sl, hi, li = last_pivot_arrays(len(b), pv)
    every = CAND_EVERY[tf]; idx = np.arange(200, len(b) - 1, every); close_ts = b.ts.values + TF_MIN[tf] * 60_000
    pos15 = np.searchsorted(m15.ts.values, close_ts); cumf, fr = funding_cum(m15, SYM[sym]); rows = []
    for d, ref in ((1, sl), (-1, sh)):
        e = b.c.values[idx]; st = ref[idx] - d * BUFFER_ATR * a[idx]
        valid = np.isfinite(st) & ((e - st) * d > 0) & (pos15[idx] < len(m15)) & (close_ts[idx] >= START)
        ii = idx[valid]; e = e[valid]; st = st[valid]; dist = np.abs(e - st) / e
        rfr = np.interp(close_ts[ii], fr.ts.values, fr.fr.values); cost_r = (RT + np.abs(rfr) * 3) / dist
        rows.append(pd.DataFrame({"ts": close_ts[ii], "side": d, "entry": e, "stop": st, "stop_pct": dist, "cost_r": cost_r, "start15": pos15[ii]}))
    c = pd.concat(rows, ignore_index=True).sort_values("ts", kind="stable").reset_index(drop=True)
    c["fee_ok"] = (c.cost_r <= MAX_COST_R) & (c.stop_pct <= MAX_STOP)
    rts, reg = regime_arrays(); c["regime"] = reg[np.clip(np.searchsorted(rts, c.ts.values, side="right") - 1, 0, None)]
    cells = {}
    for rr in RRS:
        g, hit, held, fund = simulate(m15.h.values, m15.l.values, m15.c.values, cumf, c.start15.values.astype(np.int64), c.side.values.astype(np.int64),
                                      c.entry.values, c.stop.values, np.full(len(c), rr), TIMEOUT_V4)
        for mi, mg in enumerate(MGMT):
            R = g[:, mi] - RT / c.stop_pct.values - fund[:, mi] / c.stop_pct.values
            cells[(rr, mg)] = (R, c.ts.values + held[:, mi].astype(np.int64) * 900_000 - 900_000 * 0)   # exit = entry close + held*15m
    return c, cells

# ---------------------------------------------------------------- desk stand-in
@numba.njit(cache=True)
def desk_gen(o, h, l, c, idx1, SH, SL, HI, LI, ATR1, dtrend, minleg, fibmax):
    n = len(c); maxn = n; js = np.zeros(maxn, np.int64); sd = np.zeros(maxn, np.int64); ent = np.zeros(maxn); stp = np.zeros(maxn); hid = np.zeros(maxn, np.int64); lid = np.zeros(maxn, np.int64)
    cnt = 0; kh = -2; kl = -2; kd = 0; armed = False; dead = False
    for j in range(2, n):
        i = idx1[j]
        if i < 0 or np.isnan(SH[i]) or np.isnan(SL[i]): kh = -2; continue
        d = 0
        if dtrend[j] == 1 and HI[i] > LI[i]: d = 1
        elif dtrend[j] == -1 and LI[i] > HI[i]: d = -1
        if d == 0: kh = -2; kl = -2; kd = 0; armed = False; dead = False; continue
        if HI[i] != kh or LI[i] != kl or d != kd: kh = HI[i]; kl = LI[i]; kd = d; armed = False; dead = False
        H = SH[i]; L = SL[i]; leg = H - L
        if leg < minleg * ATR1[i]: continue
        if d == 1:
            if l[j] < L: dead = True
            if dead: continue
            if l[j] <= H - 0.382 * leg: armed = True
            if armed and c[j] > o[j] and c[j] > h[j - 1] and c[j] <= H - fibmax * leg:
                js[cnt] = j; sd[cnt] = 1; ent[cnt] = c[j]; stp[cnt] = L * (1 - 1e-6); hid[cnt] = HI[i]; lid[cnt] = LI[i]; cnt += 1
        else:
            if h[j] > H: dead = True
            if dead: continue
            if h[j] >= L + 0.382 * leg: armed = True
            if armed and c[j] < o[j] and c[j] < l[j - 1] and c[j] >= L + fibmax * leg:
                js[cnt] = j; sd[cnt] = -1; ent[cnt] = c[j]; stp[cnt] = H * (1 + 1e-6); hid[cnt] = HI[i]; lid[cnt] = LI[i]; cnt += 1
    return js[:cnt], sd[:cnt], ent[:cnt], stp[:cnt], hid[:cnt], lid[:cnt]

def daily_structure_trend(sym):
    """HTF trend from code: daily fractal structure (HH+HL up / LH+LL down, pivots k=3 >=1 ATR) AND close vs EMA50. avail from next UTC day."""
    from signals import daily_series
    d = pd.read_parquet(f"{D}/d_{SYM[sym]}.parquet"); b = pd.DataFrame({"ts": d.ts.values, "o": d.o, "h": d.h, "l": d.l, "c": d.c})
    pv = pivots(b, 3, 1.0); st = np.zeros(len(b), np.int8); ema = b.c.ewm(span=50, adjust=False).mean().values
    ph = pv[pv.type == 1]; pl = pv[pv.type == -1]
    for i in range(len(b)):
        a = ph[ph.conf <= i].price.values[-2:]; z = pl[pl.conf <= i].price.values[-2:]
        if len(a) < 2 or len(z) < 2: continue
        if a[1] > a[0] and z[1] > z[0] and b.c[i] > ema[i]: st[i] = 1
        elif a[1] < a[0] and z[1] < z[0] and b.c[i] < ema[i]: st[i] = -1
    return Sig(b.ts.values + DAY, st)

TARGETS = ("T2R", "T3R", "TSWING")
def desk_candidates(sym, minleg=2.0, fibmax=0.236):
    m15 = load15(SYM[sym]); b1 = resample(m15, "1h"); b4 = resample(m15, "4h"); a1 = atr(b1).values
    pv1 = pivots(b1, 5, 1.5); SH, SL, HI, LI = last_pivot_arrays(len(b1), pv1)
    ts15c = m15.ts.values + 900_000; idx1 = np.searchsorted(b1.ts.values + 3_600_000, ts15c, side="right") - 1
    dtr = daily_structure_trend(sym).at(ts15c).astype(np.int64)
    js, sd, ent, stp, hid, lid = desk_gen(m15.o.values, m15.h.values, m15.l.values, m15.c.values, idx1.astype(np.int64), SH, SL, HI.astype(np.int64), LI.astype(np.int64), a1, dtr, minleg, fibmax)
    c = pd.DataFrame({"ts": ts15c[js], "side": sd, "entry": ent, "stop": stp, "start15": js + 1, "hid": hid, "lid": lid})
    c = c[(c.ts >= START) & (c.start15 < len(m15))].reset_index(drop=True)
    c["stop_pct"] = np.abs(c.entry - c.stop) / c.entry
    cumf, fr = funding_cum(m15, SYM[sym]); rfr = np.interp(c.ts.values, fr.ts.values, fr.fr.values); c["cost_r"] = (RT + np.abs(rfr) * 3) / c.stop_pct
    c["fee_ok"] = c.cost_r <= MAX_COST_R
    key = c.hid * 10_000_000 + c.lid * 2 + (c.side > 0); c["idea"] = pd.factorize(key)[0]
    # next-swing target: nearest confirmed 4h pivot (k=3,>=1ATR) beyond entry in trade direction
    pv4 = pivots(b4, 3, 1.0); conf_ts = b4.ts.values[np.clip(pv4.conf.values, 0, len(b4) - 1)] + 4 * 3_600_000; pr = pv4.price.values; tp = pv4.type.values
    order = np.argsort(conf_ts, kind="stable"); conf_ts, pr, tp = conf_ts[order], pr[order], tp[order]
    tgt = np.full(len(c), np.nan)
    for q, (te, e, d) in enumerate(zip(c.ts.values, c.entry.values, c.side.values)):
        cnt = np.searchsorted(conf_ts, te, side="right"); lo = max(0, cnt - 80); pp = pr[lo:cnt]; tt = tp[lo:cnt]
        if d > 0:
            x = pp[(tt == 1) & (pp > e)]; tgt[q] = x.min() if len(x) else np.nan
        else:
            x = pp[(tt == -1) & (pp < e)]; tgt[q] = x.max() if len(x) else np.nan
    rr_sw = np.abs(tgt - c.entry.values) / np.abs(c.entry.values - c.stop.values); rr_sw[~(rr_sw >= 1.5)] = np.nan
    c["rr_swing"] = rr_sw; cells = {}
    for name in TARGETS:
        rr = {"T2R": np.full(len(c), 2.0), "T3R": np.full(len(c), 3.0), "TSWING": rr_sw}[name]
        g, hit, held, fund = simulate(m15.h.values, m15.l.values, m15.c.values, cumf, c.start15.values.astype(np.int64), c.side.values.astype(np.int64),
                                      c.entry.values, c.stop.values, rr, 30 * 96)
        R = g[:, 0] - RT / c.stop_pct.values - fund[:, 0] / c.stop_pct.values
        cells[name] = (R, c.ts.values + held[:, 0].astype(np.int64) * 900_000)
    return c, cells
