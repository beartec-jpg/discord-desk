import type { Queryable } from './db.js';
import {
  evaluateTick,
  rowToEngine,
  type EngineEvent,
  type EngineTrade,
} from './engine.js';
import {
  colorForEvent,
  postDiscordWebhook,
  listWeeklyDiscordDestinations,
  resolveWebhookForSymbol,
  type DiscordEmbed,
} from './discord.js';
import { computePerformance, formatStatsEmbedFields, type ClosedTradePoint } from './stats.js';
import { applyPaperEvent, markPaperToMarket } from './paper.js';

export interface CreateTradeInput {
  userId?: string;
  source?: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  grade?: string;
  entry: number;
  stopLoss: number;
  targets: number[];
  /** touch = open on tag; reclaim = arm on tag, open only after reclaim confirm level. */
  entryConfirmType?: 'touch' | 'reclaim' | string | null;
  /** LONG: reclaim ≥ this; SHORT: reclaim ≤ this. Defaults to entry. */
  entryConfirmLevel?: number | null;
  entryConfirmRationale?: string | null;
  /** Price that must tag before TP1 to lift stop (LONG above entry, SHORT below). */
  stopLiftTrigger?: number | null;
  /** New stop after lift (entry = BE, or small profit). */
  stopLiftTo?: number | null;
  stopLiftRationale?: string | null;
  confluenceSignals?: string[];
  reasoning?: string | null;
  riskRewardRatio?: number | null;
  meta?: Record<string, unknown>;
}

function parseOptionalPrice(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function createTrade(pool: Queryable, input: CreateTradeInput) {
  const symbol = input.symbol.toUpperCase();
  const direction = input.direction.toUpperCase() as 'LONG' | 'SHORT';
  const entry = Number(input.entry);
  const stop = Number(input.stopLoss);
  const targets = (input.targets || []).map(Number).filter((n) => Number.isFinite(n));
  let stopLiftTrigger = parseOptionalPrice(input.stopLiftTrigger);
  let stopLiftTo = parseOptionalPrice(input.stopLiftTo);
  const rawConfirm = String(input.entryConfirmType || 'reclaim').toLowerCase();
  const entryConfirmType = rawConfirm === 'touch' ? 'touch' : 'reclaim';
  let entryConfirmLevel = parseOptionalPrice(input.entryConfirmLevel) ?? entry;

  if (!symbol || !['LONG', 'SHORT'].includes(direction)) {
    throw new Error('Invalid symbol/direction');
  }
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !targets.length) {
    throw new Error('entry, stopLoss, and at least one target required');
  }
  if (direction === 'LONG' && !(stop < entry && targets[0] > entry)) {
    throw new Error('LONG requires stop < entry < tp1');
  }
  if (direction === 'SHORT' && !(stop > entry && targets[0] < entry)) {
    throw new Error('SHORT requires stop > entry > tp1');
  }

  // Confirm level: for reclaim, LONG should be >= entry, SHORT <= entry (soft-fix)
  if (entryConfirmType === 'reclaim') {
    if (direction === 'LONG' && entryConfirmLevel < entry) entryConfirmLevel = entry;
    if (direction === 'SHORT' && entryConfirmLevel > entry) entryConfirmLevel = entry;
  }

  // Validate / soft-fix stop lift plan when provided
  if (stopLiftTrigger != null || stopLiftTo != null) {
    if (stopLiftTrigger == null || stopLiftTo == null) {
      stopLiftTrigger = null;
      stopLiftTo = null;
    } else if (direction === 'LONG') {
      if (!(stopLiftTrigger > entry && stopLiftTrigger < targets[0])) {
        stopLiftTrigger = null;
        stopLiftTo = null;
      } else if (!(stopLiftTo >= stop && stopLiftTo < stopLiftTrigger)) {
        stopLiftTo = entry;
      }
    } else {
      if (!(stopLiftTrigger < entry && stopLiftTrigger > targets[0])) {
        stopLiftTrigger = null;
        stopLiftTo = null;
      } else if (!(stopLiftTo <= stop && stopLiftTo > stopLiftTrigger)) {
        stopLiftTo = entry;
      }
    }
  }

  // Dedupe active identical setup
  const existing = await pool.query(
    `SELECT * FROM tracker_trades
     WHERE user_id = $1 AND symbol = $2 AND direction = $3
       AND entry = $4 AND status IN ('pending','entry_armed','entry_hit','tp1_hit')
     LIMIT 1`,
    [input.userId || 'discord-desk', symbol, direction, entry],
  );
  if (existing.rows[0]) return existing.rows[0];

  const rr =
    input.riskRewardRatio ??
    Math.abs(targets[0] - entry) / Math.abs(entry - stop);

  const result = await pool.query(
    `INSERT INTO tracker_trades (
       user_id, source, symbol, direction, grade,
       entry, original_stop, current_stop, targets,
       entry_confirm_type, entry_confirm_level, entry_confirm_rationale,
       stop_lift_trigger, stop_lift_to, stop_lift_rationale,
       confluence_signals, reasoning, risk_reward_ratio, meta, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'pending')
     RETURNING *`,
    [
      input.userId || 'discord-desk',
      input.source || 'discord_desk',
      symbol,
      direction,
      input.grade || 'B',
      entry,
      stop,
      stop,
      targets,
      entryConfirmType,
      entryConfirmLevel,
      input.entryConfirmRationale || null,
      stopLiftTrigger,
      stopLiftTo,
      input.stopLiftRationale || null,
      input.confluenceSignals || [],
      input.reasoning || null,
      rr,
      JSON.stringify(input.meta || {}),
    ],
  );
  return result.rows[0];
}

