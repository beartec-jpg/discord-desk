/**
 * Daily desk: per-symbol deep-dive (Binance data + Grok) → Discord embeds.
 * Each symbol runs in isolation (scheduler fires BTC and XRP separately).
 *
 * Env: see .env.example (DISCORD_WEBHOOK_URL_BTC / _XRP, XAI_API_KEY, TRACKER_URL,
 * DISCORD_AI_HIGHER_TF / LOWER_TF / MODE / HORIZON / MIN_RR / MIN_CONFLUENCE).
 */
import type { DeskCache } from './cache/index.js';
import { config as deskConfig } from './config.js';
import {
  encodeCryptoAiPairInterval,
  getCryptoAiTradeHorizon,
  getSessionDisplayName,
  type CryptoAiSessionLabel,
} from './lib/cryptoAiConfig.js';
import { getAiTraderMode } from './lib/aiTraderModes.js';
import { postDiscordWebhook, tradeEmbeds, type DiscordEmbed } from './lib/discordWebhook.js';
import {
  normalizeBinanceSpotSymbol,
  runGeneralPairRefresh,
  runSystemDeepDive,
} from './analysis/multiTf.js';


/** Session order for a trading day: Asia → London → New York */
const SESSION_ORDER: CryptoAiSessionLabel[] = ['asia', 'london', 'new_york'];

function sectionOf(insights: any, tf: string): { summary?: string; bias?: string; keyLevels?: string[] } | null {
  if (!insights || typeof insights !== 'object') return null;
  const section = insights[tf];
  return section && typeof section === 'object' ? section : null;
}

function overallOf(insights: any): string {
  return typeof insights?.overallSummary === 'string' ? insights.overallSummary : '';
}

function collectLevels(insights: any, frames: string[]): string[] {
  if (!insights) return [];
  const levels: string[] = [];
  for (const key of [...frames, ...Object.keys(insights)]) {
    if (key === 'overallSummary') continue;
    const section = sectionOf(insights, key);
    for (const level of section?.keyLevels || []) {
      if (level && !levels.includes(level)) levels.push(level);
    }
  }
  return levels.slice(0, 6);
}

function normaliseSnapshots(raw: unknown): any[] {
  return Array.isArray(raw) ? raw.filter(Boolean) : [];
}

function insightsHasContent(insights: any): boolean {
  if (!insights || typeof insights !== 'object') return false;
  if (overallOf(insights)) return true;
  for (const [key, value] of Object.entries(insights)) {
    if (key === 'overallSummary') continue;
    if (value && typeof value === 'object') {
      const s = value as { summary?: string; bias?: string; keyLevels?: string[] };
      if (s.summary || s.bias || (Array.isArray(s.keyLevels) && s.keyLevels.length)) return true;
    }
  }
  return false;
}

/**
 * Cache is keyed by exact (symbol, interval, mode).
 * App session board often uses BTCUSDT + 1d_15m while Discord env may be BTCUSD + 1d_1h —
 * so we probe aliases and nearby pairs before giving up.
 */
function symbolLookupCandidates(primary: string): string[] {
  const base = normalizeBinanceSpotSymbol(primary);
  const set = new Set<string>([base, primary.toUpperCase()]);
  if (base.endsWith('USDT')) {
    set.add(base.replace(/USDT$/, 'USD'));
    set.add(base.replace(/USDT$/, ''));
  }
  if (base === 'BTCUSDT') {
    set.add('BTCUSD');
    set.add('BTC');
    set.add('XBTUSDT');
  }
  return Array.from(set).filter(Boolean);
}

function pairLookupCandidates(higher: string, lower: string): string[] {
  const primary = encodeCryptoAiPairInterval(higher as any, lower as any);
  const extras = ['1d_1h', '1d_15m', '1w_1h', '1w_15m'];
  return Array.from(new Set([primary, ...extras]));
}

