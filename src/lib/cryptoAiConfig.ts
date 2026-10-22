export const CRYPTO_AI_HIGHER_TIMEFRAMES = ['1w', '1d'] as const;
export const CRYPTO_AI_LOWER_TIMEFRAMES = ['1h', '15m'] as const;
export const DEFAULT_CRYPTO_AI_HIGHER_TIMEFRAME = '1d' as const;
export const DEFAULT_CRYPTO_AI_LOWER_TIMEFRAME = '15m' as const;

export type CryptoAiHigherTimeframe = (typeof CRYPTO_AI_HIGHER_TIMEFRAMES)[number];
export type CryptoAiLowerTimeframe = (typeof CRYPTO_AI_LOWER_TIMEFRAMES)[number];
export type CryptoAiSessionLabel = 'asia' | 'london' | 'new_york';

// Keep in sync with shared/cryptoAiConfig.ts
export const CRYPTO_AI_TRADE_HORIZONS = ['scalp', 'intraday', 'swing', 'position'] as const;
export type CryptoAiTradeHorizon = (typeof CRYPTO_AI_TRADE_HORIZONS)[number];
export const DEFAULT_CRYPTO_AI_TRADE_HORIZON: CryptoAiTradeHorizon = 'intraday';

export type CryptoAiTradeHorizonMeta = {
  id: CryptoAiTradeHorizon;
  label: string;
  description: string;
  expectedHold: string;
  structureSource: 'lower' | 'balanced' | 'higher';
  structureRules: string;
};

export const CRYPTO_AI_TRADE_HORIZON_META: Record<CryptoAiTradeHorizon, CryptoAiTradeHorizonMeta> = {
  scalp: {
    id: 'scalp',
    label: 'Scalp',
    description: 'Minutes to a few hours — tight LTF structure.',
    expectedHold: '15 minutes – 4 hours',
    structureSource: 'lower',
    structureRules:
      'SCALP HORIZON: Stops and targets come from LOWER-timeframe structure only (nearest LTF swing, micro FVG/OB). ' +
      'Keep risk tight; TP1 is the next local opposing level, not a multi-day swing. Do not stretch for weekly levels.',
  },
  intraday: {
    id: 'intraday',
    label: 'Intraday',
    description: 'Same session to ~1 day — default day-trade sizing.',
    expectedHold: '4 hours – 1 day',
    structureSource: 'balanced',
    structureRules:
      'INTRADAY HORIZON: Entry timing from the lower TF; invalidation may use LTF structure behind the entry zone. ' +
      'Targets can reach the next session/HTF level, but stops should still be structurally local (not multi-week).',
  },
  swing: {
    id: 'swing',
    label: 'Swing',
    description: 'Days to a couple of weeks — wider HTF structure.',
    expectedHold: '2 days – 2 weeks',
    structureSource: 'higher',
    structureRules:
      'SWING HORIZON: Lower TF is ONLY for entry timing / trigger. Stop-loss MUST sit behind HIGHER-timeframe structure ' +
      '(HTF swing pivot, HTF order block, or HTF FVG boundary) — never a tight 15m wick. Targets are HTF level-to-level ' +
      '(prior day/week swing, HTF liquidity, value-area extremes). Weekly/monthly magnets are optional TP2 only if nearby ' +
      'and reachable without a deep opposite-direction retrace first; ignore far-away history. Wider stops are expected; keep R:R honest by using farther TPs.',
  },
  position: {
    id: 'position',
    label: 'Position',
    description: 'Weeks to months — major structural levels only.',
    expectedHold: '2 weeks – 3 months',
    structureSource: 'higher',
    structureRules:
      'POSITION HORIZON: Ignore micro LTF noise for risk. SL behind major HTF structure only (weekly/daily swings, large OBs). ' +
      'TP1/TP2 at major opposing HTF levels. Expected hold is multi-week; do not propose scalp-width stops even if LTF FVGs are nearby.',
  },
};

export function isCryptoAiTradeHorizon(value: unknown): value is CryptoAiTradeHorizon {
  return typeof value === 'string' && (CRYPTO_AI_TRADE_HORIZONS as readonly string[]).includes(value);
}

export function getCryptoAiTradeHorizon(id?: string | null): CryptoAiTradeHorizonMeta {
  if (id && isCryptoAiTradeHorizon(id)) {
    return CRYPTO_AI_TRADE_HORIZON_META[id];
  }
  return CRYPTO_AI_TRADE_HORIZON_META[DEFAULT_CRYPTO_AI_TRADE_HORIZON];
}

export function encodeCryptoAiDeepDiveMode(traderModeId: string, horizon: CryptoAiTradeHorizon): string {
  return `${traderModeId}:${horizon}`;
}

export function buildCryptoAiHorizonPromptBlock(
  horizon: CryptoAiTradeHorizon,
  higherTimeframe: string,
  lowerTimeframe: string,
): string {
  const meta = getCryptoAiTradeHorizon(horizon);
  return (
    `TRADE HORIZON: ${meta.label.toUpperCase()} (expected hold ${meta.expectedHold}). ` +
    `Chart pair is ${higherTimeframe}/${lowerTimeframe}. ${meta.structureRules}`
  );
}

