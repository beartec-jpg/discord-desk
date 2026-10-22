import { createXaiClient } from './xaiClient.js';
import type { DeskCache } from '../cache/index.js';

const AI_MIN_RISK_REWARD_RATIO = 1.5;
const XAI_PRIMARY_MODEL = process.env.XAI_PRIMARY_MODEL || 'grok-4.6';
const XAI_FALLBACK_MODEL = process.env.XAI_FALLBACK_MODEL || 'grok-4-1-fast-reasoning';
const XAI_THINKING_BUDGET = parseInt(process.env.XAI_THINKING_BUDGET || '5000', 10);

function extractTextContent(message: any): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    // Prefer final text answers; collect all text-like blocks as fallback
    const parts: string[] = [];
    for (const b of message.content) {
      if (!b) continue;
      if (typeof b === 'string') parts.push(b);
      if (typeof b.text === 'string') parts.push(b.text);
      if (typeof b.thinking === 'string') parts.push(b.thinking);
      if (typeof b.content === 'string') parts.push(b.content);
    }
    const textBlock = message.content.find((b: any) => b?.type === 'text' && b?.text);
    if (textBlock?.text) return textBlock.text;
    return parts.join('\n');
  }
  if (typeof message.reasoning_content === 'string') return message.reasoning_content;
  return '';
}

/** Prefer a JSON object that actually contains desk fields (not the whole API message). */
function parseDeskJsonPayload(
  raw: string,
): { multiTFInsights?: any; bestTrades?: any[]; openTradeReviews?: any[] } | null {
  if (!raw) return null;
  const cleaned = raw.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
  // Try full match first
  const attempts: string[] = [];
  const full = cleaned.match(/\{[\s\S]*\}/);
  if (full) attempts.push(full[0]);
  // Prefer objects that mention desk fields
  const marker = cleaned.search(
    /"bestTrades"\s*:|"multiTFInsights"\s*:|"openTradeReviews"\s*:/,
  );
  if (marker >= 0) {
    let start = cleaned.lastIndexOf('{', marker);
    if (start >= 0) {
      let depth = 0;
      for (let i = start; i < cleaned.length; i++) {
        if (cleaned[i] === '{') depth++;
        else if (cleaned[i] === '}') {
          depth--;
          if (depth === 0) {
            attempts.unshift(cleaned.slice(start, i + 1));
            break;
          }
        }
      }
    }
  }
  for (const chunk of attempts) {
    try {
      const parsed = JSON.parse(chunk);
      if (
        parsed &&
        (parsed.bestTrades || parsed.multiTFInsights || parsed.openTradeReviews)
      ) {
        return parsed;
      }
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // try next
    }
  }
  return null;
}

/** Compact open-book snapshot for the desk model. */
export function formatOpenTradesForDeskPrompt(openTrades: any[]): string {
  if (!openTrades?.length) {
    return 'No open/pending tracked setups currently on the book.';
  }
  return openTrades
    .map((t, i) => {
      const targets = Array.isArray(t.targets) ? t.targets.join(', ') : String(t.targets || '');
      const conf =
        t.entry_confirm_level ?? t.entryConfirmLevel ?? t.entry;
      const liftTrig = t.stop_lift_trigger ?? t.stopLiftTrigger;
      const liftTo = t.stop_lift_to ?? t.stopLiftTo;
      const reasoning = String(t.reasoning || '').slice(0, 220);
      return (
        `${i + 1}. id=${t.id} ${t.direction} ${t.symbol} status=${t.status} grade=${t.grade || '?'}\n` +
        `   entry=${t.entry} SL=${t.original_stop ?? t.current_stop} TPs=[${targets}]\n` +
        `   entryConfirm=${t.entry_confirm_type || 'reclaim'}@${conf}` +
        (liftTrig != null ? ` stopLift: tag ${liftTrig}→${liftTo}` : '') +
        `\n   thesis: ${reasoning || '(none)'}`
      );
    })
    .join('\n');
}

// Structural quality gate constants
const FIB_OTE_RETRACEMENT_HIGH = 0.382;  // Upper bound of the ICT OTE zone
const FIB_OTE_RETRACEMENT_LOW  = 0.705;  // Lower bound of the ICT OTE zone
const FVG_STRUCT_SIZE_MULTIPLIER  = 2;   // FVG size × this = structural tolerance radius
const FVG_STRUCT_PRICE_TOLERANCE  = 0.005; // 0.5% price tolerance for structural proximity

function calculateRSI(bars: any[], period = 14): number {
  if (bars.length < period + 1) return 50;
  const closes = bars.map(b => b.close);
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateMACD(bars: any[]): { histogram: number; crossover: string } {
  if (bars.length < 26) return { histogram: 0, crossover: 'none' };
  const closes = bars.map(b => b.close);
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macdLine = ema12 - ema26;
  const signalLine = calculateEMA([...Array(8).fill(macdLine), macdLine], 9);
  const histogram = macdLine - signalLine;
  const prevHistogram = histogram * 0.9;
  let crossover = 'none';
  if (histogram > 0 && prevHistogram < 0) crossover = 'bullish';
  else if (histogram < 0 && prevHistogram > 0) crossover = 'bearish';
  return { histogram, crossover };
}

function calculateEMA(data: number[], period: number): number {
  if (data.length < period) return data[data.length - 1] || 0;
  const multiplier = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = (data[i] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateStochastic(bars: any[], kPeriod = 14, dPeriod = 3): { k: number; d: number; crossover: string } {
  if (bars.length < kPeriod) return { k: 50, d: 50, crossover: 'none' };
  const recent = bars.slice(-kPeriod);
  const currentClose = bars[bars.length - 1].close;
  const lowestLow = Math.min(...recent.map(b => b.low));
  const highestHigh = Math.max(...recent.map(b => b.high));
  const k = highestHigh === lowestLow ? 50 : ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;
  const d = k * 0.9;
  let crossover = 'none';
  if (k > d && k < 25) crossover = 'bullish';
  else if (k < d && k > 75) crossover = 'bearish';
  return { k, d, crossover };
}

function calculateATR(bars: any[], period = 14): number {
  if (bars.length < period + 1) return 0;
  let atrSum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrSum += tr;
  }
  return atrSum / period;
}

function calculateADX(bars: any[], period = 14): number {
  if (bars.length < period * 2) return 25;
  let plusDM = 0, minusDM = 0, tr = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    plusDM += upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM += downMove > upMove && downMove > 0 ? downMove : 0;
    tr += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
  }
  if (tr === 0) return 25;
  const plusDI = (plusDM / tr) * 100;
  const minusDI = (minusDM / tr) * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  return dx || 25;
}

function calculateBollingerBands(bars: any[], period = 20, stdDev = 2): { middle: number; squeeze: boolean; bandwidth: number } {
  if (bars.length < period) return { middle: bars[bars.length - 1]?.close || 0, squeeze: false, bandwidth: 0 };
  const closes = bars.slice(-period).map(b => b.close);
  const sma = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((sum, c) => sum + Math.pow(c - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  const upper = sma + stdDev * std;
  const lower = sma - stdDev * std;
  const bandwidth = (upper - lower) / sma;
  return { middle: sma, squeeze: bandwidth < 0.02, bandwidth };
}

function calculateVWAP(bars: any[]): { vwap: number } {
  let cumVolume = 0, cumTPV = 0;
  for (const bar of bars.slice(-50)) {
    const tp = (bar.high + bar.low + bar.close) / 3;
    cumTPV += tp * bar.volume;
    cumVolume += bar.volume;
  }
  return { vwap: cumVolume > 0 ? cumTPV / cumVolume : bars[bars.length - 1]?.close || 0 };
}

function calculateOBV(bars: any[]): { obv: number } {
  let obv = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].close > bars[i - 1].close) obv += bars[i].volume;
    else if (bars[i].close < bars[i - 1].close) obv -= bars[i].volume;
  }
  return { obv };
}