const ACTIVE_STATUSES = ['pending', 'entry_armed', 'entry_hit', 'tp1_hit'] as const;

export async function cancelTrades(
  pool: Queryable,
  opts: { ids: string[]; reason?: string | null },
): Promise<{ cancelled: any[]; skipped: string[] }> {
  const ids = (opts.ids || []).map(String).filter(Boolean);
  const cancelled: any[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    const r = await pool.query(
      `UPDATE tracker_trades
       SET status = 'cancelled',
           closed_at = COALESCE(closed_at, NOW()),
           remaining_size = 0,
           updated_at = NOW(),
           meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
       WHERE id = $1::uuid
         AND status = ANY($3::text[])
       RETURNING *`,
      [
        id,
        JSON.stringify({
          cancelReason: opts.reason || 'desk_review',
          cancelledAt: new Date().toISOString(),
        }),
        [...ACTIVE_STATUSES],
      ],
    );
    if (r.rows[0]) cancelled.push(r.rows[0]);
    else skipped.push(id);
  }
  return { cancelled, skipped };
}

export async function listTrades(
  pool: Queryable,
  opts: {
    status?: string;
    limit?: number;
    activeOnly?: boolean;
    symbol?: string;
    /** Filter by tracker source, e.g. scalp_desk | discord_desk */
    source?: string;
    sources?: string[];
  } = {},
) {
  const limit = Math.min(opts.limit || 100, 500);
  const sources =
    opts.sources?.filter(Boolean) ||
    (opts.source ? [opts.source] : null);

  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, val: unknown) => {
    params.push(val);
    clauses.push(sql.replace('?', `$${params.length}`));
  };

  if (opts.activeOnly) {
    clauses.push(`status IN ('pending','entry_armed','entry_hit','tp1_hit')`);
  } else if (opts.status) {
    add('status = ?', opts.status);
  }
  if (opts.symbol) {
    add('symbol = ?', opts.symbol.toUpperCase());
  }
  if (sources?.length) {
    params.push(sources);
    clauses.push(`source = ANY($${params.length}::text[])`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  const r = await pool.query(
    `SELECT * FROM tracker_trades ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

export async function getClosedPoints(
  pool: Queryable,
  since?: Date,
  opts?: { source?: string; sources?: string[]; symbols?: string[] },
): Promise<ClosedTradePoint[]> {
  const params: unknown[] = [];
  let sql = `SELECT realized_r, closed_at, outcome, symbol, grade, direction, source
             FROM tracker_trades
             WHERE closed_at IS NOT NULL AND status IN ('tp_hit','sl_hit','be_hit')`;
  if (since) {
    params.push(since.toISOString());
    sql += ` AND closed_at >= $${params.length}`;
  }
  const sources =
    opts?.sources?.filter(Boolean) ||
    (opts?.source ? [opts.source] : null);
  if (sources?.length) {
    params.push(sources);
    sql += ` AND source = ANY($${params.length}::text[])`;
  }
  const symbols = opts?.symbols?.map((s) => String(s).toUpperCase()).filter(Boolean);
  if (symbols?.length) {
    params.push(symbols);
    sql += ` AND symbol = ANY($${params.length}::text[])`;
  }
  sql += ' ORDER BY closed_at ASC';
  const r = await pool.query(sql, params);
  return r.rows.map((row) => ({
    realizedR: parseFloat(String(row.realized_r)),
    closedAt: new Date(row.closed_at),
    outcome: row.outcome,
    symbol: row.symbol,
    grade: row.grade,
    direction: row.direction,
  }));
}

export async function getPerformance(
  pool: Queryable,
  since?: Date,
  opts?: { source?: string; sources?: string[]; symbols?: string[] },
) {
  const points = await getClosedPoints(pool, since, opts);
  return computePerformance(points);
}

function weeklyDeskSources(): string[] {
  const raw = (process.env.DISCORD_WEEKLY_SOURCES || 'discord_desk').trim();
  const list = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : ['discord_desk'];
}

async function insertEvent(
  pool: Queryable,
  tradeId: string,
  ev: EngineEvent,
): Promise<void> {
  await pool.query(
    `INSERT INTO tracker_events (trade_id, event_type, price, size_fraction, r_delta, realized_r_after, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tradeId, ev.type, ev.price, ev.sizeFraction, ev.rDelta, ev.realizedRAfter, ev.message],
  );
}

async function applyEvent(pool: Queryable, tradeId: string, ev: EngineEvent): Promise<void> {
  await insertEvent(pool, tradeId, ev);

  const sets: string[] = [
    'status = $2',
    'current_stop = $3',
    'remaining_size = $4',
    'tp1_closed_size = $5',
    'stop_to_be = $6',
    'stop_lifted = $7',
    'realized_r = $8',
    'updated_at = NOW()',
    'last_price = $9',
    'last_checked_at = NOW()',
  ];
  const params: unknown[] = [
    tradeId,
    ev.newStatus,
    ev.newCurrentStop,
    ev.newRemainingSize,
    ev.newTp1ClosedSize,
    ev.newStopToBe,
    ev.newStopLifted,
    ev.realizedRAfter,
    ev.price,
  ];
  let i = 10;

  if (ev.type === 'entry_armed') {
    sets.push(`entry_armed_at = NOW()`);
  }
  if (ev.type === 'entry_hit') {
    sets.push(`entry_hit_at = NOW()`);
  }
  if (ev.newOriginalStop != null && Number.isFinite(ev.newOriginalStop)) {
    sets.push(`original_stop = $${i++}`);
    params.push(ev.newOriginalStop);
  }
  if (ev.newSweepExtreme != null && Number.isFinite(ev.newSweepExtreme)) {
    sets.push(`meta = COALESCE(meta, '{}'::jsonb) || $${i++}::jsonb`);
    params.push(JSON.stringify({ sweepExtreme: ev.newSweepExtreme }));
  }
  if (ev.type === 'stop_lift') {
    sets.push(`stop_lift_at = NOW()`);
  }
  if (ev.type === 'tp1_hit') {
    sets.push(`tp1_hit_at = NOW()`);
    sets.push(`tp_hit_level = 1`);
  }
  if (ev.type === 'tp2_hit') {
    sets.push(`tp_hit_at = NOW()`);
    sets.push(`tp_hit_level = 2`);
  }
  if (ev.type === 'sl_hit' || ev.type === 'be_hit') {
    sets.push(`sl_hit_at = NOW()`);
  }
  if (ev.closed) {
    sets.push(`closed_at = NOW()`);
    // entry_invalid has null outcome; only set outcome column when provided
    if (ev.outcome != null || ev.type !== 'entry_invalid') {
      sets.push(`outcome = $${i++}`);
      params.push(ev.outcome);
    }
  }

  await pool.query(
    `UPDATE tracker_trades SET ${sets.join(', ')} WHERE id = $1`,
    params,
  );
}

function fmtPx(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

function fmtR(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}R`;
}

/** Planned R if full size hit this target (informational on entry only). */
function plannedR(trade: EngineTrade, target: number): string {
  const risk = Math.abs(trade.entry - trade.originalStop);
  if (risk <= 0) return '—';
  const move =
    trade.direction === 'LONG' ? target - trade.entry : trade.entry - target;
  return fmtR(move / risk);
}

/**
 * HTF Discord channels (BTC/XRP webhooks) are for discord_desk / HTF only.
 * Scalp desk trades must stay off those channels unless explicitly allowed.
 *
 * Env:
 * - DISCORD_SILENT_SOURCES — comma list always muted (default includes scalp_desk)
 * - DISCORD_NOTIFY_SOURCES — if set, ONLY these sources post (allow-list)
 * - DISCORD_SCALP_NOTIFY=1 — allow scalp_desk through (override default mute)
 */
function shouldNotifyDiscord(source: string | undefined): boolean {
  const src = String(source || 'discord_desk').toLowerCase().trim();
  const allowRaw = process.env.DISCORD_NOTIFY_SOURCES;
  if (allowRaw != null && allowRaw.trim() !== '') {
    const allow = new Set(
      allowRaw
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    return allow.has(src);
  }
  const silent = new Set([
    'scalp_desk',
    'xrp-ltf-desk',
    'ltf-desk',
    'ltf_desk',
    'scalp',
    'xrp_struct',
    'xrp_scalp',
  ]);
  for (const s of String(process.env.DISCORD_SILENT_SOURCES || '').split(/[,\s]+/)) {
    if (s.trim()) silent.add(s.trim().toLowerCase());
  }
  // Any multi-bot id starting with xrp_ or scalp_ stays off HTF Discord unless forced
  if (src.startsWith('xrp_') || src.startsWith('scalp')) silent.add(src);
  if (process.env.DISCORD_SCALP_NOTIFY === '1') {
    silent.delete('scalp_desk');
    silent.delete('xrp-ltf-desk');
    silent.delete('ltf-desk');
    silent.delete('ltf_desk');
    silent.delete('scalp');
    silent.delete('xrp_struct');
    silent.delete('xrp_scalp');
  }
  return !silent.has(src);
}

export async function notifyEvent(
  webhookUrl: string | undefined,
  trade: EngineTrade,
  ev: EngineEvent,
): Promise<void> {
  // Scalp / LTF desk must not spam HTF BTC & XRP Discord channels
  if (!shouldNotifyDiscord(trade.source)) {
    console.log(
      `[discord:silent] source=${trade.source || '?'} ${trade.symbol} ${ev.type}`,
    );
    return;
  }

  // Prefer per-symbol webhook (BTC/XRP channels); fall back to shared URL
  const hook = resolveWebhookForSymbol(trade.symbol) || webhookUrl;
  if (!hook) {
    console.log(`[discord:skip] ${ev.message}`);
    return;
  }
  // skip pure stop_to_be if we already sent tp1 (avoid spam) — still send tp1 which mentions BE
  if (ev.type === 'stop_to_be' || ev.type === 'sweep_update') return;

  const titleType =
    ev.type === 'entry_armed'
      ? 'ZONE TAGGED'
      : ev.type === 'entry_hit'
        ? 'OPENED (CONFIRMED)'
        : ev.type === 'entry_invalid'
          ? 'ENTRY INVALID'
          : ev.type === 'stop_lift'
            ? 'MOVE STOP ⚠️'
            : ev.type === 'tp1_hit'
              ? 'TP1 HIT'
              : ev.type === 'tp2_hit'
                ? 'TP2 HIT'
                : ev.type === 'sl_hit'
                  ? 'STOP HIT'
                  : ev.type === 'be_hit'
                    ? 'STOP EXIT'
                    : ev.type.replace(/_/g, ' ').toUpperCase();

  const srcLabel =
    String(trade.source || 'discord_desk') === 'scalp_desk'
      ? 'scalp desk'
      : 'HTF desk';
  const embed: DiscordEmbed = {
    title: `${trade.symbol} · ${titleType} · ${trade.direction} (${trade.grade})`,
    description: ev.message,
    color: colorForEvent(ev.type),
    fields: [],
    footer: { text: `AI trade tracker · ${srcLabel} · Not financial advice` },
    timestamp: new Date().toISOString(),
  };

  if (ev.type === 'entry_armed') {
    const conf =
      trade.entryConfirmLevel != null ? trade.entryConfirmLevel : trade.entry;
    embed.fields = [
      { name: 'Entry zone', value: fmtPx(trade.entry), inline: true },
      { name: 'Tagged @', value: fmtPx(ev.price), inline: true },
      {
        name: 'Confirm (open only if)',
        value:
          trade.direction === 'LONG'
            ? `Trade back **above ${fmtPx(conf)}**`
            : `Trade back **below ${fmtPx(conf)}**`,
        inline: false,
      },
      {
        name: 'Stop',
        value: `Origin pivot ${fmtPx(trade.originalStop)} (structural SL / R). Sweep wick is confirm only.`,
        inline: false,
      },
      {
        name: 'Rule',
        value: trade.entryConfirmRationale || `${trade.entryConfirmType} confirmation`,
        inline: false,
      },
    ];
  } else if (ev.type === 'entry_invalid') {
    embed.fields = [
      { name: 'What happened', value: 'Sweep ran too far past the zone (thesis dead) or the move already completed before confirm', inline: false },
      { name: 'Result', value: '**No position** · 0R · not a win/loss trade', inline: false },
    ];
  } else if (ev.type === 'entry_hit') {
    // Confirmed open: levels only — no R
    const tp1 = trade.targets[0];
    const tp2 = trade.targets[1];
    const conf =
      trade.entryConfirmLevel != null ? trade.entryConfirmLevel : trade.entry;
    embed.fields = [
      { name: 'Entry', value: fmtPx(trade.entry), inline: true },
      { name: 'Stop loss', value: fmtPx(ev.newOriginalStop ?? ev.newCurrentStop ?? trade.originalStop), inline: true },
      { name: 'Confirmed @', value: fmtPx(ev.price), inline: true },
      {
        name: 'Entry rule',
        value:
          trade.entryConfirmType === 'touch'
            ? 'Touch entry'
            : `Reclaim ${fmtPx(conf)} after zone sweep` +
              (trade.entryConfirmRationale ? ` · ${trade.entryConfirmRationale}` : ''),
        inline: false,
      },
      {
        name: 'TP1 (close 50%)',
        value:
          tp1 != null
            ? `${fmtPx(tp1)} · plan ${plannedR(trade, tp1)} on full size`
            : '—',
        inline: true,
      },
      {
        name: 'TP2 (runner 50%)',
        value:
          tp2 != null
            ? `${fmtPx(tp2)} · plan ${plannedR(trade, tp2)} on full size`
            : '—',
        inline: true,
      },
      {
        name: 'Stop lift (before TP1)',
        value:
          trade.stopLiftTrigger != null && trade.stopLiftTo != null
            ? `When price tags **${fmtPx(trade.stopLiftTrigger)}** → move SL to **${fmtPx(trade.stopLiftTo)}**` +
              (trade.stopLiftTo === trade.entry ? ' (BE)' : '')
            : 'Not set — stop stays at original until TP1',
        inline: false,
      },
    ];
  } else if (ev.type === 'stop_lift') {
    // Management alert — no realized R (size still open)
    embed.fields = [
      { name: 'Trigger tagged', value: fmtPx(ev.price), inline: true },
      { name: 'New stop', value: fmtPx(ev.newCurrentStop), inline: true },
      {
        name: 'Action',
        value: `**MOVE YOUR STOP** to ${fmtPx(ev.newCurrentStop)} now (position still 100% open)`,
        inline: false,
      },
      {
        name: 'Still watching',
        value: `TP1 ${trade.targets[0] != null ? fmtPx(trade.targets[0]) : '—'} · TP2 ${trade.targets[1] != null ? fmtPx(trade.targets[1]) : '—'}`,
        inline: false,
      },
    ];
  } else {
    // After the fact: size closed + realized R only
    embed.fields = [
      { name: 'Fill', value: fmtPx(ev.price), inline: true },
      { name: 'Closed size', value: `${(ev.sizeFraction * 100).toFixed(0)}%`, inline: true },
      { name: 'This fill', value: fmtR(ev.rDelta), inline: true },
      { name: 'Trade total', value: fmtR(ev.realizedRAfter), inline: true },
    ];
    if (ev.type === 'tp1_hit') {
      embed.fields.push({
        name: 'Next',
        value: `Stop @ ${fmtPx(ev.newCurrentStop)} · runner 50% open`,
        inline: false,
      });
    }
    if (ev.closed) {
      embed.fields.push({
        name: 'Outcome',
        value: `${(ev.outcome || '—').toUpperCase()} · ${fmtR(ev.realizedRAfter)}`,
        inline: true,
      });
    }
  }

  const res = await postDiscordWebhook({ webhookUrl: hook, embeds: [embed] });
  if (!res.ok) {
    console.error('[discord] failed', res.status, res.body.slice(0, 200));
  }
}

export async function processTradeAtPrice(
  pool: Queryable,
  row: Record<string, unknown>,
  price: number,
  webhookUrl?: string,
  extremes?: { high?: number; low?: number },
): Promise<EngineEvent[]> {
  const engine = rowToEngine(row);
  const events = evaluateTick(engine, price, extremes);
  if (!events.length) {
    await pool.query(
      `UPDATE tracker_trades SET last_price = $2, last_checked_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [engine.id, price],
    );
    return [];
  }

  // Apply sequentially; re-read state mentally from event chain
  let working = { ...engine };
  for (const ev of events) {
    await applyEvent(pool, working.id, ev);
    try {
      await applyPaperEvent(pool, working, ev);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[paper] event failed', working.symbol, ev.type, msg);
    }
    await notifyEvent(webhookUrl, working, ev);
    working = {
      ...working,
      status: ev.newStatus,
      currentStop: ev.newCurrentStop,
      remainingSize: ev.newRemainingSize,
      tp1ClosedSize: ev.newTp1ClosedSize,
      stopToBe: ev.newStopToBe,
      stopLifted: ev.newStopLifted,
      realizedR: ev.realizedRAfter,
      outcome: ev.outcome,
      originalStop: ev.newOriginalStop ?? working.originalStop,
      sweepExtreme: ev.newSweepExtreme ?? working.sweepExtreme,
    };
  }
  return events;
}

