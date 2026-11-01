"""TEST B: macro confluence study. Objective HTF pivots on BTC/XRP; full indicator set on 14 charts; pattern search with OOS + permutation guards."""
import numpy as np, pandas as pd, json, os, itertools, warnings; warnings.filterwarnings("ignore")
from lib import D
OUTD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out")
START, OOS, END_TRIM = pd.Timestamp("2019-01-01"), pd.Timestamp("2025-01-01"), 10
rng = np.random.default_rng(7)

def load_ohlcv():
    def b(n):
        d = pd.read_parquet(f"{D}/d_{n}.parquet"); d.index = pd.to_datetime(d.ts, unit="ms").dt.normalize()
        return d[["o", "h", "l", "c", "v"]].rename(columns=dict(o="open", h="high", l="low", c="close", v="volume")).astype(float)
    def y(n): d = pd.read_parquet(f"{D}/y_{n}.parquet"); d.index = pd.to_datetime(d.index).normalize(); return d[["open", "high", "low", "close", "volume"]].astype(float)
    def tv(n): d = pd.read_parquet(f"{D}/tv_{n}.parquet"); d.index = pd.to_datetime(d.index).normalize(); return d[["open", "high", "low", "close", "volume"]].astype(float)
    ch = {"XRP": b("XRPUSDT"), "BTC": b("BTCUSDT"), "XRPBTC": b("XRPBTC"), "ETHBTC": b("ETHBTC"), "BTCD": tv("BTCD").assign(volume=np.nan), "USDTD": tv("USDTD").assign(volume=np.nan),
          "SPX": y("SPX"), "NDX": y("NDX"), "RUT": y("RUT"), "GOLD": y("GOLD"), "SILVER": y("SILVER"), "DXY": y("DXY").assign(volume=np.nan), "US10Y": y("US10Y").assign(volume=np.nan)}
    xm, tot = tv("XRPMC").close, tv("TOTAL").close; c = (xm / tot * 100).dropna(); ch["XRPD"] = pd.DataFrame({"open": c, "high": c, "low": c, "close": c, "volume": np.nan})
    return {k: v[~v.index.duplicated()].sort_index() for k, v in ch.items()}

def rsi(c, n=14):
    d = c.diff(); up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean(); dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean(); return 100 - 100 / (1 + up / dn)
def ema(c, n): return c.ewm(span=n, adjust=False).mean()
def atr(df, n=14):
    pc = df.close.shift(); tr = pd.concat([df.high - df.low, (df.high - pc).abs(), (df.low - pc).abs()], axis=1).max(axis=1); return tr.ewm(alpha=1 / n, adjust=False).mean()

def indicators(df):
    c = df.close; out = {}
    out["RSI"] = rsi(c); m = ema(c, 12) - ema(c, 26); out["MACDh"] = (m - ema(m, 9)) / c.abs().clip(lower=1e-9)
    s200, s50 = c.rolling(200).mean(), c.rolling(50).mean()
    out["d_EMA20"] = c / ema(c, 20) - 1; out["d_SMA50"] = c / s50 - 1; out["d_SMA200"] = c / s200 - 1
    out["slope_SMA200"] = s200 / s200.shift(20) - 1; out["slope_SMA50"] = s50 / s50.shift(10) - 1
    mid, sd = c.rolling(20).mean(), c.rolling(20).std(); out["BB_pctb"] = (c - (mid - 2 * sd)) / (4 * sd).replace(0, np.nan); out["BB_width"] = 4 * sd / mid
    out["ATRpct"] = atr(df) / c.abs().clip(lower=1e-9); out["ROC30"] = c / c.shift(30) - 1
    if df.volume.notna().any() and (df.volume > 0).mean() > .5: out["VolRatio"] = df.volume / df.volume.rolling(20).mean()
    return pd.DataFrame(out)

