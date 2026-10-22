import express from 'express';
import type { DeskCache } from '../cache/index.js';
import { runAndRecord } from '../runner.js';
import { dashboardHtml } from './page.js';

export function createServer(cache: DeskCache, info: Record<string, any>) {
  const app = express();
  app.use(express.json());
  let running = false;

  const token = (process.env.DASHBOARD_TOKEN || '').trim();
  app.use((req, res, next) => {
    if (!token || req.path === '/health') return next();
    const got = req.header('x-dashboard-token') || String(req.query.token || '');
    if (got !== token) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/', (_req, res) => res.type('html').send(dashboardHtml));
  app.get('/api/info', (_req, res) => res.json({ ...info, running }));
  app.get('/api/runs', async (req, res) => {
    res.json({ runs: await cache.listRuns(Number(req.query.limit || 20)) });
  });
  app.post('/api/run', async (req, res) => {
    if (running) return res.status(409).json({ error: 'a run is already in progress' });
    const symbol = String(req.body?.symbol || 'BTCUSDT');
    const dryRun = req.body?.dryRun !== false;
    running = true;
    try {
      res.json(await runAndRecord(cache, symbol, { dryRun, trigger: 'dashboard' }));
    } finally {
      running = false;
    }
  });
  return app;
}