export async function processAllActive(
  pool: Queryable,
  prices: Map<string, number>,
  webhookUrl?: string,
  extremes?: Map<string, { high?: number; low?: number }>,
): Promise<{ checked: number; events: number }> {
  const active = await listTrades(pool, { activeOnly: true, limit: 500 });
  let events = 0;
  for (const row of active) {
    const sym = String(row.symbol).toUpperCase();
    const price = prices.get(sym);
    if (price == null) continue;
    const ex = extremes?.get(sym);
    const evs = await processTradeAtPrice(pool, row, price, webhookUrl, ex);
    events += evs.length;
  }
  try {
    await markPaperToMarket(pool, prices);
  } catch (err: unknown) {
    console.warn('[paper] mtm', err instanceof Error ? err.message : err);
  }
  return { checked: active.length, events };
}

export async function buildWeeklyReport(
  pool: Queryable,
  opts?: { sources?: string[]; symbols?: string[] },
) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const filter = {
    sources: opts?.sources || weeklyDeskSources(),
    symbols: opts?.symbols,
  };
  const week = await getPerformance(pool, weekAgo, filter);
  const all = await getPerformance(pool, undefined, filter);
  return { week, all, weekAgo, now: new Date() };
}

export async function postWeeklyReport(
  pool: Queryable,
  webhookUrl?: string,
): Promise<{ ok: boolean; stats: Awaited<ReturnType<typeof buildWeeklyReport>> }> {
  const sources = weeklyDeskSources();
  const dests = listWeeklyDiscordDestinations();
  if (webhookUrl && !dests.some((d) => d.webhookUrl === webhookUrl)) {
    dests.push({ label: 'desk', symbols: [], webhookUrl });
  }

  const overview = await buildWeeklyReport(pool, { sources });
  if (!dests.length) {
    console.log(
      '[weekly] no Discord webhook configured (need DISCORD_WEBHOOK_URL_BTC / _XRP or DISCORD_WEBHOOK_URL)',
    );
    await pool.query(
      `INSERT INTO tracker_weekly_reports (period_start, period_end, stats, discord_ok)
       VALUES ($1,$2,$3,$4)`,
      [overview.weekAgo.toISOString(), overview.now.toISOString(), JSON.stringify(overview), false],
    );
    return { ok: false, stats: overview };
  }

  let anyOk = false;
  for (const dest of dests) {
    const stats = dest.symbols.length
      ? await buildWeeklyReport(pool, { sources, symbols: dest.symbols })
      : overview;
    const tag = dest.label === 'desk' ? 'AI desk' : `${dest.label} desk`;
    const embeds: DiscordEmbed[] = [
      {
        title: `📊 ${tag} — weekly performance`,
        description: `Closed Discord-bot trades ${stats.weekAgo.toISOString().slice(0, 10)} → ${stats.now.toISOString().slice(0, 10)} (UTC)`,
        color: 0xa855f7,
        fields: formatStatsEmbedFields(stats.week),
        footer: { text: 'Not financial advice · Paper levels / AI ideas only' },
        timestamp: stats.now.toISOString(),
      },
      {
        title: `📈 ${tag} — all-time`,
        color: 0x38bdf8,
        fields: formatStatsEmbedFields(stats.all),
        footer: { text: 'Sharpe/Sortino are per-trade and noisy on small samples' },
        timestamp: stats.now.toISOString(),
      },
    ];
    const res = await postDiscordWebhook({
      webhookUrl: dest.webhookUrl,
      content: `**Sunday ${dest.label} recap** — Discord bot performance`,
      embeds,
    });
    if (res.ok) {
      anyOk = true;
      console.log(`[weekly] posted ${dest.label} recap`);
    } else {
      console.error(`[weekly] discord ${dest.label} failed`, res.status, res.body.slice(0, 200));
    }
  }

  await pool.query(
    `INSERT INTO tracker_weekly_reports (period_start, period_end, stats, discord_ok)
     VALUES ($1,$2,$3,$4)`,
    [overview.weekAgo.toISOString(), overview.now.toISOString(), JSON.stringify(overview), anyOk],
  );

  return { ok: anyOk, stats: overview };
}