def features(cal):
    """binary extreme flags from trailing percentile rank (no lookahead): hi >=0.9, lo <=0.1. Computed on each chart's own calendar, then ffilled (max 5d) to 7-day calendar."""
    ch = load_ohlcv(); cols = {}; names = []
    for k, df in ch.items():
        ind = indicators(df); win = 730 if k in ("XRP", "BTC", "XRPBTC", "ETHBTC", "BTCD", "USDTD", "XRPD") else 504
        rk = ind.rolling(win, min_periods=250).rank(pct=True)
        rk = rk.reindex(cal.union(rk.index)).ffill(limit=5).reindex(cal)
        for col in rk.columns:
            r = rk[col]; cols[f"{k}:{col}:hi"] = (r >= 0.9).where(r.notna()); cols[f"{k}:{col}:lo"] = (r <= 0.1).where(r.notna())
    F = pd.DataFrame(cols).astype(float); return F, ch

def pivots(df, N, minatr, atr_n=14):
    h, l = df.high.values, df.low.values; a = atr(df, atr_n).values; n = len(df); cand = []
    for i in range(N, n - N):
        if h[i] >= h[i - N:i + N + 1].max() and h[i] > h[i - N:i].max() - 1e-12 and (h[i] > h[i + 1:i + N + 1].max()): cand.append((i, 1, h[i]))
        if l[i] <= l[i - N:i + N + 1].min() and (l[i] < l[i + 1:i + N + 1].min()) and l[i] <= l[i - N:i].min() + 1e-12: cand.append((i, -1, l[i]))
    cand.sort(); out = []
    for i, t, p in cand:
        if not out: out.append((i, t, p)); continue
        j, tj, pj = out[-1]
        if tj == t:
            if (t == 1 and p > pj) or (t == -1 and p < pj): out[-1] = (i, t, p)
        elif abs(p - pj) >= minatr * a[i]: out.append((i, t, p))
    return [(df.index[i], t, p) for i, t, p in out]

def zone_labels(cal, piv, half):
    yb = pd.Series(0, index=cal); ys = pd.Series(0, index=cal); amb = pd.Series(False, index=cal)
    for d, t, p in piv:
        w = (cal >= d - pd.Timedelta(days=half)) & (cal <= d + pd.Timedelta(days=half)); w2 = (cal >= d - pd.Timedelta(days=half + 3)) & (cal <= d + pd.Timedelta(days=half + 3))
        amb |= w2 & ~w
        if t == 1: ys[w] = 1
        else: yb[w] = 1
    return yb, ys, amb

def stats_pair(X, y):
    """singles+pairs support & hits via matrix ops. X: T x m float32, y: T"""
    Xy = X * y[:, None]; S = X.T @ X; H = Xy.T @ X; return S, H

def zmat(S, H, b, minS, minH):
    with np.errstate(all="ignore"):
        z = (H - S * b) / np.sqrt(S * b * (1 - b))
    z[(S < minS) | (H < minH)] = -np.inf; return z

def wilson(h, n, zc=1.96):
    if n == 0: return (np.nan, np.nan)
    p = h / n; d = 1 + zc ** 2 / n; c = (p + zc ** 2 / (2 * n)) / d; w = zc * np.sqrt(p * (1 - p) / n + zc ** 2 / (4 * n ** 2)) / d; return (c - w, c + w)

def greedy_triples(Xi, yi, pairs, b, minS, nmax):
    out = []
    for a, c in pairs[:nmax]:
        base = Xi[:, a] * Xi[:, c]; Sb = (Xi * base[:, None]).sum(0); Hb = (Xi * (base * yi)[:, None]).sum(0)
        zt = zmat(Sb, Hb, b, minS * 0.6, 6); zt[[a, c]] = -np.inf
        if np.isfinite(zt).any(): k = int(np.argmax(zt)); out.append((a, c, k, float(zt[k])))
    return out

def top_pairs(Z, k):
    iu = np.triu_indices_from(Z, 1); zz = Z[iu]; o = np.argsort(-zz)[:k]; return [(iu[0][i], iu[1][i]) for i in o if np.isfinite(zz[i])]