/** Before London open, previous completed session is Asia (then prior NY if useful). */
function pickPreviousSessions(snapshots: any[]): any[] {
  if (!snapshots.length) return [];
  const bySession = new Map<string, any>();
  for (const snap of snapshots) {
    const key = String(snap?.session || '').toLowerCase();
    if (!key) continue;
    // snapshots are newest-first from rotateSnapshots
    if (!bySession.has(key)) bySession.set(key, snap);
  }
  // Prefer Asia as the session that just finished before London
  const preferred: CryptoAiSessionLabel[] = ['asia', 'new_york', 'london'];
  const ordered: any[] = [];
  for (const id of preferred) {
    const snap = bySession.get(id);
    if (snap && insightsHasContent(snap.multiTFInsights)) ordered.push(snap);
  }
  // Fall back to any snapshot with content (newest first), max 2
  if (!ordered.length) {
    return snapshots.filter((s) => insightsHasContent(s?.multiTFInsights)).slice(0, 2);
  }
  return ordered.slice(0, 2);
}

function formatSessionEmbed(
  snap: any,
  symbol: string,
  higherTimeframe: string,
  lowerTimeframe: string,
): DiscordEmbed {
  const sessionId = String(snap?.session || '').toLowerCase() as CryptoAiSessionLabel;
  const label =
    snap?.label
    || (SESSION_ORDER.includes(sessionId) ? getSessionDisplayName(sessionId) : sessionId || 'Session');
  const insights = snap?.multiTFInsights || null;
  const overall = overallOf(insights) || 'No session summary stored.';
  const higher = sectionOf(insights, higherTimeframe);
  const lower = sectionOf(insights, lowerTimeframe);
  const levels = collectLevels(insights, [lowerTimeframe, higherTimeframe]);
  const when = snap?.generatedAt ? String(snap.generatedAt).replace('T', ' ').slice(0, 16) + ' UTC' : null;

  const fields: DiscordEmbed['fields'] = [];
  if (higher?.summary || higher?.bias) {
    fields.push({
      name: `${higherTimeframe.toUpperCase()} · ${higher?.bias || '—'}`,
      value: (higher?.summary || '—').slice(0, 500),
      inline: false,
    });
  }
  if (lower?.summary || lower?.bias) {
    fields.push({
      name: `${lowerTimeframe.toUpperCase()} · ${lower?.bias || '—'}`,
      value: (lower?.summary || '—').slice(0, 500),
      inline: false,
    });
  }
  if (levels.length) {
    fields.push({
      name: 'Key levels',
      value: levels.map((l) => `• ${l}`).join('\n').slice(0, 800),
      inline: false,
    });
  }

  return {
    title: `① Previous session · ${label}`,
    description: overall.slice(0, 1500),
    color: 0x38bdf8,
    fields: fields.length ? fields : undefined,
    footer: when ? { text: `Snapshot ${when}` } : { text: `${symbol} session board` },
  };
}


function normaliseSymbolToken(s: string): string {
  const up = s.trim().toUpperCase();
  if (!up) return '';
  const looksLikeTf =
    /^\d+[MHDW]$/i.test(up) ||
    ['1D', '1H', '15M', '1W', '4H', '5M', '1M'].includes(up);
  return normalizeBinanceSpotSymbol(looksLikeTf ? 'BTCUSDT' : up);
}

/**
 * Resolve desk symbols.
 * Prefer force (query/env single-symbol cron), else DISCORD_DESK_SYMBOLS, else legacy.
 * Split crons pass force="BTCUSDT" / "XRPUSDT" so runs never share a request.
 */
function resolveDeskSymbols(force?: string | string[] | null): string[] {
  const forceRaw = Array.isArray(force)
    ? force.join(',')
    : force != null
      ? String(force)
      : '';
  const multi = (forceRaw || process.env.DISCORD_DESK_SYMBOLS || '').trim();
  if (multi) {
    return Array.from(
      new Set(
        multi
          .split(/[,\s]+/)
          .map((s) => normaliseSymbolToken(s))
          .filter(Boolean),
      ),
    );
  }
  // Legacy single-symbol env
  const rawSymbol = (process.env.DISCORD_BTC_SYMBOL || 'BTCUSDT').trim().toUpperCase();
  const looksLikeTimeframe =
    /^\d+[MHDW]$/i.test(rawSymbol) ||
    ['1D', '1H', '15M', '1W', '4H', '5M', '1M'].includes(rawSymbol);
  const symbol = normalizeBinanceSpotSymbol(
    !rawSymbol || looksLikeTimeframe ? 'BTCUSDT' : rawSymbol,
  );
  return [symbol];
}