function detectBOSCHoCH(bars: any[]): { bos: number; choch: number } {
  let bos = 0, choch = 0;
  const recent = bars.slice(-50);
  for (let i = 5; i < recent.length; i++) {
    const prevHigh = Math.max(...recent.slice(i - 5, i).map(b => b.high));
    const prevLow = Math.min(...recent.slice(i - 5, i).map(b => b.low));
    if (recent[i].close > prevHigh) bos++;
    if (recent[i].close < prevLow) choch++;
  }
  return { bos, choch };
}

function computeFibLevels(bars: any[]): { oteHigh: number; oteLow: number; swingLow: number; swingHigh: number } | null {
  const recent = bars.slice(-100);
  if (recent.length < 15) return null;
  let swingHigh = -Infinity, swingLow = Infinity;
  const lookback = 5;
  for (let i = lookback; i < recent.length - lookback; i++) {
    const isHigh = recent.slice(i - lookback, i).every((b: any) => b.high <= recent[i].high) &&
                   recent.slice(i + 1, i + lookback + 1).every((b: any) => b.high <= recent[i].high);
    const isLow  = recent.slice(i - lookback, i).every((b: any) => b.low >= recent[i].low) &&
                   recent.slice(i + 1, i + lookback + 1).every((b: any) => b.low >= recent[i].low);
    if (isHigh && recent[i].high > swingHigh) swingHigh = recent[i].high;
    if (isLow  && recent[i].low  < swingLow)  swingLow  = recent[i].low;
  }
  if (swingHigh === -Infinity || swingLow === Infinity || swingHigh <= swingLow) return null;
  const range = swingHigh - swingLow;
  // OTE zone: 0.382-0.705 retracement from the swing high (price pulling back into range)
  return {
    swingLow,
    swingHigh,
    oteHigh: swingHigh - range * FIB_OTE_RETRACEMENT_HIGH,
    oteLow:  swingHigh - range * FIB_OTE_RETRACEMENT_LOW,
  };
}

function detectFVGs(
  bars: any[],
): { bullish: Array<{low: number; high: number}>; bearish: Array<{low: number; high: number}> } {
  const bullish: Array<{low: number; high: number}> = [];
  const bearish: Array<{low: number; high: number}> = [];
  const recent = bars.slice(-100);

  // Collect all raw FVGs with no ATR filter
  const rawBullish: Array<{low: number; high: number}> = [];
  const rawBearish: Array<{low: number; high: number}> = [];
  for (let i = 2; i < recent.length; i++) {
    if (recent[i].low > recent[i - 2].high) {
      rawBullish.push({ low: recent[i - 2].high, high: recent[i].low });
    }
    if (recent[i].high < recent[i - 2].low) {
      rawBearish.push({ low: recent[i].high, high: recent[i - 2].low });
    }
  }

  // Structural quality gate: keep only FVGs aligned with a real level
  const swings = detectSwingPivots(recent, 5);
  const obs = detectOrderBlocks(recent);
  const fib = computeFibLevels(recent);
  const ema20  = calculateEMA(recent.map(b => b.close), 20);
  const ema50  = calculateEMA(recent.map(b => b.close), 50);
  const ema200 = calculateEMA(recent.map(b => b.close), 200);

  const isAtStructure = (fvgLow: number, fvgHigh: number): boolean => {
    const fvgMid = (fvgLow + fvgHigh) / 2;
    const tolerance = Math.max((fvgHigh - fvgLow) * FVG_STRUCT_SIZE_MULTIPLIER, fvgMid * FVG_STRUCT_PRICE_TOLERANCE);
    if ([...swings.highs, ...swings.lows].some(s => Math.abs(s - fvgMid) <= tolerance)) return true;
    if ([...obs.bullish, ...obs.bearish].some(ob => ob.low <= fvgHigh && ob.high >= fvgLow)) return true;
    if (fib && fvgHigh >= fib.oteLow && fvgLow <= fib.oteHigh) return true;
    if ([ema20, ema50, ema200].some(e => e > 0 && Math.abs(e - fvgMid) <= tolerance)) return true;
    return false;
  };

  for (const fvg of rawBullish.slice(-10)) {
    if (isAtStructure(fvg.low, fvg.high)) bullish.push(fvg);
  }
  for (const fvg of rawBearish.slice(-10)) {
    if (isAtStructure(fvg.low, fvg.high)) bearish.push(fvg);
  }
  return { bullish: bullish.slice(-3), bearish: bearish.slice(-3) };
}

function detectOrderBlocks(bars: any[]): { bullish: Array<{low: number; high: number}>; bearish: Array<{low: number; high: number}> } {
  const bullish: Array<{low: number; high: number}> = [];
  const bearish: Array<{low: number; high: number}> = [];
  const recent = bars.slice(-100);
  for (let i = 1; i < recent.length - 3; i++) {
    const isBullishImpulse = recent[i + 1].close > recent[i].high && recent[i + 2].close > recent[i].high;
    const isBearishImpulse = recent[i + 1].close < recent[i].low && recent[i + 2].close < recent[i].low;
    // Bearish OB: last bullish candle before a bearish impulse
    if (recent[i].close > recent[i].open && isBearishImpulse) {
      bearish.push({ low: recent[i].low, high: recent[i].high });
    }
    // Bullish OB: last bearish candle before a bullish impulse
    if (recent[i].close < recent[i].open && isBullishImpulse) {
      bullish.push({ low: recent[i].low, high: recent[i].high });
    }
  }
  return { bullish: bullish.slice(-3), bearish: bearish.slice(-3) };
}

function calculateVolumeProfile(bars: any[]): { poc: number; vah: number; val: number } {
  const recent = bars.slice(-200);
  if (recent.length === 0) return { poc: 0, vah: 0, val: 0 };
  const low = Math.min(...recent.map(b => b.low));
  const high = Math.max(...recent.map(b => b.high));
  const range = high - low;
  if (range === 0) return { poc: recent[recent.length - 1].close, vah: high, val: low };
  const buckets = 50;
  const bucketSize = range / buckets;
  const volumeBuckets = new Array(buckets).fill(0);
  for (const bar of recent) {
    const startBucket = Math.floor((bar.low - low) / bucketSize);
    const endBucket = Math.min(Math.floor((bar.high - low) / bucketSize), buckets - 1);
    const barsInBucket = endBucket - startBucket + 1;
    for (let b = Math.max(0, startBucket); b <= endBucket; b++) {
      volumeBuckets[b] += bar.volume / Math.max(1, barsInBucket);
    }
  }
  const pocBucket = volumeBuckets.indexOf(Math.max(...volumeBuckets));
  const poc = low + (pocBucket + 0.5) * bucketSize;
  const totalVolume = volumeBuckets.reduce((a, b) => a + b, 0);
  const targetVolume = totalVolume * 0.7;
  let accumulated = 0;
  let vahBucket = pocBucket;
  let valBucket = pocBucket;
  let upper = pocBucket;
  let lower = pocBucket;
  while (accumulated < targetVolume && (upper < buckets - 1 || lower > 0)) {
    const upVol = upper < buckets - 1 ? volumeBuckets[upper + 1] : 0;
    const downVol = lower > 0 ? volumeBuckets[lower - 1] : 0;
    if (upVol >= downVol && upper < buckets - 1) { upper++; accumulated += upVol; vahBucket = upper; }
    else if (lower > 0) { lower--; accumulated += downVol; valBucket = lower; }
    else break;
  }
  return {
    poc,
    vah: low + (vahBucket + 1) * bucketSize,
    val: low + valBucket * bucketSize
  };
}

