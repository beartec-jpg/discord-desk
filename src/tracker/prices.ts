export interface PriceData {
  symbol: string;
  price: number;
  /** 1m candle extremes so engine can catch wicks between polls */
  high?: number;
  low?: number;
}

/** Optional in-memory overrides for e2e / tests */
const overrides = new Map<string, number>();

export function setPriceOverride(symbol: string, price: number | null): void {
  const key = symbol.toUpperCase();
  if (price == null) overrides.delete(key);
  else overrides.set(key, price);
}

export function clearPriceOverrides(): void {
  overrides.clear();
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Last price + recent 1m high/low (covers wick between 15s polls).
 * Prefer data-api.binance.vision (works from restricted regions).
 */
export async function fetchPrices(symbols: string[]): Promise<PriceData[]> {
  const unique = Array.from(new Set(symbols.map((s) => s.toUpperCase())));
  const out: PriceData[] = [];

  for (const symbol of unique) {
    if (overrides.has(symbol)) {
      const p = overrides.get(symbol)!;
      out.push({ symbol, price: p, high: p, low: p });
    }
  }
  const missing = unique.filter((s) => !overrides.has(s));
  if (!missing.length) return out;

  // 1) bulk last prices
  const priceEndpoints = [
    'https://data-api.binance.vision/api/v3/ticker/price',
    'https://api.binance.com/api/v3/ticker/price',
    'https://api.binance.us/api/v3/ticker/price',
  ];
  let priceMap = new Map<string, number>();
  for (const url of priceEndpoints) {
    const all = await fetchJson(url);
    if (!Array.isArray(all)) continue;
    for (const row of all as Array<{ symbol: string; price: string }>) {
      if (row?.symbol && row?.price) priceMap.set(row.symbol, parseFloat(row.price));
    }
    if (missing.every((s) => priceMap.has(s))) break;
  }

  // 2) per-symbol 1m kline for wick high/low (last 2 bars)
  await Promise.all(
    missing.map(async (symbol) => {
      const last = priceMap.get(symbol);
      let high = last;
      let low = last;
      const klineBases = [
        'https://data-api.binance.vision',
        'https://api.binance.com',
        'https://api.binance.us',
      ];
      for (const base of klineBases) {
        const kl = await fetchJson(
          `${base}/api/v3/klines?symbol=${symbol}&interval=1m&limit=3`,
        );
        if (!Array.isArray(kl) || !kl.length) continue;
        // Use max high / min low across last 2-3 minutes so a quick sweep is seen
        high = Math.max(...kl.map((k: any) => parseFloat(k[2])));
        low = Math.min(...kl.map((k: any) => parseFloat(k[3])));
        const close = parseFloat(kl[kl.length - 1][4]);
        if (last == null && Number.isFinite(close)) priceMap.set(symbol, close);
        break;
      }
      const price = priceMap.get(symbol);
      if (price == null || !Number.isFinite(price)) return;
      out.push({
        symbol,
        price,
        high: high != null && Number.isFinite(high) ? high : price,
        low: low != null && Number.isFinite(low) ? low : price,
      });
    }),
  );

  return out;
}
