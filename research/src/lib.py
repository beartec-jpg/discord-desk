"""Shared helpers: data loading, resampling, swings, trend states, signal alignment, metrics. All signals use the last CLOSED bar only."""
import numpy as np, pandas as pd, os, math, numba
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
DAY = 86_400_000; TF_MIN = {"15m": 15, "1h": 60, "4h": 240}
FEE, SLIP = 0.0006, 0.0005; RT = 2 * (FEE + SLIP)          # v4 cost model (Blofin taker + slippage), round trip
START = int(pd.Timestamp("2023-01-01", tz="UTC").timestamp() * 1000)     # first trade time (2022-07..2022-12 = warm-up)
OOS = int(pd.Timestamp("2026-05-01", tz="UTC").timestamp() * 1000)        # last 6 months held out

def load15(sym): return pd.read_parquet(f"{D}/m15_{sym}.parquet")
def resample(m15, tf):
    if tf == "15m": return m15.copy()
    n = TF_MIN[tf] // 15; g = m15.ts // (n * 900_000)
    r = m15.groupby(g).agg(ts=("ts", "first"), o=("o", "first"), h=("h", "max"), l=("l", "min"), c=("c", "last"), qv=("qv", "sum"), tbqv=("tbqv", "sum"), cnt=("ts", "size"))
    return r[r.cnt == n].drop(columns="cnt").reset_index(drop=True)