function detectSwingPivots(bars: any[], lookback = 5): { highs: number[]; lows: number[] } {
  const recent = bars.slice(-100);
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = lookback; i < recent.length - lookback; i++) {
    const window = recent.slice(i - lookback, i + lookback + 1);
    if (recent[i].high === Math.max(...window.map(b => b.high))) highs.push(recent[i].high);
    if (recent[i].low === Math.min(...window.map(b => b.low))) lows.push(recent[i].low);
  }
  return { highs: highs.slice(-5), lows: lows.slice(-5) };
}

async function fetchBarsForTF(symbol: string, tf: string, limit = 500) {
  const capped = Math.max(50, Math.min(1000, limit));
  // Prefer global / data-api endpoints (Vercel often blocked on binance.us alone)
  const urls = [
    `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${capped}`,
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${capped}`,
    `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${capped}`,
  ];
  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) {
        lastError = new Error(`Failed to fetch ${tf} data (${response.status}) from ${url}`);
        continue;
      }
      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) {
        lastError = new Error(`Empty klines for ${tf} from ${url}`);
        continue;
      }
      return data.map((k: any) => ({
        time: k[0] / 1000,
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError || new Error(`Failed to fetch ${tf} data`);
}

function formatMacroPrice(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(5);
}

function formatMacroDate(tsSec: number): string {
  return new Date(tsSec * 1000).toISOString().slice(0, 10);
}

function detectDatedSwings(
  bars: any[],
  lookback: number,
  maxEach = 10,
): { highs: Array<{ price: number; date: string; time: number }>; lows: Array<{ price: number; date: string; time: number }> } {
  const highs: Array<{ price: number; date: string; time: number }> = [];
  const lows: Array<{ price: number; date: string; time: number }> = [];
  if (bars.length < lookback * 2 + 1) return { highs, lows };
  for (let i = lookback; i < bars.length - lookback; i++) {
    const window = bars.slice(i - lookback, i + lookback + 1);
    if (bars[i].high === Math.max(...window.map((b) => b.high))) {
      highs.push({ price: bars[i].high, date: formatMacroDate(bars[i].time), time: bars[i].time });
    }
    if (bars[i].low === Math.min(...window.map((b) => b.low))) {
      lows.push({ price: bars[i].low, date: formatMacroDate(bars[i].time), time: bars[i].time });
    }
  }
  return { highs: highs.slice(-maxEach), lows: lows.slice(-maxEach) };
}

function rangeOf(bars: any[], count: number): { high: number; low: number } | null {
  const slice = bars.slice(-count);
  if (!slice.length) return null;
  return {
    high: Math.max(...slice.map((b) => b.high)),
    low: Math.min(...slice.map((b) => b.low)),
  };
}

type MacroProximity = 'near' | 'approaching' | 'far';

function classifyMacroDistance(
  price: number,
  level: number,
  nearPct = 8,
  approachPct = 16,
): { pct: number; band: MacroProximity } {
  const pct = Math.abs(level - price) / price * 100;
  if (pct <= nearPct) return { pct, band: 'near' };
  if (pct <= approachPct) return { pct, band: 'approaching' };
  return { pct, band: 'far' };
}

/**
 * Weekly + monthly areas of interest. Only nearby / approaching levels are
 * candidates for analysis or TP2. Far-away history is listed as IGNORE.
 */
async function buildMacroContext(symbol: string): Promise<{ text: string; levels: string[] }> {
  const [weekly, monthly] = await Promise.all([
    fetchBarsForTF(symbol, '1w', 400).catch((err) => {
      console.warn(`[macro] weekly fetch failed for ${symbol}:`, err?.message || err);
      return [] as any[];
    }),
    fetchBarsForTF(symbol, '1M', 160).catch((err) => {
      console.warn(`[macro] monthly fetch failed for ${symbol}:`, err?.message || err);
      return [] as any[];
    }),
  ]);

  const price = weekly.at(-1)?.close ?? monthly.at(-1)?.close;
  if (!price) {
    return { text: 'MACRO CONTEXT: unavailable (no weekly/monthly bars).', levels: [] };
  }

  const weeklyAtr = weekly.length ? calculateATR(weekly, 14) : 0;
  const nearPct = weeklyAtr > 0 ? Math.min(12, Math.max(6, (weeklyAtr / price) * 100 * 2)) : 8;
  const approachPct = nearPct * 2;

  const lines: string[] = [
    `**MACRO CONTEXT (weekly / monthly)**`,
    `Spot: $${formatMacroPrice(price)} · nearby ≈ within ${nearPct.toFixed(1)}% or ~2.5 weekly ATRs`,
    `Relevance: IGNORE far levels. Only NEAR / APPROACHING levels may be mentioned or used as TP2, and only if price can get there without first reversing the other way.`,
  ];
  const relevant: string[] = [];

  const addCandidate = (label: string, levelPrice: number, extra = '') => {
    const { pct, band } = classifyMacroDistance(price, levelPrice, nearPct, approachPct);
    const dir = levelPrice >= price ? 'above' : 'below';
    const tag = band === 'far' ? 'IGNORE (too far)' : band === 'near' ? 'NEAR' : 'APPROACHING';
    const line = `${tag} ${label} $${formatMacroPrice(levelPrice)} (${pct.toFixed(1)}% ${dir})${extra ? ` — ${extra}` : ''}`;
    lines.push(`- ${line}`);
    if (band !== 'far') relevant.push(line);
  };

  const describeTf = (tf: string, bars: any[], lookback: number, rangeBars: number) => {
    if (!bars.length) {
      lines.push(`- ${tf}: no data`);
      return;
    }
    const swings = detectDatedSwings(bars, lookback, 10);
    const range = rangeOf(bars, rangeBars);
    const ema20 = calculateEMA(bars.map((b) => b.close), 20);

    if (range) {
      addCandidate(`${tf} range high`, range.high);
      addCandidate(`${tf} range low`, range.low);
    }
    lines.push(`- ${tf} EMA20 $${formatMacroPrice(ema20)}`);

    for (const h of swings.highs) {
      const idx = bars.findIndex((b) => b.time === h.time);
      const laterBroke = idx >= 0 && bars.slice(idx + 1).some((b) => b.close > h.price * 1.002);
      const extra = laterBroke ? `old breakout/retest ${h.date}` : `swing high ${h.date}`;
      addCandidate(`${tf} ${extra}`, h.price);
    }
    for (const l of swings.lows) {
      const idx = bars.findIndex((b) => b.time === l.time);
      const laterBroke = idx >= 0 && bars.slice(idx + 1).some((b) => b.close < l.price * 0.998);
      const extra = laterBroke ? `old breakdown/retest ${l.date}` : `swing low ${l.date}`;
      addCandidate(`${tf} ${extra}`, l.price);
    }
  };

  describeTf('1w', weekly, 3, 52);
  describeTf('1M', monthly, 2, 24);

  if (!relevant.length) {
    lines.push('- No weekly/monthly level is close enough to matter on this trade. Keep TP2 on current-range structure.');
  }

  return { text: lines.join('\n'), levels: relevant.slice(0, 10) };
}

function buildTargetsRule(higherTimeframe: string, lowerTimeframe: string): string {
  return (
    `9. TARGETS:\n` +
    `   - TP1 = nearest valid opposing level of the CURRENT range/swing in the trade direction ` +
    `(range high for LONG, range low for SHORT on ${higherTimeframe}/${lowerTimeframe}). Keep TP1 local.\n` +
    `   - TP2 = next structural target on this trade's path. A weekly/monthly magnet may be TP2 ONLY if it is NEAR or APPROACHING ` +
    `AND you judge price can reach it without first reversing the other way past invalidation / the opposing range. ` +
    `If the macro level is far, IGNORE it — do not stretch TP2 to a 2023 high just because it exists.\n` +
    `   - If a macro level is getting close, mention it in analysis (and in tp2Rationale if you use it). If it is far, do not mention it.\n` +
    `   - Min R/R is measured to TP1 (not TP2).`
  );
}


