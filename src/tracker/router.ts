import express from 'express';
import type { Queryable } from './db.js';
import {
  createTrade,
  listTrades,
  cancelTrades,
  getPerformance,
  processTradeAtPrice,
  postWeeklyReport,
  buildWeeklyReport,
} from './store.js';
import { setPriceOverride, clearPriceOverrides } from './prices.js';
import { resolveWebhookForSymbol, postDiscordWebhook } from './discord.js';
import { getPaperDashboard, updatePaperSettings } from './paper.js';
import { pollOnce } from './service.js';

/** Same auth rule as the original tracker: open if TRACKER_API_KEY unset; else X-Tracker-Key or Bearer. */
function authorized(req: express.Request): boolean {
  const key = process.env.TRACKER_API_KEY;
  if (!key) return true;
  const val = req.header('x-tracker-key') || req.header('authorization') || '';
  return val === key || val === `Bearer ${key}`;
}

/**
 * Trade tracker HTTP API (port of the original trade-tracker/server.ts, desk-relevant routes only).
 * GET  /health                       status
 * GET  /api/trades?active=1&symbol=  list
 * GET  /api/performance?days=        stats
 * GET  /api/weekly-preview           weekly report preview
 * GET  /api/paper                    paper account dashboard
 * POST /api/trades                   register setup(s)          (auth)
 * POST /api/trades/cancel            cancel by ids              (auth)
 * POST /api/trades/:id/process       evaluate one trade at price (auth)
 * POST /api/tick                     force poll (optional price overrides) (auth)
 * POST /api/sim-price                set/clear price override   (auth)
 * POST /api/weekly                   post weekly report         (auth)
 * POST /api/paper/settings           update paper settings      (auth)
 */
