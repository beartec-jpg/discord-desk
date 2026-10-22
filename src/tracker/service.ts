import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { initPool, migrate, closePool, type Queryable } from './db.js';
import { listTrades, processAllActive, postWeeklyReport } from './store.js';
import { fetchPrices } from './prices.js';
import { resolveWebhookForSymbol } from './discord.js';
import { ensurePaperAccount, markPaperToMarket } from './paper.js';

const POLL_MS = () => Number(process.env.TRACKER_POLL_INTERVAL_MS || process.env.POLL_INTERVAL_MS || 15_000);
const WEEKLY_DOW = () => Number(process.env.WEEKLY_DOW ?? 0);
const WEEKLY_HOUR_UTC = () => Number(process.env.WEEKLY_HOUR_UTC ?? 18);

/** One outcome pass: fetch Binance prices for active trades, apply entry/TP/stop events, notify. */
export async function pollOnce(pool: Queryable) {
  const webhook = resolveWebhookForSymbol('BTCUSDT') || process.env.DISCORD_WEBHOOK_URL || undefined;
  const active = await listTrades(pool, { activeOnly: true, limit: 500 });
  if (!active.length) return { checked: 0, events: 0 };
  const symbols = [...new Set(active.map((r: any) => String(r.symbol)))];
  const prices = await fetchPrices(symbols);
  const map = new Map(prices.map((p) => [p.symbol, p.price]));
  const extremes = new Map(prices.map((p) => [p.symbol, { high: p.high, low: p.low }] as const));
  const result = await processAllActive(pool, map, webhook, extremes as any);
  try {
    await markPaperToMarket(pool, map);
  } catch {
    /* ignore */
  }
  return result;
}

let lastWeeklyKey = '';
async function maybeWeekly(pool: Queryable) {
  const now = new Date();
  if (now.getUTCDay() !== WEEKLY_DOW() || now.getUTCHours() !== WEEKLY_HOUR_UTC()) return;
  const key = now.toISOString().slice(0, 13);
  if (key === lastWeeklyKey) return;
  lastWeeklyKey = key;
  console.log('[tracker] posting weekly report…');
  await postWeeklyReport(pool);
}

/** Single-writer guard for the embedded file DB (PGlite can't be shared between processes). */
function acquireLock(kind: string): () => void {
  if (kind !== 'pglite') return () => {};
  const file = path.resolve(process.env.DATA_DIR || './data', 'tracker-db.lock');
  if (fs.existsSync(file)) {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    let alive = false;
    try {
      if (pid && pid !== process.pid) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {
      /* stale */
    }
    if (alive) {
      throw new Error(
        `Tracker DB is in use by process ${pid} (the running service). Point at it instead: TRACKER_URL=http://127.0.0.1:<PORT>`,
      );
    }
  }
  fs.writeFileSync(file, String(process.pid));
  return () => {
    try {
      if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  };
}

export interface TrackerHandle {
  pool: Queryable;
  stop(): Promise<void>;
}

/** Open DB, apply schema, start the poll loop. */
export async function startTracker(opts: { poll?: boolean } = {}): Promise<TrackerHandle> {
  const pool = await initPool();
  const release = acquireLock(pool.kind);
  await migrate();
  try {
    await ensurePaperAccount(pool);
  } catch (e: any) {
    console.warn('[paper] init failed', e?.message);
  }
  let timer: NodeJS.Timeout | null = null;
  if (opts.poll !== false) {
    const tick = async () => {
      try {
        const r = await pollOnce(pool);
        if (r.events > 0) console.log(`[tracker] checked=${r.checked} events=${r.events}`);
        await maybeWeekly(pool);
      } catch (err: any) {
        console.error('[tracker] poll error', err?.message || err);
      }
    };
    void tick();
    timer = setInterval(tick, POLL_MS());
    console.log(`[tracker] polling every ${POLL_MS()}ms (db=${pool.kind})`);
  }
  return {
    pool,
    async stop() {
      if (timer) clearInterval(timer);
      await closePool();
      release();
    },
  };
}

/** Start an in-process tracker on an ephemeral localhost port (for CLI runs). */
export async function startEphemeralTracker(): Promise<{ url: string; handle: TrackerHandle; close(): Promise<void> }> {
  const { createTrackerRouter } = await import('./router.js');
  const handle = await startTracker({ poll: false });
  const app = express();
  app.use(createTrackerRouter(handle.pool));
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    handle,
    async close() {
      await new Promise((r) => server.close(() => r(null)));
      await handle.stop();
    },
  };
}