def atr(b, n=14):
    pc = b.c.shift(); tr = pd.concat([b.h - b.l, (b.h - pc).abs(), (b.l - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()

def pivots(b, k, m):
    """Fractal pivots: bar is a pivot high if its high is the max of +-k bars and (high - lowest low in window) >= m*ATR (mirror for lows).
    Returns DataFrame idx, type(+1 high/-1 low), price, conf (idx+k = first bar index at which it is known)."""
    h, l, a = b.h.values, b.l.values, atr(b).values
    hw = pd.Series(h).rolling(2 * k + 1, center=True).max().values; lw = pd.Series(l).rolling(2 * k + 1, center=True).min().values
    ph = (h == hw) & ((h - lw) >= m * a); pl = (l == lw) & ((hw - l) >= m * a)
    rows = [(i, 1, h[i], i + k) for i in np.where(ph)[0]] + [(i, -1, l[i], i + k) for i in np.where(pl)[0]]
    return pd.DataFrame(rows, columns=["idx", "type", "price", "conf"]).sort_values(["conf", "idx"]).reset_index(drop=True)

def last_pivot_arrays(n, pv):
    """as-of arrays: for each bar i, last confirmed pivot high/low price and the bar idx of that pivot."""
    sh = np.full(n, np.nan); sl = np.full(n, np.nan); hi = np.full(n, -1); li = np.full(n, -1)
    p = pv.sort_values("conf"); c = p.conf.values; t = p.type.values; pr = p.price.values; ix = p.idx.values; q = 0
    lh = ll = np.nan; lhi = lli = -1
    for i in range(n):
        while q < len(c) and c[q] <= i:
            if t[q] == 1: lh, lhi = pr[q], ix[q]
            else: ll, lli = pr[q], ix[q]
            q += 1
        sh[i], sl[i], hi[i], li[i] = lh, ll, lhi, lli
    return sh, sl, hi, li

def trend_state(close, fast=20, slow=50):
    """+1 if close>EMA(slow) and EMA(fast)>EMA(slow); -1 if both below; else 0. NaN->0 during warm-up."""
    f = close.ewm(span=fast, adjust=False).mean(); s = close.ewm(span=slow, adjust=False).mean()
    st = pd.Series(0, index=close.index); st[(close > s) & (f > s)] = 1; st[(close < s) & (f < s)] = -1
    st[close.rolling(slow).count() < slow] = 0
    return st.astype(np.int8)

def daily_series(name):
    """Daily close series indexed by UTC date (bar date; bar closes at end of that date for crypto, ~21-22 UTC for macro)."""
    if name.startswith("BIN:"):
        d = pd.read_parquet(f"{D}/d_{name[4:]}.parquet"); s = pd.Series(d.c.values, index=pd.to_datetime(d.ts, unit="ms").dt.normalize())
    elif name.startswith("Y:"):
        s = pd.read_parquet(f"{D}/y_{name[2:]}.parquet").close
    else:
        s = pd.read_parquet(f"{D}/tv_{name[3:]}.parquet").close
    s.index = pd.to_datetime(s.index).normalize(); s = s[~s.index.duplicated()].sort_index().astype(float)
    return s

def avail_ms(idx):  # a daily bar dated D is treated as known from D+1 00:00 UTC (conservative for macro: no intraday peeking, weekends carry Friday)
    return ((idx.values.astype("datetime64[ms]").astype(np.int64)) + DAY)

class Sig:
    """state per bar (asset-direction: +1 bullish, -1 bearish, 0 neutral) usable from avail[i] on."""
    def __init__(self, avail, state): self.avail = np.asarray(avail); self.state = np.asarray(state, dtype=np.int8)
    def at(self, ts):
        i = np.searchsorted(self.avail, ts, side="right") - 1
        out = np.where(i >= 0, self.state[np.clip(i, 0, None)], 0).astype(np.int8); return out

def rolling_corr(asset_close, other, win=30):
    """30-observation rolling correlation of returns computed on the other series' own trading days (asset aligned to those dates)."""
    a = asset_close.reindex(other.index, method="ffill"); r = pd.concat([a.pct_change(), other.pct_change()], axis=1).dropna()
    r.columns = ["a", "o"]; return r.a.rolling(win).corr(r.o)

# ---------------- metrics ----------------
def metrics(R, ts=None, w=None):
    R = np.asarray(R, float); n = len(R)
    if n == 0: return dict(n=0, win=np.nan, avgR=np.nan, pf=np.nan, t=np.nan, totR=0.0, maxdd=0.0)
    if w is None: w = np.ones(n)
    wr = R * w; gp = wr[wr > 0].sum(); gl = -wr[wr < 0].sum()
    if ts is not None: wr_c = wr[np.argsort(ts, kind="stable")]
    else: wr_c = wr
    cum = np.cumsum(wr_c); dd = float((np.maximum.accumulate(np.concatenate([[0], cum]))[1:] - cum).max())
    eff = wr / w.mean()                                   # normalise so average risk per trade = 1 (weighted modes keep capital at risk comparable)
    sd = eff.std(ddof=1) if n > 1 else np.nan
    return dict(n=n, win=float((R > 0).mean()), avgR=float(wr.sum() / w.sum()), pf=float(gp / gl) if gl > 0 else np.inf,
                t=float(eff.mean() / (sd / math.sqrt(n))) if n > 1 and sd > 0 else np.nan, totR=float(wr.sum()), maxdd=dd)

@numba.njit(cache=True)
def select_one_at_a_time(ts, exit_ts, keep, sym_id, idea_id, nsym, nidea):
    """chronological, one open trade per symbol, each idea (if idea_id>=0) traded at most once. Candidates must be sorted by ts."""
    n = len(ts); out = np.zeros(n, np.bool_); busy = np.zeros(nsym); done = np.zeros(nidea, np.bool_)
    for i in range(n):
        if not keep[i]: continue
        s = sym_id[i]
        if busy[s] > ts[i]: continue
        if idea_id[i] >= 0 and done[idea_id[i]]: continue
        out[i] = True; busy[s] = exit_ts[i]
        if idea_id[i] >= 0: done[idea_id[i]] = True
    return out

@numba.njit(cache=True)
def simulate(hi, lo, cl, cumf, start, side, entry, stop, rr, timeout):
    """v4 setups.simulate (verbatim logic): 15m intrabar, ambiguous bar -> stop first. mgmt: none / break-even at 1R / 50% partial at 1R + BE.
    `rr` is an array (R multiple of target per candidate; NaN -> skip)."""
    n = len(start); out = np.full((n, 3), np.nan); hit = np.zeros(n); held = np.zeros((n, 3)); fund = np.zeros((n, 3))
    for i in range(n):
        if np.isnan(rr[i]): continue
        s0, d, e, st = start[i], side[i], entry[i], stop[i]; R = abs(e - st); tg = e + d * rr[i] * R; one = e + d * R
        for mi in range(3):
            stp = st; part = 0.0; armed = False; res = np.nan; j = s0
            end = min(s0 + timeout, len(hi))
            while j < end:
                h, l = hi[j], lo[j]
                adverse = (l <= stp) if d > 0 else (h >= stp)
                fav_t = (h >= tg) if d > 0 else (l <= tg)
                fav_1 = (h >= one) if d > 0 else (l <= one)
                if adverse:
                    r_stop = d * (stp - e) / R
                    res = part * 1.0 + (1 - part) * r_stop if mi == 2 else r_stop; break
                if fav_t:
                    res = (0.5 * 1.0 + 0.5 * rr[i]) if mi == 2 else rr[i]
                    if mi == 0: hit[i] = 1.0
                    break
                if fav_1 and not armed and mi > 0:
                    armed = True; stp = e
                    if mi == 2: part = 0.5
                j += 1
            if np.isnan(res) and end > s0:
                j = end - 1; rt = d * (cl[j] - e) / R
                res = part * 1.0 + (1 - part) * rt if mi == 2 else rt
            out[i, mi] = res; held[i, mi] = j - s0 + 1
            je = min(j, len(hi) - 1); fund[i, mi] = d * (cumf[je] - cumf[s0 - 1 if s0 > 0 else 0])
    return out, hit, held, fund

def funding_cum(m15, sym):
    fr = pd.read_parquet(f"{D}/fund_{sym}.parquet"); f15 = np.zeros(len(m15)); p = np.searchsorted(m15.ts.values + 900_000, fr.ts.values)
    ok = p < len(m15); np.add.at(f15, p[ok], fr.fr.values[ok]); return np.cumsum(f15), fr