/** Per-symbol webhook override, else shared DISCORD_WEBHOOK_URL. */
function resolveWebhookForSymbol(symbol: string, fallback: string): string {
  const base = symbol.replace(/USDT$/i, '').toUpperCase(); // BTC, XRP
  const candidates = [
    process.env[`DISCORD_WEBHOOK_URL_${symbol}`],
    process.env[`DISCORD_WEBHOOK_URL_${base}`],
    process.env[`DISCORD_${base}_WEBHOOK_URL`],
  ];
  for (const c of candidates) {
    if (c && String(c).trim()) return String(c).trim();
  }
  return fallback;
}

export interface DeskRunOptions {
  /** Symbols to run (default: DISCORD_DESK_SYMBOLS or BTCUSDT). */
  symbols?: string | string[] | null;
  /** Print / return the Discord payload instead of posting it. Also skips tracker writes. */
  dryRun?: boolean;
  /** Skip the Discord post only; tracker register/cancel still happen (for testing the tracker). */
  noPost?: boolean;
  cache: DeskCache;
}

export interface DeskSymbolResult {
  success: boolean;
  symbol: string;
  error?: string;
  dryRun?: boolean;
  payload?: { content?: string; embeds?: DiscordEmbed[] };
  setups?: any[];
  [key: string]: any;
}

export interface DeskRunResult {
  success: boolean;
  symbols: string[];
  startedAt: string;
  finishedAt: string;
  results: DeskSymbolResult[];
}

