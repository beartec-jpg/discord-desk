export type DiscordEmbed = {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
};

/**
 * Resolve Discord webhook for a symbol.
 * Prefer DISCORD_WEBHOOK_URL_BTC / _XRP (or _BTCUSDT / _XRPUSDT), else shared DISCORD_WEBHOOK_URL.
 */
/**
 * Unique HTF Discord destinations for the Sunday recap.
 * Uses BTC / XRP channel hooks first; falls back to shared DISCORD_WEBHOOK_URL.
 */
export function listWeeklyDiscordDestinations(): Array<{
  label: string;
  symbols: string[];
  webhookUrl: string;
}> {
  const seen = new Set<string>();
  const out: Array<{ label: string; symbols: string[]; webhookUrl: string }> = [];
  const add = (label: string, symbols: string[]) => {
    const url = resolveWebhookForSymbol(symbols[0]);
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ label, symbols, webhookUrl: url });
  };
  add('BTC', ['BTCUSDT', 'BTCUSD']);
  add('XRP', ['XRPUSDT', 'XRPUSD']);
  const shared = (process.env.DISCORD_WEBHOOK_URL || '').trim();
  if (shared && !seen.has(shared)) {
    seen.add(shared);
    out.push({ label: 'desk', symbols: [], webhookUrl: shared });
  }
  return out;
}

export function resolveWebhookForSymbol(symbol?: string | null): string | undefined {
  const raw = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const base = raw.replace(/USDT$/i, '').replace(/USD$/i, '') || '';
  const candidates = [
    raw ? process.env[`DISCORD_WEBHOOK_URL_${raw}`] : undefined,
    base ? process.env[`DISCORD_WEBHOOK_URL_${base}`] : undefined,
    base ? process.env[`DISCORD_${base}_WEBHOOK_URL`] : undefined,
    process.env.DISCORD_WEBHOOK_URL,
  ];
  for (const c of candidates) {
    if (c && String(c).trim()) return String(c).trim();
  }
  return undefined;
}

export async function postDiscordWebhook(options: {
  webhookUrl: string;
  content?: string;
  embeds?: DiscordEmbed[];
}): Promise<{ ok: boolean; status: number; body: string }> {
  const { webhookUrl, content, embeds } = options;
  if (!webhookUrl || ['0', 'false', 'off'].includes(String(process.env.TRACKER_NOTIFY || '').toLowerCase())) {
    console.log(`[tracker:discord] skipped (${!webhookUrl ? 'no webhook' : 'TRACKER_NOTIFY=0'}): ${embeds?.[0]?.title || content || ''}`);
    return { ok: true, status: 0, body: 'skipped' };
  }
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: content || undefined,
      embeds: embeds || undefined,
      allowed_mentions: { parse: [] as string[] },
    }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

export function colorForEvent(type: string): number {
  switch (type) {
    case 'entry_armed':
      return 0x94a3b8; // waiting confirm
    case 'entry_hit':
      return 0x38bdf8;
    case 'entry_invalid':
      return 0x64748b;
    case 'sweep_update':
      return 0x64748b;
    case 'stop_lift':
      return 0xf59e0b; // amber — action required
    case 'tp1_hit':
    case 'tp2_hit':
      return 0x22c55e;
    case 'stop_to_be':
      return 0xa78bfa;
    case 'sl_hit':
      return 0xef4444;
    case 'be_hit':
      return 0xfbbf24;
    case 'closed':
      return 0x94a3b8;
    default:
      return 0x64748b;
  }
}
