/**
 * Performance metrics from closed trades (R-multiples).
 * Prefer win rate / expectancy / PF / max DD until sample is large;
 * Sharpe/Sortino still computed for the weekly desk report.
 */

export interface ClosedTradePoint {
  realizedR: number;
  closedAt: Date;
  outcome: string | null;
  symbol?: string;
  grade?: string;
  direction?: string;
}

export interface PerformanceStats {
  totalTrades: number;
  wins: number;
  losses: number;
  scratches: number;
  winRate: number | null;
  grossProfitR: number;
  grossLossR: number;
  netR: number;
  avgR: number | null;
  expectancyR: number | null;
  profitFactor: number | null;
  maxDrawdownR: number;
  recoveryFactor: number | null;
  profitToDrawdown: number | null;
  sharpe: number | null;
  sortino: number | null;
  bestTradeR: number | null;
  worstTradeR: number | null;
  bySymbol: Record<string, { n: number; netR: number; wins: number }>;
  byGrade: Record<string, { n: number; netR: number; wins: number }>;
  equityCurve: Array<{ t: string; equityR: number }>;
}

function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdSample(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function downsideStd(xs: number[]): number {
  const downs = xs.filter((x) => x < 0);
  if (downs.length < 1) return 0;
  // Sortino: std of negative returns only (sample)
  if (downs.length === 1) return Math.abs(downs[0]);
  return stdSample(downs);
}

export function computePerformance(trades: ClosedTradePoint[]): PerformanceStats {
  const sorted = [...trades].sort(
    (a, b) => a.closedAt.getTime() - b.closedAt.getTime(),
  );
  const rs = sorted.map((t) => t.realizedR);
  const wins = sorted.filter((t) => t.realizedR > 0.05).length;
  const losses = sorted.filter((t) => t.realizedR < -0.05).length;
  const scratches = sorted.length - wins - losses;
  const decided = wins + losses;

  const grossProfitR = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLossR = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const netR = rs.reduce((a, b) => a + b, 0);

  let peak = 0;
  let equity = 0;
  let maxDD = 0;
  const equityCurve: Array<{ t: string; equityR: number }> = [];
  for (const t of sorted) {
    equity += t.realizedR;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
    equityCurve.push({ t: t.closedAt.toISOString(), equityR: round(equity, 4) });
  }

  const avgR = rs.length ? netR / rs.length : null;
  const m = mean(rs);
  const s = stdSample(rs);
  const d = downsideStd(rs);
  // Per-trade Sharpe/Sortino (not annualized) — desk sample size is small
  const sharpe = s > 1e-12 ? m / s : null;
  const sortino = d > 1e-12 ? m / d : null;

  const bySymbol: PerformanceStats['bySymbol'] = {};
  const byGrade: PerformanceStats['byGrade'] = {};
  for (const t of sorted) {
    const sym = t.symbol || 'UNKNOWN';
    const gr = t.grade || '?';
    bySymbol[sym] ??= { n: 0, netR: 0, wins: 0 };
    bySymbol[sym].n += 1;
    bySymbol[sym].netR += t.realizedR;
    if (t.realizedR > 0.05) bySymbol[sym].wins += 1;
    byGrade[gr] ??= { n: 0, netR: 0, wins: 0 };
    byGrade[gr].n += 1;
    byGrade[gr].netR += t.realizedR;
    if (t.realizedR > 0.05) byGrade[gr].wins += 1;
  }

  const profitFactor =
    grossLossR > 1e-12 ? grossProfitR / grossLossR : grossProfitR > 0 ? Infinity : null;
  const recoveryFactor = maxDD > 1e-12 ? netR / maxDD : netR > 0 ? Infinity : null;

  return {
    totalTrades: sorted.length,
    wins,
    losses,
    scratches,
    // Scratches are 0R — not a win, not a loss. Keep them out of win rate.
    winRate: decided ? wins / decided : null,
    grossProfitR: round(grossProfitR, 4),
    grossLossR: round(grossLossR, 4),
    netR: round(netR, 4),
    avgR: avgR == null ? null : round(avgR, 4),
    expectancyR: avgR == null ? null : round(avgR, 4),
    profitFactor: profitFactor == null || !Number.isFinite(profitFactor) ? profitFactor : round(profitFactor, 4),
    maxDrawdownR: round(maxDD, 4),
    recoveryFactor:
      recoveryFactor == null || !Number.isFinite(recoveryFactor)
        ? recoveryFactor
        : round(recoveryFactor, 4),
    profitToDrawdown:
      recoveryFactor == null || !Number.isFinite(recoveryFactor)
        ? recoveryFactor
        : round(recoveryFactor, 4),
    sharpe: sharpe == null ? null : round(sharpe, 4),
    sortino: sortino == null ? null : round(sortino, 4),
    bestTradeR: rs.length ? round(Math.max(...rs), 4) : null,
    worstTradeR: rs.length ? round(Math.min(...rs), 4) : null,
    bySymbol,
    byGrade,
    equityCurve,
  };
}

function round(n: number, d: number): number {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

export function formatStatsEmbedFields(stats: PerformanceStats): Array<{ name: string; value: string; inline?: boolean }> {
  const pct = (x: number | null) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
  const num = (x: number | null | undefined) =>
    x == null || !Number.isFinite(x) ? '—' : x === Infinity ? '∞' : x.toFixed(2);

  return [
    { name: 'Trades', value: String(stats.totalTrades), inline: true },
    { name: 'W / L / Scr', value: `${stats.wins} / ${stats.losses} / ${stats.scratches}`, inline: true },
    { name: 'Win rate', value: pct(stats.winRate), inline: true },
    { name: 'Net R', value: num(stats.netR), inline: true },
    { name: 'Avg R / Exp', value: num(stats.expectancyR), inline: true },
    { name: 'Profit factor', value: num(stats.profitFactor), inline: true },
    { name: 'Max DD (R)', value: num(stats.maxDrawdownR), inline: true },
    { name: 'Recovery / P:DD', value: num(stats.recoveryFactor), inline: true },
    { name: 'Sharpe (per trade)', value: num(stats.sharpe), inline: true },
    { name: 'Sortino (per trade)', value: num(stats.sortino), inline: true },
    { name: 'Best / Worst', value: `${num(stats.bestTradeR)} / ${num(stats.worstTradeR)}`, inline: true },
  ];
}
