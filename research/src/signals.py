"""Filter signals for traded asset ('XRP' or 'BTC'). State is from the asset's point of view: +1 bullish, -1 bearish, 0 neutral. Prior CLOSED bar only."""
import numpy as np, pandas as pd
from lib import *
SYM = {"XRP": "XRPUSDT", "BTC": "BTCUSDT"}
# series -> convention sign (bullish for the traded asset when the series trend is UP, times sign). None = no pre-registered convention (only used in corr-gated form)
MACRO = {"SPX": ("Y:SPX", 1), "NDX": ("Y:NDX", 1), "RUT": ("Y:RUT", 1), "GOLD": ("Y:GOLD", 1), "SILVER": ("Y:SILVER", 1), "DXY": ("Y:DXY", -1), "US10Y": ("Y:US10Y", -1)}

def series_map():
    S = {k: v[0] for k, v in MACRO.items()}
    S.update({"USDTD": "TV:USDTD", "BTCD": "TV:BTCD", "ETHBTC": "BIN:ETHBTC", "XRPBTC": "BIN:XRPBTC"})
    out = {k: daily_series(v) for k, v in S.items()}
    out["XRPD"] = (daily_series("TV:XRPMC") / daily_series("TV:TOTAL") * 100).dropna()
    out["XRP"] = daily_series("BIN:XRPUSDT"); out["BTC"] = daily_series("BIN:BTCUSDT")
    return out

def tf_close(sym, tf):
    b = resample(load15(SYM[sym]), tf); return pd.Series(b.c.values, index=b.ts.values + TF_MIN[tf] * 60_000)   # index = bar close time (ms)

def ma_state(s, kind, band=0.02):
    """price vs 200-week SMA (completed weeks) or 200-day SMA, prior closed daily bar. +1 above(+band), -1 below(-band), else 0."""
    if kind == "W200":
        wk = s.resample("W-SUN").last(); ma = wk.rolling(200).mean(); ma.index = ma.index + pd.Timedelta(days=1)   # known from Monday after the week closes
        ma = ma.reindex(s.index.union(ma.index)).ffill().reindex(s.index)
    else: ma = s.rolling(200).mean()
    st = pd.Series(0, index=s.index); st[s > ma * (1 + band)] = 1; st[s < ma * (1 - band)] = -1; st[ma.isna()] = 0; return st.astype(np.int8)

def build(asset, corr_thr=0.3):
    S = series_map(); sigs = {}; me = S[asset]
    # trends of own/other crypto price, daily and 4h
    for nm in ("XRP", "BTC"):
        sigs[f"{nm}_trend_D"] = Sig(avail_ms(S[nm].index), trend_state(S[nm]))
        c4 = tf_close(nm, "4h"); sigs[f"{nm}_trend_4h"] = Sig(c4.index.values, trend_state(c4))
    c4x = tf_close("XRP", "4h"); c4b = tf_close("BTC", "4h"); r = (c4x / c4b).dropna()
    sigs["XRPBTC_trend_4h"] = Sig(r.index.values, trend_state(r)); sigs["XRPBTC_trend_D"] = Sig(avail_ms(S["XRPBTC"].index), trend_state(S["XRPBTC"]))
    for nm in ("XRP", "BTC"):
        sigs[f"{nm}_W200"] = Sig(avail_ms(S[nm].index), ma_state(S[nm], "W200")); sigs[f"{nm}_D200"] = Sig(avail_ms(S[nm].index), ma_state(S[nm], "D200"))
    conv = {"XRPD": 1 if asset == "XRP" else None, "BTCD": -1 if asset == "XRP" else None, "USDTD": -1, "ETHBTC": 1, **{k: v[1] for k, v in MACRO.items()}}
    for k, sg in conv.items():
        if sg is None: continue
        sigs[k] = Sig(avail_ms(S[k].index), trend_state(S[k]) * sg)
    # rolling-30 corr gated: trend * sign(corr) when |corr|>=thr else 0   (corr of asset daily returns vs the series, last 30 obs, prior closed)
    other = ["XRPBTC", "XRPD", "BTCD", "USDTD", "ETHBTC"] + list(MACRO) + (["BTC"] if asset == "XRP" else ["XRP"])
    for k in other:
        s = S[k]; cr = rolling_corr(me, s).reindex(s.index)
        g = (trend_state(s) * np.sign(cr).fillna(0)).where(cr.abs() >= corr_thr, 0).astype(np.int8)
        sigs[f"{k}@corr"] = Sig(avail_ms(s.index), g)
    return sigs

def hold_assets(asset): return build(asset)
