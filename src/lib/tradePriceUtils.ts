/** Shared price / % move helpers for Discord desk (mirrors client cryptoAiTradePlans). */

export function parseTradePrice(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function targetMovePercent(
  entry: unknown,
  target: unknown,
  direction?: string | null,
): number | null {
  const e = parseTradePrice(entry);
  const t = parseTradePrice(target);
  if (e == null || t == null || e === 0) return null;
  const dir = String(direction || '').toUpperCase();
  if (dir === 'SHORT') return ((e - t) / e) * 100;
  return ((t - e) / e) * 100;
}

export function formatPercentMove(pct: number | null | undefined, digits = 2): string {
  if (pct == null || !Number.isFinite(pct)) return '';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(digits)}%`;
}

export function formatTargetWithPercent(
  entry: unknown,
  target: unknown,
  direction?: string | null,
): string {
  const price =
    target === undefined || target === null || target === ''
      ? '—'
      : String(target);
  const pctStr = formatPercentMove(targetMovePercent(entry, target, direction));
  return pctStr ? `${price} (${pctStr})` : price;
}

export function formatTargetsWithPercent(
  entry: unknown,
  targets: Array<string | number> | null | undefined,
  direction?: string | null,
  separator = ' / ',
): string {
  if (!targets?.length) return '—';
  return targets.map((t) => formatTargetWithPercent(entry, t, direction)).join(separator);
}