def study(F, y, valid, is_mask, oos_mask, fn, minS=30, minH=10, nperm=300, topk=15, label=""):
    X = F.values.astype(np.float32); X = np.nan_to_num(X, nan=0.0); yv = y.values.astype(np.float32)
    isr = (valid & is_mask).values; Xi, yi = X[isr], yv[isr]; b = yi.mean(); m = X.shape[1]
    S, H = stats_pair(Xi, yi); Z = zmat(S, H, b, minS, minH); Zs = np.where(np.isfinite(Z), Z, -9)
    # permutation null on IS: circular shift labels (preserves label clustering), record max z over all singles+pairs
    maxnull = []; T = len(yi)
    for _ in range(nperm):
        sh = int(rng.integers(60, T - 60)); ys = np.roll(yi, sh); S2, H2 = stats_pair(Xi, ys); z2 = zmat(S2, H2, ys.mean(), minS, minH); mx = np.nanmax(np.where(np.isfinite(z2), z2, -9))
        gt = greedy_triples(Xi, ys, top_pairs(z2, 8), ys.mean(), minS, 8); mx = max([mx] + [t[3] for t in gt]); maxnull.append(mx)
    crit95, crit90 = np.percentile(maxnull, 95), np.percentile(maxnull, 90)
    iu = np.triu_indices(m); zz = Z[iu]; order = np.argsort(-zz)[:topk * 4]; pats = []; seen = set()
    for o in order:
        a, c = iu[0][o], iu[1][o]
        if not np.isfinite(zz[o]): break
        pats.append((a, c)); 
        if len(pats) >= topk: break
    trip = greedy_triples(Xi, yi, [p for p in pats if p[0] != p[1]][:12], b, minS, 12); dd = {}
    for a, c, k, z in trip: dd.setdefault(frozenset((a, c, k)), (a, c, k, z))
    trip = [(a, c, k) for a, c, k, z in sorted(dd.values(), key=lambda t: -t[3])[:5]]
    rows = []; ev_mask = (~F.index.isna())
    def rep(idx, kind):
        col = X[:, list(idx)].prod(1); names = " & ".join(F.columns[list(idx)])
        r = {"study": label, "kind": kind, "pattern": names}
        for part, mk in (("IS", (valid & is_mask).values), ("OOS", (valid & oos_mask).values)):
            s = col[mk].sum(); h = (col[mk] * yv[mk]).sum(); base_r = yv[mk].mean(); pr = h / s if s else np.nan
            r.update({f"{part}_support": int(s), f"{part}_hits": int(h), f"{part}_prec": pr, f"{part}_base": base_r, f"{part}_lift": pr / base_r if s and base_r else np.nan, f"{part}_recall": h / yv[mk].sum() if yv[mk].sum() else np.nan,
                      f"{part}_wilson_lo": wilson(h, s)[0] / base_r if s and base_r else np.nan})
        # event-level hit: fraction of distinct zones (runs of y=1) containing >=1 pattern bar, IS and OOS
        for part, mk in (("IS", (valid & is_mask).values), ("OOS", (valid & oos_mask).values)):
            yy = yv * mk; starts = np.flatnonzero((yy == 1) & (np.r_[0, yy[:-1]] == 0)); hit = 0; tot = 0
            for s0 in starts:
                e = s0
                while e + 1 < len(yy) and yy[e + 1] == 1: e += 1
                tot += 1; hit += int(col[s0:e + 1].sum() > 0)
            r[f"{part}_zones"] = tot; r[f"{part}_zones_hit"] = hit
        r["z_IS"] = float((r["IS_hits"] - r["IS_support"] * r["IS_base"]) / np.sqrt(max(r["IS_support"] * r["IS_base"] * (1 - r["IS_base"]), 1e-9))) if r["IS_support"] else np.nan
        r["sig_FWER05"] = bool(r["z_IS"] > crit95); r["sig_FWER10"] = bool(r["z_IS"] > crit90)
        for nm, (Fx, yx, vx) in fn.items():   # cross-asset replication: same pattern against other asset's labels
            cx = np.nan_to_num(Fx.values.astype(np.float32), nan=0.0)[:, list(idx)].prod(1); yxv = yx.values.astype(np.float32)
            for part, mk in (("IS", (vx & is_mask).values), ("OOS", (vx & oos_mask).values)):
                s = cx[mk].sum(); h = (cx[mk] * yxv[mk]).sum(); r[f"{nm}_{part}_lift"] = (h / s) / yxv[mk].mean() if s and yxv[mk].mean() else np.nan; r[f"{nm}_{part}_support"] = int(s)
        rows.append(r)
    for a, c in pats: rep((a,) if a == c else (a, c), "single" if a == c else "pair")
    for t in trip: rep(t, "triple")
    return rows, {"base_IS": float(b), "n_IS_rows": int(isr.sum()), "perm_crit95": float(crit95), "perm_crit90": float(crit90), "n_patterns_tested": int(m + m * (m - 1) / 2), "mean_null_max": float(np.mean(maxnull))}