export const CRYPTO_AI_SESSION_DISPLAY_NAMES: Record<CryptoAiSessionLabel, string> = {
  asia: 'Asia',
  london: 'London',
  new_york: 'New York',
};

const CRYPTO_AI_VALID_PAIRS = [
  ['1w', '1h'],
  ['1w', '15m'],
  ['1d', '1h'],
  ['1d', '15m'],
] as const satisfies readonly [CryptoAiHigherTimeframe, CryptoAiLowerTimeframe][];

const CRYPTO_AI_SCHEDULE = [
  { hour: 23, minute: 0, session: 'asia' as const },
  { hour: 6, minute: 0, session: 'london' as const },
  { hour: 13, minute: 0, session: 'new_york' as const },
];

export function isCryptoAiHigherTimeframe(value: string): value is CryptoAiHigherTimeframe {
  return (CRYPTO_AI_HIGHER_TIMEFRAMES as readonly string[]).includes(value);
}

export function isCryptoAiLowerTimeframe(value: string): value is CryptoAiLowerTimeframe {
  return (CRYPTO_AI_LOWER_TIMEFRAMES as readonly string[]).includes(value);
}

export function isValidCryptoAiPair(higherTimeframe: string, lowerTimeframe: string): boolean {
  return CRYPTO_AI_VALID_PAIRS.some(([higher, lower]) => higher === higherTimeframe && lower === lowerTimeframe);
}

export function normalizeCryptoAiPair(higherTimeframe?: string | null, lowerTimeframe?: string | null) {
  if (
    higherTimeframe &&
    lowerTimeframe &&
    isCryptoAiHigherTimeframe(higherTimeframe) &&
    isCryptoAiLowerTimeframe(lowerTimeframe) &&
    isValidCryptoAiPair(higherTimeframe, lowerTimeframe)
  ) {
    return { higherTimeframe, lowerTimeframe };
  }

  return {
    higherTimeframe: DEFAULT_CRYPTO_AI_HIGHER_TIMEFRAME,
    lowerTimeframe: DEFAULT_CRYPTO_AI_LOWER_TIMEFRAME,
  };
}

export function encodeCryptoAiPairInterval(higherTimeframe: CryptoAiHigherTimeframe, lowerTimeframe: CryptoAiLowerTimeframe): string {
  return `${higherTimeframe}_${lowerTimeframe}`;
}

export function getCryptoAiTimeframeMinutes(timeframe: string): number | null {
  const match = timeframe.trim().toLowerCase().match(/^(\d+)(m|h|d|w)$/);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  switch (match[2]) {
    case 'm':
      return value;
    case 'h':
      return value * 60;
    case 'd':
      return value * 60 * 24;
    case 'w':
      return value * 60 * 24 * 7;
    default:
      return null;
  }
}

export function getCryptoAiDeepDiveTtlMinutes(lowerTimeframe: string): number {
  const timeframeMinutes = getCryptoAiTimeframeMinutes(lowerTimeframe)
    ?? getCryptoAiTimeframeMinutes(DEFAULT_CRYPTO_AI_LOWER_TIMEFRAME)
    ?? 15;
  return timeframeMinutes * 2;
}

export function getLatestCryptoAiScheduleRun(now: Date = new Date()): { session: CryptoAiSessionLabel; boundary: Date } {
  const candidates = CRYPTO_AI_SCHEDULE.map(({ hour, minute, session }) => {
    const boundary = new Date(now);
    boundary.setUTCHours(hour, minute, 0, 0);
    if (boundary.getTime() > now.getTime()) {
      boundary.setUTCDate(boundary.getUTCDate() - 1);
    }
    return { session, boundary };
  });

  return candidates.reduce((latest, candidate) =>
    candidate.boundary.getTime() > latest.boundary.getTime() ? candidate : latest,
  );
}

export function getCryptoAiCycleSession(now: Date = new Date()): CryptoAiSessionLabel {
  return getLatestCryptoAiScheduleRun(now).session;
}

export function getSessionDisplayName(session: CryptoAiSessionLabel): string {
  return CRYPTO_AI_SESSION_DISPLAY_NAMES[session];
}

export function isCryptoAiCacheFresh(updatedAt: string | Date | null | undefined, now: Date = new Date()): boolean {
  if (!updatedAt) return false;
  const updatedDate = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  if (Number.isNaN(updatedDate.getTime())) return false;
  const { boundary } = getLatestCryptoAiScheduleRun(now);
  return updatedDate.getTime() >= boundary.getTime();
}

export function isCryptoAiDeepDiveCacheFresh(
  updatedAt: string | Date | null | undefined,
  lowerTimeframe: string,
  now: Date = new Date(),
): boolean {
  if (!updatedAt) return false;
  const updatedDate = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  if (Number.isNaN(updatedDate.getTime())) return false;

  const ageMs = now.getTime() - updatedDate.getTime();
  return ageMs >= 0 && ageMs <= getCryptoAiDeepDiveTtlMinutes(lowerTimeframe) * 60_000;
}