export async function runDesk(opts: DeskRunOptions): Promise<DeskRunResult> {
  const startedAt = new Date().toISOString();
  const dryRun = Boolean(opts.dryRun);
  const skipPost = dryRun || Boolean(opts.noPost);
  const cache = opts.cache;

  const defaultWebhookUrl =
    process.env.DISCORD_WEBHOOK_URL ||
    process.env.DISCORD_WEBHOOK_URL_BTC ||
    process.env.DISCORD_WEBHOOK_URL_XRP ||
    '';

  const apiKey = deskConfig.xaiKey();
  if (!apiKey) {
    throw new Error('XAI_API_KEY is not set (or set XAI_MOCK=1 to run offline with a mock model)');
  }

  const higherTimeframe = (process.env.DISCORD_AI_HIGHER_TF || '1d').trim().toLowerCase();
  const lowerTimeframe = (process.env.DISCORD_AI_LOWER_TF || '15m').trim().toLowerCase();
  const mode = (process.env.DISCORD_AI_MODE || 'smc').trim().toLowerCase();
  const tradeHorizon = (process.env.DISCORD_AI_HORIZON || 'swing').trim().toLowerCase();
  const minRiskReward = Number(process.env.DISCORD_MIN_RR ?? 1.5);
  const minConfluence = Number(process.env.DISCORD_MIN_CONFLUENCE ?? 3);

  const symbols = resolveDeskSymbols(opts.symbols ?? null);
  console.log(
    `📡 Discord desk symbols=${symbols.join(',')} ${higherTimeframe}/${lowerTimeframe} mode=${mode} horizon=${tradeHorizon}${dryRun ? ' [DRY RUN]' : ''}`,
  );

  const results: any[] = [];

  for (const symbol of symbols) {
    const webhookUrl = resolveWebhookForSymbol(symbol, defaultWebhookUrl || '');
    if (!webhookUrl && !skipPost) {
      console.error(`No webhook for ${symbol} — set DISCORD_WEBHOOK_URL_${symbol.replace(/USDT$/i, '')}`);
      results.push({
        success: false,
        symbol,
        error: `No Discord webhook for ${symbol}`,
      });
      continue;
    }
    console.log(
      `📡 Desk run ${symbol} → webhook ${webhookUrl === defaultWebhookUrl ? 'fallback/shared' : 'dedicated channel'}`,
    );

  try {
    // Prefer cached general analysis + session snapshots (from Asia/London/NY cron)
    let generalInsights: any = null;
    let sessionSnapshots: any[] = [];
    const pairInterval = encodeCryptoAiPairInterval(higherTimeframe as any, lowerTimeframe as any);

    const loadGeneralCache = async () => {
      const row = await cache.getGeneral(symbol, pairInterval);
      if (row?.aiNarration) {
        generalInsights = row.aiNarration?.multiTFInsights || null;
      }
      sessionSnapshots = normaliseSnapshots(row?.snapshots);
    };

    try {
      await loadGeneralCache();
    } catch (cacheErr: any) {
      console.warn('General cache lookup skipped:', cacheErr?.message);
    }

    // If session board / cross-TF empty, warm it once (same path as session cron)
    if (!generalInsights || !sessionSnapshots.length) {
      try {
        console.log(`Warming general multi-TF cache for ${symbol} ${pairInterval}…`);
        const generated = await runGeneralPairRefresh(cache, apiKey, symbol, higherTimeframe, lowerTimeframe);
        generalInsights = generated.multiTFInsights || generalInsights;
        sessionSnapshots = normaliseSnapshots(generated.snapshots);
      } catch (warmErr: any) {
        console.warn('General cache warm failed:', warmErr?.message);
        try {
          await loadGeneralCache();
        } catch {
          // ignore
        }
      }
    }

    // Snapshot open book from tracker so the model can keep|cancel prior ideas
    const trackerUrl = (process.env.TRACKER_URL || '').replace(/\/+$/, '');
    const trackerHeaders: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (process.env.TRACKER_API_KEY) {
      trackerHeaders['X-Tracker-Key'] = process.env.TRACKER_API_KEY;
    }

    let openTrades: any[] = [];
    if (trackerUrl) {
      try {
        const bookRes = await fetch(
          `${trackerUrl}/api/trades?active=1&symbol=${encodeURIComponent(symbol)}&limit=50`,
          { headers: trackerHeaders, signal: AbortSignal.timeout(10_000) },
        );
        if (bookRes.ok) {
          const bookJson: any = await bookRes.json();
          openTrades = Array.isArray(bookJson.trades) ? bookJson.trades : [];
          console.log(`📒 Open book for ${symbol}: ${openTrades.length} active setup(s)`);
        } else {
          console.warn('Open book fetch failed:', bookRes.status, await bookRes.text());
        }
      } catch (bookErr: any) {
        console.warn('Open book fetch error:', bookErr?.message || bookErr);
      }
    }

    const deep = await runSystemDeepDive({
      apiKey,
      symbol,
      higherTimeframe,
      lowerTimeframe,
      mode,
      tradeHorizon,
      minRiskReward,
      minConfluence,
      softGates: false,
      openTrades,
    });

    // Apply cancel reviews before registering new setups
    let trackerReview: {
      cancelled: number;
      kept: number;
      reviews: any[];
      error?: string;
    } = { cancelled: 0, kept: 0, reviews: deep.openTradeReviews || [] };

    if (trackerUrl && !dryRun && Array.isArray(deep.openTradeReviews) && deep.openTradeReviews.length) {
      const toCancel = deep.openTradeReviews.filter((r: any) => r.action === 'cancel');
      trackerReview.kept = deep.openTradeReviews.filter((r: any) => r.action === 'keep').length;
      if (toCancel.length) {
        try {
          const cancelRes = await fetch(`${trackerUrl}/api/trades/cancel`, {
            method: 'POST',
            headers: trackerHeaders,
            body: JSON.stringify({
              ids: toCancel.map((r: any) => r.id),
              reason: toCancel
                .map((r: any) => `${String(r.id).slice(0, 8)}: ${r.reason || 'desk cancel'}`)
                .join(' | ')
                .slice(0, 500),
            }),
            signal: AbortSignal.timeout(15_000),
          });
          const cancelText = await cancelRes.text();
          if (!cancelRes.ok) {
            console.error('Cancel open trades failed:', cancelRes.status, cancelText.slice(0, 300));
            trackerReview.error = `${cancelRes.status} ${cancelText.slice(0, 200)}`;
          } else {
            let parsed: any = {};
            try {
              parsed = JSON.parse(cancelText);
            } catch {
              /* ignore */
            }
            trackerReview.cancelled = parsed.cancelled ?? toCancel.length;
            console.log(`🗑️ Cancelled ${trackerReview.cancelled} stale setup(s) from open book`);
          }
        } catch (cancelErr: any) {
          console.error('Cancel open trades error:', cancelErr?.message || cancelErr);
          trackerReview.error = cancelErr?.message || 'cancel failed';
        }
      }
    }

    const modeMeta = getAiTraderMode(deep.modeId);
    const horizonMeta = getCryptoAiTradeHorizon(deep.tradeHorizon);
    const deepInsights = deep.multiTFInsights;
    const htf = deep.higherTimeframe;
    const ltf = deep.lowerTimeframe;

    // Build readable deep text even when overallSummary is missing (was showing "Deep-dive completed.")
    const deepHigher = sectionOf(deepInsights, htf);
    const deepLower = sectionOf(deepInsights, ltf);
    const deepMacro = sectionOf(deepInsights, 'macro');
    const watchLevels = collectLevels(deepInsights, [ltf, htf, 'macro']);
    const nearbyMacro = [
      ...(deep.macroLevels || []),
      ...((deepMacro?.keyLevels || []).filter(Boolean)),
    ].filter((level, i, arr) => arr.indexOf(level) === i).slice(0, 6);
    const deepSummary =
      overallOf(deepInsights)
      || [deepHigher?.summary, deepLower?.summary].filter(Boolean).join('\n\n')
      || (deep.bestTrades.length
        ? `Deep-dive found ${deep.bestTrades.length} setup idea(s) for ${symbol}.`
        : `Deep-dive finished for ${symbol}. No fully qualified setup — check structure on ${htf}/${ltf}.`);

    // Cross-TF: prefer general cache; only show embed if we have real content
    const genHigher = sectionOf(generalInsights, htf);
    const genLower = sectionOf(generalInsights, ltf);
    const crossSummary = overallOf(generalInsights);
    const hasCrossContent = Boolean(
      crossSummary
      || genHigher?.summary
      || genLower?.summary
      || genHigher?.bias
      || genLower?.bias,
    );

    // Previous session: only if snapshot has real analysis (never post empty "no cache" stubs)
    const previousSessions = pickPreviousSessions(sessionSnapshots).filter((snap) => {
      const insights = snap?.multiTFInsights;
      return Boolean(overallOf(insights) || collectLevels(insights, [ltf, htf]).length);
    });

    const setupCount = deep.bestTrades.length;

    const content =
      `**${symbol} · Pre-London open** (${htf}/${ltf})\n` +
      `Mode: **${modeMeta.label}** · Length: **${horizonMeta.label}** (~${horizonMeta.expectedHold})\n` +
      (setupCount
        ? `${setupCount} trade setup${setupCount === 1 ? '' : 's'} below${deep.gatesRelaxed ? ' (soft-gated — review carefully)' : ''}.`
        : 'No priced setup this run — see deep-dive / zones below.') +
      `\n\n⚠️ **Not financial advice.** Educational / informational only. Always review the chart and structure yourself before acting — make your own judgement.`;

    // Core analysis first (what worked before session section was added), then optional context, then trades
    const embeds: DiscordEmbed[] = [];

    // ① Deep-dive — always the main analysis body
    {
      const fields: DiscordEmbed['fields'] = [];
      if (deepHigher?.summary || deepHigher?.bias) {
        fields.push({
          name: `${htf.toUpperCase()} · ${deepHigher?.bias || '—'}`,
          value: (deepHigher?.summary || '—').slice(0, 900),
          inline: false,
        });
      }
      if (deepLower?.summary || deepLower?.bias) {
        fields.push({
          name: `${ltf.toUpperCase()} · ${deepLower?.bias || '—'}`,
          value: (deepLower?.summary || '—').slice(0, 900),
          inline: false,
        });
      }
      if (deepMacro?.summary || nearbyMacro.length) {
        fields.push({
          name: `Weekly / monthly · ${deepMacro?.bias || 'only if nearby'}`,
          value: [
            deepMacro?.summary,
            nearbyMacro.length ? nearbyMacro.map((l) => `• ${l}`).join('\n') : null,
          ].filter(Boolean).join('\n').slice(0, 900) || 'None nearby.',
          inline: false,
        });
      }
      if (watchLevels.length) {
        fields.push({
          name: 'Key zones to watch',
          value: watchLevels.map((l) => `• ${l}`).join('\n').slice(0, 1000),
          inline: false,
        });
      }
      embeds.push({
        title: `① Deep-dive · ${symbol}`,
        description: deepSummary.slice(0, 3500),
        color: 0xa855f7,
        fields: fields.length ? fields : undefined,
        footer: { text: `${modeMeta.label} · ${horizonMeta.label} · Not financial advice` },
        timestamp: new Date().toISOString(),
      });
    }

    // ② Trades
    const tradeList = tradeEmbeds(symbol, deep.bestTrades).map((embed, i) => ({
      ...embed,
      title: `② ${embed.title || `Trade setup ${i + 1}`}`,
    }));
    if (tradeList.length) {
      embeds.push(...tradeList);
    } else {
      embeds.push({
        title: '② Trade setups',
        description:
          'No priced setup with valid entry / stop / TP this run. Use the deep-dive and key zones above; wait for structure.',
        color: 0x64748b,
      });
    }

    // ③ Cross-timeframe — only when general cache has real content (skip empty stubs)
    if (hasCrossContent) {
      const fields: DiscordEmbed['fields'] = [];
      if (genHigher?.summary || genHigher?.bias) {
        fields.push({
          name: `${htf.toUpperCase()} · ${genHigher?.bias || '—'}`,
          value: (genHigher?.summary || '—').slice(0, 600),
          inline: false,
        });
      }
      if (genLower?.summary || genLower?.bias) {
        fields.push({
          name: `${ltf.toUpperCase()} · ${genLower?.bias || '—'}`,
          value: (genLower?.summary || '—').slice(0, 600),
          inline: false,
        });
      }
      embeds.push({
        title: '③ Cross-timeframe (session board)',
        description: (crossSummary || 'Multi-TF context from general scan.').slice(0, 2000),
        color: 0xa78bfa,
        fields: fields.length ? fields : undefined,
        footer: { text: 'General multi-TF · Not financial advice' },
      });
    }

    // Open-book keep|cancel review (after new setups, before session extras)
    if (openTrades.length && Array.isArray(deep.openTradeReviews) && deep.openTradeReviews.length) {
      const keepLines = deep.openTradeReviews
        .filter((r: any) => r.action === 'keep')
        .map((r: any) => {
          const t = openTrades.find((x) => String(x.id) === String(r.id));
          return `• KEEP ${t ? `${t.direction} @ ${t.entry}` : r.id.slice(0, 8)} — ${r.reason || 'still valid'}`;
        });
      const cancelLines = deep.openTradeReviews
        .filter((r: any) => r.action === 'cancel')
        .map((r: any) => {
          const t = openTrades.find((x) => String(x.id) === String(r.id));
          return `• CANCEL ${t ? `${t.direction} @ ${t.entry}` : r.id.slice(0, 8)} — ${r.reason || 'stale'}`;
        });
      embeds.push({
        title: '④ Open-book review (prior ideas)',
        description: [
          cancelLines.length ? cancelLines.join('\n') : '• No cancels',
          keepLines.length ? keepLines.join('\n') : '• Nothing kept (empty book or all cancelled)',
        ]
          .join('\n')
          .slice(0, 3500),
        color: 0xf59e0b,
        footer: {
          text: `Cancelled ${trackerReview.cancelled} · Kept ${trackerReview.kept}`,
        },
      });
    }

    // Previous session
    for (const snap of previousSessions) {
      const emb = formatSessionEmbed(snap, symbol, htf, ltf);
      embeds.push({
        ...emb,
        title: (emb.title || 'Previous session').replace(/^①\s*/, '⑤ '),
      });
    }

    // Disclaimer last
    embeds.push({
      title: 'Disclaimer',
      description:
        'This is **not financial advice**. Crypto trading involves substantial risk of loss. ' +
        'Setups are AI-generated ideas for education and discussion only. ' +
        '**Always inspect the chart and structure yourself** before trading, and make your own independent decisions. ' +
        'BearTec is not responsible for trading losses.',
      color: 0x64748b,
    });

    const payload = { content, embeds };
    const discord = skipPost
      ? { ok: true, status: 0, body: 'not posted (dry-run / no-post)' }
      : await postDiscordWebhook({ webhookUrl, content, embeds });

    // Auto-register priced setups with the always-on trade tracker (spare server).
    // Env: TRACKER_URL (e.g. http://your-tracker-host:3101), TRACKER_API_KEY — optional
    let tracker: {
      ok: boolean;
      registered?: number;
      cancelled?: number;
      kept?: number;
      error?: string;
    } = {
      ok: false,
      cancelled: trackerReview.cancelled,
      kept: trackerReview.kept,
    };
    if (trackerUrl && !dryRun && deep.bestTrades.length) {
      try {
        const payload = {
          source: 'discord_desk',
          userId: process.env.TRACKER_DESK_USER_ID || 'discord-desk',
          trades: deep.bestTrades.map((t: any) => ({
            symbol,
            direction: String(t.direction || '').toUpperCase(),
            grade: t.grade || 'B',
            entry: t.entry,
            stopLoss: t.stopLoss,
            targets: t.targets,
            entryConfirmType: t.entryConfirmType ?? t.entry_confirm_type ?? 'reclaim',
            entryConfirmLevel: t.entryConfirmLevel ?? t.entry_confirm_level ?? t.entry ?? null,
            entryConfirmRationale: t.entryConfirmRationale ?? t.entry_confirm_rationale ?? null,
            stopLiftTrigger: t.stopLiftTrigger ?? t.stop_lift_trigger ?? null,
            stopLiftTo: t.stopLiftTo ?? t.stop_lift_to ?? null,
            stopLiftRationale: t.stopLiftRationale ?? t.stop_lift_rationale ?? null,
            confluenceSignals: t.confluenceSignals || [],
            reasoning: t.reasoning || t.triggerZone || null,
            riskRewardRatio: t.riskRewardRatio,
            meta: {
              mode: deep.modeId,
              tradeHorizon: deep.tradeHorizon,
              higherTimeframe: deep.higherTimeframe,
              lowerTimeframe: deep.lowerTimeframe,
              from: 'discord-btc-pre-london',
              stopLiftRationale: t.stopLiftRationale || null,
            },
          })),
        };
        const tr = await fetch(`${trackerUrl}/api/trades`, {
          method: 'POST',
          headers: trackerHeaders,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        });
        const bodyText = await tr.text();
        if (!tr.ok) {
          console.error('Trade tracker register failed:', tr.status, bodyText.slice(0, 300));
          tracker = {
            ...tracker,
            ok: false,
            error: `${tr.status} ${bodyText.slice(0, 200)}`,
          };
        } else {
          let parsed: any = {};
          try {
            parsed = JSON.parse(bodyText);
          } catch {
            /* ignore */
          }
          tracker = {
            ...tracker,
            ok: true,
            registered: parsed.count ?? deep.bestTrades.length,
          };
          console.log(`📍 Registered ${tracker.registered} setup(s) with trade tracker`);
        }
      } catch (trackErr: any) {
        console.error('Trade tracker register error:', trackErr?.message || trackErr);
        tracker = {
          ...tracker,
          ok: false,
          error: trackErr?.message || 'tracker unreachable',
        };
      }
    } else if (trackerUrl) {
      tracker = { ...tracker, ok: true, registered: 0 };
    }

    if (trackerReview.error && !tracker.error) {
      tracker.error = trackerReview.error;
    }

    if (!discord.ok) {
      console.error(`${symbol} Discord webhook failed:`, discord.status, discord.body);
      results.push({
        success: false,
        symbol,
        error: 'Discord webhook failed',
        status: discord.status,
        body: discord.body.slice(0, 500),
        analysisOk: true,
        payload,
        setups: deep.bestTrades,
        tradeCount: setupCount,
        tracker,
      });
      continue;
    }

    results.push({
      success: true,
      symbol,
      dryRun,
      posted: !skipPost,
      payload,
      setups: deep.bestTrades,
      higherTimeframe: deep.higherTimeframe,
      lowerTimeframe: deep.lowerTimeframe,
      mode: deep.modeId,
      tradeHorizon: deep.tradeHorizon,
      tradeCount: setupCount,
      gatesRelaxed: deep.gatesRelaxed || false,
      rawTradeCount: deep.rawTradeCount ?? 0,
      estimatedCost: deep.estimatedCost,
      tokens: deep.tokens,
      discordStatus: discord.status,
      generalCache: Boolean(generalInsights),
      sessionSnapshots: sessionSnapshots.length,
      openBook: openTrades.length,
      openTradeReviews: deep.openTradeReviews || [],
      trackerReview,
      tracker,
    });
  } catch (error: any) {
    console.error(`Discord desk failed for ${symbol}:`, error);
    // Best-effort failure notice to Discord
    try {
      if (webhookUrl && !skipPost) {
        await postDiscordWebhook({
          webhookUrl,
          content: `⚠️ **${symbol} pre-London desk failed:** ${error?.message || 'unknown error'}`,
        });
      }
    } catch {
      // ignore
    }
    results.push({
      success: false,
      symbol,
      error: error?.message || 'Pre-London desk failed',
    });
  }
  } // end symbol loop

  const allOk = results.length > 0 && results.every((r) => r.success);
  return {
    success: allOk,
    symbols,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
  };
}