def main(nperm=300, variants=('all', 'ex_own', 'macro_only')):
    cal = pd.date_range(START, pd.Timestamp("2026-10-31")); F, ch = features(cal)
    F = F.loc[:, F.notna().mean() > 0.5]; print("features", F.shape, flush=True)
    is_mask = pd.Series(cal < OOS, index=cal); oos_mask = pd.Series(cal >= OOS, index=cal); piv_all = {}; res = []; meta = {}
    cfg = {"daily": dict(N=10, minatr=3.0, half=2), "weekly": dict(N=4, minatr=3.0, half=7)}
    labs = {}
    for tfn, cf in cfg.items():
        for asset in ("BTC", "XRP"):
            df = ch[asset]
            if tfn == "weekly":
                w = df.resample("W-SUN").agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}).dropna()
                pw = pivots(w, cf["N"], cf["minatr"]); piv = []
                for d, t, p in pw:   # map to exact extreme day inside that week
                    seg = df.loc[d - pd.Timedelta(days=6):d]; piv.append((seg.high.idxmax() if t == 1 else seg.low.idxmin(), t, p))
            else: piv = pivots(df, cf["N"], cf["minatr"])
            piv = [p for p in piv if START <= p[0] <= pd.Timestamp("2026-10-31") - pd.Timedelta(days=END_TRIM if tfn == "daily" else 30)]
            piv_all[f"{tfn}-{asset}"] = [(str(d.date()), int(t), float(p)) for d, t, p in piv]; yb, ys, amb = zone_labels(cal, piv, cf["half"])
            labs[(tfn, asset)] = {"buy": yb, "sell": ys, "valid": ~amb}
    for tfn in cfg:
        for side in ("buy", "sell"):
            for asset in ("BTC", "XRP"):
                other = "XRP" if asset == "BTC" else "BTC"
                lab = labs[(tfn, asset)]; valid = lab["valid"] & pd.Series(cal <= pd.Timestamp("2026-10-31") - pd.Timedelta(days=60 if tfn == "weekly" else 20), index=cal)
                lo = labs[(tfn, other)]; vo = lo["valid"] & valid
                nm = f"{tfn}-{asset}-{side}"
                for var in variants:
                    MAC = ("SPX:", "NDX:", "RUT:", "GOLD:", "SILVER:", "DXY:", "US10Y:")
                    Fv = F if var == "all" else (F.loc[:, [c for c in F.columns if not c.startswith(asset + ":")]] if var == "ex_own" else F.loc[:, [c for c in F.columns if c.startswith(MAC)]])
                    rows, mt = study(Fv, lab[side], valid, is_mask, oos_mask, {other: (Fv, lo[side], vo)}, label=nm + "|" + var, nperm=nperm, minS=30 if tfn == "daily" else 40, minH=10)
                    nm_ = nm + "|" + var; mt["zones_IS"] = int(((lab[side] * (valid & is_mask)).diff().fillna(0) == 1).sum()); mt["zones_OOS"] = int(((lab[side] * (valid & oos_mask)).diff().fillna(0) == 1).sum()); meta[nm_] = mt; res += rows; print(nm_, mt, flush=True)
    pd.DataFrame(res).to_csv(f"{OUTD}/testB_patterns.csv", index=False); json.dump({"meta": meta, "pivots": piv_all, "n_features": int(F.shape[1])}, open(f"{OUTD}/testB_meta.json", "w"), indent=1)
    F.notna().mean().to_csv(f"{OUTD}/testB_feature_coverage.csv")

if __name__ == "__main__":
    import sys; main(int(sys.argv[1]) if len(sys.argv) > 1 else 300)