export function createTrackerRouter(pool: Queryable) {
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));
  const webhookUrl = (symbol?: string) => resolveWebhookForSymbol(symbol) || process.env.DISCORD_WEBHOOK_URL || undefined;
  const wrap = (fn: (req: express.Request, res: express.Response) => Promise<any>) => (req: express.Request, res: express.Response) =>
    fn(req, res).catch((err) => {
      console.error('[tracker:http]', err);
      res.status(500).json({ error: err?.message || 'server error' });
    });

  r.get(['/health', '/api/tracker/health'], wrap(async (_req, res) => {
    const active = await listTrades(pool, { activeOnly: true, limit: 500 });
    res.json({ ok: true, service: 'trade-tracker', db: pool.kind, activeTrades: active.length, time: new Date().toISOString() });
  }));

  r.get('/api/trades', wrap(async (req, res) => {
    const rows = await listTrades(pool, {
      activeOnly: req.query.active === '1',
      symbol: (req.query.symbol as string) || undefined,
      limit: Number(req.query.limit || 100),
      status: (req.query.status as string) || undefined,
    });
    res.json({ trades: rows });
  }));

  r.get('/api/performance', wrap(async (req, res) => {
    const days = req.query.days;
    const since = days ? new Date(Date.now() - Number(days) * 86400000) : undefined;
    res.json({ period: await getPerformance(pool, since), allTime: await getPerformance(pool), since: since?.toISOString() || null });
  }));

  r.get('/api/weekly-preview', wrap(async (_req, res) => res.json(await buildWeeklyReport(pool))));
  r.get('/api/paper', wrap(async (_req, res) => res.json(await getPaperDashboard(pool))));

  r.post(['/api/trades', '/api/trades/cancel', '/api/trades/:id/process', '/api/tick', '/api/sim-price', '/api/weekly', '/api/paper/settings'], (req, res, next) => (authorized(req) ? next() : res.status(401).json({ error: 'Unauthorized' })));

  r.post('/api/trades', wrap(async (req, res) => {
    const body = req.body || {};
    const tradesIn = Array.isArray(body.trades) ? body.trades : [body];
    const created: any[] = [];
    for (const t of tradesIn) {
      const dir = String(t.direction || '').toUpperCase();
      if (dir !== 'LONG' && dir !== 'SHORT') return res.status(400).json({ error: `Invalid direction: ${t.direction}` });
      created.push(
        await createTrade(pool, {
          userId: t.userId || body.userId,
          source: t.source || body.source || 'api',
          symbol: t.symbol,
          direction: dir,
          grade: t.grade,
          entry: Number(t.entry),
          stopLoss: Number(t.stopLoss ?? t.stop_loss),
          targets: Array.isArray(t.targets) ? t.targets.map(Number) : [Number(t.tp1), Number(t.tp2)].filter((n) => Number.isFinite(n)),
          entryConfirmType: t.entryConfirmType ?? t.entry_confirm_type ?? 'reclaim',
          entryConfirmLevel: t.entryConfirmLevel ?? t.entry_confirm_level ?? t.entry ?? null,
          entryConfirmRationale: t.entryConfirmRationale ?? t.entry_confirm_rationale ?? null,
          stopLiftTrigger: t.stopLiftTrigger ?? t.stop_lift_trigger ?? t.breakEvenTrigger ?? null,
          stopLiftTo: t.stopLiftTo ?? t.stop_lift_to ?? t.breakEvenPrice ?? null,
          stopLiftRationale: t.stopLiftRationale ?? t.stop_lift_rationale ?? t.slLiftRationale ?? null,
          confluenceSignals: t.confluenceSignals || t.confluence_signals,
          reasoning: t.reasoning,
          riskRewardRatio: t.riskRewardRatio ?? t.risk_reward_ratio,
          meta: t.meta,
        } as any),
      );
    }
    res.status(201).json({ created, count: created.length });
  }));

  r.post('/api/trades/cancel', wrap(async (req, res) => {
    const body = req.body || {};
    const ids = Array.isArray(body.ids) ? body.ids : body.id ? [body.id] : [];
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    const result = await cancelTrades(pool, { ids: ids.map(String), reason: body.reason || 'desk_review_cancel' });
    for (const t of result.cancelled.slice(0, 5)) {
      const hook = webhookUrl(String(t.symbol));
      if (!hook) continue;
      await postDiscordWebhook({
        webhookUrl: hook,
        embeds: [{
          title: `${t.symbol} · CANCELLED · ${t.direction}`,
          description: (body.reason || 'Desk review cancelled this setup') + (t.reasoning ? `\n\n_Was:_ ${String(t.reasoning).slice(0, 200)}` : ''),
          color: 0x64748b,
          fields: [
            { name: 'Entry', value: String(t.entry), inline: true },
            { name: 'Was status', value: String(body.previousStatus || 'active'), inline: true },
            { name: 'Id', value: String(t.id).slice(0, 8), inline: true },
          ],
          footer: { text: 'AI trade tracker · setup removed from book' },
          timestamp: new Date().toISOString(),
        }],
      });
    }
    res.json({ ok: true, cancelled: result.cancelled.length, skipped: result.skipped, trades: result.cancelled });
  }));

  r.post('/api/trades/:id/process', wrap(async (req, res) => {
    const row = (await pool.query('SELECT * FROM tracker_trades WHERE id = $1', [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    const price = Number(req.body?.price);
    if (!Number.isFinite(price)) return res.status(400).json({ error: 'price required' });
    const events = await processTradeAtPrice(pool, row, price, webhookUrl(String(row.symbol)));
    const trade = (await pool.query('SELECT * FROM tracker_trades WHERE id = $1', [req.params.id])).rows[0];
    res.json({ events, trade });
  }));

  r.post('/api/tick', wrap(async (req, res) => {
    const body = req.body || {};
    if (body.prices && typeof body.prices === 'object') {
      for (const [sym, px] of Object.entries(body.prices)) setPriceOverride(String(sym), Number(px));
    }
    const result = await pollOnce(pool);
    if (body.clearOverrides) clearPriceOverrides();
    res.json(result);
  }));

  r.post('/api/sim-price', wrap(async (req, res) => {
    const body = req.body || {};
    if (body.symbol && body.price != null) setPriceOverride(String(body.symbol), Number(body.price));
    if (body.clear) clearPriceOverrides();
    res.json({ ok: true });
  }));

  r.post('/api/weekly', wrap(async (_req, res) => res.json(await postWeeklyReport(pool, webhookUrl()))));
  r.post('/api/paper/settings', wrap(async (req, res) => res.json(await updatePaperSettings(pool, req.body || {}))));

  return r;
}