function describeOpenZones(bars: any[]) {
  const recent = bars.slice(-100);
  const swings = detectSwingPivots(recent, 5);
  const zones: Array<{ low: number; high: number; index: number; side: 'bull' | 'bear' }> = [];
  const bullFvg: typeof zones = [];
  const bearFvg: typeof zones = [];
  const bullOb: typeof zones = [];
  const bearOb: typeof zones = [];
  for (let i = 2; i < recent.length; i++) {
    if (recent[i].low > recent[i - 2].high) {
      bullFvg.push({ low: recent[i - 2].high, high: recent[i].low, index: i, side: 'bull' });
    }
    if (recent[i].high < recent[i - 2].low) {
      bearFvg.push({ low: recent[i].high, high: recent[i - 2].low, index: i, side: 'bear' });
    }
  }
  for (let i = 1; i < recent.length - 3; i++) {
    const bullImpulse = recent[i + 1].close > recent[i].high && recent[i + 2].close > recent[i].high;
    const bearImpulse = recent[i + 1].close < recent[i].low && recent[i + 2].close < recent[i].low;
    if (recent[i].close > recent[i].open && bearImpulse) {
      bearOb.push({ low: recent[i].low, high: recent[i].high, index: i, side: 'bear' });
    }
    if (recent[i].close < recent[i].open && bullImpulse) {
      bullOb.push({ low: recent[i].low, high: recent[i].high, index: i, side: 'bull' });
    }
  }
  const stillOpen = (zone: (typeof zones)[number]) => {
    for (let j = zone.index + 1; j < recent.length; j++) {
      if (zone.side === 'bull' && recent[j].close < zone.low) return false;
      if (zone.side === 'bear' && recent[j].close > zone.high) return false;
    }
    return true;
  };
  const originOf = (zone: (typeof zones)[number]) => {
    if (zone.side === 'bull') {
      const lows = swings.lows.filter((v) => v <= zone.low * 1.001);
      if (!lows.length) return recent[Math.max(0, zone.index - 2)].low;
      return lows.reduce((best, v) => (Math.abs(v - zone.low) < Math.abs(best - zone.low) ? v : best));
    }
    const highs = swings.highs.filter((v) => v >= zone.high * 0.999);
    if (!highs.length) return recent[Math.max(0, zone.index - 2)].high;
    return highs.reduce((best, v) => (Math.abs(v - zone.high) < Math.abs(best - zone.high) ? v : best));
  };
  const fmt = (list: typeof zones) => {
    const kept = list.filter(stillOpen).slice(-3);
    if (!kept.length) return 'None';
    return kept
      .map((zone) => `$${zone.low.toFixed(4)}-$${zone.high.toFixed(4)} origin $${originOf(zone).toFixed(4)}`)
      .join(' | ');
  };
  return {
    bullFVGs: fmt(bullFvg),
    bearFVGs: fmt(bearFvg),
    bullOBs: fmt(bullOb),
    bearOBs: fmt(bearOb),
  };
}

function computeIndicators(bars: any[]) {
  const currentPrice = bars[bars.length - 1].close;
  const rsi = calculateRSI(bars, 14);
  const macd = calculateMACD(bars);
  const stoch = calculateStochastic(bars, 14, 3);
  const atr = calculateATR(bars, 14);
  const adx = calculateADX(bars);
  const bb = calculateBollingerBands(bars, 20, 2);
  const vwapCalc = calculateVWAP(bars);
  const obv = calculateOBV(bars);
  const boschoch = detectBOSCHoCH(bars);
  const openZones = describeOpenZones(bars);
  const volProfile = calculateVolumeProfile(bars);
  const swings = detectSwingPivots(bars);
  const recentHigh = Math.max(...bars.slice(-20).map(b => b.high));
  const recentLow = Math.min(...bars.slice(-20).map(b => b.low));

  // Fibonacci OTE zone
  const fib = computeFibLevels(bars);
  const fibOteZone = fib
    ? `$${fib.oteLow.toFixed(4)}-$${fib.oteHigh.toFixed(4)} (swing $${fib.swingLow.toFixed(4)}-$${fib.swingHigh.toFixed(4)})`
    : 'n/a';

  // Key EMA values
  const ema20  = calculateEMA(bars.map(b => b.close), 20);
  const ema50  = calculateEMA(bars.map(b => b.close), 50);
  const ema200 = calculateEMA(bars.map(b => b.close), 200);

  // EMA confluence flags
  const emaTol = currentPrice * FVG_STRUCT_PRICE_TOLERANCE;
  const emaConf: string[] = [];
  if (Math.abs(ema20  - currentPrice) <= emaTol) emaConf.push(`EMA20@$${ema20.toFixed(4)}`);
  if (Math.abs(ema50  - currentPrice) <= emaTol) emaConf.push(`EMA50@$${ema50.toFixed(4)}`);
  if (Math.abs(ema200 - currentPrice) <= emaTol) emaConf.push(`EMA200@$${ema200.toFixed(4)}`);

  // Whether current price is inside the Fib OTE zone
  const inFibOte = fib ? (currentPrice <= fib.oteHigh && currentPrice >= fib.oteLow) : false;

  return {
    currentPrice,
    rsi: rsi.toFixed(2),
    macd: { histogram: macd.histogram.toFixed(4), crossover: macd.crossover },
    stoch: { k: stoch.k.toFixed(2), d: stoch.d.toFixed(2), crossover: stoch.crossover },
    atr: atr.toFixed(6),
    adx: adx.toFixed(2),
    bb: { middle: bb.middle.toFixed(4), squeeze: bb.squeeze, bandwidth: (bb.bandwidth * 100).toFixed(2) },
    vwap: vwapCalc.vwap.toFixed(4),
    obv: (obv.obv / 1000000).toFixed(2) + 'M',
    bos: boschoch.bos,
    choch: boschoch.choch,
    poc: volProfile.poc.toFixed(4),
    vah: volProfile.vah.toFixed(4),
    val: volProfile.val.toFixed(4),
    bullFVGs: openZones.bullFVGs,
    bearFVGs: openZones.bearFVGs,
    bullOBs: openZones.bullOBs,
    bearOBs: openZones.bearOBs,
    swingHighs: swings.highs.map(h => `$${h.toFixed(4)}`).join(' → ') || 'None',
    swingLows: swings.lows.map(l => `$${l.toFixed(4)}`).join(' → ') || 'None',
    recentHigh: recentHigh.toFixed(4),
    recentLow: recentLow.toFixed(4),
    fibOteZone,
    inFibOte,
    ema20: ema20.toFixed(4),
    ema50: ema50.toFixed(4),
    ema200: ema200.toFixed(4),
    emaConf: emaConf.length > 0 ? emaConf.join(', ') : 'None',
  };
}

