"""Data fetch (public, keyless). Binance spot/USD-M klines + funding, Yahoo (yfinance) macro, TradingView anonymous daily for CRYPTOCAP dominance series."""
import time, requests, pandas as pd, os, sys
D = os.path.join(os.path.dirname(__file__), "..", "data"); os.makedirs(D, exist_ok=True)
def j(url, p):
    for i in range(5):
        r = requests.get(url, params=p, timeout=30)
        if r.status_code == 200: return r.json()
        time.sleep(2 + i * 3)
    raise RuntimeError(f"{url} {r.status_code}")
def klines(sym, interval, start, fut=True, step=None):
    base = "https://fapi.binance.com/fapi/v1/klines" if fut else "https://api.binance.com/api/v3/klines"
    ms = {"15m": 900_000, "1d": 86_400_000}[interval]; s = int(pd.Timestamp(start, tz="UTC").timestamp() * 1000); now = int(time.time() * 1000); out = []
    while s < now:
        r = j(base, {"symbol": sym, "interval": interval, "startTime": s, "limit": 1500 if fut else 1000})
        if not r: s += 1000 * ms; continue
        out += [x for x in r if int(x[6]) < now]; s = int(r[-1][0]) + ms; time.sleep(0.15)
    df = pd.DataFrame([[int(x[0]), float(x[1]), float(x[2]), float(x[3]), float(x[4]), float(x[5]), float(x[7]), float(x[10])] for x in out], columns=["ts", "o", "h", "l", "c", "v", "qv", "tbqv"])
    return df.drop_duplicates("ts").sort_values("ts").reset_index(drop=True)
def funding(sym, start):
    s = int(pd.Timestamp(start, tz="UTC").timestamp() * 1000); out = []
    while True:
        r = j("https://fapi.binance.com/fapi/v1/fundingRate", {"symbol": sym, "startTime": s, "limit": 1000})
        if not r: break
        out += r; s = int(r[-1]["fundingTime"]) + 1
        if len(r) < 1000: break
    return pd.DataFrame({"ts": [int(x["fundingTime"]) for x in out], "fr": [float(x["fundingRate"]) for x in out]})
if __name__ == "__main__":
    for sym in ["XRPUSDT", "BTCUSDT", "ETHUSDT"]:
        p = f"{D}/m15_{sym}.parquet"
        if not os.path.exists(p): klines(sym, "15m", "2022-07-01").to_parquet(p); print(sym, "15m done", flush=True)
        p = f"{D}/fund_{sym}.parquet"
        if not os.path.exists(p): funding(sym, "2022-07-01").to_parquet(p)
        p = f"{D}/d_{sym}.parquet"
        if not os.path.exists(p): klines(sym, "1d", "2017-08-01", fut=False).to_parquet(p); print(sym, "1d done", flush=True)
    # XRPBTC / ETHBTC spot daily
    for sym in ["XRPBTC", "ETHBTC"]:
        p = f"{D}/d_{sym}.parquet"
        if not os.path.exists(p): klines(sym, "1d", "2017-08-01", fut=False).to_parquet(p); print(sym, "1d done", flush=True)
