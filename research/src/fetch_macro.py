import yfinance as yf, pandas as pd, os
from fetch import D
Y = {"SPX": "^GSPC", "NDX": "^NDX", "RUT": "^RUT", "GOLD": "GC=F", "SILVER": "SI=F", "DXY": "DX-Y.NYB", "US10Y": "^TNX"}
for k, s in Y.items():
    d = yf.download(s, start="2014-01-01", progress=False, auto_adjust=False)
    d.columns = [c[0].lower() for c in d.columns]; d = d[["open", "high", "low", "close", "volume"]].dropna(subset=["close"])
    d.index = pd.to_datetime(d.index); d.index.name = "date"; d.to_parquet(f"{D}/y_{k}.parquet"); print(k, len(d), d.index.min().date(), d.index.max().date())
from tvDatafeed import TvDatafeed, Interval
tv = TvDatafeed()
for k, (s, e) in {"BTCD": ("BTC.D", "CRYPTOCAP"), "USDTD": ("USDT.D", "CRYPTOCAP"), "TOTAL": ("TOTAL", "CRYPTOCAP"), "XRPMC": ("XRP", "CRYPTOCAP"), "ETHMC": ("ETH", "CRYPTOCAP"), "BTCMC": ("BTC", "CRYPTOCAP"), "USDTMC": ("USDT", "CRYPTOCAP")}.items():
    d = None
    for t in range(4):
        d = tv.get_hist(s, e, interval=Interval.in_daily, n_bars=5000)
        if d is not None and len(d): break
    if d is None: print(k, "UNAVAILABLE"); continue
    d = d[["open", "high", "low", "close", "volume"]]; d.index = pd.to_datetime(d.index).normalize(); d.index.name = "date"; d.to_parquet(f"{D}/tv_{k}.parquet"); print(k, len(d), d.index.min().date(), d.index.max().date())