function buildGeneralPrompt(symbol: string, higherTimeframe: string, lowerTimeframe: string, higherData: ReturnType<typeof computeIndicators>, lowerData: ReturnType<typeof computeIndicators>) {
  const fmtTF = (label: string, d: ReturnType<typeof computeIndicators>) => `
**${label} (${label === higherTimeframe ? 'Higher TF bias' : 'Lower TF execution'}):**
- Price: $${d.currentPrice}, ATR(14): $${d.atr}, RSI: ${d.rsi}, MACD hist: ${d.macd.histogram}${d.macd.crossover !== 'none' ? ` (${d.macd.crossover})` : ''}
- Stoch: %K ${d.stoch.k}, %D ${d.stoch.d}${d.stoch.crossover !== 'none' ? ` (${d.stoch.crossover})` : ''} | ADX: ${d.adx}
- Volume Profile: POC $${d.poc} | VAH $${d.vah} | VAL $${d.val}
- VWAP: $${d.vwap} | OBV: ${d.obv} | BOS: ${d.bos} | CHoCH: ${d.choch}
- Bullish FVGs: ${d.bullFVGs} | Bearish FVGs: ${d.bearFVGs}
- Bullish OBs: ${d.bullOBs} | Bearish OBs: ${d.bearOBs}
- Swing Highs: ${d.swingHighs} | Swing Lows: ${d.swingLows}
- EMAs: 20=$${d.ema20} 50=$${d.ema50} 200=$${d.ema200} | EMA confluence: ${d.emaConf}
- Fib OTE zone (0.382-0.705): ${d.fibOteZone}${d.inFibOte ? ' ← price IN OTE' : ''}
- Range: $${d.recentLow} - $${d.recentHigh}`;

  return `Symbol: ${symbol} | General multi-timeframe overview
Higher timeframe: ${higherTimeframe}
Lower timeframe: ${lowerTimeframe}
${fmtTF(higherTimeframe, higherData)}
${fmtTF(lowerTimeframe, lowerData)}

Give a concise at-a-glance analysis only. Do NOT produce a trade plan, entry, stop, targets, or risk/reward.
- Higher timeframe: focus on dominant bias/trend and key levels.
- Lower timeframe: focus on momentum/structure, alignment with the higher timeframe, and nearby trigger levels.
- Keep summaries brief and actionable.

Respond with ONLY valid JSON:
{
  "multiTFInsights": {
    "${higherTimeframe}": { "summary": "1-2 sentences on higher timeframe bias/trend", "bias": "BULLISH/BEARISH/NEUTRAL", "keyLevels": ["..."] },
    "${lowerTimeframe}": { "summary": "1-2 sentences on lower timeframe momentum/structure", "bias": "BULLISH/BEARISH/NEUTRAL", "keyLevels": ["..."] },
    "overallSummary": "1-2 sentences on alignment between the two timeframes and what matters next"
  }
}`;
}

async function generateGeneralPairAnalysis(apiKey: string, symbol: string, higherTimeframe: string, lowerTimeframe: string) {
  const requestedFrames = Array.from(new Set([lowerTimeframe, higherTimeframe]));
  const barsByTimeframe = Object.fromEntries(
    await Promise.all(requestedFrames.map(async (tf) => [tf, await fetchBarsForTF(symbol, tf)]))
  ) as Record<string, any[]>;

  const lowerData = computeIndicators(barsByTimeframe[lowerTimeframe]);
  const higherData = computeIndicators(barsByTimeframe[higherTimeframe]);
  const generalPrompt = buildGeneralPrompt(symbol, higherTimeframe, lowerTimeframe, higherData, lowerData);

  const openai = createXaiClient(apiKey);

  let completion: any;
  try {
    completion = await (openai.chat.completions.create as any)({
      model: XAI_PRIMARY_MODEL,
      messages: [
        { role: 'system', content: 'You are a concise crypto market analyst. Compare the higher and lower timeframe, explain bias, momentum, structure, and key levels, and keep it lightweight. Never produce a trade plan. Always respond with valid JSON only.' },
        { role: 'user', content: generalPrompt }
      ],
      temperature: 0.2,
      max_tokens: 1200
    });
  } catch (primaryModelError: any) {
    console.warn(`⚠️ ${XAI_PRIMARY_MODEL} failed (${primaryModelError.message}), falling back to ${XAI_FALLBACK_MODEL}`);
    completion = await openai.chat.completions.create({
      model: XAI_FALLBACK_MODEL,
      messages: [
        { role: 'system', content: 'You are a concise crypto market analyst. Compare the higher and lower timeframe, explain bias, momentum, structure, and key levels, and keep it lightweight. Never produce a trade plan. Always respond with valid JSON only.' },
        { role: 'user', content: generalPrompt }
      ],
      temperature: 0.3,
      max_tokens: 1200
    });
  }

  const inputTokens = completion.usage?.prompt_tokens || 0;
  const outputTokens = completion.usage?.completion_tokens || 0;
  const estimatedCost = (inputTokens / 1_000_000 * 2) + (outputTokens / 1_000_000 * 10);

  let multiTFInsights: any = null;
  try {
    let rawContent = extractTextContent(completion.choices[0]?.message);
    rawContent = rawContent.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { multiTFInsights: null };
    multiTFInsights = parsed.multiTFInsights || null;
  } catch (parseError) {
    console.error('Failed to parse Grok response:', parseError);
  }

  return {
    multiTFInsights,
    estimatedCost,
    tokens: { input: inputTokens, output: outputTokens },
  };
}

function normaliseSnapshots(rawSnapshots: any): any[] {
  return Array.isArray(rawSnapshots) ? rawSnapshots.filter(Boolean) : [];
}

function rotateSnapshots(rawSnapshots: any, nextSnapshot: any) {
  return [nextSnapshot, ...normaliseSnapshots(rawSnapshots)].slice(0, 3);
}

export async function runGeneralPairRefresh(cache: DeskCache, apiKey: string, symbol: string, higherTimeframe: string, lowerTimeframe: string) {
  const {
    encodeCryptoAiPairInterval,
    getCryptoAiCycleSession,
    getSessionDisplayName,
  } = await import('../lib/cryptoAiConfig.js');
  const interval = encodeCryptoAiPairInterval(higherTimeframe as any, lowerTimeframe as any);
  const generated = await generateGeneralPairAnalysis(apiKey, symbol, higherTimeframe, lowerTimeframe);
  const session = getCryptoAiCycleSession();
  const generatedAt = new Date().toISOString();
  const snapshot = {
    session,
    label: getSessionDisplayName(session),
    generatedAt,
    higherTimeframe,
    lowerTimeframe,
    multiTFInsights: generated.multiTFInsights,
    estimatedCost: generated.estimatedCost,
    tokens: generated.tokens,
  };

  const existing = await cache.getGeneral(symbol, interval);

  const snapshots = rotateSnapshots(existing?.snapshots, snapshot);
  const aiNarration = {
    multiTFInsights: generated.multiTFInsights,
    estimatedCost: generated.estimatedCost,
    tokens: generated.tokens,
    refreshedAt: generatedAt,
    session,
  };

  await cache.setGeneral(symbol, interval, {
    aiNarration,
    snapshots,
    higherTimeframe,
    lowerTimeframe,
    updatedAt: generatedAt,
  });

  return {
    cached: false,
    session,
    refreshedAt: generatedAt,
    snapshots,
    multiTFInsights: generated.multiTFInsights,
    estimatedCost: generated.estimatedCost,
    tokens: generated.tokens,
  };
}

/** Map common desk aliases to Binance spot symbols (cache + klines). */
export function normalizeBinanceSpotSymbol(raw: string): string {
  const s = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return 'BTCUSDT';
  if (s === 'BTC' || s === 'XBT' || s === 'BTCUSD' || s === 'XBTUSD') return 'BTCUSDT';
  if (s === 'ETH' || s === 'ETHUSD') return 'ETHUSDT';
  if (s === 'SOL' || s === 'SOLUSD') return 'SOLUSDT';
  if (s.endsWith('USD') && !s.endsWith('USDT') && !s.endsWith('USDC')) {
    return `${s.slice(0, -3)}USDT`;
  }
  return s;
}

/**
 * System deep-dive (no user auth / credits) — used by Discord pre-London cron.
 */
