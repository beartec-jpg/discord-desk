/**
 * Discord incoming-webhook helpers (multipart file + embeds).
 */
import { formatTargetsWithPercent } from './tradePriceUtils.js';

export type DiscordEmbed = {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
};

export async function postDiscordWebhook(options: {
  webhookUrl: string;
  content?: string;
  embeds?: DiscordEmbed[];
  filename?: string;
  fileBuffer?: Buffer;
  fileContentType?: string;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const { webhookUrl, content, embeds, filename, fileBuffer, fileContentType } = options;

  if (fileBuffer && filename) {
    const form = new FormData();
    const payload = {
      content: content || undefined,
      embeds: embeds || undefined,
      allowed_mentions: { parse: [] as string[] },
    };
    form.append('payload_json', JSON.stringify(payload));
    const copy = new Uint8Array(fileBuffer.byteLength);
    copy.set(fileBuffer);
    const blob = new Blob([copy.buffer as ArrayBuffer], { type: fileContentType || 'image/png' });
    form.append('files[0]', blob, filename);

    const res = await fetch(webhookUrl, { method: 'POST', body: form });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: content || undefined,
      embeds: embeds || undefined,
      allowed_mentions: { parse: [] },
    }),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

export function tradeEmbeds(
  symbol: string,
  trades: Array<{
    direction?: string;
    grade?: string;
    entry?: string | number;
    stopLoss?: string | number;
    targets?: Array<string | number>;
    riskRewardRatio?: number;
    reasoning?: string;
    triggerZone?: string;
    entryConfirmType?: string;
    entryConfirmLevel?: string | number;
    entryConfirmRationale?: string;
    stopLiftTrigger?: string | number;
    stopLiftTo?: string | number;
    stopLiftRationale?: string;
  }>,
): DiscordEmbed[] {
  return trades.slice(0, 2).map((t, i) => {
    const dir = (t.direction || 'SETUP').toUpperCase();
    const color = dir === 'LONG' ? 0x22c55e : dir === 'SHORT' ? 0xef4444 : 0xa855f7;
    const tps = formatTargetsWithPercent(t.entry, t.targets, t.direction, '\n') || '—';
    const rr = t.riskRewardRatio == null ? '—' : `${Number(t.riskRewardRatio).toFixed(2)}R`;
    const confType = String(t.entryConfirmType || 'reclaim').toLowerCase();
    const confLvl = t.entryConfirmLevel ?? t.entry ?? '—';
    const confirm =
      confType === 'touch'
        ? 'Touch entry (open on tag)'
        : `Reclaim ${confLvl} after zone tag` +
          (t.entryConfirmRationale ? `\n${String(t.entryConfirmRationale).slice(0, 180)}` : '');
    const lift =
      t.stopLiftTrigger != null && t.stopLiftTo != null
        ? `Tag ${t.stopLiftTrigger} → move SL to ${t.stopLiftTo}` +
          (t.stopLiftRationale ? `\n${String(t.stopLiftRationale).slice(0, 200)}` : '')
        : '—';
    return {
      title: `${symbol} · Setup ${i + 1} · ${dir}${t.grade ? ` (${t.grade})` : ''}`,
      color,
      description: t.reasoning || t.triggerZone || undefined,
      fields: [
        { name: 'Entry', value: String(t.entry ?? '—'), inline: true },
        { name: 'Stop', value: String(t.stopLoss ?? '—'), inline: true },
        { name: 'R:R (to TP1)', value: rr, inline: true },
        { name: 'Entry confirm', value: confirm.slice(0, 400), inline: false },
        { name: 'Targets (% from entry)', value: tps, inline: false },
        { name: 'Stop lift (before TP1)', value: lift.slice(0, 500), inline: false },
      ],
      footer: { text: 'Not financial advice · Review the chart yourself' },
      timestamp: new Date().toISOString(),
    };
  });
}