export async function runSystemDeepDive(options: {
  apiKey: string;
  symbol: string;
  higherTimeframe?: string;
  lowerTimeframe?: string;
  mode?: string;
  tradeHorizon?: string;
  minRiskReward?: number;
  minConfluence?: number;
  /** When true (default for Discord), still return top priced ideas if strict gates empty. */
  softGates?: boolean;
  /**
   * Active tracker book (pending / armed / open / partial) for re-validation.
   * AI must return openTradeReviews keep|cancel for each id.
   */
  openTrades?: any[];
}): Promise<{
  multiTFInsights: any;
  bestTrades: any[];
  openTradeReviews: any[];
  estimatedCost: number;
  tokens: { input: number; output: number };
  higherTimeframe: string;
  lowerTimeframe: string;
  tradeHorizon: string;
  modeId: string;
  gatesRelaxed?: boolean;
  rawTradeCount?: number;
  macroLevels?: string[];
}> {
  const {
    DEFAULT_CRYPTO_AI_HIGHER_TIMEFRAME,
    DEFAULT_CRYPTO_AI_LOWER_TIMEFRAME,
    DEFAULT_CRYPTO_AI_TRADE_HORIZON,
    normalizeCryptoAiPair,
    buildCryptoAiHorizonPromptBlock,
    getCryptoAiTradeHorizon,
  } = await import('../lib/cryptoAiConfig.js');
  const { getAiTraderMode } = await import('../lib/aiTraderModes.js');

  const pair = normalizeCryptoAiPair(
    options.higherTimeframe || DEFAULT_CRYPTO_AI_HIGHER_TIMEFRAME,
    options.lowerTimeframe || DEFAULT_CRYPTO_AI_LOWER_TIMEFRAME,
  );
  const higherTimeframe = pair.higherTimeframe;
  const lowerTimeframe = pair.lowerTimeframe;
  const traderMode = getAiTraderMode(options.mode);
  const tradeHorizonMeta = getCryptoAiTradeHorizon(options.tradeHorizon || DEFAULT_CRYPTO_AI_TRADE_HORIZON);
  const tradeHorizon = tradeHorizonMeta.id;
  const horizonPrompt = buildCryptoAiHorizonPromptBlock(tradeHorizon, higherTimeframe, lowerTimeframe);
  const minRiskReward = Number(options.minRiskReward ?? AI_MIN_RISK_REWARD_RATIO);
  const minConfluence = Number(options.minConfluence ?? 3);
  const counterTrendMinConfluence = minConfluence + 1;
  const softGates = options.softGates !== false;
  const symbol = normalizeBinanceSpotSymbol(options.symbol);
  const openTrades = Array.isArray(options.openTrades) ? options.openTrades : [];
  const openBookBlock = formatOpenTradesForDeskPrompt(openTrades);

  const requestedFrames = Array.from(new Set([lowerTimeframe, higherTimeframe]));
  const barsByTimeframe = Object.fromEntries(
    await Promise.all(requestedFrames.map(async (tf) => [tf, await fetchBarsForTF(symbol, tf)])),
  ) as Record<string, any[]>;

  const lowerData = computeIndicators(barsByTimeframe[lowerTimeframe]);
  const higherData = computeIndicators(barsByTimeframe[higherTimeframe]);
  const macro = await buildMacroContext(symbol);

  const fmtTF = (label: string, d: ReturnType<typeof computeIndicators>) => `
**${label} (${label === higherTimeframe ? 'Higher TF bias' : 'Lower TF execution'}):**
- Price: $${d.currentPrice}, ATR(14): $${d.atr}, RSI: ${d.rsi}, MACD hist: ${d.macd.histogram}${d.macd.crossover !== 'none' ? ` (${d.macd.crossover})` : ''}
- Stoch: %K ${d.stoch.k}, %D ${d.stoch.d}${d.stoch.crossover !== 'none' ? ` (${d.stoch.crossover})` : ''} | ADX: ${d.adx}
- Volume Profile: POC $${d.poc} | VAH $${d.vah} | VAL $${d.val}
- VWAP: $${d.vwap} | OBV: ${d.obv} | BOS: ${d.bos} | CHoCH: ${d.choch}
- Bullish FVGs: ${d.bullFVGs} | Bearish FVGs: ${d.bearFVGs}
- Bullish OBs: ${d.bullOBs} | Bearish OBs: ${d.bearOBs}
- Swing Highs: ${d.swingHighs} | Swing Lows: ${d.swingLows}
- EMAs: 20=$${d.ema20} 50=$${d.ema50} 200=$${d.ema200} | EMA confluence: ${d.emaConf}
- Fib OTE zone (0.382-0.705): ${d.fibOteZone}${d.inFibOte ? ' ← price IN OTE' : ''}
- Range: $${d.recentLow} - $${d.recentHigh}`;

  let htfBiasScore = 0;
  const higherRsi = parseFloat(higherData.rsi);
  const lowerRsi = parseFloat(lowerData.rsi);
  if (higherRsi > 55) htfBiasScore += 2;
  else if (higherRsi < 45) htfBiasScore -= 2;
  if (lowerRsi > 55) htfBiasScore += 1;
  else if (lowerRsi < 45) htfBiasScore -= 1;
  if (parseFloat(higherData.macd.histogram) > 0) htfBiasScore += 2;
  else if (parseFloat(higherData.macd.histogram) < 0) htfBiasScore -= 2;
  if (parseFloat(lowerData.macd.histogram) > 0) htfBiasScore += 1;
  else if (parseFloat(lowerData.macd.histogram) < 0) htfBiasScore -= 1;
  const dominantBias = htfBiasScore >= 2 ? 'BULLISH' : htfBiasScore <= -2 ? 'BEARISH' : 'NEUTRAL';

  const deepPrompt = `Symbol: ${symbol} | Multi-timeframe trade search
Dominant bias from ${higherTimeframe}: ${dominantBias}
${horizonPrompt}
${fmtTF(higherTimeframe, higherData)}
${fmtTF(lowerTimeframe, lowerData)}

${macro.text}

**OPEN BOOK (from trade tracker — your previous desk ideas still live)**
${openBookBlock}

**OPEN BOOK REVIEW — MANDATORY**
For EVERY setup listed above with an id, decide keep or cancel against CURRENT structure/price.
- keep: zone still valid; do NOT invent a duplicate of the same idea.
- cancel: structure filled, broken, or no longer high-probability — remove from the book.
- Prefer cancel over keep if the thesis is stale or HTF context flipped against it.
- You MUST return one openTradeReviews entry per open-book id (empty array only if open book is empty).

**TRADE SEARCH RULES — MANDATORY**
1. ${higherTimeframe} sets directional context and the dominant destination; it is NOT a hard veto.
2. Favour with-trend setups and tag them as "with-trend". Counter-trend setups are allowed when local structure and confluence justify them; tag them as "counter-trend" and require a higher bar.
3. Explicitly detect reversal/structure-shift triggers: a higher-low after a downtrend can trigger a LONG, and a lower-high after an uptrend can trigger a SHORT, even against the HTF bias.
4. Map the NEXT high-probability setup(s), even if price has not reached the zone yet. Pending/conditional plans are valid and should be returned.
5. For pending setups, include triggerZone and triggerCondition that describe what price must do before the setup activates.
6. ENTRY: must be at a concrete structural/indicator level appropriate to the selected trader mode — never a blind entry at current price. Use ${lowerTimeframe} for timing/trigger even on swing/position horizons.
7. ENTRY CONFIRMATION (MANDATORY): do NOT open on a raw spike through the level. Define how price must confirm.
   - entryConfirmType: usually "reclaim" (preferred). Use "touch" only for rare market-order style plans.
   - entryConfirmLevel: after the entry zone is tagged, price must reclaim this level before the trade is OPEN (LONG: trade back above this price; SHORT: trade back below). Often equal to entry, or slightly past entry (e.g. close above wick high of the zone / break of the micro-swing that formed the entry).
   - entryConfirmRationale: technique-specific rule in plain language (e.g. "tag FVG then close back above zone high", "sweep liquidity then reclaim prior low").
   - A wick through the entry zone is the sweep, not a cancel. Stay pending/armed until reclaim.
   - stopLoss is the live stop. The tracker keeps that price. It does not move the stop to the wick.
   - The idea is invalid only if price closes through that stop, or the target already printed before confirm.
8. STOP LOSS: stopLoss goes beyond the origin swing of the unmitigated zone named in the data. LONG: below that origin. SHORT: above that origin. If the only valid stop is inside half the lower-timeframe ATR, return an empty bestTrades array. Do not use a nearby wick or a percent of price.
${buildTargetsRule(higherTimeframe, lowerTimeframe)}
10. STOP LIFT (MANDATORY on every trade): AFTER confirmed open and BEFORE TP1, pick a structural proof level — then move the stop. Fields: stopLiftTrigger + stopLiftTo + stopLiftRationale.
   - stopLiftTrigger: between confirmed entry and TP1 (LONG above entry; SHORT below entry).
   - stopLiftTo: usually entry (BE) or small lock-in. Must improve original stop.
11. CONFLUENCE SCORING: Fib OTE zone overlap, EMA proximity, OB alignment, swing pivot alignment, BOS/CHoCH, liquidity sweep, and trendline alignment each count as a confluence signal. More confluences = higher grade.
12. Only include trades with R/R ≥ ${minRiskReward} to TP1. With-trend setups need at least ${minConfluence} confirming signal${minConfluence === 1 ? '' : 's'}; counter-trend setups need at least ${counterTrendMinConfluence}.
13. Return the valid standalone setup(s) you actually find. Do NOT force sequenced or linked trades. You MAY mention a natural flow into another zone in overallSummary, but never withhold a good standalone setup for lack of a second leg.
14. If no valid trade exists yet, return an empty bestTrades array and use overallSummary plus keyLevels to explain the key zones to watch next.
15. Expected hold should match the horizon (${tradeHorizonMeta.expectedHold}).
16. Do not re-issue a bestTrade that duplicates an open-book setup you marked keep (same direction + similar entry).
17. MACRO RELEVANCE: only discuss NEAR/APPROACHING weekly-monthly levels. Far history is IGNORE. Use a nearby macro level as TP2 only if price can get there without first going the other way through invalidation.

Respond with ONLY valid JSON:
{
  "openTradeReviews": [
    { "id": "uuid-from-open-book", "action": "keep|cancel", "reason": "1 sentence why still valid or why cancel" }
  ],
  "multiTFInsights": {
    "${higherTimeframe}": { "summary": "2 sentences on higher timeframe bias/trend", "bias": "BULLISH/BEARISH/NEUTRAL", "keyLevels": ["..."] },
    "${lowerTimeframe}": { "summary": "2 sentences on lower timeframe momentum/structure", "bias": "BULLISH/BEARISH/NEUTRAL", "keyLevels": ["..."] },
    "macro": { "summary": "1-2 sentences ONLY if a weekly/monthly level is near or approaching and reachable on this path; otherwise say none relevant", "bias": "BULLISH/BEARISH/NEUTRAL", "keyLevels": ["only NEAR/APPROACHING levels, or empty"] },
    "overallSummary": "2 sentences on the next high-probability setup(s) or the zones to watch next"
  },
  "bestTrades": [
    {
      "grade": "A+/A/B/C",
      "primaryTF": "${lowerTimeframe}/${higherTimeframe}",
      "direction": "LONG/SHORT",
      "htfRelationship": "with-trend/counter-trend",
      "triggerZone": "e.g. 1.0800-1.0850 demand FVG",
      "triggerCondition": "e.g. price drops into the zone and reacts with local confirmation",
      "entryZone": "FVG/OB/indicator trigger zone",
      "entry": "exact entry price",
      "entryConfirmType": "reclaim",
      "entryConfirmLevel": "exact reclaim price (often = entry or zone high/low)",
      "entryConfirmRationale": "e.g. tag demand then close/trade back above zone high",
      "stopLoss": "exact SL price",
      "slRationale": "why that invalidation level matters",
      "stopLiftTrigger": "exact price between entry and TP1 that proves the trade (e.g. local high reclaim)",
      "stopLiftTo": "exact new stop after trigger (usually entry/BE or small lock-in)",
      "stopLiftRationale": "why this trigger proves the setup and why that new stop is safe",
      "targets": ["TP1 price", "TP2 price"],
      "tp1Rationale": "nearest opposing level",
      "tp2Rationale": "next major target level",
      "confluenceSignals": ["signal1", "signal2", "signal3"],
      "riskRewardRatio": 2.1,
      "reasoning": "why the setup is valid and what activates it"
    }
  ]
}`;

  const systemContent =
    `${traderMode.systemPrompt}\n\nYou are working in ${traderMode.label} mode across multiple timeframes with trade horizon ${tradeHorizonMeta.label} (expected hold ${tradeHorizonMeta.expectedHold}). Apply this mode's validity criteria: ${traderMode.validityCriteria}\n\n${horizonPrompt}\n\nHigher timeframe bias is directional context and the dominant destination, not a veto. Weekly/monthly magnets only matter if they are NEAR or APPROACHING and price can reach them without first reversing the other way; far-away history must be ignored. Favour with-trend setups, but allow counter-trend setups when local structure shifts and confluence are strong enough. Every entry needs a concrete justification appropriate to this mode — never a blind "enter at current price". Prefer predictive/pending setup plans with triggerZone and triggerCondition when price has not reached the level yet. The stop you publish is the live invalidation, beyond the origin swing of the unmitigated zone. If that stop is inside half the lower-timeframe ATR, do not return the trade. Always include entryConfirmType/entryConfirmLevel (prefer reclaim after zone touch — never open on a straight-through spike) and stopLiftTrigger + stopLiftTo so risk can be reduced after the open is confirmed BEFORE TP1. When an OPEN BOOK is provided, re-validate every id with openTradeReviews (keep|cancel) before proposing new bestTrades; cancel stale/broken zones. Respect the user's settings: minimum R/R ${minRiskReward}:1 to TP1, minimum confluence ${minConfluence}, and require one extra confluence for counter-trend setups. Fib OTE zone (0.382-0.705), EMA proximity, OB alignment, swing pivots, BOS/CHoCH, liquidity sweeps, and trendline alignment all count as confluence signals. Return valid standalone setups; do not force sequencing. Always respond with valid JSON only.`;

  const openai = createXaiClient(options.apiKey);

  let completion: any;
  try {
    completion = await (openai.chat.completions.create as any)({
      model: XAI_PRIMARY_MODEL,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: deepPrompt },
      ],
      thinking: { type: 'enabled', budget_tokens: XAI_THINKING_BUDGET },
      // Lower temp than chat deep-dive — desk needs consistent JSON + setups
      temperature: 0.4,
      max_tokens: 16000,
    });
  } catch (primaryModelError: any) {
    console.warn(`⚠️ System deep-dive ${XAI_PRIMARY_MODEL} failed (${primaryModelError.message}), falling back to ${XAI_FALLBACK_MODEL}`);
    completion = await openai.chat.completions.create({
      model: XAI_FALLBACK_MODEL,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: deepPrompt },
      ],
      temperature: 0.3,
      max_tokens: 8000,
    });
  }

  const inputTokens = completion.usage?.prompt_tokens || 0;
  const outputTokens = completion.usage?.completion_tokens || 0;
  const estimatedCost = (inputTokens / 1_000_000 * 2) + (outputTokens / 1_000_000 * 10);

  let multiTFInsights: any = null;
  let bestTrades: any[] = [];
  let openTradeReviews: any[] = [];
  let gatesRelaxed = false;
  let rawTradeCount = 0;
  try {
    const message = completion.choices[0]?.message;
    const rawContent = extractTextContent(message);
    const parsed = parseDeskJsonPayload(rawContent) || {
      multiTFInsights: null,
      bestTrades: [],
      openTradeReviews: [],
    };
    multiTFInsights = parsed.multiTFInsights || null;
    const rawReviews = Array.isArray(parsed.openTradeReviews) ? parsed.openTradeReviews : [];
    // Normalize reviews; if model omitted them, default KEEP for unknown ids (safer than mass-cancel)
    const openIds = new Set(openTrades.map((t) => String(t.id)));
    openTradeReviews = rawReviews
      .map((r: any) => ({
        id: String(r.id || ''),
        action: String(r.action || '').toLowerCase() === 'cancel' ? 'cancel' : 'keep',
        reason: String(r.reason || '').slice(0, 400),
      }))
      .filter((r: any) => r.id && openIds.has(r.id));
    for (const t of openTrades) {
      if (!openTradeReviews.some((r) => r.id === String(t.id))) {
        openTradeReviews.push({
          id: String(t.id),
          action: 'keep',
          reason: 'Model omitted review — default keep',
        });
      }
    }
    const rawTrades = Array.isArray(parsed.bestTrades) ? parsed.bestTrades : [];
    rawTradeCount = rawTrades.length;

    const scored = rawTrades
      .map((t: any) => {
        const entryNum = parseFloat(String(t.entry).replace(/[^0-9.-]/g, '')) || 0;
        const slNum = parseFloat(String(t.stopLoss).replace(/[^0-9.-]/g, '')) || 0;
        const targets = Array.isArray(t.targets) ? t.targets : [];
        const tp1Num = parseFloat(String(targets[0]).replace(/[^0-9.-]/g, '')) || 0;
        const risk = Math.abs(entryNum - slNum);
        const reward = Math.abs(tp1Num - entryNum);
        const rr = risk > 0 && reward > 0 ? reward / risk : 0;
        const derivedRelationship =
          t.htfRelationship === 'counter-trend' || t.htfRelationship === 'with-trend'
            ? t.htfRelationship
            : ((dominantBias === 'BULLISH' && t.direction === 'LONG') || (dominantBias === 'BEARISH' && t.direction === 'SHORT')
                ? 'with-trend'
                : 'counter-trend');
        const confluenceCount = Array.isArray(t.confluenceSignals)
          ? t.confluenceSignals.length
          : Number(t.confluenceCount ?? 0);
        const dir = String(t.direction || '').toUpperCase();
        const pricesValid =
          entryNum > 0 &&
          slNum > 0 &&
          tp1Num > 0 &&
          (dir !== 'LONG' || (slNum < entryNum && tp1Num > entryNum)) &&
          (dir !== 'SHORT' || (slNum > entryNum && tp1Num < entryNum));
        return {
          ...t,
          direction: dir === 'SHORT' ? 'SHORT' : dir === 'LONG' ? 'LONG' : t.direction,
          htfRelationship: derivedRelationship,
          confluenceCount,
          riskRewardRatio: parseFloat(rr.toFixed(2)),
          _rr: rr,
          _requiredConfluence: derivedRelationship === 'counter-trend' ? counterTrendMinConfluence : minConfluence,
          _pricesValid: pricesValid,
        };
      })
      .filter((t: any) => t._pricesValid);

    const gated = scored
      .filter((t: any) => t._rr >= minRiskReward && t.confluenceCount >= t._requiredConfluence)
      .sort((a: any, b: any) => b._rr - a._rr);

    let chosen = gated;
    if (!chosen.length && softGates && scored.length) {
      gatesRelaxed = true;
      chosen = [...scored].sort((a: any, b: any) => b._rr - a._rr).slice(0, 2);
      chosen = chosen.map((t: any) => ({
        ...t,
        grade: t.grade || 'C',
        reasoning: `${t.reasoning || 'Setup idea'} [Desk note: did not fully clear R:R/confluence gates — review carefully.]`,
      }));
      console.warn(
        `System deep-dive: ${rawTradeCount} raw / ${scored.length} priced / 0 gated — soft-posting top ${chosen.length}`,
      );
    }

    const minStopDist = (parseFloat(lowerData.atr) || 0) * 0.5;
    if (minStopDist > 0) {
      const before = chosen.length;
      chosen = chosen.filter((t: any) => {
        const entryNum = parseFloat(String(t.entry).replace(/[^0-9.-]/g, '')) || 0;
        const slNum = parseFloat(String(t.stopLoss).replace(/[^0-9.-]/g, '')) || 0;
        return Math.abs(entryNum - slNum) >= minStopDist;
      });
      if (before && !chosen.length) {
        console.warn(`System deep-dive: dropped ${before} setup(s) inside half an ATR (${minStopDist})`);
      }
    }

    bestTrades = chosen
      .map(({ _rr, _requiredConfluence, _pricesValid, ...t }: any) => t)
      .slice(0, 2);

    // Ensure multiTFInsights has something readable when model returned trades only
    if (!multiTFInsights || typeof multiTFInsights !== 'object') {
      multiTFInsights = {
        overallSummary: bestTrades.length
          ? `Deep-dive found ${bestTrades.length} setup idea(s) for ${symbol}. Review structure before acting.`
          : `Deep-dive completed for ${symbol}; no fully qualified setup. Watch nearby structural levels.`,
        [higherTimeframe]: {
          summary: `HTF bias score context: ${dominantBias}. Price near $${higherData.currentPrice}.`,
          bias: dominantBias,
          keyLevels: [],
        },
        [lowerTimeframe]: {
          summary: `LTF execution frame. Price near $${lowerData.currentPrice}.`,
          bias: dominantBias,
          keyLevels: [],
        },
      };
    } else if (!multiTFInsights.overallSummary) {
      multiTFInsights.overallSummary = bestTrades.length
        ? `Deep-dive returned ${bestTrades.length} setup idea(s).`
        : 'Deep-dive completed with no gated setups.';
    }
  } catch (parseError) {
    console.error('System deep-dive parse failed:', parseError);
    // On parse failure, keep all open trades (do not mass-cancel)
    openTradeReviews = openTrades.map((t) => ({
      id: String(t.id),
      action: 'keep',
      reason: 'Parse failure — default keep',
    }));
  }

  if (multiTFInsights && typeof multiTFInsights === 'object') {
    const existing = multiTFInsights.macro && typeof multiTFInsights.macro === 'object'
      ? multiTFInsights.macro
      : {};
    const modelLevels = Array.isArray(existing.keyLevels) ? existing.keyLevels.filter(Boolean) : [];
    multiTFInsights.macro = {
      ...existing,
      keyLevels: modelLevels.length ? modelLevels : macro.levels,
      summary: existing.summary
        || (macro.levels.length
          ? `Nearby/approaching weekly-monthly: ${macro.levels.slice(0, 3).join('; ')}`
          : 'No weekly/monthly level is close enough to matter on this trade.'),
    };
  }

  return {
    multiTFInsights,
    bestTrades,
    openTradeReviews,
    estimatedCost,
    tokens: { input: inputTokens, output: outputTokens },
    higherTimeframe,
    lowerTimeframe,
    tradeHorizon,
    modeId: traderMode.id,
    gatesRelaxed,
    rawTradeCount,
    macroLevels: macro.levels,
  };
}

